import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return s(v).trim();
}
function now() {
  return Date.now();
}
function requireDevKey(req, res, next) {
  const expected = trim(process.env.DEV_KEY);
  if (!expected) {
    return res.status(500).json({ ok: false, error: "DEV_KEY not configured on server" });
  }
  const got = trim(req.header("X-DEV-KEY")) || trim((req.header("Authorization") || "").replace(/^Bearer\s+/i, ""));
  if (got && got === expected) return next();
  return res.status(403).json({ ok: false, error: "Forbidden" });
}

function genToken(prefix = "SPNG") {
  // Human-friendly: SPNG-XXXX-XXXX
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${prefix}-${part()}-${part()}`;
}

function normalizeToken(v) {
  // Be forgiving: trim + remove whitespace, keep original separators like '-' or '|'.
  return trim(v).replace(/\s+/g, "");
}

function planToDays(plan) {
  const p = trim(plan).toUpperCase();
  if (p === "YEARLY") return 365;
  if (p === "QUARTERLY") return 90;
  if (p === "WEEKLY") return 7;
  return 30; // MONTHLY default
}

function findLicenseByAny(db, { licenseId, token, deviceId, shopId }) {
  const lid = trim(licenseId);
  const tok = normalizeToken(token);
  const did = trim(deviceId);
  const sid = trim(shopId);

  if (lid) {
    const byId = db.licenses.find((x) => trim(x.licenseId) === lid);
    if (byId) return byId;
  }
  if (tok) {
    const byTok = db.licenses.find((x) => normalizeToken(x.token) === tok);
    if (byTok) return byTok;
  }
  if (did) {
    const byDev = db.licenses
      .filter((x) => trim(x.status) !== "REVOKED")
      .find((x) => trim(x.boundDeviceId) === did);
    if (byDev) return byDev;
  }
  if (sid) {
    const byShop = db.licenses
      .filter((x) => trim(x.status) !== "REVOKED")
      .find((x) => trim(x.boundShopId) === sid);
    if (byShop) return byShop;
  }
  return null;
}

// -------------------------
// DEV: Generate token
// -------------------------
r.post("/generate-token", requireDevKey, (req, res) => {
  const db = readDB();

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const days = Math.max(1, parseInt(req.body?.days || planToDays(plan), 10));
  const prefix = trim(req.body?.prefix || "SPNG").toUpperCase();

  let token = genToken(prefix);
  // Ensure uniqueness in db
  for (let i = 0; i < 5; i++) {
    if (!db.licenses.some((x) => trim(x.token) === token)) break;
    token = genToken(prefix);
  }

  const createdAt = now();
  const expiresAt = createdAt + days * 24 * 60 * 60 * 1000;
  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  const lic = {
    licenseId,
    token,
    plan,
    days,
    status: "ISSUED",
    createdAt,
    expiresAt,
    boundDeviceId: "",
    boundShopId: "",
    activatedAt: 0,
    notes: ""
  };

  db.licenses.unshift(lic);
  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: createdAt });
});

// -------------------------
// DEV: Register/Import a token created elsewhere (e.g. Python)
// Allows your existing workflow while keeping the portal usable.
// -------------------------
r.post("/register-token", requireDevKey, (req, res) => {
  const db = readDB();

  const tokenRaw = req.body?.token;
  const token = normalizeToken(tokenRaw);
  if (!token) return res.status(400).json({ ok: false, error: "token required" });

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const days = Math.max(1, parseInt(req.body?.days || planToDays(plan), 10));
  const note = trim(req.body?.notes || "");

  const createdAt = now();
  // If caller supplies expiresAt, respect it; otherwise compute from days.
  const expiresAtIn = parseInt(req.body?.expiresAt || "0", 10);
  const expiresAt = (Number.isFinite(expiresAtIn) && expiresAtIn > 0)
    ? expiresAtIn
    : (createdAt + days * 24 * 60 * 60 * 1000);

  let lic = findLicenseByAny(db, { token });
  if (!lic) {
    const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    lic = {
      licenseId,
      token,
      plan,
      days,
      status: "ISSUED",
      createdAt,
      expiresAt,
      boundDeviceId: "",
      boundShopId: "",
      activatedAt: 0,
      notes: note || "IMPORTED"
    };
    db.licenses.unshift(lic);
  } else {
    // Upsert/update basic fields without breaking existing bindings.
    lic.plan = plan || lic.plan;
    lic.days = days || lic.days;
    lic.expiresAt = expiresAt || lic.expiresAt;
    if (note) lic.notes = note;
  }

  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: createdAt });
});

// -------------------------
// DEV: Assign token to device (for claim)
// -------------------------
r.post("/assign-token", requireDevKey, (req, res) => {
  const db = readDB();
  const deviceId = trim(req.body?.deviceId);
  const token = normalizeToken(req.body?.token);
  const shopId = trim(req.body?.shopId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  if (!token) return res.status(400).json({ ok: false, error: "token required" });

  const lic = findLicenseByAny(db, { token });
  if (!lic) return res.status(404).json({ ok: false, error: "token not found" });
  if (trim(lic.status) === "REVOKED") return res.status(400).json({ ok: false, error: "token revoked" });

  // If already bound to another device, block (unless reset first)
  if (trim(lic.boundDeviceId) && trim(lic.boundDeviceId) !== deviceId) {
    return res.status(409).json({ ok: false, error: "token already bound to another device", boundDeviceId: lic.boundDeviceId });
  }

  // Create/replace pending activation for this deviceId
  const rec = {
    deviceId,
    token: lic.token,
    plan: lic.plan,
    expiresAt: lic.expiresAt,
    shopId: shopId || lic.boundShopId || "",
    assignedAt: now()
  };
  db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
  db.pendingActivations.unshift(rec);
  writeDB(db);

  res.json({ ok: true, pending: rec, serverTime: now() });
});

// -------------------------
// DEV: Search device / token / shop
// -------------------------
r.get("/search", requireDevKey, (req, res) => {
  const db = readDB();
  const deviceId = trim(req.query?.deviceId);
  const token = normalizeToken(req.query?.token);
  const shopId = trim(req.query?.shopId);

  const matches = [];
  for (const lic of db.licenses) {
    const hit =
      (token && normalizeToken(lic.token) === token) ||
      (deviceId && trim(lic.boundDeviceId) === deviceId) ||
      (shopId && trim(lic.boundShopId) === shopId);
    if (hit) matches.push(lic);
  }
  const pending = db.pendingActivations.filter((p) =>
    (deviceId && trim(p.deviceId) === deviceId) ||
    (token && normalizeToken(p.token) === token) ||
    (shopId && trim(p.shopId) === shopId)
  );

  res.json({ ok: true, matches, pending, serverTime: now() });
});

// -------------------------
// DEV: Revoke / Reset activation
// -------------------------
r.post("/revoke", requireDevKey, (req, res) => {
  const db = readDB();
  const licenseId = trim(req.body?.licenseId);
  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);
  const reason = trim(req.body?.reason || "");
  const resetOnly = !!req.body?.resetOnly;

  const lic = findLicenseByAny(db, { licenseId, token, deviceId });
  if (!lic) return res.status(404).json({ ok: false, error: "license not found" });

  // Remove pending activation for that device (if any)
  if (deviceId) {
    db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
  }

  if (resetOnly) {
    lic.boundDeviceId = "";
    lic.boundShopId = "";
    lic.activatedAt = 0;
    lic.status = "ISSUED";
    lic.notes = reason ? `RESET: ${reason}` : "RESET";
  } else {
    lic.status = "REVOKED";
    lic.notes = reason ? `REVOKED: ${reason}` : "REVOKED";
  }

  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: now() });
});

// -------------------------
// DEV: Extend expiry / Upgrade plan
// -------------------------
r.post("/extend", requireDevKey, (req, res) => {
  const db = readDB();
  const licenseId = trim(req.body?.licenseId);
  const token = trim(req.body?.token);
  const deviceId = trim(req.body?.deviceId);

  const addDays = parseInt(req.body?.addDays || "0", 10);
  const newPlan = trim(req.body?.plan || "").toUpperCase();
  const setDays = parseInt(req.body?.days || "0", 10);

  const lic = findLicenseByAny(db, { licenseId, token, deviceId });
  if (!lic) return res.status(404).json({ ok: false, error: "license not found" });
  if (trim(lic.status) === "REVOKED") return res.status(400).json({ ok: false, error: "license revoked" });

  if (newPlan) {
    lic.plan = newPlan;
    if (setDays > 0) lic.days = setDays;
    else lic.days = planToDays(newPlan);
  }

  const base = Math.max(parseInt(lic.expiresAt || 0, 10), now());
  let deltaDays = 0;
  if (addDays && Number.isFinite(addDays) && addDays > 0) deltaDays = addDays;
  // If upgrading plan but no addDays provided, extend to full plan length from now.
  if (newPlan && deltaDays === 0) deltaDays = planToDays(lic.plan);

  lic.expiresAt = base + deltaDays * 24 * 60 * 60 * 1000;
  lic.status = trim(lic.status) === "ISSUED" ? "ISSUED" : "ACTIVE";

  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: now() });
});

export default r;
