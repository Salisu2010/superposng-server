import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { authMiddleware } from "./middleware/auth.js";
import shopRoutes from "./routes/shop.js";
import pairRoutes from "./routes/pair.js";
import syncRoutes from "./routes/sync.js";
import dashboardRoutes from "./routes/dashboard.js";
import devRoutes from "./routes/dev.js";
import licenseRoutes from "./routes/license.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WEB_ROOT = path.join(__dirname, "../web");
const DASHBOARD_DIR = path.join(WEB_ROOT, "dashboard");
const DEV_DIR = path.join(DASHBOARD_DIR, "dev");

app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "SuperPOSNG Cloud Sync Server",
    version: "1.0.1-dev-fix",
    time: new Date().toISOString()
  });
});

/**
 * Debug endpoint: confirm folders exist on Render
 * Open: https://superposng-server.onrender.com/__paths
 */
app.get("/__paths", (_req, res) => {
  const info = (p) => ({
    path: p,
    exists: fs.existsSync(p),
    isDir: fs.existsSync(p) ? fs.lstatSync(p).isDirectory() : false,
    files: fs.existsSync(p) && fs.lstatSync(p).isDirectory()
      ? fs.readdirSync(p).slice(0, 30)
      : []
  });

  res.json({
    ok: true,
    WEB_ROOT: info(WEB_ROOT),
    DASHBOARD_DIR: info(DASHBOARD_DIR),
    DEV_DIR: info(DEV_DIR)
  });
});

// Serve dashboard (includes /dashboard/dev/...)
app.use("/dashboard", express.static(DASHBOARD_DIR));

/**
 * ✅ Reliable: make /dev redirect to /dashboard/dev/
 * This removes all path confusion.
 */
app.get("/dev", (_req, res) => res.redirect(302, "/dashboard/dev/"));
app.get("/dev/*", (_req, res) => res.redirect(302, "/dashboard/dev/"));

/* APIs */
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/dev", devRoutes);
app.use("/api/license", licenseRoutes);

app.use("/api/shop", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);

const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => {
  console.log("✅ SuperPOSNG Cloud Sync running on:", PORT);
  console.log("🌐 Dashboard:", "/dashboard");
  console.log("🧑‍💻 Dev Portal:", "/dev -> /dashboard/dev/");
});
