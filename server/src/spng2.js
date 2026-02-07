import crypto from "crypto";
import {
  trim,
  spngSecret,
  sha256HexUpper,
  hmacSha256HexUpper,
  todayInLagos,
  addMonthsYmd,
  ymdToExpiresAtUtc,
  normalizeToken,
} from "./spng1.js";

// ------------------------------------------------------------
// SuperPOSNG SPNG2 Anti-Clone Token utilities (Cloud/Android compatible)
// Token format (same lengths as SPNG1 for simplicity):
//   SPNG2|PLAN|YYYYMMDD|DEVHASH16|SIG12
// Where:
//   DEVHASH16 = sha256( android_id.lower().trim() + "|" + fp_hash.lower().trim() )[:16].upper()
//   SIG12     = hmac_sha256(SECRET, payload)[:12].upper()
//   payload   = SPNG2|PLAN|YYYYMMDD|DEVHASH16
//
// fp_hash is a device fingerprint hash produced by the Android app.
// ------------------------------------------------------------

const PREFIX = "SPNG2";

export function devhash16Spng2(androidId, fpHash) {
  const a = trim(androidId).toLowerCase();
  const f = trim(fpHash).toLowerCase();
  if (!a) throw new Error("ANDROID_ID is required");
  if (!f) throw new Error("FP_HASH is required");
  return sha256HexUpper(`${a}|${f}`).slice(0, 16);
}

export function genSpng2Token(plan, androidId, fpHash, ymdOverride = "") {
  const p = trim(plan).toUpperCase();
  if (p !== "MONTHLY" && p !== "YEARLY") throw new Error("plan must be MONTHLY or YEARLY");

  const expYmd = trim(ymdOverride) || (() => {
    const today = todayInLagos();
    const exp = addMonthsYmd(today, p === "MONTHLY" ? 1 : 12);
    return exp.ymd;
  })();

  const dh = devhash16Spng2(androidId, fpHash);
  const payload = `${PREFIX}|${p}|${expYmd}|${dh}`;
  const sig12 = hmacSha256HexUpper(spngSecret(), payload).slice(0, 12);
  return `${payload}|${sig12}`;
}

export function parseAndVerifySpng2(tokenRaw) {
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
