import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commitAll, createWorktree, git, mergeBranch, removeWorktree, reopenWorktree } from '../server/src/workers/worktree.ts';

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'master-wt-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir });
  writeFileSync(join(dir, 'a.txt'), 'one\n');
  execFileSync('git', ['add', '.'], { cwd: dir });
  execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir });
  return dir;
}

test('a merged task reopens at the same path on a fresh branch from main', async () => {
  const dir = repo();
  const wt = await createWorktree(dir, 1, 'Edit a');
  writeFileSync(join(wt.path, 'a.txt'), 'two\n');
  await commitAll(wt.path, 'edit');
  await mergeBranch(dir, wt.branch, 'main', 'Edit a');
  await removeWorktree(dir, wt.path, wt.branch, true);
  assert.equal(existsSync(wt.path), false);

  const again = await reopenWorktree(dir, 1, 'Edit a', wt.branch, 'main');
  assert.equal(again.path, wt.path, 'same path, so the Claude session still resolves');
  assert.equal(again.fresh, true);
  assert.equal(readFileSync(join(again.path, 'a.txt'), 'utf8'), 'two\n', 'starts from the merged code');
});

test('a dismissed task reopens on its kept branch', async () => {
  const dir = repo();
  const wt = await createWorktree(dir, 2, 'Try b');
  writeFileSync(join(wt.path, 'b.txt'), 'draft\n');
  await commitAll(wt.path, 'draft');
  await removeWorktree(dir, wt.path); // dismiss: branch kept

  const again = await reopenWorktree(dir, 2, 'Try b', wt.branch, 'main');
  assert.equal(again.fresh, false);
  assert.equal(readFileSync(join(again.path, 'b.txt'), 'utf8'), 'draft\n');
  assert.equal(await git(again.path, 'rev-parse', '--abbrev-ref', 'HEAD'), wt.branch);
});

test('removeWorktree never touches a project folder', async () => {
  const dir = repo();
  await removeWorktree(dir, dir, 'main', true);
  assert.ok(existsSync(join(dir, 'a.txt')));
  assert.equal(await git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
});
