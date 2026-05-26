import { Router } from "express";
import { readDB, writeDB } from "../db.js";
import { pushStmnChatMessage } from "../fcm.js";

const r = Router();

function requireShop(req, res) {
  const raw = req.auth?.shopId ? String(req.auth.shopId) : "";
  if (!raw) { res.status(401).json({ ok:false, error:"Missing auth shopId" }); return null; }
  return raw;
}
const trim = (v) => (v ?? "").toString().trim();
const toInt = (v, d=0) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const nowTs = () => Date.now();

function normalizeRole(role) { return trim(role).toLowerCase().replace(/\s+/g, "_"); }
function conversationKey(branchId, channelType, a, bOrRole) {
  if (channelType === "role") return `role:${branchId}:${normalizeRole(bOrRole)}`;
  const a1 = toInt(a,0), b1 = toInt(bOrRole,0);
  const x = Math.min(a1,b1), y = Math.max(a1,b1);
  return `direct:${branchId}:${x}:${y}`;
}

r.post('/send', async (req, res) => {
  try {
    const shopId = requireShop(req, res); if (!shopId) return;
    const branchId = toInt(req.body?.branchId, 1) || 1;
    const senderStaffId = toInt(req.body?.senderStaffId, 0);
    const senderName = trim(req.body?.senderName);
    const senderRole = normalizeRole(req.body?.senderRole);
    const channelType = trim(req.body?.channelType || 'direct').toLowerCase() === 'role' ? 'role' : 'direct';
    const targetStaffId = toInt(req.body?.targetStaffId, 0);
    const targetRole = normalizeRole(req.body?.targetRole);
    const body = trim(req.body?.body);
    const deviceId = trim(req.body?.deviceId);
    if (!senderStaffId || !body) return res.status(400).json({ ok:false, error:'missing_sender_or_body' });
    if (channelType === 'direct' && !targetStaffId) return res.status(400).json({ ok:false, error:'missing_target_staff_id' });
    if (channelType === 'role' && !targetRole) return res.status(400).json({ ok:false, error:'missing_target_role' });

    const messageId = trim(req.body?.messageId) || `msg_${nowTs()}_${Math.random().toString(36).slice(2,8)}`;
    const createdAt = toInt(req.body?.createdAt, nowTs());
    const convKey = trim(req.body?.conversationKey) || conversationKey(branchId, channelType, senderStaffId, channelType === 'role' ? targetRole : targetStaffId);

    const db = readDB();
    db.stmnChatMessages = Array.isArray(db.stmnChatMessages) ? db.stmnChatMessages : [];
    const item = {
      shopId, branchId, messageId, conversationKey: convKey, channelType,
      senderStaffId, senderName, senderRole, targetStaffId, targetRole, body, createdAt, updatedAt: nowTs()
    };
    db.stmnChatMessages.push(item);
    writeDB(db);

    await pushStmnChatMessage(shopId, {
      type: 'stmn_chat', branchId: String(branchId), conversationKey: convKey, messageId, senderName, senderRole, body, channelType, targetStaffId: String(targetStaffId || ''), targetRole
    }, { branchId, excludeDeviceId: deviceId, targetRole: channelType === 'role' ? targetRole : '' });

    return res.json({ ok:true, message:item });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'server_error' });
  }
});

r.get('/pull', (req, res) => {
  try {
    const shopId = requireShop(req, res); if (!shopId) return;
    const since = toInt(req.query?.since, 0);
    const branchId = toInt(req.query?.branchId, 1) || 1;
    const staffId = toInt(req.query?.staffId, 0);
    const role = normalizeRole(req.query?.role);
    const db = readDB();
    db.stmnChatMessages = Array.isArray(db.stmnChatMessages) ? db.stmnChatMessages : [];
    const items = db.stmnChatMessages.filter((m) => String(m.shopId) === String(shopId) && toInt(m.branchId,1) === branchId && toInt(m.updatedAt || m.createdAt,0) > since && (m.channelType === 'role' ? normalizeRole(m.targetRole) === role : (toInt(m.senderStaffId,0) === staffId || toInt(m.targetStaffId,0) === staffId)));
    return res.json({ ok:true, messages: items.sort((a,b) => toInt(a.createdAt,0) - toInt(b.createdAt,0)), serverTime: nowTs() });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'server_error' });
  }
});

r.get('/conversations', (req, res) => {
  try {
    const shopId = requireShop(req, res); if (!shopId) return;
    const branchId = toInt(req.query?.branchId, 1) || 1;
    const staffId = toInt(req.query?.staffId, 0);
    const role = normalizeRole(req.query?.role);
    const db = readDB();
    db.stmnChatMessages = Array.isArray(db.stmnChatMessages) ? db.stmnChatMessages : [];
    const list = db.stmnChatMessages.filter((m) => String(m.shopId) === String(shopId) && toInt(m.branchId,1) === branchId && (m.channelType === 'role' ? normalizeRole(m.targetRole) === role : (toInt(m.senderStaffId,0) === staffId || toInt(m.targetStaffId,0) === staffId)));
    const map = new Map();
    for (const m of list) {
      const prev = map.get(m.conversationKey);
      if (!prev || toInt(m.createdAt,0) >= toInt(prev.createdAt,0)) map.set(m.conversationKey, m);
    }
    const conversations = Array.from(map.values()).sort((a,b) => toInt(b.createdAt,0)-toInt(a.createdAt,0));
    return res.json({ ok:true, conversations });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'server_error' });
  }
});

r.post('/seen', (req, res) => {
  try {
    const shopId = requireShop(req, res); if (!shopId) return;
    const conversationKey = trim(req.body?.conversationKey);
    const staffId = toInt(req.body?.staffId, 0);
    if (!conversationKey || !staffId) return res.status(400).json({ ok:false, error:'missing_fields' });
    const db = readDB();
    db.stmnChatSeen = Array.isArray(db.stmnChatSeen) ? db.stmnChatSeen : [];
    db.stmnChatSeen.push({ shopId, conversationKey, staffId, seenAt: nowTs() });
    writeDB(db);
    return res.json({ ok:true });
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'server_error' });
  }
});

r.post('/broadcast', async (req, res) => {
  try {
    const shopId = requireShop(req, res); if (!shopId) return;
    const branchId = toInt(req.body?.branchId, 1) || 1;
    const senderStaffId = toInt(req.body?.senderStaffId, 0);
    const senderName = trim(req.body?.senderName || 'Admin');
    const senderRole = normalizeRole(req.body?.senderRole || 'admin');
    const body = trim(req.body?.body);
    const targetRole = normalizeRole(req.body?.targetRole);
    if (!body || !targetRole) return res.status(400).json({ ok:false, error:'missing_fields' });
    req.body.channelType = 'role';
    req.body.targetRole = targetRole;
    req.body.senderStaffId = senderStaffId;
    req.body.senderName = senderName;
    req.body.senderRole = senderRole;
    return r.handle({ ...req, method:'POST', url:'/send' }, res);
  } catch (e) {
    return res.status(500).json({ ok:false, error:e?.message || 'server_error' });
  }
});

export default r;
