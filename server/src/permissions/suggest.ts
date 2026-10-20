import { addSpend, repo, settings, updateInbox } from '../ctx.ts';
import { extractJson, oneShot } from '../llm.ts';
import type { InboxItem, Rule } from '../../../shared/types.ts';

// Suggested answers come from a separate cheap one-shot, never the master chat,
// so they never hold anything up. The suggestion's first line is the answer, the rest is why.
export async function suggestAnswer(item: InboxItem): Promise<void> {
  if (item.kind !== 'permission' && item.kind !== 'question') return;
  const task = item.taskId ? repo.getTask(item.taskId) : undefined;
  const prefs = repo.listPreferences().map((p) => `- ${p.text}`).join('\n') || '(none)';
  const ask =
    item.kind === 'permission'
      ? `The agent wants to: ${item.title}\nPolicy note: ${item.detail.reason ?? ''}\nAnswer "allow" or "deny".`
      : `The agent asks:\n${(item.detail.questions ?? [])
          .map((q) => `${q.question}\nOptions: ${q.options.map((o) => `"${o.label}"${o.description ? ` (${o.description})` : ''}`).join(', ')}`)
          .join('\n\n')}\nAnswer with the exact option label you recommend (or a short free-text answer).`;
  const prompt = `You help a developer triage requests from a coding agent.
Context: each agent works in its own git worktree on its own branch. Editing files, running builds/tests, and git add/commit there are expected and fine (author name/email flags are fine too). Only pushing, merging, deploying, deleting things outside the task, or touching other folders deserve a "deny". When in doubt about a routine dev command, prefer "allow".
Task #${task?.id ?? '?'}: ${task?.title ?? ''}
Brief: ${(task?.brief ?? '').slice(0, 1500)}
Developer preferences:
${prefs}

${ask}

Reply ONLY with JSON: {"answer": "...", "why": "<max 15 words>"}`;
  try {
    const { text, costUsd } = await oneShot(prompt, { model: settings().cheapModel, timeoutMs: 60_000 });
    addSpend(item.taskId, costUsd);
    const parsed = extractJson<{ answer: string; why: string }>(text);
    if (!parsed?.answer) return;
    const current = repo.getInbox(item.id);
    if (current?.status === 'open') updateInbox(item.id, { suggestedAnswer: `${parsed.answer}\n${parsed.why ?? ''}` });
  } catch (err) {
    console.warn('[suggest] failed', (err as Error).message);
  }
}

// Cheap fuzzy check: does a remembered question answer apply to this new question?
export async function fuzzyQuestionRule(rules: Rule[], question: string, options: string[]): Promise<Rule | undefined> {
  const qRules = rules.filter((r) => r.kind === 'question' && r.answer);
  if (!qRules.length) return undefined;
  const list = qRules.map((r, i) => `${i}. Q: ${r.pattern}\n   A: ${r.answer}`).join('\n');
  const prompt = `Remembered answers from the developer:
${list}

New question: ${question}
Options: ${options.join(' | ') || '(free text)'}

Does one remembered answer clearly settle the new question (same decision, not just a similar topic)?
Reply ONLY with JSON: {"index": <number or null>}`;
  try {
    const { text, costUsd } = await oneShot(prompt, { model: settings().cheapModel, timeoutMs: 30_000 });
    addSpend(null, costUsd);
    const idx = extractJson<{ index: number | null }>(text)?.index;
    return typeof idx === 'number' ? qRules[idx] : undefined;
  } catch {
    return undefined;
  }
}
