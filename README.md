# pi-worker

**THROWAWAY A0 slice 5 prototype — NOT production, Gate 1, or a contract freeze.** One Node 22+ supervisor, one selectable Pi 1.5.2 RPC, SDK, or ACP subprocess per worker, private Unix HTTP/OpenAPI, typed CLI, fsynced control records, explicit uncertainty, and Pi-owned conversation files. The SDK dependency is pinned to 1.5.2. See [A0-SLICE3.md](A0-SLICE3.md) for the SDK production-host recommendation and evidence.

## Try the throwaway CLI

```sh
mkdir -p /tmp/a0s5/demo /tmp/a0s5/tmp
npm ci --ignore-scripts --cache /tmp/a0s5/npm-cache
TMPDIR=/tmp/a0s5/tmp npm test
# Linux: launch under the user manager so migration into delegated cgroups is legal.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
export DBUS_SESSION_BUS_ADDRESS=unix:path=$XDG_RUNTIME_DIR/bus
systemd-run --user --pipe --wait --unit=a0-demo --property=WorkingDirectory="$PWD" \
  --setenv=PATH="$PATH" --setenv=A0_STATE_DIR=/tmp/a0s5/demo node dist/main.js
# Another shell, same OS user:
export A0_SOCKET=/tmp/a0s5/demo/worker.sock
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
node dist/cli.js relaunch WORKER --command-id relaunch-1
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
- A failure **after the dispatch record** is `outcome_unknown` unless the supervisor proves no effect (`ProvenNoEffect`: it removed everything it created and a descriptor check found it absent, or the host answered with an explicit negative acknowledgement). A default refusal after dispatch is not that proof.
- CLI binding lookup is a convenience. To send a previously captured binding, pass **all** `--worker-epoch`, `--session-id`, `--binding-revision` flags. A delayed old binding refuses `no_effect`, naming the old/current revisions.
- New, fork, and same-process resume use Pi RPC and bump the binding revision, invalidate interactions, and publish `session_rebound`. Second live session bindings name their holder; canonical exclusive cwds are reserved. SDK/ACP tree navigation uses `rebind --action navigate --entry-id ENTRY --source-leaf-id CURRENT_LEAF`, bumps the binding and invalidates live interactions. **Pi 1.5.2 RPC tree navigation refuses explicitly.** A `/new` UI action uses typed `sessions.rebind(action=new)`, not raw slash-command forwarding.
- Admission, execution start and `agent_settled` are separate. `agent_end` is not settlement. Delivered input can still have a later unknown execution. Reads never append control records; derived leaf/history changes publish memory-only evidence.
- Unknown session mutations latch a persisted fence. New writes refuse `no_effect` naming its cause. Pending follow-ups/child launches pause. Reads, cancel, interrupt, stop and evidence reports remain available. Resolution checks exact binding, command **or** execution, and generation; records keep/abandon/observed; never claims external effects undone. `observed` requires exact session-file attribution or a fsynced settlement record for that execution, not arbitrary text, admission or an unknown dispatch marker.
- Follow-ups and pending child launches are supervisor-owned, capped at 32, and not sent into Pi's unpausable native queue. Payloads are memory-only. Restart turns undispatched intent into `intent_recovered/no_effect`; owner `keep` enables an exact retry once (`intent_ready`), never automatic replay. A ready live host/current binding is still required. After cgroup cleanup, explicit `workers.relaunch` opens known history on a fresh process without prompting. Only exact owner-kept recovered prompts retain their captured old binding; ordinary stale writes still refuse. Other recovered operation rebinding remains unimplemented.
- One **supervisor-wide** SSE endpoint, `/v0/events`, with `worker_id` and `types` filters. Each subscriber has at most 64 queued events/256 KiB, plus bounded in-flight transport data. Overflow sends an `overflow` frame and closes; the client requires a fresh snapshot before controls. `watch '*'` watches all authorized workers. Every reconnect snapshots; there is no historical event replay or retained ring. The legacy cursor field `worker_epoch` means **transport epoch**, changes per supervisor start, and is not the binding epoch.
- Client writes use `agent:false`, one attempt, and typed `ClientFailure`: before connect/write = `no_effect`, after attempted write = `unknown`, server refusals preserve their label/details. Disconnect never cancels work.
- Native moves that announce themselves but never bind (Pi threw after invalidation) are reconciled from `get_state` after 15 s as a binding bump; the worker faults if the host cannot answer. RPC announces moves on `session_shutdown`. In all hosts the announcement crosses a pipe, so a write arriving in that latency gap is not prevented. A native move into a session another worker holds is detected only after Pi opened it.
- Restart never adopts Pi. Linux defaults to per-process cgroup v2 domains under a stable delegated systemd user service, with no runtime sudo. Cleanup is pending until `cgroup.kill`, `populated=0` and removal succeed. SDK/ACP parents and children can use bwrap; children have a job-bound inherited report FD. No hostile-same-uid guarantee, network isolation, macOS verification, bridge, production approval policy, or exactly-once external effects.
- Journal: 32 MiB, no compaction/eviction; 512 ordinary receipts. Stop, cancel/interrupt, resolution and evidence reports bypass the ordinary count quota, **not** byte/storage failure. Result reservations are not whole-chain reservations; disk/fsync failure can still block durable control replies.

`hello` names these limits, same-user access, BYO journal machine loss, and Linux ≠ macOS. Normal Pi resource discovery runs; never use sensitive state. `openapi.json` is the draft B2 surface; `npm run generate` regenerates `src/api.generated.ts`, and `npm run check:generated` checks drift.

## Containment and sandbox profile

`A0_CGROUP_DIR` can select an operator-delegated cgroup v2 subtree instead of the installation's automatically created user service. The supervisor must have migration permission at the common ancestor; an SSH process in `init.scope` does not. Unsupported delegation refuses startup rather than silently downgrading. `A0_CLEANUP=process-group` explicitly selects the weaker fallback (also selected on non-Linux); escaped descendants remain unproven, so it never authorizes environment reuse or fresh-process relaunch. macOS is untested.

For a typed SDK/ACP parent or child, set `launch_spec.environment.filesystem="bwrap"` and `root` equal to its canonical `cwd`. System paths and worker runtime/dependencies are read-only; `/proc`, `/tmp`, `/run` and HOME are private. Network is **shared**, not filtered. Every mount source that sandboxed code could write is opened by an `O_NOFOLLOW` walk and handed to bwrap as a descriptor (`--bind-fd`/`--ro-bind-fd`), so a later rename or symlink swap cannot redirect it. bwrap runs with `--die-with-parent` and `--clearenv` plus an explicit environment allowlist. Supervisor state, B2 socket, grant files and host home are not mounted. Explicit resources reside inside the root. Stage the Pi/provider profile at `ROOT/.a0-agent`. Staged `models-store.json` and `auth.json`, when present, are overlaid read-only from descriptors; a linked credential store refuses. Expose only credentials actually needed: code inside the sandbox can read these deliberately exposed credentials. Staged copies stay in retained child worktrees after the job (their `node_modules` mount points are empty on the host). A shared network namespace also exposes loopback services and abstract Unix sockets. The transcript lives at `ROOT/.a0-worker/sessions/WORKER`.

A sandboxed parent gets one per-generation socket, mounted alone at `/run/a0-parent/socket`. Its public compatibility config is **not a B2 bearer**. The channel acts with **its own grant**, `channel-<parent worker>`, scoped to the parent worker and its root, never the owner's `*` grant. The parent's source grant is rechecked on every request. The channel is restricted to the parent and its direct children: inventory/readback, child launch/input/stop, and their own receipts. It cannot answer approvals, resolve fences, read worker-less receipts, or access unrelated workers.

The experimental host's `workers.create` child request is narrowed to SDK+bwrap. Its `cwd` must be exactly `ROOT/.a0-worktrees/<name>`, a real directory reached by an `O_NOFOLLOW` walk from the parent root's descriptor (never `realpath`); bwrap binds that descriptor. Its Git admin/common dirs must lie inside the parent root.

Only the parent's explicit staged profile is staged, and only **after every validation**. The copy walks descriptors and never follows a link: links are recreated verbatim, and file bytes come from the exact `O_NOFOLLOW`-opened file. **Dependency trees are not copied.** Each `node_modules` directory becomes an empty mount point, and the child sandbox binds the parent's directory there **read-only** (`--ro-bind-fd`), from the descriptor staging opened. Nothing writable is shared. The copied part (config, credential stores, extensions outside `node_modules`) keeps a budget of 10,000 entries and 256 MiB; at most 64 dependency binds. A real 18,801-entry profile stages 23 entries. The parent can still change its own `node_modules` after launch, which the child then loads; the parent can already write the child's worktree, so this adds no authority. Refused launches copy nothing, and an exact retry returns the stored receipt. A staging failure after dispatch removes the partial `.a0-agent` and checks by descriptor that it is gone: then the receipt is `rejected/no_effect`; otherwise it is `outcome_unknown` and the parent is fenced. A launch that fails before a host exists ends the row `failed`, with `failure: {command_id, reason}`; it never stays `starting`. Children retain only inherited report FD 3, never either control socket. This is a thin A0 compatibility adapter, not a new orchestration policy.

Linked worktrees mount only their own Git admin directory (writable for index/locks/logs), shared writable objects, and a private branch/reflog namespace. **Everything that decides what Git executes later is read-only:**
- the worktree's `.git` gitfile, which is also pinned as a mount point;
- the admin dir's `gitdir`, `commondir` and symbolic `HEAD`;
- common config, packed refs, other refs/reflogs and ignore patterns;
- hooks and `objects/info` (alternates).

Ordinary checkouts used as a root have `.git` pinned as a mount point, and `config`, `hooks`, `info` and `objects/info` are read-only. A `commondir`/`gitdir` redirect, a config `include`, or `extensions.worktreeConfig` refuses.

Use a unique two-component branch such as `task-UUID/work`; its namespace must contain only that branch at launch. Flat/shared namespaces refuse. **Tradeoff:** a child can corrupt shared objects or create additional refs inside its own namespace. No whole repository checkout or host home is exposed.

**Owner-side Git must go through `src/git-safe.ts`** (`safeGit`, `safeGitRun`, `artifactSubject`). Each call:
1. compares the checkout's `.git`, `gitdir`, `commondir`, symbolic HEAD, config hash and alternates with the launch-time `Worker.git_pin`, through `O_NOFOLLOW` descriptors, and refuses on any change;
2. from those same descriptors, copies HEAD, config (re-hashed against the pin), refs, `packed-refs`, `shallow`, `info` and the index into a fresh mode-0700 supervisor directory outside every sandbox mount;
3. refuses a config that names a program (filters, diff drivers, textconv, `diff.external`, merge drivers, includes, aliases, gpg/ssh/pager/editor programs), parsed by Git itself;
4. runs Git with `--git-dir` = that snapshot (no `commondir`), objects from the pinned common dir, a clean environment allowlist, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, fsmonitor/hooks/global attributes/transport disabled, submodules ignored, and `--no-ext-diff --no-textconv` on diff-family commands.

So owner Git never re-opens a path the agent can write for anything that selects code to execute; a parent rewriting `commondir` while the call runs gets a refusal or a run on the pinned bytes. Objects are still read from the shared store (content-addressed data). The helper is read-only: anything Git writes lands in the discarded snapshot. Relaunch refuses a changed pin too. Then compare the complete refs map, allowing only declared branch heads. A plain `git status` or `git fsck` in a retained worktree is **not** safe: a parent can rewrite its children's admin metadata, which lives in the parent's `.git`.

`files.read` requires explicit absolute subroots of this environment and returns UTF-8 regular files up to 1 MiB. Hidden paths, traversal, symlinks at any component, sockets and outside roots refuse. Sandbox history also uses root-pinned, no-symlink opens, while permitting Pi's hidden transcript directory.

```sh
node dist/cli.js files-read CHILD --path proof.txt --root /absolute/child-worktree
```

`workers.relaunch` requires a bound session file, confirmed cgroup cleanup, no unresolved fence and no competing checkout/session writer. It does not create an execution. Resolve an undispatched recovered prompt with `keep`, relaunch, then submit **the original exact command and binding**; duplicate lookup still never dispatches. See [A0-SLICE5.md](A0-SLICE5.md) for proof, setup constraints and limits.

## Evidence

See **[A0-SLICE7.md](A0-SLICE7.md)** for the security fix round (233 tests; 17/17 reversions; B1/B2/M1 fixed) and its owner-Git follow-up (239 tests; 4/4 reversions; the `commondir` race closed) and the original 216-test result, sandboxed parent/Git-worktree journey, commit-and-tree evidence, and Gate 1 accounting. **[A0-SLICE5.md](A0-SLICE5.md)** retains the containment and fresh-process recovery evidence. Earlier **[A0-SLICE3.md](A0-SLICE3.md)** records 105 tests on both machines, 256 scenario/recovery fsync cuts, 21 native-effect cuts, real-pi host comparisons and remaining gaps. **[A0-SLICE2.md](A0-SLICE2.md)** preserves the invariant/transition evidence and its superseding fix round (82 tests, 172 fsync cuts). The shared fixture table and replay format are in `src/test/fixtures/`. `A0_TRACE_FSYNC=1` emits point ordinals/labels; `A0_CRASH_INDEX=N` or `A0_CRASH_AT=LABEL` deliberately SIGKILLs after a real fsync. **Do not enable injection on valuable state.**

Earlier evidence stays in `A0-SLICE1.md`. Intended license: MIT (nubl decision R21); add LICENSE before making this public.
