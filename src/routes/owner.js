import { Router } from "express";
import crypto from "crypto";
import { readDB } from "../db.js";
import jwt from "jsonwebtoken";

const r = Router();

function toStr(v){ return (v===null||v===undefined)?"":String(v); }
function trim(v){ return toStr(v).trim(); }
function normEmail(v){ return trim(v).toLowerCase(); }

function secret(){
  return process.env.JWT_SECRET || "dev_secret_change_me";
}

function hashPassword(password, salt){
  const pw = trim(password);
  const s = salt || crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(pw, s, 64);
  return { salt: s, hash: dk.toString("hex") };
}

function verifyPassword(password, salt, hashHex){
  try{
    const dk = crypto.scryptSync(trim(password), salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hashHex, "hex"), dk);
  }catch(_e){
    return false;
  }
}

function requireOwnerAuth(req, res, next){
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
  if (!token) return res.status(401).json({ ok:false, error:"Missing token" });
  try{
    const dec = jwt.verify(token, secret());
    if (!dec || dec.role !== "owner") return res.status(403).json({ ok:false, error:"Forbidden" });
    req.owner = dec;
    return next();
  }catch(_e){
    return res.status(401).json({ ok:false, error:"Invalid token" });
  }
}

function requireShopAccess(req, res){
  const shopId = trim(req.query.shopId || req.body?.shopId);
  if (!shopId) {
    res.status(400).json({ ok:false, error:"shopId required" });
    return null;
  }
  const allowed = Array.isArray(req.owner?.shops) ? req.owner.shops : [];
  if (!allowed.includes(shopId)) {
    res.status(403).json({ ok:false, error:"No access to this shop" });
    return null;
  }
  return shopId;
}

function ymdToMs(ymd){
  const s = trim(ymd);
  if (!s) return null;
  const t = Date.parse(s + "T00:00:00Z");
  return Number.isFinite(t) ? t : null;
}

function csvEscape(v){
  const s = toStr(v);
  if (s.includes('"') || s.includes(",") || s.includes("\n") || s.includes("\r")) {
    return '"' + s.replace(/"/g,'""') + '"';
  }
  return s;
}

// ------------------- AUTH -------------------

r.post("/auth/login", (req, res) => {
  const email = normEmail(req.body?.email);
  const password = trim(req.body?.password);

  if (!email || !password) {
    return res.status(400).json({ ok:false, error:"email and password required" });
  }

  const db = readDB();
  if (!Array.isArray(db.ownerUsers)) db.ownerUsers = [];

  const u = db.ownerUsers.find(x => normEmail(x.email) === email);
  if (!u) return res.status(401).json({ ok:false, error:"Invalid login" });

  if (!verifyPassword(password, u.salt, u.passHash)) {
    return res.status(401).json({ ok:false, error:"Invalid login" });
  }

  const token = jwt.sign(
    { role:"owner", ownerId:u.ownerId, email:u.email, shops: Array.isArray(u.shops)?u.shops:[] },
    secret(),
    { expiresIn: "30d" }
  );

  return res.json({ ok:true, token, owner:{ ownerId:u.ownerId, email:u.email, shops: Array.isArray(u.shops)?u.shops:[] }});
});

r.get("/me", requireOwnerAuth, (req, res) => {
  return res.json({ ok:true, owner:{ ownerId:req.owner.ownerId, email:req.owner.email, shops:req.owner.shops || [] }});
});

// ------------------- DATA -------------------

r.get("/sync-status", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const shop = (db.shops||[]).find(s=>trim(s.shopId)===shopId) || null;
  return res.json({
    ok:true,
    shopId,
    lastSyncedAt: shop?.lastSyncedAt || shop?.updatedAt || shop?.createdAt || 0,
    lastSyncSource: shop?.lastSyncSource || "",
  });
});

r.get("/overview", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const fromMs = ymdToMs(req.query.from) || 0;
  const toMs = ymdToMs(req.query.to);
  const toMax = toMs ? (toMs + 24*3600*1000) : Number.POSITIVE_INFINITY;

  const sales = (db.sales||[]).filter(s => trim(s.shopId)===shopId && (s.createdAt||0)>=fromMs && (s.createdAt||0)<toMax);
  const products = (db.products||[]).filter(p => trim(p.shopId)===shopId);
  const debtors = (db.debtors||[]).filter(d => trim(d.shopId)===shopId);

  let revenue=0, paid=0, balance=0;
  for(const s of sales){
    revenue += Number(s.total||0) || 0;
    paid += Number(s.paid||0) || 0;
    balance += Number(s.remaining||Math.max(0,(Number(s.total||0)||0)-(Number(s.paid||0)||0)))||0;
  }

  const lowStock = products.filter(p => (Number(p.stock||0)||0) <= (Number(p.lowStockLevel||0)||0)).length;
  const expSoonDays = Number(req.query.soonDays||7) || 7;
  const today = Date.now();
  const expSoon = products.filter(p=>{
    const exp = ymdToMs(p.expiryDate || p.expiry || p.exp_date || "");
    if(!exp) return false;
    const diffDays = Math.floor((exp - today)/ (24*3600*1000));
    return diffDays>=0 && diffDays <= expSoonDays;
  }).length;
  const expired = products.filter(p=>{
    const exp = ymdToMs(p.expiryDate || p.expiry || p.exp_date || "");
    if(!exp) return false;
    return exp < today;
  }).length;

  return res.json({
    ok:true,
    kpis:{
      revenue, paid, balance,
      salesCount: sales.length,
      productsCount: products.length,
      debtorsCount: debtors.length,
      lowStockCount: lowStock,
      expiringSoonCount: expSoon,
      expiredCount: expired
    }
  });
});

r.get("/products", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const q = trim(req.query.q).toLowerCase();
  let list = (db.products||[]).filter(p=>trim(p.shopId)===shopId);

  if(q){
    list = list.filter(p=>{
      const name = toStr(p.name).toLowerCase();
      const barcode = toStr(p.barcode).toLowerCase();
      const sku = toStr(p.sku || p.plu || p.skuPlu || p.sku_plu).toLowerCase();
      return name.includes(q) || barcode.includes(q) || sku.includes(q);
    });
  }

  list.sort((a,b)=>toStr(a.name).localeCompare(toStr(b.name)));
  return res.json({ ok:true, items:list });
});

r.get("/sales", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const fromMs = ymdToMs(req.query.from) || 0;
  const toMs = ymdToMs(req.query.to);
  const toMax = toMs ? (toMs + 24*3600*1000) : Number.POSITIVE_INFINITY;

  const list = (db.sales||[])
    .filter(s=>trim(s.shopId)===shopId && (s.createdAt||0)>=fromMs && (s.createdAt||0)<toMax)
    .sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));

  return res.json({ ok:true, items:list });
});

// ------------------- EXPORTS -------------------

r.get("/export/sales.csv", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const fromMs = ymdToMs(req.query.from) || 0;
  const toMs = ymdToMs(req.query.to);
  const toMax = toMs ? (toMs + 24*3600*1000) : Number.POSITIVE_INFINITY;

  const list = (db.sales||[])
    .filter(s=>trim(s.shopId)===shopId && (s.createdAt||0)>=fromMs && (s.createdAt||0)<toMax)
    .sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));

  const header = ["date","receiptNo","customerName","customerPhone","total","paid","remaining","paymentMethod","cashier"];
  const lines = [header.join(",")];
  for(const s of list){
    const d = new Date(s.createdAt||0).toISOString();
    lines.push([
      d,
      csvEscape(s.receiptNo||""),
      csvEscape(s.customerName||""),
      csvEscape(s.customerPhone||""),
      (Number(s.total||0)||0),
      (Number(s.paid||0)||0),
      (Number(s.remaining||0)||0),
      csvEscape(s.paymentMethod||""),
      csvEscape(s.cashier||s.staffName||"")
    ].join(","));
  }

  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="sales_${shopId}.csv"`);
  return res.send(lines.join("\n"));
});

r.get("/export/products.csv", requireOwnerAuth, (req,res)=>{
  const db = readDB();
  const shopId = requireShopAccess(req,res);
  if(!shopId) return;

  const q = trim(req.query.q).toLowerCase();
  let list = (db.products||[]).filter(p=>trim(p.shopId)===shopId);
  if(q){
    list = list.filter(p=>{
      const name = toStr(p.name).toLowerCase();
      const barcode = toStr(p.barcode).toLowerCase();
      const sku = toStr(p.sku || p.plu || p.skuPlu || p.sku_plu).toLowerCase();
      return name.includes(q) || barcode.includes(q) || sku.includes(q);
    });
  }
  list.sort((a,b)=>toStr(a.name).localeCompare(toStr(b.name)));

  const header = ["name","sku_plu","barcode","stock","lowStockLevel","sellingPrice","cost","expiryDate","updatedAt"];
  const lines=[header.join(",")];
  for(const p of list){
    lines.push([
      csvEscape(p.name||""),
      csvEscape(p.sku || p.plu || p.skuPlu || p.sku_plu || ""),
      csvEscape(p.barcode||""),
      (Number(p.stock||0)||0),
      (Number(p.lowStockLevel||0)||0),
      (Number(p.price||p.sellingPrice||0)||0),
      (Number(p.cost||0)||0),
      csvEscape(p.expiryDate||p.expiry||""),
      csvEscape(new Date(p.updatedAt||p.createdAt||0).toISOString())
    ].join(","));
  }

  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="products_${shopId}.csv"`);
  return res.send(lines.join("\n"));
});

export default r;
