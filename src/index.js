import express from "express";
import cors from "cors";
import { readDB, writeDB } from './db.js'
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "fs";
import jwt from "jsonwebtoken";
import { publish, getSince, sseHeaders, sendSse } from "./tg_events.js";
import { stmnAddClient, stmnSseHeaders, stmnSendSse } from "./stmn_events.js";
import { clinicAddClient, clinicSseHeaders, clinicSendSse } from "./clinic_events.js";
import * as Fcm from "./fcm.js";

import { authMiddleware } from "./middleware/auth.js";
import { startStmnReminderEngine } from "./stmn_reminder_engine.js";
import shopRoutes from "./routes/shop.js";
import pairRoutes from "./routes/pair.js";
import syncRoutes from "./routes/sync.js";
import dashboardRoutes from "./routes/dashboard.js";
import devRoutes from "./routes/dev.js";
import licenseRoutes from "./routes/license.js";
import stmnDevRoutes from "./routes/stmn_dev.js";
import stmnLicenseRoutes from "./routes/stmn_license.js";
import stmnSyncRoutes from "./routes/stmn_sync.js";
import stmnFcmRoutes from "./routes/stmn_fcm.js";
import stmnChatRoutes from "./routes/stmn_chat.js";
import spngFcmRoutes from "./routes/spng_fcm.js";
import ownerRoutes from "./routes/owner.js";
import rmpRoutes from "./routes/rmp.js";
import trialRoutes from "./routes/trial.js";
import trackguardRoutes from "./routes/trackguard.js";
import clinicRoutes from "./routes/clinic.js";

import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const SERVER_PATCH_VERSION = "codex-v8-db-cache-timeout-fix-2026-05-23";

function safeServerLog(level, message, extra) {
  try {
    const payload = extra ? ` ${JSON.stringify(extra)}` : '';
    console[level](`[server:${level}] ${message}${payload}`);
  } catch {
    try { console.log(`[server:${level}] ${message}`); } catch {}
  }
}

process.on('unhandledRejection', (reason) => {
  safeServerLog('error', 'Unhandled promise rejection', { reason: String(reason?.stack || reason || '') });
});

process.on('uncaughtException', (err) => {
  safeServerLog('error', 'Uncaught exception', { error: String(err?.stack || err || '') });
});

const app = express();
app.set('trust proxy', true);

app.get('/healthz', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).type('text/plain').send(`ok ${SERVER_PATCH_VERSION}`);
});

app.use((req, res, next) => {
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);

  res.json = function guardedJson(body) {
    if (res.headersSent || res.writableEnded) {
      safeServerLog('error', 'Ignored duplicate JSON response', {
        method: req.method,
        url: req.originalUrl || req.url
      });
      return res;
    }
    return originalJson(body);
  };

  res.send = function guardedSend(body) {
    if (res.headersSent || res.writableEnded) {
      safeServerLog('error', 'Ignored duplicate response send', {
        method: req.method,
        url: req.originalUrl || req.url
      });
      return res;
    }
    return originalSend(body);
  };

  return next();
});

// Resolve project root for serving local dashboard assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, "../web");

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'", "data:", "blob:", "https:", "http:"],
      // Allow local dashboard style portal scripts and CDN assets.
      "script-src": ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://cdn.jsdelivr.net", "https://unpkg.com", "http:", "https:"],
      "script-src-elem": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "http:", "https:"],
      "script-src-attr": ["'unsafe-inline'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "http:", "https:"],
      "style-src-elem": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com", "http:", "https:"],
      "img-src": ["'self'", "data:", "blob:", "https:", "http:"],
      "font-src": ["'self'", "data:", "https:", "http:"],
      "connect-src": ["'self'", "https:", "http:", "ws:", "wss:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'self'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: true }));
app.use(express.json({ limit: "12mb" }));
app.use(morgan("dev"));
app.use(lightweightRateLimit);
app.use(requestValidation);

const requestBuckets = new Map();
function keyOf(req) {
  return `${req.ip || 'ip'}|${req.path || 'path'}`;
}
function lightweightRateLimit(req, res, next) {
  const limit = parseInt(process.env.API_RATE_LIMIT_PER_MIN || '240', 10);
  const key = keyOf(req);
  const t = Date.now();
  const row = requestBuckets.get(key) || { count: 0, resetAt: t + 60000 };
  if (t > row.resetAt) {
    row.count = 0;
    row.resetAt = t + 60000;
  }
  row.count += 1;
  requestBuckets.set(key, row);
  if (row.count > limit) {
    return res.status(429).json({ ok:false, error:'Rate limit exceeded' });
  }
  if (requestBuckets.size > 5000) {
    for (const [bucketKey, bucket] of requestBuckets) {
      if (!bucket || t > (bucket.resetAt || 0) + 60000) requestBuckets.delete(bucketKey);
    }
  }
  return next();
}
function requestValidation(req, res, next) {
  const requiredKey = String(process.env.API_KEY || '').trim();
  const sentKey = String(req.headers['x-api-key'] || '').trim();
  const clinicId = String(
    req.headers['x-clinic-id'] ||
    req.headers['x-hospital-id'] ||
    req.query?.clinicId ||
    req.query?.hospitalId ||
    req.body?.clinicId ||
    req.body?.hospitalId ||
    req.auth?.clinicId ||
    req.auth?.hospitalId ||
    ''
  ).trim();
  const publicLicensePath = (
    req.path.startsWith('/api/license/check') ||
    req.path.startsWith('/api/license/claim') ||
    req.path.startsWith('/api/license/status') ||
    req.path.startsWith('/api/trial/claim') ||
    req.path.startsWith('/api/trial/status')
  );
  const clinicPortalPath = (
    req.path.startsWith('/api/portal/') ||
    req.path.startsWith('/api/ai/') ||
    req.path.startsWith('/api/notifications') ||
    req.path.startsWith('/api/events/stream') ||
    req.path.startsWith('/api/clinic/events') ||
    req.path.startsWith('/api/cloud/print/') ||
    req.path.startsWith('/api/patient/') ||
    req.path === '/api/patients' ||
    req.path.startsWith('/api/bill/') ||
    req.path === '/api/bills' ||
    req.path.startsWith('/api/visit/') ||
    req.path === '/api/visits' ||
    req.path.startsWith('/api/admission/') ||
    req.path === '/api/admissions' ||
    req.path.startsWith('/api/appointment/') ||
    req.path === '/api/appointments' ||
    req.path.startsWith('/api/pharmacy/') ||
    req.path.startsWith('/api/lab/') ||
    req.path.startsWith('/api/prescription/') ||
    req.path === '/api/prescriptions' ||
    req.path.startsWith('/api/nurse_desk') ||
    req.path.startsWith('/api/staff/') ||
    req.path.startsWith('/api/doctor_queue') ||
    req.path.startsWith('/api/search/patient')
  );
  const allowClinicScopedWithoutApiKey = clinicPortalPath && !!clinicId;
  const allowPublicLicenseWithoutApiKey = publicLicensePath;
  if (requiredKey && !allowClinicScopedWithoutApiKey && !allowPublicLicenseWithoutApiKey && !req.path.startsWith('/api/auth/login') && !req.path.startsWith('/api/hospital/create')) {
    if (sentKey !== requiredKey) return res.status(401).json({ ok:false, error:'Invalid API key' });
  }
  if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') && req.body && typeof req.body !== 'object') {
    return res.status(400).json({ ok:false, error:'Invalid JSON body' });
  }
  if (clinicId && clinicId.length > 120) {
    return res.status(400).json({ ok:false, error:'Invalid clinic identifier' });
  }
  return next();
}


app.get('/api/health', (_req, res) => {
  res.json({ ok:true, status:'healthy', uptime: process.uptime(), time: new Date().toISOString() });
});

app.get('/api/health/deep', (_req, res) => {
  try {
    const db = readDB();
    res.json({
      ok: true,
      status: 'healthy',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      db: {
        shops: Array.isArray(db.shops) ? db.shops.length : 0,
        stmnShops: Array.isArray(db.stmnShops) ? db.stmnShops.length : 0,
        clinics: Array.isArray(db.clinics) ? db.clinics.length : 0,
        clinicPatients: Array.isArray(db.clinicPatients) ? db.clinicPatients.length : 0,
        clinicBills: Array.isArray(db.clinicBills) ? db.clinicBills.length : 0,
        clinicVisits: Array.isArray(db.clinicVisits) ? db.clinicVisits.length : 0,
        trialLogs: Array.isArray(db.trialAuditLogs) ? db.trialAuditLogs.length : 0,
        trialBlocks: Array.isArray(db.trialBlocks) ? db.trialBlocks.length : 0
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:'Deep health failed', detail:String(e?.message || e) });
  }
});

app.get('/api/health/runtime', (_req, res) => {
  try {
    const fcmState = typeof Fcm.ensureFcm === 'function' ? Fcm.ensureFcm() : { ok:false, disabled:true, reason:'ensureFcm export missing' };
    res.json({
      ok: true,
      status: 'healthy',
      patchVersion: SERVER_PATCH_VERSION,
      node: process.version,
      pid: process.pid,
      uptime: process.uptime(),
      time: new Date().toISOString(),
      memory: process.memoryUsage(),
      rateLimitBuckets: requestBuckets.size,
      fcm: {
        ensureFcm: typeof Fcm.ensureFcm === 'function',
        upsertDeviceToken: typeof Fcm.upsertDeviceToken === 'function',
        removeDeviceToken: typeof Fcm.removeDeviceToken === 'function',
        pushShopChange: typeof Fcm.pushShopChange === 'function',
        upsertSpngDeviceToken: typeof Fcm.upsertSpngDeviceToken === 'function',
        removeSpngDeviceToken: typeof Fcm.removeSpngDeviceToken === 'function',
        pushSpngShopChange: typeof Fcm.pushSpngShopChange === 'function',
        state: fcmState
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:'Runtime health failed', detail:String(e?.message || e) });
  }
});

app.get('/api/health/clinic', (req, res) => {
  try {
    const clinicId = String(req.query?.clinicId || req.query?.hospitalId || req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || '').trim();
    if (!clinicId) return res.status(400).json({ ok:false, error:'clinicId is required' });
    const db = readDB();
    const match = (row) => String(row?.clinicId || row?.hospitalId || row?.shopId || '') === clinicId;
    res.json({
      ok: true,
      clinicId,
      clinicExists: Array.isArray(db.clinics) ? db.clinics.some(match) : false,
      counts: {
        patients: Array.isArray(db.clinicPatients) ? db.clinicPatients.filter(match).length : 0,
        bills: Array.isArray(db.clinicBills) ? db.clinicBills.filter(match).length : 0,
        visits: Array.isArray(db.clinicVisits) ? db.clinicVisits.filter(match).length : 0,
        admissions: Array.isArray(db.clinicAdmissions) ? db.clinicAdmissions.filter(match).length : 0,
        appointments: Array.isArray(db.clinicAppointments) ? db.clinicAppointments.filter(match).length : 0,
        pharmacy: Array.isArray(db.clinicPharmacyDispenses) ? db.clinicPharmacyDispenses.filter(match).length : 0,
        labs: Array.isArray(db.clinicLabOrders) ? db.clinicLabOrders.filter(match).length : 0,
        prescriptions: Array.isArray(db.clinicPrescriptions) ? db.clinicPrescriptions.filter(match).length : 0,
        notifications: Array.isArray(db.clinicNotifications) ? db.clinicNotifications.filter(match).length : 0,
        changes: Array.isArray(db.clinicChangeLog) ? db.clinicChangeLog.filter(match).length : 0,
      }
    });
  } catch (e) {
    res.status(500).json({ ok:false, error:'Clinic health failed', detail:String(e?.message || e) });
  }
});

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "SuperPOSNG + Clinic Pro NG Cloud Sync Server",
    version: "1.0.0",
    patchVersion: SERVER_PATCH_VERSION,
    time: new Date().toISOString()
  });
});

// Avoid noisy 404s in browser console
app.get("/favicon.ico", (_req, res) => res.status(204).end());

// Local Hub Web Dashboard (no auth; intended for LAN use)
app.use("/dashboard", express.static(path.join(WEB_DIR, "dashboard")));
// TrackGuard Admin Dashboard (integrated)
app.use("/dashboard/trackguard", express.static(path.join(WEB_DIR, "trackguard")));

// Developer Portal UI
app.use("/dev", express.static(path.join(WEB_DIR, "dev")));
// Owner Cloud Dashboard UI
app.use("/owner", express.static(path.join(WEB_DIR, "owner")));

// Some hosts/proxies don't automatically redirect "/dev" -> "/dev/" for static mounts.
// Guarantee that the root paths load index.html.
function sendIndex(res, dirName) {
  const file = path.join(WEB_DIR, dirName, "index.html");
  if (fs.existsSync(file)) return res.sendFile(file);
  return res.status(404).json({
    ok: false,
    message: `UI not found for /${dirName}. Make sure the web/${dirName} folder is deployed.`
  });
}

app.get("/dev", (_req, res) => sendIndex(res, "dev"));
app.get("/dashboard", (_req, res) => sendIndex(res, "dashboard"));
app.get("/owner", (_req, res) => sendIndex(res, "owner"));
app.get("/dashboard/trackguard", (_req, res) => sendIndex(res, "trackguard"));
app.use("/api/dashboard", dashboardRoutes);

// Developer-only APIs
app.use("/api/dev", devRoutes);
app.use("/api/stmn/dev", stmnDevRoutes);
// Owner (Shop User) APIs
app.use("/api/owner", ownerRoutes);

// Public license claim endpoint for device activation
app.use("/api/license", licenseRoutes);
app.use("/api/stmn/license", stmnLicenseRoutes);

// Server-backed Trial (SPNG + RMP)
app.use("/api/trial", trialRoutes);

// TrackGuard (Lite + Enterprise) Registry + Dashboard APIs
app.use("/api/trackguard", trackguardRoutes);

// RepairMasterPro Online Licensing (RMP)
app.use("/api/rmp", rmpRoutes);

app.use("/api/shop", shopRoutes);
app.use("/api/stmn/hotel", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);
app.use("/api/stmn/sync", authMiddleware, stmnSyncRoutes);
app.use("/api/stmn/fcm", authMiddleware, stmnFcmRoutes);
app.use("/api/stmn/chat", authMiddleware, stmnChatRoutes);
app.use("/api/spng/fcm", authMiddleware, spngFcmRoutes);

/**
 * StayMasterNG Realtime Events (SSE)
 * Purpose: 0-1s push signal whenever rooms/bookings change.
 * Auth: Bearer token (same token used for /api/stmn/sync).
 */
app.get("/api/stmn/events", authMiddleware, (req, res) => {
  try {
    const shopId = String(req.auth?.shopId || "").trim();
    if (!shopId) return res.status(401).json({ ok:false, error:"Missing auth shopId" });

    stmnSseHeaders(res);
    stmnSendSse(res, "hello", { ok:true, shopId, at: Date.now() });
    stmnAddClient(shopId, res);

    const ping = setInterval(() => {
      try { stmnSendSse(res, "ping", { t: Date.now() }); } catch {}
    }, 15000);

    req.on("close", () => {
      try { clearInterval(ping); } catch {}
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:"Server error" });
  }
});


/**
 * Clinic Pro NG Realtime Events (SSE)
 * Auth: Bearer token from /api/auth/login
 */
app.get('/api/events/stream', (req, res, next) => {
  const clinicId = String(req.query?.hospitalId || req.query?.clinicId || req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || '').trim();
  const hasToken = !!String(req.headers.authorization || req.query?.token || req.headers['x-access-token'] || req.headers['x-auth-token'] || '').trim();
  if (!hasToken && clinicId) {
    req.auth = { clinicId, hospitalId: clinicId, scope: 'portal-sse-clinic' };
    return next();
  }
  return authMiddleware(req, res, next);
}, (req, res) => {
  try {
    const clinicId = String(req.auth?.clinicId || req.auth?.hospitalId || req.query?.hospitalId || req.query?.clinicId || req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || '').trim();
    if (!clinicId) return res.status(401).json({ ok:false, error:'Missing clinicId or hospitalId' });
    clinicSseHeaders(res);
    clinicSendSse(res, 'hello', { ok:true, clinicId, at: Date.now(), transport:'sse' });
    clinicAddClient(clinicId, res);
    const ping = setInterval(() => {
      try { clinicSendSse(res, 'ping', { t: Date.now() }); } catch {}
    }, 15000);
    req.on('close', () => {
      try { clearInterval(ping); } catch {}
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

app.get('/api/clinic/events', authMiddleware, (req, res) => {
  try {
    const clinicId = String(req.query?.hospitalId || req.query?.clinicId || req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || '').trim();
    if (!clinicId) return res.status(401).json({ ok:false, error:'Missing clinicId or hospitalId' });
    clinicSseHeaders(res);
    clinicSendSse(res, 'hello', { ok:true, clinicId, at: Date.now() });
    clinicAddClient(clinicId, res);
    const ping = setInterval(() => {
      try { clinicSendSse(res, 'ping', { t: Date.now() }); } catch {}
    }, 15000);
    req.on('close', () => {
      try { clearInterval(ping); } catch {}
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'Server error' });
  }
});

app.use("/api", clinicRoutes);

/**
 * TrackGuard Realtime Events (SSE)
 * Dashboard connects here for live online/offline + actions.
 * Auth: either ?key=API_KEY or Bearer JWT (Owner/Admin).
 */
app.get("/api/events", (req, res) => {
  const apiKey = String(process.env.API_KEY || "").trim();
  const key = String(req.query?.key || "").trim();
  const authH = String(req.headers.authorization || "");
  const bearer = authH.startsWith("Bearer ") ? authH.substring(7) : "";

  let ok = false;
  if (apiKey && key && key === apiKey) ok = true;

  // Note: EventSource can't set Authorization headers easily, so we also accept
  // a JWT passed via ?key=... (dashboard currently does this).
  const jwtCandidate = bearer || key;

  if (!ok && jwtCandidate) {
    try {
      const secret = process.env.JWT_SECRET || "dev_secret_change_me";
      const decoded = jwt.verify(jwtCandidate, secret);
      const role = String(decoded?.role || "").toLowerCase();
      if (role === "admin" || role === "owner") ok = true;
    } catch {}
  }

  if (!ok) return res.status(401).json({ ok:false, error:"unauthorized" });

  sseHeaders(res);
  sendSse(res, "hello", { ok:true, at: Date.now() });

  let lastId = Number(req.query?.lastId || 0) || 0;

  // Send missed events immediately
  const missed = getSince(lastId);
  for (const e of missed) {
    sendSse(res, e.type, e);
    lastId = Math.max(lastId, e.id);
  }

  const ping = setInterval(() => {
    sendSse(res, "ping", { t: Date.now() });
  }, 15000);

  const pump = setInterval(() => {
    const batch = getSince(lastId);
    for (const e of batch) {
      sendSse(res, e.type, e);
      lastId = Math.max(lastId, e.id);
    }
  }, 1200);

  req.on("close", () => {
    try { clearInterval(ping); } catch {}
    try { clearInterval(pump); } catch {}
  });
});


// Final enterprise error handler: prevents thrown route errors from killing the process
// and returns structured JSON to clients. Keep this after all routes.
app.use((err, req, res, _next) => {
  try { console.error('[express-error]', req?.method, req?.originalUrl || req?.url, err?.stack || err); } catch {}
  if (res.headersSent) return;
  res.status(err?.status || err?.statusCode || 500).json({
    ok: false,
    error: err?.publicMessage || err?.message || 'Internal server error'
  });
});

/**
 * TrackGuard online/offline reconciliation.
 * Marks device offline if no heartbeat within OFFLINE_MS and emits "status" events.
 */
const OFFLINE_MS = parseInt(process.env.TG_OFFLINE_MS || "45000", 10);
setInterval(() => {
  try{
    const db = readDB();
    if (!db || !Array.isArray(db.tgDevices)) return;

    const nowTs = Date.now();
    let changed = false;

    for (const d of db.tgDevices) {
      const lastSeen = Number(d.lastSeen || 0) || 0;
      const onlineNow = lastSeen > 0 && (nowTs - lastSeen) <= OFFLINE_MS;
      const prev = !!d.online;
      if (onlineNow !== prev) {
        d.online = onlineNow;
        changed = true;
        publish("status", { deviceId: d.deviceId, online: onlineNow, lastSeen });
      }
    }
    if (changed) writeDB(db);
  } catch {}
}, 5000);

const PORT = parseInt(process.env.PORT || "8080", 10);
const server = app.listen(PORT, () => console.log(`SuperPOSNG Cloud Sync running on :${PORT} (${SERVER_PATCH_VERSION})`));
server.on('error', (err) => {
  safeServerLog('error', 'HTTP server error', { error: String(err?.stack || err || '') });
});

function shutdown(signal) {
  safeServerLog('info', `Received ${signal}; closing HTTP server`);
  try {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref?.();
  } catch {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// StayMasterNG Smart Reminder Engine (WhatsApp/SMS compose via client)
try {
  startStmnReminderEngine();
} catch (e) {
  safeServerLog('error', 'Reminder engine failed to start', { error: String(e?.stack || e || '') });
}
