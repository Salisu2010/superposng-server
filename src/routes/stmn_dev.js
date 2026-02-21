import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { trim as _trim, genStmn1Token, parseAndVerifyStmn1, devhash16 } from "../stmn1.js";
import { genStmn2Token, parseAndVerifyStmn2, devhash16Stmn2 } from "../stmn2.js";

const r = Router();

function trim(v) { return _trim(v); }
function now() { return Date.now(); }

function requireDevKey(req, res, next) {
  const expected = trim(process.env.DEV_KEY);
  if (!expected) return res.status(500).json({ ok: false, error: "DEV_KEY not configured on server" });
  const got = trim(req.header("X-DEV-KEY")) || trim((req.header("Authorization") || "").replace(/^Bearer\s+/i, ""));
  if (got && got === expected) return next();
  return res.status(403).json({ ok: false, error: "Forbidden" });
}

// POST /api/stmn/dev/generate-token
// body: { plan, deviceId, fpHash? }
r.post("/generate-token", requireDevKey, (req, res) => {
  const db = readDB();
  db.stmnLicenses = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const deviceId = trim(req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  let token = "";
  let tokenVersion = "STMN1";
  try {
    if (fpHash) {
      tokenVersion = "STMN2";
      token = genStmn2Token(plan, deviceId, fpHash);
    } else {
      token = genStmn1Token(plan, deviceId);
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  const parsed = tokenVersion === "STMN2" ? parseAndVerifyStmn2(token) : parseAndVerifyStmn1(token);

  const createdAt = now();
  const licenseId = `STMN-LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  const lic = {
    licenseId,
    token,
    tokenVersion,
    plan,
    status: "ISSUED",
    createdAt,
    expiresAt: parsed.ok ? parsed.expiresAt : 0,
    expiryYmd: parsed.ok ? parsed.expiryYmd : "",
    devHash: parsed.ok ? parsed.devHash : "",
    fpHash: fpHash || "",
    boundDeviceId: "",
    activatedAt: 0,
    lastSeenAt: 0,
    notes: ""
  };

  db.stmnLicenses.unshift(lic);
  writeDB(db);
  return res.json({ ok: true, license: lic, serverTime: createdAt });
});

// POST /api/stmn/dev/activate-device
// body: { token, androidId, fpHash? }
r.post("/activate-device", requireDevKey, (req, res) => {
  const db = readDB();
  db.stmnLicenses = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];

  const tokenRaw = trim(req.body?.token);
  const androidId = trim(req.body?.androidId || req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash);

  if (!tokenRaw) return res.status(400).json({ ok: false, error: "token required" });
  if (!androidId) return res.status(400).json({ ok: false, error: "androidId required" });

  const prefix = (tokenRaw.split("|")[0] || "").toUpperCase();
  const is2 = prefix === "STMN2";

  const parsed = is2 ? parseAndVerifyStmn2(tokenRaw) : parseAndVerifyStmn1(tokenRaw);
  if (!parsed.ok) return res.status(400).json({ ok: false, error: parsed.error || "Token invalid" });

  let want = "";
  try {
    if (is2) {
      if (!fpHash) return res.status(400).json({ ok: false, error: "fpHash required for STMN2" });
      want = devhash16Stmn2(androidId, fpHash);
    } else {
      want = devhash16(androidId);
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: "Bad device info" });
  }

  if (want !== parsed.devHash) return res.status(400).json({ ok: false, error: "Token not for this device" });

  // Find existing license by token or devHash
  let lic = db.stmnLicenses.find(x => trim(x.token) === parsed.token) || null;
  if (!lic) {
    lic = db.stmnLicenses.find(x => trim(x.devHash) === parsed.devHash && String(x.status || "").toUpperCase() !== "REVOKED") || null;
  }

  const t = now();
  if (lic) {
    if (String(lic.status || "").toUpperCase() === "REVOKED") {
      writeDB(db);
      return res.status(403).json({ ok: false, error: "Token revoked" });
    }

    if (trim(lic.boundDeviceId) && trim(lic.boundDeviceId) !== androidId) {
      lic.lastSeenAt = t;
      writeDB(db);
      return res.status(409).json({ ok: false, error: "License already bound", boundDeviceId: lic.boundDeviceId });
    }

    lic.status = "ACTIVE";
    lic.boundDeviceId = androidId;
    lic.lastSeenAt = t;
    if (is2) lic.fpHash = fpHash || lic.fpHash || "";
    if (!lic.activatedAt) lic.activatedAt = t;
    if (!lic.plan) lic.plan = parsed.plan;
    if (!lic.expiryYmd) lic.expiryYmd = parsed.expiryYmd;
    writeDB(db);
    return res.json({ ok: true, license: lic, plan: lic.plan, expiryYmd: parseInt(String(lic.expiryYmd || "0"), 10) || 0 });
  }

  // Create record if token was not generated in portal
  const licenseId = `STMN-LIC-ACT-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const rec = {
    licenseId,
    token: parsed.token,
    tokenVersion: is2 ? "STMN2" : "STMN1",
    plan: parsed.plan,
    status: "ACTIVE",
    createdAt: t,
    expiresAt: parsed.expiresAt || 0,
    expiryYmd: parsed.expiryYmd,
    devHash: parsed.devHash,
    fpHash: is2 ? fpHash : "",
    boundDeviceId: androidId,
    activatedAt: t,
    lastSeenAt: t,
    notes: "ACTIVATED VIA DEV PORTAL"
  };
  db.stmnLicenses.unshift(rec);
  writeDB(db);
  return res.json({ ok: true, license: rec, plan: rec.plan, expiryYmd: parseInt(String(rec.expiryYmd || "0"), 10) || 0 });
});

export default r;
