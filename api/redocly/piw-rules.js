// Redocly plugin `piw`: B2 rules the built-in rule set cannot express (plan section 4.1, step 1).
// Every rule works on the raw document with local `#/...` references; the B2 spec is one file.
// Each rule has a failing example in api/lint-fixtures/ (tools/codegen/lint-fixtures.mjs checks them).

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const PRODUCERS = ['pi', 'supervisor'];
const DURABILITY = ['journal', 'memory', 'labelled', 'transport'];
const VISIBILITY = ['subscriber', 'worker'];

function resolve(root, node) {
  const seen = new Set();
  while (node && typeof node === 'object' && typeof node.$ref === 'string') {
    if (!node.$ref.startsWith('#/') || seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    node = node.$ref
      .slice(2)
      .split('/')
      .map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
      .reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), root);
  }
  return node;
}

function* operations(root) {
  for (const [path, item] of Object.entries(root.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      if (item?.[method]) yield { path, method, operation: item[method], at: ['paths', path, method] };
    }
  }
}

function report(ctx, message, at) {
  ctx.report({ message, location: ctx.location.child(at) });
}

/** operationId is present and is a contract method name (options.methods). */
function OperationIdIsMethod(options) {
  const methods = new Set(options.methods ?? []);
  return {
    Root: {
      leave(root, ctx) {
        if (methods.size === 0) report(ctx, 'rule needs a non-empty `methods` option', []);
        for (const { operation, at } of operations(root)) {
          if (typeof operation.operationId !== 'string') report(ctx, 'operation has no operationId', at);
          else if (!methods.has(operation.operationId)) {
            report(ctx, `operationId \`${operation.operationId}\` is not a contract method name`, [...at, 'operationId']);
          }
        }
      },
    },
  };
}

/** Every path is under the unversioned `/b2/` prefix. */
function PathsUnderB2() {
  return {
    Root: {
      leave(root, ctx) {
        for (const path of Object.keys(root.paths ?? {})) {
          if (!path.startsWith('/b2/')) report(ctx, `path \`${path}\` is not under /b2/`, ['paths', path]);
        }
      },
    },
  };
}

/** Every 4xx and 5xx response is `application/json` with schema `$ref: '#/components/schemas/Error'`. */
function ErrorResponses() {
  return {
    Root: {
      leave(root, ctx) {
        for (const { operation, at } of operations(root)) {
          for (const [status, raw] of Object.entries(operation.responses ?? {})) {
            if (!/^[45]/.test(status)) continue;
            const response = resolve(root, raw);
            const content = response?.content ?? {};
            const types = Object.keys(content);
            const ok =
              types.length === 1 &&
              types[0] === 'application/json' &&
              content['application/json']?.schema?.$ref === '#/components/schemas/Error';
            if (!ok) report(ctx, `response ${status} must be application/json with schema Error`, [...at, 'responses', status]);
          }
        }
      },
    },
  };
}

/** Every operation declares boolean `x-piw-mutation`; a mutation's JSON body requires `command_id`. */
function MutationCommandId() {
  return {
    Root: {
      leave(root, ctx) {
        for (const { operation, at } of operations(root)) {
          const flag = operation['x-piw-mutation'];
          if (typeof flag !== 'boolean') {
            report(ctx, 'operation must declare boolean x-piw-mutation', at);
            continue;
          }
          if (!flag) continue;
          const body = resolve(root, operation.requestBody);
          const schema = resolve(root, body?.content?.['application/json']?.schema);
          const required = Array.isArray(schema?.required) ? schema.required : [];
          if (body?.required !== true || !required.includes('command_id') || !schema?.properties?.command_id) {
            report(ctx, 'a mutation needs a required application/json body whose schema requires command_id', at);
          }
        }
      },
    },
  };
}

/** `x-piw-status` is only `unsupported`, and an unsupported operation declares its 501 response. */
function UnsupportedDeclares501() {
  return {
    Root: {
      leave(root, ctx) {
        for (const { operation, at } of operations(root)) {
          const status = operation['x-piw-status'];
          if (status === undefined) continue;
          if (status !== 'unsupported') report(ctx, 'x-piw-status may only be `unsupported`', [...at, 'x-piw-status']);
          else if (!operation.responses?.['501']) report(ctx, 'an unsupported operation must declare a 501 response', at);
        }
      },
    },
  };
}

/**
 * The event manifest: `events.subscribe` streams `text/event-stream` whose schema is a `oneOf` union. Each member
 * declares `x-piw-event {type, producer, durability, visibility}` with `type` equal to its `type` const, and every
 * schema that declares `x-piw-event` is a member.
 */
function EventManifest() {
  return {
    Root: {
      leave(root, ctx) {
        const subscribe = [...operations(root)].find(o => o.operation.operationId === 'events.subscribe');
        if (!subscribe) {
          report(ctx, 'no events.subscribe operation', ['paths']);
          return;
        }
        const ok = resolve(root, subscribe.operation.responses?.['200']);
        const unionRef = ok?.content?.['text/event-stream']?.schema;
        const union = resolve(root, unionRef);
        if (!Array.isArray(union?.oneOf)) {
          report(ctx, 'events.subscribe 200 must be text/event-stream with a oneOf event union', [...subscribe.at, 'responses', '200']);
          return;
        }
        const members = new Set();
        const types = new Set();
        union.oneOf.forEach((ref, index) => {
          const at = ['components', 'schemas', String(unionRef?.$ref ?? '').split('/').at(-1), 'oneOf', index];
          if (typeof ref?.$ref !== 'string') {
            report(ctx, 'event union members must be $ref', at);
            return;
          }
          members.add(ref.$ref);
          const schema = resolve(root, ref);
          const manifest = schema?.['x-piw-event'];
          const constType = schema?.properties?.type?.const;
          if (!manifest || typeof manifest !== 'object') {
            report(ctx, `event ${ref.$ref} must declare x-piw-event`, at);
            return;
          }
          const problems = [];
          if (typeof manifest.type !== 'string' || manifest.type !== constType) problems.push('type must equal properties.type.const');
          if (types.has(manifest.type)) problems.push(`duplicate event type ${manifest.type}`);
          types.add(manifest.type);
          if (!PRODUCERS.includes(manifest.producer)) problems.push(`producer must be one of ${PRODUCERS.join(', ')}`);
          if (!DURABILITY.includes(manifest.durability)) problems.push(`durability must be one of ${DURABILITY.join(', ')}`);
          if (!VISIBILITY.includes(manifest.visibility)) problems.push(`visibility must be one of ${VISIBILITY.join(', ')}`);
          for (const problem of problems) report(ctx, `event ${ref.$ref}: ${problem}`, at);
        });
        for (const [name, schema] of Object.entries(root.components?.schemas ?? {})) {
          if (schema?.['x-piw-event'] && !members.has(`#/components/schemas/${name}`)) {
            report(ctx, `schema ${name} declares x-piw-event but is not in the event union`, ['components', 'schemas', name]);
          }
        }
      },
    },
  };
}

export default function piwPlugin() {
  return {
    id: 'piw',
    rules: {
      oas3: {
        'operation-id-is-method': OperationIdIsMethod,
        'paths-under-b2': PathsUnderB2,
        'error-responses': ErrorResponses,
        'mutation-command-id': MutationCommandId,
        'unsupported-declares-501': UnsupportedDeclares501,
        'event-manifest': EventManifest,
      },
    },
  };
}
