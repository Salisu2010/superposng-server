import crypto from "crypto";

const MAX_EVENTS = 1500;
let events = []; // {id:number, type:string, payload:object, at:number}
let nextId = 1;

function now(){ return Date.now(); }

function safeWriteSse(res, chunk){
  try {
    if (!res || res.destroyed || res.writableEnded) return false;
    res.write(chunk);
    return true;
  } catch { return false; }
}

export function publish(type, payload = {}) {
  const evt = { id: nextId++, type, payload, at: now() };
  events.push(evt);
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  return evt;
}

export function getSince(lastId = 0) {
  const lid = Number(lastId) || 0;
  return events.filter(e => e.id > lid);
}

// SSE helpers
export function sseHeaders(res){
  try {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx
    res.flushHeaders?.();
    return true;
  } catch (e) {
    try { console.error('[tg-sse] header error', e?.message || e); } catch {}
    return false;
  }
}

export function sendSse(res, eventName, dataObj){
  return safeWriteSse(res, `event: ${eventName}\ndata: ${JSON.stringify(dataObj)}\n\n`);
}
