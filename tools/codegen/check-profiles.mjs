#!/usr/bin/env node
// The `bridge` grant profile is exactly the method table of docs/plan/b2-for-shep.md section 2.1 (plan P1-17's
// closure check, the Node half; the Go half is clients/go/workerfake/closure_test.go). Fails if a table method is
// missing from the profile, if the profile names a method outside the table, or if a profile method has no
// operation in the spec or no wire fixture.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));

/** The backticked method names in the first column of the table under `### 2.1`. */
export function tableMethods(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex(l => /^### 2\.1\b/.test(l));
  if (start < 0) throw new Error('b2-for-shep.md: no section 2.1');
  const methods = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) {
      if (inTable) break;
      continue;
    }
    inTable = true;
    const first = line.split('|')[1] ?? '';
    if (/^\s*-+\s*$/.test(first) || /^\s*Method\s*$/.test(first)) continue;
    const names = [...first.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    if (names.length === 0) throw new Error(`b2-for-shep.md 2.1: a row without a method: ${line}`);
    methods.push(...names);
  }
  if (methods.length === 0) throw new Error('b2-for-shep.md 2.1: no table');
  return methods;
}

export function check({ markdown, spec, wireDir }) {
  const failures = [];
  const table = tableMethods(markdown);
  const profile = spec.info?.['x-piw-grant-profiles']?.bridge ?? [];
  const operations = new Set(Object.values(spec.paths).flatMap(item => Object.values(item).map(op => op?.operationId).filter(Boolean)));
  for (const m of table) if (!profile.includes(m)) failures.push(`${m}: in b2-for-shep.md 2.1 but not in the bridge profile`);
  for (const m of profile) if (!table.includes(m)) failures.push(`${m}: in the bridge profile but not in b2-for-shep.md 2.1`);
  for (const m of new Set([...table, ...profile])) {
    if (!operations.has(m)) failures.push(`${m}: no route (no operation in the spec)`);
    const dir = join(wireDir, m);
    if (!existsSync(dir) || !readdirSync(dir).some(f => f.endsWith('.json'))) failures.push(`${m}: no wire fixture in api/fixtures/wire/${m}`);
  }
  if (new Set(table).size !== table.length) failures.push('b2-for-shep.md 2.1 lists a method twice');
  return { failures, table, profile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { failures, profile } = check({
    markdown: readFileSync(join(root, 'docs', 'plan', 'b2-for-shep.md'), 'utf8'),
    // The committed bundle; check:generated proves it equals api/b2.openapi.yaml.
    spec: JSON.parse(readFileSync(join(root, 'api', 'generated', 'b2.json'), 'utf8')),
    wireDir: join(root, 'api', 'fixtures', 'wire'),
  });
  for (const f of failures) console.error(`FAIL ${f}`);
  if (failures.length) process.exit(1);
  console.log(`ok   bridge profile equals b2-for-shep.md 2.1 (${profile.length} methods, each routed with a wire fixture)`);
}
