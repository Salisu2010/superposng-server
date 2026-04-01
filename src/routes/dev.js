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
function normalizeApp(v) {
  const a = trim(v).toUpperCase();
  if (!a) return "SPNG";
  if (a === "SPNG" || a === "SUPERPOSNG") return "SPNG";
  if (a === "RMP" || a === "REPAIRMASTERPRO") return "RMP";
  if (a === "STMN" || a === "STMN" || a === "SMTN" || a === "STAYMASTER" || a === "STAYMASTERNG") return "STMN";
  if (a === "CPNG" || a === "CLP" || a === "CLINICPRONG" || a === "CLINICPRO" || a === "CLINIC_PRO_NG") return "CPNG";
  return "SPNG";
}

function ensureDevCollections(db) {
  db.licenses = Array.isArray(db.licenses) ? db.licenses : [];
  db.pendingActivations = Array.isArray(db.pendingActivations) ? db.pendingActivations : [];
  db.licenseAuditLogs = Array.isArray(db.licenseAuditLogs) ? db.licenseAuditLogs : [];
}

function logLicenseAudit(db, type, payload = {}) {
  ensureDevCollections(db);
  db.licenseAuditLogs.unshift({
    id: `LLOG-${now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`,
    type,
    createdAt: now(),
    ...payload,
  });
  if (db.licenseAuditLogs.length > 5000) db.licenseAuditLogs.length = 5000;
}

function csvEscape(v) {
  const s = String(v === null || v === undefined ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows, headers) {
  const all = [headers.join(",")];
  for (const row of rows) {
    all.push(headers.map((h) => csvEscape(row?.[h] ?? "")).join(","));
  }
  return all.join("\n");
}



function startOfUtcDay(offsetDays = 0) {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + Number(offsetDays || 0));
  return d.getTime();
}

function monthKey(ts) {
  const d = new Date(Number(ts || 0));
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function parseDateOrTs(v, endOfDay = false) {
  const raw = trim(v);
  if (!raw) return 0;
  if (/^\d{13}$/.test(raw)) return Number(raw);
  if (/^\d{10}$/.test(raw)) return Number(raw) * 1000;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, m, d] = raw.split('-').map((x) => parseInt(x, 10));
    return Date.UTC(y, m - 1, d, endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
  }
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}
function inTsRange(ts, fromTs = 0, toTs = 0) {
  const n = Number(ts || 0);
  if (!n) return !fromTs && !toTs;
  if (fromTs && n < fromTs) return false;
  if (toTs && n > toTs) return false;
  return true;
}
function buildTrendBuckets(fromTs = 0, toTs = 0) {
  const end = toTs || now();
  const start = fromTs || (() => {
    const d = new Date(end);
    d.setUTCDate(1);
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCMonth(d.getUTCMonth() - 5);
    return d.getTime();
  })();
  const diffDays = Math.max(1, Math.ceil((end - start) / 86400000));
  const out = [];
  if (diffDays <= 31) {
    for (let ts = startOfUtcDay(Math.floor((start - startOfUtcDay(0)) / 86400000)); ts <= end; ts += 86400000) {
      const d = new Date(ts);
      const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}-${String(d.getUTCDate()).padStart(2,'0')}`;
      out.push({ key, label: key, startTs: ts, endTs: ts + 86400000 - 1, SPNG:0, CPNG:0, STMN:0, RMP:0, revoke:0, blocked:0 });
    }
    return out.filter((b) => b.endTs >= start && b.startTs <= end);
  }
  if (diffDays <= 120) {
    let ts = start;
    while (ts <= end) {
      const endTs = Math.min(end, ts + (7 * 86400000) - 1);
      const label = `${new Date(ts).toISOString().slice(0,10)} → ${new Date(endTs).toISOString().slice(0,10)}`;
      out.push({ key: `${ts}`, label, startTs: ts, endTs, SPNG:0, CPNG:0, STMN:0, RMP:0, revoke:0, blocked:0 });
      ts += 7 * 86400000;
    }
    return out;
  }
  const d = new Date(start);
  d.setUTCDate(1);
  d.setUTCHours(0,0,0,0);
  while (d.getTime() <= end) {
    const s = d.getTime();
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,'0')}`;
    const next = new Date(s);
    next.setUTCMonth(next.getUTCMonth() + 1);
    const e = next.getTime() - 1;
    out.push({ key, label: key, startTs: s, endTs: e, SPNG:0, CPNG:0, STMN:0, RMP:0, revoke:0, blocked:0 });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out.filter((b) => b.endTs >= start && b.startTs <= end);
}

function ensureRestoreAudit(db) {
  db.accountRestoreAudit = Array.isArray(db.accountRestoreAudit) ? db.accountRestoreAudit : [];
}
function collectRestoreAudit(db) {
  ensureRestoreAudit(db);
  return db.accountRestoreAudit.map((x) => ({
    ...x,
    app: normalizeApp(x?.app || 'SPNG'),
    action: trim(x?.action || ''),
    entityType: trim(x?.entityType || ''),
    entityId: trim(x?.entityId || ''),
    entityCode: trim(x?.entityCode || ''),
    entityName: trim(x?.entityName || ''),
    ownerPhone: trim(x?.ownerPhone || ''),
    ownerEmail: trim(x?.ownerEmail || ''),
    deviceId: trim(x?.deviceId || ''),
    reuseReason: trim(x?.reuseReason || ''),
    reused: x?.reused === true,
    createdAt: Number(x?.createdAt || x?.updatedAt || 0),
    updatedAt: Number(x?.updatedAt || x?.createdAt || 0),
  }));
}
function filterRestoreAudit(rows, { appFilter = '', q = '', reason = '', fromTs = 0, toTs = 0 } = {}) {
  const qq = trim(q).toLowerCase();
  const rr = trim(reason).toLowerCase();
  return rows.filter((x) => {
    const appOk = !appFilter || normalizeApp(x?.app || 'SPNG') === appFilter;
    if (!appOk) return false;
    const ts = Number(x?.createdAt || x?.updatedAt || 0);
    if ((fromTs || toTs) && !inTsRange(ts, fromTs, toTs)) return false;
    if (rr) {
      const hayReason = [x?.reuseReason, x?.action].map((v) => trim(v).toLowerCase()).join(' ');
      if (!hayReason.includes(rr)) return false;
    }
    if (!qq) return true;
    const hay = [x?.app, x?.entityType, x?.entityId, x?.entityCode, x?.entityName, x?.ownerPhone, x?.ownerEmail, x?.deviceId, x?.reuseReason, x?.action].map((v) => trim(v).toLowerCase()).join(' ');
    return hay.includes(qq);
  });
}

function collectAllLicenses(db) {
  const out = [];
  const base = Array.isArray(db.licenses) ? db.licenses : [];
  for (const x of base) out.push({ ...x, app: normalizeApp(x?.app || "SPNG") });
  const rmp = Array.isArray(db.rmpLicenses) ? db.rmpLicenses : [];
  for (const x of rmp) out.push({ ...x, app: "RMP" });
  const stmn = Array.isArray(db.stmnLicenses) ? db.stmnLicenses : [];
  for (const x of stmn) out.push({ ...x, app: "STMN" });
  return out;
}

function isActiveLicense(x, nowTs = now()) {
  const status = trim(x?.status).toUpperCase();
  if (status !== "ACTIVE" && status !== "ISSUED") return false;
  const exp = Number(x?.expiresAt || 0);
  if (exp > 0 && exp < nowTs) return false;
  return true;
}

function normalizeReason(v) {
  return trim(v).replace(/\s+/g, " ");
}



function firstNonEmpty(...vals) {
  for (const v of vals) {
    const t = trim(v);
    if (t) return t;
  }
  return "";
}
function extractDeviceIdentity(row = {}) {
  const deviceId = firstNonEmpty(row?.deviceKey, row?.boundDeviceId, row?.deviceId, row?.ownerDeviceId, row?.ownerAndroidId, row?.targetDeviceId);
  const androidId = firstNonEmpty(row?.androidId, row?.ownerAndroidId);
  const installId = firstNonEmpty(row?.installId, row?.installationId);
  const fpHash = firstNonEmpty(row?.fpHash, row?.devHash, row?.fingerprintHash);
  const primary = firstNonEmpty(deviceId, androidId, installId, fpHash);
  return {
    deviceKey: primary,
    deviceId,
    androidId,
    installId,
    fpHash,
  };
}
function extractIdentitySet(row = {}) {
  const ids = extractDeviceIdentity(row);
  return [ids.deviceKey, ids.deviceId, ids.androidId, ids.installId, ids.fpHash].filter(Boolean);
}
function collectDeviceSignals(db, { appFilter = '', fromTs = 0, toTs = 0 } = {}) {
  const pushSignal = (out, app, row = {}, source = '', extra = {}) => {
    const ids = extractDeviceIdentity(row);
    const ts = Number(row?.updatedAt || row?.createdAt || row?.startAt || row?.expiresAt || 0);
    if ((fromTs || toTs) && !inTsRange(ts, fromTs, toTs)) return;
    if (!ids.deviceKey && !ids.deviceId && !ids.androidId && !ids.installId && !ids.fpHash) return;
    const appNorm = normalizeApp(app || row?.app || 'SPNG');
    if (appFilter && appNorm !== appFilter) return;
    out.push({
      app: appNorm,
      source,
      createdAt: ts,
      updatedAt: ts,
      ownerPhone: trim(row?.ownerPhone || row?.phone || row?.contactPhone || ''),
      ownerEmail: trim(row?.ownerEmail || row?.email || row?.contactEmail || ''),
      shopId: trim(row?.shopId || row?.clinicId || row?.hotelId || row?.propertyId || row?.entityId || ''),
      licenseId: trim(row?.licenseId || ''),
      token: trim(row?.token || ''),
      status: trim(row?.status || ''),
      trialType: trim(row?.type || ''),
      ...ids,
      ...extra,
    });
  };

  const out = [];
  for (const row of collectAllLicenses(db)) pushSignal(out, row?.app || 'SPNG', row, 'license');
  for (const row of (Array.isArray(db.pendingActivations) ? db.pendingActivations : [])) pushSignal(out, row?.app || 'SPNG', row, 'pending');
  for (const row of (Array.isArray(db.trials) ? db.trials : [])) pushSignal(out, row?.app || 'SPNG', row, 'trial');
  for (const row of (Array.isArray(db.trialAuditLogs) ? db.trialAuditLogs : [])) pushSignal(out, row?.app || 'SPNG', row, 'trialAudit', { eventType: trim(row?.type || '') });
  for (const row of (Array.isArray(db.trialBlocks) ? db.trialBlocks : [])) pushSignal(out, row?.app || 'SPNG', row, 'trialBlock', { eventType: trim(row?.reason || row?.type || 'block') });
  for (const row of collectRestoreAudit(db)) pushSignal(out, row?.app || 'SPNG', row, 'restore', { reused: row?.reused === true, action: trim(row?.action || '') });
  for (const row of (Array.isArray(db.licenseAuditLogs) ? db.licenseAuditLogs : [])) pushSignal(out, row?.app || 'SPNG', row, 'licenseAudit', { eventType: trim(row?.type || '') });
  for (const row of (Array.isArray(db.devices) ? db.devices : [])) pushSignal(out, row?.app || 'SPNG', row, 'devices');
  return out;
}
function buildDeviceIntelligence(db, { appFilter = '', fromTs = 0, toTs = 0 } = {}) {
  const signals = collectDeviceSignals(db, { appFilter, fromTs, toTs });
  const devices = new Map();
  for (const row of signals) {
    const app = normalizeApp(row?.app || 'SPNG');
    const key = `${app}|${trim(row?.deviceKey || '')}`;
    if (!trim(row?.deviceKey)) continue;
    let entry = devices.get(key);
    if (!entry) {
      entry = {
        app,
        deviceKey: trim(row?.deviceKey),
        deviceId: trim(row?.deviceId),
        androidId: trim(row?.androidId),
        installId: trim(row?.installId),
        fpHash: trim(row?.fpHash),
        firstSeenAt: Number(row?.createdAt || row?.updatedAt || 0),
        lastSeenAt: Number(row?.updatedAt || row?.createdAt || 0),
        sources: new Set(),
        phones: new Set(),
        emails: new Set(),
        entities: new Set(),
        appsSeen: new Set([app]),
        eventTypes: new Set(),
        tokenSet: new Set(),
        licenseSet: new Set(),
        identitySet: new Set(),
        sourceRows: 0,
        blockedHits: 0,
        tamperHits: 0,
        revokeHits: 0,
        restoreHits: 0,
        multiIdentityHints: 0,
      };
      devices.set(key, entry);
    }
    entry.firstSeenAt = entry.firstSeenAt ? Math.min(entry.firstSeenAt, Number(row?.createdAt || row?.updatedAt || 0) || entry.firstSeenAt) : Number(row?.createdAt || row?.updatedAt || 0);
    entry.lastSeenAt = Math.max(entry.lastSeenAt || 0, Number(row?.updatedAt || row?.createdAt || 0));
    entry.sources.add(trim(row?.source || 'unknown'));
    entry.sourceRows += 1;
    if (trim(row?.ownerPhone)) entry.phones.add(trim(row.ownerPhone));
    if (trim(row?.ownerEmail)) entry.emails.add(trim(row.ownerEmail));
    if (trim(row?.shopId)) entry.entities.add(trim(row.shopId));
    if (trim(row?.token)) entry.tokenSet.add(trim(row.token));
    if (trim(row?.licenseId)) entry.licenseSet.add(trim(row.licenseId));
    for (const ident of [row?.deviceId, row?.androidId, row?.installId, row?.fpHash]) if (trim(ident)) entry.identitySet.add(trim(ident));
    const evt = trim(row?.eventType || row?.trialType || row?.action || row?.status || '');
    if (evt) entry.eventTypes.add(evt);
    if (/(block|blacklist|deny|denied)/i.test(evt) || row?.source === 'trialBlock') entry.blockedHits += 1;
    if (/(tamper|reinstall|date|time|multi_identity)/i.test(evt)) entry.tamperHits += 1;
    if (/(revoke|reset_binding)/i.test(evt)) entry.revokeHits += 1;
    if (row?.reused === true || /restore/i.test(evt)) entry.restoreHits += 1;
    if (entry.identitySet.size > 2) entry.multiIdentityHints = entry.identitySet.size - 2;
  }

  const rows = Array.from(devices.values()).map((entry) => {
    const phoneCount = entry.phones.size;
    const emailCount = entry.emails.size;
    const accountCount = new Set([...entry.phones, ...entry.emails, ...entry.entities]).size;
    const clusterKey = entry.fpHash || entry.androidId || entry.installId || entry.deviceId || entry.deviceKey;
    const suspiciousReasons = [];
    let fraudScore = 0;
    if (entry.blockedHits > 0) { fraudScore += Math.min(40, entry.blockedHits * 10); suspiciousReasons.push(`blocked ${entry.blockedHits}x`); }
    if (entry.tamperHits > 0) { fraudScore += Math.min(30, entry.tamperHits * 10); suspiciousReasons.push(`tamper ${entry.tamperHits}x`); }
    if (accountCount > 1) { fraudScore += Math.min(25, (accountCount - 1) * 8); suspiciousReasons.push(`${accountCount} accounts`); }
    if (entry.licenseSet.size > 1) { fraudScore += Math.min(20, (entry.licenseSet.size - 1) * 6); suspiciousReasons.push(`${entry.licenseSet.size} licenses`); }
    if (entry.identitySet.size > 2) { fraudScore += Math.min(15, (entry.identitySet.size - 2) * 4); suspiciousReasons.push(`${entry.identitySet.size} identities`); }
    if (entry.revokeHits > 0) { fraudScore += Math.min(15, entry.revokeHits * 5); suspiciousReasons.push(`revoked ${entry.revokeHits}x`); }
    fraudScore = Math.max(0, Math.min(100, fraudScore));
    const riskLevel = fraudScore >= 70 ? 'HIGH' : fraudScore >= 40 ? 'MEDIUM' : 'LOW';
    return {
      app: entry.app,
      clusterKey,
      deviceKey: entry.deviceKey,
      deviceId: entry.deviceId,
      androidId: entry.androidId,
      installId: entry.installId,
      fpHash: entry.fpHash,
      firstSeenAt: entry.firstSeenAt,
      lastSeenAt: entry.lastSeenAt,
      sourceRows: entry.sourceRows,
      sources: Array.from(entry.sources),
      accountCount,
      phoneCount,
      emailCount,
      entityCount: entry.entities.size,
      tokenCount: entry.tokenSet.size,
      licenseCount: entry.licenseSet.size,
      identityCount: entry.identitySet.size,
      blockedHits: entry.blockedHits,
      tamperHits: entry.tamperHits,
      revokeHits: entry.revokeHits,
      restoreHits: entry.restoreHits,
      fraudScore,
      riskLevel,
      suspicious: fraudScore >= 40,
      suspiciousReasons,
      phones: Array.from(entry.phones).slice(0, 6),
      emails: Array.from(entry.emails).slice(0, 6),
      entities: Array.from(entry.entities).slice(0, 6),
    };
  });

  const clusterMap = new Map();
  for (const row of rows) {
    const key = `${row.app}|${row.clusterKey}`;
    const prev = clusterMap.get(key) || { app: row.app, clusterKey: row.clusterKey, devices: 0, accounts: new Set(), licenses: 0, blockedHits: 0, fraudMax: 0 };
    prev.devices += 1;
    row.phones.forEach((x) => prev.accounts.add(`P:${x}`));
    row.emails.forEach((x) => prev.accounts.add(`E:${x}`));
    row.entities.forEach((x) => prev.accounts.add(`N:${x}`));
    prev.licenses += Number(row.licenseCount || 0);
    prev.blockedHits += Number(row.blockedHits || 0);
    prev.fraudMax = Math.max(prev.fraudMax, Number(row.fraudScore || 0));
    clusterMap.set(key, prev);
  }
  const clusters = Array.from(clusterMap.values())
    .map((x) => ({ app: x.app, clusterKey: x.clusterKey, deviceCount: x.devices, accountCount: x.accounts.size, licenseCount: x.licenses, blockedHits: x.blockedHits, fraudScore: x.fraudMax }))
    .sort((a, b) => (b.deviceCount - a.deviceCount) || (b.accountCount - a.accountCount) || (b.fraudScore - a.fraudScore));

  const suspiciousDevices = rows.filter((x) => x.suspicious).sort((a, b) => (b.fraudScore - a.fraudScore) || (b.blockedHits - a.blockedHits) || (b.lastSeenAt - a.lastSeenAt));
  const multiAccountDevices = rows.filter((x) => x.accountCount > 1).sort((a, b) => (b.accountCount - a.accountCount) || (b.fraudScore - a.fraudScore));
  const fraudScores = [...rows].sort((a, b) => (b.fraudScore - a.fraudScore) || (b.lastSeenAt - a.lastSeenAt));
  const perApp = {};
  for (const app of ['SPNG', 'CPNG', 'STMN', 'RMP']) {
    const list = rows.filter((x) => x.app === app);
    perApp[app] = {
      devices: list.length,
      suspicious: list.filter((x) => x.suspicious).length,
      multiAccount: list.filter((x) => x.accountCount > 1).length,
      clusters: clusters.filter((x) => x.app === app && x.deviceCount > 0).length,
      avgFraudScore: list.length ? Math.round(list.reduce((n, x) => n + Number(x.fraudScore || 0), 0) / list.length) : 0,
    };
  }
  return {
    totalDevices: rows.length,
    suspiciousCount: suspiciousDevices.length,
    multiAccountCount: multiAccountDevices.length,
    clusterCount: clusters.length,
    rows,
    suspiciousDevices,
    multiAccountDevices,
    clusters,
    fraudScores,
    perApp,
  };
}
function buildDeviceDetail(db, { app = '', deviceKey = '' } = {}) {
  const appNorm = normalizeApp(app || 'SPNG');
  const intel = buildDeviceIntelligence(db, { appFilter: appNorm });
  const row = intel.rows.find((x) => trim(x.deviceKey) === trim(deviceKey)) || null;
  if (!row) return null;
  const idSet = new Set([row.deviceKey, row.deviceId, row.androidId, row.installId, row.fpHash].map(trim).filter(Boolean));
  const signals = collectDeviceSignals(db, { appFilter: appNorm }).filter((s) => {
    const vals = [s.deviceKey, s.deviceId, s.androidId, s.installId, s.fpHash].map(trim).filter(Boolean);
    return vals.some((v) => idSet.has(v));
  });
  const timeline = signals.map((s) => ({
    app: normalizeApp(s.app || appNorm),
    source: trim(s.source || ''),
    type: trim(s.eventType || s.status || s.trialType || s.source || 'event'),
    status: trim(s.status || ''),
    token: trim(s.token || ''),
    licenseId: trim(s.licenseId || ''),
    entityId: trim(s.shopId || ''),
    ownerPhone: trim(s.ownerPhone || ''),
    ownerEmail: trim(s.ownerEmail || ''),
    deviceKey: trim(s.deviceKey || ''),
    deviceId: trim(s.deviceId || ''),
    androidId: trim(s.androidId || ''),
    installId: trim(s.installId || ''),
    fpHash: trim(s.fpHash || ''),
    createdAt: Number(s.createdAt || s.updatedAt || 0),
    updatedAt: Number(s.updatedAt || s.createdAt || 0),
  })).sort((a,b)=>Number(b.updatedAt||0)-Number(a.updatedAt||0));
  const licenseIds = [...new Set(timeline.map((x)=>x.licenseId).filter(Boolean))];
  const tokens = [...new Set(timeline.map((x)=>x.token).filter(Boolean))];
  const entities = [...new Set(timeline.map((x)=>x.entityId).filter(Boolean))];
  const blocks = (Array.isArray(db.trialBlocks) ? db.trialBlocks : []).filter((b) => normalizeApp(b.app || 'SPNG') === appNorm).filter((b) => [b.deviceId,b.androidId,b.installId,b.fpHash].map(trim).some((v)=>idSet.has(v))).sort((a,b)=>Number(b.updatedAt||b.createdAt||0)-Number(a.updatedAt||a.createdAt||0));
  const audits = (Array.isArray(db.licenseAuditLogs) ? db.licenseAuditLogs : []).filter((a) => normalizeApp(a.app || 'SPNG') === appNorm).filter((a) => [a.deviceId,a.androidId,a.installId,a.fpHash].map(trim).some((v)=>idSet.has(v)) || (a.licenseId && licenseIds.includes(trim(a.licenseId))) || (a.token && tokens.includes(trim(a.token)))).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  const restores = collectRestoreAudit(db).filter((r) => normalizeApp(r.app || 'SPNG') === appNorm).filter((r) => [r.deviceId,r.androidId,r.installId,r.fpHash].map(trim).some((v)=>idSet.has(v)) || (r.entityId && entities.includes(trim(r.entityId)))).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  return {
    device: row,
    related: { licenseIds, tokens, entities },
    stats: { events: timeline.length, activeBlocks: blocks.filter((x)=>x.active!==false).length, licenseAudit: audits.length, restores: restores.length },
    timeline: timeline.slice(0, 250),
    blocks: blocks.slice(0, 50),
    licenseAudit: audits.slice(0, 50),
    restores: restores.slice(0, 50),
  };
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
// -------------------
r.post("/generate-token", requireDevKey, (req, res) => {
  const db = readDB();

  const plan = trim(req.body?.plan || "MONTHLY").toUpperCase();
  const app = normalizeApp(req.body?.app);
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
    app,
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
  const app = normalizeApp(req.body?.app);
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
      app,
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
  const app = normalizeApp(req.body?.app);
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
    app,
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
  const app = normalizeApp(req.query?.app || "SPNG");
  const limit = Math.max(1, Math.min(500, parseInt(req.query?.limit || "100", 10)));
  const offset = Math.max(0, parseInt(req.query?.offset || "0", 10));

  let items = Array.isArray(db.licenses) ? db.licenses.slice() : [];
  // Backward compatibility: normalize missing fields
  items = items.map((x) => {
    const o = x || {};
    if (!trim(o.plan)) o.plan = "LEGACY";
    if (!trim(o.status)) o.status = "ISSUED";
    if (!trim(o.app)) o.app = "SPNG";
    return o;
  });

  if (app) items = items.filter((x) => normalizeApp(x.app) === app);
  if (status) items = items.filter((x) => trim(x.status).toUpperCase() === status);
  if (plan) items = items.filter((x) => trim(x.plan).toUpperCase() === plan);
  if (q) {
    items = items.filter((x) => {
      const t = trim(x.token).toUpperCase();
      const id = trim(x.licenseId).toUpperCase();
      const did = trim(x.boundDeviceId).toUpperCase();
      const sid = trim(x.boundShopId).toUpperCase();
      const dh = trim(x.devHash).toUpperCase();
      const notes = trim(x.notes).toUpperCase();
      const fp = trim(x.fpHash).toUpperCase();
      return t.includes(q) || id.includes(q) || did.includes(q) || sid.includes(q) || dh.includes(q) || notes.includes(q) || fp.includes(q);
    });
  }

  const total = items.length;
  const page = items.slice(offset, offset + limit);
  res.json({ ok: true, total, offset, limit, items: page, serverTime: now() });
});


// -------------------------
// DEV: License summary (dashboard cards)
// -------------------------
r.get("/licenses-summary", requireDevKey, (req, res) => {
  const db = readDB();
  const app = normalizeApp(req.query?.app || "SPNG");
  const nowTsValue = now();
  let items = Array.isArray(db.licenses) ? db.licenses.slice() : [];
  items = items.map((x) => {
    const o = x || {};
    if (!trim(o.plan)) o.plan = "LEGACY";
    if (!trim(o.status)) o.status = "ISSUED";
    if (!trim(o.app)) o.app = "SPNG";
    return o;
  });
  if (app) items = items.filter((x) => normalizeApp(x.app) === app);

  const stats = {
    total: items.length,
    issued: 0,
    active: 0,
    revoked: 0,
    expired: 0,
    monthly: 0,
    yearly: 0,
    trial: 0,
    pending: 0,
    expiringSoon: 0,
  };

  for (const lic of items) {
    const status = trim(lic.status).toUpperCase();
    const plan = trim(lic.plan).toUpperCase();
    const exp = Number(lic.expiresAt || 0);
    if (status === "REVOKED") stats.revoked += 1;
    else if (exp > 0 && exp < nowTsValue) stats.expired += 1;
    else if (status === "ACTIVE") stats.active += 1;
    else stats.issued += 1;

    if (plan === "MONTHLY") stats.monthly += 1;
    else if (plan === "YEARLY") stats.yearly += 1;
    else if (plan === "TRIAL") stats.trial += 1;

    if (exp > nowTsValue && exp <= (nowTsValue + (30 * 24 * 60 * 60 * 1000))) stats.expiringSoon += 1;
  }

  stats.pending = (Array.isArray(db.pendingActivations) ? db.pendingActivations : [])
    .filter((p) => normalizeApp(p?.app || "SPNG") === app).length;

  return res.json({ ok: true, app, stats, serverTime: nowTsValue });
});



r.get("/licenses-export", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
  const app = normalizeApp(req.query?.app || "SPNG");
  const status = trim(req.query?.status).toUpperCase();
  const plan = trim(req.query?.plan).toUpperCase();
  const q = trim(req.query?.q).toUpperCase();
  let items = db.licenses.slice().map((x) => ({ ...x, app: normalizeApp(x?.app || "SPNG") }));
  if (app) items = items.filter((x) => x.app === app);
  if (status) items = items.filter((x) => trim(x.status).toUpperCase() === status);
  if (plan) items = items.filter((x) => trim(x.plan).toUpperCase() === plan);
  if (q) items = items.filter((x) => [x.licenseId, x.token, x.boundDeviceId, x.boundShopId, x.devHash, x.fpHash, x.notes].map((v) => trim(v).toUpperCase()).some((v) => v.includes(q)));
  const rows = items.map((x) => ({
    licenseId: x.licenseId || "",
    app: x.app || "",
    token: x.token || "",
    plan: x.plan || "",
    status: x.status || "",
    expiryYmd: x.expiryYmd || "",
    expiresAt: x.expiresAt || 0,
    boundDeviceId: x.boundDeviceId || "",
    boundShopId: x.boundShopId || "",
    devHash: x.devHash || "",
    fpHash: x.fpHash || "",
    activatedAt: x.activatedAt || 0,
    createdAt: x.createdAt || 0,
    notes: x.notes || "",
  }));
  const csv = toCsv(rows, ["licenseId", "app", "token", "plan", "status", "expiryYmd", "expiresAt", "boundDeviceId", "boundShopId", "devHash", "fpHash", "activatedAt", "createdAt", "notes"]);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${app.toLowerCase()}_licenses_${now()}.csv"`);
  return res.send(csv);
});

r.get("/audit", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
  const app = normalizeApp(req.query?.app || "SPNG");
  const limit = Math.max(1, Math.min(500, parseInt(req.query?.limit || "100", 10)));
  const offset = Math.max(0, parseInt(req.query?.offset || "0", 10));
  let items = db.licenseAuditLogs.slice();
  if (app) items = items.filter((x) => normalizeApp(x?.app || "SPNG") === app);
  return res.json({ ok: true, total: items.length, offset, limit, items: items.slice(offset, offset + limit), serverTime: now() });
});

// -------------------------
// DEV: Assign token to device (for claim)
// -------------------------
r.post("/assign-token", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
  const app = normalizeApp(req.body?.app);
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
        app,
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
    app: app || lic.app || "SPNG",
    shopId: shopId || lic.boundShopId || "",
    assignedAt: now()
  };
  db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
  db.pendingActivations.unshift(rec);
  logLicenseAudit(db, "assign_token", { app: normalizeApp(rec.app), licenseId: lic.licenseId || "", token: lic.token || "", deviceId, shopId: rec.shopId || "", plan: lic.plan || "" });
  writeDB(db);

  res.json({ ok: true, pending: rec, serverTime: now() });
});

r.post("/resend-activation", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
  const licenseId = trim(req.body?.licenseId);
  const token = trim(req.body?.token);
  const lic = findLicenseByAny(db, { licenseId, token, deviceId: trim(req.body?.deviceId) });
  if (!lic) return res.status(404).json({ ok: false, error: "license not found" });
  const deviceId = trim(req.body?.deviceId || lic.boundDeviceId);
  if (!deviceId) return res.status(400).json({ ok: false, error: "bound device not found" });
  if (trim(lic.status).toUpperCase() === "REVOKED") return res.status(400).json({ ok: false, error: "license revoked" });
  const rec = {
    deviceId,
    token: lic.token,
    plan: lic.plan,
    expiresAt: lic.expiresAt,
    app: normalizeApp(lic.app || "SPNG"),
    shopId: trim(req.body?.shopId || lic.boundShopId || ""),
    assignedAt: now(),
  };
  db.pendingActivations = db.pendingActivations.filter((x) => trim(x.deviceId) !== deviceId);
  db.pendingActivations.unshift(rec);
  logLicenseAudit(db, "resend_activation", { app: rec.app, licenseId: lic.licenseId || "", token: lic.token || "", deviceId, shopId: rec.shopId || "", plan: lic.plan || "" });
  writeDB(db);
  return res.json({ ok: true, pending: rec, serverTime: now() });
});

// -------------------------
// DEV: Search device / token / shop
// -------------------------
r.get("/search", requireDevKey, (req, res) => {
  const db = readDB();
  const app = normalizeApp(req.query?.app || "SPNG");
  const deviceId = trim(req.query?.deviceId);
  const token = trim(req.query?.token);
  const shopId = trim(req.query?.shopId);

  const matches = [];
  for (const lic of db.licenses) {
    if (normalizeApp(lic.app || "SPNG") !== app) continue;
    const hit =
      (token && trim(lic.token) === token) ||
      (deviceId && trim(lic.boundDeviceId) === deviceId) ||
      (shopId && trim(lic.boundShopId) === shopId);
    if (hit) matches.push(lic);
  }
  const pending = db.pendingActivations.filter((p) => normalizeApp(p.app || "SPNG") === app).filter((p) =>
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
  ensureDevCollections(db);
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

  logLicenseAudit(db, resetOnly ? "reset_binding" : "revoke_license", {
    app: normalizeApp(lic.app || "SPNG"),
    licenseId: lic.licenseId || "",
    token: lic.token || "",
    deviceId: lic.boundDeviceId || deviceId || "",
    reason,
    resetOnly,
  });
  writeDB(db);
  res.json({ ok: true, license: lic, serverTime: now() });
});

// -------------------------
// DEV: Extend expiry / Upgrade plan
// -------------------------
r.post("/extend", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
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
    app: normalizeApp(lic.app || "SPNG"),
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
  logLicenseAudit(db, "extend_license", {
    app: normalizeApp(newLic.app || "SPNG"),
    fromLicenseId: lic.licenseId || "",
    licenseId: newLic.licenseId || "",
    token: newLic.token || "",
    deviceId: device,
    months: addM,
    reason,
    plan,
  });
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

  const hasPaging =
    (req.query && (
      Object.prototype.hasOwnProperty.call(req.query, "page") ||
      Object.prototype.hasOwnProperty.call(req.query, "limit") ||
      Object.prototype.hasOwnProperty.call(req.query, "q") ||
      Object.prototype.hasOwnProperty.call(req.query, "show")
    ));

  const toShopRow = (s) => ({
    shopId: s.shopId,
    shopName: s.shopName,
    shopCode: s.shopCode,
    createdAt: Number(s.createdAt || 0),
    isMerged: s.isMerged === true,
    mergedInto: s.mergedInto || "",
    isDeleted: s.isDeleted === true,
    deletedAt: Number(s.deletedAt || 0),
  });

  let shops = (db.shops || []).map(toShopRow);

  // Backward compatible: if no query params, return full list (older UI needs this)
  if (!hasPaging) {
    return res.json({ ok: true, shops });
  }

  const qRaw = trim(req.query.q || "");
  const q = qRaw.toLowerCase();
  const show = trim(req.query.show || "active").toLowerCase(); // active|all|deleted

  // Filter by show mode
  shops = shops.filter((s) => {
    const isDel = s.isDeleted === true;
    if (show === "active") return !isDel;
    if (show === "deleted") return isDel;
    return true; // all
  });

  // Search
  if (q) {
    shops = shops.filter((s) => {
      const hay = `${s.shopName || ""} ${s.shopCode || ""} ${s.shopId || ""}`.toLowerCase();
      return hay.includes(q);
    });
  }

  // Sort: active first (unless show is deleted), createdAt desc, then name
  shops.sort((a, b) => {
    const ad = a.isDeleted === true ? 1 : 0;
    const bd = b.isDeleted === true ? 1 : 0;
    if (ad !== bd) return ad - bd;
    const ac = Number(a.createdAt || 0);
    const bc = Number(b.createdAt || 0);
    if (ac !== bc) return bc - ac;
    return String(a.shopName || "").localeCompare(String(b.shopName || ""));
  });

  let page = parseInt(req.query.page || "1", 10);
  let limit = parseInt(req.query.limit || "25", 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (!Number.isFinite(limit) || limit < 5) limit = 25;
  if (limit > 200) limit = 200;

  const total = shops.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  if (page > pages) page = pages;

  const start = (page - 1) * limit;
  const end = Math.min(total, start + limit);
  const slice = shops.slice(start, end);

  return res.json({
    ok: true,
    page,
    pages,
    limit,
    total,
    q: qRaw,
    show,
    shops: slice
  });
});


// Delete shop (Dev Portal)
// body: { shopIdOrCode, mode: 'soft'|'hard', reason? }
// - soft: marks shop as isDeleted=true (keeps data)
// - hard: permanently removes shop + all related rows
r.post("/shops/delete", requireDevKey, (req, res) => {
  const shopIdOrCode = trim(req.body?.shopIdOrCode);
  const mode = trim(req.body?.mode || "soft").toLowerCase();
  const reason = trim(req.body?.reason || "");

  if (!shopIdOrCode) return res.status(400).json({ ok: false, error: "shopIdOrCode required" });
  if (mode !== "soft" && mode !== "hard") return res.status(400).json({ ok: false, error: "mode must be soft or hard" });

  const db = readDB();
  if (!Array.isArray(db.shops)) db.shops = [];

  const findShop = () => {
    const q = shopIdOrCode;
    return db.shops.find(s => trim(s.shopId) === q) || db.shops.find(s => trim(s.shopCode) === q);
  };

  const shop = findShop();
  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  const targetShopId = trim(shop.shopId);

  // helper: detect shop id field in any row
  const keys = ["shopId", "shopID", "shop_id", "sid", "shop", "shop_id_fk"];
  const matchesShop = (obj) => {
    if (!obj || typeof obj !== "object") return false;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(obj, k) && trim(obj[k]) === targetShopId) return true;
    }
    return false;
  };

  if (mode === "soft") {
    shop.isDeleted = true;
    shop.deletedAt = now();
    shop.deleteReason = reason;
    writeDB(db);
    return res.json({ ok: true, mode, shopId: shop.shopId, shopCode: shop.shopCode });
  }

  // hard delete: remove from shops + related collections
  const beforeCounts = {};
  const afterCounts = {};

  const collections = [
    "devices",
    "pairCodes",
    "products",
    "staffs",
    "sales",
    "debtors",
    "debtorPayments",
    "licenses",
    "pendingActivations",
    "rmpLicenses",
    "rmpPendingActivations",
    "trials",
  ];

  for (const name of collections) {
    const arr = Array.isArray(db[name]) ? db[name] : [];
    beforeCounts[name] = arr.length;
    db[name] = arr.filter(row => !matchesShop(row));
    afterCounts[name] = db[name].length;
  }

  // owners: remove shopId from allowed shops
  if (Array.isArray(db.owners)) {
    beforeCounts.owners = db.owners.length;
    db.owners = db.owners.map(o => {
      if (!o || typeof o !== "object") return o;
      if (!Array.isArray(o.shops)) return o;
      return { ...o, shops: o.shops.filter(id => trim(id) !== targetShopId) };
    });
    afterCounts.owners = db.owners.length;
  }

  // shopAliases: remove aliases pointing to this shop or originating from this shop
  if (Array.isArray(db.shopAliases)) {
    beforeCounts.shopAliases = db.shopAliases.length;
    db.shopAliases = db.shopAliases.filter(a => {
      const from = trim(a?.fromShopId || a?.from || "");
      const to = trim(a?.toShopId || a?.to || "");
      return from !== targetShopId && to !== targetShopId;
    });
    afterCounts.shopAliases = db.shopAliases.length;
  }

  // mergeLogs: keep, but mark that shop was deleted (audit)
  if (!Array.isArray(db.mergeLogs)) db.mergeLogs = [];
  db.mergeLogs.unshift({
    type: "DELETE_SHOP",
    mode: "hard",
    shopId: targetShopId,
    shopCode: shop.shopCode || "",
    shopName: shop.shopName || "",
    reason,
    at: now(),
  });

  // finally remove shop record
  beforeCounts.shops = db.shops.length;
  db.shops = db.shops.filter(s => trim(s.shopId) !== targetShopId);
  afterCounts.shops = db.shops.length;

  writeDB(db);
  return res.json({ ok: true, mode, shopId: targetShopId, counts: { before: beforeCounts, after: afterCounts } });
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
// ACCOUNT RESTORE HISTORY / ANALYTICS
// GET /api/dev/account-restore/history
// GET /api/dev/account-restore/summary
// GET /api/dev/account-restore/export
// ------------------------------------------------------------
r.get("/account-restore/history", requireDevKey, (req, res) => {
  const db = readDB();
  const appParam = trim(req.query?.app).toUpperCase();
  const appFilter = !appParam || appParam === 'ALL' ? '' : normalizeApp(appParam);
  const q = trim(req.query?.q);
  const reason = trim(req.query?.reason);
  const fromTs = parseDateOrTs(req.query?.from, false);
  const toTs = parseDateOrTs(req.query?.to, true);
  const page = Math.max(1, Number(req.query?.page || 1));
  const pageSize = Math.max(1, Math.min(200, Number(req.query?.pageSize || 50)));
  const allRows = filterRestoreAudit(collectRestoreAudit(db), { appFilter, q, reason, fromTs, toTs }).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  const start = (page - 1) * pageSize;
  return res.json({ ok:true, rows: allRows.slice(start, start + pageSize), total: allRows.length, page, pageSize });
});

r.get("/account-restore/summary", requireDevKey, (req, res) => {
  const db = readDB();
  const appParam = trim(req.query?.app).toUpperCase();
  const appFilter = !appParam || appParam === 'ALL' ? '' : normalizeApp(appParam);
  const q = trim(req.query?.q);
  const reason = trim(req.query?.reason);
  const fromTs = parseDateOrTs(req.query?.from, false);
  const toTs = parseDateOrTs(req.query?.to, true);
  const rows = filterRestoreAudit(collectRestoreAudit(db), { appFilter, q, reason, fromTs, toTs });
  const apps = appFilter ? [appFilter] : ['SPNG','CPNG','STMN','RMP'];
  const byApp = apps.map((app) => {
    const list = rows.filter((x) => normalizeApp(x.app) === app);
    return {
      app,
      total: list.length,
      restored: list.filter((x) => x.reused).length,
      created: list.filter((x) => !x.reused).length,
      loginRestore: list.filter((x) => x.action === 'restore_login').length,
    };
  });
  const reasons = new Map();
  rows.forEach((x) => {
    const key = `${normalizeApp(x.app)}|${x.reuseReason || x.action || 'unknown'}`;
    const prev = reasons.get(key) || { app: normalizeApp(x.app), reason: x.reuseReason || x.action || 'unknown', count: 0 };
    prev.count += 1;
    reasons.set(key, prev);
  });
  return res.json({
    ok:true,
    overview: { total: rows.length, restored: rows.filter((x)=>x.reused).length, created: rows.filter((x)=>!x.reused).length, loginRestore: rows.filter((x)=>x.action==='restore_login').length },
    byApp,
    reasons: Array.from(reasons.values()).sort((a,b)=>b.count-a.count).slice(0,12),
    recent: rows.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0,20),
  });
});

r.get("/account-restore/export", requireDevKey, (req, res) => {
  const db = readDB();
  const appParam = trim(req.query?.app).toUpperCase();
  const appFilter = !appParam || appParam === 'ALL' ? '' : normalizeApp(appParam);
  const q = trim(req.query?.q);
  const reason = trim(req.query?.reason);
  const fromTs = parseDateOrTs(req.query?.from, false);
  const toTs = parseDateOrTs(req.query?.to, true);
  const rows = filterRestoreAudit(collectRestoreAudit(db), { appFilter, q, reason, fromTs, toTs }).sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0));
  const csv = toCsv(rows, ['app','entityType','action','reused','reuseReason','entityId','entityCode','entityName','ownerPhone','ownerEmail','deviceId','createdAt']);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="account_restore_${(appFilter || 'all').toLowerCase()}.csv"`);
  return res.send(csv);
});

// ------------------------------------------------------------
// GLOBAL LICENSE / TRIAL DASHBOARD
// GET /api/dev/global-dashboard
// ------------------------------------------------------------
r.get("/global-dashboard", requireDevKey, (req, res) => {
  const db = readDB();
  ensureDevCollections(db);
  db.trials = Array.isArray(db.trials) ? db.trials : [];
  db.trialAuditLogs = Array.isArray(db.trialAuditLogs) ? db.trialAuditLogs : [];
  db.trialBlocks = Array.isArray(db.trialBlocks) ? db.trialBlocks : [];
  db.trialConsumedKeys = Array.isArray(db.trialConsumedKeys) ? db.trialConsumedKeys : [];
  ensureRestoreAudit(db);

  const appParam = trim(req.query?.app).toUpperCase();
  const appFilter = !appParam || appParam === 'ALL' ? '' : normalizeApp(appParam);
  const fromTs = parseDateOrTs(req.query?.from, false);
  const toTs = parseDateOrTs(req.query?.to, true);
  const customRange = !!(fromTs || toTs);

  const licensesAll = collectAllLicenses(db).filter((x) => !appFilter || normalizeApp(x?.app || 'SPNG') === appFilter);
  const licenses = licensesAll;
  const licenseAudit = db.licenseAuditLogs.filter((x) => (!appFilter || normalizeApp(x?.app || 'SPNG') === appFilter) && (!customRange || inTsRange(x?.createdAt || x?.updatedAt || 0, fromTs, toTs)));
  const trialAudit = db.trialAuditLogs.filter((x) => (!appFilter || normalizeApp(x?.app || 'SPNG') === appFilter) && (!customRange || inTsRange(x?.createdAt || x?.updatedAt || 0, fromTs, toTs)));
  const trialBlocks = db.trialBlocks.filter((x) => (!appFilter || normalizeApp(x?.app || 'SPNG') === appFilter) && (!customRange || inTsRange(x?.updatedAt || x?.createdAt || 0, fromTs, toTs)));
  const trials = db.trials.filter((x) => !appFilter || normalizeApp(x?.app || 'SPNG') === appFilter);
  const restoreAudit = filterRestoreAudit(collectRestoreAudit(db), { appFilter, fromTs, toTs });
  const deviceIntel = buildDeviceIntelligence(db, { appFilter, fromTs, toTs });

  const apps = appFilter ? [appFilter] : ['SPNG', 'CPNG', 'STMN', 'RMP'];
  const nowTsValue = now();
  const rangeStart = customRange ? fromTs : startOfUtcDay(0);
  const rangeEnd = customRange ? (toTs || nowTsValue) : startOfUtcDay(1);
  const soonCutoff = nowTsValue + (14 * 86400000);
  const activeLicenses = licenses.filter((x) => isActiveLicense(x, nowTsValue));
  const expiringSoonRows = activeLicenses
    .filter((x) => Number(x?.expiresAt || 0) > 0 && Number(x?.expiresAt || 0) < soonCutoff)
    .sort((a, b) => Number(a?.expiresAt || 0) - Number(b?.expiresAt || 0))
    .slice(0, 16)
    .map((x) => ({
      app: normalizeApp(x?.app || 'SPNG'),
      licenseId: x?.licenseId || '',
      token: x?.token || '',
      deviceId: x?.boundDeviceId || x?.androidId || x?.deviceId || '',
      plan: x?.plan || '',
      expiresAt: Number(x?.expiresAt || 0),
      status: x?.status || '',
    }));

  const revokedInRange = licenseAudit.filter((x) => ['revoke_license', 'reset_binding'].includes(trim(x?.type))).length;
  const blockedInRange = trialAudit.filter((x) => /(block|denied|tamper|reinstall|multi_identity)/i.test(trim(x?.type))).length;
  const recentRevokes = licenseAudit
    .filter((x) => ['revoke_license', 'reset_binding'].includes(trim(x?.type)))
    .sort((a, b) => Number(b?.createdAt || 0) - Number(a?.createdAt || 0))
    .slice(0, 12)
    .map((x) => ({
      app: normalizeApp(x?.app || 'SPNG'),
      type: x?.type || '',
      licenseId: x?.licenseId || '',
      deviceId: x?.deviceId || '',
      reason: x?.reason || '',
      createdAt: Number(x?.createdAt || 0),
    }));

  const topAbuseMap = new Map();
  const abuseRows = [
    ...trialAudit.filter((x) => /(block|denied|tamper|reinstall|multi_identity|blacklist)/i.test(trim(x?.type))),
    ...trialBlocks,
  ];
  for (const row of abuseRows) {
    const app = normalizeApp(row?.app || 'SPNG');
    const idents = [
      ['deviceId', trim(row?.deviceId)],
      ['androidId', trim(row?.androidId)],
      ['installId', trim(row?.installId)],
      ['fpHash', trim(row?.fpHash)],
    ].filter((x) => x[1]);
    for (const [kind, value] of idents) {
      const key = `${app}|${kind}|${value}`;
      const prev = topAbuseMap.get(key) || { app, kind, value, count: 0, latestAt: 0 };
      prev.count += 1;
      prev.latestAt = Math.max(prev.latestAt, Number(row?.updatedAt || row?.createdAt || 0));
      topAbuseMap.set(key, prev);
    }
  }
  const topAbuse = Array.from(topAbuseMap.values())
    .sort((a, b) => (b.count - a.count) || (b.latestAt - a.latestAt))
    .slice(0, 12);

  const appCards = apps.map((app) => {
    const appLic = licenses.filter((x) => normalizeApp(x?.app || 'SPNG') === app);
    const appAuditRange = licenseAudit.filter((x) => normalizeApp(x?.app || 'SPNG') === app);
    const appTrialRange = trialAudit.filter((x) => normalizeApp(x?.app || 'SPNG') === app);
    const appDevice = deviceIntel?.perApp?.[app] || { devices: 0, suspicious: 0, multiAccount: 0, clusters: 0, avgFraudScore: 0 };
    return {
      app,
      total: appLic.length,
      active: appLic.filter((x) => isActiveLicense(x, nowTsValue)).length,
      expiringSoon: appLic.filter((x) => isActiveLicense(x, nowTsValue) && Number(x?.expiresAt || 0) > 0 && Number(x?.expiresAt || 0) < soonCutoff).length,
      monthly: appLic.filter((x) => trim(x?.plan).toUpperCase() === 'MONTHLY').length,
      yearly: appLic.filter((x) => trim(x?.plan).toUpperCase() === 'YEARLY').length,
      revokedToday: appAuditRange.filter((x) => trim(x?.type) === 'revoke_license').length,
      resetToday: appAuditRange.filter((x) => trim(x?.type) === 'reset_binding').length,
      blockedToday: appTrialRange.filter((x) => /(block|denied|tamper|reinstall|multi_identity)/i.test(trim(x?.type))).length,
      restores: restoreAudit.filter((x) => normalizeApp(x?.app || 'SPNG') === app).length,
      deviceCount: Number(appDevice.devices || 0),
      suspiciousDevices: Number(appDevice.suspicious || 0),
      multiAccountDevices: Number(appDevice.multiAccount || 0),
      clusterCount: Number(appDevice.clusters || 0),
      avgFraudScore: Number(appDevice.avgFraudScore || 0),
    };
  });

  const trendBuckets = buildTrendBuckets(fromTs, toTs);
  for (const row of licenseAudit) {
    const type = trim(row?.type);
    const app = normalizeApp(row?.app || 'SPNG');
    const ts = Number(row?.createdAt || 0);
    const bucket = trendBuckets.find((b) => ts >= b.startTs && ts <= b.endTs);
    if (!bucket) continue;
    if (['assign_token', 'extend_license', 'resend_activation'].includes(type)) bucket[app] += 1;
    if (type === 'revoke_license') bucket.revoke += 1;
  }
  for (const row of restoreAudit) {
    const ts = Number(row?.createdAt || 0);
    const app = normalizeApp(row?.app || 'SPNG');
    const bucket = trendBuckets.find((b) => ts >= b.startTs && ts <= b.endTs);
    if (!bucket) continue;
    if (trim(row?.action) === 'restore_login' || row?.reused === true) bucket[app] += 1;
  }
  for (const row of trialAudit) {
    const ts = Number(row?.createdAt || 0);
    const bucket = trendBuckets.find((b) => ts >= b.startTs && ts <= b.endTs);
    if (!bucket) continue;
    if (/(block|denied|tamper|reinstall|multi_identity)/i.test(trim(row?.type))) bucket.blocked += 1;
  }

  const reasonMap = new Map();
  const reasonRows = [
    ...licenseAudit.filter((x) => ['revoke_license', 'reset_binding'].includes(trim(x?.type))),
    ...trialBlocks,
    ...trials.filter((x) => trim(x?.revokeReason) || trim(x?.blockReason)),
  ];
  for (const row of reasonRows) {
    const app = normalizeApp(row?.app || 'SPNG');
    const reason = normalizeReason(row?.reason || row?.revokeReason || row?.blockReason || row?.type || 'unspecified');
    const key = `${app}|${reason || 'unspecified'}`;
    const prev = reasonMap.get(key) || { app, reason: reason || 'unspecified', count: 0 };
    prev.count += 1;
    reasonMap.set(key, prev);
  }
  const topReasons = Array.from(reasonMap.values()).sort((a, b) => b.count - a.count).slice(0, 12);
  const restoreReasonsMap = new Map();
  for (const row of restoreAudit) {
    const app = normalizeApp(row?.app || 'SPNG');
    const reason = normalizeReason(row?.reuseReason || row?.action || 'unknown');
    const key = `${app}|${reason}`;
    const prev = restoreReasonsMap.get(key) || { app, reason, count: 0 };
    prev.count += 1;
    restoreReasonsMap.set(key, prev);
  }
  const restoreReasons = Array.from(restoreReasonsMap.values()).sort((a,b)=>b.count-a.count).slice(0, 10);
  const recentRestores = restoreAudit.sort((a,b)=>Number(b.createdAt||0)-Number(a.createdAt||0)).slice(0, 12);

  return res.json({
    ok: true,
    filters: { app: appFilter || 'ALL', fromTs: fromTs || 0, toTs: toTs || 0, customRange },
    overview: {
      totalLicenses: licenses.length,
      activeLicenses: activeLicenses.length,
      expiringSoon: expiringSoonRows.length,
      revokedToday: revokedInRange,
      blockedToday: blockedInRange,
      trialsTracked: trials.length,
      blocksActive: trialBlocks.filter((x) => x?.active !== false).length,
      restoresTracked: restoreAudit.length,
      restoredEntities: restoreAudit.filter((x)=>x.reused).length,
      totalDevices: Number(deviceIntel.totalDevices || 0),
      suspiciousDevices: Number(deviceIntel.suspiciousCount || 0),
      multiAccountDevices: Number(deviceIntel.multiAccountCount || 0),
      deviceClusters: Number(deviceIntel.clusterCount || 0),
      rangeStart,
      rangeEnd,
    },
    appCards,
    expiringSoonRows,
    recentRevokes,
    recentRestores,
    topAbuse,
    topReasons,
    restoreReasons,
    trend: trendBuckets.map(({ startTs, endTs, ...rest }) => rest),
    deviceIntelligence: {
      totalDevices: Number(deviceIntel.totalDevices || 0),
      suspiciousCount: Number(deviceIntel.suspiciousCount || 0),
      multiAccountCount: Number(deviceIntel.multiAccountCount || 0),
      clusterCount: Number(deviceIntel.clusterCount || 0),
      perApp: deviceIntel.perApp,
      fingerprintClusters: deviceIntel.clusters.slice(0, 16),
      suspiciousDevices: deviceIntel.suspiciousDevices.slice(0, 16),
      multiAccountDevices: deviceIntel.multiAccountDevices.slice(0, 16),
      fraudScores: deviceIntel.fraudScores.slice(0, 20),
    },
  });
});


// ------------------------------------------------------------
// DEVICE DETAIL DRILL-DOWN
// GET /api/dev/device-detail?app=CPNG&deviceKey=...
// ------------------------------------------------------------
r.get("/device-detail", requireDevKey, (req, res) => {
  const db = readDB();
  const appParam = trim(req.query?.app).toUpperCase();
  const app = normalizeApp(appParam || 'SPNG');
  const deviceKey = trim(req.query?.deviceKey || req.query?.deviceId || '');
  if (!deviceKey) return res.status(400).json({ ok:false, error:'deviceKey required' });
  const detail = buildDeviceDetail(db, { app, deviceKey });
  if (!detail) return res.status(404).json({ ok:false, error:'Device not found' });
  return res.json({ ok:true, app, ...detail });
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
