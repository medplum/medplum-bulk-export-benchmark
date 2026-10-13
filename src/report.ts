// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
//
// Summarizes results.jsonl as Markdown tables: one row per load, and the median of each tier and export level.
import { parseOptions, readResults } from './shared.ts';

const usage = `Prints results.jsonl as Markdown tables.

Usage: npm run report -- [--since ISO_TIMESTAMP]

  --since TIME   Only include results recorded at or after this time, for example 2026-10-12T00:00:00Z`;

const options = parseOptions(usage, { since: { type: 'string', default: '' } });
const results = readResults().filter((r) => r.timestamp >= options.since);

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fmt(n: number | undefined, digits = 0): string {
  return n === undefined || Number.isNaN(n)
    ? ''
    : n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function table(header: string[], rows: string[][]): void {
  console.log(`| ${header.join(' | ')} |`);
  console.log(`|${header.map(() => '---').join('|')}|`);
  rows.forEach((row) => console.log(`| ${row.join(' | ')} |`));
  console.log();
}

const loads = results.filter((r) => r.kind === 'load');
if (loads.length) {
  console.log('## Loads\n');
  table(
    ['Tier', 'Patients', 'Resources', 'Seconds', 'Resources/s', 'Servers'],
    loads.map((r) => [
      fmt(r.tier),
      fmt(r.patients),
      fmt(r.resources),
      fmt(r.seconds, 1),
      fmt(r.resources / r.seconds),
      fmt(r.servers),
    ])
  );
}

const exports = new Map<string, Record<string, any>[]>();
for (const r of results.filter((r) => r.kind === 'export')) {
  const key = `${r.level}:${r.tier}`;
  exports.set(key, [...(exports.get(key) ?? []), r]);
}
const levelOrder = ['system', 'patient', 'group'];
const groups = [...exports.values()].sort(
  (a, b) => levelOrder.indexOf(a[0].level) - levelOrder.indexOf(b[0].level) || a[0].tier - b[0].tier
);
if (groups.length) {
  console.log('## Exports (median of runs)\n');
  table(
    ['Level', 'Tier', 'Runs', 'Resources', 'MB', 'Median s', 'Min s', 'Max s', 'Resources/s', 'Peak RSS MB', 'CPU s'],
    groups.map((runs) => {
      const seconds = runs.map((r) => r.exportSeconds as number);
      const last = runs[runs.length - 1];
      const cpu = runs.map((r) => r.serverCpuSeconds).filter((n) => n !== undefined);
      const rss = runs.map((r) => r.serverPeakRssMb).filter((n) => n !== undefined);
      return [
        last.level,
        fmt(last.tier),
        fmt(runs.length),
        fmt(last.totalResources),
        fmt(last.totalBytes === undefined ? undefined : last.totalBytes / 1e6, 1),
        fmt(median(seconds), 2),
        fmt(Math.min(...seconds), 2),
        fmt(Math.max(...seconds), 2),
        fmt(last.totalResources === undefined ? undefined : last.totalResources / median(seconds)),
        rss.length ? fmt(Math.max(...rss)) : '',
        cpu.length ? fmt(median(cpu), 1) : '',
      ];
    })
  );
}

if (!loads.length && !groups.length) {
  console.log('No results yet. Run "npm run load" and "npm run export" first.');
}
