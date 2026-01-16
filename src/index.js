import express from "express";
import cors from "cors";
import { readDB, writeDB } from './db.js'
import helmet from "helmet";
import morgan from "morgan";
import dotenv from "dotenv";

import { authMiddleware } from "./middleware/auth.js";
import shopRoutes from "./routes/shop.js";
import pairRoutes from "./routes/pair.js";
import syncRoutes from "./routes/sync.js";
import dashboardRoutes from "./routes/dashboard.js";

import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();

// Resolve project root for serving local dashboard assets
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const WEB_DIR = path.join(__dirname, "../web");

app.use(helmet());
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
app.use("/api/dashboard", dashboardRoutes);

app.use("/api/shop", shopRoutes);
app.use("/api/pair", pairRoutes);
app.use("/api/sync", authMiddleware, syncRoutes);

const PORT = parseInt(process.env.PORT || "8080", 10);
app.listen(PORT, () => console.log(`SuperPOSNG Cloud Sync running on :${PORT}`));
