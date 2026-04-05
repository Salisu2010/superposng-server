import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const bearer = h.startsWith("Bearer ") ? h.substring(7) : "";
  const queryToken = String(req.query?.token || req.headers['x-access-token'] || req.headers['x-auth-token'] || "").trim();
  const token = bearer || queryToken;
  if (!token) return res.status(401).json({ ok: false, error: "Missing token" });

  try {
    const secret = process.env.JWT_SECRET || "dev_secret_change_me";
    const decoded = jwt.verify(token, secret);
    req.auth = decoded;
    return next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}
