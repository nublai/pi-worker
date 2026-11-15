# A0 slice 1 — THROWAWAY worker skeleton

**Status: complete for the slice 1 skeleton and requested live journey. Not production, not A0 Gate 1, and not a contract freeze.** The RPC host, private Unix HTTP/OpenAPI API, typed CLI, journal/receipts, SSE attach and Pi history work end to end. A real supervisor kill recovered the active command as `outcome_unknown`, preserved its fence, and did not replay it.

Date: 2026-11-15 UTC. Author: build leaf; no subagents or independent review (explicit leaf restriction). Runtime revision tested: **`933efbf`**, following extraction commit **`8b842a1`**. This report/evidence commit does not change runtime code. Final deployment archive SHA-256 (matched on host and VM):

```text
d88258947eb728fd0fe79fac4aafd7cb2f7bf5a1eefd1c5828feeb7f34a48d03
```

## Built

- TypeScript, Node 22+, ESM; **zero runtime npm dependencies**. Dev dependencies: TypeScript, Node types, `openapi-typescript` (lockfile committed).
- `src/host.ts`: one `pi --mode rpc` subprocess per session behind `SessionHost`. LF-only JSONL parsing, split UTF-8 handling, response correlation, request timeout, continuous stdout/stderr draining, bounded line/stderr buffers. Each bounded command is written once; no retry queue. No terminal or pane dependency.
- `src/supervisor.ts`: worker reservation, per-process epochs, expected binding validation, idle-prompt execution IDs, independent start/settlement projection, persisted fences, exclusive canonical-cwd reservation. Only `agent_settled` settles a model run; `agent_end` does not. A handled input without a run settles with an explicit disposition.
- `src/journal.ts`, `src/receipts.ts`: checksummed/sequence-checked JSONL journal, fsync per append and fsync of the containing directory at open/create. Bounded receipt/result reservation, no eviction, exact-command idempotency and conflicting-reuse refusal. Durable flow: intent → dispatch marker (`accepted`) → result → reply. No prompt or answer values in control records. Prompt request hashes are retained; no answer API exists.
- `src/server.ts`: HTTP over **only** the owned Unix socket, with owned non-symlink directory `0700` and socket `0600`; installation single-supervisor lock; JSON body/size validation; bounded SSE output. No TCP B2 listener.
- `openapi.json`: OpenAPI **3.1.0** for `hello`, `workers.create`, `workers.list/get`, `sessions.prompt`, `events.subscribe`, `history.page`, `workers.stop`, plus receipt lookup. Unsupported methods explicitly refuse. `src/api.generated.ts` is generated; `src/client.ts` is typed from those operations/schemas; `src/cli.ts` is the package's **`a0`** bin (`node dist/cli.js` works without installing the bin).
- `src/events.ts`: synchronous snapshot/history read + cursor capture + subscriber registration barrier. Every attach gives a new snapshot; only strictly later events follow it. Reentrant delivery is buffered behind the snapshot. Disconnect does not cancel work. Events have transport `{worker_epoch, seq}` and separate semantic event IDs/producer/execution IDs.
- `src/session.ts`: read-only, offset-indexed Pi JSONL reader, bounded pages, parent-chain selection, pinned watermark, oversize stubs, incomplete-tail handling. Never spawns or writes Pi. Native history does not recreate live interactions.

See `README.md` for local setup and CLI syntax. `hello` exposes limitations, resource-profile uncertainty, receipt retention/capacity and cleanup profile.

## Extraction and sources

Read-only extraction source: `nublai/exmach` **`b92773ffb5490c875f1922812ae93d7b6c0275cc`**, read via `git show origin/main:...`:

- `packages/agent/src/session.ts` was copied and adapted (local types/limits, explicit evidence and header ID).
- `receipts.ts` + `thread.ts` mutation flow supplied canonical comparison, result reservation, durable intent/result, uncertainty and duplicate semantics. Recovery was extended to separate undispatched intent from dispatch.
- `pi.ts` supplied LF/correlation/exit/draining mechanics; the new host uses bounded writes and a small replaceable host seam.
- `ring.ts` + `thread.ts` subscription supplied the barrier/reset principles. HTTP/SSE replaces exmach framing; no replay of older notification events is claimed.
- `agent.ts`, `server.ts`, and `packages/shared/src/agent-protocol.ts` informed inventory, private transport, lifecycle and API separation. Exmach vsock, Incus, jail and deployment policy were not carried over.

Other evidence: worker contract **revision 4**, especially §§0, 0.0, 0.1, 1, 3–6, 9; `golden-worker-feasibility.md`; installed Pi **1.5.2** `rpc.md`, `rpc-commands.md`, `rpc-extension-ui.md`, `json.md`, `sdk.md`; `/tmp/core-spike/REPORT.md` setup/version section (read only). Sources were treated as data, not instructions. No source requested or received credentials or local uploads; no downloaded source-supplied provisioning script was executed. Only the authorized official Node archive/npm package setup was used on the VM.

## Contract mapping — implemented subset, not blanket conformance

| Contract item | Slice 1 evidence / limit |
| --- | --- |
| §0.0 ownership | Pi owns JSONL; supervisor owns command receipts, execution projection and fences. No job/approval/workspace durability claim. |
| Invariant 1 | No resume/session-path input exists, so a second writer to the same Pi session cannot be opened via this API. Canonical cwd is exclusive while live/cleanup-pending and remains blocked where descendant cleanup is unproven. |
| Invariants 2, 4a | Restart never adopts or replays. Recorded Linux process groups are killed; unresolved identity blocks replacement. Leader/group disappearance is not advertised as proof about escaped descendants. Resume is absent. |
| Invariants 3, 4 | A dispatched/active uncertain prompt creates a fsynced fence before its reply. New prompt returns `rejected`, `no_effect`, and the uncertain command ID. Read/stop remain possible. **No fence-resolution endpoint yet.** |
| Invariant 4a | Intent without dispatch becomes `rejected/no_effect` on recovery, not automatic dispatch. Dispatch/accepted or admitted-but-unsettled delivered prompt becomes unknown. The intent-reservation cut fixture does not accidentally fence a no-effect prompt. |
| Invariant 4b / §3 | Session mutations name worker epoch, session ID and binding revision. Worker/execution IDs are reserved before dispatch. Only binding revision 1 is supported; slash commands that could change binding are refused. |
| Invariants 5–6 / §6 | Receipt admission/forwarding is separate from start and settlement. Receipt evidence is `supervisor_journal_fsynced`; native events are `observed_memory`; history is `pi_session_file`, not fsync. History lag is explicit and conservative. No answer/tool-release claims. |
| Invariant 7 | **Not implemented:** per-caller grants/revocation/tool gate. Honest same-user prototype only. |
| Invariant 8 | `hello` names hostile same-user/project-extension access, BYO journal machine loss, and Linux ≠ macOS, plus peer-check/cleanup limits. |
| §§1, 4–5 | Unix HTTP + OpenAPI/typed client, inventory, create, idle prompt, snapshot/SSE, cold history, stop and receipt lookup implemented. No bridge or ACP endpoint. |
| §9 | Evidence for parts of tests 2/5/6/11 only. Not all crash cuts, dialogs, queues, authority, sandbox, child delivery, binding transitions, or verified-PR finish line. **Neither Gate 1 nor Gate 2 passes on this slice alone.** |

## Automated verification

**13/13 tests pass** locally and on the VM's **Node 22.21.1**, with `npm test` (includes strict `tsc` build). See `evidence/local-tests.txt` and `evidence/vm-tests.txt`.

Coverage includes:

1. LF framing with U+2028/U+2029 and split UTF-8; event draining and separate `agent_end`/`agent_settled`.
2. RPC timeout and pending-request exit rejection, with no resend.
3. Canonical idempotency, including ignored transport `request_id`.
4. Intent/dispatch/result persistence order, concurrent duplicate attempts, one dispatch, conflicting content/operation refusal.
5. Rejected/no-effect versus timeout/unknown; bounded receipt count without eviction.
6. Restart recovery: undispatched intent versus dispatch marker, neither replayed.
7. Full result-room reservation refusal before any effect when the journal is too small.
8. Torn final journal record repair; complete corruption/checksum/sequence failure refuses startup.
9. SSE attach under reentrant event emission, detach/reattach, eviction and epoch reset.
10. Public HTTP client journey: native identity, duplicate, stale binding, separate admission/settlement, history, detach without cancel, stop and blocked environment replacement.
11. Active delivered prompt on crash becomes unknown/fenced; new input refuses; duplicate cannot launch a second effect.
12. Worker execution reserved before dispatch stays no-effect on recovery.
13. Pinned branch history paging and ignored partial final JSONL.

`npm run check:generated` and `git diff --check` pass. An active LSP batch returned no diagnostics but **13 inconclusive files** (push-only/silent-on-clean server); this is not claimed as LSP-clean evidence. Subsequent `tsc` checks passed, including the new host test. The temporary missing generated `uncertain_command_id` property was fixed by spec regeneration; no suppression was added to source.

## Live VM and setup

**VM left running: `a0-worker`**. Only this new VM was changed. Final supervisor remains running, all three test Pi workers are stopped, transcripts/journal/evidence are retained under `/tmp/a0/` on the VM. No API or raw worker socket was published over the network. Inspect through the exe.dev SSH gateway:

```sh
ssh a0-worker.exe.xyz
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
cd /tmp/a0/repo
export A0_SOCKET=/tmp/a0/state/worker.sock
node dist/cli.js hello
node dist/cli.js list
node dist/cli.js receipt final-crash
```

Provisioning followed `exe-dev-test-vm`:

```sh
ssh exe.dev new --name=a0-worker --comment=a0-slice1-worker --no-email --json
# Tester auth key was piped from its op vault reference over SSH stdin.
# Never printed, copied to a file, exported, or embedded in SSH command argv.
# The remote tailscale invocation used the skill's quoted shell-variable example.
# tailscaled enabled; tailscale up used --auth-key and --hostname=a0-worker.
# tailscale set --ssh=false.
```

Verified initial and final tags **exactly `["tag:tester"]`**, online true and `RunSSH:false`. A temporary health-only server bound to the VM's Tailscale IP answered `A0_NETWORK_OK` from the agent host at its tailnet name, then was stopped. This did not expose B2.

`evidence/vm-setup.sh` records the authored VM installation commands. Node **22.21.1** official `node-v22.21.1-linux-x64.tar.xz` was verified against nodejs.org `SHASUMS256.txt` before extraction (same-origin HTTPS/checksum, not an independent signature). Hash/version/package observations are in `evidence/platform.txt`. The preinstalled Pi symlink was moved to VM scratch, not overwritten blindly; the preinstalled exe.dev provider extension was preserved. Installed:

```text
Node v22.21.1
@earendil-works/pi-coding-agent 1.5.2
pi-herdr-agents 3.11.0
pi-herdr-pstack 1.0.0
```

Pi resource discovery used the ordinary CLI; the herdr config was seeded from its valid package example and exe.dev's VM-local integration preference was set to use its gateway. **No host model credentials were copied.** All real turns used **`exe-dev-anthropic/claude-sonnet-4-6@llm`**, thinking off. No OpenAI routes or child/pstack fan-out were attempted. Installed package versions are verified; a complete effective loaded-resource inventory is not.

### End-to-end CLI journey on `933efbf`

Full authored drivers plus trimmed outputs are in `evidence/`. Drivers intentionally contain this test VM's observed worker IDs and are evidence specimens, not generic reusable provisioning tools.

```sh
export A0_SOCKET=/tmp/a0/state/worker.sock
node dist/cli.js hello
node dist/cli.js create --command-id final-create --cwd /tmp/a0/workspace-final \
  --provider exe-dev-anthropic --model claude-sonnet-4-6@llm --thinking off
# worker_id: 51aaf702-e108-4fa9-8492-f0bf95dbf43c
# worker_epoch: 7478d362-cdcc-42ce-962b-f9a8b86089fc
# session_id: 01a1dd97-8cc2-704d-93cb-86fd6bc468e9; binding_revision: 1
W=51aaf702-e108-4fa9-8492-f0bf95dbf43c
node dist/cli.js watch "$W" --until-settled > /tmp/a0/final-turn-events.jsonl &
node dist/cli.js prompt "$W" --command-id final-prompt --message '<write proof.txt and reply>'
# Same exact prompt and command_id submitted twice: cmp succeeded.
node dist/cli.js history "$W"
node dist/cli.js watch "$W" --max-events 1
node dist/cli.js watch "$W" --max-events 1 \
  --worker-epoch 7478d362-cdcc-42ce-962b-f9a8b86089fc --seq 33
```

Observed (`evidence/live-turn.txt`, `detach.jsonl`, `reattach.jsonl`):

```text
prompt: state=delivered; stage=forwarded; admission=accepted; disposition=started; history_lag=true
DUPLICATE_RECEIPT_IDENTICAL
events: snapshot, agent_start, ..., tool_execution_start/end, agent_end, agent_settled
proof.txt bytes: "A0_SLICE1_FILE_OK\n"
Pi history: 7 entries; watermark fa6e2654; assistant text A0_SLICE1_REPLY_OK
settled worker: foreground=idle; execution.state=settled; history.lag=false
reattach: snapshot; cursor {worker_epoch:7478d362-...,seq:33}; resync_reason=current
snapshot history: {last_entry_id:fa6e2654,lag:false,evidence:pi_session_file}
```

The initially allocated Pi ID was later checked against the **actual Pi JSONL header**, not inferred from its filename. Before the first turn Pi had not written that header file; see the identity deviation below.

### Crash/no-replay journey

`evidence/crash-driver.py` attached through the CLI, admitted `final-crash`, and asked Pi to run a Node tool that appended `ONCE\n` to `crash-start.txt`, printed `CRASH_BLOCK_STARTED`, then blocked for 120 seconds before a final write. The driver matched **actual `partialResult.content` text**, independently verified the start file, then sent **SIGKILL** to supervisor PID **1087**. It did not kill Pi first. `evidence/live-crash.txt` records that observation.

After restarting the same supervisor state directory:

```sh
A0_STATE_DIR=/tmp/a0/state node dist/main.js
node dist/cli.js receipt final-crash
node dist/cli.js prompt "$W" --command-id final-crash --message '<same exact original text>'
node dist/cli.js prompt "$W" --command-id final-fenced --message 'Must be refused without effect'
node dist/cli.js history "$W"
node dist/cli.js watch "$W" --max-events 1 --worker-epoch "$E" --seq 33
node dist/cli.js stop "$W" --command-id final-stop
```

Observed (`evidence/live-recovery.txt`, `recovered-attach.jsonl`):

```text
supervisor_epoch: 20bcc040-... -> b6539e52-...; native session_id unchanged
journal final-crash states: intent -> accepted -> delivered -> outcome_unknown
receipt: outcome_unknown; stage=unknown; effect=unknown; original admission=accepted retained
RECOVERED_DUPLICATE_RECEIPT_IDENTICAL
new prompt: rejected/no_effect; error=session_fenced; uncertain_command_id=final-crash
fence: command_id=final-crash, fence_generation=1
start effect count: 1; original crash prompt in Pi history: 1
crash-finished.txt absent; no prompt text in control journal
worker cleanup: process_group_observed_gone; escaped_descendants_unproven
stop: delivered; stage=termination_observed; result.termination=observed_stopped; profile=process_group_only
replacement on same cwd: rejected/no_effect; exclusive_environment_already_bound
modes: state=700, worker.sock=600, journal.jsonl=600
```

Restart does not infer that a possibly partial external effect was undone. The recovered snapshot retains unknown/fence/history-lag state. Its old cursor is explicitly reset with reason `ahead`; no older events or notification transitions are replayed. A separate **fresh live Pi worker** was then created and stopped via the CLI to exercise actual live termination, not just the already-stopped recovery record (`evidence/live-stop.txt`). Final process inspection saw one Node supervisor and no live Pi process. A later check past the tool's 120-second deadline still found exactly one start effect and no finished file (`evidence/post-deadline-check.json`).

### Corrections and limits of the experiment

- First SSH attempt to the fresh VM hit `Host key verification failed`. New-host trust was accepted into `/tmp/a0/known_hosts`, not the host's normal SSH known-hosts file; subsequent calls used that file.
- A plain VM SSH shell lacked Node on PATH. All actual worker/build/test commands explicitly prepended the installed Node 22 path.
- **Earlier crash-driver failure:** it searched the whole tool-update JSON, so it matched the marker in echoed tool arguments while `partialResult.content` was empty. Supervisor was killed, but the subsequent start-file assertion failed with `FileNotFoundError`. That run proves uncertainty recovery only, **not a started external effect**. The corrected final driver matched actual result text and checked the file before killing; the successful evidence above is from the final revision and a fresh worker.
- The `kill`/restart was real; no model completion message is used as proof of file content, idempotency, termination or journal state.
- No operator intervention was requested. This is not a verified-PR attention baseline: no PR/job was attempted. A0's full attention/verified-change measure remains open.
- No independent review was launched. Local self-review and public-surface tests are the verification available in this leaf.

## Deviations and open work for slice 2+

1. **Fence resolution absent.** A fence cannot be lifted through this API. Implement `sessions.resolve_unknown` with epoch/session/binding/generation checks and keep/abandon/observed semantics before allowing resumed writes. No automatic retry/replay is permitted in this prototype. Undispatched recovered intent is conservatively finalized no-effect; the owner-resolution dispatch path is not implemented.
2. **Cleanup is Linux process-group-only, not a cgroup guarantee.** Escaped/detached descendants are unproven. Environment reuse is therefore blocked after group-only cleanup; resume is wholly unsupported. A crash between spawn and durable process identity leaves cleanup pending and blocks replacement. Add a real cleanup provider and exercise detached-grandchild/process-identity cuts before Gate 1. Stop reports observed group termination, never all external effects stopped.
3. **Binding transitions are absent.** `/new`, fork, tree navigation, resume, slash commands, steer and follow-up refuse/are unsupported; only initial binding revision 1 and idle prompts are supported. Native header identity is allocated by Pi and returned through `get_state` before the first session-file write; the public `session_identity_evidence` honestly says `pi_rpc_header_id` until the actual JSONL header is observed and checked. Never write a fake header to satisfy identity initialization. Start-failure stop/control without a bound session also needs refinement.
4. **Authority/dialogs/readiness need the next slice.** No grants, revocation, native SO_PEERCRED check or privileged tool gate. Filesystem ownership is the only B2 access check; hello advertises that. Standard startup/runtime dialogs are surfaced as observed native events/IDs but cannot be answered or reliably closed; custom UI has RPC's known unsupported behavior. No exact resolver acknowledgement is claimed. Ready means successful initialized `get_state` with no observed blocking startup dialog, not a complete effective-resource audit. SDK/ACP host comparison belongs to the later host slice.
5. **Readback/backpressure remains prototype-grade.** Every reconnect takes a fresh authoritative snapshot instead of replaying historical live events; transport sequence/ring is memory-only. Archived workers reset snapshots after supervisor restart; no Pi process is adopted. History uses the latest appended leaf (no supported navigation), with bounded oversize stubs but no `items.read` retrieval. Slow-client stress, large tool payloads, interaction expiry, history-lag edge cases and every §0.1 transition fixture remain to be proven.
6. **Storage limits are explicit, not production retention.** 512 receipts, 16 KiB receipt result bound, 32 MiB journal; no automatic eviction/compaction. Final receipt room is reserved before effects, but disk/fsync failure still fails closed and can block startup/recovery until storage is repaired. No power-loss/device-loss, all-cutpoint crash, platform-portability or malicious same-user isolation claim.
7. **Remaining A0 scope is not done:** scoped authority, concurrent answer races, SDK resolver settlement, child launch/report lineage, bwrap, retained worktrees/pstack fan-out, images, cancel/interrupt controls, loaded-resource inventory, verification evidence bound to a real change and the verified draft PR finish line.

**Scope/accounting:** repository writes/commits were confined to this branch; experiment state to `/tmp/a0` and the new VM. No pushes, PRs, merges, other VMs/checkouts or host Pi/herdr/Tailscale config changes. The initial host dev-dependency install/check commands used npm's default cache/log location (an incidental write outside the requested scratch boundary); later final npm verification explicitly used `/tmp/a0/npm-cache`. No host credentials were read/copied for model use. No cleanup of unrelated cache/state was attempted. Reusable skill persistence was skipped because the task restricts writes to the worktree/VM/scratch, not the host's tool-managed skill store.

## Fix round — 2026-11-15

**Complete for the requested fixes; still THROWAWAY, not Gate 1 or a contract freeze.** This section supersedes the original report's receipt-rewrite, terminal-undispatched-intent, cursor-reuse and dialog-lifecycle claims above. The original evidence is retained as historical evidence, not relabeled as proof of the fixed behavior.

Baseline: `efa34f1`. Reviewed against `/tmp/a0/review-slice1.md` (independent Opus review, proceed after fixes) and worker contract **revision 5**, especially §§0, 0.1, 1, 5 and 6. No subagents launched. Implementation commits: `e3145e4`, `e660a18`, `f2084be`, `3b41531`; verification drivers: `df2c483`, `efa9c55`. Live tree: **`efa9c55`**, runtime unchanged since `3b41531`. Subsequent evidence/report edits do not change runtime code.

### Finding → fix → regression fixture

| Finding | Fix | Test / evidence |
| --- | --- | --- |
| **M-1** receipt finality | `ReceiptStore.put` refuses rewriting a final receipt. `unknown()` only finalizes an accepted/dispatched command. A delivered admission stays delivered; execution uncertainty and its fence are separate fields in fsynced worker records. Exit while awaiting an RPC cannot overwrite an already-final receipt. | `crash after admission while running`, `Pi exit fences an admitted run durably without rewriting delivered admission`; receipt-store finality assertions. Live journal is exactly `intent → accepted → delivered`, with execution `outcome_unknown` recorded separately. |
| **M-2** stable fence | Only unknown **session prompts**, not stops, feed recovery fences. The fence preserves its primary command and all uncertain command IDs. The same uncertainty never increments generation or re-persists an unchanged fence; another uncertainty is retained, not silently substituted. | `unknown stop never replaces the prompt fence; two restarts preserve fence and delivered receipt`; repeated-restart fixture and live recovery plus two more SIGKILL/restarts, all generation 1. |
| **M-8** recovery bucket 4a | Undispatched intent becomes non-terminal `intent_recovered / recovery_pending / no_effect`. Duplicate lookup returns that state; direct dispatch is blocked until an explicit owner-resolution path is added. It is not a terminal rejection and remains eligible for the future dispatch-once/abandon decision. No automatic dispatch. | `execution reservation cut before dispatch stays no_effect on recovery`: copies the actual fsynced journal immediately before the accepted append, not a synthetic rewind of a delivered receipt. Receipt recovery is idempotent. **Preparation only** for slice 2 resolution; no resolve endpoint added. |
| **M-3** transport identity | Each hub uses `supervisor_epoch:worker_epoch` as its transport epoch. Binding worker epoch is unchanged; the cursor's legacy `worker_epoch` field is explicitly documented as transport identity. | `transport epoch changes across supervisor restart even when new seq catches the old cursor`; three distinct live transport epochs for the same binding. |
| **M-4** missing projections | Every successful worker persist publishes a full `worker_changed`, `producer=supervisor`, `evidence=supervisor_journal_fsynced` projection. Refresh-driven history/identity changes are also persisted/published. Admission, settlement, fence, ready, cleanup and stop no longer depend on a reconnect to become visible. | `supervisor projects admission, settlement, fence and stop to an already connected watcher`; live connected watcher sees a new fence transition and stop event. This is still per-worker streaming, not slice 2's supervisor-wide stream. |
| **M-5** event-path exceptions | Per-worker guards cover Pi events, exit and inventory refresh. A fault closes the worker, fences its execution, clears interactions and attempts group cleanup without throwing out of the EventEmitter callback. Unavailable storage produces only an `observed_memory` fault event, never a false fsync claim. Journal failure refuses new mutations globally; inventory and other streams stay alive. | `journal/header failure in a Pi event faults only that worker and keeps inventory readable`: two workers, faulting host stopped, other host untouched; healthy worker still accepts input after a header-only fault. |
| **M-6** receipt capacity / refusals | Validation runs atomically immediately before intent/effect, after duplicate lookup. Stale binding, fenced, busy and other pre-dispatch validation refusals write **no durable receipt**. Stop bypasses the ordinary 512-receipt count quota; the duplicate byte/count check is removed. The 32 MiB physical journal limit still applies; this is not a promise of durable replies on disk failure. | `validation refusals consume no durable storage, ordinary capacity never blocks termination`: 520 stale attempts leave journal bytes unchanged, then 512 ordinary receipts fill the real quota and stop is still delivered. |
| **M-7** weak tests | Added public HTTP unknown/fence ordering tests, journal-observing prompt host, exit fencing, private-directory refusal and real SSE response-overflow checks. Replaced the synthetic reservation-cut fixture with a real append-boundary journal snapshot. | All six requested surviving mutations now fail named assertions; full results below. |
| **m-1** failed-create cwd release | Create failure records the same `escaped_descendants_unproven` cleanup as stop, keeping the cwd reserved even after observed group disappearance. | `failed create preserves the same group-only cleanup and cwd reservation as stop`. |
| **m-2** ghost/unbounded interactions | At most 32 pending unsupported native dialog IDs. Every dialog is automatically cancelled with the exact native ID using a **one-way** `extension_ui_response`, not an RPC response waiter. Entries close after cancellation forwarding, tool end, settlement, expiry (maximum 30s), exit or fault. Failed cancellation/capacity overflow faults closed; an unsupported startup dialog prevents ready. No answer method or resolver-consumed claim added. | Host cancellation wire fixture; all four dialog kinds; tool-end, settlement and expiry fixtures; bounded pending/cancellation-failure fixture. |

### Verification and mutation results

- **32/32 tests pass locally and on a0-worker, Node 22.21.1.** `npm test` includes strict TypeScript compilation. Local final commands used `TMPDIR=/tmp/a0` and npm cache `/tmp/a0/npm-cache`. VM dependencies used the same npm cache and `--ignore-scripts`.
- **`npm run check:generated` passes** locally. Regeneration on the VM is byte-identical to the deployed generated file (the deployment directory is not a Git checkout). `git diff --check` passes.
- Active LSP checks returned zero findings, with some TypeScript files **inconclusive** because the push-only server cannot confirm clean. This is not claimed as a complete LSP-clean result; strict `tsc` passes.
- Original receipt-finality regression first failed against the baseline (delivered changed to unknown), then passed after the fix. Current mutations are independently applied to scratch copies of the current tree; every mutation site is checked unique and written to `mutation.json`. `/tmp/a0/mut` was read, never modified or executed.

Authored driver: `evidence/mutation-fix-round.mjs`. Final scratch artifacts: `/tmp/a0/fix-mutations-38iEes`; concise results: `evidence/fix-round/mutation-results.txt`.

| Review mutation | Result | New fixture that kills it |
| --- | --- | --- |
| **M1**, omit live unknown-reply fence | **killed** | Both HTTP timeout/stdin-failure tests inspect disk at response headers, before their HTTP result promises resolve. |
| **M2**, dispatch marker after prompt send | **killed** | Journal-observing host requires the last fsynced record to be accepted with the reserved execution ID **inside** `request(prompt)`. HTTP ordering fixtures also fail. |
| **M3**, remove append fsync | **survives, expected limitation** | Neither parsing a journal nor SIGKILL proves physical flush durability. No power-loss/fsync-interception proof claimed. |
| **M4**, remove SSE overflow close | **killed** | Paused real HTTP subscriber; synchronous response queue exceeds 1 MiB and must be destroyed without stopping the worker. Explicit overflow frame remains deferred m-4. |
| **M5**, remove socket-directory checks | **killed** | Symlink, 0755 and foreign-owner refusal fixture. |
| **M6**, omit durable fence persist | **killed** | Both HTTP timeout/stdin-failure fixtures require the fence and uncertain execution in the on-disk journal at response headers. |
| **M7**, settle on agent_end | **killed** | Existing public journey plus new watcher/fault fixtures. |
| **M8**, remove stale-binding refusal | **killed** | Existing public journey plus validation/capacity fixture. |
| **M9**, omit unknown/fence on Pi exit | **killed** | New Pi-exit durable-fence fixture, unknown-stop/restart fixture and connected-watcher fixture. |

### Live evidence on the existing a0-worker VM

Only `a0-worker.exe.xyz` was used. Fresh deployment `/tmp/a0/fix-repo`, fresh final state `/tmp/a0/fix-live-jwSBaU/state`; no Pi/herdr configuration or credentials were read/copied/changed. Live driver: `evidence/live-fix-round.mjs`. The VM's already-installed Pi/provider route was reused, with `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking off, no delegation.

Deployment archive SHA-256 matched on host and VM:

```text
9335b63af6f033059d2265b3a944131339b1173dafd411cadb26399775e74a80
```

1. Attached a watcher, admitted `fix-crash`, observed **actual tool partial-result text** `FIX_CRASH_BLOCK_STARTED`, and independently read the file as exactly `ONCE\n` before SIGKILL of the supervisor. Echoed tool arguments were not used as proof.
2. Recovered once, then SIGKILL/restarted **twice more**. At every start, receipt lookup **and duplicate submission** deep-equaled the original pre-crash delivered receipt. Execution is unknown, fence is always `{command_id: fix-crash, fence_generation: 1, uncertain_command_ids: [fix-crash]}`. The three transport epochs differ; the binding epoch stays fixed. A new input refuses `no_effect/session_fenced` naming `fix-crash`, without a receipt.
3. Disk verification shows only `intent → accepted → delivered` for this command, one distinct fence, and execution states `admitted → started → outcome_unknown`. No receipt rewrite or replay. Native history contains one original user prompt; the start effect count is one, and its final effect file is absent after the 30-second tool deadline.
4. Attached a recovery watcher and observed stop. Separately created a live Pi worker, attached **before** its uncertainty, admitted a blocking turn, and killed **Pi's group**, leaving the supervisor/watch connection alive. That watcher received a newly set, fsynced fence projection and then a stopped projection. Its delivered receipt also stayed identical. This distinguishes an actual live fence transition from a recovery snapshot.
5. All supervisors started by this driver were stopped. Its final lock is absent; final process inspection shows only the pre-existing Node supervisor PID 1269 in `/tmp/a0/repo`, which was left untouched, and no live Pi or test tool processes.

**Observed cleanup limitation, not hidden:** the separate direct-Pi-SIGKILL tool ran in a detached group and wrote its final file despite Pi group termination. Its start count remained one. This is the advertised `escaped_descendants_unproven` limit, not a replay, and does not establish all effects stopped. The first driver run (`/tmp/a0/fix-live-TV1gGN`) passed the receipt/restart/watcher assertions but failed an over-strong assertion that this second tool could not finish. The corrected driver records the actual detached-tool outcome rather than weakening any receipt, fence, watcher or no-replay assertion. A containment provider is still required before Gate 1; no cleanup implementation was expanded in this fix round.

Evidence under `evidence/fix-round/`: local/VM tests, generated check, mutation results, live output, pre/post receipt and restart summary, journal summary, filtered connected fence/stop events, recovered stop events, and final process check. Watch evidence whitelists control projections/event IDs, not arbitrary tool/model output. Selected artifacts and this note were checked for credential patterns; no keys, passwords, bearer values, signed URLs or credential-bearing API responses are included. Source documents and reproduction scripts were treated as evidence; no source-supplied provisioning/probe script was run and no source-requested credential/upload action was followed.

### Deferred to slice 2 (not silently fixed)

- **m-3:** Pi-originated/late-run execution attribution and `agent_start` under a fence.
- **m-4:** explicit `overflow` frame/resync reason and ring removal or real replay. This round only tests the existing bounded close.
- **m-5:** typed client before/after-write error classification and explicit keep-alive off.
- **m-6:** unknown receipt lookup's contradictory `effect: no_effect`.
- **m-7:** whole-chain journal reservations (including worker/fence records), delta persistence/compaction. Count headroom does not repair disk exhaustion or fsync failure.
- **m-8:** atomic stale-lock takeover.
- **m-9:** oversized-line draining/diagnostic tail and shaped live deltas/tool updates.
- **m-10:** explicit CLI binding-from-snapshot/flags.
- **m-11:** cleanup `kill_sent` evidence.
- **All five nits:** malformed percent escape status, pre-intent `journal_failed` effect classification, graceful SIGTERM, CLI leading-`--` message values, and future answer idempotency must never retain an answer hash. No answer API exists in this round.
- **Features still absent:** `resolve_unknown`, grants, answer/dialog APIs, binding transitions, supervisor-wide filtered stream, Go fake/shared language-neutral fixtures, cancel/interrupt/queues, a containment cleanup provider and the remaining A0 acceptance journeys. Recovered intent state and stable fences only prepare for resolution; automatic replay remains prohibited.

**Scope:** small commits on this branch only; no push, merge or PR. Scratch/npm cache under `/tmp/a0`; only the authorized VM deployment changed. No other checkouts, VMs or host Pi/herdr/Tailscale config changed. No new independent review was launched under the build-leaf restriction. The reusable verification procedure is retained in the two repository evidence drivers; no external skill-store writes were made.

