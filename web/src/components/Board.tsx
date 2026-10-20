import { useRef, useState, type ReactNode } from 'react';
import { api } from '../api.ts';
import { pushToast, setState } from '../store.ts';
import { useBoard } from '../ui.tsx';
import { NeedsYouCard } from './NeedsYouCard.tsx';
import { RunningCard } from './RunningCard.tsx';
import { QueueCard } from './QueueCard.tsx';
import { DoneCard } from './DoneCard.tsx';

type Col = 'needs' | 'running' | 'queue' | 'done';

const COLS: { id: Col; title: string; dot: string; empty: string }[] = [
  { id: 'needs', title: 'Needs you', dot: 'bg-signal', empty: "Nothing's waiting on you. Agents' questions and permission requests land here." },
  { id: 'running', title: 'Running', dot: 'bg-run', empty: 'No agents running. Tell the master what to build, or start something from the queue.' },
  { id: 'queue', title: 'Queue', dot: 'bg-queue', empty: 'Queue is empty. Say "later, …" to the master or add a task.' },
  { id: 'done', title: 'Review', dot: 'bg-done', empty: 'Finished work shows up here with a summary and diff.' },
];

function Column({ id, title, dot, count, empty, actions, children, active }: { id: Col; title: string; dot: string; count: number; empty: string; actions?: ReactNode; children: ReactNode; active: boolean }) {
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
      </div>
    </section>
  );
}

export function Board({ wide = false }: { wide?: boolean }) {
  const { needs, running, queue, done } = useBoard();
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
        <Column {...COLS[1]} count={running.length} active={tab === 'running'}>
          {running.map((t) => (
            <RunningCard key={t.id} task={t} />
          ))}
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
        <Column {...COLS[3]} count={done.length} active={tab === 'done'}>
          {done.map((t) => (
            <DoneCard key={t.id} task={t} />
          ))}
        </Column>
      </div>
    </div>
  );
}
