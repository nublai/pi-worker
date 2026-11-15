# pi-worker

One supervisor per machine that runs pi headless (RPC/SDK), one session per worker, with typed events and dialogs, a durable log, receipts, epochs and explicit unknown outcomes, and child sessions in worktrees and sandboxes.

**THROWAWAY A0 slice 1 prototype — NOT production or a contract freeze.** Node >=22.19, ESM. The RPC host remains the default; this comparison branch adds a separate pi-durable 1.5.2 host (three pinned direct runtime dependencies). `openapi.json` is the B2 OpenAPI 3.1 surface; `src/api.generated.ts` is generated from it.

```sh
npm ci --ignore-scripts
npm test
A0_STATE_DIR=/absolute/private/state npm start
# Another shell, same OS user:
node dist/cli.js --socket /absolute/private/state/worker.sock hello
node dist/cli.js --socket /absolute/private/state/worker.sock create --command-id create-1 --cwd /absolute/workspace --provider PROVIDER --model MODEL --thinking off
node dist/cli.js --socket /absolute/private/state/worker.sock prompt WORKER_ID --command-id prompt-1 --message 'Write hello.txt and reply'
node dist/cli.js --socket /absolute/private/state/worker.sock watch WORKER_ID --until-settled
node dist/cli.js --socket /absolute/private/state/worker.sock history WORKER_ID
node dist/cli.js --socket /absolute/private/state/worker.sock stop WORKER_ID --command-id stop-1
```

`a0` is also the package bin after linking/installing. Set `A0_SOCKET` to omit `--socket`. `A0_PI` selects the Pi executable. Start with a fresh owned 0700 state directory. No TCP listener, credentials, terminal, or pane required. Normal Pi CLI discovery loads the machine's configured resources; never run this prototype on sensitive state.

Every mutation requires a caller-chosen `command_id`. Retry the exact request (including binding) with that ID, or read `receipt COMMAND_ID`; never change IDs to blindly retry uncertain work. Duplicate operations return stored receipts, conflicting reuse refuses. Admission is not execution settlement: only `agent_settled` (or explicit handled-without-run disposition) settles an execution. Every SSE attach sends an authoritative snapshot and cursor, then strictly later events; reconnect does not replay old notifications. History pages pin a session-file watermark and never restore live controls.

The journal fsyncs control records, not Pi's transcript or external effects. Restart never adopts or replays Pi. It kills recorded process groups, marks dispatched/active work unknown, and retains a session fence. **Fence resolution and resume are deliberately absent**: read/stop only after uncertainty. Process-group cleanup cannot account for escaped descendants. Grants, native peer UID checks, dialogs/answers, branching and child orchestration are slice 2+ work. Named limits are returned by `hello`. See `A0-SLICE1.md` for exact evidence and deviations.

## Throwaway pi-durable comparison

See **[A0-SLICE1-DURABLE.md](A0-SLICE1-DURABLE.md)** for the decision and live evidence. This is NOT an interchangeable implementation of the current recovery contract: it automatically resumes, retries model requests, and drains durable follow-ups without an unknown fence.

```sh
npm ci --ignore-scripts --cache /tmp/a0d/npm-cache
TMPDIR=/tmp/a0d npm test
A0D_STATE_DIR=/tmp/a0d/state npm run start:durable
# Same CLI; deterministic provider for isolated tests:
A0_SOCKET=/tmp/a0d/state/worker.sock node dist/cli.js hello
# create with --provider a0-faux --model deterministic --thinking off
# On a0-worker only, A0D_GATEWAY=1 enables the VM-local exe.dev adapter:
# --provider exe-dev-anthropic --model claude-sonnet-4-6@llm
```

JSONL storage uses `fsync:true`. Receipt + input admission share a transaction. The adapter owns its writer lock; pi-durable does not. `stop` aborts conversation tasks, not the shared host process, and does not prove crash-orphaned OS tools stopped. Stop the host with SIGTERM. All evidence drivers write under `/tmp/a0d/` and stop their own processes; `evidence/durable-ecosystem.mjs` needs the VM's installed package files. No host credential is needed or read.

The API routes, client and CLI are retained; only additive evidence labels were added to OpenAPI. Durable history entries have a different native format, and `agent_settled` is a documented adapter event derived from run removal, not coding-agent's native event.

Regenerate types with `npm run generate`; `npm run check:generated` detects spec/type drift. The draft contract remains in nublai/root `.pi/plan/`.

Intended license: MIT (nubl decision R21); the LICENSE file is added before the repository is made public.
