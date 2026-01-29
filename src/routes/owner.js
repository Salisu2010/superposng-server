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

// Debtors may be stored separately OR derived from unpaid sales.
function pickDebtorTotal(d) {
  return asNum(
    d?.total ??
      d?.amountTotal ??
      d?.totalAmount ??
      d?.grandTotal ??
      d?.amount ??
      // v6 aggregate format
      d?.totalOwed ??
      d?.total_owed ??
      d?.owed ??
      d?.balanceOwed ??
      d?.remainingOwed ??
      0,
    0
  );
}

function pickDebtorPaid(d) {
  // Some versions store only remaining; infer paid if possible
  const paid = asNum(
    d?.paid ??
      d?.amountPaid ??
      d?.paidAmount ??
      d?.cashPaid ??
      d?.cash ??
      0,
    0
  );
  if (paid > 0) return paid;
  const total = pickDebtorTotal(d);
  const rem = pickDebtorRemaining(d);
  if (total > 0 && rem >= 0 && rem <= total) return Math.max(0, total - rem);
  return 0;
}

function pickDebtorRemaining(d) {
  // In some payloads "amount" means remaining
  return asNum(
    d?.remaining ??
      d?.balance ??
      d?.due ??
      d?.credit ??
      d?.amountDue ??
      d?.amount ??
      // v6 aggregate format
      d?.remainingOwed ??
      d?.balanceOwed ??
      d?.totalOwed ??
      d?.total_owed ??
      d?.owed ??
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
// --- Expiry helpers (robust parsing across Android/legacy fields) ---
function _asMsMaybe(v) {
  if (v === null || v === undefined) return null;

  // numeric input (ms or seconds)
  if (typeof v === "number" && Number.isFinite(v)) {
    return v < 1e12 ? Math.floor(v * 1000) : Math.floor(v);
  }

  const s = String(v).trim();
  if (!s) return null;

  // date-only YYYYMMDD (Android expiryYmd, e.g. "20260127")
  if (/^\d{8}$/.test(s)) {
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(4, 6));
    const d = Number(s.slice(6, 8));
    const dt = new Date(y, m - 1, d, 0, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt.getTime();
  }

  // numeric string (ms or seconds)
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return n < 1e12 ? Math.floor(n * 1000) : Math.floor(n);
  }

  // ISO or parseable date string
  const t = Date.parse(s);
  if (!isNaN(t)) return t;

  // Try common YYYY-MM-DD
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
    return isNaN(dt.getTime()) ? null : dt.getTime();
  }


  // Try common DD/MM/YYYY or MM/DD/YYYY
  const dm = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dm) {
    const a = Number(dm[1]);
    const b = Number(dm[2]);
    const y = Number(dm[3]);
    // Prefer DD/MM/YYYY for NG; if ambiguous (<=12 and <=12), treat as DD/MM.
    const day = a;
    const month = b;
    const dt = new Date(y, month - 1, day, 0, 0, 0, 0);
    if (!isNaN(dt.getTime())) return dt.getTime();
    // fallback swap
    const dt2 = new Date(y, a - 1, b, 0, 0, 0, 0);
    return isNaN(dt2.getTime()) ? null : dt2.getTime();
  }
  return null;
}


function getExpiryMs(p){
  if (!p) return null;
  const candidates = [
    // Most common (web/legacy)
    p.expiryDate,
    p.expiringDate,
    p.expiry,
    p.expiry_date,
    p.expiryDateMs,
    p.expDate,
    p.expiryAt,
    p.expiry_at,
    p.exp,

    // Android vNext (YYYYMMDD)
    p.expiryYmd,
    p.expYmd,
    p.expiry_ymd,
    p.expYMD,
    p.expiryYMD,
  ];
  for (const c of candidates){
    const ms = _asMsMaybe(c);
    if (ms) return ms;
  }

  // Heuristic fallback: look for any field name containing "expir"
  try {
    for (const k of Object.keys(p)) {
      if (!k) continue;
      if (!/expir/i.test(k)) continue;
      const ms = _asMsMaybe(p[k]);
      if (ms) return ms;
    }
  } catch (e) {}

  return null;
}

function msToYmd(ms){
  if (!ms || !isFinite(ms)) return "";
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,"0");
  const da = String(d.getDate()).padStart(2,"0");
  return `${y}-${m}-${da}`;
}

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
 * Owner shop overview (counts + totals + trend + product intelligence)
 *
 * Query params:
 *  - days: range for trend calculations (default 30, max 365)
 *  - lowStock: stock threshold (default 3)
 *  - soonDays: expiring-soon window in days (default 30)
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
  const salesAll = (db.sales || []).filter(s => pickShopId(s) === shopId);
  const debtors = (db.debtors || []).filter(d => pickShopId(d) === shopId);

  // If explicit debtors table is empty, derive debtors count from unpaid sales.
  let debtorsCount = Array.isArray(debtors) ? debtors.length : 0;
  if (debtorsCount === 0) {
    debtorsCount = salesAll.filter(s => pickSaleRemaining(s) > 0).length;
  }

  // Totals (all-time)
  const totalSales = salesAll.reduce((sum, s) => sum + pickSaleTotal(s), 0);
  const totalPaid = salesAll.reduce((sum, s) => sum + pickSalePaid(s), 0);
  const totalRemaining = salesAll.reduce((sum, s) => sum + pickSaleRemaining(s), 0);

  // Trend & product performance (range)
  const daysRaw = asInt(req.query.days || 30, 30);
  const days = Math.max(1, Math.min(daysRaw, 365));
  const now = Date.now();
  const since = now - (days * 24 * 60 * 60 * 1000);

  function dayKey(ts) {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const da = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function pickSaleCreatedAt(s) {
    return asInt(
      s?.createdAt ??
      s?.time ??
      s?.timestamp ??
      s?.date ??
      0,
      0
    );
  }

  function pickItemQty(it) {
    return Math.max(1, asInt(it?.qty ?? it?.quantity ?? 1, 1));
  }

  function pickItemPrice(it) {
    return asNum(
      it?.price ??
      it?.unitPrice ??
      it?.unit_price ??
      it?.sellingPrice ??
      it?.amount ??
      0,
      0
    );
  }

  function pickItemKey(it) {
    return trim(it?.code || it?.barcode || it?.sku || it?.plu || it?.productId || it?.name || it?.productName);
  }

  // sales within range
  const sales = salesAll
    .filter(s => pickSaleCreatedAt(s) >= since && pickSaleCreatedAt(s) <= now);

  // per-day buckets (fill missing days)
  const byDay = new Map();
  for (const s of sales) {
    const dk = dayKey(pickSaleCreatedAt(s));
    if (!dk) continue;
    const prev = byDay.get(dk) || { day: dk, revenue: 0, count: 0 };
    prev.revenue += pickSaleTotal(s);
    prev.count += 1;
    byDay.set(dk, prev);
  }

  const salesByDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = now - i * 24 * 60 * 60 * 1000;
    const k = dayKey(t);
    const row = byDay.get(k) || { day: k, revenue: 0, count: 0 };
    salesByDay.push(row);
  }

  // product performance
  const qtyByKey = new Map();
  const valByKey = new Map();
  for (const s of sales) {
    const items = Array.isArray(s.items) ? s.items : [];
    for (const it of items) {
      const key = pickItemKey(it) || "UNKNOWN";
      const q = pickItemQty(it);
      const price = pickItemPrice(it);
      qtyByKey.set(key, (qtyByKey.get(key) || 0) + q);
      valByKey.set(key, (valByKey.get(key) || 0) + (price * q));
    }
  }

  function productLabelForKey(key) {
    const lk = trim(key).toLowerCase();
    if (!lk) return key;
    const p = products.find(pp => {
      const name = trim(pp.name).toLowerCase();
      const sku = trim(pp.sku).toLowerCase();
      const bc = trim(pp.barcode).toLowerCase();
      const plu = trim(pp.plu).toLowerCase();
      const pid = trim(pp.productId || pp.id).toLowerCase();
      return lk && (lk === bc || lk === sku || lk === plu || lk === pid || lk === name);
    });
    if (!p) return key;
    return trim(p.name) || key;
  }

  const topProducts = Array.from(qtyByKey.entries())
    .map(([key, qty]) => ({ key, name: productLabelForKey(key), qty, value: asNum(valByKey.get(key) || 0, 0) }))
    .sort((a, b) => b.qty - a.qty)
    .slice(0, 10);

  const topProductsByValue = Array.from(valByKey.entries())
    .map(([key, value]) => ({ key, name: productLabelForKey(key), qty: asInt(qtyByKey.get(key) || 0, 0), value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);

  // Slow-moving products: lowest sold qty in range (include zeros)
  function keyForProduct(p) {
    return trim(p.barcode || p.sku || p.plu || p.productId || p.id || p.name);
  }

  const slowProducts = products
    .map((p) => {
      const key = keyForProduct(p);
      const qty = asInt(qtyByKey.get(key) || 0, 0);
      return {
        key,
        name: trim(p.name) || key || "UNKNOWN",
        qty,
        stock: asInt(p.stock ?? p.quantity ?? 0, 0),
        price: asNum(p.price ?? p.sellingPrice ?? p.unitPrice ?? 0, 0),
      };
    })
    .sort((a, b) => a.qty - b.qty)
    .slice(0, 10);

  // Low-stock & expiry alerts
  const lowStockThreshold = Math.max(0, asInt(req.query.lowStock || 3, 3));
  const lowStockCount = products.filter(p => asInt(p.stock ?? p.quantity ?? 0, 0) <= lowStockThreshold).length;

  let soonDays = Math.max(1, Math.min(asInt(req.query.soonDays || 0, 0), 365));
  // Default: 90 days (3 months). Allow per-shop override.
  if (!soonDays || soonDays <= 0) {
    const sds = asInt(shop?.expirySoonDays || 0, 0);
    soonDays = (sds > 0 && sds <= 365) ? sds : 90;
  }

  function parseExpiry(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(v).trim();
    if (!s) return null;
    // YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const n = Number(s);
    if (Number.isFinite(n) && s.length >= 10) {
      const d = new Date(n);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function expiryDateFromProduct(p) {
    const ms = getExpiryMs(p);
    if (!ms) return null;
    return new Date(ms);
  }

  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const soonMs = soonDays * 24 * 60 * 60 * 1000;

  let expiredCount = 0;
  let expiringSoonCount = 0;

  for (const p of products) {
    const d = expiryDateFromProduct(p);
    if (!d) continue;
    const t = d.getTime();
    if (t < today0.getTime()) expiredCount++;
    else if (t <= (today0.getTime() + soonMs)) expiringSoonCount++;
  }

  return res.json({
    ok: true,
    shop: shop || { shopId },
    range: { days, since, now, soonDays, lowStockThreshold },
    kpi: {
      products: products.length,
      sales: salesAll.length,
      debtors: debtorsCount,
      totalSales,
      totalPaid,
      totalRemaining,
      lowStock: lowStockCount,
      expired: expiredCount,
      expiringSoon: expiringSoonCount,
    },
    trend: {
      salesByDay,
    },
    productPerformance: {
      topProducts,
      topProductsByValue,
      slowProducts,
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

  // Prefer explicit debtors collection if present.
  let items = (db.debtors || []).filter(d => pickShopId(d) === shopId)
    .sort((a, b) => asInt(b.createdAt, 0) - asInt(a.createdAt, 0));

  // Fallback: derive debtors from unpaid sales if debtors table is empty.
  if (!items || items.length === 0) {
    const sales = (db.sales || []).filter(s => pickShopId(s) === shopId);
    const derived = [];
    for (const s of sales) {
      const remaining = pickSaleRemaining(s);
      if (remaining <= 0) continue;
      derived.push({
        shopId,
        customerName: (s.customerName || s.name || "").toString(),
        customerPhone: (s.customerPhone || s.phone || "").toString(),
        receiptNo: (s.receiptNo || s.saleNo || s.receipt || "").toString(),
        total: pickSaleTotal(s),
        paid: pickSalePaid(s),
        remaining,
        status: (s.status || "").toString(),
        createdAt: asInt(s.createdAt, 0) || 0,
        _derived: true,
      });
    }
    items = derived.sort((a, b) => asInt(b.createdAt, 0) - asInt(a.createdAt, 0));
  }

  // Lookup from sales by receiptNo to backfill customer details.
  // Fixes cases where debtor rows have empty name/phone.
  const salesByReceipt = new Map();
  try {
    for (const s of db.sales || []) {
      if (!s) continue;
      if ((s.shopId || "") !== shopId) continue;
      const rno = (s.receiptNo || s.saleNo || s.receipt || "").toString().trim();
      if (!rno) continue;
      if (!salesByReceipt.has(rno)) salesByReceipt.set(rno, s);
    }
  } catch (e) {
    // ignore
  }

  const norm = items.map((d) => {
    const receiptNo = (d.receiptNo || d.saleNo || d.receipt || "").toString();
    let customerName = (d.customerName || d.name || "").toString();
    let customerPhone = (d.customerPhone || d.phone || "").toString();

    // Backfill from sales if debtor row is missing customer fields.
    if ((!customerName || !customerName.trim()) || (!customerPhone || !customerPhone.trim())) {
      const s = receiptNo ? salesByReceipt.get(receiptNo) : null;
      if (s) {
        if (!customerName || !customerName.trim()) {
          customerName = (s.customerName || s.name || (s.customer && s.customer.name) || "").toString();
        }
        if (!customerPhone || !customerPhone.trim()) {
          customerPhone = (s.customerPhone || s.phone || (s.customer && s.customer.phone) || "").toString();
        }
      }
    }

    // Final fallback: never show blank strings in UI.
    if (!customerName || !customerName.trim()) customerName = "Walk-in";
    if (!customerPhone || !customerPhone.trim()) customerPhone = "-";
    const total = pickDebtorTotal(d);
    const paid = pickDebtorPaid(d);
    const remaining = pickDebtorRemaining(d);
    const createdAt = asInt(d.createdAt, 0) || 0;
    const status = (d.status || "").toString();
    return {
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
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

// -------------------------------------------------
// ✅ Professional Debtor Payments (Owner dashboard)
// -------------------------------------------------
// Records a payment against a debtor row (prefer receiptNo). If receiptNo is missing,
// it will pay oldest open debtor(s) for the provided phone.
// Body: { receiptNo?, phone?, amount, method?, note? }

// Pay a specific debtor by debtorId (id/receiptNo). Body: { amount, method?, note?, receiptNo?, phone? }
r.post("/shop/:shopId/debtors/:debtorId/pay", authMiddleware, (req, res) => {
  try {
    const { shopId, debtorId } = req.params;
    const body = req.body || {};
    // Prefer explicit debtorId match; fallback to receiptNo/phone if provided
    const receiptNo = (body.receiptNo || body.receipt || body.saleNo || debtorId || "").toString().trim();
    const phone = (body.phone || body.customerPhone || "").toString().trim();
    const method = (body.method || body.paymentMethod || "CASH").toString().trim().toUpperCase();
    const note = (body.note || "").toString().trim();
    const amount = Number(body.amount || body.paid || 0);

    if (!shopId || !shopId.trim()) return res.status(400).json({ ok: false, error: "Missing shopId" });
    if (!debtorId || !String(debtorId).trim()) return res.status(400).json({ ok: false, error: "Missing debtorId" });
    if (!amount || !isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });

    const db = readDB();
    if (!Array.isArray(db.debtors)) db.debtors = [];
    if (!Array.isArray(db.debtorPayments)) db.debtorPayments = [];

    const now = Date.now();
    const did = String(debtorId);

    const candidates = db.debtors
      .filter(d => (d && pickShopId(d) === shopId))
      .filter(d => {
        const rn = (d.receiptNo || d.receipt || d.saleNo || d.id || d.debtorId || "").toString();
        if (rn === did) return true;
        // allow matching by explicit receiptNo too
        if (receiptNo && rn === receiptNo) return true;
        return false;
      })
      .map(d => {
        const total = pickDebtorTotal(d);
        const paid = pickDebtorPaid(d);
        const remaining = pickDebtorRemaining(d);
        const createdAt = asInt(d.createdAt, 0) || 0;
        return { d, total, paid, remaining, createdAt };
      })
      .filter(x => x.remaining > 0.0001)
      .sort((a,b) => a.createdAt - b.createdAt);

    if (candidates.length === 0) {
      // Fallback: if debtorId isn't found, try phone-based payment for open debtor(s)
      if (!phone) return res.status(404).json({ ok: false, error: "Debtor not found" });
      const byPhone = db.debtors
        .filter(d => (d && pickShopId(d) === shopId))
        .filter(d => {
          const ph = (d.customerPhone || d.phone || d.customer && d.customer.phone || "").toString();
          return ph && phone && ph === phone;
        })
        .map(d => {
          const total = pickDebtorTotal(d);
          const paid = pickDebtorPaid(d);
          const remaining = pickDebtorRemaining(d);
          const createdAt = asInt(d.createdAt, 0) || 0;
          return { d, total, paid, remaining, createdAt };
        })
        .filter(x => x.remaining > 0.0001)
        .sort((a,b) => a.createdAt - b.createdAt);

      if (byPhone.length === 0) return res.status(404).json({ ok: false, error: "Debtor not found" });
      candidates.splice(0, candidates.length, ...byPhone);
    }

    let left = amount;
    let touched = 0;
    const paymentsWritten = [];

    for (const it of candidates) {
      if (left <= 0) break;
      const take = Math.min(left, it.remaining);
      if (take <= 0) continue;

      const row = it.d;
      const newPaid = (Number(row.paid || 0) || 0) + take;
      const newTotal = Math.max(it.total, Number(row.total || 0) || 0, Number(row.totalOwed || 0) || 0);
      const newBalance = Math.max(0, newTotal - newPaid);

      row.total = newTotal;
      row.paid = newPaid;
      row.balance = newBalance;
      row.remaining = newBalance;
      row.remainingOwed = newBalance;
      row.updatedAt = now;
      row.status = newBalance <= 0.0001 ? "PAID" : (row.status || "PARTIAL");

      const payRec = {
        id: `PAY-${now}-${Math.floor(Math.random()*1e6)}`,
        shopId,
        receiptNo: (row.receiptNo || row.receipt || row.saleNo || row.id || "").toString(),
        customerName: (row.customerName || row.name || "").toString(),
        customerPhone: (row.customerPhone || row.phone || "").toString(),
        amount: take,
        method,
        note,
        createdAt: now,
        by: (req.user && (req.user.username || req.user.user)) || "owner",
      };
      db.debtorPayments.push(payRec);
      paymentsWritten.push(payRec);

      touched++;
      left -= take;
    }

    writeDB(db);
    return res.json({ ok: true, applied: amount - left, touched, payments: paymentsWritten });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

r.post("/shop/:shopId/debtors/pay", authMiddleware, (req, res) => {
  try {
    const { shopId } = req.params;
    const body = req.body || {};
    const receiptNo = (body.receiptNo || body.receipt || body.saleNo || "").toString().trim();
    const phone = (body.phone || body.customerPhone || "").toString().trim();
    const method = (body.method || body.paymentMethod || "CASH").toString().trim().toUpperCase();
    const note = (body.note || "").toString().trim();
    const amount = Number(body.amount || body.paid || 0);

    if (!shopId || !shopId.trim()) return res.status(400).json({ ok: false, error: "Missing shopId" });
    if (!amount || !isFinite(amount) || amount <= 0) return res.status(400).json({ ok: false, error: "Invalid amount" });
    if (!receiptNo && !phone) return res.status(400).json({ ok: false, error: "Provide receiptNo or phone" });

    const db = readDB();
    if (!Array.isArray(db.debtors)) db.debtors = [];
    if (!Array.isArray(db.debtorPayments)) db.debtorPayments = [];

    // Candidates: either match by receiptNo OR by phone and open balance
    const now = Date.now();
    const candidates = db.debtors
      .filter(d => (d && pickShopId(d) === shopId))
      .filter(d => {
        const rn = (d.receiptNo || d.receipt || d.saleNo || d.id || "").toString();
        const ph = (d.customerPhone || d.phone || d.customer && d.customer.phone || "").toString();
        if (receiptNo) return rn === receiptNo;
        return ph && phone && ph === phone;
      })
      .map(d => {
        const total = pickDebtorTotal(d);
        const paid = pickDebtorPaid(d);
        const remaining = pickDebtorRemaining(d);
        const createdAt = asInt(d.createdAt, 0) || 0;
        return { d, total, paid, remaining, createdAt };
      })
      .filter(x => x.remaining > 0.0001)
      .sort((a,b) => a.createdAt - b.createdAt);

    if (candidates.length === 0) {
      return res.status(404).json({ ok: false, error: "No open debtor found" });
    }

    let left = amount;
    let touched = 0;
    const paymentsWritten = [];

    for (const it of candidates) {
      if (left <= 0) break;
      const take = Math.min(left, it.remaining);
      if (take <= 0) continue;

      // Update debtor row (keep backward compatible fields too)
      const row = it.d;
      const newPaid = (Number(row.paid || 0) || 0) + take;
      const newTotal = Math.max(it.total, Number(row.total || 0) || 0, Number(row.totalOwed || 0) || 0);
      const newBalance = Math.max(0, newTotal - newPaid);

      row.total = newTotal;
      row.paid = newPaid;
      row.balance = newBalance;
      row.remaining = newBalance;
      row.remainingOwed = newBalance;
      row.updatedAt = now;
      row.status = newBalance <= 0.0001 ? "PAID" : (row.status || "PARTIAL");

      const payRec = {
        id: `PAY-${now}-${Math.floor(Math.random()*1e6)}`,
        shopId,
        receiptNo: (row.receiptNo || row.receipt || row.saleNo || row.id || "").toString(),
        customerName: (row.customerName || row.name || "").toString(),
        customerPhone: (row.customerPhone || row.phone || "").toString(),
        amount: take,
        method,
        note,
        createdAt: now,
        by: (req.user && (req.user.username || req.user.user)) || "owner",
      };
      db.debtorPayments.push(payRec);
      paymentsWritten.push(payRec);

      touched++;
      left -= take;
    }

    writeDB(db);
    return res.json({ ok: true, applied: amount - left, touched, payments: paymentsWritten });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});



// -----------------------------
// Expiry lists + settings
// -----------------------------
r.get("/shop/:shopId/expiry", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const type = trim(req.query.type || "expired").toLowerCase();
  const db = readDB();
  const shop = (db.shops || []).find(s => s.shopId === shopId) || { shopId };

  let soonDays = asInt(req.query.soonDays || 0, 0);
  if (soonDays > 365) soonDays = 365;
  if (soonDays < 1) soonDays = 0;
  if (!soonDays || soonDays <= 0) {
    const sds = asInt(shop?.expirySoonDays || 0, 0);
    soonDays = (sds > 0 && sds <= 365) ? sds : 90;
  }

  function parseExpiry(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number" && Number.isFinite(v)) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    const s = String(v).trim();
    if (!s) return null;

    const m8 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
    if (m8) {
      const d = new Date(`${m8[1]}-${m8[2]}-${m8[3]}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (m) {
      const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const n = Number(s);
    if (Number.isFinite(n) && s.length >= 10) {
      const d = new Date(n);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function expiryDateFromProduct(p) {
    const ms = getExpiryMs(p);
    if (!ms) return null;
    return new Date(ms);
  }

  const products = (db.products || []).filter(p => pickShopId(p) === shopId);
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);
  const soonMs = soonDays * 24 * 60 * 60 * 1000;

  const list = [];
  for (const p of products) {
    const d = expiryDateFromProduct(p);
    if (!d) continue;
    const t = d.getTime();
    const isExpired = t < today0.getTime();
    const isSoon = (!isExpired) && t <= (today0.getTime() + soonMs);

    if (type === "expired" && !isExpired) continue;
    if ((type === "soon" || type === "expiring" || type === "expiringsoon") && !isSoon) continue;

    const daysLeft = Math.floor((t - today0.getTime()) / (24 * 60 * 60 * 1000));
    list.push({
      productId: trim(p.productId || p.id),
      name: trim(p.name),
      barcode: trim(p.barcode),
      sku: trim(p.sku),
      stock: asInt(p.stock ?? p.quantity ?? 0, 0),
      price: asNum(p.price ?? p.sellingPrice ?? p.unitPrice ?? 0, 0),
      expiryDate: d.toISOString().slice(0, 10),
      daysLeft
    });
  }

  // expired: older first (most negative daysLeft)
  // soon: earliest expiry first
  list.sort((a, b) => (a.daysLeft - b.daysLeft));

  return res.json({
    ok: true,
    shop: { shopId: shop.shopId, shopName: shop.shopName || shop.name || "" },
    type,
    soonDays,
    count: list.length,
    items: list
  });
});

r.post("/shop/:shopId/settings/expirySoonDays", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const soonDays = Math.max(1, Math.min(asInt(req.body?.soonDays || req.body?.expirySoonDays || 0, 0), 365));
  if (!soonDays) return res.status(400).json({ ok: false, error: "soonDays required" });

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];
  const idx = db.shops.findIndex(s => s.shopId === shopId);

  if (idx >= 0) {
    db.shops[idx] = { ...db.shops[idx], expirySoonDays: soonDays, updatedAt: Date.now() };
  } else {
    db.shops.push({ shopId, expirySoonDays: soonDays, createdAt: Date.now(), updatedAt: Date.now() });
  }

  writeDB(db);
  return res.json({ ok: true, shopId, expirySoonDays: soonDays });
});


function toCsv(rows, headers) {
  const esc = (v) => {
    const s = (v === null || v === undefined) ? "" : String(v);
    const needs = /[",\n\r]/.test(s);
    const out = s.replace(/"/g, '""');
    return needs ? `"${out}"` : out;
  };
  const head = headers.map(h => esc(h)).join(",");
  const lines = rows.map(r => headers.map(h => esc(r[h])).join(","));
  return [head, ...lines].join("\n");
}

function dayKey(ts) {
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

function getSaleItems(sale) {
  const s = sale || {};
  const items = Array.isArray(s.items) ? s.items :
                Array.isArray(s.cartItems) ? s.cartItems :
                Array.isArray(s.saleItems) ? s.saleItems :
                Array.isArray(s.rows) ? s.rows : [];
  return items.filter(Boolean);
}

function num(v, d=0){
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function getCost(p){
  return num(p?.costPrice ?? p?.cost ?? p?.buyPrice ?? p?.purchasePrice ?? p?.cost_price ?? 0, 0);
}

function buildProductIndex(db, shopId){
  const idx = { byId: new Map(), byBarcode: new Map(), bySku: new Map(), byName: new Map() };
  const prods = (db.products || []).filter(p => pickShopId(p) === shopId);
  for (const p of prods){
    const pid = trim(p.productId || p.id);
    const bc = trim(p.barcode);
    const sku = trim(p.sku);
    const nm = trim(p.name || p.productName).toLowerCase();
    if (pid) idx.byId.set(pid, p);
    if (bc) idx.byBarcode.set(bc, p);
    if (sku) idx.bySku.set(sku, p);
    if (nm) idx.byName.set(nm, p);
  }
  return idx;
}

function findProduct(idx, it){
  const barcode = trim(it?.barcode);
  const sku = trim(it?.sku);
  const pid = trim(it?.productId || it?.id);
  const name = trim(it?.productName || it?.name).toLowerCase();
  if (barcode && idx.byBarcode.has(barcode)) return idx.byBarcode.get(barcode);
  if (sku && idx.bySku.has(sku)) return idx.bySku.get(sku);
  if (pid && idx.byId.has(pid)) return idx.byId.get(pid);
  if (name && idx.byName.has(name)) return idx.byName.get(name);
  return null;
}

/**
 * Insights: daily revenue + profit (requires costPrice)
 */
r.get("/shop/:shopId/insights", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const days = Math.max(1, Math.min(asInt(req.query.days || 30, 30), 365));
  const now = Date.now();
  const since = now - (days * 24 * 60 * 60 * 1000);

  const db = readDB();
  const shop = (db.shops || []).find(s => s.shopId === shopId) || { shopId };
  const currency = trim(shop.currency || "");

  const idx = buildProductIndex(db, shopId);

  const sales = (db.sales || []).filter(s => pickShopId(s) === shopId && asNum(s.createdAt || 0, 0) >= since);
  const by = new Map();

  let hasAnyCost = false;

  for (const s of sales){
    const ts = asNum(s.createdAt || s.time || s.timestamp || 0, 0) || now;
    const k = dayKey(ts);
    if (!k) continue;
    const row = by.get(k) || { day: k, revenue: 0, profit: 0, salesCount: 0 };
    row.revenue += pickSaleTotal(s);
    row.salesCount += 1;

    // compute profit per item when possible
    const items = getSaleItems(s);
    for (const it of items){
      const qty = Math.max(0, num(it?.qty ?? it?.quantity ?? it?.count ?? 1, 1));
      const price = num(it?.price ?? it?.unitPrice ?? it?.sellingPrice ?? 0, 0);
      const p = findProduct(idx, it);
      const cost = p ? getCost(p) : 0;
      if (p && cost > 0) hasAnyCost = true;
      // If cost is 0/missing, profit contribution is 0 (safe).
      row.profit += Math.max(0, (price - cost)) * qty;
    }

    by.set(k, row);
  }

  const byDay = Array.from(by.values()).sort((a,b) => a.day.localeCompare(b.day));

  // Summary windows
  const todayKey = dayKey(now);
  const last7since = now - (7 * 24 * 60 * 60 * 1000);
  const last30since = now - (30 * 24 * 60 * 60 * 1000);

  let todayProfit = 0, d7 = 0, d30 = 0;
  for (const r0 of byDay){
    // dayKey parsing to ms:
    const dt = new Date(r0.day + "T00:00:00Z").getTime();
    if (r0.day === todayKey) todayProfit += asNum(r0.profit, 0);
    if (Number.isFinite(dt) && dt >= last7since) d7 += asNum(r0.profit, 0);
    if (Number.isFinite(dt) && dt >= last30since) d30 += asNum(r0.profit, 0);
  }

  return res.json({
    ok: true,
    shopId,
    profit: {
      summary: { today: todayProfit, d7, d30, currency, hasCost: hasAnyCost },
      byDay
    }
  });
});

/**
 * Export expiry list to CSV
 */
r.get("/shop/:shopId/expiry/export", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const shopId = trim(req.params.shopId);
  if (!shopId) return res.status(400).json({ ok: false, error: "shopId required" });
  if (!(auth.shops || []).includes(shopId)) return res.status(403).json({ ok: false, error: "No access to this shop" });

  const type = trim(req.query.type || "expired").toLowerCase();
  const db = readDB();
  const shop = (db.shops || []).find(s => s.shopId === shopId) || { shopId };

  let soonDays = asInt(req.query.soonDays || 0, 0);
  if (soonDays > 365) soonDays = 365;
  if (soonDays < 1) soonDays = 0;
  if (!soonDays || soonDays <= 0) {
    const sds = asInt(shop?.expirySoonDays || 0, 0);
    soonDays = (sds > 0 && sds <= 365) ? sds : 90;
  }

  function parseExpiry(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    const s = String(v).trim();
    if (!s) return null;
    const t = Date.parse(s);
    if (Number.isFinite(t)) return t;
    const m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const y = asInt(m[1], 0), mo = asInt(m[2], 1) - 1, d = asInt(m[3], 1);
      return Date.UTC(y, mo, d, 0, 0, 0, 0);
    }
    return null;
  }

  const now = Date.now();
  const startToday = new Date(); startToday.setHours(0,0,0,0);
  const today0 = startToday.getTime();
  const soonLimit = today0 + (soonDays * 24 * 60 * 60 * 1000);

  const products = (db.products || []).filter(p => pickShopId(p) === shopId);
  const rows = [];

  for (const p of products){
    const expTs = parseExpiry(p.expiryDate || p.expireDate || p.exp);
    if (!expTs) continue;

    const isExpired = expTs < today0;
    const isSoon = !isExpired && expTs <= soonLimit;

    if (type === "expired" && !isExpired) continue;
    if (type !== "expired" && !isSoon) continue;

    const daysLeft = Math.ceil((expTs - today0) / (24*60*60*1000));
    rows.push({
      name: trim(p.name || p.productName),
      barcode: trim(p.barcode),
      sku: trim(p.sku),
      expiryDate: new Date(expTs).toISOString().slice(0,10),
      daysLeft: String(daysLeft),
      qty: String(asNum(p.stock ?? p.qty ?? 0, 0)),
    });
  }

  rows.sort((a,b)=> (a.expiryDate||"").localeCompare(b.expiryDate||""));

  const csv = toCsv(rows, ["name","barcode","sku","expiryDate","daysLeft","qty"]);
  const fn = `superposng_${type}_shop_${shopId}.csv`;

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fn}"`);
  return res.status(200).send(csv);
});


export default r;