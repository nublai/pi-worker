/**
 * The `artifacts.inspect` child (artifacts.ts): reads one `InspectionJob` (JSON) on stdin, runs owner Git's synchronous
 * calls on the saved launch pin, and prints one `InspectionResult` (JSON) on stdout. It runs in a process group of its
 * own with the owner environment only, so the supervisor's event loop never waits for Git and the supervisor can kill
 * the whole group when the inspection outlives its budget.
 */
import { Refusal } from '../b2/errors.js';
import { readFacts, type InspectionJob, type InspectionResult } from './artifacts.js';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let result: InspectionResult;
try {
  result = { facts: readFacts(JSON.parse(Buffer.concat(chunks).toString('utf8')) as InspectionJob) };
} catch (error) {
  const detail = error instanceof Refusal ? error.details.detail : undefined;
  result = error instanceof Refusal ? { refusal: { error: error.message, ...(typeof detail === 'string' ? { detail } : {}) } } : { refusal: { error: 'artifact_inspection_unavailable', detail: 'git_failed' } };
}
process.stdout.write(JSON.stringify(result));
