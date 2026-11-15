# A0 slice 7 — close the Gate 1 gaps

**Complete for the authorized throwaway build. My verdict: Gate 1's bounded prototype cases are now covered, against contract revision 7. Recommend root review, then founder approval of the invariant freeze—not production approval.** Gate 2 and the verified-draft-PR finish line are not completed by this slice. No subagents, pushes, merges, PR actions, VM creation, or tailnet changes.

## Subjects and verification

Requested base: **`b4612533ee7c284085954747e6f46ab2e9cdcbb5`** (PR #2 included). Final runtime **and tests** end at **`fd99c8992941f16187e8b54affd8f9d2f6a6b3dd`**, tree **`efa1b492b8c713ab5888c66c27498111e6f9b18c`**. Later commits package evidence and documentation. The earlier candidate was superseded after the profile-staging defect below; its records and invalidated acceptance remain under `evidence/slice7/superseded-pre-broker-fix/`, not presented as current proof.

| Check | Local | Existing `a0-worker` VM |
| --- | --- | --- |
| `npm test` (includes strict TypeScript build) | **216 tests: 209 pass, 7 kernel skips, 0 failures** | **216 tests: 209 pass, 7 kernel skips, 0 failures** |
| Full suite in delegated user service, both kernel flags | **216 pass, 0 skips/failures** | **216 pass, 0 skips/failures** |
| `npm run check:generated` | Pass | Pass |
| Final `a0-*` user-service inventory | Empty | Empty |
| Final source manifest | 68 files | Identical 68 files |

[Checks](evidence/slice7/checks.json), [source manifest](evidence/slice7/source-manifest.json), [local final audit](evidence/slice7/local-final-audit.json), [VM final audit](evidence/slice7/vm-final-audit.json). Local Node 26.13.0; VM Node 22.21.1, Pi 1.5.2, bubblewrap 0.9.0, pi-herdr-agents 3.11.0, pstack 1.0.0. The experimental host execution files match `f9e6cc5367dd203e7d32e6b4059aa389f3003a8d`; that separate repository was not edited. Active LSP probes reported no findings but were inconclusive; the strict compiler supplies type evidence. Shell checks, JavaScript syntax checks, Python Ruff checks, and `git diff --check` pass.

Fifteen tests were added to the 201-test base. No existing test was deleted. One obsolete assertion that *all* sandbox parents must refuse now asserts that SDK parents are allowed; the actual isolation checks remain and are strengthened by a real-parent regression.

## Each requested gap

### 1. Git inside sandboxed linked worktrees

`src/git-sandbox.ts` supplies sparse mounts: the worktree's own administrative directory is writable, shared objects are writable, and only its private branch/reflog namespace is writable. Common config, packed refs, other refs/reflogs and ignore patterns are read-only. Neither the main checkout nor host home is mounted.

Ref lock creation and atomic rename require directory writes. Therefore a named branch must have a unique two-component namespace, for example `task-UUID/work`, with no sibling ref at launch. Flat/shared namespaces refuse before spawn. Detached HEAD is also supported. **Tradeoff:** a child can corrupt shared objects or create an extra ref in its own namespace. This is not hostile Git isolation. The owner compares the complete refs map, allows only declared branch heads, and runs Git fsck. The real job changed exactly its parent and two child branches; no unrelated ref moved and no undeclared ref appeared.

`gate1-git.test.ts` runs actual bwrap + `git status/add/commit`, refuses writes to an existing unrelated branch and sibling namespace, and denies the main-checkout sentinel. A portable test pins the flat/shared-namespace refusals. Both real VM children independently used Git and committed.

### 2. The parent is sandboxed too

SDK/ACP parents use the same bwrap root policy, private PID/proc/tmp/run/home and environment allowlist as children. Supervisor state, real B2 socket and grant files are absent. A sandboxed parent cannot launch an unconfined child.

A per-worker, per-generation Unix socket is mounted alone at `/run/a0-parent/socket`. The public compatibility config is **not a B2 bearer**. The supervisor retains and rechecks the real caller grant. The channel exposes own/direct-child inventory and readback, child creation/input/stop, and receipts; it refuses unrelated workers and does not expose interaction answers, fence resolution, relaunch, or arbitrary methods. It retires with the parent generation.

The existing experimental host still owns worktree acquisition and orchestration. Its child `workers.create` request passes through a thin compatibility adapter: require its own current parent binding, constrain cwd under `ROOT/.a0-worktrees`, copy/remap only the explicit staged profile, and narrow execution to SDK+bwrap. Resource inheritance checks recognize that profile-relative remapping. Children get only report FD 3, neither control socket.

**Credential exception:** Pi needs the VM-local **`.a0-agent/models-store.json`**, deliberately staged and overlaid **read-only** in each sandbox. It remains readable by code in that sandbox. No host model credential or GitHub credential was transferred. An empty auth store may be created; no credential-bearing auth file was staged. The generic profile also overlays `auth.json` read-only if explicitly present. Network is shared, so readable model credentials are not protected against exfiltration.

The real-parent regression and the live parent's successful Bash permission check prove direct B2 grant/journal reads fail. The regression also checks the allowed credential-store read and refused write.

**Self-review found and fixed a broker bypass before final acceptance:** `cpSync(...dereference:true)` followed a parent-created profile symlink and copied the supervisor's otherwise inaccessible grant into the child workspace. Both the portable staging test and a real sandbox attack probe reproduced it by assertion. Staging now uses `dereference:false, verbatimSymlinks:true`: external links stay inaccessible links, and internal relative package links remain relative. Both regressions pass; reverting this guard fails them again. The earlier candidate and its acceptance were invalidated, and the complete real job plus every mandatory check was repeated on `fd99c89`. No grant value was printed/exported by these synthetic probes.

### 3. Native extension session moves invalidate bindings

SDK/ACP bind actual command-context lifecycle actions, emit native replacement observations, and observe `session_tree` through an inline extension—not just `AgentSession.subscribe`, where that event is absent. RPC's audit extension observes native session start/tree events. The supervisor bumps the binding, invalidates interactions/queued work, updates the native identity/selected leaf, and persists the new binding. B2-owned moves retain one revision bump instead of double-counting their observation. A replacement-in-progress blocks writes. RPC appended entries advance its selected leaf without inventing another binding move.

`gate1-native-binding.test.ts` drives real extension commands in **all three hosts**, with no model request: seeded new session, tree navigation without an append, ordinary append, fork, new and resume. It compares the native leaf (`get_tree` for RPC), keeps the PID, and refuses every old binding. An ordinary append does not bump the revision. SDK/ACP B2 navigation remains supported; direct B2 RPC navigation remains explicitly unsupported.

### 4. Literal project-extension socket fixture

`gate1-parent.test.ts` loads the same project-extension specimen from `.pi/extensions`. Unsandboxed, it successfully connects to the **real B2 socket** and reads the grant/state as the same UID. Sandboxed as a parent, those three probes fail; its own channel works, unrelated-worker access refuses, and filtered inventory contains only itself. This is the named unsandboxed same-user limit, not a claim that private socket modes isolate project code. It runs locally and on the VM in the kernel suite.

### 5. Sibling-dialog false fence

Unrelated `agent_settled`/`tool_execution_end` events no longer perform blanket invalidation for supported dialogs. Exact resolver/deadline events own their closure; explicit binding changes/exit/cancel still invalidate them. Four regressions hold accepted input/approval answers while a sibling dialog remains pending, settle the sibling, then require stage 3, no fence, stable duplicate receipt, and the live sibling card. The prior stale-binding answer-race tests remain green.

### 6. Commit **and tree**, advisory diff bytes

`src/artifact.ts` captures `git rev-parse COMMIT^{commit}` and **`git rev-parse COMMIT^{tree}`**. Any diff digest is marked advisory and records its producing Git version. New verification/check/acceptance records bind those IDs; raw test logs are bound by their check records and hashes. Supporting VM records received explicit producer/subject metadata during packaging, disclosed in [packaging.json](evidence/slice7/packaging.json). Historical slice-6 records remain historical, not silently upgraded.

The independent [record checker](evidence/slice7/assert-record.mjs) rejects the actual old slice-6 record for its missing tree ID and accepts the new verification record. The unit test compares IDs with native Git, distinguishes commits sharing a tree, and pins advisory/version metadata. Tree-as-commit, non-advisory diff and missing-version reversions all fail assertions.

### 7. Real job, both levels sandboxed

The final VM run used **`/tmp/a0s7/run2/`**, the existing provider/model `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking `off`, and B2 for all task/control traffic. **Driver-direct native calls: zero.** The parent successfully read pstack's installed skill/playbook, published its checklist, and acquired exactly two bare leaves. It first made four refused `disabled`/`none` thinking attempts, then two successful `off` launches. The unchanged zero-refusal audit therefore **failed** and is retained as `audit2-zero-refusal-failed.log`; it is not relabelled passing. An additional acceptance audit checks all six attempts, their exact refusal class, exactly two provisioning manifests, three workers total, and the two actual children. These refusals occurred before acquisition, not after an unknown launch. There were no extra worktrees or replacements. This is guidance from the B2 prompt, not native slash-mode activation or independent-provider review.

The note writer added the existing-daemon containment limit to README's limits section. The check author added a tiny assertion script and demonstrated the expected red result before integration. The parent inspected and cherry-picked both commits, ran the checker and whitespace check, then settled. Independent audit checked actual Git/native records, not its completion text.

| Artifact | Commit | Tree |
| --- | --- | --- |
| Note child, `s7-note/task` | `b759cc6e989dda572738cfd187bd81d39e0b790d` | `fa730baaf11e6c6f5c0d85d10d957dbdd3eb129f` |
| Check child, `s7-check/task` | `8d517d5a43642417ee988c103cf82e341dcead17` | `12a7ed8cc52bf5b312bf971a58c91d8cb0ea5007` |
| Integrated `job/slice7` | **`07832f232b8b97e5c06f074fac60074b38ee33a3`** | **`8489c92caa773802a3c57440de20d6a10e4380b3`** |

Both children are clean, locked, retained and one commit above the exact base. Each delivered **one FD result**, and each result and separate termination record appears **once** in the native parent transcript. All three workers were SDK+bwrap with cgroup cleanup. Traps show no terminal-provider/executable use; executable positive controls ran only after freeze. This is not a syscall audit.

There were **407.542 seconds between owner disconnect and reconnect snapshot**. Twenty-nine actual parent tool calls occurred in the gap. Reattach returned `gap`, preserved the parent epoch/session, and did not restart/replay/cancel Pi. The job-owned orchestrator inside Pi stayed connected.

After settlement the owner stopped the parent through B2, froze the subject, then used a fresh checkout for dependency install, full default/kernel suites and generated types: **216 tests, 209 pass + 7 skips by default; 216/216 with kernel flags**. These are new checks on the final job artifact, separate from the local/VM worker-source checks. Exact README bytes, changed-file set, native deliveries, full refs map and Git fsck were independently checked. The model-authored checker was inspected, not executed by the owner verifier.

[Verification](evidence/slice7/verification.json), [native audit](evidence/slice7/native-audit.json), [acceptance](evidence/slice7/acceptance.json), [attention](evidence/slice7/attention.json), [cleanup](evidence/slice7/cleanup.json), [platform](evidence/slice7/platform.json). The final result is fetched locally as **`a0/slice7-result-final`**, not merged into this task branch. The older `a0/slice7-result` is superseded. Bundles and private journals/profiles/sessions remain on the VM; the final local bundle is `/tmp/a0s7/result-final.bundle`, and the VM bundle is `/tmp/a0s7/out2/result.bundle`. No PR was needed or attempted.

## Regression and crash evidence

[Reversion results](evidence/slice7/reversions.json): ten cross-version regression cases compile on `b461253`, then **10/10 fail by assertion**; the fixed copy passes. The portable broker case uses a router parameter absent on that old base, so it is omitted only from that comparison. Its **two before-fix assertion failures** (including the real bwrap probe) were separately recorded on pre-fix source `249be1b`. **12/12 targeted reversions compile and fail assertions**, not timeouts or compiler failures: Git mounts/private namespace, unsandboxed parent, unrelated-worker channel access, profile-link dereferencing, native binding, SDK/RPC native-tree observations, sibling cleanup, and all three evidence metadata guards. The old-record evidence check is separately red/green. These are targeted guards, not an exhaustive mutation score.

`gate1-pi-cuts.test.ts` adds **three real Pi leader SIGKILLs**, immediately after the prompt intent, dispatch/accepted and delivered/result fsyncs, while the supervisor stays alive. Pre-delivery cuts report unknown/fenced with zero native effects; the delivered cut retains its final receipt and one independently read effect. Recovery and duplicate lookup never spawn/replay or add effects. This complements—not relabels—the inherited actual-supervisor SIGKILL matrices and older live-Pi cuts.

The full suite still runs all inherited crash/conformance cases. Current log groups report **175 core fsync cuts, 45 child cuts, 13 contained-create cuts, 47 containment/relaunch cuts, and 77 scenario + 7 recovery interaction cuts**: 364 selected fsync occurrences. Native-effect and queue-readiness cuts remain separate. These are bounded scenarios and process-crash evidence, not exhaustive state-space or power-loss proof.

## Gate 1 table — contract revision 7

“Covered” means the named bounded prototype case, with the stated host/profile limits. It does not erase earlier production deferrals.

| Gate 1 requirement | Status | Slice and evidence |
| --- | --- | --- |
| **1** Real parent, pstack, two retained-worktree children, no pane | **Covered** | Slices 4/merge/6; slice 7 native audit proves two SDK+bwrap Git writers, guidance reads, once-per-kind delivery and no terminal trap during work. |
| **3** Standard startup/work dialogs, timeout/cancel, duplicate labels, custom refusal | **Covered for selected SDK host** | Slice 3 and fix-round real-Pi comparison; inherited dialog/resolver tests rerun. RPC remains stage 2 and cannot consume its tested startup answer; duplicate native label strings retain Pi's limitation. |
| **4** Answer races, timeout/restart stale answers, separate release | **Covered** | Slice 3/fix/merge races and gate checks; slice 7 closes the sibling-settlement false fence. |
| **5: supervisor cuts** | **Covered** | Slices 1–5 real fsync/SIGKILL and native-effect oracles, rerun in both final suites. No blind replay or duplicate effect. |
| **5: Pi cuts** | **Covered** | Earlier Pi-death/cleanup journeys plus slice 7's real intent/dispatch/result Pi-kill cases, default suites on both hosts. **Bridge cuts are Gate 2 in revision 7.** |
| **7** New/fork/resume/tree identity and stale bindings | **Covered** | Slices 2/3 B2 transitions; slice 5 fresh-process relaunch; slice 7 real native extension moves in SDK/ACP/RPC, native leaf comparison and stale refusals. |
| **8** bwrap allowed/outside/socket refusal | **Covered** | Slice 5 real child and root-pinned reads; slice 7 adds Git operations and parent isolation, local+VM kernel suites and real job. |
| **11** Fence/duplicate session/same-user project extension/FD report | **Covered** | Slices 2–5 fence and duplicate-open cases; slice 7 literal project-extension socket positive/negative fixture and two live sandbox FD results. |
| **12** Scoped/revoked authority, delayed mutation, paused queue/keep, abrupt-kill cleanup/profile | **Covered** | Slices 2/3/5 fixtures, gate release revocation and detached-grandchild cleanup, all rerun. Slice 7 adds own/direct-child channel filtering and full-ref verification. Existing-daemon handoffs and hostile same-UID code remain named limits. |
| **6, history-lag part only** | **Covered** | Slices 1–3 lag/watermark/stage tests rerun; slice 7 confirms snapshot identity after disconnected work. Remaining client/push surfaces are Gate 2. |
| **0.1 fixtures** | **Covered** | All eleven replay rows run in both final suites; details below. |

| Section 0.1 row | Coverage |
| --- | --- |
| bound → new/fork/resume/tree, invalidate old binding | Fixture `01-binding`, slice 3 navigation, slice 7 native-move tests |
| mutation unknown → fsynced fence before reply | `02-unknown`, HTTP disk-at-reply and crash oracles |
| fenced write → no-effect naming cause | `03-fenced-write`, supported/unsupported-write checks |
| fenced due work → paused | `04-paused`, follow-up/child queue tests |
| keep → resume queued work | `05-keep`, queue tests; slice 5 exact kept prompt/relaunch |
| abandon → drop, no replay | `06-abandon`, recovery/drop tests |
| observed → settlement evidence only | `07-observed`, exact journal/session and negative admission/other-run tests |
| wrong generation → unchanged fence | `08-generation` |
| restart → cleanup pending until recorded proof | `09-restart`, contained recovery and detached-grandchild kernel tests |
| cleanup pending → resume refused | `10-cleanup-resume`, cleanup-only and populated-domain cases |
| cancel/interrupt allowed while fenced | `11-control`, queue/abort/stop effect cuts |

**Gate 1 verdict: covered for the bounded Linux SDK prototype, ready for root review of the freeze.** The founder still owns that decision. Gate 2's bridge cuts, full convenience/client surfaces, and test 13's verified draft PR remain outside this slice. No production, macOS, hostile same-UID, network confinement, registered environment policy, crash-durable parent-delivery, or exhaustive storage-failure guarantee is claimed.

## Attention, failures, cleanup and sources

- **Final run:** two authorization interventions (one prompt, zero answers/corrections, one acceptance), five owner write actions including create/freeze/cleanup, **15.9349 elapsed minutes** prompt-to-acceptance. **Across both runs: four authorization interventions and ten owner write actions**, including the earlier invalidated acceptance; see [total attention](evidence/slice7/attention-total.json). This is one current verified change and zero verified PRs. Founder live touches were zero; active human attention minutes were not measured. Setup/debug/test/audit authoring is disclosed automated overhead, not hidden human attention.
- Initial checkout was behind the requested PR #2 base; the three local slice-7 commits were rebased onto `b461253` before final work/testing. No unrelated changes were present or lost.
- An early native fixture used a stale Pi command context; it was corrected. The authoritative old-base proof is the isolated `b461253` run, not exploratory `native-before.log`. SCP brace expansion and a scratch-script relocation caused transfer failures, not passing checks. The second setup initially retained one old grant-directory literal; exclusive creation refused without overwriting the old revoked grant, then a corrected continuation registered only the new run. One immediate `hello` hit startup `ENOENT/before_write/no_effect`; the subsequent start was safe because no B2 mutation had been sent. The zero-refusal audit failure remains explicitly failed. No failed check was counted as passing.
- Every recorded Pi leader from both runs is absent, all six job domains are removed, both scoped task grants are revoked, and only the exact run supervisors/keepers were stopped. Both hosts' **post-final-suite** `a0-*` inventories are empty. No other VM, process or service was signalled. Worktrees/private sessions remain retained.
- Inputs: A0-SLICE1 through A0-SLICE6, A0-MERGE-3-4, contract revision **7**, all supplied `a0-*review*.md`, installed Pi 1.5.2 SDK/lifecycle source and the unchanged experimental adapter. Sources were data, not authorization. Newly authored drivers ran; historical source-supplied reproduction/provisioning scripts did not. No source requested a secret transfer or upload. The only provider adaptation removes `/exe.dev`'s existence guard in a private VM profile after a hostname check; that directory is not mounted.
- [Privacy evidence](evidence/slice7/privacy.json) compares known private values in memory without exporting or hashing credentials. Whitelisted records/logs and the two committed job blobs were scanned; raw grants, model stores, private profiles and native transcripts were not exported. Final documentation/harness exports receive an additional scan. Scans do not prove absence of transformed/unknown secrets.
