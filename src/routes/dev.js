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

function ymd(ts) {
  const d = new Date(ts);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${day}`;
}

function genPipeToken(plan = "MONTHLY", expiresAtTs, ver = "SPNG1", extraParts = []) {
  const p = trim(plan).toUpperCase() || "MONTHLY";
  const exp = ymd(expiresAtTs);
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  const extras = Array.isArray(extraParts) ? extraParts.map((x) => trim(x)).filter((x) => x) : [];
  return [ver, p, exp, rand, ...extras].join("|");
}

function parsePipeToken(token) {
  const t = trim(token);
  if (!t.includes("|")) return null;
  const parts = t.split("|").map((x) => trim(x));
  if (parts.length < 4) return null;
  const plan = (parts[1] || "").toUpperCase();
  const ymdStr = parts[2] || "";
  if (!/^\d{8}$/.test(ymdStr)) return null;
  const y = parseInt(ymdStr.slice(0, 4), 10);
  const m = parseInt(ymdStr.slice(4, 6), 10);
  const d = parseInt(ymdStr.slice(6, 8), 10);
  const expiresAt = Date.UTC(y, m - 1, d, 23, 59, 59, 0);
  // Optional extended tokens may embed hints after the RAND segment:
  //   SPNG1|PLAN|YYYYMMDD|RAND|DEVICE_ID|SHOP_ID
  // We treat these as hints only (backward compatible).
  const deviceIdHint = parts.length >= 5 ? parts[4] : "";
  const shopIdHint = parts.length >= 6 ? parts[5] : "";
  return { plan, expiresAt, deviceIdHint, shopIdHint };
}

function planToDays(plan) {
  const p = trim(plan).toUpperCase();
  if (p === "YEARLY") return 365;
  if (p === "QUARTERLY") return 90;
  if (p === "WEEKLY") return 7;
  if (p === "TRIAL") return 7;
  return 30; // MONTHLY default
}

function findLicenseByAny(db, { licenseId, token, deviceId, shopId }) {
  const lid = trim(licenseId);
  const tok = trim(token);
  const did = trim(deviceId);
  const sid = trim(shopId);

  if (lid) {
    const byId = db.licenses.find((x) => trim(x.licenseId) === lid);
    if (byId) return byId;
  }
  if (tok) {
    const byTok = db.licenses.find((x) => trim(x.token) === tok);
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
  const createdAt = now();
  const expiresAt = createdAt + days * 24 * 60 * 60 * 1000;
  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  // Standard token format:
  //   SPNG1|PLAN|YYYYMMDD|RAND
  // Optional extended format (compatible with your Python generator):
  //   SPNG1|PLAN|YYYYMMDD|RAND|DEVICE_ID|SHOP_ID
  const hintDeviceId = trim(req.body?.deviceId);
  const hintShopId = trim(req.body?.shopId);
  const extra = [];
  if (hintDeviceId) extra.push(hintDeviceId);
  if (hintShopId) extra.push(hintShopId);

  let token = genPipeToken(plan, expiresAt, "SPNG1", extra);
  for (let i = 0; i < 5; i++) {
    if (!db.licenses.some((x) => trim(x.token) === token)) break;
    token = genPipeToken(plan, expiresAt, "SPNG1", extra);
  }

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
// DEV: Register/import token (e.g. created externally via Python)
// Accepts pipe tokens like: SPNG1|MONTHLY|YYYYMMDD|XXXX
// -------------------------
r.post("/register-token", requireDevKey, (req, res) => {
  const db = readDB();
  const token = trim(req.body?.token);
  if (!token) return res.status(400).json({ ok: false, error: "token required" });

  const existing = db.licenses.find((x) => trim(x.token) === token);
  if (existing) return res.json({ ok: true, license: existing, already: true, serverTime: now() });

  const parsed = parsePipeToken(token);
  const createdAt = now();
  let plan = trim(req.body?.plan || (parsed?.plan || "MONTHLY")).toUpperCase();
  if (!plan) plan = "MONTHLY";
  const days = Math.max(1, parseInt(req.body?.days || planToDays(plan), 10));
  let expiresAt = parseInt(req.body?.expiresAt || "0", 10);
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    if (parsed?.expiresAt) expiresAt = parsed.expiresAt;
    else expiresAt = createdAt + days * 24 * 60 * 60 * 1000;
  }

  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const lic = {
    licenseId,
    token,
    plan,
    days,
    status: "ISSUED",
    createdAt,
    expiresAt,
    // If the externally generated token embeds device/shop after RAND
    // we treat them as hints only (won't overwrite later explicit binding).
    boundDeviceId: trim(req.body?.boundDeviceId || parsed?.deviceIdHint || ""),
    boundShopId: trim(req.body?.boundShopId || parsed?.shopIdHint || ""),
    activatedAt: 0,
    notes: "IMPORTED"
  };
  db.licenses.unshift(lic);
  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: createdAt });
});

// -------------------------
// DEV: List tokens/licenses (for portal table)
// -------------------------
r.get("/licenses", requireDevKey, (req, res) => {
  const db = readDB();
  const q = trim(req.query?.q).toUpperCase();
  const status = trim(req.query?.status).toUpperCase();
  const plan = trim(req.query?.plan).toUpperCase();
  const limit = Math.max(1, Math.min(500, parseInt(req.query?.limit || "100", 10)));
  const offset = Math.max(0, parseInt(req.query?.offset || "0", 10));

  let items = Array.isArray(db.licenses) ? db.licenses.slice() : [];
  // Backward compatibility: normalize missing fields
  items = items.map((x) => {
    const o = x || {};
    if (!trim(o.plan)) o.plan = "LEGACY";
    if (!trim(o.status)) o.status = "ISSUED";
    return o;
  });

  if (status) items = items.filter((x) => trim(x.status).toUpperCase() === status);
  if (plan) items = items.filter((x) => trim(x.plan).toUpperCase() === plan);
  if (q) {
    items = items.filter((x) => {
      const t = trim(x.token).toUpperCase();
      const id = trim(x.licenseId).toUpperCase();
      const did = trim(x.boundDeviceId).toUpperCase();
      const sid = trim(x.boundShopId).toUpperCase();
      return t.includes(q) || id.includes(q) || did.includes(q) || sid.includes(q);
    });
  }

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  res.json({ ok: true, total, offset, limit, items: page, serverTime: now() });
});

// -------------------------
// DEV: Assign token to device (for claim)
// -------------------------
r.post("/assign-token", requireDevKey, (req, res) => {
  const db = readDB();
  const deviceId = trim(req.body?.deviceId);
  const token = trim(req.body?.token);
  const shopId = trim(req.body?.shopId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });
  if (!token) return res.status(400).json({ ok: false, error: "token required" });

  // If token was created externally (e.g. Python) and not yet in DB, auto-import
  // when it's in pipe format: SPNG1|PLAN|YYYYMMDD|XXXX
  let lic = findLicenseByAny(db, { token });
  if (!lic) {
    const parsed = parsePipeToken(token);
    if (parsed) {
      const createdAt = now();
      const plan = (parsed.plan || "MONTHLY").toUpperCase();
      const days = planToDays(plan);
      const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
      lic = {
        licenseId,
        token,
        plan,
        days,
        status: "ISSUED",
        createdAt,
        expiresAt: parsed.expiresAt,
        boundDeviceId: trim(parsed.deviceIdHint || ""),
        boundShopId: trim(parsed.shopIdHint || ""),
        activatedAt: 0,
        notes: "AUTO-IMPORTED"
      };
      db.licenses.unshift(lic);
    } else {
      return res.status(404).json({ ok: false, error: "token not found" });
    }
  }
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
  const token = trim(req.query?.token);
  const shopId = trim(req.query?.shopId);

  const matches = [];
  for (const lic of db.licenses) {
    const hit =
      (token && trim(lic.token) === token) ||
      (deviceId && trim(lic.boundDeviceId) === deviceId) ||
      (shopId && trim(lic.boundShopId) === shopId);
    if (hit) matches.push(lic);
  }
  const pending = db.pendingActivations.filter((p) =>
    (deviceId && trim(p.deviceId) === deviceId) ||
    (token && trim(p.token) === token) ||
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
