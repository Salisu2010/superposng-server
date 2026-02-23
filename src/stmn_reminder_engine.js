/**
 * StayMasterNG Smart Reminder Engine (Server-side)
 *
 * Goal: send FCM "reminder" pushes shortly before checkout time so the
 * Android apps can auto-open WhatsApp/SMS with a prefilled message.
 *
 * Notes:
 * - WhatsApp cannot be sent directly from this server without WhatsApp Business API.
 *   So we only PUSH a reminder to devices; client handles WhatsApp/SMS compose.
 * - Reminders are deduplicated in db.json (db.stmnReminderLog).
 */

import { readDB, writeDB } from "./db.js";
import { pushShopChange } from "./fcm.js";

function toInt(v, def = 0) {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : def;
}

function trim(v) {
  return (v ?? "").toString().trim();
}

function normalizeStatus(s) {
  return trim(s).toLowerCase();
}

function ensure(db) {
  db.stmnBookings = Array.isArray(db.stmnBookings) ? db.stmnBookings : [];
  db.stmnReminderLog = Array.isArray(db.stmnReminderLog) ? db.stmnReminderLog : [];
}

function computeCheckoutAt(b) {
  const explicit = toInt(b?.check_out_at, 0);
  if (explicit > 0) return explicit;

  const ci = toInt(b?.check_in_at, 0);
  if (!ci) return 0;

  const mode = normalizeStatus(b?.booking_mode || b?.bookingMode || "nightly");
  const hours = toInt(b?.hours, 0);
  const nights = Math.max(1, toInt(b?.nights, 1));

  if (mode.includes("hour") || hours > 0) {
    const h = Math.max(1, hours || 1);
    return ci + h * 60 * 60 * 1000;
  }
  return ci + nights * 24 * 60 * 60 * 1000;
}

function logKey(shopId, bookingKey, stage) {
  return `${shopId}:${bookingKey}:${stage}`;
}

function alreadySent(db, key) {
  return db.stmnReminderLog.some((x) => x && x.key === key);
}

function addSent(db, key, meta) {
  db.stmnReminderLog.push({ key, at: Date.now(), ...meta });
  if (db.stmnReminderLog.length > 50000) db.stmnReminderLog = db.stmnReminderLog.slice(-50000);
}

function buildMessage({ guestName, roomNumber, minutesLeft }) {
  const g = guestName || "Guest";
  const rn = roomNumber || "";
  if (minutesLeft <= 0) {
    return `Hello ${g}, your stay time has ended. Please proceed to checkout. (Room ${rn})`;
  }
  if (minutesLeft <= 30) {
    return `Hello ${g}, checkout is in ${minutesLeft} minutes. Please prepare for checkout. (Room ${rn})`;
  }
  const hoursLeft = Math.round((minutesLeft / 60) * 10) / 10;
  return `Hello ${g}, checkout is in about ${hoursLeft} hour(s). Kindly prepare for checkout. (Room ${rn})`;
}

/**
 * Starts the reminder loop.
 *
 * Env:
 *  - STMN_REMINDER_ENABLED=1
 *  - STMN_REMINDER_INTERVAL_MS (default 120000)
 */
export function startStmnReminderEngine() {
  const enabled = String(process.env.STMN_REMINDER_ENABLED || "1") === "1";
  if (!enabled) return;

  const interval = parseInt(process.env.STMN_REMINDER_INTERVAL_MS || "120000", 10) || 120000;

  setInterval(async () => {
    try {
      const db = readDB();
      if (!db) return;
      ensure(db);

      const now = Date.now();

      // Stages: 2 hours, 30 mins, overdue (15 mins past checkout)
      const stages = [
        { name: "2h", windowMs: 2 * 60 * 60 * 1000, toleranceMs: 6 * 60 * 1000 },
        { name: "30m", windowMs: 30 * 60 * 1000, toleranceMs: 5 * 60 * 1000 },
        { name: "overdue", windowMs: -15 * 60 * 1000, toleranceMs: 10 * 60 * 1000 },
      ];

      // Group by shopId so we can send per shop
      const byShop = new Map();
      for (const b of db.stmnBookings) {
        const shopId = trim(b?.shopId);
        if (!shopId) continue;
        const status = normalizeStatus(b?.status);
        if (status && (status.includes("complete") || status.includes("checkout") || status.includes("checked") || status === "done")) {
          continue;
        }
        if (!byShop.has(shopId)) byShop.set(shopId, []);
        byShop.get(shopId).push(b);
      }

      let changed = false;

      for (const [shopId, list] of byShop.entries()) {
        for (const b of list) {
          const checkoutAt = computeCheckoutAt(b);
          if (!checkoutAt) continue;

          const delta = checkoutAt - now; // ms until checkout (negative if overdue)

          for (const st of stages) {
            const target = st.windowMs;
            // For overdue stage, delta is negative and we want around -15min
            if (Math.abs(delta - target) > st.toleranceMs) continue;

            const bookingKey = trim(b?.key) || `${trim(b?.shopId)}:${trim(b?.branchId)}:${trim(b?.room_number)}:${toInt(b?.check_in_at, 0)}`;
            const lk = logKey(shopId, bookingKey, st.name);
            if (alreadySent(db, lk)) continue;

            const guestName = trim(b?.guest_name || b?.guestName);
            const guestPhone = trim(b?.guest_phone || b?.guestPhone);
            const roomNumber = trim(b?.room_number || b?.roomNumber);

            // Only remind if phone exists (for WhatsApp/SMS)
            if (!guestPhone) {
              addSent(db, lk, { shopId, reason: "missing_phone" });
              changed = true;
              continue;
            }

            const minutesLeft = Math.round(delta / 60000);
            const message = buildMessage({ guestName, roomNumber, minutesLeft });

            // Push to devices: client decides whether to open WhatsApp or SMS.
            try {
              await pushShopChange(
                shopId,
                {
                  type: "stmn_reminder",
                  stage: st.name,
                  bookingKey,
                  guestName,
                  guestPhone,
                  roomNumber,
                  message,
                  at: String(now),
                },
                {
                  title: "Guest Reminder",
                  body: `${guestName || "Guest"} • Room ${roomNumber} • ${st.name}`,
                }
              );
            } catch {}

            addSent(db, lk, { shopId, bookingKey, stage: st.name, guestPhone, roomNumber });
            changed = true;
          }
        }
      }

      if (changed) writeDB(db);
    } catch {}
  }, interval);
}
