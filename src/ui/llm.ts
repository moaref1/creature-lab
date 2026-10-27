// Optional LLM provider (bring your own key). The key lives in this browser only.
import { registries } from '../core/registries';
import { studio } from './store';

const KEY = 'cl.llm.key';
const MODEL = 'cl.llm.model';

function read(k: string) {
  try {
    return localStorage.getItem(k) ?? '';
  } catch {
    return '';
  }
}

export function llmStatus() {
  return { connected: !!read(KEY), model: read(MODEL) || 'claude-sonnet-5-5' };
}

function register() {
  const key = read(KEY);
  registries.llm.unregister('anthropic');
  if (!key) return;
  registries.llm.register({
    id: 'anthropic',
    label: 'Anthropic Claude',
    async complete(prompt, opts) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: opts.model ?? (read(MODEL) || 'claude-sonnet-5-5'), max_tokens: opts.maxTokens ?? 512, system: opts.system, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!r.ok) throw new Error(`LLM request failed (${r.status})`);
      const j = await r.json();
      return (j.content ?? []).map((c: any) => c.text ?? '').join('');
    },
  });
}

export function connectLlm(key: string, model: string) {
  try {
    if (key) localStorage.setItem(KEY, key);
    else if (!key && model === read(MODEL)) localStorage.removeItem(KEY);
    localStorage.setItem(MODEL, model);
  } catch {
    /* storage blocked */
  }
  register();
  studio().log(llmStatus().connected ? 'LLM provider connected.' : 'LLM provider disconnected.', 'info');
}

register();
