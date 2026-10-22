import { useEffect, useMemo, useRef, useState } from 'react';
import { api, loadEvents } from '../api.ts';
import { getState, pushToast, setMaximized, setPlan, useStore } from '../store.ts';
import { MaximizeButton, ModelSelect, Rich, useScopedTasks } from '../ui.tsx';
import type { InboxItem, Task } from '../../../shared/types.ts';

// Talk ideas through with a normal Claude agent in plan mode. When it proposes a plan you approve
// it (it then builds it in its own worktree) or keep planning.

const isPlan = (t: Task) => t.flags.includes('plan') || t.flags.includes('planned');

function PlanCard({ item }: { item: InboxItem }) {
  const [notes, setNotes] = useState('');
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="rounded-[14px] bg-run/[0.07] p-3.5 ring-1 ring-run/25">
      <div className="flex items-center justify-between">
        <h3 className="text-[13px] font-semibold">Proposed plan</h3>
        <button className="text-[12px] text-faint hover:text-ink" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      {expanded && <Rich text={item.detail.plan ?? ''} className="mt-2 max-h-[45vh] overflow-y-auto text-[13px] text-ink/90" />}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <button className="btn-done" onClick={() => api.answer(item.id, 'approve')}>
          Approve &amp; build
        </button>
        <input className="field min-w-[160px] flex-1 py-[5px] text-[13px]" placeholder="Or say what to change…" value={notes} onChange={(e) => setNotes(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && notes.trim() && api.answer(item.id, notes.trim())} />
        <button className="btn-line" disabled={!notes.trim()} onClick={() => api.answer(item.id, notes.trim())}>
          Keep planning
        </button>
      </div>
    </div>
  );
}

function QuestionCard({ item }: { item: InboxItem }) {
  return (
    <div className="rounded-[14px] bg-signal/10 p-3.5">
      {item.detail.questions?.map((q) => (
        <div key={q.question}>
          <p className="text-[13.5px] font-medium">{q.question}</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {q.options.map((o) => (
              <button key={o.label} className="btn-line" title={o.description} onClick={() => api.answer(item.id, o.label)}>
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      <p className="mt-2 text-[12px] text-faint">Or type your own answer below.</p>
    </div>
  );
}

function Conversation({ task }: { task: Task }) {
  const events = useStore((s) => s.events[task.id]);
  const inbox = useStore((s) => s.inbox);
  const [text, setText] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const pending = useMemo(() => inbox.filter((i) => i.taskId === task.id && i.status === 'open'), [inbox, task.id]);
  const planItem = pending.find((i) => i.kind === 'plan');
  const question = pending.find((i) => i.kind === 'question');
  const planning = task.flags.includes('plan');
  const working = ['running', 'needs_input', 'stalled', 'queued'].includes(task.status) && !planItem && !question;

  useEffect(() => {
    if (!events) void loadEvents(task.id);
  }, [task.id, events]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events?.length, pending.length, working]);

  // The conversation: your messages, its replies, and a quiet line for what it looked at.
  const items = (events ?? []).filter((e) => e.type === 'user' || e.type === 'assistant' || (e.type === 'tool' && !e.text.startsWith('ExitPlanMode')));

  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (question) await api.answer(question.id, t);
    else if (planItem) await api.answer(planItem.id, t);
    else pushToast((await api.message(task.id, t)).result);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 px-4 pb-2">
        <span className={`chip ${planning ? 'text-run' : task.status === 'done' ? 'text-signal' : 'text-done'}`}>
          {planning ? 'Planning' : task.status === 'accepted' ? 'Built' : task.status === 'done' ? 'In review' : task.status === 'failed' ? 'Failed' : task.status === 'idle' ? 'Ready for more' : 'Building'}
        </span>
        <ModelSelect label="Model for this conversation" value={task.model} onChange={(m) => api.setTaskModel(task.id, m)} />
        <span className="min-w-0 flex-1 truncate text-right text-[12px] text-faint">{task.statusLine}</span>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-3">
        {items.map((e) =>
          e.type === 'user' ? (
            <div key={e.id} className="flex justify-end">
              <div className="max-w-[88%] rounded-[18px] rounded-br-[6px] bg-run px-3.5 py-2 text-onaccent">
                <Rich text={e.text} className="text-[13.5px]" />
              </div>
            </div>
          ) : e.type === 'assistant' ? (
            <Rich key={e.id} text={e.text} className="text-[13.5px]" />
          ) : (
            <p key={e.id} className="truncate font-mono text-[11px] text-faint">
              {e.text.replace(/^(\w+): /, (_, t) => `${t.toLowerCase()} `)}
            </p>
          ),
        )}
        {planItem && <PlanCard item={planItem} />}
        {question && <QuestionCard item={question} />}
        {working && <p className="animate-pulse text-[12.5px] text-faint">{planning ? 'Thinking…' : task.statusLine || 'Working…'}</p>}
      </div>
      <form
        className="shrink-0 p-3 pt-0"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-1.5 rounded-[18px] bg-panel p-2 pl-3.5 ring-1 ring-line focus-within:ring-run/40">
          <textarea
            rows={Math.min(5, Math.max(1, text.split('\n').length))}
            className="min-h-[22px] flex-1 resize-none self-center bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
            placeholder={question ? 'Answer the question…' : planItem ? 'Say what to change in the plan…' : planning ? 'Reply…' : 'Message it while it builds…'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn-run px-3" disabled={!text.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

function NewPlan() {
  const scope = useStore((s) => s.scope);
  const projects = useStore((s) => s.projects);
  const buildProjectId = useStore((s) => s.buildProjectId);
  const [projectId, setProjectId] = useState<number | null>(scope !== 'boss' ? Number(scope) : buildProjectId ?? projects[0]?.id ?? null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (scope !== 'boss') setProjectId(Number(scope));
  }, [scope]);

  const start = async () => {
    if (!text.trim() || projectId == null) return;
    const s = getState();
    const task = await api.createPlan({ projectId, text: text.trim(), model: s.taskModel === 'auto' ? undefined : s.taskModel, onDone: s.onDone });
    setText('');
    setPlan({ planTaskId: task.id });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col justify-end gap-3 px-4 pb-3">
      <div className="mx-auto max-w-sm space-y-2 pb-6 text-center">
        <p className="text-[18px] font-semibold tracking-tight">Think it through first</p>
        <p className="text-[13.5px] text-muted">Chat with Claude about an idea. It reads the project but changes nothing until you approve its plan, then builds it.</p>
      </div>
      {scope === 'boss' && (
        <select className="field py-1 text-[13px]" value={projectId ?? ''} onChange={(e) => setProjectId(Number(e.target.value))}>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              Plan in {p.name}
            </option>
          ))}
        </select>
      )}
      <div className="flex items-end gap-1.5 rounded-[18px] bg-panel p-2 pl-3.5 ring-1 ring-line focus-within:ring-run/40">
        <textarea
          autoFocus
          rows={Math.min(6, Math.max(2, text.split('\n').length))}
          className="flex-1 resize-none self-center bg-transparent text-[14px] placeholder:text-faint focus:outline-none"
          placeholder="What do you want to build or figure out?"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void start();
            }
          }}
        />
        <button className="btn-run px-3" disabled={!text.trim() || projectId == null} onClick={start}>
          Start
        </button>
      </div>
    </div>
  );
}

export function PlanPanel({ big = false }: { big?: boolean }) {
  const tasks = useScopedTasks();
  const selected = useStore((s) => s.planTaskId);
  const plans = useMemo(() => tasks.filter(isPlan).sort((a, b) => b.createdAt - a.createdAt), [tasks]);
  const current = plans.find((t) => t.id === selected);

  return (
    <aside className={`flex h-full min-h-0 w-full flex-col ${big ? 'text-[15px]' : 'border-l border-line/70 bg-panel/50'}`}>
      <header className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="text-[14px] font-semibold">Plan</h2>
        <select
          aria-label="Plan conversations"
          className="min-w-0 flex-1 truncate rounded-md bg-transparent px-1 py-0.5 text-[12.5px] text-muted hover:bg-raised/60 focus:outline-none"
          value={current ? String(current.id) : ''}
          onChange={(e) => setPlan({ planTaskId: e.target.value ? Number(e.target.value) : null })}
        >
          <option value="">New conversation</option>
          {plans.map((t) => (
            <option key={t.id} value={t.id}>
              #{t.id} {t.title}
            </option>
          ))}
        </select>
        {current && (
          <button className="btn-ghost px-2 text-[12px]" onClick={() => setPlan({ planTaskId: null })}>
            New
          </button>
        )}
        <MaximizeButton target={{ kind: 'plan' }} label="the plan" />
        <button className="grid h-7 w-7 place-items-center rounded-[7px] text-muted hover:bg-raised/70 hover:text-ink" onClick={() => { setPlan({ planOpen: false }); setMaximized(null); }} title="Hide plan panel (P)" aria-label="Hide plan panel">
          ✕
        </button>
      </header>
      <div className={`flex min-h-0 flex-1 flex-col ${big ? 'mx-auto w-full max-w-[860px]' : ''}`}>{current ? <Conversation key={current.id} task={current} /> : <NewPlan />}</div>
    </aside>
  );
}
