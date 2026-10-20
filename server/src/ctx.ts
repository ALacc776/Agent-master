import { openDb } from './store/db.ts';
import { Repo } from './store/repo.ts';
import { bus } from './bus.ts';
import type { InboxItem, Task, TaskEvent } from '../../shared/types.ts';

// Shared state + helpers that both persist and broadcast a change.
export const repo = new Repo(openDb());

type InboxListener = (item: InboxItem) => void;
const inboxListeners: InboxListener[] = [];
export const onNewInbox = (fn: InboxListener) => inboxListeners.push(fn);

type TaskListener = (task: Task, prev: Task | undefined) => void;
const taskListeners: TaskListener[] = [];
export const onTaskChange = (fn: TaskListener) => taskListeners.push(fn);

export function updateTask(id: number, patch: Partial<Task>): Task {
  const prev = repo.getTask(id);
  const task = repo.updateTask(id, patch);
  bus.publish({ type: 'task', data: task });
  for (const fn of taskListeners) fn(task, prev);
  return task;
}

export function publishTask(task: Task) {
  bus.publish({ type: 'task', data: task });
  for (const fn of taskListeners) fn(task, undefined);
}

export function addInbox(i: Parameters<Repo['addInbox']>[0]): InboxItem {
  const item = repo.addInbox(i);
  bus.publish({ type: 'inbox', data: item });
  for (const fn of inboxListeners) fn(item);
  return item;
}

export function updateInbox(id: number, patch: Parameters<Repo['updateInbox']>[1]): InboxItem {
  const item = repo.updateInbox(id, patch);
  bus.publish({ type: 'inbox', data: item });
  return item;
}

// Close a task's open Needs-you items and tell the dashboards.
export function closeTaskInbox(taskId: number, kinds?: InboxItem['kind'][]): InboxItem[] {
  const closed = repo.closeTaskInbox(taskId, kinds);
  for (const i of closed) bus.publish({ type: 'inbox', data: i });
  return closed;
}

export function addEvent(taskId: number, type: TaskEvent['type'], text: string): TaskEvent {
  const ev = repo.addEvent(taskId, type, text);
  bus.publish({ type: 'event', data: ev });
  return ev;
}

export function addSpend(taskId: number | null, usd: number) {
  if (usd <= 0) return;
  repo.addSpend(taskId, usd);
  bus.publish({ type: 'spent', value: repo.spentToday() });
}

export function toast(text: string) {
  bus.publish({ type: 'toast', text });
}

export const settings = () => repo.getSettings();
