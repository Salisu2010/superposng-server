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

  // ✅ Reuse ONLY if same owner + same shopName (prevents duplicate-tap), otherwise allow multiple shops per owner
  let reused = false;
  let shop = null;

  const sameOwner = (s) => phone && pin && normPhone(s.ownerPhone) === phone && (s.ownerPin || "") === pin;
  const sameName = (s) => (s?.shopName || "").toString().trim().toLowerCase() === (shopName || "").toString().trim().toLowerCase();

  // If ownerPhone+ownerPin provided, we allow multiple shops. We only reuse when shopName matches.
  if (phone && pin) {
    const candidate = db.shops.find((s) => sameOwner(s) && sameName(s));
    if (candidate) {
      shop = candidate;
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



/**
 * List all shops for the current OWNER account (ADMIN token required)
 * - Derives ownerPhone+ownerPin from the current shop record (professional + no extra client params)
 * - Resolves merged shops to canonical targets
 */
r.get("/list", (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const decoded = jwt.verify(token, secret);
    const { shopId, role } = decoded || {};
    if (!shopId) return res.status(401).json({ ok: false, error: "Invalid token" });
    if ((role || "").toUpperCase() !== "ADMIN") return res.status(403).json({ ok: false, error: "Admins only" });

    const db = readDB();
    if (!Array.isArray(db.shops)) db.shops = [];

    const cur = db.shops.find((s) => String(s.shopId) === String(shopId));
    if (!cur) return res.status(404).json({ ok: false, error: "Shop not found" });

    const phone = normPhone(cur.ownerPhone);
    const pin = (cur.ownerPin || "").toString().trim();
    if (!phone || !pin) {
      return res.json({ ok: true, shops: [{ shopId: cur.shopId, shopCode: cur.shopCode, shopName: cur.shopName }], note: "Owner phone/PIN not set for this shop" });
    }

    const canonicalOf = (s) => {
      if (!s) return null;
      if (s.isMerged === true && s.mergedInto) {
        const canonical = db.shops.find(x => String(x.shopId) === String(s.mergedInto));
        if (canonical) return canonical;
      }
      return s;
    };

    const matches = db.shops.filter((s) => normPhone(s.ownerPhone) === phone && (s.ownerPin || "") === pin);
    const canonicalMap = new Map();
    for (const s of matches) {
      const c = canonicalOf(s);
      if (c) canonicalMap.set(c.shopId, c);
    }
    const canonicalList = Array.from(canonicalMap.values());
    const shops = canonicalList.map((s) => ({ shopId: s.shopId, shopCode: s.shopCode, shopName: s.shopName }));

    return res.json({ ok: true, shops, count: shops.length });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
});

/**
 * Switch current shop for this ADMIN device (ADMIN token required)
 * body: { targetShopId }
 * returns: { ok:true, token, shopId, shopCode, shopName }
 */
r.post("/switch", (req, res) => {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

  const targetShopIdRaw = (req.body?.targetShopId || "").toString().trim();
  if (!targetShopIdRaw) return res.status(400).json({ ok: false, error: "targetShopId is required" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const decoded = jwt.verify(token, secret);
    const deviceId = (decoded?.deviceId || "").toString().trim();
    const curShopId = (decoded?.shopId || "").toString().trim();
    const role = (decoded?.role || "").toString().trim().toUpperCase();

    if (!deviceId || !curShopId) return res.status(401).json({ ok: false, error: "Invalid token" });
    if (role !== "ADMIN") return res.status(403).json({ ok: false, error: "Admins only" });

    const db = readDB();
    if (!Array.isArray(db.shops)) db.shops = [];
    if (!Array.isArray(db.devices)) db.devices = [];

    const cur = db.shops.find((s) => String(s.shopId) === String(curShopId));
    if (!cur) return res.status(404).json({ ok: false, error: "Current shop not found" });

    const phone = normPhone(cur.ownerPhone);
    const pin = (cur.ownerPin || "").toString().trim();

    // Resolve target to canonical if merged
    let target = db.shops.find((s) => String(s.shopId) === String(targetShopIdRaw));
    if (!target) return res.status(404).json({ ok: false, error: "Target shop not found" });
    if (target.isMerged === true && target.mergedInto) {
      const canonical = db.shops.find(x => String(x.shopId) === String(target.mergedInto));
      if (canonical) target = canonical;
    }

    // Verify same owner
    if (phone && pin) {
      const okOwner = normPhone(target.ownerPhone) === phone && (target.ownerPin || "") === pin;
      if (!okOwner) return res.status(403).json({ ok: false, error: "Target shop does not belong to this owner" });
    } else {
      // Legacy shop without ownerPhone/PIN: only allow switching if current and target share same ownerDeviceId
      const okLegacy = String(target.ownerDeviceId || "") === String(cur.ownerDeviceId || "");
      if (!okLegacy) return res.status(403).json({ ok: false, error: "Target shop not allowed (legacy owner binding)" });
    }

    // Bind device to target shop as ADMIN
    const existing = db.devices.find((d) => String(d.deviceId) === String(deviceId));
    if (existing) {
      existing.shopId = target.shopId;
      existing.role = "ADMIN";
      existing.pairedAt = Date.now();
      existing.isActive = true;
    } else {
      db.devices.push({ deviceId, shopId: target.shopId, role: "ADMIN", pairedAt: Date.now(), isActive: true });
    }
    writeDB(db);

    const newToken = signToken({ deviceId, shopId: target.shopId, role: "ADMIN" });
    return res.json({ ok: true, token: newToken, shopId: target.shopId, shopCode: target.shopCode, shopName: target.shopName });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
});

export default r;
