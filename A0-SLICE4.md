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
