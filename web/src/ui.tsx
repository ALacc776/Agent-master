import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useStore } from './store.ts';
import type { InboxItem, OnDone, Task } from '../../shared/types.ts';

export const ACTIVE = ['running', 'needs_input', 'stalled'];

export function modelLabel(m: string): string {
  if (m.includes('haiku')) return 'Haiku';
  if (m.includes('opus')) return 'Opus';
  if (m.includes('sonnet')) return 'Sonnet';
  return m;
}

export function ago(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d`;
}

export const usd = (v: number) => (v < 0.01 && v > 0 ? '<$0.01' : `$${v.toFixed(2)}`);

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

// Light formatting: fenced code blocks and `inline code`, everything else as wrapped text.
export function Rich({ text, className = '' }: { text: string; className?: string }) {
  const parts = text.split(/```(?:\w+)?\n?([\s\S]*?)```/g);
  return (
    <div className={`whitespace-pre-wrap break-words ${className}`}>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <pre key={i} className="my-1.5 overflow-x-auto rounded-[10px] bg-base p-2.5 font-mono text-[12px] text-ink/90">
            {p.trim()}
          </pre>
        ) : (
          <span key={i}>
            {p.split(/(`[^`\n]+`)/g).map((s, j) =>
              s.startsWith('`') && s.endsWith('`') && s.length > 2 ? (
                <code key={j} className="rounded-[5px] bg-raised/70 px-1 font-mono text-[12.5px]">
                  {s.slice(1, -1)}
                </code>
              ) : (
                s
              ),
            )}
          </span>
        ),
      )}
    </div>
  );
}

export function Modal({ onClose, children, wide = false }: { onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 p-4 pt-[8vh] backdrop-blur-[2px]" onMouseDown={onClose}>
      <div
        className={`max-h-[84vh] w-full overflow-y-auto rounded-sheet bg-panel shadow-sheet ${wide ? 'max-w-5xl' : 'max-w-xl'}`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
      >
        {children}
      </div>
    </div>
  );
}

export interface BoardData {
  needs: InboxItem[];
  running: Task[];
  queue: Task[];
  done: Task[];
  finished: Task[]; // landed on their own recently (merged, PR opened, nothing to change)
  order: string[]; // keyboard navigation order
}

export function useBoard(): BoardData {
  const tasks = useStore((s) => s.tasks);
  const inbox = useStore((s) => s.inbox);
  return useMemo(() => {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const dependents = (id: number | null) => tasks.filter((t) => t.dependsOn === id).length;
    const needs = inbox
      .filter((i) => i.status === 'open')
      .sort((a, b) => dependents(b.taskId) - dependents(a.taskId) || a.createdAt - b.createdAt);
    const running = tasks.filter((t) => ACTIVE.includes(t.status));
    const queue = tasks.filter((t) => t.status === 'queued' || t.status === 'stopped').sort((a, b) => a.position - b.position);
    const done = tasks
      .filter((t) => t.status === 'done' || t.status === 'failed')
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    void byId;
    const finished = tasks
      .filter((t) => t.status === 'accepted' && (t.finishedAt ?? 0) > Date.now() - 864e5)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, 8);
    const order = [
      ...needs.map((i) => `inbox:${i.id}`),
      ...running.map((t) => `task:${t.id}`),
      ...queue.map((t) => `task:${t.id}`),
      ...done.map((t) => `task:${t.id}`),
    ];
    return { needs, running, queue, done, finished, order };
  }, [tasks, inbox]);
}

export function useTask(id: number | null | undefined): Task | undefined {
  const tasks = useStore((s) => s.tasks);
  return useMemo(() => tasks.find((t) => t.id === id), [tasks, id]);
}

export function useProjectName(id: number | null | undefined): string | null {
  const projects = useStore((s) => s.projects);
  return useMemo(() => projects.find((p) => p.id === id)?.name ?? null, [projects, id]);
}

export function parseSuggestion(s: string | null): { answer: string; why: string } | null {
  if (!s) return null;
  const [answer, ...rest] = s.split('\n');
  return { answer: answer.trim(), why: rest.join(' ').trim() };
}

export function TurnsChip({ turns, limit }: { turns: number; limit: number }) {
  if (!turns) return null;
  const over = limit > 0 && turns >= limit;
  const near = limit > 0 && turns >= limit * 0.8;
  return (
    <span
      className={`chip tabular-nums ${over ? 'bg-danger/15 text-danger' : near ? 'text-signal' : ''}`}
      title={over ? 'Long session: start a fresh one to save context' : 'Model turns in this session'}
    >
      {turns} turns
    </span>
  );
}

export const ON_DONE_OPTIONS: { id: OnDone; label: string; title: string }[] = [
  { id: 'merge', label: 'Merge', title: 'Merge into your project automatically when it finishes' },
  { id: 'review', label: 'Review', title: 'Hold it in Review so you can look first' },
  { id: 'pr', label: 'PR', title: 'Open a GitHub pull request when it finishes' },
];

export function WhenDone({ value, onChange, size = 'sm' }: { value: OnDone; onChange: (v: OnDone) => void; size?: 'sm' | 'md' }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[12.5px] text-faint">When done</span>
      <div role="radiogroup" aria-label="When done" className="inline-flex rounded-[8px] bg-raised/70 p-[2px]">
        {ON_DONE_OPTIONS.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            title={o.title}
            onClick={() => onChange(o.id)}
            className={`rounded-[6px] font-medium transition-colors ${size === 'md' ? 'px-3 py-1 text-[13px]' : 'px-2 py-[1px] text-[12px]'} ${
              value === o.id ? 'bg-panel text-ink shadow-card' : 'text-muted hover:text-ink'
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
