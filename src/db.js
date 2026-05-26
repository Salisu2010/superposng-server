import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '../db.json')

let cachedDb = null
let cachedMtimeMs = 0
let cachedSize = -1


function buildInitialDB() {
  return {
    shops: [], devices: [], pairCodes: [], products: [], staffs: [], sales: [], debtors: [], debtorPayments: [],
    licenses: [], pendingActivations: [], rmpLicenses: [], rmpPendingActivations: [], owners: [], shopAliases: [],
    trials: [], trialAuditLogs: [], trialBlocks: [],
    tgOrgs: [], tgDevices: [], tgEnrollTokens: [], tgCommands: [], tgLocations: [], tgHeartbeats: [], tgPairCodes: [],
    stmnLicenses: [], stmnFcmTokens: [], stmnChatMessages: [], stmnChatSeen: [],
    clinics: [], clinicDevices: [], clinicUsers: [], clinicSnapshots: [], clinicBackups: [], clinicNotifications: [], clinicEvents: [],
    clinicBranches: [], clinicSyncCursor: [], clinicPatients: [], clinicBills: [], clinicVisits: [], clinicAdmissions: [],
    clinicAppointments: [], clinicPharmacyDispenses: [], clinicPharmacyItems: [], clinicPharmacyReceipts: [], clinicStockMovements: [],
    clinicSuppliers: [], clinicLabRequests: [], clinicPrescriptions: [], clinicNurseDesk: [], clinicDoctorQueue: [], clinicPairCodes: [],
    clinicChangeLog: [], clinicLabOrders: []
  }
}

function backupCorruptedDB(raw, reason) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupFile = `${DB_FILE}.corrupt-${stamp}.bak`
    fs.writeFileSync(backupFile, raw || '', 'utf-8')
    console.error('[db] Invalid db.json backed up before reset:', backupFile, reason || '')
  } catch (e) {
    try { console.error('[db] Failed to backup corrupted db.json:', e?.message || e) } catch {}
  }
}
function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = buildInitialDB()
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    cachedDb = initialData
    try {
      const st = fs.statSync(DB_FILE)
      cachedMtimeMs = st.mtimeMs
      cachedSize = st.size
    } catch {}
  }
}

function normalizeDB(db) {
    db = db && typeof db === 'object' ? db : buildInitialDB()
    // Backward-compatible: add missing collections without overwriting existing data.
    if (!Array.isArray(db.shops)) db.shops = []
    if (!Array.isArray(db.devices)) db.devices = []
    if (!Array.isArray(db.pairCodes)) db.pairCodes = []
    if (!Array.isArray(db.products)) db.products = []
    if (!Array.isArray(db.staffs)) db.staffs = []
    if (!Array.isArray(db.sales)) db.sales = []
    if (!Array.isArray(db.debtors)) db.debtors = []
    if (!Array.isArray(db.debtorPayments)) db.debtorPayments = []

    // Backward compatibility: normalize debtor shape
    // Old shapes used fields like: { totalOwed, remainingOwed, ... }
    // New shape: { total, paid, balance, status, receiptNo, ... }
    db.debtors = db.debtors.map((d, idx) => {
      const o = d || {}
      const receiptNo = String(o.receiptNo || o.receipt || o.saleNo || o.saleId || o.id || `DEBT-${idx + 1}`)
      const customerName = String(o.customerName || o.name || "").trim()
      const customerPhone = String(o.customerPhone || o.phone || "").trim()

      const total = Number(
        o.total ?? o.amount ?? o.totalOwed ?? o.remainingOwed ?? 0
      )
      const paid = Number(
        o.paid ?? o.totalPaid ?? (Number(o.totalOwed ?? total) - Number(o.remainingOwed ?? 0)) ?? 0
      )
      const balance = Number(
        o.balance ?? o.remaining ?? o.remainingOwed ?? (total - paid)
      )
      const status = String(o.status || (balance <= 0.0001 ? "PAID" : "PARTIAL"))
      const createdAt = Number(o.createdAt || o.time || o.ts || Date.now())
      const updatedAt = Number(o.updatedAt || createdAt)

      return {
        ...o,
        receiptNo,
        customerName,
        customerPhone,
        total,
        paid,
        balance,
        status,
        createdAt,
        updatedAt
      }
    })
    // Licensing / activation tables
    if (!Array.isArray(db.licenses)) db.licenses = []
    if (!Array.isArray(db.pendingActivations)) db.pendingActivations = []
    if (!Array.isArray(db.rmpLicenses)) db.rmpLicenses = []
    if (!Array.isArray(db.rmpPendingActivations)) db.rmpPendingActivations = []
    if (!Array.isArray(db.owners)) db.owners = []
    if (!Array.isArray(db.shopAliases)) db.shopAliases = []
    if (!Array.isArray(db.trials)) db.trials = []
    if (!Array.isArray(db.trialAuditLogs)) db.trialAuditLogs = []
    if (!Array.isArray(db.trialBlocks)) db.trialBlocks = []
    if (!Array.isArray(db.stmnLicenses)) db.stmnLicenses = []
    if (!Array.isArray(db.stmnFcmTokens)) db.stmnFcmTokens = []
    if (!Array.isArray(db.stmnChatMessages)) db.stmnChatMessages = []
    if (!Array.isArray(db.stmnChatSeen)) db.stmnChatSeen = []
    if (!Array.isArray(db.clinics)) db.clinics = []
    if (!Array.isArray(db.clinicDevices)) db.clinicDevices = []
    if (!Array.isArray(db.clinicUsers)) db.clinicUsers = []
    if (!Array.isArray(db.clinicSnapshots)) db.clinicSnapshots = []
    if (!Array.isArray(db.clinicBackups)) db.clinicBackups = []
    if (!Array.isArray(db.clinicNotifications)) db.clinicNotifications = []
    if (!Array.isArray(db.clinicEvents)) db.clinicEvents = []
    if (!Array.isArray(db.clinicBranches)) db.clinicBranches = []
    if (!Array.isArray(db.clinicSyncCursor)) db.clinicSyncCursor = []
    if (!Array.isArray(db.clinicPatients)) db.clinicPatients = []
    if (!Array.isArray(db.clinicBills)) db.clinicBills = []
    if (!Array.isArray(db.clinicVisits)) db.clinicVisits = []
    if (!Array.isArray(db.clinicAdmissions)) db.clinicAdmissions = []
    if (!Array.isArray(db.clinicAppointments)) db.clinicAppointments = []
    if (!Array.isArray(db.clinicPharmacyDispenses)) db.clinicPharmacyDispenses = []
    if (!Array.isArray(db.clinicPharmacyItems)) db.clinicPharmacyItems = []
    if (!Array.isArray(db.clinicPharmacyReceipts)) db.clinicPharmacyReceipts = []
    if (!Array.isArray(db.clinicStockMovements)) db.clinicStockMovements = []
    if (!Array.isArray(db.clinicSuppliers)) db.clinicSuppliers = []
    if (!Array.isArray(db.clinicLabRequests)) db.clinicLabRequests = []
    if (!Array.isArray(db.clinicPrescriptions)) db.clinicPrescriptions = []
    if (!Array.isArray(db.clinicNurseDesk)) db.clinicNurseDesk = []
    if (!Array.isArray(db.clinicDoctorQueue)) db.clinicDoctorQueue = []
    if (!Array.isArray(db.clinicPairCodes)) db.clinicPairCodes = []
    if (!Array.isArray(db.clinicChangeLog)) db.clinicChangeLog = []
    if (!Array.isArray(db.clinicLabOrders)) db.clinicLabOrders = []
    return db
}

function updateCache(db) {
  cachedDb = db
  try {
    const st = fs.statSync(DB_FILE)
    cachedMtimeMs = st.mtimeMs
    cachedSize = st.size
  } catch {
    cachedMtimeMs = 0
    cachedSize = -1
  }
}

function readDB() {
  initDB()
  let stat = null
  try {
    stat = fs.statSync(DB_FILE)
    if (cachedDb && cachedMtimeMs === stat.mtimeMs && cachedSize === stat.size) {
      return cachedDb
    }
  } catch {}

  const data = fs.readFileSync(DB_FILE, 'utf-8') || '{}'
  try {
    const db = normalizeDB(JSON.parse(data))
    cachedDb = db
    cachedMtimeMs = stat?.mtimeMs || 0
    cachedSize = stat?.size ?? -1
    return db
  } catch (e) {
    // If db.json was corrupted, preserve the bad file as a timestamped backup,
    // then start a clean DB so production stays online without silent data loss.
    backupCorruptedDB(data, e?.message || e)
    const initialData = buildInitialDB()
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    updateCache(initialData)
    return initialData
  }
}

let writeQueue = Promise.resolve()

function writeDB(data) {
  const safeData = data || buildInitialDB()

  writeQueue = writeQueue.then(async () => {
    const dir = path.dirname(DB_FILE)
    const tmp = path.join(
      dir,
      `.${path.basename(DB_FILE)}.${process.pid}.${Date.now()}.tmp`
    )

    const payload = JSON.stringify(safeData, null, 2)

    try {
      fs.writeFileSync(tmp, payload, 'utf-8')
      fs.renameSync(tmp, DB_FILE)
      updateCache(safeData)
    } catch (e) {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
      } catch {}

      console.error('[db] writeDB failed:', e?.stack || e)
      throw e
    }
  }).catch((err) => {
    console.error('[db] queued write failure:', err?.stack || err)
  })

  return writeQueue
}

export { readDB, writeDB }
