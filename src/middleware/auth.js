import jwt from "jsonwebtoken";
import { readDB, resolveShopId } from "../db.js";

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const decoded = jwt.verify(token, secret);
    try {
      const db = readDB();
      if (decoded && decoded.shopId) decoded.shopId = resolveShopId(db, decoded.shopId);
    } catch (_) {}
    req.auth = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
