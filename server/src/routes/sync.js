import { Router } from "express";
import { readDB, writeDB } from "../db.js";

const r = Router();

/* =========================
   Helpers
========================= */

function requireShop(req, res) {
  const raw = req.auth?.shopId ? String(req.auth.shopId) : "";
  if (!raw) {
    res.status(401).json({ ok: false, error: "Missing auth shopId" });
    return null;
  }

  // Resolve merged shops to canonical shopId (safe for old devices holding old shopId)
  try {
    const db = readDB();
    if (!Array.isArray(db.shops)) db.shops = [];
    let cur = raw;
    let hops = 0;

    while (hops < 5) {
      const s = db.shops.find((x) => String(x.shopId) === String(cur));
      if (s && s.isMerged === true && s.mergedInto) {
        cur = String(s.mergedInto);
        hops++;
        continue;
      }
      break;
    }

    req.originalShopId = raw;
    req.canonicalShopId = cur;
    return cur;
  } catch (_e) {
    req.originalShopId = raw;
    req.canonicalShopId = raw;
    return raw;
  }
}

function toStr(v) {
  return v === null || v === undefined ? "" : String(v);
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
function round2(n) {
  const x = toNum(n, 0);
  return Math.round(x * 100) / 100;
}
function ensureDbArrays(db) {
  if (!Array.isArray(db.products)) db.products = [];
  if (!Array.isArray(db.staffs)) db.staffs = [];
  if (!Array.isArray(db.sales)) db.sales = [];
  if (!Array.isArray(db.debtors)) db.debtors = [];
  if (!Array.isArray(db.shops)) db.shops = [];
}
function normName(v) {
  return trim(v).toLowerCase().replace(/\s+/g, " ");
}

// Determine expiring-soon window from shop setting if present (default 90 days).
function getExpirySoonDays(db, shopId) {
  let soonDaysSetting = 90;
  try {
    const shop = (db.shops || []).find((s) => String(s.shopId) === String(shopId));
    const sd = shop ? toInt(shop.expirySoonDays, 0) : 0;
    if (sd > 0 && sd <= 365) soonDaysSetting = sd;
  } catch (_e) {}
  return soonDaysSetting;
}

function parseExpiryAny(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const s = trim(v);
  if (!s) return null;

  // YYYYMMDD
  const m8 = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (m8) {
    const d = new Date(`${m8[1]}-${m8[2]}-${m8[3]}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // YYYY-MM-DD
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m) {
    const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // epoch ms string
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
    parseExpiryAny(p?.expiryDate) ||
    parseExpiryAny(p?.expiringDate) ||
    parseExpiryAny(p?.expDate) ||
    parseExpiryAny(p?.expiry) ||
    parseExpiryAny(p?.exp) ||
    null
  );
}

function ymdFromDate(d) {
  if (!d) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${da}`;
}

// Find a product reliably for a sale item.
// Why: productId/id differ across devices, so we must prefer barcode/sku/code.
function findProductForSaleItem(db, shopId, it) {
  const code = trim(it?.code);
  const sku = trim(it?.sku);
  const barcode = trim(it?.barcode);
  const productIdFromItem = trim(it?.productId || it?.id);
  const name = normName(it?.productName || it?.name);
  const price = toNum(it?.price, NaN);

  let p = null;

  // 1) Prefer explicit barcode/sku fields if provided
  if (!p && barcode) {
    p = db.products.find((x) => x.shopId === shopId && trim(x.barcode) === barcode);
  }
  if (!p && sku) {
    p = db.products.find((x) => x.shopId === shopId && trim(x.sku) === sku);
  }

  // 2) Then try code against sku/barcode or ID:xxxx
  if (!p && code) {
    if (code.toUpperCase().startsWith("ID:")) {
      const pid = trim(code.substring(3));
      if (pid) {
        p = db.products.find(
          (x) => x.shopId === shopId && (trim(x.productId) === pid || trim(x.id) === pid)
        );
      }
    } else {
      p = db.products.find(
        (x) => x.shopId === shopId && (trim(x.sku) === code || trim(x.barcode) === code)
      );
    }
  }

  // 3) Fallback: productId/id only if still not found
  if (!p && productIdFromItem) {
    const pid = String(productIdFromItem);
    p = db.products.find(
      (x) => x.shopId === shopId && (trim(x.productId) === pid || trim(x.id) === pid)
    );
  }

  // 4) Last resort: name + price match
  if (!p && name) {
    const candidates = db.products.filter(
      (x) => x.shopId === shopId && normName(x.name) === name
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1 && Number.isFinite(price)) {
      const byPrice = candidates.find((x) => Math.abs(toNum(x.price, 0) - price) < 0.0001);
      if (byPrice) return byPrice;
    }
  }

  return p;
}

function itemLabel(it) {
  return trim(
    it?.productName ||
      it?.name ||
      it?.code ||
      it?.barcode ||
      it?.sku ||
      it?.plu ||
      it?.productId ||
      ""
  );
}

/* =========================
   PRODUCTS
========================= */

r.get("/products", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const since = toInt(req.query.since || "0", 0);
  const db = readDB();
  ensureDbArrays(db);

  const list = db.products.filter((p) => {
    if (p.shopId !== shopId) return false;
    if (since <= 0) return true;
    return (p.updatedAt || p.createdAt || 0) > since;
  });

  return res.json({ ok: true, items: list, serverTime: Date.now() });
});

r.post("/products", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: "items[] required" });
  }

  const db = readDB();
  ensureDbArrays(db);

  const now = Date.now();
  let upserts = 0;

  for (const it of items) {
    const productId = trim(it?.productId || it?.id);
    if (!productId) continue;

    const idx = db.products.findIndex(
      (p) => p.shopId === shopId && trim(p.productId) === productId
    );

    const row = { ...it, shopId, productId, updatedAt: now };

    if (idx >= 0) {
      const prev = db.products[idx] || {};

      // Conflict guard for stock:
      // If server already has a newer update (typically from /sale stock deduction),
      // do NOT allow an older client snapshot to restore stock upwards.
      const prevUpd = toInt(prev.updatedAt || prev.createdAt || 0, 0);
      const incUpd = toInt(it?.updatedAt || it?.createdAt || 0, 0);
      const prevStock = toInt(prev.stock, 0);
      const incStock = toInt(it?.stock, prevStock);
      const shouldProtectStock = prevUpd > incUpd && incStock > prevStock;

      const merged = { ...prev, ...row };
      if (shouldProtectStock) merged.stock = prev.stock;
      db.products[idx] = merged;
    } else {
      db.products.push(row);
    }

    upserts++;
  }

  writeDB(db);
  return res.json({ ok: true, upserts, serverTime: now });
});

/* =========================
   STAFFS
========================= */

r.get("/staffs", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const since = toInt(req.query.since || "0", 0);
  const db = readDB();
  ensureDbArrays(db);

  const list = db.staffs.filter((s) => {
    if (s.shopId !== shopId) return false;
    if (since <= 0) return true;
    return (s.updatedAt || s.createdAt || 0) > since;
  });

  return res.json({ ok: true, items: list, serverTime: Date.now() });
});

r.post("/staffs", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const items = req.body?.items;
  if (!Array.isArray(items)) {
    return res.status(400).json({ ok: false, error: "items[] required" });
  }

  const db = readDB();
  ensureDbArrays(db);

  const now = Date.now();
  let upserts = 0;

  for (const it of items) {
    const staffId = trim(it?.staffId || it?.id || it?.username);
    if (!staffId) continue;

    const u = trim(it?.username);
    const idx = db.staffs.findIndex(
      (s) =>
        s.shopId === shopId &&
        (trim(s.staffId) === staffId ||
          trim(s.id) === staffId ||
          (u && trim(s.username) === u))
    );

    const row = { ...it, shopId, staffId, updatedAt: now };
    if (idx >= 0) db.staffs[idx] = { ...db.staffs[idx], ...row };
    else db.staffs.push(row);
    upserts++;
  }

  writeDB(db);
  return res.json({ ok: true, upserts, serverTime: now });
});

/* =========================
   SHOP PROFILE
========================= */

r.get("/shop/profile", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const db = readDB();
  ensureDbArrays(db);

  const shop = db.shops.find((s) => s.shopId === shopId);
  if (!shop) {
    return res.json({
      ok: true,
      shop: {
        shopId,
        shopName: "",
        address: "",
        phone: "",
        whatsapp: "",
        tagline: "",
        currency: "",
        footer: "",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      serverTime: Date.now(),
      canonicalShopId: req.canonicalShopId || shopId,
      mergedFromShopId:
        req.originalShopId && req.originalShopId !== (req.canonicalShopId || shopId)
          ? req.originalShopId
          : "",
    });
  }

  return res.json({
    ok: true,
    shop,
    serverTime: Date.now(),
    canonicalShopId: req.canonicalShopId || shopId,
    mergedFromShopId:
      req.originalShopId && req.originalShopId !== (req.canonicalShopId || shopId)
        ? req.originalShopId
        : "",
  });
});

r.post("/shop/profile", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const shopPatch = req.body?.shop || req.body || {};
  const db = readDB();
  ensureDbArrays(db);

  const now = Date.now();
  let idx = db.shops.findIndex((s) => s.shopId === shopId);

  if (idx < 0) {
    db.shops.push({
      shopId,
      shopName: "",
      address: "",
      phone: "",
      whatsapp: "",
      tagline: "",
      currency: "",
      footer: "",
      createdAt: now,
      updatedAt: now,
    });
    idx = db.shops.length - 1;
  }

  db.shops[idx] = {
    ...db.shops[idx],
    shopName: shopPatch.shopName ?? db.shops[idx].shopName,
    address: shopPatch.address ?? db.shops[idx].address,
    phone: shopPatch.phone ?? db.shops[idx].phone,
    whatsapp: shopPatch.whatsapp ?? db.shops[idx].whatsapp,
    tagline: shopPatch.tagline ?? db.shops[idx].tagline,
    currency: shopPatch.currency ?? db.shops[idx].currency,
    footer: shopPatch.footer ?? db.shops[idx].footer,
    // optional config:
    expirySoonDays: shopPatch.expirySoonDays ?? db.shops[idx].expirySoonDays,
    updatedAt: now,
  };

  writeDB(db);
  return res.json({
    ok: true,
    saved: true,
    shop: db.shops[idx],
    serverTime: now,
    canonicalShopId: req.canonicalShopId || shopId,
    mergedFromShopId:
      req.originalShopId && req.originalShopId !== (req.canonicalShopId || shopId)
        ? req.originalShopId
        : "",
  });
});

/* =========================
   SALES (Push)
========================= */

function extractSaleFromBody(body) {
  const b = body || {};
  if (b.sale && typeof b.sale === "object") return b.sale;
  if (b.data?.sale && typeof b.data.sale === "object") return b.data.sale;
  if (b.payload?.sale && typeof b.payload.sale === "object") return b.payload.sale;

  const saleLikeKeys = [
    "receiptNo",
    "receipt",
    "items",
    "cartItems",
    "total",
    "paid",
    "remaining",
    "customerName",
    "customerPhone",
  ];
  const keys = Object.keys(b);
  const looksLikeSale = keys.some((k) => saleLikeKeys.includes(k));
  if (looksLikeSale) return b;

  return null;
}

const SALE_PATHS = ["/sale", "/sale/create", "/saleCreate", "/sales", "/sales/create", "/sales/push"];

r.post(SALE_PATHS, (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const sale = extractSaleFromBody(req.body);
  if (!sale) return res.status(400).json({ ok: false, error: "sale required" });

  const db = readDB();
  ensureDbArrays(db);

  const now = Date.now();

  // ✅ Expired block + expiring soon warnings
  const today0 = new Date();
  today0.setHours(0, 0, 0, 0);

  const soonDaysSetting = getExpirySoonDays(db, shopId);
  const soonMs = soonDaysSetting * 24 * 60 * 60 * 1000;

  const expiredItems = [];
  const expiringSoonItems = [];

  try {
    const items = Array.isArray(sale.items)
      ? sale.items
      : Array.isArray(sale.cartItems)
      ? sale.cartItems
      : [];

    for (const it of items) {
      const p = findProductForSaleItem(db, shopId, it);
      if (!p) continue;

      const d = expiryDateFromProduct(p);
      if (!d) continue;

      const t = d.getTime();
      if (t < today0.getTime()) {
        expiredItems.push({
          name: trim(p.name) || itemLabel(it) || "Item",
          code:
            trim(p.barcode) ||
            trim(p.sku) ||
            trim(p.plu) ||
            trim(p.productId || p.id) ||
            itemLabel(it),
          expiryDate: ymdFromDate(d),
        });
      } else if (t <= today0.getTime() + soonMs) {
        expiringSoonItems.push({
          name: trim(p.name) || itemLabel(it) || "Item",
          code:
            trim(p.barcode) ||
            trim(p.sku) ||
            trim(p.plu) ||
            trim(p.productId || p.id) ||
            itemLabel(it),
          expiryDate: ymdFromDate(d),
        });
      }
    }
  } catch (_e) {}

  if (expiredItems.length > 0) {
    return res.status(409).json({
      ok: false,
      code: "EXPIRED_BLOCK",
      messageEn: "Sale blocked: expired product(s) found. Please remove expired items before checkout.",
      messageHa: "An hana sayarwa: an samu kayayyakin da suka wuce ranar karewa. Ka cire expired items kafin checkout.",
      items: expiredItems,
      serverTime: now,
    });
  }

  // De-duplicate by receiptNo if provided
  const receiptNo = trim(sale.receiptNo || sale.receipt || sale.invoiceNo || sale.billNo);
  const exists = receiptNo
    ? db.sales.some((s) => s.shopId === shopId && trim(s.receiptNo) === receiptNo)
    : false;

  if (!exists) {
    const createdAt = toInt(sale.createdAt || sale.time || sale.timestamp || 0, 0) || now;
    db.sales.push({ ...sale, shopId, receiptNo, createdAt });
  }

  // ✅ Deduct stock (robust matching)
  let deductedItems = 0;
  let notFoundItems = 0;
  let touchedQty = 0;

  try {
    const items = Array.isArray(sale.items)
      ? sale.items
      : Array.isArray(sale.cartItems)
      ? sale.cartItems
      : [];

    for (const it of items) {
      const qty = Math.max(1, toInt(it?.qty || it?.quantity || 1, 1));
      const p = findProductForSaleItem(db, shopId, it);
      if (!p) {
        notFoundItems++;
        continue;
      }
      const cur = toInt(p.stock, 0);
      p.stock = Math.max(0, cur - qty);
      p.updatedAt = now;
      deductedItems++;
      touchedQty += qty;
    }
  } catch (_e) {}

  // ✅ Auto-upsert debtor (per receipt; supports partial payments)
  try {
    const total = toNum(sale.total, 0);
    const paid = toNum(sale.paid, 0);
    const remaining = toNum(sale.remaining, Math.max(0, total - paid));
    const phone = trim(sale.customerPhone);
    const name = trim(sale.customerName);

    if (remaining > 0.0001) {
      const key = receiptNo || `SYNC-${Date.now()}`;
      const dIdx = db.debtors.findIndex((d) => d.shopId === shopId && trim(d.receiptNo) === key);

      if (dIdx >= 0) {
        const d = db.debtors[dIdx];
        const baseTotal = toNum(d.total ?? d.totalOwed, 0);
        const basePaid = toNum(d.paid ?? d.totalPaid, 0);

        const newTotal = baseTotal + remaining;
        const newPaid = basePaid;
        const newBalance = Math.max(0, newTotal - newPaid);

        db.debtors[dIdx] = {
          ...d,
          receiptNo: key,
          customerName: name || d.customerName,
          customerPhone: phone || d.customerPhone,
          total: round2(newTotal),
          paid: round2(newPaid),
          balance: round2(newBalance),
          status: newBalance <= 0.0001 ? "PAID" : "PARTIAL",
          updatedAt: now,
        };
      } else {
        db.debtors.push({
          shopId,
          receiptNo: key,
          customerName: name,
          customerPhone: phone,
          total: round2(remaining),
          paid: 0,
          balance: round2(remaining),
          status: "PARTIAL",
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  } catch (_e) {}

  writeDB(db);
  return res.json({
    ok: true,
    saved: true,
    stock: { deductedItems, notFoundItems, qtyTotal: touchedQty },
    serverTime: now,
    warnings: {
      expiringSoonDays: soonDaysSetting,
      expiringSoon: expiringSoonItems,
    },
  });
});

/* =========================
   SALES (Pull)
========================= */

r.get("/sales", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const since = toInt(req.query.since || "0", 0);
  const db = readDB();
  ensureDbArrays(db);

  const list = db.sales.filter((s) => {
    if (s.shopId !== shopId) return false;
    if (since <= 0) return true;
    return (s.createdAt || 0) > since;
  });

  return res.json({ ok: true, items: list, serverTime: Date.now() });
});

/* =========================
   DEBTORS (Pull + Backfill)
========================= */

r.get("/debtors", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const since = toInt(req.query.since || "0", 0);
  const db = readDB();
  ensureDbArrays(db);

  const list = db.debtors.filter((d) => {
    if (d.shopId !== shopId) return false;
    if (since <= 0) return true;
    return (d.updatedAt || d.createdAt || 0) > since;
  });

  const items = list
    .map((d) => {
      const total = toNum(d.total ?? d.totalOwed, 0);
      const paid = toNum(d.paid ?? d.totalPaid, 0);
      const balance = toNum(d.balance ?? d.remainingOwed, Math.max(0, total - paid));
      const status = balance <= 0.0001 ? "PAID" : "PARTIAL";
      return { ...d, total, paid, balance, status };
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  return res.json({ ok: true, items, serverTime: Date.now() });
});

// Backfill / replace debtor customer info from device (helps cloud dashboard show names/phones)
r.post("/debtorsFull", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  try {
    const body = req.body || {};
    const list = Array.isArray(body.debtors) ? body.debtors : Array.isArray(body) ? body : [];
    const db = readDB();
    ensureDbArrays(db);

    const now = Date.now();
    let changed = 0;

    for (const d of list) {
      if (!d || typeof d !== "object") continue;
      const receiptNo = trim(d.receiptNo || d.receipt);
      if (!receiptNo) continue;

      const customerName = trim(d.customerName || d.name);
      const customerPhone = trim(d.customerPhone || d.phone);

      const totalOwed = toNum(d.totalOwed ?? d.total, 0);

      let existing = db.debtors.find((x) => x && x.shopId === shopId && trim(x.receiptNo) === receiptNo);
      if (!existing) {
        existing = { shopId, receiptNo, createdAt: now };
        db.debtors.push(existing);
      }

      if (customerName) existing.customerName = customerName;
      if (customerPhone) existing.customerPhone = customerPhone;
      if (Number.isFinite(totalOwed) && totalOwed > 0) existing.totalOwed = totalOwed;

      existing.updatedAt = now;
      existing.serverUpdatedAt = now;
      changed++;
    }

    writeDB(db);
    return res.json({ ok: true, shopId, updated: changed, serverTime: now });
  } catch (e) {
    console.error("debtorsFull error", e);
    return res.status(500).json({ ok: false, error: "debtorsFull_failed" });
  }
});

export default r;
