const $ = (id) => document.getElementById(id);
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (m) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const ngn = (v) => 'NGN ' + Number(v || 0).toLocaleString(undefined, {minimumFractionDigits:2, maximumFractionDigits:2});
const qs = new URLSearchParams(location.search);
$('base').value = qs.get('base') || localStorage.getItem('clinic_base') || location.origin;
$('hospitalId').value = qs.get('hospitalId') || localStorage.getItem('clinic_hospital_id') || '';
$('token').value = qs.get('token') || localStorage.getItem('clinic_token') || '';

async function api(path){
  const base = $('base').value.trim().replace(/\/$/, '');
  const hospitalId = $('hospitalId').value.trim();
  const token = $('token').value.trim();
  const r = await fetch(base + path, { headers: { 'Authorization': 'Bearer ' + token, 'X-Clinic-Id': hospitalId, 'X-Hospital-Id': hospitalId } });
  const t = await r.text();
  let d = {};
  try { d = t ? JSON.parse(t) : {}; } catch { throw new Error(t || ('HTTP ' + r.status)); }
  if (!r.ok || d.ok === false) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

function card(label, value, sub){
  return `<div class="card metric"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="muted">${esc(sub || '')}</div></div>`;
}

async function loadAll(){
  localStorage.setItem('clinic_base', $('base').value.trim());
  localStorage.setItem('clinic_hospital_id', $('hospitalId').value.trim());
  localStorage.setItem('clinic_token', $('token').value.trim());
  try {
    const overview = await api('/api/portal/overview');
    const finance = await api('/api/portal/finance');
    const queue = await api('/api/portal/queue');
    const ai = await api('/api/ai/clinic_overview');
    const risks = await api('/api/ai/risk_analysis');
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
    $('queue').innerHTML = (queue.queue || []).slice(0, 15).map(x => `<div class="item"><strong>${esc(x.patient_name || x.patientName || 'Patient')}</strong><div>${esc(x.complaint || x.status || 'Queue item')}</div><div class="muted">Doctor ${esc(x.doctor_name || x.doctor || 'Unassigned')}</div></div>`).join('') || '<div class="item">No live queue</div>';
    $('alerts').innerHTML = (ai.alerts || []).map(x => `<div class="item"><strong>${esc(x.type)}</strong><div>${esc(x.message)}</div><div class="muted">Severity ${esc(x.severity)}</div></div>`).join('') || '<div class="item">No AI alerts</div>';
    $('doctors').innerHTML = (o.doctorWorkload || []).map(x => `<div class="item"><strong>${esc(x.doctor)}</strong><div class="muted">Open load ${esc(x.count)}</div></div>`).join('') || '<div class="item">No doctor workload yet</div>';
    const f = finance.finance || {};
    const rp = (risks.risks || {}).queue_pressure || {};
    $('finance').innerHTML = `<div class="item"><strong>Total Bill</strong><div class="muted">${ngn(f.totalBill || 0)}</div></div><div class="item"><strong>Total Paid</strong><div class="muted">${ngn(f.totalPaid || 0)}</div></div><div class="item"><strong>Outstanding</strong><div class="muted">${ngn(f.outstanding || 0)}</div></div><div class="item"><strong>Queue Pressure</strong><div class="muted">Score ${esc(rp.score || 0)}</div></div>`;
    $('sub').textContent = `Connected to hospital ${$('hospitalId').value.trim() || '-'} • live overview active`;
  } catch (e) {
    $('sub').textContent = 'Connection failed: ' + e.message;
  }
}
$('saveBtn').addEventListener('click', loadAll);
if ($('token').value.trim() && $('hospitalId').value.trim()) loadAll();
