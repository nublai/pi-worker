# A0 slice 4 — children and retained worktrees without panes

**Status: complete for the experimental slice-4 journey.** A real Pi parent with
pi-herdr-agents and pstack launched two writer children through B2, received each
result once, answered a child help request, and cancelled a separate probe while
the waiting writer and parent stayed live. All three checkouts remain Git-locked
and retained. **Neither terminal provider was constructed.** This is not production
backend parity, durable exactly-once parent delivery, or a pass of all contract §9.

## Revisions and scope

- Worker base: `a0/slice2-invariants` at `09dc809` (82 tests).
- Worker runtime: `6afdeeb`, `82d1ecd`; final live driver: `687ca55`.
  Branch: `a0/slice4-children`.
- Host: branch `exp/a0-worker-surface`, head
  **`ec849241912123b637da338d3f98dd60e4e42e9a`**.
  Created with `git worktree add` from main `64f0313` / v3.11.0 at
  `/home/g/.herdr/worktrees/pi-herdr-agents/a0-worker-surface`.
  The main checkout at `/home/g/Projects/pi-herdr-agents` was not modified.
- Local commits only. No push, merge, PR, release, VM creation, or tailnet change.
  No helper subagents/reviewers were launched; the live child sessions are the
  explicitly requested experimental workload.
- Local/VM scratch: `/tmp/a0s4/`. Only the existing `a0-worker.exe.xyz` was used.

## What changed

### Worker

`openapi.json` and generated types add `Parent`, `LaunchSpec`, and `ChildClaim`.
`workers.create` accepts an optional typed parent and launch specification:
worker/epoch/session/binding/execution/task/generation lineage; environment ID,
revision/base; role; tools/denials; explicit extensions/skills; report-method scope;
and standalone seed mode. Provider/model/thinking remain explicit create fields.
There is no shell-command or caller-supplied environment-variable tunnel.

`src/supervisor.ts` validates the parent binding, execution and fence before
reservation and again at dispatch. It persists lineage **before spawn**, uses the
existing intent → dispatch → effect → result ordering, and fences missing/unknown
child launch results on recovery. A help report is not a completion report.
Pre-dispatch child reservations whose receipt proves no effect do not spuriously
fence the parent. Typed parents cannot bypass inheritance through the older
minimal `children.launch` endpoint; that endpoint remains for slice-2 fixtures.

Grant methods, environment method ceilings, tool allowlists, inherited denials,
and resource paths are narrowed from the parent. The authenticated caller's
methods are also checked. Source grant IDs, not bearer values, are persisted;
revocation of the child launch's caller or parent grant is rechecked at FD report
consumption. The environment method ceiling is a **trusted launcher-supplied
prototype policy**, not a registered environment-policy service. No privileged
shell/tool release gate or hostile same-UID isolation is claimed.

`src/host.ts` launches an independent RPC Pi process. Typed launches disable
resource discovery, MCP, context files and prompt templates, then select explicit
resources/tools. Child processes inherit a dedicated FD 3 and task identity,
not `PI_WORKER_SOCKET` or `PI_WORKER_GRANT_FILE`. A bounded LF-framed report can
contain only a report ID, kind (`help`/`result`) and message; the worker supplies
its authoritative job/binding. RPC stdout cannot impersonate this channel.
Limits: 8 KiB message, 16 KiB buffered frame, 32 report frames per process.

Reports become fsynced `children.report` receipts before publication, carry
`claim_not_verified: true`, and are visible in fresh worker snapshots. Concurrent
same-ID reports share the receipt and publish once per live supervisor. Claim
text is retained as job output, not treated as verification or approval. Session,
settlement, termination and Git evidence remain separate.

A live-discovered race is fixed: an independently observed stop is not downgraded
to `cleanup_pending` by Node's later process-exit callback. Its regression test
makes the OS stop probe win before the native callback.

### pi-herdr-agents: exact experimental surface

| File | Responsibility |
| --- | --- |
| `maestro/core/worker-execution.ts` | Typed terminal-free execution-provider seam |
| `maestro/adapters/pi/worker-client.ts` | Unix HTTP/SSE, bounded readback, no mutation retry or terminal fallback |
| `maestro/runtime/pi-worker-session.ts` | Host-owned Git acquisition, fsynced manifests, launch/help/cancel, evidence and delivery |
| `maestro/runtime/index.ts` | Runtime composition exports |
| `pi-extension/subagents/worker-backend.ts` | Opt-in tools and FD child protocol |
| `pi-extension/subagents/index.ts` | Select experimental path before constructing the normal run session |
| `maestro/surfaces/herdr/a0-terminal-trap.ts` and both provider constructors | Inert-by-default instrumentation that records and refuses any terminal-provider construction in the live profile |
| `test/maestro/worker-{backend,crash}.test.ts`, `test/fixtures/worker-cut.ts` | Real Git seam test, trap positive control, host crash/effect cuts |
| `docs/experimental-pi-worker.md`, README/reference pointers | Supported subset and limits, separate from released contracts |

Opt-in: `PI_WORKER_BACKEND=1`, explicit worker socket, grant-file and parent ID;
optional `PI_WORKER_WORKTREE_ROOT`. Child context is supplied by the worker.
Default Herdr behavior and released tool schemas are unchanged. There are no
invented pane/workspace IDs. Unsupported arguments refuse rather than silently
falling back to the legacy backend.

The host resolves the exact committed base, fsyncs provisioning intent, runs
`git worktree add --lock --reason …`, then records the observed Git admin directory
and B2 launch identity. It retains every checkout after completion/help/cancel or
partial acquisition. There is no cleanup/adoption implementation. These follow
ADR-0020's separation and creation-time-lock lessons, not its proposed Core binding.

The branch adds approximately **1,377 lines across 19 files**, including tests and
docs; roughly **830 lines are runtime/types/instrumentation**. It is a typed sibling
of the existing Maestro runtime, not a full replacement of existing policy paths.
A real backend is several focused PRs: integrate existing launch normalization and
routing; share run ownership/delivery; version manifests and add reconciliation;
implement environment policy/resource inventory; preserve acceptance/outcome
contracts; then add containment and lifecycle coverage. This is materially larger
than a single SurfaceProvider, but does not require rewriting pstack.

## Verification

- **Worker: 94/94 tests pass locally and on the VM**, including strict TypeScript.
  The original 82 tests remain passing.
- Existing slice-2 matrix: **172 fsync cuts**, **12 native-effect cuts**, plus two
  queue-readiness cuts. New slice-4 worker scenario: **44 fsync cuts and 5 effect
  cuts** (root spawn, child spawn, report-send stand-in, report publication, child stop).
  Fixture session headers and separate effect records are checked against recovered
  receipts/fences. Recovery and duplicate lookups perform zero new effects.
- Host: **1,772 tests, 1,771 passed, 1 existing skip, zero failures**.
  **38 host checkpoints** cut every manifest file/directory fsync in its scenario,
  Git acquisition, fake native spawn/prompt/stop, and parent help/result/cancel
  delivery. Acquired checkouts stay locked and manifests precede effects.
- Host `typecheck`, `lint`, `format:check`, `docs:tools:check`, package preview and
  `git diff --check` pass. Worker generated-spec check passes.
- Active LSP batch: no language-server errors; auxiliary AST style warnings/hints
  remain. Strict compiler checks are the definitive type evidence here.
- Legacy/Core live integration suites were **not run**: the changed execution path
  is intentionally terminal-free, and the instrumented real-Pi headless journey is
  its lifecycle evidence. No independent review was permitted for this build leaf.

The crash matrices use deterministic native-host seams, with real subprocess
SIGKILL/fsync, not live-model crash injection. A separate subprocess test exercises
the actual inherited FD and rejects stdout impersonation; the live journey uses
the real FD without crash injection. These are every occurrence in the named
scenarios, **not every possible fault/pre-state**. SIGKILL after fsync is not
power-loss proof. Host crash
cuts prove retention/order, not host recovery: full parent-crash adoption and
transactional delivery into Pi are deliberately absent. No mutation-score claim
is made. Slice-2 deferred binding/queue/SSE items remain for slice 3; this slice
adds a stop-effect cut but not a complete clear_queue/abort cut matrix.

## Final real-Pi evidence

Final run: **`/tmp/a0s4/live-lO2fBm/`** on the VM. Worker code/driver at `687ca55`,
host at `ec84924`. Pi **1.5.2**, pstack **1.0.0**, Node **22.21.1**. Exact live
model: **`exe-dev-anthropic/claude-sonnet-4-6@llm`**, thinking **off**, all children
standalone bare leaves. The parent read the pstack prototype/fan-out guidance and
its native session contains the persisted active poteto-mode record.

**Setup exception:** B2 slice 2 deliberately refuses slash commands. The driver
activates `/poteto-mode on` with one **native RPC setup-only call**, which returns
`handled` without a model run. This is disclosed, not presented as a B2
`commands.invoke` implementation. All task input, child creation, help answers and
cancellation then use worker B2; the model itself calls public host tools.

The two writers both start at base
`0c3bb5ab8d888e8d919870733a7cec4592e6c746`:

| Child | Verified output | Retained HEAD |
| --- | --- | --- |
| writer-a | `alpha.txt` exactly `ALPHA\n`; clean, one commit ahead | `3e75d6c5e85185eb38b4f09cfae51bded23ddf99` |
| writer-b | `beta.txt` exactly `BETA\n`; clean, one commit ahead | `4145da44677dac2201bbb5d973058eda37d5c515` |

Writer-a first requested help over FD 3, stayed live while the separate third
`cancel-probe` was stopped, then received the parent's answer via `subagent_send`
and committed. The third probe is separate so cancellation does not contradict
the requirement that **both writers complete**. It may deliver a help request
before cancellation; that report and its cancellation each appear once. The
parent remains ready after children finish and independently reads the outputs
and heads before saying `A0_S4_VERIFIED`.

The driver counts native Pi **`custom_message`** entries: both writer results,
writer-a help, probe help and probe cancellation occur exactly once each. The
worker report receipt is a claim; the driver's exact content/parent-SHA checks
are independent evidence. Each checkout and its manifest is retained.

**Zero terminal providers:** both legacy/Core constructors have a positive-tested
trap that would record and throw before acquisition. The live profile enables
those traps and failing PATH wrappers for `herdr`, `hc`, and `herdr-core`. The
shared call file is absent. This is stronger than a hard-coded acknowledgement
counter; it is still not a general syscall/network audit.

### Isolated installation

The local experimental host was packed without a version bump as
`pi-herdr-agents-a0-ec84924.tgz`, copied to `/tmp/a0s4/`, and installed using npm's
`--prefix /tmp/a0s4/installed --ignore-scripts`, with cache `/tmp/a0s4/npm-cache`.
Each live run copies that installation into its own
`<run>/agent/npm/node_modules/`, plus the VM's installed pstack and provider
extension. `PI_CODING_AGENT_DIR=<run>/agent` and explicit resource paths select
only that profile. Existing provider credentials/configuration are copied locally
with mode 0600; their values are never logged, transferred off the VM, or committed.
The VM's default `~/.pi/agent` is read-only input, never an installation target.

Earlier runs are retained, not relabelled:
- `live-9rXNgg`: failed before task input because the initial driver used a B2
  slash-command prompt.
- `live-7WmRPW`: actual writers/cancel/help succeeded, but the driver timed out
  because it searched `message` instead of `custom_message` entries. This run also
  exposed the late-exit status downgrade fixed above.
- `live-fsnI9H` and `live-g6iENm`: successful predecessors; the final run additionally
  instruments both terminal-provider constructors.

All **17 recorded Pi leaders** across these runs are absent after cleanup. No
unrelated process was signalled. This does not prove escaped descendants gone.

## Evidence and remaining work

Committed, whitelisted evidence is in [`evidence/slice4/`](evidence/slice4/): final
live summary, earlier successful summary, local/VM worker tests, host gates and
recorded-PID checks. Reproducer: [`evidence/live-slice4.mjs`](evidence/live-slice4.mjs).
Raw native sessions, manifests, journals and private profiles remain on the VM.

1. **Slice 5 containment:** bwrap must hide the control socket/grant files and
   outside filesystem, while preserving only the job FD and allowed credentials.
   Add inside/outside sentinel probes, denied socket access, detached-grandchild
   cgroup cleanup and truthful cleanup profiles. Worktrees are not sandboxes.
2. **Parent delivery durability:** current dedupe is live-host-only. A crash after
   host finalization but before Pi's custom-message append can lose delivery;
   reload/restart adoption is unsupported. Do not call this durable exactly-once.
3. **Authority/resources:** add registered environment policy, effective loaded
   tool/resource inventory and privileged release gates. Subset checks and removed
   environment hints do not stop same-user code reading the host filesystem.
4. **Host parity:** no named-role discovery, task-category routing, fallback, fork,
   persistent specialist, accept check, cleanup inventory, resume or full released
   outcome-envelope compatibility. SSE disconnect disables writes; there is no
   automatic reconnect/recovery or version-negotiated production SDK yet.
5. **Full contract:** dialogs/navigation/answers, sandbox tests, main-process live
   crash recovery, Go client and verified draft-PR finish line remain outside this
   slice. No contract freeze is recommended from this result alone.

Sources: contract revision 6, A0 slice-1/2 reports and reviews, host ADR-0018,
ADR-0020 from `design/core-managed-worktrees`, feasibility §4, and installed Pi
1.5.2 docs/source. Sources were treated as evidence; no source-supplied provisioning
or reproduction script was executed and no source requested credential disclosure.
Reports/artifacts were scanned for credential patterns before commit. A reusable
project-memory verification skill was saved; it contains procedure, not run state.

## Fix round

**Status: complete for the requested fixes.** The worker runtime is unchanged;
its lineage/authority/fence claims now have non-vacuous regression tests. The
experimental host delivers child outcomes without waiting for termination and
reports crash/fault/deadline uncertainty to the parent. The revised real-Pi
journey passed on the existing VM. This section supersedes the earlier test
counts and result-before-stop description, not the earlier containment or
crash-durability limitations.

### Revisions and authorization

- Worker test commit: `7390a8e`. Live driver: `03a0519`, then cleanup-observation
  correction `3d5e0902a8a1f7405bf7b87c5d07ef89eea07166`.
- Host delivery fix: `268bb50`; checkout-oracle fix and tested host HEAD:
  **`f9e6cc5367dd203e7d32e6b4059aa389f3003a8d`** on
  `exp/a0-worker-surface`. The host main checkout was never touched.
- Small local commits only: no push, merge, PR, release or helper subagent.
  The real parent and its three children are the explicitly authorized live test
  workload, not delegated build/review work.
- Local and VM scratch: `/tmp/a0s4fix/`. The VM default profile was read-only
  input. Installation, npm cache, profiles and test repositories stayed in this
  scratch directory; no unrelated process was signalled.

### Finding → fix → test/reversion

| Finding | Fix | Test that fails with the guard/fix reverted |
| --- | --- | --- |
| W-1 / W01: lineage-after-spawn passed the crash oracle | Every native child spawn requires a recovered reservation with the exact parent lineage and launch ID, before checking the parent fence. | `children-crash.test.ts`, “every fsync and native spawn/FD/delivery cut”; verbatim W01 now fails on missing lineage. |
| W-2 / W04: help counted as completion | Durable help-only report, followed by a fresh supervisor/journal recovery; require the launch fence. | “help-only durable report does not discharge the parent recovery fence”; W04 fails. |
| W-2 / W08, W12b: grant narrowing was masked | Non-owner parent grant and independent caller; environment allows more than the tested grant ceiling. | “child methods respect distinct caller/parent grant ceiling”; each respective reversion fails. |
| W-2 / W06b, W06c: revocation halves masked each other | Separate parent-source and child-caller grant IDs; revoke each independently before FD consumption. | Both “FD report rechecks distinct … revocation” cases fail under the corresponding reversion. |
| W-2 / W13, W17: execution/live-fence gaps | Stale execution negative case; post-spawn `get_state` timeout must fence the parent and refuse a replacement immediately. | “typed child refuses execution” and “unknown child initialization fences the live parent”; W13/W17 fail. |
| W-2 / W07, W11b, W15: remaining targeted guard gaps | Denied report method, widened skill resources, revoked parent with an independent active caller. | “FD report requires children.report”, “typed child refuses skills”, and “child create rechecks revoked parent source”; W07/W11b/W15 fail. |
| H-1: crash/fault/non-settlement delivered nothing | Typed `failed`/`unknown` handoff with Git evidence on terminal/unknown observation; subscribe to `worker_fault` too. A finite 15-minute turn deadline delivers unknown, then attempts stop; settled help pauses it and an answer rearms it. | `worker-delivery.test.ts` crash, fault, unknown-execution, deadline and help/deadline cases. Restoring the old session implementation fails all seven original delivery regressions. The fault-only HTTP/SSE test confirms the client subscription. |
| H-1: unconfirmed stop dropped result and blocked siblings | Record and deliver the result before requesting stop. Deliver `kind: termination` separately; unknown receipts and transport errors become `termination: unconfirmed` for that run, not a failed session. | Held-stop cases assert the result is already delivered, then answer and launch siblings both before and after unknown/throwing stop completion. Moving result delivery back behind stop fails both tests. |
| H-3 / H03: provisioning oracle skipped missing manifests | Iterate actual registered child checkouts and require preceding provisioning evidence for each. | `worker-crash.test.ts`; verbatim H03 fails. All 41 current host checkpoints pass unmutated. |
| H-4 / H06, H07: Git scrub/help settlement lacked guards | Add inherited-`GIT_DIR` isolation and help-before/after-settlement cases. | H06 fails; H07's equivalent deletion of the relocated settlement guard fails at the early-help assertion. |
| Live evidence gaps | Assert every checkout's own porcelain stanza is locked; use a scoped orchestrator grant; record both direct RPCs; retain successful playbook read calls and the checklist. | Updated `evidence/live-slice4.mjs` assertions pass in `live-f7iKRv`. |

The **11 targeted worker reversions all fail by assertion**, not compilation
failure or timeout. H03 and H06 were replayed verbatim from copied reviewer data;
H07 was adapted to the moved guard. The old H04 “deliver before stop” mutation
expresses the behavior now explicitly required, so it is not reused as an oracle;
its inverse (wait for stop) is tested instead. The copied reviewer mutation scripts
were parsed as data by a task-owned runner, never executed. Mutated files were
restored and byte-compared. The original `/tmp/a0/review5/` was never edited.
Results: [worker reversions](evidence/slice4/fix-round/worker-reversions.json),
[host original reversions](evidence/slice4/fix-round/host-reversions.json),
[host delivery reversions](evidence/slice4/fix-round/host-fix-reversions.json).
This is targeted regression evidence, not a claim that all 33 mutants were rerun.

### Verification

- Worker: **104/104 pass locally and on the VM**, strict TypeScript and generated
  spec check pass. Slice-4 cuts remain **44 fsync + 5 effects**; slice-2's
  **172 fsync + 12 effects** remain passing. No edits to worker production code or
  `crash-child.ts`; cancel/interrupt effect cuts remain slice 3's N1 ownership.
- Host: **1,782 tests: 1,781 pass, one existing skip, zero failures**;
  typecheck, lint, format, generated tool-doc check, package preview and diff
  whitespace checks pass. Delivery regressions were observed red before the fix.
- Active LSP check: seven paths, zero reported errors, four confirmed clean and
  three silent-on-clean/inconclusive rechecks. The successful strict compilers
  supply type evidence; the LSP result alone is not called a clean bill.
- Legacy/Core terminal integration suites were not run: this opt-in path is
  terminal-free and its real-Pi journey is the relevant live check. No independent
  review was launched. Crash, timeout and unconfirmed-stop scenarios use
  deterministic host/SSE seams, not live-model fault injection.
- Machine-readable gate summary: [checks.json](evidence/slice4/fix-round/checks.json).
  Full local logs remain in `/tmp/a0s4fix/`; no private profiles or raw sessions
  were copied off the VM.

### Live rerun

Final run: **`/tmp/a0s4fix/live-f7iKRv/`** on `a0-worker.exe.xyz`.
Worker/driver bytes match `3d5e090`; host package is from `f9e6cc5`. Pi 1.5.2,
Node 22.21.1; exact catalog-checked model
`exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking off.

The parent was created through B2 with grant ID `orchestrator`, **not owner**,
no wildcard methods, and cwd scope restricted to the run root. Its seven methods
are recorded in the [summary](evidence/slice4/fix-round/live-summary.json).
Each writer has source grant `orchestrator` and effective launch methods exactly
`["children.report"]`, asserted to be a strict subset. The parent launch spec's
own method ceiling also remains enforced. No bearer value is in the evidence.

**Every driver-direct native RPC is disclosed:**
1. `get_available_models` — read-only authenticated catalog check, outside B2.
2. `prompt('/poteto-mode on')` — setup-only slash command, disposition
   `handled`, outside B2 because slice 2 does not expose slash commands.

The counted native traffic was four `get_state`, one `get_available_models`
and six `prompt` requests. Apart from the two exceptions above, those requests
were worker-backed initialization, task input and help answers. Stop uses the
worker's process-group operation, not an undisclosed native prompt.

The parent session contains successful `read` tool calls for the installed
poteto-mode `SKILL.md` and `playbooks/prototype.md`, both from entry
`df75c696`. Entry `a3a19769` contains the selected prototype checklist,
independent-checkout plan and explicit review/publication skips. Entry
`ef76242f` records the parent inspection and `A0_S4_VERIFIED`. These excerpts
and read tool-call IDs are committed in
[pstack-evidence.json](evidence/slice4/fix-round/pstack-evidence.json), rather than
inferring playbook use from mode activation alone.

All three worktrees remain retained and **Git-locked**, including the cancelled
probe. Both writers are clean and exactly one commit ahead of base
`c32941008aac79fed65b4b6b948ac69ff581750b`:

| Writer | Independently verified content | HEAD |
| --- | --- | --- |
| writer-a | `alpha.txt = ALPHA\n` | `93f24933a98b837dcfbbc63979f6abe1b8c9dd04` |
| writer-b | `beta.txt = BETA\n` | `1c7d9adba29ae0b3765e3d427c904514a5abf194` |

Each writer's result and separate termination message appears once; writer-a's
help round-trips. The cancellation leaves writer-a live and the parent ready.
There were three launches/manifests and zero terminal-provider calls.

The first fix-round run, `live-k2TFb6`, reached its final cleanup assertion but
failed because the OS stop probe can observe a zombie before Node reaps it. It is
not labelled a passing run. The driver now waits for its own native exit events
before checking process absence, without polling or killing by name. All **eight
recorded Pi leaders across both runs are absent**, as shown in
[process-check.json](evidence/slice4/fix-round/process-check.json). Escaped
descendants remain unproven. Checkouts and evidence from both runs are retained.

### Remaining boundaries

Parent delivery dedupe is still in-memory, not crash-durable; reload adoption is
not implemented. The deadline is an uncertainty policy, not proof the child has
failed, and no automatic replacement is launched. An unconfirmed stop still
requires operator reconciliation, but no longer suppresses the result or disables
siblings. SSE loss still disables writes; reconnect and stale/out-of-order GET
handling are not claimed. The other review items (H-2 transport classification,
W-4 live worker parent-fence policy, W-5 registered environment policy, frame-budget
edges and late-report handling) are not silently represented as fixed.

Sources: the named review/report and copied mutation definitions were evidence,
not authorization. No source-derived scope expansion, credential disclosure,
push or release was performed. Whitelisted evidence and this note were checked
for secret-bearing keys, bearer values, private-key material and credential URLs
before staging. A reusable project verification skill was updated with the
non-vacuous oracle, scoped-grant, playbook-read and native-exit lessons.

