import { Router } from "express";
import { readDB, writeDB } from "../db.js";
import { stmnPublish } from "../stmn_events.js";
import { pushShopChange } from "../fcm.js";

const r = Router();

function requireShop(req, res) {
  const raw = req.auth?.shopId ? String(req.auth.shopId) : "";
  if (!raw) {
    res.status(401).json({ ok: false, error: "Missing auth shopId" });
    return null;
  }
  return raw;
}

function toInt(v, def = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function trim(v) {
  return (v ?? "").toString().trim();
}

function ensureDb(db) {
  db.stmnRooms = Array.isArray(db.stmnRooms) ? db.stmnRooms : [];
  db.stmnBookings = Array.isArray(db.stmnBookings) ? db.stmnBookings : [];
}

function roomKey(shopId, branchId, roomNumber) {
  return `${shopId}:${branchId}:${trim(roomNumber).toUpperCase()}`;
}

function bookingKey(shopId, branchId, bookingUid, roomNumber, checkInAt) {
  const b = trim(bookingUid);
  if (b) return `${shopId}:${branchId}:UID:${b}`;
  return `${shopId}:${branchId}:RN:${trim(roomNumber).toUpperCase()}:CI:${toInt(checkInAt, 0)}`;
}

/**
 * POST /api/stmn/sync/push
 * body: { deviceId, branchId, rooms:[...], bookings:[...], room_status_updates:[...] }
 */
r.post("/push", async (req, res) => {
  try {
    const shopId = requireShop(req, res);
    if (!shopId) return;

    const branchId = toInt(req.body?.branchId, 1) || 1;
    const rooms = Array.isArray(req.body?.rooms) ? req.body.rooms : [];
    const bookings = Array.isArray(req.body?.bookings) ? req.body.bookings : [];
    const roomStatusUpdates = Array.isArray(req.body?.room_status_updates)
      ? req.body.room_status_updates
      : [];

    const db = readDB();
    ensureDb(db);

    const now = Date.now();

    // Room status-only updates (safe for non-admin roles)
    // This path ONLY touches status + updated_at and never overwrites category/price.
    for (const u0 of roomStatusUpdates) {
      const rn = trim(u0?.room_number || u0?.roomNumber);
      if (!rn) continue;
      const key = roomKey(shopId, branchId, rn);
      const status = trim(u0?.status);
      if (!status) continue;
      // Always bump server-side updated_at to guarantee monotonic change tracking.
      // This prevents clients from sending stale updated_at values (common on checkout/checkin)
      // which would otherwise cause other devices to miss updates during pull(since).
      const updated_at = now;

      const idx = db.stmnRooms.findIndex((x) => x.key === key);
      if (idx >= 0) {
        const prev = db.stmnRooms[idx];
        const prevU = toInt(prev?.updated_at, 0);
        if (updated_at >= prevU) {
          db.stmnRooms[idx] = { ...prev, status, updated_at };
        }
      } else {
        // If room doesn't exist yet, create minimal record.
        db.stmnRooms.push({
          shopId,
          branchId,
          room_number: rn,
          category: "Standard",
          price_per_night: 0,
          status,
          updated_at,
          key,
        });
      }
    }

    // Rooms upsert
    for (const r0 of rooms) {
      const rn = trim(r0?.room_number || r0?.roomNumber);
      if (!rn) continue;
      const key = roomKey(shopId, branchId, rn);

      const rec = {
        shopId,
        branchId,
        room_number: rn,
        category: trim(r0?.category || r0?.room_category || r0?.roomCategory) || "Standard",
        price_per_night: Number(r0?.price_per_night ?? r0?.pricePerNight ?? 0) || 0,
        status: trim(r0?.status) || "available",
        // Always set updated_at on server to ensure pulls see the latest change.
        updated_at: now,
        key,
      };

      const idx = db.stmnRooms.findIndex((x) => x.key === key);
      if (idx >= 0) {
        const prev = db.stmnRooms[idx];
        // keep the latest updated
        const prevU = toInt(prev?.updated_at, 0);
        const curU = toInt(rec.updated_at, 0);
        if (curU >= prevU) db.stmnRooms[idx] = { ...prev, ...rec };
      } else {
        db.stmnRooms.push(rec);
      }
    }

    // Bookings upsert
    for (const b0 of bookings) {
      const rn = trim(b0?.room_number || b0?.roomNumber);
      const ci = toInt(b0?.check_in_at ?? b0?.checkInAt, 0);
      if (!rn || !ci) continue;

      const bUid = trim(b0?.booking_uid || b0?.bookingUid);
      const key = bookingKey(shopId, branchId, bUid, rn, ci);

      const rec = {
        shopId,
        branchId,
        room_number: rn,
        room_category: trim(b0?.room_category || b0?.roomCategory || ""),
        guest_name: trim(b0?.guest_name || b0?.guestName || ""),
        guest_phone: trim(b0?.guest_phone || b0?.guestPhone || ""),
        nights: toInt(b0?.nights, 1) || 1,
        hours: toInt(b0?.hours, 0) || 0,
        booking_mode: trim(b0?.booking_mode || b0?.bookingMode) || "nightly",
        check_in_at: ci,
        check_out_at: toInt(b0?.check_out_at ?? b0?.checkOutAt, 0),
        deposit: Number(b0?.deposit ?? 0) || 0,
        total_amount: Number(b0?.total_amount ?? b0?.totalAmount ?? 0) || 0,
        status: trim(b0?.status) || "active",
        created_at: toInt(b0?.created_at, ci) || ci,
        // Always set updated_at on server to ensure pulls see the latest change.
        updated_at: now,
        completed_at: toInt(b0?.completed_at, 0),
        group_id: trim(b0?.group_id || ""),
        group_name: trim(b0?.group_name || ""),
        booking_uid: bUid,
        key,
      };

      const idx = db.stmnBookings.findIndex((x) => x.key === key);
      if (idx >= 0) {
        const prev = db.stmnBookings[idx];
        const prevU = toInt(prev?.updated_at, 0);
        const curU = toInt(rec.updated_at, 0);
        if (curU >= prevU) db.stmnBookings[idx] = { ...prev, ...rec };
      } else {
        db.stmnBookings.push(rec);
      }
    }

    // keep bounded size
    if (db.stmnRooms.length > 5000) db.stmnRooms = db.stmnRooms.slice(-5000);
    if (db.stmnBookings.length > 10000) db.stmnBookings = db.stmnBookings.slice(-10000);

    writeDB(db);
    // Realtime push signal: tell all online devices in this shop that fresh data is available.
    // Clients will immediately trigger a pull to fetch full updates.
    try {
      stmnPublish(shopId, "stmn_changed", { branchId, at: now });
    } catch {}

    // Background push (FCM) for devices that are not currently connected via SSE.
    // Optional: will no-op if FCM isn't configured.
    try {
      await pushShopChange({
        shopId,
        title: "StayMasterNG",
        body: "New update available",
        data: { type: "stmn_changed", branchId, at: now }
      });
    } catch {}
    return res.json({ ok: true, roomsUpserted: rooms.length, bookingsUpserted: bookings.length, serverTime: now });
  } catch (e) {
    console.error("POST /api/stmn/sync/push error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

/**
 * GET /api/stmn/sync/pull?since=ms
 */
r.get("/pull", (req, res) => {
  try {
    const shopId = requireShop(req, res);
    if (!shopId) return;

    const since = toInt(req.query?.since, 0);

    const db = readDB();
    ensureDb(db);

    const rooms = db.stmnRooms.filter((x) => x.shopId === shopId && (since <= 0 || toInt(x.updated_at, 0) > since));
    const bookings = db.stmnBookings.filter((x) => x.shopId === shopId && (since <= 0 || toInt(x.updated_at, 0) > since));

    return res.json({ ok: true, rooms, bookings, serverTime: Date.now() });
  } catch (e) {
    console.error("GET /api/stmn/sync/pull error", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

export default r;
