// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// Loads a tier of synthetic patients into its own Medplum project. Safe to stop and re-run: a re-run resumes
// where the last one stopped, without inserting any patient twice.
import type { MedplumClient } from '@medplum/core';
import type { Bundle, Patient } from '@medplum/fhirtypes';
import {
  PATIENT_IDENTIFIER_SYSTEM,
  patientBundle,
  patientIdentifier,
  RESOURCES_PER_PATIENT,
  sharedResources,
} from './generate.ts';
import type { SharedRefs, TierState } from './shared.ts';
import {
  appendResult,
  BASE_URL,
  createProject,
  hasState,
  parseOptions,
  positiveInt,
  projectClient,
  readState,
  sleep,
  writeState,
} from './shared.ts';

const usage = `Loads synthetic patients into a new Medplum project, one project per tier.

Usage: npm run load -- --tier N [options]

  --tier N            Number of patients
  --concurrency N     Parallel transaction requests (default 12)
  --per-bundle N      Patients per transaction bundle (default 4)
  --base-urls URLS    Comma-separated servers to spread writes across (default MEDPLUM_BASE_URL)

The first run for a tier creates its project with Project/$init, which needs a super admin. Set
MEDPLUM_ADMIN_EMAIL and MEDPLUM_ADMIN_PASSWORD, or rely on the local development defaults.
To use an existing empty project instead, set MEDPLUM_CLIENT_ID and MEDPLUM_CLIENT_SECRET to its client.`;

const options = parseOptions(usage, {
  tier: { type: 'string' },
  concurrency: { type: 'string', default: '12' },
  'per-bundle': { type: 'string', default: '4' },
  'base-urls': { type: 'string', default: BASE_URL },
});
const tier = positiveInt('tier', options.tier);
const concurrency = positiveInt('concurrency', options.concurrency);
const perBundle = positiveInt('per-bundle', options['per-bundle']);
const baseUrls = options['base-urls'].split(',');

const state = hasState(tier) ? readState(tier) : await setupTier();
if (state.patientsLoaded >= tier) {
  console.log(`Tier ${tier} is already loaded into project ${state.projectId}`);
  process.exit(0);
}
const clients = await Promise.all(baseUrls.map((url) => projectClient(state, url)));
state.sharedRefs ??= await createSharedResources(clients[0]);
writeState(state);
await load(state, clients);

async function setupTier(): Promise<TierState> {
  let state: TierState;
  if (process.env.MEDPLUM_CLIENT_ID && process.env.MEDPLUM_CLIENT_SECRET) {
    state = {
      tier,
      projectId: '',
      clientId: process.env.MEDPLUM_CLIENT_ID,
      clientSecret: process.env.MEDPLUM_CLIENT_SECRET,
      patientsLoaded: 0,
    };
    const medplum = await projectClient(state);
    state.projectId = medplum.getProject()?.id as string;
  } else {
    state = await createProject(
      tier,
      process.env.MEDPLUM_ADMIN_EMAIL ?? 'admin@example.com',
      process.env.MEDPLUM_ADMIN_PASSWORD ?? 'medplum_admin'
    );
  }
  writeState(state);
  console.log(`Tier ${tier} uses project ${state.projectId}`);
  return state;
}

async function createSharedResources(medplum: MedplumClient): Promise<SharedRefs> {
  const result = await medplum.executeBatch({
    resourceType: 'Bundle',
    type: 'batch',
    entry: sharedResources().map((resource) => ({ resource, request: { method: 'POST', url: resource.resourceType } })),
  });
  const refs = (result.entry ?? []).map((e) => (e.response?.location as string).split('/_history')[0]);
  return {
    organizations: refs.filter((r) => r.startsWith('Organization/')),
    practitioners: refs.filter((r) => r.startsWith('Practitioner/')),
  };
}

/**
 * Finds patients loaded above the `patientsLoaded` mark by an earlier, interrupted run.
 * Transaction bundles commit atomically, so a loaded Patient means its whole bundle is loaded.
 * @param medplum - The project client.
 * @param state - The tier state.
 * @returns The indexes of patients that are already loaded.
 */
async function findLoadedPatients(medplum: MedplumClient, state: TierState): Promise<Set<number>> {
  // The server keeps committing a stopped run's in-flight bundles, so wait until the patient count settles
  const countPatients = async (): Promise<number | undefined> =>
    (await medplum.search('Patient', { _count: '0', _total: 'accurate' })).total;
  for (let before = await countPatients(); ;) {
    await sleep(5000);
    const after = await countPatients();
    if (after === before) {
      break;
    }
    before = after;
  }

  const loaded = new Set<number>();
  const query: Record<string, string> = { _sort: '_lastUpdated', _count: '1000', _elements: 'identifier' };
  if (state.checkpoint) {
    // A bundle can commit before the checkpoint while an earlier one is still in flight, so look back a few minutes
    query._lastUpdated = 'ge' + new Date(Date.parse(state.checkpoint) - 5 * 60_000).toISOString();
  }
  for await (const page of medplum.searchResourcePages('Patient', query)) {
    for (const patient of page as Patient[]) {
      const value = patient.identifier?.find((id) => id.system === PATIENT_IDENTIFIER_SYSTEM)?.value;
      const index = Number(value?.split('-')[1]);
      if (value === patientIdentifier(tier, index) && index >= state.patientsLoaded) {
        loaded.add(index);
      }
    }
  }
  return loaded;
}

async function load(state: TierState, clients: MedplumClient[]): Promise<void> {
  const shared = state.sharedRefs as SharedRefs;
  const resumeFrom = state.patientsLoaded;
  // Always check, since a run can be stopped before it saves its first checkpoint
  const alreadyLoaded = await findLoadedPatients(clients[0], state);
  if (alreadyLoaded.size > 0) {
    console.log(`Skipping ${alreadyLoaded.size} patients that an earlier run loaded above patient ${resumeFrom}`);
  }

  // Track the highest index below which every patient is loaded, so an interrupted run can resume from it
  const done = new Set<number>(alreadyLoaded);
  let next = resumeFrom;
  const advance = (): void => {
    while (done.has(state.patientsLoaded)) {
      done.delete(state.patientsLoaded++);
    }
  };
  advance();

  const start = Date.now();
  let loadedThisRun = 0;
  let lastLog = start;

  async function worker(medplum: MedplumClient): Promise<void> {
    for (;;) {
      // Bundles hold consecutive patients, skipping any that are already loaded
      const indexes: number[] = [];
      while (indexes.length < perBundle && next < tier) {
        if (!alreadyLoaded.has(next)) {
          indexes.push(next);
        }
        next++;
      }
      if (indexes.length === 0) {
        return;
      }
      const bundle: Bundle = { resourceType: 'Bundle', type: 'transaction', entry: [] };
      for (const i of indexes) {
        bundle.entry?.push(...(patientBundle(tier, i, 1, shared).entry ?? []));
      }
      const result = await medplum.executeBatch(bundle);
      state.checkpoint = result.entry?.[0]?.response?.lastModified ?? state.checkpoint;
      indexes.forEach((i) => done.add(i));
      loadedThisRun += indexes.length;
      advance();

      if (Date.now() - lastLog > 10_000) {
        lastLog = Date.now();
        writeState(state);
        const rate = loadedThisRun / ((Date.now() - start) / 1000);
        const remaining = tier - state.patientsLoaded;
        console.log(
          `${new Date().toISOString()} ${state.patientsLoaded}/${tier} patients, ` +
            `${Math.round(rate * RESOURCES_PER_PATIENT)} resources/s, eta ${Math.round(remaining / rate / 60)} min`
        );
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(clients[i % clients.length])));
  const seconds = (Date.now() - start) / 1000;
  state.loadSeconds = (state.loadSeconds ?? 0) + seconds;
  writeState(state);

  const resources = loadedThisRun * RESOURCES_PER_PATIENT;
  console.log(
    `Loaded ${loadedThisRun} patients (${resources} resources) in ${seconds.toFixed(1)}s, ` +
      `${Math.round(resources / seconds)} resources/s`
  );
  await appendResult({
    kind: 'load',
    tier,
    patients: loadedThisRun,
    resources,
    seconds,
    concurrency,
    perBundle,
    servers: clients.length,
  });
}
