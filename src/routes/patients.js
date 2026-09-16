'use strict';
const express   = require('express');
const { randomUUID } = require('crypto');
const { q, getConfig, nextNumber, rowToPatient } = require('../db');
const { evaluate, suggestDesk } = require('../scoring');
const { hashPnr, encryptPnr } = require('../crypto');
const form = require('../form.json');

const router = express.Router();

/* GET /api/patients?dept= */
router.get('/patients', async (req, res) => {
  try {
    const { dept } = req.query;
    let sql = 'SELECT * FROM patients';
    const vals = [];
    if (dept) { sql += ' WHERE dept_id=$1'; vals.push(dept); }
    sql += ' ORDER BY level ASC, created_at ASC';
    const r = await q(sql, vals);
res.json({ patients: r.rows.map(rowToPatient) });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* POST /api/patients */
router.post('/patients', async (req, res) => {
  try {
    const { deptId, namn = '', pnr = '', answers = {}, labs = {} } = req.body || {};
    if (!deptId) return res.status(400).json({ error: 'deptId krävs' });

    const dept = await q('SELECT id FROM departments WHERE id=$1 AND active=true', [deptId]);
    if (!dept.rows.length) return res.status(404).json({ error: 'Avdelning saknas' });

    const [overrides, thresholds] = await Promise.all([
      getConfig('overrides', {}),
      getConfig('thresholds', form.defaultThresholds),
    ]);

    const ev           = evaluate(answers, labs, form, overrides, thresholds);
    const desk         = suggestDesk(answers, form);
    const id           = randomUUID().replace(/-/g, '').slice(0, 16);
    const num          = await nextNumber(deptId);
    const patientId    = hashPnr(pnr);
    const pnrEncrypted = encryptPnr(pnr);

    const r = await q(
      `INSERT INTO patients
         (id, dept_id, number, namn, pnr, patient_id, pnr_encrypted,
          answers, labs,
          form_score, lab_score, score, max_score,
          level, auto_level, red_flags, breakdown, lab_breakdown,
          desk, auto_desk)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16,$17,$18,$18)
       RETURNING *`,
      [
        id, deptId, num, namn, pnr, patientId, pnrEncrypted,
        JSON.stringify(answers), JSON.stringify(labs),
        ev.formScore, ev.labScore, ev.score, ev.maxScore,
        ev.level,
        JSON.stringify(ev.redFlags),
        JSON.stringify(ev.breakdown),
        JSON.stringify(ev.labBreakdown),
        desk,
      ]
    );
    res.status(201).json(rowToPatient(r.rows[0]));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* GET /api/patients/:id */
router.get('/patients/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM patients WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Patient saknas' });
    res.json(rowToPatient(r.rows[0]));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* PATCH /api/patients/:id */
router.patch('/patients/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const body   = req.body || {};

    const cur = await q('SELECT * FROM patients WHERE id=$1', [id]);
    if (!cur.rows.length) return res.status(404).json({ error: 'Patient saknas' });
    const p = cur.rows[0];

    const sets = [], vals = [];
    const push = (col, v) => { vals.push(v); sets.push(`${col}=$${vals.length}`); };

    // Simple text / scalar fields
    if (body.namn      !== undefined) push('namn',       body.namn);
    if (body.pnr       !== undefined) push('pnr',        body.pnr);
    if (body.decision  !== undefined) push('decision',   body.decision);
    if (body.handledBy !== undefined) push('handled_by', body.handledBy);
    if (body.staffNote !== undefined) push('staff_note', body.staffNote);
    if (body.desk      !== undefined) push('desk',       body.desk);
    if (body.level     !== undefined) push('level',      body.level);

    // Timestamp management
    if (body.status !== undefined) {
      push('status', body.status);
      if (body.status === 'triagerad' && !p.triaged_at) push('triaged_at', new Date());
      if (['avslutad', 'skickad'].includes(body.status) && !p.closed_at) push('closed_at', new Date());
    }

    // Labs — re-run scoring when labs are updated
    if (body.labs !== undefined) {
      push('labs', JSON.stringify(body.labs));
      if (body.labsBy) push('labs_by', body.labsBy);
      push('labs_at', new Date());

      const [overrides, thresholds] = await Promise.all([
        getConfig('overrides', {}),
        getConfig('thresholds', form.defaultThresholds),
      ]);
      const ev = evaluate(p.answers, body.labs, form, overrides, thresholds);
      push('form_score',    ev.formScore);
      push('lab_score',     ev.labScore);
      push('score',         ev.score);
      push('max_score',     ev.maxScore);
      push('auto_level',    ev.level);
      push('red_flags',     JSON.stringify(ev.redFlags));
      push('breakdown',     JSON.stringify(ev.breakdown));
      push('lab_breakdown', JSON.stringify(ev.labBreakdown));
      // Only auto-update level if it hasn't been manually overridden
      if (p.level === p.auto_level) push('level', ev.level);
    }

    if (!sets.length) return res.status(400).json({ error: 'Inget att uppdatera' });
    vals.push(id);
    const r = await q(
      `UPDATE patients SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    res.json(rowToPatient(r.rows[0]));
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

/* DELETE /api/patients/:id */
router.delete('/patients/:id', async (req, res) => {
  try {
    const r = await q('DELETE FROM patients WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Patient saknas' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
