import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_FILE = process.env.DB_FILE || path.join(__dirname, '../db.json')

function initDB() {
  if (!fs.existsSync(DB_FILE)) {
    const initialData = {
      shops: [],
      devices: [],
      pairCodes: [],
      products: [],
      staffs: [],
      sales: [],
      debtors: [],
      debtorPayments: [],
      licenses: [],
      pendingActivations: [],
      rmpLicenses: [],
      rmpPendingActivations: [],
      owners: [],
      shopAliases: [],

      // Trial (server-backed) for SPNG + RMP
      trials: [],

      // TrackGuard Registry (Lite + Enterprise)
      tgOrgs: [],
      tgDevices: [],
      tgEnrollTokens: [],
      tgCommands: [],
      tgLocations: [],
      tgHeartbeats: [],
      tgPairCodes: [],

      // StayMasterNG FCM device tokens (background push notifications)
      stmnFcmTokens: [],
      // StayMasterNG internal messaging
      stmnChatMessages: [],
      stmnChatSeen: [],

      // Clinic Pro NG cloud
      clinics: [],
      clinicDevices: [],
      clinicUsers: [],
      clinicSnapshots: [],
      clinicBackups: [],
      clinicNotifications: [],
      clinicEvents: [],
      clinicBranches: [],
      clinicSyncCursor: [],
      clinicPatients: [],
      clinicBills: [],
      clinicVisits: [],
      clinicAdmissions: [],
      clinicAppointments: [],
      clinicPharmacyDispenses: [],
      clinicLabRequests: [],
      clinicPrescriptions: [],
      clinicNurseDesk: [],
      clinicDoctorQueue: [],
      clinicPharmacyItems: [],
      clinicVitals: [],
      clinicAuditLogs: [],
      clinicProfiles: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
  }
}

function readDB() {
  initDB()
  const data = fs.readFileSync(DB_FILE, 'utf-8')
  try {
    const db = JSON.parse(data)
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
    if (!Array.isArray(db.clinicLabRequests)) db.clinicLabRequests = []
    if (!Array.isArray(db.clinicPrescriptions)) db.clinicPrescriptions = []
    if (!Array.isArray(db.clinicNurseDesk)) db.clinicNurseDesk = []
    if (!Array.isArray(db.clinicDoctorQueue)) db.clinicDoctorQueue = []
    if (!Array.isArray(db.clinicPharmacyItems)) db.clinicPharmacyItems = []
    if (!Array.isArray(db.clinicVitals)) db.clinicVitals = []
    if (!Array.isArray(db.clinicAuditLogs)) db.clinicAuditLogs = []
    if (!Array.isArray(db.clinicProfiles)) db.clinicProfiles = []
    return db
  } catch (e) {
    // If db.json was corrupted or accidentally replaced with non-JSON content,
    // reset it to a clean initial structure so the server won't 500.
    const initialData = {
      shops: [],
      devices: [],
      pairCodes: [],
      products: [],
      staffs: [],
      sales: [],
      debtors: [],
      debtorPayments: [],
      licenses: [],
      pendingActivations: [],
      rmpLicenses: [],
      rmpPendingActivations: [],
      owners: [],
      shopAliases: [],

      // Trial (server-backed) for SPNG + RMP
      trials: [],

      // TrackGuard Registry (Lite + Enterprise)
      tgOrgs: [],
      tgDevices: [],
      tgEnrollTokens: [],
      tgCommands: [],
      tgLocations: [],
      tgHeartbeats: [],
      tgPairCodes: [],

      // StayMasterNG FCM device tokens (background push notifications)
      stmnFcmTokens: [],
      // StayMasterNG internal messaging
      stmnChatMessages: [],
      stmnChatSeen: [],

      // Clinic Pro NG cloud
      clinics: [],
      clinicDevices: [],
      clinicUsers: [],
      clinicSnapshots: [],
      clinicBackups: [],
      clinicNotifications: [],
      clinicEvents: [],
      clinicBranches: [],
      clinicSyncCursor: [],
      clinicPatients: [],
      clinicBills: [],
      clinicVisits: [],
      clinicAdmissions: [],
      clinicAppointments: [],
      clinicPharmacyDispenses: [],
      clinicLabRequests: [],
      clinicPrescriptions: [],
      clinicNurseDesk: [],
      clinicDoctorQueue: [],
      clinicPharmacyItems: [],
      clinicVitals: [],
      clinicAuditLogs: [],
      clinicProfiles: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    return initialData
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

export { readDB, writeDB }
