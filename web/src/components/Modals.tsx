import { useEffect, useState } from 'react';
import { api } from '../api.ts';
import { pushToast, setState, useStore } from '../store.ts';
import { Modal, modelLabel, ago } from '../ui.tsx';
import { MODELS, type SearchHit } from '../../../shared/types.ts';

const close = () => setState({ modal: null });

const TEMPLATES: Record<string, string> = {
  Feature: 'Goal: \nContext: \nScope: \nDone when: tests pass and ',
  Bugfix: 'Goal: fix \nReproduce: \nContext: \nRoot cause first, then fix.\nDone when: the bug no longer reproduces and tests pass.',
  Refactor: 'Goal: refactor \nScope: \nNo behavior changes; keep tests green.\nDone when: ',
  Blank: '',
};

export function NewTaskModal() {
  const projects = useStore((s) => s.projects);
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState(TEMPLATES.Feature);
  const buildProjectId = useStore((s) => s.buildProjectId);
  const [projectId, setProjectId] = useState<number | null>(projects.some((p) => p.id === buildProjectId) ? buildProjectId : (projects[0]?.id ?? null));
  const [model, setModel] = useState('auto');

  const create = async (start: boolean) => {
    if (!title.trim()) return pushToast('Give the task a title');
    const { task, waiting } = await api.createTask({ title: title.trim(), brief, projectId, model, start });
    pushToast(start ? (waiting ? `#${task.id}: ${waiting}` : `Started #${task.id}`) : `Queued #${task.id}`);
    close();
  };

  return (
    <Modal onClose={close}>
      <div className="space-y-3 p-5">
        <h2 className="text-[17px] font-semibold">New task</h2>
        <input autoFocus className="field" placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="flex gap-1">
          {Object.keys(TEMPLATES).map((k) => (
            <button key={k} className="btn-ghost" onClick={() => setBrief(TEMPLATES[k])}>
              {k}
            </button>
          ))}
        </div>
        <textarea className="field min-h-[180px]" value={brief} onChange={(e) => setBrief(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <select className="field" value={projectId ?? ''} onChange={(e) => setProjectId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No project (scratch folder)</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="auto">Auto (pick by difficulty)</option>
            {Object.values(MODELS).map((m) => (
              <option key={m} value={m}>
                {modelLabel(m)}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button className="btn-ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn-line" onClick={() => create(false)}>
            Add to queue
          </button>
          <button className="btn-run" onClick={() => create(true)}>
            Start now
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function SearchModal() {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!q.trim()) return setHits([]);
    const t = setTimeout(() => api.search(q).then(setHits).catch(() => {}), 200);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <Modal onClose={close}>
      <div className="p-4">
        <input autoFocus className="field text-[15px]" placeholder="Search tasks, agent output and master chat" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="mt-3 space-y-1">
          {hits.map((h, i) => (
            <li key={i}>
              <button
                className="w-full rounded-md px-2.5 py-2 text-left hover:bg-raised"
                onClick={() => setState(h.taskId != null ? { modal: null, drawer: h.taskId } : { modal: null })}
              >
                <div className="flex gap-2 text-[11.5px] text-faint">
                  <span>{h.kind === 'master' ? 'Master chat' : `Agent #${h.taskId}`}</span>
                  <span>{ago(h.ts)} ago</span>
                </div>
                <div className="text-[13px] text-ink/90">{h.text}</div>
              </button>
            </li>
          ))}
          {q && !hits.length && <li className="px-2.5 py-2 text-[13px] text-faint">No matches.</li>}
        </ul>
      </div>
    </Modal>
  );
}

export function DiffModal({ taskId }: { taskId: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  useEffect(() => {
    api.diff(taskId).then((d) => setDiff(d.diff));
  }, [taskId]);
  return (
    <Modal onClose={close} wide>
      <div className="hairline flex items-center justify-between px-5 py-3.5">
        <h2 className="font-display text-[16px] font-semibold">Diff for #{taskId}</h2>
        <button className="btn-ghost" onClick={close}>
          Close
        </button>
      </div>
      <pre className="overflow-x-auto p-4 font-mono text-[12px] leading-[1.5]">
        {diff === null
          ? 'Loading…'
          : diff
            ? diff.split('\n').map((l, i) => (
                <div
                  key={i}
                  className={
                    l.startsWith('+++') || l.startsWith('---')
                      ? 'text-muted'
                      : l.startsWith('+')
                        ? 'bg-done/10 text-done'
                        : l.startsWith('-')
                          ? 'bg-danger/10 text-danger'
                          : l.startsWith('@@')
                            ? 'text-queue'
                            : l.startsWith('diff ')
                              ? 'mt-3 font-semibold text-ink'
                              : 'text-ink/75'
                  }
                >
                  {l || ' '}
                </div>
              ))
            : 'No changes.'}
      </pre>
    </Modal>
  );
}

export function DigestBanner() {
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    let last = 0;
    try {
      last = Number(localStorage.getItem('masterLastSeen') ?? 0);
    } catch {
      /* storage unavailable */
    }
    const mark = () => {
      try {
        localStorage.setItem('masterLastSeen', String(Date.now()));
      } catch {
        /* ignore */
      }
    };
    const check = (since: number) => {
      if (since && Date.now() - since > 30 * 60_000) api.digest(since).then((d) => setDigest(d.text)).catch(() => {});
    };
    check(last);
    mark();
    const iv = setInterval(mark, 60_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        let prev = 0;
        try {
          prev = Number(localStorage.getItem('masterLastSeen') ?? 0);
        } catch {
          /* ignore */
        }
        check(prev);
        mark();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);
  if (!digest) return null;
  return (
    <div className="card mx-5 mt-3 px-4 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[14px] font-semibold">While you were away</h2>
        <button className="btn-ghost" onClick={() => setDigest(null)}>
          Got it
        </button>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-[13px] text-ink/85">{digest}</p>
    </div>
  );
}
