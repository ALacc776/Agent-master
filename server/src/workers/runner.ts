import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { InputChannel } from '../channel.ts';
import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { addEvent, addInbox, addSpend, closeTaskInbox, repo, settings, updateTask } from '../ctx.ts';
import { DATA_DIR } from '../store/db.ts';
import { createGate, denyAllPending, pendingCount } from '../permissions/gate.ts';
import { checkCollision, clearFlag, flagLongSession, flagLoop, LoopDetector } from '../watchdog.ts';
import { commitAll, createWorktree, diffStat, fullDiff } from './worktree.ts';
import { review, summarize } from './summarize.ts';
import { explainError } from '../llm.ts';
import { notify } from '../notify.ts';
import type { Task } from '../../../shared/types.ts';

const workerRules = (task: Task, branch: string | null) => `
You are worker agent #${task.id}, started by "Master", an orchestrator the developer chats with.
${branch ? `You work in an isolated git worktree on branch "${branch}". The current directory IS your copy of the project: any path in the brief that points at the project folder means the same path inside this directory.` : ''}
Rules:
- Do exactly the task in the brief. Stay inside the current working directory.
- Never push, merge, rebase onto other branches, publish or deploy. The developer does that from the dashboard.
- If you truly need a decision from the developer, use the AskUserQuestion tool (it shows up on their dashboard). Prefer sensible defaults for small choices.
- Commit your work on this branch when you finish, with a clear message.
- End with a short summary: what changed (bullets) and one line "Verify: ..." saying how to check it.`;

function shortInput(name: string, input: any): string {
  if (!input) return '';
  if (name === 'Bash') return String(input.command ?? '').slice(0, 300);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return `"${input.pattern}"${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return String(input.url);
  if (input.query) return String(input.query);
  if (input.description) return String(input.description);
  return JSON.stringify(input).slice(0, 200);
}

function statusFor(name: string, input: any, cwd: string): string {
  const file = input?.file_path ? relative(cwd, String(input.file_path)) || String(input.file_path) : '';
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file}`;
    case 'Write':
      return `Writing ${file}`;
    case 'Read':
      return `Reading ${file}`;
    case 'Bash':
      return `Running ${String(input?.command ?? '').split('\n')[0].slice(0, 80)}`;
    case 'Grep':
    case 'Glob':
      return `Searching ${input?.pattern ?? ''}`;
    case 'WebFetch':
    case 'WebSearch':
      return 'Researching the web';
    case 'TodoWrite':
      return 'Planning';
    case 'Task':
    case 'Agent':
      return `Delegating: ${input?.description ?? 'subtask'}`;
    case 'AskUserQuestion':
      return 'Asking you a question';
    default:
      return `Using ${name}`;
  }
}

export type ExitReason = 'done' | 'failed' | 'stopped' | 'paused';

export class WorkerRunner {
  private channel = new InputChannel();
  private abort = new AbortController();
  private q: Query | null = null;
  private lastCost = 0;
  private stopReason: 'stopped' | 'paused' | null = null;
  private loops = new LoopDetector(3);
  private lastText = '';
  private lastMessageId = '';
  private error: string | null = null;
  cwd = '';

  constructor(readonly taskId: number, private onExit: (runner: WorkerRunner, reason: ExitReason, diff?: string) => void) {}

  get task(): Task {
    return repo.getTask(this.taskId)!;
  }

  async start(prompt: string, resume: boolean) {
    let task = this.task;
    const project = repo.getProject(task.projectId);
    try {
      if (project?.isGit) {
        const wt = task.worktree ? { path: task.worktree, branch: task.branch!, base: task.baseBranch! } : await createWorktree(project.path, task.id, task.title, task.baseBranch);
        this.cwd = wt.path;
        task = updateTask(task.id, { worktree: wt.path, branch: wt.branch, baseBranch: wt.base });
      } else if (project) {
        this.cwd = project.path;
      } else {
        this.cwd = join(DATA_DIR, 'scratch', String(task.id));
        mkdirSync(this.cwd, { recursive: true });
        task = updateTask(task.id, { worktree: this.cwd });
      }
    } catch (err) {
      return this.finish('failed', `Could not prepare worktree: ${(err as Error).message}`);
    }

    updateTask(task.id, {
      status: 'running',
      startedAt: task.startedAt ?? Date.now(),
      finishedAt: null,
      statusLine: resume ? 'Resuming…' : 'Starting…',
      flags: task.flags.filter((f) => f === 'long'), // don't re-warn about a long session the developer chose to keep
      lastEventAt: Date.now(),
    });
    closeTaskInbox(task.id, ['stalled', 'loop', 'failed']);
    this.channel.push(prompt);
    addEvent(task.id, 'user', prompt);

    this.q = query({
      prompt: this.channel,
      options: {
        cwd: this.cwd,
        model: task.model,
        permissionMode: 'default',
        canUseTool: createGate(task.id, this.cwd, () => this.syncPendingStatus()),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: workerRules(task, task.branch) },
        settingSources: ['project', 'local'],
        resume: resume && task.sessionId ? task.sessionId : undefined,
        abortController: this.abort,
        env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'master-dashboard/0.1' },
        stderr: (d) => {
          if (/error/i.test(d)) console.warn(`[worker #${task.id}]`, d.trim().slice(0, 300));
        },
      },
    });

    this.consume().catch((err) => this.finish('failed', (err as Error).message));
  }

  private syncPendingStatus() {
    const t = this.task;
    if (!t || !['running', 'needs_input', 'stalled'].includes(t.status)) return;
    const waiting = pendingCount(t.id) > 0;
    if (waiting && t.status !== 'needs_input') updateTask(t.id, { status: 'needs_input', statusLine: 'Waiting for you' });
    else if (!waiting && t.status === 'needs_input') updateTask(t.id, { status: 'running', statusLine: 'Continuing…', lastEventAt: Date.now() });
  }

  private touch(patch: Partial<Task> = {}) {
    const t = this.task;
    const next: Partial<Task> = { lastEventAt: Date.now(), ...patch };
    if (t.status === 'stalled') {
      next.status = 'running';
      clearFlag(t.id, 'stalled');
    }
    updateTask(t.id, next);
  }

  private async consume() {
    for await (const msg of this.q!) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        updateTask(this.taskId, { sessionId: msg.session_id });
        continue;
      }
      if (msg.type === 'assistant') {
        if (msg.parent_tool_use_id) {
          this.touch();
          continue;
        }
        // One API response can arrive as several messages (one per block); count it once.
        if (msg.message.id && msg.message.id !== this.lastMessageId) {
          this.lastMessageId = msg.message.id;
          this.countTurn();
        }
        for (const block of msg.message.content as any[]) {
          if (block.type === 'text' && block.text?.trim() && !msg.error) {
            this.lastText = block.text;
            addEvent(this.taskId, 'assistant', block.text);
            this.touch({ statusLine: 'Thinking…' });
          } else if (block.type === 'tool_use') {
            const line = shortInput(block.name, block.input);
            addEvent(this.taskId, 'tool', `${block.name}: ${line}`);
            const patch: Partial<Task> = { statusLine: statusFor(block.name, block.input, this.cwd) };
            const file = block.input?.file_path;
            if (file && ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(block.name)) {
              const files = this.task.filesTouched;
              if (!files.includes(file)) patch.filesTouched = [...files, file];
            }
            this.touch(patch);
            if (patch.filesTouched) checkCollision(this.taskId);
            if (this.loops.push(`${block.name}:${JSON.stringify(block.input)}`)) flagLoop(this.taskId, `${block.name}: ${line.slice(0, 80)}`);
          }
        }
        continue;
      }
      if (msg.type === 'user' && Array.isArray((msg.message as any).content)) {
        for (const block of (msg.message as any).content) {
          if (block.type === 'tool_result' && block.is_error) {
            const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            addEvent(this.taskId, 'tool_result', `error: ${text.slice(0, 400)}`);
          }
        }
        continue;
      }
      if (msg.type === 'result') {
        const delta = Math.max(0, (msg.total_cost_usd ?? 0) - this.lastCost);
        this.lastCost = msg.total_cost_usd ?? this.lastCost;
        const tokens = Object.values(msg.modelUsage ?? {}).reduce(
          (n, u) => n + u.inputTokens + u.outputTokens + u.cacheReadInputTokens + u.cacheCreationInputTokens,
          0,
        );
        addSpend(this.taskId, delta);
        const t = this.task;
        updateTask(this.taskId, { costUsd: t.costUsd + delta, tokens: Math.max(t.tokens, tokens) });
        if (msg.subtype === 'success') {
          if (msg.result) this.lastText = msg.result;
          addEvent(this.taskId, 'result', `Turn finished (${msg.num_turns} steps, $${(msg.total_cost_usd ?? 0).toFixed(3)})`);
        } else {
          this.error = `Stopped: ${msg.subtype}${(msg as any).errors?.length ? ` — ${(msg as any).errors.join('; ')}` : ''}`;
          addEvent(this.taskId, 'error', this.error);
        }
        if (msg.is_error && !this.error) this.error = msg.subtype === 'success' ? msg.result : 'Agent reported an error';
        if ((msg.queued_turn_count ?? 0) === 0) this.channel.close();
      }
    }
    await this.finish(this.stopReason ?? (this.error ? 'failed' : 'done'), this.error ?? undefined);
  }

  private countTurn() {
    const t = this.task;
    const turns = t.turns + 1;
    updateTask(t.id, { turns });
    if (turns >= settings().turnWarning && settings().turnWarning > 0) flagLongSession(t.id, turns);
  }

  /** Push a follow-up message. Returns false if the run is already wrapping up. */
  send(text: string): boolean {
    if (!this.channel.push(text)) return false;
    addEvent(this.taskId, 'user', text);
    this.touch({ statusLine: 'Reading your message…' });
    return true;
  }

  stop(reason: 'stopped' | 'paused') {
    this.stopReason = reason;
    denyAllPending(this.taskId);
    this.channel.close();
    this.abort.abort();
  }

  private finished = false;
  private async finish(reason: ExitReason, error?: string) {
    if (this.finished) return;
    this.finished = true;
    if (this.stopReason) reason = this.stopReason;
    const task = this.task;

    if (reason === 'stopped' || reason === 'paused') {
      updateTask(task.id, {
        status: reason === 'paused' ? 'queued' : 'stopped',
        autoStart: reason === 'paused' ? task.autoStart : false,
        statusLine: reason === 'paused' ? 'Paused' : 'Stopped',
        flags: reason === 'paused' ? ['paused'] : [],
      });
      addEvent(task.id, 'system', reason === 'paused' ? 'Paused' : 'Stopped by you');
      return this.onExit(this, reason);
    }

    if (reason === 'failed') {
      error = explainError(error ?? 'Failed');
      updateTask(task.id, { status: 'failed', statusLine: 'Failed', finishedAt: Date.now(), flags: [] });
      addEvent(task.id, 'error', error ?? 'Failed');
      addInbox({ taskId: task.id, kind: 'failed', title: `failed: ${error.split('\n')[0].replace(/^Claude Code returned an error result: /, '').slice(0, 140)}`, detail: { message: error.replace(/^Claude Code returned an error result: /, '') } });
      notify(`Agent #${task.id} failed`, task.title);
      return this.onExit(this, 'failed');
    }

    updateTask(task.id, { statusLine: 'Wrapping up…' });
    let stat = '';
    let diff = '';
    if (task.branch && task.worktree && task.baseBranch) {
      try {
        await commitAll(task.worktree, `master: #${task.id} ${task.title}`);
        stat = await diffStat(task.worktree, task.baseBranch);
        diff = await fullDiff(task.worktree, task.baseBranch);
      } catch (err) {
        addEvent(task.id, 'error', `git: ${(err as Error).message}`);
      }
    }
    const summary = await summarize(task, this.lastText, stat);
    // Work that lands without the developer looking at it gets the automatic review first.
    const verdict = task.onDone !== 'review' && settings().reviewerEnabled && diff ? await review(this.task, diff) : null;
    updateTask(task.id, {
      statusLine: task.onDone === 'review' ? 'Done' : task.onDone === 'pr' ? 'Opening a pull request…' : 'Merging…',
      summary,
      diffStat: stat || null,
      reviewVerdict: verdict,
      finishedAt: Date.now(),
      flags: [],
    });
    closeTaskInbox(task.id, ['stalled', 'loop', 'context']);
    // The manager decides where finished work goes (merge, PR or Review).
    this.onExit(this, 'done', diff);
  }
}
