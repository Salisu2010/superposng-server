const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const ngn = (v) => 'NGN ' + Number(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const qs = new URLSearchParams(location.search);
let activeTab = 'overview';

$('base').value = qs.get('base') || localStorage.getItem('clinic_base') || location.origin;
$('hospitalId').value = qs.get('hospitalId') || localStorage.getItem('clinic_hospital_id') || '';
$('token').value = qs.get('token') || localStorage.getItem('clinic_token') || '';

function saveConn() {
  localStorage.setItem('clinic_base', $('base').value.trim());
  localStorage.setItem('clinic_hospital_id', $('hospitalId').value.trim());
  localStorage.setItem('clinic_token', $('token').value.trim());
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
  if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

function fmtDate(v) {
  const n = Number(v || 0);
  if (!n) return '--';
  try { return new Date(n).toLocaleString(); } catch { return '--'; }
}

function card(label, value, sub) {
  return `<div class="card metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="muted">${esc(sub || '')}</div></div>`;
}

function item(title, lines = []) {
  return `<div class="item"><strong>${esc(title || '--')}</strong>${lines.map(x => `<div class="muted">${esc(x)}</div>`).join('')}</div>`;
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
  document.querySelectorAll('.tabSection').forEach(el => { el.style.display = 'none'; });
  const target = document.getElementById('tab-' + tab);
  if (target) target.style.display = '';
  document.querySelectorAll('.navBtn').forEach(btn => {
    btn.style.outline = btn.dataset.tab === tab ? '2px solid rgba(14,165,233,.85)' : 'none';
  });
}

async function loadOverview() {
  const [overview, finance, queue, ai, risks] = await Promise.all([
    api('/api/portal/overview'),
    api('/api/portal/finance'),
    api('/api/portal/queue'),
    api('/api/ai/clinic_overview'),
    api('/api/ai/risk_analysis')
  ]);
  const o = overview.overview || {};
  $('cards').innerHTML = [
    card('Patients', o.patients || 0, 'registered'),
    card('Visits', o.visits || 0, 'overall'),
    card('Queue', o.queue || 0, 'live'),
    card('Revenue', ngn(o.totalPaid || 0), 'paid'),
    card('Outstanding', ngn(o.outstanding || 0), 'pending'),
    card('Bills', o.bills || 0, 'created'),
    card('Admissions', o.admissions || 0, 'active'),
    card('Low Stock', (o.lowStock || []).length, 'pharmacy')
  ].join('');
  $('queue').innerHTML = (queue.queue || []).slice(0, 15).map(x => item(x.patient_name || x.patientName || x.patientName || 'Patient', [
    x.complaint || x.status || 'Queue item',
    'Doctor: ' + (x.doctor_name || x.doctorName || x.doctor || 'Unassigned'),
    'Priority: ' + (x.priority || 'normal')
  ])).join('') || '<div class="item">No live queue</div>';
  $('alerts').innerHTML = (ai.alerts || []).map(x => item(x.type || 'Alert', [x.message || '', 'Severity: ' + (x.severity || '--')])).join('') || '<div class="item">No AI alerts</div>';
  $('doctors').innerHTML = (o.doctorWorkload || []).map(x => item(x.doctor || 'Doctor', ['Open load: ' + (x.count || 0)])).join('') || '<div class="item">No doctor workload yet</div>';
  const f = finance.finance || {};
  const rp = ((risks.risks || {}).queue_pressure || {});
  $('finance').innerHTML = [
    item('Total Bill', [ngn(f.totalBill || 0)]),
    item('Total Paid', [ngn(f.totalPaid || 0)]),
    item('Outstanding', [ngn(f.outstanding || 0)]),
    item('Queue Pressure', ['Score: ' + (rp.score || 0)])
  ].join('');
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
  ])).join('') || '<div class="item">No patient yet</div>';

  $('billsList').innerHTML = (bills.bills || []).slice(0, 20).map(x => item(x.patientName || 'Bill', [
    'Bill ID: ' + (x.billId || '--'),
    'Total: ' + ngn(x.total || 0),
    'Paid: ' + ngn(x.paid || 0),
    'Balance: ' + ngn(x.balance || 0)
  ])).join('') || '<div class="item">No bill yet</div>';

  $('visitsList').innerHTML = (visits.visits || []).slice(0, 20).map(x => item(x.patientName || 'Visit', [
    'Visit ID: ' + (x.visitId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Reason: ' + (x.reason || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No visit yet</div>';

  $('admissionsList').innerHTML = (admissions.admissions || []).slice(0, 20).map(x => item(x.patientName || 'Admission', [
    'Admission ID: ' + (x.admissionId || '--'),
    'Ward: ' + (x.ward || '--'),
    'Bed: ' + (x.bed || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No admission yet</div>';

  $('appointmentsList').innerHTML = (appointments.appointments || []).slice(0, 20).map(x => item(x.patientName || 'Appointment', [
    'Appointment ID: ' + (x.appointmentId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Date: ' + (x.appointmentDate || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No appointment yet</div>';

  $('pharmacyList').innerHTML = (dispenses.dispenses || []).slice(0, 20).map(x => item(x.patientName || 'Dispense', [
    'Drug: ' + (x.drugName || '--'),
    'Qty: ' + (x.quantity || 0),
    'Total: ' + ngn(x.total || 0),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No pharmacy dispense yet</div>';

  $('labList').innerHTML = (labRequests.labRequests || []).slice(0, 20).map(x => item(x.patientName || 'Lab Request', [
    'Test: ' + (x.testName || '--'),
    'Requested By: ' + (x.requestedBy || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No lab request yet</div>';

  $('prescriptionsList').innerHTML = (prescriptions.prescriptions || []).slice(0, 20).map(x => item(x.patientName || 'Prescription', [
    'Drug: ' + (x.drugName || '--'),
    'Dosage: ' + (x.dosage || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No prescription yet</div>';

  $('nurseList').innerHTML = (nurseDesk.nurseDesk || []).slice(0, 20).map(x => item(x.patientName || 'Nurse Desk', [
    'Temp: ' + (x.temperature || '--'),
    'BP: ' + (x.bp || '--'),
    'Pulse: ' + (x.pulse || '--'),
    'SpO2: ' + (x.spo2 || '--')
  ])).join('') || '<div class="item">No nurse desk entry yet</div>';

  $('staffList').innerHTML = (staff.staff || []).slice(0, 20).map(x => item(x.fullName || x.email || 'Staff', [
    'Email: ' + (x.email || '--'),
    'Role: ' + (x.role || '--'),
    'Phone: ' + (x.phone || '--')
  ])).join('') || '<div class="item">No staff yet</div>';

  $('queueList').innerHTML = (doctorQueue.queue || []).slice(0, 20).map(x => item(x.patientName || 'Queue', [
    'Queue ID: ' + (x.queueId || '--'),
    'Doctor: ' + (x.doctorName || '--'),
    'Priority: ' + (x.priority || '--'),
    'Status: ' + (x.status || '--')
  ])).join('') || '<div class="item">No doctor queue yet</div>';
}

async function loadAll() {
  saveConn();
  try {
    await loadOverview();
    await refreshLists();
    $('sub').textContent = `Connected to hospital ${$('hospitalId').value.trim() || '-'} • live portal + enterprise forms active`;
  } catch (e) {
    $('sub').textContent = 'Connection failed: ' + e.message;
  }
}

async function submitForm(formId, path, successMessage) {
  const form = $(formId);
  if (!form) return;
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const data = formDataObject(form);
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
    $('searchResults').innerHTML = '<div class="item">Type something to search</div>';
    return;
  }
  try {
    const result = await api('/api/search/patient?q=' + encodeURIComponent(q));
    $('searchResults').innerHTML = (result.patients || []).map(x => item(x.fullName || 'Patient', [
      'Patient ID: ' + (x.patientId || '--'),
      'MRN: ' + (x.mrn || '--'),
      'Phone: ' + (x.phone || '--'),
      'Email: ' + (x.email || '--')
    ])).join('') || '<div class="item">No patient matched your search</div>';
  } catch (e) {
    $('searchResults').innerHTML = '<div class="item">Search failed: ' + esc(e.message) + '</div>';
  }
}

$('saveBtn').addEventListener('click', loadAll);
$('refreshBtn').addEventListener('click', loadAll);
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
submitForm('queueForm', '/api/doctor_queue/create', 'Doctor queue saved');

$('searchForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  await doSearch($('searchQuery').value.trim());
});

switchTab('overview');
if ($('token').value.trim() && $('hospitalId').value.trim()) loadAll();
