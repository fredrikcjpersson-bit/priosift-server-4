'use strict';
/**
 * Kryptografiska hjälpfunktioner för PrioSift.
 *
 * patient_id  = HMAC-SHA256(pnr, PATIENT_ID_SECRET) → 16 hex-tecken versaler
 *               Deterministisk: samma pnr → samma patient_id, alltid.
 *               Kan inte räknas baklänges utan nyckeln.
 *
 * pnr_encrypted = AES-256-GCM(pnr)
 *               Krypterat personnummer för Cosmic-push.
 *               Lagras i databasen, dekrypteras bara vid FHIR-export.
 */
const crypto = require('crypto');

const PATIENT_ID_SECRET  = process.env.PATIENT_ID_SECRET  || 'priosift-dev-id-secret-change-in-prod';
const PNR_ENCRYPTION_KEY = process.env.PNR_ENCRYPTION_KEY || 'a'.repeat(64); // 32 bytes hex, byt i produktion

/**
 * Normaliserar personnummer: tar bort bindestreck och mellanslag.
 */
function normalizePnr(pnr) {
  return String(pnr || '').replace(/[-\s]/g, '').trim();
}

/**
 * Skapar ett deterministiskt patient-ID från personnumret.
 * Returnerar 16 versala hex-tecken, t.ex. "A7F3B2C1D4E5F6A8".
 */
function hashPnr(pnr) {
  if (!pnr) return '';
  const normalized = normalizePnr(pnr);
  return crypto
    .createHmac('sha256', PATIENT_ID_SECRET)
    .update(normalized)
    .digest('hex')
    .slice(0, 16)
    .toUpperCase();
}

/**
 * Krypterar personnumret med AES-256-GCM.
 * Returnerar en base64-sträng: IV (12 bytes) + Auth-tag (16 bytes) + ciphertext.
 */
function encryptPnr(pnr) {
  if (!pnr) return '';
  const key = Buffer.from(PNR_ENCRYPTION_KEY.padEnd(64, '0').slice(0, 64), 'hex');
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc  = Buffer.concat([cipher.update(String(pnr), 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

/**
 * Dekrypterar ett krypterat personnummer.
 * Kastar om dekryptering misslyckas (fel nyckel eller tampering).
 */
function decryptPnr(encrypted) {
  if (!encrypted) return '';
  const buf = Buffer.from(encrypted, 'base64');
  const iv  = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const key  = Buffer.from(PNR_ENCRYPTION_KEY.padEnd(64, '0').slice(0, 64), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data).toString('utf8') + decipher.final('utf8');
}

module.exports = { hashPnr, encryptPnr, decryptPnr, normalizePnr };
