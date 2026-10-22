import { useMemo } from 'react';
import { setScope, setState, toggleSidebar, useStore } from '../store.ts';
import type { Scope } from '../../../shared/types.ts';

const ACTIVE = ['running', 'needs_input', 'stalled'];

// Boss on top, then one master per project. Badges show what needs you and what's running.
export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  const scope = useStore((s) => s.scope);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const inbox = useStore((s) => s.inbox);
  const masters = useStore((s) => s.masters);
  const procs = useStore((s) => s.procs);
  const appRunning = useMemo(() => new Set(Object.values(procs).filter((p) => p.kind === 'run' && p.status === 'running').map((p) => String(p.projectId))), [procs]);

  const counts = useMemo(() => {
    const projectOf = new Map(tasks.map((t) => [t.id, String(t.projectId)]));
    const c: Record<Scope, { needs: number; running: number }> = { boss: { needs: 0, running: 0 } };
    for (const p of projects) c[String(p.id)] = { needs: 0, running: 0 };
    for (const t of tasks) {
      if (!ACTIVE.includes(t.status)) continue;
      c.boss.running++;
      if (c[String(t.projectId)]) c[String(t.projectId)].running++;
    }
    for (const i of inbox) {
      if (i.status !== 'open') continue;
      c.boss.needs++;
      const p = i.taskId != null ? projectOf.get(i.taskId) : undefined;
      if (p && c[p]) c[p].needs++;
    }
    return c;
  }, [tasks, inbox, projects]);

  // Short labels for the collapsed rail: word initials ("gongla-app" → GA), else the first two letters;
  // a clash with an earlier project uses first + last character instead ("sandbox2" → S2).
  const labels = useMemo(() => {
    const out: Record<string, string> = {};
    const used = new Set<string>();
    for (const p of projects) {
      const clean = p.name.replace(/[^a-zA-Z0-9]+/g, ' ').trim();
      const words = clean.split(' ').filter(Boolean);
      let label = (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)) || '·';
      label = label[0].toUpperCase() + label.slice(1).toLowerCase();
      if (used.has(label) && clean.length > 1) label = (clean[0] + clean.at(-1)).toUpperCase();
      used.add(label);
      out[String(p.id)] = label;
    }
    return out;
  }, [projects]);

  const Item = ({ id, name, hint }: { id: Scope; name: string; hint?: string }) => {
    const n = counts[id] ?? { needs: 0, running: 0 };
    const active = scope === id;
    const busy = masters[id]?.busy;
    if (collapsed)
      return (
        <button
          onClick={() => setScope(id)}
          aria-current={active ? 'page' : undefined}
          aria-label={name}
          title={`${name}${n.needs ? `: ${n.needs} need you` : ''}${n.running ? `, ${n.running} running` : ''}`}
          className={`relative mx-auto grid h-9 w-9 place-items-center rounded-[10px] text-[13px] font-semibold transition-colors ${
            active ? 'bg-raised text-ink' : 'text-muted hover:bg-raised/50 hover:text-ink'
          }`}
        >
          {id === 'boss' ? '★' : labels[id] ?? '·'}
          {n.needs > 0 && <span className="absolute -right-0.5 -top-0.5 min-w-[16px] rounded-full bg-signal px-1 text-[10px] font-semibold leading-4 tabular-nums text-white">{n.needs}</span>}
          {n.needs === 0 && (busy || n.running > 0) && <span className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ${busy ? 'animate-pulse bg-run' : 'bg-done'}`} />}
        </button>
      );
    return (
      <button
        onClick={() => setScope(id)}
        aria-current={active ? 'page' : undefined}
        title={hint}
        className={`group flex w-full items-center gap-2 rounded-[8px] px-2.5 py-[7px] text-left text-[13.5px] transition-colors ${
          active ? 'bg-raised font-semibold text-ink' : 'text-ink/80 hover:bg-raised/50'
        }`}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${busy ? 'animate-pulse bg-run' : n.running ? 'bg-done' : 'bg-faint/40'}`} />
        <span className="min-w-0 flex-1 truncate">{name}</span>
        {appRunning.has(id) && <span className="text-[10px] text-done" title="App running">▶</span>}
        {n.needs > 0 && <span className="rounded-full bg-signal px-1.5 text-[11px] font-semibold tabular-nums text-white">{n.needs}</span>}
        {n.running > 0 && <span className="text-[11.5px] tabular-nums text-faint">{n.running}</span>}
      </button>
    );
  };

  if (collapsed)
    return (
      <nav aria-label="Masters" className="flex h-full w-[56px] shrink-0 flex-col items-center gap-1.5 border-r border-line/60 bg-panel/40 py-3">
        <Item id="boss" name="Boss" />
        <div className="my-1 h-px w-6 bg-line" />
        <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto">
          {projects.map((p) => (
            <Item key={p.id} id={String(p.id)} name={p.name} />
          ))}
        </div>
        <button className="grid h-9 w-9 place-items-center rounded-[10px] text-[18px] text-run hover:bg-raised/50" onClick={() => setState({ modal: { folder: 'sidebar' } })} title="Add project" aria-label="Add project">
          +
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-[8px] text-muted hover:bg-raised/50 hover:text-ink" onClick={toggleSidebar} title="Expand sidebar ([)" aria-label="Expand sidebar">
          »
        </button>
      </nav>
    );

  return (
    <nav aria-label="Masters" className="flex h-full w-[220px] shrink-0 flex-col gap-4 border-r border-line/60 bg-panel/40 px-2.5 py-3">
      <div className="space-y-0.5">
        <Item id="boss" name="Boss" hint="The master over every project" />
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto">
        <h2 className="px-2.5 pb-1 text-[12px] font-semibold text-faint">Projects</h2>
        {projects.length === 0 && <p className="px-2.5 text-[12.5px] text-faint">Add a project to give it its own master.</p>}
        {projects.map((p) => (
          <Item key={p.id} id={String(p.id)} name={p.name} hint={p.path} />
        ))}
        <button className="mt-1 w-full rounded-[8px] px-2.5 py-[7px] text-left text-[13px] font-medium text-run hover:bg-raised/50" onClick={() => setState({ modal: { folder: 'sidebar' } })}>
          Add project…
        </button>
      </div>
      <button className="self-start rounded-[8px] px-2.5 py-1 text-[12.5px] text-faint hover:bg-raised/50 hover:text-ink" onClick={toggleSidebar} title="Collapse sidebar ([)">
        « Collapse
      </button>
    </nav>
  );
}
