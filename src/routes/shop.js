import { Router } from "express";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { readDB, writeDB } from "../db.js";

const r = Router();

function signToken(payload) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

function normPhone(p) {
  return (p || "").toString().trim().replace(/\s+/g, "");
}

/**
 * Create or Reuse a Shop (Admin)
 * body: { shopName, ownerDeviceId, ownerPin, ownerPhone? }
 *
 * ✅ Professional:
 * - If ownerPhone+ownerPin match an existing shop, reuse it (idempotent create).
 * - If only ownerDeviceId is provided (legacy clients), still creates a new shop.
 */
r.post("/create", (req, res) => {
  const { shopName, ownerDeviceId, ownerPin, ownerPhone } = req.body || {};
  if (!shopName || !ownerDeviceId) {
    return res.status(400).json({ ok: false, error: "shopName and ownerDeviceId are required" });
  }

  const pin = (ownerPin || "").toString().trim();
  const phone = normPhone(ownerPhone);

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];
  if (!Array.isArray(db.devices)) db.devices = [];
  if (!Array.isArray(db.shopAliases)) db.shopAliases = [];

  // ✅ Reuse by phone+pin (preferred)
  let reused = false;
  let shop = null;

  if (phone && pin) {
    shop = db.shops.find((s) => normPhone(s.ownerPhone) === phone && (s.ownerPin || "") === pin);
    if (shop) {
      // If this shop was merged, return the canonical shop
      if (shop.isMerged === true && shop.mergedInto) {
        const canonical = db.shops.find(x => x.shopId === shop.mergedInto);
        if (canonical) shop = canonical;
      }
      reused = true;
    }
  }

  if (!shop) {
    const shopId = nanoid(12);
    const shopCode = ("SPNG-" + nanoid(6)).toUpperCase();

    shop = {
      shopId,
      shopCode,
      shopName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ownerDeviceId,
      ownerPin: pin,
      ownerPhone: phone,
    };
    db.shops.push(shop);
  } else {
    // update shop name (keep canonical id)
    shop.shopName = shopName || shop.shopName;
    shop.updatedAt = Date.now();
    shop.ownerDeviceId = ownerDeviceId; // latest device that created/restored
  }

  // ✅ register/update device as ADMIN for this shop
  const existing = db.devices.find((d) => d.deviceId === ownerDeviceId);
  if (existing) {
    existing.shopId = shop.shopId;
    existing.role = "ADMIN";
    existing.pairedAt = Date.now();
    existing.isActive = true;
  } else {
    db.devices.push({
      deviceId: ownerDeviceId,
      shopId: shop.shopId,
      role: "ADMIN",
      pairedAt: Date.now(),
      isActive: true,
    });
  }

  writeDB(db);

  // Provide an admin token for cloud sync right away (optional for clients)
  const token = signToken({ deviceId: ownerDeviceId, shopId: shop.shopId, role: "ADMIN" });

  return res.json({
    ok: true,
    reused,
    shopId: shop.shopId,
    shopCode: shop.shopCode,
    shopName: shop.shopName,
    token,
  });
});

/**
 * Restore/Login (Phone + PIN)
 * body: { ownerPhone, ownerPin, deviceId }
 * returns: { ok:true, shops:[...], token?, shopId? }
 */
r.post("/restore-login", (req, res) => {
  const phone = normPhone(req.body?.ownerPhone);
  const pin = (req.body?.ownerPin || "").toString().trim();
  const deviceId = (req.body?.deviceId || "").toString().trim();

  if (!phone || !pin || !deviceId) {
    return res.status(400).json({ ok: false, error: "ownerPhone, ownerPin, deviceId are required" });
  }

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];
  if (!Array.isArray(db.devices)) db.devices = [];

const matches = db.shops.filter((s) => normPhone(s.ownerPhone) === phone && (s.ownerPin || "") === pin);

if (matches.length === 0) return res.status(404).json({ ok: false, error: "No shop found for this phone/PIN" });

// Resolve merged shops to their canonical targets
const canonicalOf = (s) => {
  if (!s) return null;
  if (s.isMerged === true && s.mergedInto) {
    const canonical = db.shops.find(x => x.shopId === s.mergedInto);
    if (canonical) return canonical;
  }
  return s;
};

const canonicalMap = new Map();
for (const s of matches) {
  const c = canonicalOf(s);
  if (c) canonicalMap.set(c.shopId, c);
}

const canonicalList = Array.from(canonicalMap.values());
const shops = canonicalList.map((s) => ({ shopId: s.shopId, shopCode: s.shopCode, shopName: s.shopName }));

const mergeRequired = canonicalList.length > 1;
// Pick a recommended canonical shop: most recently updated/created
let chosen = canonicalList[0];
for (const s of canonicalList) {
  const a = Number(s.updatedAt || s.createdAt || 0);
  const b = Number(chosen.updatedAt || chosen.createdAt || 0);
  if (a > b) chosen = s;
}
const recommendedShopId = chosen ? chosen.shopId : (shops[0]?.shopId || "");
  // For simplicity, auto-select the first shop for token
  const shopId = recommendedShopId || (shops[0] ? shops[0].shopId : "");

  // bind device as ADMIN
  const existing = db.devices.find((d) => d.deviceId === deviceId);
  if (existing) {
    existing.shopId = shopId;
    existing.role = "ADMIN";
    existing.pairedAt = Date.now();
    existing.isActive = true;
  } else {
    db.devices.push({ deviceId, shopId, role: "ADMIN", pairedAt: Date.now(), isActive: true });
  }

  writeDB(db);

  const token = signToken({ deviceId, shopId, role: "ADMIN" });
  return res.json({ ok: true, shops, shopId, token, mergeRequired, mergeCandidates: shops, recommendedShopId });
});

/**
 * Resolve shop by code (useful for UI)
 */
r.get("/by-code/:shopCode", (req, res) => {
  const shopCode = (req.params.shopCode || "").toUpperCase();
  const db = readDB();

  const shop = db.shops.find((s) => (s.shopCode || "").toUpperCase() === shopCode);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  return res.json({
    ok: true,
    shop: { shopId: shop.shopId, shopCode: shop.shopCode, shopName: shop.shopName },
  });
});

export default r;
