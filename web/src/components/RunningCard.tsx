import { api } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { ago, ModelSelect, TERMINAL_HINT, TurnsChip, usd, useNow, useProjectName } from '../ui.tsx';
import type { Task } from '../../../shared/types.ts';

const FLAG_TEXT: Record<string, string> = { stalled: 'No activity', looping: 'Looping?', collision: 'Same files as another agent' };

export function RunningCard({ task }: { task: Task }) {
  const key = `task:${task.id}`;
  const selected = useStore((s) => s.selected === key);
  const project = useProjectName(task.projectId);
  const now = useNow(1000);
  const waiting = task.status === 'needs_input';
  const limit = useStore((s) => s.settings.turnWarning);
  const long = limit > 0 && task.turns >= limit;

  return (
    <article
      data-key={key}
      onClick={() => setState({ selected: key })}
      onDoubleClick={() => setState({ drawer: task.id })}
      className={`card p-3.5 ${waiting ? 'ring-1 ring-signal/40' : ''} ${selected ? '!ring-2 !ring-run/45' : ''}`}
    >
      <header className="flex items-baseline gap-2">
        <span className="text-[14px] font-semibold tabular-nums text-faint">#{task.id}</span>
        <h3 className="min-w-0 flex-1 truncate text-[14px] font-semibold">{task.title}</h3>
        <span className="shrink-0 text-[11.5px] tabular-nums text-faint">{ago(task.startedAt, now)}</span>
      </header>

      <div className="mt-2 flex items-center gap-2 text-[12.5px]">
        <span className={`h-2 w-2 shrink-0 rounded-full ${waiting ? 'bg-signal' : task.status === 'stalled' ? 'bg-danger' : 'animate-pulse bg-run'}`} />
        <span className={`truncate ${waiting ? 'text-signal' : 'text-ink/85'}`}>{waiting ? 'Waiting for you' : task.statusLine || 'Working'}</span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {project && <span className="chip">{project}</span>}
        <ModelSelect label={`Model for #${task.id}${task.modelReason ? ` (${task.modelReason})` : ''}`} value={task.model} onChange={async (m) => pushToast((await api.setTaskModel(task.id, m)).result)} />
        <TurnsChip turns={task.turns} limit={limit} />
        <span className="chip tabular-nums">{usd(task.costUsd)}</span>
        {task.filesTouched.length > 0 && <span className="chip">{task.filesTouched.length} files</span>}
        {task.flags.includes('plan') && <span className="chip text-run">Planning</span>}
        {task.onDone !== 'merge' && <span className="chip">{task.onDone === 'pr' ? 'Opens a PR' : task.onDone === 'keep' ? 'Stays open' : 'You review'}</span>}
        {task.flags
          .filter((f) => FLAG_TEXT[f])
          .map((f) => (
            <span key={f} className="chip bg-danger/15 text-danger">
              {FLAG_TEXT[f]}
            </span>
          ))}
      </div>

      <div className="mt-2.5 flex gap-1">
        <button className="btn-line" onClick={() => setState({ drawer: task.id })}>
          Peek
        </button>
        {long && (
          <button className="btn-signal" onClick={async () => pushToast((await api.fresh(task.id)).result)} title="Stop, summarize progress, continue in a new session">
            Fresh session
          </button>
        )}
        <button className="btn-ghost" onClick={() => api.pause(task.id)}>
          Pause
        </button>
        {task.sessionId && (
          <button className="btn-ghost" onClick={() => api.openTerminal(task.id)} title={TERMINAL_HINT}>
            Terminal
          </button>
        )}
        <button className="btn-danger ml-auto" onClick={() => api.stop(task.id)}>
          Stop
        </button>
      </div>
    </article>
  );
}
