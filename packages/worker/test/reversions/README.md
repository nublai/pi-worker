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
