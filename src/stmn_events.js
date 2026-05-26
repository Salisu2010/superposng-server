/**
 * StayMasterNG realtime events (SSE) helper.
 * - Maintains per-shop SSE client list
 * - Allows routes to publish lightweight "changed" signals
 * Clients should do a delta pull after receiving a signal.
 */

const clientsByShop = new Map(); // shopId -> Set<res>

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

export function stmnSseHeaders(res){
  try {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no"); // nginx: disable buffering for SSE
    if (typeof res.flushHeaders === "function") res.flushHeaders();
    return true;
  } catch (e) {
    try { console.error('[stmn-sse] header error', e?.message || e); } catch {}
    return false;
  }
}

/** Write an SSE event to a single response stream. */
export function stmnSendSse(res, event, data){
  const payload = JSON.stringify(data ?? {});
  const chunk = `event: ${String(event || "message")}\ndata: ${payload}\n\n`;
  return safeWriteSse(res, chunk);
}

/** Add an SSE client for a shopId and auto-clean on close. */
export function stmnAddClient(shopId, res){
  const sid = String(shopId || "").trim();
  if (!sid) return;

  let set = clientsByShop.get(sid);
  if (!set){
    set = new Set();
    clientsByShop.set(sid, set);
  }
  set.add(res);

  // Cleanup on close
  res.on("close", () => {
    try{
      const s = clientsByShop.get(sid);
      if (s){
        s.delete(res);
        if (s.size === 0) clientsByShop.delete(sid);
      }
    }catch{}
  });
}

/**
 * Publish an event to all connected clients for the shop.
 * @param {string|number} shopId
 * @param {string} event
 * @param {object} data
 */
export function stmnPublish(shopId, event, data){
  const sid = String(shopId || "").trim();
  if (!sid) return { ok:false, sent:0 };

  const set = clientsByShop.get(sid);
  if (!set || set.size === 0) return { ok:true, sent:0 };

  let sent = 0;
  for (const res of Array.from(set)){
    try{
      stmnSendSse(res, event, { ...data, at: data?.at ?? now() });
      sent++;
    }catch(e){
      // drop broken stream
      try{ set.delete(res); }catch{}
    }
  }
  if (set.size === 0) clientsByShop.delete(sid);
  return { ok:true, sent };
}
