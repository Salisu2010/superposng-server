import { Router } from "express";
import { readDB, writeDB } from "../db.js";
import { trim as _trim, parseAndVerifyStmn1, devhash16, daysLeftFromYmd } from "../stmn1.js";
import { parseAndVerifyStmn2, devhash16Stmn2 } from "../stmn2.js";

const r = Router();

function trim(v) { return _trim(v); }
function now() { return Date.now(); }

function tokenPrefix(t) {
  const x = trim(t).toUpperCase();
  return (x.split("|")[0] || "").toUpperCase();
}

function parseAnyToken(tokenRaw) {
  const pref = tokenPrefix(tokenRaw);
  if (pref === "STMN2") return { version: "STMN2", parsed: parseAndVerifyStmn2(tokenRaw) };
  return { version: "STMN1", parsed: parseAndVerifyStmn1(tokenRaw) };
}

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
  const key = `STMN:${dh}`;
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

// POST /api/stmn/license/check
// body: { token, androidId, fpHash? }
r.post("/check", (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash);

  if (!token) return res.status(400).json({ ok: false, message: "token required" });
  if (!androidId) return res.status(400).json({ ok: false, message: "androidId required" });

  const any = parseAnyToken(token);
  const pv = any.parsed;
  if (!pv.ok) return res.status(400).json({ ok: false, message: pv.error || "Token not valid" });

  // Ensure token belongs to this device
  let want = "";
  try {
    if (any.version === "STMN2") {
      if (!fpHash) return res.status(400).json({ ok: false, message: "fpHash required for STMN2" });
      want = devhash16Stmn2(androidId, fpHash);
    } else {
      want = devhash16(androidId);
    }
  } catch (e) {
    return res.status(400).json({ ok: false, message: "Bad device info" });
  }

  if (want !== pv.devHash) {
    return res.status(400).json({ ok: false, message: "Token not for this device" });
  }

  // Security controls
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

  db.stmnLicenses = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];

  // Find by token (if generated from portal)
  let licByToken = db.stmnLicenses.find(x => trim(x.token) === pv.token) || null;
  if (licByToken && String(licByToken.status || "").toUpperCase() === "REVOKED") {
    writeDB(db);
    return res.status(403).json({ ok: false, message: "Token revoked" });
  }

  // Find active record bound to this device hash
  let licByDev = db.stmnLicenses.find((x) =>
    trim(x.devHash) === pv.devHash &&
    String(x.tokenVersion || "STMN1").toUpperCase() === any.version.toUpperCase() &&
    String(x.status || "").toUpperCase() !== "REVOKED"
  ) || null;

  const stored = licByDev || licByToken;

  if (stored) {
    if (!trim(stored.boundDeviceId)) stored.boundDeviceId = androidId;
    if (trim(stored.boundDeviceId) && trim(stored.boundDeviceId) !== androidId) {
      stored.lastSeenAt = now();
      writeDB(db);
      return res.status(409).json({ ok: false, message: "License already active for this device", boundDeviceId: stored.boundDeviceId });
    }

    stored.status = "ACTIVE";
    stored.lastSeenAt = now();
    stored.lastTokenSeen = pv.token;
    if (any.version === "STMN2") stored.fpHash = fpHash || stored.fpHash || "";
    if (!stored.activatedAt) stored.activatedAt = now();

    const expYmd = String(stored.expiryYmd || pv.expiryYmd || "");
    const daysLeft = daysLeftFromYmd(expYmd);
    writeDB(db);

    if (daysLeft <= 0) {
      return res.status(403).json({ ok: false, message: "Token expired", plan: stored.plan || pv.plan, expiryYmd: parseInt(expYmd || "0", 10) || 0, daysLeft: 0 });
    }

    return res.json({ ok: true, message: "OK", plan: stored.plan || pv.plan, expiryYmd: parseInt(expYmd, 10) || 0, daysLeft, token: pv.token });
  }

  // Auto-register a valid token even if not issued from portal (optional)
  const createdAt = now();
  const rec = {
    licenseId: `STMN-LIC-AUTO-${Math.random().toString(16).slice(2, 10).toUpperCase()}`,
    token: pv.token,
    tokenVersion: any.version,
    plan: pv.plan,
    status: "ACTIVE",
    createdAt,
    expiresAt: pv.expiresAt || 0,
    expiryYmd: pv.expiryYmd,
    devHash: pv.devHash,
    fpHash: any.version === "STMN2" ? fpHash : "",
    boundDeviceId: androidId,
    activatedAt: createdAt,
    lastSeenAt: createdAt,
    notes: "AUTO-REGISTERED ON FIRST VALID CHECK"
  };

  db.stmnLicenses.unshift(rec);
  writeDB(db);

  const daysLeft = daysLeftFromYmd(pv.expiryYmd);
  if (daysLeft <= 0) {
    return res.status(403).json({ ok: false, message: "Token expired", plan: pv.plan, expiryYmd: parseInt(pv.expiryYmd, 10) || 0, daysLeft: 0 });
  }

  return res.json({ ok: true, message: "OK", plan: pv.plan, expiryYmd: parseInt(pv.expiryYmd, 10) || 0, daysLeft, token: pv.token });
});


// POST /api/stmn/license/auto-activate
// body: { app:"STMN", androidId, fpHash?, installId? }
// Returns assigned token for this device if already activated via dev portal.
r.post("/auto-activate", (req, res) => {
  const db = readDB();
  db.stmnLicenses = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];

  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash);
  if (!androidId) return res.status(400).json({ ok: false, assigned: false, message: "androidId required" });

  // Find ACTIVE, bound licenses for this androidId
  const active = db.stmnLicenses.filter(x =>
    trim(x.boundDeviceId) === androidId &&
    String(x.status || "").toUpperCase() === "ACTIVE" &&
    String(x.token || "").trim().length > 0
  );

  if (!active.length) {
    return res.json({ ok: true, assigned: false });
  }

  // Prefer most recently seen/activated
  active.sort((a,b) => (Number(b.lastSeenAt||b.activatedAt||0) - Number(a.lastSeenAt||a.activatedAt||0)));

  // If the top is STMN2, ensure fpHash matches (if stored fpHash exists)
  let lic = active[0];
  if (String(lic.tokenVersion || "STMN1").toUpperCase() === "STMN2") {
    if (!fpHash) return res.status(400).json({ ok: false, assigned: false, message: "fpHash required" });
    const storedFp = trim(lic.fpHash);
    if (storedFp && storedFp !== fpHash) {
      return res.status(403).json({ ok: false, assigned: false, message: "Device mismatch" });
    }
    // update stored fpHash if missing
    if (!storedFp) lic.fpHash = fpHash;
  }

  // Expiry check
  const expYmd = String(lic.expiryYmd || "");
  const daysLeft = daysLeftFromYmd(expYmd);
  lic.lastSeenAt = now();
  writeDB(db);

  if (daysLeft <= 0) {
    return res.status(403).json({
      ok: false,
      assigned: true,
      message: "Token expired",
      token: trim(lic.token),
      plan: String(lic.plan || "").toUpperCase() || "MONTHLY",
      expiryYmd: parseInt(expYmd || "0", 10) || 0,
      daysLeft: 0
    });
  }

  return res.json({
    ok: true,
    assigned: true,
    token: trim(lic.token),
    plan: String(lic.plan || "").toUpperCase() || "MONTHLY",
    expiryYmd: parseInt(expYmd || "0", 10) || 0,
    daysLeft
  });
});

// GET /api/stmn/license/assigned?androidId=...&fpHash=...
// legacy fallback for older app versions
r.get("/assigned", (req, res) => {
  const db = readDB();
  db.stmnLicenses = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];

  const androidId = trim(req.query?.androidId || req.query?.deviceId);
  const fpHash = trim(req.query?.fpHash);
  if (!androidId) return res.status(400).json({ ok: false, assigned: false, message: "androidId required" });

  const active = db.stmnLicenses.filter(x =>
    trim(x.boundDeviceId) === androidId &&
    String(x.status || "").toUpperCase() === "ACTIVE" &&
    String(x.token || "").trim().length > 0
  );

  if (!active.length) return res.json({ ok: true, assigned: false });

  active.sort((a,b) => (Number(b.lastSeenAt||b.activatedAt||0) - Number(a.lastSeenAt||a.activatedAt||0)));
  let lic = active[0];

  if (String(lic.tokenVersion || "STMN1").toUpperCase() === "STMN2") {
    if (!fpHash) return res.status(400).json({ ok: false, assigned: false, message: "fpHash required" });
    const storedFp = trim(lic.fpHash);
    if (storedFp && storedFp !== fpHash) return res.status(403).json({ ok:false, assigned:false, message:"Device mismatch" });
    if (!storedFp) lic.fpHash = fpHash;
  }

  const expYmd = String(lic.expiryYmd || "");
  const daysLeft = daysLeftFromYmd(expYmd);
  lic.lastSeenAt = now();
  writeDB(db);

  if (daysLeft <= 0) {
    return res.status(403).json({ ok:false, assigned:true, message:"Token expired", token:trim(lic.token), plan:String(lic.plan||"").toUpperCase()||"MONTHLY", expiryYmd: parseInt(expYmd||"0",10)||0, daysLeft:0 });
  }

  return res.json({ ok:true, assigned:true, token: trim(lic.token), plan:String(lic.plan||"").toUpperCase()||"MONTHLY", expiryYmd: parseInt(expYmd||"0",10)||0, daysLeft });
});

export default r;
