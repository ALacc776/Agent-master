import { query } from '@anthropic-ai/claude-agent-sdk';
import { MODELS } from '../../shared/types.ts';

// One-shot completion on a cheap model: no tools, no project settings, no saved session.
export async function oneShot(prompt: string, opts: { model: string; system?: string; timeoutMs?: number }): Promise<{ text: string; costUsd: number }> {
  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), opts.timeoutMs ?? 90_000);
  let text = '';
  let costUsd = 0;
  try {
    const q = query({
      prompt,
      options: {
        model: opts.model,
        systemPrompt: opts.system ?? 'You are a concise assistant. Answer directly.',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        abortController,
      },
    });
    for await (const msg of q) {
      if (msg.type === 'result') {
        costUsd = msg.total_cost_usd ?? 0;
        if (msg.subtype === 'success') text = msg.result;
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return { text: text.trim(), costUsd };
}

export function extractJson<T>(text: string): T | undefined {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return undefined;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return undefined;
  }
}

// Turn SDK/CLI failures into something the developer can act on.
export function explainError(message: string): string {
  if (/authenticat|oauth|api key|not logged in|login/i.test(message)) {
    return `${message}\nFix: run \`claude auth login\` in a terminal (or set ANTHROPIC_API_KEY), then try again.`;
  }
  return message;
}

export const MODEL_GUIDE = `- haiku: trivial, mechanical work (typos, renames, copy edits, config tweaks, a one-file change with an obvious answer).
- sonnet: the default for normal feature work, bug fixes, tests and refactors.
- opus: hard work (architecture or design decisions, subtle or cross-cutting bugs, concurrency/security, large multi-file refactors, anything where a wrong approach is expensive).`;

export function modelId(name: string | undefined, fallback: string): string {
  const key = (name ?? '').toLowerCase();
  if (key.includes('haiku')) return MODELS.haiku;
  if (key.includes('opus')) return MODELS.opus;
  if (key.includes('sonnet')) return MODELS.sonnet;
  return name || fallback;
}

// Cheap classifier used when a task is created with model "auto".
export async function pickModel(title: string, brief: string, cheapModel: string): Promise<{ model: string; reason: string; costUsd: number }> {
  try {
    const { text, costUsd } = await oneShot(
      `Pick the model for this coding task.\n${MODEL_GUIDE}\n\nTask: ${title}\n${brief.slice(0, 3000)}\n\nReply ONLY with JSON: {"model": "haiku"|"sonnet"|"opus", "reason": "<max 8 words>"}`,
      { model: cheapModel, timeoutMs: 30_000 },
    );
    const r = extractJson<{ model: string; reason: string }>(text);
    return { model: modelId(r?.model, MODELS.sonnet), reason: r?.reason ?? '', costUsd };
  } catch {
    return { model: MODELS.sonnet, reason: 'default', costUsd: 0 };
  }
}
