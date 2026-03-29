const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  baseUrl: localStorage.getItem('clinicPortalBaseUrl') || location.origin,
  hospitalId: localStorage.getItem('clinicPortalHospitalId') || '',
  transport: 'Polling',
  lastSync: 0,
  sse: null,
  poller: null,
  refreshTimer: null,
  timelineDays: Number(localStorage.getItem('clinicPortalTimelineDays') || 14),
  currentTab: 'overview',
  live: null,
  version: 0,
  data: {
    overview: null,
    finance: null,
    queue: [],
    timeline: [],
    patients: [],
    notifications: [],
    aiOverview: null,
    risk: null,
    commandCenter: null,
    doctorWidgets: null,
    workspace: null,
  }
};

window.addEventListener('DOMContentLoaded', init);

function init() {
  $('#baseUrl').value = state.baseUrl;
  $('#hospitalId').value = state.hospitalId;
  $('#timelineDays').value = String(state.timelineDays);
  bindUI();
  tickClock();
  setInterval(tickClock, 1000);
  if (state.hospitalId) connect();
  else renderDisconnected();
}

function bindUI() {
  $('#connectBtn').addEventListener('click', connect);
  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#manualFeedBtn').addEventListener('click', loadNotificationsAndRender);
  $('#timelineDays').addEventListener('change', async (e) => {
    state.timelineDays = Number(e.target.value || 14);
    localStorage.setItem('clinicPortalTimelineDays', String(state.timelineDays));
    await loadTimeline();
    renderAnalytics();
  });
  $('#searchBtn').addEventListener('click', runSearch);
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch();
    }
  });

  $$('.navBtn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
  $('#quickPatientBtn').addEventListener('click', openPatientWizard);
  $('#quickBillBtn').addEventListener('click', () => openBillModal());
  $('#quickVisitBtn').addEventListener('click', () => switchTab('workflow'));
  $('#quickQueueBtn').addEventListener('click', () => switchTab('operations'));
  $('#railVisitBtn').addEventListener('click', () => switchTab('workflow'));
  $('#railSearchBtn').addEventListener('click', () => switchTab('search'));
  $('#fabVisitBtn').addEventListener('click', () => { toggleFab(false); switchTab('workflow'); });
  $('#fabSearchBtn').addEventListener('click', () => { toggleFab(false); switchTab('search'); });
  $('#fabMain').addEventListener('click', () => toggleFab());
  document.addEventListener('click', (e) => {
    if (!$('#fabDock').contains(e.target)) toggleFab(false);
  });
  $$('.openPatientModal').forEach(btn => btn.addEventListener('click', openPatientWizard));
  $$('.openBillModal').forEach(btn => btn.addEventListener('click', () => openBillModal()));

  bindForm('#patientForm', '/api/patient/register', 'Patient registered', async (res) => {
    closeModal();
    showToast('Patient Saved', res?.patient?.fullName || res?.patient?.patientName || 'Patient registration completed');
    await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
  });
  bindForm('#billForm', '/api/bill/create', 'Bill created', async (res) => {
    closeModal();
    showToast('Bill Created', `${res?.bill?.serviceName || 'Service'} billing saved`);
    await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
  });
  bindForm('#visitForm', '/api/visit/create', 'Visit saved', async () => { showToast('Visit Saved', 'Clinical visit recorded'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#appointmentForm', '/api/appointment/create', 'Appointment booked', async () => { showToast('Appointment Booked', 'Appointment created'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#queueForm', '/api/doctor_queue/create', 'Queue entry saved', async () => { showToast('Queue Updated', 'Doctor queue updated'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#labForm', '/api/lab/request', 'Lab request saved', async () => { showToast('Lab Request', 'Lab request created'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#prescriptionForm', '/api/prescription/create', 'Prescription saved', async () => { showToast('Prescription Saved', 'Medication order created'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#nurseForm', '/api/nurse_desk/create', 'Nurse note saved', async () => { showToast('Nurse Desk', 'Nurse entry saved'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#staffForm', '/api/staff/create', 'Staff created', async () => { showToast('Staff Created', 'Team member saved'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
}

function bindForm(selector, path, successMsg, onDone) {
  const form = $(selector);
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = formToObject(form);
      const res = await api(path, { method: 'POST', body });
      form.reset();
      showToast(successMsg, res?.message || 'Done');
      if (onDone) await onDone(res);
    } catch (err) {
      showToast('Request Failed', err.message || 'Unable to complete request');
    }
  });
}

function formToObject(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    const value = typeof v === 'string' ? v.trim() : v;
    if (value !== '') out[k] = value;
  }
  return out;
}

function toggleFab(force) {
  const dock = $('#fabDock');
  const open = typeof force === 'boolean' ? force : !dock.classList.contains('open');
  dock.classList.toggle('open', open);
}

function switchTab(tab) {
  state.currentTab = tab;
  $$('.navBtn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
  $$('.tabPane').forEach(p => p.classList.add('hidden'));
  $(`#tab-${tab}`)?.classList.remove('hidden');
  $('#modeText').textContent = {
    overview: 'Analytics',
    operations: 'Operations',
    analytics: 'Intelligence',
    patients: 'Patients',
    workflow: 'Workflow',
    search: 'Search'
  }[tab] || 'Analytics';
}

function connect() {
  state.baseUrl = ($('#baseUrl').value || '').trim().replace(/\/$/, '');
  state.hospitalId = ($('#hospitalId').value || '').trim();
  if (!state.baseUrl || !state.hospitalId) {
    showToast('Missing Connection', 'Fill Base URL and Hospital ID first');
    renderDisconnected();
    return;
  }
  localStorage.setItem('clinicPortalBaseUrl', state.baseUrl);
  localStorage.setItem('clinicPortalHospitalId', state.hospitalId);
  $('#spotHospital').textContent = state.hospitalId;
  $('#clinicTitle').textContent = `Clinic Pro NG - ${state.hospitalId}`;
  $('#heroSub').textContent = 'Enterprise analytics suite is connected. Revenue, operations, queue and AI intelligence now refresh live.';
  state.version = 0;
  refreshAll();
  startRealtime();
}

function renderDisconnected() {
  setLiveState('Disconnected', 'error');
  $('#spotHospital').textContent = '--';
  $('#transportText').textContent = state.transport;
  $('#realtimeText').textContent = 'Idle';
  $('#sideSummary').innerHTML = `<div class="miniPanel"><div class="itemTitle">Status</div><div>Connect Base URL and Hospital ID to start live command mode.</div></div>`;
  $('#kpiGrid').innerHTML = Array.from({ length: 8 }).map((_, i) => `
    <div class="kpiCard">
      <div class="kpiLabel">Metric ${i + 1}</div>
      <div class="kpiValue">--</div>
      <div class="kpiSub">Connect portal to load live analytics</div>
    </div>`).join('');
  ['revenueChart', 'mixChart', 'operationsChart'].forEach(id => renderEmptyChart(id, 'Connect the portal to load analytics'));
  ['activityFeed','alerts','queue','finance','doctors','realtimeBoard','doctorBars','financeBreakdown','workflowBenchmarks','analyticsSignals','boardSummary','patientsList','searchResults','patientAiSummary','queueBoard'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="emptyState">Connect Base URL and Hospital ID to start live dashboard.</div>`;
  });
}

async function refreshAll() {
  if (!state.baseUrl || !state.hospitalId) return renderDisconnected();
  try {
    await Promise.all([
      loadLive(),
      loadOverview(),
      loadFinance(),
      loadQueue(),
      loadTimeline(),
      loadPatients(),
      loadNotifications(),
      loadAiOverview(),
      loadRisk(),
      loadCommandCenter(),
      loadDoctorWidgets(),
      loadWorkspace(),
    ]);
    state.lastSync = Date.now();
    $('#lastSyncText').textContent = fmtTime(state.lastSync);
    setLiveState(state.transport === 'SSE' ? 'Realtime Connected' : 'Connected', 'connected');
    if (state.data.live?.clinic?.clinicName) $('#clinicTitle').textContent = state.data.live.clinic.clinicName;
    if (state.data.live?.clinic?.clinicCode) $('#spotHospital').textContent = state.data.live.clinic.clinicCode;
    $('#heroSub').textContent = `Live hospital control for ${state.data.live?.clinic?.clinicName || state.hospitalId} with instant queue, revenue and patient analytics. Delta sync version ${state.version || 0}.`;
    renderAll();
  } catch (err) {
    setLiveState('Connection Error', 'error');
    showToast('Refresh Failed', err.message || 'Unable to load portal data');
  }
}

async function loadLive() { state.data.live = await api('/api/portal/live'); state.live = state.data.live; state.version = num(state.data.live?.version || state.version); return state.data.live; }
async function loadOverview() { state.data.overview = await api('/api/portal/overview'); }
async function loadFinance() { state.data.finance = await api('/api/portal/finance'); }
async function loadQueue() { const r = await api('/api/portal/queue'); state.data.queue = r.queue || []; return r; }
async function loadTimeline() { const r = await api(`/api/portal/timeline?days=${state.timelineDays}`); state.data.timeline = r.timeline || []; return r; }
async function loadPatients() { const r = await api('/api/portal/patients'); state.data.patients = r.patients || []; return r; }
async function loadNotifications() { const r = await api('/api/notifications?limit=20'); state.data.notifications = r.notifications || []; return r; }
async function loadAiOverview() { state.data.aiOverview = await api('/api/ai/clinic_overview'); }
async function loadRisk() { state.data.risk = await api('/api/ai/risk_analysis'); }

async function loadCommandCenter() {
  const r = await api(`/api/portal/command-center?days=${state.timelineDays}`);
  state.data.commandCenter = r.commandCenter || { cards: [], counts: {}, recentPatients: [], recentBills: [], queue: [], timeline: [], recentChanges: [] };
  recomputeCommandCardsFromOverview();
  return r;
}

async function loadDoctorWidgets() { const r = await api('/api/portal/doctor-widgets'); state.data.doctorWidgets = r.widgets || null; return r; }
async function loadWorkspace() { const r = await api('/api/portal/workspace'); state.data.workspace = r || null; return r; }

function applyLiteBundle(bundle = {}) {
  if (bundle.live) { state.data.live = bundle.live; state.live = bundle.live; }
  if (bundle.overview) state.data.overview = bundle.overview;
  if (bundle.finance) state.data.finance = { finance: bundle.finance };
  if (bundle.queue) state.data.queue = bundle.queue.queue || [];
  if (bundle.timeline) state.data.timeline = bundle.timeline.timeline || [];
  if (bundle.patients) state.data.patients = bundle.patients.patients || [];
  if (bundle.notifications) state.data.notifications = bundle.notifications.notifications || [];
  if (bundle.aiOverview) state.data.aiOverview = bundle.aiOverview;
  if (bundle.risk) state.data.risk = bundle.risk;
  if (bundle.commandCenter) state.data.commandCenter = bundle.commandCenter;
  if (bundle.doctorWidgets) state.data.doctorWidgets = bundle.doctorWidgets;
  if (bundle.workspace) state.data.workspace = bundle.workspace;
  state.version = Math.max(state.version || 0, num(bundle.version || bundle.live?.version || 0));
}

async function loadLiteBundle(include = []) {
  const key = (Array.isArray(include) ? include : []).filter(Boolean).join(',');
  const q = new URLSearchParams();
  if (key) q.set('include', key);
  q.set('days', String(state.timelineDays || 14));
  const bundle = await api(`/api/portal/refresh-lite?${q.toString()}`);
  applyLiteBundle(bundle);
  return bundle;
}
async function loadNotificationsAndRender() { await loadNotifications(); renderFeed(); renderAnalyticsPanels(); }

async function runSearch() {
  const q = ($('#searchInput').value || '').trim();
  if (!q) return showToast('Search Needed', 'Enter patient ID, name, phone, MRN or email');
  try {
    const res = await api(`/api/search/patient?q=${encodeURIComponent(q)}`);
    const items = res.patients || [];
    const host = $('#searchResults');
    if (!items.length) {
      host.innerHTML = `<div class="emptyState">No patient matched your search.</div>`;
      $('#patientAiSummary').innerHTML = `<div class="emptyState">Select a patient to see AI summary.</div>`;
      return;
    }
    host.innerHTML = items.map(p => `
      <div class="searchCard">
        <div class="itemTitle">${escapeHtml(p.fullName || p.patientName || 'Unnamed Patient')}</div>
        <div class="row"><span class="badge">${escapeHtml(p.patientId || '--')}</span><span class="badge">${escapeHtml(p.gender || '--')}</span></div>
        <div class="itemMeta"><span>${escapeHtml(p.phone || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span></div>
        <div class="queueActions">
          <button class="pillBtn" data-ai="${escapeHtml(p.patientId || '')}">AI Summary</button>
          <button class="pillBtn" data-view="${escapeHtml(p.patientId || '')}">Profile</button>
          <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
        </div>
      </div>
    `).join('');
    $$('[data-ai]', host).forEach(btn => btn.addEventListener('click', () => loadPatientAi(btn.dataset.ai)));
    $$('[data-view]', host).forEach(btn => btn.addEventListener('click', () => openPatientDrawer(btn.dataset.view)));
    $$('[data-bill]', host).forEach(btn => btn.addEventListener('click', () => openBillModal(btn.dataset.bill, btn.dataset.name)));
    loadPatientAi(items[0].patientId);
  } catch (err) {
    showToast('Search Failed', err.message || 'Unable to search patient');
  }
}

async function loadPatientAi(patientId) {
  try {
    const res = await api(`/api/ai/patient_summary?patientId=${encodeURIComponent(patientId)}`);
    const host = $('#patientAiSummary');
    const cards = Array.isArray(res.cards) ? res.cards : [];
    const watch = Array.isArray(res.watchlist) ? res.watchlist : [];
    host.innerHTML = `
      <div class="miniPanel"><div class="itemTitle">${escapeHtml(res.patient_name || res.patientName || patientId)}</div><div class="itemMeta"><span>${escapeHtml(res.phone || '--')}</span><span>${escapeHtml(res.gender || '--')} ${escapeHtml(String(res.age || ''))}</span></div></div>
      ${cards.map(c => `<div class="alertItem"><div class="itemTitle">${escapeHtml(c.title || c.label || 'AI Card')}</div><div>${escapeHtml(c.message || c.value || '--')}</div></div>`).join('') || ''}
      ${watch.map(w => `<div class="alertItem"><div class="itemTitle">${escapeHtml(w.patient_name || w.patientName || '')}</div><div>Risk ${escapeHtml(String(w.risk_score || '--'))} • ${escapeHtml(w.next_action || '--')}</div></div>`).join('') || ''}
    `;
  } catch (err) {
    $('#patientAiSummary').innerHTML = `<div class="emptyState">Unable to load AI patient summary.</div>`;
  }
}

function renderAll() {
  renderKpis();
  renderAnalytics();
  renderFeed();
  renderAlerts();
  renderQueue();
  renderQueueBoard();
  renderFinance();
  renderDoctors();
  renderRealtimeBoard();
  $('#realtimeText').textContent = `${state.transport}${state.version ? ' • v' + state.version : ''}`;
  renderDoctorBars();
  renderAnalyticsPanels();
  renderPatients();
  renderWorkspace();
  renderCommandCenter();
  renderLiveTicker();
  renderSideSummary();
}

function renderKpis() {
  const o = state.data.overview?.overview || {};
  const f = state.data.finance?.finance || {};
  const kpis = [
    ['Patients', num(o.patients), 'Registered patient base'],
    ['Active Visits', num(o.activeVisits || o.visits || 0), 'Clinical load in motion'],
    ['Queue', num(o.queue), 'Live doctor waiting queue'],
    ['Paid Revenue', money(f.totalPaid), 'Collected billing revenue'],
    ['Outstanding', money(f.outstanding), 'Exposure awaiting payment'],
    ['Bills', num(f.billCount || o.bills), 'Billing records created'],
    ['Admissions', num(o.admissions), 'Current admission operations'],
    ['Pharmacy Sales', money(f.pharmacySales || o.pharmacy), 'Pharmacy revenue engine'],
  ];
  $('#kpiGrid').innerHTML = kpis.map(([label, value, sub], index) => `
    <div class="kpiCard" data-kpi-index="${index}">
      <div class="kpiLabel">${label}</div>
      <div class="kpiValue">${value}</div>
      <div class="kpiSub">${sub}</div>
    </div>
  `).join('');
}

function renderAnalytics() {
  const timeline = state.data.timeline || [];
  if (!timeline.length) {
    renderEmptyChart('revenueChart', 'No revenue data yet. Create bills to start trend intelligence.');
    renderEmptyChart('operationsChart', 'No operations data yet.');
    renderEmptyChart('mixChart', 'Waiting for activity mix.');
    return;
  }
  renderAreaChart('revenueChart', timeline.map(x => ({ label: shortDay(x.day), value: num(x.revenuePaid), alt: num(x.revenueTotal) })), 'NGN');
  renderMultiBarChart('operationsChart', timeline.map(x => ({ label: shortDay(x.day), a: num(x.patients), b: num(x.visits), c: num(x.queueAdded) })));
  const totals = timeline.reduce((acc, x) => {
    acc.patients += num(x.patients); acc.visits += num(x.visits); acc.queue += num(x.queueAdded); acc.bills += num(x.bills); return acc;
  }, { patients: 0, visits: 0, queue: 0, bills: 0 });
  renderDonutChart('mixChart', [
    { label: 'Patients', value: totals.patients },
    { label: 'Visits', value: totals.visits },
    { label: 'Queue', value: totals.queue },
    { label: 'Bills', value: totals.bills },
  ]);
}

function renderFeed() {
  const items = state.data.notifications || [];
  $('#activityFeed').innerHTML = items.length ? items.map(n => `
    <div class="feedItem">
      <div class="row alignCenter" style="justify-content:space-between">
        <div class="itemTitle">${escapeHtml(n.title || n.type || 'Activity')}</div>
        <span class="feedType">${escapeHtml(n.type || 'event')}</span>
      </div>
      <div>${escapeHtml(n.message || n.body || '--')}</div>
      <div class="itemMeta"><span>${fmtDateTime(n.createdAt)}</span><span>${escapeHtml(n.actor || n.by || 'system')}</span></div>
    </div>
  `).join('') : `<div class="emptyState">No recent activity yet.</div>`;
}

function renderAlerts() {
  const alerts = state.data.aiOverview?.alerts || [];
  const risk = state.data.risk?.risks || {};
  const cards = [];
  alerts.forEach(a => cards.push(`<div class="alertItem"><div class="itemTitle">${escapeHtml(a.type || 'Alert')} • ${escapeHtml(a.severity || 'info')}</div><div>${escapeHtml(a.message || '--')}</div></div>`));
  if (risk.unpaid_bill_detection) cards.push(metricRow('Unpaid bill risk', `${num(risk.unpaid_bill_detection.score)} / 100`, risk.unpaid_bill_detection.outstanding ? `Outstanding ${money(risk.unpaid_bill_detection.outstanding)}` : 'No outstanding pressure'));
  if (risk.queue_pressure) cards.push(metricRow('Queue pressure', `${num(risk.queue_pressure.score)} / 100`, `${num(risk.queue_pressure.openQueue)} open queue items`));
  if (risk.pharmacy_stock_warning) cards.push(metricRow('Pharmacy stock warning', `${num(risk.pharmacy_stock_warning.score)} / 100`, `${(risk.pharmacy_stock_warning.items || []).length} low stock item(s)`));
  $('#alerts').innerHTML = cards.join('') || `<div class="emptyState">No AI alerts right now.</div>`;
}

function renderQueue() {
  const queue = state.data.queue || [];
  $('#queue').innerHTML = queue.length ? queue.map(q => queueCard(q)).join('') : `<div class="emptyState">Doctor queue is clear.</div>`;
  bindQueueActions($('#queue'));
}

function renderQueueBoard() {
  const queue = state.data.queue || [];
  const groups = {
    waiting: queue.filter(q => normalizeStatus(q.status) === 'waiting'),
    served: queue.filter(q => normalizeStatus(q.status) === 'served'),
    completed: queue.filter(q => ['completed', 'cancelled'].includes(normalizeStatus(q.status))),
  };
  $('#queueBoard').innerHTML = ['waiting', 'served', 'completed'].map(key => `
    <div class="queueColumn ${key}">
      <h4>${key === 'waiting' ? 'Waiting' : key === 'served' ? 'Serving / Served' : 'Completed / Closed'} (${groups[key].length})</h4>
      <div class="stack10">${groups[key].length ? groups[key].slice(0, 8).map(q => queueCard(q, true)).join('') : `<div class="emptyState">No ${key} items.</div>`}</div>
    </div>
  `).join('');
  bindQueueActions($('#queueBoard'));
}

function queueCard(q, compact = false) {
  return `
    <div class="queueCard">
      <div class="row alignCenter" style="justify-content:space-between">
        <div class="itemTitle">${escapeHtml(q.patientName || q.patientId || 'Patient')}</div>
        <span class="badge ${escapeHtml(normalizeStatus(q.status))}">${escapeHtml(q.status || 'waiting')}</span>
      </div>
      <div>${escapeHtml(q.doctorName || 'Unassigned doctor')} • Priority ${escapeHtml(q.priority || 'normal')}</div>
      <div class="itemMeta"><span>${escapeHtml(q.patientId || '--')}</span><span>${fmtDateTime(q.createdAt)}</span></div>
      <div class="queueActions">
        <button class="pillBtn" data-qid="${escapeHtml(q.queueId || q.id || '')}" data-status="served">Serve</button>
        <button class="pillBtn warn" data-qid="${escapeHtml(q.queueId || q.id || '')}" data-status="completed">Complete</button>
        <button class="pillBtn danger" data-qid="${escapeHtml(q.queueId || q.id || '')}" data-status="cancelled">Cancel</button>
        ${compact ? '' : `<button class="pillBtn" data-bill="${escapeHtml(q.patientId || '')}" data-name="${escapeHtml(q.patientName || '')}">Bill</button>`}
      </div>
    </div>`;
}

function bindQueueActions(host) {
  if (!host) return;
  $$('[data-qid]', host).forEach(btn => btn.addEventListener('click', async () => updateQueueStatus(btn.dataset.qid, btn.dataset.status)));
  $$('[data-bill]', host).forEach(btn => btn.addEventListener('click', () => openBillModal(btn.dataset.bill, btn.dataset.name)));
}

async function updateQueueStatus(queueId, status) {
  try {
    await api('/api/doctor_queue/update', { method: 'POST', body: { queueId, status } });
    showToast('Queue Updated', `Queue item moved to ${status}`);
    await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
  } catch (err) {
    showToast('Queue Update Failed', err.message || 'Unable to update queue');
  }
}

function renderFinance() {
  const f = state.data.finance?.finance || {};
  const paid = num(f.totalPaid);
  const outstanding = num(f.outstanding);
  const total = Math.max(1, num(f.totalBill));
  $('#finance').innerHTML = [
    metricBar('Total billed', paid + outstanding, total),
    metricBar('Collected', paid, total),
    metricBar('Outstanding', outstanding, total),
    metricBar('Pharmacy sales', num(f.pharmacySales), Math.max(total, num(f.pharmacySales), 1)),
  ].join('');
}

function renderDoctors() {
  const widgets = state.data.doctorWidgets || {};
  const doctors = Array.isArray(widgets.doctors) && widgets.doctors.length ? widgets.doctors : getDoctorWorkload();
  if (!doctors.length) {
    $('#doctors').innerHTML = `<div class="emptyState">Doctor workload will appear here after visits or queue records.</div>`;
    return;
  }
  const maxCount = Math.max(...doctors.map(d => num(d.queueCount || d.count || d.total || 0)), 1);
  $('#doctors').innerHTML = doctors.slice(0, 8).map(d => `
    <div class="doctorWidgetCard">
      <div class="row alignCenter" style="justify-content:space-between">
        <div>
          <div class="itemTitle">${escapeHtml(d.doctorName || d.doctor || 'Doctor')}</div>
          <div class="itemMeta"><span>${num(d.queueCount || d.count || 0)} in queue</span><span>${num(d.servedCount || 0)} served</span></div>
        </div>
        <span class="badge ${num(d.queueCount || d.count || 0) >= 6 ? 'urgent' : 'normal'}">${num(d.queueCount || d.count || 0) >= 6 ? 'Busy' : 'Stable'}</span>
      </div>
      <div class="miniKpis">
        <div><small>Open</small><strong>${num(d.queueCount || d.count || 0)}</strong></div>
        <div><small>Served</small><strong>${num(d.servedCount || 0)}</strong></div>
        <div><small>Avg Wait</small><strong>${escapeHtml(String(d.avgWaitLabel || '--'))}</strong></div>
      </div>
      <div class="progress"><span style="width:${(num(d.queueCount || d.count || 0) / maxCount) * 100}%"></span></div>
      <div class="queueActions">
        <button class="pillBtn" type="button" data-queue-doctor="${escapeHtml(d.doctorName || d.doctor || '')}">Open Queue</button>
      </div>
    </div>`).join('');
  $$('[data-queue-doctor]', $('#doctors')).forEach(btn => btn.addEventListener('click', () => {
    switchTab('operations');
    const target = Array.from(document.querySelectorAll('.queueCard')).find(card => card.textContent.toLowerCase().includes(String(btn.dataset.queueDoctor || '').toLowerCase()));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

function renderRealtimeBoard() {
  const live = state.data.live || {};
  const changes = Array.isArray(live.recentChanges) ? live.recentChanges : [];
  const host = $('#realtimeBoard');
  host.innerHTML = [
    miniPanel('Transport', state.transport || 'Polling'),
    miniPanel('Cloud Version', state.version || live.version || 0),
    miniPanel('Queue Live', live.queueCount ?? state.data.queue?.queueCount ?? 0),
    miniPanel('Snapshot', live.lastSnapshotAt ? fmtDateTime(live.lastSnapshotAt) : 'Waiting'),
    ...changes.slice(0, 4).map(item => miniPanel(
      `${String(item.type || 'update').replace(/_/g, ' ')}`,
      `v${num(item.version)} • ${fmtTime(item.createdAt)}`
    ))
  ].join('');
}

function renderDoctorBars() {
  const doctors = getDoctorWorkload();
  const max = Math.max(...doctors.map(d => num(d.count)), 1);
  $('#doctorBars').innerHTML = doctors.length ? doctors.slice(0, 6).map(d => `
    <div class="doctorRow">
      <div class="row alignCenter" style="justify-content:space-between"><strong>${escapeHtml(d.doctorName || 'Doctor')}</strong><span>${num(d.count)} cases</span></div>
      <div class="progress"><span style="width:${(num(d.count) / max) * 100}%"></span></div>
    </div>
  `).join('') : `<div class="emptyState">Doctor bar analytics will appear after operations begin.</div>`;
}

function renderAnalyticsPanels() {
  const f = state.data.finance?.finance || {};
  const o = state.data.overview?.overview || {};
  const notifications = state.data.notifications || [];
  $('#financeBreakdown').innerHTML = [
    metricBar('Total Revenue Engine', num(f.totalBill), Math.max(num(f.totalBill), 1)),
    metricBar('Collected Cashflow', num(f.totalPaid), Math.max(num(f.totalBill), 1)),
    metricBar('Exposure Outstanding', num(f.outstanding), Math.max(num(f.totalBill), 1)),
    metricBar('Pharmacy Share', num(f.pharmacySales), Math.max(num(f.totalBill), 1)),
  ].join('');
  const ws = state.data.workspace?.summary || {};
  $('#workflowBenchmarks').innerHTML = [
    metricRow('Patient registry strength', num(o.patients), 'Registered patient footprint'),
    metricRow('Clinical throughput', num(ws.activeVisits || o.visits), 'Visits handled in the current dataset'),
    metricRow('Queue intensity', num(ws.openQueue || o.queue), 'Open doctor queue count'),
    metricRow('Pending labs', num(ws.pendingLabs), 'Laboratory desk workload'),
    metricRow('Active prescriptions', num(ws.activePrescriptions), 'Medication flow still active'),
    metricRow('Admissions active', num(ws.activeAdmissions || o.admissions), 'Bed-side and inpatient activity'),
  ].join('');
  $('#analyticsSignals').innerHTML = notifications.slice(0, 6).map(n => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(n.title || n.type || 'Signal')}</div><div>${escapeHtml(n.message || '--')}</div></div>`).join('') || `<div class="emptyState">Realtime signals will show after events start flowing.</div>`;
  const ws2 = state.data.workspace?.summary || {};
  $('#boardSummary').innerHTML = [
    miniPanel('Executive summary', escapeHtml(state.data.aiOverview?.summary || 'Analytics summary will appear here.')),
    miniPanel('Billing insight', `${money(f.totalPaid)} collected out of ${money(f.totalBill)} total billed.`),
    miniPanel('Queue insight', num(ws2.openQueue || o.queue) > 5 ? 'Doctor queue is under pressure. Consider load balancing.' : 'Queue pressure is under control.'),
    miniPanel('Workflow command', `${num(ws2.pendingAppointments)} appointments • ${num(ws2.pendingLabs)} labs • ${num(ws2.activePrescriptions)} active prescriptions.`),
    miniPanel('Operations pulse', `${num(o.patients)} patients • ${num(ws2.activeVisits || o.visits)} visits • ${num(o.bills)} bills.`),
    miniPanel('Nurse desk', `${num(ws2.nurseDeskOpen)} open care entries • ${num(ws2.staffOnlineReady)} active staff ready.`),
  ].join('');
}

function renderPatients() {
  const items = state.data.patients || [];
  $('#patientsList').innerHTML = items.length ? items.slice(0, 25).map(p => `
    <div class="listCard">
      <div class="itemTitle">${escapeHtml(p.fullName || 'Unnamed Patient')}</div>
      <div class="row"><span class="badge">${escapeHtml(p.patientId || '--')}</span><span class="badge">${escapeHtml(p.gender || '--')}</span></div>
      <div class="itemMeta"><span>${escapeHtml(p.phone || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span></div>
      <div class="inlineActions">
        <button class="pillBtn" data-ai="${escapeHtml(p.patientId || '')}">AI</button>
        <button class="pillBtn" data-view="${escapeHtml(p.patientId || '')}">Profile</button>
        <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
      </div>
    </div>
  `).join('') : `<div class="emptyState">No patients registered yet.</div>`;
  $$('[data-ai]', $('#patientsList')).forEach(btn => btn.addEventListener('click', () => { switchTab('search'); loadPatientAi(btn.dataset.ai); $('#searchInput').value = btn.dataset.ai; }));
  $$('[data-view]', $('#patientsList')).forEach(btn => btn.addEventListener('click', () => openPatientDrawer(btn.dataset.view)));
  $$('[data-bill]', $('#patientsList')).forEach(btn => btn.addEventListener('click', () => openBillModal(btn.dataset.bill, btn.dataset.name)));
}

function renderSideSummary() {
  const live = state.data.live || {};
  const overview = state.data.overview?.overview || {};
  $('#sideSummary').innerHTML = [
    miniPanel('Hospital', state.data.live?.clinic?.clinicName || state.data.overview?.clinic?.clinicName || 'Connected'),
    miniPanel('Cloud Version', state.version || live.version || 0),
    miniPanel('Realtime Transport', state.transport || 'Polling'),
    miniPanel('Patients', overview.patients ?? 0),
    miniPanel('Outstanding', money(overview.outstanding || 0)),
    miniPanel('Last Snapshot', live.lastSnapshotAt ? fmtDateTime(live.lastSnapshotAt) : '--')
  ].join('');
}


function openPatientWizard(prefill = {}) {
  toggleFab(false);
  showModal('Patient Registration Wizard', `
    <div class="wizardShell">
      <div class="wizardSteps">
        <div class="wizardStep active" data-step="1"><span>1</span><div><strong>Identity</strong><small>Patient bio</small></div></div>
        <div class="wizardStep" data-step="2"><span>2</span><div><strong>Contacts</strong><small>Reachability</small></div></div>
        <div class="wizardStep" data-step="3"><span>3</span><div><strong>Medical</strong><small>Clinical basics</small></div></div>
      </div>
      <form id="patientWizardForm" class="stack12">
        <section class="wizardPane" data-pane="1">
          <div class="formGrid compactGrid">
            <input name="fullName" placeholder="Full Name" required value="${escapeHtml(prefill.fullName || '')}">
            <input name="phone" placeholder="Phone Number" value="${escapeHtml(prefill.phone || '')}">
            <select name="gender"><option value="">Gender</option><option ${prefill.gender==='Male'?'selected':''}>Male</option><option ${prefill.gender==='Female'?'selected':''}>Female</option></select>
            <input name="age" placeholder="Age" type="number" value="${escapeHtml(prefill.age || '')}">
            <input name="mrn" placeholder="MRN optional" value="${escapeHtml(prefill.mrn || '')}">
            <input name="dob" placeholder="DOB YYYY-MM-DD" value="${escapeHtml(prefill.dob || '')}">
          </div>
        </section>
        <section class="wizardPane hidden" data-pane="2">
          <div class="formGrid compactGrid">
            <input name="email" placeholder="Email" value="${escapeHtml(prefill.email || '')}">
            <input name="maritalStatus" placeholder="Marital Status" value="${escapeHtml(prefill.maritalStatus || '')}">
            <input name="nextOfKin" placeholder="Next of Kin" value="${escapeHtml(prefill.nextOfKin || '')}">
            <input name="nextOfKinPhone" placeholder="Next of Kin Phone" value="${escapeHtml(prefill.nextOfKinPhone || '')}">
            <textarea name="address" placeholder="Address" class="span2">${escapeHtml(prefill.address || '')}</textarea>
          </div>
        </section>
        <section class="wizardPane hidden" data-pane="3">
          <div class="formGrid compactGrid">
            <input name="bloodGroup" placeholder="Blood Group" value="${escapeHtml(prefill.bloodGroup || '')}">
            <input name="genotype" placeholder="Genotype" value="${escapeHtml(prefill.genotype || '')}">
            <input name="status" placeholder="Status" value="${escapeHtml(prefill.status || 'active')}">
            <input name="notes" placeholder="Quick Notes" value="${escapeHtml(prefill.notes || '')}">
            <textarea class="span2" disabled>After save, the patient will flow instantly to command center, queue, billing, and Android sync channels.</textarea>
          </div>
        </section>
        <div class="wizardActions">
          <button type="button" class="btn btnGhost" id="wizardBackBtn">Back</button>
          <div class="row gap8">
            <button type="button" class="btn btnGhost" id="wizardNextBtn">Next</button>
            <button type="submit" class="btn btnPrimary hidden" id="wizardSubmitBtn">Save Patient</button>
          </div>
        </div>
      </form>
    </div>
  `);
  bindPatientWizard(prefill.patientId ? '/api/portal/patient/update' : '/api/patient/register', prefill.patientId || '');
}

function bindPatientWizard(path, patientId) {
  const form = $('#patientWizardForm');
  if (!form) return;
  let step = 1;
  const total = 3;
  const syncStep = () => {
    $$('.wizardPane', form).forEach(p => p.classList.toggle('hidden', Number(p.dataset.pane) !== step));
    $$('.wizardStep').forEach(s => s.classList.toggle('active', Number(s.dataset.step) === step));
    $('#wizardBackBtn').disabled = step === 1;
    $('#wizardNextBtn').classList.toggle('hidden', step === total);
    $('#wizardSubmitBtn').classList.toggle('hidden', step !== total);
  };
  $('#wizardBackBtn').addEventListener('click', () => { if (step > 1) { step--; syncStep(); } });
  $('#wizardNextBtn').addEventListener('click', () => { if (step < total) { step++; syncStep(); } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const body = formToObject(form);
      if (patientId) body.patientId = patientId;
      const res = await api(path, { method: 'POST', body });
      closeModal();
      showToast(patientId ? 'Patient Updated' : 'Patient Saved', res?.patient?.fullName || 'Patient record stored');
      await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
      if (res?.patient?.patientId) openPatientDrawer(res.patient.patientId);
    } catch (err) {
      showToast('Wizard Failed', err.message || 'Unable to save patient');
    }
  });
  syncStep();
}

function openPatientModal() {
  openPatientWizard();
}

function openBillModal(patientId = '', patientName = '') {
  toggleFab(false);
  const source = $('#billForm');
  if (!source) return;
  const clone = source.cloneNode(true);
  clone.id = 'billModalForm';
  const wrap = document.createElement('div');
  wrap.innerHTML = clone.outerHTML;
  const form = wrap.firstElementChild;
  if (patientId) form.querySelector('[name="patientId"]').value = patientId;
  const patientNameEl = form.querySelector('[name="patientName"]');
  if (patientName && patientNameEl) patientNameEl.value = patientName;
  showModal('Direct Billing Workflow', form.outerHTML);
  bindForm('#billModalForm', '/api/bill/create', 'Bill created', async (res) => {
    closeModal();
    showToast('Bill Created', `${res?.bill?.category || 'Service'} billing saved`);
    await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
    if (res?.bill?.billId) openReceiptPreview(res.bill.billId);
  });
}


async function openPatientDrawer(patientId) {
  if (!patientId) return;
  try {
    const res = await api(`/api/portal/patient-profile?patientId=${encodeURIComponent(patientId)}`);
    const p = res.patient || {};
    const encounters = Array.isArray(res.encounters) ? res.encounters : [];
    const billing = Array.isArray(res.bills) ? res.bills : [];
    const admissions = Array.isArray(res.admissions) ? res.admissions : [];
    const summary = res.summary || {};
    showDrawer(`${p.fullName || p.patientName || 'Patient Profile'}`, `
      <div class="drawerHero">
        <div>
          <div class="eyebrow">Patient Profile Drawer</div>
          <h3>${escapeHtml(p.fullName || p.patientName || patientId)}</h3>
          <div class="itemMeta"><span>${escapeHtml(p.patientId || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span><span>${escapeHtml(p.phone || '--')}</span></div>
        </div>
        <div class="drawerHeroBadge">${escapeHtml(p.status || 'active')}</div>
      </div>
      <div class="drawerGrid">
        <div class="miniPanel"><div class="itemTitle">Demography</div><div>${escapeHtml(p.gender || '--')} • ${escapeHtml(String(p.age || '--'))}</div><div class="itemMeta"><span>${escapeHtml(p.bloodGroup || '--')}</span><span>${escapeHtml(p.genotype || '--')}</span></div></div>
        <div class="miniPanel"><div class="itemTitle">Clinical Totals</div><div>${num(summary.visitCount)} visits • ${num(summary.billCount)} bills</div><div class="itemMeta"><span>${num(summary.admissionCount)} admissions</span><span>${money(summary.outstanding || 0)} outstanding</span></div></div>
        <div class="miniPanel"><div class="itemTitle">Address</div><div>${escapeHtml(p.address || '--')}</div></div>
        <div class="miniPanel"><div class="itemTitle">Next of Kin</div><div>${escapeHtml(p.nextOfKin || '--')}</div><div class="itemMeta"><span>${escapeHtml(p.nextOfKinPhone || '--')}</span></div></div>
      </div>
      <div class="drawerSection">
        <div class="cardHead compact"><div><div class="eyebrow">Timeline</div><h3>Recent Encounters</h3></div><div class="row gap8"><button class="btn btnGhost small" type="button" id="drawerEditBtn">Edit Patient</button><button class="btn btnGhost small" type="button" id="drawerBillBtn">Create Bill</button></div></div>
        <div class="stack10">${encounters.length ? encounters.map(v => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(v.kind || 'Visit')} • ${escapeHtml(v.status || '--')}</div><div>${escapeHtml(v.doctorName || v.title || '--')}</div><div class="itemMeta"><span>${escapeHtml(v.reason || v.category || '--')}</span><span>${fmtDateTime(v.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">No recent encounters for this patient.</div>`}</div>
      </div>
      <div class="drawerSection">
        <div class="cardHead compact"><div><div class="eyebrow">Billing</div><h3>Receipt Preview Queue</h3></div></div>
        <div class="stack10">${billing.length ? billing.map(b => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(b.category || 'General')} • ${money(b.total)}</div><div class="itemMeta"><span>${money(b.paid)} paid</span><span>${money(b.balance)} balance</span><span>${fmtDateTime(b.createdAt)}</span></div><div class="inlineActions"><button class="pillBtn" type="button" data-receipt="${escapeHtml(b.billId || '')}">Open Receipt</button><button class="pillBtn warn" type="button" data-edit-bill="${escapeHtml(b.billId || '')}" data-category="${escapeHtml(b.category || '')}" data-total="${escapeHtml(String(b.total || ''))}" data-paid="${escapeHtml(String(b.paid || ''))}" data-status="${escapeHtml(b.status || '')}" data-payment="${escapeHtml(b.paymentMethod || '')}" data-description="${escapeHtml(b.description || '')}">Edit Bill</button></div></div>`).join('') : `<div class="emptyState">No bills created for this patient.</div>`}</div>
      </div>
      <div class="drawerSection">
        <div class="cardHead compact"><div><div class="eyebrow">Admissions</div><h3>Inpatient Summary</h3></div></div>
        <div class="stack10">${admissions.length ? admissions.map(a => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(a.ward || 'Ward')} • ${escapeHtml(a.status || '--')}</div><div>${escapeHtml(a.doctorName || '--')}</div><div class="itemMeta"><span>${escapeHtml(a.bed || '--')}</span><span>${fmtDateTime(a.admittedAt || a.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">No admission records for this patient.</div>`}</div>
      </div>
    `);
    document.getElementById('drawerBillBtn')?.addEventListener('click', () => { closeModal(); openBillModal(p.patientId || patientId, p.fullName || p.patientName || ''); });
    document.getElementById('drawerEditBtn')?.addEventListener('click', () => openPatientWizard(p));
    $$('[data-receipt]', document.getElementById('activeModal')).forEach(btn => btn.addEventListener('click', () => openReceiptPreview(btn.dataset.receipt)));
    $$('[data-edit-bill]', document.getElementById('activeModal')).forEach(btn => btn.addEventListener('click', () => openBillEditModal({ billId: btn.dataset.editBill, category: btn.dataset.category, total: btn.dataset.total, paid: btn.dataset.paid, status: btn.dataset.status, paymentMethod: btn.dataset.payment, description: btn.dataset.description })));
  } catch (err) {
    showToast('Profile Unavailable', err.message || 'Unable to load patient profile');
  }
}


function openBillEditModal(bill = {}) {
  showModal(`Update Bill • ${bill.billId || ''}`, `
    <form id="billEditForm" class="formGrid compactGrid">
      <input type="hidden" name="billId" value="${escapeHtml(bill.billId || '')}">
      <input name="category" placeholder="Category" value="${escapeHtml(bill.category || '')}">
      <input name="total" type="number" step="0.01" placeholder="Total" value="${escapeHtml(String(bill.total || ''))}">
      <input name="paid" type="number" step="0.01" placeholder="Paid" value="${escapeHtml(String(bill.paid || ''))}">
      <select name="status"><option ${String(bill.status).toLowerCase()==='paid'?'selected':''} value="paid">Paid</option><option ${String(bill.status).toLowerCase()==='partial'?'selected':''} value="partial">Partial</option><option ${String(bill.status).toLowerCase()==='unpaid'?'selected':''} value="unpaid">Unpaid</option></select>
      <input name="paymentMethod" placeholder="Payment Method" value="${escapeHtml(bill.paymentMethod || '')}">
      <textarea name="description" class="span2" placeholder="Description">${escapeHtml(bill.description || '')}</textarea>
      <div class="span2 row end"><button type="submit" class="btn btnPrimary">Update Bill</button></div>
    </form>
  `);
  bindForm('#billEditForm', '/api/portal/bill/update', 'Bill updated', async (res) => {
    closeModal();
    showToast('Bill Updated', `${res?.bill?.category || 'Billing'} record updated`);
    await targetedRealtimeRefresh(['bills','patients','doctor_queue','audit_logs']);
    if (res?.bill?.billId) openReceiptPreview(res.bill.billId);
  });
}

async function openReceiptPreview(billId) {
  if (!billId) return;
  try {
    const res = await api(`/api/portal/receipt-preview?billId=${encodeURIComponent(billId)}`);
    const receipt = res.receipt || {};
    showModal(`Receipt Preview • ${receipt.billNo || billId}`, `
      <div class="receiptShell">
        <div class="receiptPaper">
          <div class="receiptCenter">
            <div class="receiptClinic">${escapeHtml(receipt.clinicName || 'Clinic Pro NG')}</div>
            <div>${escapeHtml(receipt.branchName || 'Main Branch')}</div>
            <div>${escapeHtml(receipt.generatedLabel || '')}</div>
          </div>
          <div class="receiptLine"></div>
          <div class="receiptRow"><span>Patient</span><strong>${escapeHtml(receipt.patientName || '--')}</strong></div>
          <div class="receiptRow"><span>Patient ID</span><strong>${escapeHtml(receipt.patientId || '--')}</strong></div>
          <div class="receiptRow"><span>Bill No</span><strong>${escapeHtml(receipt.billNo || '--')}</strong></div>
          <div class="receiptRow"><span>Category</span><strong>${escapeHtml(receipt.category || '--')}</strong></div>
          <div class="receiptRow"><span>Description</span><strong>${escapeHtml(receipt.description || '--')}</strong></div>
          <div class="receiptLine"></div>
          <div class="receiptRow"><span>Total</span><strong>${money(receipt.total || 0)}</strong></div>
          <div class="receiptRow"><span>Paid</span><strong>${money(receipt.paid || 0)}</strong></div>
          <div class="receiptRow"><span>Balance</span><strong>${money(receipt.balance || 0)}</strong></div>
          <div class="receiptRow"><span>Status</span><strong>${escapeHtml(receipt.status || '--')}</strong></div>
          <div class="receiptRow"><span>Payment</span><strong>${escapeHtml(receipt.paymentMethod || '--')}</strong></div>
          <div class="receiptLine"></div>
          <div class="receiptCenter receiptSmall">Web portal preview for direct billing workflow. Android thermal receipt can print the same bill from the device.</div>
          <div class="inlineActions" style="justify-content:center;margin-top:14px"><button class="pillBtn" type="button" id="receiptPrintBtn">Print</button><button class="pillBtn warn" type="button" id="receiptEditBtn">Edit Bill</button></div>
        </div>
      </div>
    `);
    document.getElementById('receiptPrintBtn')?.addEventListener('click', () => window.print());
    document.getElementById('receiptEditBtn')?.addEventListener('click', () => openBillEditModal({ billId: receipt.billId || billId, category: receipt.category || '', total: receipt.total || '', paid: receipt.paid || '', status: receipt.status || '', paymentMethod: receipt.paymentMethod || '', description: receipt.description || '' }));
  } catch (err) {
    showToast('Receipt Unavailable', err.message || 'Unable to load receipt preview');
  }
}

function showDrawer(title, bodyHtml) {
  $('#modalHost').innerHTML = `
    <div class="modalWrap drawerWrap" id="activeModal">
      <div class="modalCard drawerCard">
        <div class="cardHead"><div><div class="eyebrow">Enterprise Patient Workspace</div><h3>${escapeHtml(title)}</h3></div><button class="btn btnGhost small" id="closeModalBtn" type="button">Close</button></div>
        ${bodyHtml}
      </div>
    </div>`;
  $('#closeModalBtn').addEventListener('click', closeModal);
  $('#activeModal').addEventListener('click', (e) => { if (e.target.id === 'activeModal') closeModal(); });
}

function showModal(title, bodyHtml) {
  $('#modalHost').innerHTML = `
    <div class="modalWrap" id="activeModal">
      <div class="modalCard">
        <div class="cardHead"><div><div class="eyebrow">Enterprise Workflow</div><h3>${escapeHtml(title)}</h3></div><button class="btn btnGhost small" id="closeModalBtn" type="button">Close</button></div>
        ${bodyHtml}
      </div>
    </div>`;
  $('#closeModalBtn').addEventListener('click', closeModal);
  $('#activeModal').addEventListener('click', (e) => { if (e.target.id === 'activeModal') closeModal(); });
}

function closeModal() { $('#modalHost').innerHTML = ''; }

function showToast(title, message) {
  const id = `toast_${Date.now()}`;
  $('#toastHost').insertAdjacentHTML('beforeend', `<div class="toast" id="${id}"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(message)}</span></div>`);
  setTimeout(() => document.getElementById(id)?.remove(), 3200);
}

function startRealtime() {
  stopRealtime();
  try {
    const url = `${state.baseUrl}/api/events/stream?hospitalId=${encodeURIComponent(state.hospitalId)}`;
    state.sse = new EventSource(url);
    state.sse.onopen = () => {
      state.transport = 'SSE';
      $('#transportText').textContent = 'SSE Live';
      $('#realtimeText').textContent = `Streaming${state.version ? ' • v' + state.version : ''}`;
      setLiveState('Realtime Connected', 'connected');
    };
    state.sse.onmessage = (e) => handleRealtimeEvent(e.data);
    state.sse.addEventListener('hello', () => {
      state.transport = 'SSE';
      $('#transportText').textContent = 'SSE Live';
      $('#realtimeText').textContent = `Streaming${state.version ? ' • v' + state.version : ''}`;
    });
    state.sse.addEventListener('ping', () => {
      state.lastSync = Date.now();
      $('#lastSyncText').textContent = fmtTime(state.lastSync);
    });
    state.sse.onerror = () => fallbackPolling();
  } catch {
    fallbackPolling();
  }
}

function inferTablesFromType(type) {
  const value = String(type || '').toLowerCase();
  const tables = new Set();
  if (value.includes('patient')) tables.add('patients');
  if (value.includes('bill')) tables.add('bills');
  if (value.includes('visit')) tables.add('visits');
  if (value.includes('queue')) tables.add('doctor_queue');
  if (value.includes('appointment')) tables.add('appointments');
  if (value.includes('admission')) tables.add('admissions');
  if (value.includes('lab')) tables.add('lab_requests');
  if (value.includes('pharmacy') || value.includes('drug')) tables.add('pharmacy_dispenses');
  if (value.includes('nurse')) tables.add('nurse_desk');
  if (value.includes('staff')) tables.add('staff');
  return Array.from(tables);
}

async function targetedRealtimeRefresh(tables = [], versionHint = 0) {
  const keys = new Set((Array.isArray(tables) ? tables : []).map(x => String(x || '').toLowerCase()).filter(Boolean));
  if (!keys.size) return refreshAll();
  const include = new Set(['live']);
  const needsOps = ['patients','visits','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff'].some(k => keys.has(k));
  const needsFinance = ['bills','pharmacy_dispenses','cashier_shifts'].some(k => keys.has(k));
  const needsTimeline = ['patients','visits','bills','doctor_queue'].some(k => keys.has(k));
  const needsPatients = ['patients','visits','bills','admissions','appointments'].some(k => keys.has(k));
  const needsNotifications = ['audit_logs'].some(k => keys.has(k)) || !keys.size;
  if (needsOps) ['queue','overview','aiOverview','risk','doctorWidgets','workspace'].forEach(k => include.add(k));
  if (needsFinance) include.add('finance');
  if (needsTimeline) include.add('timeline');
  if (needsPatients) include.add('patients');
  if (needsNotifications) include.add('notifications');
  await loadLiteBundle(Array.from(include));
  if (versionHint) state.version = Math.max(state.version || 0, num(versionHint));
  renderAll();
}

function handleRealtimeEvent(raw) {
  state.lastSync = Date.now();
  $('#lastSyncText').textContent = fmtTime(state.lastSync);
  let event = null;
  try { event = JSON.parse(raw); } catch {}
  const type = String(event?.type || event?.event || '').toLowerCase();
  const versionHint = num(event?.payload?.version || event?.version || 0);
  const tables = Array.from(new Set([...(event?.payload?.tables || []), ...(event?.payload?.changedTables || []), ...inferTablesFromType(type)]));
  state.version = Math.max(state.version || 0, versionHint);
  if (type) showToast('Realtime Update', event.title || event.message || type);
  if (event) applyRealtimeMutation(event);
  if (state.data.live && event && type) {
    const recent = Array.isArray(state.data.live.recentChanges) ? state.data.live.recentChanges.slice() : [];
    recent.unshift({ type, version: state.version, createdAt: Date.now(), payload: event.payload || {}, tables });
    state.data.live.recentChanges = recent.slice(0, 8);
    renderRealtimeBoard();
    renderSideSummary();
  }
  if (!event?.payload?.entity && !event?.payload?.liveCounters) {
    scheduleRefresh(type.includes('queue') ? 120 : (type.includes('patient') || type.includes('bill') || type.includes('visit') ? 180 : 320), tables, versionHint);
  } else {
    renderAll();
  }
}

function scheduleRefresh(delay = 400, tables = [], versionHint = 0) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => targetedRealtimeRefresh(tables, versionHint).catch(() => refreshAll()), delay);
}

function fallbackPolling() {
  state.transport = 'Polling';
  $('#transportText').textContent = 'Polling';
  $('#realtimeText').textContent = `Fallback${state.version ? ' • v' + state.version : ''}`;
  if (!state.poller) state.poller = setInterval(refreshAll, 15000);
}

function stopRealtime() {
  if (state.sse) {
    try { state.sse.close(); } catch {}
    state.sse = null;
  }
  if (state.poller) {
    clearInterval(state.poller);
    state.poller = null;
  }
  clearTimeout(state.refreshTimer);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Hospital-Id': state.hospitalId, ...(options.headers || {}) };
  const res = await fetch(`${state.baseUrl}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let json = {};
  try { json = await res.json(); } catch {}
  if (!res.ok || json.ok === false) throw new Error(json.error || json.message || `Request failed (${res.status})`);
  return json;
}


function ensureCommandCenter() {
  if (!state.data.commandCenter) state.data.commandCenter = { cards: [], counts: {}, recentPatients: [], recentBills: [], queue: [], timeline: [], recentChanges: [] };
  return state.data.commandCenter;
}

function upsertByKey(list, item, key) {
  if (!item || !item[key]) return Array.isArray(list) ? list || [] : [];
  const rows = Array.isArray(list) ? list.slice() : [];
  const idx = rows.findIndex(x => String(x?.[key]) === String(item[key]));
  if (idx >= 0) rows[idx] = { ...rows[idx], ...item };
  else rows.unshift(item);
  return rows;
}

function recomputeCommandCardsFromOverview() {
  const cc = ensureCommandCenter();
  const o = state.data.overview?.overview || {};
  const f = state.data.finance?.finance || {};
  cc.counts = {
    patients: num(o.patients),
    visits: num(o.visits),
    queue: num(o.queue),
    bills: num(o.bills || f.billCount),
    admissions: num(o.admissions),
    totalPaid: num(f.totalPaid),
    outstanding: num(f.outstanding),
    pharmacy: num(f.pharmacySales || o.pharmacy)
  };
  cc.cards = [
    { key:'patients', label:'Patients', value: cc.counts.patients, sub:'Registered patient base' },
    { key:'visits', label:'Active Visits', value: cc.counts.visits, sub:'Clinical load in motion' },
    { key:'queue', label:'Queue', value: cc.counts.queue, sub:'Doctor waiting line' },
    { key:'totalPaid', label:'Paid Revenue', value: cc.counts.totalPaid, kind:'money', sub:'Collected billing revenue' },
    { key:'outstanding', label:'Outstanding', value: cc.counts.outstanding, kind:'money', sub:'Awaiting payment' },
    { key:'bills', label:'Bills', value: cc.counts.bills, sub:'Billing records created' },
    { key:'admissions', label:'Admissions', value: cc.counts.admissions, sub:'Current admissions' },
    { key:'pharmacy', label:'Pharmacy Sales', value: cc.counts.pharmacy, kind:'count', sub:'Pharmacy workflow volume' },
  ];
}

function applyRealtimeMutation(event) {
  const payload = event?.payload || {};
  if (!payload.liveCounters && !payload.entity) return;
  const o = state.data.overview?.overview || (state.data.overview = { overview: {}, clinic: state.data.overview?.clinic }).overview;
  const f = state.data.finance?.finance || (state.data.finance = { finance: {} }).finance;
  if (payload.liveCounters) {
    o.patients = num(payload.liveCounters.patients);
    o.visits = num(payload.liveCounters.visits);
    o.queue = num(payload.liveCounters.queue);
    o.bills = num(payload.liveCounters.bills);
    o.admissions = num(payload.liveCounters.admissions);
    o.outstanding = num(payload.liveCounters.outstanding);
    o.totalPaid = num(payload.liveCounters.totalPaid);
    f.totalBill = num(payload.liveCounters.totalBill);
    f.totalPaid = num(payload.liveCounters.totalPaid);
    f.outstanding = num(payload.liveCounters.outstanding);
    f.billCount = num(payload.liveCounters.bills);
    f.pharmacySales = num(payload.liveCounters.pharmacy);
  }
  const cc = ensureCommandCenter();
  if (payload.entity?.patient) {
    state.data.patients = upsertByKey(state.data.patients, payload.entity.patient, 'patientId').slice(0, 500);
    cc.recentPatients = upsertByKey(cc.recentPatients, payload.entity.patient, 'patientId').slice(0, 12);
  }
  if (payload.entity?.bill) {
    cc.recentBills = upsertByKey(cc.recentBills, payload.entity.bill, 'billId').slice(0, 12);
  }
  if (payload.entity?.queue) {
    state.data.queue = upsertByKey(state.data.queue, payload.entity.queue, 'queueId').slice(0, 500);
    cc.queue = upsertByKey(cc.queue, payload.entity.queue, 'queueId').slice(0, 12);
  }
  if (state.data.live) state.data.live.queueCount = num(payload.liveCounters?.queue ?? state.data.live.queueCount);
  recomputeCommandCardsFromOverview();
}

function renderLiveTicker() {
  const host = $('#liveTicker');
  if (!host) return;
  const cc = state.data.commandCenter;
  const cards = cc?.cards?.length ? cc.cards : [];
  host.innerHTML = cards.length ? cards.map(card => `<div class="tickerChip">${escapeHtml(card.label)} <b>${card.kind === 'money' ? money(card.value) : escapeHtml(String(card.value))}</b></div>`).join('') : `<div class="emptyState">Live counters will appear when data loads.</div>`;
}


function renderWorkspace() {
  const ws = state.data.workspace || {};
  const summary = ws.summary || {};
  const careTimeline = ws.careTimeline || [];
  const summaryHost = document.getElementById('workspaceSummary');
  const timelineHost = document.getElementById('workspaceTimeline');
  if (summaryHost) {
    const cards = [
      ['Active Visits', num(summary.activeVisits), 'Current clinical encounters'],
      ['Open Queue', num(summary.openQueue), 'Doctor queue waiting now'],
      ['Pending Appointments', num(summary.pendingAppointments), 'Scheduled and not closed'],
      ['Pending Labs', num(summary.pendingLabs), 'Lab desk workload'],
      ['Active Prescriptions', num(summary.activePrescriptions), 'Medication orders in motion'],
      ['Nurse Desk', num(summary.nurseDeskOpen), 'Open nursing notes/tasks'],
      ['Admissions', num(summary.activeAdmissions), 'Inpatient load'],
      ['Staff Ready', num(summary.staffOnlineReady), 'Available active team members'],
    ];
    summaryHost.innerHTML = cards.map(([label, value, sub]) => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(label)}</div><div style="font-size:24px;font-weight:900">${escapeHtml(String(value))}</div><div class="itemMeta"><span>${escapeHtml(sub)}</span></div></div>`).join('');
  }
  if (timelineHost) {
    timelineHost.innerHTML = careTimeline.length ? careTimeline.map(item => `<div class="feedItem"><div class="row alignCenter" style="justify-content:space-between"><div class="itemTitle">${escapeHtml(item.lane || 'Care')}</div><span class="feedType">${escapeHtml(item.status || '--')}</span></div><div>${escapeHtml(item.title || '--')}</div><div class="itemMeta"><span>${escapeHtml(item.sub || '--')}</span><span>${fmtDateTime(item.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">Unified care timeline will appear here as queue, lab, prescription and nurse actions come in.</div>`;
  }
}

function renderCommandCenter() {
  const cc = state.data.commandCenter || {};
  const rp = $('#recentPatients');
  const rb = $('#recentBills');
  const bc = $('#billingCards');
  if (rp) rp.innerHTML = (cc.recentPatients || []).length ? (cc.recentPatients || []).map(p => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(p.fullName || 'Patient')}</div><div>${escapeHtml(p.patientId || '--')} • ${escapeHtml(p.gender || '--')}</div><div class="itemMeta"><span>${escapeHtml(p.phone || '--')}</span><span>${fmtDateTime(p.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">Recent patients will appear here.</div>`;
  if (rb) rb.innerHTML = (cc.recentBills || []).length ? (cc.recentBills || []).map(b => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(b.patientName || 'Patient')}</div><div>${escapeHtml(b.category || 'General')} • ${money(b.total)}</div><div class="itemMeta"><span>${money(b.paid)} paid</span><span>${money(b.balance)} balance</span></div><div class="inlineActions"><button class="pillBtn" data-receipt="${escapeHtml(b.billId || '')}">Receipt</button></div></div>`).join('') : `<div class="emptyState">Recent bills will appear here.</div>`;
  if (bc) {
    const f = state.data.finance?.finance || {};
    const cards = [
      { title:'Instant Revenue', value: money(f.totalPaid), sub:'Collected revenue now', cta:'New Bill', action:'bill' },
      { title:'Pending Collection', value: money(f.outstanding), sub:'Outstanding exposure', cta:'Find Patient', action:'search' },
      { title:'Bills Created', value: num(f.billCount), sub:'Billing volume in system', cta:'Direct Billing', action:'bill' }
    ];
    bc.innerHTML = cards.map(c => `<button class="billQuickCard" type="button" data-quick-action="${c.action}"><div class="itemTitle">${escapeHtml(c.title)}</div><div style="font-size:24px;font-weight:900">${escapeHtml(String(c.value))}</div><div class="itemMeta"><span>${escapeHtml(c.sub)}</span><span>${escapeHtml(c.cta)}</span></div></button>`).join('');
    $$('[data-quick-action]', bc).forEach(btn => btn.addEventListener('click', () => btn.dataset.quickAction === 'search' ? switchTab('search') : openBillModal()));
  }
  if (rb) $$('[data-receipt]', rb).forEach(btn => btn.addEventListener('click', () => openReceiptPreview(btn.dataset.receipt)));
}

function setLiveState(text, mode) {
  const pill = $('#livePill');
  pill.textContent = text;
  pill.classList.remove('connected', 'error');
  if (mode) pill.classList.add(mode);
}

function tickClock() { $('#systemClock').textContent = new Date().toLocaleTimeString(); }

function money(v) { return `NGN ${num(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function num(v) { const n = Number(v || 0); return Number.isFinite(n) ? n : 0; }
function fmtTime(v) { return v ? new Date(Number(v)).toLocaleTimeString() : '--'; }
function fmtDateTime(v) { return v ? new Date(Number(v)).toLocaleString() : '--'; }
function shortDay(d) { return d ? String(d).slice(5) : '--'; }
function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
function normalizeStatus(v) { return String(v || 'waiting').toLowerCase(); }
function getDoctorWorkload() {
  return state.data.overview?.overview?.doctorWorkload || state.data.aiOverview?.stats?.doctorWorkload || [];
}

function miniPanel(title, value) { return `<div class="miniPanel"><div class="itemTitle">${escapeHtml(title)}</div><div>${escapeHtml(value)}</div></div>`; }
function metricRow(title, value, sub) { return `<div class="metricRow"><div class="row alignCenter" style="justify-content:space-between"><div class="itemTitle">${escapeHtml(title)}</div><strong>${escapeHtml(String(value))}</strong></div><div class="itemMeta"><span>${escapeHtml(sub)}</span></div></div>`; }
function metricBar(title, value, max) {
  const pct = Math.max(4, Math.min(100, (num(value) / Math.max(1, num(max))) * 100));
  const showMoney = ['revenue', 'sales', 'billed', 'collected', 'outstanding'].some(w => title.toLowerCase().includes(w));
  return `<div class="metricRow"><div class="dualBar"><div class="dualBarRow"><strong>${escapeHtml(title)}</strong><span>${showMoney ? money(value) : escapeHtml(String(value))}</span></div><div class="progress"><span style="width:${pct}%"></span></div></div></div>`;
}

function renderEmptyChart(id, message) {
  const host = document.getElementById(id);
  if (!host) return;
  host.innerHTML = `<div class="emptyState">${escapeHtml(message)}</div>`;
}

function renderAreaChart(id, points, unitLabel) {
  const host = document.getElementById(id);
  if (!host) return;
  if (!points.length) return renderEmptyChart(id, 'No chart data');
  const w = 880, h = 260, pad = 36;
  const max = Math.max(...points.map(p => num(p.value)), 1);
  const step = points.length > 1 ? (w - pad * 2) / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({ x: pad + i * step, y: h - pad - ((num(p.value) / max) * (h - pad * 2)), value: num(p.value), label: p.label }));
  const line = coords.map((c, i) => `${i ? 'L' : 'M'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
  const area = `${line} L ${coords.at(-1).x} ${h - pad} L ${coords[0].x} ${h - pad} Z`;
  host.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="gArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stop-color="rgba(34,211,238,.45)"/><stop offset="100%" stop-color="rgba(34,211,238,0)"/></linearGradient>
      </defs>
      ${[0,.25,.5,.75,1].map(r => `<line x1="${pad}" y1="${pad + (h-pad*2)*r}" x2="${w-pad}" y2="${pad + (h-pad*2)*r}" stroke="rgba(148,163,184,.14)"/>`).join('')}
      <path d="${area}" fill="url(#gArea)"></path>
      <path d="${line}" fill="none" stroke="#22d3ee" stroke-width="4" stroke-linejoin="round" stroke-linecap="round"></path>
      ${coords.map(c => `<circle cx="${c.x}" cy="${c.y}" r="4.5" fill="#22d3ee"></circle>`).join('')}
      ${coords.map(c => `<text x="${c.x}" y="${h - 10}" text-anchor="middle" class="chartText">${escapeHtml(c.label)}</text>`).join('')}
      <text x="${pad}" y="18" class="chartText">${escapeHtml(unitLabel)}</text>
      <text x="${w-pad}" y="18" text-anchor="end" class="chartText">Peak ${money(max)}</text>
    </svg>`;
}

function renderMultiBarChart(id, points) {
  const host = document.getElementById(id);
  if (!host) return;
  if (!points.length) return renderEmptyChart(id, 'No chart data');
  const w = 880, h = 260, pad = 34;
  const max = Math.max(...points.flatMap(p => [num(p.a), num(p.b), num(p.c)]), 1);
  const groupW = (w - pad * 2) / points.length;
  const barW = Math.max(8, Math.min(18, groupW / 4));
  host.innerHTML = `
    <svg class="chartSvg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      ${[0,.25,.5,.75,1].map(r => `<line x1="${pad}" y1="${pad + (h-pad*2)*r}" x2="${w-pad}" y2="${pad + (h-pad*2)*r}" stroke="rgba(148,163,184,.12)"/>`).join('')}
      ${points.map((p, i) => {
        const gx = pad + i * groupW + groupW / 2;
        const vals = [num(p.a), num(p.b), num(p.c)];
        const colors = ['#22c55e','#22d3ee','#8b5cf6'];
        return vals.map((v, idx) => {
          const hh = (v / max) * (h - pad * 2);
          const x = gx + (idx - 1) * (barW + 4) - barW / 2;
          const y = h - pad - hh;
          return `<rect x="${x}" y="${y}" width="${barW}" height="${hh}" rx="8" fill="${colors[idx]}"></rect>`;
        }).join('') + `<text x="${gx}" y="${h - 10}" text-anchor="middle" class="chartText">${escapeHtml(p.label)}</text>`;
      }).join('')}
      <text x="${pad}" y="18" class="chartText">Patients</text>
      <text x="${pad+74}" y="18" class="chartText">Visits</text>
      <text x="${pad+132}" y="18" class="chartText">Queue</text>
    </svg>`;
}

function renderDonutChart(id, slices) {
  const host = document.getElementById(id);
  if (!host) return;
  const clean = slices.filter(s => num(s.value) > 0);
  if (!clean.length) return renderEmptyChart(id, 'No activity mix yet');
  const total = clean.reduce((a, b) => a + num(b.value), 0);
  const colors = ['#22d3ee','#22c55e','#8b5cf6','#f59e0b','#ef4444'];
  const cx = 160, cy = 130, r = 78, inner = 48;
  let angle = -Math.PI / 2;
  const paths = clean.map((slice, i) => {
    const portion = num(slice.value) / total;
    const end = angle + portion * Math.PI * 2;
    const p1 = [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r];
    const p2 = [cx + Math.cos(end) * r, cy + Math.sin(end) * r];
    const p3 = [cx + Math.cos(end) * inner, cy + Math.sin(end) * inner];
    const p4 = [cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner];
    const large = end - angle > Math.PI ? 1 : 0;
    const d = `M ${p1[0]} ${p1[1]} A ${r} ${r} 0 ${large} 1 ${p2[0]} ${p2[1]} L ${p3[0]} ${p3[1]} A ${inner} ${inner} 0 ${large} 0 ${p4[0]} ${p4[1]} Z`;
    angle = end;
    return { d, color: colors[i % colors.length], label: slice.label, value: slice.value };
  });
  host.innerHTML = `
    <div style="display:grid;grid-template-columns:320px 1fr;gap:12px;align-items:center;width:100%">
      <svg class="chartSvg" viewBox="0 0 320 260" preserveAspectRatio="xMidYMid meet">
        ${paths.map(p => `<path d="${p.d}" fill="${p.color}"></path>`).join('')}
        <text x="${cx}" y="${cy-8}" text-anchor="middle" class="chartText">Activity</text>
        <text x="${cx}" y="${cy+18}" text-anchor="middle" class="chartText">${total}</text>
      </svg>
      <div class="stack10">${paths.map(p => `<div class="miniPanel"><div class="row alignCenter"><span class="dot" style="background:${p.color}"></span><strong>${escapeHtml(p.label)}</strong></div><div>${escapeHtml(String(p.value))}</div></div>`).join('')}</div>
    </div>`;
}
