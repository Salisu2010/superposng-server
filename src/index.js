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

const app = express();

// Resolve project root for serving local dashboard assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, "../web");

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      // Allow CDN assets used by TrackGuard dashboard (Leaflet, icons)
      "script-src": ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      "script-src-elem": ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      "style-src-elem": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
      "img-src": ["'self'", "data:", "blob:", "https:"],
      "font-src": ["'self'", "data:", "https:"],
      "connect-src": ["'self'", "https:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'self'"]
    }
  }
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
  return next();
}
function requestValidation(req, res, next) {
  const requiredKey = String(process.env.API_KEY || '').trim();
  const sentKey = String(req.headers['x-api-key'] || '').trim();
  const clinicId = String(req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || req.query?.clinicId || req.query?.hospitalId || '').trim();
  const clinicPortalPath = (
    req.path.startsWith('/api/portal/') ||
    req.path.startsWith('/api/ai/') ||
    req.path.startsWith('/api/notifications') ||
    req.path.startsWith('/api/events/stream') ||
    req.path.startsWith('/api/clinic/events') ||
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
  const localDashboardPath = (
    req.path.startsWith('/api/status') ||
    req.path.startsWith('/api/table') ||
    req.path.startsWith('/api/queue') ||
    req.path.startsWith('/api/doctors') ||
    req.path.startsWith('/api/pharmacy_items_list') ||
    req.path.startsWith('/api/patient_lookup') ||
    req.path.startsWith('/api/activity_feed') ||
    req.path.startsWith('/api/global_search') ||
    req.path.startsWith('/api/doctor_performance') ||
    req.path.startsWith('/api/financial_analytics') ||
    req.path.startsWith('/api/cloud_status') ||
    req.path.startsWith('/api/cloud_sync_queue') ||
    req.path.startsWith('/api/ai_insights') ||
    req.path.startsWith('/api/ai_patients_watchlist') ||
    req.path.startsWith('/api/ai_patient_summary') ||
    req.path.startsWith('/api/portal_overview') ||
    req.path.startsWith('/api/cloud_branch_matrix') ||
    req.path.startsWith('/api/online_notifications') ||
    req.path.startsWith('/api/report_summary') ||
    req.path.startsWith('/api/report_printable') ||
    req.path.startsWith('/api/dashboard/register_patient') ||
    req.path.startsWith('/api/dashboard/create_visit') ||
    req.path.startsWith('/api/dashboard/create_bill') ||
    req.path.startsWith('/api/dashboard/print_bill') ||
    req.path.startsWith('/api/dashboard/add_prescription') ||
    req.path.startsWith('/api/dashboard/add_pharmacy_stock') ||
    req.path.startsWith('/api/dashboard/dispense_drug') ||
    req.path.startsWith('/api/dashboard/print_summary_report') ||
    req.path.startsWith('/api/dashboard/print_patient_slip') ||
    req.path.startsWith('/api/events')
  );
  const allowClinicScopedWithoutApiKey = (clinicPortalPath && !!clinicId) || localDashboardPath;
  if (requiredKey && !allowClinicScopedWithoutApiKey && !req.path.startsWith('/api/auth/login') && !req.path.startsWith('/api/hospital/create')) {
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

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "SuperPOSNG + Clinic Pro NG Cloud Sync Server",
    version: "1.0.0",
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
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);
app.use("/api/stmn/sync", authMiddleware, stmnSyncRoutes);
app.use("/api/stmn/fcm", authMiddleware, stmnFcmRoutes);
app.use("/api/stmn/chat", authMiddleware, stmnChatRoutes);
app.use("/api/spng/fcm", authMiddleware, spngFcmRoutes);
app.use("/api", clinicRoutes);

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
app.get('/api/events/stream', (req, res) => {
  try {
    const clinicId = String(req.auth?.clinicId || req.auth?.hospitalId || req.query?.hospitalId || req.query?.clinicId || req.headers['x-clinic-id'] || req.headers['x-hospital-id'] || '').trim();
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

app.get('/api/clinic/events', (req, res) => {
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
app.listen(PORT, () => console.log(`SuperPOSNG Cloud Sync running on :${PORT}`));

// StayMasterNG Smart Reminder Engine (WhatsApp/SMS compose via client)
startStmnReminderEngine();
