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

function tokenPrefix(t) {
  const x = trim(t).toUpperCase();
  return x.split("|")[0] || "";
}
function parseAnyToken(tokenRaw) {
  const pref = tokenPrefix(tokenRaw);
  if (pref === "SPNG2") return { version: "SPNG2", parsed: parseAndVerifySpng2(tokenRaw) };
  return { version: "SPNG1", parsed: parseAndVerifySpng1(tokenRaw) };
}


function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return _trim(v);
}

// ------------------------------------------------------------
// Android Online Activation Check (SPNG1)
// POST /api/license/check
// body: { token, androidId }
// Returns keys Android typically expects: ok, message, plan, expiryYmd, daysLeft
// Also auto-registers a valid token into DB so revoke/extend works reliably.
// ------------------------------------------------------------
// ----------------------------------------------------------
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

  // Look up in DB (for revoke/extend)
  const lic = Array.isArray(db.licenses)
    ? db.licenses.find((x) => trim(x.token) === pv.token)
    : null;

  if (lic && trim(lic.status).toUpperCase() === "REVOKED") {
    return res.status(403).json({ ok: false, message: "Token revoked" });
  }

  // If token exists in DB and was extended, return updated expiry if valid for this device
  const expiresAt = lic && lic.expiresAt ? Number(lic.expiresAt) : pv.expiresAt;
  const expiryYmd = lic && lic.expiryYmd ? String(lic.expiryYmd) : pv.expiryYmd;

  return res.json({
    ok: true,
    plan: pv.plan,
    expiryYmd,
    expiresAt,
    tokenVersion: any.version,
    serverTime: now()
  });
});

