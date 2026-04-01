import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { readDB, writeDB } from '../db.js';
import { clinicAddClient, clinicPublish, clinicSendSse, clinicSseHeaders } from '../clinic_events.js';
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
function sameClinicContact(row, ownerEmail, ownerPhone){
  if (!row) return false;
  const rowEmail = safeEmail(row.ownerEmail || row.email);
  const rowPhone = cleanPhone(row.ownerPhone || row.phone);
  return !!((ownerEmail && rowEmail && rowEmail === ownerEmail) || (ownerPhone && rowPhone && rowPhone === ownerPhone));
}
function pickPatientId(x){ return toStr(x?.patientId || x?.patient_id || x?.id); }
function pickDoctorName(x){ return toStr(x?.doctorName || x?.doctor_name || x?.doctor || x?.doctorId || 'Unassigned'); }
function pickStatus(x, fallback='pending'){ return toStr(x?.status || fallback) || fallback; }
function cap(v){ const s = toStr(v); return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function ensureRestoreAudit(db){
  db.accountRestoreAudit = Array.isArray(db.accountRestoreAudit) ? db.accountRestoreAudit : [];
}
function pushRestoreAudit(db, payload = {}){
  ensureRestoreAudit(db);
  db.accountRestoreAudit.unshift({
    id: `RST-${now()}-${nanoid(6)}`,
    createdAt: now(),
    updatedAt: now(),
    ...payload
  });
  if (db.accountRestoreAudit.length > 5000) db.accountRestoreAudit.length = 5000;
}

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
  db.clinicChangeLog = arr(db.clinicChangeLog);

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
  db.clinicProfiles = arr(db.clinicProfiles);
  db.clinicAuditLogs = arr(db.clinicAuditLogs);
  db.clinicPharmacyItems = arr(db.clinicPharmacyItems);
  db.clinicVitals = arr(db.clinicVitals);
  db.clinicInpatientTreatment = arr(db.clinicInpatientTreatment);
  db.clinicTreatmentNotes = arr(db.clinicTreatmentNotes);
  db.clinicMedicationSchedule = arr(db.clinicMedicationSchedule);
  db.clinicMedicationLogs = arr(db.clinicMedicationLogs);
  db.clinicLabSamples = arr(db.clinicLabSamples);
  db.clinicPharmacyReceipts = arr(db.clinicPharmacyReceipts);
  db.clinicDischargeSummary = arr(db.clinicDischargeSummary);
  db.clinicNurseTasks = arr(db.clinicNurseTasks);
  db.clinicCashierShifts = arr(db.clinicCashierShifts);
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
    ownerPhone: c.ownerPhone || '',
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

function getClinicVersion(db, clinicId){
  const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  return toNum(clinic?.version, 0);
}
function setClinicVersion(db, clinicId, version){
  const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  if (clinic) {
    clinic.version = Math.max(toNum(clinic.version, 0), toNum(version, 0));
    clinic.updatedAt = now();
  }
  return clinic?.version || toNum(version, 0);
}
function compactChangeLog(db, clinicId, limit = 800){
  const rows = db.clinicChangeLog.filter(x => String(x.clinicId) === String(clinicId)).sort((a,b)=>toNum(b.version)-toNum(a.version));
  if (rows.length <= limit) return;
  const keep = new Set(rows.slice(0, limit).map(x => x.changeId));
  db.clinicChangeLog = db.clinicChangeLog.filter(x => String(x.clinicId) !== String(clinicId) || keep.has(x.changeId));
}
function recordClinicChange(db, clinicId, type, tables = [], payload = {}, extra = {}){
  const version = getClinicVersion(db, clinicId) + 1;
  setClinicVersion(db, clinicId, version);
  const row = {
    changeId: 'chg_' + nanoid(12),
    clinicId: String(clinicId),
    version,
    type: toStr(type || 'update') || 'update',
    tables: Array.from(new Set(arr(tables).map(x => toStr(x)).filter(Boolean))),
    payload: payload && typeof payload === 'object' ? payload : {},
    createdAt: now(),
    actor: toStr(extra.actor),
    role: normRole(extra.role || 'Admin'),
    deviceId: toStr(extra.deviceId),
    branchId: toStr(extra.branchId)
  };
  db.clinicChangeLog.push(row);
  compactChangeLog(db, clinicId);
  return row;
}
function buildSnapshotForTables(db, clinicId, tables){
  const full = clinicRows(db, clinicId);
  const wanted = new Set(arr(tables).map(x => toStr(x)).filter(Boolean));
  const aliases = {
    pharmacy: 'pharmacy_dispenses',
    lab: 'lab_requests',
    staffs: 'staff',
    clinicProfile: 'clinic_profile',
    doctorQueue: 'doctor_queue',
    nurseDesk: 'nurse_desk'
  };
  Object.entries(aliases).forEach(([alias, real]) => { if (wanted.has(alias)) wanted.add(real); });
  const data = {};
  const include = key => !wanted.size || wanted.has(key);
  Object.keys(full).forEach(key => { if (include(key)) data[key] = full[key]; });
  if (include('pharmacy_dispenses')) data.pharmacy = data.pharmacy_dispenses || full.pharmacy_dispenses;
  if (include('lab_requests')) data.lab = data.lab_requests || full.lab_requests;
  if (include('staff')) data.staffs = data.staff || full.staff;
  if (include('clinic_profile')) data.clinicProfile = data.clinic_profile || full.clinic_profile;
  if (include('doctor_queue')) data.doctorQueue = data.doctor_queue || full.doctor_queue;
  if (include('nurse_desk')) data.nurseDesk = data.nurse_desk || full.nurse_desk;
  return { data, exported_at: now(), version: getClinicVersion(db, clinicId) };
}
function changedTablesSince(db, clinicId, sinceVersion){
  const rows = db.clinicChangeLog.filter(x => String(x.clinicId) === String(clinicId) && toNum(x.version) > toNum(sinceVersion)).sort((a,b)=>toNum(a.version)-toNum(b.version));
  const tables = new Set();
  rows.forEach(row => arr(row.tables).forEach(t => tables.add(t)));
  return { rows, tables: Array.from(tables) };
}
function mergeReportTables(report){
  return Object.keys(report || {}).filter(key => {
    const v = report?.[key];
    return v && (toNum(v.inserted) > 0 || toNum(v.updated) > 0 || toNum(v.merged) > 0 || toNum(v.applied) > 0 || toNum(v.total) > 0);
  });
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
function clinicRows(db, clinicId, opts = {}){
  const canonical = opts && opts.canonical !== false;
  const match = x => String(x.clinicId) === String(clinicId);
  const profileRows = db.clinicProfiles.filter(match);
  const derivedClinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  const derivedProfile = profileRows[0] || (derivedClinic ? {
    id: 1,
    clinicId,
    clinic_name: derivedClinic.clinicName,
    phone: '',
    address: '',
    receipt_footer: 'Thank you for choosing us',
    created_at: derivedClinic.createdAt,
    updated_at: derivedClinic.updatedAt
  } : null);
  const pass = rows => arr(rows).map(x => ({ ...x }));
  const generic = (rows, prefix='row') => canonical ? arr(rows).map(x => normalizeGenericSyncRow(clinicId, x, prefix)) : pass(rows);
  return {
    clinic_profile: canonical ? arr(derivedProfile ? [derivedProfile] : profileRows).map(x => normalizeClinicProfile(clinicId, x)) : (derivedProfile ? [derivedProfile] : profileRows),
    branches: canonical ? db.clinicBranches.filter(match).map(x => normalizeBranch(clinicId, x)) : pass(db.clinicBranches.filter(match)),
    audit_logs: generic(db.clinicAuditLogs.filter(match), 'audit'),
    staff: canonical ? db.clinicUsers.filter(match).map(x => normalizeStaff(clinicId, x)) : pass(db.clinicUsers.filter(match)),
    patients: canonical ? db.clinicPatients.filter(match).map(x => normalizePatient(clinicId, x)) : pass(db.clinicPatients.filter(match)),
    visits: canonical ? db.clinicVisits.filter(match).map(x => normalizeVisit(clinicId, x)) : pass(db.clinicVisits.filter(match)),
    bills: canonical ? db.clinicBills.filter(match).map(x => normalizeBill(clinicId, x)) : pass(db.clinicBills.filter(match)),
    prescriptions: generic(db.clinicPrescriptions.filter(match), 'rx'),
    lab_requests: generic(db.clinicLabRequests.filter(match), 'lab'),
    pharmacy_items: generic(db.clinicPharmacyItems.filter(match), 'item'),
    pharmacy_dispenses: generic(db.clinicPharmacyDispenses.filter(match), 'disp'),
    admissions: canonical ? db.clinicAdmissions.filter(match).map(x => normalizeAdmission(clinicId, x)) : pass(db.clinicAdmissions.filter(match)),
    appointments: canonical ? db.clinicAppointments.filter(match).map(x => normalizeAppointment(clinicId, x)) : pass(db.clinicAppointments.filter(match)),
    vitals: generic(db.clinicVitals.filter(match), 'vital'),
    inpatient_treatment: generic(db.clinicInpatientTreatment.filter(match), 'ipt'),
    treatment_notes: generic(db.clinicTreatmentNotes.filter(match), 'note'),
    medication_schedule: generic(db.clinicMedicationSchedule.filter(match), 'msch'),
    medication_logs: generic(db.clinicMedicationLogs.filter(match), 'mlog'),
    lab_samples: generic(db.clinicLabSamples.filter(match), 'sample'),
    pharmacy_receipts: generic(db.clinicPharmacyReceipts.filter(match), 'prx'),
    discharge_summary: generic(db.clinicDischargeSummary.filter(match), 'disc'),
    nurse_tasks: generic(db.clinicNurseTasks.filter(match), 'ntask'),
    cashier_shifts: generic(db.clinicCashierShifts.filter(match), 'shift'),
    nurse_desk: generic(db.clinicNurseDesk.filter(match), 'nurse'),
    doctor_queue: generic(db.clinicDoctorQueue.filter(match), 'queue')
  };
}
function buildSnapshotData(db, clinicId){
  const rows = clinicRows(db, clinicId, { canonical:true });
  return {
    data: {
      ...rows,
      pharmacy: rows.pharmacy_dispenses,
      lab: rows.lab_requests,
      staffs: rows.staff,
      clinicProfile: rows.clinic_profile,
      doctorQueue: rows.doctor_queue,
      nurseDesk: rows.nurse_desk
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
  if (clinic) {
    clinic.updatedAt = now();
    clinic.version = Math.max(toNum(clinic.version, 0), 0);
  }
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
function slimPatientRow(row){
  if (!row) return null;
  return {
    patientId: toStr(row.patientId || row.id),
    fullName: toStr(row.fullName || row.patientName),
    mrn: toStr(row.mrn),
    gender: toStr(row.gender),
    age: toNum(row.age, 0),
    phone: cleanPhone(row.phone),
    status: toStr(row.status || 'active'),
    createdAt: toNum(row.createdAt),
    updatedAt: toNum(row.updatedAt || row.createdAt)
  };
}
function slimBillRow(row){
  if (!row) return null;
  return {
    billId: toStr(row.billId || row.id),
    patientId: toStr(row.patientId || row.patient_id),
    patientName: toStr(row.patientName),
    category: toStr(row.category || 'General'),
    total: toNum(row.total || row.amount),
    paid: toNum(row.paid || row.amount_paid),
    balance: Math.max(0, toNum(row.balance, Math.max(0, toNum(row.total || row.amount) - toNum(row.paid || row.amount_paid)))),
    status: toStr(row.status || 'pending'),
    createdAt: toNum(row.createdAt),
    updatedAt: toNum(row.updatedAt || row.createdAt)
  };
}
function slimVisitRow(row){
  if (!row) return null;
  return {
    visitId: toStr(row.visitId || row.id),
    patientId: toStr(row.patientId || row.patient_id),
    patientName: toStr(row.patientName),
    doctorName: toStr(row.doctorName || row.doctor || 'Unassigned'),
    status: toStr(row.status || 'waiting'),
    reason: toStr(row.reason || row.complaint),
    createdAt: toNum(row.createdAt),
    updatedAt: toNum(row.updatedAt || row.createdAt)
  };
}
function slimQueueRow(row){
  if (!row) return null;
  return {
    queueId: toStr(row.queueId || row.id),
    patientId: toStr(row.patientId || row.patient_id),
    patientName: toStr(row.patientName),
    doctorName: toStr(row.doctorName || row.doctor || 'Unassigned'),
    status: toStr(row.status || 'waiting'),
    priority: toStr(row.priority || 'normal'),
    createdAt: toNum(row.createdAt),
    updatedAt: toNum(row.updatedAt || row.createdAt)
  };
}
function liveCardsFromSnapshot(snapshot, changes = []){
  const stats = summarizeSnapshot(snapshot);
  const counts = {
    patients: stats.patients,
    visits: stats.visits,
    queue: stats.queue,
    bills: stats.bills,
    admissions: stats.admissions,
    totalPaid: stats.totalPaid,
    outstanding: stats.outstanding,
    pharmacy: stats.pharmacy
  };
  const cards = [
    { key:'patients', label:'Patients', value: counts.patients, sub:'Registered patient base' },
    { key:'visits', label:'Active Visits', value: counts.visits, sub:'Clinical load in motion' },
    { key:'queue', label:'Queue', value: counts.queue, sub:'Doctor waiting line' },
    { key:'totalPaid', label:'Paid Revenue', value: counts.totalPaid, kind:'money', sub:'Collected billing revenue' },
    { key:'outstanding', label:'Outstanding', value: counts.outstanding, kind:'money', sub:'Awaiting payment' },
    { key:'bills', label:'Bills', value: counts.bills, sub:'Billing records created' },
    { key:'admissions', label:'Admissions', value: counts.admissions, sub:'Current admissions' },
    { key:'pharmacy', label:'Pharmacy Sales', value: counts.pharmacy, kind:'count', sub:'Pharmacy workflow volume' }
  ];
  return { counts, cards, recentChanges: changes.slice(0,8) };
}
function buildPortalCommandCenter(db, clinicId, days = 14){
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId), createdAt: now() };
  const timeline = buildTimeline(db, clinicId, Math.max(1, Math.min(60, toNum(days, 14))));
  const queue = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === String(clinicId))).slice(0, 12).map(slimQueueRow);
  const patients = sortRecent(db.clinicPatients.filter(x => String(x.clinicId) === String(clinicId))).slice(0, 12).map(slimPatientRow);
  const bills = sortRecent(db.clinicBills.filter(x => String(x.clinicId) === String(clinicId))).slice(0, 12).map(slimBillRow);
  const changes = db.clinicChangeLog.filter(x => String(x.clinicId) === String(clinicId)).sort((a,b)=>toNum(b.version)-toNum(a.version)).slice(0, 8);
  const cards = liveCardsFromSnapshot(latest.snapshot, changes);
  return {
    version: getClinicVersion(db, clinicId),
    generatedAt: now(),
    cards: cards.cards,
    counts: cards.counts,
    timeline,
    recentPatients: patients,
    recentBills: bills,
    queue,
    recentChanges: cards.recentChanges
  };
}
function buildPortalWorkspace(db, clinicId){
  const queue = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === String(clinicId)));
  const visits = sortRecent(db.clinicVisits.filter(x => String(x.clinicId) === String(clinicId)));
  const appointments = sortRecent(db.clinicAppointments.filter(x => String(x.clinicId) === String(clinicId)));
  const labs = sortRecent(db.clinicLabRequests.filter(x => String(x.clinicId) === String(clinicId)));
  const prescriptions = sortRecent(db.clinicPrescriptions.filter(x => String(x.clinicId) === String(clinicId)));
  const nurseDesk = sortRecent(db.clinicNurseDesk.filter(x => String(x.clinicId) === String(clinicId)));
  const admissions = sortRecent(db.clinicAdmissions.filter(x => String(x.clinicId) === String(clinicId)));
  const staff = sortRecent(db.clinicUsers.filter(x => String(x.clinicId) === String(clinicId)));
  const openQueue = queue.filter(v => !['completed','closed','done','cancelled','served'].includes(lower(v.status)));
  const pendingAppointments = appointments.filter(v => ['pending','booked','scheduled'].includes(lower(v.status || 'pending')));
  const pendingLabs = labs.filter(v => !['completed','cancelled'].includes(lower(v.status || 'pending')));
  const activeVisits = visits.filter(v => !['completed','cancelled','closed'].includes(lower(v.status || 'active')));
  const activeAdmissions = admissions.filter(v => ['active','admitted','open'].includes(lower(v.status || 'active')));
  const activeRx = prescriptions.filter(v => !['stopped','cancelled','completed'].includes(lower(v.status || 'active')));
  const recentCare = [];
  openQueue.slice(0,4).forEach(x => recentCare.push({ lane:'Queue', title: pickPatientId(x) || toStr(x.patientName), sub: toStr(x.doctorName || x.doctor || 'Unassigned'), status: toStr(x.status || 'waiting'), createdAt: toNum(x.createdAt || x.updatedAt) }));
  pendingLabs.slice(0,4).forEach(x => recentCare.push({ lane:'Lab', title: toStr(x.testName || x.name || x.patientName || x.patientId), sub: toStr(x.status || 'pending'), status: toStr(x.status || 'pending'), createdAt: toNum(x.createdAt || x.updatedAt) }));
  activeRx.slice(0,4).forEach(x => recentCare.push({ lane:'Rx', title: toStr(x.drugName || x.name || x.patientName || x.patientId), sub: toStr(x.frequency || x.dosage || 'Medication order'), status: toStr(x.status || 'active'), createdAt: toNum(x.createdAt || x.updatedAt) }));
  recentCare.sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt));
  return {
    generatedAt: now(),
    summary: {
      activeVisits: activeVisits.length,
      openQueue: openQueue.length,
      pendingAppointments: pendingAppointments.length,
      pendingLabs: pendingLabs.length,
      activePrescriptions: activeRx.length,
      nurseDeskOpen: nurseDesk.filter(v => !['completed','closed'].includes(lower(v.status || 'open'))).length,
      activeAdmissions: activeAdmissions.length,
      staffOnlineReady: staff.filter(v => v.active !== false).length
    },
    lists: {
      queue: openQueue.slice(0,10).map(slimQueueRow),
      visits: activeVisits.slice(0,10).map(slimVisitRow),
      appointments: pendingAppointments.slice(0,10).map(x => ({ appointmentNo: toStr(x.appointmentNo || x.appointment_no || x.id), patientId: toStr(x.patientId || x.patient_id), doctorName: toStr(x.doctorName || x.doctor || 'Unassigned'), appointmentDate: toStr(x.appointmentDate || x.appointment_date), status: toStr(x.status || 'pending') })),
      labs: pendingLabs.slice(0,10).map(x => ({ id: toStr(x.id), patientId: toStr(x.patientId || x.patient_id), patientName: toStr(x.patientName || x.patient_id), testName: toStr(x.testName || x.name), status: toStr(x.status || 'pending'), createdAt: toNum(x.createdAt || x.updatedAt) })),
      prescriptions: activeRx.slice(0,10).map(x => ({ id: toStr(x.id), patientId: toStr(x.patientId || x.patient_id), patientName: toStr(x.patientName || x.patient_id), drugName: toStr(x.drugName || x.name), dosage: toStr(x.dosage), frequency: toStr(x.frequency), status: toStr(x.status || 'active'), createdAt: toNum(x.createdAt || x.updatedAt) })),
      nurseDesk: nurseDesk.slice(0,10).map(x => ({ id: toStr(x.id), patientId: toStr(x.patientId || x.patient_id), note: toStr(x.note), vitalSummary: toStr(x.vitalSummary || x.vital_summary), nurseName: toStr(x.nurseName || x.nurse), status: toStr(x.status || 'open'), createdAt: toNum(x.createdAt || x.updatedAt) }))
    },
    careTimeline: recentCare.slice(0,12)
  };
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
function inferTablesForEvent(type, payload = {}){
  const value = lower(type).replace(/\s+/g, '_');
  const tables = new Set();
  if (value.includes('patient')) tables.add('patients');
  if (value.includes('bill') || payload?.billId || payload?.total != null) tables.add('bills');
  if (value.includes('visit')) tables.add('visits');
  if (value.includes('appointment')) tables.add('appointments');
  if (value.includes('admission')) tables.add('admissions');
  if (value.includes('queue')) tables.add('doctor_queue');
  if (value.includes('prescription')) tables.add('prescriptions');
  if (value.includes('lab')) tables.add('lab_requests');
  if (value.includes('drug') || value.includes('pharmacy')) tables.add('pharmacy_dispenses');
  if (value.includes('nurse')) tables.add('nurse_desk');
  if (value.includes('staff')) tables.add('staff');
  if (!tables.size) tables.add('audit_logs');
  tables.add('audit_logs');
  return Array.from(tables);
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
  const changedTables = inferTablesForEvent(type, payload);
  const change = recordClinicChange(db, clinicId, type, changedTables, payload, info);
  const stats = summarizeSnapshot(snapshotRow.snapshot);
  const liveCounters = {
    patients: stats.patients,
    visits: stats.visits,
    bills: stats.bills,
    queue: stats.queue,
    admissions: stats.admissions,
    totalBill: stats.totalBill,
    totalPaid: stats.totalPaid,
    outstanding: stats.outstanding,
    pharmacy: stats.pharmacy
  };
  const livePayload = { ...payload, version: change.version, changedTables, tables: changedTables, snapshotId: snapshotRow.snapshotId, liveCounters, actor: info.actor, role: info.role };
  const event = pushEvent(db, clinicId, type, livePayload);
  makeNotification(db, clinicId, type, title, message, { payload: livePayload });
  writeDB(db);
  return { event, snapshotId: snapshotRow.snapshotId, stats, version: change.version, changedTables, liveCounters };
}
function sortRecent(items){ return arr(items).sort((a,b)=>toNum(b.updatedAt || b.createdAt)-toNum(a.updatedAt || a.createdAt)); }


function buildTimeline(db, clinicId, days = 14){
  const totalDays = Math.max(1, Math.min(60, toNum(days, 14)));
  const dayMs = 24 * 60 * 60 * 1000;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  const start = new Date(end.getTime() - ((totalDays - 1) * dayMs));
  start.setHours(0, 0, 0, 0);
  const byDay = new Map();

  for (let i = 0; i < totalDays; i += 1) {
    const d = new Date(start.getTime() + (i * dayMs));
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, {
      date: key,
      label: key,
      patients: 0,
      visits: 0,
      bills: 0,
      revenue: 0,
      paid: 0,
      outstanding: 0,
      queueAdded: 0,
      appointments: 0,
      admissions: 0,
      lab: 0,
      pharmacy: 0,
      notifications: 0
    });
  }

  const bump = (rows, field, valueFn) => {
    for (const row of arr(rows)) {
      if (!row || String(row.clinicId) !== String(clinicId)) continue;
      const ts = toNum(row.updatedAt || row.createdAt || row.date || row.timestamp || row.time, 0);
      if (!ts) continue;
      const key = new Date(ts).toISOString().slice(0, 10);
      const bucket = byDay.get(key);
      if (!bucket) continue;
      bucket[field] = toNum(bucket[field]) + toNum(valueFn ? valueFn(row) : 1);
    }
  };

  bump(db.clinicPatients, 'patients');
  bump(db.clinicVisits, 'visits');
  bump(db.clinicBills, 'bills');
  bump(db.clinicBills, 'revenue', row => toNum(row.total || row.amount));
  bump(db.clinicBills, 'paid', row => toNum(row.paid || row.amount_paid));
  bump(db.clinicDoctorQueue, 'queueAdded');
  bump(db.clinicAppointments, 'appointments');
  bump(db.clinicAdmissions, 'admissions');
  bump(db.clinicLabRequests, 'lab');
  bump(db.clinicPharmacyDispenses, 'pharmacy');
  bump(db.clinicNotifications, 'notifications');

  const timeline = Array.from(byDay.values()).map(item => ({
    ...item,
    outstanding: Math.max(0, toNum(item.revenue) - toNum(item.paid))
  }));

  return timeline.sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

function portalBundle(db, clinicId, options = {}){
  const include = new Set(arr(options.include).map(x => toStr(x).trim()).filter(Boolean));
  const wants = key => !include.size || include.has(key);
  const out = { ok:true, version: getClinicVersion(db, clinicId), serverTime: now() };
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId), createdAt: now() };
  const clinic = db.clinics.find(x => String(x.clinicId) === String(clinicId));
  const overview = summarizeSnapshot(latest?.snapshot || { data:{} });
  if (wants('live')) {
    const queue = db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && !['completed','closed','done','cancelled','served'].includes(lower(x.status)));
    const changes = db.clinicChangeLog.filter(x => String(x.clinicId) === clinicId).sort((a,b)=>toNum(b.version)-toNum(a.version)).slice(0, 8);
    const timeline = buildTimeline(db, clinicId, 1);
    const today = timeline[0] || {};
    out.live = {
      clinic: clinic ? clinicPublicRow(clinic) : null,
      version: getClinicVersion(db, clinicId),
      serverTime: now(),
      lastSnapshotAt: latest?.createdAt || 0,
      overview,
      queueCount: queue.length,
      today: {
        patients: toNum(today.patients),
        visits: toNum(today.visits),
        bills: toNum(today.bills),
        revenue: toNum(today.revenue),
        queueAdded: toNum(today.queueAdded)
      },
      recentChanges: changes
    };
  }
  if (wants('overview')) out.overview = { ok:true, version: getClinicVersion(db, clinicId), clinic: clinic ? clinicPublicRow(clinic) : null, overview };
  if (wants('finance')) out.finance = { totalBill: overview.totalBill, totalPaid: overview.totalPaid, outstanding: overview.outstanding, billCount: overview.bills, pharmacySales: overview.pharmacy };
  if (wants('queue')) {
    const rows = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && !['completed','closed','done','cancelled','served'].includes(lower(x.status))));
    out.queue = { queue: rows, queueCount: rows.length };
  }
  if (wants('patients')) {
    out.patients = { patients: sortRecent(db.clinicPatients.filter(x => String(x.clinicId) === clinicId)).slice(0, 500) };
  }
  if (wants('notifications')) {
    out.notifications = { notifications: db.clinicNotifications.filter(x => String(x.clinicId) === clinicId).sort((a,b)=>toNum(b.createdAt)-toNum(a.createdAt)).slice(0, 20) };
  }
  if (wants('timeline')) {
    out.timeline = { timeline: buildTimeline(db, clinicId, Math.max(1, Math.min(60, toNum(options.days, 14)))) };
  }
  if (wants('aiOverview')) {
    const risks = {
      unpaid_bill_detection: { score: Math.min(100, Math.round((overview.outstanding / Math.max(1, overview.totalBill || 1)) * 100)), outstanding: overview.outstanding },
      queue_pressure: { score: Math.min(100, overview.queue * 8), openQueue: overview.queue },
      doctor_workload: { score: Math.min(100, (overview.doctorWorkload[0]?.count || 0) * 10), doctors: overview.doctorWorkload.slice(0, 5) },
      pharmacy_stock_warning: { score: Math.min(100, overview.lowStock.length * 20), items: overview.lowStock.slice(0, 10) }
    };
    out.aiOverview = { ok:true, stats: overview, risks, signals: [
      { title: 'Queue pressure', score: risks.queue_pressure.score, detail: `${overview.queue} active queue item(s)` },
      { title: 'Outstanding balance', score: risks.unpaid_bill_detection.score, detail: `NGN ${overview.outstanding.toFixed(2)} pending collection` },
      { title: 'Top doctor workload', score: risks.doctor_workload.score, detail: `${overview.doctorWorkload[0]?.doctor || 'Unassigned'} currently leads queue` },
      { title: 'Pharmacy stock watch', score: risks.pharmacy_stock_warning.score, detail: `${overview.lowStock.length} item(s) below reorder threshold` }
    ] };
  }
  if (wants('risk')) {
    out.risk = { ok:true, risks: {
      unpaid_bill_detection: { score: Math.min(100, Math.round((overview.outstanding / Math.max(1, overview.totalBill || 1)) * 100)), outstanding: overview.outstanding },
      queue_pressure: { score: Math.min(100, overview.queue * 8), openQueue: overview.queue },
      doctor_workload: { score: Math.min(100, (overview.doctorWorkload[0]?.count || 0) * 10), doctors: overview.doctorWorkload.slice(0, 5) },
      pharmacy_stock_warning: { score: Math.min(100, overview.lowStock.length * 20), items: overview.lowStock.slice(0, 10) }
    }};
  }
  if (wants('commandCenter') || wants('cards') || wants('recent')) {
    out.commandCenter = buildPortalCommandCenter(db, clinicId, toNum(options.days, 14));
  }
  if (wants('workspace')) {
    out.workspace = buildPortalWorkspace(db, clinicId);
  }
  return out;
}

// Create hospital like SPNG shop create
r.post('/hospital/create', (req, res) => {
  try {
    const body = req.body || {};
    const clinicName = toStr(body.hospitalName || body.clinicName || body.shopName);
    const ownerEmail = safeEmail(body.ownerEmail || body.email);
    const ownerPhone = cleanPhone(body.ownerPhone || body.phone);
    const ownerPassword = toStr(body.ownerPassword || body.password || body.ownerPin || '1234');
    const ownerDeviceId = toStr(body.ownerDeviceId || body.deviceId);
    const branchName = toStr(body.branchName || 'Main Branch');
    if (!clinicName || !(ownerEmail || ownerPhone) || !ownerDeviceId) return res.status(400).json({ ok:false, error:'hospitalName, ownerEmail/ownerPhone and ownerDeviceId are required' });
    const db = readDB(); ensureArrays(db); ensureRestoreAudit(db);

    // Hard restore: same email or same phone must return the previous clinicId/hospitalId.
    let clinic = db.clinics.find(x => sameClinicContact(x, ownerEmail, ownerPhone));
    let reused = !!clinic;
    let reuseReason = reused ? ((ownerEmail && safeEmail(clinic.ownerEmail) === ownerEmail) ? 'ownerEmail_reused' : 'ownerPhone_reused') : '';

    // Backward compatibility for old records that only matched name+email.
    if (!clinic && ownerEmail) {
      clinic = db.clinics.find(x => safeEmail(x.ownerEmail) === ownerEmail && lower(x.clinicName) === lower(clinicName));
      reused = !!clinic;
      if (reused) reuseReason = 'ownerEmailClinicName_reused';
    }

    if (!clinic) {
      clinic = {
        clinicId: 'cln_' + nanoid(12),
        clinicCode: clinicCode(),
        clinicName,
        ownerEmail,
        ownerPhone,
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
      clinic.clinicName = clinic.clinicName || clinicName;
      if (ownerEmail) clinic.ownerEmail = ownerEmail;
      if (ownerPhone) clinic.ownerPhone = ownerPhone;
    }
    const adminUser = ensureClinicUser(db, clinic, ownerEmail, ownerPassword, 'Admin');
    const d = { deviceId: ownerDeviceId, clinicId: clinic.clinicId, role: 'Admin', trusted: true, name: toStr(body.deviceName || 'Admin Device'), updatedAt: now(), createdAt: now(), active: true };
    const i = db.clinicDevices.findIndex(x => String(x.deviceId) === d.deviceId && String(x.clinicId) === d.clinicId);
    if (i >= 0) db.clinicDevices[i] = { ...db.clinicDevices[i], ...d };
    else db.clinicDevices.push(d);
    pushRestoreAudit(db, {
      app: 'CPNG',
      entityType: 'HOSPITAL',
      action: reused ? 'restore_by_contact' : 'create_entity',
      reused,
      reuseReason,
      entityId: clinic.clinicId,
      entityCode: clinic.clinicCode,
      entityName: clinic.clinicName,
      ownerPhone,
      ownerEmail,
      deviceId: ownerDeviceId,
    });
    writeDB(db);
    const token = sign({ clinicId: clinic.clinicId, hospitalId: clinic.clinicId, deviceId: ownerDeviceId, userId: adminUser?.userId, email: ownerEmail, role: 'Admin' });
    return res.json({ ok:true, reused, reuseReason, token, clinic: clinicPublicRow(clinic), hospital: clinicPublicRow(clinic) });
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
    const db = readDB(); ensureArrays(db); ensureRestoreAudit(db);
    let clinic = null;
    if (clinicRef) clinic = db.clinics.find(x => String(x.clinicId) === clinicRef || String(x.clinicCode) === clinicRef);
    if (!clinic && email) clinic = db.clinics.find(x => safeEmail(x.ownerEmail) === email);
    if (!clinic) {
      const phoneLogin = cleanPhone(body.phone || body.ownerPhone);
      if (phoneLogin) clinic = db.clinics.find(x => cleanPhone(x.ownerPhone || x.phone) === phoneLogin);
    }
    if (!clinic) return res.status(404).json({ ok:false, error:'Hospital not found' });
    let user = db.clinicUsers.find(x => String(x.clinicId) === String(clinic.clinicId) && safeEmail(x.email) === email);
    if (!user && email === safeEmail(clinic.ownerEmail) && password === toStr(clinic.ownerPassword)) {
      user = ensureClinicUser(db, clinic, email, password, 'Admin');
    }
    if (!user || toStr(user.password) !== password) return res.status(401).json({ ok:false, error:'Invalid credentials' });
    const trusted = db.clinicDevices.find(x => String(x.clinicId) === String(clinic.clinicId) && String(x.deviceId) === deviceId && x.trusted === true);
    pushRestoreAudit(db, {
      app: 'CPNG',
      entityType: 'HOSPITAL',
      action: 'restore_login',
      reused: true,
      reuseReason: email ? 'email_login_restore' : 'phone_login_restore',
      entityId: clinic.clinicId,
      entityCode: clinic.clinicCode,
      entityName: clinic.clinicName,
      ownerPhone: cleanPhone(body.phone || body.ownerPhone || clinic.ownerPhone),
      ownerEmail: safeEmail(body.email || body.ownerEmail || clinic.ownerEmail),
      deviceId,
    });
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


function takeFirst(...vals){
  for (const v of vals) {
    const s = toStr(v);
    if (s) return s;
  }
  return '';
}
function takeTs(...vals){
  for (const v of vals) {
    const n = toNum(v, NaN);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return now();
}
function normalizePatient(clinicId, raw = {}){
  const patientId = takeFirst(raw.patientId, raw.patient_id, raw.id, raw.local_id) || createId('pt');
  return {
    ...raw,
    clinicId,
    patientId,
    patient_id: patientId,
    mrn: takeFirst(raw.mrn, raw.MRN),
    fullName: takeFirst(raw.fullName, raw.full_name, raw.patientName, raw.patient_name, raw.name),
    patientName: takeFirst(raw.patientName, raw.patient_name, raw.fullName, raw.full_name, raw.name),
    phone: cleanPhone(raw.phone || raw.mobile || raw.patientPhone),
    email: takeFirst(raw.email),
    gender: takeFirst(raw.gender, raw.sex),
    age: toNum(raw.age, 0),
    dob: takeFirst(raw.dob, raw.date_of_birth),
    address: takeFirst(raw.address),
    nextOfKin: takeFirst(raw.nextOfKin, raw.next_of_kin),
    nextOfKinPhone: cleanPhone(raw.nextOfKinPhone || raw.next_of_kin_phone),
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeBill(clinicId, raw = {}){
  const receiptNo = takeFirst(raw.receiptNo, raw.receipt_no, raw.billNo, raw.bill_no, raw.invoiceNo, raw.invoice_no, raw.id, raw.local_id) || ('BILL-' + nanoid(10));
  const patientId = takeFirst(raw.patientId, raw.patient_id);
  const total = toNum(raw.total, Number.isFinite(Number(raw.amount)) ? Number(raw.amount) : toNum(raw.paid, 0));
  const paid = toNum(raw.paid, toNum(raw.amount_paid, 0));
  return {
    ...raw,
    clinicId,
    receiptNo,
    receipt_no: receiptNo,
    billNo: receiptNo,
    bill_no: receiptNo,
    patientId,
    patient_id: patientId,
    patientName: takeFirst(raw.patientName, raw.patient_name),
    serviceName: takeFirst(raw.serviceName, raw.service_name, raw.title, raw.itemName),
    amount: total,
    total,
    paid,
    amount_paid: paid,
    balance: Math.max(0, total - paid),
    status: takeFirst(raw.status, raw.payment_status) || (paid >= total ? 'paid' : (paid > 0 ? 'partial' : 'unpaid')),
    doctorName: takeFirst(raw.doctorName, raw.doctor_name),
    note: takeFirst(raw.note, raw.notes),
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeVisit(clinicId, raw = {}){
  const visitNo = takeFirst(raw.visitNo, raw.visit_no, raw.id, raw.local_id) || ('VIS-' + nanoid(10));
  const patientId = takeFirst(raw.patientId, raw.patient_id);
  return {
    ...raw,
    clinicId,
    visitNo,
    visit_no: visitNo,
    patientId,
    patient_id: patientId,
    doctorName: takeFirst(raw.doctorName, raw.doctor_name, raw.doctor),
    reason: takeFirst(raw.reason, raw.complaint),
    diagnosis: takeFirst(raw.diagnosis),
    vitalSummary: takeFirst(raw.vitalSummary, raw.vital_summary),
    status: takeFirst(raw.status) || 'active',
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeAppointment(clinicId, raw = {}){
  const appointmentNo = takeFirst(raw.appointmentNo, raw.appointment_no, raw.id, raw.local_id) || ('APT-' + nanoid(10));
  return {
    ...raw,
    clinicId,
    appointmentNo,
    appointment_no: appointmentNo,
    patientId: takeFirst(raw.patientId, raw.patient_id),
    patient_id: takeFirst(raw.patient_id, raw.patientId),
    doctorName: takeFirst(raw.doctorName, raw.doctor_name, raw.doctor),
    appointmentDate: takeFirst(raw.appointmentDate, raw.appointment_date, raw.scheduledAt, raw.scheduled_at),
    reason: takeFirst(raw.reason),
    status: takeFirst(raw.status) || 'pending',
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeAdmission(clinicId, raw = {}){
  const admissionNo = takeFirst(raw.admissionNo, raw.admission_no, raw.id, raw.local_id) || ('ADM-' + nanoid(10));
  return {
    ...raw,
    clinicId,
    admissionNo,
    admission_no: admissionNo,
    patientId: takeFirst(raw.patientId, raw.patient_id),
    patient_id: takeFirst(raw.patient_id, raw.patientId),
    wardName: takeFirst(raw.wardName, raw.ward_name),
    bedName: takeFirst(raw.bedName, raw.bed_name),
    status: takeFirst(raw.status) || 'active',
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeSimplePatientRow(clinicId, raw = {}, kind = 'row'){
  const id = takeFirst(raw.id, raw.local_id, raw.code) || `${kind.toUpperCase()}-${nanoid(10)}`;
  return {
    ...raw,
    clinicId,
    id,
    patientId: takeFirst(raw.patientId, raw.patient_id),
    patient_id: takeFirst(raw.patient_id, raw.patientId),
    doctorName: takeFirst(raw.doctorName, raw.doctor_name, raw.doctor),
    branchId: takeFirst(raw.branchId, raw.branch_id),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}

function normalizeBranch(clinicId, raw = {}){
  const branchId = takeFirst(raw.branchId, raw.branch_id, raw.id, raw.code) || ('br_' + nanoid(10));
  return {
    ...raw,
    clinicId,
    branchId,
    branch_id: branchId,
    code: takeFirst(raw.code, raw.branchCode, raw.branch_code, branchId),
    name: takeFirst(raw.name, raw.branchName, raw.branch_name) || 'Main Branch',
    isMain: raw.isMain === true || raw.is_main === 1 || raw.is_main === true,
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeClinicProfile(clinicId, raw = {}){
  return {
    ...raw,
    id: toNum(raw.id, 1),
    clinicId,
    clinic_name: takeFirst(raw.clinic_name, raw.clinicName, raw.hospitalName),
    phone: takeFirst(raw.phone),
    address: takeFirst(raw.address),
    receipt_footer: takeFirst(raw.receipt_footer, raw.receiptFooter, raw.footer),
    created_at: takeTs(raw.created_at, raw.createdAt),
    updated_at: takeTs(raw.updated_at, raw.updatedAt, raw.created_at, raw.createdAt)
  };
}
function normalizeGenericSyncRow(clinicId, raw = {}, kind = 'row'){
  const id = takeFirst(raw.id, raw.local_id, raw.code, raw.name) || `${kind.toUpperCase()}-${nanoid(10)}`;
  return {
    ...raw,
    clinicId,
    id,
    created_at: takeTs(raw.created_at, raw.createdAt),
    updated_at: takeTs(raw.updated_at, raw.updatedAt, raw.created_at, raw.createdAt),
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function normalizeStaff(clinicId, raw = {}){
  const email = safeEmail(raw.email || raw.username);
  const userId = takeFirst(raw.userId, raw.user_id, raw.staffId, raw.staff_id, email) || ('usr_' + nanoid(10));
  return {
    ...raw,
    userId,
    clinicId,
    email: email || takeFirst(raw.username),
    username: takeFirst(raw.username, email),
    password: takeFirst(raw.password) || '1234',
    role: normRole(raw.role),
    fullName: takeFirst(raw.fullName, raw.full_name, raw.name, raw.username) || 'Staff',
    branchId: takeFirst(raw.branchId, raw.branch_id),
    active: raw.active !== false,
    createdAt: takeTs(raw.createdAt, raw.created_at),
    updatedAt: takeTs(raw.updatedAt, raw.updated_at, raw.createdAt, raw.created_at)
  };
}
function rowScore(row){
  if (!row || typeof row !== 'object') return 0;
  return Object.values(row).reduce((n, v) => {
    if (v == null) return n;
    if (typeof v === 'string') return n + (v.trim() ? 1 : 0);
    if (Array.isArray(v)) return n + (v.length ? 1 : 0);
    if (typeof v === 'object') return n + (Object.keys(v).length ? 1 : 0);
    return n + 1;
  }, 0);
}
function rowTime(row){
  return Math.max(
    toNum(row?.updatedAt, 0),
    toNum(row?.updated_at, 0),
    toNum(row?.createdAt, 0),
    toNum(row?.created_at, 0)
  );
}
function valueStrength(v){
  if (v == null) return 0;
  if (typeof v === 'string') return v.trim() ? Math.max(1, Math.min(12, v.trim().length)) : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? 3 : 0;
  if (typeof v === 'boolean') return 2;
  if (Array.isArray(v)) return v.length ? 4 + v.length : 0;
  if (typeof v === 'object') return Object.keys(v).length ? 4 + Object.keys(v).length : 0;
  return 1;
}
function mergeRowFields(existing, incoming, preferIncoming){
  const out = { ...(preferIncoming ? existing : incoming), ...(preferIncoming ? incoming : existing) };
  const keys = new Set([...Object.keys(existing || {}), ...Object.keys(incoming || {})]);
  keys.forEach(key => {
    const a = existing?.[key];
    const b = incoming?.[key];
    const aScore = valueStrength(a);
    const bScore = valueStrength(b);
    if (bScore > aScore) out[key] = b;
    else if (aScore > bScore) out[key] = a;
    else if (preferIncoming) out[key] = b;
    else out[key] = a;
  });
  return out;
}
function chooseMergedRow(existing, incoming){
  const existingTs = rowTime(existing);
  const incomingTs = rowTime(incoming);
  const existingScore = rowScore(existing);
  const incomingScore = rowScore(incoming);
  const closeWriteWindow = Math.abs(incomingTs - existingTs) <= 45000;
  const preferIncoming = incomingTs > existingTs || (incomingTs === existingTs && incomingScore >= existingScore);
  const merged = closeWriteWindow
    ? mergeRowFields(existing || {}, incoming || {}, preferIncoming)
    : (preferIncoming ? { ...existing, ...incoming } : { ...incoming, ...existing });
  const earliestCreated = Math.min(Math.max(toNum(existing?.createdAt, 0), 0) || Infinity, Math.max(toNum(incoming?.createdAt, 0), 0) || Infinity);
  return {
    ...merged,
    clinicId: incoming?.clinicId || existing?.clinicId,
    createdAt: earliestCreated === Infinity ? now() : earliestCreated,
    updatedAt: Math.max(existingTs, incomingTs, now())
  };
}
function upsertRows(target, incoming, matchers = []){
  let changed = 0;
  for (const row of arr(incoming)) {
    if (!row || typeof row !== 'object') continue;
    const idx = target.findIndex(existing => matchers.some(fn => {
      try { return fn(existing, row); } catch { return false; }
    }));
    if (idx >= 0) {
      target[idx] = chooseMergedRow(target[idx], row);
    } else {
      target.push(row);
    }
    changed += 1;
  }
  return changed;
}
function mergeSnapshotIntoCanonical(db, clinicId, snapshot){
  const data = snapshot?.data && typeof snapshot.data === 'object' ? snapshot.data : {};
  const report = {};
  report.clinic_profile = upsertRows(db.clinicProfiles, arr(data.clinic_profile || data.clinicProfile).map(x => normalizeClinicProfile(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && toNum(a.id,1)===toNum(b.id,1)
  ]);
  report.branches = upsertRows(db.clinicBranches, arr(data.branches).map(x => normalizeBranch(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.branchId||a.branch_id)===String(b.branchId||b.branch_id),
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.code) && String(a.code)===String(b.code)
  ]);
  report.audit_logs = upsertRows(db.clinicAuditLogs, arr(data.audit_logs).map(x => normalizeGenericSyncRow(clinicId, x, 'audit')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.staff = upsertRows(db.clinicUsers, arr(data.staff || data.staffs).map(x => normalizeStaff(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.userId) && String(a.userId)===String(b.userId),
    (a,b) => String(a.clinicId)===String(clinicId) && safeEmail(a.email) && safeEmail(a.email)===safeEmail(b.email),
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.username) && String(a.username)===String(b.username)
  ]);
  report.patients = upsertRows(db.clinicPatients, arr(data.patients).map(x => normalizePatient(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.patientId||a.patient_id) && String(a.patientId||a.patient_id)===String(b.patientId||b.patient_id),
    (a,b) => String(a.clinicId)===String(clinicId) && a.mrn && b.mrn && String(a.mrn)===String(b.mrn)
  ]);
  report.visits = upsertRows(db.clinicVisits, arr(data.visits).map(x => normalizeVisit(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.visitNo||a.visit_no) && String(a.visitNo||a.visit_no)===String(b.visitNo||b.visit_no)
  ]);
  report.bills = upsertRows(db.clinicBills, arr(data.bills).map(x => normalizeBill(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.receiptNo||a.receipt_no||a.billNo) && String(a.receiptNo||a.receipt_no||a.billNo)===String(b.receiptNo||b.receipt_no||b.billNo),
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id) && String(a.id)===String(b.id)
  ]);
  report.prescriptions = upsertRows(db.clinicPrescriptions, arr(data.prescriptions).map(x => normalizeGenericSyncRow(clinicId, x, 'rx')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.lab_requests = upsertRows(db.clinicLabRequests, arr(data.lab_requests || data.lab).map(x => normalizeGenericSyncRow(clinicId, x, 'lab')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.pharmacy_items = upsertRows(db.clinicPharmacyItems, arr(data.pharmacy_items).map(x => normalizeGenericSyncRow(clinicId, x, 'item')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id),
    (a,b) => String(a.clinicId)===String(clinicId) && takeFirst(a.item_name,a.itemName,a.name) && takeFirst(a.item_name,a.itemName,a.name)===takeFirst(b.item_name,b.itemName,b.name)
  ]);
  report.pharmacy_dispenses = upsertRows(db.clinicPharmacyDispenses, arr(data.pharmacy_dispenses || data.pharmacy || []).map(x => normalizeGenericSyncRow(clinicId, x, 'disp')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.admissions = upsertRows(db.clinicAdmissions, arr(data.admissions).map(x => normalizeAdmission(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.admissionNo||a.admission_no) && String(a.admissionNo||a.admission_no)===String(b.admissionNo||b.admission_no)
  ]);
  report.appointments = upsertRows(db.clinicAppointments, arr(data.appointments).map(x => normalizeAppointment(clinicId, x)), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.appointmentNo||a.appointment_no) && String(a.appointmentNo||a.appointment_no)===String(b.appointmentNo||b.appointment_no)
  ]);
  report.vitals = upsertRows(db.clinicVitals, arr(data.vitals).map(x => normalizeGenericSyncRow(clinicId, x, 'vital')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.inpatient_treatment = upsertRows(db.clinicInpatientTreatment, arr(data.inpatient_treatment).map(x => normalizeGenericSyncRow(clinicId, x, 'ipt')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.treatment_notes = upsertRows(db.clinicTreatmentNotes, arr(data.treatment_notes).map(x => normalizeGenericSyncRow(clinicId, x, 'note')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.medication_schedule = upsertRows(db.clinicMedicationSchedule, arr(data.medication_schedule).map(x => normalizeGenericSyncRow(clinicId, x, 'msch')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.medication_logs = upsertRows(db.clinicMedicationLogs, arr(data.medication_logs).map(x => normalizeGenericSyncRow(clinicId, x, 'mlog')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.lab_samples = upsertRows(db.clinicLabSamples, arr(data.lab_samples).map(x => normalizeGenericSyncRow(clinicId, x, 'sample')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.pharmacy_receipts = upsertRows(db.clinicPharmacyReceipts, arr(data.pharmacy_receipts).map(x => normalizeGenericSyncRow(clinicId, x, 'prec')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.discharge_summary = upsertRows(db.clinicDischargeSummary, arr(data.discharge_summary).map(x => normalizeGenericSyncRow(clinicId, x, 'dsch')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.nurse_tasks = upsertRows(db.clinicNurseTasks, arr(data.nurse_tasks).map(x => normalizeGenericSyncRow(clinicId, x, 'ntask')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.cashier_shifts = upsertRows(db.clinicCashierShifts, arr(data.cashier_shifts).map(x => normalizeGenericSyncRow(clinicId, x, 'shift')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.nurse_desk = upsertRows(db.clinicNurseDesk, arr(data.nurse_desk || data.nurseDesk).map(x => normalizeSimplePatientRow(clinicId, x, 'nurse')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  report.doctor_queue = upsertRows(db.clinicDoctorQueue, arr(data.doctor_queue || data.doctorQueue).map(x => normalizeSimplePatientRow(clinicId, x, 'queue')), [
    (a,b) => String(a.clinicId)===String(clinicId) && String(a.id)===String(b.id)
  ]);
  return report;
}

function saveSnapshot(db, clinicId, body){
  const snapshot = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : { data:{} };
  const mergeReport = mergeSnapshotIntoCanonical(db, clinicId, snapshot);
  const normalizedSnapshot = buildSnapshotData(db, clinicId);
  const row = {
    snapshotId: 'snp_' + nanoid(12),
    clinicId,
    branchId: toStr(body.branchId),
    deviceId: toStr(body.deviceId),
    role: normRole(body.role),
    actor: toStr(body.actor),
    snapshot: normalizedSnapshot,
    createdAt: now(),
    since: toNum(body.since, 0),
    crossBranchEnabled: !!body.cross_branch_enabled,
    mergeReport
  };
  db.clinicSnapshots.push(row);
  const change = recordClinicChange(db, clinicId, 'snapshot_sync', mergeReportTables(mergeReport), {
    snapshotId: row.snapshotId,
    deviceId: row.deviceId,
    branchId: row.branchId,
    mergeReport
  }, { actor: row.actor, role: row.role, deviceId: row.deviceId, branchId: row.branchId });
  row.version = change.version;
  return row;
}

r.post('/clinic/snapshot/upload', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.body?.hospitalId || req.body?.clinic_id || req.body?.clinicId);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const db = readDB(); ensureArrays(db);
    const row = saveSnapshot(db, clinicId, req.body || {});
    const stats = summarizeSnapshot(row.snapshot || {});
    setCursor(db, clinicId, toStr(req.body?.deviceId), row.createdAt);
    const changedTables = mergeReportTables(row.mergeReport);
    makeNotification(db, clinicId, 'sync', 'Cloud snapshot uploaded', `Device ${toStr(req.body?.deviceName || req.body?.deviceId || 'unknown')} uploaded clinic data.`, { payload: { version: row.version || getClinicVersion(db, clinicId), changedTables, tables: changedTables } });
    pushEvent(db, clinicId, 'snapshot_uploaded', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats, version: row.version || getClinicVersion(db, clinicId), changedTables, tables: changedTables });
    writeDB(db);
    const latest = getLatestSnapshot(db, clinicId);
    return res.json({ ok:true, uploaded:true, snapshotId: row.snapshotId, version: row.version || getClinicVersion(db, clinicId), stats, pull_snapshot: latest?.snapshot || row.snapshot, server_time: now() });
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
    return res.json({ ok:true, version: getClinicVersion(db, clinicId), snapshot: latest?.snapshot || fallback, snapshot_meta: latest ? { snapshotId: latest.snapshotId, createdAt: latest.createdAt, deviceId: latest.deviceId, branchId: latest.branchId } : null, server_time: now() });
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
    const stats = summarizeSnapshot(row.snapshot || {});
    setCursor(db, clinicId, toStr(req.body?.deviceId), row.createdAt);
    const changedTables = mergeReportTables(row.mergeReport);
    pushEvent(db, clinicId, 'sync_push', { deviceId: toStr(req.body?.deviceId), branchId: toStr(req.body?.branchId), stats, version: row.version || getClinicVersion(db, clinicId), changedTables, tables: changedTables });
    writeDB(db);
    return res.json({ ok:true, pushed:true, snapshotId: row.snapshotId, version: row.version || getClinicVersion(db, clinicId), stats, server_time: now() });
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
    return res.json({ ok:true, pulled:true, version: getClinicVersion(db, clinicId), snapshot: latest?.snapshot || fallback, server_time: now() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'pull failed' });
  }
});

r.get('/clinic/delta/pull', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
    if (!clinicId) return res.status(400).json({ ok:false, error:'hospitalId/clinicId is required' });
    const sinceVersion = toNum(req.query?.sinceVersion || req.query?.since_version, 0);
    const db = readDB(); ensureArrays(db);
    const currentVersion = getClinicVersion(db, clinicId);
    const { rows, tables } = changedTablesSince(db, clinicId, sinceVersion);
    const snapshot = tables.length ? buildSnapshotForTables(db, clinicId, tables) : { data:{}, exported_at: now(), version: currentVersion };
    return res.json({
      ok:true,
      sinceVersion,
      version: currentVersion,
      hasChanges: currentVersion > sinceVersion,
      changedTables: tables,
      changeCount: rows.length,
      changes: rows.slice(-50),
      snapshot,
      server_time: now()
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'delta pull failed' });
  }
});

r.get('/events/stream', (req, res) => {
  try {
    const clinicId = authClinicId(req) || toStr(req.query?.hospitalId || req.query?.clinicId || req.query?.clinic_id);
    if (!clinicId) return res.status(401).json({ ok:false, error:'Missing clinicId or hospitalId' });
    clinicSseHeaders(res);
    clinicSendSse(res, 'hello', { ok:true, clinicId, at: Date.now(), route:'/api/events/stream' });
    clinicAddClient(clinicId, res);
    const ping = setInterval(() => {
      try { clinicSendSse(res, 'ping', { t: Date.now() }); } catch {}
    }, 15000);
    req.on('close', () => {
      try { clearInterval(ping); } catch {}
    });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'events stream failed' });
  }
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
    const patient = normalizePatient(clinicId, {
      patientId: createId('pt'),
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
    });
    db.clinicPatients.push(patient);
    const summary = finalizeWrite(db, clinicId, 'patient_registered', 'New Patient Registered', `${patient.fullName} has been registered.`, { patientId: patient.patientId, patientName: patient.fullName, entity: { patient: slimPatientRow(patient) } }, req);
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
    const summary = finalizeWrite(db, clinicId, 'bill_created', 'Bill Created', `Bill created for ${patient.fullName}.`, { billId: bill.billId, patientId, total: bill.total, paid: bill.paid, balance: bill.balance, entity: { bill: slimBillRow(bill), patient: slimPatientRow(patient) } }, req);
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
    const summary = finalizeWrite(db, clinicId, 'visit_created', 'Visit Created', `Visit created for ${patient.fullName}.`, { visitId: visit.visitId, patientId, doctorName: visit.doctorName, entity: { visit: slimVisitRow(visit), patient: slimPatientRow(patient) } }, req);
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
    const summary = finalizeWrite(db, clinicId, 'doctor_queue_created', 'Doctor Queue Updated', `${patient.fullName} added to doctor queue.`, { queueId: row.queueId, patientId, doctorName: row.doctorName, entity: { queue: slimQueueRow(row), patient: slimPatientRow(patient) } }, req);
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
  return res.json({ ok:true, version: getClinicVersion(db, clinicId), clinic: clinic ? clinicPublicRow(clinic) : null, overview: summarizeSnapshot(latest?.snapshot || { data:{} }) });
});


r.get('/portal/live', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  const clinic = db.clinics.find(x => String(x.clinicId) === clinicId);
  const latest = getLatestSnapshot(db, clinicId) || { snapshot: buildSnapshotData(db, clinicId) };
  const stats = summarizeSnapshot(latest?.snapshot || { data:{} });
  const queue = db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && !['completed','closed','done','cancelled','served'].includes(lower(x.status)));
  const changes = db.clinicChangeLog.filter(x => String(x.clinicId) === clinicId).sort((a,b)=>toNum(b.version)-toNum(a.version)).slice(0, 8);
  return res.json({
    ok:true,
    clinic: clinic ? clinicPublicRow(clinic) : null,
    version: getClinicVersion(db, clinicId),
    serverTime: now(),
    lastSnapshotAt: latest?.createdAt || 0,
    overview: stats,
    queueCount: queue.length,
    recentChanges: changes
  });
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



function buildPortalPatientProfile(db, clinicId, patientId){
  ensureArrays(db);
  const patient = ensurePatientExists(db, clinicId, patientId);
  if (!patient) return null;
  const visits = sortRecent(db.clinicVisits.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId)).slice(0, 12).map(v => ({ ...slimVisitRow(v), kind:'Visit' }));
  const bills = sortRecent(db.clinicBills.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId)).slice(0, 12).map(slimBillRow);
  const admissions = sortRecent(db.clinicAdmissions.filter(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId)).slice(0, 8);
  const prescriptions = sortRecent(db.clinicPrescriptions.filter(x => String(x.clinicId) === clinicId && String(x.patientId || x.patient_id) === patientId)).slice(0, 8);
  const labs = sortRecent(db.clinicLabRequests.filter(x => String(x.clinicId) === clinicId && String(x.patientId || x.patient_id) === patientId)).slice(0, 8);
  const queue = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId && String(x.patientId || x.patient_id) === patientId)).slice(0, 8);
  const summary = { visitCount: visits.length, billCount: bills.length, admissionCount: admissions.length, prescriptionCount: prescriptions.length, labCount: labs.length, queueCount: queue.length, outstanding: bills.reduce((s,b)=>s + toNum(b.balance), 0) };
  const encounters = sortRecent([
    ...visits.map(v => ({ ...v, createdAt: toNum(v.createdAt), title: v.reason })),
    ...bills.map(b => ({ ...b, kind:'Bill', doctorName:'Billing Desk', reason:b.category })),
    ...admissions.map(a => ({ ...a, kind:'Admission', reason:a.ward, doctorName:a.doctorName, createdAt: toNum(a.admittedAt || a.createdAt) })),
    ...prescriptions.map(x => ({ kind:'Prescription', title: toStr(x.medicine || x.drugName), reason: toStr(x.dosage || x.instructions), doctorName: toStr(x.prescribed_by || x.prescribedBy), createdAt: toNum(x.created_at || x.createdAt) })),
    ...labs.map(x => ({ kind:'Lab', title: toStr(x.test_name || x.testName), reason: toStr(x.status || 'pending'), doctorName: toStr(x.requested_by || x.requestedBy), createdAt: toNum(x.created_at || x.createdAt) })),
    ...queue.map(x => ({ kind:'Queue', title: toStr(x.doctorName || x.doctor || 'Doctor Queue'), reason: toStr(x.status || 'waiting'), doctorName: toStr(x.doctorName || x.doctor), createdAt: toNum(x.createdAt || x.updatedAt || x.created_at) }))
  ]).slice(0, 24);
  return { patient, visits, bills, admissions, prescriptions, labs, queue, encounters, summary };
}

function buildPortalReceiptPreview(db, clinicId, billId){
  ensureArrays(db);
  const bill = db.clinicBills.find(x => String(x.clinicId) === clinicId && String(x.billId || x.id) === String(billId));
  if (!bill) return null;
  const patient = ensurePatientExists(db, clinicId, toStr(bill.patientId)) || {};
  const clinic = db.clinics.find(x => String(x.clinicId || x.hospitalId) === clinicId) || {};
  const branch = db.clinicBranches.find(x => String(x.clinicId) === clinicId && String(x.branchId) === String(bill.branchId)) || {};
  return {
    billId: toStr(bill.billId || bill.id), billNo: toStr(bill.billNo || `BILL-${String(bill.billId || '').slice(-6)}`),
    clinicName: toStr(clinic.clinicName || clinic.name || 'Clinic Pro NG'), branchName: toStr(branch.name || 'Main Branch'),
    generatedLabel: new Date(toNum(bill.createdAt || now())).toLocaleString(), patientId: toStr(patient.patientId || bill.patientId),
    patientName: toStr(patient.fullName || bill.patientName), category: toStr(bill.category || 'General'), description: toStr(bill.description),
    total: toNum(bill.total || bill.amount), paid: toNum(bill.paid || bill.amount_paid),
    balance: Math.max(0, toNum(bill.balance, toNum(bill.total || bill.amount) - toNum(bill.paid || bill.amount_paid))),
    status: toStr(bill.status || 'pending'), paymentMethod: toStr(bill.paymentMethod || bill.payment_method || 'Cash'), createdAt: toNum(bill.createdAt), updatedAt: toNum(bill.updatedAt || bill.createdAt)
  };
}

function buildPortalDoctorWidgets(db, clinicId){
  ensureArrays(db);
  const queue = sortRecent(db.clinicDoctorQueue.filter(x => String(x.clinicId) === clinicId)).slice(0, 400);
  const map = new Map();
  for (const row of queue){
    const doctorName = pickDoctorName(row) || 'Unassigned';
    if (!map.has(doctorName)) map.set(doctorName, { doctorName, queueCount:0, servedCount:0, waitMillisTotal:0, waitRows:0 });
    const item = map.get(doctorName);
    const status = lower(row.status || 'waiting');
    if (!['completed','cancelled'].includes(status)) item.queueCount += 1;
    if (['served','completed'].includes(status)) item.servedCount += 1;
    if (!['completed','cancelled'].includes(status)){
      const waited = Math.max(0, now() - toNum(row.createdAt || row.updatedAt));
      item.waitMillisTotal += waited;
      item.waitRows += 1;
    }
  }
  const doctors = Array.from(map.values()).map(d => { const avgWaitMin = d.waitRows ? Math.round((d.waitMillisTotal / d.waitRows) / 60000) : 0; return { ...d, avgWaitMin, avgWaitLabel: avgWaitMin ? `${avgWaitMin} min` : 'Live' }; }).sort((a,b) => toNum(b.queueCount) - toNum(a.queueCount));
  return { doctors, totals: { openQueue: doctors.reduce((s,d)=>s + toNum(d.queueCount), 0), served: doctors.reduce((s,d)=>s + toNum(d.servedCount), 0), doctorCount: doctors.length } };
}



r.post('/portal/visit/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const visitId = toStr(b.visitId || b.visit_no || b.id);
    if (!visitId) return res.status(400).json({ ok:false, error:'visitId is required' });
    const db = readDB(); ensureArrays(db);
    const visit = db.clinicVisits.find(x => String(x.clinicId) === clinicId && String(x.visitId || x.visit_no || x.id) === visitId);
    if (!visit) return res.status(404).json({ ok:false, error:'Visit not found' });
    if (b.doctorName != null) visit.doctorName = toStr(b.doctorName || b.doctor_name);
    if (b.reason != null) visit.reason = toStr(b.reason || b.complaint);
    if (b.diagnosis != null) visit.diagnosis = toStr(b.diagnosis);
    if (b.status != null) visit.status = toStr(b.status);
    visit.updatedAt = now();
    const summary = finalizeWrite(db, clinicId, 'visit_updated', 'Visit Updated', `Visit ${visit.visitNo || visitId} updated from portal.`, { visitId, patientId: visit.patientId, entity: { visit: slimVisitRow(normalizeVisit(clinicId, visit)) } }, req);
    return res.json({ ok:true, visit: normalizeVisit(clinicId, visit), ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'visit update failed' });
  }
});

r.post('/portal/queue/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const queueId = toStr(b.queueId || b.id);
    if (!queueId) return res.status(400).json({ ok:false, error:'queueId is required' });
    const db = readDB(); ensureArrays(db);
    const row = db.clinicDoctorQueue.find(x => String(x.clinicId) === clinicId && String(x.queueId || x.id) === queueId);
    if (!row) return res.status(404).json({ ok:false, error:'Queue record not found' });
    if (b.doctorName != null) row.doctorName = toStr(b.doctorName || b.doctor_name);
    if (b.priority != null) row.priority = toStr(b.priority);
    if (b.status != null) row.status = toStr(b.status);
    row.updatedAt = now();
    const summary = finalizeWrite(db, clinicId, 'doctor_queue_updated', 'Doctor Queue Updated', `Queue item ${queueId} updated from portal.`, { queueId, patientId: row.patientId, entity: { queue: slimQueueRow(row) } }, req);
    return res.json({ ok:true, queue: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'queue update failed' });
  }
});

r.post('/portal/lab/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const labId = toStr(b.labId || b.id);
    if (!labId) return res.status(400).json({ ok:false, error:'labId is required' });
    const db = readDB(); ensureArrays(db);
    const row = db.clinicLabRequests.find(x => String(x.clinicId) === clinicId && String(x.id) === labId);
    if (!row) return res.status(404).json({ ok:false, error:'Lab request not found' });
    if (b.testName != null) row.test_name = toStr(b.testName || b.test_name);
    if (b.resultText != null) row.result_text = toStr(b.resultText || b.result_text);
    if (b.status != null) row.status = toStr(b.status);
    row.updated_at = now();
    const summary = finalizeWrite(db, clinicId, 'lab_request_updated', 'Lab Request Updated', `Lab request ${labId} updated from portal.`, { labId, patientId: row.patient_id || row.patientId, entity: { lab: row } }, req);
    return res.json({ ok:true, lab: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'lab update failed' });
  }
});

r.post('/portal/prescription/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const b = req.body || {};
    const prescriptionId = toStr(b.prescriptionId || b.id);
    if (!prescriptionId) return res.status(400).json({ ok:false, error:'prescriptionId is required' });
    const db = readDB(); ensureArrays(db);
    const row = db.clinicPrescriptions.find(x => String(x.clinicId) === clinicId && String(x.id) === prescriptionId);
    if (!row) return res.status(404).json({ ok:false, error:'Prescription not found' });
    if (b.medicine != null) row.medicine = toStr(b.medicine);
    if (b.dosage != null) row.dosage = toStr(b.dosage);
    if (b.instructions != null) row.instructions = toStr(b.instructions);
    if (b.status != null) row.status = toStr(b.status);
    row.updated_at = now();
    const summary = finalizeWrite(db, clinicId, 'prescription_updated', 'Prescription Updated', `Prescription ${prescriptionId} updated from portal.`, { prescriptionId, patientId: row.patient_id || row.patientId, entity: { prescription: row } }, req);
    return res.json({ ok:true, prescription: row, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'prescription update failed' });
  }
});

r.post('/portal/patient/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const patientId = toStr(req.body?.patientId || req.body?.id);
    if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
    const db = readDB(); ensureArrays(db);
    const patient = db.clinicPatients.find(x => String(x.clinicId) === clinicId && String(x.patientId) === patientId);
    if (!patient) return res.status(404).json({ ok:false, error:'Patient not found' });
    const b = req.body || {};
    const fields = ['fullName','phone','gender','age','mrn','dob','email','bloodGroup','genotype','maritalStatus','nextOfKin','nextOfKinPhone','address','notes','status'];
    for (const key of fields) {
      if (b[key] !== undefined && b[key] !== null && String(b[key]).trim() !== '') patient[key] = key === 'age' ? toNum(b[key]) : toStr(b[key]);
    }
    patient.updatedAt = now();
    const summary = finalizeWrite(db, clinicId, 'patient_updated', 'Patient Updated', `${patient.fullName || 'Patient'} profile updated from portal.`, { patientId: patient.patientId, entity: { patient: slimPatientRow(patient) } }, req);
    return res.json({ ok:true, patient, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'patient update failed' });
  }
});

r.post('/portal/bill/update', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const billId = toStr(req.body?.billId || req.body?.id);
    if (!billId) return res.status(400).json({ ok:false, error:'billId is required' });
    const db = readDB(); ensureArrays(db);
    const bill = db.clinicBills.find(x => String(x.clinicId) === clinicId && String(x.billId || x.id) === billId);
    if (!bill) return res.status(404).json({ ok:false, error:'Bill not found' });
    const b = req.body || {};
    const total = b.total !== undefined ? toNum(b.total, toNum(bill.total || bill.amount)) : toNum(bill.total || bill.amount);
    const paid = b.paid !== undefined ? toNum(b.paid, toNum(bill.paid || bill.amount_paid)) : toNum(bill.paid || bill.amount_paid);
    if (b.category !== undefined && String(b.category).trim() !== '') bill.category = toStr(b.category);
    if (b.description !== undefined && String(b.description).trim() !== '') bill.description = toStr(b.description);
    if (b.status !== undefined && String(b.status).trim() !== '') bill.status = toStr(b.status);
    if (b.paymentMethod !== undefined && String(b.paymentMethod).trim() !== '') {
      bill.paymentMethod = toStr(b.paymentMethod);
      bill.payment_method = bill.paymentMethod;
    }
    bill.total = total;
    bill.amount = total;
    bill.paid = paid;
    bill.amount_paid = paid;
    bill.balance = Math.max(0, total - paid);
    bill.updatedAt = now();
    const summary = finalizeWrite(db, clinicId, 'bill_updated', 'Bill Updated', `${bill.patientName || 'Patient'} billing updated from portal.`, { billId: toStr(bill.billId || bill.id), patientId: bill.patientId, entity: { bill: slimBillRow(bill) } }, req);
    return res.json({ ok:true, bill, ...summary });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'bill update failed' });
  }
});

r.get('/portal/patient-profile', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const patientId = toStr(req.query?.patientId);
  if (!patientId) return res.status(400).json({ ok:false, error:'patientId is required' });
  const db = readDB(); ensureArrays(db);
  const profile = buildPortalPatientProfile(db, clinicId, patientId);
  if (!profile) return res.status(404).json({ ok:false, error:'Patient not found' });
  return res.json({ ok:true, ...profile });
});

r.get('/portal/receipt-preview', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const billId = toStr(req.query?.billId);
  if (!billId) return res.status(400).json({ ok:false, error:'billId is required' });
  const db = readDB(); ensureArrays(db);
  const receipt = buildPortalReceiptPreview(db, clinicId, billId);
  if (!receipt) return res.status(404).json({ ok:false, error:'Bill not found' });
  return res.json({ ok:true, receipt });
});

r.get('/portal/doctor-widgets', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  return res.json({ ok:true, widgets: buildPortalDoctorWidgets(db, clinicId) });
});

r.get('/portal/command-center', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  const db = readDB(); ensureArrays(db);
  return res.json({ ok:true, commandCenter: buildPortalCommandCenter(db, clinicId, toNum(req.query?.days, 14)) });
});

r.get('/portal/workspace', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const db = readDB(); ensureArrays(db);
    return res.json({ ok:true, workspace: buildPortalWorkspace(db, clinicId) });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'workspace load failed' });
  }
});

r.get('/portal/refresh-lite', (req, res) => {
  const clinicId = requireClinic(req, res); if (!clinicId) return;
  try {
    const db = readDB(); ensureArrays(db);
    const include = String(req.query?.include || 'live,overview,finance,queue,timeline,patients,notifications,aiOverview,risk,doctorWidgets').split(',').map(x => x.trim()).filter(Boolean);
    const days = toNum(req.query?.days, 14);
    const bundle = portalBundle(db, clinicId, { include, days });
    if (include.includes('doctorWidgets')) bundle.doctorWidgets = buildPortalDoctorWidgets(db, clinicId);
    return res.json(bundle);
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'portal refresh failed' });
  }
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
