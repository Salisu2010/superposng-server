import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const DB_FILE = path.join(__dirname, '../db.json')

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
      licenses: [],
      pendingActivations: [],
      owners: []
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
    // Licensing / activation tables
    if (!Array.isArray(db.licenses)) db.licenses = []
    if (!Array.isArray(db.pendingActivations)) db.pendingActivations = []
    if (!Array.isArray(db.owners)) db.owners = []
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
      licenses: [],
      pendingActivations: [],
      owners: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    return initialData
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

export { readDB, writeDB }
