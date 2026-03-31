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
  if (a === "STMN" || a === "STAYMASTER" || a === "STAYMASTERNG" || a === "STMNG") return "STMN";
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

function ensureTrialCollections(db) {
  db.trials = Array.isArray(db.trials) ? db.trials : [];
  db.trialAuditLogs = Array.isArray(db.trialAuditLogs) ? db.trialAuditLogs : [];
  db.trialBlocks = Array.isArray(db.trialBlocks) ? db.trialBlocks : [];
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

function trialMatchesIdentity(t, ids) {
  return scoreTrialMatch(t, ids) > 0;
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
      if (backward || diffAbs > 3) {
        markRevoked(currentTrial, "device-date-tamper", nowYmd);
        markBlocked(currentTrial, "device-date-tamper", nowYmd);
        ensureBlock(db, ids, "device-date-tamper", { nowYmd, clientDateYmd: ids.clientDateYmd, prevClientYmd });
        logTrialEvent(db, "trial_date_tamper_block", ids, { reason: "device-date-tamper", prevClientYmd });
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
    return res.status(400).json({ ok: false, message: "Missing/invalid app. Use app=SPNG, app=RMP or app=STMN" });
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
    logTrialEvent(db, "trial_claim_created", ids, { trialId: t.id, startYmd, expiryYmd });
    writeDB(db);
    return res.json(responsePayload(nowYmd, app, t));
  }

  enrichTrialRecord(t, ids);
  if (!t.firstClientDateYmd && ids.clientDateYmd) t.firstClientDateYmd = ids.clientDateYmd;
  db.trials[idx] = t;

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

  const payload = responsePayload(nowYmd, app, t);
  logTrialEvent(db, "trial_status_checked", ids, { trialId: t.id, status: payload.status });
  writeDB(db);

  if (payload.status === "EXPIRED" || payload.status === "REVOKED" || payload.status === "BLOCKED") {
    return res.status(403).json(payload);
  }
  return res.json(payload);
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
