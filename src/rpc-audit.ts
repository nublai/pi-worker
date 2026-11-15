/** A0-owned RPC observer; upstream custom() silently returns undefined. This makes
 * its invocation an explicit refusal and inventories actually registered resources. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function audit(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.notify('A0_HOST_IDENTITY:' + JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }));
    const inventory = () => ctx.ui.notify('A0_RESOURCE_INVENTORY:' + JSON.stringify({ tools: pi.getAllTools().map(t => ({ name: t.name, sourceInfo: t.sourceInfo })), active_tools: pi.getActiveTools(), commands: pi.getCommands().map(c => ({ name: c.name, source: c.source, sourceInfo: c.sourceInfo })) }));
    setImmediate(inventory);
  });
  pi.on('ui_prompt_start', (event, ctx) => {
    if (event.kind === 'custom') ctx.ui.notify('A0_UNSUPPORTED_CUSTOM_UI');
  });
}
