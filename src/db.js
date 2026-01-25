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
      owners: [],
      shopAliases: []
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
    if (!Array.isArray(db.owners)) db.owners = []
    if (!Array.isArray(db.shopAliases)) db.shopAliases = []
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
      owners: [],
      shopAliases: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    return initialData
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

export { readDB, writeDB }
