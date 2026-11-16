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

/** `defaults` are headers sent with every request (for example a test's bearer); a request's own headers win. */
export function createMemoryTransport(handle: RequestHandler, defaults: Record<string, string> = {}): MemoryTransport {
  return {
    async request(method, url, init = {}) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries({ ...defaults, ...init.headers })) headers[k.toLowerCase()] = v;
      let body: Uint8Array | undefined = init.raw;
      if (init.json !== undefined) {
        body = Buffer.from(JSON.stringify(init.json));
        headers['content-type'] ??= 'application/json';
      }
      if (body) headers['content-length'] ??= String(body.byteLength);
      const response = await handle({ method, url, headers, ...(body ? { body } : {}) });
      if (response.stream) {
        // Embedded SSE: the frames the stream writes synchronously at attach (its snapshot, then anything queued),
        // then the stream is closed. The body is the list of frames, each the JSON of its `data` line.
        const records: string[] = [];
        const closers: (() => void)[] = [];
        response.stream.sse({
          write: record => (records.push(record), true),
          end: () => {},
          destroy: () => {},
          onDrain: () => {},
          onClose: listener => closers.push(listener),
        });
        for (const close of closers) close();
        const frames = records.map(r => JSON.parse(r.split('\n').find(l => l.startsWith('data: '))!.slice(6)) as unknown);
        return { status: response.status, body: frames };
      }
      // Same bytes a socket client would see: a JSON round trip, so no object identity leaks across.
      return { status: response.status, body: JSON.parse(JSON.stringify(response.body)) };
    },
  };
}
