import fs from "fs";
import { readDB, writeDB } from "./db.js";

let _messaging = null;

/**
 * Initialize Firebase Admin SDK.
 * Supports either:
 *  - GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json
 *  - FIREBASE_SERVICE_ACCOUNT_JSON='{"type":"service_account",...}'
 */
export async function ensureFcm() {
  if (_messaging) return _messaging;

  try {
    // Lazy import so server still works even if firebase-admin isn't configured.
    // eslint-disable-next-line no-unused-vars
    const admin = await importAdmin();

    const jsonInline = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
    if (jsonInline) {
      const cred = admin.credential.cert(JSON.parse(jsonInline));
      admin.initializeApp({ credential: cred });
    } else {
      // Will use GOOGLE_APPLICATION_CREDENTIALS if set.
      admin.initializeApp();
    }

    _messaging = admin.messaging();
    return _messaging;
  } catch (e) {
    // Not configured; keep null so callers can fallback.
    return null;
  }
}

async function importAdmin() {
  // firebase-admin is ESM-friendly. Use dynamic import so server can boot without config.
  return await import("firebase-admin");
}

function now() { return Date.now(); }

/** Upsert token in db.json (persisted). */
export function upsertDeviceToken({ shopId, deviceId, token, platform, role }) {
  if (!shopId || !token) return { ok: false, error: "missing" };
  const db = readDB();
  db.stmnFcmTokens = Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : [];

  const key = `${String(shopId)}:${String(deviceId || "")}:${String(token)}`;
  const idx = db.stmnFcmTokens.findIndex((x) => x && x.key === key);
  const rec = {
    key,
    shopId: String(shopId),
    deviceId: String(deviceId || ""),
    token: String(token),
    platform: String(platform || "android"),
    role: String(role || ""),
    updatedAt: now(),
  };
  if (idx >= 0) db.stmnFcmTokens[idx] = { ...db.stmnFcmTokens[idx], ...rec };
  else db.stmnFcmTokens.push(rec);

  // Bound size to avoid runaway growth.
  if (db.stmnFcmTokens.length > 20000) db.stmnFcmTokens = db.stmnFcmTokens.slice(-20000);
  writeDB(db);
  return { ok: true };
}

export function removeDeviceToken({ shopId, deviceId, token }) {
  const db = readDB();
  db.stmnFcmTokens = Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : [];
  const before = db.stmnFcmTokens.length;
  db.stmnFcmTokens = db.stmnFcmTokens.filter((x) => {
    if (!x) return false;
    if (shopId && String(x.shopId) !== String(shopId)) return true;
    if (deviceId && String(x.deviceId) !== String(deviceId)) return true;
    if (token && String(x.token) !== String(token)) return true;
    return false;
  });
  writeDB(db);
  return { ok: true, removed: before - db.stmnFcmTokens.length };
}

/**
 * Send background push notification to all tokens in a shop.
 * Payload is kept small; clients will do a delta pull on receipt.
 */
export async function pushShopChange({ shopId, title, body, data = {} }) {
  const messaging = await ensureFcm();
  if (!messaging) return { ok: false, error: "fcm_not_configured" };

  const db = readDB();
  const tokens = (Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : [])
    .filter((x) => x && String(x.shopId) === String(shopId))
    .map((x) => String(x.token))
    .filter(Boolean);

  if (tokens.length === 0) return { ok: true, sent: 0 };

  const msg = {
    tokens,
    notification: {
      title: title || "StayMasterNG",
      body: body || "New update available",
    },
    data: {
      shopId: String(shopId),
      type: String(data.type || "stmn_changed"),
      at: String(data.at || now()),
      ...Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k), String(v)])),
    },
    android: {
      priority: "high",
    },
  };

  try {
    const resp = await messaging.sendEachForMulticast(msg);
    // Remove invalid tokens
    const bad = [];
    resp.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        if (String(code).includes("registration-token-not-registered") || String(code).includes("invalid-argument")) {
          bad.push(tokens[i]);
        }
      }
    });
    if (bad.length) {
      // prune
      const db2 = readDB();
      db2.stmnFcmTokens = (Array.isArray(db2.stmnFcmTokens) ? db2.stmnFcmTokens : []).filter((x) => x && !bad.includes(String(x.token)));
      writeDB(db2);
    }
    return { ok: true, sent: resp.successCount, failed: resp.failureCount };
  } catch (e) {
    return { ok: false, error: "send_failed" };
  }
}
