import { Router } from "express";
import jwt from "jsonwebtoken";
import { nanoid } from "nanoid";
import { readDB, writeDB } from "../db.js";

const r = Router();

function secret() {
  return process.env.JWT_SECRET || "dev_secret_change_me";
}

function sign(payload, expiresIn = "30d") {
  return jwt.sign(payload, secret(), { expiresIn });
}

function now() { return Date.now(); }
function toStr(v) { return (v ?? "").toString().trim(); }
function norm(v) { return toStr(v).toLowerCase(); }
function num(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function bool(v) { return v === true || v === "true" || v === 1 || v === "1"; }
function clone(x) { return JSON.parse(JSON.stringify(x)); }
function asArray(v) { return Array.isArray(v) ? v : []; }

function ensure(db) {
  const keys = {
    hospitals: [],
    hospitalBranches: [],
    hospitalUsers: [],
    hospitalDevices: [],
    hospitalBackups: [],
    hospitalNotifications: [],
    hospitalSyncLog: [],
    hospitalPatients: [],
    hospitalVisits: [],
    hospitalBills: [],
    hospitalPharmacySales: [],
    hospitalLabs: [],
    hospitalAdmissions: [],
    hospitalAiSummaries: [],
    clinicSnapshots: []
  };
  for (const [k, v] of Object.entries(keys)) {
    if (!Array.isArray(db[k])) db[k] = v;
  }
}

function decodeToken(req) {
  const h = req.headers.authorization || "";
  const bearer = h.startsWith("Bearer ") ? h.slice(7) : "";
  const queryToken = toStr(req.query?.token || req.query?.access_token || req.query?.key);
  const token = bearer || queryToken;
  if (!token) return null;
  try { return jwt.verify(token, secret()); } catch { return null; }
}

function requireAuth(req, res) {
  const auth = decodeToken(req);
  if (!auth) {
    res.status(401).json({ ok: false, error: "Missing or invalid token" });
    return null;
  }
  req.enterpriseAuth = auth;
  return auth;
}

function requireSuperAdmin(req, res) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  if (norm(auth.role) !== "super_admin") {
    res.status(403).json({ ok: false, error: "Super admin only" });
    return null;
  }
  return auth;
}

function getHospitalIdFromReq(req) {
  return toStr(req.params?.hospitalId || req.query?.hospitalId || req.body?.hospitalId || req.enterpriseAuth?.hospitalId || req.enterpriseAuth?.tenantId);
}

function requireHospitalAccess(req, res, options = {}) {
  const auth = requireAuth(req, res);
  if (!auth) return null;
  const hospitalId = getHospitalIdFromReq(req);
  if (!hospitalId) {
    res.status(400).json({ ok: false, error: "hospitalId is required" });
    return null;
  }
  if (norm(auth.role) === "super_admin") {
    return { auth, hospitalId };
  }
  const tokenHospitalId = toStr(auth.hospitalId || auth.tenantId);
  if (!tokenHospitalId || tokenHospitalId !== hospitalId) {
    res.status(403).json({ ok: false, error: "Hospital access denied" });
    return null;
  }
  if (options.roles?.length) {
    const role = norm(auth.role);
    const allowed = options.roles.map(norm);
    if (!allowed.includes(role)) {
      res.status(403).json({ ok: false, error: "Role not allowed" });
      return null;
    }
  }
  return { auth, hospitalId };
}

function hospitalById(db, hospitalId) {
  return db.hospitals.find((x) => toStr(x.hospitalId) === toStr(hospitalId));
}

function branchById(db, hospitalId, branchId) {
  return db.hospitalBranches.find((x) => toStr(x.hospitalId) === toStr(hospitalId) && toStr(x.branchId) === toStr(branchId));
}

function userSafe(u) {
  if (!u) return null;
  const { password, pin, ...rest } = u;
  return rest;
}

function makeCode(prefix) {
  return `${prefix}-${nanoid(6)}`.toUpperCase();
}

function createDefaultHospitalData(db, hospital) {
  const ts = now();
  const mainBranchId = nanoid(10);
  db.hospitalBranches.push({
    branchId: mainBranchId,
    hospitalId: hospital.hospitalId,
    name: hospital.name,
    code: makeCode("BR"),
    location: hospital.location || "Main Branch",
    isMain: true,
    isActive: true,
    createdAt: ts,
    updatedAt: ts
  });
  hospital.mainBranchId = mainBranchId;
}

function addNotification(db, hospitalId, branchId, type, title, message, payload = {}) {
  ensure(db);
  const item = {
    notificationId: nanoid(14),
    hospitalId,
    branchId: toStr(branchId || ""),
    type: toStr(type || "info") || "info",
    title: toStr(title || "Update") || "Update",
    message: toStr(message || "") || "",
    payload,
    createdAt: now(),
    readBy: []
  };
  db.hospitalNotifications.push(item);
  if (db.hospitalNotifications.length > 5000) db.hospitalNotifications = db.hospitalNotifications.slice(-5000);
  return item;
}

function getHospitalCollections(db, hospitalId) {
  return {
    patients: db.hospitalPatients.filter((x) => x.hospitalId === hospitalId),
    visits: db.hospitalVisits.filter((x) => x.hospitalId === hospitalId),
    bills: db.hospitalBills.filter((x) => x.hospitalId === hospitalId),
    pharmacySales: db.hospitalPharmacySales.filter((x) => x.hospitalId === hospitalId),
    labs: db.hospitalLabs.filter((x) => x.hospitalId === hospitalId),
    admissions: db.hospitalAdmissions.filter((x) => x.hospitalId === hospitalId),
    branches: db.hospitalBranches.filter((x) => x.hospitalId === hospitalId),
    users: db.hospitalUsers.filter((x) => x.hospitalId === hospitalId),
    devices: db.hospitalDevices.filter((x) => x.hospitalId === hospitalId),
    notifications: db.hospitalNotifications.filter((x) => x.hospitalId === hospitalId),
    syncLog: db.hospitalSyncLog.filter((x) => x.hospitalId === hospitalId)
  };
}

function summarizeHospital(db, hospitalId) {
  const c = getHospitalCollections(db, hospitalId);
  const todayStart = new Date();
  todayStart.setHours(0,0,0,0);
  const todayTs = todayStart.getTime();
  const activeVisits = c.visits.filter((x) => norm(x.status) === "active");
  const queue = c.visits.filter((x) => ["queued", "waiting", "pending"].includes(norm(x.status)));
  const billsToday = c.bills.filter((x) => num(x.createdAt) >= todayTs);
  const pharmacyToday = c.pharmacySales.filter((x) => num(x.createdAt) >= todayTs);
  const admissionsActive = c.admissions.filter((x) => norm(x.status) === "active");
  const labPending = c.labs.filter((x) => ["pending", "ordered", "requested"].includes(norm(x.status)));
  const revenueToday = billsToday.reduce((s, x) => s + num(x.amountPaid || x.paid || 0), 0) + pharmacyToday.reduce((s, x) => s + num(x.amount || x.total || 0), 0);
  const outstandingPayments = c.bills.reduce((s, x) => s + Math.max(0, num(x.totalAmount || x.total || 0) - num(x.amountPaid || x.paid || 0)), 0);
  const syncPending = c.syncLog.filter((x) => norm(x.status) === "pending").length;
  return {
    totalPatients: c.patients.length,
    activeVisits: activeVisits.length,
    queueCount: queue.length,
    revenueToday,
    outstandingPayments,
    pharmacySalesToday: pharmacyToday.reduce((s, x) => s + num(x.amount || x.total || 0), 0),
    admissionsActive: admissionsActive.length,
    labPending: labPending.length,
    trustedDevices: c.devices.filter((x) => x.isTrusted === true).length,
    totalBranches: c.branches.length,
    totalUsers: c.users.length,
    notifications: c.notifications.length,
    syncPending,
    onlineDevices: c.devices.filter((x) => (now() - num(x.lastSeen)) <= 60000).length,
    lastSyncAt: c.syncLog.length ? Math.max(...c.syncLog.map((x) => num(x.createdAt))) : 0,
  };
}

function doctorAnalytics(db, hospitalId) {
  const c = getHospitalCollections(db, hospitalId);
  const map = new Map();
  for (const v of c.visits) {
    const doctorId = toStr(v.doctorId || v.assignedDoctorId || "unassigned");
    const doctorName = toStr(v.doctorName || v.assignedDoctorName || "Unassigned");
    const row = map.get(doctorId) || { doctorId, doctorName, totalPatients: 0, activeQueueLoad: 0, completed: 0 };
    row.totalPatients += 1;
    if (["queued", "waiting", "pending", "active"].includes(norm(v.status))) row.activeQueueLoad += 1;
    if (["completed", "closed", "done"].includes(norm(v.status))) row.completed += 1;
    map.set(doctorId, row);
  }
  const ranking = Array.from(map.values()).sort((a, b) => (b.totalPatients + b.activeQueueLoad) - (a.totalPatients + a.activeQueueLoad));
  return {
    ranking,
    busiestDoctor: ranking[0] || null,
    chart: ranking.slice(0, 12).map((x) => ({ label: x.doctorName, patients: x.totalPatients, queue: x.activeQueueLoad }))
  };
}

function financeAnalytics(db, hospitalId) {
  const c = getHospitalCollections(db, hospitalId);
  const byDay = new Map();
  for (const b of c.bills) {
    const dt = new Date(num(b.createdAt || now())).toISOString().slice(0, 10);
    const row = byDay.get(dt) || { date: dt, billingIncome: 0, payments: 0, outstanding: 0, pharmacyIncome: 0 };
    row.billingIncome += num(b.totalAmount || b.total || 0);
    row.payments += num(b.amountPaid || b.paid || 0);
    row.outstanding += Math.max(0, num(b.totalAmount || b.total || 0) - num(b.amountPaid || b.paid || 0));
    byDay.set(dt, row);
  }
  for (const s of c.pharmacySales) {
    const dt = new Date(num(s.createdAt || now())).toISOString().slice(0, 10);
    const row = byDay.get(dt) || { date: dt, billingIncome: 0, payments: 0, outstanding: 0, pharmacyIncome: 0 };
    row.pharmacyIncome += num(s.amount || s.total || 0);
    byDay.set(dt, row);
  }
  return Array.from(byDay.values()).sort((a,b) => a.date.localeCompare(b.date)).slice(-30);
}

function aiPatientSummary(db, hospitalId, patientId) {
  const patient = db.hospitalPatients.find((x) => x.hospitalId === hospitalId && toStr(x.patientId) === toStr(patientId));
  if (!patient) return null;
  const visits = db.hospitalVisits.filter((x) => x.hospitalId === hospitalId && toStr(x.patientId) === toStr(patientId));
  const bills = db.hospitalBills.filter((x) => x.hospitalId === hospitalId && toStr(x.patientId) === toStr(patientId));
  const labs = db.hospitalLabs.filter((x) => x.hospitalId === hospitalId && toStr(x.patientId) === toStr(patientId));
  const admissions = db.hospitalAdmissions.filter((x) => x.hospitalId === hospitalId && toStr(x.patientId) === toStr(patientId));
  const outstanding = bills.reduce((s, b) => s + Math.max(0, num(b.totalAmount || b.total || 0) - num(b.amountPaid || b.paid || 0)), 0);
  const pendingLabs = labs.filter((x) => ["pending", "ordered", "requested"].includes(norm(x.status))).length;
  const activeAdmission = admissions.find((x) => norm(x.status) === "active") || null;
  let riskScore = 0;
  if (outstanding > 0) riskScore += 20;
  if (pendingLabs > 0) riskScore += 15;
  if (visits.some((x) => ["active", "queued", "waiting"].includes(norm(x.status)))) riskScore += 25;
  if (activeAdmission) riskScore += 30;
  if (num(patient.age) >= 60) riskScore += 10;
  const riskBand = riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low";
  const summary = {
    patientId: patient.patientId,
    patientName: patient.name || patient.patientName || "Unknown Patient",
    riskScore,
    riskBand,
    outstanding,
    pendingLabs,
    activeVisitCount: visits.filter((x) => ["active", "queued", "waiting"].includes(norm(x.status))).length,
    activeAdmission: !!activeAdmission,
    recommendedNextStep: activeAdmission
      ? "Monitor inpatient progress and clear pending labs immediately."
      : pendingLabs > 0
        ? "Complete pending lab requests and review results."
        : outstanding > 0
          ? "Settle outstanding bill and confirm discharge/next appointment."
          : "Patient is relatively stable. Continue routine follow-up.",
    updatedAt: now()
  };
  return summary;
}

function recentFeed(db, hospitalId, limit = 20) {
  const notes = db.hospitalNotifications
    .filter((x) => x.hospitalId === hospitalId)
    .sort((a,b) => num(b.createdAt) - num(a.createdAt))
    .slice(0, limit)
    .map((x) => ({
      id: x.notificationId,
      type: x.type,
      title: x.title,
      message: x.message,
      branchId: x.branchId,
      createdAt: x.createdAt
    }));
  return notes;
}

r.post('/super-admin/login', (req, res) => {
  const email = norm(req.body?.email);
  const password = toStr(req.body?.password);
  const expectedEmail = norm(process.env.SUPER_ADMIN_EMAIL || 'admin@superpos.com.ng');
  const expectedPassword = toStr(process.env.SUPER_ADMIN_PASSWORD || 'admin123');
  if (email !== expectedEmail || password !== expectedPassword) {
    return res.status(401).json({ ok: false, error: 'Invalid super admin credentials' });
  }
  const token = sign({ role: 'SUPER_ADMIN', email: expectedEmail, scope: 'enterprise' }, '7d');
  return res.json({ ok: true, token, role: 'SUPER_ADMIN', email: expectedEmail });
});

r.post('/hospitals/create', (req, res) => {
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  const name = toStr(req.body?.name);
  const location = toStr(req.body?.location);
  const adminName = toStr(req.body?.adminName || 'Hospital Admin');
  const adminEmail = norm(req.body?.adminEmail || `admin.${nanoid(5)}@hospital.local`);
  const adminPassword = toStr(req.body?.adminPassword || '1234');
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  const db = readDB(); ensure(db);
  const ts = now();
  const hospitalId = nanoid(12);
  const hospital = {
    hospitalId,
    code: makeCode('HSP'),
    name,
    location,
    subscriptionPlan: toStr(req.body?.subscriptionPlan || 'enterprise'),
    status: 'active',
    createdAt: ts,
    updatedAt: ts,
    createdBy: auth.email || 'super_admin'
  };
  db.hospitals.push(hospital);
  createDefaultHospitalData(db, hospital);
  const adminUser = {
    userId: nanoid(12),
    hospitalId,
    branchId: hospital.mainBranchId,
    fullName: adminName,
    email: adminEmail,
    password: adminPassword,
    role: 'manager',
    status: 'active',
    createdAt: ts,
    updatedAt: ts
  };
  db.hospitalUsers.push(adminUser);
  addNotification(db, hospitalId, hospital.mainBranchId, 'hospital_created', 'Hospital Created', `${name} was provisioned successfully.`, { hospitalId });
  writeDB(db);
  return res.json({ ok: true, hospital, adminUser: userSafe(adminUser) });
});

r.get('/hospitals/list', (req, res) => {
  const auth = requireSuperAdmin(req, res);
  if (!auth) return;
  const db = readDB(); ensure(db);
  return res.json({ ok: true, hospitals: db.hospitals.map((h) => ({ ...h, metrics: summarizeHospital(db, h.hospitalId) })) });
});

r.get('/hospitals/:hospitalId/overview', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const hospital = hospitalById(db, ctx.hospitalId);
  if (!hospital) return res.status(404).json({ ok: false, error: 'Hospital not found' });
  const metrics = summarizeHospital(db, ctx.hospitalId);
  return res.json({ ok: true, hospital, metrics, doctorPerformance: doctorAnalytics(db, ctx.hospitalId), financeSeries: financeAnalytics(db, ctx.hospitalId), feed: recentFeed(db, ctx.hospitalId, 15) });
});

r.post('/hospitals/:hospitalId/branches', (req, res) => {
  const ctx = requireHospitalAccess(req, res, { roles: ['manager', 'admin', 'super_admin'] });
  if (!ctx) return;
  const name = toStr(req.body?.name);
  if (!name) return res.status(400).json({ ok: false, error: 'name is required' });
  const db = readDB(); ensure(db);
  if (!hospitalById(db, ctx.hospitalId)) return res.status(404).json({ ok: false, error: 'Hospital not found' });
  const branch = {
    branchId: nanoid(10), hospitalId: ctx.hospitalId, name,
    code: makeCode('BR'), location: toStr(req.body?.location || name),
    isMain: false, isActive: true, createdAt: now(), updatedAt: now()
  };
  db.hospitalBranches.push(branch);
  addNotification(db, ctx.hospitalId, branch.branchId, 'branch_created', 'New Branch Added', `${name} branch was created.`, { branchId: branch.branchId });
  writeDB(db);
  return res.json({ ok: true, branch });
});

r.get('/hospitals/:hospitalId/branches', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  return res.json({ ok: true, branches: db.hospitalBranches.filter((x) => x.hospitalId === ctx.hospitalId) });
});

r.post('/auth/login', (req, res) => {
  const email = norm(req.body?.email);
  const password = toStr(req.body?.password);
  const hospitalId = toStr(req.body?.hospitalId);
  const deviceId = toStr(req.body?.deviceId || nanoid(10));
  if (!email || !password || !hospitalId) return res.status(400).json({ ok: false, error: 'hospitalId, email, password are required' });
  const db = readDB(); ensure(db);
  const user = db.hospitalUsers.find((x) => x.hospitalId === hospitalId && norm(x.email) === email && toStr(x.password) === password && norm(x.status) === 'active');
  if (!user) return res.status(401).json({ ok: false, error: 'Invalid login' });
  let device = db.hospitalDevices.find((x) => x.hospitalId === hospitalId && x.deviceId === deviceId);
  if (!device) {
    device = { deviceId, hospitalId, branchId: user.branchId || '', userId: user.userId, name: toStr(req.body?.deviceName || 'Enterprise Device'), isTrusted: false, status: 'active', createdAt: now(), updatedAt: now(), lastSeen: now() };
    db.hospitalDevices.push(device);
  } else {
    device.lastSeen = now();
    device.updatedAt = now();
    device.userId = user.userId;
  }
  writeDB(db);
  const token = sign({ role: user.role, hospitalId, tenantId: hospitalId, branchId: user.branchId || '', userId: user.userId, deviceId, email: user.email }, '30d');
  return res.json({ ok: true, token, user: userSafe(user), device, trusted: !!device.isTrusted });
});

r.post('/devices/register', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const auth = ctx.auth;
  const db = readDB(); ensure(db);
  const deviceId = toStr(req.body?.deviceId || auth.deviceId || nanoid(10));
  let device = db.hospitalDevices.find((x) => x.hospitalId === ctx.hospitalId && x.deviceId === deviceId);
  if (!device) {
    device = { deviceId, hospitalId: ctx.hospitalId, branchId: toStr(req.body?.branchId || auth.branchId || ''), userId: toStr(auth.userId || ''), name: toStr(req.body?.name || 'Enterprise Device'), isTrusted: bool(req.body?.isTrusted), status: 'active', createdAt: now(), updatedAt: now(), lastSeen: now() };
    db.hospitalDevices.push(device);
  } else {
    device.name = toStr(req.body?.name || device.name);
    device.branchId = toStr(req.body?.branchId || device.branchId);
    device.isTrusted = bool(req.body?.isTrusted) || device.isTrusted;
    device.lastSeen = now();
    device.updatedAt = now();
  }
  addNotification(db, ctx.hospitalId, device.branchId, 'device_registered', 'Device Registered', `${device.name} is connected.`, { deviceId });
  writeDB(db);
  return res.json({ ok: true, device });
});

r.get('/hospitals/:hospitalId/devices', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const devices = db.hospitalDevices.filter((x) => x.hospitalId === ctx.hospitalId).map((x) => ({ ...x, online: (now() - num(x.lastSeen)) <= 60000 }));
  return res.json({ ok: true, devices });
});

r.post('/sync/push', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const auth = ctx.auth;
  const db = readDB(); ensure(db);
  const branchId = toStr(req.body?.branchId || auth.branchId || '');
  const items = {
    patients: asArray(req.body?.patients),
    visits: asArray(req.body?.visits),
    bills: asArray(req.body?.bills),
    pharmacySales: asArray(req.body?.pharmacySales),
    labs: asArray(req.body?.labs),
    admissions: asArray(req.body?.admissions),
  };
  const mappings = [
    ['patients', 'hospitalPatients', 'patientId'],
    ['visits', 'hospitalVisits', 'visitId'],
    ['bills', 'hospitalBills', 'billId'],
    ['pharmacySales', 'hospitalPharmacySales', 'saleId'],
    ['labs', 'hospitalLabs', 'labId'],
    ['admissions', 'hospitalAdmissions', 'admissionId']
  ];
  const ts = now();
  const stats = {};
  for (const [reqKey, dbKey, pk] of mappings) {
    stats[reqKey] = 0;
    for (const raw of items[reqKey]) {
      const id = toStr(raw?.[pk] || raw?.id || nanoid(12));
      const record = { ...clone(raw), [pk]: id, hospitalId: ctx.hospitalId, branchId: toStr(raw?.branchId || branchId || ''), updatedAt: ts, createdAt: num(raw?.createdAt || ts) };
      const idx = db[dbKey].findIndex((x) => x.hospitalId === ctx.hospitalId && toStr(x[pk]) === id);
      if (idx >= 0) db[dbKey][idx] = { ...db[dbKey][idx], ...record };
      else db[dbKey].push(record);
      stats[reqKey] += 1;
    }
  }
  const log = { syncId: nanoid(14), hospitalId: ctx.hospitalId, branchId, direction: 'push', deviceId: auth.deviceId || '', status: 'done', counts: stats, createdAt: ts };
  db.hospitalSyncLog.push(log);
  const totalOps = Object.values(stats).reduce((s, x) => s + num(x), 0);
  if (totalOps > 0) {
    addNotification(db, ctx.hospitalId, branchId, 'sync_push', 'Cloud Sync Updated', `${totalOps} records were pushed to cloud.`, { stats, syncId: log.syncId });
  }
  const device = db.hospitalDevices.find((x) => x.hospitalId === ctx.hospitalId && x.deviceId === auth.deviceId);
  if (device) { device.lastSeen = ts; device.updatedAt = ts; }
  writeDB(db);
  return res.json({ ok: true, sync: log, stats });
});

r.get('/sync/pull', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const since = num(req.query?.since || 0);
  const db = readDB(); ensure(db);
  const branchId = toStr(req.query?.branchId || ctx.auth.branchId || '');
  const filterBranch = (x) => !branchId || !toStr(x.branchId) || toStr(x.branchId) === branchId;
  const data = {
    patients: db.hospitalPatients.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    visits: db.hospitalVisits.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    bills: db.hospitalBills.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    pharmacySales: db.hospitalPharmacySales.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    labs: db.hospitalLabs.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    admissions: db.hospitalAdmissions.filter((x) => x.hospitalId === ctx.hospitalId && num(x.updatedAt || x.createdAt) > since && filterBranch(x)),
    notifications: db.hospitalNotifications.filter((x) => x.hospitalId === ctx.hospitalId && num(x.createdAt) > since && (!branchId || !toStr(x.branchId) || toStr(x.branchId) === branchId)),
  };
  return res.json({ ok: true, serverTime: now(), ...data });
});

r.post('/snapshot/upload', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const snapshot = clone(req.body?.snapshot || {});
  const ts = now();
  const item = { snapshotId: nanoid(14), hospitalId: ctx.hospitalId, branchId: toStr(req.body?.branchId || ctx.auth.branchId || ''), snapshot, createdAt: ts, createdBy: ctx.auth.userId || ctx.auth.email || 'system' };
  db.clinicSnapshots.push(item);
  addNotification(db, ctx.hospitalId, item.branchId, 'snapshot_upload', 'Snapshot Uploaded', 'A new clinic snapshot was saved to cloud.', { snapshotId: item.snapshotId });
  writeDB(db);
  return res.json({ ok: true, snapshotId: item.snapshotId, createdAt: ts });
});

r.get('/snapshot/pull', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const branchId = toStr(req.query?.branchId || ctx.auth.branchId || '');
  const snap = db.clinicSnapshots
    .filter((x) => x.hospitalId === ctx.hospitalId && (!branchId || !toStr(x.branchId) || toStr(x.branchId) === branchId))
    .sort((a,b) => num(b.createdAt) - num(a.createdAt))[0];
  return res.json({ ok: true, snapshot: snap || null });
});

r.post('/backup/create', (req, res) => {
  const ctx = requireHospitalAccess(req, res, { roles: ['manager', 'admin', 'super_admin'] });
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const bundle = getHospitalCollections(db, ctx.hospitalId);
  const backup = {
    backupId: nanoid(14), hospitalId: ctx.hospitalId, name: toStr(req.body?.name || `Backup ${new Date().toISOString()}`),
    createdAt: now(), createdBy: ctx.auth.userId || ctx.auth.email || 'system', data: bundle
  };
  db.hospitalBackups.push(backup);
  addNotification(db, ctx.hospitalId, '', 'backup_created', 'Cloud Backup Created', backup.name, { backupId: backup.backupId });
  writeDB(db);
  return res.json({ ok: true, backupId: backup.backupId, name: backup.name, createdAt: backup.createdAt });
});

r.get('/backup/list', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const backups = db.hospitalBackups.filter((x) => x.hospitalId === ctx.hospitalId).map((x) => ({ backupId: x.backupId, name: x.name, createdAt: x.createdAt, createdBy: x.createdBy }));
  return res.json({ ok: true, backups: backups.sort((a,b) => num(b.createdAt) - num(a.createdAt)) });
});

r.post('/backup/restore', (req, res) => {
  const ctx = requireHospitalAccess(req, res, { roles: ['manager', 'admin', 'super_admin'] });
  if (!ctx) return;
  const backupId = toStr(req.body?.backupId);
  if (!backupId) return res.status(400).json({ ok: false, error: 'backupId is required' });
  const db = readDB(); ensure(db);
  const backup = db.hospitalBackups.find((x) => x.hospitalId === ctx.hospitalId && x.backupId === backupId);
  if (!backup) return res.status(404).json({ ok: false, error: 'Backup not found' });
  const data = backup.data || {};
  const targets = {
    hospitalPatients: 'patients', hospitalVisits: 'visits', hospitalBills: 'bills', hospitalPharmacySales: 'pharmacySales', hospitalLabs: 'labs', hospitalAdmissions: 'admissions', hospitalDevices: 'devices', hospitalNotifications: 'notifications', hospitalSyncLog: 'syncLog', hospitalBranches: 'branches', hospitalUsers: 'users'
  };
  for (const [dbKey, dataKey] of Object.entries(targets)) {
    db[dbKey] = db[dbKey].filter((x) => x.hospitalId !== ctx.hospitalId).concat(asArray(data[dataKey]));
  }
  addNotification(db, ctx.hospitalId, '', 'backup_restored', 'Cloud Backup Restored', backup.name, { backupId });
  writeDB(db);
  return res.json({ ok: true, restoredFrom: backupId, backupName: backup.name });
});

r.get('/ai/patient_summary/:patientId', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const summary = aiPatientSummary(db, ctx.hospitalId, req.params.patientId);
  if (!summary) return res.status(404).json({ ok: false, error: 'Patient not found' });
  const idx = db.hospitalAiSummaries.findIndex((x) => x.hospitalId === ctx.hospitalId && x.patientId === summary.patientId);
  if (idx >= 0) db.hospitalAiSummaries[idx] = summary; else db.hospitalAiSummaries.push({ hospitalId: ctx.hospitalId, ...summary });
  writeDB(db);
  return res.json({ ok: true, summary });
});

r.get('/ai/overview', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const c = getHospitalCollections(db, ctx.hospitalId);
  const watchlist = c.patients.map((p) => aiPatientSummary(db, ctx.hospitalId, p.patientId)).filter(Boolean).sort((a,b) => b.riskScore - a.riskScore).slice(0, 10);
  const doctorPerf = doctorAnalytics(db, ctx.hospitalId);
  const summary = summarizeHospital(db, ctx.hospitalId);
  return res.json({ ok: true, watchlist, doctorPerformance: doctorPerf, queuePressure: summary.queueCount, financialRisk: summary.outstandingPayments, recommendations: [
    summary.queueCount > 10 ? 'Queue pressure is high. Add another doctor to triage.' : 'Queue load is stable.',
    summary.labPending > 5 ? 'Pending lab requests are rising. Review lab turnaround.' : 'Lab flow is under control.',
    summary.outstandingPayments > 0 ? 'Outstanding payments detected. Follow up with cashier desk.' : 'No major payment risk detected.'
  ]});
});

r.get('/portal/overview', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const hospital = hospitalById(db, ctx.hospitalId);
  const metrics = summarizeHospital(db, ctx.hospitalId);
  return res.json({ ok: true, hospital, metrics, doctorPerformance: doctorAnalytics(db, ctx.hospitalId), financeSeries: financeAnalytics(db, ctx.hospitalId), feed: recentFeed(db, ctx.hospitalId, 12) });
});

r.get('/portal/patients', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const q = norm(req.query?.q);
  const db = readDB(); ensure(db);
  let items = db.hospitalPatients.filter((x) => x.hospitalId === ctx.hospitalId);
  if (q) items = items.filter((x) => [x.patientId, x.name, x.patientName, x.phone].some((v) => norm(v).includes(q)));
  return res.json({ ok: true, patients: items.slice(0, 100) });
});

r.get('/portal/finance', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  return res.json({ ok: true, series: financeAnalytics(db, ctx.hospitalId), bills: db.hospitalBills.filter((x) => x.hospitalId === ctx.hospitalId).slice(-100).reverse() });
});

r.get('/portal/queue', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const queue = db.hospitalVisits.filter((x) => x.hospitalId === ctx.hospitalId && ["queued", "waiting", "pending", "active"].includes(norm(x.status)));
  return res.json({ ok: true, queue: queue.sort((a,b) => num(a.createdAt) - num(b.createdAt)) });
});

r.get('/notifications', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const since = num(req.query?.since || 0);
  const branchId = toStr(req.query?.branchId || ctx.auth.branchId || '');
  let items = db.hospitalNotifications.filter((x) => x.hospitalId === ctx.hospitalId && num(x.createdAt) > since);
  if (branchId) items = items.filter((x) => !toStr(x.branchId) || toStr(x.branchId) === branchId);
  items.sort((a,b) => num(b.createdAt) - num(a.createdAt));
  return res.json({ ok: true, notifications: items.slice(0, 100) });
});

r.post('/notifications/publish', (req, res) => {
  const ctx = requireHospitalAccess(req, res);
  if (!ctx) return;
  const db = readDB(); ensure(db);
  const note = addNotification(db, ctx.hospitalId, toStr(req.body?.branchId || ctx.auth.branchId || ''), toStr(req.body?.type || 'info'), toStr(req.body?.title || 'Notification'), toStr(req.body?.message || ''), clone(req.body?.payload || {}));
  writeDB(db);
  return res.json({ ok: true, notification: note });
});

r.get('/events/stream', (req, res) => {
  const auth = decodeToken(req);
  if (!auth) return res.status(401).json({ ok: false, error: 'Missing or invalid token' });
  const hospitalId = toStr(req.query?.hospitalId || auth.hospitalId || auth.tenantId);
  if (!hospitalId) return res.status(400).json({ ok: false, error: 'hospitalId is required' });
  if (norm(auth.role) !== 'super_admin' && toStr(auth.hospitalId || auth.tenantId) !== hospitalId) {
    return res.status(403).json({ ok: false, error: 'Hospital access denied' });
  }
  const branchId = toStr(req.query?.branchId || auth.branchId || '');
  let lastTs = num(req.query?.since || 0);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive'
  });
  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };
  send('hello', { ok: true, hospitalId, branchId, time: now() });
  const pump = () => {
    try {
      const db = readDB(); ensure(db);
      let items = db.hospitalNotifications.filter((x) => x.hospitalId === hospitalId && num(x.createdAt) > lastTs);
      if (branchId) items = items.filter((x) => !toStr(x.branchId) || toStr(x.branchId) === branchId);
      items.sort((a,b) => num(a.createdAt) - num(b.createdAt));
      for (const item of items) {
        send(item.type || 'message', item);
        lastTs = Math.max(lastTs, num(item.createdAt));
      }
    } catch {}
  };
  pump();
  const ping = setInterval(() => send('ping', { t: now() }), 15000);
  const timer = setInterval(pump, 2000);
  req.on('close', () => {
    clearInterval(ping);
    clearInterval(timer);
  });
});

export default r;
