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
