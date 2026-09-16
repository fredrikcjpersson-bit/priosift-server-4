'use strict';
const express = require('express');
const { q, getConfig } = require('../db');
const form    = require('../form.json');

const router = express.Router();

/* GET /api/stats  (owner only — requireOwner applied in server.js)
   Returns per-department stats, tier analysis and revenue summary. */
router.get('/stats', async (req, res) => {
  try {
    // Aggregate per department
    const [depts, patients, tiers] = await Promise.all([
      q('SELECT * FROM departments ORDER BY name'),
      q(`SELECT dept_id,
                COUNT(*)                                           AS total,
                COUNT(*) FILTER (WHERE status NOT IN ('avslutad','skickad')) AS open,
                COUNT(*) FILTER (WHERE level=1)                  AS lvl1,
                COUNT(*) FILTER (WHERE level=2)                  AS lvl2,
                COUNT(*) FILTER (WHERE level=3)                  AS lvl3,
                COUNT(*) FILTER (WHERE level=4)                  AS lvl4,
                AVG(score)::numeric(6,1)                         AS avg_score,
                COUNT(DISTINCT created_at::date)                 AS days_active
         FROM patients
         GROUP BY dept_id`),
      getConfig('tiers', form.tiers),
    ]);

    const statsMap = {};
    for (const r of patients.rows) statsMap[r.dept_id] = r;

    const departments = depts.rows.map(d => {
      const s      = statsMap[d.id] || {};
      const tier   = tiers.find(t => t.id === d.tier) || tiers[0];

      // Tier mismatch: if annual volume suggests a different tier
      const correctTier = tiers.slice().reverse().find(t => d.annual_volume >= (t.minVolume || 0)) || tiers[0];
      const tierMismatch = correctTier.id !== d.tier;

      const total = parseInt(s.total || 0);
      return {
        id:           d.id,
        name:         d.name,
        city:         d.city,
        tier:         d.tier,
        tierName:     tier.name,
        annualVolume: d.annual_volume,
        contact:      d.contact,
        active:       d.active,
        priceMonth:   tier.monthlyPrice || 0,
        tierMismatch,
        suggestedTier: tierMismatch ? correctTier.id : null,
        total,
        levels: {
          1: parseInt(s.lvl1 || 0),
          2: parseInt(s.lvl2 || 0),
          3: parseInt(s.lvl3 || 0),
          4: parseInt(s.lvl4 || 0),
        },
      };
    });

    const monthly = departments.filter(d => d.active).reduce((a, d) => a + d.priceMonth, 0);
    const totalPatients = departments.reduce((s, d) => s + d.total, 0);

    res.json({
      departments,
      tiers,
      totals: {
        monthlyRevenue: monthly,
        annualRevenue:  monthly * 12,
        patients:       totalPatients,
        active:         departments.filter(d => d.active).length,
      },
    });
  } catch (e) {
    console.error(e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
