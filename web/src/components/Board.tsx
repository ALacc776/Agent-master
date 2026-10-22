import { useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { pushToast, setState, toggleCompact, useStore } from '../store.ts';
import type { Task } from '../../../shared/types.ts';
import { modelLabel, useBoard, usd } from '../ui.tsx';
import { NeedsYouCard } from './NeedsYouCard.tsx';
import { RunningCard } from './RunningCard.tsx';
import { QueueCard } from './QueueCard.tsx';
import { DoneCard } from './DoneCard.tsx';

type Col = 'needs' | 'running' | 'queue' | 'done';

const COLS: { id: Col; title: string; dot: string; empty: string }[] = [
  { id: 'needs', title: 'Needs you', dot: 'bg-signal', empty: "Nothing needs you. In auto mode, only pushes, deploys, deletions, real decisions and failures show up here." },
  { id: 'running', title: 'Running', dot: 'bg-run', empty: 'No agents running. Tell the master what to build, or start something from the queue.' },
  { id: 'queue', title: 'Queue', dot: 'bg-queue', empty: 'Queue is empty. Say "later, …" to the master or add a task.' },
  { id: 'done', title: 'Review', dot: 'bg-done', empty: 'Nothing to review. Finished work merges by itself; only tasks set to Review, flagged by the automatic review, or unable to merge land here.' },
];

function Column({ id, title, dot, count, empty, actions, children, active, footer }: { id: Col; title: string; dot: string; count: number; empty: string; actions?: ReactNode; children: ReactNode; active: boolean; footer?: ReactNode }) {
  return (
    <section className={`min-h-0 min-w-0 flex-col ${active ? 'flex' : 'hidden'} lg:flex`} aria-labelledby={`col-${id}`}>
      <header className="flex h-9 shrink-0 items-center gap-2 px-1">
        <span className={`h-2 w-2 rounded-full ${dot}`} />
        <h2 id={`col-${id}`} className="text-[13px] font-semibold">
          {title}
        </h2>
        <span className="text-[13px] tabular-nums text-faint">{count}</span>
        <div className="ml-auto flex gap-1">{actions}</div>
      </header>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-1 pb-4 pt-0.5">
        {count === 0 ? <p className="px-1 pt-1 text-[12.5px] leading-relaxed text-faint">{empty}</p> : children}
        {footer}
      </div>
    </section>
  );
}

export function Board({ wide = false }: { wide?: boolean }) {
  const { needs, running, queue, done, finished, idle } = useBoard();
  const compact = useStore((s) => s.compact);
  const wrap = (col: string, t: Task, card: ReactNode) => (compact[col] ? <Row key={t.id} task={t}>{card}</Row> : card);
  const [tab, setTab] = useState<Col>('needs');
  const dragId = useRef<number | null>(null);
  const counts = { needs: needs.length, running: running.length, queue: queue.length, done: done.length };

  const onDrop = (targetId: number) => {
    const from = dragId.current;
    dragId.current = null;
    if (from == null || from === targetId) return;
    const idx = queue.findIndex((t) => t.id === targetId);
    const prev = queue[idx - 1];
    const target = queue[idx];
    const fromIdx = queue.findIndex((t) => t.id === from);
    // Dropping onto a card puts the dragged card before it (or after it, if dragging downward).
    const position =
      fromIdx < idx
        ? (target.position + (queue[idx + 1]?.position ?? target.position + 2)) / 2
        : ((prev?.position ?? target.position - 2) + target.position) / 2;
    void api.updateTask(from, { position });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <nav className="flex shrink-0 gap-1 overflow-x-auto px-3 py-2 lg:hidden">
        {COLS.map((c) => (
          <button key={c.id} onClick={() => setTab(c.id)} className={`btn ${tab === c.id ? 'bg-panel text-ink shadow-card' : 'text-muted'}`}>
            <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
            {c.title} <span className="tabular-nums text-faint">{counts[c.id]}</span>
          </button>
        ))}
      </nav>
      <div
        className={`grid min-h-0 flex-1 grid-rows-[minmax(0,1fr)] gap-x-5 gap-y-2 px-5 pt-3 lg:grid-cols-2 lg:grid-rows-[fit-content(50%)_minmax(0,1fr)] ${
          wide ? 'xl:grid-cols-4 xl:grid-rows-[minmax(0,1fr)]' : '2xl:grid-cols-4 2xl:grid-rows-[minmax(0,1fr)]'
        }`}
      >
        <Column {...COLS[0]} count={needs.length} active={tab === 'needs'}>
          {needs.map((i) => (
            <NeedsYouCard key={i.id} item={i} />
          ))}
        </Column>
        <Column
          {...COLS[1]}
          count={running.length + idle.length}
          active={tab === 'running'}
          actions={running.length + idle.length > 0 && <CompactToggle column="running" />}
          footer={
            idle.length > 0 && (
              <div className="space-y-2.5 pt-3">
                <h3 className="flex items-center px-1 text-[12.5px] font-semibold text-muted">
                  <span>
                    Ready for more <span className="font-normal text-faint">{idle.length}</span>
                  </span>
                  <MergeAll tasks={idle} />
                </h3>
                {idle.map((t) => wrap('running', t, <DoneCard key={t.id} task={t} />))}
              </div>
            )
          }
        >
          {running.length === 0 && idle.length > 0 && <p className="px-1 pt-1 text-[12.5px] text-faint">Nothing running right now.</p>}
          {running.map((t) => wrap('running', t, <RunningCard key={t.id} task={t} />))}
        </Column>
        <Column
          {...COLS[2]}
          count={queue.length}
          active={tab === 'queue'}
          actions={
            <>
              {queue.some((t) => !t.autoStart) && (
                <button
                  className="btn-ghost"
                  onClick={async () => {
                    const { started } = await api.startAll();
                    pushToast(`Starting ${started} task${started === 1 ? '' : 's'}`);
                  }}
                >
                  Start all
                </button>
              )}
              <button className="btn-ghost" onClick={() => setState({ modal: 'new' })} title="New task">
                + Add
              </button>
            </>
          }
        >
          {queue.map((t) => (
            <div key={t.id} onDragOver={(e) => e.preventDefault()} onDrop={() => onDrop(t.id)}>
              <QueueCard task={t} onDragStart={(id) => (dragId.current = id)} />
            </div>
          ))}
        </Column>
        <Column {...COLS[3]} count={done.length} active={tab === 'done'} actions={
            <>
              <MergeAll tasks={done} />
              {done.length > 0 && <CompactToggle column="done" />}
            </>
          } footer={finished.length > 0 && <RecentlyFinished tasks={finished} />}>
          {done.map((t) => wrap('done', t, <DoneCard key={t.id} task={t} />))}
        </Column>
      </div>
    </div>
  );
}

function RecentlyFinished({ tasks }: { tasks: Task[] }) {
  return (
    <div className="pt-3">
      <h3 className="px-1 pb-1.5 text-[12.5px] font-semibold text-muted">Recently finished</h3>
      <ul className="card divide-y divide-line/60">
        {tasks.map((t) => {
          const pr = t.outcome?.match(/https?:\/\/\S+/)?.[0];
          return (
            <li key={t.id} className="flex items-center gap-2 px-3 py-2 text-[12.5px]">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-done" />
              <button className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setState({ drawer: t.id })} title={t.summary ?? undefined}>
                <span className="tabular-nums text-faint">#{t.id}</span> {t.title}
              </button>
              {pr ? (
                <a className="shrink-0 font-medium text-run hover:underline" href={pr} target="_blank" rel="noreferrer">
                  PR
                </a>
              ) : (
                <span className="shrink-0 text-faint">{(t.outcome ?? 'Done').replace(/^Merged into /, 'Merged · ')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// Merge every mergeable task in a list, one at a time. Failures stay put (with their reason) and don't stop the rest.
function MergeAll({ tasks }: { tasks: Task[] }) {
  const [busy, setBusy] = useState(false);
  const mergeable = tasks.filter((t) => t.branch && t.status !== 'failed');
  if (mergeable.length < 2) return null;
  const flagged = mergeable.filter((t) => t.reviewVerdict?.startsWith('⚠️'));

  const run = async () => {
    const warn = flagged.length ? `\n\n${flagged.length} of them had review concerns: ${flagged.map((t) => `#${t.id}`).join(', ')}.` : '';
    if (!confirm(`Merge ${mergeable.length} tasks into their base branches?${warn}`)) return;
    setBusy(true);
    let ok = 0;
    const failed: number[] = [];
    for (const t of mergeable) {
      try {
        await api.merge(t.id);
        ok++;
      } catch {
        failed.push(t.id);
      }
    }
    setBusy(false);
    pushToast(`Merged ${ok} of ${mergeable.length}${failed.length ? `. Couldn't merge ${failed.map((id) => `#${id}`).join(', ')}; they're still here` : ''}`);
  };

  return (
    <button className="btn-ghost ml-auto px-2 py-0.5 text-[12px]" onClick={run} disabled={busy} title="Merge each of these into its base branch">
      {busy ? 'Merging…' : `Merge all ${mergeable.length}`}
    </button>
  );
}

function CompactToggle({ column }: { column: string }) {
  const on = useStore((s) => !!s.compact[column]);
  return (
    <button className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => toggleCompact(column)} aria-pressed={on} title={on ? 'Show full cards' : 'Show one line per task'}>
      {on ? 'Expand' : 'Compact'}
    </button>
  );
}

// One-line row for compact columns; click to open the full card in place.
function Row({ task, children }: { task: Task; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <div className="space-y-1">
        {children}
        <button className="px-1 text-[12px] text-faint hover:text-ink" onClick={() => setOpen(false)}>
          Collapse
        </button>
      </div>
    );
  const waiting = task.status === 'needs_input';
  const dot = waiting ? 'bg-signal' : task.status === 'stalled' || task.status === 'failed' ? 'bg-danger' : task.status === 'idle' ? 'bg-queue' : task.status === 'done' ? 'bg-done' : 'animate-pulse bg-run';
  const line = waiting ? 'Waiting for you' : task.status === 'idle' ? 'Ready for more' : task.status === 'done' ? task.outcome ?? 'Needs your review' : task.statusLine;
  return (
    <button data-key={`task:${task.id}`} onClick={() => setOpen(true)} title={`${line}${'\n'}${modelLabel(task.model)}, ${usd(task.costUsd)}`} className="card flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-raised/40">
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      <span className="text-[12.5px] font-semibold tabular-nums text-faint">#{task.id}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{task.title}</span>
      {waiting && <span className="shrink-0 text-[12px] font-medium text-signal">Waiting for you</span>}
      <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{usd(task.costUsd)}</span>
    </button>
  );
}
