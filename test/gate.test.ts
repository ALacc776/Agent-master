import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolated database for this test run; must be set before the server modules load.
process.env.MASTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'master-test-'));
const { repo } = await import('../server/src/ctx.ts');
const { createGate, answerInbox, pendingCount } = await import('../server/src/permissions/gate.ts');
const { flagLongSession } = await import('../server/src/watchdog.ts');

const cwd = '/repo/.master-worktrees/1-x';
const signal = new AbortController().signal;
const task = repo.createTask({ title: 't', brief: '', projectId: null, model: 'm', createdBy: 'user' });
const gate = createGate(task.id, cwd, () => {});
const tick = () => new Promise((r) => setTimeout(r, 10));

test('safe calls pass straight through', async () => {
  const r = await gate('Bash', { command: 'npm test' }, { signal } as any);
  assert.equal(r.behavior, 'allow');
  assert.equal(repo.openInbox().length, 0);
});

test('git push waits on the developer, only that worker blocks, remembered deny applies next time', async () => {
  const pending = gate('Bash', { command: 'git push origin main' }, { signal } as any);
  await tick();
  const [item] = repo.openInbox();
  assert.equal(item.kind, 'permission');
  assert.equal(item.taskId, task.id);
  assert.equal(pendingCount(task.id), 1);

  answerInbox(item.id, 'deny', true);
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  assert.equal(pendingCount(task.id), 0);

  const again = await gate('Bash', { command: 'git push origin feature' }, { signal } as any);
  assert.equal(again.behavior, 'deny');
  assert.equal(repo.openInbox().length, 0, 'second push is auto-denied without asking');
});

test('a free-text reply denies with the instruction passed to the agent', async () => {
  const pending = gate('Bash', { command: 'docker compose up' }, { signal } as any);
  await tick();
  const [item] = repo.openInbox();
  answerInbox(item.id, 'use npm run dev instead');
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  assert.match((r as any).message, /npm run dev/);
});

test('worker questions become inbox items and remembered answers are reused', async () => {
  const input = { questions: [{ question: 'JWT or sessions?', header: 'Auth', options: [{ label: 'JWT', description: '' }, { label: 'Sessions', description: '' }] }] };
  const pending = gate('AskUserQuestion', input, { signal } as any);
  await tick();
  const [item] = repo.openInbox();
  assert.equal(item.kind, 'question');
  answerInbox(item.id, 'JWT', true);
  const r = await pending;
  assert.deepEqual((r as any).updatedInput.answers, { 'JWT or sessions?': 'JWT' });

  const again = await gate('AskUserQuestion', input, { signal } as any);
  assert.deepEqual((again as any).updatedInput.answers, { 'JWT or sessions?': 'JWT' });
  assert.equal(repo.openInbox().length, 0);
});

test('stopping a worker releases its pending prompt', async () => {
  const ac = new AbortController();
  const pending = gate('Bash', { command: 'terraform apply' }, { signal: ac.signal } as any);
  await tick();
  ac.abort();
  const r = await pending;
  assert.equal(r.behavior, 'deny');
  assert.equal(repo.openInbox().length, 0);
});

test('long sessions raise one context warning per session', () => {
  const t = repo.createTask({ title: 'long', brief: '', projectId: null, model: 'm', createdBy: 'user' });
  flagLongSession(t.id, 100);
  flagLongSession(t.id, 101);
  const items = repo.openInbox().filter((i) => i.taskId === t.id);
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'context');
  assert.ok(repo.getTask(t.id)!.flags.includes('long'));
});
