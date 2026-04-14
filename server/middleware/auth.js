'use strict';

/**
 * middleware/auth.js
 *
 * Lightweight API secret authentication.
 * This app is personal and runs on a private network (Tailscale),
 * so a single shared secret is appropriate.
 *
 * The iOS app and any client sends:
 *   Authorization: Bearer <API_SECRET>
 */

function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing Authorization header' });
  }

  const token = authHeader.slice(7).trim();

  if (token !== process.env.API_SECRET) {
    return res.status(403).json({ error: 'Invalid API secret' });
  }

  next();
}

module.exports = { requireAuth };
