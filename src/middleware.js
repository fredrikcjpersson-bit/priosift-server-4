'use strict';

function requireAuth(req, res, next) {
  if (!req.session?.user) return res.status(401).json({ error: 'Ej inloggad' });
  next();
}

function requireOwner(req, res, next) {
  if (req.session?.user?.role !== 'owner')
    return res.status(403).json({ error: 'Endast administratör kan ändra detta' });
  next();
}

module.exports = { requireAuth, requireOwner };
