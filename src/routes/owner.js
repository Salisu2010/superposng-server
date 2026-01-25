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

  // If explicit debtors table is empty, derive debtors count from unpaid sales.
  let debtorsCount = Array.isArray(debtors) ? debtors.length : 0;
  if (debtorsCount === 0) {
    debtorsCount = sales.filter(s => pickSaleRemaining(s) > 0).length;
  }

  const totalSales = sales.reduce((sum, s) => sum + pickSaleTotal(s), 0);
  const totalPaid = sales.reduce((sum, s) => sum + pickSalePaid(s), 0);
  const totalRemaining = sales.reduce((sum, s) => sum + pickSaleRemaining(s), 0);

  return res.json({
    ok: true,
    shop: shop || { shopId },
    kpi: {
      products: products.length,
      sales: sales.length,
      debtors: debtorsCount,
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

export default r;
