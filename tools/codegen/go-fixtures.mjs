// The Go fake's fixture bundle (clients/go/workerfake/fixtures.gen.json): every wire fixture under api/fixtures/wire,
// keyed by operation and file name, and the frozen section 0.1 rows (api/fixtures/transitions.json) unchanged.
// go:embed cannot reach outside the package directory, and Shep vendors the package, so the fake embeds this copy;
// check:generated keeps it equal to api/fixtures.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function goFixtures(root, ops) {
  const dir = join(root, 'api', 'fixtures', 'wire');
  const known = new Set(ops.map(o => o.operationId));
  const wire = {};
  for (const op of readdirSync(dir).sort()) {
    if (!known.has(op)) throw new Error(`api/fixtures/wire/${op}: not an operation of the spec`);
    wire[op] = {};
    for (const file of readdirSync(join(dir, op)).filter(f => f.endsWith('.json')).sort()) {
      wire[op][file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(dir, op, file), 'utf8'));
    }
  }
  const transitions = JSON.parse(readFileSync(join(root, 'api', 'fixtures', 'transitions.json'), 'utf8'));
  return `${JSON.stringify({ generated: 'by tools/codegen from api/fixtures; DO NOT EDIT', wire, transitions }, null, 1)}\n`;
}
