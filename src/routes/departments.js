'use strict';
const express  = require('express');
const { q }    = require('../db');
const { requireOwner } = require('../middleware');

const router = express.Router();

const rowToDept = d => ({
  id:           d.id,
  name:         d.name,
  city:         d.city,
  tier:         d.tier,
  annualVolume: d.annual_volume,
  contact:      d.contact,
  active:       d.active,
  createdAt:    d.created_at,
});

/* GET /api/departments */
router.get('/departments', async (req, res) => {
  try {
    const r = await q('SELECT * FROM departments ORDER BY name');
   res.json({ departments: r.rows.map(rowToDept) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* POST /api/departments  (owner only) */
router.post('/departments', requireOwner, async (req, res) => {
  try {
    const { name, city = '', tier = 1, annualVolume = 0, contact = '' } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Namn krävs' });

    const id = name
      .toLowerCase()
      .replace(/å/g, 'a').replace(/ä/g, 'a').replace(/ö/g, 'o')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) + '-' + Date.now().toString(36);

    const r = await q(
      `INSERT INTO departments(id,name,city,tier,annual_volume,contact,active)
       VALUES($1,$2,$3,$4,$5,$6,true) RETURNING *`,
      [id, name, city, tier, annualVolume, contact]
    );
    res.status(201).json(rowToDept(r.rows[0]));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* PATCH /api/departments/:id  (owner only) */
router.patch('/departments/:id', requireOwner, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, city, tier, annualVolume, contact, active } = req.body || {};
    const sets = [], vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };
    if (name         !== undefined) push('name',          name);
    if (city         !== undefined) push('city',          city);
    if (tier         !== undefined) push('tier',          tier);
    if (annualVolume !== undefined) push('annual_volume', annualVolume);
    if (contact      !== undefined) push('contact',       contact);
    if (active       !== undefined) push('active',        active);

    if (!sets.length) return res.status(400).json({ error: 'Inget att uppdatera' });
    vals.push(id);
    const r = await q(
      `UPDATE departments SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Avdelning saknas' });
    res.json(rowToDept(r.rows[0]));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* DELETE /api/departments/:id?force=1  (owner only) */
router.delete('/departments/:id', requireOwner, async (req, res) => {
  try {
    const { id }    = req.params;
    const force     = req.query.force === '1';
    if (!force) {
      const patients = await q('SELECT id FROM patients WHERE dept_id=$1 LIMIT 1', [id]);
      if (patients.rows.length)
        return res.status(409).json({ error: 'Avdelningen har patienter; skicka force=1 för att ta bort dem också' });
    }
    const r = await q('DELETE FROM departments WHERE id=$1 RETURNING id', [id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Avdelning saknas' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
