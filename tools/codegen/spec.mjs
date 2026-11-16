// Reads the bundled B2 spec and derives the operation and event model every generator step shares.
import { readFileSync } from 'node:fs';

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'];
const SCHEMA_REF = '#/components/schemas/';

export function loadSpec(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Follow local `$ref`s to the node they name. */
export function deref(spec, node) {
  const seen = new Set();
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/') || seen.has(node.$ref)) throw new Error(`unresolvable $ref ${node.$ref}`);
    seen.add(node.$ref);
    node = node.$ref
      .slice(2)
      .split('/')
      .reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec);
  }
  if (node === undefined) throw new Error('dangling $ref');
  return node;
}

/** `sessions.resolve_unknown` → `sessions_resolve_unknown`, a JS and Go-safe key. */
export function ident(operationId) {
  return operationId.replace(/[^A-Za-z0-9]+/g, '_');
}

/** The scalar kind of a parameter schema: what the router converts the raw string to before validation. */
function scalarKind(spec, schema) {
  const s = deref(spec, schema);
  const types = Array.isArray(s.type) ? s.type.filter(t => t !== 'null') : [s.type];
  if (types.length !== 1 || !['string', 'integer', 'number', 'boolean'].includes(types[0])) {
    throw new Error(`parameter schema must be one scalar type, got ${JSON.stringify(s.type)}`);
  }
  return types[0];
}

/** The JSON request body cap every `json` operation gets unless it declares less. */
export function jsonBodyLimit(spec) {
  const cap = spec.info?.['x-piw-json-max-bytes'];
  if (!Number.isInteger(cap) || cap <= 0) throw new Error('info.x-piw-json-max-bytes must be a positive integer');
  return cap;
}

/** Operations in path order, with parameters, body and responses resolved to what generators need. */
export function operations(spec) {
  const jsonCap = jsonBodyLimit(spec);
  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op) continue;
      const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map(p => deref(spec, p));
      const parameter = p => ({ name: p.name, in: p.in, required: p.required === true, kind: scalarKind(spec, p.schema), schema: p.schema });
      const body = op.requestBody ? deref(spec, op.requestBody) : null;
      const bodyMode = op['x-piw-body'];
      const mediaTypes = Object.keys(body?.content ?? {});
      let bodySchema = null;
      let maxBodyBytes;
      if (bodyMode === 'json') {
        bodySchema = body?.content?.['application/json']?.schema ?? null;
        if (!bodySchema || mediaTypes.length !== 1) throw new Error(`${op.operationId}: a json body is application/json with a schema`);
        maxBodyBytes = op['x-piw-max-bytes'] ?? jsonCap;
      } else if (bodyMode === 'binary') {
        if (!mediaTypes.length || mediaTypes.includes('application/json')) throw new Error(`${op.operationId}: a binary body needs non-JSON media types`);
        maxBodyBytes = op['x-piw-max-bytes'];
      } else if (bodyMode === 'none') {
        if (body) throw new Error(`${op.operationId}: x-piw-body none with a request body`);
        maxBodyBytes = 0;
      } else {
        throw new Error(`${op.operationId}: x-piw-body must be json, binary or none`);
      }
      if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 0) throw new Error(`${op.operationId}: bad x-piw-max-bytes`);
      const responses = Object.entries(op.responses).map(([status, raw]) => {
        const response = deref(spec, raw);
        const entries = Object.entries(response.content ?? {});
        if (entries.length !== 1) throw new Error(`${op.operationId} ${status}: exactly one content type expected`);
        const [contentType, media] = entries[0];
        // Error responses are JSON (piw/error-responses); a success response declares its mode.
        const mode = /^2/.test(status) ? response['x-piw-response'] : 'json';
        if (mode === 'ndjson' || mode === 'binary') {
          // Header-schema validators for these modes land with the first operation that uses one (plan 4.2).
          throw new Error(`${op.operationId} ${status}: x-piw-response ${mode} is not supported by the generator yet`);
        }
        if (mode !== 'json' && mode !== 'sse') throw new Error(`${op.operationId} ${status}: x-piw-response must be declared`);
        const maxFrameBytes = mode === 'sse' ? response['x-piw-max-frame-bytes'] : null;
        if (mode === 'sse' && !(Number.isInteger(maxFrameBytes) && maxFrameBytes > 0)) throw new Error(`${op.operationId}: sse needs x-piw-max-frame-bytes`);
        return { status, contentType, schema: media.schema, mode, maxFrameBytes };
      });
      const ok = responses.find(r => r.status === '200');
      if (!ok) throw new Error(`${op.operationId}: no 200 response`);
      ops.push({
        operationId: op.operationId,
        key: ident(op.operationId),
        method: method.toUpperCase(),
        path,
        segments: path.split('/').filter(Boolean),
        mutation: op['x-piw-mutation'] === true,
        supported: op['x-piw-status'] !== 'unsupported',
        params: params.map(parameter),
        bodyMode,
        mediaTypes,
        maxBodyBytes,
        body: bodySchema,
        responses,
        responseMode: ok.mode,
        maxFrameBytes: ok.maxFrameBytes,
        stream: ok.mode === 'sse',
      });
    }
  }
  return ops;
}

/** Event union members with their manifest entries. */
export function events(spec) {
  const subscribe = operations(spec).find(o => o.operationId === 'events.subscribe');
  const union = subscribe.responses.find(r => r.contentType === 'text/event-stream').schema;
  const unionName = union.$ref.slice(SCHEMA_REF.length);
  return {
    unionName,
    members: deref(spec, union).oneOf.map(ref => {
      const name = ref.$ref.slice(SCHEMA_REF.length);
      return { name, ...spec.components.schemas[name]['x-piw-event'] };
    }),
  };
}

export function schemaName(ref) {
  if (typeof ref?.$ref !== 'string' || !ref.$ref.startsWith(SCHEMA_REF)) return null;
  return ref.$ref.slice(SCHEMA_REF.length);
}
