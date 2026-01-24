import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { signToken } from "../auth.js";
import { authMiddleware } from "../middleware/auth.js";

const r = Router();

function trim(v) { return (v === null || v === undefined) ? "" : String(v).trim(); }

function hashPassword(password, salt) {
  // scrypt is strong and built-in
  const key = crypto.scryptSync(password, salt, 32);
  return key.toString("hex");
}
function verifyPassword(password, salt, hashHex) {
  const h = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(h, "hex"), Buffer.from(hashHex, "hex"));
}

/**
 * Owner Login
 * body: { email, password }
 */
r.post("/auth/login", (req, res) => {
  const email = trim(req.body?.email).toLowerCase();
  const password = trim(req.body?.password);
  if (!email || !password) return res.status(400).json({ ok: false, error: "email and password required" });

  const db = readDB();
  const owner = (db.owners || []).find(o => (o.email || "").toLowerCase() === email && o.isDisabled !== true);
  if (!owner) return res.status(401).json({ ok: false, error: "Invalid credentials" });

  try {
    const ok = verifyPassword(password, owner.salt, owner.passHash);
    if (!ok) return res.status(401).json({ ok: false, error: "Invalid credentials" });
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid credentials" });
  }

  const secret = process.env.JWT_SECRET || "dev_secret_change_me";
  const token = signToken({ sub: owner.ownerId, role: "owner", shops: owner.shops || [] }, secret, "30d");
  return res.json({ ok: true, token, owner: { ownerId: owner.ownerId, email: owner.email, shops: owner.shops || [] } });
});

/**
 * Owner profile
 */
r.get("/me", authMiddleware, (req, res) => {
  const auth = req.auth || {};
  if (auth.role !== "owner") return res.status(403).json({ ok: false, error: "Forbidden" });

  const db = readDB();
  const owner = (db.owners || []).find(o => o.ownerId === auth.sub);
  if (!owner) return res.status(404).json({ ok: false, error: "Owner not found" });

  // attach shop names
  const shops = (owner.shops || []).map(id => {
    const s = (db.shops || []).find(x => x.shopId === id);
    return {
      shopId: id,
      shopName: s?.shopName || "",
      shopCode: s?.shopCode || "",
      // richer shop profile (filled by /api/sync/shop/profile)
      address: s?.address || "",
      phone: s?.phone || "",
      whatsapp: s?.whatsapp || "",
      tagline: s?.tagline || "",
      currency: s?.currency || "",
      footer: s?.footer || "",
      updatedAt: s?.updatedAt || 0,
    };
  });

  return res.json({ ok: true, owner: { ownerId: owner.ownerId, email: owner.email, shops } });
});

export default r;
