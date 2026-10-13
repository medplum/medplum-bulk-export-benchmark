// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// Synthetic patient generator. Patient `index` in tier `tier` always produces the same data, so a tier can be
// regenerated identically. The functions here do no I/O. Run this file directly to write transaction bundles to disk.
import type { Bundle, BundleEntry, Organization, Patient, Practitioner, Reference, Resource } from '@medplum/fhirtypes';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SharedRefs } from './shared.ts';
import { parseOptions, positiveInt } from './shared.ts';

/** Resources generated per patient. Small enough that a 1M patient tier fits on one machine. */
export const PER_PATIENT = {
  Patient: 1,
  Coverage: 1,
  AllergyIntolerance: 1,
  Condition: 3,
  Encounter: 5,
  Observation: 15, // 3 vitals per encounter
  MedicationRequest: 3,
  Immunization: 2,
  Procedure: 1,
  DiagnosticReport: 1,
};
export const RESOURCES_PER_PATIENT = Object.values(PER_PATIENT).reduce((a, b) => a + b, 0);

export const SHARED_ORGANIZATIONS = 20;
export const SHARED_PRACTITIONERS = 100;

const IDENTIFIER_BASE = 'https://github.com/medplum/medplum-bulk-export-benchmark/';
export const PATIENT_IDENTIFIER_SYSTEM = IDENTIFIER_BASE + 'patient';
const ORGANIZATION_IDENTIFIER_SYSTEM = IDENTIFIER_BASE + 'organization';

/**
 * Returns the identifier value for a patient, which a resumed load uses to find patients that are already loaded.
 * @param tier - The tier size.
 * @param index - The patient index.
 * @returns The identifier value.
 */
export function patientIdentifier(tier: number, index: number): string {
  return `${tier}-${index}`;
}

// Deterministic PRNG (mulberry32 seeded from sha256)
function prng(seed: string): () => number {
  let h = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST_NAMES = [
  'Alex',
  'Blair',
  'Casey',
  'Drew',
  'Elliot',
  'Finley',
  'Gray',
  'Harper',
  'Jordan',
  'Morgan',
  'Quinn',
  'Riley',
  'Sam',
  'Taylor',
];
const LAST_NAMES = [
  'Adams',
  'Baker',
  'Clark',
  'Diaz',
  'Evans',
  'Foster',
  'Garcia',
  'Harris',
  'Jones',
  'Kim',
  'Lopez',
  'Miller',
  'Nguyen',
  'Patel',
  'Rivera',
  'Singh',
  'Walker',
];
const CITIES = [
  ['Arlington', 'VA'],
  ['Boulder', 'CO'],
  ['Dover', 'DE'],
  ['Eugene', 'OR'],
  ['Fremont', 'CA'],
  ['Hamilton', 'OH'],
  ['Lancaster', 'PA'],
] as const;
const VITALS = [
  ['8867-4', 'Heart rate', '/min', 55, 110],
  ['8480-6', 'Systolic blood pressure', 'mm[Hg]', 95, 170],
  ['29463-7', 'Body weight', 'kg', 45, 130],
  ['8310-5', 'Body temperature', 'Cel', 36, 38.5],
  ['2339-0', 'Glucose', 'mg/dL', 70, 200],
] as const;
const CONDITIONS = [
  ['44054006', 'Diabetes mellitus type 2'],
  ['38341003', 'Hypertensive disorder'],
  ['195967001', 'Asthma'],
  ['55822004', 'Hyperlipidemia'],
  ['13645005', 'Chronic obstructive lung disease'],
  ['49436004', 'Atrial fibrillation'],
] as const;
const MEDICATIONS = [
  ['860975', 'metformin 500 MG Oral Tablet'],
  ['314076', 'lisinopril 10 MG Oral Tablet'],
  ['617312', 'atorvastatin 10 MG Oral Tablet'],
  ['745679', 'albuterol 0.09 MG/ACTUAT Inhaler'],
  ['855332', 'warfarin 5 MG Oral Tablet'],
] as const;
const VACCINES = [
  ['140', 'Influenza, seasonal, injectable'],
  ['208', 'COVID-19, mRNA, LNP-S, PF, 30 mcg/0.3 mL dose'],
  ['115', 'Tdap'],
  ['133', 'Pneumococcal conjugate PCV 13'],
] as const;
const PROCEDURES = [
  ['73761001', 'Colonoscopy'],
  ['430193006', 'Medication review'],
  ['396487001', 'Physical therapy procedure'],
] as const;
const ALLERGIES = [
  ['7980', 'Penicillin G'],
  ['1191', 'Aspirin'],
  ['2670', 'Codeine'],
] as const;

function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString();
}

const YEAR = 365.25 * 24 * 3600 * 1000;
const NOW = Date.parse('2026-09-01T00:00:00Z');

/**
 * Builds the shared Organizations and Practitioners that patients reference.
 * @returns The shared resources.
 */
export function sharedResources(): (Organization | Practitioner)[] {
  const resources: (Organization | Practitioner)[] = [];
  for (let i = 0; i < SHARED_ORGANIZATIONS; i++) {
    resources.push({
      resourceType: 'Organization',
      identifier: [{ system: ORGANIZATION_IDENTIFIER_SYSTEM, value: String(i + 1) }],
      name: `Synthetic Health System ${i + 1}`,
      active: true,
    });
  }
  for (let i = 0; i < SHARED_PRACTITIONERS; i++) {
    resources.push({
      resourceType: 'Practitioner',
      identifier: [{ system: 'http://hl7.org/fhir/sid/us-npi', value: String(1000000000 + i) }],
      name: [
        { given: [FIRST_NAMES[i % FIRST_NAMES.length]], family: LAST_NAMES[i % LAST_NAMES.length], prefix: ['Dr.'] },
      ],
    });
  }
  return resources;
}

/**
 * Builds transaction entries for one synthetic patient. References within the patient use urn:uuid fullUrls.
 * @param tier - The tier size, part of the random seed.
 * @param index - The patient index within the tier.
 * @param shared - References to the shared Organizations and Practitioners.
 * @returns The transaction entries, Patient first.
 */
export function patientEntries(tier: number, index: number, shared: SharedRefs): BundleEntry[] {
  const rand = prng(`${tier}:${index}`);
  const entries: BundleEntry[] = [];
  const add = (resource: Resource): string => {
    const fullUrl = 'urn:uuid:' + randomUUID();
    entries.push({ fullUrl, resource, request: { method: 'POST', url: resource.resourceType } });
    return fullUrl;
  };

  const gender = rand() < 0.5 ? 'female' : 'male';
  const birth = NOW - (1 + rand() * 89) * YEAR;
  const [city, state] = pick(rand, CITIES);
  const patient = add({
    resourceType: 'Patient',
    identifier: [{ system: PATIENT_IDENTIFIER_SYSTEM, value: patientIdentifier(tier, index) }],
    name: [{ given: [pick(rand, FIRST_NAMES)], family: pick(rand, LAST_NAMES) }],
    gender,
    birthDate: isoDate(birth).slice(0, 10),
    address: [
      {
        line: [`${100 + Math.floor(rand() * 9000)} Main St`],
        city,
        state,
        postalCode: String(10000 + Math.floor(rand() * 89999)),
      },
    ],
    telecom: [{ system: 'phone', value: `555-${String(Math.floor(rand() * 10000)).padStart(4, '0')}` }],
  });
  const subject: Reference<Patient> = { reference: patient };
  const org = pick(rand, shared.organizations);

  add({
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: subject,
    payor: [{ reference: org }],
    subscriberId: `M${index}`,
    period: { start: '2025-01-01' },
  });

  const [allergyCode, allergyName] = pick(rand, ALLERGIES);
  add({
    resourceType: 'AllergyIntolerance',
    clinicalStatus: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical', code: 'active' }],
    },
    code: {
      coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code: allergyCode, display: allergyName }],
    },
    patient: subject,
  });

  for (let i = 0; i < PER_PATIENT.Condition; i++) {
    const [code, display] = pick(rand, CONDITIONS);
    add({
      resourceType: 'Condition',
      clinicalStatus: {
        coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-clinical', code: 'active' }],
      },
      category: [
        { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/condition-category', code: 'problem-list-item' }] },
      ],
      code: { coding: [{ system: 'http://snomed.info/sct', code, display }] },
      subject,
      onsetDateTime: isoDate(birth + rand() * (NOW - birth)),
    });
  }

  const encounters: { ref: string; time: number; practitioner: string }[] = [];
  for (let i = 0; i < PER_PATIENT.Encounter; i++) {
    const time = NOW - rand() * 5 * YEAR;
    const practitioner = pick(rand, shared.practitioners);
    const ref = add({
      resourceType: 'Encounter',
      status: 'finished',
      class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB', display: 'ambulatory' },
      type: [{ coding: [{ system: 'http://snomed.info/sct', code: '185349003', display: 'Encounter for check up' }] }],
      subject,
      participant: [{ individual: { reference: practitioner } }],
      period: { start: isoDate(time), end: isoDate(time + 30 * 60 * 1000) },
      serviceProvider: { reference: org },
    });
    encounters.push({ ref, time, practitioner });
  }

  const observationsPerEncounter = PER_PATIENT.Observation / PER_PATIENT.Encounter;
  const observationRefs: string[] = [];
  for (const enc of encounters) {
    for (let i = 0; i < observationsPerEncounter; i++) {
      const [code, display, unit, lo, hi] = VITALS[(i + Math.floor(rand() * VITALS.length)) % VITALS.length];
      observationRefs.push(
        add({
          resourceType: 'Observation',
          status: 'final',
          category: [
            { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/observation-category', code: 'vital-signs' }] },
          ],
          code: { coding: [{ system: 'http://loinc.org', code, display }] },
          subject,
          encounter: { reference: enc.ref },
          effectiveDateTime: isoDate(enc.time),
          valueQuantity: {
            value: Math.round((lo + rand() * (hi - lo)) * 10) / 10,
            unit,
            system: 'http://unitsofmeasure.org',
            code: unit,
          },
        })
      );
    }
  }

  for (let i = 0; i < PER_PATIENT.MedicationRequest; i++) {
    const [code, display] = pick(rand, MEDICATIONS);
    const enc = pick(rand, encounters);
    add({
      resourceType: 'MedicationRequest',
      status: 'active',
      intent: 'order',
      medicationCodeableConcept: { coding: [{ system: 'http://www.nlm.nih.gov/research/umls/rxnorm', code, display }] },
      subject,
      encounter: { reference: enc.ref },
      authoredOn: isoDate(enc.time),
      requester: { reference: enc.practitioner },
      dosageInstruction: [{ text: 'Take 1 tablet by mouth daily' }],
    });
  }

  for (let i = 0; i < PER_PATIENT.Immunization; i++) {
    const [code, display] = pick(rand, VACCINES);
    add({
      resourceType: 'Immunization',
      status: 'completed',
      vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code, display }] },
      patient: subject,
      occurrenceDateTime: isoDate(NOW - rand() * 10 * YEAR),
      primarySource: true,
    });
  }

  const [procCode, procName] = pick(rand, PROCEDURES);
  const procEnc = pick(rand, encounters);
  add({
    resourceType: 'Procedure',
    status: 'completed',
    code: { coding: [{ system: 'http://snomed.info/sct', code: procCode, display: procName }] },
    subject,
    encounter: { reference: procEnc.ref },
    performedDateTime: isoDate(procEnc.time),
    performer: [{ actor: { reference: procEnc.practitioner } }],
  });

  const drEnc = encounters[0];
  add({
    resourceType: 'DiagnosticReport',
    status: 'final',
    code: { coding: [{ system: 'http://loinc.org', code: '85354-9', display: 'Blood pressure panel' }] },
    subject,
    encounter: { reference: drEnc.ref },
    effectiveDateTime: isoDate(drEnc.time),
    result: observationRefs.slice(0, observationsPerEncounter).map((reference) => ({ reference })),
  });

  return entries;
}

/**
 * Wraps patient entries into a transaction bundle.
 * @param tier - The tier size.
 * @param first - The first patient index.
 * @param count - The number of patients.
 * @param shared - References to the shared resources.
 * @returns The transaction bundle.
 */
export function patientBundle(tier: number, first: number, count: number, shared: SharedRefs): Bundle {
  const entry: BundleEntry[] = [];
  for (let i = first; i < first + count; i++) {
    entry.push(...patientEntries(tier, i, shared));
  }
  return { resourceType: 'Bundle', type: 'transaction', entry };
}

const usage = `Writes synthetic patients to disk as FHIR transaction bundles.

Usage: npm run generate -- --patients N [--per-bundle N] [--out DIR]

  --patients N     Number of patients to generate
  --per-bundle N   Patients per transaction bundle (default 20, which stays under the 1 MB request limit)
  --out DIR        Output directory (default ./bundles)

Writes 00000-shared.json first, a batch of the shared Organizations and Practitioners. Patient bundles refer to
them with conditional references, so load the shared bundle before the others.`;

function main(): void {
  const options = parseOptions(usage, {
    patients: { type: 'string' },
    'per-bundle': { type: 'string', default: '20' },
    out: { type: 'string', default: 'bundles' },
  });
  const patients = positiveInt('patients', options.patients);
  const perBundle = positiveInt('per-bundle', options['per-bundle']);
  const out = options.out;
  mkdirSync(out, { recursive: true });

  const shared = sharedResources();
  const sharedBundle: Bundle = {
    resourceType: 'Bundle',
    type: 'batch',
    entry: shared.map((resource) => ({ resource, request: { method: 'POST', url: resource.resourceType } })),
  };
  writeFileSync(`${out}/00000-shared.json`, JSON.stringify(sharedBundle));

  // Conditional references resolve to the shared resources at load time
  const refs: SharedRefs = { organizations: [], practitioners: [] };
  for (const resource of shared) {
    const identifier = resource.identifier?.[0];
    const ref = `${resource.resourceType}?identifier=${identifier?.system}|${identifier?.value}`;
    (resource.resourceType === 'Organization' ? refs.organizations : refs.practitioners).push(ref);
  }

  let file = 1;
  for (let first = 0; first < patients; first += perBundle) {
    const bundle = patientBundle(patients, first, Math.min(perBundle, patients - first), refs);
    writeFileSync(`${out}/${String(file++).padStart(5, '0')}.json`, JSON.stringify(bundle));
  }
  console.log(`Wrote ${patients} patients (${patients * RESOURCES_PER_PATIENT} resources) to ${file} files in ${out}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
