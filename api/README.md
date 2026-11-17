# B2 API source

`b2.openapi.yaml` (OpenAPI 3.1) is the single source of the B2 API. Edit it, then regenerate; never edit files under
`generated/` by hand.

| Path | What |
| --- | --- |
| `b2.openapi.yaml` | Operations, schemas and the event manifest (`x-piw-mutation`, `x-piw-status`, `x-piw-event`), body and response modes (`x-piw-body`, `x-piw-max-bytes`, `x-piw-response`, `x-piw-max-frame-bytes`, `info.x-piw-json-max-bytes`), grant profiles (`info.x-piw-grant-profiles`; `bridge` is Shep's method list). |
| `redocly.yaml` | Lint rules (Redocly `recommended` plus the `piw` plugin) and the bundle target. |
| `redocly/piw-rules.js` | The `piw` rules: operationId is a contract method name, paths under `/b2/`, 4xx/5xx use `Error`, mutations require `command_id`, `unsupported` declares `501`, the event manifest, body and response modes on every operation (a binary body declares its byte limit; a binary mutation carries `Piw-Command-Id`). |
| `lint-fixtures/` | One failing example per `piw` rule, plus `valid.yaml`, the baseline they are derived from. |
| `generated/b2.json` | The bundled single-file spec (`npm run api:bundle`). |

```sh
npm run api:lint          # lint the spec, prove every piw rule fails on its fixture, check the bridge profile
npm run api:bundle        # write generated/b2.json
npm run generate          # bundle, then every generated file below
npm run check:generated   # regenerate and fail if any generated file differs from the commit
```

`npm run generate` (`tools/codegen/generate.mjs`) writes:

| Output | Tool |
| --- | --- |
| `api/generated/b2.json` | Redocly CLI bundle |
| `packages/worker/src/generated/api.ts` | openapi-typescript |
| `packages/worker/src/generated/validators.js`, `.d.ts` | Ajv 2020 standalone: every request body, parameter set (path, query, header), JSON response per status and event; no runtime dependency |
| `packages/worker/src/generated/routes.ts` | in-repo route table (`tools/codegen/tables.mjs`) |
| `packages/worker/src/generated/events.ts` | in-repo event manifest and typed publishers; a `journal` event needs the journal append result |
| `packages/client-ts/src/generated/api.ts`, `routes.ts` | openapi-typescript (a copy) and the client's route table |
| `clients/go/b2/models.gen.go` | oapi-codegen v2.8.2, models only |
| `clients/go/b2/ops.gen.go` | in-repo Go operation table, event types, grant profiles and typed JSON calls (`tools/codegen/go.mjs`) |
| `clients/go/workerfake/fixtures.gen.json` | the Go fake's copy of `api/fixtures` (wire fixtures and `transitions.json`), embedded (`tools/codegen/go-fixtures.mjs`) |

`tools/codegen/check-profiles.mjs` (in `api:lint`) fails unless `info.x-piw-grant-profiles.bridge` lists exactly the
methods of [b2-for-shep.md](../docs/plan/b2-for-shep.md) section 2.1, each with an operation and a wire fixture.

Redocly runs with telemetry off (`telemetry: 'off'` in `redocly.yaml` and `REDOCLY_TELEMETRY=off` in the scripts).

## Pins

`npm run generate` first checks that every npm dependency is an exact version and that the installed Redocly CLI,
openapi-typescript, Ajv and TypeScript equal their root `devDependencies` pins (`tools/codegen/pins.mjs`), so
`check:generated` fails on a range or a drifted install. Ajv is a generator-only dependency: the standalone
validators inline Ajv's one runtime helper and generation fails on any other runtime `require`. `ajv-formats` is not
installed because the spec uses no `format` keyword, and Ajv's strict mode fails generation on an unknown format, so
adding one forces that decision. The generator refuses `ndjson` and `binary` response modes until the first operation
that uses one adds their header-schema validators.
