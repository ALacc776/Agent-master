import { addEvent, addSpend, closeTaskInbox, onTaskChange, publishTask, repo, settings, toast, updateTask } from '../ctx.ts';
import { bus } from '../bus.ts';
import { today } from '../store/repo.ts';
import { BLOCK_TEXT, blockReason, pickStartable, ACTIVE } from '../scheduler.ts';
import { WorkerRunner, type ExitReason } from './runner.ts';
import { setAutoHandlers } from '../watchdog.ts';
import { mergeBranch, openPullRequest, removeWorktree } from './worktree.ts';
import { oneShot } from '../llm.ts';
import { notify } from '../notify.ts';
import { review } from './summarize.ts';
import type { Task } from '../../../shared/types.ts';

// Owns the running workers and applies the scheduler.

const runners = new Map<number, WorkerRunner>();
const pendingPrompts = new Map<number, string>();
let budgetToastDay = '';

export function buildPrompt(task: Task): string {
  const prefs = repo.listPreferences();
  return `# Task #${task.id}: ${task.title}

${task.brief}${prefs.length ? `\n\n## Developer preferences\n${prefs.map((p) => `- ${p.text}`).join('\n')}` : ''}`;
}

function scheduleInput() {
  const s = settings();
  return {
    tasks: repo.listTasks(),
    projects: repo.listProjects(),
    maxConcurrent: s.maxConcurrent,
    spentToday: repo.spentToday(),
    dailyCapUsd: s.dailyCapUsd,
    paused: s.paused,
  };
}

function run(task: Task) {
  if (runners.has(task.id)) return;
  const runner = new WorkerRunner(task.id, onExit);
  runners.set(task.id, runner);
  const explicit = pendingPrompts.get(task.id);
  pendingPrompts.delete(task.id);
  const resume = !!task.sessionId;
  const prompt = explicit ?? (resume ? 'Continue where you left off.' : buildPrompt(task));
  void runner.start(prompt, resume);
}

function onExit(runner: WorkerRunner, reason: ExitReason, diff?: string) {
  runners.delete(runner.taskId);
  if (pendingPrompts.has(runner.taskId)) {
    updateTask(runner.taskId, { status: 'queued', autoStart: true });
  } else if (reason === 'done') {
    void land(runner.taskId, diff ?? '').catch((err) => holdForReview(runner.taskId, `Couldn't finish automatically: ${(err as Error).message}`));
  }
  tick();
}

// Merges into one repo happen one at a time.
const projectLocks = new Map<number, Promise<unknown>>();
function withProjectLock<T>(projectId: number, fn: () => Promise<T>): Promise<T> {
  const prev = projectLocks.get(projectId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  projectLocks.set(projectId, next);
  return next;
}

function holdForReview(id: number, outcome: string) {
  const task = updateTask(id, { status: 'done', statusLine: 'Needs your review', outcome });
  notify(`Agent #${id} needs your review`, `${task.title}: ${outcome}`);
}

function finishQuietly(id: number, outcome: string) {
  const task = updateTask(id, { status: 'accepted', statusLine: 'Done', outcome, worktree: null });
  closeTaskInbox(id);
  notify(`Agent #${id} done`, `${task.title}: ${outcome}`);
}

/** Decide where finished work goes: merged in, opened as a PR, or held in Review. */
async function land(id: number, diff: string) {
  const task = repo.getTask(id)!;
  const project = repo.getProject(task.projectId);

  if (task.onDone === 'review') {
    holdForReview(id, 'You asked to review this one');
    if (settings().reviewerEnabled && diff) {
      const verdict = await review(task, diff);
      if (verdict) updateTask(id, { reviewVerdict: verdict });
    }
    return;
  }
  if (task.reviewVerdict?.startsWith('⚠️')) return holdForReview(id, 'Held back: the automatic review found concerns');

  // No git branch: the agent worked in place (non-git folder) or in a scratch folder.
  if (!project?.isGit || !task.branch || !task.baseBranch) {
    if (task.onDone === 'pr') return holdForReview(id, "Not a git repo, so there's no PR to open. The changes are in place");
    return finishQuietly(id, project ? 'Changes made in place' : 'Finished');
  }

  if (!diff.trim()) {
    if (task.worktree) await removeWorktree(project.path, task.worktree, task.branch, true);
    return finishQuietly(id, 'Finished with no code changes');
  }

  if (task.onDone === 'pr') {
    try {
      const url = await openPr(id);
      if (task.worktree) await removeWorktree(project.path, task.worktree);
      return finishQuietly(id, `Pull request opened: ${url}`);
    } catch (err) {
      return holdForReview(id, `Couldn't open a pull request: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  try {
    await withProjectLock(project.id, () => mergeTask(id));
  } catch (err) {
    holdForReview(id, `Couldn't merge automatically: ${(err as Error).message.split('\n')[0]}`);
  }
}

let ticking = false;
export function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const input = scheduleInput();
    const start = pickStartable(input);
    if (!start.length && input.dailyCapUsd > 0 && input.spentToday >= input.dailyCapUsd && budgetToastDay !== today()) {
      if (input.tasks.some((t) => t.status === 'queued' && t.autoStart)) {
        budgetToastDay = today();
        toast(`Daily cap of $${input.dailyCapUsd} reached. Queued tasks are on hold. Raise the cap in Settings to continue.`);
      }
    }
    for (const t of start) run(t);
  } finally {
    ticking = false;
  }
}

/** Manual ▶ Start (or master "now"). Returns null if started, else why it's waiting. */
export function startTask(id: number): string | null {
  const task = repo.getTask(id);
  if (!task) return 'No such task';
  if (runners.has(id)) return null;
  if (!['queued', 'stopped', 'failed'].includes(task.status)) return `Task is ${task.status}`;
  const t = updateTask(id, { status: 'queued', autoStart: true, flags: task.flags.filter((f) => f !== 'paused') });
  const reason = blockReason(t, scheduleInput());
  tick();
  return runners.has(id) ? null : reason ? BLOCK_TEXT[reason] : null;
}

export function startAll(): number {
  const queued = repo.listTasks().filter((t) => t.status === 'queued' && !t.autoStart);
  for (const t of queued) updateTask(t.id, { autoStart: true });
  tick();
  return queued.length;
}

export function stopTask(id: number) {
  const r = runners.get(id);
  pendingPrompts.delete(id);
  if (r) r.stop('stopped');
  else {
    const t = repo.getTask(id);
    if (t && t.status === 'queued') updateTask(id, { autoStart: false });
  }
}

export function pauseTask(id: number) {
  const r = runners.get(id);
  if (r) {
    updateTask(id, { autoStart: false });
    r.stop('paused');
  }
}

export function setPaused(paused: boolean) {
  const s = repo.updateSettings({ paused });
  bus.publish({ type: 'settings', data: s });
  if (paused) for (const r of runners.values()) r.stop('paused');
  else tick();
}

/** Send a message to a task; restarts finished tasks by resuming their session. */
export function messageTask(id: number, text: string): string {
  const task = repo.getTask(id);
  if (!task) return 'No such task';
  const r = runners.get(id);
  if (r && r.send(text)) return 'Delivered to the running agent.';
  if (r) {
    pendingPrompts.set(id, text);
    return 'Agent is wrapping up; it will pick this up right after.';
  }
  if (task.status === 'accepted') return 'Task was already accepted and its worktree removed. Start a follow-up instead.';
  pendingPrompts.set(id, text);
  updateTask(id, { status: 'queued', autoStart: true, summary: null, reviewVerdict: null });
  const reason = blockReason(repo.getTask(id)!, scheduleInput());
  tick();
  return runners.has(id) ? 'Agent resumed with your message.' : `Queued: ${reason ? BLOCK_TEXT[reason] : 'waiting'}.`;
}

/** Restart a long-running task in a new session, carrying a progress summary forward. */
export async function freshSession(id: number): Promise<string> {
  const task = repo.getTask(id);
  if (!task) return 'No such task';
  const history = repo
    .listEvents(id, 120)
    .filter((e) => ['assistant', 'tool', 'user', 'error'].includes(e.type))
    .map((e) => `${e.type}: ${e.text.slice(0, 300)}`)
    .join('\n');
  let handoff = task.summary ?? '';
  try {
    const r = await oneShot(
      `A coding agent is being moved to a fresh session to free up context. Write a handoff note for its next session: what is done, what is in progress, what is left, and any decisions or gotchas. Max 200 words, bullet points.\n\nTask: ${task.title}\nBrief:\n${task.brief.slice(0, 2000)}\n\nRecent activity:\n${history.slice(-12000)}`,
      { model: settings().cheapModel },
    );
    addSpend(id, r.costUsd);
    handoff = r.text || handoff;
  } catch {
    /* fall back to whatever summary exists */
  }
  pendingPrompts.set(
    id,
    `${buildPrompt(task)}\n\n## Progress from your previous session\nYour previous session was restarted to free up context. Handoff note:\n${handoff || '(none available)'}\n\nThe working directory already contains that work (check git status and git log). Continue from where it left off.`,
  );
  updateTask(id, { sessionId: null, turns: 0, flags: task.flags.filter((f) => f !== 'long') });
  closeTaskInbox(id, ['context']);
  addEvent(id, 'system', 'Starting a fresh session with a handoff summary');
  const r = runners.get(id);
  if (r) r.stop('paused');
  else {
    updateTask(id, { status: 'queued', autoStart: true });
    tick();
  }
  return `#${id} is restarting in a fresh session`;
}

export function requestChanges(id: number, text: string) {
  return messageTask(id, `The developer reviewed your work and asks for changes:\n\n${text}`);
}

export async function acceptTask(id: number) {
  const task = repo.getTask(id)!;
  const project = repo.getProject(task.projectId);
  if (project?.isGit && task.worktree) await removeWorktree(project.path, task.worktree);
  updateTask(id, { status: 'accepted', worktree: null, outcome: task.branch ? `Dismissed; branch ${task.branch} kept` : 'Done' });
  closeTaskInbox(id);
  tick();
}

export async function mergeTask(id: number) {
  const task = repo.getTask(id)!;
  const project = repo.getProject(task.projectId);
  if (!project?.isGit || !task.branch || !task.baseBranch) throw new Error('Task has no branch to merge');
  await mergeBranch(project.path, task.branch, task.baseBranch, task.title);
  if (task.worktree) await removeWorktree(project.path, task.worktree, task.branch, true);
  addEvent(id, 'system', `Merged ${task.branch} into ${task.baseBranch}`);
  // Follow-ups that were going to build on this branch now build on what it merged into.
  for (const t of repo.listTasks()) {
    if (t.baseBranch === task.branch && !t.worktree) updateTask(t.id, { baseBranch: task.baseBranch });
  }
  const done = updateTask(id, { status: 'accepted', statusLine: 'Done', worktree: null, outcome: `Merged into ${task.baseBranch}` });
  closeTaskInbox(id);
  notify(`Agent #${id} merged`, `${done.title} → ${task.baseBranch}`);
  tick();
}

export async function openPr(id: number): Promise<string> {
  const task = repo.getTask(id)!;
  if (!task.worktree || !task.branch) throw new Error('Task has no branch');
  const url = await openPullRequest(task.worktree, task.branch, task.title, `${task.summary ?? ''}\n\n---\nBrief:\n${task.brief}`);
  addEvent(id, 'system', `Opened PR: ${url}`);
  return url;
}

export function followUp(id: number, text: string, createdBy: 'user' | 'master' = 'user'): Task {
  const prev = repo.getTask(id)!;
  const t = repo.createTask({
    title: text.split('\n')[0].slice(0, 80),
    brief: `${text}\n\nThis is a follow-up to task #${prev.id} "${prev.title}".${prev.summary ? `\nWhat #${prev.id} did:\n${prev.summary}` : ''}`,
    projectId: prev.projectId,
    model: prev.model,
    dependsOn: ['done', 'accepted'].includes(prev.status) ? null : prev.id,
    createdBy,
  });
  // Build on the previous task's branch if it hasn't been merged yet.
  const task = prev.branch && prev.status !== 'accepted' ? repo.updateTask(t.id, { baseBranch: prev.branch }) : t;
  publishTask(task);
  return task;
}

export function deleteTask(id: number) {
  stopTask(id);
  const task = repo.getTask(id);
  const project = repo.getProject(task?.projectId);
  if (task?.worktree && project?.isGit) void removeWorktree(project.path, task.worktree);
  repo.deleteTask(id);
  bus.publish({ type: 'task_removed', id });
}

export const isRunning = (id: number) => runners.has(id);

// After a restart nothing is actually running: put interrupted tasks back in the queue to resume.
export function recoverOnBoot() {
  for (const t of repo.listTasks()) {
    if (ACTIVE.includes(t.status)) {
      repo.updateTask(t.id, { status: 'queued', autoStart: true, flags: ['paused'], statusLine: 'Interrupted by restart' });
    }
  }
  for (const i of repo.openInbox()) {
    if (i.kind === 'permission' || i.kind === 'question') repo.updateInbox(i.id, { status: 'dismissed' });
  }
}

onTaskChange((task, prev) => {
  if (prev && prev.status !== task.status && (task.status === 'done' || task.status === 'accepted')) tick();
});

setAutoHandlers({
  nudge: (taskId, text) => void messageTask(taskId, text),
  fresh: (taskId) => void freshSession(taskId),
});

setInterval(tick, 10_000).unref();
