import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import {
  trim as _trim,
  genRmp1Token,
  parseAndVerifyRmp1,
  devhash16,
  normalizeDevhash,
  daysLeftFromYmd,
} from "../rmp1.js";

const r = Router();

function trim(v) {
  return _trim(v);
}

function requireDevKey(req, res, next) {
  const expected = trim(process.env.DEV_KEY);
  if (!expected) return res.status(500).json({ ok: false, error: "DEV_KEY not configured on server" });
  const got = trim(req.header("X-DEV-KEY")) || trim((req.header("Authorization") || "").replace(/^Bearer\s+/i, ""));
  if (got && got === expected) return next();
  return res.status(403).json({ ok: false, error: "Forbidden" });
}

// ------------------------------------------------------------
// Pricing (for portals / app info)
// GET /api/rmp/pricing
// ------------------------------------------------------------
r.get("/pricing", (_req, res) => {
  return res.json({
    ok: true,
    currency: "NGN",
    trialDays: 7,
    monthly: 1500,
    yearly: 15000,
    plans: [
      { plan: "TRIAL", days: 7, price: 0 },
      { plan: "MONTHLY", days: 30, price: 1500 },
      { plan: "YEARLY", days: 365, price: 15000 },
    ]
  });
});

// ------------------------------------------------------------
// DEV: Generate token
// POST /api/rmp/dev/generate-token
// headers: X-DEV-KEY: <DEV_KEY>
// body: { plan: TRIAL|MONTHLY|YEARLY, deviceId }
// ------------------------------------------------------------
r.post("/dev/generate-token", requireDevKey, (req, res) => {
  const db = readDB();
  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const deviceId = trim(req.body?.deviceId || req.body?.androidId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  let token = "";
  try {
    token = genRmp1Token(plan, deviceId);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  const pv = parseAndVerifyRmp1(token);
  if (!pv.ok) return res.status(400).json({ ok: false, error: pv.error || "Token error" });

  const licenseId = `RMP-LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const rec = {
    licenseId,
    token: pv.token,
    tokenVersion: "RMP1",
    plan: pv.plan,
    status: "ISSUED",
    createdAt: Date.now(),
    expiresAt: pv.expiresAt,
    expiryYmd: pv.expiryYmd,
    devHash: pv.devHash,
    boundDeviceId: "",
    activatedAt: 0,
    notes: ""
  };

  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  db.rmpLicenses.unshift(rec);
  writeDB(db);

  return res.json({ ok: true, license: rec, serverTime: Date.now() });
});

// ------------------------------------------------------------
// Android Online Activation Check
// POST /api/rmp/license/check
// body: { token, androidId }
// returns: ok, message, plan, expiryYmd, daysLeft
// ------------------------------------------------------------
r.post("/license/check", (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  if (!token) return res.status(400).json({ ok: false, message: "token required" });
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  const pv = parseAndVerifyRmp1(token);
  if (!pv.ok) return res.status(400).json({ ok: false, message: pv.error || "Token not valid" });

  let want = "";
  try { want = normalizeDevhash(androidId); } catch (e) {}
  if (!want || want !== pv.devHash) return res.status(400).json({ ok: false, message: "Token not for this device" });

  // DB check for revoke/bind
  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  const lic = db.rmpLicenses.find((x) => trim(x.token) === pv.token) || null;
  if (lic && trim(lic.status).toUpperCase() === "REVOKED") return res.status(403).json({ ok: false, message: "Token revoked" });

  // Auto-register if not present
  if (!lic) {
    const licenseId = `RMP-LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    db.rmpLicenses.unshift({
      licenseId,
      token: pv.token,
      tokenVersion: "RMP1",
      plan: pv.plan,
      status: "ACTIVE",
      createdAt: Date.now(),
      expiresAt: pv.expiresAt,
      expiryYmd: pv.expiryYmd,
      devHash: pv.devHash,
      boundDeviceId: androidId,
      activatedAt: Date.now(),
      notes: "AUTO-REGISTERED BY /rmp/license/check"
    });
    writeDB(db);
  } else {
    // bind on first check
    if (!trim(lic.boundDeviceId)) lic.boundDeviceId = androidId;
    if (trim(lic.boundDeviceId) !== androidId) {
      return res.status(409).json({ ok: false, message: "token bound to another device", boundDeviceId: lic.boundDeviceId });
    }
    if (!lic.activatedAt) lic.activatedAt = Date.now();
    lic.status = "ACTIVE";
    writeDB(db);
  }

  const daysLeft = daysLeftFromYmd(pv.expiryYmd);
  if (daysLeft <= 0) {
    return res.status(403).json({ ok: false, message: "Token expired", plan: pv.plan, expiryYmd: pv.expiryYmd, daysLeft: 0 });
  }
  return res.json({ ok: true, message: "OK", plan: pv.plan, expiryYmd: pv.expiryYmd, daysLeft });
});

// ------------------------------------------------------------
// Pull active license by device (ONLINE activation from Dev Portal)
// POST /api/rmp/license/pull-by-device
// body: { androidId }
// returns: ok, message, plan, expiryYmd, daysLeft, token
// ------------------------------------------------------------
r.post("/license/pull-by-device", (req, res) => {
  const db = readDB();
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  let dh = "";
  try { dh = normalizeDevhash(androidId); } catch (e) { /* ignore */ }
  if (!dh) return res.status(400).json({ ok: false, message: "androidId required" });

  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  const candidates = db.rmpLicenses
    .filter((x) => trim(x.devHash).toLowerCase() === dh && trim(x.status).toUpperCase() !== "REVOKED")
    .sort((a, b) => Number(b.expiresAt || 0) - Number(a.expiresAt || 0));

  const lic = candidates.length ? candidates[0] : null;
  if (!lic) return res.status(404).json({ ok: false, message: "No active license found" });

  const pv = parseAndVerifyRmp1(lic.token);
  if (!pv.ok) return res.status(400).json({ ok: false, message: "Stored token invalid" });

  const daysLeft = daysLeftFromYmd(pv.expiryYmd);
  if (daysLeft <= 0) return res.status(403).json({ ok: false, message: "Token expired", plan: pv.plan, expiryYmd: pv.expiryYmd, daysLeft: 0 });

  // Bind if not bound
  if (!trim(lic.boundDeviceId)) lic.boundDeviceId = androidId;
  if (trim(lic.boundDeviceId) !== androidId) {
    return res.status(409).json({ ok: false, message: "token bound to another device", boundDeviceId: lic.boundDeviceId });
  }
  lic.status = "ACTIVE";
  if (!lic.activatedAt) lic.activatedAt = Date.now();
  writeDB(db);

  return res.json({ ok: true, message: "OK", plan: pv.plan, expiryYmd: pv.expiryYmd, daysLeft, token: pv.token });
});

// ------------------------------------------------------------
// DEV: Activate online (generate + store + bind)
// POST /api/rmp/dev/activate-online
// headers: X-DEV-KEY
// body: { plan, androidId }
// ------------------------------------------------------------
r.post("/dev/activate-online", requireDevKey, (req, res) => {
  const db = readDB();
  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  if (!androidId) return res.status(400).json({ ok: false, error: "androidId required" });

  let token = "";
  try {
    token = genRmp1Token(plan, androidId);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  const pv = parseAndVerifyRmp1(token);
  if (!pv.ok) return res.status(400).json({ ok: false, error: pv.error || "Token error" });

  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  // Upsert by token
  let lic = db.rmpLicenses.find((x) => trim(x.token) === pv.token) || null;
  if (!lic) {
    const licenseId = `RMP-LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    lic = {
      licenseId,
      token: pv.token,
      tokenVersion: "RMP1",
      plan: pv.plan,
      status: "ACTIVE",
      createdAt: Date.now(),
      expiresAt: pv.expiresAt,
      expiryYmd: pv.expiryYmd,
      devHash: pv.devHash,
      boundDeviceId: androidId,
      activatedAt: Date.now(),
      notes: "DEV ONLINE ACTIVATE"
    };
    db.rmpLicenses.unshift(lic);
  } else {
    lic.plan = pv.plan;
    lic.expiresAt = pv.expiresAt;
    lic.expiryYmd = pv.expiryYmd;
    lic.devHash = pv.devHash;
    lic.status = "ACTIVE";
    if (!trim(lic.boundDeviceId)) lic.boundDeviceId = androidId;
    if (trim(lic.boundDeviceId) !== androidId) {
      return res.status(409).json({ ok: false, error: "token bound to another device", boundDeviceId: lic.boundDeviceId });
    }
    lic.activatedAt = Date.now();
  }

  writeDB(db);
  const daysLeft = daysLeftFromYmd(pv.expiryYmd);
  return res.json({ ok: true, license: lic, plan: pv.plan, expiryYmd: pv.expiryYmd, daysLeft, token: pv.token, serverTime: Date.now() });
});

// ------------------------------------------------------------
// DEV: Revoke token
// POST /api/rmp/dev/revoke { token }
// ------------------------------------------------------------
r.post("/dev/revoke", requireDevKey, (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  if (!token) return res.status(400).json({ ok: false, error: "token required" });
  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  const lic = db.rmpLicenses.find((x) => trim(x.token) === token) || null;
  if (!lic) return res.status(404).json({ ok: false, error: "not found" });
  lic.status = "REVOKED";
  lic.revokedAt = Date.now();
  writeDB(db);
  return res.json({ ok: true, license: lic });
});

export default r;
