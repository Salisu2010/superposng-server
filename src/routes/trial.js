import express from "express";
import { readDB, writeDB } from "../db.js";

const router = express.Router();

function nowTs() {
  return Date.now();
}

function ymdFromDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return Number(`${yyyy}${mm}${dd}`);
}

function addDaysUTC(ymd, days) {
  const s = String(ymd || "");
  const yyyy = Number(s.slice(0, 4));
  const mm = Number(s.slice(4, 6));
  const dd = Number(s.slice(6, 8));
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return ymdFromDate(d);
}

function normalizeApp(app) {
  const a = String(app || "").trim().toUpperCase();
  if (a === "SPNG" || a === "SUPERPOSNG") return "SPNG";
  if (a === "RMP" || a === "REPAIRMASTERPRO") return "RMP";
  if (a === "STMN" || a === "STMN" || a === "SMTN" || a === "STAYMASTER" || a === "STAYMASTERNG" || a === "STMNG") return "STMN";
  if (a === "CPNG" || a === "CLP" || a === "CLINICPRONG" || a === "CLINICPRO" || a === "CLINIC_PRO_NG") return "CPNG";
  return "";
}

function normalizeId(v) {
  return String(v || "").trim();
}

function normalizeYmd(v) {
  const s = String(v || "").trim();
  return /^\d{8}$/.test(s) ? Number(s) : 0;
}

function same(a, b) {
  const x = normalizeId(a);
  const y = normalizeId(b);
  return !!x && !!y && x === y;
}

function computeStatus(nowYmd, t) {
  if (!t) return "NONE";
  if (t.blocked) return "BLOCKED";
  if (t.revoked) return "REVOKED";
  if (Number(nowYmd) > Number(t.expiryYmd)) return "EXPIRED";
  return "ACTIVE";
}

function trialMessage(status) {
  if (status === "BLOCKED") return "Trial blocked. Contact admin for activation token.";
  if (status === "REVOKED") return "Trial ended. Contact admin for activation token.";
  if (status === "EXPIRED") return "Trial ended. Contact admin for activation token.";
  if (status === "ACTIVE") return "Trial active";
  return "No trial found";
}

function requireDevKey(req, res, next) {
  const expected = normalizeId(process.env.DEV_KEY);
  if (!expected) {
    return res.status(500).json({ ok: false, error: "DEV_KEY not configured on server" });
  }
  const got = normalizeId(req.header("X-DEV-KEY")) || normalizeId((req.header("Authorization") || "").replace(/^Bearer\s+/i, ""));
  if (got && got === expected) return next();
  return res.status(403).json({ ok: false, error: "Forbidden" });
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = headers.map(esc).join(",");
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

function ensureTrialCollections(db) {
  db.trials = Array.isArray(db.trials) ? db.trials : [];
  db.trialAuditLogs = Array.isArray(db.trialAuditLogs) ? db.trialAuditLogs : [];
  db.trialBlocks = Array.isArray(db.trialBlocks) ? db.trialBlocks : [];
  db.trialConsumedKeys = Array.isArray(db.trialConsumedKeys) ? db.trialConsumedKeys : [];
}

function parseIdentity(req) {
  return {
    app: normalizeApp(req.query.app),
    deviceId: normalizeId(req.query.deviceId),
    fpHash: normalizeId(req.query.fpHash),
    androidId: normalizeId(req.query.androidId),
    installId: normalizeId(req.query.installId),
    clientDateYmd: normalizeYmd(req.query.clientDateYmd || req.query.deviceDateYmd || req.query.localDateYmd),
    ip: normalizeId((req.headers["x-forwarded-for"] || "").split(",")[0]) || normalizeId(req.ip),
    userAgent: normalizeId(req.header("user-agent"))
  };
}

function hasPrimaryIdentity(ids) {
  return !!(ids.fpHash || ids.androidId || ids.deviceId);
}

function scoreTrialMatch(t, { fpHash, androidId, deviceId, installId }) {
  let score = 0;
  if (same(t.fpHash, fpHash)) score += 100;
  if (same(t.androidId, androidId)) score += 60;
  if (same(t.deviceId, deviceId)) score += 40;
  if (same(t.installId, installId)) score += 20;
  return score;
}

function selectExistingTrial(trials, app, ids) {
  const list = Array.isArray(trials) ? trials : [];
  const matches = list
    .map((t, idx) => ({ idx, t, score: t && t.app === app ? scoreTrialMatch(t, ids) : 0 }))
    .filter((x) => x.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aStart = Number(a.t?.startYmd || 0);
      const bStart = Number(b.t?.startYmd || 0);
      if (aStart !== bStart) return aStart - bStart;
      return Number(a.t?.createdAt || 0) - Number(b.t?.createdAt || 0);
    });
  return matches.length ? matches[0] : null;
}

function getIdentityValues(ids) {
  return [ids.fpHash, ids.androidId, ids.deviceId, ids.installId].map(normalizeId).filter(Boolean);
}

function trialIdentityKey(app, kind, value) {
  const v = normalizeId(value);
  if (!app || !kind || !v) return "";
  return `${app}|${String(kind).toUpperCase()}|${v}`;
}

function consumedKeysForIds(ids) {
  return [
    trialIdentityKey(ids.app, "FP", ids.fpHash),
    trialIdentityKey(ids.app, "ANDROID", ids.androidId),
    trialIdentityKey(ids.app, "DEVICE", ids.deviceId),
    trialIdentityKey(ids.app, "INSTALL", ids.installId),
  ].filter(Boolean);
}

function ensureConsumedKeys(db, ids, trial, statusHint = "") {
  ensureTrialCollections(db);
  const status = normalizeId(statusHint).toUpperCase() || computeStatus(ymdFromDate(new Date()), trial);
  const keys = consumedKeysForIds({
    app: ids?.app || trial?.app || "",
    fpHash: ids?.fpHash || trial?.fpHash || "",
    androidId: ids?.androidId || trial?.androidId || "",
    deviceId: ids?.deviceId || trial?.deviceId || "",
    installId: ids?.installId || trial?.installId || "",
  });
  for (const key of keys) {
    const existing = db.trialConsumedKeys.find((x) => x && x.key === key);
    if (existing) {
      existing.status = status || existing.status || "CONSUMED";
      existing.updatedAt = nowTs();
      if (trial?.id) existing.trialId = existing.trialId || trial.id;
      continue;
    }
    db.trialConsumedKeys.unshift({
      key,
      app: ids?.app || trial?.app || "",
      trialId: trial?.id || "",
      status: status || "CONSUMED",
      createdAt: nowTs(),
      updatedAt: nowTs(),
    });
  }
}

function findConsumedKeyReuse(db, ids) {
  ensureTrialCollections(db);
  const keys = consumedKeysForIds(ids);
  return db.trialConsumedKeys.find((x) => x && keys.includes(x.key)) || null;
}

function trialMatchesIdentity(t, ids) {
  return scoreTrialMatch(t, ids) > 0;
}


function hasActiveLikeStatus(v) {
  const s = normalizeId(v).toUpperCase();
  return s === "ACTIVE" || s === "OK" || s === "VALID" || s === "APPROVED";
}

function findActivatedLicense(db, ids) {
  const androidId = normalizeId(ids.androidId || ids.deviceId);
  const fpHash = normalizeId(ids.fpHash);
  const collections = [];
  collections.push(...(Array.isArray(db.licenses) ? db.licenses.flatMap((x) => ([{ kind: "SPNG", row: x }, { kind: "CPNG", row: x }])) : []));
  collections.push(...(Array.isArray(db.rmpLicenses) ? db.rmpLicenses.map((x) => ({ kind: "RMP", row: x })) : []));
  collections.push(...(Array.isArray(db.stmnLicenses) ? db.stmnLicenses.map((x) => ({ kind: "STMN", row: x })) : []));

  const allowedKind = ids.app === "STMN" ? new Set(["STMN"]) : new Set([ids.app]);

  for (const item of collections) {
    if (!allowedKind.has(item.kind)) continue;
    const x = item.row || {};
    const status = normalizeId(x.status).toUpperCase();
    const boundDeviceId = normalizeId(x.boundDeviceId || x.androidId || x.deviceId);
    const recFpHash = normalizeId(x.fpHash);
    const deviceMatch = androidId && boundDeviceId && androidId === boundDeviceId;
    const fpMatch = fpHash && recFpHash && fpHash === recFpHash;
    if ((deviceMatch || fpMatch) && hasActiveLikeStatus(status)) {
      return { kind: item.kind, row: x };
    }
  }
  return null;
}

function blockMatchesIdentity(b, ids) {
  if (!b) return false;
  if (b.app && ids.app && b.app !== ids.app) return false;
  return (
    same(b.fpHash, ids.fpHash) ||
    same(b.androidId, ids.androidId) ||
    same(b.deviceId, ids.deviceId) ||
    same(b.installId, ids.installId)
  );
}

function logTrialEvent(db, type, ids, extra = {}) {
  ensureTrialCollections(db);
  db.trialAuditLogs.unshift({
    id: `TLOG-${nowTs()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    type,
    app: ids.app || "",
    fpHash: ids.fpHash || "",
    androidId: ids.androidId || "",
    deviceId: ids.deviceId || "",
    installId: ids.installId || "",
    clientDateYmd: Number(ids.clientDateYmd || 0),
    ip: ids.ip || "",
    userAgent: ids.userAgent || "",
    createdAt: nowTs(),
    ...extra
  });
  if (db.trialAuditLogs.length > 5000) db.trialAuditLogs.length = 5000;
}

function ensureBlock(db, ids, reason, meta = {}) {
  ensureTrialCollections(db);
  const existing = db.trialBlocks.find((b) => blockMatchesIdentity(b, ids));
  if (existing) {
    existing.reason = existing.reason || reason;
    existing.updatedAt = nowTs();
    existing.meta = { ...(existing.meta || {}), ...(meta || {}) };
    return existing;
  }
  const row = {
    id: `TBL-${nowTs()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    app: ids.app || "",
    fpHash: ids.fpHash || "",
    androidId: ids.androidId || "",
    deviceId: ids.deviceId || "",
    installId: ids.installId || "",
    reason,
    meta: meta || {},
    createdAt: nowTs(),
    updatedAt: nowTs(),
    active: true
  };
  db.trialBlocks.unshift(row);
  return row;
}

function blockPayload(app, reason, nowYmd) {
  return {
    ok: false,
    app,
    status: "BLOCKED",
    message: trialMessage("BLOCKED"),
    reason: reason || "blocked",
    startYmd: 0,
    expiryYmd: Number(nowYmd || 0),
    consumed: true
  };
}

function responsePayload(nowYmd, app, t) {
  const status = computeStatus(nowYmd, t);
  return {
    ok: status === "ACTIVE",
    app,
    status,
    message: trialMessage(status),
    reason: normalizeId(t?.revokeReason || t?.blockReason || ""),
    startYmd: Number(t?.startYmd || 0),
    expiryYmd: Number(t?.expiryYmd || 0),
    consumed: !!t?.consumed,
    blocked: !!t?.blocked,
    revoked: !!t?.revoked
  };
}

function markRevoked(t, reason, nowYmd) {
  t.revoked = true;
  t.revokeReason = reason;
  t.expiryYmd = Math.min(Number(t.expiryYmd || nowYmd), Number(nowYmd));
  t.updatedAt = nowTs();
  return t;
}

function markBlocked(t, reason, nowYmd) {
  t.blocked = true;
  t.blockReason = reason;
  t.expiryYmd = Math.min(Number(t.expiryYmd || nowYmd), Number(nowYmd));
  t.updatedAt = nowTs();
  return t;
}

function enrichTrialRecord(t, ids) {
  if (!normalizeId(t.deviceId) && ids.deviceId) t.deviceId = ids.deviceId;
  if (!normalizeId(t.fpHash) && ids.fpHash) t.fpHash = ids.fpHash;
  if (!normalizeId(t.androidId) && ids.androidId) t.androidId = ids.androidId;
  if (!normalizeId(t.installId) && ids.installId) t.installId = ids.installId;
  t.lastSeenAt = nowTs();
  t.lastIp = ids.ip || t.lastIp || "";
  t.lastUserAgent = ids.userAgent || t.lastUserAgent || "";
  if (ids.clientDateYmd) t.lastClientDateYmd = ids.clientDateYmd;
  t.seenCount = Number(t.seenCount || 0) + 1;
  t.updatedAt = nowTs();
}

function antiAbuseCleanup(db, app) {
  ensureTrialCollections(db);
  const beforeTrials = db.trials.length;
  const beforeBlocks = db.trialBlocks.length;
  const beforeConsumed = db.trialConsumedKeys.length;
  const keep = [];
  const dupRevoked = [];
  const byCanonical = new Map();

  for (const t of db.trials) {
    if (!t || (app && t.app !== app)) {
      keep.push(t);
      continue;
    }
    const canonical = [t.app, normalizeId(t.fpHash) || "-", normalizeId(t.androidId) || "-", normalizeId(t.deviceId) || "-"].join("|");
    if (!byCanonical.has(canonical)) {
      byCanonical.set(canonical, t);
      keep.push(t);
      continue;
    }
    const existing = byCanonical.get(canonical);
    const existingScore = Number(existing.blocked) * 1000 + Number(existing.revoked) * 100 + Number(existing.startYmd || 0);
    const currentScore = Number(t.blocked) * 1000 + Number(t.revoked) * 100 + Number(t.startYmd || 0);
    const keeper = existingScore <= currentScore ? existing : t;
    const loser = keeper === existing ? t : existing;
    if (keeper !== existing) {
      const idx = keep.indexOf(existing);
      if (idx >= 0) keep[idx] = keeper;
      byCanonical.set(canonical, keeper);
    }
    loser.revoked = true;
    loser.revokeReason = loser.revokeReason || "duplicate-cleanup";
    loser.updatedAt = nowTs();
    dupRevoked.push(loser);
  }

  db.trials = keep;
  db.trialBlocks = db.trialBlocks
    .filter((b) => b && b.active !== false)
    .filter((b, idx, arr) => arr.findIndex((x) => [x.app, x.fpHash, x.androidId, x.deviceId, x.installId].join("|") === [b.app, b.fpHash, b.androidId, b.deviceId, b.installId].join("|")) === idx)
    .slice(0, 5000);

  return {
    beforeTrials,
    afterTrials: db.trials.length,
    beforeBlocks,
    afterBlocks: db.trialBlocks.length,
    duplicatesRevoked: dupRevoked.length
  };
}

function getAbuseState(db, ids, nowYmd, currentTrial) {
  ensureTrialCollections(db);

  const block = db.trialBlocks.find((b) => blockMatchesIdentity(b, ids) && b.active !== false);
  if (block) {
    return { blocked: true, reason: block.reason || "blocked", payload: blockPayload(ids.app, block.reason || "blocked", nowYmd) };
  }

  const relatedTrials = db.trials.filter((t) => t && t.app === ids.app && trialMatchesIdentity(t, ids));

  const activated = findActivatedLicense(db, ids);
  if (activated) {
    if (currentTrial) {
      markRevoked(currentTrial, "already-activated-no-trial", nowYmd);
      markBlocked(currentTrial, "already-activated-no-trial", nowYmd);
    }
    ensureBlock(db, ids, "already-activated-no-trial", {
      nowYmd,
      licenseKind: activated.kind,
      licenseId: normalizeId(activated.row?.licenseId),
      boundDeviceId: normalizeId(activated.row?.boundDeviceId)
    });
    logTrialEvent(db, "trial_block_after_activation", ids, {
      reason: "already-activated-no-trial",
      licenseKind: activated.kind,
      licenseId: normalizeId(activated.row?.licenseId)
    });
    return {
      blocked: true,
      reason: "already-activated-no-trial",
      payload: blockPayload(ids.app, "already-activated-no-trial", nowYmd)
    };
  }
  const hasEnded = relatedTrials.some((t) => {
    const s = computeStatus(nowYmd, t);
    return s === "EXPIRED" || s === "REVOKED" || s === "BLOCKED";
  });
  if (!currentTrial && hasEnded) {
    ensureBlock(db, ids, "expired-or-ended-trial-reuse", { nowYmd });
    logTrialEvent(db, "trial_force_block", ids, { reason: "expired-or-ended-trial-reuse" });
    return {
      blocked: true,
      reason: "expired-or-ended-trial-reuse",
      payload: blockPayload(ids.app, "expired-or-ended-trial-reuse", nowYmd)
    };
  }

  const consumedReuse = findConsumedKeyReuse(db, ids);
  if (!currentTrial && consumedReuse) {
    ensureBlock(db, ids, "trial-already-consumed", { nowYmd, key: consumedReuse.key, trialId: consumedReuse.trialId || "" });
    logTrialEvent(db, "trial_force_block", ids, { reason: "trial-already-consumed", key: consumedReuse.key, trialId: consumedReuse.trialId || "" });
    return {
      blocked: true,
      reason: "trial-already-consumed",
      payload: blockPayload(ids.app, "trial-already-consumed", nowYmd)
    };
  }

  if (currentTrial) {
    const installMismatch = !!(ids.installId && currentTrial.installId && currentTrial.installId !== ids.installId);
    if (installMismatch) {
      markRevoked(currentTrial, "reinstall-detected", nowYmd);
      markBlocked(currentTrial, "reinstall-detected", nowYmd);
      ensureBlock(db, ids, "reinstall-detected", { nowYmd, originalInstallId: currentTrial.installId });
      logTrialEvent(db, "trial_reinstall_block", ids, { reason: "reinstall-detected" });
      return { blocked: true, reason: "reinstall-detected", payload: blockPayload(ids.app, "reinstall-detected", nowYmd) };
    }

    if (ids.clientDateYmd) {
      const prevClientYmd = Number(currentTrial.lastClientDateYmd || currentTrial.firstClientDateYmd || 0);
      const diffAbs = Math.abs(Number(ids.clientDateYmd) - Number(nowYmd));
      const backward = prevClientYmd > 0 && Number(ids.clientDateYmd) < Number(prevClientYmd);
      const tooFarFromServer = diffAbs > 1;
      if (backward || tooFarFromServer) {
        markRevoked(currentTrial, "device-date-tamper", nowYmd);
        markBlocked(currentTrial, "device-date-tamper", nowYmd);
        ensureBlock(db, ids, "device-date-tamper", { nowYmd, clientDateYmd: ids.clientDateYmd, prevClientYmd });
        logTrialEvent(db, "trial_date_tamper_block", ids, { reason: "device-date-tamper", prevClientYmd, serverDateYmd: nowYmd, clientDateYmd: ids.clientDateYmd });
        return { blocked: true, reason: "device-date-tamper", payload: blockPayload(ids.app, "device-date-tamper", nowYmd) };
      }
    }

    const distinctInstallIds = new Set(relatedTrials.map((t) => normalizeId(t.installId)).filter(Boolean));
    const distinctFp = new Set(relatedTrials.map((t) => normalizeId(t.fpHash)).filter(Boolean));
    if (distinctInstallIds.size > 1 || distinctFp.size > 2) {
      markRevoked(currentTrial, "multi-identity-abuse", nowYmd);
      markBlocked(currentTrial, "multi-identity-abuse", nowYmd);
      ensureBlock(db, ids, "multi-identity-abuse", { nowYmd, installIds: Array.from(distinctInstallIds), fpHashes: Array.from(distinctFp) });
      logTrialEvent(db, "trial_multi_identity_block", ids, { reason: "multi-identity-abuse" });
      return { blocked: true, reason: "multi-identity-abuse", payload: blockPayload(ids.app, "multi-identity-abuse", nowYmd) };
    }
  }

  return { blocked: false };
}

router.get("/claim", (req, res) => {
  const ids = parseIdentity(req);
  const app = ids.app;

  if (!app) {
    return res.status(400).json({ ok: false, message: "Missing/invalid app. Use app=SPNG, app=RMP, app=STMN or app=CPNG" });
  }
  if (!hasPrimaryIdentity(ids)) {
    return res.status(400).json({ ok: false, message: "Missing device identity (fpHash/androidId/deviceId)" });
  }

  const db = readDB();
  ensureTrialCollections(db);
  const nowYmd = ymdFromDate(new Date());
  const trialDays = Number(process.env.TRIAL_DAYS || "7");

  antiAbuseCleanup(db, app);

  const hit = selectExistingTrial(db.trials, app, ids);
  let idx = hit ? hit.idx : -1;
  let t = hit ? hit.t : null;

  const abuse = getAbuseState(db, ids, nowYmd, t);
  if (abuse.blocked) {
    writeDB(db);
    return res.status(403).json(abuse.payload);
  }

  if (!t) {
    const startYmd = nowYmd;
    const expiryYmd = addDaysUTC(startYmd, trialDays);
    t = {
      id: `${app}-${ids.fpHash || ids.androidId || ids.deviceId}`,
      app,
      fpHash: ids.fpHash,
      deviceId: ids.deviceId,
      androidId: ids.androidId,
      installId: ids.installId,
      startYmd,
      expiryYmd,
      consumed: true,
      revoked: false,
      blocked: false,
      revokeReason: "",
      blockReason: "",
      createdAt: nowTs(),
      updatedAt: nowTs(),
      lastSeenAt: nowTs(),
      firstClientDateYmd: Number(ids.clientDateYmd || 0),
      lastClientDateYmd: Number(ids.clientDateYmd || 0),
      seenCount: 1,
      lastIp: ids.ip,
      lastUserAgent: ids.userAgent
    };
    db.trials.push(t);
    ensureConsumedKeys(db, ids, t, "ACTIVE");
    logTrialEvent(db, "trial_claim_created", ids, { trialId: t.id, startYmd, expiryYmd });
    writeDB(db);
    return res.json(responsePayload(nowYmd, app, t));
  }

  enrichTrialRecord(t, ids);
  if (!t.firstClientDateYmd && ids.clientDateYmd) t.firstClientDateYmd = ids.clientDateYmd;
  db.trials[idx] = t;
  ensureConsumedKeys(db, ids, t);

  const payload = responsePayload(nowYmd, app, t);
  if (payload.status === "EXPIRED" || payload.status === "REVOKED" || payload.status === "BLOCKED") {
    ensureBlock(db, ids, payload.reason || payload.status.toLowerCase(), { nowYmd });
    logTrialEvent(db, "trial_claim_denied", ids, { trialId: t.id, status: payload.status, reason: payload.reason || payload.status.toLowerCase() });
    writeDB(db);
    return res.status(403).json(payload);
  }

  logTrialEvent(db, "trial_claim_reused", ids, { trialId: t.id, expiryYmd: t.expiryYmd });
  writeDB(db);
  return res.json(payload);
});

router.get("/status", (req, res) => {
  const ids = parseIdentity(req);
  const app = ids.app;

  if (!app || !hasPrimaryIdentity(ids)) {
    return res.status(400).json({ ok: false, message: "Missing app or device identity" });
  }

  const db = readDB();
  ensureTrialCollections(db);
  const nowYmd = ymdFromDate(new Date());

  antiAbuseCleanup(db, app);

  const hit = selectExistingTrial(db.trials || [], app, ids);
  const t = hit ? hit.t : null;

  const abuse = getAbuseState(db, ids, nowYmd, t);
  if (abuse.blocked) {
    writeDB(db);
    return res.status(403).json(abuse.payload);
  }

  if (!t) {
    logTrialEvent(db, "trial_status_none", ids, {});
    writeDB(db);
    return res.json({ ok: true, app, status: "NONE", message: trialMessage("NONE") });
  }

  enrichTrialRecord(t, ids);
  db.trials[hit.idx] = t;
  ensureConsumedKeys(db, ids, t);

  const payload = responsePayload(nowYmd, app, t);
  logTrialEvent(db, "trial_status_checked", ids, { trialId: t.id, status: payload.status });
  writeDB(db);

  if (payload.status === "EXPIRED" || payload.status === "REVOKED" || payload.status === "BLOCKED") {
    return res.status(403).json(payload);
  }
  return res.json(payload);
});


router.get("/admin/summary", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const nowYmd = ymdFromDate(new Date());
  let items = db.trials.map((t) => ({ ...t, status: computeStatus(nowYmd, t) }));
  if (app) items = items.filter((t) => t.app === app);

  const stats = {
    total: items.length,
    active: 0,
    expired: 0,
    revoked: 0,
    blocked: 0,
    todayConsumed: 0,
    blocks: 0,
    audits: 0,
  };

  for (const t of items) {
    const st = String(t.status || '').toUpperCase();
    if (st === 'ACTIVE') stats.active += 1;
    else if (st === 'EXPIRED') stats.expired += 1;
    else if (st === 'REVOKED') stats.revoked += 1;
    else if (st === 'BLOCKED') stats.blocked += 1;
    if (Number(t.createdAt || 0) >= (Date.now() - 24 * 60 * 60 * 1000)) stats.todayConsumed += 1;
  }

  stats.blocks = [...db.trialBlocks].filter((x) => x && x.active !== false && (!app || x.app === app)).length;
  stats.audits = [...db.trialAuditLogs].filter((x) => !app || x.app === app).length;

  return res.json({ ok: true, app: app || '', stats, serverTime: nowTs() });
});

router.get("/admin/consumed", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const statusFilter = normalizeId(req.query.status).toUpperCase();
  const q = normalizeId(req.query.q).toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const nowYmd = ymdFromDate(new Date());

  let items = db.trials.map((t) => ({ ...t, status: computeStatus(nowYmd, t) }));
  if (app) items = items.filter((t) => t.app === app);
  if (statusFilter) items = items.filter((t) => t.status === statusFilter);
  if (q) {
    items = items.filter((t) => [t.id, t.fpHash, t.androidId, t.deviceId, t.installId, t.revokeReason, t.blockReason]
      .map((x) => String(x || "").toLowerCase())
      .some((x) => x.includes(q)));
  }

  items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return res.json({ ok: true, total, offset, limit, items: page, serverTime: nowTs() });
});

router.get("/admin/audit", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const type = normalizeId(req.query.type);
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  let items = [...db.trialAuditLogs];
  if (app) items = items.filter((x) => x.app === app);
  if (type) items = items.filter((x) => x.type === type);
  const total = items.length;
  return res.json({ ok: true, total, offset, limit, items: items.slice(offset, offset + limit), serverTime: nowTs() });
});

router.get("/admin/blocks", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const q = normalizeId(req.query.q).toLowerCase();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 100)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  let items = [...db.trialBlocks].filter((x) => x && x.active !== false);
  if (app) items = items.filter((x) => x.app === app);
  if (q) items = items.filter((x) => [x.reason, x.fpHash, x.androidId, x.deviceId, x.installId].map((v) => String(v || "").toLowerCase()).some((v) => v.includes(q)));
  const total = items.length;
  return res.json({ ok: true, total, offset, limit, items: items.slice(offset, offset + limit), serverTime: nowTs() });
});


router.get("/admin/consumed-export", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const statusFilter = normalizeId(req.query.status).toUpperCase();
  const q = normalizeId(req.query.q).toLowerCase();
  const nowYmd = ymdFromDate(new Date());
  let items = db.trials.map((t) => ({ ...t, status: computeStatus(nowYmd, t) }));
  if (app) items = items.filter((t) => t.app === app);
  if (statusFilter) items = items.filter((t) => t.status === statusFilter);
  if (q) items = items.filter((t) => [t.id, t.fpHash, t.androidId, t.deviceId, t.installId, t.revokeReason, t.blockReason].map((x) => String(x || "").toLowerCase()).some((x) => x.includes(q)));
  items.sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  const rows = items.map((t) => ({
    id: t.id || "",
    app: t.app || "",
    status: t.status || "",
    deviceId: t.deviceId || "",
    androidId: t.androidId || "",
    fpHash: t.fpHash || "",
    installId: t.installId || "",
    startYmd: t.startYmd || 0,
    expiryYmd: t.expiryYmd || 0,
    consumed: !!t.consumed,
    revoked: !!t.revoked,
    blocked: !!t.blocked,
    revokeReason: t.revokeReason || "",
    blockReason: t.blockReason || "",
    createdAt: t.createdAt || 0,
    updatedAt: t.updatedAt || 0,
    lastSeenAt: t.lastSeenAt || 0,
  }));
  const csv = toCsv(rows, ["id", "app", "status", "deviceId", "androidId", "fpHash", "installId", "startYmd", "expiryYmd", "consumed", "revoked", "blocked", "revokeReason", "blockReason", "createdAt", "updatedAt", "lastSeenAt"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${app ? app.toLowerCase() : 'trial'}_trials_${nowTs()}.csv"`);
  return res.send(csv);
});

router.get("/admin/audit-export", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const type = normalizeId(req.query.type);
  let items = [...db.trialAuditLogs];
  if (app) items = items.filter((x) => x.app === app);
  if (type) items = items.filter((x) => x.type === type);
  const rows = items.map((x) => ({
    id: x.id || "",
    app: x.app || "",
    type: x.type || "",
    deviceId: x.deviceId || "",
    androidId: x.androidId || "",
    fpHash: x.fpHash || "",
    installId: x.installId || "",
    clientDateYmd: x.clientDateYmd || 0,
    ip: x.ip || "",
    createdAt: x.createdAt || 0,
    meta: JSON.stringify(x.meta || {}),
  }));
  const csv = toCsv(rows, ["id", "app", "type", "deviceId", "androidId", "fpHash", "installId", "clientDateYmd", "ip", "createdAt", "meta"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${app ? app.toLowerCase() : 'trial'}_audit_${nowTs()}.csv"`);
  return res.send(csv);
});

router.get("/admin/blocks-export", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.query.app);
  const q = normalizeId(req.query.q).toLowerCase();
  let items = [...db.trialBlocks];
  if (app) items = items.filter((x) => x.app === app);
  if (q) items = items.filter((x) => [x.reason, x.fpHash, x.androidId, x.deviceId, x.installId].map((v) => String(v || "").toLowerCase()).some((v) => v.includes(q)));
  const rows = items.map((x) => ({
    id: x.id || "",
    app: x.app || "",
    active: x.active !== false,
    reason: x.reason || "",
    deviceId: x.deviceId || "",
    androidId: x.androidId || "",
    fpHash: x.fpHash || "",
    installId: x.installId || "",
    createdAt: x.createdAt || 0,
    updatedAt: x.updatedAt || 0,
    meta: JSON.stringify(x.meta || {}),
  }));
  const csv = toCsv(rows, ["id", "app", "active", "reason", "deviceId", "androidId", "fpHash", "installId", "createdAt", "updatedAt", "meta"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${app ? app.toLowerCase() : 'trial'}_blocks_${nowTs()}.csv"`);
  return res.send(csv);
});

router.post("/admin/revoke", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const ids = {
    app: normalizeApp(req.body?.app || req.query.app),
    deviceId: normalizeId(req.body?.deviceId),
    fpHash: normalizeId(req.body?.fpHash),
    androidId: normalizeId(req.body?.androidId),
    installId: normalizeId(req.body?.installId),
    clientDateYmd: 0,
    ip: normalizeId(req.ip),
    userAgent: normalizeId(req.header("user-agent")),
  };
  const reason = normalizeId(req.body?.reason) || "manual-revoke";
  if (!ids.app) return res.status(400).json({ ok: false, error: "app required" });
  const hit = selectExistingTrial(db.trials, ids.app, ids);
  if (!hit || !hit.t) return res.status(404).json({ ok: false, error: "trial not found" });
  const nowYmd = ymdFromDate(new Date());
  const t = hit.t;
  markRevoked(t, reason, nowYmd);
  ensureConsumedKeys(db, ids, t, "REVOKED");
  ensureBlock(db, ids, reason, { nowYmd, action: "manual-revoke", trialId: t.id || "" });
  logTrialEvent(db, "trial_admin_revoke", ids, { reason, trialId: t.id || "" });
  writeDB(db);
  return res.json({ ok: true, trial: { ...t, status: computeStatus(nowYmd, t) }, serverTime: nowTs() });
});

router.post("/admin/blacklist", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const ids = {
    app: normalizeApp(req.body?.app || req.query.app),
    deviceId: normalizeId(req.body?.deviceId),
    fpHash: normalizeId(req.body?.fpHash),
    androidId: normalizeId(req.body?.androidId),
    installId: normalizeId(req.body?.installId),
    clientDateYmd: 0,
    ip: normalizeId(req.ip),
    userAgent: normalizeId(req.header("user-agent")),
  };
  const reason = normalizeId(req.body?.reason) || "manual-blacklist";
  if (!ids.app) return res.status(400).json({ ok: false, error: "app required" });
  if (!hasPrimaryIdentity(ids) && !ids.installId) return res.status(400).json({ ok: false, error: "identity required" });
  const row = ensureBlock(db, ids, reason, { source: "admin-blacklist" });
  const hit = selectExistingTrial(db.trials, ids.app, ids);
  if (hit && hit.t) {
    markBlocked(hit.t, reason, ymdFromDate(new Date()));
    ensureConsumedKeys(db, ids, hit.t, "BLOCKED");
  }
  logTrialEvent(db, "trial_admin_blacklist", ids, { reason, blockId: row?.id || "", trialId: hit?.t?.id || "" });
  writeDB(db);
  return res.json({ ok: true, block: row || null, serverTime: nowTs() });
});

router.post("/admin/unblock", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const ids = {
    app: normalizeApp(req.body?.app || req.query.app),
    deviceId: normalizeId(req.body?.deviceId),
    fpHash: normalizeId(req.body?.fpHash),
    androidId: normalizeId(req.body?.androidId),
    installId: normalizeId(req.body?.installId),
    clientDateYmd: 0,
    ip: normalizeId(req.ip),
    userAgent: normalizeId(req.header("user-agent")),
  };
  if (!ids.app) return res.status(400).json({ ok: false, error: "app required" });
  const reason = normalizeId(req.body?.reason) || "manual-unblock";
  let changed = 0;
  for (const b of db.trialBlocks) {
    if (!b || b.active === false) continue;
    if (blockMatchesIdentity(b, ids)) {
      b.active = false;
      b.updatedAt = nowTs();
      b.clearedReason = reason;
      changed += 1;
    }
  }
  logTrialEvent(db, "trial_admin_unblock", ids, { reason, changed });
  writeDB(db);
  return res.json({ ok: true, changed, note: "Existing consumed-trial ledger remains intact.", serverTime: nowTs() });
});


router.post("/admin/cleanup", requireDevKey, (req, res) => {
  const db = readDB();
  ensureTrialCollections(db);
  const app = normalizeApp(req.body?.app || req.query.app);
  const summary = antiAbuseCleanup(db, app || "");
  logTrialEvent(db, "trial_admin_cleanup", { app, fpHash: "", androidId: "", deviceId: "", installId: "", clientDateYmd: 0, ip: normalizeId(req.ip), userAgent: normalizeId(req.header("user-agent")) }, summary);
  writeDB(db);
  return res.json({ ok: true, summary, serverTime: nowTs() });
});

export default router;
