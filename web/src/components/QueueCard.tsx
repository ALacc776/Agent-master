import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { modelLabel, useTask } from '../ui.tsx';
import { MODELS, type Task } from '../../../shared/types.ts';

export function QueueCard({ task, onDragStart }: { task: Task; onDragStart: (id: number) => void }) {
  const key = `task:${task.id}`;
  const selected = useStore((s) => s.selected === key);
  const projects = useStore((s) => s.projects);
  const tasks = useStore((s) => s.tasks);
  const dep = useTask(task.dependsOn);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [brief, setBrief] = useState(task.brief);
  useEffect(() => setTitle(task.title), [task.title]);
  useEffect(() => setBrief(task.brief), [task.brief]);

  const waiting = task.autoStart && task.status === 'queued';
  const paused = task.flags.includes('paused');

  const start = async () => {
    const r = await api.start(task.id);
    if (r.waiting) pushToast(`#${task.id}: ${r.waiting}`);
  };
  const save = (patch: Partial<Task>) => api.updateTask(task.id, patch);

  return (
    <article
      data-key={key}
      draggable={!open}
      onDragStart={() => onDragStart(task.id)}
      onClick={() => setState({ selected: key })}
      className={`group card p-3.5 ${selected ? 'ring-2 ring-run/45' : ''}`}
    >
      <header className="flex items-start gap-2">
        <span className="text-[14px] font-semibold tabular-nums text-faint">#{task.id}</span>
        {open ? (
          <input className="field py-0.5" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== task.title && save({ title })} />
        ) : (
          <button className="min-w-0 flex-1 truncate text-left text-[14px] font-semibold" onClick={() => setOpen(true)} title="Edit">
            {task.title}
          </button>
        )}
      </header>

      {!open && task.brief && <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{task.brief}</p>}

      {open && (
        <div className="mt-2 space-y-2">
          <textarea
            className="field min-h-[140px] font-sans text-[13px]"
            value={brief}
            onChange={(e) => setBrief(e.target.value)}
            onBlur={() => brief !== task.brief && save({ brief })}
          />
          <div className="grid grid-cols-3 gap-1.5">
            <select className="field py-1 text-[12.5px]" value={task.projectId ?? ''} onChange={(e) => save({ projectId: e.target.value ? Number(e.target.value) : null })}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select className="field py-1 text-[12.5px]" value={task.model} onChange={(e) => save({ model: e.target.value })}>
              {Object.values(MODELS).map((m) => (
                <option key={m} value={m}>
                  {modelLabel(m)}
                </option>
              ))}
            </select>
            <select className="field py-1 text-[12.5px]" value={task.dependsOn ?? ''} onChange={(e) => save({ dependsOn: e.target.value ? Number(e.target.value) : null })}>
              <option value="">No dependency</option>
              {tasks
                .filter((t) => t.id !== task.id && t.status !== 'accepted')
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    After #{t.id}
                  </option>
                ))}
            </select>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-1">
        {!open && <span className="chip">{projects.find((p) => p.id === task.projectId)?.name ?? 'No project'}</span>}
        {!open && <span className="chip">{modelLabel(task.model)}</span>}
        {dep && !open && <span className="chip">After #{dep.id}</span>}
        {task.onDone !== 'merge' && <span className="chip">{task.onDone === 'pr' ? 'Opens a PR' : 'You review'}</span>}
        {task.createdBy === 'master' && <span className="chip">From master</span>}
        {paused && <span className="chip text-signal">Paused</span>}
        {task.status === 'stopped' && <span className="chip">Stopped</span>}
      </div>

      {!open && task.modelReason && <p className="mt-1.5 text-[12px] text-faint">{modelLabel(task.model)} because {task.modelReason.replace(/^[A-Z](?![A-Z])/, (c) => c.toLowerCase()).replace(/\.$/, '')}</p>}

      <div className="mt-2.5 flex items-center gap-1">
        {waiting ? (
          <span className="text-[12px] text-muted">{dep && !['done', 'accepted'].includes(dep.status) ? `Starts when #${dep.id} is done` : 'Starts when a slot frees up'}</span>
        ) : (
          <button className="btn-run" onClick={start} title="Start (s)">
            ▶ {paused || task.status === 'stopped' ? 'Resume' : 'Start'}
          </button>
        )}
        {waiting && (
          <button className="btn-ghost" onClick={() => save({ autoStart: false })}>
            Hold
          </button>
        )}
        <button className="btn-ghost" onClick={() => setOpen(!open)}>
          {open ? 'Done editing' : 'Edit'}
        </button>
        <button className="btn-danger ml-auto opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => api.deleteTask(task.id)}>
          Delete
        </button>
      </div>
    </article>
  );
}
