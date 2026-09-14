'use strict';
const express  = require('express');
const { q, getConfig, setConfig, rowToPatient } = require('../db');
const { evaluate } = require('../scoring');
const form     = require('../form.json');

const router = express.Router();

/* PUT /api/config  (owner only — requireOwner already applied in server.js)
   Body: { overrides?, thresholds?, tiers?, recalculate? }
   When recalculate=true, re-runs evaluate() on every non-closed patient. */
router.put('/config', async (req, res) => {
  try {
    const { overrides, thresholds, tiers, recalculate } = req.body || {};

    if (overrides  !== undefined) await setConfig('overrides',  overrides);
    if (thresholds !== undefined) await setConfig('thresholds', thresholds);
    if (tiers      !== undefined) await setConfig('tiers',      tiers);

    let recalculated = 0;
    if (recalculate) {
      const [ov, th] = await Promise.all([
        getConfig('overrides',  {}),
        getConfig('thresholds', form.defaultThresholds),
      ]);

      const open = await q(
        "SELECT * FROM patients WHERE status NOT IN ('avslutad','skickad')"
      );

      for (const p of open.rows) {
        const ev = evaluate(p.answers, p.labs, form, ov, th);
        await q(
          `UPDATE patients SET
             form_score=$1, lab_score=$2, score=$3, max_score=$4,
             auto_level=$5, red_flags=$6, breakdown=$7, lab_breakdown=$8,
             level = CASE WHEN level=auto_level THEN $5 ELSE level END
           WHERE id=$9`,
          [
            ev.formScore, ev.labScore, ev.score, ev.maxScore,
            ev.level,
            JSON.stringify(ev.redFlags),
            JSON.stringify(ev.breakdown),
            JSON.stringify(ev.labBreakdown),
            p.id,
          ]
        );
        recalculated++;
      }
    }

    const [ov, th, ti] = await Promise.all([
      getConfig('overrides',  {}),
      getConfig('thresholds', form.defaultThresholds),
      getConfig('tiers',      form.tiers),
    ]);

    res.json({ ok: true, recalculated, overrides: ov, thresholds: th, tiers: ti });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* GET /api/users  (owner only) */
router.get('/users', async (req, res) => {
  try {
    const r = await q('SELECT username, name, role, created_at FROM users ORDER BY name');
    res.json(r.rows.map(u => ({
      username:  u.username,
      name:      u.name,
      role:      u.role,
      createdAt: u.created_at,
    })));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* POST /api/users  (owner only) */
router.post('/users', async (req, res) => {
  try {
    const bcrypt = require('bcryptjs');
    const { username, name, role = 'staff', password } = req.body || {};
    if (!username || !name || !password)
      return res.status(400).json({ error: 'username, name och password krävs' });
    if (!['owner', 'staff'].includes(role))
      return res.status(400).json({ error: 'Ogiltig roll' });
    if (password.length < 8)
      return res.status(400).json({ error: 'Lösenordet måste vara minst 8 tecken' });

    const hash = await bcrypt.hash(password, 10);
    const r = await q(
      'INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4) RETURNING username,name,role,created_at',
      [username.toLowerCase().trim(), name, role, hash]
    );
    res.status(201).json({ username: r.rows[0].username, name: r.rows[0].name, role: r.rows[0].role });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Användarnamnet är redan taget' });
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* DELETE /api/users/:username  (owner only) */
router.delete('/users/:username', async (req, res) => {
  try {
    if (req.params.username === req.session.user.username)
      return res.status(400).json({ error: 'Du kan inte ta bort dig själv' });
    const r = await q('DELETE FROM users WHERE username=$1 RETURNING username', [req.params.username]);
    if (!r.rows.length) return res.status(404).json({ error: 'Användare saknas' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
