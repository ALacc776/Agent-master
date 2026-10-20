import { addSpend, settings } from '../ctx.ts';
import { extractJson, oneShot } from '../llm.ts';
import type { Task } from '../../../shared/types.ts';

// The worker is asked to end with a short summary; only condense it with the cheap model if it's long.
export async function summarize(task: Task, finalText: string, diffStat: string): Promise<string> {
  const text = finalText.trim();
  if (text && text.length <= 700) return text;
  try {
    const { text: out, costUsd } = await oneShot(
      `Summarize what this coding agent did in 2-4 short bullet points, then one line "Verify: ..." telling the developer how to check it.\n\nTask: ${task.title}\n\nAgent's final message:\n${text.slice(0, 6000)}\n\nDiff stat:\n${diffStat.slice(0, 2000)}`,
      { model: settings().cheapModel },
    );
    addSpend(task.id, costUsd);
    return out || text.slice(0, 700);
  } catch {
    return text.slice(0, 700);
  }
}

export async function review(task: Task, diff: string): Promise<string | null> {
  if (!diff.trim()) return null;
  try {
    const { text, costUsd } = await oneShot(
      `You are a strict code reviewer. Review this diff for the task below. Look for bugs, missing pieces vs. the brief, and risky changes.

Task #${task.id}: ${task.title}
Brief:
${task.brief.slice(0, 3000)}

Diff:
${diff.slice(0, 40_000)}${diff.length > 40_000 ? '\n…(truncated)' : ''}

Reply ONLY with JSON: {"ok": true|false, "notes": "<max 40 words>"}`,
      { model: settings().reviewerModel, timeoutMs: 120_000 },
    );
    addSpend(task.id, costUsd);
    const r = extractJson<{ ok: boolean; notes: string }>(text);
    if (!r) return null;
    return `${r.ok ? '✅ Looks good' : '⚠️ Concerns'} — ${r.notes}`;
  } catch {
    return null;
  }
}
