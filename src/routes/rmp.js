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

  if (rec.blockedUntil && t < rec.blockedUntil) {
    sec.rate[key] = rec;
    return { ok: false, retryAfterSec: Math.ceil((rec.blockedUntil - t) / 1000) };
  }

  const WIN_MS = 5 * 60 * 1000;
  const MAX = 25;
  const BLOCK_MS = 10 * 60 * 1000;

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

  // Security: blacklist + rate limit
  const sec = ensureSecurity(db);
  const bl = isBlacklisted(sec, pv.devHash);
  if (bl) {
    writeDB(db);
    return res.status(403).json({ ok: false, message: "Device blocked", reason: String(bl.reason || "blocked") });
  }
  const rl = applyRateLimit(sec, pv.devHash);
  if (!rl.ok) {
    writeDB(db);
    return res.status(429).json({ ok: false, message: "Too many requests. Try again later.", retryAfterSec: rl.retryAfterSec || 60 });
  }

  // Normalize DB
  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];

  // Device-lock: Only one ACTIVE license per devHash
  let licByDev = db.rmpLicenses.find((x) =>
    trim(x.devHash) === pv.devHash &&
    trim(x.status).toUpperCase() !== "REVOKED"
  ) || null;

  // Token record (if exists)
  let licByToken = db.rmpLicenses.find((x) => trim(x.token) === pv.token) || null;
  if (licByToken && trim(licByToken.status).toUpperCase() === "REVOKED") {
    writeDB(db);
    return res.status(403).json({ ok: false, message: "Token revoked" });
  }

  // If license already exists for this device, NEVER reset expiry by reinstall/re-token.
  if (licByDev) {
    if (!trim(licByDev.boundDeviceId)) licByDev.boundDeviceId = androidId;
    if (trim(licByDev.boundDeviceId) && trim(licByDev.boundDeviceId) !== androidId) {
      licByDev.lastSeenAt = now();
      writeDB(db);
      return res.status(409).json({ ok: false, message: "License already active for this device", boundDeviceId: licByDev.boundDeviceId });
    }

    const storedYmd = String(licByDev.expiryYmd || "");
    const daysLeft = daysLeftFromYmd(storedYmd);

    licByDev.lastSeenAt = now();
    licByDev.lastTokenSeen = pv.token;
    if (!licByDev.activatedAt) licByDev.activatedAt = now();
    licByDev.status = "ACTIVE";
    writeDB(db);

    if (daysLeft <= 0) {
      return res.status(403).json({ ok: false, message: "Token expired", plan: licByDev.plan || pv.plan, expiryYmd: storedYmd, daysLeft: 0 });
    }

    return res.json({ ok: true, message: "OK", plan: licByDev.plan || pv.plan, expiryYmd: storedYmd, daysLeft, token: licByDev.token || pv.token });
  }

  // No device license yet → create first activation record, expiry starts NOW
  const licenseId = `RMP-LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const expYmd = addDaysYmd(planDays(pv.plan));
  db.rmpLicenses.unshift({
    licenseId,
    token: pv.token,
    tokenVersion: "RMP1",
    plan: pv.plan,
    status: "ACTIVE",
    createdAt: now(),
    expiresAt: 0,
    expiryYmd: expYmd,
    devHash: pv.devHash,
    boundDeviceId: androidId,
    activatedAt: now(),
    lastSeenAt: now(),
    notes: "HARDENED: ACTIVATION STARTS ON FIRST CHECK"
  });
  writeDB(db);

  const daysLeft = daysLeftFromYmd(expYmd);
  return res.json({ ok: true, message: "OK", plan: pv.plan, expiryYmd: expYmd, daysLeft, token: pv.token });
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
  const requestedDevHash = trim(req.body?.devHash || req.body?.devHash16);
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  // Compute the expected DEVHASH from androidId, but also accept a DEVHASH sent by the app.
  // This makes online activation robust even if different devices/reporting formats exist.
  let dh = "";
  try {
    if (requestedDevHash && /^[0-9a-fA-F]{16}$/.test(requestedDevHash)) {
      dh = trim(requestedDevHash).toLowerCase();
    } else {
      dh = normalizeDevhash(androidId);
    }
  } catch (e) {
    /* ignore */
  }
  if (!dh) return res.status(400).json({ ok: false, message: "androidId required" });

  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  const candidates = db.rmpLicenses
    .filter((x) => {
      const st = trim(x.status).toUpperCase();
      if (st === "REVOKED") return false;
      const byHash = trim(x.devHash).toLowerCase() === dh;
      const byBind = trim(x.boundDeviceId) === androidId;
      return byHash || byBind;
    })
    .sort((a, b) => Number(b.expiresAt || 0) - Number(a.expiresAt || 0));

  const lic = candidates.length ? candidates[0] : null;
  if (!lic) return res.status(404).json({ ok: false, message: "No active license found" });

  // Ensure the stored token matches the requested/current device hash.
  // If not, re-issue a new token with the SAME plan + expiry but bound to this device hash.
  let pv = parseAndVerifyRmp1(lic.token);
  if (!pv.ok) return res.status(400).json({ ok: false, message: "Stored token invalid" });
  if (trim(pv.devHash).toLowerCase() !== dh) {
    try {
      const newToken = genRmp1Token(pv.plan, dh, pv.expiryYmd);
      const pv2 = parseAndVerifyRmp1(newToken);
      if (pv2.ok) {
        lic.token = pv2.token;
        lic.devHash = dh;
        pv = pv2;
      }
    } catch (e) {
      // keep old token if regeneration fails
    }
  }

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


// ------------------------------------------------------------
// DEV: List RMP tokens/licenses (for portal table)
// GET /api/rmp/dev/licenses?q=&status=&plan=&limit=&offset=
// ------------------------------------------------------------
r.get("/dev/licenses", requireDevKey, (req, res) => {
  const db = readDB();
  db.rmpLicenses = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];

  const q = trim(req.query?.q).toLowerCase();
  const status = trim(req.query?.status).toUpperCase();
  const plan = trim(req.query?.plan).toUpperCase();
  const limit = Math.max(1, Math.min(200, Number(req.query?.limit || 25)));
  const offset = Math.max(0, Number(req.query?.offset || 0));

  let items = db.rmpLicenses.slice();

  if (status) items = items.filter((x) => trim(x.status).toUpperCase() === status);
  if (plan) items = items.filter((x) => trim(x.plan).toUpperCase() === plan);

  if (q) {
    items = items.filter((x) => {
      const s = [
        x.licenseId,
        x.token,
        x.status,
        x.plan,
        x.boundDeviceId,
        x.devHash,
        x.notes
      ].map(v => String(v || "").toLowerCase()).join(" | ");
      return s.includes(q);
    });
  }

  // sort newest first
  items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return res.json({ ok: true, total, limit, offset, items: page });
});


// ------------------------------------------------------------
// BLACKLIST / DEVICE BLOCK (DEV KEY)
// POST /api/rmp/dev/blacklist/add    { devHash, reason?, days? }
// POST /api/rmp/dev/blacklist/remove { devHash }
// GET  /api/rmp/dev/blacklist/list
// ------------------------------------------------------------
r.post("/dev/blacklist/add", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  const devHash = trim(req.body?.devHash).toUpperCase();
  const reason = trim(req.body?.reason) || "blocked";
  const days = Number(req.body?.days || 0);
  if (!devHash) return res.status(400).json({ ok: false, error: "devHash required" });

  const until = days > 0 ? (now() + Math.floor(days * 86400000)) : 0;
  const existing = sec.blacklist.find(x => trim(x.devHash).toUpperCase() === devHash) || null;
  if (existing) {
    existing.reason = reason;
    existing.until = until;
    existing.updatedAt = now();
  } else {
    sec.blacklist.unshift({ devHash, reason, until, createdAt: now(), updatedAt: now() });
  }
  writeDB(db);
  return res.json({ ok: true, devHash, reason, until });
});

r.post("/dev/blacklist/remove", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  const devHash = trim(req.body?.devHash).toUpperCase();
  if (!devHash) return res.status(400).json({ ok: false, error: "devHash required" });
  sec.blacklist = sec.blacklist.filter(x => trim(x.devHash).toUpperCase() !== devHash);
  writeDB(db);
  return res.json({ ok: true, devHash });
});

r.get("/dev/blacklist/list", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  return res.json({ ok: true, blacklist: sec.blacklist });
});

export default r;
