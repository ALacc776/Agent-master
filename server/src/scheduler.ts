import type { Project, Task } from '../../shared/types.ts';

// Pure scheduling decision: which queued auto-start tasks may launch right now.

export const ACTIVE: Task['status'][] = ['running', 'needs_input', 'stalled'];

export interface ScheduleInput {
  tasks: Task[];
  projects: Project[];
  maxConcurrent: number;
  spentToday: number;
  dailyCapUsd: number;
  paused: boolean;
}

export type BlockReason = 'paused' | 'cap' | 'budget' | 'deps' | 'project_busy' | null;

export function depsSatisfied(task: Task, tasks: Task[]): boolean {
  if (task.dependsOn == null) return true;
  const dep = tasks.find((t) => t.id === task.dependsOn);
  return !dep || dep.status === 'done' || dep.status === 'accepted';
}

export function blockReason(task: Task, s: ScheduleInput, alsoStarting: Task[] = []): BlockReason {
  if (s.paused) return 'paused';
  if (s.dailyCapUsd > 0 && s.spentToday >= s.dailyCapUsd) return 'budget';
  const active = s.tasks.filter((t) => ACTIVE.includes(t.status)).length + alsoStarting.length;
  if (active >= s.maxConcurrent) return 'cap';
  if (!depsSatisfied(task, s.tasks)) return 'deps';
  const project = s.projects.find((p) => p.id === task.projectId);
  if (project && !project.isGit) {
    const busy = [...s.tasks.filter((t) => ACTIVE.includes(t.status)), ...alsoStarting].some(
      (t) => t.id !== task.id && t.projectId === project.id,
    );
    if (busy) return 'project_busy';
  }
  return null;
}

export function pickStartable(s: ScheduleInput): Task[] {
  const picked: Task[] = [];
  const queued = s.tasks.filter((t) => t.status === 'queued' && t.autoStart).sort((a, b) => a.position - b.position);
  for (const t of queued) {
    if (blockReason(t, s, picked) === null) picked.push(t);
  }
  return picked;
}

export const BLOCK_TEXT: Record<Exclude<BlockReason, null>, string> = {
  paused: 'Everything is paused',
  cap: 'At the concurrency limit; it starts when a slot frees up',
  budget: 'Daily spending cap reached',
  deps: 'Waiting for its dependency to finish',
  project_busy: 'Another agent is working in this non-git project; it starts after',
};
