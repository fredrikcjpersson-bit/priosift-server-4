'use strict';
/**
 * Genererar en berättande journaltext från patientens svar i PrioSift.
 *
 * Texten är avsedd att kunna klistras in direkt i Cosmic som en
 * strukturerad journalanteckning (FHIR DocumentReference / NarrativeText).
 *
 * generateNarrative(patient, form) → String
 */

/* ── Hjälpare ─────────────────────────────────────────────────────────── */
function getLabel(options, id) {
  const o = options.find(x => x.id === id);
  return o ? o.label : id;
}

function joinSv(arr) {
  if (!arr.length) return '';
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(', ') + ' och ' + arr[arr.length - 1];
}

/* ── Huvud ─────────────────────────────────────────────────────────────── */
function generateNarrative(patient, form) {
  const a = patient.answers || {};
  const labs = patient.labs || {};
  const parts = [];

  /* --- Sökorsakerna --- */
  const huvudStep = form.steps.find(s => s.id === 'huvudbesvar');
  const chosen = Array.isArray(a.huvudbesvar) ? a.huvudbesvar : (a.huvudbesvar ? [a.huvudbesvar] : []);
  const sokOrsaker = chosen
    .filter(id => id !== 'annat')
    .map(id => getLabel(huvudStep?.options || [], id).toLowerCase());

  if (sokOrsaker.length) {
    parts.push(`Patienten söker för ${joinSv(sokOrsaker)}.`);
  } else {
    parts.push('Patienten söker akutvård.');
  }

  /* --- Smärta / besvär --- */
  const smartaStep = form.steps.find(s => s.id === 'smarta');
  const smartaId = a.smarta;
  if (smartaId && smartaStep) {
    const nrs = parseInt(smartaId.replace('nrs', ''), 10);
    if (!isNaN(nrs)) {
      const isPain = chosen.some(id => (form.painSymptoms || []).includes(id));
      parts.push(`${isPain ? 'Smärtan' : 'Besvären'} skattas till ${nrs}/10 (NRS).`);
    }
  }

  /* --- Varaktighet och debut --- */
  const varaktighetStep = form.steps.find(s => s.id === 'varaktighet');
  const debutStep       = form.steps.find(s => s.id === 'debut');
  const forlopStep      = form.steps.find(s => s.id === 'forlopp');

  const varaktighetLabel = varaktighetStep ? getLabel(varaktighetStep.options, a.varaktighet) : '';
  const debutLabel       = debutStep       ? getLabel(debutStep.options, a.debut) : '';
  const forlopLabel      = forlopStep      ? getLabel(forlopStep.options, a.forlopp) : '';

  const tidDelar = [];
  if (varaktighetLabel && varaktighetLabel !== a.varaktighet) tidDelar.push(`besvären har funnits i ${varaktighetLabel.toLowerCase()}`);
  if (debutLabel       && debutLabel !== a.debut)             tidDelar.push(`debuten var ${debutLabel.toLowerCase()}`);
  if (forlopLabel      && forlopLabel !== a.forlopp)          tidDelar.push(`förloppet har ${forlopLabel.toLowerCase()}`);
  if (tidDelar.length) parts.push(`Anamnestiskt: ${joinSv(tidDelar)}.`);

  /* --- Övriga symtom --- */
  const symStep = form.steps.find(s => s.id === 'samtidiga');
  if (symStep) {
    const symChosen = Array.isArray(a.samtidiga) ? a.samtidiga : (a.samtidiga ? [a.samtidiga] : []);
    const symLabels = symChosen
      .filter(id => id !== 'sym_inga')
      .map(id => getLabel(symStep.options, id).toLowerCase());
    if (symLabels.length) {
      parts.push(`Övriga symtom: ${joinSv(symLabels)}.`);
    } else {
      parts.push('Patienten uppger inga övriga symtom.');
    }
  }

  /* --- Sjukdomar --- */
  const sjukStep = form.steps.find(s => s.id === 'sjukdomar');
  if (sjukStep) {
    const sjukChosen = Array.isArray(a.sjukdomar) ? a.sjukdomar : (a.sjukdomar ? [a.sjukdomar] : []);
    const sjukLabels = sjukChosen
      .filter(id => id !== 'inga_sjukdomar')
      .map(id => getLabel(sjukStep.options, id).toLowerCase());
    if (sjukLabels.length) {
      parts.push(`Känd med: ${joinSv(sjukLabels)}.`);
    } else {
      parts.push('Inga kända sjukdomar.');
    }
  }

  /* --- Läkemedel --- */
  const lakStep = form.steps.find(s => s.id === 'lakemedel');
  if (lakStep) {
    const lakChosen = Array.isArray(a.lakemedel) ? a.lakemedel : (a.lakemedel ? [a.lakemedel] : []);
    const lakLabels = lakChosen
      .filter(id => id !== 'inga_lakemedel')
      .map(id => getLabel(lakStep.options, id).toLowerCase());
    if (lakLabels.length) {
      parts.push(`Läkemedel: ${joinSv(lakLabels)}.`);
    } else {
      parts.push('Inga fasta läkemedel.');
    }
  }

  /* --- Allergier --- */
  const allergiStep = form.steps.find(s => s.id === 'allergier');
  if (allergiStep) {
    const allergiChosen = Array.isArray(a.allergier) ? a.allergier : (a.allergier ? [a.allergier] : []);
    const allergiLabels = allergiChosen
      .filter(id => id !== 'inga_allergier')
      .map(id => getLabel(allergiStep.options, id).toLowerCase());
    if (allergiLabels.length) {
      parts.push(`Läkemedelsallergi mot: ${joinSv(allergiLabels)}.`);
    } else {
      parts.push('Inga kända läkemedelsallergier.');
    }
  }

  /* --- Slutfrågor (graviditet, rökning) --- */
  if (a.graviditet === 'grav_ja') parts.push('Kan vara gravid.');
  if (a.rokning === 'rok_ja')    parts.push('Röker.');

  /* --- Prover (om ifyllda) --- */
  const labParts = [];
  const bt = labs.bt;
  if (bt && (bt.sys || bt.dia)) labParts.push(`BT ${bt.sys || '?'}/${bt.dia || '?'} mmHg`);
  if (labs.puls)  labParts.push(`puls ${labs.puls} slag/min`);
  if (labs.temp)  labParts.push(`temp ${String(labs.temp).replace('.', ',')} °C`);
  if (labs.spo2)  labParts.push(`SpO₂ ${labs.spo2}%`);
  if (labParts.length) {
    parts.push(`Vitalparametrar: ${joinSv(labParts)}.`);
  }

  /* --- Prioritering --- */
  const levelNames = { 1: 'Omedelbar', 2: 'Brådskande', 3: 'Kan vänta', 4: 'Lägre prioritet' };
  const levelName = levelNames[patient.level] || `Nivå ${patient.level}`;
  parts.push(`Triageprioritet: ${levelName} (poäng ${patient.score ?? '–'}).`);

  if (patient.decision) {
    parts.push(`Beslut: ${patient.decision}`);
  }
  if (patient.staffNote) {
    parts.push(`Notering: ${patient.staffNote}`);
  }

  return parts.join('\n');
}

module.exports = { generateNarrative };
