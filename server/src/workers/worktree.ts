import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

export async function isGitRepo(path: string): Promise<boolean> {
  try {
    return (await git(path, 'rev-parse', '--is-inside-work-tree')) === 'true';
  } catch {
    return false;
  }
}

export const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'task';

function excludeWorktreeDir(projectPath: string) {
  try {
    const exclude = join(projectPath, '.git', 'info', 'exclude');
    mkdirSync(join(projectPath, '.git', 'info'), { recursive: true });
    const cur = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!cur.includes('.master-worktrees')) appendFileSync(exclude, '\n.master-worktrees/\n');
  } catch {
    /* project may use a .git file (submodule/worktree); ignore */
  }
}

export async function createWorktree(projectPath: string, taskId: number, title: string, fromRef?: string | null) {
  excludeWorktreeDir(projectPath);
  const hasCommit = await git(projectPath, 'rev-parse', '--verify', 'HEAD').then(() => true, () => false);
  if (!hasCommit) await git(projectPath, '-c', 'user.name=Master', '-c', 'user.email=master@localhost', 'commit', '--allow-empty', '-m', 'Initial commit');
  const base = fromRef || (await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD'));
  const branch = `master/${taskId}-${slugify(title)}`;
  const path = join(projectPath, '.master-worktrees', `${taskId}-${slugify(title)}`);
  if (!existsSync(path)) await git(projectPath, 'worktree', 'add', '-b', branch, path, fromRef || 'HEAD');
  return { path, branch, base };
}

export async function commitAll(worktree: string, message: string): Promise<boolean> {
  await git(worktree, 'add', '-A');
  const status = await git(worktree, 'status', '--porcelain');
  if (!status) return false;
  await git(worktree, '-c', 'user.name=Master', '-c', 'user.email=master@localhost', 'commit', '-m', message);
  return true;
}

export async function diffStat(worktree: string, base: string): Promise<string> {
  try {
    return await git(worktree, 'diff', '--stat', `${base}...HEAD`);
  } catch {
    return '';
  }
}

export async function fullDiff(worktree: string, base: string): Promise<string> {
  try {
    return await git(worktree, 'diff', `${base}...HEAD`);
  } catch {
    return '';
  }
}

export async function removeWorktree(projectPath: string, worktree: string, branch?: string | null, deleteBranch = false) {
  try {
    await git(projectPath, 'worktree', 'remove', '--force', worktree);
  } catch {
    /* already gone */
  }
  if (deleteBranch && branch) await git(projectPath, 'branch', '-D', branch).catch(() => {});
}

export async function mergeBranch(projectPath: string, branch: string, base: string, title: string) {
  const current = await git(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (current !== base) throw new Error(`Project is on "${current}", expected "${base}". Switch branches first.`);
  const dirty = await git(projectPath, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) throw new Error('Project has uncommitted changes. Commit or stash them first.');
  await git(projectPath, 'merge', '--no-ff', '-m', `Merge ${branch}: ${title}`, branch);
}

export async function openPullRequest(worktree: string, branch: string, title: string, body: string): Promise<string> {
  await git(worktree, 'push', '-u', 'origin', branch);
  const { stdout } = await exec('gh', ['pr', 'create', '--head', branch, '--title', title, '--body', body], { cwd: worktree });
  return stdout.trim();
}
