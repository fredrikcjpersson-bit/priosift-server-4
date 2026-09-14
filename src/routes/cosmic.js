'use strict';
/**
 * Cambio COSMIC / COS FHIR-adapter — PrioSift ↔ COSMIC integration layer.
 *
 * COSMIC är Cambios journalsystem. Integrationen sker via Cambio Open Services
 * (COS), som exponerar ett FHIR R4 API med SMART on FHIR / OAuth 2.0.
 *
 * Developer portal : https://developer.openservices.cambio.se
 * FHIR-profiler    : https://fhir.openservices.cambio.se
 * Sandbox          : https://sandbox.openservices.cambio.se (syntetiska patienter)
 *
 * Endpoints:
 *   GET  /api/cosmic/status          – Health-check / OAuth-test
 *   GET  /api/cosmic/patient/:pnr    – Slå upp patient i COSMIC via PNR
 *   POST /api/cosmic/push/:id        – Skicka triageresultat som FHIR-Bundle
 *   GET  /api/cosmic/preview/:id     – Förhandsgranska FHIR-bundle + journaltext
 *
 * Alla anrop kräver autentisering (requireAuth i server.js).
 *
 * Miljövariabler (sätt i Railway):
 *   COSMIC_ENABLED       – "true" för att aktivera, annars 501-stub
 *   COSMIC_BASE_URL      – t.ex. https://sandbox.openservices.cambio.se/fhir/r4
 *   COSMIC_TOKEN_URL     – OAuth 2.0 token-endpoint hos Cambio COS
 *   COSMIC_CLIENT_ID     – Client-ID från Cambio COS-portalen
 *   COSMIC_CLIENT_SECRET – Client-secret från Cambio COS-portalen
 *   COSMIC_SCOPE         – SMART on FHIR scopes, t.ex. "system/*.write system/*.read"
 */

const express = require('express');
const { q }   = require('../db');
const { decryptPnr } = require('../crypto');
const { generateNarrative } = require('../narrative');
const form = require('../form.json');

const router  = express.Router();
const ENABLED = process.env.COSMIC_ENABLED === 'true';

/* ── Cambio COS profil-URLs ─────────────────────────────────────────────── */
const COS_PROFILES = {
  heartRate:   'https://fhir.openservices.cambio.se/StructureDefinition/ObservationHeartRateLite',
  bloodPressure: 'https://fhir.openservices.cambio.se/StructureDefinition/ObservationBloodPressureLite',
  temp:        'https://fhir.openservices.cambio.se/StructureDefinition/ObservationBodyTemperatureLite',
  spo2:        'https://fhir.openservices.cambio.se/StructureDefinition/ObservationOxygenSaturationLite',
};

/* ── PNR identifier system (SE standard) ───────────────────────────────── */
const PNR_SYSTEM = 'http://electronichealth.se/identifier/pnr';

/* ── OAuth token cache ──────────────────────────────────────────────────── */
let _token    = null;
let _tokenExp = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExp - 30_000) return _token;

  const { COSMIC_TOKEN_URL, COSMIC_CLIENT_ID, COSMIC_CLIENT_SECRET, COSMIC_SCOPE } = process.env;
  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     COSMIC_CLIENT_ID,
    client_secret: COSMIC_CLIENT_SECRET,
    scope:         COSMIC_SCOPE || 'system/*.read system/*.write',
  });

  const r = await fetch(COSMIC_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    body.toString(),
  });
  if (!r.ok) throw new Error(`Cambio COS token error ${r.status}: ${await r.text()}`);
  const data  = await r.json();
  _token      = data.access_token;
  _tokenExp   = Date.now() + (data.expires_in || 3600) * 1000;
  return _token;
}

async function fhirReq(method, path, body) {
  const token = await getToken();
  const opts  = {
    method,
    headers: {
      Authorization:  `Bearer ${token}`,
      Accept:         'application/fhir+json',
      'Content-Type': 'application/fhir+json',
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(`${process.env.COSMIC_BASE_URL}/${path}`, opts);
  if (!r.ok) throw new Error(`FHIR ${method} ${path}: ${r.status} – ${await r.text()}`);
  return r.json();
}

/* ── Bygg FHIR-resurser från patientdata ────────────────────────────────── */

/** Subjekt-referens med PNR */
function subject(pnrClear) {
  return { identifier: { system: PNR_SYSTEM, value: pnrClear } };
}

/**
 * QuestionnaireResponse – formulärsvar i strukturerat FHIR-format.
 * Cambio COS stöder POST av QuestionnaireResponse direkt mot en patient.
 */
function buildQuestionnaireResponse(p, pnrClear, narrativeText) {
  const a = p.answers || {};
  const levelNames = { 1:'Omedelbar', 2:'Brådskande', 3:'Kan vänta', 4:'Lägre prioritet' };

  const items = [
    { linkId: 'priority',   text: 'Triageprioritet',   answer: [{ valueString: levelNames[p.level] || String(p.level) }] },
    { linkId: 'score',      text: 'Triagepoäng',       answer: [{ valueInteger: p.score || 0 }] },
    { linkId: 'desk',       text: 'Triagedesk',        answer: [{ valueString: p.desk || '' }] },
    { linkId: 'narrative',  text: 'Journaltext',       answer: [{ valueString: narrativeText }] },
  ];

  if (p.decision) {
    items.push({ linkId: 'decision', text: 'Beslut', answer: [{ valueString: p.decision }] });
  }
  if (p.staff_note) {
    items.push({ linkId: 'note', text: 'Notering (personal)', answer: [{ valueString: p.staff_note }] });
  }
  if (p.handled_by) {
    items.push({ linkId: 'handledBy', text: 'Triagerad av', answer: [{ valueString: p.handled_by }] });
  }

  // Lägg till röda flaggor om de finns
  const redFlags = p.red_flags || [];
  if (redFlags.length) {
    items.push({ linkId: 'redFlags', text: 'Röda flaggor', answer: [{ valueString: redFlags.join(', ') }] });
  }

  return {
    resourceType: 'QuestionnaireResponse',
    meta: { tag: [{ system: 'https://priosift.com/tags', code: 'triage-result' }] },
    status: 'completed',
    questionnaire: 'https://priosift.com/fhir/Questionnaire/triage-v1',
    subject: subject(pnrClear),
    authored: p.triaged_at || new Date().toISOString(),
    author: p.handled_by ? { display: p.handled_by } : undefined,
    item: items,
  };
}

/**
 * Observation-resurser för vitalparametrar med Cambio COS-profiler.
 * Returnerar array av Observation-resources (tomma om inget mätvärde finns).
 */
function buildVitalObservations(p, pnrClear) {
  const labs = p.labs || {};
  const ts   = p.labs_at || new Date().toISOString();
  const obs  = [];

  // Puls (ObservationHeartRateLite)
  if (labs.puls) {
    obs.push({
      resourceType: 'Observation',
      meta: { profile: [COS_PROFILES.heartRate] },
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8867-4', display: 'Heart rate' }] },
      subject: subject(pnrClear),
      effectiveDateTime: ts,
      valueQuantity: { value: Number(labs.puls), unit: 'slag/min', system: 'http://unitsofmeasure.org', code: '/min' },
    });
  }

  // Blodtryck (ObservationBloodPressureLite)
  if (labs.bt?.sys || labs.bt?.dia) {
    obs.push({
      resourceType: 'Observation',
      meta: { profile: [COS_PROFILES.bloodPressure] },
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
      subject: subject(pnrClear),
      effectiveDateTime: ts,
      component: [
        labs.bt.sys ? { code: { coding: [{ system: 'http://loinc.org', code: '8480-6', display: 'Systolic BP' }] },
          valueQuantity: { value: Number(labs.bt.sys), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } } : null,
        labs.bt.dia ? { code: { coding: [{ system: 'http://loinc.org', code: '8462-4', display: 'Diastolic BP' }] },
          valueQuantity: { value: Number(labs.bt.dia), unit: 'mmHg', system: 'http://unitsofmeasure.org', code: 'mm[Hg]' } } : null,
      ].filter(Boolean),
    });
  }

  // Temperatur (ObservationBodyTemperatureLite)
  if (labs.temp) {
    obs.push({
      resourceType: 'Observation',
      meta: { profile: [COS_PROFILES.temp] },
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '8310-5', display: 'Body temperature' }] },
      subject: subject(pnrClear),
      effectiveDateTime: ts,
      valueQuantity: { value: Number(String(labs.temp).replace(',', '.')), unit: '°C', system: 'http://unitsofmeasure.org', code: 'Cel' },
    });
  }

  // SpO₂ (ObservationOxygenSaturationLite)
  if (labs.spo2) {
    obs.push({
      resourceType: 'Observation',
      meta: { profile: [COS_PROFILES.spo2] },
      status: 'final',
      code: { coding: [{ system: 'http://loinc.org', code: '2708-6', display: 'Oxygen saturation' }] },
      subject: subject(pnrClear),
      effectiveDateTime: ts,
      valueQuantity: { value: Number(labs.spo2), unit: '%', system: 'http://unitsofmeasure.org', code: '%' },
    });
  }

  return obs;
}

/**
 * Bygg ett komplett FHIR Transaction Bundle med:
 *   1. QuestionnaireResponse (formulärsvar + triageresultat)
 *   2. Observation × N (en per vitalparameter med Cambio-profil)
 */
function buildBundle(p, pnrClear, narrativeText) {
  const qr   = buildQuestionnaireResponse(p, pnrClear, narrativeText);
  const vits = buildVitalObservations(p, pnrClear);

  const entries = [
    { fullUrl: 'urn:uuid:triage-qr', resource: qr, request: { method: 'POST', url: 'QuestionnaireResponse' } },
    ...vits.map((obs, i) => ({
      fullUrl: `urn:uuid:vital-${i}`,
      resource: obs,
      request:  { method: 'POST', url: 'Observation' },
    })),
  ];

  return {
    resourceType: 'Bundle',
    type: 'transaction',
    entry: entries,
  };
}

/* ── Stub helper ────────────────────────────────────────────────────────── */
function stub(res) {
  return res.status(501).json({
    error:   'Cambio COS-integration är inte aktiverad',
    hint:    'Sätt COSMIC_ENABLED=true och COSMIC_* miljövariabler (se .env.example)',
    docs:    'https://developer.openservices.cambio.se',
    enabled: false,
  });
}

/* ── GET /api/cosmic/status ─────────────────────────────────────────────── */
router.get('/cosmic/status', async (req, res) => {
  if (!ENABLED) return res.json({ enabled: false, status: 'disabled', docs: 'https://developer.openservices.cambio.se' });
  try {
    await getToken();
    const meta = await fhirReq('GET', 'metadata');
    res.json({ enabled: true, status: 'ok', fhirVersion: meta.fhirVersion, software: meta.software?.name });
  } catch (e) {
    res.status(502).json({ enabled: true, status: 'error', error: e.message });
  }
});

/* ── GET /api/cosmic/patient/:pnr ───────────────────────────────────────── */
router.get('/cosmic/patient/:pnr', async (req, res) => {
  if (!ENABLED) return stub(res);
  try {
    const { pnr } = req.params;
    const bundle = await fhirReq('GET',
      `Patient?identifier=${encodeURIComponent(PNR_SYSTEM + '|' + pnr)}`);
    if (!bundle.entry?.length)
      return res.status(404).json({ error: 'Patienten hittades inte i COSMIC' });

    const pt   = bundle.entry[0].resource;
    const name = pt.name?.[0];
    res.json({
      pnr,
      fhirId:    pt.id,
      namn:      [name?.family, ...(name?.given || [])].filter(Boolean).join(' '),
      birthDate: pt.birthDate,
      gender:    pt.gender,
      address:   pt.address?.[0]?.text || '',
    });
  } catch (e) {
    console.error('COSMIC patient lookup:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ── POST /api/cosmic/push/:id ──────────────────────────────────────────── */
router.post('/cosmic/push/:id', async (req, res) => {
  if (!ENABLED) return stub(res);
  try {
    const r = await q('SELECT * FROM patients WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Patient saknas' });
    const p = r.rows[0];

    const pnrClear     = decryptPnr(p.pnr_encrypted) || p.pnr || '';
    const patientObj   = { answers: p.answers, labs: p.labs, level: p.level, score: p.score,
                           decision: p.decision, staffNote: p.staff_note, desk: p.desk,
                           red_flags: p.red_flags, handled_by: p.handled_by, triaged_at: p.triaged_at, labs_at: p.labs_at };
    const narrativeText = generateNarrative(patientObj, form);
    const token        = await getToken();
    const bundle       = buildBundle(p, pnrClear, narrativeText);

    const pushRes = await fetch(`${process.env.COSMIC_BASE_URL}`, {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/fhir+json',
        Accept:         'application/fhir+json',
      },
      body: JSON.stringify(bundle),
    });

    if (!pushRes.ok) {
      const err = await pushRes.text();
      return res.status(502).json({ error: `COSMIC ${pushRes.status}`, detail: err });
    }

    const result = await pushRes.json();
    const qrEntry = result.entry?.find(e => e.resource?.resourceType === 'QuestionnaireResponse');
    res.json({
      ok:              true,
      bundleId:        result.id,
      questionnaireId: qrEntry?.resource?.id,
      entriesSent:     bundle.entry.length,
    });
  } catch (e) {
    console.error('COSMIC push:', e.message);
    res.status(502).json({ error: e.message });
  }
});

/* ── GET /api/cosmic/preview/:id ────────────────────────────────────────── */
router.get('/cosmic/preview/:id', async (req, res) => {
  try {
    const r = await q('SELECT * FROM patients WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Patient saknas' });
    const p = r.rows[0];

    const pnrClear = decryptPnr(p.pnr_encrypted) || p.pnr || '';

    const patientObj = {
      answers:    p.answers,
      labs:       p.labs,
      level:      p.level,
      score:      p.score,
      decision:   p.decision,
      staffNote:  p.staff_note,
      desk:       p.desk,
      red_flags:  p.red_flags,
      handled_by: p.handled_by,
      triaged_at: p.triaged_at,
      labs_at:    p.labs_at,
    };
    const narrativeText  = generateNarrative(patientObj, form);
    const fhirBundle     = buildBundle(p, pnrClear ? pnrClear.slice(0, 8) + '****' : '(PNR ej tillgängligt)', narrativeText);
    const vitalCount     = buildVitalObservations(p, '').length;

    res.json({
      patientId:     p.patient_id || '',
      pnrMasked:     pnrClear ? pnrClear.slice(0, 8) + '****' : '',
      namn:          p.namn || '',
      number:        p.number,
      narrativeText,
      fhirBundle,
      vitalCount,
      cosmicEnabled: ENABLED,
      docs: 'https://developer.openservices.cambio.se',
    });
  } catch (e) {
    console.error('COSMIC preview:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
