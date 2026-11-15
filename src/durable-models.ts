/** THROWAWAY. No host credentials; gateway uses exe.dev's VM-local integration.
 * The faux provider is solely for deterministic crash cuts, not capability evidence.
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createModels, type MutableModels, type Provider } from '@earendil-works/pi-ai/models';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { fauxProvider, fauxAssistantMessage, fauxToolCall, type FauxResponseFactory } from '@earendil-works/pi-ai/providers/faux';
export function spikeModels(dir: string, gateway = false): MutableModels {
  const models = createModels();
  if (gateway) {
    const base = anthropicProvider();
    const template = base.getModels().find(m => m.id === 'claude-sonnet-4-6');
    if (!template) throw new Error('Pinned provider has no requested model');
    const model = { ...template, provider: 'exe-dev-anthropic', id: 'claude-sonnet-4-6@llm', baseUrl: 'https://llm.int.exe.xyz/anthropic' };
    const native = (m: typeof model) => ({ ...m, id: 'claude-sonnet-4-6' });
    const provider: Provider<'anthropic-messages'> = { ...base, id: model.provider, name: 'exe.dev VM integration (throwaway adapter)', baseUrl: model.baseUrl,
      auth: { apiKey: { name: 'VM-local integration', resolve: async () => ({ auth: { apiKey: 'integration', baseUrl: model.baseUrl }, source: 'exe.dev VM integration; public placeholder, no host credential' }) } },
      getModels: () => [model],
      stream: (m, transcript, options) => base.stream(native(m), transcript, options),
      streamSimple: (m, transcript, options) => base.streamSimple(native(m), transcript, options),
    };
    models.setProvider(provider);
  }
  const faux = fauxProvider({ provider: 'a0-faux', models: [{ id: 'deterministic', contextWindow: 200000, maxTokens: 4096 }] });
  const answer: FauxResponseFactory = async (transcript, options) => {
    faux.appendResponses([answer]);
    const last = transcript.messages.at(-1);
    const content = [...transcript.messages].reverse().find(m => m.role === 'user')?.content;
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    appendFileSync(join(dir, 'model-attempts.jsonl'), JSON.stringify({ pid: process.pid, scenario: text, lastRole: last?.role }) + '\n');
    if (last?.role === 'toolResult') return fauxAssistantMessage('TOOL_RESULT_OBSERVED');
    if (text?.includes('MODEL_CUT') && !existsSync(join(dir, 'model-cut-once'))) {
      writeFileSync(join(dir, 'model-cut-once'), String(process.pid));
      await delay(120000, undefined, { signal: options?.signal });
    }
    if (text?.includes('BASH_CUT')) return fauxAssistantMessage(fauxToolCall('bash', {
      command: `printf 'ONCE\\n' >> '${dir}/bash-start'; echo $$ > '${dir}/bash-pid'; echo BASH_STARTED; sleep 6; printf 'FINISHED\\n' >> '${dir}/bash-finish'`, timeout: 20,
    }, { id: 'a0-bash-call' }), { stopReason: 'toolUse' });
    return fauxAssistantMessage(`FAUX_OK ${text}`);
  };
  faux.setResponses([answer]); models.setProvider(faux.provider); return models;
}
