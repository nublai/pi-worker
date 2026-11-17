# B2 fixtures

## Wire fixtures

`wire/<operationId>/<name>.json` holds one request and response example per file. Every operation has at least one;
the closure tests (`packages/worker/test/closure.test.ts`) check that, and that every fixture validates against the
spec. Add or update a fixture with every new or changed operation. The Go fake (`clients/go/workerfake`) embeds a
generated copy of every fixture and answers from them, so two fixtures of one operation need different requests.

```json
{
  "request": { "path": { "worker_id": "..." }, "query": { "limit": "2" }, "body": { } },
  "response": { "status": 200, "body": { } }
}
```

- `path` and `query` hold the raw strings as they appear on the wire; the router converts them to the parameter's
  type before validation.
- `body` is present only for operations with a JSON request body.
- A `text/event-stream` response carries `frames` (each one `EventFrame`) instead of `body`.

## Section 0.1 transitions (frozen)

`transitions.json` is A0's fixture at contract revision 8 (`ee66117:src/test/fixtures/transitions.json`, copied byte
for byte): one row per section 0.1 transition, `01-binding` to `11-control`. The replay runner is
`packages/worker/test/conformance/transitions.test.ts` (`npm run test:conformance`); the rows run as `todo` until P1
provides the supervisor, and P1 must turn all eleven green. The Go replay
(`clients/go/workerfake/transitions_test.go`, P1-17) runs the same rows through the Go client against the Go fake
and pins the same semantic hash.

- **Frozen fields:** each row's `id`, `from`, `event`, `to` and `expect`. Their canonical SHA-256 is pinned in the
  test. They change only with a new contract revision approved by the founder.
- **Wire data:** `steps` and `macros` (call bodies, method names). They may migrate when the catalog changes, in a PR
  that changes no assertion. Every call body must validate against the spec (a test checks it).

Step semantics (from A0's fixture README): each row starts with a fresh idle worker, private socket, controller grant
and an exclusive empty cwd; `initial` is its first binding and `worker` a fresh `workers.get` after each step;
`child_cwd` is a separate available cwd. `call` sends one B2 method once with body = binding (`initial` unless
`binding: worker`) + `command_id` + `fields`, where a string starting with `@` is the value at that dot-path in
`{initial, worker, child_cwd}`; the result is the receipt or the labelled error. `begin` starts a call and waits only
for native `agent_start`. `host_reply drop` loses the next prompt reply after it starts; `hold` delays it until
`drop_reply`. `host_event` injects a native event (`exit` is the host lifecycle event). `drain` lets due queue items
run to the next barrier, never admitting a fenced item. `restart` discards the supervisor, recovers its journal and
starts a new transport epoch, never adopting a host; profile `unconfirmed_native_identity` makes the host's process
identity unconfirmable, so cleanup stays pending. Assertions are dot-path equality on `{result, worker, disk,
effects}`: `disk` is the latest fsynced worker record, `effects.prompts` and `effects.hosts` count native prompt
submissions and host launches independently of receipts. No assertion accepts an agent completion message as
evidence. Row 01 covers `new`; Pi 1.5.2 has no direct tree-navigation command, so that variant stays uncovered.
