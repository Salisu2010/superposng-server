import { Router } from "express";
import { upsertDeviceToken, removeDeviceToken, ensureFcm } from "../fcm.js";

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
 * POST /api/stmn/fcm/register
 * body: { token, deviceId, role }
 * Requires Bearer auth (same JWT used for /api/stmn/sync).
 */
r.post("/register", async (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;

  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);
  const role = trim(req.body?.role);

  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  upsertDeviceToken({ shopId, deviceId, token, platform: "android", role });
  // Check if FCM is configured (optional)
  const messaging = await ensureFcm();
  return res.json({ ok: true, fcmReady: !!messaging });
});

/**
 * POST /api/stmn/fcm/unregister
 * body: { token, deviceId }
 */
r.post("/unregister", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;
  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);
  const out = removeDeviceToken({ shopId, deviceId, token });
  return res.json({ ok: true, ...out });
});

export default r;
