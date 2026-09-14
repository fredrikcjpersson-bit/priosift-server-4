'use strict';

/* ── Helpers ─────────────────────────────────────────────────────────────── */
const numval = v => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
const bandFor = (lab, n) =>
  lab.bands.find(b => b.lt === null || n < b.lt) || lab.bands[lab.bands.length - 1];
const labItems = lab => lab.bands || lab.options;

/* optCfg: merge overrides into an option's defaults */
const optCfg = (o, overrides = {}) => {
  const ov = overrides[o.id] || {};
  return { points: ov.points ?? o.points ?? 0, redFlag: ov.redFlag ?? !!o.redFlag };
};

/* ── Max scores ─────────────────────────────────────────────────────────── */
function maxFormScore(form, overrides = {}) {
  let sum = 0;
  for (const st of form.steps) {
    if (!st.scored) continue;
    if (st.type === 'combo') {
      for (const q of st.questions)
        sum += Math.max(...q.options.map(o => optCfg(o, overrides).points), 0);
    } else if (st.type === 'multi') {
      sum += st.options
        .map(o => Math.max(0, optCfg(o, overrides).points))
        .sort((a, b) => b - a)
        .slice(0, 3)
        .reduce((a, b) => a + b, 0);
    } else {
      sum += Math.max(...st.options.map(o => optCfg(o, overrides).points), 0);
    }
  }
  return sum;
}

function maxLabScore(form, overrides = {}) {
  return form.labs.reduce((sum, lab) => {
    const pts = labItems(lab).map(o => optCfg(o, overrides).points);
    return sum + (lab.type === 'multi'
      ? pts.map(p => Math.max(0, p)).sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0)
      : Math.max(...pts, 0));
  }, 0);
}

/* ── Main evaluation ────────────────────────────────────────────────────── */
function evaluate(answers, labs, form, overrides = {}, thresholds = {}) {
  const breakdown = [], labBreakdown = [], redFlags = [];
  let formScore = 0, labScore = 0;

  const take = (o, stepId, stepTitle, scored) => {
    const cfg = optCfg(o, overrides);
    const pts = scored ? cfg.points : 0;
    formScore += pts;
    breakdown.push({ stepId, stepTitle, label: o.label, points: pts, redFlag: cfg.redFlag, optionId: o.id });
    if (cfg.redFlag) redFlags.push({ stepTitle, label: o.label });
  };

  for (const st of form.steps) {
    if (st.type === 'combo') {
      for (const q of st.questions) {
        const o = q.options.find(x => x.id === answers[q.id]);
        if (o) take(o, st.id, q.title, st.scored);
      }
      continue;
    }
    const v = answers[st.id];
    const chosen = Array.isArray(v) ? v : (v ? [v] : []);
    for (const id of chosen) {
      const o = (st.options || []).find(x => x.id === id);
      if (o) take(o, st.id, st.title, st.scored);
    }
  }

  for (const lab of form.labs) {
    const v = (labs || {})[lab.id];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;

    let hits = [], shown = '';
    if (lab.type === 'number' || lab.type === 'number2') {
      const raw = lab.type === 'number2' ? v[lab.scoreOn] : v;
      const n = numval(raw);
      if (n === null) continue;
      hits = [bandFor(lab, n)];
      shown = lab.type === 'number2'
        ? `${v.sys || '?'}/${v.dia || '?'} ${lab.unit}`
        : `${String(raw).replace('.', ',')} ${lab.unit || ''}`.trim();
    } else {
      const ids = Array.isArray(v) ? v : [v];
      hits = ids.map(id => lab.options.find(o => o.id === id)).filter(Boolean);
      shown = hits.map(o => o.label).join(' · ');
    }

    for (const h of hits) {
      const cfg = optCfg(h, overrides);
      labScore += cfg.points;
      if (cfg.redFlag) redFlags.push({ stepTitle: lab.name, label: h.label });
    }
    labBreakdown.push({
      labId:    lab.id,
      labName:  lab.name,
      value:    shown,
      band:     hits.map(h => h.label).join(' · '),
      points:   hits.reduce((a, h) => a + optCfg(h, overrides).points, 0),
      redFlag:  hits.some(h => optCfg(h, overrides).redFlag),
    });
  }

  const t   = { level1: 45, level2: 30, level3: 18, ...thresholds };
  const score = formScore + labScore;
  const level = (redFlags.length || score >= t.level1) ? 1
              : score >= t.level2 ? 2
              : score >= t.level3 ? 3 : 4;

  return {
    formScore, labScore, score, level,
    redFlags, breakdown, labBreakdown,
    maxScore: maxFormScore(form, overrides) + maxLabScore(form, overrides),
  };
}

/* ── Desk suggestion ────────────────────────────────────────────────────── */
function suggestDesk(answers, form) {
  const chosen = Array.isArray(answers.huvudbesvar) ? answers.huvudbesvar : [];
  const step   = form.steps.find(s => s.id === 'huvudbesvar');
  if (!step) return 'medicin';
  const desks  = chosen
    .map(id => (step.options.find(o => o.id === id) || {}).desk)
    .filter(Boolean);
  for (const d of form.deskPriority) if (desks.includes(d)) return d;
  return 'medicin';
}

module.exports = { evaluate, suggestDesk, maxFormScore, maxLabScore, optCfg };
