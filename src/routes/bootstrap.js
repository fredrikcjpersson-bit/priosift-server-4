'use strict';
const express  = require('express');
const { q, getConfig } = require('../db');
const { maxFormScore, maxLabScore } = require('../scoring');
const form     = require('../form.json');

const router = express.Router();

/* GET /api/bootstrap
   Returns everything the frontend needs on startup:
   user, form, overrides, thresholds, tiers, departments, score maxima */
router.get('/bootstrap', async (req, res) => {
  try {
    const [overrides, thresholds, tiers, depts] = await Promise.all([
      getConfig('overrides',  {}),
      getConfig('thresholds', form.defaultThresholds),
      getConfig('tiers',      form.tiers),
      q('SELECT * FROM departments WHERE active=true ORDER BY name'),
    ]);

    res.json({
      user:         req.session.user,
      form,
      overrides,
      thresholds,
      tiers,
      departments:  depts.rows.map(d => ({
        id:           d.id,
        name:         d.name,
        city:         d.city,
        tier:         d.tier,
        annualVolume: d.annual_volume,
        contact:      d.contact,
        active:       d.active,
      })),
      maxFormScore: maxFormScore(form, overrides),
      maxLabScore:  maxLabScore(form, overrides),
    });
  } catch (e) {
    console.error('Bootstrap error:', e.message);
    res.status(500).json({ error: 'Serverfel' });
  }
});

module.exports = router;
