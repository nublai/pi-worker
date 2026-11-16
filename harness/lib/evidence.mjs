#!/usr/bin/env node
// Evidence record (plan section 8): binds a journey run to the exact commit and tree it ran on, with the platform,
// the attention record, the cleanup proof and the privacy scan result, as checks.json in the run directory.
//   node harness/lib/evidence.mjs <run-dir> <commit> <tree> <vm-name> <status: pass|fail> [note]
// Reads <run-dir>/platform.json and <run-dir>/journey.json when present. Scans the run directory before writing and
// refuses to write a record over a finding.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { scan } from './privacy-scan.mjs';

const [dir, commit, tree, vm, status, note] = process.argv.slice(2);
if (!dir || !/^[0-9a-f]{40}$/.test(commit ?? '') || !/^[0-9a-f]{40}$/.test(tree ?? '') || !vm || !['pass', 'fail'].includes(status)) {
  console.error('usage: evidence.mjs <run-dir> <commit> <tree> <vm-name> <pass|fail> [note]');
  process.exit(2);
}
const read = name => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
const journey = read('journey.json');
const privacy = scan([dir]);
const record = {
  journey: journey?.journey ?? null,
  status,
  // A failed attempt stays recorded and labelled; it never counts as a pass.
  counted: status === 'pass' && journey?.pass === true && privacy.findings.length === 0,
  commit,
  tree,
  vm,
  recorded_at: new Date().toISOString(),
  platform: read('platform.json'),
  checks: journey?.checks ?? null,
  cleanup: journey?.checks
    ? { no_piw_units_left: journey.checks.no_piw_units_left, socket_removed: journey.checks.socket_removed, cgroup_removed: journey.checks.cgroup_removed }
    : null,
  attention: [],
  privacy_scan: { scanned: privacy.scanned, findings: privacy.findings.length },
  ...(note ? { note } : {}),
};
if (privacy.findings.length) {
  console.error(JSON.stringify({ refused: 'privacy scan findings', findings: privacy.findings }));
  process.exit(1);
}
writeFileSync(join(dir, 'checks.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(JSON.stringify({ wrote: join(dir, 'checks.json'), status, counted: record.counted }));
