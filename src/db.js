'use strict';
const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');
const form     = require('./form.json');

const pool = new Pool({ connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });

/* ── Schema ─────────────────────────────────────────────────────────── */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username      VARCHAR(50)  PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  role          VARCHAR(20)  NOT NULL CHECK (role IN ('owner','staff')),
  password_hash VARCHAR(100) NOT NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS departments (
  id            VARCHAR(80)  PRIMARY KEY,
  name          VARCHAR(100) NOT NULL,
  city          VARCHAR(100) DEFAULT '',
  tier          INTEGER      DEFAULT 1,
  annual_volume INTEGER      DEFAULT 0,
  contact       VARCHAR(120) DEFAULT '',
  active        BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS patients (
  id            VARCHAR(20)  PRIMARY KEY,
  dept_id       VARCHAR(80)  NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  number        VARCHAR(20)  NOT NULL,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  namn          VARCHAR(120) DEFAULT '',
  pnr           VARCHAR(20)  DEFAULT '',
  patient_id    VARCHAR(20)  DEFAULT '',
  pnr_encrypted TEXT         DEFAULT '',
  answers       JSONB        DEFAULT '{}',
  labs          JSONB        DEFAULT '{}',
  form_score    INTEGER      DEFAULT 0,
  lab_score     INTEGER      DEFAULT 0,
  score         INTEGER      DEFAULT 0,
  max_score     INTEGER      DEFAULT 0,
  level         INTEGER      DEFAULT 4,
  auto_level    INTEGER      DEFAULT 4,
  red_flags     JSONB        DEFAULT '[]',
  breakdown     JSONB        DEFAULT '[]',
  lab_breakdown JSONB        DEFAULT '[]',
  desk          VARCHAR(40)  DEFAULT 'medicin',
  auto_desk     VARCHAR(40)  DEFAULT 'medicin',
  status        VARCHAR(20)  DEFAULT 'vantar',
  decision      VARCHAR(300) DEFAULT '',
  handled_by    VARCHAR(120) DEFAULT '',
  staff_note    TEXT         DEFAULT '',
  labs_by       VARCHAR(120) DEFAULT '',
  labs_at       TIMESTAMPTZ,
  triaged_at    TIMESTAMPTZ,
  closed_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS config (
  key   VARCHAR(50) PRIMARY KEY,
  value JSONB       NOT NULL
);

CREATE TABLE IF NOT EXISTS day_counters (
  dept_id VARCHAR(80) NOT NULL,
  day     DATE        NOT NULL,
  count   INTEGER     DEFAULT 0,
  PRIMARY KEY (dept_id, day)
);
`;

/* ── Helpers ────────────────────────────────────────────────────────── */
const q = (sql, params) => pool.query(sql, params);

async function getConfig(key, fallback = null) {
  const r = await q('SELECT value FROM config WHERE key=$1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function setConfig(key, value) {
  await q(`INSERT INTO config(key,value) VALUES($1,$2)
           ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value`, [key, JSON.stringify(value)]);
}

/* ── Patient number (letter + daily counter per dept) ───────────────── */
async function nextNumber(deptId) {
  const day = new Date().toISOString().slice(0, 10);
  const r = await q(
    `INSERT INTO day_counters(dept_id,day,count) VALUES($1,$2,1)
     ON CONFLICT(dept_id,day) DO UPDATE SET count=day_counters.count+1
     RETURNING count`, [deptId, day]);
  const n = r.rows[0].count;
  const letters = 'ABCDEFGHJKLMNPQRSTUVXYZ';
  return `${letters[(new Date().getDate() - 1) % letters.length]}-${100 + n}`;
}

/* ── Row → camelCase patient object ─────────────────────────────────── */
function rowToPatient(r) {
  return {
    id:           r.id,
    deptId:       r.dept_id,
    number:       r.number,
    createdAt:    r.created_at,
    namn:         r.namn,
    pnr:          r.pnr,
    patientId:    r.patient_id    || '',
    pnrEncrypted: r.pnr_encrypted || '',
    answers:      r.answers,
    labs:         r.labs,
    formScore:    r.form_score,
    labScore:     r.lab_score,
    score:        r.score,
    maxScore:     r.max_score,
    level:        r.level,
    autoLevel:    r.auto_level,
    redFlags:     r.red_flags,
    breakdown:    r.breakdown,
    labBreakdown: r.lab_breakdown,
    desk:         r.desk,
    autoDesk:     r.auto_desk,
    status:       r.status,
    decision:     r.decision,
    handledBy:    r.handled_by,
    staffNote:    r.staff_note,
    labsBy:       r.labs_by,
    labsAt:       r.labs_at,
    triagedAt:    r.triaged_at,
    closedAt:     r.closed_at,
  };
}

/* ── Seed ───────────────────────────────────────────────────────────── */
async function seed() {
  // Default owner (Fredrik)
  const ownerUsername = process.env.OWNER_USERNAME || 'fredrik';
  const ownerName     = process.env.OWNER_NAME     || 'Fredrik Persson';
  const ownerPassword = process.env.OWNER_PASSWORD || 'PrioSift-Admin-2024';
  const existing = await q('SELECT username FROM users WHERE username=$1', [ownerUsername]);
  if (!existing.rows.length) {
    const hash = await bcrypt.hash(ownerPassword, 10);
    await q('INSERT INTO users(username,name,role,password_hash) VALUES($1,$2,$3,$4)',
            [ownerUsername, ownerName, 'owner', hash]);
    console.log(`Seed: owner "${ownerUsername}" created (change password in admin!)`);
  }

  // Default demo department
  const depts = await q("SELECT id FROM departments WHERE id='demo'");
  if (!depts.rows.length) {
    await q(`INSERT INTO departments(id,name,city,tier,annual_volume,contact,active)
             VALUES('demo','Demo akutmottagning','Stockholm',2,38000,'demo@priosift.com',true)`);
  }

  // Config defaults
  const overrides  = await getConfig('overrides');
  if (!overrides)  await setConfig('overrides', {});
  const thresholds = await getConfig('thresholds');
  if (!thresholds) await setConfig('thresholds', form.defaultThresholds);
  const tiers      = await getConfig('tiers');
  if (!tiers)      await setConfig('tiers', form.tiers);
}

/* ── Migration: lägg till nya kolumner om de saknas (idempotent) ──── */
const MIGRATIONS = [
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS patient_id    VARCHAR(20) DEFAULT ''`,
  `ALTER TABLE patients ADD COLUMN IF NOT EXISTS pnr_encrypted TEXT        DEFAULT ''`,
];

/* ── Init ───────────────────────────────────────────────────────────── */
async function initDb() {
  await pool.query(SCHEMA);
  for (const m of MIGRATIONS) {
    await pool.query(m).catch(e => console.warn('Migration skip:', e.message));
  }
  await seed();
  console.log('DB ready');
}

module.exports = { pool, q, initDb, getConfig, setConfig, nextNumber, rowToPatient };
