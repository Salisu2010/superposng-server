import express from "express";
import { readDB, writeDB } from "../db.js";

const router = express.Router();

function ymdFromDate(d) {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return Number(`${yyyy}${mm}${dd}`);
}

function addDaysUTC(ymd, days) {
  const s = String(ymd);
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

function computeStatus(nowYmd, t) {
  if (!t) return "NONE";
  if (t.revoked) return "REVOKED";
  if (Number(nowYmd) > Number(t.expiryYmd)) return "EXPIRED";
  return "ACTIVE";
}

/**
 * Server-backed trial claim
 * - First claim creates trial record (7 days default)
 * - Subsequent claims return same expiry
 * - If installId changes for the same device fingerprint, trial is REVOKED (uninstall/reinstall behavior)
 */
router.get("/claim", (req, res) => {
  const app = normalizeApp(req.query.app);
  const deviceId = String(req.query.deviceId || "").trim();
  const fpHash = String(req.query.fpHash || "").trim();
  const androidId = String(req.query.androidId || "").trim();
  const installId = String(req.query.installId || "").trim();

  if (!app) {
    return res.status(400).json({ ok: false, message: "Missing/invalid app. Use app=SPNG, app=RMP or app=STMN" });
  }
  if (!fpHash) {
    return res.status(400).json({ ok: false, message: "Missing fpHash" });
  }

  const db = readDB();
  const now = new Date();
  const nowYmd = ymdFromDate(now);
  const trialDays = Number(process.env.TRIAL_DAYS || "7");

  db.trials = Array.isArray(db.trials) ? db.trials : [];

  const idx = db.trials.findIndex(t => t && t.app === app && t.fpHash === fpHash);
  let t = idx >= 0 ? db.trials[idx] : null;

  if (!t) {
    const startYmd = nowYmd;
    const expiryYmd = addDaysUTC(startYmd, trialDays);
    t = {
      id: `${app}-${fpHash}`,
      app,
      fpHash,
      deviceId,
      androidId,
      installId,
      startYmd,
      expiryYmd,
      consumed: true,
      revoked: false,
      createdAt: Date.now(),
      lastSeenAt: Date.now()
    };
    db.trials.push(t);
    writeDB(db);
    return res.json({
      ok: true,
      app,
      status: computeStatus(nowYmd, t),
      startYmd: t.startYmd,
      expiryYmd: t.expiryYmd,
      consumed: true
    });
  }

  // Update known identifiers (non-destructive)
  t.deviceId = t.deviceId || deviceId;
  t.androidId = t.androidId || androidId;
  t.lastSeenAt = Date.now();

  // Uninstall/reinstall behavior: if installId changes, revoke trial permanently.
  if (installId) {
    if (!t.installId) {
      t.installId = installId;
    } else if (t.installId !== installId) {
      t.revoked = true;
      // Force expiry today to avoid any UI confusion
      t.expiryYmd = Math.min(Number(t.expiryYmd || nowYmd), Number(nowYmd));
    }
  }

  db.trials[idx] = t;
  writeDB(db);

  return res.json({
    ok: true,
    app,
    status: computeStatus(nowYmd, t),
    startYmd: t.startYmd,
    expiryYmd: t.expiryYmd,
    consumed: true
  });
});

/**
 * Status-only (does not create trial)
 */
router.get("/status", (req, res) => {
  const app = normalizeApp(req.query.app);
  const fpHash = String(req.query.fpHash || "").trim();
  if (!app || !fpHash) {
    return res.status(400).json({ ok: false, message: "Missing app or fpHash" });
  }
  const db = readDB();
  const nowYmd = ymdFromDate(new Date());
  const t = (db.trials || []).find(x => x && x.app === app && x.fpHash === fpHash);
  if (!t) return res.json({ ok: true, app, status: "NONE" });
  return res.json({
    ok: true,
    app,
    status: computeStatus(nowYmd, t),
    startYmd: t.startYmd,
    expiryYmd: t.expiryYmd,
    consumed: !!t.consumed
  });
});

export default router;
