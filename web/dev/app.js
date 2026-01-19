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
let _tblOffset = 0;
const _tblLimit = 50;

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
  const addDays = Number($("addDays").value || 0);
  const plan = $("plan").value;
  const payload = Object.assign(parseTarget(target), {
    addDays: Number.isFinite(addDays) ? addDays : 0,
    plan: plan || ""
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
  const daysRaw = ($("genDays")?.value || "").trim();
  const days = daysRaw ? Number(daysRaw) : 0;

  // If admin already typed Device ID / Shop ID (for activation),
  // include them as token hints to match your Python generator format:
  // SPNG1|PLAN|YYYYMMDD|RAND|DEVICE_ID|SHOP_ID
  const hintDeviceId = ($("deviceId")?.value || "").trim();
  const hintShopId = ($("shopId")?.value || "").trim();

  const payload = { plan };
  if (Number.isFinite(days) && days > 0) payload.days = Math.floor(days);
  if (hintDeviceId) payload.deviceId = hintDeviceId;
  if (hintShopId) payload.shopId = hintShopId;

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
  const daysRaw = ($("genDays")?.value || "").trim();
  const days = daysRaw ? Number(daysRaw) : 0;
  const payload = { token };
  // Optional override
  if (plan) payload.plan = plan;
  if (Number.isFinite(days) && days > 0) payload.days = Math.floor(days);

  const out = await api("/api/dev/register-token", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  _lastGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : _lastGenerated;
  toast(out?.already ? "Token already registered" : "Token registered");
  await refreshTokenTable(true).catch(() => {});
  return out;
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
          ${actionBtn("+30", "", { act: "add", id, days: 30 })}
          ${actionBtn("+365", "", { act: "add", id, days: 365 })}
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
      const days = Number(btn.getAttribute("data-days") || 0);

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
        $("addDays").value = String(days);
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

// Init
$("devKey").value = getKey();

$("btnSaveKey").addEventListener("click", () => {
  const v = $("devKey").value.trim();
  setKey(v);
  toast("DEV KEY saved");
});

// Generator
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
