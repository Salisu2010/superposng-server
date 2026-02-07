import crypto from "crypto";

// ------------------------------------------------------------
// SuperPOSNG SPNG1 Offline Token utilities (Python/Android compatible)
// Token format:
//   SPNG1|MONTHLY|YYYYMMDD|DEVHASH16|SIG12
// Where:
//   DEVHASH16 = sha256(android_id.lower().trim())[:16].upper()
//   SIG12     = hmac_sha256(SECRET, payload)[:12].upper()
//   payload   = SPNG1|PLAN|YYYYMMDD|DEVHASH16
// ------------------------------------------------------------

const PREFIX = "SPNG1";

function s(v) {
  return (v === null || v === undefined) ? "" : String(v);
}

export function trim(v) {
  return s(v).trim();
}

export function spngSecret() {
  // Prefer env (safer in production), fallback to legacy hardcoded value
  return trim(process.env.SPNG_SECRET) || "DAURAWA_SUPERPOSNG_PRIVATE_2026";
}

export function sha256HexUpper(data) {
  const h = crypto.createHash("sha256").update(trim(data).toLowerCase(), "utf8").digest("hex");
  return h.toUpperCase();
}

export function devhash16(androidId) {
  const a = trim(androidId).toLowerCase();
  if (!a) throw new Error("ANDROID_ID is required");
  return sha256HexUpper(a).slice(0, 16);
}

export function hmacSha256HexUpper(key, payload) {
  const mac = crypto.createHmac("sha256", key).update(payload, "utf8").digest("hex");
  return mac.toUpperCase();
}

// Nigeria is UTC+1 and does not observe DST.
// To match your Python (run in Nigeria) and Android device date logic,
// we compute "today" based on Africa/Lagos.
export function todayInLagos() {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Lagos",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const y = parseInt(parts.find(p => p.type === "year")?.value || "0", 10);
  const m = parseInt(parts.find(p => p.type === "month")?.value || "0", 10);
  const d = parseInt(parts.find(p => p.type === "day")?.value || "0", 10);
  return { y, m, d };
}

export function addMonthsYmd({ y, m, d }, months) {
  const mm = Math.max(0, parseInt(months || "0", 10));
  const year = y + Math.floor((m - 1 + mm) / 12);
  const month = ((m - 1 + mm) % 12) + 1;
  const isLeap = (year % 4 === 0) && (year % 100 !== 0 || year % 400 === 0);
  const mdays = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = Math.min(d, mdays);
  const ymd = `${year}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
  return { y: year, m: month, d: day, ymd };
}

export function ymdToExpiresAtUtc(ymd) {
  const t = trim(ymd);
  if (!/^\d{8}$/.test(t)) return 0;
  const y = parseInt(t.slice(0, 4), 10);
  const m = parseInt(t.slice(4, 6), 10);
  const d = parseInt(t.slice(6, 8), 10);
  // End of day UTC (close enough; Android checks by ymd integer)
  return Date.UTC(y, m - 1, d, 23, 59, 59, 999);
}

export function genSpng1Token(plan, androidId, ymdOverride = "") {
  const p = trim(plan).toUpperCase();
  if (p !== "MONTHLY" && p !== "YEARLY") throw new Error("plan must be MONTHLY or YEARLY");

  const expYmd = trim(ymdOverride) || (() => {
    const today = todayInLagos();
    const exp = addMonthsYmd(today, p === "MONTHLY" ? 1 : 12);
    return exp.ymd;
  })();

  const dh = devhash16(androidId);
  const payload = `${PREFIX}|${p}|${expYmd}|${dh}`;
  const sig12 = hmacSha256HexUpper(spngSecret(), payload).slice(0, 12);
  return `${payload}|${sig12}`;
}

export function normalizeToken(raw) {
  let t = trim(raw);
  if (!t) return "";
  if (t.startsWith("'") || t.startsWith('"') || t.startsWith("`")) t = t.slice(1);
  if (t.endsWith("'") || t.endsWith('"') || t.endsWith("`")) t = t.slice(0, -1);
  t = t.replace(/[\n\r\t\s]/g, "");
  t = t.replace(/｜|¦|∣/g, "|");
  return trim(t);
}

export function parseAndVerifySpng1(tokenRaw) {
  const token = normalizeToken(tokenRaw);
  if (!token) return { ok: false, error: "Empty token" };
  const parts = token.split("|").map(x => trim(x));
  if (parts.length !== 5) return { ok: false, error: "Invalid token format" };
  const [pref, plan, ymd, devHash, sig] = parts;
  if (pref.toUpperCase() !== PREFIX) return { ok: false, error: "Invalid token prefix" };
  const p = trim(plan).toUpperCase();
  if (p !== "MONTHLY" && p !== "YEARLY") return { ok: false, error: "Invalid plan" };
  if (!/^\d{8}$/.test(ymd)) return { ok: false, error: "Invalid expiry" };
  if (!/^[0-9A-F]{16}$/.test(devHash.toUpperCase())) return { ok: false, error: "Invalid device hash" };
  if (!/^[0-9A-F]{12}$/.test(sig.toUpperCase())) return { ok: false, error: "Invalid signature" };
  const payload = `${PREFIX}|${p}|${ymd}|${devHash.toUpperCase()}`;
  const expected = hmacSha256HexUpper(spngSecret(), payload).slice(0, 12);
  if (expected.toUpperCase() !== sig.toUpperCase()) return { ok: false, error: "Token not valid" };
  return {
    ok: true,
    token: `${payload}|${sig.toUpperCase()}`,
    plan: p,
    expiryYmd: ymd,
    devHash: devHash.toUpperCase(),
    payload,
    sig: sig.toUpperCase(),
    expiresAt: ymdToExpiresAtUtc(ymd)
  };
}

export function daysLeftFromYmd(expiryYmd) {
  const t = trim(expiryYmd);
  if (!/^\d{8}$/.test(t)) return 0;
  const y = parseInt(t.slice(0, 4), 10);
  const m = parseInt(t.slice(4, 6), 10);
  const d = parseInt(t.slice(6, 8), 10);

  const end = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999)).getTime();
  const now = Date.now();
  const diff = end - now;
  if (diff <= 0) return 0;
  const day = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.min(3660, Math.ceil(diff / day)));
}
