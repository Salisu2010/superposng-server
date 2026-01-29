import jwt from "jsonwebtoken";
import { readDB, writeDB } from "../db.js";

function trim(v) {
  return (v === null || v === undefined) ? "" : String(v).trim();
}

/**
 * Auth middleware for API routes.
 *
 * Supports two token types:
 * 1) Device token: { deviceId, shopId, role }
 * 2) Owner token: { sub, role:"owner", shops:[...] }
 *
 * IMPORTANT:
 * - When a device is revoked, we block its token immediately.
 */
export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const decoded = jwt.verify(token, secret);
    req.auth = decoded;

    // Owner tokens are validated only by JWT.
    if (decoded && decoded.role === "owner") {
      return next();
    }

    // Device tokens: enforce registry + revoke/active flags.
    const deviceId = trim(decoded?.deviceId);
    const shopId = trim(decoded?.shopId);
    if (deviceId && shopId) {
      const db = readDB();
      db.devices = Array.isArray(db.devices) ? db.devices : [];

      const d = db.devices.find((x) => trim(x.deviceId) === deviceId);
      if (!d) return res.status(401).json({ ok: false, error: "Device not registered" });
      if (trim(d.shopId) !== shopId) return res.status(401).json({ ok: false, error: "Device not bound to this shop" });
      if (d.isRevoked === true || d.isActive === false) {
        return res.status(401).json({ ok: false, error: "Device revoked" });
      }

      // Update last seen (best-effort).
      try {
        const now = Date.now();
        d.lastSeenAt = now;
        d.updatedAt = now;
        writeDB(db);
      } catch (_e) {}

      return next();
    }

    // If token doesn't look like owner or device, reject.
    return res.status(401).json({ ok: false, error: "Invalid token payload" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
