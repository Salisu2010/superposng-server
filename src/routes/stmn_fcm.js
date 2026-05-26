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

  // IMPORTANT: upsertDeviceToken signature is (shopId, deviceId, role, token)
  // A previous refactor accidentally called it with an object which caused tokens
  // not to be stored (=> no notifications after server upgrade).
  const out = upsertDeviceToken(shopId, deviceId, role, token);

  // Check if FCM is configured (optional)
  const st = ensureFcm();
  return res.json({ ok: true, stored: !!out?.ok, fcmDisabled: !!st?.disabled, reason: st?.reason || "" });
});

/**
 * POST /api/stmn/fcm/unregister
 * body: { token, deviceId }
 */
r.post("/unregister", (req, res) => {
  const shopId = requireShop(req, res);
  if (!shopId) return;
  // token is optional here; deviceId is our primary key
  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);
  // removeDeviceToken signature is (shopId, deviceId)
  const out = removeDeviceToken(shopId, deviceId);
  return res.json({ ok: true, ...out });
});

export default r;
