import { Router } from "express";
import { nanoid } from "nanoid";
import { readDB, writeDB } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";

const r = Router();

function trim(v) {
  return (v === null || v === undefined) ? "" : String(v).trim();
}

function upper(v) {
  return trim(v).toUpperCase();
}

function asInt(v, d = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : d;
}

function pickShopId(req) {
  const auth = req.auth || {};
  // Owner token: must pass shopId and it must be among allowed shops
  if (auth.role === "owner") {
    const shopId = trim(req.query.shopId || req.body?.shopId || req.params?.shopId);
    if (!shopId) return { ok: false, status: 400, error: "shopId required" };
    const allowed = Array.isArray(auth.shops) ? auth.shops : [];
    if (!allowed.includes(shopId)) return { ok: false, status: 403, error: "No access to this shop" };
    return { ok: true, shopId };
  }

  // Device token: shopId is embedded
  const shopId = trim(auth.shopId);
  if (!shopId) return { ok: false, status: 401, error: "Missing auth shopId" };

  // Only ADMIN can manage devices
  if (upper(auth.role) !== "ADMIN") {
    return { ok: false, status: 403, error: "Admin access required" };
  }

  return { ok: true, shopId };
}

function safeRole(role) {
  const r = upper(role);
  if (r === "ADMIN" || r === "CASHIER") return r;
  // Allow OWNER_DEVICE if needed in future; keep strict for now.
  return "CASHIER";
}

// List devices for a shop
r.get("/", authMiddleware, (req, res) => {
  const pick = pickShopId(req);
  if (!pick.ok) return res.status(pick.status).json({ ok: false, error: pick.error });
  const shopId = pick.shopId;

  const db = readDB();
  if (!Array.isArray(db.devices)) db.devices = [];

  const list = db.devices
    .filter((d) => trim(d.shopId) === shopId)
    .map((d) => ({
      deviceId: trim(d.deviceId),
      role: upper(d.role),
      label: trim(d.label || d.name || ""),
      pairedAt: d.pairedAt || 0,
      addedAt: d.addedAt || d.pairedAt || 0,
      lastSeenAt: d.lastSeenAt || 0,
      isActive: d.isActive !== false,
      isRevoked: d.isRevoked === true,
      revokedAt: d.revokedAt || 0,
      revokedReason: trim(d.revokedReason || ""),
    }))
    .sort((a, b) => (b.lastSeenAt || b.addedAt || 0) - (a.lastSeenAt || a.addedAt || 0));

  return res.json({ ok: true, shopId, count: list.length, devices: list });
});

// Register/add a device (manual registry)
r.post("/register", authMiddleware, (req, res) => {
  const pick = pickShopId(req);
  if (!pick.ok) return res.status(pick.status).json({ ok: false, error: pick.error });
  const shopId = pick.shopId;

  const deviceId = trim(req.body?.deviceId);
  const role = safeRole(req.body?.role);
  const label = trim(req.body?.label || req.body?.name || "");

  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  const db = readDB();
  if (!Array.isArray(db.devices)) db.devices = [];

  const now = Date.now();
  const existing = db.devices.find((d) => trim(d.deviceId) === deviceId);
  if (existing) {
    existing.shopId = shopId;
    existing.role = role;
    if (label) existing.label = label;
    existing.isActive = true;
    // NOTE: do not auto-unrevoke
    existing.updatedAt = now;
  } else {
    db.devices.push({
      deviceId,
      shopId,
      role,
      label,
      isActive: true,
      isRevoked: false,
      addedAt: now,
      pairedAt: now,
      lastSeenAt: 0,
    });
  }

  writeDB(db);
  return res.json({ ok: true, shopId, deviceId, role, label });
});

// Revoke a device (blocks its tokens via middleware)
r.post("/revoke", authMiddleware, (req, res) => {
  const pick = pickShopId(req);
  if (!pick.ok) return res.status(pick.status).json({ ok: false, error: pick.error });
  const shopId = pick.shopId;

  const deviceId = trim(req.body?.deviceId);
  const reason = trim(req.body?.reason || req.body?.note || "");

  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  const db = readDB();
  if (!Array.isArray(db.devices)) db.devices = [];

  const d = db.devices.find((x) => trim(x.deviceId) === deviceId && trim(x.shopId) === shopId);
  if (!d) return res.status(404).json({ ok: false, error: "Device not found" });

  const now = Date.now();
  d.isRevoked = true;
  d.isActive = false;
  d.revokedAt = now;
  d.revokedReason = reason;
  d.revokedBy = (req.auth?.role === "owner") ? (req.auth?.sub || "owner") : (req.auth?.deviceId || "admin");
  d.updatedAt = now;

  writeDB(db);
  return res.json({ ok: true, shopId, deviceId, revokedAt: now });
});

// Update device role (ADMIN <-> CASHIER)
r.post("/role", authMiddleware, (req, res) => {
  const pick = pickShopId(req);
  if (!pick.ok) return res.status(pick.status).json({ ok: false, error: pick.error });
  const shopId = pick.shopId;

  const deviceId = trim(req.body?.deviceId);
  const role = safeRole(req.body?.role);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  const db = readDB();
  if (!Array.isArray(db.devices)) db.devices = [];

  const d = db.devices.find((x) => trim(x.deviceId) === deviceId && trim(x.shopId) === shopId);
  if (!d) return res.status(404).json({ ok: false, error: "Device not found" });

  d.role = role;
  d.updatedAt = Date.now();
  writeDB(db);
  return res.json({ ok: true, shopId, deviceId, role });
});

// Generate a one-time pairing code (Owner/Admin). Uses existing db.pairCodes table.
r.post("/pair-code", authMiddleware, (req, res) => {
  const pick = pickShopId(req);
  if (!pick.ok) return res.status(pick.status).json({ ok: false, error: pick.error });
  const shopId = pick.shopId;

  const role = safeRole(req.body?.role || "CASHIER");
  const expiresMin = Math.max(1, Math.min(asInt(req.body?.expiresMin || 10, 10), 120));

  const db = readDB();
  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];

  const pairingCode = ("PAIR-" + nanoid(6)).toUpperCase();
  const now = Date.now();
  const expiresAt = now + expiresMin * 60 * 1000;

  db.pairCodes.push({
    pairingCode,
    shopId,
    role,
    createdAt: now,
    expiresAt,
    used: false,
  });

  writeDB(db);
  return res.json({ ok: true, pairingCode, role, expiresAt });
});

export default r;
