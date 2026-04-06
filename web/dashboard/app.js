const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const state = {
  baseUrl: localStorage.getItem('clinicPortalBaseUrl') || location.origin,
  hospitalId: localStorage.getItem('clinicPortalHospitalId') || '',
  authToken: localStorage.getItem('clinicPortalToken') || sessionStorage.getItem('clinicPortalToken') || '',
  transport: 'Polling',
  lastSync: 0,
  sse: null,
  poller: null,
  refreshTimer: null,
  searchTimer: null,
  searchSeq: 0,
  lastSearchQuery: '',
  timelineDays: Number(localStorage.getItem('clinicPortalTimelineDays') || 14),
  currentTab: 'overview',
  live: null,
  version: 0,
  sidebarCollapsed: localStorage.getItem('clinicPortalSidebarCollapsed') === '1',
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
    rbac: null,
    auditTrail: null,
    financialIntelligence: null,
    inventoryIntelligence: null,
  },
  selectedPatient: null,
  selectedPatientProfile: null
};

window.addEventListener('DOMContentLoaded', init);

function init() {
  $('#baseUrl').value = state.baseUrl;
  $('#hospitalId').value = state.hospitalId;
  if ($('#accessToken')) $('#accessToken').value = state.authToken;
  $('#timelineDays').value = String(state.timelineDays);
  bindUI();
  bindKeyboardShortcuts();
  applySidebarState();
  applyRouteState();
  tickClock();
  setInterval(tickClock, 1000);
  if (state.hospitalId) connect();
  else renderDisconnected();
}

function bindUI() {
  $('#connectBtn').addEventListener('click', connect);
  $('#sidebarCollapseBtn')?.addEventListener('click', () => toggleSidebarCollapsed());
  $('#sidebarToggleMobile')?.addEventListener('click', () => setMobileSidebar(true));
  $('#sidebarBackdrop')?.addEventListener('click', () => setMobileSidebar(false));
  window.addEventListener('resize', handleResponsiveSidebar);
  $('#refreshBtn').addEventListener('click', refreshAll);
  $('#manualFeedBtn').addEventListener('click', loadNotificationsAndRender);
  $('#timelineDays').addEventListener('change', async (e) => {
    state.timelineDays = Number(e.target.value || 14);
    localStorage.setItem('clinicPortalTimelineDays', String(state.timelineDays));
    await loadTimeline();
    renderAnalytics();
  });
  $('#searchBtn').addEventListener('click', () => runSearch({ immediate: true, source: 'button' }));
  $('#searchInput').addEventListener('input', () => scheduleInstantSearch());
  $('#searchInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      runSearch({ immediate: true, source: 'enter' });
    }
  });

  $$('.navBtn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab, true)));
  $('#quickPatientBtn').addEventListener('click', openPatientWizard);
  $('#quickBillBtn').addEventListener('click', () => openBillModal());
  $('#quickVisitBtn').addEventListener('click', () => switchTab('workflow'));
  $('#quickQueueBtn').addEventListener('click', () => switchTab('operations'));
  $('#railVisitBtn').addEventListener('click', () => switchTab('workflow'));
  $('#railSearchBtn').addEventListener('click', () => switchTab('search'));
  $('#patientsOpenSearchBtn')?.addEventListener('click', () => switchTab('search'));
  $('#spotlightSearchBtn')?.addEventListener('click', () => switchTab('search', true));
  $('#patientsRefreshHubBtn')?.addEventListener('click', refreshAll);
  $('#smartNavPatients')?.addEventListener('click', () => switchTab('patients', true));
  $('#smartNavWorkflow')?.addEventListener('click', () => switchTab('workflow', true));
  $('#smartNavSearch')?.addEventListener('click', () => switchTab('search', true));
  $('#smartRefreshBtn')?.addEventListener('click', refreshAll);
  $('#smartNewPatientBtn')?.addEventListener('click', openPatientWizard);
  $('#smartNewBillBtn')?.addEventListener('click', () => openBillModal());
  $$('.speedJumpBtn').forEach(btn => btn.addEventListener('click', () => jumpToWorkflowTarget(btn.dataset.jumpTarget)));
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
    const savedPatient = normalizePatientRecord(res?.patient || {});
    showToast('Patient Saved', savedPatient.fullName || savedPatient.patientName || 'Patient registration completed');
    await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']);
    if (savedPatient.patientId) {
      setSelectedPatient(savedPatient, { openDrawer: true, switchToPatients: true });
    }
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
  bindForm('#admissionForm', '/api/admission/create', 'Admission created', async () => { showToast('Admission Saved', 'Ward admission created'); await targetedRealtimeRefresh(['patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff','audit_logs']); });
  bindForm('#pharmacyDispenseForm', '/api/pharmacy/dispense', 'Drug dispensed', async () => { showToast('Pharmacy Dispense', 'Medication dispensed successfully'); await targetedRealtimeRefresh(['patients','bills','pharmacy_dispenses','audit_logs']); });
  bindForm('#stockItemForm', '/api/pharmacy/items/upsert', 'Stock item saved', async () => { showToast('Stock Item', 'Pharmacy item master saved'); await targetedRealtimeRefresh(['pharmacy_items','pharmacy_receipts','audit_logs']); await loadInventoryIntelligence(); renderAnalytics(); });
  bindForm('#supplierForm', '/api/pharmacy/suppliers/upsert', 'Supplier saved', async () => { showToast('Supplier Saved', 'Supplier record updated'); await targetedRealtimeRefresh(['pharmacy_receipts','audit_logs']); await loadInventoryIntelligence(); renderAnalytics(); });
  bindForm('#purchaseReceiptForm', '/api/pharmacy/purchases/receive', 'Purchase receipt posted', async () => { showToast('Purchase Receipt', 'Stock received successfully'); await targetedRealtimeRefresh(['pharmacy_items','pharmacy_receipts','audit_logs']); await Promise.all([loadFinancialIntelligence(), loadInventoryIntelligence()]); renderAnalytics(); });
  bindForm('#stockMovementForm', '/api/pharmacy/movements/create', 'Stock movement logged', async () => { showToast('Stock Movement', 'Inventory movement recorded'); await targetedRealtimeRefresh(['pharmacy_items','pharmacy_receipts','audit_logs']); await loadInventoryIntelligence(); renderAnalytics(); });
  bindForm('#dischargeForm', '/api/discharge/create', 'Discharge completed', async () => { showToast('Discharge Workflow', 'Patient discharge completed'); await targetedRealtimeRefresh(['patients','admissions','audit_logs']); });
  bindForm('#refundForm', '/api/payment/refund', 'Refund processed', async () => { showToast('Refund Processed', 'Billing refund saved'); await targetedRealtimeRefresh(['bills','audit_logs']); });
  bindForm('#theatreForm', '/api/theatre/schedule', 'Procedure scheduled', async () => { showToast('Theatre Scheduled', 'Procedure schedule saved'); await targetedRealtimeRefresh(['appointments','audit_logs']); });
}


function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toLowerCase();
    const editing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable;
    if ((e.key === '/' || ((e.key || '').toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) && !editing) {
      e.preventDefault();
      switchTab('search', true);
      $('#searchInput')?.focus();
      return;
    }
    if (editing || e.altKey || e.ctrlKey || e.metaKey) return;
    const key = (e.key || '').toLowerCase();
    if (key === 'n') {
      e.preventDefault();
      openPatientWizard();
    } else if (key === 'b') {
      e.preventDefault();
      if (state.selectedPatient?.patientId) openBillModal(state.selectedPatient.patientId, state.selectedPatient.fullName || state.selectedPatient.patientName || '');
      else switchTab('workflow', true);
    } else if (key === 'v') {
      e.preventDefault();
      goToPatientAction('visit');
    } else if (key === 'l') {
      e.preventDefault();
      goToPatientAction('lab');
    } else if (key === 'r') {
      e.preventDefault();
      refreshAll();
    }
  });
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

function switchTab(tab, pushHash = false) {
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
  document.getElementById('focusChipMode').textContent = {
    overview: 'Executive Overview',
    operations: 'Operations Board',
    analytics: 'Analytics Suite',
    patients: 'Patients Desk',
    workflow: 'Workflow Workspace',
    search: 'Patient Search'
  }[tab] || 'Executive Overview';
  document.getElementById('focusChipMode').classList.add('active');
  if (pushHash) history.replaceState(null, '', `#${tab}`);
  setMobileSidebar(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
}


function applySidebarState() {
  document.body.classList.toggle('sidebar-collapsed', !!state.sidebarCollapsed);
  const btn = document.getElementById('sidebarCollapseBtn');
  if (btn) btn.textContent = state.sidebarCollapsed ? '»' : '☰';
}

function toggleSidebarCollapsed(force) {
  state.sidebarCollapsed = typeof force === 'boolean' ? force : !state.sidebarCollapsed;
  localStorage.setItem('clinicPortalSidebarCollapsed', state.sidebarCollapsed ? '1' : '0');
  applySidebarState();
}

function setMobileSidebar(open) {
  document.body.classList.toggle('sidebar-open-mobile', !!open);
}

function handleResponsiveSidebar() {
  if (window.innerWidth > 1100) setMobileSidebar(false);
}

function applyRouteState() {
  const tab = (location.hash || '').replace('#', '').trim();
  if (tab && document.getElementById(`tab-${tab}`)) {
    switchTab(tab, false);
  } else {
    switchTab(state.currentTab || 'overview', false);
  }
}

window.addEventListener('hashchange', () => applyRouteState());

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  if (raw.startsWith('//')) return `${location.protocol}${raw}`.replace(/\/$/, '');
  if (raw.startsWith('/')) return `${location.origin}${raw}`.replace(/\/$/, '');
  if (/^[a-z0-9.-]+(?::\d+)?(?:\/.*)?$/i.test(raw)) return `https://${raw}`.replace(/\/$/, '');
  return raw.replace(/\/$/, '');
}

function buildUrl(path) {
  const cleanPath = String(path || '').startsWith('/') ? String(path) : `/${String(path || '')}`;
  const base = normalizeBaseUrl(state.baseUrl || location.origin) || location.origin;
  try {
    return new URL(cleanPath, `${base}/`).toString();
  } catch {
    return `${base}${cleanPath}`;
  }
}

function getAuthHeaders(extra = {}) {
  const headers = { 'X-Hospital-Id': state.hospitalId, ...extra };
  if (state.authToken) headers.Authorization = `Bearer ${state.authToken}`;
  return headers;
}

function connect() {
  state.baseUrl = normalizeBaseUrl($('#baseUrl').value || location.origin);
  state.hospitalId = ($('#hospitalId').value || '').trim();
  state.authToken = ($('#accessToken')?.value || '').trim();
  if (!state.baseUrl || !state.hospitalId) {
    showToast('Missing Connection', 'Fill Base URL and Hospital ID first');
    renderDisconnected();
    return;
  }
  localStorage.setItem('clinicPortalBaseUrl', state.baseUrl);
  localStorage.setItem('clinicPortalHospitalId', state.hospitalId);
  if (state.authToken) {
    localStorage.setItem('clinicPortalToken', state.authToken);
    sessionStorage.setItem('clinicPortalToken', state.authToken);
  } else {
    localStorage.removeItem('clinicPortalToken');
    sessionStorage.removeItem('clinicPortalToken');
  }
  $('#spotHospital').textContent = state.hospitalId;
  document.getElementById('focusChipHospital').textContent = `Hospital ${state.hospitalId}`;
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
  document.getElementById('focusChipTransport').textContent = `Realtime ${state.transport}`;
  $('#realtimeText').textContent = 'Idle';
  document.getElementById('focusChipHospital').textContent = 'Hospital --';
  document.getElementById('focusChipSync').textContent = 'Last Sync --';
  $('#sideSummary').innerHTML = `<div class="miniPanel"><div class="itemTitle">Status</div><div>Connect Base URL and Hospital ID to start live command mode.</div></div>`;
  $('#kpiGrid').innerHTML = Array.from({ length: 8 }).map((_, i) => `
    <div class="kpiCard">
      <div class="kpiLabel">Metric ${i + 1}</div>
      <div class="kpiValue">--</div>
      <div class="kpiSub">Connect portal to load live analytics</div>
    </div>`).join('');
  ['revenueChart', 'mixChart', 'operationsChart'].forEach(id => renderEmptyChart(id, 'Connect the portal to load analytics'));
  ['activityFeed','alerts','queue','finance','doctors','realtimeBoard','doctorBars','financeBreakdown','workflowBenchmarks','analyticsSignals','boardSummary','patientsList','searchResults','patientAiSummary','queueBoard','accessControlGrid','auditTrailGrid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = `<div class="emptyState">Connect Base URL and Hospital ID to start live dashboard.</div>`;
  });
}

async function refreshAll() {
  if (!state.baseUrl || !state.hospitalId) return renderDisconnected();
  try {
    await loadLiteBundle(['live','overview','finance','queue','timeline','patients','notifications','aiOverview','risk','commandCenter','doctorWidgets','workspace','clinicalOps','financialIntelligence','inventoryIntelligence']);
    await Promise.allSettled([loadRbac(), loadAuditTrail()]);
    state.lastSync = Date.now();
    $('#lastSyncText').textContent = fmtTime(state.lastSync);
    document.getElementById('focusChipSync').textContent = `Last Sync ${fmtTime(state.lastSync)}`;
    document.getElementById('focusChipTransport').textContent = `Realtime ${state.transport}`;
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
async function loadClinicalOps() { const r = await api('/api/portal/clinical-ops'); state.data.clinicalOps = r?.modules || null; return r; }
async function loadFinancialIntelligence() { const r = await api('/api/portal/financial-intelligence'); state.data.financialIntelligence = r?.intelligence || null; return r; }
async function loadInventoryIntelligence() { const r = await api('/api/portal/inventory-intelligence'); state.data.inventoryIntelligence = r?.intelligence || null; return r; }
async function loadRbac() { const r = await api('/api/rbac/overview'); state.data.rbac = r || null; return r; }
async function loadAuditTrail() { const r = await api('/api/audit/trail?limit=80'); state.data.auditTrail = r || null; return r; }

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
  if (bundle.workspace) state.data.workspace = bundle.workspace.workspace || bundle.workspace;
  if (bundle.clinicalOps) state.data.clinicalOps = bundle.clinicalOps.modules || bundle.clinicalOps;
  if (bundle.financialIntelligence) state.data.financialIntelligence = bundle.financialIntelligence.intelligence || bundle.financialIntelligence;
  if (bundle.inventoryIntelligence) state.data.inventoryIntelligence = bundle.inventoryIntelligence.intelligence || bundle.inventoryIntelligence;
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

function clearSearchResults(message = 'Start typing to search patients instantly.') {
  const host = $('#searchResults');
  if (host) host.innerHTML = `<div class="emptyState">${escapeHtml(message)}</div>`;
  renderSearchActionDock([], '');
}

function scheduleInstantSearch() {
  const q = ($('#searchInput').value || '').trim();
  clearTimeout(state.searchTimer);
  if (!q) {
    state.lastSearchQuery = '';
    clearSearchResults('Start typing patient ID, MRN, name, phone or email. Results will appear instantly.');
    return;
  }
  if (q.length < 2) {
    clearSearchResults('Keep typing... live patient search starts from 2 characters.');
    return;
  }
  state.searchTimer = setTimeout(() => runSearch({ live: true, source: 'typing' }), 180);
}

async function runSearch(opts = {}) {
  const { live = false, immediate = false } = opts;
  const q = ($('#searchInput').value || '').trim();
  if (!q) {
    clearSearchResults('Start typing patient ID, MRN, name, phone or email. Results will appear instantly.');
    return;
  }
  if (q.length < 2 && !immediate) {
    clearSearchResults('Keep typing... live patient search starts from 2 characters.');
    return;
  }
  if (live && q === state.lastSearchQuery) return;
  const seq = ++state.searchSeq;
  state.lastSearchQuery = q;
  const host = $('#searchResults');
  if (host && live) host.innerHTML = `<div class="emptyState">Searching <strong>${escapeHtml(q)}</strong>...</div>`;
  try {
    const res = await api(`/api/search/patient?q=${encodeURIComponent(q)}`);
    if (seq !== state.searchSeq) return;
    const items = res.patients || [];
    if (!items.length) {
      host.innerHTML = `<div class="emptyState">No patient matched <strong>${escapeHtml(q)}</strong>.</div>`;
      renderSearchActionDock([], q);
      $('#patientAiSummary').innerHTML = `<div class="emptyState">Select a patient to see AI summary.</div>`;
      return;
    }
    host.innerHTML = `
      <div class="searchSummaryBar"><div><strong>${items.length}</strong> patient result(s) found for <strong>${escapeHtml(q)}</strong></div><div class="row gap8"><span class="badge">Instant Search</span><span class="badge">Profile Drawer</span></div></div>
      ${items.map(p => {
        const name = escapeHtml(p.fullName || p.patientName || 'Unnamed Patient');
        const pid = escapeHtml(p.patientId || '--');
        const initials = escapeHtml(((p.fullName || p.patientName || 'P').split(/\s+/).slice(0,2).map(s => s[0] || '').join('') || 'P').toUpperCase());
        return `
        <div class="searchCardPremium ${String(state.selectedPatient?.patientId || '') === String(p.patientId || '') ? 'selected' : ''}">
          <div class="patientCardHead">
            <div class="patientIdentity">
              <div class="avatarOrb">${initials}</div>
              <div>
                <div class="itemTitle">${name}</div>
                <div class="patientMetaLine"><span class="metaPill">${pid}</span><span class="metaPill">${escapeHtml(p.gender || '--')}</span><span class="metaPill">${escapeHtml(String(p.age || '--'))} yrs</span></div>
              </div>
            </div>
            <span class="badge">Search Match</span>
          </div>
          <div class="itemMeta"><span>${escapeHtml(p.phone || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span><span>${escapeHtml(p.email || '--')}</span></div>
          <div class="queueActions">
            <button class="pillBtn" data-select="${escapeHtml(p.patientId || '')}">Select</button>
            <button class="pillBtn" data-ai="${escapeHtml(p.patientId || '')}">AI Summary</button>
            <button class="pillBtn" data-view="${escapeHtml(p.patientId || '')}">Profile</button>
            <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
          </div>
          <div class="patientActionRow compactSearchRow">
            ${['visit','lab','prescription','pharmacy','admission'].map(action => `<button class="patientActionMini" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${workflowActionMeta(action).title}</button>`).join('')}
          </div>
        </div>`;
      }).join('')}
    `;
    renderSearchActionDock(items, q);
    $$('[data-select]', host).forEach(btn => btn.addEventListener('click', () => { const found = items.find(x => (x.patientId || x.id) === btn.dataset.select); if (found) setSelectedPatient(found); }));
    $$('[data-ai]', host).forEach(btn => btn.addEventListener('click', () => loadPatientAi(btn.dataset.ai)));
    $$('[data-view]', host).forEach(btn => btn.addEventListener('click', () => { const found = items.find(x => (x.patientId || x.id) === btn.dataset.view); if (found) setSelectedPatient(found); openPatientDrawer(btn.dataset.view); }));
    $$('[data-bill]', host).forEach(btn => btn.addEventListener('click', () => { const found = items.find(x => (x.patientId || x.id) === btn.dataset.bill); if (found) setSelectedPatient(found); openBillModal(btn.dataset.bill, btn.dataset.name); }));
    bindPatientActionButtons(host);
    loadPatientAi(items[0].patientId);
  } catch (err) {
    if (seq !== state.searchSeq) return;
    if (!live) showToast('Search Failed', err.message || 'Unable to search patient');
    host.innerHTML = `<div class="emptyState">Unable to search patients right now.</div>`;
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
  renderWorkflowActionPanels();
  renderWorkspace();
  renderClinicalOps();
  renderCommandCenter();
  renderLiveTicker();
  renderSideSummary();
  renderExecutiveOverview();
  renderEnterpriseInsights();
  renderAccessControlAudit();
}


function getExecutiveMetrics() {
  const o = state.data.overview?.overview || {};
  const f = state.data.finance?.finance || {};
  const ws = state.data.workspace?.summary || {};
  const timeline = Array.isArray(state.data.timeline) ? state.data.timeline : [];
  const today = timeline.at(-1) || {};
  const last7 = timeline.slice(-7);
  const last30 = timeline.slice(-30);
  const doctors = getDoctorWorkload();
  const openQueue = num(ws.openQueue || o.queue || state.data.queue?.length || 0);
  const activeAdmissions = num(ws.activeAdmissions || o.admissions || 0);
  const emergencyAlerts = getEmergencyAlerts().length;
  const totalBedsEstimate = Math.max(activeAdmissions, num(state.data.live?.clinic?.branchCount || 1) * 20, 20);
  const occupiedPct = totalBedsEstimate ? Math.round((activeAdmissions / totalBedsEstimate) * 100) : 0;
  const queuePerDoctor = doctors.length ? openQueue / doctors.length : openQueue;
  const pharmacySales = num(f.pharmacySales || 0);
  return {
    totalPatients: num(o.patients || state.data.patients?.length || 0),
    activeVisits: num(ws.activeVisits || o.activeVisits || o.visits || 0),
    admissionsActive: activeAdmissions,
    revenueToday: num(today.revenuePaid || today.paid || 0),
    revenueWeek: last7.reduce((s, x) => s + num(x.revenuePaid || x.paid), 0),
    revenueMonth: last30.reduce((s, x) => s + num(x.revenuePaid || x.paid), 0),
    outstanding: num(f.outstanding || o.outstanding || 0),
    labPending: num(ws.pendingLabs || o.lab || 0),
    pharmacySales,
    queuePerDoctor,
    queuePerDoctorLabel: doctors.length ? `${queuePerDoctor.toFixed(1)} avg` : `${openQueue} open`,
    bedOccupancyPct: occupiedPct,
    bedOccupancyLabel: activeAdmissions ? `${occupiedPct}% est.` : '0% est.',
    emergencyAlerts,
    totalBedsEstimate,
    systemStatus: getSystemStatus(),
    forecastRevenue: estimateForecastRevenue(timeline),
  };
}

function getSystemStatus() {
  const lagMs = state.lastSync ? Math.max(0, Date.now() - state.lastSync) : 0;
  const lagMin = Math.round(lagMs / 60000);
  const transport = state.transport === 'SSE' ? 'Cloud Online' : (state.hospitalId ? 'Polling Fallback' : 'Offline');
  const syncHealth = !state.hospitalId ? 'Disconnected' : !state.lastSync ? 'Connecting' : lagMin <= 1 ? 'Healthy' : lagMin <= 5 ? 'Watch' : 'Needs Attention';
  return {
    cloud: transport,
    syncHealth,
    lastSyncLabel: state.lastSync ? new Date(state.lastSync).toLocaleString() : '--',
    backupLabel: state.data.live?.lastSnapshotAt ? fmtDateTime(state.data.live.lastSnapshotAt) : 'Not exposed',
    transport: state.transport || 'Polling'
  };
}

function getEmergencyAlerts() {
  const alerts = Array.isArray(state.data.aiOverview?.alerts) ? state.data.aiOverview.alerts : [];
  const critical = alerts.filter(a => ['critical', 'urgent', 'high'].includes(String(a.severity || '').toLowerCase()));
  const risk = state.data.risk?.risks || {};
  const queuePressure = num(risk.queue_pressure?.score || 0) >= 70 ? [{ type: 'Queue', severity: 'high', message: `${num(risk.queue_pressure?.openQueue)} open queue items` }] : [];
  const unpaid = num(risk.unpaid_bill_detection?.score || 0) >= 70 ? [{ type: 'Collections', severity: 'high', message: `Outstanding ${money(risk.unpaid_bill_detection?.outstanding || 0)}` }] : [];
  return [...critical, ...queuePressure, ...unpaid];
}

function estimateForecastRevenue(timeline = []) {
  const paidSeries = timeline.map(x => num(x.revenuePaid || x.paid)).filter(v => v > 0);
  if (!paidSeries.length) return 0;
  const recent = paidSeries.slice(-7);
  const avg = recent.reduce((s, x) => s + x, 0) / recent.length;
  return Math.round(avg * 30 * 100) / 100;
}

function buildDepartmentRanking() {
  const ws = state.data.workspace?.summary || {};
  const f = state.data.finance?.finance || {};
  const list = [
    { label: 'Revenue Desk', score: num(f.totalPaid), sub: `${money(f.totalPaid)} collected` },
    { label: 'Pharmacy', score: num(f.pharmacySales || 0) || num(ws.activePrescriptions || 0), sub: `${num(ws.activePrescriptions || 0)} active prescriptions` },
    { label: 'Lab', score: Math.max(0, 100 - (num(ws.pendingLabs || 0) * 8)), sub: `${num(ws.pendingLabs || 0)} pending labs` },
    { label: 'Admissions', score: num(ws.activeAdmissions || 0) * 10, sub: `${num(ws.activeAdmissions || 0)} active admissions` },
    { label: 'Front Desk', score: num(state.data.overview?.overview?.patients || 0), sub: `${num(state.data.overview?.overview?.patients || 0)} patient records` },
  ];
  return list.sort((a, b) => num(b.score) - num(a.score));
}

function buildStaffProductivity() {
  const ws = state.data.workspace?.summary || {};
  const doctors = getDoctorWorkload();
  const activeStaff = Math.max(1, num(ws.staffOnlineReady || 0));
  const activeVisits = num(ws.activeVisits || state.data.overview?.overview?.visits || 0);
  const queueServed = doctors.reduce((s, d) => s + num(d.servedCount || 0), 0);
  return {
    activeStaff,
    visitsPerStaff: activeVisits / activeStaff,
    servedPerDoctor: doctors.length ? queueServed / doctors.length : 0,
    staffReady: activeStaff,
    queueServed,
  };
}

function buildPeakHoursInsight() {
  const rows = [
    ...(state.data.queue || []).map(x => x.createdAt || x.updatedAt),
    ...(state.data.notifications || []).map(x => x.createdAt),
    ...((state.data.workspace?.careTimeline || []).map(x => x.createdAt))
  ].map(v => Number(v)).filter(Boolean);
  if (!rows.length) return { peak: '--', bottleneck: 'Waiting for more activity data', byHour: [] };
  const hours = new Map();
  rows.forEach(ts => {
    const h = new Date(ts).getHours();
    hours.set(h, (hours.get(h) || 0) + 1);
  });
  const sorted = Array.from(hours.entries()).sort((a,b)=>b[1]-a[1]);
  const [hour,count] = sorted[0];
  const queueOpen = num(state.data.workspace?.summary?.openQueue || state.data.overview?.overview?.queue || 0);
  return {
    peak: `${String(hour).padStart(2, '0')}:00`,
    bottleneck: queueOpen >= 8 ? 'Doctor queue congestion' : num(state.data.workspace?.summary?.pendingLabs || 0) >= 5 ? 'Laboratory backlog' : 'No major bottleneck',
    byHour: sorted.slice(0,4)
  };
}

function buildRiskTrendInsight() {
  const risk = state.data.risk?.risks || {};
  const aiAlerts = Array.isArray(state.data.aiOverview?.alerts) ? state.data.aiOverview.alerts : [];
  const readmissionProxy = state.data.patients?.filter?.(p => num(p.visitCount || 0) > 1).length || 0;
  const score = Math.max(num(risk.queue_pressure?.score || 0), num(risk.unpaid_bill_detection?.score || 0), num(risk.pharmacy_stock_warning?.score || 0));
  return {
    riskScore: score,
    readmissionProxy,
    trend: score >= 70 || aiAlerts.some(a => ['critical','urgent','high'].includes(String(a.severity || '').toLowerCase())) ? 'High Watch' : score >= 40 ? 'Moderate Watch' : 'Stable',
  };
}

function buildBranchComparison() {
  const patients = Array.isArray(state.data.patients) ? state.data.patients : [];
  const groups = new Map();
  patients.forEach(p => {
    const key = p.branchName || p.branch || p.branchId || 'Main Branch';
    if (!groups.has(key)) groups.set(key, { label: key, patients: 0, activity: 0 });
    const row = groups.get(key);
    row.patients += 1;
    row.activity += num(p.createdAt || p.updatedAt ? 1 : 0);
  });
  const out = Array.from(groups.values()).sort((a,b)=>b.patients-a.patients);
  return out.length > 1 ? out : [];
}

function renderExecutiveOverview() {
  const host = $('#executiveOverviewGrid');
  if (!host) return;
  const m = getExecutiveMetrics();
  const sys = m.systemStatus;
  const dept = buildDepartmentRanking();
  const alerts = getEmergencyAlerts();
  host.innerHTML = `
    <div class="glassInnerCard">
      <div class="itemTitle">System Status</div>
      ${metricRow('Cloud', sys.cloud, `${sys.transport} transport`)}
      ${metricRow('Sync Health', sys.syncHealth, `Last sync ${sys.lastSyncLabel}`)}
      ${metricRow('Last Backup', sys.backupLabel, 'Using last snapshot timestamp exposed by server')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Revenue Windows</div>
      ${metricRow('Today', money(m.revenueToday), 'Collections captured today')}
      ${metricRow('This Week', money(m.revenueWeek), '7-day aggregate')}
      ${metricRow('This Month', money(m.revenueMonth), '30-day aggregate')}
      ${metricRow('Forecast Revenue', money(m.forecastRevenue), 'Projected next 30 days from recent trend')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Capacity and Alerts</div>
      ${metricRow('Admissions Active', num(m.admissionsActive), 'Beds currently occupied by active admissions')}
      ${metricRow('Bed Occupancy', m.bedOccupancyLabel, `${num(m.admissionsActive)} active beds out of est. ${num(m.totalBedsEstimate)}`)}
      ${metricRow('Emergency Alerts', num(m.emergencyAlerts), alerts.length ? alerts.slice(0,2).map(a => a.type).join(' • ') : 'No urgent signal detected')}
      ${metricRow('Lab Pending', num(m.labPending), 'Pending laboratory operations')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Department Performance Ranking</div>
      <div class="stack10">
        ${dept.slice(0,5).map((d, i) => `<div class="metricRow"><div class="row alignCenter" style="justify-content:space-between"><div class="itemTitle">#${i+1} ${escapeHtml(d.label)}</div><strong>${escapeHtml(String(Math.round(num(d.score))))}</strong></div><div class="itemMeta"><span>${escapeHtml(d.sub)}</span></div></div>`).join('')}
      </div>
    </div>`;
}

function renderEnterpriseInsights() {
  const host = $('#enterpriseInsightsGrid');
  if (!host) return;
  const m = getExecutiveMetrics();
  const prod = buildStaffProductivity();
  const peak = buildPeakHoursInsight();
  const risk = buildRiskTrendInsight();
  const branches = buildBranchComparison();
  host.innerHTML = `
    <div class="glassInnerCard">
      <div class="itemTitle">Forecast Revenue</div>
      ${metricRow('Next 30 Days', money(m.forecastRevenue), 'Trend based on recent paid revenue performance')}
      ${metricRow('Queue per Doctor', m.queuePerDoctorLabel, 'Used to anticipate doctor-side congestion')}
      ${metricRow('Outstanding Exposure', money(m.outstanding), 'Collections risk still in the pipeline')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Staff Productivity</div>
      ${metricRow('Staff Ready', num(prod.staffReady), 'Currently active team members')}
      ${metricRow('Visits per Staff', prod.visitsPerStaff.toFixed(1), 'Active visits divided by ready staff')}
      ${metricRow('Served per Doctor', prod.servedPerDoctor.toFixed(1), 'Average served queue load by doctor')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Peak Hours / Bottlenecks</div>
      ${metricRow('Peak Hour', peak.peak, 'Busiest observed hour from recent activity')}
      ${metricRow('Bottleneck', peak.bottleneck, 'Primary operational pressure now')}
      ${metricRow('Top Activity Slots', peak.byHour.map(([h,c]) => `${String(h).padStart(2,'0')}:00(${c})`).join(' • ') || '--', 'Recent event concentration')}
    </div>
    <div class="glassInnerCard">
      <div class="itemTitle">Readmission / Risk Trend</div>
      ${metricRow('Risk Trend', risk.trend, `Composite risk score ${num(risk.riskScore)}`)}
      ${metricRow('Readmission Proxy', num(risk.readmissionProxy), 'Patients showing repeated-touch proxy from loaded records')}
      ${metricRow('AI Watch', num(getEmergencyAlerts().length), 'Urgent AI or workflow warnings')}
    </div>
    <div class="glassInnerCard spanWide">
      <div class="itemTitle">Branch Comparison</div>
      ${branches.length ? `<div class="summaryGrid">${branches.slice(0,6).map(b => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(b.label)}</div><div style="font-size:24px;font-weight:900">${num(b.patients)}</div><div class="itemMeta"><span>${num(b.activity)} observed activities</span></div></div>`).join('')}</div>` : `<div class="emptyState">Branch comparison will appear automatically when multiple branches are exposed in portal patient records.</div>`}
    </div>`;
}

function renderKpis() {
  const metrics = getExecutiveMetrics();
  const kpis = [
    ['Total Patients', num(metrics.totalPatients), 'Registered patient base'],
    ['Active Visits', num(metrics.activeVisits), 'Clinical load in motion'],
    ['Admissions Active', num(metrics.admissionsActive), 'Current inpatient operations'],
    ['Revenue Today', money(metrics.revenueToday), 'Collections captured today'],
    ['Revenue This Week', money(metrics.revenueWeek), '7-day cashflow pulse'],
    ['Revenue This Month', money(metrics.revenueMonth), '30-day billing momentum'],
    ['Outstanding Payments', money(metrics.outstanding), 'Pending settlement exposure'],
    ['Lab Pending', num(metrics.labPending), 'Pending laboratory workload'],
    ['Pharmacy Sales', money(metrics.pharmacySales), 'Pharmacy contribution'],
    ['Queue / Doctor', metrics.queuePerDoctorLabel, 'Average open queue pressure'],
    ['Bed Occupancy', metrics.bedOccupancyLabel, 'Estimated from active admissions'],
    ['Emergency Alerts', num(metrics.emergencyAlerts), 'Urgent or critical signals'],
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

function formatActivityType(type = '') {
  const value = String(type || '').trim().toLowerCase();
  if (!value) return 'Activity';
  const labels = {
    patient_registered: 'New patient registered',
    bill_created: 'Bill created',
    payment_received: 'Payment received',
    payment_refund: 'Refund processed',
    lab_sample_collected: 'Lab sample collected',
    lab_request_created: 'Lab order created',
    lab_request_updated: 'Result ready / lab updated',
    drug_dispensed: 'Drug dispensed',
    admission_created: 'Admission created',
    discharge_created: 'Patient discharged',
    doctor_queue_created: 'Doctor queue updated',
    doctor_queue_updated: 'Doctor queue changed',
    prescription_created: 'Prescription tracked',
    prescription_updated: 'Prescription updated',
    sync: 'System sync update',
    restore: 'Backup restore alert',
    printer_issue: 'Printer issue',
    failed_sync: 'Failed sync',
    stock_low: 'Stock low',
    stock_expired: 'Expired stock'
  };
  return labels[value] || value.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function activityTone(type = '') {
  const value = String(type || '').toLowerCase();
  if (/(failed_sync|printer_issue|system_alert|error|critical|expired|stock_low)/.test(value)) return 'danger';
  if (/(refund|discharge|lab_request_updated|payment_received)/.test(value)) return 'warn';
  if (/(patient_registered|bill_created|drug_dispensed|admission_created|doctor_queue|visit_created|prescription|appointment)/.test(value)) return 'success';
  return 'normal';
}

function getActivityFeedItems() {
  const notifications = Array.isArray(state.data.notifications) ? state.data.notifications : [];
  const liveChanges = Array.isArray(state.data.live?.recentChanges) ? state.data.live.recentChanges : [];
  const synthesized = liveChanges.map(item => ({
    id: `live_${item.version || ''}_${item.type || ''}_${item.createdAt || ''}`,
    type: item.type || 'update',
    title: formatActivityType(item.type),
    message: item.message || item.payload?.message || item.payload?.patientName || item.payload?.itemName || 'Realtime dashboard update received.',
    createdAt: item.createdAt || Date.now(),
    actor: item.payload?.actor || item.actor || 'system'
  }));
  return [...notifications, ...synthesized]
    .filter(Boolean)
    .sort((a, b) => num(b.createdAt) - num(a.createdAt))
    .filter((item, index, arr) => arr.findIndex(x => String(x.id || `${x.type}_${x.createdAt}_${x.message}`) === String(item.id || `${item.type}_${item.createdAt}_${item.message}`)) === index)
    .slice(0, 20);
}

function pushRealtimeNotification(event) {
  if (!event) return;
  const payload = event.payload || {};
  const type = String(event.type || event.event || 'update').toLowerCase();
  const incoming = {
    id: event.id || `evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type,
    title: event.title || formatActivityType(type),
    message: event.message || payload.message || payload.patientName || payload.itemName || 'Realtime activity received.',
    createdAt: num(event.createdAt || Date.now()),
    actor: payload.actor || event.actor || payload.by || 'system',
    payload
  };
  const existing = Array.isArray(state.data.notifications) ? state.data.notifications.slice() : [];
  state.data.notifications = [incoming, ...existing]
    .filter((item, index, arr) => arr.findIndex(x => String(x.id) === String(item.id)) === index)
    .sort((a, b) => num(b.createdAt) - num(a.createdAt))
    .slice(0, 20);
}

function renderFeed() {
  const items = getActivityFeedItems();
  $('#activityFeed').innerHTML = items.length ? items.map(n => `
    <div class="feedItem">
      <div class="row alignCenter" style="justify-content:space-between">
        <div class="itemTitle">${escapeHtml(n.title || formatActivityType(n.type) || 'Activity')}</div>
        <span class="feedType ${activityTone(n.type)}">${escapeHtml(formatActivityType(n.type || 'event'))}</span>
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
  const billCount = num(f.billCount || state.data.overview?.overview?.bills || 0);
  const avgCollection = billCount ? money(paid / Math.max(billCount, 1)) : money(0);
  document.getElementById('opsRibbonBilling') && (document.getElementById('opsRibbonBilling').textContent = outstanding > paid ? 'Collections Attention' : 'Collections Ready');
  $('#finance').innerHTML = `
    <div class="opsExecutiveGrid">
      <div class="execMiniCard"><span>Collected</span><strong>${money(paid)}</strong></div>
      <div class="execMiniCard"><span>Outstanding</span><strong>${money(outstanding)}</strong></div>
      <div class="execMiniCard"><span>Avg per Bill</span><strong>${avgCollection}</strong></div>
    </div>
    ${metricBar('Total billed', paid + outstanding, total, 'Full billing volume now in the system')}
    ${metricBar('Collected', paid, total, paid >= outstanding ? 'Cashflow is leading exposure' : 'Collection is trailing exposure')}
    ${metricBar('Outstanding', outstanding, total, outstanding > 0 ? 'Pending settlement still exists' : 'No outstanding exposure')}
    ${metricBar('Pharmacy sales', num(f.pharmacySales), Math.max(total, num(f.pharmacySales), 1), 'Medication revenue contribution')}
  `;
}

function renderDoctors() {
  const widgets = state.data.doctorWidgets || {};
  const doctors = Array.isArray(widgets.doctors) && widgets.doctors.length ? widgets.doctors : getDoctorWorkload();
  const opsSummary = state.data.overview?.overview || {};
  document.getElementById('opsRibbonDoctors') && (document.getElementById('opsRibbonDoctors').textContent = doctors.some(d => num(d.queueCount || d.count || 0) >= 6) ? 'Load Pressure' : 'Balanced Load');
  document.getElementById('opsRibbonStatus') && (document.getElementById('opsRibbonStatus').textContent = num(opsSummary.queue || 0) > 6 ? 'Queue Elevated' : 'Live Control');
  if (!doctors.length) {
    $('#doctors').innerHTML = `<div class="emptyState">Doctor workload will appear here after visits or queue records.</div>`;
    return;
  }
  const maxCount = Math.max(...doctors.map(d => num(d.queueCount || d.count || d.total || 0)), 1);
  $('#doctors').innerHTML = doctors.slice(0, 8).map(d => {
    const open = num(d.queueCount || d.count || 0);
    const served = num(d.servedCount || 0);
    const avgWait = escapeHtml(String(d.avgWaitLabel || '--'));
    const intensity = open >= 7 ? 'Critical Load' : open >= 4 ? 'Moderate Load' : 'Balanced';
    const statusClass = open >= 7 ? 'urgent' : open >= 4 ? 'warn' : 'normal';
    return `
    <div class="doctorWidgetCard">
      <div class="doctorIdentityRow">
        <div class="doctorNameBlock">
          <div class="itemTitle">${escapeHtml(d.doctorName || d.doctor || 'Doctor')}</div>
          <small>${open} open queue • ${served} served • Avg wait ${avgWait}</small>
        </div>
        <span class="badge ${statusClass}">${open >= 7 ? 'Busy' : open >= 4 ? 'Watch' : 'Stable'}</span>
      </div>
      <div class="doctorBadgeStrip">
        <span>Queue Focus</span>
        <span>${open ? `${open} active cases` : 'No open queue'}</span>
        <span>${served} served this window</span>
      </div>
      <div class="doctorMetricsGrid">
        <div class="doctorMetric"><small>Open Queue</small><strong>${open}</strong></div>
        <div class="doctorMetric"><small>Served</small><strong>${served}</strong></div>
        <div class="doctorMetric"><small>Avg Wait</small><strong>${avgWait}</strong></div>
      </div>
      <div class="progress"><span style="width:${(open / maxCount) * 100}%"></span></div>
      <div class="doctorIntensity"><div><strong>${intensity}</strong><small>Use Open Queue to focus this desk instantly.</small></div><button class="pillBtn" type="button" data-queue-doctor="${escapeHtml(d.doctorName || d.doctor || '')}">Open Queue</button></div>
    </div>`;
  }).join('');
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
  const ws = state.data.workspace?.summary || {};
  const fin = state.data.financialIntelligence || {};
  const inv = state.data.inventoryIntelligence || {};
  const collectionRate = num(fin.totals?.totalRevenue || f.totalBill) ? Math.round((num(fin.totals?.totalPaid || f.totalPaid) / Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1)) * 100) : 0;
  const exposureRate = num(fin.totals?.totalRevenue || f.totalBill) ? Math.round((num(fin.totals?.totalOutstanding || f.outstanding) / Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1)) * 100) : 0;
  document.getElementById('analyticsRibbonFinance') && (document.getElementById('analyticsRibbonFinance').textContent = `${collectionRate}% Collected`);
  document.getElementById('analyticsRibbonWorkflow') && (document.getElementById('analyticsRibbonWorkflow').textContent = (inv.counts?.lowStock || 0) + (inv.counts?.expired || 0) > 0 ? 'Inventory Under Watch' : (ws.pendingLabs + ws.pendingAppointments + ws.activePrescriptions > 0 ? 'Workflow Under Watch' : 'Workflow Stable'));

  const dept = Array.isArray(fin.revenueByDepartment) ? fin.revenueByDepartment : [];
  const doctors = Array.isArray(fin.revenueByDoctor) ? fin.revenueByDoctor : [];
  const payMix = Array.isArray(fin.paymentMix) ? fin.paymentMix : [];
  const topServices = Array.isArray(fin.topServices) ? fin.topServices : [];
  const refunds = fin.refundAnalytics || {};
  const leakages = Array.isArray(fin.leakageAlerts) ? fin.leakageAlerts : [];
  const discountAbuse = Array.isArray(fin.discountAbuseAlerts) ? fin.discountAbuseAlerts : [];
  const profitability = Array.isArray(fin.departmentProfitability) ? fin.departmentProfitability : [];
  const branchComparison = Array.isArray(fin.branchComparison) ? fin.branchComparison : [];
  const outstandingPatient = Array.isArray(fin.outstanding?.patient) ? fin.outstanding.patient : [];
  const outstandingCompany = Array.isArray(fin.outstanding?.company) ? fin.outstanding.company : [];
  const outstandingHmo = Array.isArray(fin.outstanding?.hmo) ? fin.outstanding.hmo : [];
  const lowStock = Array.isArray(inv.lowStock) ? inv.lowStock : [];
  const outOfStock = Array.isArray(inv.outOfStock) ? inv.outOfStock : [];
  const expired = Array.isArray(inv.expired) ? inv.expired : [];
  const expiringSoon = Array.isArray(inv.expiringSoon) ? inv.expiringSoon : [];
  const movements = Array.isArray(inv.drugMovementHistory) ? inv.drugMovementHistory : [];
  const wardConsumption = Array.isArray(inv.wardConsumption) ? inv.wardConsumption : [];
  const labUse = Array.isArray(inv.labConsumablesUsage) ? inv.labConsumablesUsage : [];
  const suppliers = Array.isArray(inv.suppliers) ? inv.suppliers : [];
  const reorderAlerts = Array.isArray(inv.automaticReorderAlerts) ? inv.automaticReorderAlerts : [];
  const batchTracking = Array.isArray(inv.batchTracking) ? inv.batchTracking : [];
  const productProfit = Array.isArray(inv.pharmacyProfitability?.items) ? inv.pharmacyProfitability.items : [];
  const dailyTrend = Array.isArray(fin.trends?.daily) ? fin.trends.daily : [];
  const monthlyTrend = Array.isArray(fin.trends?.monthly) ? fin.trends.monthly : [];

  $('#financeBreakdown').innerHTML = `
    <div class="analyticsSummaryGrid">
      <div class="execMiniCard"><span>Collection Rate</span><strong>${collectionRate}%</strong></div>
      <div class="execMiniCard"><span>Exposure Rate</span><strong>${exposureRate}%</strong></div>
      <div class="execMiniCard"><span>Refunds</span><strong>${money(refunds.totalRefundAmount || 0)}</strong></div>
      <div class="execMiniCard"><span>Discounts</span><strong>${money(fin.totals?.totalDiscounts || 0)}</strong></div>
      <div class="execMiniCard"><span>Data Mode</span><strong>${escapeHtml(fin.dataQuality?.sourceMode || 'connected')}</strong></div>
      <div class="execMiniCard"><span>Branch Rows</span><strong>${num(fin.dataQuality?.branchRows || 0)}</strong></div>
    </div>
    <div class="metricRow"><div class="itemTitle">Exact Revenue Trend</div><div class="itemMeta"><span>Paid cashflow from actual bills, dispenses and refunds</span></div></div>
    <div id="fiTrendChart" class="chartHost smallTall"></div>
    <div class="dualAnalyticsRow">
      <div>
        <div class="metricRow"><div class="itemTitle">Revenue by Department</div><div class="itemMeta"><span>Real posted value</span></div></div>
        <div id="fiDeptChart"></div>
      </div>
      <div>
        <div class="metricRow"><div class="itemTitle">Payment Mix</div><div class="itemMeta"><span>Cash vs transfer vs insurance</span></div></div>
        <div id="fiPaymentChart"></div>
      </div>
    </div>
    <div class="dualAnalyticsRow">
      <div>
        <div class="metricRow"><div class="itemTitle">Revenue by Doctor</div><div class="itemMeta"><span>Doctor-linked collections</span></div></div>
        <div id="fiDoctorChart"></div>
      </div>
      <div>
        <div class="metricRow"><div class="itemTitle">Branch Comparison</div><div class="itemMeta"><span>Cross-branch posted revenue</span></div></div>
        <div id="fiBranchChart"></div>
      </div>
    </div>
    ${metricBar('Total Revenue Engine', num(fin.totals?.totalRevenue || f.totalBill), Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1))}
    ${metricBar('Collected Cashflow', num(fin.totals?.totalPaid || f.totalPaid), Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1))}
    ${metricBar('Exposure Outstanding', num(fin.totals?.totalOutstanding || f.outstanding), Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1))}
    ${metricBar('Pharmacy Share', num(inv.pharmacyProfitability?.totalRevenue || f.pharmacySales), Math.max(num(fin.totals?.totalRevenue || f.totalBill), 1))}
    <div class="metricRow"><div class="itemTitle">Most Profitable Departments</div><div class="itemMeta"><span>Margin view based on recorded cost fields</span></div></div>
    ${(profitability.length ? profitability.slice(0,6).map(x => metricRow(x.label, money(x.value), `${num(x.services)} service row(s)`)).join('') : '<div class="emptyState">Department profitability appears when cost fields exist.</div>')}
    <div class="metricRow"><div class="itemTitle">Top Services</div><div class="itemMeta"><span>Most valuable posted services</span></div></div>
    ${(topServices.length ? topServices.slice(0,6).map(x => metricRow(x.label, money(x.value), 'Captured from bill and dispense lines')).join('') : '<div class="emptyState">Service ranking appears when billing lines exist.</div>')}
  `;

  $('#workflowBenchmarks').innerHTML = `
    <div class="analyticsSummaryGrid">
      <div class="execMiniCard"><span>Low Stock</span><strong>${num(inv.counts?.lowStock || 0)}</strong></div>
      <div class="execMiniCard"><span>Out of Stock</span><strong>${num(inv.counts?.outOfStock || 0)}</strong></div>
      <div class="execMiniCard"><span>Expired</span><strong>${num(inv.counts?.expired || 0)}</strong></div>
      <div class="execMiniCard"><span>Expiring Soon</span><strong>${num(inv.counts?.expiringSoon || 0)}</strong></div>
      <div class="execMiniCard"><span>Purchase Rows</span><strong>${num(inv.dataQuality?.purchaseRows || 0)}</strong></div>
      <div class="execMiniCard"><span>Batch Rows</span><strong>${num(inv.dataQuality?.batchRows || 0)}</strong></div>
    </div>
    <div class="metricRow"><div class="itemTitle">Inventory Risk View</div><div class="itemMeta"><span>Exact stock intelligence from items, receipts and dispenses</span></div></div>
    <div id="invRiskChart"></div>
    <div class="dualAnalyticsRow">
      <div>
        <div class="metricRow"><div class="itemTitle">Supplier Spend</div><div class="itemMeta"><span>Purchase value by supplier</span></div></div>
        <div id="invSupplierChart"></div>
      </div>
      <div>
        <div class="metricRow"><div class="itemTitle">Pharmacy Profitability</div><div class="itemMeta"><span>Recorded revenue minus mapped item cost</span></div></div>
        <div id="invProfitChart"></div>
      </div>
    </div>
    ${metricRow('Patient registry strength', num(o.patients), 'Registered patient footprint')}
    ${metricRow('Clinical throughput', num(ws.activeVisits || o.visits), 'Visits handled in the current dataset')}
    ${metricRow('Queue intensity', num(ws.openQueue || o.queue), 'Open doctor queue count')}
    ${metricRow('Pending labs', num(ws.pendingLabs), 'Laboratory desk workload')}
    ${metricRow('Active prescriptions', num(ws.activePrescriptions), 'Medication flow still active')}
    ${metricRow('Admissions active', num(ws.activeAdmissions || o.admissions), 'Bed-side and inpatient activity')}
    <div class="metricRow"><div class="itemTitle">Batch Tracking</div><div class="itemMeta"><span>Received vs dispensed vs on-hand</span></div></div>
    ${(batchTracking.length ? batchTracking.slice(0,5).map(x => metricRow(`${x.label} • ${x.batch}`, `${num(x.value)} on hand`, `Received ${num(x.receivedQty)} • Dispensed ${num(x.dispensedQty)} • ${x.supplier || '--'}`)).join('') : '<div class="emptyState">Batch tracking will appear when purchase receipts include batch data.</div>')}
    <div class="metricRow"><div class="itemTitle">Ward Consumption</div><div class="itemMeta"><span>Consumables and medication usage</span></div></div>
    ${(wardConsumption.length ? wardConsumption.slice(0,4).map(x => metricRow(x.label, num(x.value), 'Ward-side usage count')).join('') : '<div class="emptyState">Ward consumption appears from nurse desk logs.</div>')}
    <div class="metricRow"><div class="itemTitle">Lab Consumables Usage</div><div class="itemMeta"><span>Sample and test-driven usage</span></div></div>
    ${(labUse.length ? labUse.slice(0,4).map(x => metricRow(x.label, num(x.value), 'Lab-driven usage count')).join('') : '<div class="emptyState">Lab consumable usage appears from lab requests.</div>')}
  `;

  const combinedSignals = [
    ...leakages.map(x => ({ title:'Leakage Detection', message:`${x.label} • ${x.detail}`, createdAt:x.createdAt, actor:'system' })),
    ...discountAbuse.map(x => ({ title:'Discount Abuse Alert', message:`${x.label} • ${x.detail}`, createdAt:x.createdAt, actor:'system' })),
    ...reorderAlerts.map(x => ({ title:'Automatic Reorder Alert', message:`${x.label} • ${x.detail}`, createdAt:Date.now(), actor:x.supplier })),
    ...outOfStock.slice(0,4).map(x => ({ title:'Out of Stock', message:`${x.label} • Batch ${x.batch || '--'}`, createdAt:Date.now(), actor:x.supplier || 'inventory' })),
    ...notifications.slice(0, 6).map(n => ({ title:n.title || n.type || 'Signal', message:n.message || '--', createdAt:n.createdAt, actor:n.actor || n.by || 'system' }))
  ].sort((a,b) => num(b.createdAt) - num(a.createdAt));

  $('#analyticsSignals').innerHTML = combinedSignals.length ? combinedSignals.slice(0,10).map(n => `<div class="analyticsSignalCard"><strong>${escapeHtml(n.title || 'Signal')}</strong><div>${escapeHtml(n.message || '--')}</div><div class="itemMeta"><span>${fmtDateTime(n.createdAt)}</span><span>${escapeHtml(n.actor || 'system')}</span></div></div>`).join('') : `<div class="emptyState">Realtime signals will show after events start flowing.</div>`;

  $('#boardSummary').innerHTML = [
    miniPanel('Executive summary', escapeHtml(state.data.aiOverview?.summary || 'Analytics summary will appear here.')),
    miniPanel('Most profitable department', fin.mostProfitableDepartment ? `${fin.mostProfitableDepartment.label} • ${money(fin.mostProfitableDepartment.value)}` : 'Waiting for profitability data'),
    miniPanel('Top services', topServices.length ? `${topServices[0].label} • ${money(topServices[0].value)}` : 'No service ranking yet'),
    miniPanel('Outstanding by patient', outstandingPatient.length ? `${outstandingPatient[0].label} • ${money(outstandingPatient[0].value)}` : 'No patient-level outstanding exposure'),
    miniPanel('Outstanding by company/HMO', (outstandingCompany[0] || outstandingHmo[0]) ? `${(outstandingCompany[0] || outstandingHmo[0]).label} • ${money((outstandingCompany[0] || outstandingHmo[0]).value)}` : 'No company/HMO exposure yet'),
    miniPanel('Refund analytics', `${num(refunds.refundCount || 0)} refund(s) • ${money(refunds.totalRefundAmount || 0)}`),
    miniPanel('Inventory risk', `${num(inv.counts?.lowStock || 0)} low • ${num(inv.counts?.expired || 0)} expired • ${num(inv.counts?.expiringSoon || 0)} expiring soon`),
    miniPanel('Supplier watch', suppliers.length ? `${suppliers[0].label} • ${money(suppliers[0].value)}` : 'Supplier data will appear when supplier fields are available'),
    miniPanel('Movement history', movements.length ? `${movements[0].type} • ${movements[0].label} • ${fmtDateTime(movements[0].createdAt)}` : 'Movement history will appear after purchases/dispenses'),
    miniPanel('BI mode', `${fin.dataQuality?.sourceMode || 'connected'} / ${inv.dataQuality?.sourceMode || 'connected'}`)
  ].join('');

  renderAreaChart('fiTrendChart', (monthlyTrend.length ? monthlyTrend : dailyTrend).map(x => ({ label: String(x.label).slice(-5), value: num(x.value) })), 'NGN');
  renderHorizontalBars('fiDeptChart', dept, v => money(v));
  renderHorizontalBars('fiPaymentChart', payMix, v => money(v));
  renderHorizontalBars('fiDoctorChart', doctors.map(x => ({ label: `${x.label} (${num(x.visits)}v)`, value: x.value })), v => money(v));
  renderHorizontalBars('fiBranchChart', branchComparison, v => money(v));
  renderHorizontalBars('invRiskChart', [
    { label:'Low Stock', value: inv.counts?.lowStock || 0 },
    { label:'Out of Stock', value: inv.counts?.outOfStock || 0 },
    { label:'Expired', value: inv.counts?.expired || 0 },
    { label:'Expiring Soon', value: inv.counts?.expiringSoon || 0 }
  ], v => `${num(v)} item(s)`);
  renderHorizontalBars('invSupplierChart', suppliers, v => money(v));
  renderHorizontalBars('invProfitChart', productProfit.map(x => ({ label:`${x.label} (${num(x.qty)})`, value:x.profit })), v => money(v));
}

function renderAccessControlAudit() {
  const accessHost = $('#accessControlGrid');
  const auditHost = $('#auditTrailGrid');
  if (accessHost) {
    const rbac = state.data.rbac || {};
    const totals = rbac.totals || {};
    const staff = Array.isArray(rbac.staff) ? rbac.staff : [];
    const templates = Array.isArray(rbac.templates) ? rbac.templates : [];
    accessHost.innerHTML = `
      <div class="permissionCard">
        <div class="itemTitle">Access Posture</div>
        <div class="permissionMeta">
          <span class="permissionChip">Users ${num(totals.users || staff.length)}</span>
          <span class="permissionChip">Active ${num(totals.activeUsers || 0)}</span>
          <span class="permissionChip">Sensitive View ${num(totals.sensitiveUsers || 0)}</span>
          <span class="permissionChip">Discount Approvers ${num(totals.discountApprovers || 0)}</span>
          <span class="permissionChip">Lab Approvers ${num(totals.labApprovers || 0)}</span>
        </div>
        <div class="itemMeta" style="margin-top:10px"><span>Per-user permissions now support view/create/edit/delete/approve with sensitive record control.</span></div>
      </div>
      <div class="permissionCard">
        <div class="itemTitle">Role Templates</div>
        <div class="permissionMeta">${templates.slice(0,7).map(t => `<span class="permissionChip">${escapeHtml(t.role)} • ${num(t.summary?.grants || 0)} grants</span>`).join('') || '<span class="permissionChip">No templates</span>'}</div>
      </div>
      <div class="permissionCard" style="grid-column:1/-1">
        <div class="itemTitle">Per-User Permission Matrix</div>
        <div class="permissionMatrix">
          ${staff.length ? staff.slice(0,16).map(u => `
            <div class="permissionCard">
              <div class="row alignCenter" style="justify-content:space-between"><strong>${escapeHtml(u.fullName || u.email || 'User')}</strong><span class="badge">${escapeHtml(u.role || '--')}</span></div>
              <div class="itemMeta"><span>${escapeHtml(u.email || '--')}</span><span>${escapeHtml(u.branchId || 'Main')}</span><span>${u.active === false ? 'Inactive' : 'Active'}</span></div>
              <div class="permissionMeta">
                <span class="permissionChip">Grants ${num(u.grants || 0)}</span>
                <span class="permissionChip">Sensitive ${u.sensitiveView ? 'Allowed' : 'Blocked'}</span>
                <span class="permissionChip">Discount ${u.discountApproval ? 'Approve' : 'No Approval'}</span>
                <span class="permissionChip">Lab ${u.labApproval ? 'Approve' : 'No Approval'}</span>
              </div>
              <div class="permissionActions">
                <button type="button" class="btn btnGhost small" data-perm-template="least" data-user-id="${escapeHtml(u.userId || '')}">Least Privilege</button>
                <button type="button" class="btn btnGhost small" data-perm-template="role" data-user-id="${escapeHtml(u.userId || '')}">Reset to Role</button>
              </div>
            </div>`).join('') : '<div class="emptyState">No staff records yet.</div>'}
        </div>
      </div>`;
    $$('[data-perm-template]', accessHost).forEach(btn => btn.addEventListener('click', async () => {
      const userId = btn.dataset.userId;
      const mode = btn.dataset.permTemplate;
      const user = staff.find(x => String(x.userId) === String(userId));
      if (!user) return;
      const roleTemplate = templates.find(t => String(t.role) === String(user.role));
      let permissions = roleTemplate?.permissions || user.permissions || {};
      if (mode === 'least') {
        permissions = JSON.parse(JSON.stringify(permissions || {}));
        Object.keys(permissions).forEach(moduleName => {
          if (moduleName !== 'patients' && moduleName !== 'audit_logs') permissions[moduleName].delete = false;
          if (moduleName === 'sensitive_records') { permissions[moduleName].view = false; permissions[moduleName].approve = false; }
          if (moduleName === 'billing') permissions[moduleName].approve = false;
        });
      }
      try {
        await api(`/api/staff/${encodeURIComponent(userId)}/permissions`, { method:'POST', body:{ permissions } });
        showToast('Permissions Updated', `${user.fullName || user.email} access profile saved`);
        await Promise.allSettled([loadRbac(), loadAuditTrail()]);
        renderAccessControlAudit();
      } catch (err) {
        showToast('Permission Update Failed', err.message || 'Unable to save permissions');
      }
    }));
  }
  if (auditHost) {
    const audit = state.data.auditTrail || {};
    const rows = Array.isArray(audit.audit) ? audit.audit : [];
    const stats = audit.stats || {};
    auditHost.innerHTML = `
      <div class="auditCard">
        <div class="itemTitle">Audit Coverage</div>
        <div class="auditMeta">
          <span class="auditChip">Events ${num(stats.total || rows.length)}</span>
          <span class="auditChip">Sensitive ${num(stats.sensitive || 0)}</span>
          <span class="auditChip">Patient Views ${num(stats.patientViews || 0)}</span>
          <span class="auditChip">Refunds ${num(stats.refunds || 0)}</span>
          <span class="auditChip">Approvals ${num(stats.approvals || 0)}</span>
        </div>
      </div>
      <div class="auditCard" style="grid-column:1/-1">
        <div class="itemTitle">Latest Trace</div>
        <div class="auditTrailList">
          ${rows.length ? rows.slice(0,18).map(r => `
            <div class="auditCard">
              <div class="row alignCenter" style="justify-content:space-between"><strong>${escapeHtml(formatActivityType(r.action || 'activity'))}</strong><span class="badge">${escapeHtml(r.role || '--')}</span></div>
              <div>${escapeHtml(r.details || r.entityType || '--')}</div>
              <div class="auditMeta">
                <span class="auditChip">Actor ${escapeHtml(r.actor || 'system')}</span>
                <span class="auditChip">IP ${escapeHtml(r.ipAddress || '--')}</span>
                <span class="auditChip">Device ${escapeHtml(r.deviceId || '--')}</span>
                <span class="auditChip">Branch ${escapeHtml(r.branchId || '--')}</span>
                <span class="auditChip">Entity ${escapeHtml(r.entityType || '--')}</span>
                <span class="auditChip">${fmtDateTime(r.createdAt)}</span>
              </div>
            </div>`).join('') : '<div class="emptyState">Audit logs will appear here as users open, edit, approve and refund records.</div>'}
        </div>
      </div>`;
  }
}


function normalizePatientRecord(patient = {}) {
  return {
    ...patient,
    patientId: patient.patientId || patient.id || '',
    fullName: patient.fullName || patient.patientName || patient.name || '',
    patientName: patient.patientName || patient.fullName || patient.name || '',
    age: patient.age || '',
    gender: patient.gender || '',
    phone: patient.phone || '',
    mrn: patient.mrn || '',
    email: patient.email || '',
    bloodGroup: patient.bloodGroup || '',
    genotype: patient.genotype || '',
    status: patient.status || 'active',
    address: patient.address || '',
    nextOfKin: patient.nextOfKin || '',
    nextOfKinPhone: patient.nextOfKinPhone || ''
  };
}

function setSelectedPatient(patient = {}, opts = {}) {
  const normalized = normalizePatientRecord(patient);
  if (!normalized.patientId && !normalized.fullName) return;
  state.selectedPatient = normalized;
  state.selectedPatientProfile = null;
  renderSelectedPatientHub();
  renderPatientCommandDock();
  renderWorkflowPatientBanner();
  renderWorkflowInsightRail();
  fillWorkflowPatient(normalized);
  if (normalized.patientId) loadSelectedPatientProfile(normalized.patientId);
  if (opts.switchToPatients) switchTab('patients', true);
  if (opts.openDrawer && normalized.patientId) openPatientDrawer(normalized.patientId);
}

function fillWorkflowPatient(patient = {}) {
  const normalized = normalizePatientRecord(patient);
  const patientId = normalized.patientId || '';
  const patientName = normalized.fullName || normalized.patientName || '';
  const mappings = [
    ['#billForm [name="patientId"]', patientId],
    ['#billForm [name="patientName"]', patientName],
    ['#visitForm [name="patientId"]', patientId],
    ['#appointmentForm [name="patientId"]', patientId],
    ['#queueForm [name="patientId"]', patientId],
    ['#labForm [name="patientId"]', patientId],
    ['#prescriptionForm [name="patientId"]', patientId],
    ['#nurseForm [name="patientId"]', patientId],
    ['#admissionForm [name="patientId"]', patientId],
    ['#pharmacyDispenseForm [name="patientId"]', patientId],
    ['#dischargeForm [name="patientId"]', patientId],
    ['#theatreForm [name="patientId"]', patientId],
  ];
  mappings.forEach(([selector, value]) => {
    const el = $(selector);
    if (!el) return;
    el.value = value || '';
  });
}

function jumpToWorkflowTarget(selector) {
  if (!selector) return;
  switchTab('workflow', true);
  requestAnimationFrame(() => {
    const target = $(selector);
    if (!target) return;
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    target.classList.add('workflowFocus');
    setTimeout(() => target.classList.remove('workflowFocus'), 1800);
    const firstInput = target.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus({ preventScroll: true });
  });
}

function workflowActionMeta(action) {
  return {
    bill: { tab: 'workflow', selector: '#billForm', title: 'Direct Billing', note: 'Create bill and receipt instantly' },
    appointment: { tab: 'workflow', selector: '#appointmentForm', title: 'Appointment', note: 'Book patient for doctor or clinic time' },
    visit: { tab: 'workflow', selector: '#visitForm', title: 'New Visit', note: 'Open clinical visit and diagnosis flow' },
    prescription: { tab: 'workflow', selector: '#prescriptionForm', title: 'Prescription', note: 'Write medication order quickly' },
    lab: { tab: 'workflow', selector: '#labForm', title: 'Lab Request', note: 'Send patient to laboratory' },
    pharmacy: { tab: 'workflow', selector: '#pharmacyDispenseForm', title: 'Pharmacy', note: 'Dispense drug for selected patient' },
    admission: { tab: 'workflow', selector: '#admissionForm', title: 'Admission', note: 'Move patient to ward / bed' },
    nurse: { tab: 'workflow', selector: '#nurseForm', title: 'Nurse Desk', note: 'Capture nursing note or vitals' },
    queue: { tab: 'workflow', selector: '#queueForm', title: 'Doctor Queue', note: 'Push patient into doctor queue' },
    profile: { tab: 'patients', selector: '#selectedPatientHub', title: 'Patient Profile', note: 'Return to patient command hub' },
    search: { tab: 'search', selector: '#searchInput', title: 'Search Desk', note: 'Search related record instantly' },
  }[action] || { tab: 'workflow', selector: '#workflowPatientCard', title: 'Workflow', note: 'Continue with patient workflow' };
}

function goToPatientAction(action, patient = state.selectedPatient) {
  const normalized = normalizePatientRecord(patient || {});
  if (normalized.patientId) setSelectedPatient(normalized);
  const meta = workflowActionMeta(action);
  switchTab(meta.tab, true);
  requestAnimationFrame(() => {
    const target = $(meta.selector);
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target.matches('form')) {
        target.classList.add('workflowFocus');
        setTimeout(() => target.classList.remove('workflowFocus'), 1800);
      }
      const firstInput = target.querySelector('input,textarea,select');
      if (firstInput) firstInput.focus({ preventScroll: true });
    }
  });
  showToast(meta.title, normalized.patientId ? `${normalized.fullName || normalized.patientName || normalized.patientId} ready for ${meta.note.toLowerCase()}.` : meta.note);
}

function bindPatientActionButtons(root = document) {
  $$('[data-patient-action]', root).forEach(btn => {
    if (btn.dataset.boundPatientAction === '1') return;
    btn.dataset.boundPatientAction = '1';
    btn.addEventListener('click', () => {
      const patient = {
        patientId: btn.dataset.patientId || state.selectedPatient?.patientId || '',
        fullName: btn.dataset.patientName || state.selectedPatient?.fullName || ''
      };
      if (btn.dataset.patientAction === 'drawer') {
        if (patient.patientId) openPatientDrawer(patient.patientId);
        return;
      }
      goToPatientAction(btn.dataset.patientAction, patient);
    });
  });
}


async function loadSelectedPatientProfile(patientId, opts = {}) {
  if (!patientId) {
    state.selectedPatientProfile = null;
    if (!opts.silent) {
      renderSelectedPatientHub();
      renderPatientCommandDock();
      renderWorkflowInsightRail();
    }
    return;
  }
  try {
    const res = await api(`/api/portal/patient-profile?patientId=${encodeURIComponent(patientId)}`);
    if (String(state.selectedPatient?.patientId || '') !== String(patientId)) return;
    state.selectedPatientProfile = res;
    if (!opts.silent) {
      renderSelectedPatientHub();
      renderPatientCommandDock();
      renderWorkflowInsightRail();
    }
  } catch (_err) {
    state.selectedPatientProfile = null;
    if (!opts.silent) {
      renderSelectedPatientHub();
      renderPatientCommandDock();
      renderWorkflowInsightRail();
    }
  }
}

function renderSelectedPatientHub() {
  const host = $('#selectedPatientHub');
  if (!host) return;
  const p = normalizePatientRecord(state.selectedPatient || {});
  const profile = state.selectedPatientProfile || {};
  const summary = profile.summary || {};
  const encounters = Array.isArray(profile.encounters) ? profile.encounters.slice(0, 6) : [];
  const latestVisit = Array.isArray(profile.visits) && profile.visits.length ? profile.visits[0] : null;
  const latestBill = Array.isArray(profile.bills) && profile.bills.length ? profile.bills[0] : null;
  const smartNext = (() => {
    if (!p.patientId) return 'Select or register a patient to unlock the full workflow.';
    if (num(summary.outstanding || 0) > 0) return 'Outstanding balance detected. Billing or payment follow-up is recommended.';
    if ((summary.visitCount || 0) === 0) return 'This patient has no visit yet. Start with New Visit for doctor consultation.';
    if ((summary.labCount || 0) > 0 && (!profile.labs || !profile.labs.some(x => String(x.status || '').toLowerCase().includes('result')))) return 'There are pending lab requests. Review the Lab desk next.';
    if ((summary.prescriptionCount || 0) === 0) return 'No prescription recorded yet. Open Prescription after consultation if medication is needed.';
    return 'Patient workflow is active. Continue from billing, nurse desk, pharmacy or admission as needed.';
  })();

  if (!p.patientId && !p.fullName) {
    host.classList.add('empty');
    host.innerHTML = `<div class="emptyState">Select or register a patient to open the direct action hub.</div>`;
    return;
  }
  host.classList.remove('empty');
  host.innerHTML = `
    <div class="patientHubGrid advanced">
      <div class="hubSideStack">
        <div class="patientHubHero">
          <div>
            <div class="eyebrow">Active Patient Workspace</div>
            <h3>${escapeHtml(p.fullName || p.patientName || p.patientId)}</h3>
            <div class="patientHubMeta">
              <span class="metaTag">${escapeHtml(p.patientId || '--')}</span>
              <span class="metaTag">${escapeHtml(p.gender || '--')}</span>
              <span class="metaTag">${escapeHtml(String(p.age || '--'))} yrs</span>
              <span class="metaTag">${escapeHtml(p.phone || '--')}</span>
              <span class="metaTag">${escapeHtml(p.status || 'active')}</span>
            </div>
          </div>
          <div class="row wrap gap8">
            <button class="btn btnGhost small" type="button" data-patient-action="drawer" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">Open Profile</button>
            <button class="btn btnGhost small" type="button" data-patient-action="search" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">Search Desk</button>
          </div>
        </div>

        <div class="patientBriefGrid">
          <div class="briefStat"><span>Visits</span><strong>${num(summary.visitCount || 0)}</strong><small>${latestVisit ? escapeHtml(latestVisit.reason || latestVisit.diagnosis || 'Latest visit available') : 'No visit yet'}</small></div>
          <div class="briefStat"><span>Bills</span><strong>${num(summary.billCount || 0)}</strong><small>${latestBill ? money(latestBill.total || latestBill.amount || 0) : 'No bill yet'}</small></div>
          <div class="briefStat"><span>Outstanding</span><strong>${money(summary.outstanding || 0)}</strong><small>${num(summary.queueCount || 0)} queue item(s)</small></div>
          <div class="briefStat"><span>Clinical</span><strong>${num(summary.labCount || 0) + num(summary.prescriptionCount || 0)}</strong><small>${num(summary.labCount || 0)} lab • ${num(summary.prescriptionCount || 0)} rx</small></div>
        </div>

        <div class="patientHubActions">
          ${[
            ['visit','New Visit','Open consultation workflow'],
            ['bill','New Bill','Create receipt and payment flow'],
            ['appointment','Appointment','Book a clinic time quickly'],
            ['prescription','Prescription','Medication order'],
            ['lab','Lab','Send to lab desk'],
            ['pharmacy','Pharmacy','Dispense medication'],
            ['admission','Admission','Move to ward'],
            ['nurse','Nurse Desk','Capture vitals and note']
          ].map(([action,title,note]) => `<button class="hubActionBtn" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${title}<small>${note}</small></button>`).join('')}
        </div>
      </div>
      <div class="hubSideStack">
        <div class="infoStatGrid">
          <div class="infoStat"><span>MRN</span><strong>${escapeHtml(p.mrn || '--')}</strong></div>
          <div class="infoStat"><span>Blood</span><strong>${escapeHtml(p.bloodGroup || '--')}</strong></div>
          <div class="infoStat"><span>Genotype</span><strong>${escapeHtml(p.genotype || '--')}</strong></div>
        </div>
        <div class="quickNote smartNextNote"><strong>Smart next step:</strong> ${escapeHtml(smartNext)}</div>
        <div class="patientTimelineMini">
          <div class="miniTimelineHead">
            <strong>Recent Care Timeline</strong>
            <span class="badge">${encounters.length ? 'Live history' : 'Awaiting activity'}</span>
          </div>
          ${encounters.length ? encounters.map(row => `
            <div class="timelineMiniRow">
              <div>
                <div class="itemTitle">${escapeHtml(row.kind || 'Activity')}</div>
                <div class="itemMeta">${escapeHtml(row.title || row.reason || row.doctorName || '--')}</div>
              </div>
              <div class="itemMeta right">${fmtDateTime(row.createdAt || row.updatedAt)}</div>
            </div>`).join('') : `<div class="emptyState">Patient history will appear here as visit, bill, lab, queue and prescription records arrive.</div>`}
        </div>
      </div>
    </div>`;
  bindPatientActionButtons(host);
}

function renderWorkflowPatientBanner() {
  const host = $('#workflowPatientBanner');
  if (!host) return;
  const p = normalizePatientRecord(state.selectedPatient || {});
  if (!p.patientId && !p.fullName) {
    host.classList.add('empty');
    host.innerHTML = `<div class="emptyState">Choose a patient from Patients Desk or Search Desk to lock this workflow to one patient and reduce repeated typing.</div>`;
    return;
  }
  host.classList.remove('empty');
  host.innerHTML = `
    <div class="workflowPatientHero">
      <div class="eyebrow">Selected Patient Workflow</div>
      <h3>${escapeHtml(p.fullName || p.patientName || p.patientId)}</h3>
      <div class="patientHubMeta">
        <span class="metaTag">${escapeHtml(p.patientId || '--')}</span>
        <span class="metaTag">${escapeHtml(p.phone || '--')}</span>
        <span class="metaTag">${escapeHtml(p.gender || '--')}</span>
        <span class="metaTag">${escapeHtml(String(p.age || '--'))} yrs</span>
      </div>
      <div class="workflowQuickGrid">
        ${[
          ['visit','Visit','Consultation'],['bill','Bill','Receipt'],['lab','Lab','Request'],['prescription','Rx','Medication'],
          ['pharmacy','Pharmacy','Dispense'],['admission','Admission','Ward'],['nurse','Nurse','Vitals'],['queue','Queue','Doctor line']
        ].map(([action,title,note]) => `<button class="workflowQuickBtn" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${title}<small>${note}</small></button>`).join('')}
      </div>
    </div>
    <div class="workflowPatientAside">
      <div class="workflowHintCard"><strong>Why this is faster</strong><div class="itemMeta">All main workflow forms now stay linked to the selected patient. Staff can move desk-to-desk without retyping patient ID repeatedly.</div></div>
      <div class="workflowHintCard"><strong>Suggested next step</strong><div class="itemMeta">Open <b>New Visit</b> for doctor consultation, or open <b>New Bill</b> when the patient comes only for billing / payment.</div></div>
      <div class="workflowHintCard"><strong>Need full profile?</strong><div class="itemMeta"><button class="btn btnGhost small" type="button" data-patient-action="drawer" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">Open Patient Drawer</button></div></div>
    </div>`;
  bindPatientActionButtons(host);
}




function renderWorkflowActionPanels() {
  const billingHost = $('#billingActionPanel');
  const clinicalHost = $('#clinicalActionPanel');
  const careHost = $('#careActionPanel');
  if (!billingHost || !clinicalHost || !careHost) return;
  const p = normalizePatientRecord(state.selectedPatient || {});
  const profile = state.selectedPatientProfile || {};
  const summary = profile.summary || {};
  if (!p.patientId && !p.fullName) {
    const empty = '<div class="emptyState">Select a patient from Patients Desk or Search Desk. These action panels will then suggest the fastest next step.</div>';
    billingHost.innerHTML = empty;
    clinicalHost.innerHTML = empty;
    careHost.innerHTML = empty;
    return;
  }
  const fullName = escapeHtml(p.fullName || p.patientName || p.patientId || 'Patient');
  const pid = escapeHtml(p.patientId || '');
  const outstanding = num(summary.outstanding || 0);
  const queueCount = num(summary.queueCount || 0);
  const labCount = num(summary.labCount || 0);
  const rxCount = num(summary.prescriptionCount || 0);
  const visitCount = num(summary.visitCount || 0);
  const billCount = num(summary.billCount || 0);
  billingHost.innerHTML = `
    <div class="actionPanelHero"><div><div class="eyebrow">Billing focus</div><h4>${fullName}</h4></div><div class="actionPanelMetric ${outstanding > 0 ? 'warn' : ''}">${money(outstanding)}</div></div>
    <div class="actionPanelCopy">${outstanding > 0 ? 'Outstanding balance exists. Staff can open direct billing or receipt preview immediately.' : 'No current outstanding balance. Create new charge or review latest receipt status.'}</div>
    <div class="actionActionGrid">
      <button class="panelActionBtn primary" type="button" data-patient-action="bill" data-patient-id="${pid}" data-patient-name="${fullName}">Create Bill<small>${billCount} existing bill(s)</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="drawer" data-patient-id="${pid}" data-patient-name="${fullName}">Open Receipt Queue<small>Preview and edit billing records</small></button>
    </div>
    <div class="actionMiniStats"><div><span>Outstanding</span><strong>${money(outstanding)}</strong></div><div><span>Bills</span><strong>${billCount}</strong></div><div><span>Status</span><strong>${outstanding > 0 ? 'Follow-up' : 'Balanced'}</strong></div></div>`;
  clinicalHost.innerHTML = `
    <div class="actionPanelHero"><div><div class="eyebrow">Clinical flow</div><h4>${fullName}</h4></div><div class="actionPanelMetric ${queueCount > 0 ? 'hot' : ''}">${queueCount}</div></div>
    <div class="actionPanelCopy">${visitCount === 0 ? 'No visit yet. Start consultation workflow now so every other desk has a clinical anchor.' : 'Patient already has clinical activity. Continue with queue, admission, or another visit.'}</div>
    <div class="actionActionGrid">
      <button class="panelActionBtn primary" type="button" data-patient-action="visit" data-patient-id="${pid}" data-patient-name="${fullName}">Open Visit Desk<small>${visitCount} visit(s) recorded</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="queue" data-patient-id="${pid}" data-patient-name="${fullName}">Push To Queue<small>${queueCount} open queue item(s)</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="admission" data-patient-id="${pid}" data-patient-name="${fullName}">Admission Desk<small>Ward and inpatient flow</small></button>
    </div>
    <div class="actionMiniStats"><div><span>Visits</span><strong>${visitCount}</strong></div><div><span>Queue</span><strong>${queueCount}</strong></div><div><span>Priority</span><strong>${queueCount > 0 ? 'Live' : 'Ready'}</strong></div></div>`;
  careHost.innerHTML = `
    <div class="actionPanelHero"><div><div class="eyebrow">Care completion</div><h4>${fullName}</h4></div><div class="actionPanelMetric ${labCount > 0 ? 'warn' : rxCount > 0 ? 'good' : ''}">${labCount + rxCount}</div></div>
    <div class="actionPanelCopy">${labCount > 0 ? 'Active lab workflow exists. Review tests and coordinate with prescription or pharmacy after results.' : 'Use this area to complete medication, nurse notes, and dispensing with fewer clicks.'}</div>
    <div class="actionActionGrid">
      <button class="panelActionBtn primary" type="button" data-patient-action="lab" data-patient-id="${pid}" data-patient-name="${fullName}">Lab Desk<small>${labCount} request(s)</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="prescription" data-patient-id="${pid}" data-patient-name="${fullName}">Prescription<small>${rxCount} medication order(s)</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="pharmacy" data-patient-id="${pid}" data-patient-name="${fullName}">Pharmacy<small>Dispense and charge</small></button>
      <button class="panelActionBtn" type="button" data-patient-action="nurse" data-patient-id="${pid}" data-patient-name="${fullName}">Nurse Desk<small>Vitals and progress note</small></button>
    </div>
    <div class="actionMiniStats"><div><span>Lab</span><strong>${labCount}</strong></div><div><span>Rx</span><strong>${rxCount}</strong></div><div><span>Mode</span><strong>${labCount > 0 ? 'Follow Result' : 'Complete Care'}</strong></div></div>`;
  [billingHost, clinicalHost, careHost].forEach(bindPatientActionButtons);
}

function renderPatientCommandDock() {
  const host = $('#patientCommandDock');
  if (!host) return;
  const p = normalizePatientRecord(state.selectedPatient || {});
  const summary = state.selectedPatientProfile?.summary || {};
  if (!p.patientId && !p.fullName) {
    host.className = 'patientCommandDock empty';
    host.innerHTML = `<div class="emptyState">Choose a patient from Registry or Search Desk to activate the sticky command dock.</div>`;
    return;
  }
  host.className = 'patientCommandDock';
  const nextAction = num(summary.outstanding || 0) > 0
    ? 'Billing follow-up recommended because outstanding balance exists.'
    : (num(summary.visitCount || 0) === 0
      ? 'Start New Visit first so clinical workflow begins from consultation.'
      : (num(summary.labCount || 0) > 0 ? 'Review Lab desk because active lab workflow exists.' : 'Continue from Queue, Prescription, Pharmacy or Admission as needed.'));
  host.innerHTML = `
    <div class="commandDockIdentity">
      <div class="avatarOrb">${escapeHtml(((p.fullName || p.patientName || 'P').split(/\s+/).slice(0,2).map(s => s[0] || '').join('') || 'P').toUpperCase())}</div>
      <div>
        <div class="eyebrow">Active Patient</div>
        <h3>${escapeHtml(p.fullName || p.patientName || p.patientId)}</h3>
        <div class="patientMetaLine"><span class="metaPill">${escapeHtml(p.patientId || '--')}</span><span class="metaPill">${escapeHtml(p.phone || '--')}</span><span class="metaPill">${escapeHtml(p.gender || '--')}</span></div>
      </div>
    </div>
    <div class="commandDockMetrics">
      <div class="dockMetric"><span>Visits</span><strong>${num(summary.visitCount || 0)}</strong></div>
      <div class="dockMetric"><span>Bills</span><strong>${num(summary.billCount || 0)}</strong></div>
      <div class="dockMetric"><span>Outstanding</span><strong>${money(summary.outstanding || 0)}</strong></div>
      <div class="dockMetric"><span>Queue</span><strong>${num(summary.queueCount || 0)}</strong></div>
    </div>
    <div class="commandDockActions">
      ${['visit','bill','queue','lab','prescription','pharmacy','admission','nurse'].map(action => `<button class="dockActionBtn" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${workflowActionMeta(action).title}</button>`).join('')}
      <button class="dockActionBtn ghost" type="button" data-patient-action="drawer" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">Open Drawer</button>
    </div>
    <div class="commandDockNote"><strong>Smart next step:</strong> ${escapeHtml(nextAction)}</div>
  `;
  bindPatientActionButtons(host);
}

function renderWorkflowInsightRail() {
  const host = $('#workflowInsightRail');
  if (!host) return;
  const p = normalizePatientRecord(state.selectedPatient || {});
  const profile = state.selectedPatientProfile || {};
  const summary = profile.summary || {};
  if (!p.patientId) {
    host.innerHTML = `<div class="emptyState">No selected patient yet. Choose a patient to get workflow intelligence for visit, billing, lab, prescription and admission.</div>`;
    return;
  }
  const cards = [
    ['Registration', p.patientId, p.fullName || p.patientName || 'Patient linked'],
    ['Consultation', num(summary.visitCount || 0), num(summary.visitCount || 0) ? 'Visit history exists' : 'No visit yet'],
    ['Financial', money(summary.outstanding || 0), num(summary.outstanding || 0) > 0 ? 'Outstanding follow-up needed' : 'Billing balanced'],
    ['Clinical', `${num(summary.labCount || 0)} lab • ${num(summary.prescriptionCount || 0)} rx`, num(summary.labCount || 0) ? 'Pending or completed lab workflow' : 'No lab request yet'],
    ['Admission', num(summary.admissionCount || 0), num(summary.admissionCount || 0) ? 'Inpatient workflow exists' : 'No admission record']
  ];
  host.innerHTML = cards.map(([label,value,note]) => `<div class="workflowInsightCard"><span>${escapeHtml(label)}</span><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(note)}</small></div>`).join('');
}

function renderSearchActionDock(items = [], query = '') {
  const host = $('#searchActionDock');
  if (!host) return;
  if (!items.length) {
    host.className = 'searchActionDock empty';
    host.innerHTML = `<div class="emptyState">Search results will show action shortcuts here for bill, visit, lab, prescription, pharmacy and admission.</div>`;
    return;
  }
  const p = normalizePatientRecord(items[0] || {});
  host.className = 'searchActionDock';
  host.innerHTML = `
    <div class="searchDockHead">
      <div>
        <div class="eyebrow">Top Search Match</div>
        <h3>${escapeHtml(p.fullName || p.patientName || p.patientId)}</h3>
        <div class="itemMeta">${escapeHtml(items.length + ' result(s)')} for ${escapeHtml(query || '')}</div>
      </div>
      <div class="row gap8 wrap">
        <button class="btn btnGhost small" type="button" data-patient-action="drawer" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">Open Drawer</button>
        <button class="btn btnPrimary small" type="button" id="searchDockSelectBtn">Select Patient</button>
      </div>
    </div>
    <div class="searchDockActions">
      ${['visit','bill','lab','prescription','pharmacy','admission','queue'].map(action => `<button class="dockActionBtn" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${workflowActionMeta(action).title}</button>`).join('')}
    </div>
  `;
  bindPatientActionButtons(host);
  $('#searchDockSelectBtn')?.addEventListener('click', () => {
    setSelectedPatient(p, { switchToPatients: false });
    showToast('Search Match Selected', `${p.fullName || p.patientName || p.patientId} moved into active command center.`);
  });
}

function renderPatients() {
  const items = state.data.patients || [];
  const overview = state.data.overview?.overview || {};
  const listHost = $('#patientsList');
  $('#patientRibbonCount').textContent = `${num(overview.patients || items.length)} Patients`;
  $('#patientRibbonSearch').textContent = items.length ? 'Registry Connected' : 'Awaiting Records';
  $('#patientRibbonSync').textContent = state.transport === 'SSE' ? 'Realtime Active' : 'Polling Mode';
  renderSelectedPatientHub();
  renderWorkflowPatientBanner();
  listHost.innerHTML = items.length ? items.slice(0, 24).map(raw => {
    const p = normalizePatientRecord(raw);
    const fullName = escapeHtml(p.fullName || 'Unnamed Patient');
    const pid = escapeHtml(p.patientId || '--');
    const initials = escapeHtml(((p.fullName || 'P').split(/\s+/).slice(0,2).map(s => s[0] || '').join('') || 'P').toUpperCase());
    return `
      <div class="patientCardPremium ${String(state.selectedPatient?.patientId || '') === String(p.patientId || '') ? 'selected' : ''}">
        <div class="patientCardHead">
          <div class="patientIdentity">
            <div class="avatarOrb">${initials}</div>
            <div>
              <div class="itemTitle">${fullName}</div>
              <div class="patientMetaLine"><span class="metaPill">${pid}</span><span class="metaPill">${escapeHtml(p.gender || '--')}</span><span class="metaPill">${escapeHtml(String(p.age || '--'))} yrs</span></div>
            </div>
          </div>
          <span class="badge">Live</span>
        </div>
        <div class="itemMeta"><span>${escapeHtml(p.phone || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span><span>${escapeHtml(p.email || '--')}</span></div>
        <div class="patientFoot">
          <div class="patientQuickStats"><div><strong>${escapeHtml(p.bloodGroup || '--')}</strong>Blood</div><div><strong>${escapeHtml(p.genotype || '--')}</strong>Genotype</div></div>
          <div class="queueActions">
            <button class="pillBtn" data-select="${escapeHtml(p.patientId || '')}">Select</button>
            <button class="pillBtn" data-ai="${escapeHtml(p.patientId || '')}">AI</button>
            <button class="pillBtn" data-view="${escapeHtml(p.patientId || '')}">Profile</button>
            <button class="pillBtn" data-bill="${escapeHtml(p.patientId || '')}" data-name="${escapeHtml(p.fullName || '')}">Bill</button>
          </div>
        </div>
        <div class="patientActionRow">
          ${[
            ['visit','Visit'],['appointment','Appointment'],['prescription','Rx'],['lab','Lab'],['pharmacy','Pharmacy'],['admission','Admission'],['nurse','Nurse']
          ].map(([action,title]) => `<button class="patientActionMini" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || '')}" data-patient-name="${escapeHtml(p.fullName || '')}">${title}</button>`).join('')}
        </div>
      </div>`;
  }).join('') : `<div class="emptyState">No patients registered yet.</div>`;
  $$('[data-select]', listHost).forEach(btn => btn.addEventListener('click', () => {
    const p = items.find(x => (x.patientId || x.id) === btn.dataset.select);
    if (p) {
      setSelectedPatient(p, { switchToPatients: false });
      showToast('Patient Selected', `${p.fullName || p.patientName || p.patientId} is now active in the command center.`);
    }
  }));
  $$('[data-ai]', listHost).forEach(btn => btn.addEventListener('click', () => { switchTab('search'); $('#searchInput').value = btn.dataset.ai; runSearch({ immediate: true, source: 'patient-card' }); loadPatientAi(btn.dataset.ai); }));
  $$('[data-view]', listHost).forEach(btn => btn.addEventListener('click', () => {
    const p = items.find(x => (x.patientId || x.id) === btn.dataset.view);
    if (p) setSelectedPatient(p);
    openPatientDrawer(btn.dataset.view);
  }));
  $$('[data-bill]', listHost).forEach(btn => btn.addEventListener('click', () => {
    const p = items.find(x => (x.patientId || x.id) === btn.dataset.bill);
    if (p) setSelectedPatient(p);
    openBillModal(btn.dataset.bill, btn.dataset.name);
  }));
  bindPatientActionButtons(listHost);
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
  const f = state.data.finance?.finance || {};
  $('#sidebarPortalState').textContent = state.baseUrl && state.hospitalId ? (state.transport === 'SSE' ? 'Live' : 'Connected') : 'Standby';
  $('#sidebarQueueState').textContent = `${num(overview.queue || 0)} Open`;
  $('#sidebarBillingState').textContent = money(f.totalPaid || 0);
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
      if (res?.patient?.patientId) setSelectedPatient(res.patient, { openDrawer: true });
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
    const p = normalizePatientRecord(res.patient || {});
    setSelectedPatient(p);
    const encounters = Array.isArray(res.encounters) ? res.encounters : [];
    const billing = Array.isArray(res.bills) ? res.bills : [];
    const admissions = Array.isArray(res.admissions) ? res.admissions : [];
    const summary = res.summary || {};
    showDrawer(`${p.fullName || p.patientName || 'Patient Profile'}`, `
      <div class="drawerTabBar">
        <button class="drawerTabBtn active" type="button" data-drawer-tab="overview">Overview</button>
        <button class="drawerTabBtn" type="button" data-drawer-tab="timeline">Timeline</button>
        <button class="drawerTabBtn" type="button" data-drawer-tab="finance">Finance</button>
      </div>
      <section class="drawerTabPane" data-drawer-pane="overview">
      <div class="drawerHero">
        <div>
          <div class="eyebrow">Patient Profile Drawer</div>
          <h3>${escapeHtml(p.fullName || p.patientName || patientId)}</h3>
          <div class="itemMeta"><span>${escapeHtml(p.patientId || '--')}</span><span>${escapeHtml(p.mrn || '--')}</span><span>${escapeHtml(p.phone || '--')}</span><span>${escapeHtml(p.email || '--')}</span></div>
          <div class="patientDrawerHeroStats">
            <div class="drawerStat"><span>Visits</span><strong>${num(summary.visitCount)}</strong></div>
            <div class="drawerStat"><span>Bills</span><strong>${num(summary.billCount)}</strong></div>
            <div class="drawerStat"><span>Outstanding</span><strong>${money(summary.outstanding || 0)}</strong></div>
          </div>
        </div>
        <div class="drawerHeroBadge">${escapeHtml(p.status || 'active')}</div>
      </div>
      <div class="drawerGrid">
        <div class="miniPanel"><div class="itemTitle">Demography</div><div>${escapeHtml(p.gender || '--')} • ${escapeHtml(String(p.age || '--'))}</div><div class="itemMeta"><span>${escapeHtml(p.bloodGroup || '--')}</span><span>${escapeHtml(p.genotype || '--')}</span></div></div>
        <div class="miniPanel"><div class="itemTitle">Contacts</div><div>${escapeHtml(p.phone || '--')}</div><div class="itemMeta"><span>${escapeHtml(p.email || '--')}</span><span>${escapeHtml(p.address || '--')}</span></div></div>
        <div class="miniPanel"><div class="itemTitle">Next of Kin</div><div>${escapeHtml(p.nextOfKin || '--')}</div><div class="itemMeta"><span>${escapeHtml(p.nextOfKinPhone || '--')}</span></div></div>
        <div class="miniPanel"><div class="itemTitle">Clinical Totals</div><div>${num(summary.visitCount)} visits • ${num(summary.billCount)} bills</div><div class="itemMeta"><span>${num(summary.admissionCount)} admissions</span><span>${money(summary.outstanding || 0)} outstanding</span></div></div>
      </div>
      <div class="drawerSection">
        <div class="cardHead compact"><div><div class="eyebrow">Command Actions</div><h3>Direct Clinical Controls</h3></div><div class="row gap8"><button class="btn btnGhost small" type="button" id="drawerEditBtn">Edit Patient</button><button class="btn btnGhost small" type="button" id="drawerBillBtn">Create Bill</button></div></div>
        <div class="patientDrawerActionGrid">
          ${[
            ['visit','New Visit','Consultation + diagnosis'],
            ['appointment','Appointment','Schedule clinic time'],
            ['prescription','Prescription','Medication order'],
            ['lab','Lab','Test request'],
            ['pharmacy','Pharmacy','Dispense drug'],
            ['admission','Admission','Ward / bed'],
            ['nurse','Nurse Desk','Vitals / note'],
            ['queue','Queue','Doctor waiting line']
          ].map(([action,title,note]) => `<button class="drawerActionBtn" type="button" data-patient-action="${action}" data-patient-id="${escapeHtml(p.patientId || patientId)}" data-patient-name="${escapeHtml(p.fullName || p.patientName || '')}">${title}<small>${note}</small></button>`).join('')}
        </div>
      </div>
      </section>
      <section class="drawerTabPane hidden" data-drawer-pane="timeline">
      <div class="drawerSplitGrid">
        <div class="drawerPanelCard">
          <div class="cardHead compact"><div><div class="eyebrow">Timeline</div><h3>Recent Encounters</h3></div></div>
          <div class="stack10">${encounters.length ? encounters.map(v => `<div class="drawerTimelineRow"><div class="itemTitle">${escapeHtml(v.kind || 'Visit')} • ${escapeHtml(v.status || '--')}</div><div>${escapeHtml(v.doctorName || v.title || '--')}</div><div class="itemMeta"><span>${escapeHtml(v.reason || v.category || '--')}</span><span>${fmtDateTime(v.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">No recent encounters for this patient.</div>`}</div>
        </div>
        <div class="drawerPanelCard">
          <div class="cardHead compact"><div><div class="eyebrow">Admissions</div><h3>Inpatient Summary</h3></div></div>
          <div class="stack10">${admissions.length ? admissions.map(a => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(a.ward || 'Ward')} • ${escapeHtml(a.status || '--')}</div><div>${escapeHtml(a.doctorName || '--')}</div><div class="itemMeta"><span>${escapeHtml(a.bed || '--')}</span><span>${fmtDateTime(a.admittedAt || a.createdAt)}</span></div></div>`).join('') : `<div class="emptyState">No admission records for this patient.</div>`}</div>
        </div>
      </div>
      </section>
      <section class="drawerTabPane hidden" data-drawer-pane="finance">
      <div class="drawerSection">
        <div class="cardHead compact"><div><div class="eyebrow">Billing</div><h3>Receipt Preview Queue</h3></div></div>
        <div class="stack10">${billing.length ? billing.map(b => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(b.category || 'General')} • ${money(b.total)}</div><div class="itemMeta"><span>${money(b.paid)} paid</span><span>${money(b.balance)} balance</span><span>${fmtDateTime(b.createdAt)}</span></div><div class="inlineActions"><button class="pillBtn" type="button" data-receipt="${escapeHtml(b.billId || '')}">Open Receipt</button><button class="pillBtn warn" type="button" data-edit-bill="${escapeHtml(b.billId || '')}" data-category="${escapeHtml(b.category || '')}" data-total="${escapeHtml(String(b.total || ''))}" data-paid="${escapeHtml(String(b.paid || ''))}" data-status="${escapeHtml(b.status || '')}" data-payment="${escapeHtml(b.paymentMethod || '')}" data-description="${escapeHtml(b.description || '')}">Edit Bill</button></div></div>`).join('') : `<div class="emptyState">No bills created for this patient.</div>`}</div>
      </div>
      </section>
    `);
    document.getElementById('drawerBillBtn')?.addEventListener('click', () => { closeModal(); setSelectedPatient(p); openBillModal(p.patientId || patientId, p.fullName || p.patientName || ''); });
    document.getElementById('drawerEditBtn')?.addEventListener('click', () => openPatientWizard(p));
    const activeModal = document.getElementById('activeModal');
    bindPatientActionButtons(activeModal);
    $$('.drawerTabBtn', activeModal).forEach(btn => btn.addEventListener('click', () => {
      const tab = btn.dataset.drawerTab;
      $$('.drawerTabBtn', activeModal).forEach(x => x.classList.toggle('active', x === btn));
      $$('.drawerTabPane', activeModal).forEach(pane => pane.classList.toggle('hidden', pane.dataset.drawerPane !== tab));
    }));
    $$('[data-receipt]', activeModal).forEach(btn => btn.addEventListener('click', () => openReceiptPreview(btn.dataset.receipt)));
    $$('[data-edit-bill]', activeModal).forEach(btn => btn.addEventListener('click', () => openBillEditModal({ billId: btn.dataset.editBill, category: btn.dataset.category, total: btn.dataset.total, paid: btn.dataset.paid, status: btn.dataset.status, paymentMethod: btn.dataset.payment, description: btn.dataset.description })));
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
          <div class="receiptBanner">
            <div class="receiptBannerTop">
              <div>
                <div class="eyebrow" style="color:#b7d7ff">Billing Receipt</div>
                <div class="receiptTitle">${escapeHtml(receipt.clinicName || 'Clinic Pro NG')}</div>
                <div>${escapeHtml(receipt.branchName || 'Main Branch')}</div>
              </div>
              <div class="receiptBadge">${escapeHtml(receipt.status || 'Pending')}</div>
            </div>
          </div>
          <div class="receiptClinicBlock">
            <div class="receiptExecutiveGrid">
              <div class="receiptIdentityCard">
                <h4>Billing Identity</h4>
                <div class="receiptRow"><span>Patient</span><strong>${escapeHtml(receipt.patientName || '--')}</strong></div>
                <div class="receiptRow"><span>Patient ID</span><strong>${escapeHtml(receipt.patientId || '--')}</strong></div>
                <div class="receiptRow"><span>Bill No</span><strong>${escapeHtml(receipt.billNo || '--')}</strong></div>
                <div class="receiptRow"><span>Category</span><strong>${escapeHtml(receipt.category || '--')}</strong></div>
                <div class="receiptRow"><span>Description</span><strong>${escapeHtml(receipt.description || '--')}</strong></div>
              </div>
              <div class="receiptMetaCard">
                <h4>Receipt Meta</h4>
                <div class="receiptSpotlight"><span>Generated</span><strong>${escapeHtml(receipt.generatedLabel || fmtDateTime(new Date().toISOString()))}</strong></div>
                <div class="receiptSpotlight" style="margin-top:12px"><span>Payment Method</span><strong>${escapeHtml(receipt.paymentMethod || '--')}</strong></div>
                <div class="receiptSpotlight" style="margin-top:12px"><span>Workflow Note</span><strong>World-class portal preview aligned with Android receipt flow.</strong></div>
              </div>
            </div>
            <div class="receiptTotalsGrid">
              <div class="receiptTotalCard"><span>Total</span><strong>${money(receipt.total || 0)}</strong></div>
              <div class="receiptTotalCard"><span>Paid</span><strong>${money(receipt.paid || 0)}</strong></div>
              <div class="receiptTotalCard"><span>Balance</span><strong>${money(receipt.balance || 0)}</strong></div>
            </div>
          </div>
          <div class="receiptFooterNote receiptCenter receiptSmall">This premium preview is optimized for executive billing review, while Android can still print the thermal version instantly.</div>
          <div class="receiptActionBar"><button class="pillBtn receiptActionBtn" type="button" id="receiptPrintBtn">Print</button><button class="pillBtn warn receiptActionBtn" type="button" id="receiptEditBtn">Edit Bill</button></div>
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
    const q = new URLSearchParams({ hospitalId: state.hospitalId });
    if (state.authToken) q.set('token', state.authToken);
    const url = buildUrl(`/api/events/stream?${q.toString()}`);
    state.sse = new EventSource(url, { withCredentials: false });
    state.sse.onopen = () => {
      state.transport = 'SSE';
      $('#transportText').textContent = 'SSE Live';
      document.getElementById('focusChipTransport').textContent = 'Realtime SSE Live';
      $('#realtimeText').textContent = `Streaming${state.version ? ' • v' + state.version : ''}`;
      setLiveState('Realtime Connected', 'connected');
    };
    state.sse.onmessage = (e) => handleRealtimeEvent(e.data);
    state.sse.addEventListener('hello', () => {
      state.transport = 'SSE';
      $('#transportText').textContent = 'SSE Live';
      document.getElementById('focusChipTransport').textContent = 'Realtime SSE Live';
      $('#realtimeText').textContent = `Streaming${state.version ? ' • v' + state.version : ''}`;
    });
    state.sse.addEventListener('ping', () => {
      state.lastSync = Date.now();
      $('#lastSyncText').textContent = fmtTime(state.lastSync);
      document.getElementById('focusChipSync').textContent = `Last Sync ${fmtTime(state.lastSync)}`;
    document.getElementById('focusChipSync').textContent = `Last Sync ${fmtTime(state.lastSync)}`;
    document.getElementById('focusChipTransport').textContent = `Realtime ${state.transport}`;
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
  const needsNotifications = ['audit_logs','patients','visits','bills','doctor_queue','appointments','admissions','lab_requests','pharmacy_dispenses','nurse_desk','prescriptions','staff'].some(k => keys.has(k)) || !keys.size;
  if (needsOps) ['queue','overview','aiOverview','risk','doctorWidgets','workspace'].forEach(k => include.add(k));
  if (needsFinance) include.add('finance');
  if (needsTimeline) include.add('timeline');
  if (needsPatients) include.add('patients');
  if (needsNotifications) include.add('notifications');
  await loadLiteBundle(Array.from(include));
  if (needsOps) {
    try { await loadClinicalOps(); } catch {}
  }
  if (needsFinance) {
    try { await loadFinancialIntelligence(); } catch {}
    try { await loadInventoryIntelligence(); } catch {}
  }
  if (keys.has('staff')) { try { await loadRbac(); } catch {} }
  if (keys.has('audit_logs')) { try { await loadAuditTrail(); } catch {} }
  if (versionHint) state.version = Math.max(state.version || 0, num(versionHint));
  renderAll();
}

function handleRealtimeEvent(raw) {
  state.lastSync = Date.now();
  $('#lastSyncText').textContent = fmtTime(state.lastSync);
    document.getElementById('focusChipSync').textContent = `Last Sync ${fmtTime(state.lastSync)}`;
    document.getElementById('focusChipTransport').textContent = `Realtime ${state.transport}`;
  let event = null;
  try { event = JSON.parse(raw); } catch {}
  const type = String(event?.type || event?.event || '').toLowerCase();
  const versionHint = num(event?.payload?.version || event?.version || 0);
  const tables = Array.from(new Set([...(event?.payload?.tables || []), ...(event?.payload?.changedTables || []), ...inferTablesFromType(type)]));
  state.version = Math.max(state.version || 0, versionHint);
  if (type) showToast('Realtime Update', event.title || event.message || formatActivityType(type));
  if (event) {
    applyRealtimeMutation(event);
    pushRealtimeNotification(event);
  }
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
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs || 25000);
  const timer = setTimeout(() => controller.abort(new DOMException('Request timeout', 'AbortError')), timeoutMs);
  const extraHeaders = { ...(options.headers || {}) };
  const headers = getAuthHeaders(extraHeaders);
  if (!(options.body instanceof FormData) && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  try {
    const res = await fetch(buildUrl(path), {
      method: options.method || 'GET',
      headers,
      body: options.body ? (options.body instanceof FormData ? options.body : JSON.stringify(options.body)) : undefined,
      signal: controller.signal,
    });
    let json = {};
    try { json = await res.json(); } catch {}
    if (!res.ok || json.ok === false) throw new Error(json.error || json.message || `Request failed (${res.status})`);
    return json;
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('Request timed out. Check Base URL / server health and try again.');
    if (/Failed to fetch/i.test(String(err?.message || ''))) throw new Error(`Unable to reach ${state.baseUrl}. Check Base URL, DNS, SSL or server status.`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
    pharmacy: num(f.pharmacySales || o.pharmacyRevenue || o.pharmacy),
    pharmacyDispenseCount: num(f.pharmacyDispenseCount || o.pharmacy || 0)
  };
  cc.cards = [
    { key:'patients', label:'Patients', value: cc.counts.patients, sub:'Registered patient base' },
    { key:'visits', label:'Active Visits', value: cc.counts.visits, sub:'Clinical load in motion' },
    { key:'queue', label:'Queue', value: cc.counts.queue, sub:'Doctor waiting line' },
    { key:'totalPaid', label:'Paid Revenue', value: cc.counts.totalPaid, kind:'money', sub:'Collected billing revenue' },
    { key:'outstanding', label:'Outstanding', value: cc.counts.outstanding, kind:'money', sub:'Awaiting payment' },
    { key:'bills', label:'Bills', value: cc.counts.bills, sub:'Billing records created' },
    { key:'admissions', label:'Admissions', value: cc.counts.admissions, sub:'Current admissions' },
    { key:'pharmacy', label:'Pharmacy Revenue', value: cc.counts.pharmacy, kind:'money', sub:`${cc.counts.pharmacyDispenseCount || 0} dispense record(s)` },
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


function renderClinicalOps() {
  const grid = document.getElementById('clinicalOpsGrid');
  const lists = document.getElementById('clinicalOpsLists');
  if (!grid || !lists) return;
  const mods = state.data.clinicalOps || {};
  const cards = [
    { label:'Patient Registration', value:num(mods.registration?.count), sub:'Registered patient base' },
    { label:'OPD / Visits', value:num(mods.visits?.count), sub:'Active clinical encounters' },
    { label:'Doctor Queue', value:num(mods.queue?.count), sub:'Patients waiting for doctors' },
    { label:'Admissions / Ward', value:num(mods.admissions?.count), sub:'Current inpatient load' },
    { label:'Nursing Desk', value:num(mods.nursing?.count), sub:'Open nursing actions' },
    { label:'Lab Orders', value:num(mods.labs?.count), sub:'Pending lab requests' },
    { label:'Pharmacy Revenue', value:money(mods.pharmacy?.revenue || 0), sub:`${num(mods.pharmacy?.count)} dispense(s)` },
    { label:'Prescription Tracking', value:num(mods.prescriptions?.count), sub:'Active medication orders' },
    { label:'Billing', value:money(mods.billing?.revenue || 0), sub:`Outstanding ${money(mods.billing?.outstanding || 0)}` },
    { label:'Appointments', value:num(mods.appointments?.count), sub:'Upcoming booked appointments' },
    { label:'Theatre / Procedures', value:num(mods.theatre?.count), sub:'Scheduled procedures' },
    { label:'Discharge Workflow', value:num(mods.discharges?.count), sub:`Refunds ${money(mods.refunds?.amount || 0)}` },
  ];
  grid.innerHTML = cards.map(c => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(c.label)}</div><div style="font-size:24px;font-weight:900">${escapeHtml(String(c.value))}</div><div class="itemMeta"><span>${escapeHtml(c.sub)}</span></div></div>`).join('');
  const sections = [
    ['Recent Registrations', mods.registration?.recent || [], row => `${escapeHtml(row.fullName || row.patientName || '--')}<span>${escapeHtml(row.patientId || '--')}</span>`],
    ['Visit Queue', mods.queue?.recent || [], row => `${escapeHtml(row.patientName || row.patientId || '--')}<span>${escapeHtml(row.doctorName || row.doctor || row.status || '--')}</span>`],
    ['Admissions', mods.admissions?.recent || [], row => `${escapeHtml(row.patientName || row.patientId || '--')}<span>${escapeHtml(row.ward || row.reason || row.status || '--')}</span>`],
    ['Lab Orders', mods.labs?.recent || [], row => `${escapeHtml(row.testName || row.name || '--')}<span>${escapeHtml(row.patientName || row.patientId || row.status || '--')}</span>`],
    ['Pharmacy Dispenses', mods.pharmacy?.recent || [], row => `${escapeHtml(row.itemName || row.drugName || '--')}<span>${money(row.total || 0)}</span>`],
    ['Bills / Payments', mods.billing?.recent || [], row => `${escapeHtml(row.patientName || row.patientId || '--')}<span>${money(row.total || row.amount || 0)}</span>`],
    ['Appointments', mods.appointments?.recent || [], row => `${escapeHtml(row.patientName || row.patientId || '--')}<span>${escapeHtml(row.appointmentDate || row.date || row.status || '--')}</span>`],
    ['Theatre Schedule', mods.theatre?.recent || [], row => `${escapeHtml(row.procedureName || '--')}<span>${escapeHtml(row.theatreDate || row.status || '--')}</span>`],
    ['Discharges / Refunds', [...(mods.discharges?.recent || []).slice(0,4), ...(mods.refunds?.recent || []).slice(0,4)], row => `${escapeHtml(row.patientName || row.billId || row.procedureName || '--')}<span>${escapeHtml(row.dischargeSummary || row.reason || row.amount || row.status || '--')}</span>`],
  ];
  lists.innerHTML = sections.map(([title, rows, fmt]) => `<div class="miniPanel"><div class="itemTitle">${escapeHtml(title)}</div>${rows.length ? rows.slice(0,4).map(r => `<div class="feedItem compactFeed"><div style="display:flex;justify-content:space-between;gap:12px"><div>${fmt(r)}</div><div class="itemMeta"><span>${fmtDateTime(r.createdAt || r.updatedAt)}</span></div></div></div>`).join('') : `<div class="emptyState">No records yet.</div>`}</div>`).join('');
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
    const collectionRate = num(f.totalBill) ? Math.round((num(f.totalPaid) / Math.max(num(f.totalBill), 1)) * 100) : 0;
    const cards = [
      { title:'Instant Revenue', value: money(f.totalPaid), sub:`${collectionRate}% collection strength`, cta:'New Bill', action:'bill' },
      { title:'Pending Collection', value: money(f.outstanding), sub:'Outstanding exposure requiring action', cta:'Find Patient', action:'search' },
      { title:'Bills Created', value: num(f.billCount), sub:'Billing volume across the system', cta:'Direct Billing', action:'bill' }
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

function renderHorizontalBars(id, rows, formatter = v => money(v)) {
  const host = document.getElementById(id);
  if (!host) return;
  const data = Array.isArray(rows) ? rows.filter(Boolean).slice(0, 8) : [];
  if (!data.length) return renderEmptyChart(id, 'No chart data');
  const max = Math.max(...data.map(x => num(x.value)), 1);
  host.innerHTML = `<div class="stack10">${data.map(x => `
    <div class="metricRow">
      <div class="dualBar">
        <div class="dualBarRow"><strong>${escapeHtml(x.label || '--')}</strong><span>${escapeHtml(String(formatter(num(x.value), x)))}</span></div>
        <div class="progress"><span style="width:${Math.max(4, Math.min(100, (num(x.value) / max) * 100))}%"></span></div>
      </div>
    </div>`).join('')}</div>`;
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
