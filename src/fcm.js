/**
 * Firebase Cloud Messaging helper for SuperPOSNG / StayMasterNG cloud push.
 *
 * Exports:
 *  - ensureFcm() -> initializes firebase-admin (lazy) if credentials exist
 *  - upsertDeviceToken(shopId, deviceId, role, token)
 *  - removeDeviceToken(shopId, deviceId)
 *  - pushShopChange(shopId, payload, opts)
 *
 * Notes:
 *  - This project runs as ESM (package.json "type": "module").
 *  - firebase-admin is imported as default to support Node 20 ESM.
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import admin from "firebase-admin";
import { fileURLToPath } from "url";
import { readDB, writeDB } from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config helpers ----
function resolveCredPath(p) {
  if (!p || typeof p !== "string") return null;
  // If relative, resolve relative to project root (../ from src)
  if (!path.isAbsolute(p)) {
    const projectRoot = path.resolve(__dirname, "..");
    return path.resolve(projectRoot, p);
  }
  return p;
}

function credPathFromEnv() {
  // Prefer GOOGLE_APPLICATION_CREDENTIALS but accept legacy envs too
  const p =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    process.env.FIREBASE_SERVICE_ACCOUNT ||
    process.env.FCM_SERVICE_ACCOUNT ||
    "";
  return resolveCredPath(p);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ---- firebase-admin init ----
let _fcmReady = false;
let _fcmDisabledReason = "";

function fcmLog(...args) {
  if (String(process.env.FCM_LOG || "1") === "0") return;
  try { console.log("[FCM]", ...args); } catch {}
}

export function ensureFcm() {
  if (_fcmReady) return { ok: true, disabled: false };

  // If already initialized by other code, mark ready
  if (admin?.apps?.length) {
    _fcmReady = true;
    return { ok: true, disabled: false };
  }

  const credPath = credPathFromEnv();

  // Allow running without push (sync should still work)
  if (!credPath) {
    _fcmDisabledReason = "GOOGLE_APPLICATION_CREDENTIALS not set";
    fcmLog("disabled:", _fcmDisabledReason);
    return { ok: true, disabled: true, reason: _fcmDisabledReason };
  }

  if (!fs.existsSync(credPath)) {
    _fcmDisabledReason = `Service account file not found: ${credPath}`;
    fcmLog("disabled:", _fcmDisabledReason);
    return { ok: true, disabled: true, reason: _fcmDisabledReason };
  }

  const raw = fs.readFileSync(credPath, "utf-8");
  const credJson = safeJsonParse(raw);
  if (!credJson) {
    _fcmDisabledReason = `Service account file is not valid JSON: ${credPath}`;
    fcmLog("disabled:", _fcmDisabledReason);
    return { ok: true, disabled: true, reason: _fcmDisabledReason };
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert(credJson),
    });
    _fcmReady = true;
    _fcmDisabledReason = "";
    fcmLog("ready. service account:", credJson?.project_id || "(unknown)");
    return { ok: true, disabled: false };
  } catch (e) {
    // If initializeApp called twice, firebase-admin throws.
    // If already initialized elsewhere, consider it ready.
    if (String(e?.message || "").toLowerCase().includes("already exists")) {
      _fcmReady = true;
      fcmLog("ready (already initialized)");
      return { ok: true, disabled: false };
    }
    _fcmDisabledReason = `firebase-admin init failed: ${e?.message || e}`;
    fcmLog("disabled:", _fcmDisabledReason);
    return { ok: false, disabled: true, reason: _fcmDisabledReason };
  }
}

// ---- Device token store (db.json) ----
function nowTs() {
  return Date.now();
}

function normalizeRole(role) {
  if (!role) return "unknown";
  const r = String(role).trim().toLowerCase();
  return r || "unknown";
}

function tokenKey(token) {
  // Stable, short hash for debugging (don't log full token)
  return crypto.createHash("sha256").update(String(token)).digest("hex").slice(0, 12);
}

export function upsertDeviceToken(shopId, deviceId, role, token) {
  const db = readDB();
  db.stmnFcmTokens = Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : [];

  const entry = {
    shopId: String(shopId || "").trim(),
    deviceId: String(deviceId || "").trim(),
    role: normalizeRole(role),
    token: String(token || "").trim(),
    tokenHash: tokenKey(token),
    updatedAt: nowTs(),
  };

  if (!entry.shopId || !entry.deviceId || !entry.token) {
    return { ok: false, error: "Missing shopId/deviceId/token" };
  }

  const idx = db.stmnFcmTokens.findIndex(
    (t) => t.shopId === entry.shopId && t.deviceId === entry.deviceId
  );

  if (idx >= 0) {
    db.stmnFcmTokens[idx] = { ...db.stmnFcmTokens[idx], ...entry };
  } else {
    db.stmnFcmTokens.push(entry);
  }

  writeDB(db);
  fcmLog("token saved", {
    shopId: entry.shopId,
    deviceId: entry.deviceId,
    role: entry.role,
    tokenHash: entry.tokenHash,
  });
  return { ok: true };
}

export function removeDeviceToken(shopId, deviceId) {
  const db = readDB();
  const before = Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens.length : 0;
  db.stmnFcmTokens = (Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : []).filter(
    (t) => !(t.shopId === String(shopId || "").trim() && t.deviceId === String(deviceId || "").trim())
  );
  writeDB(db);
  const after = db.stmnFcmTokens.length;
  fcmLog("token removed", { shopId: String(shopId || ""), deviceId: String(deviceId || ""), removed: before - after });
  return { ok: true, removed: before - after };
}

function getShopTokens(shopId) {
  const db = readDB();
  const list = Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : [];
  const sid = String(shopId || "").trim();
  return list.filter((t) => t.shopId === sid && t.token);
}

// ---- Push sending ----
export async function pushShopChange(shopId, payload, opts = {}) {
  const init = ensureFcm();
  if (!init.ok) return { ok: false, error: init.reason || "FCM init failed" };
  if (init.disabled) {
    fcmLog("skip push (disabled)", init.reason || "FCM disabled");
    return { ok: true, skipped: true, reason: init.reason || "FCM disabled" };
  }

  const tokens = getShopTokens(shopId).map((t) => t.token).filter(Boolean);
  const uniqueTokens = Array.from(new Set(tokens));

  if (!uniqueTokens.length) return { ok: true, skipped: true, reason: "No device tokens" };

  const title = opts.title || "New update";
  const body = opts.body || "Data synced successfully";
  const data = {};
  if (payload && typeof payload === "object") {
    // Only allow string values in FCM data payload
    for (const [k, v] of Object.entries(payload)) {
      data[String(k)] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }

  const message = {
    tokens: uniqueTokens,
    
    data,
    android: {
      priority: "high",
    },
  };

  try {
    fcmLog("sending", {
      shopId: String(shopId || ""),
      tokens: uniqueTokens.length,
      type: data?.type || "(none)",
      title,
    });
    const res = await admin.messaging().sendEachForMulticast(message);

    // Remove invalid tokens to keep db clean
    if (res?.responses?.length) {
      const bad = [];
      res.responses.forEach((r, i) => {
        if (!r.success) {
          const err = r.error?.code || r.error?.message || "";
          // Typical invalid token codes
          if (
            String(err).includes("registration-token-not-registered") ||
            String(err).includes("invalid-argument")
          ) {
            bad.push(uniqueTokens[i]);
          }
        }
      });
      if (bad.length) {
        // purge by token match
        const db = readDB();
        db.stmnFcmTokens = (Array.isArray(db.stmnFcmTokens) ? db.stmnFcmTokens : []).filter(
          (t) => !bad.includes(t.token)
        );
        writeDB(db);
      }
    }

    return {
      ok: true,
      successCount: res?.successCount || 0,
      failureCount: res?.failureCount || 0,
    };
  } catch (e) {
    fcmLog("send error", e?.message || String(e));
    return { ok: false, error: e?.message || String(e) };
  }
}

// Convenience re-export name used in some older codebases
export const pushShopChangeNow = pushShopChange;
