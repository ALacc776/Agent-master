import { addEvent, addSpend, closeTaskInbox, onTaskChange, publishTask, repo, settings, toast, updateTask } from '../ctx.ts';
import { bus } from '../bus.ts';
import { today } from '../store/repo.ts';
import { BLOCK_TEXT, blockReason, pickStartable, ACTIVE } from '../scheduler.ts';
import { WorkerRunner, type ExitReason } from './runner.ts';
import { setAutoHandlers } from '../watchdog.ts';
import { mergeBranch, openPullRequest, removeWorktree, reopenWorktree } from './worktree.ts';
import { oneShot } from '../llm.ts';
import { notify } from '../notify.ts';
import { review } from './summarize.ts';
import { MODELS, type Task } from '../../../shared/types.ts';
import { existsSync } from 'node:fs';
import { listSessions, sessionExists } from '../sessions.ts';
import { knownCommands } from '../commands.ts';
import { addProjectFromPath } from '../projects.ts';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Owns the running workers and applies the scheduler.

const runners = new Map<number, WorkerRunner>();
const pendingPrompts = new Map<number, string>();
let budgetToastDay = '';

export function buildPrompt(task: Task): string {
  const prefs = repo.listPreferences();
  if (task.flags.includes('plan'))
    return `${task.brief}${prefs.length ? `\n\n(Developer preferences: ${prefs.map((p) => p.text).join('; ')})` : ''}`;
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
  const prev = repo.getTask(id)!;
  const task = updateTask(id, { status: 'accepted', statusLine: 'Done', outcome, worktree: prev.worktree?.includes('/.master-worktrees/') ? null : prev.worktree });
  closeTaskInbox(id);
  notify(`Agent #${id} done`, `${task.title}: ${outcome}`);
}

/** Decide where finished work goes: merged in, opened as a PR, or held in Review. */
async function land(id: number, diff: string) {
  const task = repo.getTask(id)!;
  const project = repo.getProject(task.projectId);

  // Still planning: it's the developer's turn to reply (or approve a plan).
  if (task.flags.includes('plan')) {
    updateTask(id, { status: 'idle', statusLine: 'Planning: your turn', outcome: null });
    return;
  }
  if (task.onDone === 'keep') {
    updateTask(id, { status: 'idle', statusLine: 'Ready for more', outcome: null });
    notify(`Agent #${id} is ready for more`, task.title);
    return;
  }
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
  if (!['queued', 'stopped', 'failed', 'idle'].includes(task.status)) return `Task is ${task.status}`;
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
  if (task.status === 'accepted') {
    void reopenTask(id, text).catch((err) => toast(`Couldn't reopen #${id}: ${(err as Error).message}`));
    return `Reopening #${id} with its context…`;
  }
  pendingPrompts.set(id, text);
  updateTask(id, { status: 'queued', autoStart: true, summary: null, reviewVerdict: null });
  const reason = blockReason(repo.getTask(id)!, scheduleInput());
  tick();
  return runners.has(id) ? 'Agent resumed with your message.' : `Queued: ${reason ? BLOCK_TEXT[reason] : 'waiting'}.`;
}

/** Continue a finished (merged or dismissed) agent: same session and memory, fresh branch from the latest code. */
async function reopenTask(id: number, text: string) {
  const task = repo.getTask(id)!;
  if (!task.sessionId) throw new Error('it never started a session');
  const project = repo.getProject(task.projectId);
  let note = '';
  if (project?.isGit && task.branch && task.baseBranch) {
    const wt = await reopenWorktree(project.path, id, task.title, task.branch, task.baseBranch);
    updateTask(id, { worktree: wt.path });
    note = wt.fresh
      ? `(Your earlier work was merged into ${task.baseBranch}. You're on a fresh branch "${task.branch}" from the latest ${task.baseBranch}; the files may have changed since, so re-check before editing.)\n\n`
      : `(You're back on your branch "${task.branch}".)\n\n`;
  }
  pendingPrompts.set(id, note + text);
  updateTask(id, { status: 'queued', autoStart: true, outcome: null, summary: null, reviewVerdict: null, finishedAt: null });
  addEvent(id, 'system', 'Reopened to continue the conversation');
  tick();
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

/** Change a task's model. Running agents switch live, from their next turn. */
export async function setTaskModel(id: number, model: string): Promise<string> {
  const task = repo.getTask(id);
  if (!task) return 'No such task';
  updateTask(id, { model, modelReason: 'Chosen by you' });
  const r = runners.get(id);
  if (r) {
    try {
      await r.setModel(model);
    } catch (err) {
      return `Saved, but the live switch failed (${(err as Error).message}); it applies on the next run.`;
    }
    addEvent(id, 'system', `Model switched to ${model}`);
    return `#${id} switched to ${model}`;
  }
  return `#${id} will use ${model}`;
}

export function taskCommands(id: number) {
  return runners.get(id)?.commands ?? knownCommands();
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

/** Bring a Claude Code session the developer started themselves under Master's management. It runs in place, in its own folder. */
export async function adoptSession(opts: { sessionId: string; cwd: string; title?: string; next?: string; onDone?: Task['onDone'] }): Promise<Task> {
  const { sessionId, cwd } = opts;
  if (!sessionExists(cwd, sessionId)) throw new Error(`No Claude Code session ${sessionId} in ${cwd}`);
  const existing = repo.listTasks().find((t) => t.sessionId === sessionId && t.status !== 'accepted');
  if (existing) throw new Error(`That session is already task #${existing.id}`);
  const info = (await listSessions(cwd, 50)).find((s) => s.id === sessionId);
  const project = repo.listProjects().find((p) => p.path === cwd) ?? (await addProjectFromPath(cwd));
  const created = repo.createTask({
    title: opts.title?.trim() || info?.firstPrompt.split('\n')[0].slice(0, 70) || 'Claude Code session',
    brief: `Adopted from a Claude Code session the developer started in ${cwd}.${info?.firstPrompt ? `\n\nIt began with: ${info.firstPrompt}` : ''}`,
    projectId: project.id,
    model: settings().workerModel,
    modelReason: 'Adopted session',
    onDone: opts.onDone ?? settings().defaultOnDone,
    createdBy: 'user',
  });
  // In place: the session's folder is its working directory; there's no branch to merge.
  const task = updateTask(created.id, { sessionId, worktree: cwd, branch: null, baseBranch: null, statusLine: 'Adopted from Claude Code', flags: ['adopted'] });
  addEvent(task.id, 'system', `Adopted Claude Code session ${sessionId}`);
  if (opts.next?.trim()) messageTask(task.id, opts.next.trim());
  return repo.getTask(task.id)!;
}

/** Start a plan conversation: a normal Claude agent in plan mode that builds only once you approve its plan. */
export function createPlan(opts: { projectId: number; text: string; model?: string; onDone?: Task['onDone'] }): Task {
  const project = repo.getProject(opts.projectId);
  if (!project) throw new Error('Pick a project to plan in');
  const text = opts.text.trim();
  if (!text) throw new Error('Say what you want to plan');
  const created = repo.createTask({
    title: text.split('\n')[0].replace(/^(let'?s|can we|i want to|help me)\s+/i, '').slice(0, 70),
    brief: text,
    projectId: project.id,
    model: opts.model && opts.model !== 'auto' ? opts.model : MODELS.opus,
    modelReason: 'Planning',
    onDone: opts.onDone ?? settings().defaultOnDone,
    autoStart: true,
    createdBy: 'user',
  });
  const task = updateTask(created.id, { flags: ['plan'] });
  tick();
  return task;
}

const HANDBACK =
  'The developer just worked in this session directly from their terminal. Check the current state (git status, git log, recent changes), then continue the task or, if it is finished, wrap up with your summary.';

/** Pause an agent so the developer can open its session in the Claude Code CLI. */
export async function detachTask(id: number): Promise<{ sessionId: string; cwd: string; title: string }> {
  const task = repo.getTask(id);
  if (!task) throw new Error('No such task');
  if (!task.sessionId) throw new Error(`#${id} hasn't started a session yet. Start it first.`);
  const cwd = task.worktree ?? repo.getProject(task.projectId)?.path;
  if (!cwd || !existsSync(cwd)) throw new Error(`#${id}'s folder is gone (it was merged or dismissed). Start a follow-up instead.`);
  const r = runners.get(id);
  if (r) {
    updateTask(id, { autoStart: false });
    r.stop('paused');
    for (let i = 0; i < 100 && runners.has(id); i++) await new Promise((res) => setTimeout(res, 100));
  }
  pendingPrompts.delete(id);
  const t = repo.getTask(id)!;
  updateTask(id, { autoStart: false, flags: [...t.flags.filter((f) => f !== 'attached'), 'attached'], statusLine: 'Open in your terminal' });
  addEvent(id, 'system', 'Opened in the terminal (Claude Code)');
  return { sessionId: task.sessionId, cwd, title: task.title };
}

/** The developer closed the CLI session; optionally let the agent carry on. */
export function handBack(id: number, carryOn: boolean): string {
  const task = repo.getTask(id);
  if (!task) return 'No such task';
  updateTask(id, {
    flags: task.flags.filter((f) => f !== 'attached' && f !== 'paused'),
    statusLine: carryOn ? 'Back with Master' : task.status === 'done' ? 'Needs your review' : 'Paused',
  });
  addEvent(id, 'system', carryOn ? 'Handed back from the terminal' : 'Closed in the terminal; left paused');
  if (carryOn) return messageTask(id, HANDBACK);
  return task.status === 'done' ? `#${id} is back in Review.` : `#${id} is paused. Start it from the queue when you want it to continue.`;
}

/** Open macOS Terminal running `master attach <id>`. */
export function openInTerminal(id: number): Promise<void> {
  const cli = join(here, '..', '..', '..', 'bin', 'master.mjs');
  const cmd = `node ${shellQuote(cli)} attach ${id}`;
  const script = `tell application "Terminal"\n  activate\n  do script "${cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\nend tell`;
  return new Promise((resolve, reject) =>
    execFile('osascript', ['-e', script], (err) => (err ? reject(new Error(`Couldn't open Terminal: ${err.message}`)) : resolve())),
  );
}

const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

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
