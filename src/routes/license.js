import { Router } from "express";
import { readDB, writeDB } from "../db.js";
import {
  trim as _trim,
  parseAndVerifySpng1,
  devhash16,
  daysLeftFromYmd,
} from "../spng1.js";
import { parseAndVerifySpng2, devhash16Spng2 } from "../spng2.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return _trim(v);
}

function tokenPrefix(t) {
  const x = trim(t).toUpperCase();
  return (x.split("|")[0] || "").toUpperCase();
}

function parseAnyToken(tokenRaw) {
  const pref = tokenPrefix(tokenRaw);
  if (pref === "SPNG2") return { version: "SPNG2", parsed: parseAndVerifySpng2(tokenRaw) };
  return { version: "SPNG1", parsed: parseAndVerifySpng1(tokenRaw) };
}


function now() { return Date.now(); }
function ensureSecurity(db) {
  db.security = db.security && typeof db.security === "object" ? db.security : {};
  db.security.blacklist = Array.isArray(db.security.blacklist) ? db.security.blacklist : [];
  db.security.rate = db.security.rate && typeof db.security.rate === "object" ? db.security.rate : {};
  return db.security;
}
function isBlacklisted(sec, devHash) {
  const dh = trim(devHash);
  if (!dh) return null;
  const hit = sec.blacklist.find(x => trim(x.devHash) === dh) || null;
  if (!hit) return null;
  const until = Number(hit.until || 0);
  if (until > 0 && now() > until) return null;
  return hit;
}
function applyRateLimit(sec, devHash) {
  const dh = trim(devHash);
  if (!dh) return { ok: true };
  const key = dh;
  const rec = sec.rate[key] && typeof sec.rate[key] === "object" ? sec.rate[key] : { winStart: 0, count: 0, blockedUntil: 0 };
  const t = now();

  // If currently blocked
  if (rec.blockedUntil && t < rec.blockedUntil) {
    sec.rate[key] = rec;
    return { ok: false, retryAfterSec: Math.ceil((rec.blockedUntil - t) / 1000) };
  }

  const WIN_MS = 5 * 60 * 1000;      // 5 minutes
  const MAX = 25;                    // max checks per window
  const BLOCK_MS = 10 * 60 * 1000;   // 10 minutes block

  if (!rec.winStart || (t - rec.winStart) > WIN_MS) {
    rec.winStart = t;
    rec.count = 0;
  }
  rec.count = (rec.count || 0) + 1;

  if (rec.count > MAX) {
    rec.blockedUntil = t + BLOCK_MS;
    sec.rate[key] = rec;
    return { ok: false, retryAfterSec: Math.ceil(BLOCK_MS / 1000) };
  }

  sec.rate[key] = rec;
  return { ok: true };
}
function ymdFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}
function addDaysYmd(days) {
  const d = new Date();
  d.setHours(0,0,0,0);
  d.setDate(d.getDate() + Number(days || 0));
  return ymdFromDate(d);
}
function planDays(plan) {
  const p = trim(plan).toUpperCase();
  if (p.includes("TRIAL")) return 7;
  if (p.includes("WEEK")) return 7;
  if (p.includes("MONTH")) return 30;
  if (p.includes("YEAR")) return 365;
  return 30;
}

// ------------------------------------------------------------
// Android Online Activation Check (SPNG1/SPNG2)
// POST /api/license/check
// body: { token, androidId, fpHash? }
// Returns keys Android typically expects: ok, message, plan, expiryYmd, daysLeft
// Also auto-registers a valid token into DB so revoke/extend works reliably.
// ------------------------------------------------------------
r.post("/check", (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash); // required only for SPNG2

  if (!token) return res.status(400).json({ ok: false, message: "token required" });
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  const any = parseAnyToken(token);
  const pv = any.parsed;
  if (!pv.ok) return res.status(400).json({ ok: false, message: pv.error || "Token not valid" });

  // Ensure token belongs to this device
  let want = "";
  try {
    if (any.version === "SPNG2") {
      if (!fpHash) return res.status(400).json({ ok: false, message: "fpHash required for SPNG2" });
      want = devhash16Spng2(androidId, fpHash);
    } else {
      want = devhash16(androidId);
    }
  } catch (e) { /* ignore */ }

  if (!want || want !== pv.devHash) {
    return res.status(400).json({ ok: false, message: "Token not for this device" });
  }

  // Security: blacklist + rate limit
  const sec = ensureSecurity(db);
  const bl = isBlacklisted(sec, pv.devHash);
  if (bl) {
    writeDB(db);
    return res.status(403).json({ ok: false, message: "Device blocked", reason: s(bl.reason || "blocked") });
  }
  const rl = applyRateLimit(sec, pv.devHash);
  if (!rl.ok) {
    writeDB(db);
    return res.status(429).json({ ok: false, message: "Too many requests. Try again later.", retryAfterSec: rl.retryAfterSec || 60 });
  }

  // Normalize DB
  db.licenses = Array.isArray(db.licenses) ? db.licenses : [];

  // Device-lock: Only one ACTIVE license per devHash+version
  let licByDev = db.licenses.find((x) =>
    trim(x.devHash) === pv.devHash &&
    trim(x.tokenVersion || "SPNG1").toUpperCase() === any.version.toUpperCase() &&
    trim(x.status).toUpperCase() !== "REVOKED"
  ) || null;

  // Token-specific record (if exists)
  let licByToken = db.licenses.find((x) => trim(x.token) === pv.token) || null;

  // If token record is revoked, reject
  if (licByToken && trim(licByToken.status).toUpperCase() === "REVOKED") {
    writeDB(db);
    return res.status(403).json({ ok: false, message: "Token revoked" });
  }

  // If there is already an ACTIVE license for this device, NEVER reset/extend by re-install / re-token.
  if (licByDev) {
    // bind device id once
    if (!trim(licByDev.boundDeviceId)) licByDev.boundDeviceId = androidId;
    if (trim(licByDev.boundDeviceId) && trim(licByDev.boundDeviceId) !== androidId) {
      // If someone tries to reuse same devHash with different androidId (rare), block for safety.
      licByDev.status = "ACTIVE";
      licByDev.lastSeenAt = now();
      writeDB(db);
      return res.status(409).json({ ok: false, message: "License already active for this device", boundDeviceId: licByDev.boundDeviceId });
    }

    // keep original expiry (anti-cheat)
    const storedYmd = String(licByDev.expiryYmd || "");
    const daysLeft = daysLeftFromYmd(storedYmd);
    licByDev.lastSeenAt = now();
    licByDev.lastTokenSeen = pv.token;
    if (any.version === "SPNG2") licByDev.fpHash = fpHash || licByDev.fpHash || "";
    if (!licByDev.activatedAt) licByDev.activatedAt = now();
    writeDB(db);

    if (daysLeft <= 0) {
      return res.status(403).json({
        ok: false,
        message: "Token expired",
        plan: licByDev.plan || pv.plan,
        expiryYmd: parseInt(storedYmd, 10) || 0,
        daysLeft: 0
      });
    }

    return res.json({
      ok: true,
      message: "OK",
      plan: licByDev.plan || pv.plan,
      expiryYmd: parseInt(storedYmd, 10) || 0,
      daysLeft,
      token: licByDev.token || pv.token // server-side canonical token for this device
    });
  }

  // No device license yet → create first activation record, expiry starts NOW (prevents losing days before install)
  const licenseId = `LIC-${Math.random().toString(16).slice(2, 10).toUpperCase()}`;
  const expYmd = addDaysYmd(planDays(pv.plan));
  const rec = {
    licenseId,
    token: pv.token,
    tokenVersion: any.version,
    plan: pv.plan,
    status: "ACTIVE",
    createdAt: now(),
    expiresAt: 0,
    expiryYmd: expYmd,
    devHash: pv.devHash,
    fpHash: any.version === "SPNG2" ? fpHash : "",
    boundDeviceId: androidId,
    boundShopId: "",
    activatedAt: now(),
    lastSeenAt: now(),
    notes: "HARDENED: ACTIVATION STARTS ON FIRST CHECK"
  };
  db.licenses.unshift(rec);
  writeDB(db);

  const daysLeft = daysLeftFromYmd(expYmd);
  return res.json({
    ok: true,
    message: "OK",
    plan: pv.plan,
    expiryYmd: parseInt(expYmd, 10) || 0,
    daysLeft,
    token: pv.token
  });
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
