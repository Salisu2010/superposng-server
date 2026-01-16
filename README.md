# SuperPOSNG Cloud Sync (Online Pairing) - Local Dev Server

Wannan server din yana ba SuperPOSNG damar:
- **Generate Pairing Code** (Admin)
- **Pair Device** (Cashier) ta amfani da internet (DATA)
- **Basic Sync Endpoints** (products/staffs/sales/debtors)

## Requirements
- Node.js 18+ (recommended)
- Internet (optional) - amma local test zai yi a LAN/localhost

## Run (Local)
```bash
# NOTE: idan wannan zip din shi ne server folder kai tsaye, ka yi "cd" zuwa root din.
# Idan kuma kana da babban project da yake da folder "server", sai ka shiga can.
# Misali:
# cd server
npm install
npm run dev
```

Server zai tashi a:
- http://localhost:8080

## Local Hub Web Dashboard

Da zarar server ya tashi, ka bude dashboard a browser:

- `http://<HUB_IP>:8080/dashboard/`

Dashboard din zai nuna:
- Overview
- Sales
- Products
- Debtors
- Staff Performance

## ENV (.env)
Ka create `.env` (a root din server) ko `server/.env` idan kana amfani da folder "server":
```
PORT=8080
JWT_SECRET=superposng_change_me
PAIRING_EXPIRE_MIN=10
```

## Important
Wannan version din yana amfani da **JSON database** (`db.json` ko `server/db.json`) domin easy local testing.
A production, za mu mayar da shi **PostgreSQL** (Render/Railway) ba tare da canza Android logic sosai ba.
