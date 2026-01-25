import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { signToken } from "../auth.js";
import { authMiddleware } from "../middleware/auth.js";

const r = Router();

function trim(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

function asNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function pickShopId(row) {
  const a = row || {};
  return trim(a.shopId || a.shopID || a.shop_id || a.sid || a.shop || a.shop_id_fk);
}

function pickSaleTotal(s) {
  // Support multiple field names across app versions
  return asNum(
    s?.total ??
      s?.grandTotal ??
      s?.amountTotal ??
      s?.totalAmount ??
      s?.total_price ??
      s?.totalPrice ??
      0,
    0
  );
}

function pickSalePaid(s) {
  return asNum(
    s?.paid ??
      s?.amountPaid ??
      s?.paidAmount ??
      s?.cashPaid ??
      s?.cash ??
      0,
    0
  );
}

function pickSaleRemaining(s) {
  // Remaining might be stored as balance/credit
  return asNum(
    s?.remaining ??
      s?.balance ??
      s?.due ??
      s?.credit ??
      s?.amountDue ??
      0,
    0
  );
}

function asInt(v, d = 0) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
}

function requireOwner(req, res) {
  if (!req?.auth || req.auth.role !== "owner") {
    res.status(403).json({ ok: false, error: "Owner access required" });
    return false;
  }
  return true;
}

function canAccessShop(req, shopId) {
  try {
    const shops = Array.isArray(req?.auth?.shops) ? req.auth.shops : [];
    return shops.includes(shopId);
  } catch (e) {
    return false;
  }
}

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
    return {
      shopId: id,
      shopName: s?.shopName || "",
      shopCode: s?.shopCode || "",
      // richer shop profile (filled by /api/sync/shop/profile)
      address: s?.address || "",
      phone: s?.phone || "",
      whatsapp: s?.whatsapp || "",
      tagline: s?.tagline || "",
      currency: s?.currency || "",
      footer: s?.footer || "",
      updatedAt: s?.updatedAt || 0,
    };
  });

  return res.json({ ok: true, owner: { ownerId: owner.ownerId, email: owner.email, shops } });
});

/**
 * Owner shop overview (counts + totals)
 */
r.get("/shop/:shopId/overview", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const db = readDB();
  const shop = (db.shops || []).find(s => s.shopId === shopId);
  const products = (db.products || []).filter(p => pickShopId(p) === shopId);
  const sales = (db.sales || []).filter(s => pickShopId(s) === shopId);
  const debtors = (db.debtors || []).filter(d => pickShopId(d) === shopId);

  const totalSales = sales.reduce((sum, s) => sum + pickSaleTotal(s), 0);
  const totalPaid = sales.reduce((sum, s) => sum + pickSalePaid(s), 0);
  const totalRemaining = sales.reduce((sum, s) => sum + pickSaleRemaining(s), 0);

  return res.json({
    ok: true,
    shop: shop || { shopId },
    kpi: {
      products: products.length,
      sales: sales.length,
      debtors: debtors.length,
      totalSales,
      totalPaid,
      totalRemaining,
    }
  });
});

/**
 * Owner: products table
 */
r.get("/shop/:shopId/products", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });
  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const db = readDB();
  const q = trim(req.query.q || "").toLowerCase();
  let items = (db.products || []).filter(p => pickShopId(p) === shopId);
  if (q) {
    items = items.filter(p => {
      const name = trim(p.name).toLowerCase();
      const sku = trim(p.sku).toLowerCase();
      const bc = trim(p.barcode).toLowerCase();
      return name.includes(q) || sku.includes(q) || bc.includes(q);
    });
  }
  items.sort((a, b) => trim(a.name).localeCompare(trim(b.name)));
  return res.json({ ok: true, items });
});

/**
 * Owner: sales table
 */
r.get("/shop/:shopId/sales", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });
  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const from = asInt(req.query.from, 0);
  const to = asInt(req.query.to, 0);
  const limit = Math.min(2000, Math.max(50, asInt(req.query.limit, 500)));

  const db = readDB();
  let items = (db.sales || []).filter(s => pickShopId(s) === shopId);
  if (from > 0) items = items.filter(s => asInt(s.createdAt, 0) >= from);
  if (to > 0) items = items.filter(s => asInt(s.createdAt, 0) <= to);
  items.sort((a, b) => asInt(b.createdAt, 0) - asInt(a.createdAt, 0));
  items = items.slice(0, limit);

  // Normalize for Owner dashboard (online should look like Local Hub dashboard)
  const norm = items.map((s) => {
    const receiptNo = (s.receiptNo || s.saleNo || s.receipt || s.id || "").toString();
    const paymentMethod = (s.paymentMethod || s.method || s.payMethod || "").toString();
    const status = (s.status || s.payStatus || "").toString();
    const staffUser = (s.staffUser || s.staff || s.user || "").toString();
    const createdAt = asInt(s.createdAt, 0) || asInt(s.ts, 0) || 0;
    const total = pickSaleTotal(s);
    const paid = pickSalePaid(s);
    const remaining = Math.max(0, total - paid);
    const itemsCount = Array.isArray(s.items) ? s.items.length : asInt(s.itemsCount, 0);

    return {
      receiptNo,
      staffUser,
      paymentMethod,
      status,
      itemsCount,
      total,
      paid,
      remaining,
      createdAt,
      raw: s,
    };
  });

  return res.json({ ok: true, items: norm });
});

/**
 * Owner: debtors table
 */
r.get("/shop/:shopId/debtors", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });
  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const db = readDB();
  let items = (db.debtors || []).filter(d => pickShopId(d) === shopId)
    .sort((a, b) => asInt(b.createdAt, 0) - asInt(a.createdAt, 0));

	const norm = items.map((d) => {
	  const customerName = (
	    d.customerName ||
	    d.name ||
	    d.fullName ||
	    d.customer ||
	    d.custName ||
	    d.buyerName ||
	    d.buyer ||
	    (d.customerObj && (d.customerObj.name || d.customerObj.fullName)) ||
	    ""
	  ).toString();
	  const customerPhone = (
	    d.customerPhone ||
	    d.phone ||
	    d.tel ||
	    d.mobile ||
	    d.custPhone ||
	    d.buyerPhone ||
	    (d.customerObj && (d.customerObj.phone || d.customerObj.mobile || d.customerObj.tel)) ||
	    ""
	  ).toString();
    const receiptNo = (d.receiptNo || d.saleNo || d.receipt || "").toString();
    const total = pickDebtorTotal(d);
    const paid = pickDebtorPaid(d);
    const remaining = pickDebtorRemaining(d);
    const createdAt = asInt(d.createdAt, 0) || 0;
    const status = (d.status || "").toString();
    return {
      customerName,
      customerPhone,
      receiptNo,
      total,
      paid,
      remaining,
      status,
      createdAt,
      raw: d,
    };
  });

  return res.json({ ok: true, items: norm });
});

export default r;
