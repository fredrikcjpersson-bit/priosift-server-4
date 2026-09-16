'use strict';
const express    = require('express');
const session    = require('express-session');
const PgSession  = require('connect-pg-simple')(session);
const path       = require('path');
const { pool, initDb } = require('./src/db');

const app  = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
/* ── Trust Railway's reverse proxy (needed for secure cookies) ──────── */
   if (PROD) app.set('trust proxy', 1);

/* ── Middleware ─────────────────────────────────────────────────────── */
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'priosift-dev-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: PROD, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

/* ── API Routes ─────────────────────────────────────────────────────── */
const { requireAuth, requireOwner } = require('./src/middleware');

app.use('/api', require('./src/routes/auth'));
app.use('/api', requireAuth, require('./src/routes/bootstrap'));
app.use('/api', requireAuth, require('./src/routes/departments'));
app.use('/api', requireAuth, require('./src/routes/patients'));
app.use('/api', requireAuth, require('./src/routes/waiting'));
app.use('/api', requireAuth, requireOwner, require('./src/routes/config'));
app.use('/api', requireAuth, requireOwner, require('./src/routes/stats'));
app.use('/api', requireAuth, require('./src/routes/cosmic'));

/* ── SPA fallback ───────────────────────────────────────────────────── */
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ── Start ──────────────────────────────────────────────────────────── */
initDb()
  .then(() => app.listen(PORT, () => console.log(`PrioSift listening on :${PORT}`)))
  .catch(err => { console.error('Startup failed:', err.message); process.exit(1); });
