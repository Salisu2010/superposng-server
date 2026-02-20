import { Router } from "express";
import crypto from "crypto";
import { readDB, writeDB } from "../db.js";
import { authMiddleware } from "../middleware/auth.js";
import { publish } from "../tg_events.js";

const r = Router();

function trim(v){ return (v===null||v===undefined) ? "" : String(v).trim(); }
function now(){ return Date.now(); }
function newId(){ return crypto.randomBytes(16).toString("hex"); }
function code6(){ return String(Math.floor(100000 + Math.random()*900000)); }
function token32(){ return crypto.randomBytes(16).toString("hex"); }

function ensureCollections(db){
  if (!Array.isArray(db.tgOrgs)) db.tgOrgs = [];
  if (!Array.isArray(db.tgDevices)) db.tgDevices = [];
  if (!Array.isArray(db.tgEnrollTokens)) db.tgEnrollTokens = [];
  if (!Array.isArray(db.tgPairCodes)) db.tgPairCodes = [];
  if (!Array.isArray(db.tgCommands)) db.tgCommands = [];
  if (!Array.isArray(db.tgLocations)) db.tgLocations = [];
  if (!Array.isArray(db.tgIntruders)) db.tgIntruders = [];
  if (!db.tgSeq) db.tgSeq = { lastCmdId: 0 };
}

function isAdminOrOwner(req){
  const role = trim(req?.auth?.role || "");
  return role === "admin" || role === "owner";
}

function safeListDevices(db, orgCode){
  const list = db.tgDevices.filter(d=> trim(d.orgCode) === trim(orgCode));
  return list.map(d=>({
    id: d.id,
    orgCode: d.orgCode,
    deviceId: d.deviceId,
    label: d.label || "",
    model: d.model || "",
    os: d.os || "",
    appVer: d.appVer || "",
    lastSeenAt: d.lastSeenAt || 0,
    isOnline: (now() - (d.lastSeenAt||0)) < 70_000,
    lastLocation: (d.lastLocation || null)
  }));
}

// ------------------- Admin auth (JWT OR API_KEY) -------------------

function requireAdminJWT(req, res, next){
  authMiddleware(req, res, ()=>{
    if (!isAdminOrOwner(req)) return res.status(403).json({ ok:false, error:"forbidden" });
    next();
  });
}

/**
 * Accepts either:
 *  - JWT (Authorization: Bearer ...)
 *  - API key (query ?key= or header x-api-key)
 */
function requireAdminAccess(req, res, next){
  const apiKey = trim(process.env.API_KEY || "");
  const keyQ = trim(req.query?.key || "");
  const keyH = trim(req.headers["x-api-key"] || req.headers["X-API-Key"] || "");
  const key = keyQ || keyH;

  if (apiKey && key && key === apiKey) {
    // Minimal auth object for audit/debug
    req.auth = { role: "admin", sub: "API_KEY" };
    return next();
  }
  return requireAdminJWT(req, res, next);
}

// ------------------- Device auth (x-device-key) -------------------

function requireDeviceKey(req, res, next){
  const deviceId = trim(req.body?.deviceId || req.query?.deviceId || "");
  const key = trim(req.headers["x-device-key"] || "");
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!key) return res.status(401).json({ ok:false, error:"missing_device_key" });

  const db = readDB(); ensureCollections(db);
  const d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) return res.status(404).json({ ok:false, error:"device_not_registered" });
  if (trim(d.deviceKey) !== key) return res.status(403).json({ ok:false, error:"invalid_device_key" });

  req.tgDevice = d;
  next();
}

// ------------------- Pairing (public confirm) -------------------

// Confirm pairing (device side) - does NOT require JWT, only pairCode
r.post("/pair/confirm", (req,res)=>{
  const pairCode = trim(req.body?.pairCode || req.body?.code || "");
  const deviceId = trim(req.body?.deviceId || "");
  const label = trim(req.body?.label || "");
  const model = trim(req.body?.model || "");
  const os = trim(req.body?.os || "");
  const appVer = trim(req.body?.appVer || "");

  if (!pairCode) return res.status(400).json({ ok:false, error:"missing_pairCode" });
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });

  const db = readDB(); ensureCollections(db);

  // Find valid pair code
  const pc = db.tgPairCodes.find(x=> x.code === pairCode && (x.expAt||0) > now());
  if (!pc) return res.status(404).json({ ok:false, error:"invalid_or_expired_pairCode" });

  // Ensure org exists
  const orgCode = trim(pc.orgCode || "");
  let org = db.tgOrgs.find(o=> trim(o.orgCode) === orgCode);
  if (!org) {
    org = { id:newId(), orgCode: orgCode || "ORG_"+code6(), name: pc.orgName || "Org", createdAt: now() };
    db.tgOrgs.push(org);
  }

  // Upsert device
  let d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) {
    d = {
      id: newId(),
      orgCode: org.orgCode,
      deviceId,
      deviceKey: token32(),
      label, model, os, appVer,
      createdAt: now(),
      lastSeenAt: 0,
      lastLocation: null
    };
    db.tgDevices.push(d);
  } else {
    d.orgCode = org.orgCode;
    d.label = label || d.label;
    d.model = model || d.model;
    d.os = os || d.os;
    d.appVer = appVer || d.appVer;
    if (!d.deviceKey) d.deviceKey = token32();
  }

  // Mark paircode as used (optional single-use)
  pc.usedAt = now();
  pc.usedBy = deviceId;

  writeDB(db);
  publish("device_paired", { orgCode: org.orgCode, deviceId });

  return res.json({
    ok:true,
    orgCode: org.orgCode,
    deviceId,
    deviceKey: d.deviceKey
  });
});

// ------------------- Device registry / enrollment -------------------

/**
 * Optional device register endpoint if you want to pre-register without pairing
 * (still returns deviceKey). Public, but you can protect it later if you want.
 */
r.post("/device/register", (req,res)=>{
  const orgCode = trim(req.body?.orgCode || "");
  const deviceId = trim(req.body?.deviceId || "");
  const label = trim(req.body?.label || "");
  const model = trim(req.body?.model || "");
  const os = trim(req.body?.os || "");
  const appVer = trim(req.body?.appVer || "");

  if (!orgCode) return res.status(400).json({ ok:false, error:"missing_orgCode" });
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });

  const db = readDB(); ensureCollections(db);

  let org = db.tgOrgs.find(o=> trim(o.orgCode) === orgCode);
  if (!org) {
    org = { id:newId(), orgCode, name: "Org", createdAt: now() };
    db.tgOrgs.push(org);
  }

  let d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) {
    d = {
      id: newId(),
      orgCode,
      deviceId,
      deviceKey: token32(),
      label, model, os, appVer,
      createdAt: now(),
      lastSeenAt: 0,
      lastLocation: null
    };
    db.tgDevices.push(d);
  } else {
    d.orgCode = orgCode;
    d.label = label || d.label;
    d.model = model || d.model;
    d.os = os || d.os;
    d.appVer = appVer || d.appVer;
    if (!d.deviceKey) d.deviceKey = token32();
  }

  writeDB(db);
  publish("device_registered", { orgCode, deviceId });

  return res.json({ ok:true, orgCode, deviceId, deviceKey: d.deviceKey });
});

// ------------------- Device runtime endpoints -------------------

r.post("/device/heartbeat", requireDeviceKey, (req,res)=>{
  const d = req.tgDevice;
  const db = readDB(); ensureCollections(db);

  const online = true;
  d.lastSeenAt = now();

  writeDB(db);
  publish("heartbeat", { deviceId: d.deviceId, orgCode: d.orgCode, online, at: d.lastSeenAt });

  return res.json({ ok:true, at: d.lastSeenAt });
});

r.post("/location/push", requireDeviceKey, (req,res)=>{
  const d = req.tgDevice;
  const lat = Number(req.body?.lat);
  const lng = Number(req.body?.lng ?? req.body?.lon);
  const accuracy = Number(req.body?.accuracy || 0);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ ok:false, error:"invalid_lat_lng" });
  }

  const db = readDB(); ensureCollections(db);
  const row = { id:newId(), deviceId: d.deviceId, orgCode: d.orgCode, lat, lng, accuracy, at: now() };
  db.tgLocations.push(row);

  // keep last 50k
  if (db.tgLocations.length > 50000) db.tgLocations = db.tgLocations.slice(db.tgLocations.length-50000);

  d.lastLocation = { lat, lng, accuracy, at: row.at };
  d.lastSeenAt = row.at;

  writeDB(db);
  publish("location", { deviceId:d.deviceId, orgCode:d.orgCode, lat, lng, accuracy, at: row.at });

  return res.json({ ok:true });
});

// Device polls for next command
r.get("/command/poll", (req,res)=>{
  const deviceId = trim(req.query?.deviceId || "");
  const key = trim(req.headers["x-device-key"] || "");
  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!key) return res.status(401).json({ ok:false, error:"missing_device_key" });

  const db = readDB(); ensureCollections(db);
  const d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) return res.status(404).json({ ok:false, error:"device_not_registered" });
  if (trim(d.deviceKey) !== key) return res.status(403).json({ ok:false, error:"invalid_device_key" });

  const cmd = db.tgCommands.find(c=> c.deviceId === deviceId && c.status === "queued");
  if (!cmd) return res.json({ ok:true, command:null });

  cmd.status = "sent";
  cmd.sentAt = now();
  writeDB(db);

  publish("command_sent", { deviceId, id:cmd.id, type:cmd.type });
  return res.json({ ok:true, command: cmd });
});

// Device posts command result
r.post("/command/result", (req,res)=>{
  const deviceId = trim(req.body?.deviceId || "");
  const key = trim(req.headers["x-device-key"] || "");
  const id = trim(req.body?.id || "");
  const status = trim(req.body?.status || "done"); // done/failed
  const result = req.body?.result ?? null;

  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!key) return res.status(401).json({ ok:false, error:"missing_device_key" });
  if (!id) return res.status(400).json({ ok:false, error:"missing_command_id" });

  const db = readDB(); ensureCollections(db);
  const d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) return res.status(404).json({ ok:false, error:"device_not_registered" });
  if (trim(d.deviceKey) !== key) return res.status(403).json({ ok:false, error:"invalid_device_key" });

  const cmd = db.tgCommands.find(c=> c.id === id && c.deviceId === deviceId);
  if (!cmd) return res.status(404).json({ ok:false, error:"command_not_found" });

  cmd.status = (status === "failed") ? "failed" : "done";
  cmd.result = result;
  cmd.doneAt = now();
  writeDB(db);

  publish("command_result", { deviceId, id:cmd.id, status:cmd.status });
  return res.json({ ok:true });
});

// ------------------- Admin endpoints (JWT or API_KEY) -------------------

r.post("/org", requireAdminAccess, (req,res)=>{
  const name = trim(req.body?.name || "Org");
  const orgCode = trim(req.body?.orgCode || ("ORG_"+code6()));
  const db = readDB(); ensureCollections(db);

  if (db.tgOrgs.some(o=> trim(o.orgCode) === orgCode)) {
    return res.status(409).json({ ok:false, error:"org_exists" });
  }

  const org = { id:newId(), orgCode, name, createdAt: now() };
  db.tgOrgs.push(org);
  writeDB(db);

  return res.json({ ok:true, org });
});

r.post("/enroll/token", requireAdminAccess, (req,res)=>{
  const orgCode = trim(req.body?.orgCode || "");
  const qty = Math.max(1, Math.min(500, Number(req.body?.qty || 1)));
  const ttlMin = Math.max(5, Math.min(60*24*30, Number(req.body?.ttlMin || 60*24))); // default 24h

  if (!orgCode) return res.status(400).json({ ok:false, error:"missing_orgCode" });

  const db = readDB(); ensureCollections(db);
  if (!db.tgOrgs.some(o=> trim(o.orgCode) === orgCode)) {
    return res.status(404).json({ ok:false, error:"org_not_found" });
  }

  const expAt = now() + ttlMin*60*1000;
  const tokens = [];
  for (let i=0;i<qty;i++){
    const token = token32();
    db.tgEnrollTokens.push({ id:newId(), orgCode, token, expAt, createdAt: now(), usedAt: 0, usedBy:"" });
    tokens.push(token);
  }
  writeDB(db);
  return res.json({ ok:true, orgCode, expAt, tokens });
});

r.get("/org/:orgCode/devices", requireAdminAccess, (req,res)=>{
  const orgCode = trim(req.params.orgCode);
  const db = readDB(); ensureCollections(db);
  return res.json({ ok:true, devices: safeListDevices(db, orgCode) });
});

r.get("/devices", requireAdminAccess, (req,res)=>{
  const db = readDB(); ensureCollections(db);
  const orgCode = trim(req.query?.orgCode || "");
  const devices = orgCode ? safeListDevices(db, orgCode) : db.tgDevices.map(d=>({
    id: d.id,
    orgCode: d.orgCode,
    deviceId: d.deviceId,
    label: d.label || "",
    model: d.model || "",
    os: d.os || "",
    appVer: d.appVer || "",
    lastSeenAt: d.lastSeenAt || 0,
    isOnline: (now() - (d.lastSeenAt||0)) < 70_000,
    lastLocation: (d.lastLocation || null)
  }));
  return res.json({ ok:true, devices });
});

r.post("/pair/generate", requireAdminAccess, (req,res)=>{
  const db = readDB(); ensureCollections(db);
  const pairCode = code6();
  const expAt = now() + 10*60*1000; // 10 min
  const orgCode = trim(req.body?.orgCode || req.query?.orgCode || "");
  const orgName = trim(req.body?.orgName || "");

  db.tgPairCodes.push({ id:newId(), code:pairCode, orgCode, orgName, expAt, createdAt: now(), usedAt: 0, usedBy:"" });
  // keep last 5k
  if (db.tgPairCodes.length > 5000) db.tgPairCodes = db.tgPairCodes.slice(db.tgPairCodes.length-5000);

  writeDB(db);
  publish("pair_code", { orgCode, code:pairCode, expAt });

  return res.json({ ok:true, pairCode, expAt });
});

r.post("/command/send", requireAdminAccess, (req,res)=>{
  const deviceId = trim(req.body?.deviceId || "");
  const type = trim(req.body?.type || "");
  const payload = req.body?.payload ?? null;

  if (!deviceId) return res.status(400).json({ ok:false, error:"missing_deviceId" });
  if (!type) return res.status(400).json({ ok:false, error:"missing_type" });

  const db = readDB(); ensureCollections(db);
  const d = db.tgDevices.find(x=> trim(x.deviceId) === deviceId);
  if (!d) return res.status(404).json({ ok:false, error:"device_not_found" });

  const cmd = {
    id: String(++db.tgSeq.lastCmdId),
    deviceId,
    orgCode: d.orgCode,
    type,
    payload,
    status: "queued",
    createdAt: now(),
    sentAt: 0,
    doneAt: 0,
    result: null
  };

  db.tgCommands.push(cmd);
  // keep last 50k
  if (db.tgCommands.length > 50000) db.tgCommands = db.tgCommands.slice(db.tgCommands.length-50000);

  writeDB(db);
  publish("command_queued", { deviceId, id:cmd.id, type });

  return res.json({ ok:true, command: cmd });
});

// Location trail (admin)
r.get("/location/trail", requireAdminAccess, (req,res)=>{
  const deviceId = trim(req.query?.deviceId || "");
  const limit = Math.max(1, Math.min(5000, Number(req.query?.limit || 500)));

  const db = readDB(); ensureCollections(db);

  const list = db.tgLocations
    .filter(x=> !deviceId || x.deviceId === deviceId)
    .sort((a,b)=> (b.at||0) - (a.at||0))
    .slice(0, limit);

  return res.json({ ok:true, items:list });
});

// Backward compat
r.get("/api/location/trail", requireAdminAccess, (req,res)=>{
  req.url = req.url.replace("/api/location/trail", "/location/trail");
  return r.handle(req, res);
});

// Commands list (admin)
function handleCommandsList(req, res){
  const deviceId = trim(req.query?.deviceId || "");
  const limit = Math.max(1, Math.min(5000, Number(req.query?.limit || 500)));
  const db = readDB(); ensureCollections(db);

  const list = db.tgCommands
    .filter(x=> !deviceId || x.deviceId === deviceId)
    .sort((a,b)=> (b.createdAt||0) - (a.createdAt||0))
    .slice(0, limit);
  return res.json({ ok:true, items:list });
}
r.get("/commands", requireAdminAccess, handleCommandsList);
r.get("/api/commands", requireAdminAccess, handleCommandsList);

// Intruder list (admin) - optional; returns empty if none
function handleIntruderList(req, res){
  const db = readDB(); ensureCollections(db);
  const deviceId = trim(req.query?.deviceId || "");
  const limit = Math.max(1, Math.min(2000, Number(req.query?.limit || 100)));

  const list = db.tgIntruders
    .filter(x=> !deviceId || x.deviceId === deviceId)
    .sort((a,b)=> (b.at||0) - (a.at||0))
    .slice(0, limit);

  return res.json({ ok:true, items:list });
}
r.get("/intruder/list", requireAdminAccess, handleIntruderList);
r.get("/api/intruder/list", requireAdminAccess, handleIntruderList);

// Device pushes intruder record (optional)
r.post("/intruder/push", requireDeviceKey, (req,res)=>{
  const d = req.tgDevice;
  const kind = trim(req.body?.kind || "unknown");
  const imageDataUrl = trim(req.body?.imageDataUrl || ""); // can be data: or empty
  const meta = req.body?.meta ?? null;

  const db = readDB(); ensureCollections(db);

  const item = {
    id: newId(),
    orgCode: d.orgCode,
    deviceId: d.deviceId,
    kind,
    imageDataUrl,
    meta,
    at: now()
  };
  db.tgIntruders.push(item);
  // keep last 2000
  if (db.tgIntruders.length > 2000) db.tgIntruders = db.tgIntruders.slice(db.tgIntruders.length-2000);
  writeDB(db);

  publish("intruder", { deviceId, id:item.id, kind });
  return res.json({ ok:true, id:item.id });
});

export default r;