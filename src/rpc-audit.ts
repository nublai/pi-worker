/** A0-owned RPC observer; upstream custom() silently returns undefined. This makes
 * its invocation an explicit refusal and inventories actually registered resources. */
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
export default function audit(pi: ExtensionAPI): void {
  const binding = (ctx: ExtensionContext, action: string) => ctx.ui.notify('A0_HOST_BINDING:' + JSON.stringify({ action, sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(), leafId: ctx.sessionManager.getLeafId() }));
  pi.on('session_tree', (_event, ctx) => binding(ctx, 'tree'));
  // Pre-move warning (SDK/ACP get it from beforeSessionInvalidate): the old
  // session is being torn down, so the supervisor refuses writes until the
  // replacement binds. Pipe latency still leaves a tiny window (stated limit).
  pi.on('session_shutdown', (_event, ctx) => ctx.ui.notify('A0_HOST_BINDING_CHANGING'));
  pi.on('session_start', (event, ctx) => {
    binding(ctx, event.reason);
    const inventory = () => ctx.ui.notify('A0_RESOURCE_INVENTORY:' + JSON.stringify({ tools: pi.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })), active_tools: pi.getActiveTools(), commands: pi.getCommands().map(c => ({ name: c.name, source: c.source, sourceInfo: c.sourceInfo })) }));
    setImmediate(inventory);
  });
  pi.on('ui_prompt_start', (event, ctx) => {
    if (event.kind === 'custom') ctx.ui.notify('A0_UNSUPPORTED_CUSTOM_UI');
  });
}
