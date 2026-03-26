const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const ngn = (v) => 'NGN ' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qs = new URLSearchParams(location.search);
let activeTab = 'overview';
let feedCursor = 0;
let autoTimer = null;

$('base').value = qs.get('base') || localStorage.getItem('clinic_base') || location.origin;
$('hospitalId').value = qs.get('hospitalId') || localStorage.getItem('clinic_hospital_id') || '';
$('token').value = qs.get('token') || localStorage.getItem('clinic_token') || '';

function saveConn() {
  localStorage.setItem('clinic_base', $('base').value.trim());
  localStorage.setItem('clinic_hospital_id', $('hospitalId').value.trim());
  localStorage.setItem('clinic_token', $('token').value.trim());
}

function hasConnection() {
  return Boolean($('base').value.trim() && $('hospitalId').value.trim() && $('token').value.trim());
}

function connHeaders() {
  const hospitalId = $('hospitalId').value.trim();
  const token = $('token').value.trim();
  return {
    'Authorization': 'Bearer ' + token,
    'X-Clinic-Id': hospitalId,
    'X-Hospital-Id': hospitalId,
    'Content-Type': 'application/json'
  };
}

async function api(path, method = 'GET', body = null) {
  const base = $('base').value.trim().replace(/\/$/, '');
  const opts = { method, headers: connHeaders() };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(base + path, opts);
  const t = await r.text();
  let d = {};
  try { d = t ? JSON.parse(t) : {}; } catch { throw new Error(t || ('HTTP ' + r.status)); }
  if (!r.ok || d.ok === false) throw new Error(d.error || d.message || ('HTTP ' + r.status));
  return d;
}

function fmtDate(v) {
  const n = Number(v || 0);
  if (!n) return '--';
  try { return new Date(n).toLocaleString(); } catch { return '--'; }
}

function cardClass(label, value) {
  if (label === 'Outstanding' && Number(value) > 0) return 'kpiWarn';
  if (label === 'Revenue') return 'kpiGood';
  return 'kpiInfo';
}

function metricCard(label, value, sub) {
  return `<div class="metricCard ${esc(cardClass(label, value))}"><div class="metricLabel">${esc(label)}</div><div class="metricValue">${esc(value)}</div><div class="metricSub">${esc(sub || '')}</div></div>`;
}

function item(title, lines = []) {
  return `<div class="item"><strong>${esc(title || '--')}</strong>${lines.map(x => `<div class="muted">${esc(x)}</div>`).join('')}</div>`;
}

function emptyState(msg) {
  return `<div class="emptyState">${esc(msg)}</div>`;
}

function formDataObject(form) {
  const fd = new FormData(form);
  const out = {};
  for (const [k, v] of fd.entries()) {
    const val = String(v == null ? '' : v).trim();
    if (val !== '') out[k] = val;
  }
  return out;
}

function switchTab(tab) {
  activeTab = tab;
  document.querySelectorAll('.tabSection').forEach(el => el.classList.add('hidden'));
  const target = document.getElementById('tab-' + tab);
  if (target) target.classList.remove('hidden');
  document.querySelectorAll('.navBtn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
}

function setStatus(mode, text) {
  const pill = $('livePill');
  pill.textContent = text;
  pill.classList.remove('connected', 'error');
  if (mode === 'connected') pill.classList.add('connected');
  if (mode === 'error') pill.classList.add('error');
}

function updateClock() {
  $('systemClock').textContent = new Date().toLocaleTimeString();
}

function renderActivity(notifications = []) {
  $('activityFeed').innerHTML = notifications.length
    ? notifications.slice(0, 20).map(n => {
        const type = n.type || 'activity';
        return `<div class="feedItem"><strong>${esc(n.title || 'Clinic Activity')}</strong><div class="muted">${esc(n.message || '')}</div><div class="feedMeta"><span class="feedType">${esc(type)}</span><span>${esc(fmtDate(n.createdAt))}</span></div></div>`;
      }).join('')
    : emptyState('No recent operational activity yet.');
}

function renderAiSummary(summary) {
  if (!summary) {
    $('patientAiSummary').innerHTML = emptyState('Enter a Patient ID to load AI summary.');
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

async function loadOverview() {
  const [overview, finance, queue, ai, risks, notifications] = await Promise.all([
    api('/api/portal/overview'),
    api('/api/portal/finance'),
    api('/api/portal/queue'),
    api('/api/ai/clinic_overview'),
    api('/api/ai/risk_analysis'),
    api('/api/notifications?since=' + encodeURIComponent(feedCursor || 0))
  ]);

  const clinic = overview.clinic || {};
  const o = overview.overview || {};
  $('clinicTitle').textContent = clinic.clinicName || clinic.hospitalName || 'Clinic Pro NG Enterprise Portal';
  $('cards').innerHTML = [
    metricCard('Patients', o.patients || 0, 'registered'),
    metricCard('Visits', o.visits || 0, 'overall'),
    metricCard('Queue', o.queue || 0, 'live'),
    metricCard('Revenue', ngn(o.totalPaid || 0), 'paid'),
    metricCard('Outstanding', ngn(o.outstanding || 0), 'pending'),
    metricCard('Bills', o.bills || 0, 'created'),
    metricCard('Admissions', o.admissions || 0, 'active'),
    metricCard('Low Stock', (o.lowStock || []).length, 'pharmacy')
  ].join('');

  $('queue').innerHTML = (queue.queue || []).slice(0, 12).map(x => item(x.patientName || 'Patient', [
    'Doctor: ' + (x.doctorName || 'Unassigned'),
    'Priority: ' + (x.priority || 'normal'),
    'Status: ' + (x.status || 'waiting')
  ])).join('') || emptyState('No live queue right now.');

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
  if (incoming.length) {
    feedCursor = Math.max(feedCursor, ...incoming.map(n => Number(n.createdAt || 0)));
  }
  renderActivity(incoming);
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

  $('patientsList').innerHTML = (patients.patients || []).slice(0, 20).map(x => item(x.fullName || 'Patient', [
    'Patient ID: ' + (x.patientId || '--'),
    'MRN: ' + (x.mrn || '--'),
    'Phone: ' + (x.phone || '--')
  ])).join('') || emptyState('No patient yet.');

  $('billsList').innerHTML = (bills.bills || []).slice(0, 20).map(x => item(x.patientName || 'Bill', [
    'Bill ID: ' + (x.billId || '--'),
    'Total: ' + ngn(x.total || 0),
    'Paid: ' + ngn(x.paid || 0),
    'Balance: ' + ngn(x.balance || 0)
  ])).join('') || emptyState('No bill yet.');

  $('visitsList').innerHTML = (visits.visits || []).slice(0, 20).map(x => item(x.patientName || 'Visit', [
    'Visit ID: ' + (x.visitId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Reason: ' + (x.reason || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No visit yet.');

  $('admissionsList').innerHTML = (admissions.admissions || []).slice(0, 20).map(x => item(x.patientName || 'Admission', [
    'Admission ID: ' + (x.admissionId || '--'),
    'Ward: ' + (x.ward || '--'),
    'Bed: ' + (x.bed || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No admission yet.');

  $('appointmentsList').innerHTML = (appointments.appointments || []).slice(0, 20).map(x => item(x.patientName || 'Appointment', [
    'Appointment ID: ' + (x.appointmentId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Date: ' + (x.appointmentDate || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No appointment yet.');

  $('pharmacyList').innerHTML = (dispenses.dispenses || []).slice(0, 20).map(x => item(x.patientName || 'Dispense', [
    'Drug: ' + (x.drugName || '--'),
    'Qty: ' + (x.quantity || 0),
    'Total: ' + ngn(x.total || 0),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No pharmacy dispense yet.');

  $('labList').innerHTML = (labRequests.labRequests || []).slice(0, 20).map(x => item(x.patientName || 'Lab Request', [
    'Test: ' + (x.testName || '--'),
    'Requested By: ' + (x.requestedBy || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No lab request yet.');

  $('prescriptionsList').innerHTML = (prescriptions.prescriptions || []).slice(0, 20).map(x => item(x.patientName || 'Prescription', [
    'Drug: ' + (x.drugName || '--'),
    'Dosage: ' + (x.dosage || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No prescription yet.');

  $('nurseList').innerHTML = (nurseDesk.nurseDesk || []).slice(0, 20).map(x => item(x.patientName || 'Nurse Desk', [
    'Temp: ' + (x.temperature || '--'),
    'BP: ' + (x.bp || '--'),
    'Pulse: ' + (x.pulse || '--'),
    'SpO2: ' + (x.spo2 || '--')
  ])).join('') || emptyState('No nurse desk entry yet.');

  $('staffList').innerHTML = (staff.staff || []).slice(0, 20).map(x => item(x.fullName || x.email || 'Staff', [
    'Email: ' + (x.email || '--'),
    'Role: ' + (x.role || '--'),
    'Phone: ' + (x.phone || '--')
  ])).join('') || emptyState('No staff yet.');

  $('queueList').innerHTML = (doctorQueue.queue || []).slice(0, 20).map(x => item(x.patientName || 'Queue', [
    'Queue ID: ' + (x.queueId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Priority: ' + (x.priority || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || emptyState('No doctor queue yet.');
}

async function loadAll() {
  saveConn();
  if (!hasConnection()) {
    setStatus('error', 'Missing Connection');
    $('sub').textContent = 'Fill Base URL, Hospital ID and Bearer Token first.';
    return;
  }
  try {
    $('realtimeText').textContent = 'Loading';
    await loadOverview();
    await refreshLists();
    setStatus('connected', 'Connected');
    $('realtimeText').textContent = 'Live';
    $('sub').textContent = `Connected to hospital ${$('hospitalId').value.trim()} • Android-like enterprise portal active`;
  } catch (e) {
    setStatus('error', 'Connection Failed');
    $('realtimeText').textContent = 'Offline';
    $('sub').textContent = 'Connection failed: ' + e.message;
  }
}

async function submitForm(formId, path, successMessage, transform = (x) => x) {
  const form = $(formId);
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const data = transform(formDataObject(form));
      const result = await api(path, 'POST', data);
      form.reset();
      $('sub').textContent = successMessage + ' • ' + (result?.message || 'Saved successfully');
      await loadAll();
    } catch (e) {
      $('sub').textContent = 'Action failed: ' + e.message;
      alert(e.message);
    }
  });
}

async function doSearch(q) {
  if (!q) {
    $('searchResults').innerHTML = emptyState('Type something to search.');
    return;
  }
  try {
    const result = await api('/api/search/patient?q=' + encodeURIComponent(q));
    $('searchResults').innerHTML = (result.patients || []).map(x => item(x.fullName || 'Patient', [
      'Patient ID: ' + (x.patientId || '--'),
      'MRN: ' + (x.mrn || '--'),
      'Phone: ' + (x.phone || '--'),
      'Email: ' + (x.email || '--')
    ])).join('') || emptyState('No patient matched your search.');
  } catch (e) {
    $('searchResults').innerHTML = emptyState('Search failed: ' + e.message);
  }
}

async function loadPatientAi(patientId) {
  if (!patientId) {
    renderAiSummary(null);
    return;
  }
  try {
    const result = await api('/api/ai/patient_summary?patientId=' + encodeURIComponent(patientId));
    renderAiSummary(result);
  } catch (e) {
    $('patientAiSummary').innerHTML = emptyState('AI summary failed: ' + e.message);
  }
}

function scheduleAutoRefresh() {
  clearInterval(autoTimer);
  autoTimer = setInterval(() => {
    if (hasConnection()) loadAll();
  }, 15000);
}

$('saveBtn').addEventListener('click', loadAll);
$('refreshBtn').addEventListener('click', loadAll);
$('manualFeedBtn').addEventListener('click', loadAll);
document.querySelectorAll('.navBtn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));

submitForm('patientForm', '/api/patient/register', 'Patient saved');
submitForm('billForm', '/api/bill/create', 'Bill saved');
submitForm('visitForm', '/api/visit/create', 'Visit saved');
submitForm('admissionForm', '/api/admission/create', 'Admission saved');
submitForm('appointmentForm', '/api/appointment/create', 'Appointment saved');
submitForm('pharmacyForm', '/api/pharmacy/dispense', 'Pharmacy dispense saved');
submitForm('labForm', '/api/lab/request', 'Lab request saved');
submitForm('prescriptionForm', '/api/prescription/create', 'Prescription saved');
submitForm('nurseForm', '/api/nurse_desk/create', 'Nurse desk saved');
submitForm('staffForm', '/api/staff/create', 'Staff saved');
submitForm('queueForm', '/api/doctor_queue/create', 'Queue saved');

$('searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  doSearch(($('searchQuery').value || '').trim());
});

$('patientAiForm').addEventListener('submit', (e) => {
  e.preventDefault();
  loadPatientAi(($('patientAiId').value || '').trim());
});

updateClock();
setInterval(updateClock, 1000);
scheduleAutoRefresh();
renderAiSummary(null);
switchTab(activeTab);
if (hasConnection()) loadAll();
