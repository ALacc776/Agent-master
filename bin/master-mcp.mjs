#!/usr/bin/env node
// MCP server that gives any Claude Code session Master's controls: start agents, message them,
// answer Needs-you items, merge work. Everything goes through the running Master server, so the
// dashboard shows it all. Used by `master claude` and `master install-mcp`.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.MASTER_URL ?? 'http://127.0.0.1:4545').replace(/\/$/, '');
const TOKEN = process.env.MASTER_TOKEN ?? '';

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-master-token': TOKEN },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Master isn't running at ${BASE}. Ask the developer to run "npm start" in the Master folder.`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const safe = (fn) => async (args) => {
  try {
    return text(await fn(args));
  } catch (err) {
    return { ...text(err.message), isError: true };
  }
};

const MODEL = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', auto: 'auto' };
const modelName = (m) => (m.includes('haiku') ? 'haiku' : m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m);
const taskLine = (t) =>
  `#${t.id} [${t.status === 'done' ? 'review' : t.status}] ${t.title} (${modelName(t.model)}, ${t.turns} turns, $${t.costUsd.toFixed(2)})${t.flags.includes('attached') ? ' [open in a terminal]' : ''} ${t.status === 'accepted' ? t.outcome ?? '' : t.statusLine}`;
const inboxLine = (i) =>
  `inbox#${i.id} agent #${i.taskId ?? '-'} ${i.kind}: ${i.detail?.command ?? i.title}${i.suggestedAnswer ? ` (suggested: ${i.suggestedAnswer.split('\n')[0]})` : ''}${
    i.detail?.questions ? ` options: ${i.detail.questions.flatMap((q) => q.options.map((o) => o.label)).join(' | ')}` : ''
  }`;

function findProject(snap, name) {
  if (!name) return snap.projects.length === 1 ? snap.projects[0].id : null;
  const q = name.toLowerCase();
  const p = snap.projects.find((p) => p.name.toLowerCase() === q || p.path === name) ?? snap.projects.find((p) => p.name.toLowerCase().includes(q));
  if (!p) throw new Error(`No project "${name}". Known: ${snap.projects.map((p) => `${p.name} (${p.path})`).join(', ') || 'none'}. Use add_project first.`);
  return p.id;
}

const server = new McpServer({ name: 'master', version: '1.0.0' });
const id = z.number().int().describe('Task number, e.g. 3 for #3');

server.tool('status', 'Overview of the fleet: what needs the developer, what is running, queued and waiting for review.', {}, safe(async () => {
  const s = await api('GET', '/api/snapshot');
  const open = s.inbox.filter((i) => i.status === 'open');
  const by = (st) => s.tasks.filter((t) => st.includes(t.status));
  const block = (title, items, fmt) => `${title} (${items.length})${items.length ? `\n${items.map(fmt).join('\n')}` : ''}`;
  return [
    `Agents: ${by(['running', 'needs_input', 'stalled']).length}/${s.settings.maxConcurrent}, spent today $${s.spentToday.toFixed(2)}${s.settings.paused ? ', PAUSED' : ''}${s.settings.autoMode ? ', auto mode on' : ''}`,
    `Projects: ${s.projects.map((p) => `${p.name} (${p.path})`).join('; ') || 'none'}`,
    block('Needs the developer', open, inboxLine),
    block('Running', by(['running', 'needs_input', 'stalled']), taskLine),
    block('Queue', by(['queued', 'stopped']), taskLine),
    block('Review', by(['done', 'failed']), taskLine),
  ].join('\n\n');
}));

server.tool(
  'spawn_task',
  'Start a worker agent on a task. It runs in its own git worktree and appears on the Master dashboard. Returns immediately; do not wait for it.',
  {
    title: z.string().describe('Short title'),
    brief: z.string().describe('Everything the worker needs: Goal / Context / Scope (relative paths) / Done when. The worker sees only this.'),
    project: z.string().optional().describe('Project name or path (see status). Omit if there is only one.'),
    model: z.enum(['auto', 'haiku', 'sonnet', 'opus']).optional().describe('haiku for trivial edits, sonnet by default, opus for hard work; auto lets Master pick'),
    when_done: z.enum(['merge', 'review', 'pr', 'keep']).optional().describe('merge it in automatically (default), hold for review, open a PR, or keep the agent open for more instructions'),
    start: z.boolean().optional().describe('false puts it in the queue instead of starting now'),
    depends_on: z.number().int().optional().describe('Task that must finish first'),
  },
  safe(async (a) => {
    const s = await api('GET', '/api/snapshot');
    const r = await api('POST', '/api/tasks', {
      title: a.title,
      brief: a.brief,
      projectId: findProject(s, a.project),
      model: MODEL[a.model ?? 'auto'],
      onDone: a.when_done,
      dependsOn: a.depends_on ?? null,
      start: a.start !== false,
      createdBy: 'master',
    });
    const t = r.task;
    return `${a.start === false ? 'Queued' : r.waiting ? 'Created' : 'Started'} #${t.id} ${t.title} (${modelName(t.model)}${t.modelReason ? `: ${t.modelReason}` : ''})${r.waiting ? `. Waiting: ${r.waiting}` : ''}`;
  }),
);

server.tool('list_tasks', 'List tasks, optionally by status (queued, running, needs_input, done = waiting for review, failed, accepted = finished).', { status: z.string().optional() }, safe(async (a) => {
  const s = await api('GET', '/api/snapshot');
  const tasks = s.tasks.filter((t) => (a.status ? t.status === a.status : t.status !== 'accepted'));
  return tasks.map(taskLine).join('\n') || 'No tasks';
}));

server.tool('get_task', "One task's brief, summary, review notes and recent activity.", { id }, safe(async (a) => {
  const s = await api('GET', '/api/snapshot');
  const t = s.tasks.find((t) => t.id === a.id);
  if (!t) throw new Error('No such task');
  const events = await api('GET', `/api/tasks/${a.id}/events`);
  return [
    taskLine(t),
    `Folder: ${t.worktree ?? '-'}  Branch: ${t.branch ?? '-'}  When done: ${t.onDone}`,
    `Brief:\n${t.brief}`,
    t.summary ? `Summary:\n${t.summary}` : '',
    t.reviewVerdict ? `Review: ${t.reviewVerdict}` : '',
    t.outcome ? `Outcome: ${t.outcome}` : '',
    `Recent activity:\n${events.slice(-15).map((e) => `${e.type}: ${e.text.slice(0, 300)}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}));

server.tool('task_diff', 'The code changes a task has made on its branch.', { id }, safe(async (a) => (await api('GET', `/api/tasks/${a.id}/diff`)).diff || 'No changes'));

server.tool('message_task', "Continue an existing agent with its full context: running, idle, in review, or finished (finished ones reopen on a fresh branch). Prefer this over spawn_task when the request relates to an agent's work. Slash commands like /compact pass through.", { id, text: z.string() }, safe(async (a) => (await api('POST', `/api/tasks/${a.id}/message`, { text: a.text })).result));

for (const [name, path, desc] of [
  ['start_task', 'start', 'Start or resume a queued, stopped or failed task.'],
  ['stop_task', 'stop', 'Stop a task.'],
  ['pause_task', 'pause', 'Pause a running task (it can be resumed).'],
  ['fresh_session', 'fresh', 'Restart a long-running task in a new session with a handoff summary.'],
  ['merge_task', 'merge', 'Merge a task waiting in Review into its base branch.'],
  ['open_pr', 'pr', 'Push a task in Review and open a GitHub pull request.'],
  ['dismiss_task', 'accept', 'Close a task in Review without merging (its branch is kept).'],
]) {
  server.tool(name, desc, { id }, safe(async (a) => {
    const r = await api('POST', `/api/tasks/${a.id}/${path}`);
    return r.result ?? r.waiting ?? r.url ?? `Done (#${a.id})`;
  }));
}

server.tool('list_inbox', 'Items waiting on the developer (permission requests, questions, failures).', {}, safe(async () => {
  const s = await api('GET', '/api/snapshot');
  return s.inbox.filter((i) => i.status === 'open').map(inboxLine).join('\n') || 'Nothing needs the developer';
}));

server.tool(
  'answer_inbox',
  'Answer a waiting item, ONLY with the answer the developer gave you. Permissions: allow / deny / an instruction. Questions: an option label or text. Stuck agents: a nudge, stop, retry, fresh, or dismiss.',
  { inbox_id: z.number().int(), answer: z.string(), remember: z.boolean().optional().describe('Save as a rule so it is not asked again') },
  safe(async (a) => (await api('POST', `/api/inbox/${a.inbox_id}/answer`, { answer: a.answer, remember: !!a.remember })).result),
);

server.tool('add_project', 'Register a folder so agents can work in it.', { path: z.string(), name: z.string().optional() }, safe(async (a) => {
  const p = await api('POST', '/api/projects', { path: a.path, name: a.name });
  return `Added ${p.name} (${p.path})${p.isGit ? '' : ': not a git repo, agents work in place one at a time'}`;
}));

// ---------- app, terminal and fleet controls

const latestRun = (snap, projectId) => snap.procs.filter((p) => p.kind === 'run' && p.projectId === projectId).sort((a, b) => a.startedAt - b.startedAt).at(-1);
const procText = (p, n = 60) => `$ ${p.cmd}\n[${p.status === 'running' ? 'running' : `exited with code ${p.code}`}]\n${p.lines.slice(-n).join('\n').trim()}`;

server.tool(
  'run_app',
  "Start, stop or restart a project's app (its dev command from the Run panel).",
  { action: z.enum(['start', 'stop', 'restart']), project: z.string().optional() },
  safe(async (a) => {
    const s = await api('GET', '/api/snapshot');
    const id = findProject(s, a.project);
    if (id == null) throw new Error('Which project?');
    await api('POST', `/api/projects/${id}/run${a.action === 'start' ? '' : `/${a.action}`}`);
    return `${a.action}ed. Use app_output to check it.`;
  }),
);

server.tool("app_output", "Recent output of a project's app.", { project: z.string().optional() }, safe(async (a) => {
  const s = await api('GET', '/api/snapshot');
  const id = findProject(s, a.project);
  const p = latestRun(s, id);
  return p ? procText(p) : `Not started. Run command: ${s.runCommands[String(id)] || '(none)'}`;
}));

server.tool(
  'terminal',
  "Run a quick shell command in a project's folder (shows in its Terminal tab) and return the output.",
  { command: z.string(), project: z.string().optional() },
  safe(async (a) => {
    const s = await api('GET', '/api/snapshot');
    const id = findProject(s, a.project);
    const proc = await api('POST', `/api/projects/${id}/terminal`, { command: a.command });
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const p = (await api('GET', '/api/snapshot')).procs.find((x) => x.id === proc.id);
      if (p && p.status !== 'running') return procText(p, 120);
    }
    return 'Still running after 20s; check the Terminal tab.';
  }),
);

server.tool('pause_all', 'Pause every agent (true) or resume them (false).', { paused: z.boolean() }, safe(async (a) => {
  await api('POST', '/api/pause', { paused: a.paused });
  return a.paused ? 'Paused.' : 'Resumed.';
}));

server.tool('approve_plan', "Approve a task's proposed plan so it builds (only when the developer says so).", { id }, safe(async (a) => {
  const s = await api('GET', '/api/snapshot');
  const item = s.inbox.find((i) => i.status === 'open' && i.taskId === a.id && i.kind === 'plan');
  if (!item) throw new Error(`#${a.id} has no plan waiting`);
  return (await api('POST', `/api/inbox/${item.id}/answer`, { answer: 'approve' })).result;
}));

server.tool(
  'wait_for_updates',
  'Block until something happens (a task finishes, fails, or needs the developer), then report it. Only use when the developer asks you to wait or watch.',
  { seconds: z.number().int().min(5).max(900).optional().describe('Give up after this many seconds (default 300)') },
  safe(async (a) => {
    const before = await api('GET', '/api/snapshot');
    const seen = new Map(before.tasks.map((t) => [t.id, t.status]));
    const seenInbox = new Set(before.inbox.filter((i) => i.status === 'open').map((i) => i.id));
    const deadline = Date.now() + (a.seconds ?? 300) * 1000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 4000));
      const s = await api('GET', '/api/snapshot');
      const changes = [
        ...s.tasks.filter((t) => seen.get(t.id) !== t.status && ['done', 'failed', 'accepted', 'needs_input'].includes(t.status)).map(taskLine),
        ...s.inbox.filter((i) => i.status === 'open' && !seenInbox.has(i.id)).map(inboxLine),
      ];
      if (changes.length) return changes.join('\n');
    }
    return 'Nothing changed yet.';
  }),
);

await server.connect(new StdioServerTransport());
