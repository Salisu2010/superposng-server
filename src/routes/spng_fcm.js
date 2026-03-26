import { Router } from "express";
import { upsertSpngDeviceToken, removeSpngDeviceToken, ensureFcm } from "../fcm.js";

const r = Router();

function requireShop(req, res) {
  const raw = req.auth?.shopId ? String(req.auth.shopId) : "";
  if (!raw) {
    res.status(401).json({ ok: false, error: "Missing auth shopId" });
    return null;
  }
  return raw;
}

function trim(v) {
  return (v ?? "").toString().trim();
}

/**
 * POST /api/spng/fcm/register
 * body: { token, deviceId, role }
 * Requires Bearer auth (same JWT used for /api/sync).
 */
r.post("/register", async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);
  const role = trim(req.body?.role);

  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  const out = upsertSpngDeviceToken(shopId, deviceId, role, token);

  const init = ensureFcm();
    return res.json({
    ok: true,
    stored: out,
    fcm: init,
  });
});

/**
 * POST /api/spng/fcm/unregister
 * body: { deviceId }
 */
r.post("/unregister", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const deviceId = trim(req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "missing_deviceId" });

  const out = removeSpngDeviceToken(shopId, deviceId);
    return res.json({ ok: true, removed: out });
});

export default r;
