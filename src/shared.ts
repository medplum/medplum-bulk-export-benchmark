// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { ClientStorage, MedplumClient, MemoryStorage } from '@medplum/core';
import type { ClientApplication, Parameters, Project } from '@medplum/fhirtypes';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import type { ParseArgsOptionsConfig } from 'node:util';
import { parseArgs } from 'node:util';

export const BASE_URL = process.env.MEDPLUM_BASE_URL ?? 'http://localhost:8103/';
const STATE_DIR = 'state';
const RESULTS_FILE = 'results.jsonl';

/** Saved per tier, so each command can find the tier's project and a load can resume. */
export interface TierState {
  tier: number;
  projectId: string;
  clientId: string;
  clientSecret: string;
  /** Every patient index below this is loaded. */
  patientsLoaded: number;
  /** Server time of the last committed bundle, used to find patients loaded above `patientsLoaded` on resume. */
  checkpoint?: string;
  sharedRefs?: SharedRefs;
  loadSeconds?: number;
  groupId?: string;
}

/** Organizations and Practitioners shared by all patients in a tier. */
export interface SharedRefs {
  organizations: string[];
  practitioners: string[];
}

/**
 * Parses command line options, exiting with usage text on bad input.
 * @param usage - The usage text.
 * @param options - The `node:util` parseArgs options.
 * @returns The parsed option values.
 */
export function parseOptions<T extends ParseArgsOptionsConfig>(
  usage: string,
  options: T
): ReturnType<typeof parseArgs<{ options: T }>>['values'] {
  if (process.argv.includes('--help')) {
    console.log(usage);
    process.exit(0);
  }
  try {
    return parseArgs({ options }).values;
  } catch (err) {
    console.error(`${(err as Error).message}\n\n${usage}`);
    process.exit(1);
  }
}

/**
 * Reads a positive integer option.
 * @param name - The option name, for error messages.
 * @param value - The raw option value.
 * @returns The parsed integer.
 */
export function positiveInt(name: string, value: string | undefined): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    console.error(`--${name} must be a positive integer`);
    process.exit(1);
  }
  return n;
}

function statePath(tier: number): string {
  return `${STATE_DIR}/tier-${tier}.json`;
}

export function hasState(tier: number): boolean {
  return existsSync(statePath(tier));
}

export function readState(tier: number): TierState {
  if (!hasState(tier)) {
    console.error(`No project for tier ${tier}. Run "npm run load -- --tier ${tier}" first.`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(statePath(tier), 'utf8')) as TierState;
}

export function writeState(state: TierState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(state.tier), JSON.stringify(state, null, 2));
}

/**
 * Creates a client for the tier's project, signed in with its client credentials.
 * @param state - The tier state.
 * @param baseUrl - The server to connect to.
 * @returns The signed-in client.
 */
export async function projectClient(state: TierState, baseUrl = BASE_URL): Promise<MedplumClient> {
  // Disable the GET cache so repeated reads always reach the server
  const medplum = new MedplumClient({ baseUrl, cacheTime: 0 });
  await medplum.startClientLogin(state.clientId, state.clientSecret);
  return medplum;
}

/**
 * Creates a new project for a tier with `Project/$init`, which requires a super admin login.
 * @param tier - The number of patients the tier will hold.
 * @param email - The super admin email.
 * @param password - The super admin password.
 * @returns The new tier state.
 */
export async function createProject(tier: number, email: string, password: string): Promise<TierState> {
  // Supply the PKCE verifier, since MedplumClient's own PKCE helper expects a browser `window.crypto`
  const storage = new ClientStorage(new MemoryStorage());
  const codeVerifier = randomUUID() + randomUUID();
  storage.setString('codeVerifier', codeVerifier);
  const admin = new MedplumClient({ baseUrl: BASE_URL, cacheTime: 0, storage });
  let login = await admin.startLogin({ email, password, codeChallenge: codeVerifier, codeChallengeMethod: 'plain' });
  if (!login.code && login.memberships) {
    login = await admin.post('auth/profile', { login: login.login, profile: login.memberships[0].id });
  }
  await admin.processCode(login.code as string);

  const result = await admin.post<Parameters | Project>(admin.fhirUrl('Project', '$init'), {
    resourceType: 'Parameters',
    parameter: [{ name: 'name', valueString: `Bulk Export Benchmark ${tier}` }],
  });
  const project =
    result.resourceType === 'Project'
      ? result
      : (result.parameter?.find((p) => p.name === 'return')?.resource as Project);
  const client = await admin.searchOne('ClientApplication', { _project: project.id });
  if (!client?.secret) {
    throw new Error(`Project/$init did not create a ClientApplication for project ${project.id}`);
  }
  return {
    tier,
    projectId: project.id as string,
    clientId: (client as ClientApplication).id as string,
    clientSecret: client.secret,
    patientsLoaded: 0,
  };
}

/**
 * Appends a result record, with enough environment detail to compare runs from different machines.
 * @param record - The result fields.
 */
export async function appendResult(record: Record<string, unknown>): Promise<void> {
  const full = {
    ...record,
    timestamp: new Date().toISOString(),
    serverUrl: BASE_URL,
    serverVersion: await getServerVersion(),
    client: {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memoryGb: Math.round(os.totalmem() / 1024 ** 3),
    },
  };
  appendFileSync(RESULTS_FILE, JSON.stringify(full) + '\n');
}

async function getServerVersion(): Promise<string | undefined> {
  try {
    const res = await fetch(new URL('healthcheck', BASE_URL));
    return ((await res.json()) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

export function readResults(): Record<string, any>[] {
  if (!existsSync(RESULTS_FILE)) {
    return [];
  }
  return readFileSync(RESULTS_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
