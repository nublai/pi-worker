# A0 slice 5: containment, sandbox and recovery

**Complete for this throwaway slice.** Real Pi SDK workers and their descendant detached tools are cleaned up through cgroup v2. Owner-kept recovered prompts dispatch once on a fresh Pi process, and a bwrap child delivers its report without seeing the supervisor socket. This is not production approval, Gate 1, or a contract freeze.

The review-fix artifact is **`90220b5`**, based on the reviewed `93bc4ad` and original base `65f767c`. The [fix-round source manifest](evidence/slice5/review-source.sha256) matches the local and VM copies. Later evidence/report commits do not change runtime or tests. The original verification below covers `6517837feeb79ab8246f338fe717f148cbf78f9c`; the fix-round section supersedes its counts and current behavior. No build or review subagents, push, merge, PR, or deployment outside the authorized VM.

## Cleanup domains and durable state

`src/containment.ts` creates a stable, installation-specific delegated systemd user service. Each Pi process gets a separate `w-WORKER_EPOCH` cgroup beneath it. RPC, SDK and ACP hosts all use the same launcher. Runtime needs no sudo. Stop fences an active execution before cleanup, without depending on Node's later exit callback. Confirmed OS cleanup alone cannot erase execution uncertainty or authorize an unfenced relaunch.

The journal records the domain root, unique generation and boot ID **before spawn**. A fixed shell joins the domain before it executes the payload. A domain that already exists is refused, even if empty. Relaunch always reserves a new generation.

Stop, spontaneous Pi exit, restart recovery, fault cleanup and shutdown use the whole domain, not its leader's process group. Normal cleanup records a fsynced `cleanup_pending`, writes `cgroup.kill`, waits for `populated 0`, and removes the domain. Only then does the supervisor record `cgroup_empty_removed` and release the lease. Removal also prevents a delayed pre-exec wrapper from joining a retired generation. A missing PID record does not lose the domain identity.

A failed kill, removal, delegation check or cleanup record keeps the lease blocked. If storage fails during fault cleanup, the supervisor still attempts the safety kill. It does not claim confirmed cleanup without a durable record. The new storage-failure regression was observed failing before that correction.

Linux defaults to cgroup v2 and refuses an unavailable delegation. `A0_CGROUP_DIR` can select an operator-provided delegation. The automatically created user service survives supervisor crashes. Before accepting requests, startup sweeps unknown `w-*` domains inside that installation-hashed service: kill, wait empty, remove, or fail startup. Journaled current domains use normal durable cleanup. Another installation's service and operator-supplied `A0_CGROUP_DIR` trees are never swept. The supervisor itself must run under the user systemd manager so migration at the common ancestor is permitted. A bare exe.dev SSH process starts in `init.scope` and cannot perform that migration.

`hello.cleanup_profile` publishes the actual provider. Explicit `A0_CLEANUP=process-group`, or a non-Linux platform, selects a named **weaker** fallback. That fallback never authorizes environment reuse or fresh-process relaunch. Its portable `ps` identity path is unverified on macOS.

## Explicit fresh-process relaunch

`workers.relaunch`, available through B2, the typed client and CLI, requires confirmed cgroup cleanup, an existing session file, no fence and no competing session or checkout writer. It starts a fresh process epoch, opens the original history and never prompts. Retired host callbacks cannot fault the replacement process.

A recovered pre-dispatch prompt stays `intent_recovered/no_effect` until the owner records `keep`. The existing resolution tombstone repairs `intent_ready` after a crash, including a crash between the tombstone and receipt update. Relaunch saves the original binding for each such prompt. Only that exact owner-kept command can use its captured binding on the captured relaunch epoch, original session and original binding revision. A later new-session, same-session revision change or another relaunch invalidates compatibility. The capture is consumed at admission, and the receipt/dispatch gate prevents a second write. Ordinary stale writes still refuse.

The original command ID, operation, binding and payload hash must match. Dispatch remains intent, fsynced dispatch record, one Pi write, result, reply. A dispatched uncertain command is never replayed. The tests also refuse relaunch when another worker has acquired the cleaned-up checkout.

This path proves recovered **prompts**. Rebinding recovered answers, navigation, queued follow-ups or child launches onto a fresh epoch remains unimplemented. Those requests do not gain a general stale-binding exemption.

## Filesystem sandbox and readback

Typed SDK and ACP children can declare `launch_spec.environment.filesystem="bwrap"` and an explicit `root` equal to their canonical cwd. RPC sandbox launches refuse before effects. A sandboxed parent cannot request an unconfined child.

The bwrap profile has:

- One host-writable worktree bind.
- Read-only system paths and the worker's required runtime files and dependencies.
- Private PID, user, IPC and UTS namespaces, private `/proc`, `/tmp`, `/run` and HOME, and dropped capabilities.
- An environment allowlist. No inherited parent socket, grant, credential variables or parent profile directory.
- The existing job-bound inherited FD 3 report channel. Bubblewrap 0.9 preserves this configured FD without a special preservation option.

The child's own Pi profile must be staged explicitly at `ROOT/.a0-agent`. Its transcript directory is `ROOT/.a0-worker/sessions/WORKER`, not a bind of the supervisor state. Explicit resources must be inside the root. State, runtime and worktree overlaps that would expose protected paths refuse. Directory provisioning uses pinned directory descriptors and refuses symlinks.

`files.read` requires explicit absolute subroots of the environment. It accepts regular UTF-8 files up to 1 MiB. Hidden paths, traversal, outside roots, symlinks at any component, sockets and oversized files refuse. The CLI command is `files-read CHILD --path FILE --root ROOT`.

Final inspection reproduced a readback gap in the old, unconfined `SessionIndex`: a worktree symlink could make it read an outside transcript. Sandbox history and settlement reads now use the same root-pinned, no-symlink open policy, while allowing Pi's hidden transcript directory. Tests cover outside file and directory symlinks. Removing this guard fails by assertion.

## Review fix round

**All eight requested findings are addressed.** The input was independent review 9 at `/home/g/Projects/nubl/.pi/plan/research/a0-slice5-review.md`. Each finding was checked against source and a regression or live probe before acceptance; no finding was rejected. This round did not commission another independent review.

| Finding | Fix and regression evidence |
| --- | --- |
| 1. Kept prompt crossed session boundaries | Persist the target relaunch epoch; require its exact session/revision and consume the capture. Tests cover one dispatch plus duplicate, `/new`, same-session resume and `/new` followed by another relaunch. Before the fix, the new-session case dispatched instead of rejecting. Both target-binding and revision-only reversions now fail assertions. |
| 2. Relaunch cleanup gate lacked tests | Keep the existing full guard. Default tests refuse pending cleanup both before and after restart, and refuse process-group fallback even when status is stopped. Removing the guard fails three assertions; weakening it to status-only fails the fallback assertion in plain `npm test`. |
| 3. Unsafe sandbox roots | Refuse `/`, fix slash-root containment, and reject overlaps with supervisor state, socket directory, grant file and cgroup controls. Reverting the original slash-root policy or the protected-path guard fails the root regression. |
| 4. Untested confinement/identity guards | Default tests inspect the actual host spawn environment key allowlist and PID flag, reject unconfined children of sandboxed parents, and require the returned original session file on relaunch. Each of the four reversions fails by assertion. Environment failure messages compare names only, never inherited values. |
| 5. Keeper leak | The bwrap test stops its exact hashed keeper in teardown and asserts it is inactive. Removing the stop fails the kernel regression; the mutation runner then stops that test's keeper using its isolated temp state path. |
| 6. Unknown startup domains | Sweep only the installation-owned delegation before startup readiness. Portable tests cover known/unknown domains, unrelated directories, other installations, operator trees and failed cleanup. A real-kernel test removes an unjournaled populated domain while leaving another installation populated. Removing sweep, its kill, or default-provider ownership fails regressions. |
| 7. Pi crash left detached tools alive | A spontaneous leader exit immediately starts normal domain cleanup; failed proof remains `cleanup_pending`. Before the fix both portable cases recorded zero clean calls. Tests now require immediate cleanup, durable final status and real detached-grandchild termination. The live real-Pi journey independently kills only the Pi leader and observes automatic removal, with no stop/restart request. |
| 8. Daemon handoffs escape | Documented below as a containment limit; no detection or daemon-control code was added. |

### Current verification and reversion evidence

[Checks](evidence/slice5/review-checks.json), [default mutations](evidence/slice5/review-mutations.json), [kernel mutations](evidence/slice5/review-kernel-mutations.json) and the [source manifest](evidence/slice5/review-source.sha256) identify this round. Mutation programs use disposable copies, not the working checkout.

| Check | Result |
| --- | --- |
| Local Node 26.13.0, default `npm test` | **174 tests: 169 pass, 5 kernel skips, 0 failures** |
| Local under delegated user service, kernel flags enabled | **174 pass, 0 skips/failures** |
| VM Node 22.21.1, default `npm test` | **174 tests: 169 pass, 5 kernel skips, 0 failures** |
| VM under delegated user service, kernel flags enabled | **174 pass, 0 skips/failures** |
| Strict TypeScript and API generation | Pass locally and on VM; regeneration preserves identical API bytes |
| Default guard reversions | **13/13 fail by assertion**, including both cleanup-gate variants; no compile failure/timeout counted |
| Kernel guard reversions | **2/2 fail by assertion**: keeper stop and installation sweep ownership |
| Existing bounded slice 5 cuts | 13 create fsync cuts + 1 native cut; 47 recovery/relaunch/sandbox/report/stop fsync cuts + 8 native cuts, unchanged |
| Active LSP, six changed TypeScript paths | No reported errors; 2 confirmed clean, 4 inconclusive. Strict compiler supplies full type evidence. |

Final full-suite VM logs are in **`/tmp/a0s5/review5-nqEg70/`**; committed logs have `review-` names under `evidence/slice5/`. The only post-runtime adjustment was a test assertion privacy change, followed by fresh full default/kernel suites on both hosts and source-hash comparison.

The [review driver](evidence/slice5/review-live.mjs) reran the B2 real-Pi journey at **`/tmp/a0s5/live-4hW12M/`**, using the same explicit provider/model and private provider-copy policy described below. Its [summary](evidence/slice5/review-live-summary.json) proves actual populated `cleanup_pending` across restart, stop cleanup, restart cleanup, **automatic cleanup after a Pi leader SIGKILL**, one owner-kept append, and a real bwrap SDK tool plus inherited-FD report. The extra Pi-crash detached tool was alive in the exact domain before the leader died; its marker stayed absent past its deadline.

The separate read-only [native audit](evidence/slice5/review-native-tools.json) found exactly **4 parent bash calls and 1 child bash call**, no other tools, exact detached/append commands, and the child's denied-path/allowed-read/write checks. All **5 supervisors, 6 Pi leaders and 3 detached-tool PIDs are absent**, and all **6 worker domains are removed**. The child's worktree remains locked and retained. The driver's keeper is stopped. After every runner exited, `systemctl --user list-units 'a0-*'` showed **zero loaded units on both hosts**; only explicitly test-owned services were stopped.

Setup failures excluded from passing evidence: the short SSH hostname refused connections, the first local user-service runner lacked Node PATH, and the `python` shim had no selected version. Explicit VM FQDN, Node PATH and `python3` corrected them. No test was weakened or removed.

## Original verification (pre-review)

[Machine-readable checks](evidence/slice5/checks.json) and the [source manifest](evidence/slice5/source.sha256) identify the tested artifact. Every `src` file, package manifest, OpenAPI file and live driver hash matches the VM copy.

| Check | Result |
| --- | --- |
| Local Node 26.13.0, `npm test` | 158 tests, 155 pass, 3 kernel tests skipped, no failures |
| VM Node 22.21.1, `npm test` under user systemd | **158 pass, zero failures or skips** |
| Strict TypeScript build | Pass locally and on VM |
| Generated API drift | Local check passes, VM regeneration preserves identical bytes |
| Slice 5 contained-create cuts | 13 fsync cuts and 1 native-effect cut |
| Slice 5 recovery, relaunch, sandbox, report and stop cuts | 47 fsync cuts and 8 native-effect cuts |
| Combined bounded matrices, including earlier slices | 364 fsync cuts and 46 native-effect cuts, plus two existing queue cuts |
| Targeted guard reversions | 8 of 8 fail by assertion, not compilation or timeout |
| Active LSP | No reported errors. Final three-path probe has two confirmed clean and one inconclusive result. The strict compiler supplies full type evidence. |

The cut oracles cross-check native effects against dispatch records. Every spawn requires its exact durable domain, and sandbox spawns require lineage and confinement metadata. Kill effects require a preceding pending record. An unreported child fences its parent. A durable owner tombstone must restore dispatch readiness. Recovery and duplicate lookup perform no new native effects.

The eight reversions remove domain reservation, pending-before-kill persistence, owner-tombstone repair, ordinary stale-binding checks, file pinning, history confinement, the storage-failure safety kill, or the active-execution stop fence. [Results](evidence/slice5/mutations.json) come from isolated copies of `6517837`; the primary checkout was not mutated.

Markdown analysis was unavailable. The report received manual evidence, privacy and whitespace checks.

These are every fsync occurrence and native seam effect in the **selected bounded scenarios**. They are not exhaustive state-space exploration, power-loss proof, or real-kernel SIGKILL injection at every machine instruction. Real kernel and real Pi evidence are separate below. No existing test was dropped or weakened.

## Original real Pi evidence on a0-worker

Final run: **`/tmp/a0s5/live-ug9ddB/`**. Full verification logs are in `/tmp/a0s5/accept-vm-bUCQKQ/`. Pi SDK 1.5.2, bubblewrap 0.9.0, systemd 255. The explicit model was `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking off. All worker operations used B2 with a non-owner, non-wildcard, run-scoped orchestrator grant. No driver-direct native RPC or prompt was used.

The [task-owned driver](evidence/slice5/live.mjs) and [final summary](evidence/slice5/live-summary.json) assert:

1. **Actual pending cleanup.** The driver temporarily withheld write permission on its own populated worker's `cgroup.kill`. Stop returned unknown. Resume and relaunch refused `no_effect`. A real supervisor SIGKILL and restart retained `cleanup_pending` while the unit remained populated. Restoring permission allowed confirmed cleanup. The original unknown stop receipt stayed final.
2. **Detached real tools.** Real Pi bash tools ran `setsid` plus `nohup` shells that wrote their PID, slept, then attempted a marker write. The driver independently checked each live PID and exact worker cgroup. Stop removed one domain. In the restart case the detached process was still alive **after** the supervisor died and **before** recovery. Recovery removed its domain. Both marker files remained absent past their write deadlines.
3. **Recovered intent once.** The supervisor died at the real prompt-intent fsync, before dispatch. Recovery returned `intent_recovered/no_effect` and no effect file existed. Owner keep, explicit fresh-process relaunch and the original exact prompt produced one native user entry and one `ONCE` append. A duplicate returned the identical receipt. Relaunch itself produced no prompt.
4. **Real bwrap SDK child.** The child ran in a retained, locked Git worktree at exact base `870a7f2debfb93e76b97cb9991111851bf2115f8` as recorded by the driver summary. Its actual bash tool read the allowed file, tested absence of the outside sentinel, supervisor state, actual socket and grant path, and wrote `SANDBOX_TOOL_OK`. One inherited-FD result report reached the supervisor. B2 file read returned the allowed proof and refused outside and hidden paths. Stopping the child left the parent ready.

A separate read-only [native tool audit](evidence/slice5/native-tools.json) checked the actual Pi transcripts. The parent made exactly three bash calls and the child made one, with no other tool calls. Both detached commands and the recovered append match the requested commands exactly. The child's bash call contains all denied paths and the allowed read and write checks. Transcript commands were compared as data, never executed by the audit.

The driver stages private VM provider configuration inside the child's own profile. The exe.dev provider normally checks whether `/exe.dev` exists. Only the private probe copy removes that existence check, after the driver verifies the VM hostname. `/exe.dev` is **not** mounted, and the provider's network registration and preference checks remain. No host credentials were copied to the VM, and no credentials were exported from it.

Five successful live runs remain under `/tmp/a0s5/`. The final [process audit](evidence/slice5/process-check.json) finds all **25 recorded worker leaders, 24 supervisors and 10 detached tool PIDs absent**, with all 25 worker domains removed. Worker leaders include the bwrap wrappers; domain removal establishes cleanup of their payloads too. All five child worktrees remain retained and locked. The three keeper-cleanup records show eleven test-owned keeper invocations stopped after checking their exact start time, command and contents. No unrelated unit was signalled, and no active A0 delegation remains. Private profiles, journals and raw sessions stay on the VM.

## Setup failures and corrections

- The first kernel probe ran from SSH `init.scope`. Migration failed, the SDK parent returned an EPIPE uncertainty, and the grandchild tests were cancelled rather than passed. The provider now checks common-ancestor migration permission, and the successful probes run under the user manager.
- The next sandbox probe used `--preserve-fds`, which bubblewrap 0.9 rejects. Removing that unsupported option made the actual SDK FD test pass. No socket or sidecar replacement was added.
- The old history reader followed an outside transcript symlink. The root-pinned history regression now rejects that read.
- A new fault-cleanup test found that a failed journal could suppress the cgroup kill. Cleanup now attempts termination but keeps the lease pending without durable confirmation. The test was red before the fix and green afterwards.

- A stopped domain could otherwise hide an active execution if cleanup beat Node's exit callback. The relaunch regression was red before an explicit stop-time fence and green afterwards.
- One final SSH runner had a quoting error and did not run its suite. Task-owned shell files replaced the nested quoting. That attempt is not counted.

These failed checks are not counted as passes. Earlier successful live runs do not substitute for the final artifact's verification.

## Limits and open work

- **Not hostile same-user isolation.** An unsandboxed process with the same UID can migrate out of a user-delegated cgroup or interfere with another process. Root-owned domains or a separate-UID helper would be needed for that threat. The sandbox does not mount the cgroup filesystem, but a hostile process outside it still has the named same-user capability.
- **Existing-daemon handoffs escape containment.** Cleanup covers processes launched in the worker's domain and their descendants, including setsid/nohup detachment. Work handed to an already-running tmux server, `systemd-run --user`/D-Bus service, Docker daemon or similar external executor runs outside that domain and is not killed by `cgroup.kill`. This ordinary handoff is distinct from hostile same-UID cgroup migration. No daemon-handoff detection or cleanup is implemented. The bwrap profile hides normal filesystem-backed user-daemon sockets; that is not a general external-executor guarantee.
- **Network is shared.** This is filesystem confinement and cleanup, not a network or credential-exfiltration sandbox. The child can access credentials deliberately staged inside its root. No cgroup CPU, memory or PID limits are configured by this slice.
- **Linux only evidence.** The process-group fallback is weaker and macOS is untested. Unavailable cgroup delegation refuses rather than silently downgrading. RPC sandbox execution is unsupported.
- **Git and registered environment policy remain open.** A linked worktree's Git administrative directory is outside its root and intentionally inaccessible. `environment.id`, revision and base SHA remain launcher declarations, not supervisor attestations. There is no registered root policy or complete result and cancel policy.
- **Recovery is intentionally narrow.** Fresh-process compatibility applies to exact owner-kept prompts, not every operation. No adoption, automatic replay, exactly-once external effects or durable parent-delivery dedupe is claimed.
- **Storage limits remain.** Journal capacity, lack of compaction and incomplete whole-command reservations are inherited. Admission can still refuse durable control when storage is failed. Fault cleanup attempts a safety kill without falsely releasing the lease. Physical disk-loss recovery is not proved.
- **Earlier review deferrals remain.** Native extension-driven binding changes, interaction attribution and sibling-settlement false fences, child frame-budget edges, late-report handling, host deadlines, transport classification and production authority policy are not silently fixed by this slice. The separate pi-herdr-agents repository is unchanged.
- No verified PR job, bridge, macOS check or production deployment was attempted. The fix round used the supplied independent review; no second review was commissioned. No contract freeze follows from this result alone.

## Sources and privacy

Inputs were A0-SLICE1 through A0-SLICE4, A0-MERGE-3-4, contract revision 6, all `a0-*review*.md` files, and exmach's read-only `packages/agent/src/jail.ts` and SPEC cleanup sections. The cgroup sequence follows that reference design; no Incus or vsock code was copied.

Prior reports and reviews contain reproduction commands and mutation-run suggestions. They were data, not instructions. This task used newly authored probes rather than executing their scripts. No source requested credential disclosure or an upload. No secret-bearing URL, API response, grant, private profile or raw session is in the committed evidence. Whitelisted summaries, logs and this report were checked for credential patterns before staging.
