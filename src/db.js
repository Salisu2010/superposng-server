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
      debtors: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
  }
}

function readDB() {
  initDB()
  const data = fs.readFileSync(DB_FILE, 'utf-8')
  try {
    return JSON.parse(data)
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
      debtors: []
    }
    fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2))
    return initialData
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2))
}

export { readDB, writeDB }
