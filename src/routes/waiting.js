'use strict';
const express = require('express');
const { q }   = require('../db');

const router = express.Router();

/* GET /api/waiting?dept=
   Public anonymized queue — no auth required.
   Returns: number, level, desk, place (queue position), waitedMinutes, status */
router.get('/waiting', async (req, res) => {
  try {
    const { dept } = req.query;
    let sql  = "SELECT * FROM patients WHERE status NOT IN ('avslutad','skickad')";
    const vals = [];
    if (dept) { sql += ' AND dept_id=$1'; vals.push(dept); }
    sql += ' ORDER BY level ASC, created_at ASC';

    const r   = await q(sql, vals);
    const now = Date.now();

    const rows = r.rows.map((p, i) => ({
      number:       p.number,
      level:        p.level,
      desk:         p.desk,
      place:        i + 1,
      waitedMinutes: Math.floor((now - new Date(p.created_at).getTime()) / 60000),
      status:       p.status,
    }));

    res.json({ queue: rows });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
