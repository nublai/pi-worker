# A0 Gate 1 rerun: model-driven job on the fixed code

> **Fix round and second run (2026-11-15): the model-driven job PASSED on the fixed runtime `24e1de2`.** D1, D2 and D3 are fixed. Each has a regression test that fails on `7ea2f0d`, and 6 of 6 isolated reversions are killed. The first run, below, is kept unchanged as history. See [Fix round](#fix-round-d1d3) and [Second run](#second-run-job-passed).

## Fix round (D1–D3)

The fix is commit `2a3ba08`, and the tests are commit `b0b9bcb`. Evidence is in [`evidence/gate1-fix/`](evidence/gate1-fix/). The new tests live in `src/test/gate1-fix.test.ts`: 5 portable tests and 1 kernel test. [Before the fix](evidence/gate1-fix/before-fix/gate1-fix-on-7ea2f0d.log), all 6 failed by assertion on the unfixed runtime, and the D1 tests reproduced `profile_copy_too_many_entries`. [Reversions](evidence/gate1-fix/reversions.json): each case makes one exact source edit, builds, and runs with real bwrap. **6 of 6 are killed by assertion.**

**D1: root cause fixed, not a bigger number.** `stageProfileAt` (`src/pinned-fs.ts`) still copies the profile's config and mutable files through the same no-follow descriptor walk, with the same 10,000-entry and 256 MiB budget. Every `node_modules` directory now becomes an empty mount point instead of a copy. Its source descriptor (opened with `O_NOFOLLOW` during the walk) is handed to `sandboxLaunch`, which binds it with `--ro-bind-fd` at `ROOT/.a0-agent/<path>` after checking that the mount point is the real directory staging created. Nothing writable is shared. Each launch allows at most 64 dependency binds.
- Relaunch reopens the same paths from the parent's profile with the same walk. `within` and `profileBinds` are now persisted. `within` had been omitted from `persist()` before.
- On the VM, the real 18,801-entry profile now stages **23 entries** per child, and the host mount point holds 0 entries.
- Tradeoff: after launch the parent can change its own `node_modules`, and the child would then load the change. This adds no authority, because the parent can already write the child's worktree.
- Tests:
  - Portable: a 20,000+ entry profile shaped like a real one is staged and a child is launched. The staged copy has fewer than 50 entries. The ro-bind source is the parent's exact inode. There is never a writable bind.
  - Portable: a budget test with over 10,000 non-dependency files. It refuses, and leaves nothing behind.
  - Kernel: a real Pi SDK parent and a channel child, both in bwrap, with a 20,000+ entry profile. The child loads its extension from the bind and reads a file deep in the tree. A write fails with `EROFS`, and the parent's files are unchanged.

**D2: one rule.** After the dispatch record, a failure is `outcome_unknown` unless it is thrown as the new `ProvenNoEffect` (`src/types.ts`). That class is used only with evidence. `ReceiptStore.run` no longer treats a default `Refusal` after dispatch as `no_effect`. For staging, `Supervisor.stageProfile` works as follows:
- If the launch created nothing, it reports `no_effect`.
- Otherwise it removes the `.a0-agent` it created with a descriptor-relative `removeTreeAt`, then checks by `O_NOFOLLOW` open that the directory is absent. Only then does it report `rejected/no_effect`.
- If anything remains, the receipt is `outcome_unknown` and the parent is fenced.
- Both paths are tested. The unknown-path test uses a cleanup seam that removes nothing, so the descriptor check, not the cleanup function, decides the label.

The other `Refusal` throws after dispatch were reviewed:

| Site | Before | Now |
| --- | --- | --- |
| `create`: staging (`copyTreeAt` budget, special-file and link refusals; source open; `mkdir`) | `rejected/no_effect` with partial files (D2) | Removed and verified → `no_effect`; otherwise `unknown` plus parent fence |
| `create`: `sessionDir` and `sandboxLaunch` inside the host factory (`sandbox_credential_not_regular_file`, Git pin/plan refusals, `sandbox_parent_channel_required`, new `sandbox_dependency_mount_point_invalid`). These run after staging and session-dir creation. | `no_effect` (same mistake) | `unknown` (fences a channel parent). The row is `failed`. |
| `create`: `noOtherWriter` → `session_already_bound`, after a Pi process ran and was cleaned up | `no_effect` (same mistake) | `unknown` |
| `relaunch`: `openSandboxRoot` and sandbox refusals, after the worker epoch changed | `no_effect` (same mistake) | `unknown`. Relaunch still does not fence; that is unchanged. |
| `rebind`: second `dispatchGuard()` (grant revoked after the interactions were cancelled) | `no_effect` (same mistake) | `unknown`, so the existing rebind fence and fault apply |
| `prompt`: `pi_rejected_prompt` (Pi answered `success:false`) | `no_effect` | Still `no_effect`, now explicitly `ProvenNoEffect` (host negative response) |
| `interactions.answer`: `answer_binding_changed` after an exact resolver's negative ack | `no_effect` | Still `no_effect`, now explicitly `ProvenNoEffect`. Every other case was already `unknown`. |
| `flushPending` untyped (slice 2) child: `create` validation refusal after `children.launch` dispatch | The receipt stays `accepted` until restart; recovery then makes it `unknown` and fences | Unchanged. This is not a `no_effect` mislabel; it is noted only. |

**D3.** A launch that fails before any host exists now ends with `status: failed` and a new `Worker.failure: {command_id, reason}` field (`openapi.json`, regenerated). If no cgroup domain remains, `cleanup` is `no_process_started` or `cgroup_empty_removed`. The existing post-spawn failure path records `failure` too. A `failed` row is not live: in the test, the same root launches again, and after the parent stops no child row is `starting` or `cleanup_pending`.

**Suites (local, Node 26.13.0, bwrap 0.11.1):** `npm test` **245 tests, 231 pass, 14 kernel skips, 0 failures**. Kernel suite in the delegated user unit `a0-g1f-kernel`: **245/245**. `check:generated` is clean. The total was 239 before; 6 tests were added and none removed or weakened. 0 `a0-*` units remain.

## Second run: job PASSED

Evidence is in [`evidence/gate1-fix-run/`](evidence/gate1-fix-run/): [checks.json](evidence/gate1-fix-run/checks.json), plus the VM exports in `vm/`. The harness is the first run's, with `/tmp/a0g1b/` scratch and `a0-g1b-*` units. A fresh bundle of `a0/gate1-rerun` at **`24e1de2`** (tree `2de6251`) was checked out. Its runtime code equals the fix commit.

| Check | Result |
| --- | --- |
| VM `npm test` (Node 26.13.0) | **245 tests, 231 pass, 14 skips, 0 failures** |
| VM kernel suite (`a0-g1b-suite-kernel`) | First run: 244/245. The failing test was `owner Git: results match plain Git on an untouched checkout`, a pre-existing flake explained below. Second run: **245/245**. Both logs are exported. |
| VM `check:generated` | Pass |
| Sandboxed SDK parent, pin equal to the owner's setup pin, parent grant/state denied | Pass |
| **Fan-out through pstack to two sandboxed git-worktree children** | **Pass.** Exactly 2 `subagent` launches (`note-writer` → `g1-note/task`, `check-author` → `g1-check/task`), both thinking `off`, both `delivered`. Each child: SDK+bwrap, a locked retained worktree, 1 commit over base, real `git status/add/commit` in its own bash. 1 result and 1 termination delivery each. |
| Parent did not do the children's work | **Pass.** Parent tools: `bash` 9, `read` 4, `subagent` 2. **0 edit/write calls and 0 `git commit` calls.** Its two commits have diffs identical to the children's commits, so they are cherry-picks ([integration-check.json](evidence/gate1-fix-run/vm/integration-check.json)). |
| Clients disconnected and reconnected | Pass: a 314.5 s gap, snapshot `resync_reason: gap`, same parent epoch and session, 15 parent tool calls during the gap |
| Strict audit (`audit.mjs`) | Pass after two harness corrections (see below). Refs moved: only `job/gate1`, `g1-note/task`, `g1-check/task`. Workers stopped, and every cgroup domain was removed. |
| Owner verification on a fresh checkout via the safe Git helper | **Pass ([verification.json](evidence/gate1-fix-run/vm/verification.json)).** Artifact **commit `cd8b6f1b0912bb3615ee0507ec17ddbb7f2e03b6`, tree `8876bd099d0fa7ec2831142f59a1c57f1dab3390`**, base `24e1de2`. Changed files are exactly `README.md` and `evidence/gate1-job/verify.mjs`. On the fresh checkout: `npm ci`, `npm test` 245/231/14 skips, `check:generated`, and the kernel suite 245/245. |
| Evidence record bound to commit and tree; acceptance | `verification.json`, then `acceptance.json` on the same commit and tree. `git fsck --full --strict` (pinned) passed. |
| Cleanup | Orchestrator grant revoked. Only `a0-g1b-supervisor` and its keeper `a0-507b2747e9387a63d5b6` were stopped. **0 `a0-*` units** on the VM. The terminal trap was absent during the job. |
| Privacy | 51 exported files scanned against known private values (in memory) and credential patterns: pass |

**Attention** ([attention.json](evidence/gate1-fix-run/vm/attention.json)):
- **Authorization interventions: 2** (1 prompt, 0 answers, 1 acceptance).
- **Owner write actions: 5**: create, prompt, freeze-stop, acceptance, cleanup.
- Verified changes: 1. PRs: 0. Founder live touches: 0.
- Elapsed time from prompt to acceptance was 20.0 minutes. That is wall time, not active attention. Active human attention was not measured.

**Harness attempts that failed, listed plainly** (none is counted as a pass; every log is exported):
1. I ran `audit.mjs` before `freeze`, so the parent was still `ready`. This was an ordering error; I reran it after `freeze`.
2. `audit.mjs` checked worktree locks with `safeGit worktree list`. Since the owner-Git follow-up, `safeGit` runs on a private snapshot that has no `worktrees/` directory, so it cannot list linked worktrees. Git reports a worktree as locked exactly when `<admin>/locked` exists. The audit now checks that file with an `O_NOFOLLOW` walk from each child's launch-time `git_pin.git_dir` (no Git process).
3. The `verify.mjs` clone was refused, because `SAFE_GIT_CONFIG` sets `protocol.allow=never`. Only `protocol.file.allow=always` was re-allowed, for that one clone.
4. On `verify.mjs` attempt 2, the artifact's kernel suite hit the same owner-Git flake. Attempt 3 passed.

**Pre-existing flake found (not fixed; outside D1–D3).** `owner Git: results match plain Git on an untouched checkout` fails intermittently on the VM's Git 2.43. Cause:
- The fixture writes a same-size change within the same second as the index.
- Plain Git treats that entry as racily clean and compares content, so it sees ` M note`.
- `safeGit` copies the index into its snapshot with a new mtime, so the entry no longer looks racy, and Git trusts the stat data and reports clean.

So `safeGit status` can miss a racily-clean modification. Suggested fix: keep the source index's mtime on the snapshot copy (`futimes`), with a test that forces the same-second case.

**Old stray supervisor stopped.** This was PID 1269, `node dist/main.js`. I confirmed its cwd was `/tmp/a0/repo`, its parent PID was 1, it was in `init.scope`, and it had no children. It had been started on the VM at 05:05:37. I sent it SIGTERM at 22:32:13Z and it was gone within 1 s. No other process was touched, and no `dist/main.js` process remains.

The VM keeps for inspection: `/tmp/a0g1b/run` (journal, private sessions, workspace with the three refs, both locked child worktrees) and `/tmp/a0g1b/out/result.bundle` (local copy: `/tmp/a0g1f/result.bundle`). The first run's `/tmp/a0g1/` is untouched.

---

# First run (history, unchanged)

**Result: FAILED. Do not freeze Gate 1 on `4474a9a` yet.** Both full suites pass on the VM. The real job did not: on the fixed runtime, the supervisor refused both sandboxed child launches with `profile_copy_too_many_entries`. The real staged Pi profile has 18,801 entries, but the security-round staging copy (`copyTreeAt`) allows at most 10,000. The pstack fan-out to two children therefore cannot happen with the profile slice 7 used. Following the task rules, I stopped and am reporting the defect instead of fixing it. No runtime code was changed.

- Runtime subject: **`4474a9a8eecda33ba5d0af2c0259554dd56fb431`**, tree **`cabd514c0962de15324a4e2b1f15767a44ee3666`** (`prototype/a0`, the slice 7 merge).
- Branch: `a0/gate1-rerun`. Only harness scripts, evidence and this report were added. Nothing was pushed or merged.
- Evidence: [`evidence/gate1-rerun/`](evidence/gate1-rerun/), with [checks.json](evidence/gate1-rerun/checks.json) and [failure-audit.json](evidence/gate1-rerun/vm/failure-audit.json).

## Versions (a0-worker VM)

| Component | Version |
| --- | --- |
| Node | **v26.13.0**, user-local at `~/.local/node26`, from the official linux-x64 tarball. Its SHA-256 matched `SHASUMS256.txt` (GPG signature not checked). The existing `~/.local/node` 22.21.1 and system packages were not touched. |
| npm | 11.20.0 |
| Pi (runtime dependency and `~/.local/bin/pi`) | 1.5.2 |
| pi-herdr-agents / pstack (staged profile) | 3.11.0 / 1.0.0. The four experimental host source hashes are identical to slice 7's `platform.json`. |
| bubblewrap / Git / kernel | 0.9.0 / 2.43.0 / 6.12.115 |
| Provider/model | `exe-dev-anthropic/claude-sonnet-4-6@llm`, thinking `off` (the existing VM provider) |

The supervisor and every SDK host ran under Node 26.13.0: the unit's command is `~/.local/node26/bin/node`, and the sandbox `PATH` mounted `~/.local/node26/bin`. No GitHub credential was sent to the VM. The final audit's credential-boundary check passed: no standard credential files, no GitHub token environment variables, no Git credential helper, and no token pattern in the staged store.

## Checks and results

| Check | Result |
| --- | --- |
| `npm test` on VM at `4474a9a` | **Pass: 239 tests, 226 pass, 13 kernel skips, 0 failures** |
| Full suite in delegated user service `a0-g1-suite-kernel`, `A0_TEST_BWRAP=1` plus cgroup | **Pass: 239/239, 0 skips** |
| `npm run check:generated` on VM | Pass; checkout stayed clean |
| VM source audit ([vm-final-audit.json](evidence/gate1-rerun/vm/vm-final-audit.json)) | Subject `4474a9a`/`cabd514`, 72 source files hashed, no `a0-*` units |
| Sandboxed SDK parent started, with Git pin equal to the owner's setup pin | Pass |
| Parent denied its grant and journal (`PARENT_GRANT_AND_STATE_DENIED` check in the prompt) | Ran; the strict audit was not run (see below) |
| Parent read the pstack skill and playbook | 2 reads |
| **Fan-out to two sandboxed git-worktree children** | **FAILED.** Two `subagent` calls, both thinking `off`, both refused: the receipts show `rejected / refused / no_effect / profile_copy_too_many_entries`. There were 0 result deliveries. |
| Clients disconnected, then reconnected | Pass: 408.5 s gap, snapshot `resync_reason: gap`, same parent epoch, 46 parent tool calls during the gap, Pi not restarted |
| Owner Git through `src/git-safe.ts` on the real job workspace | Pass. The pin-checked `safeGit` read the log, diff, refs and trees. The changed set was only `README.md` and `evidence/gate1-job/verify.mjs`. |
| Fresh-checkout owner verification of the artifact, evidence record, acceptance | **Not run.** The job failed its required shape, so there is no subject to accept. |
| Terminal trap | Absent during the job. The file appeared only when the three post-cleanup positive controls ran (each exited 97). |
| Privacy scan of the export | Pass: 17 files, known private values compared in memory, pattern scan run ([privacy.json](evidence/gate1-rerun/vm/privacy.json)) |
| Cleanup | Parent stopped through B2 (`termination_observed`, cgroup removed). Orchestrator grant revoked. Only `a0-g1-supervisor` and its keeper `a0-a838fd122b09beb979f6` were stopped. Final `a0-*` user units: **0**. |

## The defects, with evidence

**D1 (blocking): the staging entry budget is smaller than the real profile.**
- `src/pinned-fs.ts:79`: `if (++budget.entries > 10000) throw new Refusal('profile_copy_too_many_entries')`.
- The parent's `.a0-agent` has **18,801** entries, and slice 7's `run2` profile has the same count. Almost all of them are the `npm/node_modules` tree that the experimental host and pstack need.
- `supervisor.ts:468` calls `copyTreeAt(source, dest)` with the default budget for every channel child. So every sandboxed child launch with this profile refuses.
- The suites missed this because no test stages a profile anywhere near this size.
- Consequence: Gate 1 row 1 (real parent, pstack, two retained-worktree children) has **no model-driven evidence on the fixed runtime**.

**D2: a staging refusal after dispatch is labelled `no_effect` after real writes.**
- Each child root holds **10,000 partially copied entries** under `.a0-agent`.
- Yet the receipt moved from `accepted/dispatch_recorded/unknown` to `rejected/refused/no_effect`. The parent was **not fenced** (`fence: null`).
- Cause: `Refusal` defaults to `effect: 'no_effect'`, and `receipts.ts` maps that to `rejected` even after `dispatch()`.
- This contradicts A0-SLICE7's B2 claim, "A staging failure after dispatch reports `unknown` and fences the parent." The claim holds only for non-`Refusal` errors.

**D3: refused child rows linger as live workers.**
- Both refused children remain in `workers.list` as `status: starting`, `cleanup: not_started`, `pid: null`, even after the parent stopped ([stop.json](evidence/gate1-rerun/vm/stop.json)).

**Model behaviour after the refusals (an observation, not a runtime defect).**
- The tool result said `rejected/no_effect; retained, never retried`.
- The parent then did both leaves' work itself. It edited files in the two pre-created child worktrees, committed `g1-note/task` (`f161aa8`) and `g1-check/task` (`f4a3c25`), and cherry-picked them onto `job/gate1`.
- It then added a third commit fixing the checker: `1e689e8`, tree `4945e51`.
- The sandbox allowed this, because the child worktrees lie inside the parent root. It is not the two-writer fan-out the job requires, and the strict audit would fail on it (0 deliveries, 3 parent commits).

## Attention

| Measure | Value |
| --- | --- |
| Authorization interventions | 1 prompt, 0 answers, 0 acceptances = **1** |
| Owner write actions | **4**: create, prompt, failure-stop, cleanup ([attention.jsonl](evidence/gate1-rerun/vm/attention.jsonl)) |
| Verified changes / PRs | 0 / 0 |
| Founder live touches | 0 |

Active human attention was not measured. The elapsed time from prompt to failure-stop was 23.2 minutes, but that is wall time, not attention.

## Deviations from slice 7's run

1. **Paths and names.** Scratch was `/tmp/a0g1/`. Units were `a0-g1-*`. Branches were `job/gate1`, `g1-note/task` and `g1-check/task`. The marker was `A0_GATE1_JOB_COMPLETE`.
2. **Job text.** This run added a README limits bullet saying that owner Git runs on a private snapshot of launch-pinned metadata, plus a checker at `evidence/gate1-job/verify.mjs`.
3. **Prompt wording.** The prompt says thinking is "the literal string 'off'". Both attempts used `off`; the four alias refusals seen in slice 7 did not recur.
4. **Setup fetch.** `vm-setup.sh` fetches `refs/heads/prototype/a0`, because the bundle has no `HEAD`.
5. **Node version.** The VM ran Node 26.13.0; slice 7 ran 22.21.1.
6. **Steps not run.** After the failure, the harness's `audit`, `freeze`, `verify` and `finish` steps were not run.
7. **Replacement scripts.** `failure-audit.mjs` exports only counts and codes; it reads no model text except the two `subagent` tool-result strings quoted above. `failure-stop.mjs` stops the parent through B2.
8. **Privacy scan.** `privacy-scan.mjs` binds to the runtime subject (there is no verification record) and also scans the channel grant.

## Failures, listed plainly

- The model-driven job failed (D1). The `live.mjs wait` step exited 1 at its 900 s deadline, with no automatic cancel or retry ([wait.log](evidence/gate1-rerun/vm/wait.log)).
- No owner fresh-checkout verification, evidence record or acceptance exists for this run.

## Recommendation

1. **Fix D1:** size the staging budget to real profiles, or stage a minimal profile. Add a regression with a profile of 20,000 or more entries.
2. **Fix D2:** a staging failure after dispatch should report `unknown` and fence the parent, as documented.
3. **Fix D3:** finalize refused worker rows.
4. Then rerun this exact harness. It is ready in `evidence/gate1-rerun/`. Gate 1 row 1 and item 12's staging claim should not be called covered on `4474a9a` until that rerun passes.

Retained on the VM for inspection: `/tmp/a0g1/run/` (journal, private sessions, workspace with the three refs, child roots holding partial profiles), `/tmp/a0g1/runtime`, and `~/.local/node26`.
