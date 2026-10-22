import { useEffect, useRef, useState } from 'react';
import { api, loadEvents } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { ModelSelect, Rich, usd, useTask } from '../ui.tsx';
import { CommandMenu, useCommandMenu } from './CommandMenu.tsx';
import type { AgentCommand, TaskEvent } from '../../../shared/types.ts';

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
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const menu = useCommandMenu(text, setText, commands);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (id == null) return;
    void loadEvents(id);
    api.commands(id).then(setCommands).catch(() => {});
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
            <ModelSelect label={`Model for #${task.id}`} value={task.model} onChange={async (m) => pushToast((await api.setTaskModel(task.id, m)).result)} />
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
          <div className="relative flex gap-2">
            <CommandMenu menu={menu} />
            <input
              className="field"
              placeholder={task.status === 'accepted' ? `Continue with #${task.id} (it reopens with its memory), or / for commands` : `Message agent #${task.id}, or type / for commands`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (menu.onKeyDown(e)) e.stopPropagation();
              }}
            />
            <button className="btn-run">Send</button>
          </div>
        </form>
      </div>
    </div>
  );
}
