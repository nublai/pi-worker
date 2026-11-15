/** A0-owned SDK subprocess and ACP v1 client. ACP extension profile is documented
 * in A0-SLICE3.md; it is not a generic ACP client and never masquerades as B1. */
import { fileURLToPath } from 'node:url';
import { RpcHost, type PiRecord } from './host.js';
import type { Create } from './types.js';
export class SdkHost extends RpcHost {
  constructor(c: Create, dir: string, kind: 'sdk' | 'acp' = 'sdk') {
    super(process.execPath, c.cwd, dir, c.provider, c.model, c.thinking, 30000, { kind, args: [fileURLToPath(new URL('./sdk-child.js', import.meta.url)), kind, dir, c.provider, c.model, c.thinking, String(c.project_trusted === true)] });
  }
}
export class AcpHost extends SdkHost {
  private initialized = false;
  private sessionId = '';
  private readonly agentCwd: string;
  constructor(c: Create, dir: string) { super(c, dir, 'acp'); this.agentCwd = c.cwd; }
  override async request(c: PiRecord) {
    if (!this.initialized && c.type === 'get_state') {
      const init = await super.request({ type: 'acp_initialize' });
      if (!init.success || init.data?.protocolVersion !== 1) throw new Error('ACP v1 required');
      const created = await super.request({ type: 'acp_new' });
      if (!created.success) throw new Error('ACP session/new failed');
      this.sessionId = String(created.data?.sessionId); this.initialized = true;
    }
    const r = await super.request(c);
    if (c.type === 'get_state' && typeof r.data?.sessionId === 'string') this.sessionId = r.data.sessionId;
    return r;
  }
  protected override encode(c: PiRecord): Record<string, unknown> {
    if (c.type === 'answer_ui') {
      const answer = c.answer as { outcome: string; value?: unknown };
      return { jsonrpc: '2.0', id: c.nativeId, result: { outcome: answer.outcome === 'cancel' ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: answer.value === false ? 'deny' : 'allow' }, _meta: { piAnswer: c.answer, ackId: c.id } } };
    }
    if (c.type === 'acp_initialize') return { jsonrpc: '2.0', id: c.id, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {}, _meta: { piWorkerProfile: 1 } } };
    if (c.type === 'acp_new') return { jsonrpc: '2.0', id: c.id, method: 'session/new', params: { cwd: this.agentCwd, mcpServers: [] } };
    if (c.type === 'prompt') return { jsonrpc: '2.0', id: c.id, method: 'session/prompt', params: { sessionId: this.sessionId, prompt: [{ type: 'text', text: c.message }] } };
    return { jsonrpc: '2.0', id: c.id, method: '_pi/command', params: { sessionId: this.sessionId, command: c } };
  }
  protected override decode(r: Record<string, unknown>): PiRecord | null {
    if (r.jsonrpc !== '2.0') return null;
    if (r.method === '_pi/admitted' || r.method === '_pi/consumed') {
      const p = r.params as Record<string, unknown>;
      return { type: 'response', id: p.id, success: true, data: p.data };
    }
    if (r.method === '_pi/dialog' || r.method === 'session/request_permission') return (r.params as { _meta: { piEvent: PiRecord } })._meta.piEvent;
    if (r.method === '_pi/event') return (r.params as { event: PiRecord }).event;
    if (r.method === 'session/update') return (r.params as { _meta?: { piEvent?: PiRecord } })._meta?.piEvent ?? null;
    if ('id' in r && ('result' in r || 'error' in r)) return { type: 'response', id: r.id, success: !r.error, data: r.result, error: r.error ? 'acp_error' : undefined };
    return null;
  }
}
