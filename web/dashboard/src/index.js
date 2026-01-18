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
const WEB_DIR = path.join(__dirname, "../web");

/* ===============================
   Global Middlewares
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
    version: "1.0.0",
    time: new Date().toISOString()
  });
});

/* ===============================
   STATIC WEB UIs
================================ */

// Local Hub Web Dashboard (LAN usage)
app.use(
  "/dashboard",
  express.static(path.join(WEB_DIR, "dashboard"))
);

// Developer Portal UI
app.use(
  "/dev",
  express.static(path.join(WEB_DIR, "dashboard/dev"))
);

// Force /dev to always load index.html
app.get("/dev", (_req, res) => {
  res.sendFile(
    path.join(WEB_DIR, "dashboard/dev/index.html")
  );
});

/* ===============================
   API ROUTES
================================ */

// Dashboard APIs
app.use("/api/dashboard", dashboardRoutes);

// Developer-only APIs
app.use("/api/dev", devRoutes);

// Public license claim (device activation)
app.use("/api/license", licenseRoutes);

// Core APIs
app.use("/api/shop", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);

/* ===============================
   Start Server
================================ */
const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => {
  console.log(`✅ SuperPOSNG Cloud Sync running on :${PORT}`);
});
