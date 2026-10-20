import { repo, updateInbox } from './ctx.ts';
import { answerInbox, isPending } from './permissions/gate.ts';
import { freshSession, messageTask, startTask, stopTask } from './workers/manager.ts';
import { clearFlag } from './watchdog.ts';

// One entry point for answering a Needs-You item, used by the dashboard and the master.
// Permission/question items unblock the waiting worker; watchdog items take an action.
export function answerItem(id: number, answer: string, remember = false): string {
  const item = repo.getInbox(id);
  if (!item) return 'No such inbox item';
  if (item.status !== 'open') return 'Already handled';

  if (isPending(id)) {
    answerInbox(id, answer, remember);
    return `Answered agent #${item.taskId}: ${answer}`;
  }

  const a = answer.trim();
  const taskId = item.taskId;
  updateInbox(id, { status: 'answered', answer: a });
  if (taskId == null) return 'Dismissed';

  if (/^(stop|kill|cancel)$/i.test(a)) {
    stopTask(taskId);
    return `Stopped #${taskId}`;
  }
  if (/^(fresh|fresh session|new session|restart fresh)$/i.test(a)) {
    void freshSession(taskId);
    return `Restarting #${taskId} in a fresh session`;
  }
  if (/^(dismiss|ignore|ok|fine|keep going|continue)$/i.test(a)) {
    if (item.kind === 'loop') clearFlag(taskId, 'looping');
    if (item.kind === 'collision') clearFlag(taskId, 'collision');
    return 'Dismissed';
  }
  if (/^(retry|restart|start)$/i.test(a)) {
    return startTask(taskId) ?? `Restarted #${taskId}`;
  }
  // Anything else is a nudge/instruction sent to the agent.
  if (item.kind === 'loop') clearFlag(taskId, 'looping');
  if (item.kind === 'stalled') clearFlag(taskId, 'stalled');
  return messageTask(taskId, a);
}

export function dismissItem(id: number) {
  const item = repo.getInbox(id);
  if (!item) return;
  if (isPending(id)) answerInbox(id, 'deny');
  else updateInbox(id, { status: 'dismissed' });
  if (item.taskId != null && item.kind === 'loop') clearFlag(item.taskId, 'looping');
  if (item.taskId != null && item.kind === 'collision') clearFlag(item.taskId, 'collision');
}
