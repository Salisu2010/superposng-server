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
  const clinicId = authClinicId(req);
  if (!clinicId) {
    res.status(401).json({ ok:false, error:'Missing clinic context' });
    return null;
  }
  return clinicId;
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
    patients: db.clinicPatients.filter(match),
    bills: db.clinicBills.filter(match),
    visits: db.clinicVisits.filter(match),
    admissions: db.clinicAdmissions.filter(match),
    appointments: db.clinicAppointments.filter(match),
    pharmacy_dispenses: db.clinicPharmacyDispenses.filter(match),
    lab_requests: db.clinicLabRequests.filter(match),
    prescriptions: db.clinicPrescriptions.filter(match),
    nurse_desk: db.clinicNurseDesk.filter(match),
    doctor_queue: db.clinicDoctorQueue.filter(match),
    staff: db.clinicUsers.filter(match)
  };
}
function buildSnapshotData(db, clinicId){
  const rows = clinicRows(db, clinicId);
  return {
    data: {
      ...rows,
      pharmacy_items: rows.pharmacy_dispenses,
      staffs: rows.staff
    }
  };
}


function firstNonEmpty(obj, keys, fallback=''){
  for (const key of keys) {
    const v = obj?.[key];
    if (v == null) continue;
    const s = typeof v === 'string' ? v.trim() : String(v);
    if (s !== '') return v;
  }
  return fallback;
}
function numAny(obj, keys, fallback=0){
  for (const key of keys) {
    const v = obj?.[key];
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}
function timeAny(obj, keys){
  const n = numAny(obj, keys, 0);
  return n > 0 ? n : now();
}
function rowIdentityForTable(table, row){
  if (!row || typeof row !== 'object') return '';
  const id = (...keys) => keys.map(k => toStr(row[k])).find(Boolean) || '';
  switch (table) {
    case 'patients': return id('patient_id','patientId','mrn','id');
    case 'bills': return id('receipt_no','receiptNo','billNo','billId','id');
    case 'visits': return id('visit_no','visitNo','visitId','id');
    case 'admissions': return id('admission_no','admissionNo','admissionId','id');
    case 'appointments': return id('appointment_no','appointmentNo','appointmentId','id');
    case 'pharmacy_dispenses': return id('receipt_no','receiptNo','dispense_no','dispenseNo','dispenseId','id');
    case 'lab_requests': return id('request_no','requestNo','lab_no','labNo','sample_id','sampleId','requestId','id');
    case 'prescriptions': return id('prescription_no','prescriptionNo','prescriptionId','id');
    case 'nurse_desk': return id('note_id','noteId','desk_id','deskId','id');
    case 'doctor_queue': return id('queue_no','queueNo','queueId','visit_no','visitNo','visitId','id');
    case 'staff': return id('username','email','userId','id');
    default: return id('id');
  }
}
function normalizeSnapshotRow(table, row, clinicId){
  const baseClinicId = toStr(clinicId || row?.clinicId || row?.clinic_id);
  if (table === 'patients') {
    const patientId = toStr(firstNonEmpty(row, ['patient_id','patientId','mrn','id']));
    return {
      patientId,
      clinicId: baseClinicId,
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      mrn: toStr(firstNonEmpty(row, ['mrn','patient_id','patientId'])),
      fullName: toStr(firstNonEmpty(row, ['full_name','fullName','name'])),
      gender: toStr(firstNonEmpty(row, ['gender'])),
      age: numAny(row, ['age'], 0),
      dob: toStr(firstNonEmpty(row, ['dob'])),
      phone: cleanPhone(firstNonEmpty(row, ['phone'])),
      email: safeEmail(firstNonEmpty(row, ['email'])),
      address: toStr(firstNonEmpty(row, ['address'])),
      bloodGroup: toStr(firstNonEmpty(row, ['blood_group','bloodGroup'])),
      genotype: toStr(firstNonEmpty(row, ['genotype'])),
      nextOfKin: toStr(firstNonEmpty(row, ['next_of_kin','nextOfKin'])),
      nextOfKinPhone: cleanPhone(firstNonEmpty(row, ['next_of_kin_phone','nextOfKinPhone'])),
      maritalStatus: toStr(firstNonEmpty(row, ['marital_status','maritalStatus'])),
      notes: toStr(firstNonEmpty(row, ['notes'])),
      status: toStr(firstNonEmpty(row, ['status'], 'active')) || 'active',
      createdAt: timeAny(row, ['updated_at','updatedAt','created_at','createdAt']),
      updatedAt: timeAny(row, ['updated_at','updatedAt','created_at','createdAt'])
    };
  }
  if (table === 'bills') {
    const patientId = toStr(firstNonEmpty(row, ['patient_id','patientId']));
    const total = numAny(row, ['total','amount'], 0);
    const paid = numAny(row, ['paid','amount_paid','amountPaid'], 0);
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      billId: toStr(firstNonEmpty(row, ['billId','bill_id','id'])),
      clinicId: baseClinicId,
      patientId,
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      billNo: toStr(firstNonEmpty(row, ['billNo','bill_no','receipt_no','receiptNo'])),
      category: toStr(firstNonEmpty(row, ['category'], 'General')),
      description: toStr(firstNonEmpty(row, ['description'])),
      consultation: numAny(row, ['consultation'], 0),
      lab: numAny(row, ['lab'], 0),
      drugs: numAny(row, ['drugs'], 0),
      other: numAny(row, ['other'], 0),
      total,
      paid,
      balance: numAny(row, ['balance'], Math.max(0, total - paid)),
      status: toStr(firstNonEmpty(row, ['status'], Math.max(0, total - paid) <= 0 ? 'paid' : 'pending')),
      paymentMethod: toStr(firstNonEmpty(row, ['payment_method','paymentMethod'])),
      cashier: toStr(firstNonEmpty(row, ['cashier','actor'])),
      receiptNo: toStr(firstNonEmpty(row, ['receipt_no','receiptNo','billNo','bill_no'])),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'visits') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt','check_in_at','checkInAt']);
    return {
      visitId: toStr(firstNonEmpty(row, ['visitId','visit_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      visitNo: toStr(firstNonEmpty(row, ['visit_no','visitNo','visitId','visit_id'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      doctorName: toStr(firstNonEmpty(row, ['doctor_name','doctorName','doctor'])),
      complaint: toStr(firstNonEmpty(row, ['chief_complaint','complaint'])),
      diagnosis: toStr(firstNonEmpty(row, ['diagnosis'])),
      status: toStr(firstNonEmpty(row, ['status'], 'pending')),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'appointments') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt','appointment_time','appointmentTime']);
    return {
      appointmentId: toStr(firstNonEmpty(row, ['appointmentId','appointment_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      appointmentNo: toStr(firstNonEmpty(row, ['appointment_no','appointmentNo','appointmentId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      doctorName: toStr(firstNonEmpty(row, ['doctor_name','doctorName','doctor'])),
      reason: toStr(firstNonEmpty(row, ['reason','notes'])),
      status: toStr(firstNonEmpty(row, ['status'], 'pending')),
      appointmentTime: timeAny(row, ['appointment_time','appointmentTime','created_at','createdAt']),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'admissions') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','admitted_at','admittedAt','created_at','createdAt']);
    return {
      admissionId: toStr(firstNonEmpty(row, ['admissionId','admission_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      admissionNo: toStr(firstNonEmpty(row, ['admission_no','admissionNo','admissionId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      ward: toStr(firstNonEmpty(row, ['ward'])),
      bed: toStr(firstNonEmpty(row, ['bed'])),
      doctorName: toStr(firstNonEmpty(row, ['doctor_name','doctorName','doctor'])),
      status: toStr(firstNonEmpty(row, ['status'], 'active')),
      admittedAt: timeAny(row, ['admitted_at','admittedAt','created_at','createdAt']),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'pharmacy_dispenses') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      dispenseId: toStr(firstNonEmpty(row, ['dispenseId','dispense_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      itemName: toStr(firstNonEmpty(row, ['item_name','itemName','drug_name','drugName'])),
      quantity: numAny(row, ['qty','quantity'], 0),
      unitPrice: numAny(row, ['unit_price','unitPrice','price'], 0),
      total: numAny(row, ['total','amount'], 0),
      receiptNo: toStr(firstNonEmpty(row, ['receipt_no','receiptNo'])),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'lab_requests') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      requestId: toStr(firstNonEmpty(row, ['requestId','request_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      requestNo: toStr(firstNonEmpty(row, ['request_no','requestNo','sample_id','sampleId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      testName: toStr(firstNonEmpty(row, ['test_name','testName'])),
      status: toStr(firstNonEmpty(row, ['status'], 'pending')),
      amount: numAny(row, ['amount','total'], 0),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'prescriptions') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      prescriptionId: toStr(firstNonEmpty(row, ['prescriptionId','prescription_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      doctorName: toStr(firstNonEmpty(row, ['doctor_name','doctorName','doctor'])),
      medication: toStr(firstNonEmpty(row, ['medication','drug_name','drugName'])),
      dosage: toStr(firstNonEmpty(row, ['dosage'])),
      frequency: toStr(firstNonEmpty(row, ['frequency'])),
      duration: toStr(firstNonEmpty(row, ['duration'])),
      notes: toStr(firstNonEmpty(row, ['notes'])),
      status: toStr(firstNonEmpty(row, ['status'], 'active')),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'nurse_desk') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      deskId: toStr(firstNonEmpty(row, ['deskId','desk_id','noteId','note_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      nurseName: toStr(firstNonEmpty(row, ['nurse_name','nurseName','actor'])),
      note: toStr(firstNonEmpty(row, ['note','notes'])),
      status: toStr(firstNonEmpty(row, ['status'], 'open')),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'doctor_queue') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      queueId: toStr(firstNonEmpty(row, ['queueId','queue_id','visitId','visit_id','id'])),
      clinicId: baseClinicId,
      patientId: toStr(firstNonEmpty(row, ['patient_id','patientId'])),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      patientName: toStr(firstNonEmpty(row, ['patient_name','patientName'])),
      doctorName: toStr(firstNonEmpty(row, ['doctor_name','doctorName','doctor'])),
      queueNo: toStr(firstNonEmpty(row, ['queue_no','queueNo','visit_no','visitNo'])),
      status: toStr(firstNonEmpty(row, ['status'], 'waiting')),
      createdAt,
      updatedAt: createdAt
    };
  }
  if (table === 'staff') {
    const createdAt = timeAny(row, ['updated_at','updatedAt','created_at','createdAt']);
    return {
      userId: toStr(firstNonEmpty(row, ['userId','user_id','id'])),
      clinicId: baseClinicId,
      email: safeEmail(firstNonEmpty(row, ['email','username'])),
      username: toStr(firstNonEmpty(row, ['username','email'])),
      password: toStr(firstNonEmpty(row, ['password'], '1234')),
      role: normRole(firstNonEmpty(row, ['role'], 'Cashier')),
      branchId: toStr(firstNonEmpty(row, ['branch_id','branchId'])),
      fullName: toStr(firstNonEmpty(row, ['full_name','fullName','name'])),
      active: firstNonEmpty(row, ['active'], true) !== false,
      createdAt,
      updatedAt: createdAt
    };
  }
  return { ...row, clinicId: baseClinicId };
}
function findCanonicalRow(collection, clinicId, table, incoming){
  const identity = rowIdentityForTable(table, incoming);
  if (identity) {
    return collection.find(x => String(x.clinicId) === String(clinicId) && rowIdentityForTable(table, x) === identity) || null;
  }
  return null;
}
function mergeSnapshotIntoDbArrays(db, clinicId, snapshot){
  ensureArrays(db);
  const data = snapshot?.data || {};
  const mapping = {
    patients: 'clinicPatients',
    bills: 'clinicBills',
    visits: 'clinicVisits',
    admissions: 'clinicAdmissions',
    appointments: 'clinicAppointments',
    pharmacy_dispenses: 'clinicPharmacyDispenses',
    lab_requests: 'clinicLabRequests',
    prescriptions: 'clinicPrescriptions',
    nurse_desk: 'clinicNurseDesk',
    doctor_queue: 'clinicDoctorQueue',
    staff: 'clinicUsers',
    staffs: 'clinicUsers'
  };
  const applied = {};
  for (const [table, bucket] of Object.entries(mapping)) {
    const rows = arr(data[table]);
    if (!rows.length) continue;
    const collection = db[bucket];
    let count = 0;
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object') continue;
      const normalized = normalizeSnapshotRow(table === 'staffs' ? 'staff' : table, raw, clinicId);
      const current = findCanonicalRow(collection, clinicId, table === 'staffs' ? 'staff' : table, normalized);
      if (current) {
        const incomingTs = toNum(normalized.updatedAt || normalized.createdAt || 0);
        const existingTs = toNum(current.updatedAt || current.createdAt || 0);
        if (incomingTs >= existingTs || JSON.stringify(normalized).length >= JSON.stringify(current).length) {
          Object.assign(current, { ...current, ...normalized, clinicId: String(clinicId), updatedAt: Math.max(incomingTs, existingTs, now()) });
          count++;
        }
      } else {
        collection.push({ ...normalized, clinicId: String(clinicId) });
        count++;
      }
    }
    if (count) applied[table] = count;
  }
  return applied;
}
function toAndroidSnapshot(db, clinicId){
  const rows = clinicRows(db, clinicId);
  const mapPatient = p => ({
    id: numAny(p, ['id'], 0),
    patient_id: toStr(firstNonEmpty(p, ['patientId','mrn','id'])),
    full_name: toStr(firstNonEmpty(p, ['fullName','name'])),
    phone: cleanPhone(firstNonEmpty(p, ['phone'])),
    gender: toStr(firstNonEmpty(p, ['gender'])),
    age: numAny(p, ['age'], 0),
    address: toStr(firstNonEmpty(p, ['address'])),
    created_at: timeAny(p, ['updatedAt','createdAt'])
  });
  const mapBill = b => ({
    id: numAny(b, ['id'], 0),
    patient_id: toStr(firstNonEmpty(b, ['patientId'])),
    patient_name: toStr(firstNonEmpty(b, ['patientName'])),
    receipt_no: toStr(firstNonEmpty(b, ['receiptNo','billNo'])),
    consultation: numAny(b, ['consultation'], 0),
    lab: numAny(b, ['lab'], 0),
    drugs: numAny(b, ['drugs'], 0),
    other: numAny(b, ['other'], 0),
    total: numAny(b, ['total','amount'], 0),
    paid: numAny(b, ['paid','amountPaid'], 0),
    balance: numAny(b, ['balance'], Math.max(0, numAny(b, ['total','amount'], 0) - numAny(b, ['paid','amountPaid'], 0))),
    payment_method: toStr(firstNonEmpty(b, ['paymentMethod'])),
    cashier: toStr(firstNonEmpty(b, ['cashier'])),
    created_at: timeAny(b, ['updatedAt','createdAt'])
  });
  const mapVisit = v => ({
    id: numAny(v, ['id'], 0),
    patient_id: toStr(firstNonEmpty(v, ['patientId'])),
    patient_name: toStr(firstNonEmpty(v, ['patientName'])),
    visit_no: toStr(firstNonEmpty(v, ['visitNo','visitId'])),
    doctor_name: toStr(firstNonEmpty(v, ['doctorName'])),
    complaint: toStr(firstNonEmpty(v, ['complaint'])),
    diagnosis: toStr(firstNonEmpty(v, ['diagnosis'])),
    status: toStr(firstNonEmpty(v, ['status'], 'pending')),
    created_at: timeAny(v, ['updatedAt','createdAt'])
  });
  const mapAppointment = a => ({
    id: numAny(a, ['id'], 0),
    patient_id: toStr(firstNonEmpty(a, ['patientId'])),
    patient_name: toStr(firstNonEmpty(a, ['patientName'])),
    appointment_no: toStr(firstNonEmpty(a, ['appointmentNo','appointmentId'])),
    doctor_name: toStr(firstNonEmpty(a, ['doctorName'])),
    reason: toStr(firstNonEmpty(a, ['reason','notes'])),
    status: toStr(firstNonEmpty(a, ['status'], 'pending')),
    appointment_time: timeAny(a, ['appointmentTime','updatedAt','createdAt']),
    created_at: timeAny(a, ['updatedAt','createdAt'])
  });
  const mapAdmission = a => ({
    id: numAny(a, ['id'], 0),
    patient_id: toStr(firstNonEmpty(a, ['patientId'])),
    patient_name: toStr(firstNonEmpty(a, ['patientName'])),
    admission_no: toStr(firstNonEmpty(a, ['admissionNo','admissionId'])),
    ward: toStr(firstNonEmpty(a, ['ward'])),
    bed: toStr(firstNonEmpty(a, ['bed'])),
    doctor_name: toStr(firstNonEmpty(a, ['doctorName'])),
    status: toStr(firstNonEmpty(a, ['status'], 'active')),
    admitted_at: timeAny(a, ['admittedAt','updatedAt','createdAt'])
  });
  const mapDispense = d => ({
    id: numAny(d, ['id'], 0),
    patient_id: toStr(firstNonEmpty(d, ['patientId'])),
    item_name: toStr(firstNonEmpty(d, ['itemName'])),
    qty: numAny(d, ['quantity'], 0),
    unit_price: numAny(d, ['unitPrice','price'], 0),
    total: numAny(d, ['total','amount'], 0),
    receipt_no: toStr(firstNonEmpty(d, ['receiptNo'])),
    created_at: timeAny(d, ['updatedAt','createdAt'])
  });
  const mapLab = l => ({
    id: numAny(l, ['id'], 0),
    patient_id: toStr(firstNonEmpty(l, ['patientId'])),
    patient_name: toStr(firstNonEmpty(l, ['patientName'])),
    request_no: toStr(firstNonEmpty(l, ['requestNo','sampleId'])),
    test_name: toStr(firstNonEmpty(l, ['testName'])),
    status: toStr(firstNonEmpty(l, ['status'], 'pending')),
    amount: numAny(l, ['amount','total'], 0),
    created_at: timeAny(l, ['updatedAt','createdAt'])
  });
  const mapPrescription = p => ({
    id: numAny(p, ['id'], 0),
    patient_id: toStr(firstNonEmpty(p, ['patientId'])),
    patient_name: toStr(firstNonEmpty(p, ['patientName'])),
    doctor_name: toStr(firstNonEmpty(p, ['doctorName'])),
    medication: toStr(firstNonEmpty(p, ['medication'])),
    dosage: toStr(firstNonEmpty(p, ['dosage'])),
    frequency: toStr(firstNonEmpty(p, ['frequency'])),
    duration: toStr(firstNonEmpty(p, ['duration'])),
    notes: toStr(firstNonEmpty(p, ['notes'])),
    status: toStr(firstNonEmpty(p, ['status'], 'active')),
    created_at: timeAny(p, ['updatedAt','createdAt'])
  });
  const mapNurse = n => ({
    id: numAny(n, ['id'], 0),
    patient_id: toStr(firstNonEmpty(n, ['patientId'])),
    patient_name: toStr(firstNonEmpty(n, ['patientName'])),
    nurse_name: toStr(firstNonEmpty(n, ['nurseName'])),
    note: toStr(firstNonEmpty(n, ['note','notes'])),
    status: toStr(firstNonEmpty(n, ['status'], 'open')),
    created_at: timeAny(n, ['updatedAt','createdAt'])
  });
  const mapQueue = q => ({
    id: numAny(q, ['id'], 0),
    patient_id: toStr(firstNonEmpty(q, ['patientId'])),
    patient_name: toStr(firstNonEmpty(q, ['patientName'])),
    doctor_name: toStr(firstNonEmpty(q, ['doctorName'])),
    queue_no: toStr(firstNonEmpty(q, ['queueNo','visitNo'])),
    status: toStr(firstNonEmpty(q, ['status'], 'waiting')),
    created_at: timeAny(q, ['updatedAt','createdAt'])
  });
  const mapStaff = u => ({
    id: numAny(u, ['id'], 0),
    username: toStr(firstNonEmpty(u, ['username','email'])),
    password: toStr(firstNonEmpty(u, ['password'], '1234')),
    full_name: toStr(firstNonEmpty(u, ['fullName','name'])),
    role: normRole(firstNonEmpty(u, ['role'], 'Cashier')),
    active: firstNonEmpty(u, ['active'], true) !== false ? 1 : 0,
    created_at: timeAny(u, ['updatedAt','createdAt'])
  });
  return {
    exported_at: now(),
    data: {
      patients: rows.patients.map(mapPatient),
      bills: rows.bills.map(mapBill),
      visits: rows.visits.map(mapVisit),
      admissions: rows.admissions.map(mapAdmission),
      appointments: rows.appointments.map(mapAppointment),
      pharmacy_dispenses: rows.pharmacy_dispenses.map(mapDispense),
      lab_requests: rows.lab_requests.map(mapLab),
      prescriptions: rows.prescriptions.map(mapPrescription),
      nurse_desk: rows.nurse_desk.map(mapNurse),
      doctor_queue: rows.doctor_queue.map(mapQueue),
      staff: rows.staff.map(mapStaff),
      staffs: rows.staff.map(mapStaff),
      pharmacy_items: rows.pharmacy_dispenses.map(mapDispense)
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
    const rawRow = saveSnapshot(db, clinicId, req.body || {});
    const merged = mergeSnapshotIntoDbArrays(db, clinicId, rawRow.snapshot || { data:{} });
    const row = persistDerivedSnapshot(db, clinicId, toStr(req.body?.actor || 'system'), normRole(req.body?.role), toStr(req.body?.deviceId), toStr(req.body?.branchId));
    const stats = summarizeSnapshot(row.snapshot || {});
    setCursor(db, clinicId, toStr(req.body?.deviceId), row.createdAt);
    makeNotification(db, clinicId, 'sync', 'Cloud snapshot uploaded', `Device ${toStr(req.body?.deviceName || req.body?.deviceId || 'unknown')} uploaded clinic data.`);
    pushEvent(db, clinicId, 'snapshot_uploaded', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats, merged });
    writeDB(db);
    return res.json({ ok:true, uploaded:true, snapshotId: row.snapshotId, stats, merged, pull_snapshot: toAndroidSnapshot(db, clinicId), server_time: now() });
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
    return res.json({ ok:true, snapshot: toAndroidSnapshot(db, clinicId), snapshot_meta: latest ? { snapshotId: latest.snapshotId, createdAt: latest.createdAt, deviceId: latest.deviceId, branchId: latest.branchId } : null, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'pull failed' });
  }
});

r.post('/clinic/sync/push', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.body?.hospitalId || req.body?.clinic_id || req.body?.clinicId);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const rawRow = saveSnapshot(db, clinicId, req.body || {});
    const merged = mergeSnapshotIntoDbArrays(db, clinicId, rawRow.snapshot || { data:{} });
    const row = persistDerivedSnapshot(db, clinicId, toStr(req.body?.actor || 'system'), normRole(req.body?.role), toStr(req.body?.deviceId), toStr(req.body?.branchId));
    const stats = summarizeSnapshot(row.snapshot || {});
    setCursor(db, clinicId, toStr(req.body?.deviceId), row.createdAt);
    pushEvent(db, clinicId, 'sync_push', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats, merged });
    writeDB(db);
    return res.json({ ok:true, pushed:true, snapshotId: row.snapshotId, stats, merged, snapshot: toAndroidSnapshot(db, clinicId), server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'push failed' });
  }
});

r.get('/clinic/sync/pull', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    return res.json({ ok:true, pulled:true, snapshot: toAndroidSnapshot(db, clinicId), server_time: now() });
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

export default r;
