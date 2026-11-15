# A0 slice 6: verified change through the worker

**Complete for the authorized leaf delivery.** The VM's Pi parent used pstack guidance to launch two typed children, integrated their commits, and produced a verified fix for [pi-worker issue 1](https://github.com/nublai/pi-worker/issues/1). Root still owns publication and the draft PR. The full contract test 13 is therefore not complete, and Gate 1 is not ready to freeze.

## Result and revisions

- Supervisor runtime stayed at the requested base, `409bd889289fa3601977411747e0aaccf9a73332`.
- Result branch `fix/issue-1` is **`a3c4e02b902ffb151a1c8f99b93dc9bd75aa48a6`**. It is fetched into this repository, not merged into this report branch.
- [Verification evidence](evidence/slice6/verification.json) verdict is **`verified`** for that exact commit. The SHA-256 of `git diff --binary BASE COMMIT` is `72cd34f6360344c8680181900bd6dbfb78d5000d420183b926364a7dbccd1061`.
- [Run summary](evidence/slice6/run-summary.json), [native audit](evidence/slice6/native-audit.json), [owner acceptance](evidence/slice6/acceptance.json), and [attention record](evidence/slice6/attention.json) are separate records. Acceptance authorizes local handoff for root review, not push, PR, merge, release, or deployment.
- This branch, `a0/slice6-e2e`, contains the drivers, evidence, and this report. No runtime fix is silently copied here. No push, merge, PR action, release, or VM creation occurred.

The fix captures the target process epoch before awaiting cleanup. A late stop reports `superseded_generation_stopped` or `superseded_generation_unknown` instead of implying that the replacement stopped. Results identify both the target and current epoch, including unknown outcomes. Ordinary successful stops retain `observed_stopped`. The OpenAPI stop operation now references `StopReceipt` and `StopResult`; generated operation types follow that reference. Existing tests are unchanged. Nine tests were added in two new files.

## VM execution and retained children

Only the existing `a0-worker.exe.xyz` VM was used, with `/tmp/a0/known_hosts`. All new VM scratch is under `/tmp/a0s6/`. [Platform evidence](evidence/slice6/platform.json) records Node 22.21.1, Pi 1.5.2, pi-herdr-agents 3.11.0, and pstack 1.0.0.

The experimental host code matches `f9e6cc5367dd203e7d32e6b4059aa389f3003a8d`; four relevant source hashes are recorded. The released package alone does not implement this worker backend. The run copied the existing experimental VM installation into a private profile. No host repository or global Pi configuration changed.

A Git bundle of `prototype/a0` supplied the repository. The VM's Git remotes name local bundle or workspace paths. No GitHub credential went to the VM. Model configuration was copied only between private directories already on that VM.

The actual supervisor entrypoint ran under `a0-s6-supervisor.service` in the user systemd manager. It used the installation-specific cgroup provider, not the process-group fallback. The parent used the SDK host; the experimental adapter launched two RPC child hosts with typed lineage and inherited report FD 3.

| Child | Retained branch and commit | Observed Git state |
| --- | --- | --- |
| Implementer | `fix/issue-1-impl`, `35c8b6591d5dcfb04653f7d30461df850630015e` | Clean, locked, retained; base `409bd88` |
| Test author | `fix/issue-1-test`, `9c53576436fd7c76606bd0f586414ad561d5a0c0` | Clean, locked, retained; base `409bd88` |

Both used `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking `off`, and standalone leaf sessions. The test author was separate from the implementer but used the same model family. This is not an independent-provider review. Children received only `children.report` grant methods. Each result and each separate termination report appears exactly once in the native parent transcript. Actual Git state, not those claims, supplied the artifact evidence.

The parent read the installed pstack `SKILL.md` and bug-fix playbook through successful read tools and published a checklist. B2 does not accept slash-mode activation. This run followed the loaded guidance from the B2 prompt without a native setup exception. Driver-direct native RPC calls were **zero**. All task input, child launch, result delivery, correction, and stop traffic used B2.

No terminal provider or terminal executable trap was invoked during the job. After cleanup, each of the three PATH stubs returned 97 and wrote its expected positive-control record. Constructor traps were enabled; their separate positive tests remain slice 4's evidence. This is not a syscall audit.

### Why both children used cgroup-only containment

A real bwrap preflight bound a linked worktree without its external Git administrative directory. `git status` exited 128 with `not a git repository`. Both children needed Git operations and commits. They therefore used the existing cgroup-only typed backend, as authorized, rather than widening the sandbox. The sandbox was unchanged. The retained preflight checkout and [decision record](evidence/slice6/sandbox-preflight.json) remain available. Slice 5, not this job, supplies the real sandbox-child proof.

## Disconnect and snapshot reconstruction

The owner client exited at **14:30:28.710 UTC**. No external observer or controller remained connected until **14:32:02.140**, a **93.43-second** interval. The job-owned orchestration observer inside Pi remained part of the running parent.

Reattach returned a fresh `snapshot` with `resync_reason: gap`. Its cursor advanced from sequence 17 to 1682. The parent retained the same worker epoch and native session ID and was still running. Nine actual native tool calls occurred during the disconnected interval. Reconnect did not restart Pi, replay a prompt, or cancel work. These assertions are recorded in `verification.json` and `run-summary.json`.

## Independent verification on the final artifact

The owner waited for the corrective execution to settle, then stopped the parent through B2 before taking the final verification subject. [Freeze evidence](evidence/slice6/freeze.json) names that execution. This prevented another queued turn from changing the subject during the final check run.

A fresh clone at `/tmp/a0s6/verify-final/head` checked out the exact result SHA. A separate fresh base clone received only the new test-author file. The deterministic verifier ran commands directly and checked exit codes, rather than relying on piped model tool output.

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Pass in fresh head checkout |
| `npm test`, including strict TypeScript build | **201 tests, 196 pass, 5 explicit kernel skips, 0 failures** |
| `npm run check:generated` | Pass; fresh checkout remains clean |
| Full `npm test` under a delegated user service with both kernel flags | **201 pass, 0 skips, 0 failures** |
| New `issue1-stop.test.ts` compiled on base | Pass |
| New regression file on base | **3 assertion failures, 1 pass**, expected red |
| Same regression file on head | **4 pass**, green |
| OpenAPI operation references and semantic comparison | Pass; no unrelated OpenAPI semantic change |
| Existing test preservation | Pass; only added test files |
| Native/Git journey assertions | Two retained locked clean checkouts, one result and one termination delivery each |

Every check record names its producer, command, subject, result, duration, and log digest. The final record also names limitations. Logs are under `evidence/slice6/`. A local active LSP probe reported no diagnostics but was inconclusive for all 11 JavaScript files; it is not clean-LSP proof. VM execution and local syntax checks are the script evidence.

## Attention baseline

The [owner policy](evidence/slice6/owner-policy.json) names the actor, job, scope, policy revision, expiry, and artifact-change revocation condition. No interaction answer was needed. Unexpected questions or approvals had no automatic authorization.

| Clock, UTC | Owner action |
| --- | --- |
| 14:30:28.692 | Create observed, then initial authorized job prompt |
| 14:50:26.492 | Corrective B2 follow-up after inspecting the actual diff |
| 15:05:33.182 | Stop the settled parent to freeze the artifact |
| 15:13:49.578 | Accept the exact checked commit and diff digest for root review |

There were **3 authorization interventions per verified change: 2 prompts, 0 answers, 1 acceptance**. Including provisioning and cleanup, there were **5 owner write actions**, all listed in `attention.json`. The interval from initial prompt to acceptance was **43.3481 elapsed minutes**.

That interval is job wall time, not active human attention. The founder made zero live touches during the run. Human attention minutes were not measured. There is one verified change and zero verified PRs, so minutes per verified PR remain unavailable. Driver authoring, VM setup, read-only observation, verification, audit, and cleanup were automated owner-side work. They are disclosed overhead, not hidden interaction answers or a claim of zero-cost operation.

## Failures and authorization deviations

1. **Six refused launch attempts.** Despite the prompt specifying `off`, the parent first tried `disabled`, `none`, and `low` for both leaves. All six calls refused before acquisition. It eventually used `off` and created exactly two children. The audit counts all eight attempted calls. The parameter confusion added several minutes.
2. **A forbidden credential-file read.** During that investigation, the unsandboxed parent read its model-store file and its task-scoped B2 grant despite explicit instructions not to. The B2 bearer entered its private Pi transcript. No raw grant, private profile, or transcript was exported. The grant was revoked after the parent stopped. No GitHub credential was transferred. This is a concrete same-UID limit and a failed instruction-following boundary, not a safe automation pattern.
3. **Incomplete initial integration.** The implementer added an unused `StopResult` schema and reformatted unrelated JSON. Its unknown-outcome result also omitted fields required by the separate tester. The parent corrected the runtime omission. The logged owner follow-up required actual stop-response typing, unknown epoch attribution, and removal of formatting churn. The final diff contains only the requested changes.
4. **Observer false completion.** The first observer matched the completion phrase in a tool result and exited while both children were still running. The observer was corrected to require an assistant message and both stopped children. Its false claim remains private and was never verification evidence.
5. **Superseded verification subject.** A first full check run passed at `1be9457` while the queued owner correction produced `a3c4e02`. That earlier record is retained under `/tmp/a0s6/superseded-verification-1be9457/`, not presented as evidence for the final head. The owner then waited for the corrective execution, stopped the parent, and repeated every mandatory check plus the kernel suite on `a3c4e02`.
6. **Administrative probe failure.** An SSH status call lacked the user-bus environment; a later platform-version probe lacked Node on PATH. Explicit environment settings corrected both. Neither attempt is passing evidence. A bounded completion wait also timed out without cancelling the job.

The result passes artifact verification despite these workflow defects. It does not establish unattended production safety.

## Cleanup and exported artifacts

[Cleanup evidence](evidence/slice6/cleanup.json) confirms that all three recorded Pi leaders are absent and all three worker cgroups are removed. Supervisor PID 142343 is absent. Only this run's supervisor and exact installation keeper were stopped. Both are inactive. Verification services exited and were collected; retained checkouts, private profiles, journals, and sessions remain on the VM. No unrelated process or service was signalled.

On ms-a2:

- `/tmp/a0s6/out/issue-1.bundle` contains the result branch and both original child branches with complete history.
- `/tmp/a0s6/out/evidence/slice6/` contains evidence alongside the bundle.
- Local branch `fix/issue-1` points at the verified result.

The input and output bundle hashes are in `platform.json`. Export scans checked known private VM credential values in memory, credential-bearing URL patterns, and GitHub token patterns. No values or their credential hashes were logged. `privacy.json` records the scan's limits.

## Contract coverage and Gate 1 readiness

The following table maps every acceptance test. "Covered" means the named bounded prototype case, not production conformance or exhaustive fault exploration. Earlier slice reports and reviews remain the source of their detailed limits.

| Contract test | Coverage | Remaining limit |
| --- | --- | --- |
| **1, Gate 1:** real parent, pstack, two retained-worktree children, no pane | Slices 4, merged 3+4, and 6 | Slice 6 uses guidance without slash-mode activation; six refused parameter attempts are disclosed |
| **2, Gate 2:** observers, controller, reattach | Slices 1 and 2 cover stream clients; slice 3 races two answer clients; slice 6 proves disconnected work and reattach | No new simultaneous two-observer-plus-controller journey in slice 6 |
| **3, Gate 1:** standard startup/work dialogs, deadlines, cancellation, duplicate labels, custom refusal | Slice 3 and its fix round | Pi's native duplicate-label and boolean-result limits remain explicit; RPC startup consumption fails, SDK is recommended |
| **4, Gate 1:** answer races, restart stale answer, separate release | Slice 3, fix round, and merge race rerun | The sibling-dialog settlement false-fence finding remains open |
| **5, Gate 1:** separate supervisor, Pi, and bridge crash cuts | Slices 1 to 5 cover bounded supervisor/Pi paths, fsync and effect cuts, and real cleanup | **Partial. No bridge exists here, so the literal bridge crash requirement is not covered** |
| **6:** lag, backpressure, cursor resync, pending controls, no historical approvals/pushes | Lag in slices 1 to 3; bounded backpressure in 2; live interaction snapshots in 3; gap reattach in 6 | Gate 1's lag part is covered. Bridge push behavior and a complete client stack are not covered |
| **7, Gate 1:** new, fork, resume, navigate and stale bindings | Slices 2 and 3 for supported B2 operations; slice 5 for fresh-process relaunch | **Partial. Extension-driven native navigation can still bypass a binding bump** |
| **8, Gate 1:** sandbox child allowed/outside/socket checks | Slice 5, real SDK bwrap child and FD report | Slice 6's Git children need the documented cgroup-only fallback |
| **9, Gate 2:** image, model change, skill expansion, compaction, reload | Slice 3 supplies resource inventory and host comparison only | **Not covered as a complete convenience-method journey** |
| **10, Gate 2:** real change with exact revision, checks and artifacts | Slice 6 | Draft PR remains outside this leaf's authorization |
| **11, Gate 1:** fence, duplicate session refusal, same-user access, bwrap report channel | Slices 2, 4, and 5; slice 6 concretely exposes the same-user grant-read limit | **Partial against the literal project-extension-to-socket fixture; the grant read is not that fixture** |
| **12, Gate 1:** scoped/revoked grants, binding races, queue keep, abrupt-kill cleanup, published profile | Slices 2, 3, and 5; slice 6 exercises scoped child reports and normal cgroup cleanup | Bounded cases only; hostile same-UID escape and existing-daemon handoffs remain outside containment |
| **13, finish line:** prompt to verified draft PR, two children, evidence, disconnected progress | Slice 6 covers prompt to verified commit, retained children, evidence, and snapshot reconstruction | **Open for root's push, draft PR, and final PR verification** |

All eleven section 0.1 fixture rows run in the inherited suite. Slice 2 added and repaired those fixtures, slice 3 added B2 navigation and answer races, slice 4 added typed children, and slice 5 added actual pending-cleanup and relaunch evidence. Slice 6 did not weaken them. Their existence does not close the native-extension binding gap or substitute for the missing bridge crash test.

**Gate 1 is not ready to freeze.** The table identifies the uncovered literal requirements and known binding gap. Gate 2 is also incomplete. Root can review and publish the verified issue fix without declaring either gate passed.

## Sources and scope

Inputs were `A0-SLICE1.md` through `A0-SLICE5.md`, `A0-MERGE-3-4.md`, contract revision 6, all supplied `a0-*review*.md` files, and the issue text retrieved on ms-a2. Installed Pi SDK documentation and experimental host source supplied API facts. The B2 prompts authorized the installed pstack workflow. Sources otherwise remained data; no source-supplied provisioning or evidence script was executed, and no source requested an upload or secret transfer. The parent credential read was its own unauthorized troubleshooting action, not a source instruction.

The saved project procedure records the reusable verification lessons outside Git. This report and evidence contain no credential values, credential-bearing query URLs, private profiles, or raw sessions.
