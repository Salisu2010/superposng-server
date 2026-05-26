import jwt from "jsonwebtoken";

export function authMiddleware(req, res, next) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.substring(7) : "";
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
