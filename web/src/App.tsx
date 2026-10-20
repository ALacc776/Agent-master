import { useEffect, useRef } from 'react';
import { api } from './api.ts';
import { getState, pushToast, setState, setView, useStore } from './store.ts';
import { parseSuggestion, useBoard } from './ui.tsx';
import { TopBar } from './components/TopBar.tsx';
import { Board } from './components/Board.tsx';
import { MasterBar, MasterFull, MasterPanel } from './components/MasterChat.tsx';
import { TranscriptDrawer } from './components/TranscriptDrawer.tsx';
import { SettingsModal } from './components/Settings.tsx';
import { DiffModal, DigestBanner, NewTaskModal, SearchModal } from './components/Modals.tsx';
import { FolderPicker } from './components/FolderPicker.tsx';

function useKeyboard(chatRef: React.RefObject<HTMLTextAreaElement>) {
  const board = useBoard();
  const boardRef = useRef(board);
  boardRef.current = board;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = getState();
      if (s.modal || s.drawer != null) return;
      const { order, needs } = boardRef.current;
      const sel = s.selected;
      const [kind, rawId] = sel?.split(':') ?? [];
      const id = Number(rawId);
      const item = kind === 'inbox' ? needs.find((i) => i.id === id) : undefined;
      const task = kind === 'task' ? s.tasks.find((t) => t.id === id) : undefined;

      const move = (d: number) => {
        if (!order.length) return;
        const i = sel ? order.indexOf(sel) : -1;
        const next = order[Math.max(0, Math.min(order.length - 1, i + d))];
        setState({ selected: next });
        document.querySelector(`[data-key="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      };

      const handlers: Record<string, () => void> = {
        j: () => move(1),
        ArrowDown: () => move(1),
        k: () => move(-1),
        ArrowUp: () => move(-1),
        c: () => chatRef.current?.focus(),
        '/': () => setState({ modal: 'search' }),
        p: () => api.pauseAll(!s.settings.paused),
        N: () => setState({ modal: 'new' }),
        '1': () => setView('board'),
        '2': () => setView('split'),
        '3': () => setView('master'),
        Escape: () => setState({ selected: null, replyTo: null }),
        a: () => {
          const sug = parseSuggestion(item?.suggestedAnswer ?? null);
          if (item && sug) api.answer(item.id, sug.answer);
          else if (task?.status === 'done') api.accept(task.id);
        },
        y: () => item?.kind === 'permission' && api.answer(item.id, 'allow'),
        n: () => item?.kind === 'permission' && api.answer(item.id, 'deny'),
        r: () => sel && setState({ replyTo: sel }),
        s: () => {
          if (task && ['queued', 'stopped', 'failed'].includes(task.status))
            api.start(task.id).then((r) => r.waiting && pushToast(`#${task.id}: ${r.waiting}`));
        },
        o: () => {
          const tid = task?.id ?? item?.taskId;
          if (tid != null) setState({ drawer: tid });
        },
        Enter: () => {
          const tid = task?.id ?? item?.taskId;
          if (tid != null) setState({ drawer: tid });
        },
        '?': () => pushToast('j/k move, a accept suggestion, y/n allow/deny, r reply, s start, o open, c chat, / search, p pause all, N new task, 1/2/3 switch layout'),
      };
      const h = handlers[e.key];
      if (h) {
        e.preventDefault();
        h();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [chatRef]);
}

export function App() {
  const modal = useStore((s) => s.modal);
  const view = useStore((s) => s.view);
  const toasts = useStore((s) => s.toasts);
  const needsCount = useBoard().needs.length;
  const chatRef = useRef<HTMLTextAreaElement>(null);
  useKeyboard(chatRef);

  useEffect(() => {
    document.title = needsCount ? `(${needsCount}) Master` : 'Master';
  }, [needsCount]);

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      {view === 'master' ? (
        <MasterFull inputRef={chatRef} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${view === 'board' ? 'pb-28' : ''}`}>
            <DigestBanner />
            <Board wide={view === 'board'} />
          </main>
          {view === 'split' && (
            <div className="h-[45vh] shrink-0 lg:h-auto lg:w-[340px] xl:w-[380px]">
              <MasterPanel inputRef={chatRef} />
            </div>
          )}
        </div>
      )}
      {view === 'board' && <MasterBar inputRef={chatRef} />}

      <TranscriptDrawer />
      {modal === 'settings' && <SettingsModal />}
      {modal === 'search' && <SearchModal />}
      {modal === 'new' && <NewTaskModal />}
      {modal && typeof modal === 'object' && 'diff' in modal && <DiffModal taskId={modal.diff} />}
      {modal && typeof modal === 'object' && 'folder' in modal && <FolderPicker returnTo={modal.folder} />}

      <div className="pointer-events-none fixed left-1/2 top-16 z-50 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="glass rounded-2xl px-4 py-2.5 text-[13px] shadow-bar">
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
