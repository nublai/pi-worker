/** Embedded mode: the same request handler over an in-memory transport, for tests and single-process callers. */
import type { B2Response, RequestHandler } from './router.js';

export interface MemoryRequest {
  readonly headers?: Record<string, string>;
  /** A JSON value (sent as application/json) or raw bytes with the caller's own content type. */
  readonly json?: unknown;
  readonly raw?: Uint8Array;
}

export interface MemoryTransport {
  request(method: string, url: string, init?: MemoryRequest): Promise<B2Response>;
}

export function createMemoryTransport(handle: RequestHandler): MemoryTransport {
  return {
    async request(method, url, init = {}) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
      let body: Uint8Array | undefined = init.raw;
      if (init.json !== undefined) {
        body = Buffer.from(JSON.stringify(init.json));
        headers['content-type'] ??= 'application/json';
      }
      if (body) headers['content-length'] ??= String(body.byteLength);
      const response = await handle({ method, url, headers, ...(body ? { body } : {}) });
      // Same bytes a socket client would see: a JSON round trip, so no object identity leaks across.
      return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) };
    },
  };
}
