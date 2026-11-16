# B2 API source

`b2.openapi.yaml` (OpenAPI 3.1) is the single source of the B2 API. Edit it, then regenerate; never edit files under
`generated/` by hand.

| Path | What |
| --- | --- |
| `b2.openapi.yaml` | Operations, schemas and the event manifest (`x-piw-mutation`, `x-piw-status`, `x-piw-event`). |
| `redocly.yaml` | Lint rules (Redocly `recommended` plus the `piw` plugin) and the bundle target. |
| `redocly/piw-rules.js` | The `piw` rules: operationId is a contract method name, paths under `/b2/`, 4xx/5xx use `Error`, mutations require `command_id`, `unsupported` declares `501`, the event manifest. |
| `lint-fixtures/` | One failing example per `piw` rule, plus `valid.yaml`, the baseline they are derived from. |
| `generated/b2.json` | The bundled single-file spec (`npm run api:bundle`). |

```sh
npm run api:lint     # lint the spec, then prove every piw rule fails on its fixture
npm run api:bundle   # write generated/b2.json
```

Redocly runs with telemetry off (`telemetry: 'off'` in `redocly.yaml` and `REDOCLY_TELEMETRY=off` in the scripts).
