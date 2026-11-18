# Go client for B2

`github.com/nublai/pi-worker/clients/go`: Go 1.24, standard library only (`stdlib-gate.sh` enforces it, tests
included).

| File | What |
| --- | --- |
| `b2/models.gen.go` | Models from oapi-codegen v2.8.2, models only (`b2/oapi-codegen.yaml`; the tool is pinned in `tools/go/go.mod`). |
| `b2/ops.gen.go` | Operation table, `EventTypes`, `GrantProfiles` and typed JSON call wrappers, from `tools/codegen/go.mjs`. |
| `b2/transport.go` | Unix-socket transport: peer owner check before any byte is written (`peercred_linux.go` SO_PEERCRED, `peercred_darwin.go` LOCAL_PEERCRED, refused elsewhere), one attempt, no keep-alive, no redirects, classification. |
| `b2/grant_unix.go` | Grant read from the opened file on every call: `O_NOFOLLOW`, non-blocking, exact regular 0600, owned by the effective UID, at most 64 KiB. Refused on other systems (`grant_other.go`). |
| `b2/bytes.go` | The byte operations: `AttachmentsStage` (streamed upload, never buffered whole or re-sent), `SessionsHistory` and `BlobsRead` (byte reads with their headers). |
| `b2/sse.go`, `b2/events.go` | The SSE loop (`Watch`) and the event union decoder. Never reconnects on its own. |
| `workerfake/` | A fake worker for driver tests (below). |
| `workerfake/fixtures.gen.json` | The fake's embedded copy of `api/fixtures`, from `tools/codegen/go-fixtures.mjs`. |

Regenerate with `npm run generate` at the repository root. Failures are `*ClientFailure`: `NoEffect` only before the
connection reaches the writer or when the worker says `no_effect`; otherwise `UnknownEffect`, and the caller reads the
receipt for its `command_id`. After an upload whose reply was lost, read `AttachmentsStatus` for the attachment id;
never upload again blindly.

## `workerfake`

`workerfake.Start(workerfake.Options{})` serves B2 on a private socket with a grant file (`Fake.Client()` returns a
client for it). The grant is the `bridge` profile unless `Options.Methods` says otherwise.

- **Stateful (default).** Workers, bindings, executions, the follow-up queue, fences and `resolve_unknown`,
  receipts, interactions, attachments and the event stream follow the worker's rules, with its refusal names and
  bounds. Every session a worker binds has a session file: its header line; for each prompt, the
  `pi-worker.input` stamp and the user message, as the worker's SDK child and pi write them (the worker-owned
  interrupt marker in front of the text after an interrupted execution, `result.interrupt_marker` on the receipt);
  pi's aborted assistant turn when `executions.cancel` or `executions.interrupt` ends a running execution; and what
  `AppendHistory` adds. `sessions.get`, `sessions.list`, `sessions.history` and `blobs.read` read those, and an unknown session is
  `unknown_session`. `models.list` and `commands.list` answer for a ready worker or an existing directory with
  their wire fixtures' catalog. The reads it does not model (`history.page`, `items.read`, `files.read`,
  `artifacts.inspect`) answer only a
  request that matches a wire fixture exactly, else `404 fixture_not_found`, never another request's reply.
- **Replay (`Options.Replay`).** Every operation answers only from its wire fixtures, matched exactly; use it to test
  that a driver handles every documented reply, refusals included.
- **Fixture controls**, never model effects: `Host(id)` (`DropNextPromptReply`, `HoldNextPromptReply`,
  `ReleaseHeldReply`, `NextAgentStart`, `Emit("agent_start" | "agent_settled" | "exit")`, `Prompts`,
  `AcceptNextImages`), `Hosts`, `Restart`, `Drain`, `Disk`, `Overflow`, `EndAuthority` (a terminal stream end
  with a refusal code), `DropNextStageReply`, `OpenInteraction` (a card closes `timeout` at its deadline, 30 s by default), `AppendHistory`, `ReplaceHistory`. A prompt starts
  and is acknowledged; nothing settles until `Emit("agent_settled")`, and no assistant reply is written unless a test
  appends one.

Its tests are the plan's P1-17 check: the Go replay of `api/fixtures/transitions.json` (the eleven section 0.1 rows,
semantic hash pinned), the bridge-profile closure (every method routed, with wire fixtures, answered; every wire
fixture round-trips through its typed Go call), SSE reconnect and overflow, and the streamed upload (1.5 MiB, a lost
reply reconciled through `attachments.status`, limits refused before sending).

## Vendoring (Shep, S-2)

Copy `b2/` and `workerfake/` (with `fixtures.gen.json`) at one pi-worker commit, rewrite the import path
`github.com/nublai/pi-worker/clients/go/b2` in `workerfake/*.go` to the vendored one, and record the commit and the
files' SHA-256 in the stamp file. Nothing outside the two directories is read at build or test time. Skip
`b2/integration_test.go`: it starts the built worker from this repository.

```sh
go vet ./... && go test -race ./...
go test -race ./workerfake/...     # the P1-17 check alone
go test -tags integration ./...    # needs `npm run build` first; starts packages/worker/dist/src/main.js
./stdlib-gate.sh
```
