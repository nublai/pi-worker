# pi-worker

**THROWAWAY A0 slice 3 prototype — NOT production, Gate 1, or a contract freeze.** One Node 22+ supervisor, one selectable Pi 1.5.2 RPC, SDK, or ACP subprocess per worker, private Unix HTTP/OpenAPI, typed CLI, fsynced control records, explicit uncertainty, and Pi-owned conversation files. The SDK dependency is pinned to 1.5.2. See [A0-SLICE3.md](A0-SLICE3.md) for the SDK production-host recommendation and evidence.

## Try the throwaway CLI

```sh
npm ci --ignore-scripts --cache /tmp/a0s3/npm-cache
TMPDIR=/tmp/a0s3 npm test
A0_STATE_DIR=/tmp/a0s3/demo npm start
# Another shell, same OS user:
export A0_SOCKET=/tmp/a0s3/demo/worker.sock
node dist/cli.js hello
node dist/cli.js create --command-id create-1 --cwd /absolute/workspace --provider PROVIDER --model MODEL --thinking off
node dist/cli.js prompt WORKER --command-id prompt-1 --message 'Reply hello'
node dist/cli.js watch WORKER --until-settled
node dist/cli.js history WORKER
node dist/cli.js new WORKER --command-id new-1
node dist/cli.js rebind WORKER --command-id resume-1 --action resume --target-session-id KNOWN_SESSION
node dist/cli.js rebind WORKER --command-id fork-1 --action fork --entry-id USER_ENTRY --source-leaf-id CURRENT_LEAF
node dist/cli.js resolve WORKER --command-id resolution-1 --uncertain-command-id UNCERTAIN_COMMAND --fence-generation GENERATION --disposition keep
node dist/cli.js stop WORKER --command-id stop-1
```

`A0_PI` selects Pi. The installation owner is registered at the first supervisor start; its bearer file is `STATE/grants/owner.json` (0600). The CLI defaults to that file. Register a separate honest-component caller locally, then set `A0_GRANT_FILE` to the returned **file path** (never paste a bearer):

```sh
node dist/cli.js grant-register --caller observer --methods hello,workers.list,workers.get,events.subscribe --workers WORKER
node dist/cli.js grant-revoke GRANT_ID
```

Registration/revocation is local machine-owner configuration, not an unauthenticated HTTP endpoint. Scope is explicit worker IDs and/or canonical cwd roots (`--cwd-roots /absolute/root`); `*` is an explicit owner policy. Every B2 method checks the bearer/method/scope. Mutations recheck revocation at dispatch, including queued dispatch. **Same-user code can read these grant files**. There is no native SO_PEERCRED check. SDK/ACP include an opt-in **test** bash approval gate; it is not a production security boundary.

## Hosts and interactions

`create --host rpc|sdk|acp` selects a host per worker (default: RPC). Project-local executable resources require explicit `--project-trusted`; no global trust settings are changed. SDK/ACP explicitly load Pi's codemode, tool-search and MCP builtins. Per-worker `resources` reports actual registrations, not merely installed packages.

```sh
node dist/cli.js create --command-id create-sdk --cwd /absolute/workspace --provider PROVIDER --model MODEL --thinking off --host sdk --project-trusted
node dist/cli.js interactions WORKER
node dist/cli.js answer WORKER --answer-file /private/answer.json
node dist/cli.js interaction-status WORKER --interaction-id INTERACTION
```

The answer file is a complete `Answer` from `openapi.json`: capture worker epoch, session and binding revision, interaction ID/revision/kind; supply `command_id`, `answer_id`, `outcome: answer|cancel`, and either a boolean/text `value` or a select `option_id`. The CLI never silently substitutes today's binding. Use offered option IDs, including for duplicate labels. Answer text and answer-derived hashes are absent from control records; duplicate-value comparison is live-only. Snapshots restore current questions and payloads, while only metadata/outcomes are journaled.

`answer_stage` distinguishes worker acceptance (1), forwarding (2), exact resolver consumption (3), and gate release (4). RPC proves at most 2; SDK/ACP prove 3. A separate `ANSWER_ID:release` receipt reports the typed test gate's release or denial. Lost acknowledgements fence; lookup does not redispatch. `custom()` is explicitly unsupported. ACP uses a negotiated Pi profile over ACP v1, not a generic-client compatibility claim.

## Semantics and limits

- Every mutation names a caller-chosen `command_id`; session mutations also name `worker_epoch`, `session_id`, `binding_revision`, and a source leaf for fork. Retry only the exact request with that ID, or read its receipt. Duplicate lookup never retries an effect; conflicting reuse refuses.
- CLI binding lookup is a convenience. To send a previously captured binding, pass **all** `--worker-epoch`, `--session-id`, `--binding-revision` flags. A delayed old binding refuses `no_effect`, naming the old/current revisions.
- New, fork, and same-process resume use Pi RPC and bump the binding revision, invalidate interactions, and publish `session_rebound`. Second live session bindings name their holder; canonical exclusive cwds are reserved. SDK/ACP tree navigation uses `rebind --action navigate --entry-id ENTRY --source-leaf-id CURRENT_LEAF`, bumps the binding and invalidates live interactions. **Pi 1.5.2 RPC tree navigation refuses explicitly.** A `/new` UI action uses typed `sessions.rebind(action=new)`, not raw slash-command forwarding.
- Admission, execution start and `agent_settled` are separate. `agent_end` is not settlement. Delivered input can still have a later unknown execution. Reads never append control records; derived leaf/history changes publish memory-only evidence.
- Unknown session mutations latch a persisted fence. New writes refuse `no_effect` naming its cause. Pending follow-ups/child launches pause. Reads, cancel, interrupt, stop and evidence reports remain available. Resolution checks exact binding, command **or** execution, and generation; records keep/abandon/observed; never claims external effects undone. `observed` requires exact session-file attribution or a fsynced settlement record for that execution, not arbitrary text, admission or an unknown dispatch marker.
- Follow-ups and pending child launches are supervisor-owned, capped at 32, and not sent into Pi's unpausable native queue. Payloads are memory-only. Restart turns undispatched intent into `intent_recovered/no_effect`; owner `keep` enables an exact retry once (`intent_ready`), never automatic replay. A ready live host/current binding is still required. Full post-restart relaunch/resume remains blocked by unproven descendant cleanup.
- One **supervisor-wide** SSE endpoint, `/v0/events`, with `worker_id` and `types` filters. Each subscriber has at most 64 queued events/256 KiB, plus bounded in-flight transport data. Overflow sends an `overflow` frame and closes; the client requires a fresh snapshot before controls. `watch '*'` watches all authorized workers. Every reconnect snapshots; there is no historical event replay or retained ring. The legacy cursor field `worker_epoch` means **transport epoch**, changes per supervisor start, and is not the binding epoch.
- Client writes use `agent:false`, one attempt, and typed `ClientFailure`: before connect/write = `no_effect`, after attempted write = `unknown`, server refusals preserve their label/details. Disconnect never cancels work.
- Restart never adopts Pi. Linux process groups are cleaned up, but escaped descendants remain **unproven**; replacement environments stay reserved. No cgroup/bwrap guarantee, macOS coverage, bridge, child result FD, production approval policy, or exactly-once external effects.
- Journal: 32 MiB, no compaction/eviction; 512 ordinary receipts. Stop, cancel/interrupt, resolution and evidence reports bypass the ordinary count quota, **not** byte/storage failure. Result reservations are not whole-chain reservations; disk/fsync failure can still block durable control replies.

`hello` names these limits, same-user access, BYO journal machine loss, and Linux ≠ macOS. Normal Pi resource discovery runs; never use sensitive state. `openapi.json` is the draft B2 surface; `npm run generate` regenerates `src/api.generated.ts`, and `npm run check:generated` checks drift.

## Evidence

See **[A0-SLICE3.md](A0-SLICE3.md)** for 105 tests on both machines, 256 scenario/recovery fsync cuts, 21 native-effect cuts, real-pi host comparisons and remaining gaps. **[A0-SLICE2.md](A0-SLICE2.md)** preserves the invariant/transition evidence and its superseding fix round (82 tests, 172 fsync cuts). The shared fixture table and replay format are in `src/test/fixtures/`. `A0_TRACE_FSYNC=1` emits point ordinals/labels; `A0_CRASH_INDEX=N` or `A0_CRASH_AT=LABEL` deliberately SIGKILLs after a real fsync. **Do not enable injection on valuable state.**

Earlier evidence stays in `A0-SLICE1.md`. Intended license: MIT (nubl decision R21); add LICENSE before making this public.
