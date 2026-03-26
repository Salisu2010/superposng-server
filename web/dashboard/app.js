const $ = id => document.getElementById(id);
const storage = {
  get base(){ return localStorage.getItem('clinic.base') || 'https://api.superpos.com.ng'; },
  set base(v){ localStorage.setItem('clinic.base', v || ''); },
  get hospitalId(){ return localStorage.getItem('clinic.hospitalId') || ''; },
  set hospitalId(v){ localStorage.setItem('clinic.hospitalId', v || ''); }
};

let activeTab = 'overview';
let feedCursor = 0;
let eventSource = null;
let refreshTimer = null;
let pollTimer = null;
let dashboardState = {
  overview: {},
  finance: {},
  queue: [],
  bills: [],
  visits: [],
  notifications: [],
  patients: [],
  timeline: []
};

function esc(v){
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function ngn(v){ return 'NGN ' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function nowText(){ return new Date().toLocaleTimeString(); }
function fmtDate(v){ const n = Number(v || 0); return n ? new Date(n).toLocaleString() : '--'; }
function toNum(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function debounceRefresh(ms = 700){ clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshAll(false), ms); }
function connReady(){ return $('base').value.trim() && $('hospitalId').value.trim(); }

function connHeaders(){
  const clinicId = $('hospitalId').value.trim();
  return {
    'Content-Type': 'application/json',
    'X-Clinic-Id': clinicId,
    'X-Hospital-Id': clinicId
  };
}

async function api(path, method = 'GET', body){
  const base = $('base').value.trim().replace(/\/$/, '');
  if (!base) throw new Error('Base URL is required');
  const opts = { method, headers: connHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(base + path, opts);
  const t = await r.text();
  let d = {};
  try { d = t ? JSON.parse(t) : {}; } catch { throw new Error(t || ('HTTP ' + r.status)); }
  if (!r.ok || d.ok === false) throw new Error(d.error || d.message || ('HTTP ' + r.status));
  return d;
}

function setStatus(mode, text) {
  const pill = $('livePill');
  pill.textContent = text;
  pill.classList.remove('connected', 'error');
  if (mode === 'connected') pill.classList.add('connected');
  if (mode === 'error') pill.classList.add('error');
  $('spotStatus').textContent = text;
}

function toast(msg, bad = false){
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.borderColor = bad ? 'rgba(239,68,68,.26)' : 'rgba(34,211,238,.22)';
  el.innerHTML = esc(msg);
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabSection').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById('tab-' + tab);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.navBtn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
}

function updateClock() {
  $('systemClock').textContent = nowText();
}

function metricCard(label, value, sub, mode = 'kpiInfo') {
  return `<div class="metricCard ${esc(mode)}"><div class="metricLabel">${esc(label)}</div><div class="metricValue">${esc(value)}</div><div class="metricSub">${esc(sub || '')}</div></div>`;
}
function item(title, lines = [], actions = '') {
  return `<div class="item"><strong>${esc(title || '--')}</strong>${lines.map(x => `<div class="muted">${esc(x)}</div>`).join('')}${actions}</div>`;
}
function emptyState(msg) { return `<div class="emptyState">${esc(msg)}</div>`; }
function formDataObject(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    const val = String(v == null ? '' : v).trim();
    if (val !== '') out[k] = val;
  }
  return out;
}

function openModal(title, eyebrow, templateId, setup){
  $('modalTitle').textContent = title;
  $('modalEyebrow').textContent = eyebrow;
  const tpl = $(templateId);
  $('modalBody').innerHTML = '';
  $('modalBody').appendChild(tpl.content.cloneNode(true));
  $('modalWrap').classList.remove('hidden');
  if (typeof setup === 'function') setup($('modalBody'));
}
function closeModal(){ $('modalWrap').classList.add('hidden'); $('modalBody').innerHTML = ''; }

function renderActivity(notifications = []) {
  dashboardState.notifications = notifications;
  $('activityFeed').innerHTML = notifications.length
    ? notifications.slice(0, 20).map(n => {
        const type = n.type || 'activity';
        return `<div class="feedItem"><strong>${esc(n.title || 'Clinic Activity')}</strong><div class="muted">${esc(n.message || '')}</div><div class="feedMeta"><span class="feedType">${esc(type)}</span><span>${esc(fmtDate(n.createdAt))}</span></div></div>`;
      }).join('')
    : emptyState('No recent operational activity yet.');
}

function renderAiSummary(summary) {
  if (!summary) {
    $('patientAiSummary').innerHTML = emptyState('Search and select a patient to load AI summary.');
    return;
  }
  $('patientAiSummary').innerHTML = `
    <div class="aiSummary">
      <strong>${esc(summary.patient?.fullName || summary.patient?.patientName || summary.patientId || 'Patient')}</strong>
      <div class="muted">Risk Level: ${esc(summary.riskLevel || '--')} • Risk Score: ${esc(summary.riskScore || 0)}</div>
      <div class="muted">Visits: ${esc(summary.visitCount || 0)} • Bills: ${esc(summary.billCount || 0)} • Dispenses: ${esc(summary.dispenseCount || 0)}</div>
      <div class="muted">Outstanding: ${esc(ngn(summary.outstanding || 0))}</div>
      <div class="feedMeta"><span>${esc(summary.summary || 'No AI summary')}</span><span>${esc(fmtDate(summary.lastVisit?.createdAt || summary.lastVisit?.created_at || 0))}</span></div>
    </div>`;
}

function groupByDay(rows, field, valField){
  const map = new Map();
  rows.forEach(r => {
    const dt = new Date(Number(r[field] || r.createdAt || Date.now()));
    const key = isNaN(dt) ? 'Unknown' : dt.toLocaleDateString(undefined, { month:'short', day:'numeric' });
    map.set(key, (map.get(key) || 0) + Number(r[valField] || 0));
  });
  return Array.from(map.entries()).slice(-7);
}

function drawBarChart(canvasId, pairs, yPrefix = 'NGN '){
  const canvas = $(canvasId);
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 600;
  const height = Number(canvas.getAttribute('height') || 220);
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);
  const pad = { l:44, r:16, t:18, b:32 };
  const vals = pairs.map(x => Number(x[1] || 0));
  const max = Math.max(1, ...vals);
  ctx.strokeStyle = 'rgba(123,160,214,.18)';
  ctx.lineWidth = 1;
  for (let i=0;i<4;i++) {
    const y = pad.t + ((height - pad.t - pad.b) / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
  }
  const plotW = width - pad.l - pad.r;
  const barW = Math.max(22, Math.min(48, plotW / Math.max(1,pairs.length) - 12));
  pairs.forEach((p, idx) => {
    const x = pad.l + (plotW / Math.max(1,pairs.length)) * idx + 10;
    const v = Number(p[1] || 0);
    const barH = (v / max) * (height - pad.t - pad.b - 12);
    const y = height - pad.b - barH;
    const g = ctx.createLinearGradient(0, y, 0, height - pad.b);
    g.addColorStop(0, '#22d3ee');
    g.addColorStop(1, '#2563eb');
    ctx.fillStyle = g;
    roundRect(ctx, x, y, barW, barH, 12, true);
    ctx.fillStyle = '#9bb0cf';
    ctx.font = '12px Inter, Segoe UI, Arial';
    ctx.fillText(String(p[0]), x, height - 10);
  });
  ctx.fillStyle = '#9bb0cf';
  ctx.font = '12px Inter, Segoe UI, Arial';
  ctx.fillText(yPrefix + Math.round(max).toLocaleString(), 6, pad.t + 4);
}

function drawMixChart(canvasId, stats){
  const canvas = $(canvasId);
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 340;
  const height = Number(canvas.getAttribute('height') || 220);
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);
  const items = [
    ['Patients', Number(stats.patients || 0)],
    ['Visits', Number(stats.visits || 0)],
    ['Bills', Number(stats.bills || 0)],
    ['Queue', Number(stats.queue || 0)],
    ['Admissions', Number(stats.admissions || 0)],
    ['Pharmacy', Number(stats.pharmacy || 0)]
  ];
  const max = Math.max(1, ...items.map(x => x[1]));
  const cx = width/2, cy = height/2 - 8, radius = Math.min(width, height) * .30;
  ctx.strokeStyle = 'rgba(123,160,214,.18)';
  for (let i=1;i<=4;i++) { ctx.beginPath(); ctx.arc(cx, cy, radius * i/4, 0, Math.PI * 2); ctx.stroke(); }
  items.forEach((it, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 / items.length) * i;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke();
    ctx.fillStyle = '#9bb0cf'; ctx.font = '12px Inter, Segoe UI, Arial';
    ctx.fillText(it[0], cx + Math.cos(angle) * (radius + 18) - 18, cy + Math.sin(angle) * (radius + 18));
  });
  ctx.beginPath();
  items.forEach((it, i) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 / items.length) * i;
    const r = radius * (it[1] / max);
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = 'rgba(34,211,238,.18)';
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = 2;
  ctx.fill(); ctx.stroke();
}

function drawTimelineChart(canvasId, rows){
  const canvas = $(canvasId);
  if (!canvas) return;
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 700;
  const height = Number(canvas.getAttribute('height') || 220);
  canvas.width = width * ratio; canvas.height = height * ratio;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio,0,0,ratio,0,0);
  ctx.clearRect(0,0,width,height);
  const pad = { l:42, r:16, t:18, b:34 };
  const labels = rows.map(x => (x.day || '').slice(5));
  const series = [
    { key:'patients', color:'#22d3ee' },
    { key:'visits', color:'#2563eb' },
    { key:'queueAdded', color:'#22c55e' }
  ];
  const max = Math.max(1, ...rows.flatMap(r => series.map(s => Number(r[s.key] || 0))));
  ctx.strokeStyle = 'rgba(123,160,214,.18)';
  for (let i=0;i<4;i++) {
    const y = pad.t + ((height - pad.t - pad.b) / 3) * i;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(width - pad.r, y); ctx.stroke();
  }
  const plotW = width - pad.l - pad.r;
  const plotH = height - pad.t - pad.b;
  series.forEach((s, idx) => {
    ctx.beginPath();
    rows.forEach((r, i) => {
      const x = pad.l + (plotW * (rows.length === 1 ? .5 : i / Math.max(1, rows.length - 1)));
      const y = pad.t + plotH - ((Number(r[s.key] || 0) / max) * plotH);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = s.color; ctx.lineWidth = 2.5; ctx.stroke();
    rows.forEach((r, i) => {
      const x = pad.l + (plotW * (rows.length === 1 ? .5 : i / Math.max(1, rows.length - 1)));
      const y = pad.t + plotH - ((Number(r[s.key] || 0) / max) * plotH);
      ctx.beginPath(); ctx.fillStyle = s.color; ctx.arc(x, y, 3.2, 0, Math.PI * 2); ctx.fill();
    });
  });
  ctx.fillStyle = '#9bb0cf'; ctx.font = '12px Inter, Segoe UI, Arial';
  labels.forEach((label, i) => {
    const x = pad.l + (plotW * (rows.length === 1 ? .5 : i / Math.max(1, rows.length - 1)));
    ctx.fillText(label || '--', x - 12, height - 10);
  });
}

function renderRealtimeBoard(){
  const queueOpen = (dashboardState.queue || []).filter(x => !['served','completed','cancelled'].includes(String(x.status || '').toLowerCase())).length;
  $('realtimeBoard').innerHTML = `<div class="realtimePulse">`
    + item('Transport', [$('transportText').textContent || '--', 'Last Sync: ' + ($('lastSyncText').textContent || '--')])
    + item('Hospital Scope', [$('hospitalId').value.trim() || '--', 'Open Queue: ' + queueOpen])
    + item('Live Feed Buffer', ['Notifications: ' + ((dashboardState.notifications || []).length || 0), 'Timeline Points: ' + ((dashboardState.timeline || []).length || 0)])
    + `</div>`;
}

function roundRect(ctx, x, y, w, h, r, fill){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  if (fill) ctx.fill(); else ctx.stroke();
}

function renderOverviewCards(o){
  $('cards').innerHTML = [
    metricCard('Patients', o.patients || 0, 'registered', 'kpiInfo'),
    metricCard('Visits', o.visits || 0, 'overall', 'kpiInfo'),
    metricCard('Queue', o.queue || 0, 'live', o.queue > 0 ? 'kpiWarn' : 'kpiInfo'),
    metricCard('Revenue', ngn(o.totalPaid || 0), 'paid', 'kpiGood'),
    metricCard('Outstanding', ngn(o.outstanding || 0), 'pending', Number(o.outstanding || 0) > 0 ? 'kpiWarn' : 'kpiGood'),
    metricCard('Bills', o.bills || 0, 'created', 'kpiInfo'),
    metricCard('Admissions', o.admissions || 0, 'active', 'kpiInfo'),
    metricCard('Low Stock', (o.lowStock || []).length, 'pharmacy', (o.lowStock || []).length ? 'kpiWarn' : 'kpiGood')
  ].join('');
}

function renderPatients(patients = []){
  dashboardState.patients = patients;
  $('patientsList').innerHTML = patients.slice(0, 20).map(x => item(x.fullName || 'Patient', [
    'Patient ID: ' + (x.patientId || '--'),
    'MRN: ' + (x.mrn || '--'),
    'Phone: ' + (x.phone || '--')
  ], `<div class="quickActionGroup"><button class="inlineAction" data-patient-bill="${esc(x.patientId)}" data-patient-name="${esc(x.fullName || '')}" type="button">Direct Bill</button><button class="inlineAction" data-patient-visit="${esc(x.patientId)}" type="button">New Visit</button><button class="inlineAction" data-patient-queue="${esc(x.patientId)}" type="button">Queue</button></div>`)).join('') || emptyState('No patient yet.');
}

function renderBills(bills = []){
  dashboardState.bills = bills;
  $('billsList').innerHTML = bills.slice(0, 20).map(x => item(x.patientName || 'Bill', [
    'Bill ID: ' + (x.billId || '--'),
    'Total: ' + ngn(x.total || 0),
    'Paid: ' + ngn(x.paid || 0),
    'Balance: ' + ngn(x.balance || 0)
  ])).join('') || emptyState('No bill yet.');
}

function renderQueueCard(x){
  const status = String(x.status || 'waiting');
  return item(x.patientName || 'Queue', [
    'Queue ID: ' + (x.queueId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Priority: ' + (x.priority || '--'),
    'Status: ' + status
  ], `<div class="queueActionRow">
      <button class="queueActionBtn" data-queue-action="served" data-queue-id="${esc(x.queueId)}" type="button">Serve</button>
      <button class="queueActionBtn warn" data-queue-action="completed" data-queue-id="${esc(x.queueId)}" type="button">Complete</button>
      <button class="queueActionBtn danger" data-queue-action="cancelled" data-queue-id="${esc(x.queueId)}" type="button">Cancel</button>
    </div>`);
}

function renderSimpleList(targetId, rows, mapper, emptyText){
  $(targetId).innerHTML = rows.slice(0, 20).map(mapper).join('') || emptyState(emptyText);
}

async function loadOverview() {
  const days = (($('timelineDays') && $('timelineDays').value) || '14');
  const [overview, finance, queue, ai, risks, notifications, bills, visits, timeline] = await Promise.all([
    api('/api/portal/overview'),
    api('/api/portal/finance'),
    api('/api/portal/queue'),
    api('/api/ai/clinic_overview'),
    api('/api/ai/risk_analysis'),
    api('/api/notifications?since=' + encodeURIComponent(feedCursor || 0)),
    api('/api/bills'),
    api('/api/visits'),
    api('/api/portal/timeline?days=' + encodeURIComponent(days))
  ]);

  const clinic = overview.clinic || {};
  const o = overview.overview || {};
  dashboardState.overview = o;
  dashboardState.finance = finance.finance || {};
  dashboardState.queue = queue.queue || [];
  dashboardState.visits = visits.visits || [];
  $('clinicTitle').textContent = clinic.clinicName || clinic.hospitalName || 'Clinic Pro NG Enterprise Portal';
  $('spotHospital').textContent = clinic.clinicName || clinic.hospitalName || $('hospitalId').value.trim() || '--';
  renderOverviewCards(o);

  $('queue').innerHTML = (queue.queue || []).slice(0, 12).map(renderQueueCard).join('') || emptyState('No live queue right now.');

  $('alerts').innerHTML = (ai.alerts || []).map(x => item(x.type || 'Alert', [x.message || '', 'Severity: ' + (x.severity || '--')])).join('') || emptyState('No AI alerts right now.');
  $('doctors').innerHTML = (o.doctorWorkload || []).map(x => item(x.doctor || 'Doctor', ['Open load: ' + (x.count || 0)])).join('') || emptyState('No doctor workload yet.');

  const f = finance.finance || {};
  const risk = risks.risks || {};
  $('finance').innerHTML = [
    item('Total Bill', [ngn(f.totalBill || 0)]),
    item('Total Paid', [ngn(f.totalPaid || 0)]),
    item('Outstanding', [ngn(f.outstanding || 0)]),
    item('Queue Pressure', ['Score: ' + ((risk.queue_pressure || {}).score || 0)]),
    item('Doctor Workload Risk', ['Score: ' + ((risk.doctor_workload || {}).score || 0)]),
    item('Pharmacy Stock Risk', ['Score: ' + ((risk.pharmacy_stock_warning || {}).score || 0)])
  ].join('');

  const incoming = notifications.notifications || [];
  if (incoming.length) feedCursor = Math.max(feedCursor, ...incoming.map(n => Number(n.createdAt || 0)));
  renderActivity(incoming);
  renderBills(bills.bills || []);
  dashboardState.timeline = timeline.timeline || [];
  drawBarChart('revenueChart', groupByDay(bills.bills || [], 'createdAt', 'paid'), 'NGN ');
  drawMixChart('mixChart', o);
  drawTimelineChart('operationsChart', dashboardState.timeline || []);
  renderRealtimeBoard();
}

async function refreshLists() {
  const [patients, bills, visits, admissions, appointments, dispenses, labRequests, prescriptions, nurseDesk, staff, doctorQueue] = await Promise.all([
    api('/api/patients'),
    api('/api/bills'),
    api('/api/visits'),
    api('/api/admissions'),
    api('/api/appointments'),
    api('/api/pharmacy/dispenses'),
    api('/api/lab/requests'),
    api('/api/prescriptions'),
    api('/api/nurse_desk'),
    api('/api/staff/list'),
    api('/api/doctor_queue')
  ]);

  renderPatients(patients.patients || []);
  renderBills(bills.bills || []);
  renderSimpleList('visitsList', visits.visits || [], x => item(x.patientName || 'Visit', [
    'Visit ID: ' + (x.visitId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Reason: ' + (x.reason || '--'),
    'Status: ' + (x.status || '--')
  ]), 'No visit yet.');
  renderSimpleList('admissionsList', admissions.admissions || [], x => item(x.patientName || 'Admission', [
    'Admission ID: ' + (x.admissionId || '--'),
    'Ward: ' + (x.ward || '--'),
    'Bed: ' + (x.bed || '--'),
    'Status: ' + (x.status || '--')
  ]), 'No admission yet.');
  renderSimpleList('appointmentsList', appointments.appointments || [], x => item(x.patientName || 'Appointment', [
    'Appointment ID: ' + (x.appointmentId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Date: ' + (x.appointmentDate || '--'),
    'Status: ' + (x.status || '--')
  ]), 'No appointment yet.');
  renderSimpleList('pharmacyList', dispenses.dispenses || [], x => item(x.patientName || 'Dispense', [
    'Drug: ' + (x.drugName || '--'),
    'Qty: ' + (x.quantity || 0),
    'Total: ' + ngn(x.total || 0),
    'Status: ' + (x.status || '--')
  ]), 'No pharmacy dispense yet.');
  renderSimpleList('labList', labRequests.labRequests || [], x => item(x.patientName || 'Lab Request', [
    'Test: ' + (x.testName || '--'),
    'Requested By: ' + (x.requestedBy || '--'),
    'Status: ' + (x.status || '--')
  ]), 'No lab request yet.');
  renderSimpleList('prescriptionsList', prescriptions.prescriptions || [], x => item(x.patientName || 'Prescription', [
    'Drug: ' + (x.drugName || '--'),
    'Dosage: ' + (x.dosage || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Status: ' + (x.status || '--')
  ]), 'No prescription yet.');
  renderSimpleList('nurseList', nurseDesk.nurseDesk || [], x => item(x.patientName || 'Nurse Desk', [
    'Temp: ' + (x.temperature || '--'),
    'BP: ' + (x.bp || '--'),
    'Pulse: ' + (x.pulse || '--'),
    'SpO2: ' + (x.spo2 || '--')
  ]), 'No nurse desk entry yet.');
  renderSimpleList('staffList', staff.staff || [], x => item(x.fullName || x.email || 'Staff', [
    'Email: ' + (x.email || '--'),
    'Role: ' + (x.role || '--'),
    'Phone: ' + (x.phone || '--')
  ]), 'No staff yet.');
  renderSimpleList('queueList', doctorQueue.queue || [], renderQueueCard, 'No doctor queue yet.');
}

async function refreshAll(showToast = false){
  try {
    if (!connReady()) {
      setStatus('error', 'Missing Connection');
      $('sub').textContent = 'Fill Base URL and Hospital ID first.';
      $('realtimeText').textContent = 'Idle';
      return;
    }
    await Promise.all([loadOverview(), refreshLists()]);
    $('sub').textContent = 'Connected to live clinic workflow. Direct billing and realtime updates active.';
    $('lastSyncText').textContent = nowText();
    $('spotRealtime').textContent = eventSource ? 'SSE live channel' : 'Polling active';
    if (showToast) toast('Dashboard refreshed');
  } catch (e) {
    setStatus('error', e.message || 'Connection failed');
    $('realtimeText').textContent = 'Degraded';
    $('spotRealtime').textContent = 'Retrying via polling';
    if (showToast) toast(e.message || 'Connection failed', true);
    console.error(e);
  }
}

function openSse(){
  try { if (eventSource) eventSource.close(); } catch {}
  eventSource = null;
  if (!connReady()) return;
  const base = $('base').value.trim().replace(/\/$/, '');
  const hospitalId = encodeURIComponent($('hospitalId').value.trim());
  const url = `${base}/api/events/stream?hospitalId=${hospitalId}`;
  $('transportText').textContent = 'SSE Realtime';
  const es = new EventSource(url);
  eventSource = es;
  es.onopen = () => {
    setStatus('connected', 'Realtime Connected');
    $('realtimeText').textContent = 'SSE Live';
    $('spotRealtime').textContent = 'Realtime SSE connected';
  };
  es.onerror = () => {
    setStatus('error', 'Realtime reconnecting');
    $('realtimeText').textContent = 'Reconnect';
    $('spotRealtime').textContent = 'SSE reconnecting';
  };
  ['hello','ping','notification','patient_registered','bill_created','visit_created','admission_created','appointment_created','pharmacy_dispensed','lab_request_created','prescription_created','nurse_desk_created','doctor_queue_created','doctor_queue_updated','staff_created'].forEach(name => {
    es.addEventListener(name, (evt) => {
      if (name !== 'ping' && name !== 'hello') {
        try { const data = evt?.data ? JSON.parse(evt.data) : null; if (data?.title || data?.message) toast((data.title || data.type || 'Live update') + (data.message ? ': ' + data.message : '')); } catch {}
      }
      debounceRefresh(500);
    });
  });
  es.onmessage = () => debounceRefresh(500);
}

function startPolling(){
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refreshAll(false), 15000);
}

function bindForm(formId, path, successText, after){
  const form = $(formId);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = formDataObject(form);
      const result = await api(path, 'POST', body);
      form.reset();
      toast(successText);
      closeModal();
      await refreshAll(false);
      if (typeof after === 'function') after(result, body);
    } catch (err) {
      toast(err.message || 'Save failed', true);
    }
  });
}

function openPatientModal(){
  openModal('Register New Patient', 'Patient registration modal', 'patientModalTemplate', root => {
    bindForm('modalPatientForm', '/api/patient/register', 'Patient registered');
  });
}

function openBillModal(patientId = '', patientName = ''){
  openModal('Direct Billing Workflow', 'Billing modal', 'billModalTemplate', root => {
    const form = root.querySelector('#modalBillForm');
    if (patientId) form.patientId.value = patientId;
    if (patientName) form.patientName.value = patientName;
    const finderBtn = root.querySelector('#billFinderBtn');
    const finderInput = root.querySelector('#billFinderInput');
    finderBtn?.addEventListener('click', () => runBillFinder(root));
    finderInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runBillFinder(root); } });
    root.addEventListener('click', (e) => {
      const pick = e.target.closest('[data-bill-select]');
      if (!pick) return;
      form.patientId.value = pick.getAttribute('data-bill-select') || '';
      form.patientName.value = pick.getAttribute('data-bill-patient-name') || '';
      const results = root.querySelector('#billFinderResults');
      if (results) results.innerHTML = emptyState('Patient selected for direct billing.');
    });
    bindForm('modalBillForm', '/api/bill/create', 'Bill created');
  });
}

function quickFillVisit(patientId){ switchTab('visits'); $('visitForm').patientId.value = patientId || ''; }
function quickFillQueue(patientId){ switchTab('queue'); $('queueForm').patientId.value = patientId || ''; }

async function handleSearch(e){
  e.preventDefault();
  const q = new FormData(e.target).get('q');
  if (!q) return;
  try {
    const res = await api('/api/search/patient?q=' + encodeURIComponent(q));
    const rows = res.patients || res.results || [];
    $('searchResults').innerHTML = rows.length ? rows.map(x => `
      <div class="searchCard">
        <strong>${esc(x.fullName || x.patientName || 'Patient')}</strong>
        <div class="muted">Patient ID: ${esc(x.patientId || '--')}</div>
        <div class="muted">Phone: ${esc(x.phone || '--')} • MRN: ${esc(x.mrn || '--')}</div>
        <div class="quickActionGroup">
          <button class="inlineAction" data-patient-bill="${esc(x.patientId)}" data-patient-name="${esc(x.fullName || '')}" type="button">Direct Bill</button>
          <button class="inlineAction" data-patient-visit="${esc(x.patientId)}" type="button">New Visit</button>
          <button class="inlineAction" data-ai-patient="${esc(x.patientId)}" type="button">AI Summary</button>
        </div>
      </div>`).join('') : emptyState('No patient found.');
  } catch (err) {
    toast(err.message || 'Search failed', true);
  }
}

async function loadPatientAi(patientId){
  try {
    const res = await api('/api/ai/patient_summary?patientId=' + encodeURIComponent(patientId));
    renderAiSummary(res);
  } catch (err) {
    toast(err.message || 'AI summary failed', true);
  }
}

async function updateQueueStatus(queueId, status){
  if (!queueId) return;
  try {
    await api('/api/doctor_queue/update', 'POST', { queueId, status });
    toast('Queue moved to ' + status);
    await refreshAll(false);
  } catch (err) {
    toast(err.message || 'Queue update failed', true);
  }
}

async function runBillFinder(root){
  const input = root.querySelector('#billFinderInput');
  const box = root.querySelector('#billFinderResults');
  const q = String(input?.value || '').trim();
  if (!q) return box.innerHTML = emptyState('Type patient name, phone, MRN or ID.');
  try {
    const res = await api('/api/search/patient?q=' + encodeURIComponent(q));
    const rows = res.patients || [];
    box.innerHTML = rows.length ? rows.slice(0, 8).map(x => `<div class="searchCard"><strong>${esc(x.fullName || 'Patient')}</strong><div class="muted">${esc(x.patientId || '--')} • ${esc(x.phone || '--')}</div><div class="quickActionGroup"><button type="button" class="inlineAction" data-bill-select="${esc(x.patientId)}" data-bill-patient-name="${esc(x.fullName || '')}">Use For Billing</button></div></div>`).join('') : emptyState('No patient found for billing workflow.');
  } catch (err) {
    box.innerHTML = emptyState(err.message || 'Search failed.');
  }
}

function saveConnection(){
  storage.base = $('base').value.trim();
  storage.hospitalId = $('hospitalId').value.trim();
  setStatus('connected', 'Connecting...');
  $('spotHospital').textContent = $('hospitalId').value.trim() || '--';
  refreshAll(true);
  openSse();
}

function restoreConnection(){
  $('base').value = storage.base;
  $('hospitalId').value = storage.hospitalId;
  $('spotHospital').textContent = storage.hospitalId || '--';
}

function bindGlobalClicks(){
  document.querySelectorAll('.navBtn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  document.addEventListener('click', (e) => {
    const billBtn = e.target.closest('[data-patient-bill]');
    if (billBtn) return openBillModal(billBtn.getAttribute('data-patient-bill'), billBtn.getAttribute('data-patient-name') || '');
    const visitBtn = e.target.closest('[data-patient-visit]');
    if (visitBtn) return quickFillVisit(visitBtn.getAttribute('data-patient-visit'));
    const queueBtn = e.target.closest('[data-patient-queue]');
    if (queueBtn) return quickFillQueue(queueBtn.getAttribute('data-patient-queue'));
    const aiBtn = e.target.closest('[data-ai-patient]');
    if (aiBtn) return loadPatientAi(aiBtn.getAttribute('data-ai-patient'));
    const qBtn = e.target.closest('[data-queue-action]');
    if (qBtn) return updateQueueStatus(qBtn.getAttribute('data-queue-id'), qBtn.getAttribute('data-queue-action'));
    if (e.target.closest('.openPatientModal')) return openPatientModal();
    if (e.target.closest('.openBillModal')) return openBillModal();
  });
}

window.addEventListener('resize', () => {
  drawBarChart('revenueChart', groupByDay(dashboardState.bills || [], 'createdAt', 'paid'), 'NGN ');
  drawMixChart('mixChart', dashboardState.overview || {});
  drawTimelineChart('operationsChart', dashboardState.timeline || []);
});

restoreConnection();
updateClock();
setInterval(updateClock, 1000);
bindGlobalClicks();
$('saveBtn').addEventListener('click', saveConnection);
$('refreshBtn').addEventListener('click', () => refreshAll(true));
$('manualFeedBtn').addEventListener('click', () => refreshAll(true));
$('quickPatientBtn').addEventListener('click', openPatientModal);
$('quickBillBtn').addEventListener('click', () => openBillModal());
$('quickVisitBtn').addEventListener('click', () => switchTab('visits'));
$('quickQueueBtn').addEventListener('click', () => switchTab('queue'));
$('modalCloseBtn').addEventListener('click', closeModal);
$('modalWrap').addEventListener('click', (e) => { if (e.target === $('modalWrap')) closeModal(); });
$('searchForm').addEventListener('submit', handleSearch);
$('timelineDays')?.addEventListener('change', () => refreshAll(false));

bindForm('patientForm', '/api/patient/register', 'Patient registered');
bindForm('visitForm', '/api/visit/create', 'Visit saved');
bindForm('billForm', '/api/bill/create', 'Bill saved');
bindForm('admissionForm', '/api/admission/create', 'Admission saved');
bindForm('appointmentForm', '/api/appointment/create', 'Appointment saved');
bindForm('pharmacyForm', '/api/pharmacy/dispense', 'Dispense saved');
bindForm('labForm', '/api/lab/request', 'Lab request saved');
bindForm('prescriptionForm', '/api/prescription/create', 'Prescription saved');
bindForm('nurseForm', '/api/nurse_desk/create', 'Nurse desk saved');
bindForm('staffForm', '/api/staff/create', 'Staff saved');
bindForm('queueForm', '/api/doctor_queue/create', 'Queue saved');

startPolling();
if (connReady()) {
  refreshAll(false);
  openSse();
} else {
  setStatus('error', 'Missing Connection');
  $('sub').textContent = 'Fill Base URL and Hospital ID first.';
}
