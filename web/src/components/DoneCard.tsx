import { useState } from 'react';
import { api } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { ago, modelLabel, Rich, TurnsChip, usd, useNow, useProjectName } from '../ui.tsx';
import type { Task } from '../../../shared/types.ts';

export function DoneCard({ task }: { task: Task }) {
  const key = `task:${task.id}`;
  const selected = useStore((s) => s.selected === key);
  const project = useProjectName(task.projectId);
  const now = useNow(30_000);
  const [mode, setMode] = useState<null | 'changes' | 'followup'>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const failed = task.status === 'failed';
  const limit = useStore((s) => s.settings.turnWarning);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!text.trim()) return;
    if (mode === 'changes') pushToast((await api.changes(task.id, text.trim())).result);
    else {
      const t = await api.followUp(task.id, text.trim());
      pushToast(`Queued follow-up #${t.id}`);
    }
    setText('');
    setMode(null);
  };

  return (
    <article
      data-key={key}
      onClick={() => setState({ selected: key })}
      className={`card p-3.5 ${failed ? 'ring-1 ring-danger/30' : ''} ${selected ? '!ring-2 !ring-run/45' : ''}`}
    >
      <header className="flex items-baseline gap-2">
        <span className={`text-[14px] font-semibold tabular-nums ${failed ? 'text-danger' : 'text-faint'}`}>#{task.id}</span>
        <button className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold hover:underline" onClick={() => setState({ drawer: task.id })} title="Open transcript">
          {task.title}
        </button>
        <span className="shrink-0 text-[11.5px] text-faint">{ago(task.finishedAt, now)} ago</span>
      </header>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {project && <span className="chip">{project}</span>}
        <span className="chip" title={task.modelReason ?? undefined}>
          {modelLabel(task.model)}
        </span>
        <TurnsChip turns={task.turns} limit={limit} />
        <span className="chip tabular-nums">{usd(task.costUsd)}</span>
        {failed && <span className="chip bg-danger/15 text-danger">Failed</span>}
      </div>

      {task.summary ? (
        <>
          <Rich text={task.summary} className={`mt-2 text-[13px] text-ink/85 ${expanded ? '' : 'line-clamp-4'}`} />
          {task.summary.length > 220 && (
            <button className="mt-0.5 text-[12.5px] font-medium text-muted hover:text-ink" onClick={() => setExpanded(!expanded)}>
              {expanded ? 'Show less' : 'Show more'}
            </button>
          )}
        </>
      ) : (
        !failed && <p className="mt-2 text-[12.5px] text-muted">Writing summary…</p>
      )}

      {task.diffStat && (
        <button className="mt-2 block w-full text-left" onClick={() => setState({ modal: { diff: task.id } })} title="View diff">
          <pre className="max-h-24 overflow-hidden rounded-[10px] bg-base p-2.5 font-mono text-[11.5px] text-muted hover:text-ink">{task.diffStat.split('\n').slice(-4).join('\n')}</pre>
        </button>
      )}

      {task.reviewVerdict && <ReviewNote verdict={task.reviewVerdict} />}

      <div className="mt-2.5 flex flex-wrap gap-1">
        {!failed && (
          <button className="btn-done" disabled={busy} onClick={() => act(() => api.accept(task.id))} title="Remove the worktree, keep the branch">
            Accept
          </button>
        )}
        {task.branch && !failed && (
          <button className="btn-line" disabled={busy} onClick={() => act(() => api.merge(task.id))} title={`Merge ${task.branch} into ${task.baseBranch}`}>
            Merge
          </button>
        )}
        {task.branch && !failed && (
          <button
            className="btn-line"
            disabled={busy}
            onClick={() =>
              act(async () => {
                const { url } = await api.pr(task.id);
                pushToast(`Opened PR ${url}`);
                window.open(url, '_blank');
              })
            }
          >
            Open PR
          </button>
        )}
        {failed && (
          <button className="btn-run" onClick={() => api.start(task.id)}>
            Retry
          </button>
        )}
        <button className="btn-ghost" onClick={() => setMode(mode === 'changes' ? null : 'changes')}>
          Ask for changes
        </button>
        <button className="btn-ghost" onClick={() => setMode(mode === 'followup' ? null : 'followup')}>
          Follow-up
        </button>
        {failed && (
          <button className="btn-danger ml-auto" onClick={() => api.deleteTask(task.id)}>
            Delete
          </button>
        )}
      </div>

      {mode && (
        <form
          className="mt-2 flex gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <input
            autoFocus
            className="field"
            placeholder={mode === 'changes' ? 'What should change?' : 'Describe the follow-up task'}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setMode(null)}
          />
          <button className="btn-run">{mode === 'changes' ? 'Send' : 'Queue'}</button>
        </form>
      )}
    </article>
  );
}

function ReviewNote({ verdict }: { verdict: string }) {
  const ok = verdict.startsWith('✅');
  const notes = verdict.replace(/^(✅ Looks good|⚠️ Concerns)\s*—\s*/, '');
  return (
    <p className="mt-2 text-[12.5px] text-muted">
      <span className={`font-semibold ${ok ? 'text-done' : 'text-signal'}`}>{ok ? 'Review: looks good.' : 'Review: concerns.'}</span> {notes}
    </p>
  );
}
