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

// ---- Pairing API (Enterprise)
// STMNG expects:
//   POST /api/pair/create   (Admin/Manager generates code)
//   POST /api/pair/consume  (Other roles connect with code)
// Older clients used:
//   POST /api/pair/generate
//   POST /api/pair/connect
// We keep all 4 paths.

function normalizeRole(v) {
  return String(v || "").toUpperCase().trim();
}

function cleanExpiredPairCodes(db) {
  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];
  const t = now();
  // Keep used codes for audit; remove expired unused codes.
  db.pairCodes = db.pairCodes.filter((p) => {
    if (!p) return false;
    if (p.used) return true;
    const exp = Number(p.expiresAt || 0) || 0;
    if (!exp) return true;
    return t <= exp;
  });
}

function requireShop(db, shopId) {
  if (!Array.isArray(db.shops)) db.shops = [];
  return db.shops.find((s) => s.shopId === shopId);
}

function requireAdmin(db, shopId, adminDeviceId) {
  if (!Array.isArray(db.devices)) db.devices = [];
  const role = "ADMIN";
  return db.devices.find(
    (d) => d.deviceId === adminDeviceId && d.shopId === shopId && normalizeRole(d.role) === role
  );
}

/**
 * Admin/Manager generates a one-time pairing code for a role device
 * body: { shopId, adminDeviceId, targetRole?, branchId? }
 */
function handleCreate(req, res) {
  const { shopId, adminDeviceId, targetRole, branchId } = req.body || {};
  if (!shopId || !adminDeviceId) {
    return res.status(400).json({ ok: false, error: "shopId and adminDeviceId are required" });
  }

  const db = readDB();

  const shop = requireShop(db, shopId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  // simple admin check (you can extend to MANAGER if you want)
  const admin = requireAdmin(db, shopId, adminDeviceId);
  if (!admin) return res.status(403).json({ ok: false, error: "Not allowed" });

  const minutes = parseInt(process.env.PAIRING_EXPIRE_MIN || "10", 10);
  const pairingCode = ("PAIR-" + nanoid(6)).toUpperCase();
  const expiresAt = now() + minutes * 60 * 1000;

  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];
  cleanExpiredPairCodes(db);

  const roleWanted = normalizeRole(targetRole) || "STAFF";
  const branchWanted = String(branchId || "").trim();

  db.pairCodes.push({
    pairingCode,
    shopId,
    targetRole: roleWanted,
    branchId: branchWanted,
    createdAt: now(),
    expiresAt,
    used: false,
  });

  writeDB(db);
  return res.json({
    ok: true,
    pairingCode,
    expiresAt,
    shopId,
    targetRole: roleWanted,
    branchId: branchWanted,
  });
}

/**
 * Role device consumes pairing code
 * body: { pairingCode, deviceId, role?, branchId? }
 */
function handleConsume(req, res) {
  const pairingCode = (req.body?.pairingCode || "").toUpperCase().trim();
  const deviceId = (req.body?.deviceId || "").trim();
  const reqRole = normalizeRole(req.body?.role || "");
  const reqBranch = String(req.body?.branchId || "").trim();

  if (!pairingCode || !deviceId) {
    return res.status(400).json({ ok: false, error: "pairingCode and deviceId are required" });
  }

  const db = readDB();
  if (!Array.isArray(db.pairCodes)) db.pairCodes = [];
  if (!Array.isArray(db.devices)) db.devices = [];
  if (!Array.isArray(db.shops)) db.shops = [];

  cleanExpiredPairCodes(db);

  const p = db.pairCodes.find((x) => (x?.pairingCode || "").toUpperCase() === pairingCode);
  if (!p) return res.status(404).json({ ok: false, error: "Invalid pairing code" });
  if (p.used) return res.status(400).json({ ok: false, error: "Pairing code already used" });
  if (now() > p.expiresAt) return res.status(400).json({ ok: false, error: "Pairing code expired" });

  const shop = requireShop(db, p.shopId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  const resolvedRole = normalizeRole(p.targetRole) || reqRole || "STAFF";
  const resolvedBranch = String(p.branchId || reqBranch || "").trim();

  // mark used
  p.used = true;
  p.usedAt = now();
  p.usedByDeviceId = deviceId;
  p.usedByRole = resolvedRole;
  p.usedByBranchId = resolvedBranch;

  // register/update device
  const existing = db.devices.find((d) => d.deviceId === deviceId);
  if (existing) {
    existing.shopId = p.shopId;
    existing.role = resolvedRole;
    existing.branchId = resolvedBranch;
    existing.pairedAt = now();
    existing.isActive = true;
  } else {
    db.devices.push({
      deviceId,
      shopId: p.shopId,
      role: resolvedRole,
      branchId: resolvedBranch,
      pairedAt: now(),
      isActive: true,
    });
  }

  writeDB(db);

  const token = signToken({ deviceId, shopId: p.shopId, role: resolvedRole, branchId: resolvedBranch });

  // Optional: pass back server-provided bases if stored in shop config
  const apiBase = String(shop.apiBase || shop.cloudBase || "").trim();
  const adminHubBase = String(shop.adminHubBase || shop.hubBase || "").trim();

  return res.json({
    ok: true,
    token,
    shopId: p.shopId,
    role: resolvedRole,
    branchId: resolvedBranch,
    apiBase: apiBase || undefined,
    adminHubBase: adminHubBase || undefined,
    serverTime: new Date().toISOString(),
  });
}

// New STMNG endpoints
r.post("/create", handleCreate);
r.post("/consume", handleConsume);

// Backward compatible endpoints
r.post("/generate", handleCreate);
r.post("/connect", handleConsume);

export default r;
