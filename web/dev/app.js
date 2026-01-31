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

