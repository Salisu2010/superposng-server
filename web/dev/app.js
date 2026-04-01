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
let _lastCpngGenerated = null; // { licenseId, token }
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


async function doGenerateCpngToken() {
  const plan = ($("cpngPlan")?.value || "MONTHLY").trim();
  const deviceId = ($("cpngDeviceId")?.value || "").trim();
  const use2 = $("cpngUseSpng2") ? !!$("cpngUseSpng2").checked : false;
  const fpHash = use2 ? ($("cpngFpHash")?.value || "").trim() : "";
  if (!deviceId) { toast("ANDROID_ID/Device ID is required"); return; }
  if (use2 && !fpHash) { toast("Paste Device Code"); return; }
  const payload = { app: "CPNG", plan, deviceId, fpHash: use2 ? fpHash : "" };
  const out = await api("/api/dev/generate-token", { method: "POST", body: JSON.stringify(payload) });
  _lastCpngGenerated = out?.license ? { licenseId: out.license.licenseId, token: out.license.token } : null;
  if ($("cpngToken")) $("cpngToken").value = _lastCpngGenerated?.token || "";
  toast("CPNG token generated");
  return out;
}

async function doAssignCpngOnline() {
  const deviceId = ($("cpngDeviceId")?.value || "").trim();
  const token = ($("cpngToken")?.value || _lastCpngGenerated?.token || "").trim();
  if (!deviceId) { toast("ANDROID_ID/Device ID is required"); return; }
  if (!token) { toast("Generate or paste token first"); return; }
  const out = await api("/api/dev/assign-token", { method: "POST", body: JSON.stringify({ app: "CPNG", deviceId, token }) });
  toast("ClinicProNG device activated online ✅");
  return out;
}

function updateCpngUi() {
  const use = $("cpngUseSpng2") ? !!$("cpngUseSpng2").checked : false;
  if ($("cpngFpWrap")) $("cpngFpWrap").style.display = use ? "block" : "none";
  if (!use && $("cpngFpHash")) $("cpngFpHash").value = "";
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


let _cpngTblOffset = 0;
const _cpngTblLimit = 50;

function renderKpiCards(elId, cards) {
  const box = $(elId);
  if (!box) return;
  const items = Array.isArray(cards) ? cards : [];
  box.innerHTML = items.map((c) => `
    <div class="kpiCard">
      <div class="kpiLabel">${c.label || ""}</div>
      <div class="kpiValue">${c.value ?? 0}</div>
      <div class="kpiSub">${c.sub || ""}</div>
      ${c.chips ? `<div class="kpiChipRow">${c.chips}</div>` : ''}
    </div>
  `).join("");
}

function cpngTableParams() {
  return {
    q: ($("cpngTblQ")?.value || "").trim(),
    status: ($("cpngTblStatus")?.value || "").trim(),
    plan: ($("cpngTblPlan")?.value || "").trim(),
  };
}

async function refreshCpngStats() {
  const out = await api(`/api/dev/licenses-summary?app=CPNG`, { method: "GET" });
  const s = out?.stats || {};
  renderKpiCards("cpngStats", [
    { label: "Total Licenses", value: s.total || 0, sub: `Pending ${s.pending || 0}` },
    { label: "Active", value: s.active || 0, sub: `Expiring soon ${s.expiringSoon || 0}` },
    { label: "Issued", value: s.issued || 0, sub: `Revoked ${s.revoked || 0}` },
    { label: "Plans", value: `${s.monthly || 0}/${s.yearly || 0}`, sub: `Monthly / Yearly` },
  ]);
  return out;
}

async function refreshCpngTokenTable(resetOffset) {
  if (resetOffset) _cpngTblOffset = 0;
  const { q, status, plan } = cpngTableParams();
  const qs = new URLSearchParams();
  qs.set("app", "CPNG");
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (plan) qs.set("plan", plan);
  qs.set("limit", String(_cpngTblLimit));
  qs.set("offset", String(_cpngTblOffset));
  const out = await api(`/api/dev/licenses?${qs.toString()}`, { method: "GET" });
  renderCpngTokenTable(out);
  return out;
}

function renderCpngTokenTable(out) {
  const box = $("cpngTokenTable");
  const meta = $("cpngTblMeta");
  if (!box) return;

  const items = Array.isArray(out?.items) ? out.items : [];
  const total = Number(out?.total || 0);
  const start = total === 0 ? 0 : (_cpngTblOffset + 1);
  const end = Math.min(_cpngTblOffset + _cpngTblLimit, total);
  if (meta) meta.textContent = `Showing ${start}-${end} of ${total}`;

  const rows = items.map((m) => {
    const id = m.licenseId || "";
    const token = m.token || "";
    const status = m.status || "";
    const plan = m.plan || "";
    const exp = fmtTs(m.expiresAt);
    const dev = m.boundDeviceId || "-";
    const notes = m.notes || "-";
    return `
      <tr>
        <td><code>${id}</code></td>
        <td><code>${token}</code></td>
        <td>${status}</td>
        <td>${plan}</td>
        <td>${exp}</td>
        <td><code>${dev}</code></td>
        <td>${notes}</td>
        <td style="white-space:nowrap">
          ${actionBtn("Copy", "", { act: "cpng_copy", token })}
          ${actionBtn("Target", "", { act: "cpng_target", id })}
          ${actionBtn("+1M", "", { act: "cpng_add", id, months: 1 })}
          ${actionBtn("+12M", "", { act: "cpng_add", id, months: 12 })}
          ${actionBtn("Reset", "warn", { act: "cpng_reset", id })}
          ${actionBtn("Revoke", "danger", { act: "cpng_revoke", id })}
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
          <th>Notes</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="8" style="color:var(--muted)">No CPNG licenses found</td></tr>`}
      </tbody>
    </table>
  `;

  box.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      const id = btn.getAttribute("data-id") || "";
      const token = btn.getAttribute("data-token") || "";
      const months = Number(btn.getAttribute("data-months") || 0);
      try {
        if (act === "cpng_copy") {
          copyText(token);
          toast("Copied CPNG token");
          return;
        }
        if (act === "cpng_target") {
          if ($("target")) $("target").value = id;
          copyText(id);
          toast("Target set");
          return;
        }
        if (act === "cpng_add") {
          await api("/api/dev/extend", { method: "POST", body: JSON.stringify({ licenseId: id, months, app: "CPNG" }) });
          toast("CPNG license extended");
        } else if (act === "cpng_reset") {
          await api("/api/dev/revoke", { method: "POST", body: JSON.stringify({ licenseId: id, resetOnly: true, reason: "Portal reset" }) });
          toast("CPNG binding reset");
        } else if (act === "cpng_revoke") {
          await api("/api/dev/revoke", { method: "POST", body: JSON.stringify({ licenseId: id, reason: "Portal revoke" }) });
          toast("CPNG license revoked");
        }
        await Promise.all([refreshCpngStats(), refreshCpngTokenTable(false)]);
      } catch (e) {
        toast(e.message || "Action failed");
      }
    });
  });
}

async function refreshCpngTrialDashboard() {
  const q = ($("cpngTrialQ")?.value || "").trim();
  const status = ($("cpngTrialStatus")?.value || "").trim();

  const sum = await api(`/api/trial/admin/summary?app=CPNG`, { method: "GET" });
  const s = sum?.stats || {};
  renderKpiCards("cpngTrialStats", [
    { label: "Trials Used", value: s.total || 0, sub: `Today ${s.todayConsumed || 0}` },
    { label: "Active", value: s.active || 0, sub: `Expired ${s.expired || 0}` },
    { label: "Blocked", value: s.blocked || 0, sub: `Revoked ${s.revoked || 0}` },
    { label: "Security", value: s.blocks || 0, sub: `Audit logs ${s.audits || 0}` },
  ]);

  const qs = new URLSearchParams({ app: "CPNG", limit: "50", offset: "0" });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const consumed = await api(`/api/trial/admin/consumed?${qs.toString()}`, { method: "GET" });
  const items = Array.isArray(consumed?.items) ? consumed.items : [];
  if ($("cpngTrialMeta")) $("cpngTrialMeta").textContent = `Showing ${items.length} of ${consumed?.total || 0} trials`;
  $("cpngTrialTable").innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Status</th>
          <th>Device ID</th>
          <th>Android ID</th>
          <th>Install ID</th>
          <th>FP Hash</th>
          <th>Start</th>
          <th>Expiry</th>
          <th>Reason</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
        ${items.map((t) => `
          <tr>
            <td>${escHtml(t.status || "")}</td>
            <td><code>${escHtml(t.deviceId || "-")}</code></td>
            <td><code>${escHtml(t.androidId || "-")}</code></td>
            <td><code>${escHtml(t.installId || "-")}</code></td>
            <td><code>${escHtml(t.fpHash || "-")}</code></td>
            <td>${escHtml(t.startYmd || "-")}</td>
            <td>${escHtml(t.expiryYmd || "-")}</td>
            <td>${escHtml(t.revokeReason || t.blockReason || "-")}</td>
            <td>${actionBtn("Load", "", { act: "cpng_trial_load", device: t.deviceId || "", android: t.androidId || "", install: t.installId || "", fp: t.fpHash || "" })}</td>
          </tr>
        `).join("") || `<tr><td colspan="9" style="color:var(--muted)">No trial records</td></tr>`}
      </tbody>
    </table>
  `;
  $("cpngTrialTable").querySelectorAll("button[data-act='cpng_trial_load']").forEach((btn) => {
    btn.addEventListener("click", () => {
      fillCpngTrialActionFields({
        deviceId: btn.getAttribute("data-device") || "",
        androidId: btn.getAttribute("data-android") || "",
        installId: btn.getAttribute("data-install") || "",
        fpHash: btn.getAttribute("data-fp") || "",
      });
      toast("Loaded trial identity into action center");
    });
  });

  const audit = await api(`/api/trial/admin/audit?app=CPNG&limit=30&offset=0`, { method: "GET" });
  const audits = Array.isArray(audit?.items) ? audit.items : [];
  $("cpngAuditTable").innerHTML = `
    <table class="table">
      <thead>
        <tr>
          <th>Time</th>
          <th>Type</th>
          <th>Device ID</th>
          <th>Android ID</th>
          <th>Details</th>
        </tr>
      </thead>
      <tbody>
        ${audits.map((a) => `
          <tr>
            <td>${fmtTs(a.createdAt)}</td>
            <td>${a.type || "-"}</td>
            <td><code>${a.deviceId || "-"}</code></td>
            <td><code>${a.androidId || "-"}</code></td>
            <td>${JSON.stringify(a.meta || {}).slice(0, 180) || "-"}</td>
          </tr>
        `).join("") || `<tr><td colspan="5" style="color:var(--muted)">No audit logs</td></tr>`}
      </tbody>
    </table>
  `;
}

async function doCpngTrialCleanup() {
  await api("/api/trial/admin/cleanup", { method: "POST", body: JSON.stringify({ app: "CPNG" }) });
  toast("CPNG anti-abuse cleanup complete");
  await refreshCpngTrialDashboard();
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
  Promise.all([
    refreshGlobalDashboard().catch(() => {}),
    refreshCpngStats().catch(() => {}),
    refreshCpngTokenTable(true).catch(() => {}),
    refreshCpngTrialDashboard().catch(() => {}),
  ]);
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


if ($("cpngUseSpng2")) {
  $("cpngUseSpng2").addEventListener("change", updateCpngUi);
  updateCpngUi();
}
if ($("btnCpngGenerate")) {
  $("btnCpngGenerate").addEventListener("click", () => doGenerateCpngToken().catch((e) => toast(e.message)));
}
if ($("btnCpngAssignOnline")) {
  $("btnCpngAssignOnline").addEventListener("click", () => doAssignCpngOnline().catch((e) => toast(e.message)));
}
if ($("btnCpngCopy")) {
  $("btnCpngCopy").addEventListener("click", () => { copyText($("cpngToken")?.value || ""); toast("Copied CPNG token"); });
}
if ($("btnCpngTblRefresh")) {
  $("btnCpngTblRefresh").addEventListener("click", () => Promise.all([refreshCpngStats(), refreshCpngTokenTable(true), refreshCpngLicenseAudit()]).catch((e) => toast(e.message)));
}
if ($("btnCpngTblPrev")) {
  $("btnCpngTblPrev").addEventListener("click", () => { if (_cpngTblOffset >= _cpngTblLimit) { _cpngTblOffset -= _cpngTblLimit; refreshCpngTokenTable(false).catch((e) => toast(e.message)); } });
}
if ($("btnCpngTblNext")) {
  $("btnCpngTblNext").addEventListener("click", () => { _cpngTblOffset += _cpngTblLimit; refreshCpngTokenTable(false).catch((e) => toast(e.message)); });
}
if ($("cpngTblQ")) {
  $("cpngTblQ").addEventListener("input", () => refreshCpngTokenTable(true).catch((e) => toast(e.message)));
}
if ($("cpngTblStatus")) {
  $("cpngTblStatus").addEventListener("change", () => refreshCpngTokenTable(true).catch((e) => toast(e.message)));
}
if ($("cpngTblPlan")) {
  $("cpngTblPlan").addEventListener("change", () => refreshCpngTokenTable(true).catch((e) => toast(e.message)));
}
if ($("btnCpngTrialRefresh")) {
  $("btnCpngTrialRefresh").addEventListener("click", () => refreshCpngTrialDashboard().catch((e) => toast(e.message)));
}
if ($("btnCpngTrialCleanup")) {
  $("btnCpngTrialCleanup").addEventListener("click", () => doCpngTrialCleanup().catch((e) => toast(e.message)));
}
if ($("cpngTrialQ")) {
  $("cpngTrialQ").addEventListener("input", () => refreshCpngTrialDashboard().catch((e) => toast(e.message)));
}
if ($("cpngTrialStatus")) {
  $("cpngTrialStatus").addEventListener("change", () => refreshCpngTrialDashboard().catch((e) => toast(e.message)));
}
if ($("btnCpngCustomExtend")) {
  $("btnCpngCustomExtend").addEventListener("click", () => doCpngCustomExtend().catch((e) => toast(e.message)));
}
if ($("btnCpngResendOnline")) {
  $("btnCpngResendOnline").addEventListener("click", () => doCpngResendOnlineActivation().catch((e) => toast(e.message)));
}
if ($("btnCpngManualRevoke")) {
  $("btnCpngManualRevoke").addEventListener("click", () => doCpngManualRevoke().catch((e) => toast(e.message)));
}
if ($("btnCpngResetBinding")) {
  $("btnCpngResetBinding").addEventListener("click", () => doCpngResetBinding().catch((e) => toast(e.message)));
}
if ($("btnCpngExportLicenses")) {
  $("btnCpngExportLicenses").addEventListener("click", () => exportCpngLicensesCsv().catch((e) => toast(e.message)));
}
if ($("btnCpngExportTrials")) {
  $("btnCpngExportTrials").addEventListener("click", () => exportCpngTrialsCsv().catch((e) => toast(e.message)));
}

if ($("btnCpngTrialRevoke")) {
  $("btnCpngTrialRevoke").addEventListener("click", () => doCpngTrialRevoke().catch((e) => toast(e.message)));
}
if ($("btnCpngTrialBlacklist")) {
  $("btnCpngTrialBlacklist").addEventListener("click", () => doCpngTrialBlacklist().catch((e) => toast(e.message)));
}
if ($("btnCpngTrialUnblock")) {
  $("btnCpngTrialUnblock").addEventListener("click", () => doCpngTrialUnblock().catch((e) => toast(e.message)));
}
if ($("btnCpngTrialExportAudit")) {
  $("btnCpngTrialExportAudit").addEventListener("click", () => exportCpngTrialAuditCsv().catch((e) => toast(e.message)));
}
if ($("btnCpngTrialExportBlocks")) {
  $("btnCpngTrialExportBlocks").addEventListener("click", () => exportCpngTrialBlocksCsv().catch((e) => toast(e.message)));
}


function cpngActionPayload() {
  return {
    app: "CPNG",
    licenseId: ($("cpngActionLicenseId")?.value || "").trim(),
    deviceId: ($("cpngActionDeviceId")?.value || "").trim(),
    token: ($("cpngActionToken")?.value || "").trim(),
    months: Number((($("cpngActionMonths")?.value || "1").trim())) || 1,
    reason: ($("cpngActionReason")?.value || "").trim(),
  };
}

async function refreshCpngLicenseAudit() {
  const out = await api(`/api/dev/audit?app=CPNG&limit=20&offset=0`, { method: "GET" });
  const items = Array.isArray(out?.items) ? out.items : [];
  const box = $("cpngLicenseAuditTable");
  if (!box) return out;
  box.innerHTML = `
    <table class="table">
      <thead>
        <tr><th>Time</th><th>Action</th><th>License</th><th>Device</th><th>Details</th></tr>
      </thead>
      <tbody>
        ${items.map((x) => `
          <tr>
            <td>${fmtTs(x.createdAt)}</td>
            <td>${escHtml(x.action || "-")}</td>
            <td><code>${escHtml(x.licenseId || "-")}</code></td>
            <td><code>${escHtml(x.deviceId || "-")}</code></td>
            <td>${escHtml([x.plan, x.token].filter(Boolean).join(" • ") || "-")}</td>
          </tr>
        `).join("") || `<tr><td colspan="5" style="color:var(--muted)">No license audit logs</td></tr>`}
      </tbody>
    </table>`;
  return out;
}

async function doCpngCustomExtend() {
  const p = cpngActionPayload();
  if (!p.licenseId && !p.token) throw new Error("License ID or token is required");
  await api("/api/dev/extend", { method: "POST", body: JSON.stringify({ app: "CPNG", licenseId: p.licenseId, token: p.token, months: p.months, reason: p.reason, androidId: p.deviceId, deviceId: p.deviceId }) });
  toast(`CPNG license extended by ${p.months} month(s)`);
  await Promise.all([refreshCpngStats(), refreshCpngTokenTable(false), refreshCpngLicenseAudit()]);
}

async function doCpngResendOnlineActivation() {
  const p = cpngActionPayload();
  if (!p.licenseId && !p.token) throw new Error("License ID or token is required");
  await api("/api/dev/resend-activation", { method: "POST", body: JSON.stringify({ licenseId: p.licenseId, token: p.token, deviceId: p.deviceId }) });
  toast("Online activation re-sent to target device");
  await Promise.all([refreshCpngStats(), refreshCpngLicenseAudit()]);
}

async function doCpngManualRevoke() {
  const p = cpngActionPayload();
  if (!p.licenseId && !p.token) throw new Error("License ID or token is required");
  await api("/api/dev/revoke", { method: "POST", body: JSON.stringify({ licenseId: p.licenseId, token: p.token, reason: p.reason || "Portal manual revoke" }) });
  toast("CPNG license revoked");
  await Promise.all([refreshCpngStats(), refreshCpngTokenTable(false), refreshCpngLicenseAudit()]);
}

async function doCpngResetBinding() {
  const p = cpngActionPayload();
  if (!p.licenseId && !p.token) throw new Error("License ID or token is required");
  await api("/api/dev/revoke", { method: "POST", body: JSON.stringify({ licenseId: p.licenseId, token: p.token, resetOnly: true, reason: p.reason || "Portal reset binding" }) });
  toast("CPNG binding reset complete");
  await Promise.all([refreshCpngStats(), refreshCpngTokenTable(false), refreshCpngLicenseAudit()]);
}

async function exportCpngLicensesCsv() {
  const { q, status, plan } = cpngTableParams();
  const qs = new URLSearchParams({ app: "CPNG" });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  if (plan) qs.set("plan", plan);
  const res = await fetch(`/api/dev/licenses-export?${qs.toString()}`, { headers: { "X-DEV-KEY": getKey() || $("devKey")?.value || "" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  downloadText(`cpng_licenses_${Date.now()}.csv`, text);
  toast("CPNG licenses CSV downloaded");
}

async function exportCpngTrialsCsv() {
  const q = ($("cpngTrialQ")?.value || "").trim();
  const status = ($("cpngTrialStatus")?.value || "").trim();
  const qs = new URLSearchParams({ app: "CPNG" });
  if (q) qs.set("q", q);
  if (status) qs.set("status", status);
  const res = await fetch(`/api/trial/admin/consumed-export?${qs.toString()}`, { headers: { "X-DEV-KEY": getKey() || $("devKey")?.value || "" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  downloadText(`cpng_trials_${Date.now()}.csv`, text);
  toast("CPNG trials CSV downloaded");
}

function cpngTrialActionPayload() {
  return {
    app: "CPNG",
    deviceId: ($("cpngTrialActionDeviceId")?.value || "").trim(),
    androidId: ($("cpngTrialActionAndroidId")?.value || "").trim(),
    installId: ($("cpngTrialActionInstallId")?.value || "").trim(),
    fpHash: ($("cpngTrialActionFpHash")?.value || "").trim(),
    reason: ($("cpngTrialActionReason")?.value || "").trim(),
  };
}

function fillCpngTrialActionFields(row = {}) {
  if ($("cpngTrialActionDeviceId")) $("cpngTrialActionDeviceId").value = row.deviceId || "";
  if ($("cpngTrialActionAndroidId")) $("cpngTrialActionAndroidId").value = row.androidId || "";
  if ($("cpngTrialActionInstallId")) $("cpngTrialActionInstallId").value = row.installId || "";
  if ($("cpngTrialActionFpHash")) $("cpngTrialActionFpHash").value = row.fpHash || "";
}

async function doCpngTrialRevoke() {
  const p = cpngTrialActionPayload();
  if (!p.deviceId && !p.androidId && !p.installId && !p.fpHash) throw new Error("At least one trial identity is required");
  await api("/api/trial/admin/revoke", { method: "POST", body: JSON.stringify(p) });
  toast("Trial revoked and blocked");
  await refreshCpngTrialDashboard();
}

async function doCpngTrialBlacklist() {
  const p = cpngTrialActionPayload();
  if (!p.deviceId && !p.androidId && !p.installId && !p.fpHash) throw new Error("At least one trial identity is required");
  await api("/api/trial/admin/blacklist", { method: "POST", body: JSON.stringify(p) });
  toast("Device blacklisted from trial");
  await refreshCpngTrialDashboard();
}

async function doCpngTrialUnblock() {
  const p = cpngTrialActionPayload();
  if (!p.deviceId && !p.androidId && !p.installId && !p.fpHash) throw new Error("At least one trial identity is required");
  const out = await api("/api/trial/admin/unblock", { method: "POST", body: JSON.stringify(p) });
  toast(`Unblock complete (${out.changed || 0} block entries cleared)`);
  await refreshCpngTrialDashboard();
}

async function exportCpngTrialAuditCsv() {
  const res = await fetch(`/api/trial/admin/audit-export?app=CPNG`, { headers: { "X-DEV-KEY": getKey() || $("devKey")?.value || "" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  downloadText(`cpng_trial_audit_${Date.now()}.csv`, text);
  toast("Trial audit CSV downloaded");
}

async function exportCpngTrialBlocksCsv() {
  const res = await fetch(`/api/trial/admin/blocks-export?app=CPNG`, { headers: { "X-DEV-KEY": getKey() || $("devKey")?.value || "" } });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
  downloadText(`cpng_trial_blocks_${Date.now()}.csv`, text);
  toast("Trial blocks CSV downloaded");
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

const HISTORY_APPS = ["SPNG", "RMP", "STMN", "CPNG"];
const HISTORY_APP_ALIASES = {
  ALL: HISTORY_APPS,
  CLP: ["CPNG"],
  CPNG: ["CPNG"],
  SPNG: ["SPNG"],
  RMP: ["RMP"],
  SMTN: ["STMN"],
  STMN: ["STMN"],
};
const HISTORY_APP_LABELS = {
  SPNG: "SPNG",
  RMP: "RMP",
  STMN: "SMTN/STMN",
  CPNG: "CLP/CPNG",
};
let _histTab = "licenses";

function setText(id, text) { const el = $(id); if (el) el.textContent = text; }
function setHtml(id, html) { const el = $(id); if (el) el.innerHTML = html; }
function chip(label, value) { return `<span class="countChip"><span>${escHtml(label)}</span><strong>${escHtml(String(value ?? 0))}</strong></span>`; }
function appCountChips(rows, mapper) {
  const counts = { SPNG: 0, CPNG: 0, STMN: 0, RMP: 0 };
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const app = String(row?.app || '').toUpperCase();
    if (counts[app] != null) counts[app] += Number(mapper ? mapper(row) : 1) || 0;
  });
  return ['CPNG','SPNG','STMN','RMP'].map((app) => chip(histAppLabel(app), counts[app] || 0)).join('');
}
function fmtMs(ms) {
  const sec = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  return rem ? `${min}m ${rem}s` : `${min}m`;
}
let _liveRefreshTimer = null;
let _liveRefreshTickTimer = null;
let _liveRefreshNextAt = 0;
let _liveRefreshLastAt = 0;
let _liveRefreshBusy = false;
function autoRefreshEnabled() { return !!($('autoRefreshToggle')?.checked); }
function autoRefreshEveryMs() { return Math.max(15000, Number($('autoRefreshEvery')?.value || 30000)); }
function renderLiveRefreshMeta() {
  const enabled = autoRefreshEnabled();
  const every = autoRefreshEveryMs();
  const nextIn = enabled && _liveRefreshNextAt ? Math.max(0, _liveRefreshNextAt - Date.now()) : 0;
  const last = _liveRefreshLastAt ? `Last refresh ${fmtTs(_liveRefreshLastAt)}` : 'Last refresh -';
  const state = enabled ? (_liveRefreshBusy ? 'Refreshing now' : `Auto refresh every ${fmtMs(every)}`) : 'Auto refresh paused';
  setText('liveRefreshMeta', `${state} • ${last}${enabled ? ` • Next in ${fmtMs(nextIn)}` : ''}`);
  setText('histLiveMeta', `${enabled ? 'Live counts enabled' : 'Live counts paused'}${enabled ? ` • Next sync ${fmtMs(nextIn)}` : ''}`);
}
async function runLiveRefreshCycle() {
  if (!autoRefreshEnabled() || _liveRefreshBusy) { renderLiveRefreshMeta(); return; }
  _liveRefreshBusy = true;
  renderLiveRefreshMeta();
  try {
    await Promise.all([
      refreshGlobalDashboard().catch(() => {}),
      histRefresh(true).catch(() => {}),
    ]);
    _liveRefreshLastAt = Date.now();
  } finally {
    _liveRefreshBusy = false;
    _liveRefreshNextAt = Date.now() + autoRefreshEveryMs();
    renderLiveRefreshMeta();
  }
}
function scheduleLiveRefresh() {
  if (_liveRefreshTimer) clearInterval(_liveRefreshTimer);
  if (_liveRefreshTickTimer) clearInterval(_liveRefreshTickTimer);
  if (!autoRefreshEnabled()) { _liveRefreshNextAt = 0; renderLiveRefreshMeta(); return; }
  const every = autoRefreshEveryMs();
  _liveRefreshNextAt = Date.now() + every;
  _liveRefreshTimer = setInterval(() => { runLiveRefreshCycle().catch(() => {}); }, every);
  _liveRefreshTickTimer = setInterval(renderLiveRefreshMeta, 1000);
  renderLiveRefreshMeta();
}
function histRenderTabCounts() {
  ["licenses", "licenseAudit", "trials", "trialAudit", "blocks", "restores"].forEach((kind) => {
    const el = $(`histCount_${kind}`);
    if (el) el.textContent = String(histFiltered(kind).length);
  });
}
function histRenderSectionCounts(reasonEntries = null, abuseEntries = null) {
  const reasons = Array.isArray(reasonEntries) ? reasonEntries : histCountReasons();
  const abuse = Array.isArray(abuseEntries) ? abuseEntries : histAbuseStats();
  setHtml('histReasonsTitle', `<div class="sectionHeadRow"><span>Revoke / Block Reasons Dashboard (${reasons.length})</span><span class="sectionChipRow">${appCountChips(histFiltered('licenseAudit').filter((x) => String(x.type || '') === 'revoke_license' || String(x.type || '') === 'reset_binding'))}${appCountChips(histFiltered('blocks'))}</span></div>`);
  setHtml('histAbuseTitle', `<div class="sectionHeadRow"><span>Abuse Analytics (${abuse.length})</span><span class="sectionChipRow">${appCountChips(histFiltered('trialAudit'))}</span></div>`);
}
function globalRenderSectionCounts(data) {
  const reasons = Array.isArray(data?.topReasons) ? data.topReasons : [];
  const expiring = Array.isArray(data?.expiringSoonRows) ? data.expiringSoonRows : [];
  const abuse = Array.isArray(data?.topAbuse) ? data.topAbuse : [];
  const revokes = Array.isArray(data?.recentRevokes) ? data.recentRevokes : [];
  setHtml('globalReasonsTitle', `<div class="sectionHeadRow"><span>Top Revoke / Block Reasons (${reasons.length})</span><span class="sectionChipRow">${appCountChips(reasons, (r) => Number(r.count || 0))}</span></div>`);
  setHtml('globalExpiringTitle', `<div class="sectionHeadRow"><span>Expiring Soon (${expiring.length})</span><span class="sectionChipRow">${appCountChips(expiring)}</span></div>`);
  setHtml('globalAbuseTitle', `<div class="sectionHeadRow"><span>Top Abused Identities (${abuse.length})</span><span class="sectionChipRow">${appCountChips(abuse, (r) => Number(r.count || 0))}</span></div>`);
  setHtml('globalRevokesTitle', `<div class="sectionHeadRow"><span>Recent Revokes / Binding Resets (${revokes.length})</span><span class="sectionChipRow">${appCountChips(revokes)}</span></div>`);
}
let _histPage = 1;
let _histPageSize = 50;
let _histCache = { licenses: [], licenseAudit: [], trials: [], trialAudit: [], blocks: [], restores: [] };

function histResolveApps(v) {
  const key = String(v || "ALL").toUpperCase();
  return HISTORY_APP_ALIASES[key] || HISTORY_APPS;
}
function histAppLabel(v) {
  return HISTORY_APP_LABELS[v] || String(v || "-");
}
function histNeedle(parts) {
  return parts.map((x) => String(x || "").toLowerCase()).join(" ");
}
async function histFetchAllPages(urlBase) {
  let offset = 0;
  const limit = 500;
  let all = [];
  while (true) {
    const sep = urlBase.includes("?") ? "&" : "?";
    const out = await api(`${urlBase}${sep}limit=${limit}&offset=${offset}`, { method: "GET" });
    const items = Array.isArray(out?.items) ? out.items : [];
    all = all.concat(items);
    const total = Number(out?.total || items.length || 0);
    offset += items.length;
    if (!items.length || offset >= total || items.length < limit) break;
  }
  return all;
}
async function histLoadData() {
  const apps = histResolveApps($("histApp")?.value);
  const jobs = [];
  for (const app of apps) {
    jobs.push(histFetchAllPages(`/api/dev/licenses?app=${encodeURIComponent(app)}`).then((items) => items.map((x) => ({ ...x, app: x.app || app }))));
    jobs.push(histFetchAllPages(`/api/dev/audit?app=${encodeURIComponent(app)}`).then((items) => items.map((x) => ({ ...x, app: x.app || app }))));
    jobs.push(histFetchAllPages(`/api/trial/admin/consumed?app=${encodeURIComponent(app)}`).then((items) => items.map((x) => ({ ...x, app: x.app || app }))));
    jobs.push(histFetchAllPages(`/api/trial/admin/audit?app=${encodeURIComponent(app)}`).then((items) => items.map((x) => ({ ...x, app: x.app || app }))));
    jobs.push(histFetchAllPages(`/api/trial/admin/blocks?app=${encodeURIComponent(app)}`).then((items) => items.map((x) => ({ ...x, app: x.app || app }))));
    jobs.push(api(`/api/dev/account-restore/history?app=${encodeURIComponent(app)}&page=1&pageSize=500`, { method: 'GET' }).then((out) => (Array.isArray(out?.rows) ? out.rows : []).map((x) => ({ ...x, app: x.app || app }))));
  }
  const out = await Promise.all(jobs);
  _histCache = { licenses: [], licenseAudit: [], trials: [], trialAudit: [], blocks: [], restores: [] };
  for (let i = 0; i < out.length; i += 6) {
    _histCache.licenses.push(...out[i]);
    _histCache.licenseAudit.push(...out[i + 1]);
    _histCache.trials.push(...out[i + 2]);
    _histCache.trialAudit.push(...out[i + 3]);
    _histCache.blocks.push(...out[i + 4]);
    _histCache.restores.push(...out[i + 5]);
  }
}
function histGetFilters() {
  return {
    q: String($("histQ")?.value || "").trim().toLowerCase(),
    reason: String($("histReason")?.value || "").trim().toLowerCase(),
    status: String($("histStatus")?.value || "").trim().toUpperCase(),
    plan: String($("histPlan")?.value || "").trim().toUpperCase(),
    from: String($("histFrom")?.value || "").trim(),
    to: String($("histTo")?.value || "").trim(),
  };
}
function histFiltered(kind) {
  const f = histGetFilters();
  const rows = Array.isArray(_histCache[kind]) ? _histCache[kind].slice() : [];
  return rows.filter((row) => {
    const status = String(row.status || "").toUpperCase();
    const plan = String(row.plan || "").toUpperCase();
    const reason = String(row.reason || row.revokeReason || row.blockReason || row.meta?.reason || "").toLowerCase();
    const needle = histNeedle([
      row.app, row.licenseId, row.fromLicenseId, row.token, row.deviceId, row.boundDeviceId,
      row.androidId, row.installId, row.fpHash, row.devHash, row.notes, row.type, reason,
      row.id, row.shopId, row.boundShopId, row.plan, row.status, row.entityId, row.entityCode, row.entityName, row.ownerPhone, row.ownerEmail, row.action, row.reuseReason, row.entityType,
    ]);
    if (f.q && !needle.includes(f.q)) return false;
    if (f.reason && !reason.includes(f.reason)) return false;
    if (f.status && status !== f.status) return false;
    if (f.plan && plan !== f.plan) return false;
    const ts = Number(row.createdAt || row.updatedAt || row.lastSeenAt || row.activatedAt || 0);
    if (f.from && ts && ts < Date.parse(`${f.from}T00:00:00Z`)) return false;
    if (f.to && ts && ts > Date.parse(`${f.to}T23:59:59Z`)) return false;
    return true;
  }).sort((a, b) => Number(b.createdAt || b.updatedAt || 0) - Number(a.createdAt || a.updatedAt || 0));
}
function histCountReasons() {
  const reasonMap = new Map();
  const pushReason = (app, reason) => {
    const r = String(reason || "").trim();
    if (!r) return;
    const k = `${histAppLabel(app)}::${r}`;
    reasonMap.set(k, (reasonMap.get(k) || 0) + 1);
  };
  histFiltered("licenseAudit").forEach((x) => {
    if (String(x.type || "") === "revoke_license" || String(x.type || "") === "reset_binding") pushReason(x.app, x.reason || (x.resetOnly ? "reset-binding" : "revoke"));
  });
  histFiltered("trials").forEach((x) => pushReason(x.app, x.revokeReason || x.blockReason));
  histFiltered("blocks").forEach((x) => pushReason(x.app, x.reason));
  histFiltered('restores').forEach((x) => pushReason(x.app, x.reuseReason || x.action));
  return [...reasonMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}
function histAbuseStats() {
  const audits = histFiltered("trialAudit");
  const blocks = histFiltered("blocks");
  const offenders = new Map();
  const bump = (k) => offenders.set(k, (offenders.get(k) || 0) + 1);
  let dateTamper = 0, reinstall = 0, multiIdentity = 0, forceBlock = 0, manualBlacklist = 0;
  audits.forEach((x) => {
    const type = String(x.type || "");
    if (type === "trial_date_tamper_block") dateTamper += 1;
    if (type === "trial_reinstall_block") reinstall += 1;
    if (type === "trial_multi_identity_block") multiIdentity += 1;
    if (type === "trial_force_block") forceBlock += 1;
    if (type === "trial_admin_blacklist") manualBlacklist += 1;
    const id = x.deviceId || x.androidId || x.fpHash || x.installId;
    if (id) bump(`${x.app}:${id}`);
  });
  blocks.forEach((x) => {
    const id = x.deviceId || x.androidId || x.fpHash || x.installId;
    if (id) bump(`${x.app}:${id}`);
  });
  const repeatOffenders = [...offenders.values()].filter((n) => n > 1).length;
  return [
    ["Date tamper", dateTamper],
    ["Reinstall abuse", reinstall],
    ["Multi-identity abuse", multiIdentity],
    ["Force blocks", forceBlock],
    ["Manual blacklists", manualBlacklist],
    ["Repeat offenders", repeatOffenders],
  ];
}
function histRenderStats() {
  const licenses = histFiltered("licenses");
  const trials = histFiltered("trials");
  const blocks = histFiltered("blocks");
  const activeLic = licenses.filter((x) => String(x.status || "").toUpperCase() === "ACTIVE").length;
  const revokedLic = licenses.filter((x) => String(x.status || "").toUpperCase() === "REVOKED").length;
  const activeTrials = trials.filter((x) => String(x.status || "").toUpperCase() === "ACTIVE").length;
  const endedTrials = trials.filter((x) => ["EXPIRED","REVOKED","BLOCKED"].includes(String(x.status || "").toUpperCase())).length;
  const restores = histFiltered('restores');
  const restoredRows = restores.filter((x) => x.reused).length;
  renderKpiCards("histStats", [
    { label: "Licenses", value: licenses.length, sub: `Active ${activeLic} • Revoked ${revokedLic}`, chips: appCountChips(licenses) },
    { label: "Trials", value: trials.length, sub: `Active ${activeTrials} • Ended ${endedTrials}`, chips: appCountChips(trials) },
    { label: "Blocks", value: blocks.length, sub: `Audit ${histFiltered("trialAudit").length}`, chips: appCountChips(blocks) },
    { label: "Restores", value: restores.length, sub: `Recovered ${restoredRows} • Fresh ${Math.max(0, restores.length-restoredRows)}`, chips: appCountChips(restores) },
  ]);
  const reasons = histCountReasons();
  const rBox = $("histReasons");
  if (rBox) rBox.innerHTML = reasons.length ? reasons.map(([key, count]) => {
    const parts = key.split("::");
    return `<div class="stackItem"><div><div><b>${escHtml(parts[1] || key)}</b></div><div class="muted">${escHtml(parts[0] || "")}</div></div><div class="pill">${count}</div></div>`;
  }).join("") : '<div class="muted">No revoke/block reasons found for current filters.</div>';
  const aBox = $("histAbuse");
  if (aBox) aBox.innerHTML = abuse.map(([label, count]) => `<div class="stackItem"><span>${escHtml(label)}</span><div class="pill">${count}</div></div>`).join("");
}
function histPageRows(rows) {
  _histPageSize = Math.max(1, Number($("histPageSize")?.value || 50));
  const totalPages = Math.max(1, Math.ceil(rows.length / _histPageSize));
  if (_histPage > totalPages) _histPage = totalPages;
  const start = (_histPage - 1) * _histPageSize;
  return { totalPages, start, page: rows.slice(start, start + _histPageSize) };
}
function histCsv(rows) {
  if (!rows.length) return "";
  const headers = [...new Set(rows.flatMap((row) => Object.keys(row || {})))];
  const esc = (v) => {
    const s = String(v == null ? "" : (typeof v === "object" ? JSON.stringify(v) : v));
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(",")].concat(rows.map((row) => headers.map((h) => esc(row[h])).join(","))).join("\n");
}
function histRenderTable() {
  const wrap = $("histTableWrap");
  const meta = $("histMeta");
  if (!wrap) return;
  const rows = histFiltered(_histTab);
  const { totalPages, start, page } = histPageRows(rows);
  const showingFrom = rows.length ? (start + 1) : 0;
  const showingTo = Math.min(start + page.length, rows.length);
  if (meta) meta.innerHTML = `<div>View ${escHtml(_histTab)} • Total ${rows.length} • Showing ${showingFrom}-${showingTo} • Page ${_histPage} of ${totalPages}</div><div class="tableHeaderMeta">${appCountChips(rows.slice(start, start + page.length))}</div>`;
  const noData = `<tr><td colspan="12" style="color:var(--muted)">No records found for current filters.</td></tr>`;
  if (_histTab === "licenses") {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>License ID</th><th>Status</th><th>Plan</th><th>Expiry</th><th>Device</th><th>Token</th><th>Notes</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td><code>${escHtml(x.licenseId || "-")}</code></td><td>${escHtml(x.status || "")}</td><td>${escHtml(x.plan || "")}</td><td>${escHtml(fmtTs(x.expiresAt) || x.expiryYmd || "-")}</td><td><code>${escHtml(x.boundDeviceId || "-")}</code></td><td><code>${escHtml(x.token || "-")}</code></td><td>${escHtml(x.notes || "-")}</td></tr>`).join("") || noData}</tbody></table>`;
  } else if (_histTab === "licenseAudit") {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>Type</th><th>License ID</th><th>From</th><th>Device</th><th>Reason</th><th>Time</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td>${escHtml(x.type || "")}</td><td><code>${escHtml(x.licenseId || "-")}</code></td><td><code>${escHtml(x.fromLicenseId || "-")}</code></td><td><code>${escHtml(x.deviceId || "-")}</code></td><td>${escHtml(x.reason || "-")}</td><td>${escHtml(fmtTs(x.createdAt) || "-")}</td></tr>`).join("") || noData}</tbody></table>`;
  } else if (_histTab === "trials") {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>Status</th><th>Device</th><th>Android ID</th><th>Install ID</th><th>FP Hash</th><th>Start</th><th>Expiry</th><th>Reason</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td>${escHtml(x.status || "")}</td><td><code>${escHtml(x.deviceId || "-")}</code></td><td><code>${escHtml(x.androidId || "-")}</code></td><td><code>${escHtml(x.installId || "-")}</code></td><td><code>${escHtml(x.fpHash || "-")}</code></td><td>${escHtml(String(x.startYmd || "-"))}</td><td>${escHtml(String(x.expiryYmd || "-"))}</td><td>${escHtml(x.revokeReason || x.blockReason || "-")}</td></tr>`).join("") || noData}</tbody></table>`;
  } else if (_histTab === "trialAudit") {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>Type</th><th>Device</th><th>Android ID</th><th>Install ID</th><th>FP Hash</th><th>IP</th><th>Time</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td>${escHtml(x.type || "")}</td><td><code>${escHtml(x.deviceId || "-")}</code></td><td><code>${escHtml(x.androidId || "-")}</code></td><td><code>${escHtml(x.installId || "-")}</code></td><td><code>${escHtml(x.fpHash || "-")}</code></td><td><code>${escHtml(x.ip || "-")}</code></td><td>${escHtml(fmtTs(x.createdAt) || "-")}</td></tr>`).join("") || noData}</tbody></table>`;
  } else if (_histTab === 'restores') {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>Entity</th><th>Action</th><th>Reuse</th><th>Reason</th><th>Name</th><th>Phone</th><th>Email</th><th>Device</th><th>Time</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td><code>${escHtml(x.entityId || '-')}</code><div class="muted">${escHtml(x.entityType || '-')}</div></td><td>${escHtml(x.action || '-')}</td><td>${x.reused ? 'YES' : 'NO'}</td><td>${escHtml(x.reuseReason || '-')}</td><td>${escHtml(x.entityName || '-')}</td><td><code>${escHtml(x.ownerPhone || '-')}</code></td><td><code>${escHtml(x.ownerEmail || '-')}</code></td><td><code>${escHtml(x.deviceId || '-')}</code></td><td>${escHtml(fmtTs(x.createdAt) || '-')}</td></tr>`).join('') || noData}</tbody></table>`;
  } else {
    wrap.innerHTML = `<table class="table"><thead><tr><th>App</th><th>Reason</th><th>Device</th><th>Android ID</th><th>Install ID</th><th>FP Hash</th><th>Active</th><th>Updated</th></tr></thead><tbody>${page.map((x) => `<tr><td>${escHtml(histAppLabel(x.app))}</td><td>${escHtml(x.reason || "-")}</td><td><code>${escHtml(x.deviceId || "-")}</code></td><td><code>${escHtml(x.androidId || "-")}</code></td><td><code>${escHtml(x.installId || "-")}</code></td><td><code>${escHtml(x.fpHash || "-")}</code></td><td>${x.active === false ? "No" : "Yes"}</td><td>${escHtml(fmtTs(x.updatedAt || x.createdAt) || "-")}</td></tr>`).join("") || noData}</tbody></table>`;
  }
}
async function histRefresh(forceReload = true) {
  try {
    if (forceReload) await histLoadData();
    histRenderStats();
    histRenderTable();
    renderLiveRefreshMeta();
  } catch (e) {
    toast(e?.message || "History refresh failed");
  }
}
function histBind() {
  document.querySelectorAll("button[data-hist-tab]").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("button[data-hist-tab]").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      _histTab = btn.getAttribute("data-hist-tab") || "licenses";
      _histPage = 1;
      histRenderStats();
      histRenderTable();
    });
  });
  const instantReloadIds = ["histApp"];
  instantReloadIds.forEach((id) => { const el = $(id); if (el) el.addEventListener("change", () => { _histPage = 1; histRefresh(true); }); });
  ["histQ", "histReason"].forEach((id) => { const el = $(id); if (el) el.addEventListener("input", () => { _histPage = 1; clearTimeout(histBind._t); histBind._t = setTimeout(() => histRefresh(false), 250); }); });
  ["histStatus", "histPlan", "histPageSize", "histFrom", "histTo"].forEach((id) => { const el = $(id); if (el) el.addEventListener("change", () => { _histPage = 1; histRefresh(false); }); });
  const rf = $("btnHistRefresh"); if (rf) rf.addEventListener("click", () => { _histPage = 1; histRefresh(true).then(() => { _liveRefreshLastAt = Date.now(); _liveRefreshNextAt = Date.now() + autoRefreshEveryMs(); renderLiveRefreshMeta(); }); });
  const prev = $("btnHistPrev"); if (prev) prev.addEventListener("click", () => { if (_histPage > 1) { _histPage -= 1; histRenderTable(); } });
  const next = $("btnHistNext"); if (next) next.addEventListener("click", () => {
    const rows = histFiltered(_histTab);
    const totalPages = Math.max(1, Math.ceil(rows.length / Math.max(1, Number($("histPageSize")?.value || 50))));
    if (_histPage < totalPages) { _histPage += 1; histRenderTable(); } else toast("No more pages");
  });
  const ex = $("btnHistExport"); if (ex) ex.addEventListener("click", () => {
    const rows = histFiltered(_histTab);
    const csv = histCsv(rows);
    if (!csv) return toast("No rows to export");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `history_${String($("histApp")?.value || "ALL").toLowerCase()}_${_histTab}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  const pdf = $("btnHistPdf"); if (pdf) pdf.addEventListener("click", () => {
    const rows = histFiltered(_histTab);
    const shown = rows.slice(0, 200);
    const headers = shown.length ? Object.keys(shown[0]) : [];
    const html = `<div class="muted">App ${escHtml(String($("histApp")?.value || 'ALL'))} • Tab ${escHtml(_histTab)} • Rows ${rows.length}</div>` + (shown.length ? `<table><thead><tr>${headers.map((h)=>`<th>${escHtml(h)}</th>`).join('')}</tr></thead><tbody>${shown.map((row)=>`<tr>${headers.map((h)=>`<td>${escHtml(typeof row[h] === 'object' ? JSON.stringify(row[h]) : String(row[h] ?? ''))}</td>`).join('')}</tr>`).join('')}</tbody></table>` : `<div class="muted">No rows to export.</div>`);
    printHtmlReport('License / Trial History Report', html);
  });
}



let _globalDashboardCache = null;

function badge(text) {
  return `<span class="pill">${escHtml(text)}</span>`;
}
function globalFilters() {
  return {
    app: String($('globalAppFilter')?.value || 'ALL').trim().toUpperCase(),
    action: String($('globalActionFilter')?.value || 'ALL').trim().toUpperCase(),
    from: String($('globalFrom')?.value || '').trim(),
    to: String($('globalTo')?.value || '').trim(),
  };
}
function renderMiniTable(targetId, headers, rows, emptyText = "No data") {
  const el = $(targetId);
  if (!el) return;
  if (!rows || !rows.length) {
    el.innerHTML = `<div class="muted">${escHtml(emptyText)}</div>`;
    return;
  }
  el.innerHTML = `<div class="tableHeaderMeta">${appCountChips(rows)}</div><table class="miniTable"><thead><tr>${headers.map((h) => `<th>${escHtml(h.label)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((h) => `<td>${h.render ? h.render(row) : escHtml(row[h.key] ?? "-")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function renderGlobalTrend(rows, action = 'ALL') {
  const box = $("globalTrend");
  if (!box) return;
  if (!rows || !rows.length) {
    box.innerHTML = '<div class="muted">No trend data yet.</div>';
    return;
  }
  box.innerHTML = rows.map((row) => {
    const nums = action === 'ABUSE'
      ? `<span>Blocked ${Number(row.blocked || 0)}</span>`
      : action === 'REVOKES'
        ? `<span>Revoke ${Number(row.revoke || 0)}</span>`
        : `<span>SPNG ${Number(row.SPNG || 0)}</span><span>CPNG ${Number(row.CPNG || 0)}</span><span>STMN ${Number(row.STMN || 0)}</span><span>RMP ${Number(row.RMP || 0)}</span><span>Revoke ${Number(row.revoke || 0)}</span><span>Blocked ${Number(row.blocked || 0)}</span>`;
    return `
    <div class="trendRow">
      <div class="trendLabel">${escHtml(row.label || row.month || '-')}</div>
      <div class="trendBar">
        <div class="trendHead">Activation / safety events</div>
        <div class="trendNums">${nums}</div>
      </div>
    </div>`;
  }).join('');
}


async function refreshGlobalDashboard() {
  const f = globalFilters();
  const data = await api(`/api/dev/global-dashboard${buildQuery({ app: f.app, from: f.from, to: f.to })}`, { method: 'GET' });
  _globalDashboardCache = { ...(data || {}), uiFilters: f };
  globalRenderSectionCounts(data || {});
  renderLiveRefreshMeta();
  const ov = data?.overview || {};
  const action = f.action || 'ALL';
  const meta = $('globalMeta');
  if (meta) {
    const rangeText = (f.from || f.to) ? `Range ${f.from || 'start'} → ${f.to || 'today'}` : 'Default 6-month view';
    meta.textContent = `${f.app || 'ALL'} • ${action} • ${rangeText}`;
  }
  const overviewEl = $("globalOverview");
  if (overviewEl) {
    const revokeLabel = (f.from || f.to) ? 'Revoked in range' : 'Revoked today';
    const blockedLabel = (f.from || f.to) ? 'Blocked in range' : 'Blocked today';
    overviewEl.innerHTML = [
      ["Total licenses", ov.totalLicenses, "Across selected app scope"],
      ["Active licenses", ov.activeLicenses, "Valid + not expired"],
      ["Expiring soon", ov.expiringSoon, "Next 14 days"],
      [revokeLabel, ov.revokedToday, "License revokes + resets"],
      [blockedLabel, ov.blockedToday, "Trial abuse / deny events"],
      ["Trials tracked", ov.trialsTracked, "Historic records"],
      ["Restores tracked", ov.restoresTracked, `Recovered ${Number(ov.restoredEntities || 0)}`],
    ].map(([label, value, sub]) => `<div class="kpiCard"><div class="kpiLabel">${escHtml(label)}</div><div class="kpiValue">${escHtml(String(value ?? 0))}</div><div class="kpiSub">${escHtml(sub)}</div></div>`).join("");
  }

  const appCardsEl = $("globalAppCards");
  if (appCardsEl) {
    appCardsEl.innerHTML = (data?.appCards || []).map((x) => `
      <div class="kpiCard">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
          <div>
            <div class="kpiLabel">${escHtml(x.app || '')}</div>
            <div class="kpiValue">${Number(x.active || 0)}</div>
          </div>
          <button class="btn" onclick="openHistoryForApp('${escHtml(x.app || 'ALL')}', 'licenses')">Open History</button>
        </div>
        <div class="kpiSub">Active • Total ${Number(x.total || 0)} • Soon ${Number(x.expiringSoon || 0)}</div>
        <div class="kpiChipRow">${chip('Active', Number(x.active || 0))}${chip('Total', Number(x.total || 0))}${chip('Soon', Number(x.expiringSoon || 0))}${chip('Blocked', Number(x.blockedToday || 0))}</div>
        <div class="trendNums" style="margin-top:8px;">
          <span>M ${Number(x.monthly || 0)}</span>
          <span>Y ${Number(x.yearly || 0)}</span>
          <span>Revoked ${Number(x.revokedToday || 0)}</span>
          <span>Reset ${Number(x.resetToday || 0)}</span>
          <span>Blocked ${Number(x.blockedToday || 0)}</span>
          <span>Restore ${Number(x.restores || 0)}</span>
        </div>
      </div>
    `).join("");
  }

  renderGlobalTrend(data?.trend || [], action);

  const reasons = $("globalReasons");
  if (reasons) {
    const list = (data?.topReasons || []).filter((x) => action !== 'ACTIVATIONS');
    reasons.innerHTML = list.length ? list.map((x) => `<div class="stackItem"><div><b>${escHtml(x.reason || 'unspecified')}</b><div class="muted">${escHtml(x.app || '')}</div></div><div class="row"><div class="pill">${Number(x.count || 0)}</div><button class="btn" onclick="openHistoryForApp('${escHtml(x.app || 'ALL')}', 'licenseAudit')">View</button></div></div>`).join("") : '<div class="muted">No revoke or block reasons yet for current filters.</div>';
  }

  renderMiniTable("globalExpiring", [
    { label: 'App', key: 'app' },
    { label: 'License', render: (r) => `<code>${escHtml(r.licenseId || '-')}</code>` },
    { label: 'Plan', key: 'plan' },
    { label: 'Expiry', render: (r) => escHtml(fmtTs(r.expiresAt) || '-') },
    { label: 'Device', render: (r) => `<code>${escHtml(r.deviceId || '-')}</code>` },
    { label: 'Action', render: (r) => `<button class="btn" onclick="openHistoryForApp('${escHtml(r.app || 'ALL')}', 'licenses')">History</button>` },
  ], action === 'ABUSE' ? [] : (data?.expiringSoonRows || []), 'No active licenses expiring soon.');

  const restoreBox = $('globalRestores');
  if (restoreBox) {
    const list = data?.recentRestores || [];
    restoreBox.innerHTML = list.length ? list.map((x) => `<div class="stackItem"><div><b>${escHtml(x.app || '')}</b> <code>${escHtml(x.action || '')}</code><div class="muted">${escHtml(x.entityName || x.entityId || '')}</div></div><div class="row"><div class="pill">${x.reused ? 'RESTORE' : 'CREATE'}</div><button class="btn" onclick="openHistoryForApp('${escHtml(x.app || 'ALL')}', 'restores')">Open</button></div></div>`).join('') : '<div class="muted">No restore activity yet.</div>';
  }

  const abuseEl = $("globalAbuse");
  if (abuseEl) {
    const list = data?.topAbuse || [];
    abuseEl.innerHTML = (action === 'ACTIVATIONS') ? '<div class="muted">Switch action filter to ABUSE to view device abuse hotspots.</div>' : (list.length ? list.map((x) => `<div class="stackItem"><div><b>${escHtml(x.app || '')}</b> <code>${escHtml(x.kind || '')}</code><div class="muted"><code>${escHtml(x.value || '')}</code></div></div><div class="row"><div class="pill">${Number(x.count || 0)}</div><button class="btn" onclick="openHistoryForApp('${escHtml(x.app || 'ALL')}', 'trialAudit')">Open</button></div></div>`).join("") : '<div class="muted">No abuse hotspots yet.</div>');
  }

  const recentRows = (data?.recentRevokes || []).filter((r) => action !== 'ACTIVATIONS');
  renderMiniTable("globalRevokes", [
    { label: 'App', key: 'app' },
    { label: 'Type', key: 'type' },
    { label: 'License', render: (r) => `<code>${escHtml(r.licenseId || '-')}</code>` },
    { label: 'Device', render: (r) => `<code>${escHtml(r.deviceId || '-')}</code>` },
    { label: 'Reason', key: 'reason' },
    { label: 'Date', render: (r) => escHtml(fmtTs(r.createdAt) || '-') },
    { label: 'Open', render: (r) => `<button class="btn" onclick="openHistoryForApp('${escHtml(r.app || 'ALL')}', 'licenseAudit')">History</button>` },
  ], recentRows, 'No recent revoke/reset activity.');
}

window.openHistoryForApp = openHistoryForApp;

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

  const gref = $("btnGlobalRefresh"); if (gref) gref.onclick = () => refreshGlobalDashboard().then(() => { _liveRefreshLastAt = Date.now(); _liveRefreshNextAt = Date.now() + autoRefreshEveryMs(); renderLiveRefreshMeta(); }).catch((e) => toast(e.message));
  ["globalAppFilter", "globalActionFilter", "globalFrom", "globalTo"].forEach((id) => { const el = $(id); if (el) el.addEventListener(el.tagName === 'INPUT' ? 'change' : 'change', () => refreshGlobalDashboard().catch((e) => toast(e.message))); });
  const gh = $("btnGlobalOpenHistory"); if (gh) gh.onclick = () => openHistoryForApp(String($("globalAppFilter")?.value || 'ALL'), 'licenses');
  const gcsv = $("btnGlobalExportCsv"); if (gcsv) gcsv.onclick = () => {
    const d = _globalDashboardCache;
    if (!d) return toast('Load the global dashboard first');
    const rows = [];
    (d.appCards || []).forEach((x) => rows.push({ section:'appCards', ...x }));
    (d.expiringSoonRows || []).forEach((x) => rows.push({ section:'expiringSoon', ...x }));
    (d.recentRevokes || []).forEach((x) => rows.push({ section:'recentRevokes', ...x }));
    (d.recentRestores || []).forEach((x) => rows.push({ section:'recentRestores', ...x }));
    (d.topAbuse || []).forEach((x) => rows.push({ section:'topAbuse', ...x }));
    (d.topReasons || []).forEach((x) => rows.push({ section:'topReasons', ...x }));
    (d.trend || []).forEach((x) => rows.push({ section:'trend', ...x }));
    const csv = histCsv(rows);
    if (!csv) return toast('No rows to export');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `global_dashboard_${String(d?.uiFilters?.app || 'all').toLowerCase()}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const gpdf = $("btnGlobalExportPdf"); if (gpdf) gpdf.onclick = () => {
    const d = _globalDashboardCache;
    if (!d) return toast('Load the global dashboard first');
    const ov = d.overview || {};
    const html = `
      <div class="muted">App ${escHtml(d.uiFilters?.app || 'ALL')} • Action ${escHtml(d.uiFilters?.action || 'ALL')} • ${(d.uiFilters?.from || d.uiFilters?.to) ? `Range ${escHtml(d.uiFilters?.from || 'start')} → ${escHtml(d.uiFilters?.to || 'today')}` : 'Default 6-month view'}</div>
      <div class="grid">
        <div class="card"><b>Total licenses</b><div>${Number(ov.totalLicenses || 0)}</div></div>
        <div class="card"><b>Active licenses</b><div>${Number(ov.activeLicenses || 0)}</div></div>
        <div class="card"><b>Expiring soon</b><div>${Number(ov.expiringSoon || 0)}</div></div>
        <div class="card"><b>Revoked / blocked</b><div>${Number(ov.revokedToday || 0)} / ${Number(ov.blockedToday || 0)}</div></div>
      </div>
      <h2>By App</h2><table><thead><tr><th>App</th><th>Total</th><th>Active</th><th>Expiring Soon</th><th>Monthly</th><th>Yearly</th><th>Revoked</th><th>Blocked</th></tr></thead><tbody>${(d.appCards || []).map((x)=>`<tr><td>${escHtml(x.app || '')}</td><td>${Number(x.total || 0)}</td><td>${Number(x.active || 0)}</td><td>${Number(x.expiringSoon || 0)}</td><td>${Number(x.monthly || 0)}</td><td>${Number(x.yearly || 0)}</td><td>${Number(x.revokedToday || 0)}</td><td>${Number(x.blockedToday || 0)}</td></tr>`).join('')}</tbody></table>
      <h2>Recent Revokes</h2><table><thead><tr><th>App</th><th>Type</th><th>License</th><th>Device</th><th>Reason</th><th>Date</th></tr></thead><tbody>${(d.recentRevokes || []).map((x)=>`<tr><td>${escHtml(x.app || '')}</td><td>${escHtml(x.type || '')}</td><td>${escHtml(x.licenseId || '')}</td><td>${escHtml(x.deviceId || '')}</td><td>${escHtml(x.reason || '')}</td><td>${escHtml(fmtTs(x.createdAt) || '')}</td></tr>`).join('') || '<tr><td colspan="6">No rows</td></tr>'}</tbody></table>
      <h2>Recent Restores</h2><table><thead><tr><th>App</th><th>Action</th><th>Entity</th><th>Phone</th><th>Email</th><th>Date</th></tr></thead><tbody>${(d.recentRestores || []).map((x)=>`<tr><td>${escHtml(x.app || '')}</td><td>${escHtml(x.action || '')}</td><td>${escHtml(x.entityName || x.entityId || '')}</td><td>${escHtml(x.ownerPhone || '')}</td><td>${escHtml(x.ownerEmail || '')}</td><td>${escHtml(fmtTs(x.createdAt) || '')}</td></tr>`).join('') || '<tr><td colspan="6">No rows</td></tr>'}</tbody></table>
    `;
    printHtmlReport('Global License & Trial Report', html);
  };

  const autoT = $('autoRefreshToggle'); if (autoT) autoT.addEventListener('change', () => scheduleLiveRefresh());
  const autoE = $('autoRefreshEvery'); if (autoE) autoE.addEventListener('change', () => scheduleLiveRefresh());

  // Load shops once key is present (or after user saves)
  histBind();
  if (getKey()) {
    smRefresh();
    Promise.all([
      refreshGlobalDashboard().catch(() => {}),
      refreshCpngStats().catch(() => {}),
      refreshCpngTokenTable(true).catch(() => {}),
      refreshCpngTrialDashboard().catch(() => {}),
      refreshCpngLicenseAudit().catch(() => {}),
      histRefresh(true).catch(() => {}),
    ]).finally(() => { _liveRefreshLastAt = Date.now(); scheduleLiveRefresh(); });
  } else {
    renderLiveRefreshMeta();
  }
});
