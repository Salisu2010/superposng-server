const el = (id) => document.getElementById(id);

const state = {
  serverUrl: "",
  adminKey: "",
  map: null,
  markers: new Map(),
  polylines: new Map(),
  selectedDeviceId: "",
  sse: null,
  lastEventId: Number(localStorage.getItem("tg_last_evt") || "0") || 0,
  notifOn: (localStorage.getItem("tg_notif_on") || "0") === "1",
  beepOn: (localStorage.getItem("tg_beep_on") || "1") === "1",
  devicesCache: [],
  commandsCache: [],
  sseRetryMs: 1200,
  refreshTimer: null
};

const elv = (id) => (el(id) ? el(id).value : "");
const setv = (id, v) => { const x = el(id); if (x) x.value = v; };

function normBase(url) {
  url = (url || "").trim();
  if (!url) return "";
  return url.replace(/\/+$/, "");
}

function setStatus(t) {
  const s1 = el("statusText");
  const s2 = el("status");
  if (s1) s1.textContent = t || "Ready";
  if (s2) s2.textContent = t || "Ready";
}

function logLine(msg, cls) {
  const root = el("logs");
  if (!root) return;
  const p = document.createElement("div");
  p.className = "logline " + (cls || "");
  p.textContent = msg;
  root.prepend(p);
  while (root.childNodes.length > 140) root.removeChild(root.lastChild);
}

function warningLine(msg) { logLine(msg, "logbad"); }

function saveConfig() {
  const u = normBase(elv("serverUrl"));
  const k = String(elv("adminKey") || "").trim();
  localStorage.setItem("tg_server", u);
  localStorage.setItem("tg_admin", k);
  state.serverUrl = u;
  state.adminKey = k;
}

function loadConfig() {
  state.serverUrl = normBase(localStorage.getItem("tg_server") || "");
  state.adminKey = String(localStorage.getItem("tg_admin") || "").trim();
  setv("serverUrl", state.serverUrl || "");
  setv("adminKey", state.adminKey || "");

  const b1 = el("btnNotif");
  if (b1) b1.textContent = state.notifOn ? "Notifications: ON" : "Notifications: OFF";
  const b2 = el("btnBeep");
  if (b2) b2.textContent = state.beepOn ? "Beep: ON" : "Beep: OFF";
}

function currentServer() {
  // Integrated with SuperPOSNG server: use same origin
  // All TrackGuard APIs are namespaced under /api/trackguard
  return window.location.origin;
}

function currentKey() {
  // Preferred: SuperPOSNG owner/admin JWT stored by the Owner portal.
  const jwt = (localStorage.getItem('spng_owner_token') || '').trim();
  if (jwt) return jwt;
  // Fallback: Admin Key typed in dashboard (works great in Incognito)
  return (state.adminKey || '').trim();
}

function looksLikeJwt(s) {
  s = String(s || '').trim();
  // Very light check: header.payload.signature
  return s.split('.').length === 3;
}

function withKey(url, key) {
  key = String(key || '').trim();
  if (!key) return url;
  const u = new URL(url, window.location.origin);
  if (!u.searchParams.get('key')) u.searchParams.set('key', key);
  return u.toString();
}

async function api(path, opt = {}) {
  const srv = currentServer();
  if (!srv) throw new Error("Server URL ba a saka ba");

  const headers = Object.assign({}, opt.headers || {});
  headers["Content-Type"] = "application/json";

  const keyOrJwt = currentKey();
  if (keyOrJwt && looksLikeJwt(keyOrJwt)) {
    headers["Authorization"] = "Bearer " + keyOrJwt;
  }

  // Namespace all calls under SuperPOS TrackGuard module
  let url = srv + "/api/trackguard" + path;
  // If we're not using JWT, pass admin key through ?key=...
  if (keyOrJwt && !looksLikeJwt(keyOrJwt)) {
    url = withKey(url, keyOrJwt);
  }

  const res = await fetch(url, {
    method: opt.method || "GET",
    headers,
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });

  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); }
  catch { data = { ok: false, error: txt || ("HTTP " + res.status) }; }

  if (!res.ok) throw new Error((data && data.error) ? data.error : ("HTTP " + res.status));
  return data;
}

function initMap() {
  if (!window.L) return;
  const mapEl = el("map");
  if (!mapEl) return;
  try {
    state.map = L.map("map").setView([9.0, 7.0], 6);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(state.map);
  } catch {}
}

function setMarker(deviceId, loc) {
  if (!state.map || !window.L) return;
  const lat = Number(loc.lat);
  const lng = Number(loc.lng ?? loc.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
  const latlng = [lat, lng];
  const acc = Number(loc.acc ?? loc.accuracy ?? 0);
  const spd = Number(loc.speed ?? 0);
  const src = String(loc.src || loc.source || "");
  const ts = Number(loc.time ?? loc.at ?? loc.ts ?? Date.now());
  const pop = `<b>${deviceId}</b><br>acc: ${Math.round(acc)}m<br>speed: ${Math.round(spd * 10) / 10}<br>src: ${src}<br>time: ${new Date(ts).toLocaleString()}`;

  if (!state.markers.has(deviceId)) {
    const m = L.marker(latlng).addTo(state.map);
    m.bindPopup(pop);
    state.markers.set(deviceId, m);
  } else {
    const m = state.markers.get(deviceId);
    m.setLatLng(latlng);
    m.setPopupContent(pop);
  }

  const meta = el("mapMeta");
  if (meta) meta.textContent = `${deviceId} • ${lat.toFixed(6)}, ${lng.toFixed(6)} • acc ${Math.round(acc)}m • ${new Date(ts).toLocaleTimeString()}`;
}

async function drawTrail(deviceId) {
  try {
    if (!state.map || !window.L) return;
    const r = await api(`/location/trail?deviceId=${encodeURIComponent(deviceId)}&limit=120`);
    const pts = (r.items || r.trail || []).map(p => [Number(p.lat), Number(p.lng ?? p.lon)]).filter(x => Number.isFinite(x[0]) && Number.isFinite(x[1]));
    if (pts.length < 2) return;

    if (state.polylines.has(deviceId)) {
      state.map.removeLayer(state.polylines.get(deviceId));
      state.polylines.delete(deviceId);
    }

    const line = L.polyline(pts, { weight: 4, opacity: 0.7 }).addTo(state.map);
    state.polylines.set(deviceId, line);
  } catch {}
}

function absUrl(rel) {
  if (!rel) return "";
  if (/^https?:\/\//i.test(rel)) return rel;
  return (state.serverUrl || "") + rel;
}

function pickTs(obj) {
  const v = obj && (obj.ts ?? obj.at ?? obj.time ?? obj.createdAt ?? obj.updatedAt);
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/* Drawer */
function openDrawer() {
  const m = el("drawerMask");
  const d = el("drawer");
  if (m) m.style.display = "block";
  if (d) d.style.display = "flex";
}

function closeDrawer() {
  const m = el("drawerMask");
  const d = el("drawer");
  if (m) m.style.display = "none";
  if (d) d.style.display = "none";
}

function ago(ts) {
  const t = Number(ts || 0);
  if (!t) return "-";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function kvRow(k, v) {
  const div = document.createElement("div");
  div.className = "kvItem";
  const a = document.createElement("div");
  a.className = "kvKey";
  a.textContent = k;
  const b = document.createElement("div");
  b.className = "kvVal";
  b.textContent = (v == null || String(v).trim() === "") ? "-" : String(v);
  div.appendChild(a);
  div.appendChild(b);
  return div;
}

function renderDrawerForDevice(d) {
  const title = el("drawerTitle");
  const sub = el("drawerSub");
  const kv = el("drawerKv");

  if (title) title.textContent = d ? `Device ${d.deviceId}` : "Device Details";
  if (sub) sub.textContent = d ? `${d.online ? "ONLINE" : "OFFLINE"} • last seen ${ago(d.lastSeen)}` : "Select a device first";
  if (!kv) return;

  kv.innerHTML = "";
  if (!d) {
    kv.appendChild(kvRow("Info", "No device selected"));
    return;
  }

  kv.appendChild(kvRow("Device ID", d.deviceId));
  kv.appendChild(kvRow("Status", d.online ? "ONLINE" : "OFFLINE"));
  kv.appendChild(kvRow("Last Seen", d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "-"));
  kv.appendChild(kvRow("Seen Ago", ago(d.lastSeen)));

  kv.appendChild(kvRow("Brand", d.brand || "-"));
  kv.appendChild(kvRow("Model", d.model || "-"));
  kv.appendChild(kvRow("SDK", d.sdk || "-"));
  kv.appendChild(kvRow("App Version", d.appVersion || "-"));

  if (d.location && Number.isFinite(d.location.lat) && Number.isFinite(d.location.lon)) {
    kv.appendChild(kvRow("Location", `${Number(d.location.lat).toFixed(6)}, ${Number(d.location.lon).toFixed(6)}`));
    kv.appendChild(kvRow("Accuracy", `${Math.round(d.location.acc || 0)}m`));
    kv.appendChild(kvRow("Speed", `${Math.round((d.location.speed || 0) * 10) / 10}`));
    kv.appendChild(kvRow("Source", d.location.src || "-"));
    kv.appendChild(kvRow("Loc Time", d.location.time ? new Date(d.location.time).toLocaleString() : "-"));
  } else {
    kv.appendChild(kvRow("Location", "No location yet"));
  }

  const st = d.status || null;
  kv.appendChild(kvRow("Battery", st && st.battery != null ? `${st.battery}%` : "-"));
  kv.appendChild(kvRow("Charging", st && st.charging != null ? (st.charging ? "YES" : "NO") : "-"));
  kv.appendChild(kvRow("Network", st && st.network ? st.network : "-"));
  kv.appendChild(kvRow("Signal", st && st.signal != null ? String(st.signal) : "-"));
  kv.appendChild(kvRow("Extra", st && st.extra ? st.extra : "-"));
}

/* Intruder */
function showIntruder(rec) {
  const img = el("intruderImg");
  const meta = el("intruderMeta");

  const ts = pickTs(rec);
  const when = ts ? new Date(ts).toLocaleString() : "-";

  if (meta) meta.textContent = rec ? `${rec.deviceId || "-"} • ${when} • ${rec.reason || ""}` : "No intruder photo yet.";

  if (img) {
    if (!rec || !rec.url) {
      img.style.display = "none";
      img.removeAttribute("src");
      img.removeAttribute("data-url");
    } else {
      img.src = absUrl(rec.url);
      img.style.display = "block";
      img.setAttribute("data-url", absUrl(rec.url));
    }
  }
}

async function loadIntruderList(deviceId) {
  const box = el("intruderList");
  if (!box) return;
  box.innerHTML = "";
  if (!deviceId) {
    box.innerHTML = `<div class="logline logmuted">Select a device first</div>`;
    return;
  }

  try {
    const r = await api(`/intruder/list?deviceId=${encodeURIComponent(deviceId)}&limit=20`);
    const items = r.items || [];
    if (!items.length) {
      box.innerHTML = `<div class="logline logmuted">No intruder photos yet</div>`;
      return;
    }

    items.forEach(it => {
      const ts = pickTs(it);
      const when = ts ? new Date(ts).toLocaleString() : "-";

      const row = document.createElement("div");
      row.className = "intruderRow";
      row.innerHTML = `
        <div class="intruderRowLeft">
          <div class="intruderRowTitle">${it.deviceId || "-"}</div>
          <div class="intruderRowMeta">${when} • ${it.reason || "intruder"}</div>
        </div>
        <button class="btn">View</button>
      `;
      row.querySelector("button").onclick = () => showIntruder(it);
      box.appendChild(row);
    });
  } catch (e) {
    box.innerHTML = `<div class="logline logbad">Failed to load intruder list</div>`;
  }
}

/* Commands history */
function tagForStatus(st) {
  const s = String(st || "").toLowerCase();
  if (s === "done") return `<span class="tag ok">done</span>`;
  if (s === "failed") return `<span class="tag bad">failed</span>`;
  if (s === "sent") return `<span class="tag mid">sent</span>`;
  if (s === "queued") return `<span class="tag gray">queued</span>`;
  return `<span class="tag gray">${s || "-"}</span>`;
}

function fmtMsg(msg) {
  const m = (msg == null ? "" : String(msg)).trim();
  if (!m) return "";
  return m.length > 160 ? (m.slice(0, 160) + "...") : m;
}

function renderCommandList(deviceId, commands) {
  const root = el("cmdHistory");
  if (!root) return;

  const filter = (el("cmdFilter") ? el("cmdFilter").value : "ALL") || "ALL";
  const list = (commands || []).slice();
  const out = filter === "ALL" ? list : list.filter(c => String(c.status || "").toLowerCase() === filter);

  root.innerHTML = "";

  if (!deviceId) {
    root.innerHTML = `<div class="logline logmuted">Select a device</div>`;
    return;
  }

  if (!out.length) {
    root.innerHTML = `<div class="logline logmuted">No commands</div>`;
    return;
  }

  out.forEach(cmd => {
    const whenTs = Number(cmd.updatedAt || cmd.createdAt || 0) || 0;
    const when = whenTs ? new Date(whenTs).toLocaleString() : "-";
    const msg = cmd.result && cmd.result.msg ? cmd.result.msg : "";

    const row = document.createElement("div");
    row.className = "cmdRow";
    row.innerHTML = `
      <div class="cmdLeft">
        <div class="cmdTitle">${cmd.type || "CMD"} ${tagForStatus(cmd.status)}</div>
        <div class="cmdMeta">id: ${cmd.id || "-"} • ${when} • updated ${ago(cmd.updatedAt || cmd.createdAt)}</div>
        ${msg ? `<div class="cmdMeta">msg: ${fmtMsg(msg)}</div>` : ``}
      </div>
      <div class="cmdRight">
        <button class="btnMini">Retry</button>
      </div>
    `;

    row.querySelector("button").onclick = async () => {
      try {
        await api("/command/send", { method: "POST", body: { deviceId, type: String(cmd.type || "LOCATE").toUpperCase() } });
        logLine(`Retry queued: ${cmd.type} → ${deviceId}`, "logok");
        beep();
        notify("Command queued", `${cmd.type} → ${deviceId}`, { silent: true });
      } catch (e) {
        logLine(`Retry failed: ${e.message || e}`, "logbad");
      }
    };

    root.appendChild(row);
  });
}

async function loadCommandHistory(deviceId) {
  const meta = el("cmdMeta");
  if (!deviceId) {
    if (meta) meta.textContent = "Select a device to view history";
    renderCommandList("", []);
    return;
  }
  if (meta) meta.textContent = `Loading commands for ${deviceId}...`;
  try {
    const r = await api(`/commands?deviceId=${encodeURIComponent(deviceId)}`);
    const cmds = r.commands || [];
    state.commandsCache = cmds;
    if (meta) meta.textContent = `${deviceId} • ${cmds.length} commands`;
    renderCommandList(deviceId, cmds);
  } catch (e) {
    if (meta) meta.textContent = `Failed to load commands: ${e.message || e}`;
    warningLine("Commands load failed: " + (e.message || e));
  }
}

/* Notifications + Beep */
function beep() {
  if (!state.beepOn) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880;
    g.gain.value = 0.08;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    setTimeout(() => {
      try { o.stop(); } catch {}
      try { ctx.close(); } catch {}
    }, 160);
  } catch {}
}

function notify(title, body, opt = {}) {
  if (!state.notifOn) return;
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title || "TrackGuard", { body: body || "", silent: !!opt.silent });
  } catch {}
}

async function toggleNotifications() {
  if (!("Notification" in window)) {
    logLine("Browser dinka baya goyon bayan Notifications", "logbad");
    return;
  }

  if (!state.notifOn) {
    const p = await Notification.requestPermission();
    if (p !== "granted") {
      logLine("Notification permission an hana", "logbad");
      state.notifOn = false;
      localStorage.setItem("tg_notif_on", "0");
      const b = el("btnNotif");
      if (b) b.textContent = "Notifications: OFF";
      return;
    }
    state.notifOn = true;
    localStorage.setItem("tg_notif_on", "1");
    notify("TrackGuard", "Notifications enabled", { silent: true });
    logLine("Notifications ON", "logok");
  } else {
    state.notifOn = false;
    localStorage.setItem("tg_notif_on", "0");
    logLine("Notifications OFF", "logmuted");
  }

  const b = el("btnNotif");
  if (b) b.textContent = state.notifOn ? "Notifications: ON" : "Notifications: OFF";
}

function toggleBeep() {
  state.beepOn = !state.beepOn;
  localStorage.setItem("tg_beep_on", state.beepOn ? "1" : "0");
  const b = el("btnBeep");
  if (b) b.textContent = state.beepOn ? "Beep: ON" : "Beep: OFF";
  logLine(state.beepOn ? "Beep ON" : "Beep OFF", "logmuted");
  if (state.beepOn) beep();
}

/* Devices render */
function renderDeviceSelect(devices) {
  const sel = el("deviceSelect");
  if (!sel) return;

  const cur = state.selectedDeviceId || sel.value || "";
  sel.innerHTML = "";

  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Select device...";
  sel.appendChild(opt0);

  (devices || []).forEach(d => {
    const o = document.createElement("option");
    o.value = d.deviceId;
    o.textContent = `${d.deviceId}${d.online ? " (ONLINE)" : " (OFFLINE)"}`;
    sel.appendChild(o);
  });

  if ((devices || []).some(d => d.deviceId === cur)) sel.value = cur;

  sel.onchange = async () => {
    state.selectedDeviceId = sel.value || "";
    if (!state.selectedDeviceId) {
      renderDrawerForDevice(null);
      return;
    }

    const d = (devices || []).find(x => x.deviceId === state.selectedDeviceId) || null;
    if (d && d.location && state.map && Number.isFinite(d.location.lat) && Number.isFinite(d.location.lon)) {
      state.map.setView([d.location.lat, d.location.lon], 16);
      setMarker(d.deviceId, d.location);
      await drawTrail(d.deviceId);
    }
    renderDrawerForDevice(d);
    await loadIntruderList(state.selectedDeviceId);
    await loadCommandHistory(state.selectedDeviceId);
  };
}

function renderDevices(devices) {
  const root = el("devices");
  if (!root) return;
  root.innerHTML = "";

  const dc = el("devCount");
  if (dc) dc.textContent = String((devices || []).length || 0);

  (devices || []).forEach(d => {
    const div = document.createElement("div");
    div.className = "device";

    const badge = d.online ? `<span class="badge on">ONLINE</span>` : `<span class="badge off">OFFLINE</span>`;
    const meta1 = `${(d.brand || "").trim()} ${(d.model || "").trim()} • SDK:${d.sdk || "-"} • v:${d.appVersion || "-"}`.trim();

    const loc = d.location && Number.isFinite(d.location.lat) && Number.isFinite(d.location.lon)
      ? `${Number(d.location.lat).toFixed(6)}, ${Number(d.location.lon).toFixed(6)} • acc ${Math.round(d.location.acc || 0)}m`
      : "No location yet";

    div.innerHTML = `
      <div class="devleft">
        <div class="devid">${d.deviceId} ${badge}</div>
        <div class="devmeta">${meta1 || "-"}</div>
        <div class="devmeta">${loc}</div>
      </div>
      <button class="btn" data-id="${d.deviceId}">Show</button>
    `;

    div.querySelector("button").onclick = async () => {
      state.selectedDeviceId = d.deviceId;
      const sel = el("deviceSelect");
      if (sel) sel.value = d.deviceId;

      if (d.location && state.map && Number.isFinite(d.location.lat) && Number.isFinite(d.location.lon)) {
        state.map.setView([d.location.lat, d.location.lon], 16);
        setMarker(d.deviceId, d.location);
        await drawTrail(d.deviceId);
      }

      renderDrawerForDevice(d);
      openDrawer();
      await loadIntruderList(d.deviceId);
      await loadCommandHistory(d.deviceId);
    };

    root.appendChild(div);
  });
}

/* Commands */
async function sendCommand(type) {
  const deviceId = String(state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "") || "").trim();
  if (!deviceId) { logLine("Select device first", "logbad"); return; }
  try {
    await api("/command/send", { method: "POST", body: { deviceId, type: String(type).toUpperCase() } });
    logLine(`Command queued: ${type} → ${deviceId}`, "logok");
    beep();
    notify("Command queued", `${type} → ${deviceId}`, { silent: true });
    await loadCommandHistory(deviceId);
  } catch (e) {
    logLine(`Command failed: ${type} → ${deviceId} (${e.message || e})`, "logbad");
  }
}

async function generatePair() {
  try {
    const r = await api("/pair/generate", { method: "POST", body: {} });
    const code = r.code || (r.payload && r.payload.code) || "";
    if (el("pairCode")) el("pairCode").textContent = code || "----";
    logLine("Pair code generated: " + (code || "-"), "logok");
    notify("Pair Code Ready", `Code: ${code || "-"}`, { silent: true });
  } catch (e) {
    logLine("Generate pair failed: " + (e.message || e), "logbad");
  }
}

/* Refresh */
async function refresh() {
  try {
    setStatus("Loading...");
    const r = await api("/devices");
    const devices = r.devices || [];
    state.devicesCache = devices;

    renderDevices(devices);
    renderDeviceSelect(devices);

    if (state.selectedDeviceId) {
      const d = devices.find(x => x.deviceId === state.selectedDeviceId) || null;
      if (d) {
        renderDrawerForDevice(d);
        if (d.location && state.map) {
          setMarker(d.deviceId, d.location);
        }
      }
    }

    setStatus("Ready");
  } catch (e) {
    setStatus("Error");
    warningLine("Refresh failed: " + (e.message || e));
  }
}

function startRefreshLoop() {
  try { if (state.refreshTimer) clearInterval(state.refreshTimer); } catch {}
  state.refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, 15000);
}

/* SSE */
function closeSSE() {
  try { if (state.sse) state.sse.close(); } catch {}
  state.sse = null;
}

function openSSE() {
  closeSSE();

  const srv = currentServer();
  const key = currentKey();

  if (!srv) { logLine("Set server URL first", "logbad"); return; }
  if (!key) { logLine("Admin Key missing (SSE needs ?key=...)", "logbad"); return; }

  const last = encodeURIComponent(String(state.lastEventId || 0));
  const k = encodeURIComponent(String(key));
  const url = `${srv}/api/events?lastId=${last}&key=${k}`;

  logLine("SSE URL: " + url, "logmuted");

  const es = new EventSource(url);
  state.sse = es;

  state.sseRetryMs = 1200;

  es.addEventListener("hello", () => logLine("Push connected (SSE)", "logok"));
  es.addEventListener("ping", () => {});
  es.addEventListener("heartbeat", (ev) => onEvt(ev));
  es.addEventListener("status", (ev) => onEvt(ev));
  es.addEventListener("pair_code", (ev) => onEvt(ev));
  es.addEventListener("paired", (ev) => onEvt(ev));
  es.addEventListener("location", (ev) => onEvt(ev));
  es.addEventListener("intruder_photo", (ev) => onEvt(ev));
  es.addEventListener("command_queued", (ev) => onEvt(ev));
  es.addEventListener("command_sent", (ev) => onEvt(ev));
  es.addEventListener("command_ack", (ev) => onEvt(ev));
  es.addEventListener("command_result", (ev) => onEvt(ev));

  function scheduleRetry() {
    const wait = Math.min(20000, state.sseRetryMs);
    state.sseRetryMs = Math.min(20000, Math.floor(state.sseRetryMs * 1.6));
    logLine("Push disconnected, retrying...", "logmuted");
    closeSSE();
    setTimeout(() => openSSE(), wait);
  }

  es.onerror = () => {
    scheduleRetry();
  };
}

function onEvt(ev) {
  try {
    const obj = JSON.parse(ev.data || "{}");
    if (obj && obj.id) {
      state.lastEventId = obj.id;
      localStorage.setItem("tg_last_evt", String(obj.id));
    }
    handleEvent(obj);
  } catch {}
}

function handleEvent(evt) {
  if (!evt || !evt.type) return;
  const p = evt.payload || {};
  const t = evt.type;

  if (t === "paired") {
    beep();
    notify("Device paired", `${p.deviceId || "device"} paired`, {});
    logLine(`Device paired: ${p.deviceId || "-"}`, "logok");
    refresh().catch(() => {});
    return;
  }

  if (t === "pair_code") {
    logLine(`Pair code generated: ${p.code || "-"}`, "logok");
    notify("Pair Code Ready", `Code: ${p.code || "-"}`, { silent: true });
    if (el("pairCode")) el("pairCode").textContent = p.code || "----";
    return;
  }

  if (t === "heartbeat") {
    const deviceId = p.deviceId || "";
    if (deviceId) {
      const d = state.devicesCache.find(x => x.deviceId === deviceId);
      if (d) {
        d.lastSeen = p.lastSeen || Date.now();
        d.online = true;
        renderDevices(state.devicesCache);
        renderDeviceSelect(state.devicesCache);
        if (state.selectedDeviceId === deviceId) renderDrawerForDevice(d);
      }
    }
    return;
  }

  if (t === "status") {
    const deviceId = p.deviceId || "";
    if (deviceId) {
      const d = state.devicesCache.find(x => x.deviceId === deviceId);
      if (d) {
        d.status = p;
        renderDevices(state.devicesCache);
        renderDeviceSelect(state.devicesCache);
        if (state.selectedDeviceId === deviceId) renderDrawerForDevice(d);
      }
    }
    return;
  }

  if (t === "location") {
    const deviceId = p.deviceId || "";
    if (deviceId && Number.isFinite(p.lat) && Number.isFinite(p.lon)) {
      setMarker(deviceId, p);

      const d = state.devicesCache.find(x => x.deviceId === deviceId);
      if (d) d.location = p;

      if (state.selectedDeviceId === deviceId) drawTrail(deviceId).catch(() => {});
      if (state.beepOn) beep();
      notify("Location update", `${deviceId}: ${Number(p.lat).toFixed(5)}, ${Number(p.lon).toFixed(5)}`, { silent: true });

      renderDevices(state.devicesCache);
      renderDeviceSelect(state.devicesCache);
      if (state.selectedDeviceId === deviceId) renderDrawerForDevice(d || null);
    }
    return;
  }

  if (t === "command_result") {
    const deviceId = p.deviceId || "";
    const ok = !!p.ok;
    const type = p.type || "CMD";
    beep();
    notify("Command result", `${type} on ${deviceId}: ${ok ? "OK" : "FAILED"}`, {});
    logLine(`Result: ${type} → ${deviceId} = ${ok ? "OK" : "FAILED"} ${p.msg ? ("(" + p.msg + ")") : ""}`, ok ? "logok" : "logbad");
    if (state.selectedDeviceId && deviceId === state.selectedDeviceId) loadCommandHistory(deviceId).catch(() => {});
    return;
  }

  if (t === "command_queued" || t === "command_sent" || t === "command_ack") {
    const deviceId = p.deviceId || "";
    if (deviceId && state.selectedDeviceId === deviceId) loadCommandHistory(deviceId).catch(() => {});
    return;
  }

  if (t === "intruder_photo") {
    const deviceId = p.deviceId || "";
    beep();
    notify("Intruder detected", `${deviceId} • photo captured`, {});
    logLine(`Intruder photo: ${deviceId} (${p.reason || "intruder"})`, "logbad");
    showIntruder(p);
    const sel = state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "");
    if (deviceId && (!sel || sel === deviceId)) loadIntruderList(deviceId).catch(() => {});
    return;
  }
}

/* UI bind */
function bindUI() {
  const saveBtn = el("btnSaveServer");
  if (saveBtn) saveBtn.onclick = async () => {
    saveConfig();
    logLine("Saved config", "logok");
    await refresh().catch(() => {});
    openSSE();
  };

  const btnPair = el("btnGeneratePair");
  if (btnPair) btnPair.onclick = () => generatePair();

  const bn = el("btnNotif");
  if (bn) bn.onclick = () => toggleNotifications();

  const bb = el("btnBeep");
  if (bb) bb.onclick = () => toggleBeep();

  const btnOpenDrawer = el("btnOpenDrawer");
  if (btnOpenDrawer) btnOpenDrawer.onclick = () => {
    const deviceId = String(state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "") || "").trim();
    const d = deviceId ? (state.devicesCache.find(x => x.deviceId === deviceId) || null) : null;
    renderDrawerForDevice(d);
    openDrawer();
  };

  const btnDrawerClose = el("btnDrawerClose");
  if (btnDrawerClose) btnDrawerClose.onclick = () => closeDrawer();

  const dm = el("drawerMask");
  if (dm) dm.onclick = () => closeDrawer();

  const btnLocate = el("btnLocate");
  if (btnLocate) btnLocate.onclick = () => sendCommand("LOCATE");

  const btnAlarm = el("btnAlarm");
  if (btnAlarm) btnAlarm.onclick = () => sendCommand("ALARM");

  const btnEmerOn = el("btnEmerOn");
  if (btnEmerOn) btnEmerOn.onclick = () => sendCommand("EMERGENCY_ON");

  const btnEmerOff = el("btnEmerOff");
  if (btnEmerOff) btnEmerOff.onclick = () => sendCommand("EMERGENCY_OFF");

  const btnDrawerLocate = el("btnDrawerLocate");
  if (btnDrawerLocate) btnDrawerLocate.onclick = () => sendCommand("LOCATE");

  const btnDrawerAlarm = el("btnDrawerAlarm");
  if (btnDrawerAlarm) btnDrawerAlarm.onclick = () => sendCommand("ALARM");

  const btnDrawerEmerOn = el("btnDrawerEmerOn");
  if (btnDrawerEmerOn) btnDrawerEmerOn.onclick = () => sendCommand("EMERGENCY_ON");

  const btnDrawerEmerOff = el("btnDrawerEmerOff");
  if (btnDrawerEmerOff) btnDrawerEmerOff.onclick = () => sendCommand("EMERGENCY_OFF");

  const btnIntruderReload = el("btnIntruderReload");
  if (btnIntruderReload) btnIntruderReload.onclick = async () => {
    const deviceId = String(state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "") || "").trim();
    await loadIntruderList(deviceId);
  };

  const btnOpenIntruder = el("btnOpenIntruder");
  if (btnOpenIntruder) btnOpenIntruder.onclick = () => {
    const img = el("intruderImg");
    if (!img) return;
    const u = img.getAttribute("data-url") || img.getAttribute("src") || "";
    if (u) window.open(u, "_blank");
  };

  const btnClearIntruderView = el("btnClearIntruderView");
  if (btnClearIntruderView) btnClearIntruderView.onclick = () => showIntruder(null);

  const btnCmdReload = el("btnCmdReload");
  if (btnCmdReload) btnCmdReload.onclick = async () => {
    const deviceId = String(state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "") || "").trim();
    await loadCommandHistory(deviceId);
  };

  const btnCmdClear = el("btnCmdClear");
  if (btnCmdClear) btnCmdClear.onclick = () => {
    const root = el("cmdHistory");
    if (root) root.innerHTML = "";
    const meta = el("cmdMeta");
    if (meta) meta.textContent = "Cleared UI";
  };

  const cmdFilter = el("cmdFilter");
  if (cmdFilter) cmdFilter.onchange = () => {
    const deviceId = String(state.selectedDeviceId || (el("deviceSelect") ? el("deviceSelect").value : "") || "").trim();
    renderCommandList(deviceId, state.commandsCache || []);
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      refresh().catch(() => {});
      openSSE();
    }
  });
}

/* Boot */
function boot() {
  loadConfig();
  bindUI();
  initMap();

  refresh().catch(() => {});
  startRefreshLoop();
  openSSE();

  const key = currentKey();
  if (key && !state.notifOn && ("Notification" in window) && Notification.permission === "granted") {
    state.notifOn = true;
    localStorage.setItem("tg_notif_on", "1");
    const b = el("btnNotif");
    if (b) b.textContent = "Notifications: ON";
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
function setupUi() {
  const btnOpen = el("btnOpenDrawer");
  const btnClose = el("btnDrawerClose");
  const mask = el("drawerMask");

  if (btnOpen) {
    btnOpen.onclick = () => {
      const sel = el("deviceSelect");
      const id = (state.selectedDeviceId || (sel ? sel.value : "") || "").trim();
      if (!id) { logLine("Select device first", "logbad"); return; }

      const d = (state.devicesCache || []).find(x => x.deviceId === id) || null;
      renderDrawerForDevice(d);
      openDrawer();
    };
  }

  if (btnClose) btnClose.onclick = closeDrawer;
  if (mask) mask.onclick = closeDrawer;
}

window.addEventListener("load", () => {
  loadConfig();
  initMap();
  setupUi();
});
