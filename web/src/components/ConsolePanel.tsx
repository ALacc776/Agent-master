import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.ts';
import { setConsole, useStore } from '../store.ts';
import { MaximizeButton } from '../ui.tsx';
import type { ProcInfo } from '../../../shared/types.ts';

// Bottom panel for a project: run its dev server and run terminal commands in its folder.
// Collapses to a slim bar that keeps the run controls.

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+)(?::\d+)?[^\s'")\]]*/g;

function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [dep]);
  const onScroll = () => {
    const el = ref.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };
  return { ref, onScroll };
}

const Icon = {
  play: <path d="M7 5v14l11-7z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  restart: <path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />,
  chevron: <path d="m6 15 6-6 6 6" />,
};
const Svg = ({ children, size = 14 }: { children: React.ReactNode; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);

function RunCommandEditor({ projectId, command }: { projectId: number; command: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(command);
  useEffect(() => setValue(command), [command]);
  if (editing)
    return (
      <form
        className="min-w-0 flex-1"
        onSubmit={(e) => {
          e.preventDefault();
          void api.setRunCommand(projectId, value);
          setEditing(false);
        }}
      >
        <input autoFocus className="field w-full max-w-md py-[3px] font-mono text-[12px]" value={value} onChange={(e) => setValue(e.target.value)} onBlur={() => setEditing(false)} onKeyDown={(e) => e.key === 'Escape' && setEditing(false)} placeholder="npm run dev" />
      </form>
    );
  return (
    <button className="min-w-0 truncate rounded-md px-1.5 py-0.5 font-mono text-[12px] text-muted hover:bg-raised/60 hover:text-ink" onClick={() => setEditing(true)} title="Change the run command">
      {command || 'Set a run command…'}
    </button>
  );
}

function Output({ lines }: { lines: string[] }) {
  const { ref, onScroll } = useAutoScroll(lines.length + (lines.at(-1)?.length ?? 0));
  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-4 py-2 font-mono text-[12px] leading-[1.5] text-ink/85">
      {lines.join('\n') || <span className="text-faint">No output yet.</span>}
    </div>
  );
}

function RunTab({ run }: { run: ProcInfo | undefined }) {
  const [input, setInput] = useState('');
  const urls = useMemo(() => [...new Set((run?.lines.join('\n') ?? '').match(URL_RE) ?? [])].slice(-3), [run?.lines]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {urls.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2">
          {urls.map((u) => (
            <a key={u} href={u.replace('0.0.0.0', 'localhost')} target="_blank" rel="noreferrer" className="chip text-run hover:underline">
              Open {u.replace(/^https?:\/\//, '')}
            </a>
          ))}
        </div>
      )}
      <Output lines={run?.lines ?? []} />
      {run?.status === 'running' && (
        <form
          className="px-3 pb-2"
          onSubmit={(e) => {
            e.preventDefault();
            void api.procInput(run.id, input);
            setInput('');
          }}
        >
          <input className="field py-[4px] font-mono text-[12px]" placeholder="Type into the running app (e.g. r to reload), Enter to send" value={input} onChange={(e) => setInput(e.target.value)} />
        </form>
      )}
    </div>
  );
}

function TerminalTab({ projectId, procs }: { projectId: number; procs: ProcInfo[] }) {
  const [cmd, setCmd] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState(-1);
  const last = procs.at(-1);
  const { ref, onScroll } = useAutoScroll(procs.length + (last?.lines.length ?? 0) + (last?.lines.at(-1)?.length ?? 0));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-2 font-mono text-[12px] leading-[1.5]">
        {procs.length === 0 && <p className="text-faint">Run commands in this project's folder: git status, npm install, npm test…</p>}
        {procs.map((p) => (
          <div key={p.id}>
            <div className="flex items-center gap-2">
              <span className="text-done">$</span>
              <span className="min-w-0 flex-1 truncate text-ink">{p.cmd}</span>
              {p.status === 'running' ? (
                <button className="text-[11px] text-danger hover:underline" onClick={() => api.stopProc(p.id)}>
                  Stop
                </button>
              ) : (
                <span className={`text-[11px] ${p.code === 0 ? 'text-faint' : 'text-danger'}`}>{p.code === 0 ? 'done' : `exit ${p.code}`}</span>
              )}
            </div>
            <div className="whitespace-pre-wrap break-words text-ink/80">{p.lines.join('\n').replace(/\n\[exited with code \d+\]\n?$/, '').trimEnd()}</div>
          </div>
        ))}
      </div>
      <form
        className="flex items-center gap-2 px-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          const c = cmd.trim();
          if (!c) return;
          void api.terminal(projectId, c);
          setHistory((h) => [...h.filter((x) => x !== c), c].slice(-50));
          setCursor(-1);
          setCmd('');
        }}
      >
        <span className="font-mono text-[12px] text-done">$</span>
        <input
          className="field py-[4px] font-mono text-[12px]"
          placeholder="Run a command in this project"
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && history.length) {
              e.preventDefault();
              const i = cursor < 0 ? history.length - 1 : Math.max(0, cursor - 1);
              setCursor(i);
              setCmd(history[i]);
            } else if (e.key === 'ArrowDown' && cursor >= 0) {
              e.preventDefault();
              const i = cursor + 1;
              setCursor(i >= history.length ? -1 : i);
              setCmd(i >= history.length ? '' : history[i]);
            }
          }}
        />
        {procs.some((p) => p.status !== 'running') && (
          <button type="button" className="btn-ghost px-2 py-0.5 text-[12px]" onClick={() => api.clearTerminal(projectId)}>
            Clear
          </button>
        )}
      </form>
    </div>
  );
}

export function ConsolePanel({ big = false }: { big?: boolean }) {
  const scope = useStore((s) => s.scope);
  const open = useStore((s) => s.consoleOpen) || big;
  const tab = useStore((s) => s.consoleTab);
  const height = useStore((s) => s.consoleHeight);
  const allProcs = useStore((s) => s.procs);
  const commands = useStore((s) => s.runCommands);
  const projectId = Number(scope);

  const { run, terms } = useMemo(() => {
    const mine = Object.values(allProcs).filter((p) => p.projectId === projectId).sort((a, b) => a.startedAt - b.startedAt);
    return { run: mine.filter((p) => p.kind === 'run').at(-1), terms: mine.filter((p) => p.kind === 'term') };
  }, [allProcs, projectId]);

  // Let the floating master bar sit above the panel.
  useEffect(() => {
    if (big) return;
    document.documentElement.style.setProperty('--console-h', `${open ? height : 40}px`);
    return () => {
      document.documentElement.style.setProperty('--console-h', '0px');
    };
  }, [open, height]);

  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const move = (ev: MouseEvent) => setConsole({ consoleHeight: Math.max(140, Math.min(window.innerHeight * 0.75, startH + startY - ev.clientY)) });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const running = run?.status === 'running';
  const command = commands[scope] ?? '';
  const termRunning = terms.some((p) => p.status === 'running');

  return (
    <section aria-label="Run and terminal" className={`relative flex flex-col ${big ? 'h-full' : 'shrink-0 border-t border-line/70 bg-panel/70'}`} style={big ? undefined : { height: open ? height : 40 }}>
      {open && !big && <div onMouseDown={startDrag} className="absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize" title="Drag to resize" />}
      <header className="flex h-10 shrink-0 items-center gap-1.5 px-3">
        {running ? (
          <>
            <button className="grid h-7 w-7 place-items-center rounded-[8px] text-ink hover:bg-raised/70" onClick={() => api.restartRun(projectId)} title="Restart">
              <Svg>{Icon.restart}</Svg>
            </button>
            <button className="grid h-7 w-7 place-items-center rounded-[8px] text-danger hover:bg-danger/10" onClick={() => api.stopRun(projectId)} title="Stop">
              <Svg size={12}>{Icon.stop}</Svg>
            </button>
          </>
        ) : (
          <button className="btn-done gap-1 px-2.5 py-[3px] text-[12.5px]" onClick={() => command && api.run(projectId).then(() => setConsole({ consoleTab: 'run' }))} disabled={!command} title={command ? `Run ${command}` : 'Set a run command first'}>
            <Svg size={11}>{Icon.play}</Svg> Run
          </button>
        )}
        <span className={`ml-1 h-1.5 w-1.5 shrink-0 rounded-full ${running ? 'animate-pulse bg-done' : run && run.code ? 'bg-danger' : 'bg-faint/40'}`} />
        <RunCommandEditor projectId={projectId} command={command} />

        <div className="ml-auto flex items-center gap-1">
          <div role="tablist" className="inline-flex rounded-[8px] bg-raised/70 p-[2px]">
            {(['run', 'term'] as const).map((t) => (
              <button
                key={t}
                role="tab"
                aria-selected={open && tab === t}
                onClick={() => setConsole({ consoleTab: t, consoleOpen: true })}
                className={`rounded-[6px] px-2.5 py-[2px] text-[12px] font-medium ${open && tab === t ? 'bg-panel text-ink shadow-card' : 'text-muted hover:text-ink'}`}
              >
                {t === 'run' ? 'Output' : 'Terminal'}
                {t === 'term' && termRunning && <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-done align-middle" />}
              </button>
            ))}
          </div>
          <MaximizeButton target={{ kind: 'console' }} label="the run and terminal panel" />
          {!big && <button className="grid h-7 w-7 place-items-center rounded-[8px] text-muted hover:bg-raised/70 hover:text-ink" onClick={() => setConsole({ consoleOpen: !open })} title={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
            <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>
              <Svg>{Icon.chevron}</Svg>
            </span>
          </button>}
        </div>
      </header>
      {open && (tab === 'run' ? <RunTab run={run} /> : <TerminalTab projectId={projectId} procs={terms} />)}
    </section>
  );
}
