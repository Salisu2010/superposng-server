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

function parsePipeTokenMeta(tok) {
  // Expected: SPNG1|MONTHLY|YYYYMMDD|...
  const t = (tok || "").trim();
  if (!t.includes("|")) return null;
  const parts = t.split("|").map((x) => x.trim());
  if (parts.length < 3) return null;
  const plan = (parts[1] || "MONTHLY").toUpperCase();
  const ymd = parts[2] || "";
  if (!/^[0-9]{8}$/.test(ymd)) return { plan };
  const y = parseInt(ymd.slice(0, 4), 10);
  const m = parseInt(ymd.slice(4, 6), 10) - 1;
  const d = parseInt(ymd.slice(6, 8), 10);
  const dt = new Date(Date.UTC(y, m, d, 0, 0, 0));
  const expiresAt = dt.getTime();
  return { plan, expiresAt };
}

async function doRegisterToken() {
  const token = $("token").value.trim();
  if (!token) {
    toast("Enter a token first");
    return;
  }
  const meta = parsePipeTokenMeta(token) || {};
  const payload = { token, plan: meta.plan || "MONTHLY" };
  if (meta.expiresAt) payload.expiresAt = meta.expiresAt;
  await api("/api/dev/register-token", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  toast("Token registered");
}

async function doGenerateToken() {
  const out = await api("/api/dev/generate-token", {
    method: "POST",
    body: JSON.stringify({ plan: "MONTHLY" })
  });
  const tok = (out && out.license && out.license.token) ? out.license.token : "";
  if (tok) {
    $("token").value = tok;
    navigator.clipboard.writeText(tok).catch(() => {});
    toast("Generated token copied");
  } else {
    toast("Generated");
  }
}

async function doAssign() {
  const deviceId = $("deviceId").value.trim();
  const token = $("token").value.trim();
  const shopId = $("shopId").value.trim();
  if (!deviceId || !token) {
    toast("Device ID and Token are required");
    return;
  }
  let data;
  try {
    data = await api("/api/dev/assign-token", {
      method: "POST",
      body: JSON.stringify({ deviceId, token, shopId })
    });
  } catch (e) {
    // If token was created externally (e.g. Python) and isn't in server DB yet,
    // auto-register it then retry once.
    const msg = (e && e.message) ? String(e.message) : "";
    if (/token not found/i.test(msg)) {
      await doRegisterToken();
      data = await api("/api/dev/assign-token", {
        method: "POST",
        body: JSON.stringify({ deviceId, token, shopId })
      });
    } else {
      throw e;
    }
  }
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
  // Accept both legacy tokens (SPNG-XXXX-XXXX) and pipe tokens (SPNG1|MONTHLY|YYYYMMDD|...)
  if (/^SPNG/i.test(t) || t.includes("-") || t.includes("|")) return { token: t };
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

// Init
$("devKey").value = getKey();

$("btnSaveKey").addEventListener("click", () => {
  const v = $("devKey").value.trim();
  setKey(v);
  toast("DEV KEY saved");
});

$("btnAssign").addEventListener("click", () => doAssign().catch((e) => toast(e.message)));
$("btnRegister").addEventListener("click", () => doRegisterToken().catch((e) => toast(e.message)));
$("btnGenerate").addEventListener("click", () => doGenerateToken().catch((e) => toast(e.message)));
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
