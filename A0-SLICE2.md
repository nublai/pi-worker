# A0 slice 2 — THROWAWAY core invariants

**Built and verified the slice-2 control/transport subset, including live Pi. Not production, not full section 0 conformance, not Gate 1, and not a contract freeze.** Remaining gaps are explicit below: direct RPC tree navigation, safe post-restart relaunch/resume, confirmed answers/tool release, contained children and inherited authority.

Date: 2026-11-15 UTC. Base: `5b0bdc8`. Final runtime tested: **`a5ed733`**, following the live-discovered journal-close fix `d601824`. Report/evidence changes do not change that runtime. No subagents, independent review, push, merge, PR, deployment outside the authorized VM, or changes to `/tmp/a0d/`.

## Result and verification

- **68/68 tests pass locally and on `a0-worker`**, including strict TypeScript compilation. Local Node v26.13.0; VM Node v22.21.1, Pi 1.5.2. Commands: `TMPDIR=/tmp/a0s2 npm test --cache /tmp/a0s2/npm-cache`; npm installation used `--ignore-scripts` and the same dedicated cache.
- **161/161 actual SIGKILL cuts pass on both runtimes:** 155 fsync occurrences in the deterministic scenario and six during recovery. Each cut checks every recorded receipt's recovery bucket, no new native prompt/launch effects during recovery or duplicate lookup, and stable receipts/fences across a second restart. This is process-crash evidence, **not power-loss or device-flush proof**.
- Live real-Pi checks passed: new/resume/fork in one process; old-revision input refused; duplicate open names holder; explicit SSE overflow and snapshot resync; grant scope denial and revocation before queued dispatch; all three fence dispositions; two restarts; two real main-process fsync cuts.
- `npm run check:generated` and `git diff --check` pass. Active LSP checks on 17 changed source/test files returned zero diagnostics: six confirmed clean, **11 inconclusive** on a push-only server. This is not a blanket LSP-clean claim; strict `tsc` passes.

Evidence: [`evidence/slice2/`](evidence/slice2/). Live driver: [`evidence/live-slice2.mjs`](evidence/live-slice2.mjs). Shared fixture data/format: [`src/test/fixtures/transitions.json`](src/test/fixtures/transitions.json), [`README.md`](src/test/fixtures/README.md). Crash harness: [`crash-matrix.test.ts`](src/test/crash-matrix.test.ts), [`crash-child.ts`](src/test/fixtures/crash-child.ts).

Final deployment archive SHA-256, matched locally and on the VM:

```text
bc227db3424d6672119ae3ad2c53dab4238511f1bccb84a3ba0782254e0536ed
```

## What was built, in requested order

1. **N-1, N-2, T-1 first** (`5f1a0cb`, completed regression adjustment in `f68c8cf`). New tests reproduced both bugs before the fixes. Leaf/history/header-evidence refreshes publish `observed_memory`; reads do not append the journal, including read-triggered faults. Faults do not rewrite a settled execution to unknown. A fixture compares restart 1 directly with restart 2, not just a live epoch with one restart.
2. **Fence latch and pending work** (`f68c8cf`). `sessions.resolve_unknown` validates session, worker epoch, binding revision, exactly one uncertain command/execution, generation, and disposition. Fence generations retain a high-water mark and all uncertain IDs; resolving one item cannot silently erase another. Resolution tombstones survive restart; duplicate lookup of a resolved unknown does not relatch it. A *new* crash of a kept, still-running execution does relatch at the next generation.
   - Keep releases paused work when the native run is actually idle. Abandon drops/reports live and recovered queued work, without redispatch. Observed requires exact execution attribution in the session file or a delivered fsynced receipt carrying that execution ID; memory, arbitrary text and an unknown dispatch marker are insufficient.
   - Follow-ups and minimal child launches stay in the supervisor, not Pi's native queue. Pending payloads are memory-only, capped at 32. Every due item checks fence, binding and its original grant. Recovery retains undispatched intents as no-effect; explicit owner keep enables one exact retry, never automatic replay.
   - Cancel/interrupt clear queued input before native `abort`, report requested versus observed/unknown, and do not clear the fence. Evidence reports and stop are allowed under a fence. Unsupported writes also name the fence cause.
3. **Binding transitions** (`f68c8cf`). Typed `sessions.rebind` uses `new_session`, `switch_session`, `fork`; increments the revision, invalidates live interactions and emits `session_rebound`. Fork requires a current source leaf and known entry. Session paths are supervisor-local catalog data, not caller authority. Target reservations close concurrent second-open admission; refusals name the holder. Exclusive canonical-cwd checks remain. Direct navigation refuses explicitly because this Pi version has no direct RPC command for it.
4. **B2 stream/client** (`36483ff`). A single supervisor-wide `/v0/events` endpoint with worker/type filters replaces per-worker streams. Snapshot/barrier/registration is synchronous; snapshots carry all authorized workers and history markers. Single-worker snapshots retain convenience `worker`/`history` fields. No dead ring or historical replay. Each subscriber queues at most 64 events/256 KiB, then gets `overflow` and stream end; a never-draining peer is closed after a one-second final-buffer deadline. Only that subscriber closes.
   - Transport epoch is the supervisor start UUID, independent of binding epochs. The draft cursor's legacy field name remains `worker_epoch`.
   - Hand-written clients have `agent:false`, connect-before-write, one attempt, typed pre-write `no_effect` versus post-write `unknown`, and preserved server labels/details. Overflow/disconnect disables client stream controls until a fresh snapshot. No hidden reconnect or mutation retry.
5. **Minimal grants** (`7c33050`). Local owner registration issues the installation owner file; local `grant-register` issues per-caller 0600 bearer files naming caller, worker/canonical-cwd scope, methods and revocation. No unauthenticated registration HTTP method exists. Every OpenAPI method, including hello/readback/SSE/receipts, authenticates. Inventory/SSE filter out other workers; mutation dispatch rechecks the original grant, including after a queue delay. `hello` says same-user code can read grants and there is no privileged tool-release gate yet.
6. **Crash/conformance** (`03bcb01`, `a5ed733`). All supervisor fsyncs pass through the labelled injection seam. The data table contains one replayable fixture per section 0.1 row, with native test-seam events explicitly distinguished from B2 calls. Child launch lineage is persisted before the parent result: restart without a matching fsynced child report fences the parent launch result, without rewriting its delivered receipt. A matching report is still a claim, not verified success. Control/recovery/report operations bypass ordinary receipt count quota, not byte/storage failure.
7. **Live acceptance** (`9d88171` driver, final runtime `a5ed733`). See below. The first live run exposed and reproduced a real lifecycle bug; it was fixed before the successful final runs.

## Section 0 invariant coverage

“Pass” means the named implemented behavior, not every future method. Each uncovered part is listed rather than inferred from a green subset.

| §0 item | Automated test/evidence | Live evidence | Status and limit |
| --- | --- | --- | --- |
| **1 One live writer** | `invariants.test.ts`: stale binding, exclusive cwd, duplicate open with `holder_worker_id`; source-leaf checks. | `binding_and_duplicate`: same PID, revs 1→2→3→4, second worker refused naming first. | **Pass** for supported bindings/environments. Native processes outside this supervisor are not discovered/locked. |
| **2 Restart policy** | Crash matrix; fixture `09-restart`; missing/untrusted identity stays cleanup-pending; no recovery host factory call. Closed-journal fd-reuse regression. | Both real fsync cuts; old native groups observed gone, no adoption/replay. Final recorded PID check is empty. | **Pass** for no-adoption and fail-closed replacement; **not covered** for contained descendant cleanup and safe relaunch. Group-only/escaped-descendant limit remains. |
| **3 Unknown fence/latch** | `invariants.test.ts`, fixtures 02–08/11; multiple IDs, monotonic generations, wrong generation, observed rejection/evidence, paused queues, keep/abandon, allowed controls/reports. | `resolve_keep`, `resolve_abandon`, `resolve_observed`, `two_restarts`: cause-labelled refusals, unchanged admissions, clear resolved fences after restart. | **Pass** for the supported control subset. Live queue pause/resume and confirmed answer/tool gates **not covered**. Byte/fsync failure can still prevent durable resolution/control replies. |
| **4 Labelled refusals** | HTTP unknown/fence-before-reply tests; typed pre-/post-write transport tests; every-method grant tests. | Old revision, duplicate holder, fenced prompt and wrong generation refuse no-effect; killed HTTP write is unknown. | **Pass** for supported B2 requests. Unknown receipt lookup is explicitly unknown, never proof of no effect. |
| **4a Recovery buckets** | 161-cut matrix; owner-ready/exact-retry once fixture; child report/no-report recovery tests; recovered-queue abandon. | Intent cut → `intent_recovered/no_effect`; accepted cut → `outcome_unknown/unknown`; duplicate lookup unchanged, zero native input entries. | **Pass** for classification/no replay and local dispatch-once seam; **not covered live** for post-restart retry through a safely relaunched host or the sandbox child result channel. |
| **4b Binding on mutation** | Fixture 01; new/fork/resume, source leaf, old revision, interaction invalidation, second-open reservation. | Real new/resume/fork preserve PID and change native session/revision correctly; delayed old input refused. | **Pass** for supported mutations; **not covered** for direct tree navigation (unsupported RPC) and later catalog methods. |
| **5 Explicit evidence** | N-1 read tests, journal-observing host, history/lag tests, receipt finality, observed-evidence rejection. | Delivered admissions separate from later unknown executions; observed uses exact fsynced receipt, not completion text. | **Pass** for memory/session-file/journal labels. Pi transcript is not advertised as fsynced. |
| **6 Separate stages** | Admission/start/`agent_settled`, not `agent_end`; handled-without-run; immutable delivered receipts. | Real turns settle via native events; admissions stay delivered across Pi death and fence resolution. | **Pass** for execution stages; **not covered** for answer accepted/forwarded/consumed/tool-release/effect-done stages. No answer API here. |
| **7 Scoped/rechecked authority** | Every OpenAPI method requires bearer; worker/cwd/method denial, symlink root check, filtered inventory/SSE, revoked queue dispatch blocked. | `grant_revocation`: file 0600, cross-worker denied, queued follow-up rejected no-effect after revocation, marker absent from Pi history. | **Pass** for minimal B2 grants; **not covered** for child grant subset/environment policy and revocation at privileged tool release. Queue dispatch is not a tool-release proof. |
| **8 Named limits** | `hello`, README; grant/cleanup profiles explicit. | Same-user client reads a grant file; real Linux Pi/group profile; no credential transfer. | **Pass** for named same-user, BYO machine loss, Linux≠macOS and peer-credential limitations. No isolation claim. |

Section **0.0 ownership**: Pi alone writes conversation JSONL. The supervisor writes control receipts, binding/fence/lineage state; reads derive history without persisting it. Jobs, bridge decisions, workspace durability, result acceptance and presentation remain outside this prototype. A fsynced child report is a reported claim, not verified artifact acceptance.

## Section 0.1 — one shared fixture per row

All **11 fixture rows pass** against the public Unix HTTP client on both runtimes. Row 01 explicitly records its unsupported navigation variant; that variant is not made green by testing new.

| Row / transition | Fixture | Live evidence | Result |
| --- | --- | --- | --- |
| bound(n) → new/fork/resume/tree move → bound(n+1), invalidate interactions | `01-binding`; additional fork/resume/interaction test | `binding_and_duplicate`, revs 1–4, same PID | **Pass** new/fork/resume; tree navigation **not covered**. |
| bound → mutation unknown → fsynced fence before reply | `02-unknown`; HTTP response-header disk check | Three native Pi kills; accepted fsync cut recovered fenced | **Pass**. |
| fenced → any write → no-effect naming cause | `03-fenced-write`; supported and unsupported write checks | New prompt refused naming uncertain command | **Pass** supported write subset. |
| fenced → queued follow-up/child due → paused | `04-paused` | **Not covered** live | **Pass** deterministic native seam, no admission/launch effect. |
| fenced → keep → bound, queued work resumes | `05-keep` | Keep clears persisted latch; live due queue resume **not covered** | **Pass** local queue/child dispatch; live latch only. |
| fenced → abandon → bound, queues dropped, no redispatch | `06-abandon`; recovered queue test | Abandon clears latch; live queue-drop **not covered** | **Pass** local queue/drop; live latch only. |
| fenced → observed → bound only with exact execution evidence | `07-observed`; additional negative session/receipt evidence test | Exact execution in delivered fsynced receipt | **Pass**. Pi attribution stamping itself is not implemented. |
| fenced(g) → resolve(g′) → unchanged fence, no-effect | `08-generation` | Wrong generation refused for all dispositions | **Pass**. |
| any → restart → cleanup pending until old host gone/recorded | `09-restart`; full crash matrix | Two actual main kills/restarts, observed group cleanup | **Pass** no-adoption/fail-closed profile; escaped descendants unproven. |
| cleanup pending → resume → refused no-effect | `10-cleanup-resume` | **Not covered** with a genuinely escaped descendant in this slice | **Pass** unconfirmed-identity seam; containment still absent. |
| any → cancel/interrupt → allowed without lifting fence | `11-control`; clear queue before abort | **Not covered** live while fenced | **Pass** native seam; requested/settled/unknown remains explicit. |

## Fsync-point crash matrix

All **seven call sites** are enumerated below. `src/fsync.ts` calls the real `fsyncSync`, emits `{index,label}` only when tracing is enabled, and optionally SIGKILLs **after** it. `A0_CRASH_INDEX` cuts a particular occurrence; `A0_CRASH_AT` cuts a named label. Reads create no timing-dependent fsync points.

| Site / label family | Expected recovery rule | Local + VM result |
| --- | --- | --- |
| Journal open/truncate file: `journal.open_file` | Only torn final line may be truncated; complete corruption refuses; no new effect. | **Pass**, scenario + recovery cuts. |
| Journal containing directory: `journal.open_directory` | Durable journal directory entry; otherwise same recovered records, never replay. | **Pass**, scenario + recovery cuts. |
| New grants directory in state dir: `grant.directory_created` | Owner registration may be completed at startup; no old command replay. | **Pass**. |
| Grant file: `grant.register_file` | Complete 0600 grant available; no bearer emitted by tracing. | **Pass**, owner + scoped registration occurrences. |
| Grant directory: `grant.register_directory` | Issued file retained; registration is local owner configuration. | **Pass**. |
| Revocation file: `grant.revoke_file` | Revoked state remains revoked; dispatch reads file again. | **Pass**. |
| Every journal append: dynamic families below | Intent/no-dispatch → no-effect; dispatched/no-result → unknown; terminal receipt unchanged; worker fence/resolution recovered independently. | **Pass** at every occurrence in the scenario/recovery run. |

Journal append families exercised:

| Record family | Cut assertions |
| --- | --- |
| `journal.supervisor` | Installation ID retained; new transport epoch; no adoption. |
| `receipt.workers.create.{intent,accepted,delivered}`; worker starting/ready records | Undispatched creation intent no-effect, dispatch unknown, delivered immutable. No automatic replacement factory call. Spawn-to-identity uncertainty remains fail-closed. |
| `receipt.sessions.prompt.{intent,accepted,delivered,outcome_unknown}`; worker admitted/started/settled/fenced | No-effect before marker; unknown after marker; delivered admission unchanged while unsettled execution fences; observed settlement not rewritten. Native prompt/launch effect counts ≤1. |
| `receipt.sessions.rebind.{intent,accepted,delivered}` | No replay of native binding effects; unknown remains fenced; old binding rejected. |
| Follow-up/child `{intent,queued,intent_ready,accepted,delivered,rejected}` | Queued/undispatched recovers no-effect; owner authorization is not auto replay; dispatch unknown; abandon never sends input/launch. Child without fsynced report fences parent's launch result. |
| `receipt.sessions.resolve_unknown.{intent,accepted,delivered}` and worker resolution tombstone | Before durable resolution, fence remains. After tombstone, acknowledgement survives even if the resolution reply/result was lost. No external-effect undo claim. |
| Cancel/interrupt/report/stop `{intent,accepted,delivered}` and cleanup records | Lost dispatched result is unknown, immutable terminal results stay final; controls do not replace the session's uncertainty cause. |
| Recovery unknown receipt and worker fence records | Second crash/restart preserves bucket and latch generation, no new effect. |

Raw matrices: [`crash-matrix-local.json`](evidence/slice2/crash-matrix-local.json), [`crash-matrix-vm.json`](evidence/slice2/crash-matrix-vm.json): **155 scenario + 6 recovery occurrences = 161**, 62 distinct labels, all pass. The harness compares every latest pre-cut receipt with recovered state, not just aggregate counts. Effect counters independently record native prompts and launches; model success text is not used. A second recovery checks unchanged receipts/fences. All seven sites are covered; this is not exhaustive enumeration of every possible workload, storage failure, or instruction between fsyncs.

### Two live main-process cuts

| Real fsync point | Recovery bucket | Native history entries for input | Retry/replay/cleanup |
| --- | --- | --- | --- |
| `receipt.sessions.prompt.intent` | `intent_recovered / no_effect`, no fence | **0** | Exact duplicate returns recovered intent; no send. Owner abandon records no-dispatch disposition. Old group observed gone. |
| `receipt.sessions.prompt.accepted` | `outcome_unknown / unknown`, gen-1 fence | **0** | Exact duplicate returns same unknown; no send. Owner abandon clears latch, not external history/effects. Old group observed gone. |

Both start with a **real initialized Pi child** and kill the **actual supervisor main process** via SIGKILL at the real fsync seam. The HTTP client correctly says unknown after its write; subsequent receipt lookup supplies the more precise bucket. The dispatch cut happens before sending Pi input, so zero native entries is expected, not proof that all unknown commands have no effect. The deterministic matrix also covers cuts after native prompt/launch effects and before result persistence.

SIGKILL cannot prove hardware flush durability, simulate an in-flight failed fsync/power loss, or prove escaped descendants dead. Stop/recovery do not currently persist `kill_sent` separately from observing a group already gone (Pi may exit on stdin EOF before recovery).

## Live VM and retained state

Only the existing **`a0-worker.exe.xyz`** was used. No VM creation, tailnet changes, network publication, or changes to `/tmp/a0d/`. Final deployment: `/tmp/a0s2/repo`. Final successful journey: **`/tmp/a0s2/live-jomm5O/`**. Prior successful regression run: `/tmp/a0s2/live-2gzgwe/`. The first failed run is retained at `/tmp/a0s2/live-cwvGew/` and must not be relabelled successful or reused as clean journal state.

Real Pi used the VM's existing **`exe-dev-anthropic/claude-sonnet-4-6@llm`**, thinking off, explicitly checked in native available-model data. No children/subagents or host model credentials were supplied. Normal Pi discovery ran; a complete effective extension/tool inventory and incidental extension initialization writes outside the supplied session directory were not audited. No global Pi/provider configuration was explicitly changed by this work.

Final live cases in [`live-summary.json`](evidence/slice2/live-summary.json):

- Real initial user/assistant history, new → old session resume → fork, revisions `[1,2,3,4]`, unchanged native PID. A delayed old-revision prompt refuses no-effect with received revision 1. Duplicate session open refuses and names holder `5c7f7f3f-b684-40ed-b024-420a839aed5a`.
- **Real Unix SSE transport**, with a deliberately synthetic supervisor-memory event burst to force backpressure. Explicit overflow received, stream controls disabled, fresh overflow-resync snapshot received; no worker cancellation. This is not a claim that Pi itself generated an overload.
- A real native run held the session busy. A scoped caller queued input, its grant was revoked, and dispatch later rejected no-effect. Its marker is absent from Pi history. Scope denial and file mode 0600 were independently checked; same-user readability is recorded as a limit, not a security pass.
- Three real Pi process-group deaths after delivered admission produced fences. Each disposition was tested, wrong generation refused, new prompt named the cause, and the original delivered receipt stayed unchanged. `observed` used a fsynced receipt for the exact execution, not the session's arbitrary text.
- Both resolved fence persistence and transport identity survived two subsequent supervisor restarts: three distinct transport epochs, no native adoption.
- The two main-process fsync cuts above recovered the correct buckets and never sent/replayed the input.
- All supervisors/workers started by the driver were stopped. Final recorded-native-PID inspection has no live non-zombie process for all three retained runs. This does not inspect or claim cleanup of arbitrary escaped descendants or unrelated processes.

### Failure discovered live, reproduced and fixed

The first run passed binding, transport, grants and all dispositions, then a later restart refused a corrupt journal. Investigation found an **old supervisor callback appended sequence 132 into a new supervisor's journal at sequence 138**: after `Journal.close()`, the OS recycled the descriptor, and a late Pi exit callback used it to write the new open file with the old sequence counter.

A focused regression failed first with “Missing expected exception.” `d601824` makes journal close idempotent, marks it closed before releasing the descriptor, refuses late appends before touching the descriptor, and refuses new reservations on a closed instance. The entire local/VM suite and live journey were rerun successfully; the final successful journey was repeated after the recovered-queue/count-quota adjustments in `a5ed733`. The corrupt first-run file was preserved, not edited to manufacture success.

## Deviations and remaining slices 3–5

1. **Tree navigation is genuinely unavailable as a direct Pi 1.5.2 RPC command.** Installed `rpc-commands.md`, `rpc-types.d.ts`, and the native RPC switch have new/switch/fork/get_tree but no navigate command. The implementation has `navigateTree` only in extension command context. This slice does not fabricate success, forward an unknown command, or install a project extension as a hidden workaround. Use an SDK/explicit extension seam in slice 3, then bump the binding and add real evidence for that variant.
2. **Safe full post-restart relaunch/resume is still blocked.** Same-process `switch_session` is implemented. Restart kills/does not adopt Pi, and escaped-descendant cleanup is not proven. Owner-ready recovered intent can dispatch once with an exact request and ready current binding in the native seam; it cannot magically run on a stopped host, and changing its binding changes the request hash. No live “recovered intent → safe replacement host → one dispatch” claim is made. Recovered lifecycle create intents before a session binding also lack a session-resolution endpoint. A containment/resume design is required, not a silently weakened cleanup check.
3. **Minimal children are not the slice-4 child platform.** Pending launches pause/resume/drop and persist parent launch lineage; missing report fences parent. There is no job-scoped inherited result FD, bwrap, environment-policy authority subset, child-specific grant inheritance, worktree routing or parent-result verification. HTTP reports are scoped reported claims, not a child-only sandbox channel.
4. **Grants are not approvals.** The live revocation test blocks queued prompt dispatch. It does not prove revocation between a person's answer and privileged tool release, artifact/policy/expiry binding, resolver consumption, answer races, or the SDK/RPC stage-3 comparison. Those remain slice 3/4. No answer hashes or values were introduced into control records.
5. **Storage/control availability is bounded, not production-grade.** Reads no longer consume the journal, but full worker control snapshots, no compaction/eviction, result-only rather than whole-chain reservations, and byte/fsync failure can still prevent durable termination/resolution. Ordinary count quota no longer blocks stop/cancel/interrupt/resolve/report. Stale-lock takeover atomicity, graceful termination, Pi-originated execution attribution, shaped large live deltas, and complete startup-resource readiness remain open review items.
6. **Transport fixtures are ready for another implementation, not proof of one.** No Go fake or Go race test, real bridge crash, notification snapshot-diff consumer, macOS run, multi-controller answer race, image/settings/reload journey, or verified draft-PR job was built here. Slice 5 still needs those integrations, exact-revision verification evidence and the attention-per-verified-change baseline.
7. **No independent review ran:** explicit leaf restriction. Parent should review actual diffs/evidence before integration. Reusable procedures are the committed crash/conformance/live drivers; no out-of-scope shared skill-store writes were made.

### Gate 1 accounting

| Contract §9 item emphasized for slice 2 | Result |
| --- | --- |
| Test 4: answer races/stages | **Not covered**; no answer/gate API. |
| Test 5: supervisor/Pi/bridge crash cuts | **Pass** supervisor fsync cuts and Pi-death fences; bridge crash and power loss **not covered**. |
| Test 7: binding identity | **Pass** real new/fork/same-process resume; tree navigation **not covered**. |
| Test 11: fence/trust/duplicate/child channel | **Pass** fence resolution, duplicate holder and named same-user limit; project-extension probe and bwrap child FD **not covered**. |
| Test 12: scoped/revoked authority, stale mutation, queued work, cleanup | **Pass** scoped B2 grants, queued-dispatch revocation, stale binding, local paused/keep/abandon queues; privileged release and real contained detached-grandchild cleanup **not covered**. |
| One section 0.1 fixture per row | **Pass** all 11 replay rows, with row 01's unavailable navigation variant explicitly partial. |
| Gate 1 overall | **Not passed. Do not freeze section 0.** Other Gate 1 dialogs, sandbox/child delivery and host guarantees remain outside this slice. |

## Sources, scope and privacy

Read-only sources: worker contract revision 5 sections 0/0.0/0.1/1/3–6/9; both slice-1 reviews; `A0-SLICE1.md` including fix round; README/OpenAPI/source/tests; installed Pi 1.5.2 RPC docs and VM RPC command types/implementation. Sources were treated as evidence, not authority. No source requested credential disclosure/uploads or changed task authorization, and no source-supplied provisioning/review reproduction script was executed. The slice-1 historical Python specimen only received a `stdout=PIPE` null check for static typing; it was not rerun or relabelled slice-2 evidence.

Authored code/commits are confined to this worktree; scratch/npm cache and deployment state to `/tmp/a0s2/` locally and on the one authorized VM. No pushes, merges, PRs, unrelated checkout edits, VM creation/deletion, or tailnet/production configuration changes. Pi's own ordinary resource discovery and its named same-user limits are not represented as isolation.

Committed evidence is whitelisted control summaries, test output, fsync labels/buckets and PID-presence results, not grant files, raw HTTP authorization headers, credential-bearing model/API responses or full native stdout. Selected artifacts/report were scanned for bearer/API-key/private-key/query-credential patterns before committing; credentials are referred to only by file/variable names. No secret or signed URL is included.
