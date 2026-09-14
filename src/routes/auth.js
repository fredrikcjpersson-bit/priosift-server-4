'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { q }   = require('../db');
const { requireAuth } = require('../middleware');

const router = express.Router();

/* POST /api/login */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password)
      return res.status(400).json({ error: 'Användarnamn och lösenord krävs' });

    const r = await q('SELECT * FROM users WHERE username=$1', [username.toLowerCase().trim()]);
    if (!r.rows.length)
      return res.status(401).json({ error: 'Felaktigt användarnamn eller lösenord' });

    const user = r.rows[0];
    const ok   = await bcrypt.compare(password, user.password_hash);
    if (!ok)
      return res.status(401).json({ error: 'Felaktigt användarnamn eller lösenord' });

    req.session.user = { username: user.username, name: user.name, role: user.role };
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Session-fel' });
      res.json(req.session.user);
    });
  } catch (e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* POST /api/logout */
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

/* GET /api/me */
router.get('/me', requireAuth, (req, res) => {
  res.json(req.session.user);
});

/* PUT /api/password */
router.put('/password', requireAuth, async (req, res) => {
  try {
    const { current, next: next_ } = req.body || {};
    if (!current || !next_)
      return res.status(400).json({ error: 'Ange nuvarande och nytt lösenord' });
    if (next_.length < 8)
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });

    const { username } = req.session.user;
    const r = await q('SELECT password_hash FROM users WHERE username=$1', [username]);
    if (!r.rows.length) return res.status(404).json({ error: 'Användare saknas' });

    const ok = await bcrypt.compare(current, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Nuvarande lösenord är fel' });

    const hash = await bcrypt.hash(next_, 10);
    await q('UPDATE users SET password_hash=$1 WHERE username=$2', [hash, username]);
    res.json({ ok: true });
  } catch (e) {
    console.error('Password change error:', e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
