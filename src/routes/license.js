import { Router } from "express";
import { readDB, writeDB } from "../db.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return s(v).trim();
}

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
