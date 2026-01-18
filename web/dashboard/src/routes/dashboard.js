import { Router } from "express";
import { readDB } from "../db.js";

const r = Router();

function toStr(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

function trim(v) {
  return toStr(v).trim();
}

function toInt(v, def = 0) {
  const n = parseInt(toStr(v), 10);
  return Number.isFinite(n) ? n : def;
}

function toNum(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function ensureDbArrays(db) {
  if (!Array.isArray(db.products)) db.products = [];
  if (!Array.isArray(db.staffs)) db.staffs = [];
  if (!Array.isArray(db.sales)) db.sales = [];
  if (!Array.isArray(db.debtors)) db.debtors = [];
  if (!Array.isArray(db.shops)) db.shops = [];
}

function pickShopId(db, shopIdOrCode) {
  const v = trim(shopIdOrCode);
  if (!v) return (db.shops[0] && db.shops[0].shopId) ? db.shops[0].shopId : "";
  const byId = db.shops.find((s) => trim(s.shopId) === v);
  if (byId) return byId.shopId;
  const byCode = db.shops.find((s) => trim(s.shopCode) === v);
  if (byCode) return byCode.shopId;
  return v; // fallback (maybe already a shopId not yet in shops[])
}

function dayKey(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function clampDays(v, def = 30) {
  const n = toInt(v, def);
  if (n <= 0) return def;
  return Math.min(Math.max(n, 1), 365);
}

r.get("/shops", (_req, res) => {
  const db = readDB();
  ensureDbArrays(db);
  const items = db.shops.map((s) => ({
    shopId: s.shopId,
    shopCode: s.shopCode,
    shopName: s.shopName || "",
    address: s.address || "",
    phone: s.phone || "",
    whatsapp: s.whatsapp || "",
    currency: s.currency || "",
  }));
  res.json({ ok: true, items, serverTime: Date.now() });
});

r.get("/overview", (req, res) => {
  const db = readDB();
  ensureDbArrays(db);

  const shopId = pickShopId(db, req.query.shopId || req.query.shopCode);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });

  const days = clampDays(req.query.days, 30);
  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;

  const sales = db.sales
    .filter((s) => trim(s.shopId) === shopId)
    .filter((s) => toInt(s.createdAt || 0, 0) >= since)
    .sort((a, b) => toInt(b.createdAt || 0, 0) - toInt(a.createdAt || 0, 0));

  let salesCount = 0;
  let revenue = 0;
  let paid = 0;
  let remaining = 0;
  let itemsSold = 0;
  const byDay = new Map();
  const prodQty = new Map();
  const payMethods = new Map();

  for (const s of sales) {
    salesCount++;
    revenue += toNum(s.total, 0);
    paid += toNum(s.paid, 0);
    remaining += toNum(s.remaining, 0);

    const dk = dayKey(toInt(s.createdAt || 0, 0));
    if (dk) {
      const prev = byDay.get(dk) || { day: dk, revenue: 0, count: 0 };
      prev.revenue += toNum(s.total, 0);
      prev.count += 1;
      byDay.set(dk, prev);
    }

    const pm = trim(s.paymentMethod || "").toUpperCase() || "OTHER";
    payMethods.set(pm, (payMethods.get(pm) || 0) + 1);

    const items = Array.isArray(s.items) ? s.items : [];
    for (const it of items) {
      const q = Math.max(1, toInt(it.qty || 1, 1));
      itemsSold += q;
      const key = trim(it.code) || trim(it.barcode) || trim(it.sku) || trim(it.productName) || "UNKNOWN";
      prodQty.set(key, (prodQty.get(key) || 0) + q);
    }
  }

  // Build last N days array (fill missing days)
  const salesByDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 24 * 60 * 60 * 1000;
    const k = dayKey(t);
    const row = byDay.get(k) || { day: k, revenue: 0, count: 0 };
    salesByDay.push(row);
  }

  const products = db.products.filter((p) => trim(p.shopId) === shopId);
  const staffs = db.staffs.filter((s) => trim(s.shopId) === shopId);
  const debtors = db.debtors.filter((d) => trim(d.shopId) === shopId);

  const lowStockThreshold = toInt(req.query.lowStock || 3, 3);
  const lowStockCount = products.filter((p) => toInt(p.stock, 0) <= lowStockThreshold).length;

  const totalOwed = debtors.reduce((acc, d) => acc + toNum(d.totalOwed, 0), 0);

  const topProducts = Array.from(prodQty.entries())
    .map(([k, v]) => ({ key: k, qty: v }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const paymentBreakdown = Array.from(payMethods.entries())
    .map(([k, v]) => ({ method: k, count: v }))
    .sort((a, b) => b.count - a.count);

  const shop = db.shops.find((s) => trim(s.shopId) === shopId) || { shopId };

  res.json({
    ok: true,
    shop: {
      shopId,
      shopCode: shop.shopCode || "",
      shopName: shop.shopName || "",
      address: shop.address || "",
      phone: shop.phone || "",
      whatsapp: shop.whatsapp || "",
      currency: shop.currency || "",
    },
    range: { days, since, now },
    metrics: {
      salesCount,
      revenue,
      paid,
      remaining,
      itemsSold,
      productsCount: products.length,
      lowStockCount,
      staffCount: staffs.length,
      debtorsCount: debtors.length,
      totalOwed,
    },
    salesByDay,
    topProducts,
    paymentBreakdown,
    serverTime: now,
  });
});

r.get("/sales", (req, res) => {
  const db = readDB();
  ensureDbArrays(db);

  const shopId = pickShopId(db, req.query.shopId || req.query.shopCode);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });

  const limit = Math.min(Math.max(toInt(req.query.limit, 200), 1), 1000);
  const from = toInt(req.query.from || "0", 0);
  const to = toInt(req.query.to || String(Date.now()), Date.now());

  const items = db.sales
    .filter((s) => trim(s.shopId) === shopId)
    .filter((s) => {
      const t = toInt(s.createdAt || 0, 0);
      return t >= from && t <= to;
    })
    .sort((a, b) => toInt(b.createdAt || 0, 0) - toInt(a.createdAt || 0, 0))
    .slice(0, limit);

  res.json({ ok: true, items, serverTime: Date.now() });
});

r.get("/products", (req, res) => {
  const db = readDB();
  ensureDbArrays(db);
  const shopId = pickShopId(db, req.query.shopId || req.query.shopCode);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  const items = db.products
    .filter((p) => trim(p.shopId) === shopId)
    .sort((a, b) => (toInt(a.stock, 0) - toInt(b.stock, 0)) || (trim(a.name).localeCompare(trim(b.name))));
  res.json({ ok: true, items, serverTime: Date.now() });
});

r.get("/debtors", (req, res) => {
  const db = readDB();
  ensureDbArrays(db);
  const shopId = pickShopId(db, req.query.shopId || req.query.shopCode);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  const items = db.debtors
    .filter((d) => trim(d.shopId) === shopId)
    .sort((a, b) => toNum(b.totalOwed, 0) - toNum(a.totalOwed, 0));
  res.json({ ok: true, items, serverTime: Date.now() });
});

r.get("/staff", (req, res) => {
  const db = readDB();
  ensureDbArrays(db);
  const shopId = pickShopId(db, req.query.shopId || req.query.shopCode);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });

  const days = clampDays(req.query.days, 30);
  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;

  const sales = db.sales
    .filter((s) => trim(s.shopId) === shopId)
    .filter((s) => toInt(s.createdAt || 0, 0) >= since);

  const map = new Map();
  for (const s of sales) {
    const staffKey = trim(s.staffUser) || trim(s.staffName) || String(s.staffId || "Unknown");
    const row = map.get(staffKey) || { staff: staffKey, salesCount: 0, revenue: 0, paid: 0, remaining: 0, itemsSold: 0 };
    row.salesCount += 1;
    row.revenue += toNum(s.total, 0);
    row.paid += toNum(s.paid, 0);
    row.remaining += toNum(s.remaining, 0);
    const items = Array.isArray(s.items) ? s.items : [];
    for (const it of items) row.itemsSold += Math.max(1, toInt(it.qty || 1, 1));
    map.set(staffKey, row);
  }

  const items = Array.from(map.values())
    .map((x) => ({
      ...x,
      avgSale: x.salesCount > 0 ? (x.revenue / x.salesCount) : 0,
    }))
    .sort((a, b) => b.revenue - a.revenue);

  res.json({ ok: true, range: { days, since, now }, items, serverTime: now });
});

export default r;
