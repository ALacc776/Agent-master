import { useEffect, useMemo, useRef, useState } from 'react';
import { api, loadEvents } from '../api.ts';
import { pushToast, setPlan, setState, setView, useStore } from '../store.ts';
import { ago, MaximizeButton, ModelSelect, TurnsChip, usd, useNow, useProjectName, useScopedTasks } from '../ui.tsx';
import type { InboxItem, Task, TaskEvent } from '../../../shared/types.ts';

// A wall of live agents: each tile streams what its agent is doing and takes messages directly.

const ACTIVE = ['running', 'needs_input', 'stalled'];

function FeedLine({ e }: { e: TaskEvent }) {
  switch (e.type) {
    case 'tool': {
      const [tool, ...rest] = e.text.split(': ');
      const arg = rest.join(': ');
      if (tool === 'Bash') return <div className="truncate text-ink/80"><span className="text-done">$</span> {arg}</div>;
      if (['Edit', 'Write', 'MultiEdit'].includes(tool)) return <div className="truncate text-signal/90">✎ {arg.split('/').slice(-3).join('/')}</div>;
      if (tool === 'Read') return <div className="truncate text-faint">read {arg.split('/').slice(-3).join('/')}</div>;
      return <div className="truncate text-faint">{tool.toLowerCase()} {arg}</div>;
    }
    case 'assistant':
      return <div className="line-clamp-3 whitespace-pre-wrap font-sans text-[12.5px] text-ink">{e.text}</div>;
    case 'user':
      return <div className="truncate text-run">› {e.text.split('\n')[0]}</div>;
    case 'permission':
      return <div className="truncate text-signal">! {e.text}</div>;
    case 'error':
    case 'tool_result':
      return <div className="truncate text-danger">✗ {e.text}</div>;
    case 'result':
      return <div className="truncate text-done/80">✓ {e.text}</div>;
    default:
      return <div className="truncate text-faint">{e.text}</div>;
  }
}

function WaitingBanner({ item }: { item: InboxItem }) {
  const answer = (a: string) => api.answer(item.id, a);
  const options = item.detail.questions?.flatMap((q) => q.options) ?? [];
  return (
    <div className="mx-3 mb-2 rounded-[10px] bg-signal/10 px-3 py-2 text-[12.5px]">
      <p className="line-clamp-2 font-medium text-signal">{item.kind === 'permission' ? `Wants to ${item.title}` : item.kind === 'plan' ? 'Has a plan ready for you' : item.title}</p>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {item.kind === 'permission' && (
          <>
            <button className="btn-done px-2.5 py-0.5 text-[12px]" onClick={() => answer('allow')}>
              Allow
            </button>
            <button className="btn-line px-2.5 py-0.5 text-[12px]" onClick={() => answer('deny')}>
              Deny
            </button>
          </>
        )}
        {options.slice(0, 4).map((o) => (
          <button key={o.label} className="btn-line px-2.5 py-0.5 text-[12px]" onClick={() => answer(o.label)} title={o.description}>
            {o.label}
          </button>
        ))}
        {item.kind === 'plan' && (
          <>
            <button className="btn-done px-2.5 py-0.5 text-[12px]" onClick={() => answer('approve')}>
              Approve &amp; build
            </button>
            <button className="btn-line px-2.5 py-0.5 text-[12px]" onClick={() => setPlan({ planOpen: true, planTaskId: item.taskId })}>
              Open plan
            </button>
          </>
        )}
        {item.kind !== 'permission' && item.kind !== 'plan' && !options.length && (
          <button className="btn-line px-2.5 py-0.5 text-[12px]" onClick={() => setView('board')}>
            Open in Needs you
          </button>
        )}
      </div>
    </div>
  );
}

export function AgentTile({ task, big = false }: { task: Task; big?: boolean }) {
  const events = useStore((s) => s.events[task.id]);
  const inbox = useStore((s) => s.inbox);
  const limit = useStore((s) => s.settings.turnWarning);
  const project = useProjectName(task.projectId);
  const now = useNow(1000);
  const [text, setText] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const waiting = useMemo(() => inbox.find((i) => i.taskId === task.id && i.status === 'open'), [inbox, task.id]);
  const idle = task.status === 'idle';

  useEffect(() => {
    if (!events) void loadEvents(task.id);
  }, [task.id, events]);
  useEffect(() => {
    feed.current?.scrollTo({ top: feed.current.scrollHeight });
  }, [events?.length]);

  const shown = (events ?? []).filter((e) => e.type !== 'system' || /model|fresh|terminal/i.test(e.text)).slice(-40);
  const dot = waiting ? 'bg-signal' : task.status === 'stalled' ? 'bg-danger' : idle ? 'bg-queue' : 'animate-pulse bg-done';

  return (
    <article className={`flex flex-col overflow-hidden ${big ? 'h-full' : `card h-[340px] ${waiting ? 'ring-1 ring-signal/50' : ''}`}`}>
      <header className="flex items-center gap-2 px-3.5 pb-2 pt-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} />
        <span className="text-[13px] font-semibold tabular-nums text-faint">#{task.id}</span>
        <button className="min-w-0 flex-1 truncate text-left text-[13.5px] font-semibold hover:underline" onClick={() => setState({ drawer: task.id })} title="Open transcript">
          {task.title}
        </button>
        <span className="shrink-0 text-[11px] tabular-nums text-faint">{idle ? 'ready' : ago(task.startedAt, now)}</span>
        <MaximizeButton target={{ kind: 'agent', id: task.id }} label={`agent #${task.id}`} />
      </header>
      <div className="flex flex-wrap items-center gap-1 px-3.5 pb-2">
        {project && <span className="chip">{project}</span>}
        <ModelSelect label={`Model for #${task.id}`} value={task.model} onChange={async (m) => pushToast((await api.setTaskModel(task.id, m)).result)} />
        <TurnsChip turns={task.turns} limit={limit} />
        <span className="chip tabular-nums">{usd(task.costUsd)}</span>
      </div>

      <div ref={feed} className={`mx-3 mb-2 min-h-0 flex-1 space-y-1 overflow-y-auto rounded-[10px] bg-base px-3 py-2 font-mono leading-[1.55] ${big ? 'text-[13px]' : 'text-[11.5px]'}`}>
        {!events && <div className="text-faint">Loading…</div>}
        {shown.map((e) => (
          <FeedLine key={e.id} e={e} />
        ))}
        {!idle && !waiting && ACTIVE.includes(task.status) && <div className="animate-pulse text-faint">{task.statusLine || 'working'}…</div>}
      </div>

      {waiting && <WaitingBanner item={waiting} />}

      <form
        className="flex items-center gap-1.5 px-3 pb-3"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          const t = text.trim();
          setText('');
          pushToast(`#${task.id}: ${(await api.message(task.id, t)).result}`);
        }}
      >
        <input className="field py-[5px] text-[13px]" placeholder={idle ? `Keep going with #${task.id}…` : `Message #${task.id} (or /command)`} value={text} onChange={(e) => setText(e.target.value)} />
        {idle && task.branch && (
          <button type="button" className="btn-done px-2.5" onClick={() => api.merge(task.id).then(() => pushToast(`Merged #${task.id}`))}>
            Merge
          </button>
        )}
        {!idle && (
          <button type="button" className="btn-ghost px-2" onClick={() => api.stop(task.id)} title="Stop this agent">
            Stop
          </button>
        )}
      </form>
    </article>
  );
}

export function AgentsView() {
  const tasks = useScopedTasks();
  const agents = useMemo(
    () =>
      tasks
        .filter((t) => ACTIVE.includes(t.status) || t.status === 'idle')
        .sort((a, b) => Number(a.status === 'idle') - Number(b.status === 'idle') || a.id - b.id),
    [tasks],
  );
  const active = agents.filter((t) => t.status !== 'idle').length;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-36 pt-4">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-semibold">Agents</h2>
        <span className="text-[12.5px] text-faint">
          {active} working, {agents.length - active} ready for more
        </span>
      </div>
      {agents.length === 0 ? (
        <p className="pt-[18vh] text-center text-[14px] text-faint">No agents are working. Tell the master what to build in the bar below.</p>
      ) : (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(360px,1fr))]">
          {agents.map((t) => (
            <AgentTile key={t.id} task={t} />
          ))}
        </div>
      )}
    </div>
  );
}
