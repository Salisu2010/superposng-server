import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { publish } from "../tg_events.js";

const r = Router();

// All routes here require SuperPOSNG JWT (Owner/Admin). Devices can use enrollToken + deviceKey later.
r.use(authMiddleware);

function isAdminOrOwner(req){
  const role = (req?.auth?.role || "").toLowerCase();
  return role === "admin" || role === "owner";
}
function requireAdmin(req, res, next){
  if (!isAdminOrOwner(req)) return res.status(403).json({ ok:false, error:"forbidden" });
  next();
}

function trim(v){ return (v===null||v===undefined) ? "" : String(v).trim(); }
function now(){ return Date.now(); }
function newId(){ return crypto.randomBytes(16).toString("hex"); }
function code6(){ return String(Math.floor(100000 + Math.random()*900000)); }
function token32(){ return crypto.randomBytes(16).toString("hex"); }

function ensureCollections(db){
  if (!Array.isArray(db.tgOrgs)) db.tgOrgs = [];
  if (!Array.isArray(db.tgDevices)) db.tgDevices = [];
  if (!Array.isArray(db.tgEnrollTokens)) db.tgEnrollTokens = [];
  if (!Array.isArray(db.tgCommands)) db.tgCommands = [];
  if (!Array.isArray(db.tgLocations)) db.tgLocations = [];
  if (!Array.isArray(db.tgHeartbeats)) db.tgHeartbeats = [];
}

function upsertDevice(db, patch){
  const deviceId = trim(patch.deviceId);
  if (!deviceId) return null;
  let d = db.tgDevices.find(x => trim(x.deviceId) === deviceId);
  if (!d){
    d = { deviceId, paired:false, deviceKey:"", pairedAt:0, lastSeen:0, online:false, model:"", brand:"", sdk:"", appVersion:"", note:"", orgCode:"", mode:"LITE" };
    db.tgDevices.push(d);
  }
  Object.assign(d, patch);
  return d;
}

function safeListDevices(db, orgCode){
  const list = db.tgDevices
    .filter(d => !orgCode || trim(d.orgCode) === orgCode)
    .sort((a,b)=> (b.lastSeen||0)-(a.lastSeen||0));
  return list;
}

// ---------- Registry: org + enrollment tokens ----------
r.post("/org", requireAdmin, (req,res)=>{
  const name = trim(req.body?.name);
  const orgCode = trim(req.body?.orgCode) || ("ORG-" + code6());
  if (!name) return res.status(400).json({ ok:false, error:"missing_name" });

  const db = readDB(); ensureCollections(db);
  const exists = db.tgOrgs.find(o=> trim(o.orgCode)===orgCode);
  if (exists) return res.status(409).json({ ok:false, error:"org_exists" });

  const row = { orgCode, name, createdAt: now(), createdBy: trim(req.auth?.sub || req.auth?.userId || req.auth?.email || "") };
  db.tgOrgs.push(row);
  writeDB(db);
  return res.json({ ok:true, org: row });
});

r.post("/enroll/token", requireAdmin, (req,res)=>{
  const orgCode = trim(req.body?.orgCode);
  if (!orgCode) return res.status(400).json({ ok:false, error:"missing_orgCode" });

  const db = readDB(); ensureCollections(db);
  const org = db.tgOrgs.find(o=> trim(o.orgCode)===orgCode);
  if (!org) return res.status(404).json({ ok:false, error:"org_not_found" });

  const token = token32();
  const ttlMin = Number(req.body?.ttlMin || 60);
  const expAt = now() + Math.max(5, ttlMin) * 60 * 1000;

  const row = { token, orgCode, createdAt: now(), expAt, used:false, usedAt:0, usedByDevice:"" };
  db.tgEnrollTokens.push(row);
  writeDB(db);
  return res.json({ ok:true, orgCode, token, expAt });
});

r.get("/org/:orgCode/devices", requireAdmin, (req,res)=>{
  const orgCode = trim(req.params.orgCode);
  const db = readDB(); ensureCollections(db);
  const list = safeListDevices(db, orgCode);
  return res.json({ ok:true, orgCode, devices: list });
});

// ---------- Device enrollment + heartbeat ----------
r.post("/device/register", requireAdmin, (req,res)=>{
  const deviceId = trim(req.body?.deviceId);
  const orgCode = trim(req.body?.orgCode);
  const enrollToken = trim(req.body?.enrollToken);

  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!orgCode) return res.status(400).json({ ok:false, error:"missing_orgCode" });
  if (!enrollToken) return res.status(400).json({ ok:false, error:"missing_enrollToken" });

  const db = readDB(); ensureCollections(db);

  const tok = db.tgEnrollTokens.find(t=> t.token===enrollToken);
  if (!tok) return res.status(401).json({ ok:false, error:"invalid_enrollToken" });
  if (tok.used) return res.status(401).json({ ok:false, error:"enrollToken_used" });
  if (now() > (tok.expAt||0)) return res.status(401).json({ ok:false, error:"enrollToken_expired" });
  if (trim(tok.orgCode)!==orgCode) return res.status(401).json({ ok:false, error:"enrollToken_org_mismatch" });

  // mark used
  tok.used = true;
  tok.usedAt = now();
  tok.usedByDevice = deviceId;

  const deviceKey = token32(); // used by device auth later
  const d = upsertDevice(db, {
    deviceId,
    orgCode,
    deviceKey,
    paired:true,
    pairedAt: now(),
    model: trim(req.body?.model),
    brand: trim(req.body?.brand),
    sdk: trim(req.body?.sdk),
    appVersion: trim(req.body?.appVersion),
    mode: trim(req.body?.mode || "ENTERPRISE").toUpperCase(),
    lastSeen: now(),
    online: true
  });

  db.tgHeartbeats.push({ id:newId(), deviceId, orgCode, at: now(), type:"register" });
  writeDB(db);

  publish("heartbeat", { deviceId, orgCode, lastSeen: d.lastSeen, online: true, mode: d.mode || "" });

  return res.json({ ok:true, deviceId, orgCode, deviceKey });
});

r.post("/device/heartbeat", requireAdmin, (req,res)=>{
  const deviceId = trim(req.body?.deviceId);
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });

  const db = readDB(); ensureCollections(db);
  const d = upsertDevice(db, {
    deviceId,
    lastSeen: now(),
    online: true,
    mode: trim(req.body?.mode || "").toUpperCase() || undefined
  });

  // Optional location
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (Number.isFinite(lat) && Number.isFinite(lon)){
    db.tgLocations.push({ id:newId(), deviceId, at: now(), lat, lon, acc: Number(req.body?.acc||0), provider: trim(req.body?.provider||"") });
    // keep last 1000
    if (db.tgLocations.length > 1000) db.tgLocations.splice(0, db.tgLocations.length-1000);
  }

  db.tgHeartbeats.push({ id:newId(), deviceId, orgCode: trim(d?.orgCode||""), at: now(), type:"heartbeat" });
  if (db.tgHeartbeats.length > 2000) db.tgHeartbeats.splice(0, db.tgHeartbeats.length-2000);

  writeDB(db);
  return res.json({ ok:true, deviceId, lastSeen: d?.lastSeen || now() });
});

// ---------- Dashboard legacy endpoints (from TrackGuard Dash) ----------
r.get("/devices", requireAdmin, (req,res)=>{
  const db = readDB(); ensureCollections(db);
  return res.json({ ok:true, devices: safeListDevices(db, "") });
});

r.post("/pair/generate", requireAdmin, (req,res)=>{
  const db = readDB(); ensureCollections(db);
  const pairCode = code6();
  const expAt = now() + 10*60*1000; // 10 minutes
  if (!Array.isArray(db.tgPairCodes)) db.tgPairCodes = [];
  db.tgPairCodes.push({ pairCode, expAt, createdAt: now(), used:false, deviceId:"" });
  // trim
  db.tgPairCodes = db.tgPairCodes.filter(x => (x.expAt||0) > now());
  writeDB(db);
  publish("pair_code", { code: pairCode, expiresAt: expAt });
  return res.json({ ok:true, pairCode, expAt });
});

r.post("/command/send", requireAdmin, (req,res)=>{
  const deviceId = trim(req.body?.deviceId);
  const type = trim(req.body?.type).toUpperCase();
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!type) return res.status(400).json({ ok:false, error:"missing_type" });

  const db = readDB(); ensureCollections(db);
  const d = db.tgDevices.find(x => trim(x.deviceId)===deviceId);
  if (!d) return res.status(404).json({ ok:false, error:"device_not_found" });

  const cmd = {
    id: newId(),
    deviceId,
    type,
    status:"queued",
    createdAt: now(),
    ackAt: 0,
    doneAt: 0,
    resultOk: false,
    resultError: "",
    payload: req.body?.payload || {}
  };
  db.tgCommands.push(cmd);
  if (db.tgCommands.length > 2000) db.tgCommands.splice(0, db.tgCommands.length-2000);
  writeDB(db);
  publish("command_queued", { deviceId, commandId: cmd.id, type });
  return res.json({ ok:true, commandId: cmd.id, deviceId, type });
});

export default r;
