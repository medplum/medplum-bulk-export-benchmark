// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// Times a FHIR Bulk Data Export of a loaded tier, from the kickoff request until the export is complete,
// then downloads every output file to count resources and bytes.
import type { MedplumClient } from '@medplum/core';
import type { Group, GroupMember } from '@medplum/fhirtypes';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { TierState } from './shared.ts';
import { appendResult, parseOptions, positiveInt, projectClient, readState, sleep, writeState } from './shared.ts';

const LEVELS = ['system', 'patient', 'group'] as const;
type ExportLevel = (typeof LEVELS)[number];

const usage = `Times a FHIR Bulk Data Export of a loaded tier and appends the result to results.jsonl.

Usage: npm run export -- --tier N [options]

  --tier N           Tier to export (load it first)
  --level LEVEL      system ([base]/$export), patient (Patient/$export) or group (Group/[id]/$export).
                     Default system. The group level first builds a Group of every patient in the tier.
  --runs N           Number of runs (default 1)
  --timeout MIN      Give up on a run after this many minutes (default 120)
  --skip-download    Skip downloading the output files, so resource and byte counts are not recorded
  --server-pid PID   Linux only: sample this Medplum server process for peak memory and CPU time`;

interface ExportManifest {
  requiresAccessToken?: boolean;
  output: { type: string; url: string }[];
}

interface OutputFile {
  type: string;
  lines: number;
  bytes: number;
}

const options = parseOptions(usage, {
  tier: { type: 'string' },
  level: { type: 'string', default: 'system' },
  runs: { type: 'string', default: '1' },
  timeout: { type: 'string', default: '120' },
  'skip-download': { type: 'boolean', default: false },
  'server-pid': { type: 'string' },
});
const tier = positiveInt('tier', options.tier);
const level = options.level as ExportLevel;
if (!LEVELS.includes(level)) {
  console.error(`--level must be one of ${LEVELS.join(', ')}`);
  process.exit(1);
}
const runs = positiveInt('runs', options.runs);
const timeoutMs = positiveInt('timeout', options.timeout) * 60_000;
const serverPid = options['server-pid'] ? positiveInt('server-pid', options['server-pid']) : undefined;

const state = readState(tier);
const medplum = await projectClient(state);
const kickoffUrl = await getKickoffUrl(medplum, state);
for (let run = 1; run <= runs; run++) {
  await runExport(run);
}

async function getKickoffUrl(medplum: MedplumClient, state: TierState): Promise<URL> {
  if (level === 'patient') {
    return medplum.fhirUrl('Patient', '$export');
  }
  if (level === 'group') {
    return medplum.fhirUrl('Group', await ensureGroup(medplum, state), '$export');
  }
  return medplum.fhirUrl('$export');
}

/**
 * Builds a Group with every patient in the tier, the first time a tier is exported at the group level.
 * @param medplum - The project client.
 * @param state - The tier state.
 * @returns The Group ID.
 */
async function ensureGroup(medplum: MedplumClient, state: TierState): Promise<string> {
  if (state.groupId) {
    return state.groupId;
  }
  const members: GroupMember[] = [];
  for await (const page of medplum.searchResourcePages('Patient', {
    _elements: 'id',
    _sort: '_lastUpdated',
    _count: '1000',
  })) {
    members.push(...page.map((patient) => ({ entity: { reference: `Patient/${patient.id}` } })));
  }
  console.log(`Building a Group of ${members.length} patients`);

  // Request bodies are capped at 1 MB by default (maxJsonSize), and a 100k member Group is about 5.5 MB,
  // so create the Group with the first chunk of members and append the rest with JSON Patch
  const chunkSize = 8000;
  const group = await medplum.createResource<Group>({
    resourceType: 'Group',
    type: 'person',
    actual: true,
    name: `All patients (tier ${tier})`,
    member: members.slice(0, chunkSize),
  });
  for (let i = chunkSize; i < members.length; i += chunkSize) {
    const ops = members.slice(i, i + chunkSize).map((value) => ({ op: 'add' as const, path: '/member/-', value }));
    await medplum.patchResource('Group', group.id as string, ops);
  }
  state.groupId = group.id as string;
  writeState(state);
  return state.groupId;
}

async function authorizedFetch(url: URL | string, headers?: Record<string, string>): Promise<Response> {
  await medplum.refreshIfExpired();
  return fetch(url, { headers: { Authorization: `Bearer ${medplum.getAccessToken()}`, ...headers } });
}

async function runExport(run: number): Promise<void> {
  const sampler = serverPid ? startProcessSampler(serverPid) : undefined;
  const start = performance.now();
  const kickoff = await authorizedFetch(kickoffUrl, { Accept: 'application/fhir+json', Prefer: 'respond-async' });
  const kickoffMs = performance.now() - start;
  if (kickoff.status !== 202) {
    throw new Error(`Kickoff failed: ${kickoff.status} ${await kickoff.text()}`);
  }
  await kickoff.text();
  const statusUrl = kickoff.headers.get('content-location') as string;

  // Poll quickly for small tiers, so the poll interval does not dominate the measurement
  const pollMs = tier <= 1000 ? 100 : tier <= 10_000 ? 250 : 1000;
  let manifest: ExportManifest;
  let polls = 0;
  for (;;) {
    const res = await authorizedFetch(statusUrl, { Accept: 'application/json' });
    polls++;
    if (res.status === 200) {
      manifest = (await res.json()) as ExportManifest;
      break;
    }
    const body = await res.text();
    if (res.status !== 202) {
      throw new Error(`Export failed: ${res.status} ${body}`);
    }
    if (performance.now() - start > timeoutMs) {
      throw new Error(`Export still in progress after ${options.timeout} minutes: ${statusUrl}`);
    }
    await sleep(pollMs);
  }
  const exportMs = performance.now() - start;
  const server = sampler?.();

  const files: OutputFile[] = [];
  const downloadStart = performance.now();
  if (!options['skip-download']) {
    for (const output of manifest.output) {
      files.push(await countOutputFile(output, manifest.requiresAccessToken));
    }
  }
  const downloadMs = performance.now() - downloadStart;

  const totalResources = files.reduce((sum, f) => sum + f.lines, 0);
  const result = {
    kind: 'export',
    tier,
    level,
    run,
    kickoffMs: Math.round(kickoffMs),
    exportSeconds: Math.round(exportMs) / 1000,
    downloadSeconds: Math.round(downloadMs) / 1000,
    polls,
    outputFiles: manifest.output.length,
    totalResources: files.length ? totalResources : undefined,
    totalBytes: files.length ? files.reduce((sum, f) => sum + f.bytes, 0) : undefined,
    resourcesPerSecond: files.length ? Math.round(totalResources / (exportMs / 1000)) : undefined,
    serverPeakRssMb: server?.peakRssMb,
    serverCpuSeconds: server?.cpuSeconds,
    files,
  };
  await appendResult(result);
  const { files: _files, ...summary } = result;
  console.log(JSON.stringify(summary));
}

/**
 * Streams one output file, counting its NDJSON lines (one resource per line) and bytes.
 * @param output - The manifest output entry.
 * @param requiresAccessToken - Whether the manifest says downloads need the access token.
 * @returns The counts.
 */
async function countOutputFile(
  output: { type: string; url: string },
  requiresAccessToken?: boolean
): Promise<OutputFile> {
  const res = requiresAccessToken ? await authorizedFetch(output.url) : await fetch(output.url);
  if (!res.ok || !res.body) {
    throw new Error(`Download failed for ${output.type}: ${res.status}`);
  }
  let bytes = 0;
  let lines = 0;
  for await (const chunk of res.body) {
    bytes += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 10) {
        lines++;
      }
    }
  }
  return { type: output.type, lines, bytes };
}

/**
 * Samples a server process from /proc while an export runs, for peak resident memory and CPU time used.
 * @param pid - The server process ID.
 * @returns A function that stops sampling and returns the results.
 */
function startProcessSampler(pid: number): () => { peakRssMb: number; cpuSeconds: number } {
  const pageSize = Number(execSync('getconf PAGESIZE'));
  const ticksPerSecond = Number(execSync('getconf CLK_TCK'));
  const read = (): { rssMb: number; cpuSeconds: number } => {
    // Fields after the command name, which is in parentheses and may contain spaces
    const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
    return {
      rssMb: (Number(fields[21]) * pageSize) / 1024 ** 2,
      cpuSeconds: (Number(fields[11]) + Number(fields[12])) / ticksPerSecond, // utime + stime
    };
  };
  const initial = read();
  let peak = initial.rssMb;
  const timer = setInterval(() => (peak = Math.max(peak, read().rssMb)), 250);
  return () => {
    clearInterval(timer);
    const end = read();
    return {
      peakRssMb: Math.round(Math.max(peak, end.rssMb)),
      cpuSeconds: Math.round((end.cpuSeconds - initial.cpuSeconds) * 10) / 10,
    };
  };
}
