import { Router } from "express";
import { readDB, writeDB } from "../db.js";
import {
  trim as _trim,
  parseAndVerifySpng1,
  devhash16,
  daysLeftFromYmd,
} from "../spng1.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return _trim(v);
}

// ------------------------------------------------------------
// Android Online Activation Check (SPNG1)
// POST /api/license/check
// body: { token, androidId }
// Returns keys Android typically expects: ok, message, plan, expiryYmd, daysLeft
// Also auto-registers a valid token into DB so revoke/extend works reliably.
// ------------------------------------------------------------
r.post("/check", (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  if (!token) return res.status(400).json({ ok: false, message: "token required" });
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  const pv = parseAndVerifySpng1(token);
  if (!pv.ok) return res.status(400).json({ ok: false, message: pv.error || "Token not valid" });

  // Ensure token belongs to this device
  let want = "";
  try { want = devhash16(androidId); } catch (e) { /* ignore */ }
  if (!want || want !== pv.devHash) {
    return res.status(400).json({ ok: false, message: "Token not for this device" });
  }

  // Look up in DB (for revoke/extend)
  const lic = Array.isArray(db.licenses)
    ? db.licenses.find((x) => trim(x.token) === pv.token)
    : null;

  if (lic && trim(lic.status) === "REVOKED") {
    return res.status(403).json({ ok: false, message: "Token revoked" });
  }

  // Auto-register if not found
  if (!lic) {
    const licenseId = `LIC-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
    const rec = {
      licenseId,
      token: pv.token,
      plan: pv.plan,
      status: "ACTIVE",
      createdAt: Date.now(),
      expiresAt: pv.expiresAt,
      expiryYmd: pv.expiryYmd,
      devHash: pv.devHash,
      boundDeviceId: androidId,
      boundShopId: "",
      activatedAt: Date.now(),
      notes: "AUTO-REGISTERED BY /license/check"
    };
    db.licenses = Array.isArray(db.licenses) ? db.licenses : [];
    db.licenses.unshift(rec);
    writeDB(db);
  }

  const daysLeft = daysLeftFromYmd(pv.expiryYmd);
  if (daysLeft <= 0) return res.status(403).json({ ok: false, message: "Token expired", plan: pv.plan, expiryYmd: parseInt(pv.expiryYmd, 10) || 0, daysLeft: 0 });

  return res.json({ ok: true, message: "OK", plan: pv.plan, expiryYmd: parseInt(pv.expiryYmd, 10) || 0, daysLeft });
});

function licensePayload(lic) {
  return {
    token: lic.token,
    plan: lic.plan,
    expiresAt: lic.expiresAt,
    shopId: lic.boundShopId || "",
    status: lic.status
  };
}

// Device claims a pending activation assigned by developer OR checks current status.
//
// Why this exists:
// - First activation flow uses pendingActivations.
// - After the first claim, pending record is removed.
// - Android may still call this endpoint to re-check status/expiry.
//
// So when there is no pending record, we return the currently bound license by deviceId.
r.get("/claim", (req, res) => {
  const db = readDB();
  const deviceId = trim(req.query?.deviceId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  // 1) Normal first-time activation: pending exists
  const pending = Array.isArray(db.pendingActivations)
    ? db.pendingActivations.find((x) => trim(x.deviceId) === deviceId)
    : null;

  if (pending) {
    const lic = Array.isArray(db.licenses)
      ? db.licenses.find((x) => trim(x.token) === trim(pending.token))
      : null;

    if (!lic) {
      // Cleanup dangling pending record
      db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
      writeDB(db);
      return res.json({ ok: true, found: false, serverTime: Date.now() });
    }

    if (trim(lic.status) === "REVOKED") {
      db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
      writeDB(db);
      return res.status(400).json({ ok: false, error: "revoked", serverTime: Date.now() });
    }

    // Bind on first claim
    if (!trim(lic.boundDeviceId)) lic.boundDeviceId = deviceId;
    if (trim(lic.boundDeviceId) !== deviceId) {
      return res.status(409).json({ ok: false, error: "token bound to another device", boundDeviceId: lic.boundDeviceId, serverTime: Date.now() });
    }

    if (trim(pending.shopId) && !trim(lic.boundShopId)) lic.boundShopId = trim(pending.shopId);

    if (!lic.activatedAt) lic.activatedAt = Date.now();
    lic.status = "ACTIVE";

    // Remove pending once claimed
    db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
    writeDB(db);

    return res.json({
      ok: true,
      found: true,
      ...licensePayload(lic),
      serverTime: Date.now()
    });
  }

  // 2) Subsequent checks: no pending record, but device may already be bound
  const bound = Array.isArray(db.licenses)
    ? db.licenses.find((x) => trim(x.boundDeviceId) === deviceId)
    : null;

  if (!bound) return res.json({ ok: true, found: false, serverTime: Date.now() });

  if (trim(bound.status) === "REVOKED") {
    return res.status(400).json({ ok: false, error: "revoked", serverTime: Date.now() });
  }

  return res.json({
    ok: true,
    found: true,
    ...licensePayload(bound),
    serverTime: Date.now()
  });
});

// Optional: direct status check by token or deviceId
r.get("/status", (req, res) => {
  const db = readDB();
  const token = trim(req.query?.token);
  const deviceId = trim(req.query?.deviceId);

  const lic = Array.isArray(db.licenses)
    ? db.licenses.find((x) => (token && trim(x.token) === token) || (deviceId && trim(x.boundDeviceId) === deviceId))
    : null;

  if (!lic) return res.json({ ok: true, found: false, serverTime: Date.now() });
  if (trim(lic.status) === "REVOKED") return res.status(400).json({ ok: false, error: "revoked", serverTime: Date.now() });

  return res.json({ ok: true, found: true, ...licensePayload(lic), serverTime: Date.now() });
});

export default r;
