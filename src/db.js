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


// Resolve canonical shopId using alias mappings (old -> canonical).
export function resolveShopId(db, shopId) {
  const seen = new Set();
  let cur = (shopId || '').toString();
  if (!cur) return cur;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const m = (db.shopAliases || []).find(a => a && a.from === cur);
    if (m && m.to && m.to !== cur) { cur = m.to; continue; }
    break;
  }
  return cur;
}

export function addShopAlias(db, from, to) {
  const f = (from||'').toString().trim();
  const t = (to||'').toString().trim();
  if (!f || !t || f === t) return false;
  if (!Array.isArray(db.shopAliases)) db.shopAliases = [];
  const now = Date.now();
  const ex = db.shopAliases.find(a => a.from === f);
  if (ex) { ex.to = t; ex.updatedAt = now; return true; }
  db.shopAliases.push({ from: f, to: t, createdAt: now, updatedAt: now });
  return true;
}
