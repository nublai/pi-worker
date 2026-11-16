# Reversions

Each diff removes one guard. Its test must fail with the diff applied. `manifest.json` groups the diffs with the
command that must catch them; `node harness/lib/reversions.mjs <group>...` (or `--all`) runs them:

```sh
node tools/reversions.mjs --command 'npm test -w @nublai/pi-worker -- --test-name-pattern=closure' \
  packages/worker/test/reversions/p0-4-*.diff
```

| Diff | Guard removed | Caught by |
| --- | --- | --- |
| `p0-4-no-response-validation.diff` | response validation in the router | closure tests on invalid responses |
| `p0-4-drop-one-route.diff` | one route (`workers.stop`) | `closure: every spec operation is routed` |
| `p0-4-no-binary-byte-limit.diff` | the body byte counter and the binary declared-length check | `closure: binary body modes refuse over-limit bodies…` and the socket case |
| `p0-review-f2-no-socket-lock.diff` | the socket takeover lock in `listenPrivate` | `server: concurrent starts over one stale socket` (command: `--test-name-pattern=server`) |
| `p1-1-label-without-cut.diff` | a durable label without a cut scenario | `crash: every durable label has a cut scenario…` (group `journal`) |
| `p1-2-refusal-after-dispatch-no-effect.diff` | a default `Refusal` after the dispatch record counts as `no_effect` | `receipts: a default Refusal after the dispatch record is outcome_unknown…` (group `receipts`) |
| `p1-2-dispatch-marker-after-write.diff` | the dispatch marker is written after the write to pi starts | `receipts: dispatchThen makes the dispatch marker durable…` and the native-effect cut test (group `receipts`) |
| `p1-4-no-one-writer.diff` | the one-live-writer check (`noOtherWriter` ignores a holding worker) | `lifecycle: one live writer per session; a duplicate open is refused naming the holder…` (group `lifecycle`) |
| `p1-fix-f1-create-resume-unreserved.diff` | create-with-resume reserves its target before any open (review F1) | `lifecycle: create-with-resume reserves its target before any open; concurrent creates and rebinds share the reservation` (group `lifecycle`) |
| `p1-fix-f1-failed-resume-releases-target.diff` | a resume that fails after the open keeps its target with the uncleaned worker | `lifecycle: a create whose resume fails after the open keeps its target…` (group `lifecycle`) |
| `p1-fix-f2-create-resume-skips-session-gates.diff` | create-with-resume passes the shared resume gates (cleanup proven, fence resolved; review F2) | `lifecycle: create-with-resume over B2 applies the session gates…` (group `lifecycle`) |
| `p1-fix2-create-resume-target-not-durable.diff` | a create-with-resume's target is durable in the worker's starting row before any host starts, and recovery attributes it (fix round 2) | `crash: SIGKILL after every resume-scenario fsync; the resume target stays reserved…` and `crash: SIGKILL right after pi opened the resume target, before the binding is recorded…` (group `resume`) |
| `p1-fix3-create-resume-unknown-not-fenced.diff` | an `outcome_unknown` create-with-resume latches the fence on its target in its failure row, before the receipt is final (fix round 3) | `lifecycle: an outcome_unknown create-with-resume fences its target durably…` and `lifecycle (real pi): a session_before_switch hook that ran and cancelled a create-with-resume…` (group `lifecycle`) |
| `p1-fix3-create-resume-unknown-not-recovered.diff` | recovery fences an unresolved `outcome_unknown` create-with-resume (fix round 3) | `crash: SIGKILL after every resume-scenario fsync…` (independent fence oracle) and both `crash: SIGKILL right after pi opened…` / `…ran the switch hooks…` cuts (group `resume`) |
| `p1-fix3-create-not-binding-existing-session.diff` | `workers.create` is classified as a session write when it names an existing session (fix round 3) | `fence: the supervisor recovers exactly the contract session writes…` and the resume-scenario cuts (group `resume`; `resume.test.js` imports the fence oracle tests) |
| `p1-5-no-binding-check.diff` | the binding check on session-directed mutations (`SupervisorState.binding` never refuses) | `input: every session-directed mutation refuses a stale binding…` (group `input`) |
| `p1-2-dispatch-marker-after-write.diff` (again) | write-ahead dispatch, at the supervisor | `supervisor dispatch marker with execution ID is fsynced before the host receives prompt (M2)` and the control effect cuts (group `input`) |
| `p1-fix-f3-negative-prompt-reply-no-effect.diff` | a generic negative prompt reply after dispatch stays unknown (review F3) | `input: a generic negative pi reply after dispatch is not proof of no effect…` and `input (real pi): a prompt pi refuses after its input hooks ran…` (group `input`) |
| `p1-fix-f3-negative-steer-reply-no-effect.diff` | a generic negative steer reply after dispatch stays unknown (review F3) | `input: a generic negative pi reply after dispatch is not proof of no effect…` (group `input`) |
| `p1-fix-f3-sdk-child-marks-any-failure-refused.diff` | the SDK child marks only its own pre-hook refusals `refused: before_input` (review F3) | `input (real pi): a prompt pi refuses after its input hooks ran…` (group `input`) |
| `p1-6-no-fenced-write-refusal.diff` | the fenced-write refusal (`session_fenced`) | row `03-fenced-write`, invariants and fence tests (group `fence`) |
| `p1-6-fence-not-durable-before-reply.diff` | the durable fence before the reply of a lost-reply prompt | row `02-unknown` (`disk.fence`), `HTTP … durable fence before response headers (M1, M6)` (group `fence`) |
| `p1-6-any-fence-generation.diff` | the fence generation check of `resolve_unknown` | row `08-generation`, invariants (group `fence`) |
| `p1-7-rebind-keeps-revision.diff` | the binding revision bump of a B2 move | row `01-binding` (group `binding`) |
| `p1-7-no-native-move-refusal.diff` | the write refusal while a native move is in flight | `m4: a native move that never completes…`, `m3 (SDK)…` (group `binding`) |
| `p1-fix-f4-sessions-new-not-session-directed.diff` | `sessions.new` is a session write whose unknown outcome fences on recovery (review F4) | `crash: SIGKILL right after the sessions.new dispatch record…`, the binding-scenario fsync cuts through the independent fence oracle, and `fence: the supervisor recovers exactly the contract session writes…` (group `binding`; `npm test -- binding` includes `crash/binding.test.js`) |
| `p1-8-invalid-frame-no-overflow.diff` | a worker event that fails its schema overflows every subscriber that would have received it | `events: an invalid frame is never sent; its subscribers get overflow…` (group `events`) |
| `p1-8-snapshot-not-validated.diff` | the attach snapshot is validated before it is sent | `events: an invalid frame is never sent…` (the invalid-snapshot case; group `events`) |
| `p1-8-unbounded-queue.diff` | the subscriber queue bound (64 events, 256 KiB) that closes a backpressured subscriber with overflow | `events: one supervisor stream filters workers/types, … bounded explicit overflow and resync` and `events: public client … overflow disables controls` (group `events`) |
