import { Router } from "express";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { readDB, writeDB } from "../db.js";

const r = Router();

function signToken(payload) {
  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  return jwt.sign(payload, secret, { expiresIn: "30d" });
}

function now() {
  return Date.now();
}

/**
 * Admin generates a one-time pairing code for a cashier device
 * body: { shopId, adminDeviceId }
 */
r.post("/generate", (req, res) => {
  const { shopId, adminDeviceId } = req.body || {};
  if (!shopId || !adminDeviceId) {
    return res
      .status(400)
      .json({ ok: false, error: "shopId and adminDeviceId are required" });
  }

  const db = readDB();

  const shop = db.shops.find((s) => s.shopId === shopId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  // simple admin check (demo)
  const admin = db.devices.find(
    (d) => d.deviceId === adminDeviceId && d.shopId === shopId && d.role === "ADMIN"
  );
  if (!admin) return res.status(403).json({ ok: false, error: "Not allowed" });

  const minutes = parseInt(process.env.PAIRING_EXPIRE_MIN || "10", 10);
  const pairingCode = ("PAIR-" + nanoid(6)).toUpperCase();
  const expiresAt = now() + minutes * 60 * 1000;

  // ensure array exists (safety)
  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];

  db.pairCodes.push({
    pairingCode,
    shopId,
    createdAt: now(),
    expiresAt,
    used: false,
  });

  writeDB(db);
  return res.json({ ok: true, pairingCode, expiresAt });
});

/**
 * Cashier connects using pairingCode
 * body: { pairingCode, deviceId, role? } -> returns { token, shopId }
 */
r.post("/connect", (req, res) => {
  const pairingCode = (req.body?.pairingCode || "").toUpperCase().trim();
  const deviceId = (req.body?.deviceId || "").trim();
  const role = (req.body?.role || "CASHIER").toString().toUpperCase().trim();

  if (!pairingCode || !deviceId) {
    return res
      .status(400)
      .json({ ok: false, error: "pairingCode and deviceId are required" });
  }

  const db = readDB();

  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];
  if (!Array.isArray(db.devices)) db.devices = [];
  if (!Array.isArray(db.shops)) db.shops = [];

  const p = db.pairCodes.find(
    (x) => (x.pairingCode || "").toUpperCase() === pairingCode
  );

  if (!p) return res.status(404).json({ ok: false, error: "Invalid pairing code" });
  if (p.used) return res.status(400).json({ ok: false, error: "Pairing code already used" });
  if (now() > p.expiresAt) return res.status(400).json({ ok: false, error: "Pairing code expired" });

  // verify shop still exists
  const shop = db.shops.find((s) => s.shopId === p.shopId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  // mark used
  p.used = true;
  p.usedAt = now();
  p.usedByDeviceId = deviceId;

  // register/update device
  const existing = db.devices.find((d) => d.deviceId === deviceId);
  if (existing) {
    existing.shopId = p.shopId;
    existing.role = role;
    existing.pairedAt = now();
    existing.isActive = true;
  } else {
    db.devices.push({
      deviceId,
      shopId: p.shopId,
      role,
      pairedAt: now(),
      isActive: true,
    });
  }

  writeDB(db);

  const token = signToken({ deviceId, shopId: p.shopId, role });
  return res.json({ ok: true, token, shopId: p.shopId, role });
});

export default r;
