import { api } from '../api.ts';
import { setPlan, setState, setView, toggleSidebar, useStore, type View } from '../store.ts';
import { useBoard, useScopeName, usd } from '../ui.tsx';

const VIEWS: { id: View; label: string; key: string }[] = [
  { id: 'board', label: 'Board', key: '1' },
  { id: 'split', label: 'Split', key: '2' },
  { id: 'master', label: 'Master', key: '3' },
  { id: 'agents', label: 'Agents', key: '4' },
];

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { id: T; label: string; title?: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-[9px] bg-raised/70 p-[2px]">
      {options.map((o) => (
        <button
          key={o.id}
          role="radio"
          aria-checked={value === o.id}
          title={o.title}
          onClick={() => onChange(o.id)}
          className={`rounded-[7px] px-3 py-[3px] text-[12.5px] font-medium transition-colors ${value === o.id ? 'bg-panel text-ink shadow-card' : 'text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const Icon = {
  search: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  gear: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
};

export function TopBar() {
  const settings = useStore((s) => s.settings);
  const spent = useStore((s) => s.spentToday);
  const connected = useStore((s) => s.connected);
  const view = useStore((s) => s.view);
  const { needs } = useBoard();
  const running = useStore((s) => s.tasks.filter((t) => ['running', 'needs_input', 'stalled'].includes(t.status)).length);
  const scopeName = useScopeName();
  const planOpen = useStore((s) => s.planOpen);
  const cap = settings.dailyCapUsd || 0;
  const pct = cap ? Math.min(100, (spent / cap) * 100) : 0;

  return (
    <header className="glass hairline sticky top-0 z-10 grid h-[52px] shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 px-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <button className="hidden h-7 w-7 place-items-center rounded-[7px] text-muted hover:bg-raised/70 hover:text-ink md:grid" onClick={toggleSidebar} title="Collapse or expand the sidebar ([)" aria-label="Collapse or expand the sidebar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <rect x="3" y="4" width="18" height="16" rx="3" />
            <path d="M9 4v16" />
          </svg>
        </button>
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${needs.length ? 'bg-signal' : 'bg-done'}`} title={needs.length ? `${needs.length} need you` : 'All clear'} />
        <h1 className="truncate text-[15px] font-semibold tracking-tight">{scopeName}</h1>
        {!connected && <span className="chip bg-danger/10 text-danger">Reconnecting…</span>}
      </div>

      <Segmented label="Layout" value={view} onChange={setView} options={VIEWS.map((v) => ({ id: v.id, label: v.label, title: `${v.label} (${v.key})` }))} />

      <div className="flex items-center justify-end gap-3 text-[12.5px]">
        <div className="hidden items-center gap-1.5 text-muted md:flex" title="Agents running / how many can run at once">
          <span>
            <span className="tabular-nums text-ink">{running}</span> of
          </span>
          <div className="inline-flex items-center rounded-[8px] bg-raised/70">
            <button className="grid h-6 w-6 place-items-center rounded-l-[8px] hover:bg-raised disabled:opacity-30" aria-label="Allow fewer agents" disabled={settings.maxConcurrent <= 1} onClick={() => api.settings({ maxConcurrent: settings.maxConcurrent - 1 })}>
              −
            </button>
            <span className="w-5 text-center tabular-nums text-ink">{settings.maxConcurrent}</span>
            <button className="grid h-6 w-6 place-items-center rounded-r-[8px] hover:bg-raised disabled:opacity-30" aria-label="Allow more agents" disabled={settings.maxConcurrent >= 20} onClick={() => api.settings({ maxConcurrent: settings.maxConcurrent + 1 })}>
              +
            </button>
          </div>
          <span>agents</span>
        </div>
        <div className="hidden items-center gap-2 lg:flex" title={cap ? `Spent today, of a $${cap} daily cap` : 'Spent today'}>
          <span className="tabular-nums text-ink">{usd(spent)}</span>
          {cap > 0 && (
            <span className="h-1 w-14 overflow-hidden rounded-full bg-raised">
              <span className={`block h-full rounded-full ${pct > 85 ? 'bg-danger' : 'bg-done'}`} style={{ width: `${pct}%` }} />
            </span>
          )}
        </div>
        <button
          className={`btn px-3 ${planOpen ? 'bg-run text-onaccent' : 'bg-raised/70 text-ink hover:bg-raised'}`}
          onClick={() => setPlan({ planOpen: !planOpen })}
          title="Plan with Claude before building (P)"
          aria-pressed={planOpen}
        >
          Plan
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-raised/70 hover:text-ink" onClick={() => setState({ modal: 'search' })} title="Search (/)" aria-label="Search">
          {Icon.search}
        </button>
        <button className="grid h-8 w-8 place-items-center rounded-full text-muted hover:bg-raised/70 hover:text-ink" onClick={() => setState({ modal: 'settings' })} title="Settings" aria-label="Settings">
          {Icon.gear}
        </button>
        <button className={settings.paused ? 'btn-signal' : 'btn-line'} onClick={() => api.pauseAll(!settings.paused)} title="Pause or resume every agent (p)">
          {settings.paused ? 'Resume all' : 'Pause all'}
        </button>
      </div>
    </header>
  );
}
