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
import clinicEnterpriseRoutes from "./routes/clinic_enterprise.js";

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
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "SuperPOSNG Cloud Sync Server",
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
// Clinic Pro NG doctor/manager enterprise portal
app.use("/portal", express.static(path.join(WEB_DIR, "hospital_portal")));
app.use("/manager-portal", express.static(path.join(WEB_DIR, "hospital_portal")));
app.use("/doctor-portal", express.static(path.join(WEB_DIR, "hospital_portal")));

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
app.get("/portal", (_req, res) => sendIndex(res, "hospital_portal"));
app.get("/manager-portal", (_req, res) => sendIndex(res, "hospital_portal"));
app.get("/doctor-portal", (_req, res) => sendIndex(res, "hospital_portal"));
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
// Clinic Pro NG Enterprise SaaS / multi-hospital cloud APIs
app.use("/api/clinic", clinicEnterpriseRoutes);

// RepairMasterPro Online Licensing (RMP)
app.use("/api/rmp", rmpRoutes);

app.use("/api/shop", shopRoutes);
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
