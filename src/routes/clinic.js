import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { readDB, writeDB } from '../db.js';
import { clinicPublish } from '../clinic_events.js';
import { ensureFcm, pushShopChange } from '../fcm.js';

const r = Router();

function secret(){ return process.env.JWT_SECRET || 'dev_secret_change_me'; }
function sign(payload){ return jwt.sign(payload, secret(), { expiresIn: '30d' }); }
function now(){ return Date.now(); }
function toStr(v){ return v == null ? '' : String(v).trim(); }
function toNum(v, d=0){ const n = Number(v); return Number.isFinite(n) ? n : d; }
function arr(v){ return Array.isArray(v) ? v : []; }
function lower(v){ return toStr(v).toLowerCase(); }
function bool(v){
  if (typeof v === 'boolean') return v;
  const s = lower(v);
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}
function normRole(v){
  const m = lower(v);
  if (!m) return 'Cashier';
  if (m === 'reception' || m === 'receptionist') return 'Receptionist';
  if (m === 'doctor') return 'Doctor';
  if (m === 'nurse') return 'Nurse';
  if (m === 'cashier') return 'Cashier';
  if (m === 'admin' || m === 'manager' || m === 'owner') return 'Admin';
  if (m === 'pharmacy' || m === 'pharmacist') return 'Pharmacy';
  if (m === 'lab' || m === 'laboratory') return 'Lab';
  return toStr(v) || 'Cashier';
}
function clinicCode(){ return ('CLN-' + nanoid(6)).toUpperCase(); }
function safeEmail(v){ return lower(v).replace(/\s+/g, ''); }
function authClinicId(req){ return toStr(req.auth?.clinicId || req.auth?.hospitalId || req.headers['x-clinic-id'] || req.headers['x-hospital-id']); }
function roleAllowed(req, allowed){
  const role = normRole(req.auth?.role);
  return allowed.includes(role) || allowed.includes('*');
}
function requireClinic(req, res){
  let clinicId = authClinicId(req) || toStr(req.body?.hospitalId || req.body?.clinic_id || req.body?.clinicId || req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
  if (clinicId) return clinicId;
  try {
    const db = readDB(); ensureArrays(db);
    clinicId = toStr(db.clinics?.[0]?.clinicId || db.clinicSnapshots?.[0]?.clinicId || db.clinicPatients?.[0]?.clinicId || db.clinicBills?.[0]?.clinicId);
    if (clinicId) return clinicId;
  } catch {}
  res.status(401).json({ ok:false, error:'Missing clinic context' });
  return null;
}
function createId(prefix){ return `${prefix}_${nanoid(12)}`; }
function cleanPhone(v){ return toStr(v).replace(/\s+/g, ''); }
function pickPatientId(x){ return toStr(x?.patientId || x?.patient_id || x?.id); }
function pickDoctorName(x){ return toStr(x?.doctorName || x?.doctor_name || x?.doctor || x?.doctorId || 'Unassigned'); }
function pickStatus(x, fallback='pending'){ return toStr(x?.status || fallback) || fallback; }
function cap(v){ const s = toStr(v); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function ensureArrays(db){
  db.clinics = arr(db.clinics);
  db.clinicDevices = arr(db.clinicDevices);
  db.clinicUsers = arr(db.clinicUsers);
  db.clinicSnapshots = arr(db.clinicSnapshots);
  db.clinicBackups = arr(db.clinicBackups);
  db.clinicNotifications = arr(db.clinicNotifications);
  db.clinicEvents = arr(db.clinicEvents);
  db.clinicBranches = arr(db.clinicBranches);
  db.clinicSyncCursor = arr(db.clinicSyncCursor);

  db.clinicPatients = arr(db.clinicPatients);
  db.clinicBills = arr(db.clinicBills);
  db.clinicVisits = arr(db.clinicVisits);
  db.clinicAdmissions = arr(db.clinicAdmissions);
  db.clinicAppointments = arr(db.clinicAppointments);
  db.clinicPharmacyDispenses = arr(db.clinicPharmacyDispenses);
  db.clinicLabRequests = arr(db.clinicLabRequests);
  db.clinicPrescriptions = arr(db.clinicPrescriptions);
  db.clinicNurseDesk = arr(db.clinicNurseDesk);
  db.clinicDoctorQueue = arr(db.clinicDoctorQueue);
  db.clinicPharmacyItems = arr(db.clinicPharmacyItems);
  db.clinicVitals = arr(db.clinicVitals);
  db.clinicAuditLogs = arr(db.clinicAuditLogs);
  db.clinicProfiles = arr(db.clinicProfiles);
}
function clinicPublicRow(c){
  return {
    clinicId: c.clinicId,
    hospitalId: c.clinicId,
    clinicCode: c.clinicCode,
    hospitalCode: c.clinicCode,
    clinicName: c.clinicName,
    hospitalName: c.clinicName,
    ownerEmail: c.ownerEmail,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    branchCount: toNum(c.branchCount, 1)
  };
}
function getLatestSnapshot(db, clinicId){
  const list = db.clinicSnapshots.filter(x => String(x.clinicId) === String(clinicId));
  if (!list.length) return null;
  list.sort((a,b) => toNum(b.createdAt) - toNum(a.createdAt));
  return list[0];
}
function getCursor(db, clinicId, deviceId){
  return db.clinicSyncCursor.find(x => String(x.clinicId) === String(clinicId) && String(x.deviceId) === String(deviceId)) || null;
}
function setCursor(db, clinicId, deviceId, ts){
  const row = { clinicId: String(clinicId), deviceId: String(deviceId), lastSyncAt: toNum(ts), updatedAt: now() };
  const i = db.clinicSyncCursor.findIndex(x => String(x.clinicId) === row.clinicId && String(x.deviceId) === row.deviceId);
  if (i >= 0) db.clinicSyncCursor[i] = { ...db.clinicSyncCursor[i], ...row };
  else db.clinicSyncCursor.push(row);
}
function makeNotification(db, clinicId, type, title, message, extra = {}){
  const row = {
    id: 'ntf_' + nanoid(12),
    clinicId: String(clinicId),
    type: toStr(type) || 'info',
    title: toStr(title) || 'Clinic Notification',
    message: toStr(message),
    createdAt: now(),
    ...extra
  };
  db.clinicNotifications.push(row);
  clinicPublish(clinicId, 'notification', row);
  try {
    ensureFcm();
    pushShopChange(String(clinicId), { type: 'CLINIC_NOTIFICATION', title: row.title, body: row.message, eventType: row.type }).catch(() => {});
  } catch {}
  return row;
}
function pushEvent(db, clinicId, type, payload = {}){
  const row = {
    id: 'evt_' + nanoid(12),
    clinicId: String(clinicId),
    type: toStr(type) || 'update',
    payload,
    createdAt: now()
  };
  db.clinicEvents.push(row);
  clinicPublish(clinicId, row.type, row);
  return row;
}
function clinicRows(db, clinicId){
  const match = x => String(x.clinicId) === String(clinicId);
  return {
    clinic_profile: db.clinicProfiles.filter(match),
    audit_logs: db.clinicAuditLogs.filter(match),
    patients: db.clinicPatients.filter(match),
    bills: db.clinicBills.filter(match),
    visits: db.clinicVisits.filter(match),
    admissions: db.clinicAdmissions.filter(match),
    appointments: db.clinicAppointments.filter(match),
    pharmacy_items: db.clinicPharmacyItems.filter(match),
    pharmacy_dispenses: db.clinicPharmacyDispenses.filter(match),
    lab_requests: db.clinicLabRequests.filter(match),
    prescriptions: db.clinicPrescriptions.filter(match),
    nurse_desk: db.clinicNurseDesk.filter(match),
    doctor_queue: db.clinicDoctorQueue.filter(match),
    vitals: db.clinicVitals.filter(match),
    staff: db.clinicUsers.filter(match)
  };
}
function toSnakePatient(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId || x.id),
    full_name: toStr(x.full_name || x.fullName || x.patientName),
    phone: toStr(x.phone),
    gender: toStr(x.gender),
    age: toNum(x.age, 0),
    address: toStr(x.address),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeVisit(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    visit_no: toStr(x.visit_no || x.visitNo || x.id),
    complaint: toStr(x.complaint),
    doctor_name: toStr(x.doctor_name || x.doctorName),
    status: toStr(x.status || 'Pending'),
    diagnosis: toStr(x.diagnosis),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeBill(x){
  const total = toNum(x.total || x.amount, 0);
  const paid = toNum(x.paid || x.amount_paid || x.amountPaid, 0);
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    receipt_no: toStr(x.receipt_no || x.receiptNo || x.billNo || x.billId || x.id),
    consultation: toNum(x.consultation, 0),
    lab: toNum(x.lab, 0),
    drugs: toNum(x.drugs, 0),
    other: toNum(x.other, 0),
    total,
    paid,
    balance: Math.max(0, toNum(x.balance, total - paid)),
    payment_method: toStr(x.payment_method || x.paymentMethod),
    cashier: toStr(x.cashier || x.createdBy || x.actor),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakePrescription(x){
  return {
    id: toNum(x.id || x.localId, 0),
    visit_no: toStr(x.visit_no || x.visitNo),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    medicine: toStr(x.medicine || x.drug_name),
    dosage: toStr(x.dosage),
    instructions: toStr(x.instructions),
    prescribed_by: toStr(x.prescribed_by || x.prescribedBy || x.doctor_name),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakePharmacyItem(x){
  return {
    id: toNum(x.id || x.localId, 0),
    item_name: toStr(x.item_name || x.itemName),
    unit_price: toNum(x.unit_price || x.unitPrice, 0),
    stock_qty: toNum(x.stock_qty || x.stockQty || x.qty || x.quantity, 0),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeDispense(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    item_name: toStr(x.item_name || x.itemName),
    qty: toNum(x.qty || x.quantity, 0),
    unit_price: toNum(x.unit_price || x.unitPrice, 0),
    total: toNum(x.total, 0),
    dispensed_by: toStr(x.dispensed_by || x.dispensedBy || x.staff),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeAdmission(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    ward_name: toStr(x.ward_name || x.wardName),
    bed_no: toStr(x.bed_no || x.bedNo),
    reason: toStr(x.reason),
    status: toStr(x.status),
    admitted_by: toStr(x.admitted_by || x.admittedBy),
    discharged_by: toStr(x.discharged_by || x.dischargedBy),
    admitted_at: toNum(x.admitted_at || x.admittedAt || x.createdAt, 0),
    discharged_at: toNum(x.discharged_at || x.dischargedAt, 0)
  };
}
function toSnakeAppointment(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    appointment_no: toStr(x.appointment_no || x.appointmentNo || x.id),
    doctor_name: toStr(x.doctor_name || x.doctorName),
    appointment_date: toStr(x.appointment_date || x.appointmentDate),
    appointment_time: toStr(x.appointment_time || x.appointmentTime),
    reason: toStr(x.reason),
    status: toStr(x.status),
    created_by: toStr(x.created_by || x.createdBy),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeVitals(x){
  return {
    id: toNum(x.id || x.localId, 0),
    patient_id: toStr(x.patient_id || x.patientId),
    patient_name: toStr(x.patient_name || x.patientName),
    visit_no: toStr(x.visit_no || x.visitNo),
    temperature: toStr(x.temperature),
    bp: toStr(x.bp),
    pulse: toStr(x.pulse),
    weight: toStr(x.weight),
    height: toStr(x.height),
    spo2: toStr(x.spo2),
    notes: toStr(x.notes),
    recorded_by: toStr(x.recorded_by || x.recordedBy),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function toSnakeStaff(x){
  return {
    id: toNum(x.id || x.localId, 0),
    full_name: toStr(x.full_name || x.fullName || x.email),
    username: toStr(x.username || x.email),
    role: toStr(x.role),
    pin: toStr(x.pin || ''),
    created_at: toNum(x.created_at || x.createdAt || x.updatedAt, 0)
  };
}
function buildSnapshotData(db, clinicId){
  const rows = clinicRows(db, clinicId);
  const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  const branch = db.clinicBranches.find(x => String(x.clinicId) === String(clinicId) && (x.isMain || true));
  const profile = rows.clinic_profile.length ? rows.clinic_profile[0] : { clinic_name: clinic?.clinicName || 'Clinic Pro NG', clinic_address: '', clinic_phone: '', branch_name: branch?.name || 'Main Branch' };
  return {
    exported_at: now(),
    data: {
      clinic_profile: [{
        id: 1,
        clinic_name: toStr(profile.clinic_name || profile.clinicName || clinic?.clinicName || 'Clinic Pro NG'),
        clinic_address: toStr(profile.clinic_address || profile.clinicAddress || ''),
        clinic_phone: toStr(profile.clinic_phone || profile.clinicPhone || ''),
        branch_name: toStr(profile.branch_name || profile.branchName || branch?.name || 'Main Branch')
      }],
      audit_logs: rows.audit_logs,
      branches: db.clinicBranches.filter(x => String(x.clinicId) === String(clinicId)).map((b, idx) => ({ id: idx + 1, code: toStr(b.code || b.branchId || `BR-${idx+1}`), name: toStr(b.name), created_at: toNum(b.createdAt || b.updatedAt, 0) })),
      staff: rows.staff.map(toSnakeStaff),
      patients: rows.patients.map(toSnakePatient),
      visits: rows.visits.map(toSnakeVisit),
      bills: rows.bills.map(toSnakeBill),
      prescriptions: rows.prescriptions.map(toSnakePrescription),
      lab_requests: rows.lab_requests,
      pharmacy_items: rows.pharmacy_items.map(toSnakePharmacyItem),
      pharmacy_dispenses: rows.pharmacy_dispenses.map(toSnakeDispense),
      admissions: rows.admissions.map(toSnakeAdmission),
      appointments: rows.appointments.map(toSnakeAppointment),
      vitals: rows.vitals.map(toSnakeVitals),
      nurse_desk: rows.nurse_desk,
      doctor_queue: rows.doctor_queue,
      inpatient_treatment: [], treatment_notes: [], medication_schedule: [], medication_logs: [], lab_samples: [], pharmacy_receipts: [], discharge_summary: [], nurse_tasks: [], cashier_shifts: []
    }
  };
}
function persistDerivedSnapshot(db, clinicId, actor='system', role='Admin', deviceId='', branchId=''){
  const latest = getLatestSnapshot(db, clinicId);
  const snapshot = buildSnapshotData(db, clinicId);
  const row = {
    snapshotId: 'snp_' + nanoid(12),
    clinicId,
    branchId: toStr(branchId),
    deviceId: toStr(deviceId),
    role: normRole(role),
    actor: toStr(actor),
    snapshot,
    createdAt: now(),
    since: latest?.createdAt || 0,
    crossBranchEnabled: false
  };
  db.clinicSnapshots.push(row);
  const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  if (clinic) clinic.updatedAt = now();
  return row;
}
function summarizeSnapshot(snapshot){
  const data = snapshot?.data || {};
  const patients = arr(data.patients).length;
  const visits = arr(data.visits).length;
  const bills = arr(data.bills).length;
  const admissions = arr(data.admissions).length;
  const pharmacyRows = arr(data.pharmacy_dispenses).length ? arr(data.pharmacy_dispenses) : arr(data.pharmacy);
  const labRows = arr(data.lab_requests).length ? arr(data.lab_requests) : arr(data.lab);
  const pharmacy = pharmacyRows.length;
  const lab = labRows.length;
  const totalBill = arr(data.bills).reduce((s, x) => s + toNum(x.total || x.amount || x.paid), 0);
  const totalPaid = arr(data.bills).reduce((s, x) => s + toNum(x.paid || x.amount_paid), 0);
  const outstanding = Math.max(0, totalBill - totalPaid);
  const queueRows = arr(data.doctor_queue).length ? arr(data.doctor_queue) : arr(data.visits);
  const queue = queueRows.filter(v => !['completed','closed','done','cancelled','served'].includes(lower(v.status))).length;
  const doctorBuckets = new Map();
  for (const v of queueRows) {
    const k = pickDoctorName(v) || 'Unassigned';
    doctorBuckets.set(k, (doctorBuckets.get(k) || 0) + 1);
  }
  const doctorWorkload = Array.from(doctorBuckets.entries()).map(([doctor,count]) => ({ doctor, count })).sort((a,b) => b.count - a.count);
  const lowStock = pharmacyRows.filter(x => toNum(x.remaining_qty || x.quantity || x.qty || x.stock, 0) <= Math.max(5, toNum(x.reorder_level || x.min_stock, 5)));
  return { patients, visits, bills, admissions, pharmacy, lab, totalBill, totalPaid, outstanding, queue, doctorWorkload, lowStock };
}
function patientSummary(snapshot, patientId){
  const data = snapshot?.data || {};
  const patients = arr(data.patients);
  const visits = arr(data.visits).filter(v => String(v.patient_id || v.patientId) === String(patientId));
  const bills = arr(data.bills).filter(v => String(v.patient_id || v.patientId) === String(patientId));
  const dispenses = arr(data.pharmacy_dispenses).filter(v => String(v.patient_id || v.patientId) === String(patientId));
  const patient = patients.find(v => String(v.id || v.patient_id || v.patientId) === String(patientId)) || null;
  const totalBill = bills.reduce((s,x)=>s+toNum(x.total || x.amount || x.paid),0);
  const totalPaid = bills.reduce((s,x)=>s+toNum(x.paid || x.amount_paid),0);
  const outstanding = Math.max(0,totalBill-totalPaid);
  let riskScore = 10;
  if (visits.length >= 5) riskScore += 20;
  if (outstanding > 0) riskScore += 20;
  if (dispenses.length >= 3) riskScore += 10;
  const lastVisit = visits.sort((a,b)=>toNum(b.created_at||b.createdAt)-toNum(a.created_at||a.createdAt))[0] || null;
  return {
    patient,
    patientId,
    visitCount: visits.length,
    billCount: bills.length,
    dispenseCount: dispenses.length,
    outstanding,
    riskScore: Math.min(100, riskScore),
    riskLevel: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
    lastVisit,
    summary: lastVisit
      ? `Patient has ${visits.length} visit(s), outstanding NGN ${outstanding.toFixed(2)}, last status ${toStr(lastVisit.status || 'open')}.`
      : `Patient has ${visits.length} visit(s) and outstanding NGN ${outstanding.toFixed(2)}.`
  };
}
function ensureClinicUser(db, clinic, email, password, role = 'Admin', branchId = ''){
  const safe = safeEmail(email);
  if (!safe) return null;
  let user = db.clinicUsers.find(x => String(x.clinicId) === String(clinic.clinicId) && safeEmail(x.email) === safe);
  if (!user) {
    user = {
      userId: 'usr_' + nanoid(10),
      clinicId: clinic.clinicId,
      email: safe,
      password: toStr(password) || '1234',
      role: normRole(role),
      branchId: toStr(branchId),
      fullName: cap(role) + ' User',
      createdAt: now(),
      updatedAt: now(),
      active: true
    };
    db.clinicUsers.push(user);
  }
  return user;
}
function ensurePatientExists(db, clinicId, patientId){
  return db.clinicPatients.find(x => String(x.clinicId) === String(clinicId) && String(x.patientId) === String(patientId));
}
function actorInfo(req){
  return {
    actor: toStr(req.auth?.email || req.body?.actor || req.auth?.deviceId || 'system'),
    role: normRole(req.auth?.role || req.body?.role || 'Admin'),
    deviceId: toStr(req.auth?.deviceId || req.body?.deviceId),
    branchId: toStr(req.auth?.branchId || req.body?.branchId)
  };
}
function finalizeWrite(db, clinicId, type, title, message, payload, req){
  const info = actorInfo(req);
  const snapshotRow = persistDerivedSnapshot(db, clinicId, info.actor, info.role, info.deviceId, info.branchId);
  const event = pushEvent(db, clinicId, type, payload);
  makeNotification(db, clinicId, type, title, message, { payload });
  writeDB(db);
  return { event, snapshotId: snapshotRow.snapshotId, stats: summarizeSnapshot(snapshotRow.snapshot) };
}
function sortRecent(items){ return arr(items).sort((a,b)=>toNum(b.updatedAt || b.createdAt)-toNum(a.updatedAt || a.createdAt)); }

// Create hospital like SPNG shop create
r.post('/hospital/create', (req, res) => {
  try {
    const body = req.body || {};
    const clinicName = toStr(body.hospitalName || body.clinicName || body.shopName);
    const ownerEmail = safeEmail(body.ownerEmail || body.email || body.ownerPhone);
    const ownerPassword = toStr(body.ownerPassword || body.password || body.ownerPin || '1234');
    const ownerDeviceId = toStr(body.ownerDeviceId || body.deviceId);
    const branchName = toStr(body.branchName || 'Main Branch');
    if (!clinicName || !ownerEmail || !ownerDeviceId) return res.status(400).json({ ok:false, error:'hospitalName, ownerEmail and ownerDeviceId are required' });
    const db = readDB(); ensureArrays(db);
    let clinic = db.clinics.find(x => safeEmail(x.ownerEmail) === ownerEmail && lower(x.clinicName) === lower(clinicName));
    const reused = !!clinic;
    if (!clinic) {
      clinic = {
        clinicId: 'cln_' + nanoid(12),
        clinicCode: clinicCode(),
        clinicName,
        ownerEmail,
        ownerPassword,
        createdAt: now(),
        updatedAt: now(),
        branchCount: 1,
        active: true
      };
      db.clinics.push(clinic);
      db.clinicBranches.push({ branchId: 'br_' + nanoid(10), clinicId: clinic.clinicId, name: branchName, createdAt: now(), updatedAt: now(), isMain: true });
    } else {
      clinic.updatedAt = now();
      clinic.ownerPassword = ownerPassword || clinic.ownerPassword;
    }
    const adminUser = ensureClinicUser(db, clinic, ownerEmail, ownerPassword, 'Admin');
    const d = { deviceId: ownerDeviceId, clinicId: clinic.clinicId, role: 'Admin', trusted: true, name: toStr(body.deviceName || 'Admin Device'), updatedAt: now(), createdAt: now(), active: true };
    const i = db.clinicDevices.findIndex(x => String(x.deviceId) === d.deviceId && String(x.clinicId) === d.clinicId);
    if (i >= 0) db.clinicDevices[i] = { ...db.clinicDevices[i], ...d };
    else db.clinicDevices.push(d);
    writeDB(db);
    const token = sign({ clinicId: clinic.clinicId, hospitalId: clinic.clinicId, deviceId: ownerDeviceId, userId: adminUser?.userId, email: ownerEmail, role: 'Admin' });
    return res.json({ ok:true, reused, token, clinic: clinicPublicRow(clinic), hospital: clinicPublicRow(clinic) });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'create failed' });
  }
});

r.post('/auth/login', (req, res) => {
  try {
    const body = req.body || {};
    const email = safeEmail(body.email || body.ownerEmail || body.username);
    const password = toStr(body.password || body.ownerPassword || body.ownerPin);
    const clinicRef = toStr(body.hospitalId || body.clinicId || req.headers['x-clinic-id'] || req.headers['x-hospital-id']);
    const deviceId = toStr(body.deviceId);
    const db = readDB(); ensureArrays(db);
    let clinic = null;
    if (clinicRef) clinic = db.clinics.find(x => String(x.clinicId) === clinicRef || String(x.clinicCode) === clinicRef);
    if (!clinic && email) clinic = db.clinics.find(x => safeEmail(x.ownerEmail) === email);
    if (!clinic) return res.status(404).json({ ok:false, error:'Hospital not found' });
    let user = db.clinicUsers.find(x => String(x.clinicId) === String(clinic.clinicId) && safeEmail(x.email) === email);
    if (!user && email === safeEmail(clinic.ownerEmail) && password === toStr(clinic.ownerPassword)) {
      user = ensureClinicUser(db, clinic, email, password, 'Admin');
    }
    if (!user || toStr(user.password) !== password) return res.status(401).json({ ok:false, error:'Invalid credentials' });
    const trusted = db.clinicDevices.find(x => String(x.clinicId) === String(clinic.clinicId) && String(x.deviceId) === deviceId && x.trusted === true);
    const token = sign({ clinicId: clinic.clinicId, hospitalId: clinic.clinicId, deviceId, userId: user.userId, email: user.email, role: normRole(user.role), branchId: toStr(user.branchId) });
    writeDB(db);
    return res.json({ ok:true, token, trusted: !!trusted, user: { userId: user.userId, email: user.email, role: normRole(user.role), branchId: toStr(user.branchId) }, clinic: clinicPublicRow(clinic) });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'login failed' });
  }
});

r.post('/device/register', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const body = req.body || {};
    const role = normRole(body.role || req.auth?.role);
    const row = {
      deviceId: toStr(body.deviceId),
      clinicId,
      name: toStr(body.name || body.deviceName || 'Clinic Device'),
      role,
      branchId: toStr(body.branchId || req.auth?.branchId),
      trusted: !!body.isTrusted,
      tokenHash: toStr(body.tokenHash),
      active: true,
      createdAt: now(),
      updatedAt: now(),
      lastSeenAt: now()
    };
    if (!row.deviceId) return res.status(400).json({ ok:false, error:'deviceId is required' });
    const db = readDB(); ensureArrays(db);
    const i = db.clinicDevices.findIndex(x => String(x.deviceId) === row.deviceId && String(x.clinicId) === clinicId);
    if (i >= 0) db.clinicDevices[i] = { ...db.clinicDevices[i], ...row, createdAt: db.clinicDevices[i].createdAt || row.createdAt };
    else db.clinicDevices.push(row);
    writeDB(db);
    return res.json({ ok:true, device: row });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'device register failed' });
  }
});

r.post('/device/trust', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  if (!roleAllowed(req, ['Admin'])) return res.status(403).json({ ok:false, error:'Admins only' });
  const deviceId = toStr(req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ ok:false, error:'deviceId is required' });
  const db = readDB(); ensureArrays(db);
  const item = db.clinicDevices.find(x => String(x.clinicId) === clinicId && String(x.deviceId) === deviceId);
  if (!item) return res.status(404).json({ ok:false, error:'Device not found' });
  item.trusted = req.body?.trusted !== false;
  item.updatedAt = now();
  writeDB(db);
  return res.json({ ok:true, device: item });
});

r.get('/device/list', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const items = db.clinicDevices.filter(x => String(x.clinicId) === clinicId).sort((a,b)=>toNum(b.updatedAt)-toNum(a.updatedAt));
  return res.json({ ok:true, devices: items });
});


function identityValue(row, keys){
  for (const k of keys) {
    const v = toStr(row?.[k]);
    if (v) return v;
  }
  return '';
}
function upsertByIdentity(list, row, keys){
  const val = identityValue(row, keys);
  if (!val) {
    list.push(row);
    return row;
  }
  const i = list.findIndex(x => identityValue(x, keys) === val);
  if (i >= 0) list[i] = { ...list[i], ...row };
  else list.push(row);
  return i >= 0 ? list[i] : row;
}
function mergeSnapshotIntoClinic(db, clinicId, snapshot, meta = {}){
  const data = snapshot?.data || {};
  const actor = toStr(meta.actor || 'cloud-sync');
  const branchId = toStr(meta.branchId || '');
  const updatedAt = toNum(snapshot?.exported_at || meta.updatedAt || now());
  const toPatient = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId || x.id), mrn: toStr(x.mrn || x.patient_id || x.patientId), fullName: toStr(x.full_name || x.fullName || x.patient_name || x.patientName), gender: toStr(x.gender), age: toNum(x.age, 0), dob: toStr(x.dob), phone: cleanPhone(x.phone), email: safeEmail(x.email), address: toStr(x.address), bloodGroup: toStr(x.blood_group || x.bloodGroup), genotype: toStr(x.genotype), nextOfKin: toStr(x.next_of_kin || x.nextOfKin), nextOfKinPhone: cleanPhone(x.next_of_kin_phone || x.nextOfKinPhone), maritalStatus: toStr(x.marital_status || x.maritalStatus), notes: toStr(x.notes), status: toStr(x.status || 'active'), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt: updatedAt });
  const toVisit = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName || x.full_name || x.fullName), visitNo: toStr(x.visit_no || x.visitNo || x.id), complaint: toStr(x.complaint), doctorName: toStr(x.doctor_name || x.doctorName), status: toStr(x.status || 'Pending'), diagnosis: toStr(x.diagnosis), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toBill = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), billId: toStr(x.billId || x.bill_id || x.id || x.receipt_no || x.receiptNo), billNo: toStr(x.billNo || x.bill_no || x.receipt_no || x.receiptNo), receiptNo: toStr(x.receipt_no || x.receiptNo || x.billNo || x.bill_no), category: toStr(x.category || 'General'), description: toStr(x.description), consultation: toNum(x.consultation, 0), lab: toNum(x.lab, 0), drugs: toNum(x.drugs, 0), other: toNum(x.other, 0), total: toNum(x.total || x.amount, 0), paid: toNum(x.paid || x.amount_paid || x.amountPaid, 0), balance: toNum(x.balance, Math.max(0, toNum(x.total || x.amount, 0) - toNum(x.paid || x.amount_paid || x.amountPaid, 0))), status: toStr(x.status || 'pending'), paymentMethod: toStr(x.payment_method || x.paymentMethod), cashier: toStr(x.cashier || actor), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toRx = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), visitNo: toStr(x.visit_no || x.visitNo), medicine: toStr(x.medicine), dosage: toStr(x.dosage), instructions: toStr(x.instructions), prescribedBy: toStr(x.prescribed_by || x.prescribedBy || actor), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toPharmItem = x => ({ clinicId, branchId, itemName: toStr(x.item_name || x.itemName), unitPrice: toNum(x.unit_price || x.unitPrice, 0), stockQty: toNum(x.stock_qty || x.stockQty || x.qty || x.quantity, 0), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toDispense = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), itemName: toStr(x.item_name || x.itemName), qty: toNum(x.qty || x.quantity, 0), unitPrice: toNum(x.unit_price || x.unitPrice, 0), total: toNum(x.total, toNum(x.qty || x.quantity, 0) * toNum(x.unit_price || x.unitPrice, 0)), dispensedBy: toStr(x.dispensed_by || x.dispensedBy || actor), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toAdmission = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), wardName: toStr(x.ward_name || x.wardName), bedNo: toStr(x.bed_no || x.bedNo), reason: toStr(x.reason), status: toStr(x.status), admittedBy: toStr(x.admitted_by || x.admittedBy || actor), dischargedBy: toStr(x.discharged_by || x.dischargedBy), admittedAt: toNum(x.admitted_at || x.admittedAt || x.created_at || updatedAt), dischargedAt: toNum(x.discharged_at || x.dischargedAt, 0), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toAppt = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), appointmentNo: toStr(x.appointment_no || x.appointmentNo || x.id), doctorName: toStr(x.doctor_name || x.doctorName), appointmentDate: toStr(x.appointment_date || x.appointmentDate), appointmentTime: toStr(x.appointment_time || x.appointmentTime), reason: toStr(x.reason), status: toStr(x.status), createdBy: toStr(x.created_by || x.createdBy || actor), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toVital = x => ({ clinicId, branchId, patientId: toStr(x.patient_id || x.patientId), patientName: toStr(x.patient_name || x.patientName), visitNo: toStr(x.visit_no || x.visitNo), temperature: toStr(x.temperature), bp: toStr(x.bp), pulse: toStr(x.pulse), weight: toStr(x.weight), height: toStr(x.height), spo2: toStr(x.spo2), notes: toStr(x.notes), recordedBy: toStr(x.recorded_by || x.recordedBy || actor), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt });
  const toUser = x => ({ clinicId, userId: toStr(x.userId || x.id || x.username || x.email), email: safeEmail(x.username || x.email || `${toStr(x.full_name || x.fullName || 'staff').replace(/\s+/g,'.').toLowerCase()}@local`), password: toStr(x.pin || x.password || '1234'), role: normRole(x.role), branchId, fullName: toStr(x.full_name || x.fullName || x.username || x.email), username: toStr(x.username || x.email), createdAt: toNum(x.created_at || x.createdAt || updatedAt), updatedAt, active: true });
  const rows = arr(data.patients).map(toPatient).filter(x => x.patientId);
  rows.forEach(x => upsertByIdentity(db.clinicPatients, x, ['patientId']));
  arr(data.visits).map(toVisit).filter(x => x.visitNo).forEach(x => upsertByIdentity(db.clinicVisits, x, ['visitNo']));
  arr(data.bills).map(toBill).filter(x => x.receiptNo || x.billNo).forEach(x => upsertByIdentity(db.clinicBills, x, ['receiptNo','billNo']));
  arr(data.prescriptions).map(toRx).filter(x => x.visitNo || x.patientId).forEach(x => upsertByIdentity(db.clinicPrescriptions, x, ['visitNo','patientId','medicine','createdAt']));
  arr(data.pharmacy_items).map(toPharmItem).filter(x => x.itemName).forEach(x => upsertByIdentity(db.clinicPharmacyItems, x, ['itemName']));
  arr(data.pharmacy_dispenses).map(toDispense).filter(x => x.itemName).forEach(x => upsertByIdentity(db.clinicPharmacyDispenses, x, ['patientId','itemName','createdAt']));
  arr(data.admissions).map(toAdmission).filter(x => x.patientId).forEach(x => upsertByIdentity(db.clinicAdmissions, x, ['patientId','admittedAt']));
  arr(data.appointments).map(toAppt).filter(x => x.appointmentNo || x.patientId).forEach(x => upsertByIdentity(db.clinicAppointments, x, ['appointmentNo','patientId','createdAt']));
  arr(data.vitals).map(toVital).filter(x => x.patientId).forEach(x => upsertByIdentity(db.clinicVitals, x, ['patientId','visitNo','createdAt']));
  arr(data.staff || data.staffs).map(toUser).filter(x => x.email || x.username).forEach(x => upsertByIdentity(db.clinicUsers, x, ['email','username']));
  const qSource = arr(data.doctor_queue).length ? arr(data.doctor_queue) : arr(data.visits);
  qSource.map(toVisit).filter(x => x.visitNo).forEach(x => upsertByIdentity(db.clinicDoctorQueue, x, ['visitNo']));
  arr(data.audit_logs).forEach(x => db.clinicAuditLogs.push({ clinicId, branchId, ...x }));
  const profile = arr(data.clinic_profile)[0];
  if (profile) {
    const p = { clinicId, branchId, clinic_name: toStr(profile.clinic_name || profile.clinicName), clinic_address: toStr(profile.clinic_address || profile.clinicAddress), clinic_phone: toStr(profile.clinic_phone || profile.clinicPhone), branch_name: toStr(profile.branch_name || profile.branchName), updatedAt };
    upsertByIdentity(db.clinicProfiles, p, ['clinicId']);
    const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
    if (clinic && p.clinic_name) clinic.clinicName = p.clinic_name;
  }
  const branchRows = arr(data.branches);
  branchRows.forEach((b, idx) => {
    const row = { clinicId, branchId: toStr(b.branchId || b.code || `br_${idx+1}`), code: toStr(b.code || b.branchId || `BR-${idx+1}`), name: toStr(b.name || b.branch_name || b.branchName || `Branch ${idx+1}`), createdAt: toNum(b.created_at || updatedAt), updatedAt, isMain: idx === 0 };
    upsertByIdentity(db.clinicBranches, row, ['branchId','code']);
  });
  return summarizeSnapshot(buildSnapshotData(db, clinicId));
}

function saveSnapshot(db, clinicId, body){
  const row = {
    snapshotId: 'snp_' + nanoid(12),
    clinicId,
    branchId: toStr(body.branchId),
    deviceId: toStr(body.deviceId),
    role: normRole(body.role),
    actor: toStr(body.actor),
    snapshot: body.snapshot || { data:{} },
    createdAt: now(),
    since: toNum(body.since, 0),
    crossBranchEnabled: !!body.cross_branch_enabled
  };
  db.clinicSnapshots.push(row);
  const clinic = db.clinics.find(x => String(x.clinicId) === clinicId);
  if (clinic) clinic.updatedAt = now();
  return row;
}

r.post('/clinic/snapshot/upload', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.body?.hospitalId || req.body?.clinic_id || req.body?.clinicId);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const row = saveSnapshot(db, clinicId, req.body || {});
    const stats = mergeSnapshotIntoClinic(db, clinicId, row.snapshot || { data:{} }, req.body || {});
    persistDerivedSnapshot(db, clinicId, toStr(req.body?.actor || 'cloud-sync'), toStr(req.body?.role || 'Admin'), toStr(req.body?.deviceId), toStr(req.body?.branchId));
    setCursor(db, clinicId, toStr(req.body?.deviceId), toNum(row.snapshot?.exported_at || row.createdAt));
    makeNotification(db, clinicId, 'sync', 'Cloud snapshot uploaded', `Device ${toStr(req.body?.deviceName || req.body?.deviceId || 'unknown')} uploaded clinic data.`);
    pushEvent(db, clinicId, 'snapshot_uploaded', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats });
    writeDB(db);
    const latest = getLatestSnapshot(db, clinicId);
    return res.json({ ok:true, uploaded:true, snapshotId: row.snapshotId, stats, pull_snapshot: latest?.snapshot || row.snapshot, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'upload failed' });
  }
});

r.get('/clinic/snapshot/pull', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const latest = getLatestSnapshot(db, clinicId);
    const fallback = buildSnapshotData(db, clinicId);
    return res.json({ ok:true, snapshot: latest?.snapshot || fallback, snapshot_meta: latest ? { snapshotId: latest.snapshotId, createdAt: latest.createdAt, deviceId: latest.deviceId, branchId: latest.branchId } : null, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'pull failed' });
  }
});

r.post('/clinic/sync/push', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.body?.hospitalId || req.body?.clinic_id || req.body?.clinicId);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const row = saveSnapshot(db, clinicId, req.body || {});
    const stats = mergeSnapshotIntoClinic(db, clinicId, row.snapshot || { data:{} }, req.body || {});
    persistDerivedSnapshot(db, clinicId, toStr(req.body?.actor || 'cloud-sync'), toStr(req.body?.role || 'Admin'), toStr(req.body?.deviceId), toStr(req.body?.branchId));
    setCursor(db, clinicId, toStr(req.body?.deviceId), toNum(row.snapshot?.exported_at || row.createdAt));
    pushEvent(db, clinicId, 'sync_push', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats });
    writeDB(db);
    return res.json({ ok:true, pushed:true, snapshotId: row.snapshotId, stats, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'push failed' });
  }
});

r.get('/clinic/sync/pull', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const latest = getLatestSnapshot(db, clinicId);
    const fallback = buildSnapshotData(db, clinicId);
    return res.json({ ok:true, pulled:true, snapshot: latest?.snapshot || fallback, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'pull failed' });
  }
});

r.get('/events/stream', (req, res) => {
  return res.status(400).json({ ok:false, error:'Use app-level /api/events/stream endpoint' });
});

r.post('/events/publish', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const type = toStr(req.body?.type || 'update');
    const payload = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : {};
    const db = readDB(); ensureArrays(db);
    const event = pushEvent(db, clinicId, type, payload);
    if (['patient registered','patient_registered','visit created','visit_created','bill created','bill_created','payment received','payment_received','drug dispensed','drug_dispensed'].includes(lower(type).replace(/\s+/g,'_'))) {
      makeNotification(db, clinicId, type, type.replace(/_/g,' '), payload.message || 'Clinic activity update');
    }
    writeDB(db);
    return res.json({ ok:true, event });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'publish failed' });
  }
});

// =========================
// ENTERPRISE DATA ENDPOINTS
// =========================

r.post('/patient/register', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const fullName = toStr(b.fullName || b.patientName || b.name);
    const phone = cleanPhone(b.phone || b.patientPhone);
    if (!fullName) return res.status(400).json({ ok:false, error:'fullName is required' });
    const db = readDB(); ensureArrays(db);
    const patient = {
      patientId: createId('pt'),
      clinicId,
      branchId: toStr(b.branchId || req.auth?.branchId),
      mrn: toStr(b.mrn || `MRN-${Date.now().toString().slice(-6)}`),
      fullName,
      gender: toStr(b.gender),
      age: toNum(b.age, 0),
      dob: toStr(b.dob),
      phone,
      email: safeEmail(b.email),
      address: toStr(b.address),
      bloodGroup: toStr(b.bloodGroup || b.blood_group),
      genotype: toStr(b.genotype),
      nextOfKin: toStr(b.nextOfKin || b.next_of_kin),
      nextOfKinPhone: cleanPhone(b.nextOfKinPhone || b.next_of_kin_phone),
      maritalStatus: toStr(b.maritalStatus),
      notes: toStr(b.notes),
      status: toStr(b.status || 'active'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicPatients.push(patient);
    const summary = finalizeWrite(db, clinicId, 'patient_registered', 'New Patient Registered', `${patient.fullName} has been registered.`, { patientId: patient.patientId, patientName: patient.fullName }, req);
    return res.json({ ok:true, patient, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'patient register failed' });
  }
});

r.get('/patient/search', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const q = lower(req.query?.q || req.query?.term || req.query?.query);
  const limit = Math.max(1, Math.min(200, toNum(req.query?.limit, 50)));
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicPatients.filter(x => String(x.clinicId) === clinicId);
  if (q) {
    rows = rows.filter(x => [x.patientId, x.mrn, x.fullName, x.phone, x.email, x.address].some(v => lower(v).includes(q)));
  }
  rows = sortRecent(rows).slice(0, limit);
  return res.json({ ok:true, count: rows.length, patients: rows });
});

r.get('/patients', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const patients = sortRecent(db.clinicPatients.filter(x => String(x.clinicId) === clinicId)).slice(0, 500);
  return res.json({ ok:true, patients });
});

r.get('/patient/:patientId', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const patientId = toStr(req.params?.patientId);
  const db = readDB(); ensureArrays(db);
  const patient = ensurePatientExists(db, clinicId, patientId);
  if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
  const visits = db.clinicVisits.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId);
  const bills = db.clinicBills.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId);
  const admissions = db.clinicAdmissions.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId);
  const prescriptions = db.clinicPrescriptions.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId);
  return res.json({ ok:true, patient, visits, bills, admissions, prescriptions });
});

r.post('/bill/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const total = toNum(b.total || b.amount);
    const paid = toNum(b.paid || b.amountPaid || b.amount_paid);
    const bill = {
      billId: createId('bill'),
      clinicId,
      patientId,
      branchId: toStr(b.branchId || req.auth?.branchId),
      patientName: patient.fullName,
      billNo: toStr(b.billNo || `BILL-${Date.now().toString().slice(-6)}`),
      category: toStr(b.category || 'General'),
      description: toStr(b.description),
      total,
      paid,
      balance: Math.max(0, total - paid),
      status: toStr(b.status || (Math.max(0, total - paid) <= 0 ? 'paid' : 'pending')),
      paymentMethod: toStr(b.paymentMethod || b.payment_method),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicBills.push(bill);
    const summary = finalizeWrite(db, clinicId, 'bill_created', 'Bill Created', `Bill created for ${patient.fullName}.`, { billId: bill.billId, patientId, total: bill.total }, req);
    return res.json({ ok:true, bill, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'bill create failed' });
  }
});

r.get('/bills', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let bills = db.clinicBills.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.patientId) bills = bills.filter(x => String(x.patientId) === String(req.query.patientId));
  return res.json({ ok:true, bills: sortRecent(bills).slice(0, 500) });
});

r.post('/visit/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const visit = {
      visitId: createId('vis'),
      clinicId,
      patientId,
      branchId: toStr(b.branchId || req.auth?.branchId),
      patientName: patient.fullName,
      doctorName: toStr(b.doctorName || b.doctor_name || b.doctor || 'Unassigned'),
      reason: toStr(b.reason || b.complaint),
      diagnosis: toStr(b.diagnosis),
      vitalSummary: toStr(b.vitalSummary || b.vitals),
      status: pickStatus(b, 'waiting'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicVisits.push(visit);
    db.clinicDoctorQueue.push({
      queueId: createId('dq'),
      clinicId,
      visitId: visit.visitId,
      patientId,
      patientName: patient.fullName,
      doctorName: visit.doctorName,
      status: toStr(b.queueStatus || 'waiting'),
      priority: toStr(b.priority || 'normal'),
      branchId: visit.branchId,
      createdAt: now(),
      updatedAt: now()
    });
    const summary = finalizeWrite(db, clinicId, 'visit_created', 'Visit Created', `Visit created for ${patient.fullName}.`, { visitId: visit.visitId, patientId, doctorName: visit.doctorName }, req);
    return res.json({ ok:true, visit, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'visit create failed' });
  }
});

r.get('/visits', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let visits = db.clinicVisits.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.patientId) visits = visits.filter(x => String(x.patientId) === String(req.query.patientId));
  if (req.query?.status) visits = visits.filter(x => lower(x.status) === lower(req.query.status));
  return res.json({ ok:true, visits: sortRecent(visits).slice(0, 500) });
});

r.post('/admission/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const admission = {
      admissionId: createId('adm'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      ward: toStr(b.ward),
      bed: toStr(b.bed),
      doctorName: toStr(b.doctorName || b.doctor),
      note: toStr(b.note || b.notes),
      status: pickStatus(b, 'admitted'),
      admittedAt: toNum(b.admittedAt, now()),
      dischargeAt: toNum(b.dischargeAt, 0),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicAdmissions.push(admission);
    const summary = finalizeWrite(db, clinicId, 'admission_created', 'Admission Created', `${patient.fullName} has been admitted.`, { admissionId: admission.admissionId, patientId }, req);
    return res.json({ ok:true, admission, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'admission create failed' });
  }
});

r.get('/admissions', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let admissions = db.clinicAdmissions.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.status) admissions = admissions.filter(x => lower(x.status) === lower(req.query.status));
  return res.json({ ok:true, admissions: sortRecent(admissions).slice(0, 500) });
});

r.post('/appointment/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const appointment = {
      appointmentId: createId('apt'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      doctorName: toStr(b.doctorName || b.doctor),
      appointmentDate: toStr(b.appointmentDate || b.date),
      appointmentTime: toStr(b.appointmentTime || b.time),
      purpose: toStr(b.purpose || b.reason),
      status: pickStatus(b, 'scheduled'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicAppointments.push(appointment);
    const summary = finalizeWrite(db, clinicId, 'appointment_created', 'Appointment Created', `Appointment scheduled for ${patient.fullName}.`, { appointmentId: appointment.appointmentId, patientId }, req);
    return res.json({ ok:true, appointment, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'appointment create failed' });
  }
});

r.get('/appointments', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let appointments = db.clinicAppointments.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.status) appointments = appointments.filter(x => lower(x.status) === lower(req.query.status));
  return res.json({ ok:true, appointments: sortRecent(appointments).slice(0, 500) });
});

r.post('/pharmacy/dispense', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const row = {
      dispenseId: createId('phm'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      itemName: toStr(b.itemName || b.drugName || b.drug),
      dosage: toStr(b.dosage),
      quantity: toNum(b.quantity, 0),
      unitPrice: toNum(b.unitPrice, 0),
      total: toNum(b.total, toNum(b.quantity, 0) * toNum(b.unitPrice, 0)),
      status: pickStatus(b, 'dispensed'),
      dispensedBy: toStr(b.dispensedBy || req.auth?.email),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicPharmacyDispenses.push(row);
    const summary = finalizeWrite(db, clinicId, 'drug_dispensed', 'Drug Dispensed', `${row.itemName || 'Drug'} dispensed to ${patient.fullName}.`, { dispenseId: row.dispenseId, patientId, itemName: row.itemName }, req);
    return res.json({ ok:true, dispense: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'pharmacy dispense failed' });
  }
});

r.get('/pharmacy/dispenses', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicPharmacyDispenses.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.patientId) rows = rows.filter(x => String(x.patientId) === String(req.query.patientId));
  return res.json({ ok:true, dispenses: sortRecent(rows).slice(0, 500) });
});

r.post('/lab/request', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const row = {
      labRequestId: createId('lab'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      testName: toStr(b.testName || b.labTest),
      requestedBy: toStr(b.requestedBy || b.doctorName || req.auth?.email),
      result: toStr(b.result),
      note: toStr(b.note || b.notes),
      status: pickStatus(b, 'pending'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicLabRequests.push(row);
    const summary = finalizeWrite(db, clinicId, 'lab_request_created', 'Lab Request Created', `Lab request created for ${patient.fullName}.`, { labRequestId: row.labRequestId, patientId, testName: row.testName }, req);
    return res.json({ ok:true, labRequest: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'lab request failed' });
  }
});

r.get('/lab/requests', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicLabRequests.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.status) rows = rows.filter(x => lower(x.status) === lower(req.query.status));
  return res.json({ ok:true, labRequests: sortRecent(rows).slice(0, 500) });
});

r.post('/prescription/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const row = {
      prescriptionId: createId('rx'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      doctorName: toStr(b.doctorName || b.doctor),
      drugName: toStr(b.drugName || b.drug),
      dosage: toStr(b.dosage),
      frequency: toStr(b.frequency),
      duration: toStr(b.duration),
      route: toStr(b.route),
      note: toStr(b.note || b.notes),
      status: pickStatus(b, 'active'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicPrescriptions.push(row);
    const summary = finalizeWrite(db, clinicId, 'prescription_created', 'Prescription Created', `Prescription created for ${patient.fullName}.`, { prescriptionId: row.prescriptionId, patientId, drugName: row.drugName }, req);
    return res.json({ ok:true, prescription: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'prescription create failed' });
  }
});

r.get('/prescriptions', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicPrescriptions.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.patientId) rows = rows.filter(x => String(x.patientId) === String(req.query.patientId));
  return res.json({ ok:true, prescriptions: sortRecent(rows).slice(0, 500) });
});

r.post('/nurse_desk/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const row = {
      nurseDeskId: createId('nrs'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      temperature: toStr(b.temperature),
      bp: toStr(b.bp),
      pulse: toStr(b.pulse),
      spo2: toStr(b.spo2),
      note: toStr(b.note || b.notes),
      nurseName: toStr(b.nurseName || req.auth?.email),
      status: pickStatus(b, 'recorded'),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicNurseDesk.push(row);
    const summary = finalizeWrite(db, clinicId, 'nurse_desk_created', 'Nurse Desk Updated', `Nurse desk entry saved for ${patient.fullName}.`, { nurseDeskId: row.nurseDeskId, patientId }, req);
    return res.json({ ok:true, nurseDesk: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'nurse desk create failed' });
  }
});

r.get('/nurse_desk', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicNurseDesk.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.patientId) rows = rows.filter(x => String(x.patientId) === String(req.query.patientId));
  return res.json({ ok:true, nurseDesk: sortRecent(rows).slice(0, 500) });
});

r.post('/staff/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  if (!roleAllowed(req, ['Admin'])) return res.status(403).json({ ok:false, error:'Admins only' });
  try {
    const b = req.body || {};
    const email = safeEmail(b.email || b.username);
    if (!email) return res.status(400).json({ ok:false, error:'email is required' });
    const db = readDB(); ensureArrays(db);
    let staff = db.clinicUsers.find(x => String(x.clinicId) === clinicId && safeEmail(x.email) === email);
    if (staff) return res.status(409).json({ ok:false, error:'Staff already exists' });
    staff = {
      userId: createId('usr'),
      clinicId,
      branchId: toStr(b.branchId || req.auth?.branchId),
      email,
      password: toStr(b.password || '1234'),
      role: normRole(b.role),
      fullName: toStr(b.fullName || b.name),
      phone: cleanPhone(b.phone),
      active: b.active !== false,
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicUsers.push(staff);
    const summary = finalizeWrite(db, clinicId, 'staff_created', 'Staff Added', `${staff.fullName || staff.email} added as ${staff.role}.`, { userId: staff.userId, role: staff.role, email: staff.email }, req);
    return res.json({ ok:true, staff, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'staff create failed' });
  }
});

r.get('/staff/list', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const staff = sortRecent(db.clinicUsers.filter(x => String(x.clinicId) === clinicId)).slice(0, 500);
  return res.json({ ok:true, staff });
});

r.post('/doctor_queue/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const patientId = toStr(b.patientId || b.patient_id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = ensurePatientExists(db, clinicId, patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const row = {
      queueId: createId('dq'),
      clinicId,
      patientId,
      patientName: patient.fullName,
      visitId: toStr(b.visitId),
      doctorName: toStr(b.doctorName || b.doctor || 'Unassigned'),
      status: pickStatus(b, 'waiting'),
      priority: toStr(b.priority || 'normal'),
      note: toStr(b.note || b.notes),
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicDoctorQueue.push(row);
    const summary = finalizeWrite(db, clinicId, 'doctor_queue_created', 'Doctor Queue Updated', `${patient.fullName} added to doctor queue.`, { queueId: row.queueId, patientId, doctorName: row.doctorName }, req);
    return res.json({ ok:true, queue: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'doctor queue create failed' });
  }
});

r.get('/doctor_queue', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  let rows = db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId);
  if (req.query?.doctorName) rows = rows.filter(x => lower(x.doctorName) === lower(req.query.doctorName));
  if (req.query?.status) rows = rows.filter(x => lower(x.status) === lower(req.query.status));
  return res.json({ ok:true, queue: sortRecent(rows).slice(0, 500), queueCount: rows.length });
});

r.post('/doctor_queue/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const queueId = toStr(req.body?.queueId || req.body?.id);
    if (!queueId) return res.status(400).json({ ok:false, error:'queueId is required' });
    const db = readDB(); ensureArrays(db);
    const row = db.clinicDoctorQueue.find(x => String(x.clinicId) === clinicId && String(x.queueId) === queueId);
    if (!row) return res.status(404).json({ ok:false, error:'Queue entry not found' });
    const prevStatus = toStr(row.status || 'waiting');
    const nextStatus = toStr(req.body?.status || prevStatus) || prevStatus;
    row.status = nextStatus;
    if (req.body?.priority != null) row.priority = toStr(req.body.priority || row.priority);
    if (req.body?.doctorName != null) row.doctorName = toStr(req.body.doctorName || row.doctorName || 'Unassigned');
    if (req.body?.note != null) row.note = toStr(req.body.note);
    row.updatedAt = now();
    const actionWord = nextStatus === prevStatus ? 'updated' : `moved to ${nextStatus}`;
    const summary = finalizeWrite(db, clinicId, 'doctor_queue_updated', 'Doctor Queue Updated', `${row.patientName || 'Patient'} ${actionWord}.`, { queueId: row.queueId, patientId: row.patientId, doctorName: row.doctorName, status: row.status, previousStatus: prevStatus }, req);
    return res.json({ ok:true, queue: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'doctor queue update failed' });
  }
});

r.get('/portal/timeline', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const days = Math.max(7, Math.min(90, toNum(req.query?.days, 14)));
  const db = readDB(); ensureArrays(db);
  const start = now() - (days * 86400000);
  const dayKey = ts => {
    const d = new Date(toNum(ts));
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${dd}`;
  };
  const buckets = new Map();
  const ensure = k => {
    if (!buckets.has(k)) buckets.set(k, { day: k, revenuePaid: 0, revenueTotal: 0, bills: 0, visits: 0, patients: 0, queueAdded: 0 });
    return buckets.get(k);
  };
  for (let i = days - 1; i >= 0; i--) {
    const d = Date.now() - (i * 86400000);
    ensure(dayKey(d));
  }
  db.clinicBills.filter(x => String(x.clinicId) === clinicId && toNum(x.createdAt) >= start).forEach(x => {
    const b = ensure(dayKey(x.createdAt));
    b.revenuePaid += toNum(x.paid || x.amount_paid);
    b.revenueTotal += toNum(x.total || x.amount || x.paid);
    b.bills += 1;
  });
  db.clinicVisits.filter(x => String(x.clinicId) === clinicId && toNum(x.createdAt) >= start).forEach(x => { ensure(dayKey(x.createdAt)).visits += 1; });
  db.clinicPatients.filter(x => String(x.clinicId) === clinicId && toNum(x.createdAt) >= start).forEach(x => { ensure(dayKey(x.createdAt)).patients += 1; });
  db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && toNum(x.createdAt) >= start).forEach(x => { ensure(dayKey(x.createdAt)).queueAdded += 1; });
  return res.json({ ok:true, days, timeline: Array.from(buckets.values()) });
});

r.get('/search/patient', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const q = lower(req.query?.q || req.query?.query || '');
  if (!q) return res.status(400).json({ ok:false, error:'q is required' });
  const patients = db.clinicPatients.filter(x => String(x.clinicId) === clinicId).filter(x => [x.patientId, x.mrn, x.fullName, x.phone, x.email].some(v => lower(v).includes(q)));
  return res.json({ ok:true, count: patients.length, patients: sortRecent(patients).slice(0, 100) });
});

r.get('/ai/patient_summary', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const patientId = toStr(req.query?.patientId || req.query?.patient_id);
  if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
  const db = readDB(); ensureArrays(db);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const summary = patientSummary(latest?.snapshot || { data:{} }, patientId);
  return res.json({ ok:true, ...summary });
});

r.get('/ai/clinic_overview', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const stats = summarizeSnapshot(latest?.snapshot || { data:{} });
  const alerts = [];
  if (stats.outstanding > 0) alerts.push({ type:'finance', severity: stats.outstanding > 50000 ? 'high' : 'medium', message:`Outstanding bills detected: NGN ${stats.outstanding.toFixed(2)}` });
  if (stats.queue >= 10) alerts.push({ type:'queue', severity:'high', message:`Queue pressure is high: ${stats.queue} open visits` });
  if (stats.lowStock.length) alerts.push({ type:'stock', severity:'medium', message:`${stats.lowStock.length} pharmacy item(s) are at or below reorder threshold` });
  return res.json({ ok:true, stats, alerts, summary:`Patients ${stats.patients}, open queue ${stats.queue}, outstanding NGN ${stats.outstanding.toFixed(2)}.` });
});

r.get('/ai/risk_analysis', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const stats = summarizeSnapshot(latest?.snapshot || { data:{} });
  const risks = {
    unpaid_bill_detection: { score: Math.min(100, Math.round((stats.outstanding / Math.max(1, stats.totalBill || 1)) * 100)), outstanding: stats.outstanding },
    queue_pressure: { score: Math.min(100, stats.queue * 8), openQueue: stats.queue },
    doctor_workload: { score: Math.min(100, (stats.doctorWorkload[0]?.count || 0) * 10), doctors: stats.doctorWorkload.slice(0, 5) },
    pharmacy_stock_warning: { score: Math.min(100, stats.lowStock.length * 20), items: stats.lowStock.slice(0, 10) }
  };
  return res.json({ ok:true, risks });
});

r.get('/portal/overview', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const clinic = db.clinics.find(x => String(x.clinicId) === clinicId);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  return res.json({ ok:true, clinic: clinic ? clinicPublicRow(clinic) : null, overview: summarizeSnapshot(latest?.snapshot || { data:{} }) });
});

r.get('/portal/patients', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const patients = sortRecent(db.clinicPatients.filter(x => String(x.clinicId) === clinicId)).slice(0, 500);
  return res.json({ ok:true, patients });
});

r.get('/portal/finance', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const stats = summarizeSnapshot(latest?.snapshot || { data:{} });
  return res.json({ ok:true, finance: { totalBill: stats.totalBill, totalPaid: stats.totalPaid, outstanding: stats.outstanding, billCount: stats.bills, pharmacySales: stats.pharmacy } });
});

r.get('/portal/queue', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const rows = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && !['completed','closed','done','cancelled','served'].includes(lower(x.status))));
  return res.json({ ok:true, queue: rows, queueCount: rows.length });
});

r.post('/backup/create', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const backup = {
    backupId: 'bkp_' + nanoid(12),
    clinicId,
    label: toStr(req.body?.label || 'Auto Snapshot Backup'),
    snapshot: latest?.snapshot || { data:{} },
    createdAt: now(),
    by: toStr(req.auth?.email || req.auth?.deviceId)
  };
  db.clinicBackups.push(backup);
  writeDB(db);
  return res.json({ ok:true, backupId: backup.backupId, createdAt: backup.createdAt });
});

r.get('/backup/list', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const backups = db.clinicBackups.filter(x => String(x.clinicId) === clinicId).map(x => ({ backupId: x.backupId, label: x.label, createdAt: x.createdAt, by: x.by })).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt));
  return res.json({ ok:true, backups });
});

r.post('/backup/restore', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const backupId = toStr(req.body?.backupId);
  if (!backupId) return res.status(400).json({ ok:false, error:'backupId is required' });
  const db = readDB(); ensureArrays(db);
  const backup = db.clinicBackups.find(x => String(x.clinicId) === clinicId && String(x.backupId) === backupId);
  if (!backup) return res.status(404).json({ ok:false, error:'Backup not found' });
  const row = saveSnapshot(db, clinicId, { snapshot: backup.snapshot, deviceId: req.auth?.deviceId, actor: req.auth?.email, role: req.auth?.role, branchId: req.auth?.branchId });
  makeNotification(db, clinicId, 'restore', 'Cloud backup restored', `Backup ${backup.label} has been restored.`);
  writeDB(db);
  return res.json({ ok:true, snapshotId: row.snapshotId, snapshot: row.snapshot });
});

r.get('/branch/matrix', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const branches = db.clinicBranches.filter(x => String(x.clinicId) === clinicId);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const stats = summarizeSnapshot(latest?.snapshot || { data:{} });
  const matrix = branches.map(b => ({ branchId: b.branchId, name: b.name, patients: stats.patients, visits: stats.visits, revenue: stats.totalPaid, queue: stats.queue }));
  return res.json({ ok:true, branches: matrix, aggregated: { patients: stats.patients, visits: stats.visits, revenue: stats.totalPaid, queue: stats.queue } });
});

r.post('/branch/sync', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const event = pushEvent(db, clinicId, 'branch_sync', { branchId: toStr(req.body?.branchId), mode: toStr(req.body?.mode || 'pull_push') });
  writeDB(db);
  return res.json({ ok:true, synced:true, event });
});

r.get('/notifications', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const since = toNum(req.query?.since, 0);
  const db = readDB(); ensureArrays(db);
  const notifications = db.clinicNotifications.filter(x => String(x.clinicId) === clinicId && toNum(x.createdAt) >= since).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt)).slice(0, 200);
  return res.json({ ok:true, notifications });
});

r.post('/notifications/push', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const n = makeNotification(db, clinicId, req.body?.type || 'info', req.body?.title || 'Clinic Notification', req.body?.message || '', { payload: req.body?.payload || {} });
  writeDB(db);
  return res.json({ ok:true, notification: n });
});



// =========================
// LOCAL DASHBOARD COMPAT LAYER (Cloud Portal mirrors Local Hub UI)
// =========================
function fmtDay(ts){ const d = new Date(toNum(ts, Date.now())); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function currency(v){ return Number(toNum(v,0).toFixed(2)); }
function getClinicContext(req, res){ const clinicId = requireClinic(req, res); if (!clinicId) return null; const db = readDB(); ensureArrays(db); const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId)); const branch = db.clinicBranches.find(x => String(x.clinicId) === String(clinicId) && (x.isMain || true)); const snapshot = getLatestSnapshot(db, clinicId)?.snapshot || buildSnapshotData(db, clinicId); return { clinicId, db, clinic, branch, snapshot, stats: summarizeSnapshot(snapshot) }; }
function localStatusPayload(ctx){
  const trusted = ctx.db.clinicDevices.filter(x => String(x.clinicId) === String(ctx.clinicId) && x.trusted).map(x => ({ device_id: x.deviceId, device_name: x.name, role: x.role, trusted_at: x.updatedAt || x.createdAt || now() }));
  return {
    clinic_name: ctx.clinic?.clinicName || 'Clinic Pro NG',
    role: 'Admin', branch: ctx.branch?.name || 'Main Branch', hub_url: 'Cloud Portal • ' + (ctx.clinic?.clinicCode || ctx.clinicId),
    patients: ctx.stats.patients, visits: ctx.stats.visits, open_queue: ctx.stats.queue, revenue_today: ctx.stats.totalPaid, outstanding: ctx.stats.outstanding,
    lab_income: 0, staff: ctx.db.clinicUsers.filter(x => String(x.clinicId) === String(ctx.clinicId)).length, lab_requests: ctx.db.clinicLabRequests.filter(x => String(x.clinicId) === String(ctx.clinicId)).length,
    admissions: ctx.stats.admissions, appointments: ctx.db.clinicAppointments.filter(x => String(x.clinicId) === String(ctx.clinicId) && !['completed','done','cancelled'].includes(lower(x.status))).length,
    vitals: ctx.db.clinicVitals.filter(x => String(x.clinicId) === String(ctx.clinicId)).length, pharmacy_sales: ctx.db.clinicPharmacyDispenses.filter(x => String(x.clinicId) === String(ctx.clinicId)).reduce((s,x)=>s+toNum(x.total),0),
    last_export_at: ctx.snapshot?.exported_at || now(), trusted_clients: trusted, auto_sync_enabled: true
  };
}
function rowsForTable(ctx, name){
  const snap = ctx.snapshot?.data || {};
  const direct = arr(snap[name]);
  if (direct.length) return direct;
  if (name === 'patients') return ctx.db.clinicPatients.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakePatient);
  if (name === 'bills') return ctx.db.clinicBills.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakeBill);
  if (name === 'visits') return ctx.db.clinicVisits.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakeVisit);
  if (name === 'prescriptions') return ctx.db.clinicPrescriptions.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakePrescription);
  if (name === 'pharmacy_items') return ctx.db.clinicPharmacyItems.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakePharmacyItem);
  if (name === 'pharmacy_dispenses') return ctx.db.clinicPharmacyDispenses.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakeDispense);
  return [];
}
function buildSeries(rows, valueKey){
  const map = new Map();
  rows.forEach(r => { const k = fmtDay(r.created_at || r.createdAt); map.set(k, (map.get(k)||0) + toNum(r[valueKey] || r.total || r.paid)); });
  return Array.from(map.entries()).sort((a,b)=>a[0].localeCompare(b[0])).slice(-7).map(([label,value])=>({ label, value: currency(value) }));
}
function buildDoctorPerf(ctx){
  const visits = ctx.db.clinicVisits.filter(x => String(x.clinicId) === String(ctx.clinicId));
  const map = new Map();
  visits.forEach(v => { const name = toStr(v.doctorName || v.doctor_name || 'General Doctor') || 'General Doctor'; const row = map.get(name) || { doctor_name:name, patients_total:0, active_queue:0 }; row.patients_total += 1; if (!['completed','done','closed','cancelled','served'].includes(lower(v.status))) row.active_queue += 1; map.set(name,row); });
  const rows = Array.from(map.values()).sort((a,b)=>b.patients_total-a.patients_total);
  return { rows, busiest_doctor: rows[0]?.doctor_name || '--', busiest_count: rows[0]?.patients_total || 0 };
}
function buildFinancePayload(ctx){
  const bills = ctx.db.clinicBills.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakeBill);
  const disp = ctx.db.clinicPharmacyDispenses.filter(x => String(x.clinicId) === String(ctx.clinicId)).map(toSnakeDispense);
  const totalPaid = bills.reduce((s,x)=>s+toNum(x.paid),0);
  const outstanding = bills.reduce((s,x)=>s+toNum(x.balance),0);
  const pharmacy = disp.reduce((s,x)=>s+toNum(x.total),0);
  return { billing_7d: buildSeries(bills,'paid'), pharmacy_7d: buildSeries(disp,'total'), payment_vs_outstanding: { Paid: currency(totalPaid), Outstanding: currency(outstanding) }, income_mix: { Billing: currency(totalPaid), Pharmacy: currency(pharmacy) } };
}
function htmlEscape(v){ return toStr(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

r.get('/status', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; return res.json(localStatusPayload(ctx)); });
r.get('/queue', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const queue = rowsForTable(ctx,'visits').filter(v => !['completed','done','closed','cancelled','served'].includes(lower(v.status))); return res.json({ ok:true, queue }); });
r.get('/table', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const limit = Math.max(1, Math.min(500, toNum(req.query?.limit, 50))); const name = toStr(req.query?.name); const rows = rowsForTable(ctx, name).sort((a,b)=>toNum(b.created_at||b.createdAt)-toNum(a.created_at||a.createdAt)).slice(0, limit); return res.json({ ok:true, name, rows, count: rows.length }); });
r.get('/doctors', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const set = new Set(); ctx.db.clinicUsers.filter(x => String(x.clinicId) === String(ctx.clinicId) && ['doctor','admin'].includes(lower(x.role))).forEach(x => set.add(toStr(x.fullName || x.username || x.email))); ctx.db.clinicVisits.filter(x => String(x.clinicId) === String(ctx.clinicId)).forEach(x => set.add(toStr(x.doctorName))); const doctors = Array.from(set).filter(Boolean); if (!doctors.length) doctors.push('General Doctor'); return res.json({ ok:true, doctors }); });
r.get('/pharmacy_items_list', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const items = rowsForTable(ctx,'pharmacy_items').sort((a,b)=>String(a.item_name).localeCompare(String(b.item_name))); return res.json({ ok:true, items }); });
r.get('/patient_lookup', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const pid = toStr(req.query?.patient_id); const patient = rowsForTable(ctx,'patients').find(x => String(x.patient_id) === String(pid)); if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' }); return res.json({ ok:true, patient }); });
r.get('/activity_feed', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const limit = Math.max(1, Math.min(100, toNum(req.query?.limit, 20))); const rows = ctx.db.clinicNotifications.filter(x => String(x.clinicId) === String(ctx.clinicId)).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt)).slice(0, limit).map(x => ({ actor: x.payload?.actor || x.payload?.patientName || 'System', action: x.title || x.type, details: x.message, created_at: x.createdAt })); return res.json({ ok:true, rows }); });
r.get('/global_search', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const q = lower(req.query?.q); const patients = rowsForTable(ctx,'patients').filter(x => [x.patient_id,x.full_name,x.phone,x.address].some(v => lower(v).includes(q))).slice(0,10); const visits = rowsForTable(ctx,'visits').filter(x => [x.visit_no,x.patient_name,x.doctor_name,x.complaint].some(v => lower(v).includes(q))).slice(0,10); const bills = rowsForTable(ctx,'bills').filter(x => [x.receipt_no,x.patient_name,x.payment_method].some(v => lower(v).includes(q))).slice(0,10); return res.json({ ok:true, patients, visits, bills }); });
r.get('/doctor_performance', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; return res.json({ ok:true, ...buildDoctorPerf(ctx) }); });
r.get('/financial_analytics', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; return res.json({ ok:true, ...buildFinancePayload(ctx) }); });
r.get('/cloud_status', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const devices = ctx.db.clinicDevices.filter(x => String(x.clinicId) === String(ctx.clinicId)); return res.json({ ok:true, mode:'Hybrid', trusted_devices: devices.filter(x=>x.trusted).length, total_devices: devices.length, last_snapshot_at: ctx.snapshot?.exported_at || now(), queue_depth: 0 }); });
r.get('/cloud_sync_queue', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const latest = ctx.db.clinicEvents.filter(x => String(x.clinicId) === String(ctx.clinicId)).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt)).slice(0,8).map(x => ({ title: x.type, subtitle: JSON.stringify(x.payload||{}).slice(0,120), status:'synced' })); return res.json({ ok:true, items: latest, recommendation:'Hybrid sync bridge active' }); });
r.get('/ai_insights', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; return res.json({ ok:true, cards:[{ title:'Patient Base', value:ctx.stats.patients, status:'good' },{ title:'Outstanding', value:'NGN '+currency(ctx.stats.outstanding).toFixed(2), status:ctx.stats.outstanding>0?'warn':'good' },{ title:'Queue Load', value:ctx.stats.queue, status:ctx.stats.queue>5?'warn':'good' }], summary:'Cloud portal is reading the same hybrid data model as Android local sync.' }); });
r.get('/ai_patients_watchlist', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const rows = rowsForTable(ctx,'patients').slice(0,10).map(p => ({ patient_id:p.patient_id, full_name:p.full_name, status:'stable', reason:'Recent sync available' })); return res.json({ ok:true, rows }); });
r.get('/ai_patient_summary', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const patientId = toStr(req.query?.patient_id); const s = patientSummary(ctx.snapshot, patientId); return res.json({ ok:true, ...s }); });
r.get('/portal_overview', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; return res.json({ ok:true, overview: localStatusPayload(ctx) }); });
r.get('/cloud_branch_matrix', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const branches = ctx.db.clinicBranches.filter(x => String(x.clinicId) === String(ctx.clinicId)); return res.json({ ok:true, branches: branches.map(b => ({ branchId:b.branchId, name:b.name, patients:ctx.stats.patients, revenue:ctx.stats.totalPaid, queue:ctx.stats.queue })) }); });
r.get('/online_notifications', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const limit = Math.max(1,Math.min(50,toNum(req.query?.limit,8))); const rows = ctx.db.clinicNotifications.filter(x => String(x.clinicId) === String(ctx.clinicId)).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt)).slice(0,limit); return res.json({ ok:true, rows }); });
r.get('/report_summary', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const type = toStr(req.query?.type || 'daily'); if (type === 'cashier') { const map = new Map(); ctx.db.clinicBills.filter(x => String(x.clinicId) === String(ctx.clinicId)).forEach(b => { const k = toStr(b.cashier || 'System'); const r = map.get(k) || { cashier:k, bills_count:0, paid_total:0, outstanding_total:0 }; r.bills_count += 1; r.paid_total += toNum(b.paid); r.outstanding_total += toNum(b.balance); map.set(k,r); }); return res.json({ ok:true, rows:Array.from(map.values()) }); } return res.json({ ok:true, patients_registered:ctx.stats.patients, visits_created:ctx.stats.visits, bills_created:ctx.stats.bills, revenue_today:ctx.stats.totalPaid, pharmacy_today:ctx.db.clinicPharmacyDispenses.filter(x => String(x.clinicId) === String(ctx.clinicId)).reduce((s,x)=>s+toNum(x.total),0), outstanding_today:ctx.stats.outstanding }); });
r.get('/report_printable', (req, res) => { const ctx = getClinicContext(req, res); if (!ctx) return; const html = `<!doctype html><html><head><meta charset="utf-8"><title>Clinic Report</title><style>body{font-family:Arial;padding:24px;color:#111}h1{margin:0 0 8px}table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border:1px solid #ddd;padding:8px;text-align:left}</style></head><body><h1>${htmlEscape(ctx.clinic?.clinicName || 'Clinic Pro NG')}</h1><div>Generated ${new Date().toLocaleString()}</div><table><tr><th>Patients</th><th>Visits</th><th>Bills</th><th>Paid</th><th>Outstanding</th></tr><tr><td>${ctx.stats.patients}</td><td>${ctx.stats.visits}</td><td>${ctx.stats.bills}</td><td>NGN ${currency(ctx.stats.totalPaid).toFixed(2)}</td><td>NGN ${currency(ctx.stats.outstanding).toFixed(2)}</td></tr></table></body></html>`; res.setHeader('Content-Type','text/html; charset=utf-8'); return res.send(html); });
r.post('/dashboard/register_patient', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const fullName = toStr(b.full_name || b.fullName || b.name);
    if (!fullName) return res.status(400).json({ ok:false, error:'full_name is required' });
    const db = readDB(); ensureArrays(db);
    const patient = {
      clinicId,
      branchId: toStr(b.branchId || req.auth?.branchId),
      patientId: `CPN-PT-${new Date().getFullYear()}-${String(db.clinicPatients.filter(x => String(x.clinicId) === String(clinicId)).length + 1).padStart(4,'0')}`,
      mrn: `MRN-${Date.now().toString().slice(-6)}`,
      fullName,
      gender: toStr(b.gender),
      age: toNum(b.age, 0),
      phone: cleanPhone(b.phone),
      address: toStr(b.address),
      status: 'active',
      createdAt: now(),
      updatedAt: now()
    };
    db.clinicPatients.push(patient);
    const summary = finalizeWrite(db, clinicId, 'patient_registered', 'New Patient Registered', `${patient.fullName} has been registered.`, { patientId: patient.patientId, patientName: patient.fullName }, req);
    return res.json({ ok:true, patient: toSnakePatient(patient), ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'patient register failed' });
  }
});
r.post('/dashboard/create_visit', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; const b = req.body || {}; const db = readDB(); ensureArrays(db); const pid = toStr(b.patient_id || b.patientId); const patient = db.clinicPatients.find(x => String(x.clinicId) === String(clinicId) && String(x.patientId) === pid); if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' }); const visit = { clinicId, patientId: pid, patientName: patient.fullName, visitNo: 'VIS-'+Date.now().toString().slice(-6), complaint: toStr(b.complaint), doctorName: toStr(b.doctor_name || b.doctorName || 'General Doctor'), status:'Pending', diagnosis:'', createdAt: now(), updatedAt: now() }; db.clinicVisits.push(visit); upsertByIdentity(db.clinicDoctorQueue, { ...visit }, ['visitNo']); const summary = finalizeWrite(db, clinicId, 'visit_created', 'Visit Created', `Visit created for ${patient.fullName}.`, { visitNo: visit.visitNo, patientId: pid, actor: toStr(b.actor) }, req); return res.json({ ok:true, visit, ...summary }); });
r.post('/dashboard/create_bill', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; const b = req.body || {}; const db = readDB(); ensureArrays(db); const pid = toStr(b.patient_id || b.patientId); const patient = db.clinicPatients.find(x => String(x.clinicId) === String(clinicId) && String(x.patientId) === pid); if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' }); const total = toNum(b.consultation)+toNum(b.lab)+toNum(b.drugs)+toNum(b.other); const paid = toNum(b.paid); const bill = { clinicId, patientId: pid, patientName: patient.fullName, billId:'bill_'+Date.now(), billNo:'BILL-'+Date.now().toString().slice(-6), receiptNo:'RCPT-'+Date.now().toString().slice(-6), consultation:toNum(b.consultation), lab:toNum(b.lab), drugs:toNum(b.drugs), other:toNum(b.other), total, paid, balance:Math.max(0,total-paid), status:Math.max(0,total-paid)<=0?'paid':'pending', paymentMethod:toStr(b.payment_method || b.paymentMethod || 'Cash'), cashier:toStr(b.actor || 'Admin'), createdAt:now(), updatedAt:now() }; db.clinicBills.push(bill); const summary = finalizeWrite(db, clinicId, 'bill_created', 'Bill Created', `Bill created for ${patient.fullName}.`, { billId: bill.billId, patientId: pid, total: bill.total, actor: toStr(b.actor) }, req); return res.json({ ok:true, bill_id: bill.billId, receipt_no: bill.receiptNo, printed: !!b.print_now, ...summary }); });
r.post('/dashboard/print_bill', (req, res) => res.json({ ok:true, printed:true, receipt_no: toStr(req.body?.receipt_no || 'LATEST') }));
r.post('/dashboard/add_prescription', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; const b=req.body||{}; const db=readDB(); ensureArrays(db); const patient= db.clinicPatients.find(x => String(x.clinicId)===String(clinicId) && String(x.patientId)===String(toStr(b.patient_id || b.patientId))); if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' }); db.clinicPrescriptions.push({ clinicId, patientId: patient.patientId, patientName: patient.fullName, visitNo: toStr(b.visit_no || b.visitNo), medicine: toStr(b.medicine), dosage: toStr(b.dosage), instructions: toStr(b.instructions), prescribedBy: toStr(b.actor || 'Admin'), createdAt: now(), updatedAt: now() }); const summary = finalizeWrite(db, clinicId, 'prescription_saved', 'Prescription Saved', `Prescription saved for ${patient.fullName}.`, { patientId: patient.patientId }, req); return res.json({ ok:true, ...summary }); });
r.post('/dashboard/add_pharmacy_stock', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; const b=req.body||{}; const db=readDB(); ensureArrays(db); upsertByIdentity(db.clinicPharmacyItems, { clinicId, itemName: toStr(b.item_name || b.itemName), unitPrice: toNum(b.unit_price || b.unitPrice), stockQty: toNum(b.qty || b.stock_qty), createdAt: now(), updatedAt: now() }, ['itemName']); const summary = finalizeWrite(db, clinicId, 'pharmacy_stock', 'Pharmacy Stock Updated', `Stock updated for ${toStr(b.item_name || b.itemName)}.`, { itemName: toStr(b.item_name || b.itemName) }, req); return res.json({ ok:true, ...summary }); });
r.post('/dashboard/dispense_drug', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; const b=req.body||{}; const db=readDB(); ensureArrays(db); const patient= db.clinicPatients.find(x => String(x.clinicId)===String(clinicId) && String(x.patientId)===String(toStr(b.patient_id || b.patientId))); if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' }); const item = db.clinicPharmacyItems.find(x => String(x.clinicId)===String(clinicId) && lower(x.itemName)===lower(b.item_name || b.itemName)); const qty = toNum(b.qty, 0); const unitPrice = toNum(item?.unitPrice, 0); if (item) item.stockQty = Math.max(0, toNum(item.stockQty) - qty), item.updatedAt = now(); db.clinicPharmacyDispenses.push({ clinicId, patientId: patient.patientId, patientName: patient.fullName, itemName: toStr(b.item_name || b.itemName), qty, unitPrice, total: qty*unitPrice, dispensedBy: toStr(b.actor || 'Admin'), createdAt: now(), updatedAt: now() }); const summary = finalizeWrite(db, clinicId, 'drug_dispensed', 'Drug Dispensed', `${toStr(b.item_name || b.itemName)} dispensed to ${patient.fullName}.`, { patientId: patient.patientId }, req); return res.json({ ok:true, ...summary }); });
r.post('/dashboard/print_summary_report', (req, res) => res.json({ ok:true, printed:true, type: toStr(req.body?.type || 'daily') }));
r.post('/dashboard/print_patient_slip', (req, res) => res.json({ ok:true, printed:true, patient_id: toStr(req.body?.patient_id) }));
r.get('/events', (req, res) => { const clinicId = requireClinic(req, res); if (!clinicId) return; res.set({ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive' }); res.flushHeaders?.(); const hello = `event: hello
data: ${JSON.stringify({ ok:true, clinicId, at: Date.now() })}

`; res.write(hello); const timer = setInterval(() => { try { res.write(`event: heartbeat
data: ${JSON.stringify({ t: Date.now() })}

`); } catch {} }, 15000); const unsub = clinicAddClient(clinicId, res); req.on('close', () => { clearInterval(timer); try { unsub?.(); } catch {} }); });
export default r;
