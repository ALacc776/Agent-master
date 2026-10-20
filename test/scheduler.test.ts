import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickStartable, blockReason } from '../server/src/scheduler.ts';
import { LoopDetector } from '../server/src/loop.ts';
import type { Project, Task } from '../shared/types.ts';

let n = 0;
const task = (p: Partial<Task>): Task => ({
  id: ++n, title: 't', brief: '', projectId: 1, model: 'm', status: 'queued', autoStart: true, dependsOn: null,
  position: n, sessionId: null, worktree: null, branch: null, baseBranch: null, costUsd: 0, tokens: 0, statusLine: '',
  filesTouched: [], flags: [], summary: null, diffStat: null, reviewVerdict: null, createdBy: 'user', createdAt: 0,
  startedAt: null, finishedAt: null, lastEventAt: null, ...p,
});
const git: Project[] = [{ id: 1, name: 'a', path: '/a', isGit: true }];
const base = { projects: git, maxConcurrent: 2, spentToday: 0, dailyCapUsd: 10, paused: false };

test('respects the concurrency cap', () => {
  const tasks = [task({ status: 'running' }), task({}), task({})];
  assert.equal(pickStartable({ ...base, tasks }).length, 1);
});

test('only auto-start tasks launch', () => {
  const tasks = [task({ autoStart: false }), task({})];
  assert.deepEqual(pickStartable({ ...base, tasks }).map((t) => t.id), [tasks[1].id]);
});

test('waits for dependencies', () => {
  const dep = task({ status: 'running' });
  const child = task({ dependsOn: dep.id });
  assert.equal(blockReason(child, { ...base, maxConcurrent: 5, tasks: [dep, child] }), 'deps');
  dep.status = 'done';
  assert.equal(blockReason(child, { ...base, maxConcurrent: 5, tasks: [dep, child] }), null);
});

test('budget and pause block everything', () => {
  const tasks = [task({})];
  assert.equal(pickStartable({ ...base, tasks, spentToday: 10 }).length, 0);
  assert.equal(pickStartable({ ...base, tasks, paused: true }).length, 0);
});

test('non-git projects run one task at a time', () => {
  const projects: Project[] = [{ id: 2, name: 'b', path: '/b', isGit: false }];
  const tasks = [task({ projectId: 2 }), task({ projectId: 2 })];
  assert.equal(pickStartable({ ...base, maxConcurrent: 5, projects, tasks }).length, 1);
});

test('loop detector fires on 3 identical calls in a row', () => {
  const d = new LoopDetector(3);
  assert.equal(d.push('a'), false);
  assert.equal(d.push('a'), false);
  assert.equal(d.push('a'), true);
  assert.equal(d.push('b'), false);
});
