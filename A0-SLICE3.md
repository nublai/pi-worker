# A0 slice 3 — hosting pi and interactions

**Complete for this throwaway slice. Recommend a dedicated SDK subprocess as the production host.** It owns exact dialog resolvers, can answer during startup, and supports native tree navigation. RPC cannot prove consumption and lost the tested startup answer. ACP can prove the same facts as SDK, but needs a negotiated Pi-specific profile without adding a capability this worker needs. This is **not** production approval or an A0 Gate 1/contract freeze.

Date: 2026-11-15. Base: `09dc809` (`a0/slice2-invariants`). Original runtime/live verification: `ce5a2dff90c30e2a63c6ea7eb963a7f1d63df517`. **The Fix round below supersedes that revision and its test counts; current verified runtime is `4b40c475c63e0e81d0c5147b17ac35ce0a935fe1`.** No subagents or independent reviewer were launched by this builder, as required by the leaf assignment.

## Host versus capability

All observations below use real Pi **1.5.2** on the existing `a0-worker` VM, Node **22.21.1**, provider/model `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking off. Sources: [live driver](evidence/slice3/live.mjs), [native-result specimen](evidence/slice3/dialog-extension.ts), [sanitized comparison](evidence/slice3/live-summary.json), [VM output](evidence/slice3/vm-tests-and-live.txt).

| Capability | RPC subprocess | SDK subprocess | ACP v1 → our SDK adapter |
|---|---|---|---|
| Own isolated pi process, no terminal pane | Yes | Yes | Yes |
| Select / confirm / input / editor | All four, stage **2** | All four, stage **3** | All four, stage **3** |
| Duplicate select labels / editor prefill | Offered IDs distinguish worker records, not identical labels returned to the native extension; prefill observed | Same | Same |
| Confirm No / cancel / timeout | Worker records distinct outcomes; native extension sees `false` for all three; consumption unproven | Host records distinct resolver outcomes; native boolean API still returns `false` for all three | Same as SDK |
| Startup dialog | Stage 2 forwarding; native answer **not received**, hook expired | Answer received, stage 3; then ready | Answer received, stage 3; then ready |
| Two-client answer race | One winner, one refusal | Same | Same |
| Answer after deadline | Refused without dispatch | Same, plus native atomic deadline check | Same as SDK |
| Lost host result after real resolver consumption | Unknown, fence, one native effect, no replay | Same | Same |
| Tree navigation | Explicit `no_effect` refusal | Real `navigateTree`; binding 1→2; native/worker leaf agree; old answer refused | Same via negotiated command |
| Typed test bash approval | Not provided | Stage **3** answer, separate stage **4** release receipt | Same; uses ACP permission request |
| Revoke / change policy / expire before release | Not claimed | All deny; protected artifact absent | Same |
| Revoke **after supervisor check**, before child delivery | Not claimed | Child's final grant check denies | Same |
| Custom UI | Observer emits explicit unsupported event; upstream still returns `undefined` | Host emits explicit unsupported event and rejects `custom()` | Same as SDK |
| Loaded pstack / pi-herdr-agents | Registered tools/commands and 81 skills observed | Exact extension paths, 81 skills, tools observed; no loader errors | Same as SDK |

**Startup finding:** Pi's RPC mode awaits `bindExtensions()` before attaching its stdin command reader (`rpc-mode.js`, Pi 1.5.2). A `session_start` dialog can emit a request while its response remains buffered on stdin until the hook times out. The test exposes the real session identity before that hook, so the worker can accept/forward an answer; the independent native result still proves it was not consumed. SDK/ACP install their stdin reader independently and allow answers while binding awaits the resolver. No RPC stage-3 claim is inferred from a successful write or a later tool result.

## Built surface and invariants

- **Hosts:** `src/host.ts`, `src/library-host.ts`, `src/sdk-child.ts`. `workers.create.host` selects `rpc|sdk|acp`; default remains RPC for compatibility. SDK is pinned to `@earendil-works/pi-coding-agent@1.5.2`. Each worker gets a detached child process group and its own Pi session directory. LF framing, correlation, bounded inbound lines/stderr, exit rejection, and no retry remain behind `SessionHost`.
- **Explicit project trust:** `create.project_trusted` defaults false. RPC uses `--approve`/`--no-approve`; SDK uses the corresponding `SettingsManager` option. No global trust setting changes. SDK/ACP explicitly supply codemode, tool-search and MCP builtin factories; they are not magically present in a bare SDK session.
- **Interactions:** `src/interactions.ts`, `src/resolvers.ts`; generated OpenAPI types, hand-written HTTP routing/client, and CLI `interactions`, `answer --answer-file`, `interaction-status`. Startup workers are observable before create returns. A complete captured binding is required for answers; the CLI never refreshes an old answer's binding silently.
- **Atomic validation:** path worker, worker epoch, session, binding revision, interaction ID and content revision, kind, offered option ID, absolute deadline, and value shape/64-KiB UTF-8 limit. Empty text is valid; booleans stay booleans; cancel cannot carry a value. Select IDs are canonical offered indices, not labels. A synchronous pending→accepted claim precedes the first await. The SDK registry separately compare/deletes the exact resolver, including native timeout and AbortSignal races.
- **Stages:** `answer_stage=1` / `answer_accepted` is journaled before dispatch; a dispatch marker precedes the child write. RPC returns stage 2 after flush. SDK/ACP return stage 3 only for the exact resolver's positive consumption acknowledgement; an expired/refused resolver stays at stage 2. The separate `ANSWER_ID:release` receipt reports stage 4 only when the gate positively acknowledges release. Denial records `released:false`; no stage 5 is claimed.
- **Privacy/idempotency:** durable interactions contain identities, kind/source, binding, deadline, outcome, authenticated actor/grant ID, and stage. They contain neither answer text nor an answer-derived hash. Answer receipt hashes cover **metadata only**. Conflicting private values are compared in live memory. After restart, an existing `answer_id` returns its recorded receipt without validating or dispatching the supplied value, even with a different wire-attempt command ID. Cross-worker/binding/interaction reuse still refuses.
- **Snapshots:** worker reads and the SSE attach barrier overlay complete live interactions (including prefill/options) from memory. Worker journal snapshots store metadata only. `interactions_changed` carries current live cards; `interactions.status` returns durable outcome metadata. History cannot recreate a pending resolver. Pending questions become interrupted after restart; final ordinary answer receipts remain final.
- **Navigation:** SDK `AgentSession.navigateTree()` is real, not a fabricated RPC command or JSONL rewrite. Binding changes cancel/invalidate live questions, require the current source leaf, bump the revision, and preserve PID/session identity for navigation. `SessionIndex` now accepts the native selected leaf; append order is not used as a substitute for SDK tree selection. Pinned old history watermarks remain valid.
- **Readiness/recovery:** RPC's own audit extension must report registrations; SDK/ACP inventory must succeed without extension loader errors before ready. Old groups are killed on supervisor recovery, never adopted. Unknown answer/release/rebind receipts fence alongside prior prompt/lineage uncertainty. All 82 pre-slice tests remain passing. Process-group cleanup still does **not** prove absence of escaped descendants or authorize environment reuse.

The question payload itself is memory-only; the conversation may record an answer in native Pi entries/tool results. The live specimen's `.a0-dialog-results` is a separate synthetic native-effect artifact, not a worker control record and not a receipt-stage source.

## Test approval gate

The small inline SDK test extension intercepts `tool_call` for **bash** only in a workspace with `.a0-gate-policy`. It requests a typed `tool_approval`, not a selector with a special title. Missing policy means the specimen is not enabled; malformed enabled policy blocks. This opt-in fixture is **not a production approval policy or sandbox**.

Its binding includes the actual bash-input SHA-256, operation/resource/environment, offered scope `once`, policy revision, expiry and a unique gate token. Answer metadata records the actor/grant ID. At release:

1. Supervisor rechecks the saved caller guard, fence, worker/session/binding, consumed Allow outcome, input digest, policy, scope and expiry.
2. A separate release intent/dispatch record precedes delivery to the child.
3. The child rereads the actual grant file (identity, method, scope and revocation), current policy and expiry, and rehashes the actual tool input immediately before its hook releases the call. No await intervenes between final validation, gate acknowledgement and permission return.

For **both SDK and ACP**, the Allow case produced stage 3 then stage 4 and the independently read `gate-proof.txt` artifact. Revocation between answer and release, revocation after supervisor checking but before child delivery, changed policy, and expired policy all produced no release and no artifact. Fake-host tests also change the digest, binding and fence. Allowing this test gate is not evidence of external-effect completion or authority to merge/deploy.

## ACP profile, not an ACP-shaped label

`src/sdk-child.ts` is our adapter; no community adapter is used or depended on. Worker↔adapter is JSON-RPC 2.0 / LF-delimited stdio, negotiating **ACP protocolVersion 1** and `_meta.piWorkerProfile=1`.

Standard vocabulary exercised:

- `initialize`, `session/new` with cwd and no client MCP servers;
- `session/prompt` with text content, final `stopReason` response;
- `session/update` for actual assistant text deltas;
- `session/request_permission` and selected/cancelled permission responses for typed tool approvals.

The adapter also implements standard `session/cancel` notification; worker control requests currently use the profile command channel to retain a correlated control receipt. The recorded live frames were validated against the **official** `@agentclientprotocol/sdk@2.7.0` stable **v1** schemas, a dev/test dependency. Final run: 7 initialize pairs, 7 new-session pairs, 16 prompt requests, 11 final prompt responses before stops, 2 text updates, 5 permission request/response pairs; **zero schema failures**. Stops can end outstanding turns; this is not a claim that all prompts completed normally.

Negotiated extensions, documented rather than disguised as standard ACP:

| Extension | Purpose |
|---|---|
| `_pi/dialog` server request | Lossless select/confirm/input/editor fields and native ID/deadline |
| Response `_meta.piAnswer`, `_meta.ackId` | Worker answer plus a separately correlated resolver acknowledgement |
| `_pi/consumed` notification | Exact resolver consumption/refusal; same owned SDK registry |
| `_pi/admitted` notification | Early input disposition, distinct from ACP's final turn response |
| `_pi/event` notification | Native Pi lifecycle/identity/leaf/gate events not represented by text chunks |
| `_pi/command` request | State, inventory, rebind/navigation and correlated control operations |

This is an explicitly profiled **worker-to-agent** boundary, not B1. Four dialogs and early admission are not represented by pretending all interactions are ACP permissions. No generic ACP editor interoperability, multi-session multiplexing, arbitrary client filesystem/terminal access, session-load catalog, binary attachments or ACP auth flow is claimed.

## Actually loaded resources

The inventories are **snapshots**, not a universal equivalence claim. Full names/paths are in each host's `resources` in [live-summary.json](evidence/slice3/live-summary.json).

| Host | Observed resources |
|---|---|
| RPC | Source-attributed registrations from `npm:pi-herdr-agents@3.11.0`, `npm:pi-herdr-pstack@1.0.0`; extension commands from `.../pi-extension/subagents/index.ts`, `.../pi-extension/pstack/index.ts`, `builtin:llama.cpp`, `builtin:mcp`. Codemode/tool-search tools registered. Our CLI audit extension and the exercised dialog specimen loaded. 88 commands including **81 skill commands**. RPC does not expose an exhaustive extension-loader inventory. |
| SDK | Exact loaded paths: workspace `.pi/extensions/dialog.ts`; `~/.pi/agent/extensions/exe-dev/index.ts`; herdr `pi-extension/subagents/index.ts`; pstack `pi-extension/pstack/index.ts`; `builtin:codemode`, `builtin:tool_search`, `builtin:mcp`; `<inline:1>` (our test gate). **81 skills**, from the herdr and pstack packages; **zero loader errors**. |
| ACP | Same eight extension entries and 81 skill names as SDK; **zero loader errors**. Adapter owns these resources, not the worker parent. |

All three registered the same **20 tool names**:

```text
read bash powershell edit write grep find ls
worktree_list worktree_remove subagents_write_task_models
subagent subagent_send subagent_stop subagent_interrupt subagent_cancel
subagents_list subagent_resume codemode tool_search
```

Active-tool snapshots differed: RPC had `read bash edit write tool_search`; SDK/ACP had `read bash edit write`, the two worktree tools, and the seven subagent lifecycle tools listed above. Registration is not activation. SDK/ACP do not presently reproduce CLI `builtin:llama.cpp` discovery. No MCP server connection parity or model-routing configuration change is claimed. The successful actual provider turns and loaded pstack/herdr registrations are proven; pstack child fan-out was neither authorized nor attempted here.

## Verification and crash accounting

**105/105 tests pass locally (Node 26.13.0) and on the VM (Node 22.21.1)**, including strict TypeScript compilation. `check:generated` and `git diff --check` pass. Active LSP probes were inconclusive/silent-on-clean, not counted as clean evidence; `tsc` is the typecheck evidence.

| Evidence | Count and scope |
|---|---|
| Existing slice-2 matrix | 172 fsync cuts and 12 native-effect cuts; plus its two queue-readiness cuts |
| New interaction matrix | **77 scenario + 7 recovery fsync occurrences**; new interaction metadata, accepted/outcome writes, timeout-cancel markers, answer/release receipts and navigation paths |
| New native-effect cuts | **9**: four resolver consumptions (including cancellation/approval), two gate decisions, timeout cancel, rebind cancel, navigation |
| Totals | **256 fsync cuts, 21 native-effect cuts**, plus the existing queue-readiness checks; bounded scenarios, not every possible state/path |
| Real supervisor crashes | **9**, all three hosts at answer receipt intent, dispatch/accepted and delivered/result fsyncs |
| Deliberately lost host result | All three real hosts: native resolver effect exactly once, answer unknown/fenced, duplicate unchanged; no blind replay |
| Killing mutations | **6/6**: missing deadline, missing answer dispatch marker, answer-derived receipt hash, second winner, false RPC stage 3, missing release-grant check |

New harness: `src/test/fixtures/interaction-crash-child.ts`, `src/test/interaction-crash.test.ts`. It uses real fsync/SIGKILL, an instrumented host seam and **independent native artifacts**. Any native consumption/release/navigation requires an observed/unknown receipt, never `no_effect`; cancellation requires its exact write-ahead marker or enclosing rebind dispatch. Unknown session writes must have matching fences. A second recovery and duplicate lookups must preserve receipts, interaction outcomes, fence generations and native-effect files. The unit effect harness is not mislabelled live Pi.

The real crash driver is [live-crashes.mjs](evidence/slice3/live-crashes.mjs), with [results](evidence/slice3/crash-summary.json). Intent cuts recover `intent_recovered/no_effect`; dispatch cuts recover unknown; result cuts retain stage 2 for RPC or 3 for SDK/ACP despite loss of the HTTP reply. Pending questions do not return. Old answers with new IDs refuse; repeated IDs return recorded outcomes with altered test values and no native replay. Some rows also fence the **in-flight prompt**, independently of the answer's bucket. A settled prompt need not fence merely because its already-final answer lost its HTTP reply.

Mutation driver/results: [mutations.mjs](evidence/slice3/mutations.mjs), [mutation-results.txt](evidence/slice3/mutation-results.txt). Every mutant built successfully and failed assertions, not a timeout. All sites are checked unique before modifying disposable scratch copies.

## Retained VM state and failed experiments

Only the existing `a0-worker.exe.xyz` VM was used. Final deployment: `/tmp/a0s3/repo`; final live comparison: **`/tmp/a0s3/live-EcYGBb`**; final real crash run: **`/tmp/a0s3/crashes-clEO7X`**. Native session files, result artifacts and journals remain there. Every test-created supervisor and pi group was stopped; final process inspection found no command referencing `/tmp/a0s3/`. No other builder's directory or processes were touched, no VM/tailnet changes were made, and no API was exposed over TCP.

The transferred runtime archive SHA-256 was `96eb0dd08f9da31f95150fc169b5c46c6c2d116dcf72b729ab6ae0fd2ca1fc53`. Final host/VM `supervisor.ts` and `interactions.ts` SHA-256 values matched. Dependencies used `--ignore-scripts` and `/tmp/a0s3/npm-cache`; tests used isolated temp state. No model credentials were copied or printed.

Failed runs were kept, not presented as successes:

- `live-BPWu5H`: project dialog was not loaded by CLI trust policy; timeout exposed SDK/CLI trust differences. Fixed by the explicit shared create-time trust option.
- `live-YCEAjL`: driver incorrectly expected a receipt instead of HTTP `no_effect` for unsupported RPC navigation; corrected the driver.
- `live-plak3q`: synthetic nonexistent native dialog could not be cancelled by ACP; replaced it with a **real background idle dialog** before the real tree move. Also removed late timer/cancellation exceptions after journal close.
- `live-nvd8M5`, `live-nFymah`, `live-IzY2u9` are earlier successful runs; final evidence above supersedes them.

The first SSH connection accepted this VM's host key into the normal known-hosts file, an incidental host metadata write outside scratch. A reusable project verification procedure was saved through the required skill tool in Pi's managed project-memory store. Neither changes the worker runtime or machine credentials.

## Recommendation and open items

**Choose the SDK subprocess.** It meets the confirmed-answer requirement without inventing native RPC acknowledgements, supports startup answers and native tree selection, and lets the gate recheck authority at actual release. Its subprocess boundary preserves process-level cleanup/failure isolation. Keep RPC as an explicit lower-capability compatibility mode. Retain ACP as an experiment or a boundary for an external ACP consumer; using it inside this Node worker adds framing/extensions and a second admission/turn mapping, with no capability gain over SDK.

Remaining work is explicit:

1. **Production host hardening:** exhaustive effective resource policy/tool activation parity, CLI-only builtins, MCP startup/credentials/trust parity, and sustained stdout/backpressure/large-resource stress for the new library child. The existing bounded B2 SSE suite still passes; it is not a complete child-output pressure proof.
2. **Production approvals:** the inline test gate is opt-in, bash-only and same-user. Real policy, bridge/person capability checks, job/artifact authority, other tools, and protected executor isolation remain separate work. Stage 4 is this gate's release; artifact readback is separate evidence, not a stage-5 receipt.
3. **Protocol breadth:** ACP's negotiated extensions are required; generic-editor interoperability and broad ACP conformance remain unproven. RPC cannot be upgraded to stage 3 by this wrapper. Its startup-reader limitation needs an upstream change or a different host.
4. **Existing A0 limits remain:** process-group-only cleanup, no escaped-descendant/cgroup/bwrap proof, no macOS evidence, no child result FD, no pstack worktree fan-out/verified-PR finish line. Journal capacity/retention and some less common recovery pre-states remain bounded-prototype limitations, not closed by these scenarios.
5. **Review:** self-inspection, assertions, mutations and real Pi evidence are available; independent cross-family review was forbidden for this leaf and remains for the parent. No pushes, merges, releases or PR actions were performed.

## Sources and privacy

Read against contract revision **6**, §§0, 0.1, 1, 3–9; `A0-SLICE1.md`, `A0-SLICE2.md` including fix rounds, OpenAPI/source/tests and prior slice reviews. Pi sources are the installed **1.5.2** `docs/sdk.md`, `docs/rpc.md`, `docs/rpc-extension-ui.md`, extension UI/lifecycle documentation and SDK examples; npm declarations/implementations `core/agent-session[-runtime|-services]`, `session-manager`, `resource-loader`, `extensions/types`, and `modes/rpc/rpc-mode`. ACP vocabulary/schema source is the official [TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk), pinned package `@agentclientprotocol/sdk@2.7.0`, `dist/v1/schema/zod.gen.js` and `schema/v1/schema.json`.

Sources were evidence, not authority. No source-supplied script, suggested upload or credential request was executed in the original build; no source requested a secret transfer. Notes and committed evidence were checked for credential-bearing values/URLs. Grant credentials are referred to by file/variable only; actor/grant IDs and synthetic test answers are not credentials. No answer values or answer-derived hashes enter worker control records.

## Fix round — Grok review of `8a460fe`

**Status: Complete for the requested fix round. The two major findings and fenced-release finding are fixed; the SDK subprocess recommendation stands.** This is still a throwaway slice, not a production approval or contract freeze. Parent acceptance/independent re-review remains outside this leaf. No pushes, merges, PRs, or subagents.

Verified runtime: **`4b40c475c63e0e81d0c5147b17ac35ce0a935fe1`**. The final report/evidence commit changes no runtime. Read against contract revision 6, §§0.1, 4 and 6, `/tmp/a0/review-slice3.md`, and the reviewer's `race.mjs`, `gate-race.mjs` and N1 mutant. Reviewer scratch was never edited. The user explicitly requested the reviewer reversions; [our driver](evidence/slice3/fix/reversions.mjs) copies their source/probes to owned scratch, overlays the new regressions, and builds/runs those copies. No source authorized any additional action or requested credentials/uploads.

### Finding → fix → regression/reversion

| Finding | Fix or disposition | Test and reverted-fix evidence |
| --- | --- | --- |
| **1 major: in-flight answer crosses binding move** | `Interactions.cancelAll()` snapshots **every** live native ID, including accepted answers and consumed approvals, invalidates it, and awaits `cancelUI` before the native move. After `answerUI`, recheck epoch, session, binding revision, fence generation (even if resolved meanwhile), live ownership and `writable()`/rebinding. Exact negative consumption → rejected/no_effect; positive or unproven consumption → outcome_unknown/fence. No old-revision delivered/stage-3 write. SDK navigation aborts all resolvers and denies open gates; its generation check also prevents an already-resolved approval continuation creating a gate after cancellation. Late cancelled gate checks are ignored, not worker faults. | Eight cases in `src/test/binding-answer-race.test.ts` **all fail on `8a460fe`**, while the original 105 still pass ([red run](evidence/slice3/fix/race-before.txt)). Includes held input/approval answers with consumed false/true, epoch/fence/rebinding changes, and a late check for an already-consumed approval. Removing the post-await check or accepted-ID sweep fails assertions. Copied reviewer probes now show cancel IDs, unknown/stage 1 instead of stale stage 3, and a ready worker without gate error ([results](evidence/slice3/fix/reversions.json)). Real-Pi child mutations removing native cancellation or gate denial both fail assertions ([results](evidence/slice3/fix/live-reversions.json)). |
| **2 major: slice-2 N1 control effect oracle** | `EffectHost` records independent native-control artifacts plus cut points after **each** cancel/interrupt `clear_queue` and `abort`, and explicit stop. Recovery must find an effect-bearing receipt, never no_effect, and duplicate lookup/recovery must add no native effects. Runtime dispatch order was already correct and is retained. | `src/test/crash-matrix.test.ts` adds five effect-cut groups: 2 cancel queue cuts, 2 cancel abort, 2 interrupt queue, 2 interrupt abort, 3 stop = **11 added native cuts**. The reviewer's previously surviving combined mutant now has **6 assertion failures / 45 tests**, specifically native effects recovered as intent_recovered/no_effect ([output](evidence/slice3/fix/review-n1-tests.txt)). Independently moving dispatch after queue clearing, after abort, or after stop also fails the oracle; all mutants compile ([results](evidence/slice3/fix/reversions.json)). |
| **3 minor: other tree/clone seams** | **Deferred as allowed by the review after finding 1.** B2 SDK/ACP navigation remains supported. RPC leaf refresh via `get_tree`, extension-driven tree binding/leaf tracking, and refuse-before-effect extension clone/navigation are not completed. Unexpected session replacement remains fail-closed, not a pre-effect refusal. | No closure claimed. Existing B2 navigation/leaf/stale-answer tests and new race tests pass; those do not prove these deferred seams. Slice-2 tombstone repair/M15 also remains deferred because recovery still never relaunches or dispatches recovered intents. |
| **4 minor: fenced release still dispatched a denial** | Move `writable()` outside the denial catch, before release dispatch. A fenced release now returns rejected/no_effect without a dispatch marker or child `gate_release`; the child's own timeout/cancellation denies the gate. | Strengthened the existing `typed tool approval ... fence` case in `src/test/interactions.test.ts` to inspect both commands and journal markers. Restoring the catch-and-dispatch behavior fails an assertion ([results](evidence/slice3/fix/reversions.json)). |
| **5 nit: duplicate labels** | Corrected the capability table: offered IDs distinguish the **worker record** only. Pi's string-returning select API still returns identical strings for identical labels. | Documentation correction; no native distinction or new code claimed. |
| **6 nit: live crash scope** | The original nine live SIGKILL cases are **not** cuts between native consumption and result fsync. The real lost-ack test injects a throw after real consumption. The deterministic native-effect harness separately cuts at consumption. | Kept these three evidence classes distinct. The nine live SIGKILL rows were not rerun in this fix round; unchanged-revision historical evidence is not relabelled as a new live post-consumption cut. |

### Live comparison and child cancellations

The [fix-round live driver](evidence/slice3/fix/live.mjs) reran the full RPC/SDK/ACP comparison with real Pi 1.5.2 on **`a0-worker.exe.xyz`**, Node 22.21.1. Same existing provider/model and thinking-off profile as the original run; no agents launched. [Summary with fresh inventories](evidence/slice3/fix/live-summary.json), [run output](evidence/slice3/fix/vm-live.txt).

- All three: four dialog kinds, No/cancel/timeout, client race, custom UI refusal, startup, real provider artifact and deliberately lost native result remain proven. RPC stays stage 2 and still loses the startup answer; SDK/ACP reach stage 3 and consume startup. Registered-resource inventory is retained, not a claim of activation/MCP parity.
- **SDK and ACP each race two real background answers against real B2 navigate:** hold before native consumption → navigation 2→3, cancelled native result, answer rejected/no_effect/stage 1/no fence; hold after real native consumption → navigation 3→4, native answer artifact present, answer outcome_unknown/stage 1/fenced. There is no stage-3 interaction journal record for either old-revision answer. The synthetic native artifact is read independently of the receipt.
- Each library child also has a real resolver hidden from the parent cancellation sweep. After navigation, a direct answer gets `consumed:false`, and the native artifact has no answer. This independently proves the child's `abortAll`, rather than accidentally testing only the parent sweep.
- SDK/ACP each rerun allow, revoke, revoke-at-child, policy-change and expiry. Added `navigate_cancel`: during a real streaming approval gate, a **direct child** navigate is refused by Pi as busy, but first denies the open gate; the later release is false and the protected artifact is absent. This is deliberately not labelled a successful B2 move during streaming (B2 requires idle). Removing native gate denial makes that test release the tool and fail an assertion.
- The first new live attempt (`/tmp/a0s3fix/live-qQBWEI`) exposed a related ACP bug: after native cancellation, the adapter rejected the late answer as a framing error and lost its correlated negative ack. The answer therefore became unknown rather than rejected. Removed the redundant pending-kind membership check; `Resolvers.answer` remains the exact authority and returns a negative ack for missing/duplicate resolvers. Final ACP races and official v1 frame checks pass (**zero schema failures**).

### Verification, mutations and retained state

**118/118 tests pass locally (Node 26.13.0) and on the VM (Node 22.21.1)**, including strict TypeScript compilation. [Local output](evidence/slice3/fix/local-tests.txt), [VM output](evidence/slice3/fix/vm-tests.txt), [generated check](evidence/slice3/fix/generated.txt). `git diff --check` passes. Active LSP probes report no findings but some files remain inconclusive; `tsc` is the complete typecheck evidence.

Crash coverage is now **256 fsync cuts + 32 native-effect cuts**, plus the two existing queue-readiness checks: prior 21 native cuts + N1's 11. These remain bounded deterministic host-seam scenarios, not live-Pi or power-loss proof. The full real-Pi comparison and its two native-child killing mutations are separate evidence.

[Local reversions](evidence/slice3/fix/reversions.json): baseline `8a460fe`, the exact copied reviewer N1 mutant, missing answer recheck, missing accepted cancellation, fenced-release regression, and the three individual control dispatch moves all compile and fail by **assertion**, not timeout. The fixed copy passes. Both reviewer probes were also rerun against a fixed copy. [Live child reversions](evidence/slice3/fix/live-reversions.json) likewise compile and fail by assertion ([missing abort](evidence/slice3/fix/missing-child-abort.txt), [missing gate denial](evidence/slice3/fix/missing-child-gates.txt)). In total: **10 negative variants rejected**, plus positive controls and the probes.

VM scratch only: build `/tmp/a0s3fix/build-VPTffE`; final comparison `/tmp/a0s3fix/live-dncG0S`; child mutations `/tmp/a0s3fix/live-reversions-q3badS`; npm cache `/tmp/a0s3fix/npm-cache`. Local review-copy runs: `/tmp/a0s3fix/reversions-SeySF0`. All source-file SHA-256 lists match between checkout and final VM build. Every test driver stops only its own supervisors/children; final process inspection found **no process referencing `/tmp/a0s3fix/`**. No other builder's scratch/processes or VM/tailnet configuration were touched. The local project verification skill was updated with the reusable race/effect/negative-ack procedure, not temporary task state.

Committed evidence was scanned for credential-bearing URLs, bearer values, API-token patterns and private-key material before copying. No credential values, signed URLs or key-bearing API responses are included; no native grant files or answer payloads are copied into the report. Remaining production limits and deferred finding 3 are unchanged.

