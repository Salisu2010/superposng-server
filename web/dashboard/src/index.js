import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

import { authMiddleware } from "./middleware/auth.js";
import shopRoutes from "./routes/shop.js";
import pairRoutes from "./routes/pair.js";
import syncRoutes from "./routes/sync.js";
import dashboardRoutes from "./routes/dashboard.js";
import devRoutes from "./routes/dev.js";
import licenseRoutes from "./routes/license.js";

dotenv.config();

const app = express();

/* ===============================
   Resolve paths (ESM safe)
================================ */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 👇 REAL paths based on your server folder
const WEB_ROOT = path.join(__dirname, "../web");
const DEV_DIR = path.join(WEB_ROOT, "dev");

/* ===============================
   Middlewares
================================ */
app.use(helmet());
app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));
app.use(morgan("dev"));

/* ===============================
   Health Check
================================ */
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    name: "SuperPOSNG Cloud Sync Server",
    version: "1.0.3-dev-final-fix",
    time: new Date().toISOString()
  });
});

/* ===============================
   🔥 DEVELOPER PORTAL (FINAL FIX)
================================ */

// Serve static assets
app.use("/dev", express.static(DEV_DIR));

// Force index.html for /dev
app.get("/dev", (_req, res) => {
  res.sendFile(path.join(DEV_DIR, "index.html"));
});

// Support SPA routes like /dev/anything
app.get("/dev/*", (_req, res) => {
  res.sendFile(path.join(DEV_DIR, "index.html"));
});

/* ===============================
   API ROUTES
================================ */
app.use("/api/dashboard", dashboardRoutes);
app.use("/api/dev", devRoutes);
app.use("/api/license", licenseRoutes);

app.use("/api/shop", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);

/* ===============================
   Start Server
================================ */
const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => {
  console.log("====================================");
  console.log("✅ SuperPOSNG Server RUNNING");
  console.log("🧑‍💻 Developer Portal: /dev");
  console.log("🚀 Port:", PORT);
  console.log("====================================");
});
