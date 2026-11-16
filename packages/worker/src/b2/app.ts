/** Wires the generated route table to the handlers this build serves. P0 serves `hello`; the rest answer 501. */
import { createHello, type HelloSource } from './hello.js';
import { createRouter, type RequestHandler } from './router.js';
import type { Handlers } from './types.js';

export function createApp(source: HelloSource = {}): { handle: RequestHandler; handlers: Handlers } {
  const hello = createHello(source);
  const handlers: Handlers = { hello: () => hello() };
  return { handle: createRouter({ handlers }), handlers };
}
