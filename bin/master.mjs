#!/usr/bin/env node
// Master CLI: everything the dashboard does, from the terminal, plus `attach` to drop into an
// agent's session in Claude Code. Talks to the running Master server.

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MCP_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'master-mcp.mjs');

const BASE = (process.env.MASTER_URL ?? 'http://127.0.0.1:4545').replace(/\/$/, '');
const TOKEN = process.env.MASTER_TOKEN ?? '';

// ---------- output helpers
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = { dim: paint(2), bold: paint(1), orange: paint(33), green: paint(32), red: paint(31), cyan: paint(36), magenta: paint(35) };
const out = (s = '') => process.stdout.write(`${s}\n`);
const die = (msg) => {
  process.stderr.write(`${c.red('✗')} ${msg}\n`);
  process.exit(1);
};

// ---------- API
async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-master-token': TOKEN },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    die(`Can't reach Master at ${BASE}. Start it with: cd <master folder> && npm start`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(data.error ?? `Request failed (${res.status})`);
  return data;
}
const snapshot = () => api('GET', '/api/snapshot');

// ---------- argument parsing: positional args + --flags
function parse(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else if (a === '-f') flags.follow = true;
    else args.push(a);
  }
  return { args, flags };
}

const taskId = (v) => {
  const n = Number(String(v ?? '').replace(/^#/, ''));
  if (!Number.isInteger(n) || n <= 0) die('Give a task number, like: master logs 3');
  return n;
};
const projectId = (snap, name) => {
  if (!name) return null;
  const q = String(name).toLowerCase();
  const p = snap.projects.find((p) => p.name.toLowerCase() === q) ?? snap.projects.find((p) => p.name.toLowerCase().includes(q));
  if (!p) die(`No project "${name}". Projects: ${snap.projects.map((p) => p.name).join(', ') || 'none (add one in the dashboard)'}`);
  return p.id;
};
const MODEL = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5', auto: 'auto' };
const modelName = (m) => (m.includes('haiku') ? 'haiku' : m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m);
const whenDone = (v) => {
  if (v === undefined) return undefined;
  if (!['merge', 'review', 'pr', 'keep'].includes(v)) die('--when must be merge, review, pr or keep');
  return v;
};

// ---------- formatting
const STATUS = {
  running: c.cyan('running'),
  idle: c.magenta('ready for more'),
  needs_input: c.orange('needs you'),
  stalled: c.red('stuck'),
  queued: c.dim('queued'),
  stopped: c.dim('stopped'),
  done: c.green('review'),
  failed: c.red('failed'),
  accepted: c.dim('finished'),
};
function taskLine(t) {
  const bits = [STATUS[t.status] ?? t.status, modelName(t.model), t.turns ? `${t.turns} turns` : '', `$${t.costUsd.toFixed(2)}`].filter(Boolean);
  const extra = t.flags.includes('attached') ? c.magenta(' [in your terminal]') : '';
  const line = t.status === 'accepted' ? t.outcome ?? '' : t.statusLine;
  return `${c.bold(`#${t.id}`)} ${t.title}${extra}\n    ${bits.join(c.dim(' · '))}${line ? c.dim(`  ${line}`) : ''}`;
}
function inboxLine(i) {
  const who = i.taskId != null ? `Agent #${i.taskId}` : 'Master';
  const sug = i.suggestedAnswer ? c.dim(`  (suggested: ${i.suggestedAnswer.split('\n')[0]})`) : '';
  const opts = i.detail?.questions?.flatMap((q) => q.options.map((o) => o.label)) ?? [];
  return `${c.orange(`[${i.id}]`)} ${c.bold(who)} ${i.kind}: ${i.detail?.command ?? i.title}${sug}${opts.length ? `\n    options: ${opts.join(' | ')}` : ''}`;
}

// ---------- commands
const commands = {
  async status() {
    const s = await snapshot();
    const open = s.inbox.filter((i) => i.status === 'open');
    const by = (st) => s.tasks.filter((t) => st.includes(t.status));
    const running = by(['running', 'needs_input', 'stalled']);
    out(`${c.bold('Master')}  ${running.length}/${s.settings.maxConcurrent} agents  $${s.spentToday.toFixed(2)} today${s.settings.paused ? c.orange('  PAUSED') : ''}${s.settings.autoMode ? c.dim('  auto mode') : ''}`);
    const section = (title, items, fmt) => {
      out(`\n${c.bold(title)} ${c.dim(items.length)}`);
      for (const i of items) out(`  ${fmt(i).replace(/\n/g, '\n  ')}`);
    };
    section('Needs you', open, inboxLine);
    section('Running', running, taskLine);
    section('Ready for more', by(['idle']), taskLine);
    section('Queue', by(['queued', 'stopped']), taskLine);
    section('Review', by(['done', 'failed']), taskLine);
  },

  async tasks({ flags }) {
    const s = await snapshot();
    const tasks = flags.all ? s.tasks : s.tasks.filter((t) => t.status !== 'accepted');
    if (!tasks.length) return out(c.dim('No tasks.'));
    for (const t of tasks) out(taskLine(t));
  },

  async inbox() {
    const s = await snapshot();
    const open = s.inbox.filter((i) => i.status === 'open');
    if (!open.length) return out(c.dim('Nothing needs you.'));
    for (const i of open) out(inboxLine(i));
    out(c.dim('\nAnswer with: master answer <id> allow|deny|<option>|<text> [--remember]'));
  },

  async answer({ args, flags }) {
    const [id, ...rest] = args;
    if (!id || !rest.length) die('Usage: master answer <inbox id> <answer> [--remember]');
    const r = await api('POST', `/api/inbox/${Number(id)}/answer`, { answer: rest.join(' '), remember: !!flags.remember });
    out(c.green(`✓ ${r.result}`));
  },

  async say({ args, flags }) {
    const text = args.join(' ').trim();
    if (!text) die('Usage: master say "what you want" [--project name] [--when merge|review|pr|keep]');
    const s = await snapshot();
    // --project talks to that project's own master; otherwise the boss.
    const scope = flags.project ? String(projectId(s, flags.project)) : 'boss';
    await api('POST', '/api/master/message', { text, scope, onDone: whenDone(flags.when), model: flags.model ? MODEL[flags.model] ?? die('--model must be auto, haiku, sonnet or opus') : undefined });
    if (flags['no-wait']) return out(c.dim('Sent.'));
    await waitForReply(s.master.at(-1)?.id ?? 0, scope);
  },

  async new({ args, flags }) {
    const title = args.join(' ').trim();
    if (!title) die('Usage: master new "title" [--brief "…"] [--project name] [--model auto|haiku|sonnet|opus] [--when merge|review|pr|keep] [--start]');
    const s = await snapshot();
    const model = MODEL[flags.model ?? 'auto'] ?? die('--model must be auto, haiku, sonnet or opus');
    const r = await api('POST', '/api/tasks', {
      title,
      brief: flags.brief ?? title,
      projectId: projectId(s, flags.project) ?? (s.projects.length === 1 ? s.projects[0].id : null),
      model,
      onDone: whenDone(flags.when),
      start: !!flags.start,
    });
    out(c.green(`✓ #${r.task.id} ${r.task.title}`) + c.dim(` (${modelName(r.task.model)}${r.task.modelReason ? `: ${r.task.modelReason}` : ''})`));
    if (r.waiting) out(c.dim(`  ${r.waiting}`));
  },

  async start({ args }) {
    const r = await api('POST', `/api/tasks/${taskId(args[0])}/start`);
    out(r.waiting ? c.orange(r.waiting) : c.green('✓ Started'));
  },
  async stop({ args }) {
    await api('POST', `/api/tasks/${taskId(args[0])}/stop`);
    out(c.green('✓ Stopped'));
  },
  async pause({ args }) {
    await api('POST', `/api/tasks/${taskId(args[0])}/pause`);
    out(c.green('✓ Paused'));
  },
  async fresh({ args }) {
    out((await api('POST', `/api/tasks/${taskId(args[0])}/fresh`)).result);
  },
  async msg({ args }) {
    const [id, ...rest] = args;
    if (!rest.length) die('Usage: master msg <task> <text>   (slash commands like /compact are passed through)');
    out((await api('POST', `/api/tasks/${taskId(id)}/message`, { text: rest.join(' ') })).result);
  },
  async merge({ args }) {
    await api('POST', `/api/tasks/${taskId(args[0])}/merge`);
    out(c.green('✓ Merged'));
  },
  async pr({ args }) {
    out(c.green(`✓ ${(await api('POST', `/api/tasks/${taskId(args[0])}/pr`)).url}`));
  },
  async dismiss({ args }) {
    await api('POST', `/api/tasks/${taskId(args[0])}/accept`);
    out(c.green('✓ Dismissed'));
  },
  async diff({ args }) {
    const { diff } = await api('GET', `/api/tasks/${taskId(args[0])}/diff`);
    if (!diff) return out(c.dim('No changes.'));
    for (const l of diff.split('\n')) out(l.startsWith('+') && !l.startsWith('+++') ? c.green(l) : l.startsWith('-') && !l.startsWith('---') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : l);
  },

  async logs({ args, flags }) {
    const id = taskId(args[0]);
    const events = await api('GET', `/api/tasks/${id}/events`);
    for (const e of events.slice(flags.all ? 0 : -60)) printEvent(e);
    if (!flags.follow) return;
    out(c.dim('— following, Ctrl+C to stop —'));
    await listen((m) => m.type === 'event' && m.data.taskId === id && printEvent(m.data));
  },

  async attach({ args, flags }) {
    const id = taskId(args[0]);
    if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).status !== 0) die('The `claude` CLI is not on your PATH.');
    const { sessionId, cwd, title } = await api('POST', `/api/tasks/${id}/detach`);
    out(`${c.bold(`#${id} ${title}`)} ${c.dim('is paused and yours.')}`);
    out(c.dim(`Folder: ${cwd}\nOpening its session in Claude Code. Quit (/exit or Ctrl+D) to come back here.\n`));
    const extra = typeof flags.model === 'string' ? ['--model', MODEL[flags.model] ?? flags.model] : [];
    const child = spawn('claude', ['--resume', sessionId, ...extra], { cwd, stdio: 'inherit' });
    await new Promise((resolve) => child.on('exit', resolve));
    const carryOn = flags.keep ? false : flags.handback ? true : await confirm(`\nHand #${id} back to Master so it carries on?`, true);
    out((await api('POST', `/api/tasks/${id}/handback`, { carryOn })).result);
  },

  async adopt({ args, flags }) {
    const cwd = typeof flags.dir === 'string' ? flags.dir : process.cwd();
    const sessions = await api('GET', `/api/sessions?cwd=${encodeURIComponent(cwd)}`);
    if (!sessions.length) die(`No Claude Code sessions found for ${cwd}. Run this in the folder where you used claude, or pass --dir.`);
    let pick = args[0] ? sessions.find((s) => s.id.startsWith(args[0])) : null;
    if (args[0] && !pick) die(`No session starting with "${args[0]}" in ${cwd}. Run: master adopt --list`);
    if (!pick) {
      const shown = sessions.slice(0, flags.list ? 10 : 5);
      out(c.bold(`Claude Code sessions in ${cwd}`));
      shown.forEach((s, i) => out(`  ${c.bold(String(i + 1))}. ${s.firstPrompt.split('\n')[0].slice(0, 70) || c.dim('(no prompt)')}\n     ${c.dim(`${s.id.slice(0, 8)} · ${ago(s.updatedAt)} ago`)}`));
      const n = await ask(`Which one? ${c.dim('[1]')} `);
      pick = shown[(Number(n) || 1) - 1] ?? die('No such session');
    }
    if (Date.now() - pick.updatedAt < 60_000) out(c.orange('This session changed in the last minute. Make sure it is not still open in claude.'));
    const next = typeof flags.next === 'string' ? flags.next : await ask(`What should it do next? ${c.dim('(blank = just track it)')} `);
    const task = await api('POST', '/api/tasks/adopt', { sessionId: pick.id, cwd, title: typeof flags.title === 'string' ? flags.title : undefined, next, onDone: whenDone(flags.when) });
    out(c.green(`✓ Now task #${task.id}: ${task.title}`) + c.dim(next ? '  (running)' : '  (in the queue; master msg/start to continue)'));
  },

  // Launch Claude Code with Master's tools, acting as the master. Extra args go straight to claude.
  async claude() {
    const passthrough = process.argv.slice(3);
    if (spawnSync('claude', ['--version'], { stdio: 'ignore' }).status !== 0) die('The `claude` CLI is not on your PATH.');
    await api('GET', '/api/settings'); // fail early if the server isn't running
    const config = JSON.stringify({ mcpServers: { master: { command: process.execPath, args: [MCP_SCRIPT], env: { MASTER_URL: BASE, MASTER_TOKEN: TOKEN } } } });
    out(c.dim(`Claude Code as the master (dashboard: ${BASE}). Your normal commands, skills and settings all work.\n`));
    const child = spawn('claude', ['--mcp-config', config, '--allowedTools', 'mcp__master', '--append-system-prompt', CLI_MASTER_PROMPT, ...passthrough], { stdio: 'inherit' });
    await new Promise((resolve) => child.on('exit', resolve));
  },

  // Make Master's tools available in every Claude Code session.
  async 'install-mcp'() {
    const args = ['mcp', 'add', '--scope', 'user', 'master', '-e', `MASTER_URL=${BASE}`, ...(TOKEN ? ['-e', `MASTER_TOKEN=${TOKEN}`] : []), '--', process.execPath, MCP_SCRIPT];
    const r = spawnSync('claude', args, { stdio: 'inherit' });
    if (r.status !== 0) die('claude mcp add failed (if "master" already exists, remove it first: claude mcp remove master -s user)');
    out(c.green('✓ Every Claude Code session now has Master tools (spawn_task, status, list_inbox, …). Remove with: claude mcp remove master -s user'));
  },

  async 'pause-all'() {
    await api('POST', '/api/pause', { paused: true });
    out(c.green('✓ Everything paused'));
  },
  async 'resume-all'() {
    await api('POST', '/api/pause', { paused: false });
    out(c.green('✓ Resumed'));
  },

  async chat({ flags = {} } = {}) {
    const s = await snapshot();
    let scope = flags.project ? String(projectId(s, flags.project)) : 'boss';
    const scopeName = (snap) => (scope === 'boss' ? 'Boss' : `${snap.projects.find((p) => String(p.id) === scope)?.name ?? 'project'} master`);
    out(`${c.bold(scopeName(s))} ${c.dim(`at ${BASE}. Type to talk; :help for commands; Ctrl+D to leave.`)}`);
    for (const m of s.master.filter((m) => m.scope === scope).slice(-6)) printMaster(m);
    let when;
    const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: c.bold('› ') });
    const stopListening = listen((m) => {
      if (m.type === 'master_message' && m.data.role !== 'user' && m.data.scope === scope) {
        clearLine();
        printMaster(m.data);
        rl.prompt(true);
      } else if (m.type === 'inbox' && m.data.status === 'open') {
        clearLine();
        out(c.orange(`! ${m.data.taskId != null ? `Agent #${m.data.taskId}` : 'Master'} needs you: ${m.data.title}`) + c.dim(`  (:answer ${m.data.id} …)`));
        rl.prompt(true);
      }
    });
    rl.prompt();
    rl.on('line', async (line) => {
      const text = line.trim();
      if (!text) return rl.prompt();
      if (text.startsWith(':')) {
        const [cmd, ...rest] = text.slice(1).split(/\s+/);
        if (cmd === 'q' || cmd === 'quit') return rl.close();
        if (cmd === 'help') out(CHAT_HELP);
        else if (cmd === 'project' || cmd === 'boss') {
          const snap = await snapshot();
          scope = cmd === 'project' && rest.length ? String(projectId(snap, rest.join(' '))) : 'boss';
          out(c.dim(`Now talking to the ${scopeName(snap)}`));
          for (const m of snap.master.filter((m) => m.scope === scope).slice(-4)) printMaster(m);
        } else if (cmd === 'when') {
          when = whenDone(rest[0]);
          out(c.dim(`When done: ${when}`));
        } else if (cmd === 'attach') {
          rl.pause();
          stopListening();
          await commands.attach(parse(rest));
          return commands.chat();
        } else if (commands[cmd]) await commands[cmd](parse(rest));
        else out(c.red(`Unknown command :${cmd}. Try :help`));
        return rl.prompt();
      }
      await api('POST', '/api/master/message', { text, scope, onDone: when });
      rl.prompt();
    });
    await new Promise((resolve) => rl.on('close', resolve));
    stopListening();
    out();
    process.exit(0);
  },

  help() {
    out(HELP);
  },
};

const HELP = `${c.bold('master')}: drive Master from the terminal  ${c.dim(`(server: ${BASE})`)}

  master [--project <name>]    chat with the boss, or with that project's own master
  master say "…"               send one message and print the reply
        --project <name>       to that project's master   --when merge|review|pr|keep
  master status                Needs you, Running, Queue, Review at a glance
  master tasks [--all]         list tasks
  master inbox                 what needs you
  master answer <id> <answer>  allow | deny | an option | free text  [--remember]
  master new "title"           add a task  [--brief "…"] [--project p] [--model auto|haiku|sonnet|opus]
                               [--when merge|review|pr|keep] [--start]
  master start|stop|pause <n>  control agent #n
  master msg <n> <text>        message agent #n (slash commands like /compact pass through)
  master fresh <n>             restart #n in a fresh session with a handoff summary
  master logs <n> [-f]         agent #n's activity, -f to follow
  master diff <n>              changes made by #n
  master merge|pr|dismiss <n>  finish a task in Review
  master attach <n>            pause #n and open its session in Claude Code (full CLI, your commands)
                               [--handback | --keep] [--model haiku|sonnet|opus]
  master claude [claude args]  open Claude Code AS the master: full CLI, plus tools to run the fleet
  master install-mcp           add Master's tools to every Claude Code session (claude mcp add)
  master adopt [session]       hand a Claude Code session you started to Master (run it in that folder)
                               [--list] [--next "what to do"] [--title "…"] [--when merge|review|pr|keep]
  master pause-all | resume-all

Env: MASTER_URL (default http://127.0.0.1:4545), MASTER_TOKEN for remote access.`;

const CLI_MASTER_PROMPT = `You are also acting as "Master", the developer's orchestrator for a fleet of Claude coding agents. The master tools (mcp__master__*) control that fleet; everything you do with them shows up on the developer's Master dashboard.

- Delegate real coding work: split requests into independent tasks and call spawn_task for each, with a complete brief (Goal / Context / Scope with relative paths / Done when). Each worker runs in its own git worktree.
- Pick the model per task: haiku for trivial edits, sonnet by default, opus for hard work. when_done defaults to merge; use review or pr if the developer asks to look first or wants a PR.
- Don't block. After starting tasks, reply briefly. Only call wait_for_updates if the developer asks you to wait or watch.
- Use status to see what's going on, list_inbox for what needs the developer, and answer_inbox only with answers the developer gives you.
- If the developer clearly wants you to do something yourself right here, do it directly instead of spawning.`;

const CHAT_HELP = `${c.dim(`:status  :inbox  :tasks  :answer <id> <answer>  :attach <n>  :logs <n>
:project <name>   talk to that project's master   :boss  back to the boss
:when merge|review|pr   what happens when tasks finish
:quit`)}`;

// ---------- live updates
function listen(onMessage) {
  const url = `${BASE.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(TOKEN)}`;
  let ws;
  let closed = false;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onmessage = (e) => {
      try {
        onMessage(JSON.parse(e.data));
      } catch {
        /* ignore bad frames */
      }
    };
    ws.onclose = () => !closed && setTimeout(connect, 1500);
  };
  connect();
  return () => {
    closed = true;
    ws?.close();
  };
}

// Print the master's replies until it has gone quiet and the server says it's idle.
function waitForReply(afterId, scope = 'boss') {
  return new Promise((resolve) => {
    let replied = false;
    let timer;
    const check = async () => {
      const s = await snapshot();
      if (replied && !s.masters?.[scope]?.busy) return done();
      timer = setTimeout(check, 1000);
    };
    const stop = listen((m) => {
      if (m.type === 'master_message' && m.data.id > afterId && m.data.role !== 'user' && m.data.scope === scope) {
        printMaster(m.data);
        replied = true;
        clearTimeout(timer);
        timer = setTimeout(check, 1200);
      }
    });
    const done = () => {
      clearTimeout(timer);
      clearTimeout(giveUp);
      stop();
      resolve();
    };
    const giveUp = setTimeout(done, 180_000);
    timer = setTimeout(check, 3000);
  });
}

function printMaster(m) {
  if (m.role === 'user') out(c.bold(`› ${m.text}`));
  else if (m.role === 'system') out(c.dim(`  ${m.text}`));
  else out(`${c.magenta('Master')} ${m.text}`);
}

function printEvent(e) {
  const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const color = { tool: c.dim, tool_result: c.red, error: c.red, permission: c.orange, result: c.green, user: c.bold, system: c.dim }[e.type] ?? ((s) => s);
  out(`${c.dim(time)} ${color(e.text)}`);
}

function clearLine() {
  if (tty) process.stdout.write('\r\x1b[K');
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve('');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    }),
  );
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60_000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
}

function confirm(question, def) {
  if (!process.stdin.isTTY) return Promise.resolve(def);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(`${question} ${c.dim(def ? '[Y/n]' : '[y/N]')} `, (a) => {
      rl.close();
      resolve(a.trim() ? /^y/i.test(a.trim()) : def);
    }),
  );
}

// ---------- main
const argv = process.argv.slice(2);
// `master --project x` (flags only) opens the chat.
const [cmd = 'chat', ...rest] = argv[0]?.startsWith('--') && argv[0] !== '--help' ? ['chat', ...argv] : argv;
const handler = commands[cmd] ?? (cmd === '--help' || cmd === '-h' ? commands.help : null);
if (!handler) die(`Unknown command "${cmd}". Run: master help`);
await handler(parse(rest));
