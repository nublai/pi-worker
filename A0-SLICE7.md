# A0 slice 7 — close the Gate 1 gaps

> **Security fix round (2026-11-15) supersedes the original verdict below.** Two independent reviews found that the slice's parent sandbox could be escaped: a symlinked `ROOT/.a0-worktrees` gave a child an arbitrary host root (B1), profile staging could be raced into copying unreadable files (B2), and sandbox-writable Git metadata could run code as the owner (M1). All three, and the listed minors, are fixed with regressions on runtime **`c8bfbdbfbbce2c257458b60362c7e6752763b66f`** (tree `52d1653219cfbb3b1151bdbb5a42706963a9fd34`). See [Security fix round](#security-fix-round) and the corrected Gate 1 table. The original claims for items 8 and 12 were **not met** as first stated.
>
> **Owner-Git follow-up (2026-11-15).** A delta review (Grok, `nubl/.pi/plan/research/a0-slice7-security-delta.md`) found that the M1 fix was not one step: a sandboxed parent could still rewrite a child's `commondir` between the owner pin check and Git's own open of it, so owner `safeGit diff` could run a planted diff driver or filter. Owner Git now runs on a private snapshot of the pinned metadata and ignores global/system config. Runtime **`244bc54`**; records on `51a8641` (same `src/`). See [Owner-Git follow-up](#owner-git-follow-up-grok-delta-review-fixed).

**Complete for the authorized throwaway build. My verdict, after the security fix round: Gate 1's bounded prototype cases are covered against contract revision 7, with the stated limits. Recommend root review, then founder approval of the invariant freeze—not production approval.** Gate 2 and the verified-draft-PR finish line are not completed by this slice. No subagents, pushes, merges, PR actions, VM creation, or tailnet changes.

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

> **Corrected in the security fix round:** the worktree's `.git`, its admin `gitdir`/`commondir`/symbolic `HEAD`, and `objects/info` are now read-only too. Every mount source is an O_NOFOLLOW descriptor, and owner Git goes through a pinned helper. The refs-map check alone was not a Git mitigation.

`src/git-sandbox.ts` supplies sparse mounts: the worktree's own administrative directory is writable, shared objects are writable, and only its private branch/reflog namespace is writable. Common config, packed refs, other refs/reflogs and ignore patterns are read-only. Neither the main checkout nor host home is mounted.

Ref lock creation and atomic rename require directory writes. Therefore a named branch must have a unique two-component namespace, for example `task-UUID/work`, with no sibling ref at launch. Flat/shared namespaces refuse before spawn. Detached HEAD is also supported. **Tradeoff:** a child can corrupt shared objects or create an extra ref in its own namespace. This is not hostile Git isolation. The owner compares the complete refs map, allows only declared branch heads, and runs Git fsck. The real job changed exactly its parent and two child branches; no unrelated ref moved and no undeclared ref appeared.

`gate1-git.test.ts` runs actual bwrap + `git status/add/commit`, refuses writes to an existing unrelated branch and sibling namespace, and denies the main-checkout sentinel. A portable test pins the flat/shared-namespace refusals. Both real VM children independently used Git and committed.

### 2. The parent is sandboxed too

> **Corrected in the security fix round.** The text below describes the first candidate. Its cwd check trusted a parent-writable path, the channel acted with the owner's grant, and staging raced. The current mechanism is in [Security fix round](#security-fix-round).

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

## Security fix round

**Status: complete. All three blockers are fixed with regressions, on runtime `c8bfbdbfbbce2c257458b60362c7e6752763b66f` (tree `52d1653219cfbb3b1151bdbb5a42706963a9fd34`), base `1f38036`.** The inputs were the two reviews (Claude, `nubl/.pi/plan/research/a0-slice7-review.md`: B1, B2, M1, minors; Grok, `nubl/.pi/plan/research/a0-slice7-security.md`: blockers 1 and 2, minors, nits). Both are local nubl planning files. I reproduced each blocker on the old code before fixing it. No reviewer script was executed: their probes were re-authored as tests.

| Check (`c8bfbdb`) | Local (Node 26.13, bwrap 0.11.1) | `a0-worker` VM (Node 22.21, bwrap 0.9.0) |
| --- | --- | --- |
| `npm test` | **233 tests: 221 pass, 12 kernel skips, 0 failures** | **233: 221 pass, 12 skips, 0 failures** |
| Full suite, delegated user service, `A0_TEST_BWRAP=1` + cgroup | **233/233 pass** | **233/233 pass** |
| `npm run check:generated` | Pass (`git_pin` added to `Worker`) | not run (no checkout on VM; `git archive` copy) |
| Final `a0-*` user units | Empty | Empty |

The run added 17 tests to the 216-test base, five of them kernel-only. No test was removed or weakened. Four existing tests changed:
- `gate1-parent`'s portable staging test now uses an *accepted* launch, because staging no longer happens on refusal. It also asserts that a refused launch copies nothing.
- `gate1-parent`'s real-bwrap test gains the PROBE A attack.
- `gate1-git` passes mount descriptors to `spawnSync`.
- `gate1-artifact` passes a pin.

Records: [checks](evidence/slice7-security/checks.json), [reversions](evidence/slice7-security/reversions.json), logs under [evidence/slice7-security/](evidence/slice7-security/). Each record binds its commit and tree through the pinned helper ([record.mjs](evidence/slice7-security/record.mjs)).

### B1 — the parent channel could hand a child any host directory: **fixed**

Verified on the old code. In the portable channel probe, a child launched through a symlinked `.a0-worktrees` was **delivered**, rooted in the outside directory. The real-bwrap PROBE A got **HTTP 200**: [before-1f38036.log](evidence/slice7-security/before-fix/before-1f38036.log), [probe-a-before-1f38036.log](evidence/slice7-security/before-fix/probe-a-before-1f38036.log).

- **The child root is opened, never resolved.** A channel child's `cwd` must be exactly `PARENT_ROOT/.a0-worktrees/<name>`. The supervisor opens the canonical parent root and walks `.a0-worktrees` and `<name>` with `O_NOFOLLOW|O_DIRECTORY`. A symlink at any component refuses with `parent_channel_child_root_not_real_directory`, and so does a different device. This runs before the grant check and again inside the effect, with no `realpath`.
- **bwrap binds that exact descriptor.** It receives `--bind-fd`, never a path the parent can rename. This applies to every sandbox-writable mount source: root, Git dirs and files, and credential stores. bwrap closes each descriptor after binding, so none reaches Pi; a kernel test checks `/proc/self/fd`.
- **The channel acts with its own grant.** `channel-<parent worker>` is scoped to `{worker_ids:[parent], cwd_roots:[parent root]}`. Its methods are the channel set intersected with the parent's source grant, plus the parent's child grant methods. It is never the owner's `*` grant. The source grant is still rechecked on every request, so revoking it stops the channel.
- **Git dirs stay inside the parent root.** A channel child's Git admin and common dirs must lie inside the parent root, which is where the parent's own `.git` lives. A gitfile naming another repository refuses with `sandbox_git_outside_parent_root`.
- **Regressions:**
  - Portable: `.a0-worktrees` and child-entry symlinks, nesting, own grant, worker-less receipts, foreign gitdir.
  - Kernel: an exact-descriptor bind survives a swap after open; PROBE A on a real Pi parent in bwrap.
  - Reversions killed: `channel-directory-check-removed`, `channel-uses-owner-grant`, `root-bound-by-path`, `channel-git-containment-removed`. The first one is the "removed directory check" reversion the reviewer showed surviving; it now fails by assertion.
- **Deviation, stated:** the supervisor does **not** create the child directory itself.
  - Why: the unchanged experimental host (`f9e6cc5`) runs `git worktree add` inside the parent sandbox *before* `workers.create`. Refusing any directory the supervisor did not create would break the real-job path, and fixing that needs a host protocol change in a repository this round may not edit.
  - What holds instead: the root is a real directory reached without links from the parent root, on its device, and bwrap gets that descriptor. Hard links cannot reach outside the parent's own mounts.
  - Consequence: the child gets nothing the parent could not already write.

### B2 — profile staging raced into unreadable files: **fixed**

- **Staging happens only after every validation,** inside the create effect after the dispatch marker. Refused launches copy nothing: the regression sends 20 refused requests during a race and finds empty directories.
- **The copy is descriptor-relative** (`copyTreeAt`). The source dir comes from an `O_NOFOLLOW` walk. Each entry opens with `O_NOFOLLOW|O_NONBLOCK`, and bytes are read from that exact descriptor. A link (`ELOOP`) is recreated verbatim. Special files refuse. A file↔link flip-flop is retried rather than failed. Destination entries are created `O_EXCL|O_NOFOLLOW` under a fresh `.a0-agent`. A pre-existing `.a0-agent` refuses before any write.
- **A staging failure after dispatch reports `unknown` and fences the parent.** It no longer says `no_effect` after a write.
- **Regression:** a separate process atomically swaps 64 profile files between a regular file and a link to an unreadable secret, across 40 accepted launches.
  - Reverting to the old `cpSync(..., dereference:false, verbatimSymlinks:true)` primitive, even after validation, **copied the secret** in each of 3 runs ("staging copied a link target (f24, attempt 1)"). Both `staging-follows-race-cpSync` and `staging-before-validation` are killed.
  - The leak check runs before the receipt check, because the old primitive both fails (`EINVAL`) and steals under this race.

### M1 / Grok blocker 2 — sandbox-written Git metadata ran as the owner: **fixed** (owner helper completed in the [follow-up](#owner-git-follow-up-grok-delta-review-fixed))

Verified on the old code: a decoy `commondir` with `core.fsmonitor` ran its payload from the pre-fix owner audit's `git -C <child> status` ([m1-before-1f38036.log](evidence/slice7-security/before-fix/m1-before-1f38036.log)). Locally, Git 2.53 also runs it from `fsck`.

- **Linked worktrees:** these are read-only inside the sandbox (bound read-only from descriptors):
  - the worktree's `.git` gitfile, which also becomes a mount point that cannot be unlinked or renamed;
  - the admin dir's `gitdir` and `commondir`, plus `config`, `config.worktree` and `hooks` when present;
  - a symbolic `HEAD`, since a commit on a branch never rewrites it;
  - common `config`, `packed-refs`, `shallow`, `info/exclude`, `refs` and `logs`;
  - `objects/info`, which holds alternates.

  Writable: the admin dir itself (index, locks, `ORIG_HEAD`, logs), shared objects, and the private branch/reflog namespace. A detached HEAD stays writable because its commits rewrite it. `git add`/`commit` still work in bwrap.
- **Ordinary (non-linked) checkouts,** such as the live parent's clone: `.git` is bound onto itself as a mount point, so it cannot be renamed away and replaced. `config`, `hooks`, `info` and `objects/info` are read-only; `hooks`, `info` and `objects/info` are created first if absent. A `commondir`/`gitdir` file in an ordinary `.git` refuses.
  - **Interpretation, stated:** "refuse unless `.git` is read-only" is implemented as "every execution-relevant part is read-only, and `.git` is pinned." Making all of `.git` read-only would stop the parent from cherry-picking its children's commits, which is the real job's integration step.
- **Repository config may not contain `include`/`includeIf`, and `extensions.worktreeConfig` refuses.** Either could make a sandbox-writable file effective. This is checked at launch and on every owner command.
- **Launch-time pin.** `GitPin` is a new `Worker.git_pin` in the OpenAPI schema. It records:
  - the gitfile bytes;
  - the git and common dirs;
  - the `gitdir` and `commondir` bytes;
  - a symbolic HEAD;
  - the config sha256;
  - alternates.

  It is read through `O_NOFOLLOW` descriptors when the supervisor first launches the worker.
- **One owner helper, `src/git-safe.ts`.** *(Superseded by the follow-up below: a compare-then-run-by-path helper was raceable.)* Before every Git command it re-reads the pin and refuses on any change (`git_metadata_changed_since_launch`) or a missing pin. It then runs Git with:
  - `--git-dir=<pinned dir>`;
  - `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.ignoreSubmodules=all -c submodule.recurse=false`;
  - inherited `GIT_DIR`/`GIT_CONFIG_*`-style variables removed.

  Callers:
  - `artifactSubject` takes a pin and uses the helper.
  - So do the slice-7 driver, both audits, the verifier, `finish` (including the owner refs-map and `fsck`), the final audit, the record checker and the packager. The driver pins the owner workspace at setup and asserts that the supervisor's launch pin equals it.
  - Slice-6 `audit.mjs`/`verify.mjs` use the helper too. They now refuse to rerun because slice-6 records carry no pin.
- **Regressions:**
  - Portable: plants via `commondir` and via the gitfile are refused without running the payload. A pre-pin `core.fsmonitor` in config still never runs, through `safeGit`, `fsck` and `artifactSubject`. An ordinary-checkout `commondir` plant, a config include, and the mount plan are each covered.
  - Kernel: a child cannot write `.git`, `gitdir`, `commondir`, `HEAD`, alternates or config, and cannot remove or rename `.git`, yet still commits. In an ordinary-checkout root, config, hooks, attributes and alternates are read-only, `.git` cannot be renamed, and the commit works.
  - Reversions killed: `git-pointer-overlays-removed`, `ordinary-checkout-overlays-removed`, `owner-pin-compare-removed`, `owner-safe-config-removed`.

### Owner-Git follow-up (Grok delta review): **fixed**

**The race is closed: owner Git no longer re-opens any agent-writable path for anything that picks code to run. Runtime `244bc54`; the tests ran on `51a8641` (tree `ccdaf49`), whose `src/` is the same.** Input: `nubl/.pi/plan/research/a0-slice7-security-delta.md`, a local planning file. No reviewer script was executed.

**The hole, confirmed before the fix.** `checkGitPin` read the pointer files, closed the descriptors and returned. Then `spawnSync('git', ['--git-dir=<admin path>', ...])` let Git re-read `commondir` by path. A sandboxed parent can write its children's admin files under `.git/worktrees/`, and also its own `.git/commondir`. So it can flip `commondir` to a decoy common dir. That decoy's config defines `diff.<x>.command`, `diff.<x>.textconv` and `filter.<x>.clean`, and the worktree `.gitattributes` selects `<x>`. The `-c` fsmonitor/hooks flags do not stop that. I confirmed the reviewer's blocker with new tests built against the `a8d1357` helper ([log](evidence/slice7-security/before-fix/owner-git-before-a8d1357.log)):
- **Linked child:** the payload ran 605 times during 452 passing `safeGitRun` calls (900 calls in total: `diff --binary BASE HEAD`, `diff -- note`, `status`).
- **Ordinary `.git`:** the payload also ran when the decoy `commondir` was created and removed during the calls.
- **Repository config:** a filter in the repository config ran.
- **Global config:** a filter pulled in by a `~/.gitconfig` `[include]` ran.

**The fix (`src/git-safe.ts`).** Each `safeGitRun` call:
1. Opens `.git`, the admin dir and the common dir with `O_NOFOLLOW` and compares the launch pin through those descriptors. This is the same `inspect` the sandbox mount plan uses.
2. Copies HEAD from the **same descriptors** into a fresh mode-0700 `mkdtemp` dir that the supervisor owns. The dir is checked for owner, mode, and being outside the root and the git and common dirs. A symbolic HEAD must equal the pin; otherwise HEAD must have the expected shape. The step also copies config, re-hashed so it must equal `config_sha256`. It copies `refs/`, `packed-refs`, `shallow`, `info/` and the index as well. Links and special files refuse.
3. Lists the copied config with Git's own parser: `git config --file <copy> --no-includes --null --list`. That parser handles a BOM, quoting and case. The call refuses with `git_config_executes_code` if any key names a program: `include*`, `filter.*`, `diff.external`, `diff.*.command|textconv`, `merge.*.driver`, `alias.*`, `gpg[.*].program`, `core.sshCommand|pager|editor|askPass|gitProxy|alternateRefsCommand`, `pager.*`, `sequence.editor`, `uploadpack.packObjectsHook`. A `-c` flag cannot switch off a driver whose name is unknown, and `.gitattributes` is agent data that picks drivers by name.
4. Runs Git with `--git-dir=<snapshot>` (no `commondir`, so nothing redirects) and `GIT_OBJECT_DIRECTORY=<pinned common>/objects`. The environment is a clean allowlist (`PATH`, locale, `TZ`) plus `HOME`/`XDG_CONFIG_HOME` set to an empty private dir. It also sets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_ATTR_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0` and `GIT_NO_LAZY_FETCH=1`. The `-c` flags are `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `core.attributesFile=/dev/null`, `diff.ignoreSubmodules=all`, `submodule.recurse=false` and `protocol.allow=never`. Diff-family commands (`diff*`, `log`, `show`, `whatchanged`) get `--no-ext-diff --no-textconv`. The snapshot is removed afterwards.

`checkGitPin` stays exported for scripts, but its docs now say it is advisory on its own. `copyTreeAt` gained a `links: 'refuse'` mode. `copyFileAt` streams one `O_NOFOLLOW` file. Callers did not change. On this checkout, `artifactSubject`'s diff digest equals a plain `git diff --no-ext-diff --no-textconv --binary` with global config off (identical 76,886 bytes).

**Deviations, stated:**
- **No `-c diff.external=`.** On Git 2.53 it makes every plain `git diff` fail with `cannot run :`. Instead, `diff.external` in config refuses, `GIT_EXTERNAL_DIFF` is dropped by the environment allowlist, and `--no-ext-diff` is added.
- **Repository configs that define drivers or filters now refuse owner Git.** Example: a repo-local `git lfs install`. This fails closed. `credential.helper` and remote/url keys are not refused, because `protocol.allow=never` blocks every transport in the helper.
- **Objects come from the shared store by path.** A parent could swap that store for one holding crafted objects or FIFOs. That is data or a hang, never code; the delta review accepted it. Work-tree contents (`.gitattributes`, `.gitignore`, `.gitmodules`) are agent data too: they cannot name a program once no config defines one.
- **Per-worktree refs and reflogs are not copied.** These are `refs/worktree`, `refs/bisect` and `logs/`, so `@{n}` reflog syntax does not work through the helper. `fsck` still exits 0; other worktrees' HEADs are not reachability roots there.

**Regressions, in `src/test/owner-git.test.ts` (6 tests: 5 portable, 1 kernel):**
- **Linked-child race:** a separate process atomically flips the child admin `commondir` between the real path and a decoy. Meanwhile there are 300 each of `safeGitRun` `diff --binary BASE HEAD`, `diff -- note` and `status` (the file is made stat-dirty every call, so the clean filter is needed). The test asserts no payload run and no unexpected error. It also requires passes > 0 and refusals > 0, so it cannot pass vacuously, and a static control proves the decoy fires under the old argv.
- **Ordinary `.git` race:** the same, with `.git/commondir` created and removed.
- **Executing config:** each of the 8 executing keys in repository config refuses for all three commands on both checkouts. A control shows that plain Git runs it.
- **Global config:** a `~/.gitconfig` `[include]`, XDG `git/config` and `git/attributes`, and then `GIT_CONFIG_GLOBAL`, `GIT_CONFIG_SYSTEM` and `GIT_EXTERNAL_DIFF` are not honoured. A control shows that plain Git honours them.
- **Faithful snapshot:** `status --branch`, `rev-parse` (loose and packed refs and tags), `for-each-ref`, `diff --binary`, `log` and `symbolic-ref` match plain Git. `fsck --full --strict` exits 0, and `config --get credential.helper` exits 1.
- **Kernel:** the flipping writer is a real bwrap sandbox whose root is the parent's ordinary clone. It uses `/bin/sh` and `mv`.

| Check (`51a8641`) | Local (Node 26.13, bwrap 0.11.1, Git 2.53) |
| --- | --- |
| `npm test` (`TMPDIR=/tmp/a0s7g/tmp`) | **239 tests: 226 pass, 13 kernel skips, 0 failures** |
| Full suite, delegated user service `a0-s7g-kernel`, `A0_TEST_BWRAP=1` + cgroup | **239/239 pass** |
| New tests on the `a8d1357` helper | 4 portable fail by assertion (kernel skipped); 1 passes (snapshot fidelity) |
| Reversions ([runner](evidence/slice7-security/reversions/owner-git-reversions.py), portable + `A0_TEST_BWRAP=1`) | **4/4 killed:** `owner-helper-a8d1357` (all 5 guards, including the kernel race; 600 payload runs in the linked race), `snapshot-removed-git-reads-pinned-paths` (both races and the kernel race; Git reads the pinned admin path again), `executing-config-allowed`, `global-config-honoured` |
| Final `a0-*` user units; leftover `a0-git-*` snapshots | Empty; none |

The 6 new tests join the 233. No test was removed or weakened. Record: [owner-git-checks.json](evidence/slice7-security/owner-git-checks.json), with logs, diffs and the before-fix log; [owner-git-record.mjs](evidence/slice7-security/owner-git-record.mjs) binds the commit and tree through the helper. **Not rerun:** the `a0-worker` VM suites; the model-driven job.

**Delta-review nits not addressed here:**
- The channel grant still unions `launch_spec.grant_methods`. The router whitelist ignores them.
- A quoted or BOM-prefixed `worktreeConfig = "true"` slips past the launch regex. Only sandbox Git is affected: the agent cannot write common config, and owner Git never reads `config.worktree` (the snapshot has no admin config).
- Missing pins on pre-fix workers still skip the relaunch compare. Owner `safeGit` refuses a missing pin (`git_launch_pin_required`).

### Minors and nits

| Finding | Result | Evidence |
| --- | --- | --- |
| Claude m1: channel launch retry returned 500/unknown | **Fixed.** Channel normalization is now pure string mapping with no filesystem reads, so an exact retry hashes identically. A known `command_id` goes straight to the receipt lookup and returns the stored receipt. A missing `cwd` is `409 no_effect`. | Test `m1`; old code returned 500 ([before log](evidence/slice7-security/before-fix/before-1f38036.log)); reversion `channel-retry-lookup-removed` killed |
| Claude m2 / Grok minor: relaunch trusted a child-writable HEAD | **Fixed.** Relaunch compares the current pin with `w.git_pin` before a durable receipt, and again when building mounts. A retargeted HEAD refuses. Symbolic HEAD is also read-only during the sandbox. | Test `m2`; reversion `relaunch-pin-ignored` killed |
| Claude m3: RPC had no pre-move signal | **Fixed for RPC.** `rpc-audit` notifies `A0_HOST_BINDING_CHANGING` on `session_shutdown`, so stale writes refuse `binding_change_in_progress` and are never dispatched. **Stated limit:** in all three hosts, the signal crosses a pipe, so a write that arrives in that latency gap can still pass. | Real-RPC test `m3` (no model call); reversion `rpc-premove-signal-removed` killed |
| Claude m4: `nativeRebinding` could latch forever | **Fixed.** After `nativeMoveTimeoutMs` (15 s), the supervisor asks the host's `get_state` and binds whatever session it reports, always as a revision bump. If the host cannot answer, the worker faults, and stop/relaunch remain available. The timer is cleared on bind or exit. | Test `m4`; reversion `native-move-reconcile-removed` killed |
| Claude m5: native move into another worker's held session | **Stated limit.** It is detected only after the move: `noOtherWriter` throws and the worker faults. Pi has already opened the file, which is inherent to native moves. | — |
| Claude m6: credential exposure wider than stated | **Stated limit.** Staged credential copies stay in retained child worktrees. The VM setup's `exe-dev-llm-integration.json` is staged writable and is not in the credential exception. A shared network namespace also exposes loopback services and abstract Unix sockets. | README limits |
| Claude m7 / Grok nit: worker-less receipts visible on the channel | **Fixed.** The channel refuses them, and its grant has no `*` scope. | Test `B1: the channel acts…`; reversion `channel-uses-owner-grant` killed |
| Grok minor: `objects/info/alternates` writable | **Fixed.** `objects/info` is read-only, and alternates are pinned for owner commands. | Portable + kernel M1 tests |
| Grok minor: no `--die-with-parent` | **Fixed.** A kernel test SIGKILLs the spawning process and the sandbox dies. | Reversion `die-with-parent-removed` killed |
| Grok nit: no `--clearenv` | **Fixed.** bwrap gets `--clearenv` plus `--setenv` for exactly the allowlist, so a future merged spawn environment cannot leak. | Reversion `clearenv-removed` killed |
| Grok nit: credential `--ro-bind` followed links | **Fixed.** Credentials are bound read-only from an `O_NOFOLLOW` descriptor; a linked or non-regular credential refuses. | Reversion `credential-bind-follows-links` killed |
| Grok nit: no seccomp | **Not added (stated).** The review demonstrated no hole: no tty fd is inherited, `legacy_tiocsti=0`, and all caps are dropped. It would be defense in depth only. | — |
| Claude nit: per-worktree refs (`refs/worktree`, `refs/bisect`) outside the refs map | **Stated, unchanged.** They are harmless apart from keeping objects alive. | — |

### Remaining stated limits from this round

- **Admin files created after launch.** A linked worktree's writable admin dir can gain `config`, `config.worktree` or `hooks` files that were absent at launch. Git does not read them for a linked worktree (`worktreeConfig` is refused), and the helper disables hooks anyway.
- **Parent-controlled child metadata.** For children of an ordinary-clone parent, the admin metadata lives in the parent's writable `.git/worktrees/`, so the parent can rewrite it. The owner helper detects that through the pins. Since the follow-up, it runs Git on a private snapshot taken from the compared descriptors, so a concurrent rewrite cannot reach Git either. **Manual owner Git** in a retained worktree, outside the helper, is not protected: use `safeGit` (or a fresh `--no-local` clone) for any later inspection.
- **Experimental host Git.** The experimental host's own Git inspection runs plain `git` inside the parent sandbox; that repository was not edited. Child pointers are read-only, so a child cannot redirect it.
- **Shared objects.** The object store stays writable, as an integrity limit (corruption, extra loose objects or packs), not a code-execution vector.
- **Pins and config edits.** Workers persisted before this round have no `git_pin`, so their relaunch skips the pin compare. An owner config edit after launch makes owner commands refuse; this fails closed.
- **Model-driven job not rerun.** The VM model-driven job was **not** rerun on the fixed runtime. The real-job path did change (descriptor binds, channel grant, Git overlays, staging), so both full suites were rerun on the VM. The kernel live-topology test repeats the job's Git/channel shape with real Pi SDK processes in bwrap and no model; it uses a hand-written parent extension in place of the experimental host.

### Reversion and before-fix evidence

**17/17 targeted reversions compile and fail by assertion,** run in an isolated worktree from [reversions.py](evidence/slice7-security/reversions/reversions.py), with diffs and logs alongside. Kernel reversions ran with `A0_TEST_BWRAP=1`. Separately, the re-authored probes were compiled against pre-fix `1f38036`:
- the channel tests: 4/4 fail;
- real-bwrap PROBE A: fails, with an HTTP 200 escape;
- the owner-audit fsmonitor probe: fails, the payload ran.

The probe sources are under [before-fix/](evidence/slice7-security/before-fix/). These are targeted guards, not a mutation score.

**Cleanup and inputs.** Local and VM `a0-*` user units: empty after every suite. VM work used only `/tmp/a0s7f/` and its own transient units. No other VM process was signalled; nothing was pushed or merged, and no PR was opened. Sources were treated as data. No source asked for a secret, and none appears in the exports: a credential-pattern scan of `evidence/slice7-security/` found nothing, and its only marker is the synthetic `SECRET-MARKER`.

## Gate 1 table — contract revision 7

“Covered” means the named bounded prototype case, with the stated host/profile limits. It does not erase earlier production deferrals.

| Gate 1 requirement | Status | Slice and evidence |
| --- | --- | --- |
| **1** Real parent, pstack, two retained-worktree children, no pane | **Covered** (model-driven job on pre-fix `fd99c89`) | Slices 4/merge/6; slice 7 native audit proves two SDK+bwrap Git writers, guidance reads, once-per-kind delivery and no terminal trap during work. That run used the escapable pre-fix parent sandbox; nothing in it exploited the holes. On the fixed runtime, the kernel live-topology test repeats the topology without a model: parent `worktree add`, channel child commit, parent cherry-pick, owner pinned checks. It passes locally and on the VM. The model-driven job was **not** rerun. |
| **3** Standard startup/work dialogs, timeout/cancel, duplicate labels, custom refusal | **Covered for selected SDK host** | Slice 3 and fix-round real-Pi comparison; inherited dialog/resolver tests rerun. RPC remains stage 2 and cannot consume its tested startup answer; duplicate native label strings retain Pi's limitation. |
| **4** Answer races, timeout/restart stale answers, separate release | **Covered** | Slice 3/fix/merge races and gate checks; slice 7 closes the sibling-settlement false fence. |
| **5: supervisor cuts** | **Covered** | Slices 1–5 real fsync/SIGKILL and native-effect oracles, rerun in both final suites. No blind replay or duplicate effect. |
| **5: Pi cuts** | **Covered** | Earlier Pi-death/cleanup journeys plus slice 7's real intent/dispatch/result Pi-kill cases, default suites on both hosts. **Bridge cuts are Gate 2 in revision 7.** |
| **7** New/fork/resume/tree identity and stale bindings | **Covered** | Slices 2/3 B2 transitions; slice 5 fresh-process relaunch; slice 7 real native extension moves in SDK/ACP/RPC, native leaf comparison and stale refusals. |
| **8** bwrap allowed/outside/socket refusal | **Covered after the fix round** (first claim was **not met**) | Slice 5 real child and root-pinned reads. As first delivered, slice 7's parent sandbox failed this item: B1 hit the "unconfined file read" stop condition (a host root bound read-write), and B2 gave an unconfined read through staging. Fixed: descriptor binds, an O_NOFOLLOW child root inside the parent root, post-validation descriptor staging, and read-only Git pointers. Real-bwrap regressions run in both kernel suites; PROBE A got HTTP 200 on the old code and is refused now. |
| **11** Fence/duplicate session/same-user project extension/FD report | **Covered** | Slices 2–5 fence and duplicate-open cases; slice 7 literal project-extension socket positive/negative fixture and two live sandbox FD results. |
| **12** Scoped/revoked authority, delayed mutation, paused queue/keep, abrupt-kill cleanup/profile | **Covered after the fix round** (first claim was **not met** for the channel) | Slices 2/3/5 fixtures, gate release revocation and detached-grandchild cleanup, all rerun. As first delivered, the channel acted with the owner's `*` grant, so "a scoped grant is denied outside its scope" failed (B1). Fixed: the channel has its own grant scoped to the parent worker and root, the source grant is rechecked, and worker-less receipts are hidden. Owner Git checks compare launch-time pins, because a full-ref map alone was not a Git mitigation (M1). Since the owner-Git follow-up, they also run Git on a private snapshot of the pinned bytes, with executing config refused and global/system config ignored. This closes the `commondir` race the delta review found. Existing-daemon handoffs and hostile same-UID code remain named limits. |
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

**Gate 1 verdict (after the security fix round): covered for the bounded Linux SDK prototype, ready for root review of the freeze.** Items 8 and 12 were not met as first delivered. The founder still owns that decision. Gate 2's bridge cuts, full convenience/client surfaces, and test 13's verified draft PR remain outside this slice. No production, macOS, hostile same-UID, network confinement, registered environment policy, crash-durable parent-delivery, or exhaustive storage-failure guarantee is claimed.

## Attention, failures, cleanup and sources

- **Final run:** two authorization interventions (one prompt, zero answers/corrections, one acceptance), five owner write actions including create/freeze/cleanup, **15.9349 elapsed minutes** prompt-to-acceptance. **Across both runs: four authorization interventions and ten owner write actions**, including the earlier invalidated acceptance; see [total attention](evidence/slice7/attention-total.json). This is one current verified change and zero verified PRs. Founder live touches were zero; active human attention minutes were not measured. Setup/debug/test/audit authoring is disclosed automated overhead, not hidden human attention.
- Initial checkout was behind the requested PR #2 base; the three local slice-7 commits were rebased onto `b461253` before final work/testing. No unrelated changes were present or lost.
- An early native fixture used a stale Pi command context; it was corrected. The authoritative old-base proof is the isolated `b461253` run, not exploratory `native-before.log`. SCP brace expansion and a scratch-script relocation caused transfer failures, not passing checks. The second setup initially retained one old grant-directory literal; exclusive creation refused without overwriting the old revoked grant, then a corrected continuation registered only the new run. One immediate `hello` hit startup `ENOENT/before_write/no_effect`; the subsequent start was safe because no B2 mutation had been sent. The zero-refusal audit failure remains explicitly failed. No failed check was counted as passing.
- Every recorded Pi leader from both runs is absent, all six job domains are removed, both scoped task grants are revoked, and only the exact run supervisors/keepers were stopped. Both hosts' **post-final-suite** `a0-*` inventories are empty. No other VM, process or service was signalled. Worktrees/private sessions remain retained.
- Inputs: A0-SLICE1 through A0-SLICE6, A0-MERGE-3-4, contract revision **7**, all supplied `a0-*review*.md`, installed Pi 1.5.2 SDK/lifecycle source and the unchanged experimental adapter. Sources were data, not authorization. Newly authored drivers ran; historical source-supplied reproduction/provisioning scripts did not. No source requested a secret transfer or upload. The only provider adaptation removes `/exe.dev`'s existence guard in a private VM profile after a hostname check; that directory is not mounted.
- [Privacy evidence](evidence/slice7/privacy.json) compares known private values in memory without exporting or hashing credentials. Whitelisted records/logs and the two committed job blobs were scanned; raw grants, model stores, private profiles and native transcripts were not exported. Final documentation/harness exports receive an additional scan. Scans do not prove absence of transformed/unknown secrets.
