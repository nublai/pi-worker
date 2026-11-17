#!/usr/bin/env node
/** `pi-worker`: the operator CLI over @nublai/pi-worker-client. See `pi-worker --help`. */
import { run } from './run.js';

process.exitCode = await run(process.argv.slice(2), {
  out: line => process.stdout.write(`${line}\n`),
  err: line => process.stderr.write(`${line}\n`),
  env: process.env,
});
