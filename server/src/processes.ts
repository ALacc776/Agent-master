import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from './bus.ts';
import { repo } from './ctx.ts';
import type { ProcInfo } from '../../shared/types.ts';

// A project's dev server ("run") plus one-off terminal commands, run in the project folder
// through the user's login shell so PATH (Homebrew, nvm, …) matches their terminal.

interface Proc extends ProcInfo {
  child: ChildProcess | null;
  pending: string;
  flush: NodeJS.Timeout | null;
}

const MAX_LINES = 2000;
const procs = new Map<string, Proc>();
let seq = 0;

const info = (p: Proc): ProcInfo => ({ id: p.id, projectId: p.projectId, kind: p.kind, cmd: p.cmd, status: p.status, code: p.code, startedAt: p.startedAt, lines: p.lines.slice(-300) });
const publish = (p: Proc) => bus.publish({ type: 'proc', data: { ...info(p), lines: [] } });
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\r(?!\n)/g, '\n');

/** Append streamed text to a line buffer whose last entry is the line still being written. */
export function appendText(lines: string[], text: string) {
  const parts = text.split('\n');
  if (!lines.length) lines.push('');
  lines[lines.length - 1] += parts.shift() ?? '';
  lines.push(...parts);
}

function emit(p: Proc, chunk: string) {
  p.pending += stripAnsi(chunk);
  if (p.flush) return;
  // Batch output so a chatty dev server doesn't flood the dashboard.
  p.flush = setTimeout(() => {
    p.flush = null;
    const text = p.pending;
    p.pending = '';
    appendText(p.lines, text);
    if (p.lines.length > MAX_LINES) p.lines.splice(0, p.lines.length - MAX_LINES);
    bus.publish({ type: 'proc_output', id: p.id, projectId: p.projectId, text });
  }, 80);
}

function start(projectId: number, kind: ProcInfo['kind'], cmd: string): Proc {
  const project = repo.getProject(projectId);
  if (!project) throw new Error('No such project');
  if (!cmd.trim()) throw new Error('No command to run');
  const p: Proc = { id: `${kind}-${projectId}-${++seq}`, projectId, kind, cmd, status: 'running', code: null, startedAt: Date.now(), lines: [], child: null, pending: '', flush: null };
  const child = spawn(process.env.SHELL || '/bin/zsh', ['-lc', cmd], {
    cwd: project.path,
    detached: true, // own process group, so Stop also ends whatever the command started
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  p.child = child;
  child.stdout?.on('data', (d) => emit(p, d.toString()));
  child.stderr?.on('data', (d) => emit(p, d.toString()));
  child.on('error', (err) => emit(p, `\n${err.message}\n`));
  child.on('exit', (code, signal) => {
    p.status = 'exited';
    p.code = code ?? (signal ? -1 : 0);
    p.child = null;
    emit(p, signal === 'SIGTERM' || signal === 'SIGKILL' ? '\n[stopped]\n' : `\n[exited with code ${p.code}]\n`);
    publish(p);
  });
  procs.set(p.id, p);
  publish(p);
  return p;
}

function kill(p: Proc): Promise<void> {
  const child = p.child;
  if (!child?.pid) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    try {
      process.kill(-child.pid!, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
    setTimeout(() => {
      try {
        if (p.child) process.kill(-child.pid!, 'SIGKILL');
      } catch {
        /* already gone */
      }
      resolve();
    }, 3000);
  });
}

const runOf = (projectId: number) => [...procs.values()].filter((p) => p.kind === 'run' && p.projectId === projectId).at(-1);

// ---------- run (the project's dev server)

export function detectRunCommand(path: string): string {
  const pkgFile = join(path, 'package.json');
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'));
      const pm = existsSync(join(path, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(path, 'yarn.lock')) ? 'yarn' : existsSync(join(path, 'bun.lockb')) || existsSync(join(path, 'bun.lock')) ? 'bun' : 'npm';
      const script = ['dev', 'start', 'serve', 'web'].find((s) => pkg.scripts?.[s]);
      if (script) return pm === 'npm' ? `npm run ${script}` : `${pm} ${script}`;
      if (pkg.dependencies?.expo) return 'npx expo start';
    } catch {
      /* fall through */
    }
  }
  if (existsSync(join(path, 'manage.py'))) return 'python3 manage.py runserver';
  if (existsSync(join(path, 'Cargo.toml'))) return 'cargo run';
  if (existsSync(join(path, 'go.mod'))) return 'go run .';
  if (existsSync(join(path, 'index.html'))) return 'npx --yes serve .';
  return '';
}

export function runCommand(projectId: number): string {
  const saved = repo.getKv(`runCommand:${projectId}`);
  if (saved !== undefined) return saved;
  const project = repo.getProject(projectId);
  return project ? detectRunCommand(project.path) : '';
}

export function setRunCommand(projectId: number, command: string) {
  repo.setKv(`runCommand:${projectId}`, command.trim());
  bus.publish({ type: 'run_command', projectId, command: command.trim() });
}

export function startRun(projectId: number): ProcInfo {
  const current = runOf(projectId);
  if (current?.status === 'running') return info(current);
  return info(start(projectId, 'run', runCommand(projectId)));
}

export async function stopRun(projectId: number) {
  const p = runOf(projectId);
  if (p) await kill(p);
}

export async function restartRun(projectId: number): Promise<ProcInfo> {
  await stopRun(projectId);
  return startRun(projectId);
}

/** Type into the running process (e.g. "r" to reload Expo). */
export function sendInput(procId: string, text: string) {
  const p = procs.get(procId);
  if (!p?.child?.stdin?.writable) throw new Error('That process is not running');
  p.child.stdin.write(`${text}\n`);
  emit(p, `› ${text}\n`);
}

// ---------- terminal (one-off commands)

export function runTerminal(projectId: number, cmd: string): ProcInfo {
  // Keep a short history per project.
  const mine = [...procs.values()].filter((p) => p.kind === 'term' && p.projectId === projectId);
  for (const old of mine.slice(0, Math.max(0, mine.length - 30))) if (old.status !== 'running') procs.delete(old.id);
  return info(start(projectId, 'term', cmd));
}

export async function stopProc(procId: string) {
  const p = procs.get(procId);
  if (p) await kill(p);
}

export function clearTerminal(projectId: number) {
  for (const p of [...procs.values()]) if (p.kind === 'term' && p.projectId === projectId && p.status !== 'running') procs.delete(p.id);
  bus.publish({ type: 'procs_cleared', projectId });
}

export function listProcs(): ProcInfo[] {
  return [...procs.values()].map(info);
}

export function runCommands(): Record<string, string> {
  return Object.fromEntries(repo.listProjects().map((p) => [String(p.id), runCommand(p.id)]));
}

// Don't leave dev servers running when Master quits.
function killAll() {
  for (const p of procs.values()) {
    if (p.child?.pid) {
      try {
        process.kill(-p.child.pid, 'SIGTERM');
      } catch {
        /* gone */
      }
    }
  }
}
process.on('exit', killAll);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    killAll();
    process.exit(0);
  });
}

// ---------- for the masters' tools

/** Status and the last `n` lines of a process. */
export function procSummary(procId: string, n = 40): string | null {
  const p = procs.get(procId);
  if (!p) return null;
  const out = p.lines.slice(-n).join('\n').trim();
  return `$ ${p.cmd}\n[${p.status === 'running' ? 'running' : `exited with code ${p.code}`}]${out ? `\n${out}` : ''}`;
}

export function runSummary(projectId: number, n = 40): string {
  const p = runOf(projectId);
  if (!p) return `The app hasn't been started. Run command: ${runCommand(projectId) || '(none set)'}`;
  return procSummary(p.id, n)!;
}

export function runProcId(projectId: number): string | undefined {
  return runOf(projectId)?.id;
}

/** Wait up to `ms` for a process to finish (short terminal commands); resolves either way. */
export function waitForProc(procId: string, ms: number): Promise<void> {
  const p = procs.get(procId);
  if (!p?.child) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    p.child!.once('exit', () => {
      clearTimeout(t);
      setTimeout(resolve, 120); // let the last output flush
    });
  });
}
