import crypto from 'crypto';

function shortId() {
  try {
    return crypto.randomUUID().slice(0, 12);
  } catch {
    return Math.random().toString(36).slice(2, 14);
  }
}

export function requestRuntime(req, res, next) {
  const startedAt = Date.now();
  const requestId = String(req.headers['x-request-id'] || shortId());
  req.requestId = requestId;
  res.setHeader('x-request-id', requestId);

  const origJson = res.json.bind(res);
  const origSend = res.send.bind(res);
  const origEnd = res.end.bind(res);

  const guard = (methodName, fn) => (...args) => {
    if (res.writableEnded || res.headersSent) {
      console.error(`[DOUBLE_RESPONSE_BLOCKED] ${methodName} ${req.method} ${req.originalUrl} requestId=${requestId}`);
      return res;
    }
    return fn(...args);
  };

  res.json = guard('json', origJson);
  res.send = guard('send', origSend);
  res.end = guard('end', origEnd);

  res.safeJson = (statusCode, payload) => {
    if (!res.headersSent && !res.writableEnded) res.status(statusCode);
    return res.json(payload);
  };

  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    const line = `[REQ_${level.toUpperCase()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms requestId=${requestId}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  });

  next();
}

export function notFoundHandler(req, res, _next) {
  return res.status(404).json({
    ok: false,
    error: 'not_found',
    message: 'Route not found',
    path: req.originalUrl,
    requestId: req.requestId || ''
  });
}

export function errorHandler(err, req, res, _next) {
  console.error(`[UNHANDLED_ROUTE_ERROR] ${req.method} ${req.originalUrl} requestId=${req.requestId || ''}`, err);
  if (res.headersSent || res.writableEnded) return;
  return res.status(500).json({
    ok: false,
    error: 'internal_server_error',
    message: err?.message || 'Internal server error',
    requestId: req.requestId || ''
  });
}

export function bindProcessGuards() {
  process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT_EXCEPTION]', err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error('[UNHANDLED_REJECTION]', reason);
  });
}
