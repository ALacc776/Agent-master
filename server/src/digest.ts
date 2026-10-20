import { addSpend, repo, settings } from './ctx.ts';
import { oneShot } from './llm.ts';

// "While you were away": a cheap summary of what happened since the dashboard was last open.
export async function digest(since: number): Promise<{ text: string; counts: Record<string, number> }> {
  const tasks = repo.listTasks();
  const changed = tasks.filter((t) => (t.finishedAt ?? 0) > since || (t.startedAt ?? 0) > since || t.createdAt > since);
  const counts = {
    done: changed.filter((t) => t.status === 'done').length,
    failed: changed.filter((t) => t.status === 'failed').length,
    running: tasks.filter((t) => ['running', 'needs_input', 'stalled'].includes(t.status)).length,
    needsYou: repo.openInbox().length,
  };
  if (!changed.length && !counts.needsYou) return { text: 'Nothing new while you were away.', counts };

  const lines = changed.map((t) => `#${t.id} ${t.title} [${t.status}] ${t.summary ? `— ${t.summary.slice(0, 300)}` : t.statusLine}`);
  const inbox = repo.openInbox().map((i) => `agent #${i.taskId}: ${i.kind} — ${i.title}`);
  try {
    const { text, costUsd } = await oneShot(
      `Write a short "while you were away" update for a developer (max 5 bullets, plain and specific, most important first: things waiting on them, then failures, then completed work).\n\nTasks:\n${lines.join('\n')}\n\nWaiting on developer:\n${inbox.join('\n') || 'none'}`,
      { model: settings().cheapModel },
    );
    addSpend(null, costUsd);
    return { text: text || lines.join('\n'), counts };
  } catch {
    return { text: lines.join('\n'), counts };
  }
}
