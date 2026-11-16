# B2 fixtures

## Wire fixtures

`wire/<operationId>/<name>.json` holds one request and response example per file. Every operation has at least one;
the closure tests (`packages/worker/test/closure.test.ts`) check that, and that every fixture validates against the
spec. Add or update a fixture with every new or changed operation.

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
