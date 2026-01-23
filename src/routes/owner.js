import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { signToken } from "../auth.js";
import { authMiddleware } from "../middleware/auth.js";

const r = Router();

function trim(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

function hashPassword(password, salt) {
  // scrypt is strong and built-in
  const key = crypto.scryptSync(password, salt, 32);
  return key.toString("hex");
}
function verifyPassword(password, salt, hashHex) {
  const h = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hashHex, "hex"));
}

/**
 * Owner Login
 * body: { email, password }
 */
r.post("/auth/login", (req, res) => {
  const email = trim(req.body?.email).toLowerCase();
  const password = trim(req.body?.password);
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  const db = readDB();
  const owner = (db.owners || []).find(o => (o.email || "").toLowerCase() === email && o.isDisabled !== true);
  if (!owner) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  try {
    const ok = verifyPassword(password, owner.salt, owner.passHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  const token = signToken({ sub: owner.ownerId, role: "owner", shops: owner.shops || [] }, secret, "30d");
  return res.json({ ok: true, token, owner: { ownerId: owner.ownerId, email: owner.email, shops: owner.shops || [] } });
});

/**
 * Owner profile
 */
r.get("/me", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const db = readDB();
  const owner = (db.owners || []).find(o => o.ownerId === auth.sub);
  if (!owner) return res.status(404).json({ ok: false, error: "Owner not found" });

  // attach shop names
  const shops = (owner.shops || []).map(id => {
    const s = (db.shops || []).find(x => x.shopId === id);
    return { shopId: id, shopName: s?.shopName || "", shopCode: s?.shopCode || "" };
  });

  return res.json({ ok: true, owner: { ownerId: owner.ownerId, email: owner.email, shops } });
});



// ------------------------------
// Owner Dashboard Data APIs (Protected)
// ------------------------------
function ensureDbArrays(db) {
  if (!Array.isArray(db.products)) db.products = [];
  if (!Array.isArray(db.sales)) db.sales = [];
  if (!Array.isArray(db.debtors)) db.debtors = [];
  if (!Array.isArray(db.shops)) db.shops = [];
}
function toInt(v, def=0){ const n = parseInt(trim(v),10); return Number.isFinite(n)?n:def; }
function toNum(v, def=0){ const n = Number(v); return Number.isFinite(n)?n:def; }
function norm(v){ return trim(v).toLowerCase().replace(/\s+/g,' '); }

function requireOwner(req, res){
  const auth = req.auth || {};
  if (auth.role !== "owner") {
    res.status(403).json({ ok:false, error:"Forbidden" });
    return null;
  }
  const shops = Array.isArray(auth.shops) ? auth.shops : [];
  return { ownerId: auth.sub, shops };
}

function requireOwnerShop(req, res, shopId){
  const o = requireOwner(req,res);
  if (!o) return null;
  const sid = trim(shopId);
  if (!sid) { res.status(400).json({ ok:false, error:"shopId required" }); return null; }
  if (!o.shops.includes(sid)) { res.status(403).json({ ok:false, error:"Shop not assigned" }); return null; }
  return sid;
}

// GET /api/owner/dashboard/overview?shopId=XXX&days=30
r.get("/dashboard/overview", authMiddleware, (req,res)=>{
  const shopId = requireOwnerShop(req,res, req.query.shopId);
  if (!shopId) return;

  const days = Math.min(Math.max(toInt(req.query.days, 30), 1), 365);
  const now = Date.now();
  const since = now - days*24*60*60*1000;

  const db = readDB(); ensureDbArrays(db);

  const sales = db.sales
    .filter(s => trim(s.shopId) === shopId)
    .filter(s => toInt(s.createdAt || 0, 0) >= since);

  let salesCount=0, revenue=0, paid=0, balance=0, itemsSold=0;
  for(const s of sales){
    salesCount++;
    revenue += toNum(s.total,0);
    paid += toNum(s.paid,0);
    balance += toNum(s.remaining,0);
    const items = Array.isArray(s.items)?s.items:[];
    for(const it of items){
      const q = Math.max(1, toInt(it.qty || 1, 1));
      itemsSold += q;
    }
  }

  const products = db.products.filter(p => trim(p.shopId) === shopId);
  const lowStock = products.filter(p => toNum(p.stock,0) <= toNum(p.lowStockLevel,0) && toNum(p.lowStockLevel,0) > 0).length;

  return res.json({
    ok:true,
    shopId,
    rangeDays: days,
    kpi: { salesCount, revenue, paid, balance, itemsSold, products: products.length, lowStock },
    serverTime: now
  });
});

// GET /api/owner/dashboard/products?shopId=XXX&q=abc&limit=200
r.get("/dashboard/products", authMiddleware, (req,res)=>{
  const shopId = requireOwnerShop(req,res, req.query.shopId);
  if (!shopId) return;
  const q = norm(req.query.q || "");
  const limit = Math.min(Math.max(toInt(req.query.limit, 200), 1), 500);

  const db = readDB(); ensureDbArrays(db);
  let items = db.products.filter(p => trim(p.shopId) === shopId);

  if(q){
    items = items.filter(p => {
      const name = norm(p.name || "");
      const barcode = norm(p.barcode || "");
      const sku = norm(p.sku || "");
      const plu = norm(p.plu || "");
      return name.includes(q) || barcode.includes(q) || sku.includes(q) || plu.includes(q);
    });
  }

  items = items
    .sort((a,b)=> toInt(b.updatedAt||b.createdAt||0,0) - toInt(a.updatedAt||a.createdAt||0,0))
    .slice(0, limit)
    .map(p => ({
      productId: p.productId || p.id,
      name: p.name || "",
      price: toNum(p.price,0),
      cost: toNum(p.cost,0),
      stock: toNum(p.stock,0),
      barcode: p.barcode || "",
      sku: p.sku || "",
      plu: p.plu || "",
      expiryDate: p.expiryDate || p.expiry || "",
      lowStockLevel: toNum(p.lowStockLevel,0),
      updatedAt: toInt(p.updatedAt||p.createdAt||0,0)
    }));

  return res.json({ ok:true, shopId, items, serverTime: Date.now() });
});

// GET /api/owner/dashboard/sales?shopId=XXX&days=7&limit=200
r.get("/dashboard/sales", authMiddleware, (req,res)=>{
  const shopId = requireOwnerShop(req,res, req.query.shopId);
  if (!shopId) return;

  const days = Math.min(Math.max(toInt(req.query.days, 7), 1), 365);
  const limit = Math.min(Math.max(toInt(req.query.limit, 200), 1), 500);
  const now = Date.now();
  const since = now - days*24*60*60*1000;

  const db = readDB(); ensureDbArrays(db);
  const items = db.sales
    .filter(s => trim(s.shopId) === shopId)
    .filter(s => toInt(s.createdAt||0,0) >= since)
    .sort((a,b)=> toInt(b.createdAt||0,0) - toInt(a.createdAt||0,0))
    .slice(0, limit)
    .map(s => ({
      receiptNo: s.receiptNo || "",
      total: toNum(s.total,0),
      paid: toNum(s.paid,0),
      remaining: toNum(s.remaining,0),
      paymentMethod: s.paymentMethod || "",
      cashier: s.cashier || s.staffName || "",
      createdAt: toInt(s.createdAt||0,0),
      itemsCount: Array.isArray(s.items)?s.items.length:0
    }));

  return res.json({ ok:true, shopId, rangeDays: days, items, serverTime: now });
});

export default r;
