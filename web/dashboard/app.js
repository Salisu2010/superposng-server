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
  data: {
    overview: null,
    finance: null,
    queue: [],
    timeline: [],
    patients: [],
    notifications: [],
    aiOverview: null,
    risk: null,
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
  $('#quickPatientBtn').addEventListener('click', openPatientModal);
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
  $$('.openPatientModal').forEach(btn => btn.addEventListener('click', openPatientModal));
  $$('.openBillModal').forEach(btn => btn.addEventListener('click', () => openBillModal()));

  bindForm('#patientForm', '/api/patient/register', 'Patient registered', async (res) => {
    closeModal();
    showToast('Patient Saved', res?.patient?.fullName || res?.patient?.patientName || 'Patient registration completed');
    await refreshAll();
  });
  bindForm('#billForm', '/api/bill/create', 'Bill created', async (res) => {
    closeModal();
    showToast('Bill Created', `${res?.bill?.serviceName || 'Service'} billing saved`);
    await refreshAll();
  });
  bindForm('#visitForm', '/api/visit/create', 'Visit saved', async () => { showToast('Visit Saved', 'Clinical visit recorded'); await refreshAll(); });
  bindForm('#appointmentForm', '/api/appointment/create', 'Appointment booked', async () => { showToast('Appointment Booked', 'Appointment created'); await refreshAll(); });
  bindForm('#queueForm', '/api/doctor_queue/create', 'Queue entry saved', async () => { showToast('Queue Updated', 'Doctor queue updated'); await refreshAll(); });
  bindForm('#labForm', '/api/lab/request', 'Lab request saved', async () => { showToast('Lab Request', 'Lab request created'); await refreshAll(); });
  bindForm('#prescriptionForm', '/api/prescription/create', 'Prescription saved', async () => { showToast('Prescription Saved', 'Medication order created'); await refreshAll(); });
  bindForm('#nurseForm', '/api/nurse_desk/create', 'Nurse note saved', async () => { showToast('Nurse Desk', 'Nurse entry saved'); await refreshAll(); });
  bindForm('#staffForm', '/api/staff/create', 'Staff created', async () => { showToast('Staff Created', 'Team member saved'); await refreshAll(); });
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
      loadOverview(),
      loadFinance(),
      loadQueue(),
      loadTimeline(),
      loadPatients(),
      loadNotifications(),
      loadAiOverview(),
      loadRisk(),
    ]);
    state.lastSync = Date.now();
    $('#lastSyncText').textContent = fmtTime(state.lastSync);
    setLiveState(state.transport === 'SSE' ? 'Realtime Connected' : 'Connected', 'connected');
    renderAll();
  } catch (err) {
    setLiveState('Connection Error', 'error');
    showToast('Refresh Failed', err.message || 'Unable to load portal data');
  }
}

async function loadOverview() { state.data.overview = await api('/api/portal/overview'); }
async function loadFinance() { state.data.finance = await api('/api/portal/finance'); }
async function loadQueue() { const r = await api('/api/portal/queue'); state.data.queue = r.queue || []; return r; }
async function loadTimeline() { const r = await api(`/api/portal/timeline?days=${state.timelineDays}`); state.data.timeline = r.timeline || []; return r; }
async function loadPatients() { const r = await api('/api/portal/patients'); state.data.patients = r.patients || []; return r; }
async function loadNotifications() { const r = await api('/api/notifications?limit=20'); state.data.notifications = r.notifications || []; return r; }
async function loadAiOverview() { state.data.aiOverview = await api('/api/ai/clinic_overview'); }
async function loadRisk() { state.data.risk = await api('/api/ai/risk_analysis'); }
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
          <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
        </div>
      </div>
    `).join('');
    $$('[data-ai]', host).forEach(btn => btn.addEventListener('click', () => loadPatientAi(btn.dataset.ai)));
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
  renderDoctorBars();
  renderAnalyticsPanels();
  renderPatients();
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
    await refreshAll();
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
  const doctors = getDoctorWorkload();
  $('#doctors').innerHTML = doctors.length ? doctors.slice(0, 6).map(d => metricBar(d.doctorName || 'Doctor', num(d.count), Math.max(...doctors.map(x => num(x.count)), 1))).join('') : `<div class="emptyState">Doctor workload will appear here after visits or queue records.</div>`;
}

function renderRealtimeBoard() {
  const o = state.data.overview?.overview || {};
  const n = state.data.notifications || [];
  const signal = state.transport === 'SSE' ? 'Live stream active' : 'Polling fallback active';
  $('#realtimeBoard').innerHTML = [
    miniPanel('Connection', $('#livePill').textContent),
    miniPanel('Transport', signal),
    miniPanel('Last event', n[0] ? `${escapeHtml(n[0].title || n[0].type || 'Activity')} • ${fmtTime(n[0].createdAt)}` : 'No event yet'),
    miniPanel('Operational pressure', `${num(o.queue)} queue • ${money(state.data.finance?.finance?.outstanding)} outstanding`),
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
  $('#workflowBenchmarks').innerHTML = [
    metricRow('Patient registry strength', num(o.patients), 'Registered patient footprint'),
    metricRow('Clinical throughput', num(o.visits), 'Visits handled in the current dataset'),
    metricRow('Queue intensity', num(o.queue), 'Open doctor queue count'),
    metricRow('Admissions active', num(o.admissions), 'Bed-side and inpatient activity'),
  ].join('');
  $('#analyticsSignals').innerHTML = notifications.slice(0, 6).map(n => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(n.title || n.type || 'Signal')}</div><div>${escapeHtml(n.message || '--')}</div></div>`).join('') || `<div class="emptyState">Realtime signals will show after events start flowing.</div>`;
  $('#boardSummary').innerHTML = [
    miniPanel('Executive summary', escapeHtml(state.data.aiOverview?.summary || 'Analytics summary will appear here.')),
    miniPanel('Billing insight', `${money(f.totalPaid)} collected out of ${money(f.totalBill)} total billed.`),
    miniPanel('Queue insight', num(o.queue) > 5 ? 'Doctor queue is under pressure. Consider load balancing.' : 'Queue pressure is under control.'),
    miniPanel('Operations pulse', `${num(o.patients)} patients • ${num(o.visits)} visits • ${num(o.bills)} bills.`),
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
        <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
      </div>
    </div>
  `).join('') : `<div class="emptyState">No patients registered yet.</div>`;
  $$('[data-ai]', $('#patientsList')).forEach(btn => btn.addEventListener('click', () => { switchTab('search'); loadPatientAi(btn.dataset.ai); $('#searchInput').value = btn.dataset.ai; }));
  $$('[data-bill]', $('#patientsList')).forEach(btn => btn.addEventListener('click', () => openBillModal(btn.dataset.bill, btn.dataset.name)));
}

function renderSideSummary() {
  const o = state.data.overview?.overview || {};
  const f = state.data.finance?.finance || {};
  $('#sideSummary').innerHTML = [
    miniPanel('Connection', $('#livePill').textContent),
    miniPanel('Patients', `${num(o.patients)} registered`),
    miniPanel('Queue', `${num(o.queue)} open items`),
    miniPanel('Revenue', `${money(f.totalPaid)} collected`),
  ].join('');
}

function openPatientModal() {
  toggleFab(false);
  const sourceForm = $('#patientForm');
  if (!sourceForm) return;
  const clone = sourceForm.cloneNode(true);
  clone.id = 'patientModalForm';
  showModal('Patient Registration', clone.outerHTML);
  bindForm('#patientModalForm', '/api/patient/register', 'Patient registered', async (res) => {
    closeModal();
    showToast('Patient Saved', res?.patient?.fullName || 'Patient registration completed');
    await refreshAll();
  });
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
    showToast('Bill Created', `${res?.bill?.serviceName || 'Service'} billing saved`);
    await refreshAll();
  });
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
      $('#realtimeText').textContent = 'Streaming';
      setLiveState('Realtime Connected', 'connected');
    };
    state.sse.onmessage = (e) => handleRealtimeEvent(e.data);
    state.sse.addEventListener('hello', () => {
      state.transport = 'SSE';
      $('#transportText').textContent = 'SSE Live';
      $('#realtimeText').textContent = 'Streaming';
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

function handleRealtimeEvent(raw) {
  state.lastSync = Date.now();
  $('#lastSyncText').textContent = fmtTime(state.lastSync);
  let event = null;
  try { event = JSON.parse(raw); } catch {}
  const type = String(event?.type || event?.event || '').toLowerCase();
  if (type) {
    showToast('Realtime Update', event.title || event.message || type);
  }
  // safest path: lightweight schedule instead of immediate full refresh bursts
  scheduleRefresh(type.includes('queue') ? 200 : 500);
}

function scheduleRefresh(delay = 400) {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => refreshAll(), delay);
}

function fallbackPolling() {
  state.transport = 'Polling';
  $('#transportText').textContent = 'Polling';
  $('#realtimeText').textContent = 'Fallback';
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
