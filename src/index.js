import express from "express";
import cors from "cors";
import { readDB, writeDB } from './db.js'
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import fs from "fs";

import { authMiddleware } from "./middleware/auth.js";
import shopRoutes from "./routes/shop.js";
import pairRoutes from "./routes/pair.js";
import syncRoutes from "./routes/sync.js";
import dashboardRoutes from "./routes/dashboard.js";
import devRoutes from "./routes/dev.js";
import licenseRoutes from "./routes/license.js";
import ownerRoutes from "./routes/owner.js";
import devicesRoutes from "./routes/devices.js";

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
      "script-src": ["'self'", "https://cdn.jsdelivr.net"],
      "script-src-elem": ["'self'", "https://cdn.jsdelivr.net"],
      "style-src": ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
      "img-src": ["'self'", "data:"],
      "font-src": ["'self'", "data:"],
      "connect-src": ["'self'"],
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

// Local Hub Web Dashboard (no auth; intended for LAN use)
app.use("/dashboard", express.static(path.join(WEB_DIR, "dashboard")));
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
app.use("/api/dashboard", dashboardRoutes);

// Developer-only APIs
app.use("/api/dev", devRoutes);
// Owner (Shop User) APIs
app.use("/api/owner", ownerRoutes);
// Device registry APIs (Owner/Admin)
app.use("/api/devices", devicesRoutes);

// Public license claim endpoint for device activation
app.use("/api/license", licenseRoutes);

app.use("/api/shop", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);

const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`SuperPOSNG Cloud Sync running on :${PORT}`));
