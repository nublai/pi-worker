# Go client for B2

`github.com/nublai/pi-worker/clients/go/b2`: Go 1.24, standard library only (`stdlib-gate.sh` enforces it).

| File | What |
| --- | --- |
| `b2/models.gen.go` | Models from oapi-codegen v2.8.2, models only (`b2/oapi-codegen.yaml`; the tool is pinned in `tools/go/go.mod`). |
| `b2/ops.gen.go` | Operation table, `EventTypes` and typed call wrappers, from `tools/codegen/go.mjs`. |
| `b2/transport.go` | Unix-socket transport: SO_PEERCRED owner check before the bearer, one attempt, no keep-alive, no redirects, classification. |
| `b2/sse.go`, `b2/events.go` | The SSE loop (`Watch`) and the event union decoder. Never reconnects on its own. |

Regenerate with `npm run generate` at the repository root. Failures are `*ClientFailure`: `NoEffect` only before the
connection reaches the writer or when the worker says `no_effect`; otherwise `UnknownEffect`, and the caller reads the
receipt for its `command_id`.

```sh
go vet ./... && go test -race ./...
go test -tags integration ./...   # needs `npm run build` first; starts packages/worker/dist/src/main.js
./stdlib-gate.sh
```
