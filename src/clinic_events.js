const clientsByClinic = new Map();

function now(){ return Date.now(); }

export function clinicSseHeaders(res){
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function clinicSendSse(res, event, data){
  res.write(`event: ${String(event || 'message')}\n`);
  res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
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
