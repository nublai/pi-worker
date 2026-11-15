/** A0 live specimen: synthetic questions, real pi ExtensionUIContext. No model calls.
 * Native results are separate evidence in the conversation workspace, not control logs. */
import { appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
export default function specimen(pi: any) {
  const record = (ctx: any, kind: string, value: unknown) => appendFileSync(join(ctx.cwd, '.a0-dialog-results'), JSON.stringify({ kind, value, at: Date.now() }) + '\n');
  pi.on('session_start', async (_event: any, ctx: any) => {
    if (!existsSync(join(ctx.cwd, '.a0-startup'))) return;
    // This test explicitly exposes native identity before its blocking startup hook.
    ctx.ui.notify('A0_HOST_IDENTITY:' + JSON.stringify({ sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile() }));
    const value = await ctx.ui.input('A0 startup dialog', 'startup', { timeout: 1500 });
    record(ctx, 'startup', value);
  });
  pi.on('input', async (event: any, ctx: any) => {
    if (!event.text.startsWith('a0:dialog:')) return;
    const [kind, mode] = event.text.slice('a0:dialog:'.length).split(':');
    const opts = { timeout: mode === 'timeout' ? 150 : 15000 };
    let value;
    if (kind === 'background') {
      void ctx.ui.input('A0 idle dialog', 'navigate while pending', opts).then((v: unknown) => record(ctx, 'background', v));
      return { action: 'handled' };
    }
    if (kind === 'select') value = await ctx.ui.select('A0 duplicate labels', ['same', 'same'], opts);
    else if (kind === 'confirm') value = await ctx.ui.confirm('A0 confirm', 'No is not cancel', opts);
    else if (kind === 'input') value = await ctx.ui.input('A0 input', 'placeholder', opts);
    else if (kind === 'editor') value = await ctx.ui.editor('A0 editor', 'prefilled\ntext');
    else if (kind === 'custom') { try { value = await ctx.ui.custom(() => ({ render: () => [], invalidate() {} })); } catch { value = 'explicit_refusal'; } }
    else return;
    record(ctx, kind + ':' + (mode ?? 'answer'), value);
    return { action: 'handled' };
  });
}
