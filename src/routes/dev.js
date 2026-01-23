import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import {
  trim as _trim,
  genSpng1Token,
  parseAndVerifySpng1,
  ymdToExpiresAtUtc,
  todayInLagos,
  addMonthsYmd,
  devhash16,
} from "../spng1.js";

const r = Router();

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}
function trim(v) {
  return _trim(v);
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

function parseTokenAny(token) {
  const sp = parseAndVerifySpng1(token);
  if (sp.ok) {
    return {
      kind: "SPNG1",
      plan: sp.plan,
      expiryYmd: sp.expiryYmd,
      expiresAt: sp.expiresAt,
      devHash: sp.devHash,
    };
  }
  const p = parsePipeToken(token);
  if (p) return { kind: "LEGACY", ...p };
  return null;
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
  const createdAt = now();
  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  // ✅ EXACT Offline Token (Python/Android compatible):
  //   SPNG1|PLAN|YYYYMMDD|DEVHASH16|SIG12
  const deviceId = trim(req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  let token = "";
  try {
    token = genSpng1Token(plan, deviceId);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  const parsed = parseAndVerifySpng1(token);
  const expiresAt = parsed.ok ? parsed.expiresAt : 0;
  const expiryYmd = parsed.ok ? parsed.expiryYmd : "";
  const devHash = parsed.ok ? parsed.devHash : "";

  const lic = {
    licenseId,
    token,
    plan,
    status: "ISSUED",
    createdAt,
    expiresAt,
    expiryYmd,
    devHash,
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

  const parsedAny = parseTokenAny(token);
  const createdAt = now();
  let plan = trim(req.body?.plan || (parsedAny?.plan || "MONTHLY")).toUpperCase();
  if (!plan) plan = "MONTHLY";
  let expiresAt = parseInt(req.body?.expiresAt || "0", 10);
  if (!expiresAt || !Number.isFinite(expiresAt) || expiresAt <= 0) {
    if (parsedAny?.expiresAt) expiresAt = parsedAny.expiresAt;
    else expiresAt = createdAt + planToDays(plan) * 24 * 60 * 60 * 1000;
  }

  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const lic = {
    licenseId,
    token,
    plan,
    status: "ISSUED",
    createdAt,
    expiresAt,
    expiryYmd: parsedAny?.expiryYmd || (parsedAny?.expiresAt ? ymd(parsedAny.expiresAt) : ""),
    devHash: parsedAny?.devHash || "",
    boundDeviceId: trim(req.body?.boundDeviceId || ""),
    boundShopId: trim(req.body?.boundShopId || ""),
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

  // If this is an SPNG1 offline token, it MUST match the target deviceId.
  const pv = parseAndVerifySpng1(token);
  if (pv.ok) {
    const want = devhash16(deviceId);
    if (want !== pv.devHash) {
      return res.status(400).json({ ok: false, error: "token not for this device" });
    }
  }

  // If token was created externally (e.g. Python/Dev Portal) and not yet in DB, auto-import.
  let lic = findLicenseByAny(db, { token });
  if (!lic) {
    const parsed = parseTokenAny(token);
    if (parsed) {
      const createdAt = now();
      const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
      lic = {
        licenseId,
        token,
        plan: (parsed.plan || "MONTHLY").toUpperCase(),
        status: "ISSUED",
        createdAt,
        expiresAt: parsed.expiresAt || 0,
        expiryYmd: parsed.expiryYmd || (parsed.expiresAt ? ymd(parsed.expiresAt) : ""),
        devHash: parsed.devHash || "",
        boundDeviceId: "",
        boundShopId: "",
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

  const months = parseInt(req.body?.months || "0", 10);
  const newPlan = trim(req.body?.plan || "").toUpperCase();
  const reason = trim(req.body?.reason || "");

  const lic = findLicenseByAny(db, { licenseId, token, deviceId });
  if (!lic) return res.status(404).json({ ok: false, error: "license not found" });
  if (trim(lic.status) === "REVOKED") return res.status(400).json({ ok: false, error: "license revoked" });

  // ✅ SPNG1 rules: extend = re-issue new token (new expiry) + revoke old token.
  // This keeps Android offline validation intact while allowing online revoke/extend.
  const device = trim(req.body?.androidId || req.body?.deviceId || lic.boundDeviceId);
  if (!device) return res.status(400).json({ ok: false, error: "deviceId/androidId required to extend" });

  // Determine base date: max(today, current expiry date)
  const t = todayInLagos();
  const todayYmd = `${t.y}${String(t.m).padStart(2, "0")}${String(t.d).padStart(2, "0")}`;
  const current = trim(lic.expiryYmd) || (() => {
    const pv = parseAndVerifySpng1(lic.token);
    return pv.ok ? pv.expiryYmd : "";
  })();
  const baseYmd = (/^\d{8}$/.test(current) && current > todayYmd) ? current : todayYmd;
  const by = parseInt(baseYmd.slice(0,4),10);
  const bm = parseInt(baseYmd.slice(4,6),10);
  const bd = parseInt(baseYmd.slice(6,8),10);

  const plan = (newPlan || trim(lic.plan) || "MONTHLY").toUpperCase();
  const addM = Number.isFinite(months) && months > 0 ? months : (plan === "YEARLY" ? 12 : 1);
  const next = addMonthsYmd({ y: by, m: bm, d: bd }, addM);

  // New token must match device hash (Python/Android)
  let newToken = "";
  try {
    newToken = genSpng1Token(plan, device, next.ymd);
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  // Revoke old
  lic.status = "REVOKED";
  lic.notes = reason ? `REVOKED (EXTEND): ${reason}` : "REVOKED (EXTEND)";

  // Insert new license
  const licenseId2 = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
  const parsed2 = parseAndVerifySpng1(newToken);
  const newLic = {
    licenseId: licenseId2,
    token: newToken,
    plan,
    status: "ACTIVE",
    createdAt: now(),
    expiresAt: parsed2.ok ? parsed2.expiresAt : ymdToExpiresAtUtc(next.ymd),
    expiryYmd: parsed2.ok ? parsed2.expiryYmd : next.ymd,
    devHash: parsed2.ok ? parsed2.devHash : devhash16(device),
    boundDeviceId: trim(device),
    boundShopId: trim(lic.boundShopId || ""),
    activatedAt: now(),
    notes: `EXTENDED_FROM ${trim(lic.licenseId)}`
  };

  db.licenses.unshift(newLic);
  writeDB(db);
  res.json({ ok: true, old: lic, license: newLic, serverTime: now() });
});


// ------------------------------
// Owner (Shop User) Management (Option 1: Dev Portal creates owners)
// ------------------------------
function ownerId() {
  return "OWN_" + crypto.randomBytes(6).toString("hex");
}
function hashPassword(password, salt) {
  const key = crypto.scryptSync(password, salt, 32);
  return key.toString("hex");
}
function sanitizeEmail(v) {
  return trim(v).toLowerCase();
}

// List shops (for Dev Portal owner assignment UI)
r.get("/shops/list", requireDevKey, (req, res) => {
  const db = readDB();
  const shops = (db.shops || []).map(s => ({
    shopId: s.shopId,
    shopName: s.shopName,
    shopCode: s.shopCode
  }));
  return res.json({ ok: true, shops });
});

// Create Owner
r.post("/owners/create", requireDevKey, (req, res) => {
  const email = sanitizeEmail(req.body?.email);
  const password = trim(req.body?.password);
  const shops = Array.isArray(req.body?.shops) ? req.body.shops.map(trim).filter(Boolean) : [];

  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  const db = readDB();
  if (!Array.isArray(db.owners)) db.owners = [];

  const existing = db.owners.find(o => (o.email || "").toLowerCase() === email);
  if (existing) return res.status(409).json({ ok: false, error: "Owner already exists", ownerId: existing.ownerId });

  // Validate shop IDs exist (optional: allow empty shops then assign later)
  const validShopIds = (db.shops || []).map(s => s.shopId);
  const assigned = shops.filter(id => validShopIds.includes(id));

  const salt = crypto.randomBytes(16).toString("hex");
  const passHash = hashPassword(password, salt);

  const o = {
    ownerId: ownerId(),
    email,
    salt,
    passHash,
    shops: assigned,
    createdAt: now(),
    isDisabled: false
  };
  db.owners.unshift(o);
  writeDB(db);

  return res.json({ ok: true, owner: { ownerId: o.ownerId, email: o.email, shops: o.shops } });
});

// Assign shops to owner (replace)
r.post("/owners/assign", requireDevKey, (req, res) => {
  const ownerIdVal = trim(req.body?.ownerId);
  const shops = Array.isArray(req.body?.shops) ? req.body.shops.map(trim).filter(Boolean) : [];
  if (!ownerIdVal) return res.status(400).json({ ok: false, error: "ownerId required" });

  const db = readDB();
  if (!Array.isArray(db.owners)) db.owners = [];
  const owner = db.owners.find(o => o.ownerId === ownerIdVal);
  if (!owner) return res.status(404).json({ ok: false, error: "Owner not found" });

  const validShopIds = (db.shops || []).map(s => s.shopId);
  owner.shops = shops.filter(id => validShopIds.includes(id));
  owner.updatedAt = now();
  writeDB(db);

  return res.json({ ok: true, owner: { ownerId: owner.ownerId, email: owner.email, shops: owner.shops } });
});

// Reset owner password
r.post("/owners/reset-password", requireDevKey, (req, res) => {
  const ownerIdVal = trim(req.body?.ownerId);
  const newPassword = trim(req.body?.newPassword);
  if (!ownerIdVal || !newPassword) return res.status(400).json({ ok: false, error: "ownerId and newPassword required" });

  const db = readDB();
  if (!Array.isArray(db.owners)) db.owners = [];
  const owner = db.owners.find(o => o.ownerId === ownerIdVal);
  if (!owner) return res.status(404).json({ ok: false, error: "Owner not found" });

  const salt = crypto.randomBytes(16).toString("hex");
  owner.salt = salt;
  owner.passHash = hashPassword(newPassword, salt);
  owner.updatedAt = now();
  writeDB(db);

  return res.json({ ok: true, owner: { ownerId: owner.ownerId, email: owner.email } });
});

// List owners (for Dev Portal UI)
r.get("/owners/list", requireDevKey, (req, res) => {
  const db = readDB();
  const owners = (db.owners || []).map(o => ({
    ownerId: o.ownerId,
    email: o.email,
    shops: o.shops || [],
    createdAt: o.createdAt || 0,
    isDisabled: o.isDisabled === true
  }));
  return res.json({ ok: true, owners });
});

export default r;
