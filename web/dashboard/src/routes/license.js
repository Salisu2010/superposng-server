import { Router } from "express";
import { readDB, writeDB } from "../db.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return s(v).trim();
}

// Device claims a pending activation assigned by developer.
// This endpoint is intentionally public but only returns data for the exact deviceId.
r.get("/claim", (req, res) => {
  const db = readDB();
  const deviceId = trim(req.query?.deviceId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  const pending = db.pendingActivations.find((x) => trim(x.deviceId) === deviceId);
  if (!pending) return res.json({ ok: true, found: false });

  const lic = db.licenses.find((x) => trim(x.token) === trim(pending.token));
  if (!lic) {
    // Cleanup dangling pending record
    db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
    writeDB(db);
    return res.json({ ok: true, found: false });
  }

  if (trim(lic.status) === "REVOKED") {
    db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
    writeDB(db);
    return res.status(400).json({ ok: false, error: "revoked" });
  }

  // Bind on first claim
  if (!trim(lic.boundDeviceId)) lic.boundDeviceId = deviceId;
  if (trim(lic.boundDeviceId) !== deviceId) {
    return res.status(409).json({ ok: false, error: "token bound to another device", boundDeviceId: lic.boundDeviceId });
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
    token: lic.token,
    plan: lic.plan,
    expiresAt: lic.expiresAt,
    shopId: lic.boundShopId || "",
    serverTime: Date.now()
  });
});

export default r;
