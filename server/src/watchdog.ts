import { addInbox, closeTaskInbox, repo, settings, updateTask } from './ctx.ts';
import type { Task } from '../../shared/types.ts';
export { LoopDetector } from './loop.ts';

// Flags stuck workers: stalled (no activity), looping (same tool call repeatedly), and
// collisions (two running tasks touching the same files in one project).

// In auto mode the watchdog fixes things itself instead of asking. The manager registers these
// (it owns the workers; importing it here would be circular).
let auto: { nudge: (taskId: number, text: string) => void; fresh: (taskId: number) => void } | null = null;
export function setAutoHandlers(h: NonNullable<typeof auto>) {
  auto = h;
}
const NUDGE = 'Status check: you seem stuck or are repeating the same step. Step back, say briefly what is blocking you, and try a different approach. If the task is done, wrap up with your summary.';

function addFlag(task: Task, flag: string): boolean {
  if (task.flags.includes(flag)) return false;
  updateTask(task.id, { flags: [...task.flags, flag] });
  return true;
}

export function clearFlag(taskId: number, flag: string) {
  const task = repo.getTask(taskId);
  if (task?.flags.includes(flag)) updateTask(taskId, { flags: task.flags.filter((f) => f !== flag) });
  if (task) closeTaskInbox(taskId, [flag === 'looping' ? 'loop' : (flag as any)]);
}

export function flagLoop(taskId: number, what: string) {
  const task = repo.getTask(taskId);
  if (!task || !addFlag(task, 'looping')) return;
  if (settings().autoMode && auto && !task.flags.includes('nudged')) {
    addFlag(repo.getTask(taskId)!, 'nudged');
    auto.nudge(taskId, NUDGE);
    setTimeout(() => clearFlag(taskId, 'looping'), 1000);
    return;
  }
  addInbox({ taskId, kind: 'loop', title: `may be looping: repeated "${what}" 3× in a row`, detail: { message: what } });
}

// Long sessions fill the context window; suggest a fresh session carrying a summary forward.
export function flagLongSession(taskId: number, turns: number) {
  const task = repo.getTask(taskId);
  if (!task || !addFlag(task, 'long')) return;
  if (settings().autoMode && auto) {
    auto.fresh(taskId);
    return;
  }
  addInbox({
    taskId,
    kind: 'context',
    title: `has run ${turns} turns in one session`,
    detail: { message: 'Its context is getting large, which makes it slower, pricier and more forgetful. Start a fresh session: it stops, writes a progress summary, and continues in a new session with that summary.' },
  });
}

export function overlappingFiles(a: Task, b: Task): string[] {
  const rel = (t: Task, f: string) => (t.worktree && f.startsWith(t.worktree) ? f.slice(t.worktree.length) : f);
  const bs = new Set(b.filesTouched.map((f) => rel(b, f)));
  return a.filesTouched.map((f) => rel(a, f)).filter((f) => bs.has(f));
}

export function checkCollision(taskId: number) {
  const task = repo.getTask(taskId);
  if (!task || task.projectId == null || task.flags.includes('collision')) return;
  const others = repo
    .listTasks()
    .filter((t) => t.id !== task.id && t.projectId === task.projectId && ['running', 'needs_input', 'stalled'].includes(t.status));
  for (const other of others) {
    const overlap = overlappingFiles(task, other);
    if (overlap.length) {
      addFlag(task, 'collision');
      if (settings().autoMode) return; // shown as a chip on the card; merges that conflict land in Review anyway
      addInbox({
        taskId,
        kind: 'collision',
        title: `edits the same files as agent #${other.id}: ${overlap.slice(0, 3).join(', ')}${overlap.length > 3 ? '…' : ''}`,
        detail: { message: `Merging both branches may conflict. Consider stopping one or letting them finish one after the other.` },
      });
      return;
    }
  }
}

export function startWatchdog() {
  setInterval(() => {
    const limit = settings().stallMinutes * 60_000;
    for (const task of repo.listTasks()) {
      if (task.status !== 'running') continue;
      const last = task.lastEventAt ?? task.startedAt ?? Date.now();
      if (Date.now() - last > limit && addFlag(task, 'stalled')) {
        updateTask(task.id, { status: 'stalled' });
        if (settings().autoMode && auto && !task.flags.includes('nudged')) {
          addFlag(repo.getTask(task.id)!, 'nudged');
          auto.nudge(task.id, NUDGE);
          continue;
        }
        addInbox({
          taskId: task.id,
          kind: 'stalled',
          title: `has shown no activity for ${settings().stallMinutes}+ minutes`,
          detail: { message: task.statusLine },
        });
      }
    }
  }, 30_000).unref();
}
