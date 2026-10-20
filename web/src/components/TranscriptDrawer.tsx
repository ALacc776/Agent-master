import { useEffect, useRef, useState } from 'react';
import { api, loadEvents } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { modelLabel, Rich, usd, useTask } from '../ui.tsx';
import type { TaskEvent } from '../../../shared/types.ts';

const STYLE: Record<TaskEvent['type'], string> = {
  assistant: 'text-ink',
  tool: 'font-mono text-[12px] text-muted',
  tool_result: 'font-mono text-[12px] text-danger/80',
  user: 'ml-10 rounded-[16px] bg-raised/70 px-3.5 py-2 text-ink',
  system: 'text-[12px] text-faint',
  result: 'text-[12px] text-done',
  error: 'text-danger',
  permission: 'text-[12.5px] text-signal',
};

export function TranscriptDrawer() {
  const id = useStore((s) => s.drawer);
  const events = useStore((s) => (id != null ? s.events[id] : undefined));
  const task = useTask(id);
  const [text, setText] = useState('');
  const [showBrief, setShowBrief] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id != null) void loadEvents(id);
  }, [id]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [events?.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setState({ drawer: null });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (id == null || !task) return null;

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-black/20 p-2 backdrop-blur-[2px]" onMouseDown={() => setState({ drawer: null })}>
      <div className="flex h-full w-full max-w-2xl flex-col overflow-hidden rounded-sheet bg-panel shadow-sheet" onMouseDown={(e) => e.stopPropagation()}>
        <header className="hairline shrink-0 px-5 py-4">
          <div className="flex items-baseline gap-2">
            <span className="text-[17px] font-semibold tabular-nums text-faint">#{task.id}</span>
            <h2 className="min-w-0 flex-1 truncate font-display text-[17px] font-semibold">{task.title}</h2>
            <button className="btn-ghost" onClick={() => setState({ drawer: null })}>
              Close
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            <span className="chip">{task.status.replace('_', ' ')}</span>
            <span className="chip">{modelLabel(task.model)}</span>
            <span className="chip">{usd(task.costUsd)}</span>
            {task.branch && <span className="chip font-mono">{task.branch}</span>}
            <button className="chip hover:text-ink" onClick={() => setShowBrief(!showBrief)}>
              {showBrief ? 'Hide brief' : 'Show brief'}
            </button>
          </div>
          {showBrief && <Rich text={task.brief} className="mt-2 max-h-60 overflow-y-auto rounded bg-base p-2.5 text-[12.5px] text-muted" />}
        </header>

        <div ref={scroller} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3">
          {!events && <p className="text-faint">Loading…</p>}
          {events?.map((e) => (
            <div key={e.id} className={STYLE[e.type]}>
              {e.type === 'assistant' || e.type === 'user' ? <Rich text={e.text} className="text-[13.5px]" /> : <div className="whitespace-pre-wrap break-words">{e.text}</div>}
            </div>
          ))}
        </div>

        <form
          className="shrink-0 p-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const { result } = await api.message(task.id, text.trim());
            pushToast(result);
            setText('');
          }}
        >
          <div className="flex gap-2">
            <input className="field" placeholder={`Message agent #${task.id} directly`} value={text} onChange={(e) => setText(e.target.value)} />
            <button className="btn-run">Send</button>
          </div>
        </form>
      </div>
    </div>
  );
}
