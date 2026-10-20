import { useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import { getState, setBuildProject, setOnDone, setState, setView, useStore } from '../store.ts';
import { Rich, useBoard, WhenDone } from '../ui.tsx';
import type { MasterMessage } from '../../../shared/types.ts';

// Browser speech recognition (Chrome/Safari/Edge).
const SpeechRecognition: any = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;

function send(text: string) {
  const s = getState();
  void api.sendMaster(text, s.projects.some((p) => p.id === s.buildProjectId) ? s.buildProjectId : null, s.onDone);
}

function Message({ m }: { m: MasterMessage }) {
  if (m.role === 'system') return <p className="text-center text-[12px] text-faint">{m.text}</p>;
  if (m.role === 'user')
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-[18px] rounded-br-[6px] bg-run px-3.5 py-2 text-onaccent">
          <Rich text={m.text} className="text-[14px]" />
        </div>
      </div>
    );
  return <Rich text={m.text} className="pr-6 text-[14px]" />;
}

function Thread({ className = '', limit }: { className?: string; limit?: number }) {
  const all = useStore((s) => s.master);
  const busy = useStore((s) => s.masterBusy);
  const messages = limit ? all.slice(-limit) : all;
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [all.length, busy]);

  return (
    <div ref={scroller} className={`space-y-3.5 overflow-y-auto ${className}`}>
      {all.length === 0 && !limit && (
        <div className="mx-auto max-w-sm space-y-2 pt-[12vh] text-center">
          <p className="font-display text-[22px] font-semibold tracking-tight">What should we build?</p>
          <p className="text-[14px] text-muted">Describe it in plain words. The master splits it into tasks, starts agents, and keeps talking with you while they work.</p>
          <div className="space-y-1.5 pt-3 text-[13px]">
            {['Fix the signup redirect bug, and later add dark mode', 'What is everyone working on?', 'Add tests for the payments module'].map((t) => (
              <button key={t} className="block w-full rounded-xl bg-raised/50 px-3 py-2 text-left text-muted hover:bg-raised hover:text-ink" onClick={() => send(t)}>
                {t}
              </button>
            ))}
          </div>
        </div>
      )}
      {messages.map((m) => (
        <Message key={m.id} m={m} />
      ))}
      {busy && <p className="text-[12.5px] text-faint">Master is on it. You can keep typing.</p>}
    </div>
  );
}

function BuildIn() {
  const projects = useStore((s) => s.projects);
  const buildProjectId = useStore((s) => s.buildProjectId);
  const current = projects.find((p) => p.id === buildProjectId) ?? null;
  return (
    <div className="flex items-center gap-1 text-[12.5px]">
      <label htmlFor="build-in" className="text-faint">
        Build in
      </label>
      <select
        id="build-in"
        className="max-w-[180px] cursor-pointer truncate rounded-md bg-transparent px-1 py-0.5 font-medium text-ink hover:bg-raised/60 focus:outline-none"
        value={current ? String(current.id) : ''}
        onChange={(e) => {
          if (e.target.value === '__choose') setState({ modal: { folder: 'chat' } });
          else setBuildProject(e.target.value ? Number(e.target.value) : null);
        }}
      >
        <option value="">Any project</option>
        {projects.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        <option value="__choose">Choose a folder…</option>
      </select>
    </div>
  );
}

function Options({ className = '' }: { className?: string }) {
  const onDone = useStore((s) => s.onDone);
  return (
    <div className={`flex flex-wrap items-center gap-x-4 gap-y-1 ${className}`}>
      <BuildIn />
      <WhenDone value={onDone} onChange={setOnDone} />
    </div>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function Composer({ inputRef, compact = false, onFocus }: { inputRef: React.RefObject<HTMLTextAreaElement>; compact?: boolean; onFocus?: () => void }) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const recog = useRef<any>(null);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    send(t);
    setText('');
  };

  const toggleMic = () => {
    if (listening) return recog.current?.stop();
    const r = new SpeechRecognition();
    r.continuous = true;
    r.interimResults = true;
    const base = text ? `${text} ` : '';
    r.onresult = (e: any) => {
      let s = '';
      for (let i = 0; i < e.results.length; i++) s += e.results[i][0].transcript;
      setText(base + s);
    };
    r.onend = () => setListening(false);
    r.start();
    recog.current = r;
    setListening(true);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`flex items-end gap-1.5 ${compact ? 'rounded-full py-1.5 pl-4 pr-1.5' : 'rounded-[20px] bg-panel p-2 pl-3.5 ring-1 ring-line focus-within:ring-run/40'}`}
    >
      <textarea
        ref={inputRef}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
        className="min-h-[24px] flex-1 resize-none self-center bg-transparent py-0.5 text-[14.5px] placeholder:text-faint focus:outline-none"
        placeholder="Message Master"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => {
          setState({ selected: null });
          onFocus?.();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
          if (e.key === 'Escape') (e.target as HTMLElement).blur();
        }}
      />
      {SpeechRecognition && (
        <button
          type="button"
          onClick={toggleMic}
          className={`grid h-8 w-8 place-items-center rounded-full ${listening ? 'bg-danger/15 text-danger' : 'text-muted hover:bg-raised/70 hover:text-ink'}`}
          title="Dictate"
          aria-pressed={listening}
        >
          <MicIcon />
        </button>
      )}
      <button className="grid h-8 w-8 place-items-center rounded-full bg-run text-onaccent disabled:opacity-30" disabled={!text.trim()} aria-label="Send">
        <SendIcon />
      </button>
    </form>
  );
}

function Status() {
  const busy = useStore((s) => s.masterBusy);
  const queued = useStore((s) => s.masterQueue);
  return <span className="text-[12px] text-faint">{busy ? (queued ? `Working, ${queued} queued` : 'Working…') : 'Ready'}</span>;
}

const resetChat = () => confirm('Start a new conversation with the master? Tasks are kept.') && api.resetMaster();

/** Split view: a panel on the right. */
export function MasterPanel({ inputRef }: { inputRef: React.RefObject<HTMLTextAreaElement> }) {
  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-line/70 bg-panel/50">
      <header className="flex h-11 shrink-0 items-center gap-2 px-4">
        <h2 className="text-[14px] font-semibold">Master</h2>
        <Status />
        <button className="btn-ghost ml-auto px-2 text-[12px]" onClick={resetChat}>
          New chat
        </button>
      </header>
      <Thread className="min-h-0 flex-1 px-4 pb-3" />
      <div className="shrink-0 space-y-1.5 p-3 pt-0">
        <Options />
        <Composer inputRef={inputRef} />
      </div>
    </aside>
  );
}

/** Master view: the conversation fills the screen. */
export function MasterFull({ inputRef }: { inputRef: React.RefObject<HTMLTextAreaElement> }) {
  const { needs, running, queue, done } = useBoard();
  const pills = [
    { n: needs.length, label: 'need you', dot: 'bg-signal' },
    { n: running.length, label: 'running', dot: 'bg-run' },
    { n: queue.length, label: 'queued', dot: 'bg-queue' },
    { n: done.length, label: 'to review', dot: 'bg-done' },
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center justify-center gap-1.5 px-4 pt-3">
        {pills.map((p) => (
          <button key={p.label} className="btn-line gap-2 text-[12.5px]" onClick={() => setView('board')}>
            <span className={`h-1.5 w-1.5 rounded-full ${p.dot}`} />
            <span className="tabular-nums">{p.n}</span> {p.label}
          </button>
        ))}
      </div>
      <Thread className="mx-auto min-h-0 w-full max-w-[720px] flex-1 px-5 py-6" />
      <div className="mx-auto w-full max-w-[720px] shrink-0 space-y-1.5 px-5 pb-5">
        <div className="flex items-center justify-between gap-2">
          <Options />
          <div className="flex shrink-0 items-center gap-2">
            <Status />
            <button className="btn-ghost px-2 text-[12px]" onClick={resetChat}>
              New chat
            </button>
          </div>
        </div>
        <Composer inputRef={inputRef} />
      </div>
    </div>
  );
}

/** Board view: the master shrinks to a floating bar; recent replies peek above it. */
export function MasterBar({ inputRef }: { inputRef: React.RefObject<HTMLTextAreaElement> }) {
  const messages = useStore((s) => s.master);
  const [open, setOpen] = useState(false);
  const lastSeen = useRef(messages.length);
  useEffect(() => {
    // Peek automatically when the master replies.
    const last = messages.at(-1);
    if (messages.length > lastSeen.current && last && last.role !== 'user') setOpen(true);
    lastSeen.current = messages.length;
  }, [messages]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-[640px]">
        {open && messages.length > 0 && (
          <div className="glass mb-2 rounded-[20px] shadow-bar">
            <div className="flex items-center gap-2 px-4 pt-2.5">
              <span className="text-[12.5px] font-semibold">Master</span>
              <Status />
              <button className="btn-ghost ml-auto px-2 text-[12px]" onClick={() => setView('master')}>
                Open
              </button>
              <button className="btn-ghost px-2 text-[12px]" onClick={() => setOpen(false)} aria-label="Hide replies">
                Hide
              </button>
            </div>
            <Thread className="max-h-[38vh] px-4 pb-3 pt-2" limit={6} />
          </div>
        )}
        <div className="glass rounded-full shadow-bar">
          <Composer inputRef={inputRef} compact onFocus={() => setOpen(true)} />
        </div>
        <div className="mt-1.5 flex justify-center">
          <div className="glass rounded-full px-3 py-1 shadow-card">
            <Options />
          </div>
        </div>
      </div>
    </div>
  );
}
