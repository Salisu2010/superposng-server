/* SuperPOSNG Developer Portal
 * - Search device/token/shop
 * - Activate device (assign token)
 * - Reset / Revoke
 * - Extend expiry / Upgrade plan
 */

const $ = (id) => document.getElementById(id);

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.style.display = "none"), 2600);
}

function getKey() {
  return localStorage.getItem("spng_dev_key") || "";
}

function setKey(v) {
  localStorage.setItem("spng_dev_key", v || "");
}

let _lastGenerated = null; // { licenseId, token }
let _lastRmpGenerated = null; // { licenseId, token }
let _lastStmnGenerated = null; // { licenseId, token }
let _tblOffset = 0;
const _tblLimit = 50;

let _rmpTblOffset = 0;
const _rmpTblLimit = 50;

async function api(path, opts = {}) {
  const key = getKey() || $("devKey").value.trim();
  const headers = Object.assign(
    {
      "Content-Type": "application/json",
      "X-DEV-KEY": key,
    },
    (opts.headers || {})
  );
  const res = await fetch(path, Object.assign({}, opts, { headers }));
  let json = null;
  try { json = await res.json(); } catch { /* ignore */ }
  if (!res.ok) {
    const err = (json && (json.error || json.message)) ? (json.error || json.message) : `HTTP ${res.status}`;
    throw new Error(err);
  }
  return json;
}

function fmtTs(ms) {
  const n = Number(ms || 0);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const d = new Date(n);
  return d.toISOString().slice(0, 10);
}

function renderResults(data) {
  const box = $("results");
  if (!data) {
    box.innerHTML = "";
    return;
  }

  const matches = Array.isArray(data.matches) ? data.matches : [];
  const pending = Array.isArray(data.pending) ? data.pending : [];

  const pills = [
    `<span class="pill">Matches: <b>${matches.length}</b></span>`,
    `<span class="pill">Pending: <b>${pending.length}</b></span>`,
  ].join("");

  const rows = matches.map((m) => {
    const id = (m.licenseId || "");
    const token = (m.token || "");
    const status = (m.status || "");
    const plan = (m.plan || "");
    const exp = fmtTs(m.expiresAt);
    const dev = (m.boundDeviceId || "-");
    const shop = (m.boundShopId || "-");
    return `
      <tr>
        <td><code>${id}</code></td>
        <td><code>${token}</code></td>
        <td>${status}</td>
        <td>${plan}</td>
        <td>${exp}</td>
        <td><code>${dev}</code></td>
        <td><code>${shop}</code></td>
        <td>
          <button class="btn" data-copy="${id}">Copy ID</button>
        </td>
      </tr>
    `;
  }).join("");

  const pendRows = pending.map((p) => {
    return `
      <tr>
        <td><code>${p.deviceId || ""}</code></td>
        <td><code>${p.token || ""}</code></td>
        <td>${p.plan || ""}</td>
        <td>${fmtTs(p.expiresAt)}</td>
        <td><code>${p.shopId || "-"}</code></td>
      </tr>
    `;
  }).join("");

  box.innerHTML = `
    <div>${pills}</div>
    <h3 style="margin:12px 0 6px; font-size:13px; color:var(--muted)">Licenses</h3>
    <table class="table">
      <thead>
        <tr>
          <th>License ID</th>
          <th>Token</th>
          <th>Status</th>
          <th>Plan</th>
          <th>Expiry</th>
          <th>Device</th>
          <th>Shop</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="8" style="color:var(--muted)">No matches</td></tr>`}
      </tbody>
    </table>

    <h3 style="margin:12px 0 6px; font-size:13px; color:var(--muted)">Pending Activations</h3>
    <table class="table">
      <thead>
        <tr>
          <th>Device ID</th>
          <th>Token</th>
          <th>Plan</th>
          <th>Expiry</th>
          <th>Shop</th>
        </tr>
      </thead>
      <tbody>
        ${pendRows || `<tr><td colspan="5" style="color:var(--muted)">No pending activations</td></tr>`}
      </tbody>
    </table>
  `;

  // Hook Copy buttons
  box.querySelectorAll("button[data-copy]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-copy") || "";
      $("target").value = v;
      navigator.clipboard.writeText(v).catch(() => {});
      toast("Copied License ID → Target");
    });
  });
}

async function doSearch() {
  const deviceId = $("searchDevice").value.trim();
  const token = $("searchToken").value.trim();
  const shopId = $("searchShop").value.trim();
  if (!deviceId && !token && !shopId) {
    toast("Enter deviceId or token or shopId");
    return;
  }
  const qs = new URLSearchParams();
  if (deviceId) qs.set("deviceId", deviceId);
  if (token) qs.set("token", token);
  if (shopId) qs.set("shopId", shopId);
  const data = await api(`/api/dev/search?${qs.toString()}`, { method: "GET" });
  renderResults(data);
  toast("Search done");
}

async function doAssign() {
  const deviceId = $("deviceId").value.trim();
  const token = $("token").value.trim();
  const shopId = $("shopId").value.trim();
  if (!deviceId || !token) {
    toast("Device ID and Token are required");
    return;
  }
  const data = await api("/api/dev/assign-token", {
    method: "POST",
    body: JSON.stringify({ deviceId, token, shopId })
  });
  toast("Assigned. Customer can claim now.");
  // Auto-search
  $("searchDevice").value = deviceId;
  $("searchToken").value = token;
  $("searchShop").value = shopId;
  await doSearch();
}

function parseTarget(v) {
  const t = (v || "").trim();
  if (!t) return {};
  if (/^LIC-/i.test(t)) return { licenseId: t };
  if (t.includes("|")) return { token: t };
  if (/^SPNG/i.test(t)) return { token: t };
  return { deviceId: t };
}

async function doRevoke(resetOnly) {
  const reason = $("reason").value.trim();
  const target = $("target").value.trim();
  const payload = Object.assign(parseTarget(target), { reason, resetOnly: !!resetOnly });
  if (!payload.licenseId && !payload.token && !payload.deviceId) {
    toast("Target is required");
    return;
  }
  const out = await api("/api/dev/revoke", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  toast(resetOnly ? "Reset OK" : "Revoked OK");
  // Refresh search
  if (payload.deviceId) $("searchDevice").value = payload.deviceId;
  if (payload.token) $("searchToken").value = payload.token;
  if (payload.licenseId) { /* keep */ }
  await doSearch().catch(() => {});
  return out;
}

async function doExtend() {
  const target = $("target").value.trim();
  const addMonths = Number($("addMonths")?.value || 0);
  const plan = $("plan").value;
  const payload = Object.assign(parseTarget(target), {
    months: Number.isFinite(addMonths) ? addMonths : 0,
    plan: plan || "",
    androidId: ($("extendAndroidId")?.value || "").trim()
  });
  if (!payload.licenseId && !payload.token && !payload.deviceId) {
    toast("Target is required");
    return;
  }
  const out = await api("/api/dev/extend", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  toast("Extended/Upgraded OK");
  await doSearch().catch(() => {});
  return out;
}

// ------------------------------
// Token generator (plan-aware)
// ------------------------------
async function doGenerateToken() {
  const plan = ($("genPlan")?.value || "MONTHLY").trim();
  const deviceId = ($("genDeviceId")?.value || $("deviceId")?.value || "").trim();
  if (!deviceId) {
    toast("ANDROID_ID/Device ID is required");
    return;
  }

  const useSpng2 = $("genUseSpng2") ? !!$("genUseSpng2").checked : false;
  const fpHash = (useSpng2 && $("genFpHash")) ? ($("genFpHash").value || "") : "";
  const payload = (useSpng2 && fpHash.trim()) ? { plan, deviceId, fpHash: fpHash.trim() } : { plan, deviceId };

  const out = await api("/api/dev/generate-token", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  _lastGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : null;
  if ($("genToken")) $("genToken").value = _lastGenerated?.token || "";
  // also copy into activate box for convenience
  if ($("token")) $("token").value = _lastGenerated?.token || $("token").value;
  toast("Token generated");
  await refreshTokenTable(true).catch(() => {});
  return out;
}

async function doRegisterExistingToken() {
  const token = ($("genToken")?.value || "").trim();
  if (!token) {
    toast("Paste token into Token field first");
    return;
  }
  const plan = ($("genPlan")?.value || "").trim();
  const payload = { token };
  // Optional override
  if (plan) payload.plan = plan;

  const out = await api("/api/dev/register-token", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  _lastGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : _lastGenerated;
  toast(out?.already ? "Token already registered" : "Token registered");
  await refreshTokenTable(true).catch(() => {});
  return out;
}

// ------------------------------
// RepairMasterPro token generator
// ------------------------------
async function doGenerateRmpToken() {
  const plan = ($("rmpPlan")?.value || "MONTHLY").trim();
  const deviceId = ($("rmpDeviceId")?.value || "").trim();
  if (!deviceId) {
    toast("ANDROID_ID/Device ID is required");
    return;
  }

  const out = await api("/api/rmp/dev/generate-token", {
    method: "POST",
    body: JSON.stringify({ plan, deviceId })
  });

  _lastRmpGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : null;
  if ($("rmpToken")) $("rmpToken").value = _lastRmpGenerated?.token || "";
  toast("RMP token generated");
  return out;
}

async function doActivateRmpOnline() {
  const plan = ($("rmpPlan")?.value || "MONTHLY").trim();
  const androidId = ($("rmpDeviceId")?.value || "").trim();
  if (!androidId) {
    toast("ANDROID_ID is required");
    return;
  }

  const out = await api("/api/rmp/dev/activate-online", {
    method: "POST",
    body: JSON.stringify({ plan, androidId })
  });

  const token = out?.token || out?.license?.token || "";
  if ($("rmpToken")) $("rmpToken").value = token;
  toast("RMP activated online ✅");
  return out;
}

// ------------------------------
// StayMasterNG token generator (STMN1/STMN2)
// ------------------------------
async function doGenerateStmnToken() {
  const plan = ($("stmnPlan")?.value || "MONTHLY").trim();
  const deviceId = ($("stmnDeviceId")?.value || "").trim();
  const use2 = $("stmnUseStmn2") ? !!$("stmnUseStmn2").checked : false;
  const fpHash = use2 ? ($("stmnFpHash")?.value || "").trim() : "";

  if (!deviceId) {
    toast("ANDROID_ID/Device ID is required");
    return;
  }
  if (use2 && !fpHash) {
    toast("Paste Device Code (STMN2)");
    return;
  }

  const out = await api("/api/stmn/dev/generate-token", {
    method: "POST",
    body: JSON.stringify({ plan, deviceId, fpHash })
  });

  _lastStmnGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : null;
  if ($("stmnToken")) $("stmnToken").value = _lastStmnGenerated?.token || "";
  toast("STMN token generated");
  return out;
}

// ------------------------------
// StayMasterNG: Activate device online (bind token to device)
// ------------------------------
async function doActivateStmnDevice() {
  const token = ($("stmnActToken")?.value || "").trim();
  const androidId = ($("stmnActAndroidId")?.value || "").trim();
  const fpHash = ($("stmnActFpHash")?.value || "").trim();

  if (!token) {
    toast("Token is required");
    return;
  }
  if (!androidId) {
    toast("ANDROID_ID is required");
    return;
  }

  const out = await api("/api/stmn/dev/activate-device", {
    method: "POST",
    body: JSON.stringify({ token, androidId, fpHash })
  });

  toast("STMN device activated ✅");
  return out;
}

function updateStmn2Ui() {
  const use = $("stmnUseStmn2") ? !!$("stmnUseStmn2").checked : false;
  if ($("stmnFpWrap")) $("stmnFpWrap").style.display = use ? "block" : "none";
  if (!use && $("stmnFpHash")) $("stmnFpHash").value = "";
}

function copyText(v) {
  const s = String(v || "");
  if (!s) return;
  navigator.clipboard.writeText(s).catch(() => {});
}

// ------------------------------
// Token table (listing)
// ------------------------------
function tableParams() {
  const q = ($("tblQ")?.value || "").trim();
  const status = ($("tblStatus")?.value || "").trim();
  const plan = ($("tblPlan")?.value || "").trim();
  return { q, status, plan };
}

async function refreshTokenTable(resetOffset) {
  if (resetOffset) _tblOffset = 0;
  const { q, status, plan } = tableParams();
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (plan) qs.set("plan", plan);
  qs.set("limit", String(_tblLimit));
  qs.set("offset", String(_tblOffset));

  const out = await api(`/api/dev/licenses?${qs.toString()}`, { method: "GET" });
  renderTokenTable(out);
  return out;
}

function actionBtn(label, cls, data) {
  const attrs = Object.entries(data || {}).map(([k, v]) => `data-${k}="${String(v)}"`).join(" ");
  return `<button class="btn ${cls || ""}" ${attrs}>${label}</button>`;
}

function renderTokenTable(out) {
  const box = $("tokenTable");
  const meta = $("tblMeta");
  if (!box) return;

  const items = Array.isArray(out?.items) ? out.items : [];
  const total = Number(out?.total || 0);
  const start = total === 0 ? 0 : (_tblOffset + 1);
  const end = Math.min(_tblOffset + _tblLimit, total);
  if (meta) meta.textContent = `Showing ${start}-${end} of ${total}`;

  const rows = items.map((m) => {
    const id = m.licenseId || "";
    const token = m.token || "";
    const status = m.status || "";
    const plan = m.plan || "";
    const exp = fmtTs(m.expiresAt);
    const dev = m.boundDeviceId || "-";
    const shop = m.boundShopId || "-";
    return `
      <tr>
        <td><code>${id}</code></td>
        <td><code>${token}</code></td>
        <td>${status}</td>
        <td>${plan}</td>
        <td>${exp}</td>
        <td><code>${dev}</code></td>
        <td><code>${shop}</code></td>
        <td style="white-space:nowrap">
          ${actionBtn("Copy", "", { act: "copy", token })}
          ${actionBtn("Target", "", { act: "target", id })}
          ${actionBtn("+1M", "", { act: "add", id, months: 1 })}
          ${actionBtn("+12M", "", { act: "add", id, months: 12 })}
          ${actionBtn("Revoke", "danger", { act: "revoke", id })}
        </td>
      </tr>
    `;
  }).join("");

  box.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>License ID</th>
          <th>Token</th>
          <th>Status</th>
          <th>Plan</th>
          <th>Expiry</th>
          <th>Device</th>
          <th>Shop</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="8" style="color:var(--muted)">No tokens found</td></tr>`}
      </tbody>
    </table>
  `;

  box.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id") || "";
      const token = btn.getAttribute("data-token") || "";
      const months = Number(btn.getAttribute("data-months") || 0);

      if (act === "copy") {
        copyText(token);
        toast("Copied token");
        return;
      }
      if (act === "target") {
        $("target").value = id;
        copyText(id);
        toast("Target set to License ID");
        return;
      }
      if (act === "add") {
        $("target").value = id;
        $("addMonths").value = String(months);
        await doExtend();
        await refreshTokenTable(false).catch(() => {});
        return;
      }
      if (act === "revoke") {
        $("target").value = id;
        await doRevoke(false);
        await refreshTokenTable(false).catch(() => {});
      }
    });
  });
}

// ------------------------------
// RepairMasterPro license table (listing)
// ------------------------------
function rmpTableParams() {
  const q = ($("rmpTblQ")?.value || "").trim();
  const status = ($("rmpTblStatus")?.value || "").trim();
  const plan = ($("rmpTblPlan")?.value || "").trim();
  return { q, status, plan };
}

async function refreshRmpTokenTable(resetOffset) {
  if (resetOffset) _rmpTblOffset = 0;
  const { q, status, plan } = rmpTableParams();
  const qs = new URLSearchParams();
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (plan) qs.set("plan", plan);
  qs.set("limit", String(_rmpTblLimit));
  qs.set("offset", String(_rmpTblOffset));

  const out = await api(`/api/rmp/dev/licenses?${qs.toString()}`, { method: "GET" });
  renderRmpTokenTable(out);
  return out;
}

function renderRmpTokenTable(out) {
  const box = $("rmpTokenTable");
  const meta = $("rmpTblMeta");
  if (!box) return;

  const items = Array.isArray(out?.items) ? out.items : [];
  const total = Number(out?.total || 0);
  const start = total === 0 ? 0 : (_rmpTblOffset + 1);
  const end = Math.min(_rmpTblOffset + _rmpTblLimit, total);
  if (meta) meta.textContent = `Showing ${start}-${end} of ${total}`;

  const rows = items.map((m) => {
    const id = m.licenseId || "";
    const token = m.token || "";
    const status = m.status || "";
    const plan = m.plan || "";
    const exp = fmtTs(m.expiresAt);
    const dev = m.boundDeviceId || "-";
    const hash = m.devHash || "-";
    return `
      <tr>
        <td><code>${id}</code></td>
        <td><code>${token}</code></td>
        <td>${status}</td>
        <td>${plan}</td>
        <td>${exp}</td>
        <td><code>${dev}</code></td>
        <td><code>${hash}</code></td>
        <td style="white-space:nowrap">
          ${actionBtn("Copy", "", { act: "rmp_copy", token })}
          ${actionBtn("Revoke", "danger", { act: "rmp_revoke", token })}
        </td>
      </tr>
    `;
  }).join("");

  box.innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>License ID</th>
          <th>Token</th>
          <th>Status</th>
          <th>Plan</th>
          <th>Expiry</th>
          <th>Device</th>
          <th>DevHash</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="8" style="color:var(--muted)">No RMP licenses found</td></tr>`}
      </tbody>
    </table>
  `;

  box.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const token = btn.getAttribute("data-token") || "";
      if (act === "rmp_copy") {
        copyText(token);
        toast("Copied RMP token");
        return;
      }
      if (act === "rmp_revoke") {
        if (!token) return;
        await api("/api/rmp/dev/revoke", { method: "POST", body: JSON.stringify({ token }) });
        toast("RMP token revoked");
        await refreshRmpTokenTable(false).catch(() => {});
        return;
      }
    });
  });
}

// Init
$("devKey").value = getKey();

$("btnSaveKey").addEventListener("click", () => {
  const v = $("devKey").value.trim();
  setKey(v);
  toast("DEV KEY saved");
});

// Generator
function updateSpng2Ui() {
  const use = $("genUseSpng2") ? !!$("genUseSpng2").checked : false;
  if ($("genFpWrap")) {
    $("genFpWrap").style.display = use ? "block" : "none";
  }
  if (!use && $("genFpHash")) {
    $("genFpHash").value = "";
  }
}

if ($("genUseSpng2")) {
  $("genUseSpng2").addEventListener("change", updateSpng2Ui);
}
updateSpng2Ui();

if ($("btnGenerate")) {
  $("btnGenerate").addEventListener("click", () => doGenerateToken().catch((e) => toast(e.message)));
}
if ($("btnRegister")) {
  $("btnRegister").addEventListener("click", () => doRegisterExistingToken().catch((e) => toast(e.message)));
}
if ($("btnCopyToken")) {
  $("btnCopyToken").addEventListener("click", () => {
    copyText($("genToken")?.value || "");
    toast("Copied token");
  });
}
if ($("btnCopyId")) {
  $("btnCopyId").addEventListener("click", () => {
    copyText(_lastGenerated?.licenseId || "");
    toast("Copied license ID");
  });
}

// RMP Generator
if ($("btnRmpGenerate")) {
  $("btnRmpGenerate").addEventListener("click", () => doGenerateRmpToken().catch((e) => toast(e.message)));
}
if ($("btnRmpActivateOnline")) {
  $("btnRmpActivateOnline").addEventListener("click", () => doActivateRmpOnline().catch((e) => toast(e.message)));
}
if ($("btnRmpCopy")) {
  $("btnRmpCopy").addEventListener("click", () => {
    copyText($("rmpToken")?.value || "");
    toast("Copied RMP token");
  });
}

// STMN Generator
if ($("stmnUseStmn2")) {
  $("stmnUseStmn2").addEventListener("change", updateStmn2Ui);
  updateStmn2Ui();
}
if ($("btnStmnGenerate")) {
  $("btnStmnGenerate").addEventListener("click", () => doGenerateStmnToken().catch((e) => toast(e.message)));
}
if ($("btnStmnCopy")) {
  $("btnStmnCopy").addEventListener("click", () => {
    copyText($("stmnToken")?.value || "");
    toast("Copied STMN token");
  });
}

if ($("btnStmnActivateDevice")) {
  $("btnStmnActivateDevice").addEventListener("click", () => doActivateStmnDevice().catch((e) => toast(e.message)));
}
if ($("btnStmnActivateDeviceFill")) {
  $("btnStmnActivateDeviceFill").addEventListener("click", () => {
    if ($("stmnActToken")) $("stmnActToken").value = $("stmnToken")?.value || _lastStmnGenerated?.token || "";
    if ($("stmnActAndroidId") && !$("stmnActAndroidId").value.trim()) $("stmnActAndroidId").value = $("stmnDeviceId")?.value || "";
    if ($("stmnActFpHash") && !$("stmnActFpHash").value.trim()) $("stmnActFpHash").value = $("stmnFpHash")?.value || "";
    toast("Filled from generator");
  });
}

// Sync generator Device ID with activation field (optional convenience)
if ($("genDeviceId")) {
  $("genDeviceId").addEventListener("input", () => {
    const v = $("genDeviceId").value.trim();
    if ($("deviceId") && !$("deviceId").value.trim()) $("deviceId").value = v;
  });
}
if ($("deviceId")) {
  $("deviceId").addEventListener("input", () => {
    const v = $("deviceId").value.trim();
    if ($("genDeviceId") && !$("genDeviceId").value.trim()) $("genDeviceId").value = v;
  });
}

// Token table controls
if ($("btnTblRefresh")) {
  $("btnTblRefresh").addEventListener("click", () => refreshTokenTable(true).catch((e) => toast(e.message)));
}
if ($("tblQ")) {
  $("tblQ").addEventListener("input", () => {
    // light debounce
    clearTimeout(refreshTokenTable._t);
    refreshTokenTable._t = setTimeout(() => refreshTokenTable(true).catch(() => {}), 300);
  });
}
if ($("tblStatus")) {
  $("tblStatus").addEventListener("change", () => refreshTokenTable(true).catch(() => {}));
}
if ($("tblPlan")) {
  $("tblPlan").addEventListener("change", () => refreshTokenTable(true).catch(() => {}));
}
if ($("btnTblPrev")) {
  $("btnTblPrev").addEventListener("click", () => {
    _tblOffset = Math.max(0, _tblOffset - _tblLimit);
    refreshTokenTable(false).catch((e) => toast(e.message));
  });
}
if ($("btnTblNext")) {
  $("btnTblNext").addEventListener("click", async () => {
    const out = await refreshTokenTable(false).catch((e) => { toast(e.message); return null; });
    const total = Number(out?.total || 0);
    if (_tblOffset + _tblLimit < total) {
      _tblOffset += _tblLimit;
      refreshTokenTable(false).catch((e) => toast(e.message));
    } else {
      toast("No more pages");
    }
  });
}

// RMP token table controls
if ($("btnRmpTblRefresh")) {
  $("btnRmpTblRefresh").addEventListener("click", () => refreshRmpTokenTable(true).catch((e) => toast(e.message)));
}
if ($("rmpTblQ")) {
  $("rmpTblQ").addEventListener("input", () => {
    clearTimeout(refreshRmpTokenTable._t);
    refreshRmpTokenTable._t = setTimeout(() => refreshRmpTokenTable(true).catch(() => {}), 300);
  });
}
if ($("rmpTblStatus")) {
  $("rmpTblStatus").addEventListener("change", () => refreshRmpTokenTable(true).catch(() => {}));
}
if ($("rmpTblPlan")) {
  $("rmpTblPlan").addEventListener("change", () => refreshRmpTokenTable(true).catch(() => {}));
}
if ($("btnRmpTblPrev")) {
  $("btnRmpTblPrev").addEventListener("click", () => {
    _rmpTblOffset = Math.max(0, _rmpTblOffset - _rmpTblLimit);
    refreshRmpTokenTable(false).catch((e) => toast(e.message));
  });
}
if ($("btnRmpTblNext")) {
  $("btnRmpTblNext").addEventListener("click", async () => {
    const out = await refreshRmpTokenTable(false).catch((e) => { toast(e.message); return null; });
    const total = Number(out?.total || 0);
    if (_rmpTblOffset + _rmpTblLimit < total) {
      _rmpTblOffset += _rmpTblLimit;
      refreshRmpTokenTable(false).catch((e) => toast(e.message));
    } else {
      toast("No more pages");
    }
  });
}

$("btnAssign").addEventListener("click", () => doAssign().catch((e) => toast(e.message)));
$("btnSearchFromActivate").addEventListener("click", () => {
  $("searchDevice").value = $("deviceId").value.trim();
  $("searchToken").value = $("token").value.trim();
  $("searchShop").value = $("shopId").value.trim();
  doSearch().catch((e) => toast(e.message));
});

$("btnSearch").addEventListener("click", () => doSearch().catch((e) => toast(e.message)));
$("btnClear").addEventListener("click", () => {
  $("searchDevice").value = "";
  $("searchToken").value = "";
  $("searchShop").value = "";
  renderResults(null);
});

$("btnReset").addEventListener("click", () => doRevoke(true).catch((e) => toast(e.message)));
$("btnRevoke").addEventListener("click", () => doRevoke(false).catch((e) => toast(e.message)));
$("btnExtend").addEventListener("click", () => doExtend().catch((e) => toast(e.message)));

// Load token table on open
refreshTokenTable(true).catch(() => {});

// Load RMP license table on open
refreshRmpTokenTable(true).catch(() => {});


// ------------------------------
// Owner Accounts UI (Option 1)
// ------------------------------
function esc(s){return String(s||"").replace(/[&<>"]/g, c=>({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));}

async function loadShopOptions() {
  try {
    const data = await api("/api/dev/shops/list");
    const shops = (data.shops || []);
    const ownSel = $("ownShops");
    const fromSel = $("mergeFromShop");
    const toSel = $("mergeToShop");

    if (ownSel) ownSel.innerHTML = "";
    if (fromSel) fromSel.innerHTML = "";
    if (toSel) toSel.innerHTML = "";

    shops.forEach(sh => {
      const label = `${sh.shopName || "Shop"} (${sh.shopCode || sh.shopId})`;

      if (ownSel) {
        const opt = document.createElement("option");
        opt.value = sh.shopId;
        opt.textContent = label;
        ownSel.appendChild(opt);
      }

      if (fromSel) {
        const opt = document.createElement("option");
        opt.value = sh.shopId;
        opt.textContent = label;
        fromSel.appendChild(opt);
      }

      if (toSel) {
        const opt = document.createElement("option");
        opt.value = sh.shopId;
        opt.textContent = label;
        toSel.appendChild(opt);
      }
    });
  } catch (e) {
    // ignore until dev key saved
  }
}


async function loadOwners() {
  const wrap = $("ownersTable");
  if (!wrap) return;
  wrap.innerHTML = '<div class="hint">Loading owners...</div>';
  try {
    const data = await api("/api/dev/owners/list");
    const owners = data.owners || [];
    if (!owners.length) {
      wrap.innerHTML = '<div class="hint">No owners yet. Create one above.</div>';
      return;
    }
    const rows = owners.map(o => {
      const shops = (o.shops || []).join(", ");
      return `<div class="result-row owner-row" data-owner="${esc(o.ownerId)}">
        <div style="flex:1">
          <div style="font-weight:700">${esc(o.email)}</div>
          <div class="hint">Owner ID: <b>${esc(o.ownerId)}</b> • Shops: ${esc(shops || "(none)")}</div>
        </div>
        <button class="btn btn2" data-select="${esc(o.ownerId)}" style="margin-left:auto">Select</button>
      </div>`;
    }).join("");
    wrap.innerHTML = `<div class="results">${rows}</div>`;

    // hook buttons
    wrap.querySelectorAll("[data-select]").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.preventDefault();
        const id = btn.getAttribute("data-select");
        $("ownOwnerId").value = id;
        toast("Selected owner " + id);
      });
    });
    wrap.querySelectorAll(".owner-row").forEach(row => {
      row.addEventListener("click", (ev) => {
        const id = row.getAttribute("data-owner");
        if (id) $("ownOwnerId").value = id;
      });
    });
  } catch (e) {
    wrap.innerHTML = '<div class="hint">Enter DEV KEY and click Save, then reload owners.</div>';
  }
}



async function loadMergeHistory() {
  const wrap = $("mergeHistoryTable");
  if (!wrap) return;
  wrap.innerHTML = '<div class="hint">Loading merge history...</div>';
  try {
    const data = await api("/api/dev/shops/merge/history?limit=100");
    const logs = data.logs || [];
    if (!logs.length) {
      wrap.innerHTML = '<div class="hint">No merges yet.</div>';
      return;
    }
    const rows = logs.map(x => {
      const when = fmtTs(x.createdAt || 0);
      const from = `${x.fromShopName || ""} (${x.fromShopCode || x.fromShopId})`;
      const to = `${x.toShopName || ""} (${x.toShopCode || x.toShopId})`;
      const moved = x.moved || {};
      const movedTxt = Object.keys(moved).map(k => `${k}:${moved[k]}`).join(" | ");
      return `<div class="result-row" style="gap:10px;align-items:flex-start">
        <div style="min-width:90px"><b>${esc(when)}</b></div>
        <div style="flex:1">
          <div><b>FROM:</b> ${esc(from)}</div>
          <div><b>TO:</b> ${esc(to)}</div>
          <div class="hint small">${esc(movedTxt || "")}</div>
        </div>
      </div>`;
    }).join("");
    wrap.innerHTML = `<div class="results">${rows}</div>`;
  } catch (e) {
    wrap.innerHTML = '<div class="hint">Enter DEV KEY and click Save, then reload.</div>';
  }
}
function getSelectedShopIds() {
  const sel = $("ownShops");
  if (!sel) return [];
  return Array.from(sel.selectedOptions || []).map(o => o.value).filter(Boolean);
}


async function mergeShops() {
  const fromShopId = ($("mergeFromShop")?.value || "").trim();
  const toShopId = ($("mergeToShop")?.value || "").trim();
  const msg = $("mergeMsg");
  if (msg) msg.textContent = "";
  if (!fromShopId || !toShopId) return toast("Select From and To shops");
  if (fromShopId === toShopId) return toast("From and To must be different");

  const fromText = $("mergeFromShop").selectedOptions[0]?.textContent || fromShopId;
  const toText = $("mergeToShop").selectedOptions[0]?.textContent || toShopId;

  // Preview first (counts)
  let pv = null;
  try {
    pv = await api("/api/dev/shops/merge/preview", {
      method: "POST",
      body: JSON.stringify({ fromShopId, toShopId })
    });
  } catch (e) {
    pv = null;
  }

  let previewLines = "";
  if (pv && pv.ok) {
    const p = pv.preview || {};
    const owners = pv.ownersWouldUpdate || 0;
    const parts = Object.keys(p).map(k => `${k}: ${p[k]}`).join("\n");
    previewLines =
      `\n\nPREVIEW (rows to move)\n` +
      `${parts || "-"}\n` +
      `owners: ${owners}`;
    if (pv.fromShop?.isMerged && pv.fromShop?.mergedInto) {
      previewLines += `\n\n⚠ FROM shop is already merged into: ${pv.fromShop.mergedInto}`;
    }
  }

  const ok = confirm(
    `Merge shops?\n\nFROM: ${fromText}\nTO:   ${toText}` +
    previewLines +
    `\n\nThis will MOVE all data from FROM -> TO.`
  );
  if (!ok) return;

  const data = await api("/api/dev/shops/merge", {
    method: "POST",
    body: JSON.stringify({ fromShopId, toShopId })
  });

  toast("Merged successfully");
  if (msg) {
    const moved = data.moved || {};
    const parts = Object.keys(moved).map(k => `${k}:${moved[k]}`).join(" | ");
    msg.textContent = `Done. ${parts}. Owners updated: ${data.ownersUpdated || 0}`;
  }
  // refresh dropdowns and owners + merge history
  await loadShopOptions();
  await loadOwners().catch(() => {});
  await loadMergeHistory().catch(() => {});
}
async function createOwner() {
  const email = ($("ownEmail").value || "").trim();
  const password = ($("ownPass").value || "").trim();
  const shops = getSelectedShopIds();
  if (!email || !password) return toast("Email and password required");
  const data = await api("/api/dev/owners/create", { method:"POST", body: JSON.stringify({ email, password, shops }) });
  toast("Owner created: " + data.owner.ownerId);
  $("ownOwnerId").value = data.owner.ownerId;
  $("ownNewPass").value = "";
  await loadOwners();
}

async function assignOwnerShops() {
  const ownerId = ($("ownOwnerId").value || "").trim();
  const shops = getSelectedShopIds();
  if (!ownerId) return toast("Select an owner first");
  const data = await api("/api/dev/owners/assign", { method:"POST", body: JSON.stringify({ ownerId, shops }) });
  toast("Updated shops for " + data.owner.ownerId);
  await loadOwners();
}

async function resetOwnerPassword() {
  const ownerId = ($("ownOwnerId").value || "").trim();
  const newPassword = ($("ownNewPass").value || "").trim();
  if (!ownerId || !newPassword) return toast("Owner ID and new password required");
  await api("/api/dev/owners/reset-password", { method:"POST", body: JSON.stringify({ ownerId, newPassword }) });
  toast("Password reset for " + ownerId);
  $("ownNewPass").value = "";
}

if ($("btnOwnCreate")) {
  $("btnOwnCreate").addEventListener("click", () => createOwner().catch(e => toast(e.message)));
  $("btnOwnAssign").addEventListener("click", () => assignOwnerShops().catch(e => toast(e.message)));
  $("btnOwnReset").addEventListener("click", () => resetOwnerPassword().catch(e => toast(e.message)));
  $("btnOwnReload").addEventListener("click", () => loadOwners().catch(() => {}));

  // after dev key save, try load
  setTimeout(() => { loadShopOptions(); loadOwners(); loadMergeHistory(); }, 300);
}


if ($("btnMergeShop")) {
  $("btnMergeShop").addEventListener("click", () => mergeShops().catch(e => toast(e.message)));
  if ($("btnMergeHistory")) $("btnMergeHistory").addEventListener("click", () => loadMergeHistory().catch(e => toast(e.message)));
  // Load shops even if Owner Accounts section isn't used
  setTimeout(() => { loadShopOptions(); }, 300);
}


  // ----------------------------
  // Cashier Permissions
  // ----------------------------
  const permShopCode = $("permShopCode");
  const btnLoadCashiers = $("btnLoadCashiers");
  const permTemplate = $("permTemplate");
  const btnApplyTemplateAll = $("btnApplyTemplateAll");
  const cashierPermMsg = $("cashierPermMsg");
  const tCashierPerms = $("tCashierPerms");

  function showPermMsg(msg, ok=true){
    if(!cashierPermMsg) return;
    cashierPermMsg.textContent = msg || "";
    cashierPermMsg.classList.toggle("hidden", !msg);
    cashierPermMsg.classList.toggle("ok", !!ok);
    cashierPermMsg.classList.toggle("err", !ok);
  }

  function mkCheck(checked){
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    return input;
  }


  async function loadPermTemplates(){
    if(!permTemplate) return;
    try{
      const data = await devApi(`/api/dev/cashier-permission-templates`);
      if(!data.ok) throw new Error(data.error || "Failed to load templates");
      permTemplate.innerHTML = `<option value="">Permission Template…</option>`;
      (data.templates || []).forEach((t) => {
        const opt = document.createElement("option");
        opt.value = t.id;
        opt.textContent = t.name;
        permTemplate.appendChild(opt);
      });
    }catch(e){
      // keep silent; templates are optional
    }
  }

  async function loadCashiers(){
    showPermMsg("");
    const code = (permShopCode?.value || "").trim();
    if(!code) return showPermMsg("Enter Shop Code or Shop ID", false);

    try{
      const data = await devApi(`/api/dev/shops/${encodeURIComponent(code)}/cashiers`);
      if(!data.ok) throw new Error(data.error || "Failed");

      const tbody = tCashierPerms?.querySelector("tbody");
      if(!tbody) return;
      tbody.innerHTML = "";

      const rows = Array.isArray(data.cashiers) ? data.cashiers : [];
      if(!rows.length){
        const tr = document.createElement("tr");
        const td = document.createElement("td");
        td.colSpan = 9;
        td.className = "muted";
        td.textContent = "No cashiers found for this shop.";
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }

      rows.forEach((c) => {
        const tr = document.createElement("tr");
        const perms = c.permissions || {};
        const tdUser = document.createElement("td");
        tdUser.textContent = c.username || "";
        tr.appendChild(tdUser);

        const chkSales = mkCheck(perms.sales !== false);
        const chkProd = mkCheck(!!perms.products);
        const chkDebt = mkCheck(!!perms.debtors);
        const chkExp = mkCheck(!!perms.expiry);
        const chkSet = mkCheck(!!perms.settings);
        const chkIns = mkCheck(!!perms.insights);
        const chkEx = mkCheck(!!perms.export);

        [chkSales, chkProd, chkDebt, chkExp, chkSet, chkIns, chkEx].forEach((ch) => {
          const td = document.createElement("td");
          td.appendChild(ch);
          tr.appendChild(td);
        });

        const tdSave = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "btn small";
        btn.textContent = "Save";
        btn.addEventListener("click", async () => {
          showPermMsg("");
          const payload = {
            permissions: {
              sales: !!chkSales.checked,
              products: !!chkProd.checked,
              debtors: !!chkDebt.checked,
              expiry: !!chkExp.checked,
              settings: !!chkSet.checked,
              insights: !!chkIns.checked,
              export: !!chkEx.checked
            }
          };
          try{
            const resp = await devApi(`/api/dev/shops/${encodeURIComponent(code)}/cashiers/${encodeURIComponent(c.username)}/permissions`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            if(!resp.ok) throw new Error(resp.error || "Save failed");
            showPermMsg(`Saved permissions for ${c.username}`, true);
          }catch(e){
            showPermMsg(String(e.message || e), false);
          }
        });
        tdSave.appendChild(btn);
        tr.appendChild(tdSave);

        tbody.appendChild(tr);
      });

      showPermMsg(`Loaded ${rows.length} cashier(s) for ${data.shop?.shopName || "shop"}`, true);
    }catch(e){
      showPermMsg(String(e.message || e), false);
    }
  }

  if(btnLoadCashiers) btnLoadCashiers.addEventListener("click", loadCashiers);

  async function applyTemplateAll(){
    showPermMsg("");
    const code = (permShopCode?.value || "").trim();
    const tplId = (permTemplate?.value || "").trim();
    if(!code) return showPermMsg("Enter Shop Code or Shop ID", false);
    if(!tplId) return showPermMsg("Select a permission template", false);

    try{
      const resp = await devApi(`/api/dev/shops/${encodeURIComponent(code)}/cashiers/apply-template`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId: tplId })
      });
      if(!resp.ok) throw new Error(resp.error || "Apply failed");
      showPermMsg(`Applied template to ${resp.updated || 0} cashier(s). Reloading...`, true);
      await loadCashiers();
    }catch(e){
      showPermMsg(String(e.message || e), false);
    }
  }

  if(btnApplyTemplateAll) btnApplyTemplateAll.addEventListener("click", applyTemplateAll);

  // load templates on page init
  loadPermTemplates();



// ================================
// Bulk Token Generator (SPNG + RMP)
// ================================
let _bulkSpng = [];
let _bulkRmp = [];

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function toCsv(rows, headers) {
  const esc = (v) => {
    const s = String(v ?? "");
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g,'""')}"`;
    return s;
  };
  const head = headers.map(esc).join(",");
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join(",")).join("\n");
  return head + "\n" + body + "\n";
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 250);
}

async function bulkGenerateSpng() {
  const plan = String($("bulkPlan")?.value || "MONTHLY").trim().toUpperCase();
  const useSpng2 = !!$("bulkUseSpng2")?.checked;
  const lines = String($("bulkLines")?.value || "").trim();

  $("bulkMsg").textContent = "Generating...";
  $("bulkErr").textContent = "";
  $("bulkTable").innerHTML = "";

  try {
    const res = await api("/api/dev/bulk-generate-tokens", {
      method: "POST",
      body: JSON.stringify({ plan, useSpng2, lines }),
    });

    _bulkSpng = Array.isArray(res.licenses) ? res.licenses : [];
    const errs = Array.isArray(res.errors) ? res.errors : [];

    $("bulkMsg").textContent = `Done: ${_bulkSpng.length} tokens • Errors: ${errs.length}`;
    $("bulkTable").innerHTML = _bulkSpng
      .map((x, i) => `<tr>
        <td>${i + 1}</td>
        <td class="mono">${escHtml(x.licenseId || "")}</td>
        <td>${escHtml(x.plan || "")}</td>
        <td class="mono">${escHtml(x.expiryYmd || "")}</td>
        <td class="mono">${escHtml(x.token || "")}</td>
      </tr>`)
      .join("");

    if (errs.length) {
      $("bulkErr").innerHTML =
        `<b>Errors</b><br>` +
        errs
          .slice(0, 30)
          .map((e) => `Row ${escHtml(e.row)}: ${escHtml(e.error)} (${escHtml(e.input)})`)
          .join("<br>") +
        (errs.length > 30 ? `<br>...and ${errs.length - 30} more` : "");
    }
  } catch (e) {
    $("bulkMsg").textContent = "";
    toast(e?.message || "Bulk generate failed");
  }
}

function bulkCsvSpng() {
  if (!_bulkSpng.length) return toast("Nothing to export yet");
  const rows = _bulkSpng.map((x) => ({
    licenseId: x.licenseId || "",
    app: "SuperPOSNG",
    plan: x.plan || "",
    expiryYmd: x.expiryYmd || "",
    tokenVersion: x.tokenVersion || "",
    token: x.token || "",
    devHash: x.devHash || "",
  }));
  const csv = toCsv(rows, ["licenseId", "app", "plan", "expiryYmd", "tokenVersion", "token", "devHash"]);
  downloadText(`superposng_bulk_tokens_${Date.now()}.csv`, csv);
}

async function bulkGenerateRmp() {
  const plan = String($("bulkRmpPlan")?.value || "MONTHLY").trim().toUpperCase();
  const lines = String($("bulkRmpLines")?.value || "").trim();

  $("bulkRmpMsg").textContent = "Generating...";
  $("bulkRmpErr").textContent = "";
  $("bulkRmpTable").innerHTML = "";

  try {
    const res = await api("/api/rmp/dev/bulk-generate-tokens", {
      method: "POST",
      body: JSON.stringify({ plan, lines }),
    });

    _bulkRmp = Array.isArray(res.licenses) ? res.licenses : [];
    const errs = Array.isArray(res.errors) ? res.errors : [];

    $("bulkRmpMsg").textContent = `Done: ${_bulkRmp.length} tokens • Errors: ${errs.length}`;
    $("bulkRmpTable").innerHTML = _bulkRmp
      .map((x, i) => `<tr>
        <td>${i + 1}</td>
        <td class="mono">${escHtml(x.licenseId || "")}</td>
        <td>${escHtml(x.plan || "")}</td>
        <td class="mono">${escHtml(x.expiryYmd || "")}</td>
        <td class="mono">${escHtml(x.token || "")}</td>
      </tr>`)
      .join("");

    if (errs.length) {
      $("bulkRmpErr").innerHTML =
        `<b>Errors</b><br>` +
        errs
          .slice(0, 30)
          .map((e) => `Row ${escHtml(e.row)}: ${escHtml(e.error)} (${escHtml(e.input)})`)
          .join("<br>") +
        (errs.length > 30 ? `<br>...and ${errs.length - 30} more` : "");
    }
  } catch (e) {
    $("bulkRmpMsg").textContent = "";
    toast(e?.message || "Bulk generate failed");
  }
}

function bulkCsvRmp() {
  if (!_bulkRmp.length) return toast("Nothing to export yet");
  const rows = _bulkRmp.map((x) => ({
    licenseId: x.licenseId || "",
    app: "RepairMasterPro",
    plan: x.plan || "",
    expiryYmd: x.expiryYmd || "",
    tokenVersion: x.tokenVersion || "",
    token: x.token || "",
    devHash: x.devHash || "",
  }));
  const csv = toCsv(rows, ["licenseId", "app", "plan", "expiryYmd", "tokenVersion", "token", "devHash"]);
  downloadText(`repairmasterpro_bulk_tokens_${Date.now()}.csv`, csv);
}

/* =========================
   Shop Manager (Server-side Pagination + Search + Delete)
========================= */

let _smAll = [];          // current page shops from server
let _smPage = 1;          // 1-based
let _smPages = 1;
let _smTotal = 0;
let _smSelectedShop = null; // {shopId, shopCode, shopName}
let _smLastQuerySig = "";   // helps avoid redundant fetches

function escJs(v) {
  // escape for single-quoted inline onclick
  return String(v == null ? "" : v)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function smSetMsg(kind, text) {
  const box = $("smMsg");
  if (!box) return;
  box.classList.remove("hidden", "success", "error");
  if (!text) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }
  if (kind) box.classList.add(kind);
  box.textContent = text;
}

function smPageSize() {
  const v = parseInt($("smPageSize")?.value || "25", 10);
  return Math.max(5, Math.min(200, Number.isFinite(v) ? v : 25));
}

function smShowMode() {
  return String($("smShow")?.value || "active");
}

function smQuery() {
  return String($("smQ")?.value || "").trim();
}

function smSig(page) {
  return `${page}|${smPageSize()}|${smShowMode()}|${smQuery().toLowerCase()}`;
}

function smRender() {
  const tbody = $("smTbody");
  const meta = $("smMeta");
  const prev = $("btnSmPrev");
  const next = $("btnSmNext");
  if (!tbody || !meta) return;

  const slice = Array.isArray(_smAll) ? _smAll : [];
  tbody.innerHTML = slice.map((s) => {
    const isDel = s?.isDeleted === true;
    const status = isDel ? "DELETED" : (s?.isMerged === true ? "MERGED" : "ACTIVE");
    const created = s?.createdAt ? fmtTs(s.createdAt) : "-";
    const safeName = escHtml(s?.shopName || "(no name)");
    const safeCode = escHtml(s?.shopCode || "");
    const safeId = escHtml(s?.shopId || "");
    const trClass = (_smSelectedShop && _smSelectedShop.shopId === s.shopId) ? "table-active" : "";
    return `
      <tr class="${trClass}" data-shopid="${safeId}">
        <td><strong>${safeName}</strong></td>
        <td class="mono">${safeCode}</td>
        <td class="mono">${safeId}</td>
        <td><span class="pill">${escHtml(status)}</span></td>
        <td>${escHtml(created)}</td>
        <td>
          <button class="btn" onclick="smSelect('${escJs(s.shopId)}')">Select</button>
          <button class="btn warn" onclick="smDeleteOne('${escJs(s.shopId)}','soft')">Soft</button>
          <button class="btn danger" onclick="smDeleteOne('${escJs(s.shopId)}','hard')">Hard</button>
        </td>
      </tr>
    `;
  }).join("");

  meta.textContent = `Total ${_smTotal} • Page ${_smPage}/${_smPages} • Showing ${slice.length} shops`;

  if (prev) prev.disabled = (_smPage <= 1);
  if (next) next.disabled = (_smPage >= _smPages);
}

async function smFetch(page = 1, { force = false } = {}) {
  smSetMsg("", "");
  const btn = $("btnSmRefresh");
  const prev = $("btnSmPrev");
  const next = $("btnSmNext");

  const sig = smSig(page);
  if (!force && sig === _smLastQuerySig) return;

  if (btn) btn.disabled = true;
  if (prev) prev.disabled = true;
  if (next) next.disabled = true;

  try {
    const limit = smPageSize();
    const show = smShowMode();
    const q = smQuery();

    const qs = new URLSearchParams();
    qs.set("page", String(Math.max(1, parseInt(page || 1, 10))));
    qs.set("limit", String(limit));
    qs.set("show", show);
    if (q) qs.set("q", q);

    const res = await api(`/api/dev/shops/list?${qs.toString()}`);

    _smAll = Array.isArray(res.shops) ? res.shops : [];
    _smPage = Number(res.page || 1) || 1;
    _smPages = Number(res.pages || 1) || 1;
    _smTotal = Number(res.total || 0) || 0;

    _smLastQuerySig = sig;

    // if selected shop is not on this page, keep selection but don't highlight
    smRender();

    const msg = `Loaded ${_smAll.length} shops (page ${_smPage}/${_smPages}).`;
    smSetMsg("success", msg);
  } catch (e) {
    smSetMsg("error", e?.message || "Failed to load shops");
  } finally {
    if (btn) btn.disabled = false;
    smRender();
  }
}

async function smRefresh() {
  _smPage = 1;
  return smFetch(1, { force: true });
}

function smSelect(shopId) {
  const s = (_smAll || []).find(x => String(x.shopId) === String(shopId));
  if (!s) return;
  _smSelectedShop = { shopId: s.shopId, shopCode: s.shopCode, shopName: s.shopName };
  const box = $("smSelected");
  if (box) box.value = `${s.shopName || ""} • ${s.shopCode || ""} • ${s.shopId}`;
  smRender();
}

async function smDeleteSelected() {
  if (!_smSelectedShop?.shopId) return toast("Select a shop first");
  const mode = String($("smDeleteMode")?.value || "soft");
  const reason = String($("smReason")?.value || "").trim();
  return smDeleteOne(_smSelectedShop.shopId, mode, reason);
}

async function smDeleteOne(shopIdOrCode, mode = "soft", reason = "") {
  const m = String(mode || "soft").toLowerCase();
  const isHard = m === "hard";
  const confirmMsg = isHard
    ? `HARD DELETE will permanently remove this shop and ALL its data.\n\nType DELETE to confirm:`
    : `Soft delete will hide the shop (keeps data).\n\nType DELETE to confirm:`;
  const typed = prompt(confirmMsg);
  if (String(typed || "").trim().toUpperCase() !== "DELETE") return;

  try {
    smSetMsg("", "");
    await api("/api/dev/shops/delete", {
      method: "POST",
      body: JSON.stringify({ shopIdOrCode, mode: m, reason: reason || "" }),
    });
    smSetMsg("success", `Deleted shop (${m}). Refreshing...`);
    // refresh current page (server may shrink pages after delete)
    await smFetch(_smPage, { force: true });
  } catch (e) {
    smSetMsg("error", e?.message || "Delete failed");
  }
}

// Debounce search to reduce server load
let _smDebT = null;
function smDebouncedFetch() {
  clearTimeout(_smDebT);
  _smDebT = setTimeout(() => smFetch(1, { force: true }), 250);
}
window.addEventListener("load", () => {
  const b1 = $("btnBulkGenerate"); if (b1) b1.onclick = bulkGenerateSpng;
  const b2 = $("btnBulkCsv"); if (b2) b2.onclick = bulkCsvSpng;
  const b3 = $("btnBulkRmpGenerate"); if (b3) b3.onclick = bulkGenerateRmp;
  const b4 = $("btnBulkRmpCsv"); if (b4) b4.onclick = bulkCsvRmp;

  // Shop Manager
  const smRef = $("btnSmRefresh"); if (smRef) smRef.onclick = () => smRefresh();
  const smPrev = $("btnSmPrev"); if (smPrev) smPrev.onclick = () => { if (_smPage > 1) smFetch(_smPage - 1, { force: true }); };
  const smNext = $("btnSmNext"); if (smNext) smNext.onclick = () => { if (_smPage < _smPages) smFetch(_smPage + 1, { force: true }); };
  const smQ = $("smQ"); if (smQ) smQ.oninput = () => smDebouncedFetch();
  const smShow = $("smShow"); if (smShow) smShow.onchange = () => smFetch(1, { force: true });
  const smSz = $("smPageSize"); if (smSz) smSz.onchange = () => smFetch(1, { force: true });
  const smDel = $("btnSmDelete"); if (smDel) smDel.onclick = smDeleteSelected;

  // Load shops once key is present (or after user saves)
  if (getKey()) smRefresh();
});
