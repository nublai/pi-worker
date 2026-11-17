// p1-chat's agent-directory extension: pi's scripted faux provider (no credentials, no network), answering by the
// last message, a dialog before every `write` tool call (ctx.ui.confirm, answered over B2), and an extension command
// `p1-chat-mark` that writes its argument to p1-chat-mark.txt in the cwd (for commands.invoke).
//   "p1-chat:write"  -> a write tool call (the dialog opens first; "no" blocks it)
//   "p1-chat:sleep"  -> a bash `sleep 60` tool call, to be interrupted
//   an image         -> "saw N image(s)"
//   a tool result    -> "<tool> finished"
//   anything else    -> "scripted reply"
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';

const text = message =>
  typeof message.content === 'string' ? message.content : (message.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('');

const reply = context => {
  const last = context.messages.at(-1);
  if (!last) return fauxAssistantMessage('scripted reply');
  if (last.role === 'toolResult') return fauxAssistantMessage(`${last.toolName} finished`);
  const images = Array.isArray(last.content) ? last.content.filter(c => c.type === 'image').length : 0;
  if (images) return fauxAssistantMessage(`saw ${images} image(s)`);
  const said = text(last);
  if (said.includes('p1-chat:write')) return fauxAssistantMessage([fauxToolCall('write', { path: 'dialog.txt', content: 'answered over B2\n' })], { stopReason: 'toolUse' });
  if (said.includes('p1-chat:sleep')) return fauxAssistantMessage([fauxToolCall('bash', { command: 'sleep 60' })], { stopReason: 'toolUse' });
  return fauxAssistantMessage('scripted reply');
};

export default pi => {
  const core = createFauxCore({ provider: 'faux', models: [{ id: 'faux-1' }] });
  core.setResponses(Array.from({ length: 200 }, () => reply));
  pi.registerProvider('faux', {
    baseUrl: 'http://127.0.0.1:9',
    apiKey: 'faux',
    api: core.api,
    streamSimple: core.streamSimple,
    models: [{ id: 'faux-1', name: 'faux', reasoning: false, input: ['text', 'image'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }],
  });
  pi.registerCommand('p1-chat-mark', {
    description: 'Write the argument to p1-chat-mark.txt',
    handler: async (args, ctx) => writeFileSync(join(ctx.cwd, 'p1-chat-mark.txt'), String(args)),
  });
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'write') return;
    const ok = await ctx.ui.confirm('p1-chat dialog', `Write ${event.input.path}?`);
    if (!ok) return { block: true, reason: 'declined in the dialog' };
  });
};
