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
    return (
      parseExpiry(p.expiryDate) ||
      parseExpiry(p.expiringDate) ||
      parseExpiry(p.expDate) ||
      parseExpiry(p.expiry) ||
      parseExpiry(p.exp) ||
      null
    );
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
      .filter(d => (d && d.shopId === shopId))
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

  let soonDays = Math.max(1, Math.min(asInt(req.query.soonDays || 0, 0), 365));
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
    return (
      parseExpiry(p.expiryDate) ||
      parseExpiry(p.expiringDate) ||
      parseExpiry(p.expDate) ||
      parseExpiry(p.expiry) ||
      parseExpiry(p.exp) ||
      null
    );
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

export default r;
