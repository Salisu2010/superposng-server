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
import { genSpng2Token, parseAndVerifySpng2, devhash16Spng2 } from "../spng2.js";

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


function ensureSecurity(db) {
  db.security = db.security && typeof db.security === "object" ? db.security : {};
  db.security.blacklist = Array.isArray(db.security.blacklist) ? db.security.blacklist : [];
  db.security.rate = db.security.rate && typeof db.security.rate === "object" ? db.security.rate : {};
  return db.security;
}
function normalizeDh(v) { return trim(v).toUpperCase(); }


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
// -------------------
r.post("/generate-token", requireDevKey, (req, res) => {
  const db = readDB();

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const createdAt = now();
  const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;

  // ✅ Token generator (Professional):
  // - If fpHash is provided => SPNG2 (Anti-Clone stronger)
  // - Else => SPNG1 (Legacy compatible)
  //
  // SPNG1: SPNG1|PLAN|YYYYMMDD|DEVHASH16|SIG12
  // SPNG2: SPNG2|PLAN|YYYYMMDD|DEVHASH16|SIG12   (DEVHASH derived from ANDROID_ID + fpHash)

  const deviceId = trim(req.body?.deviceId);
  const fpHash = trim(req.body?.fpHash);

  if (!deviceId) return res.status(400).json({ ok: false, error: "deviceId required" });

  let token = "";
  let tokenVersion = "SPNG1";

  try {
    if (fpHash) {
      tokenVersion = "SPNG2";
      token = genSpng2Token(plan, deviceId, fpHash);
    } else {
      token = genSpng1Token(plan, deviceId);
    }
  } catch (e) {
    return res.status(400).json({ ok: false, error: e?.message || "Bad request" });
  }

  const parsed = tokenVersion === "SPNG2" ? parseAndVerifySpng2(token) : parseAndVerifySpng1(token);
  const expiresAt = parsed.ok ? parsed.expiresAt : 0;
  const expiryYmd = parsed.ok ? parsed.expiryYmd : "";
  const devHash = parsed.ok ? parsed.devHash : "";

  const lic = {
    licenseId,
    token,
    tokenVersion,
    plan,
    status: "ISSUED",
    createdAt,
    expiresAt,
    expiryYmd,
    devHash,
    fpHash: fpHash || "",
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
// DEV: Bulk generate tokens (SPNG1/SPNG2)
// body: { plan, useSpng2, quantity, lines }
// - Professional mode: prefer 'lines' (list of AndroidIDs) to generate many at once
// - Each line can be: ANDROID_ID   OR   ANDROID_ID,FP_HASH
// - Max batch size: 200 (to protect server)
// returns: { ok, licenses: [...], errors: [...], serverTime }
// -------------------------
r.post("/bulk-generate-tokens", requireDevKey, (req, res) => {
  const db = readDB();

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const useSpng2 = !!req.body?.useSpng2;

  const rawLines = trim(req.body?.lines || "");
  let lines = rawLines
    ? rawLines.split(/\r?\n/).map((x) => trim(x)).filter((x) => !!x)
    : [];

  // Optional: quantity mode (only if lines not provided) - will require deviceIds in future,
  // so we keep it disabled to avoid generating unbound tokens accidentally.
  const quantity = parseInt(req.body?.quantity || String(lines.length || 0), 10) || 0;

  if (!lines.length) {
    return res.status(400).json({ ok: false, error: "lines required (paste AndroidIDs: one per line)" });
  }

  const MAX = 200;
  if (lines.length > MAX) {
    return res.status(400).json({ ok: false, error: `Too many rows. Max ${MAX} per batch.` });
  }

  const createdAt = now();
  const out = [];
  const errors = [];

  for (let i = 0; i < lines.length; i++) {
    const row = lines[i];
    // line formats:
    // 1) androidId
    // 2) androidId,fpHash
    // 3) androidId|fpHash (allow)
    let androidId = "";
    let fpHash = "";

    const parts = row.split(/[,|\t;]/).map((x) => trim(x)).filter((x) => !!x);
    androidId = trim(parts[0] || "");
    fpHash = trim(parts[1] || "");

    if (!androidId) {
      errors.push({ row: i + 1, input: row, error: "Missing AndroidID" });
      continue;
    }

    let token = "";
    let tokenVersion = "SPNG1";

    try {
      if (useSpng2) {
        tokenVersion = "SPNG2";
        if (!fpHash) {
          // If fpHash not provided, we still allow SPNG2 by using a stable empty marker
          // to keep user flow simple. (Android app should provide fpHash for strongest anti-clone)
          fpHash = "";
        }
        token = genSpng2Token(plan, androidId, fpHash);
      } else {
        token = genSpng1Token(plan, androidId);
      }
    } catch (e) {
      errors.push({ row: i + 1, input: row, error: e?.message || "Bad row" });
      continue;
    }

    const parsed = tokenVersion === "SPNG2" ? parseAndVerifySpng2(token) : parseAndVerifySpng1(token);
    if (!parsed.ok) {
      errors.push({ row: i + 1, input: row, error: parsed.error || "Token parse failed" });
      continue;
    }

    const licenseId = `LIC-${crypto.randomBytes(6).toString("hex").toUpperCase()}`;
    const lic = {
      licenseId,
      token,
      tokenVersion,
      plan,
      status: "ISSUED",
      createdAt,
      expiresAt: parsed.expiresAt,
      expiryYmd: parsed.expiryYmd || "",
      devHash: parsed.devHash || "",
      fpHash: tokenVersion === "SPNG2" ? (fpHash || "") : "",
      boundDeviceId: "",
      boundShopId: "",
      activatedAt: 0,
      notes: ""
    };

    db.licenses.unshift(lic);
    out.push(lic);
  }

  writeDB(db);
  return res.json({ ok: true, licenses: out, errors, serverTime: createdAt });
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

function resolveShopByIdOrCode(db, shopIdOrCode) {
  const q = trim(shopIdOrCode);
  if (!q) return null;
  if (!Array.isArray(db.shops)) db.shops = [];
  // Exact match by shopId or shopCode (case-insensitive for shopCode)
  let shop = db.shops.find(s => String(s.shopId) === q) ||
             db.shops.find(s => String(s.shopCode || "").toUpperCase() === q.toUpperCase());
  return shop || null;
}

function purgeShopData(db, shopId) {
  const sid = String(shopId || "");
  const dropByShopId = (arr, key = "shopId") => Array.isArray(arr) ? arr.filter(x => String(x?.[key] || "") !== sid) : [];
  // Core
  db.shops = Array.isArray(db.shops) ? db.shops.filter(s => String(s.shopId) !== sid) : [];
  // Related collections
  db.devices = dropByShopId(db.devices, "shopId");
  db.products = dropByShopId(db.products, "shopId");
  db.staffs = dropByShopId(db.staffs, "shopId");
  db.sales = dropByShopId(db.sales, "shopId");
  db.debtors = dropByShopId(db.debtors, "shopId");
  db.debtorPayments = dropByShopId(db.debtorPayments, "shopId");
  db.licenses = dropByShopId(db.licenses, "shopId");
  db.pendingActivations = dropByShopId(db.pendingActivations, "shopId");
  db.pairCodes = dropByShopId(db.pairCodes, "shopId");
  db.shopAliases = dropByShopId(db.shopAliases, "shopId");
  db.trials = dropByShopId(db.trials, "shopId");

  // RMP collections
  db.rmpLicenses = dropByShopId(db.rmpLicenses, "shopId");
  db.rmpPendingActivations = dropByShopId(db.rmpPendingActivations, "shopId");
}

r.get("/shops/list", requireDevKey, (req, res) => {
  const db = readDB();
  const shops = (db.shops || []).map(s => ({
    shopId: s.shopId,
    shopName: s.shopName,
    shopCode: s.shopCode,
    createdAt: s.createdAt,
    isMerged: s.isMerged === true,
    mergedInto: s.mergedInto || "",
    isDeleted: s.isDeleted === true
  }));
  return res.json({ ok: true, shops });
});

/**
 * Delete a Shop (Dev Portal)
 * body: { shopIdOrCode, hard?: true }
 *
 * ⚠️ HARD delete removes the shop and all related records (devices, products, staffs, sales, debtors, licenses, trials, etc).
 * This is intended for duplicate / mistaken shop creation or when a customer wants the shop wiped.
 */
r.post("/shops/delete", requireDevKey, (req, res) => {
  const { shopIdOrCode, hard } = req.body || {};
  const q = trim(shopIdOrCode);
  if (!q) return res.status(400).json({ ok: false, error: "shopIdOrCode is required" });

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];

  const shop = resolveShopByIdOrCode(db, q);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  // Safety: don't allow deleting a canonical shop that others are merged into unless hard=true
  const sid = String(shop.shopId);
  const mergedChildren = db.shops.filter(s => s && s.isMerged === true && String(s.mergedInto || "") === sid);
  if (mergedChildren.length && hard !== true) {
    return res.status(400).json({
      ok: false,
      error: "This shop has merged shops pointing to it. Pass {hard:true} to force delete.",
      mergedChildren: mergedChildren.map(s => ({ shopId: s.shopId, shopCode: s.shopCode, shopName: s.shopName }))
    });
  }

  if (hard === true) {
    // Remove merged children first (so pointers don't dangle)
    mergedChildren.forEach(ch => purgeShopData(db, ch.shopId));
    purgeShopData(db, sid);
  } else {
    // Soft delete: mark as deleted (keeps history)
    shop.isDeleted = true;
    shop.deletedAt = Date.now();
    shop.updatedAt = Date.now();
  }

  writeDB(db);
  return res.json({
    ok: true,
    deleted: hard === true,
    softDeleted: hard !== true,
    shop: { shopId: shop.shopId, shopCode: shop.shopCode, shopName: shop.shopName }
  });
});


});




// Merge Preview (Dev Portal)
// body: { fromShopId, toShopId }
// - Returns counts for each collection before running merge
r.post("/shops/merge/preview", requireDevKey, (req, res) => {
  const fromShopId = trim(req.body?.fromShopId);
  const toShopId = trim(req.body?.toShopId);

  if (!fromShopId || !toShopId) return res.status(400).json({ ok: false, error: "fromShopId and toShopId required" });
  if (fromShopId === toShopId) return res.status(400).json({ ok: false, error: "fromShopId and toShopId must be different" });

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];

  const fromShop = db.shops.find(s => s.shopId === fromShopId);
  const toShop = db.shops.find(s => s.shopId === toShopId);

  if (!fromShop) return res.status(404).json({ ok: false, error: "fromShopId not found" });
  if (!toShop) return res.status(404).json({ ok: false, error: "toShopId not found" });

  const keys = ["shopId", "shopID", "shop_id", "sid", "shop", "shop_id_fk"];
  const matchesShop = (obj, sid) => {
    if (!obj || typeof obj !== "object") return false;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && trim(obj[k]) === sid) return true;
    }
    return false;
  };

  const collections = [
    "devices",
    "pairCodes",
    "products",
    "staffs",
    "sales",
    "debtors",
    "debtorPayments",
    "licenses",
    "pendingActivations"
  ];

  const preview = {};
  for (const name of collections) {
    const arr = Array.isArray(db[name]) ? db[name] : [];
    preview[name] = arr.filter(row => matchesShop(row, fromShopId)).length;
  }

  // owners preview
  let ownersWouldUpdate = 0;
  for (const o of (db.owners || [])) {
    if (!Array.isArray(o.shops)) continue;
    if (o.shops.some(id => trim(id) === fromShopId)) ownersWouldUpdate++;
  }

  return res.json({
    ok: true,
    fromShop: { shopId: fromShop.shopId, shopName: fromShop.shopName, shopCode: fromShop.shopCode, isMerged: fromShop.isMerged === true, mergedInto: fromShop.mergedInto || "" },
    toShop: { shopId: toShop.shopId, shopName: toShop.shopName, shopCode: toShop.shopCode },
    preview,
    ownersWouldUpdate,
  });
});

// Merge History (Dev Portal)
r.get("/shops/merge/history", requireDevKey, (req, res) => {
  const db = readDB();
  const logs = Array.isArray(db.mergeLogs) ? db.mergeLogs : [];
  const limit = Math.max(1, Math.min(200, parseInt(req.query?.limit, 10) || 100));
  return res.json({ ok: true, logs: logs.slice(0, limit) });
});

// Merge Shops (Dev Portal)
// body: { fromShopId, toShopId }
// - Moves all data rows from fromShopId -> toShopId across collections
// - Records alias in db.shopAliases and marks fromShop as merged
r.post("/shops/merge", requireDevKey, (req, res) => {
  const fromShopId = trim(req.body?.fromShopId);
  const toShopId = trim(req.body?.toShopId);

  if (!fromShopId || !toShopId) return res.status(400).json({ ok: false, error: "fromShopId and toShopId required" });
  if (fromShopId === toShopId) return res.status(400).json({ ok: false, error: "fromShopId and toShopId must be different" });

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];
  if (!Array.isArray(db.shopAliases)) db.shopAliases = [];
  if (!Array.isArray(db.mergeLogs)) db.mergeLogs = [];
  if (!Array.isArray(db.owners)) db.owners = [];

  const fromShop = db.shops.find(s => s.shopId === fromShopId);
  const toShop = db.shops.find(s => s.shopId === toShopId);

  if (!fromShop) return res.status(404).json({ ok: false, error: "fromShopId not found" });
  if (!toShop) return res.status(404).json({ ok: false, error: "toShopId not found" });

  // Helper: detect shop id field and rewrite
  const rewriteShopId = (obj) => {
    if (!obj || typeof obj !== "object") return 0;
    const keys = ["shopId", "shopID", "shop_id", "sid", "shop", "shop_id_fk"];
    let changed = 0;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && trim(obj[k]) === fromShopId) {
        obj[k] = toShopId;
        changed++;
      }
    }
    return changed;
  };

  const collections = [
    "devices",
    "pairCodes",
    "products",
    "staffs",
    "sales",
    "debtors",
    "debtorPayments",
    "licenses",
    "pendingActivations"
  ];

  const stats = {};
  for (const name of collections) {
    const arr = Array.isArray(db[name]) ? db[name] : [];
    let moved = 0;
    for (const row of arr) {
      moved += rewriteShopId(row) ? 1 : 0;
    }
    db[name] = arr;
    stats[name] = moved;
  }

  // Also update owners shop lists (if any)
  let ownersUpdated = 0;
  for (const o of (db.owners || [])) {
    if (!Array.isArray(o.shops)) continue;
    const before = o.shops.slice();
    o.shops = o.shops.map(id => (trim(id) === fromShopId ? toShopId : id));
    // de-dupe
    o.shops = Array.from(new Set(o.shops.filter(Boolean)));
    if (JSON.stringify(before) !== JSON.stringify(o.shops)) ownersUpdated++;
  }

  // Record alias
  db.shopAliases.unshift({
    fromShopId,
    toShopId,
    createdAt: now(),
    note: "dev-portal-merge"
  });

  // Mark fromShop merged (but keep record)
  fromShop.isMerged = true;
  fromShop.mergedInto = toShopId;
  fromShop.updatedAt = now();

  // Optionally: if fromShop has ownerPhone/pin and toShop lacks it, keep it on toShop
  if ((fromShop.ownerPhone || fromShop.ownerPin) && (!toShop.ownerPhone && !toShop.ownerPin)) {
    toShop.ownerPhone = fromShop.ownerPhone || toShop.ownerPhone || "";
    toShop.ownerPin = fromShop.ownerPin || toShop.ownerPin || "";
    toShop.updatedAt = now();
  }

  writeDB(db);

  return res.json({ ok: true, fromShopId, toShopId, moved: stats, ownersUpdated });
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


/**
 * Cashier permissions management (DEV only)
 *
 * Permissions model:
 *  { sales:true|false, products:true|false, debtors:true|false, expiry:true|false, settings:true|false, insights:true|false, export:true|false }
 *
 * GET /api/dev/shops/:shopCodeOrId/cashiers
 * POST /api/dev/shops/:shopCodeOrId/cashiers/:username/permissions  body: { permissions:{...} }
 */

function normPermsDev(p) {
  const o = (p && typeof p === "object") ? p : {};
  return {
    sales: o.sales !== false, // default true
    products: o.products === true,
    debtors: o.debtors === true,
    expiry: o.expiry === true,
    settings: o.settings === true,
    insights: o.insights === true,
    export: o.export === true,
  };
}

function resolveShopByCodeOrId(db, shopCodeOrId) {
  const key = trim(shopCodeOrId).toUpperCase();
  if (!key) return null;
  let shop = (db.shops || []).find(s => trim(s.shopId).toUpperCase() === key || trim(s.shopCode).toUpperCase() === key);
  if (!shop) return null;
  // resolve merged to canonical
  if (shop.isMerged === true && shop.mergedInto) {
    const c = (db.shops || []).find(x => x.shopId === shop.mergedInto);
    if (c) shop = c;
  }
  return shop;
}

r.get("/shops/:shopCodeOrId/cashiers", requireDevKey, (req, res) => {
  const db = readDB();
  const shop = resolveShopByCodeOrId(db, req.params.shopCodeOrId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  const staffs = (db.staffs || []).filter(st => {
    const sid = trim(st.shopId || st.shopID || st.shop_id || st.sid || "");
    return sid === shop.shopId && st.active !== false;
  }).map(st => ({
    staffId: trim(st.staffId || st.id || ""),
    username: trim(st.username || ""),
    name: trim(st.name || st.fullName || ""),
    role: trim(st.role || "cashier"),
    active: st.active !== false,
    permissions: normPermsDev(st.permissions || st.perms || {})
  }));

  return res.json({ ok: true, shop: { shopId: shop.shopId, shopName: shop.shopName || "", shopCode: shop.shopCode || "" }, cashiers: staffs });
});

r.post("/shops/:shopCodeOrId/cashiers/:username/permissions", requireDevKey, (req, res) => {
  const shopCodeOrId = req.params.shopCodeOrId;
  const username = trim(req.params.username).toLowerCase();
  const perms = normPermsDev(req.body?.permissions || req.body?.perms || {});

  const db = readDB();
  const shop = resolveShopByCodeOrId(db, shopCodeOrId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  const staff = (db.staffs || []).find(st => {
    const sid = trim(st.shopId || st.shopID || st.shop_id || st.sid || "");
    return sid === shop.shopId && trim(st.username).toLowerCase() === username;
  });
  if (!staff) return res.status(404).json({ ok: false, error: "Cashier not found" });

  staff.permissions = perms;
  writeDB(db);

  return res.json({ ok: true, shopId: shop.shopId, username: trim(staff.username), permissions: perms });
});


// ----------------------------
// Cashier Permission Templates (DEV only)
// ----------------------------
const CASHIER_PERMISSION_TEMPLATES = [
  { id: "sales_only", name: "Sales Only", permissions: { sales:true, products:false, debtors:false, expiry:false, settings:false, insights:false, export:false } },
  { id: "sales_debtors", name: "Sales + Debtors", permissions: { sales:true, products:false, debtors:true, expiry:false, settings:false, insights:false, export:false } },
  { id: "supervisor", name: "Supervisor", permissions: { sales:true, products:true, debtors:true, expiry:true, settings:false, insights:false, export:true } },
  { id: "manager", name: "Manager", permissions: { sales:true, products:true, debtors:true, expiry:true, settings:false, insights:true, export:true } },
  { id: "full_access", name: "Full Access (No Settings)", permissions: { sales:true, products:true, debtors:true, expiry:true, settings:false, insights:true, export:true } },
];

r.get("/cashier-permission-templates", requireDevKey, (req, res) => {
  return res.json({ ok: true, templates: CASHIER_PERMISSION_TEMPLATES });
});

// Apply a template to many/all cashiers in a shop
// POST /api/dev/shops/:shopCodeOrId/cashiers/apply-template  body: { templateId, usernames?:[] }
r.post("/shops/:shopCodeOrId/cashiers/apply-template", requireDevKey, (req, res) => {
  const db = readDB();
  const shop = resolveShopByCodeOrId(db, req.params.shopCodeOrId);
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  const templateId = trim(req.body?.templateId || req.body?.id).toLowerCase();
  const tpl = CASHIER_PERMISSION_TEMPLATES.find(t => t.id === templateId);
  if (!tpl) return res.status(400).json({ ok: false, error: "Invalid templateId" });

  const usernames = Array.isArray(req.body?.usernames) ? req.body.usernames.map(x => trim(x).toLowerCase()).filter(Boolean) : null;

  let updated = 0;
  (db.staffs || []).forEach((st) => {
    const sid = trim(st.shopId || st.shopID || st.shop_id || st.sid || "");
    if (sid !== shop.shopId) return;
    if (st.active === false) return;
    const un = trim(st.username).toLowerCase();
    if (!un) return;
    if (usernames && !usernames.includes(un)) return;
    st.permissions = normPermsDev(tpl.permissions);
    updated++;
  });

  writeDB(db);
  return res.json({ ok: true, shopId: shop.shopId, templateId: tpl.id, updated });
});



// ------------------------------------------------------------
// BLACKLIST / DEVICE BLOCK (DEV KEY)
// POST /api/dev/blacklist/add    { devHash, reason?, days? }
// POST /api/dev/blacklist/remove { devHash }
// GET  /api/dev/blacklist/list
// ------------------------------------------------------------
r.post("/blacklist/add", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  const devHash = normalizeDh(req.body?.devHash);
  const reason = trim(req.body?.reason) || "blocked";
  const days = Number(req.body?.days || 0);
  if (!devHash) return res.status(400).json({ ok: false, error: "devHash required" });

  const until = days > 0 ? (now() + Math.floor(days * 86400000)) : 0;
  const existing = sec.blacklist.find(x => normalizeDh(x.devHash) === devHash) || null;
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

r.post("/blacklist/remove", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  const devHash = normalizeDh(req.body?.devHash);
  if (!devHash) return res.status(400).json({ ok: false, error: "devHash required" });
  sec.blacklist = sec.blacklist.filter(x => normalizeDh(x.devHash) !== devHash);
  writeDB(db);
  return res.json({ ok: true, devHash });
});

r.get("/blacklist/list", requireDevKey, (req, res) => {
  const db = readDB();
  const sec = ensureSecurity(db);
  return res.json({ ok: true, blacklist: sec.blacklist });
});


export default r;
