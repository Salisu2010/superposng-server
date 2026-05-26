const clientsByClinic = new Map();

function now(){ return Date.now(); }

function safeWriteSse(res, chunk){
  try {
    if (!res || res.destroyed || res.writableEnded) return false;
    res.write(chunk);
    return true;
  } catch {
    return false;
  }
}

export function clinicSseHeaders(res){
  try {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    return true;
  } catch (e) {
    try { console.error('[clinic-sse] header error', e?.message || e); } catch {}
    return false;
  }
}

export function clinicSendSse(res, event, data){
  const chunk = `event: ${String(event || 'message')}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  return safeWriteSse(res, chunk);
}

export function clinicAddClient(clinicId, res){
  const key = String(clinicId || '').trim();
  if (!key) return;
  let set = clientsByClinic.get(key);
  if (!set) {
    set = new Set();
    clientsByClinic.set(key, set);
  }
  set.add(res);
  res.on('close', () => {
    try {
      const s = clientsByClinic.get(key);
      if (s) {
        s.delete(res);
        if (!s.size) clientsByClinic.delete(key);
      }
    } catch {}
  });
}

export function clinicPublish(clinicId, event, data){
  const key = String(clinicId || '').trim();
  if (!key) return { ok:false, sent:0 };
  const set = clientsByClinic.get(key);
  if (!set || !set.size) return { ok:true, sent:0 };
  let sent = 0;
  for (const res of Array.from(set)) {
    try {
      clinicSendSse(res, event, { ...data, at: data?.at ?? now() });
      sent++;
    } catch {
      try { set.delete(res); } catch {}
    }
  }
  if (!set.size) clientsByClinic.delete(key);
  return { ok:true, sent };
}
