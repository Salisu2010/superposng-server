import { Router } from "express";
import { nanoid } from "nanoid";
import { readDB, writeDB } from "../db.js";

const r = Router();

/**
 * Create a Shop (Admin)
 * body: { shopName, ownerDeviceId, ownerPin? }
 */
r.post("/create", (req, res) => {
  const { shopName, ownerDeviceId, ownerPin } = req.body || {};
  if (!shopName || !ownerDeviceId) {
    return res
      .status(400)
      .json({ ok: false, error: "shopName and ownerDeviceId are required" });
  }

  const db = readDB();

  const shopId = nanoid(12);
  const shopCode = ("SPNG-" + nanoid(6)).toUpperCase();

  db.shops.push({
    shopId,
    shopCode,
    shopName,
    createdAt: Date.now(),
    ownerDeviceId,
    ownerPin: (ownerPin || "").toString().trim(),
  });

  // also register owner device
  db.devices.push({
    deviceId: ownerDeviceId,
    shopId,
    role: "ADMIN",
    pairedAt: Date.now(),
    isActive: true,
  });

  writeDB(db);
  return res.json({ ok: true, shopId, shopCode, shopName });
});

/**
 * Resolve shop by code (useful for UI)
 */
r.get("/by-code/:shopCode", (req, res) => {
  const shopCode = (req.params.shopCode || "").toUpperCase();
  const db = readDB();

  const shop = db.shops.find(
    (s) => (s.shopCode || "").toUpperCase() === shopCode
  );

  if (!shop) return res.status(404).json({ ok: false, error: "Shop not found" });

  return res.json({
    ok: true,
    shop: { shopId: shop.shopId, shopCode: shop.shopCode, shopName: shop.shopName },
  });
});

export default r;
