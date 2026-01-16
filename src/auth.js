import jwt from 'jsonwebtoken'

export function signToken(payload, secret, expiresIn = '30d') {
  return jwt.sign(payload, secret, { expiresIn })
}

export function requireAuth(req, res, next) {
  const h = req.headers.authorization || ''
  const token = h.startsWith('Bearer ') ? h.substring(7) : ''
  if (!token) return res.status(401).json({ ok: false, error: 'Missing token' })

  try {
    const secret = process.env.JWT_SECRET || 'dev_secret'
    req.user = jwt.verify(token, secret)
    return next()
  } catch (e) {
    return res.status(401).json({ ok: false, error: 'Invalid token' })
  }
}
