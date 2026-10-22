import { useState } from 'react';
import { api } from '../api.ts';
import { setPlan, setState, useStore } from '../store.ts';
import { ago, parseSuggestion, Rich, useNow, useTask } from '../ui.tsx';
import type { InboxItem } from '../../../shared/types.ts';

const KIND_TEXT: Record<InboxItem['kind'], string> = {
  permission: 'wants permission',
  question: 'has a question',
  stalled: 'looks stuck',
  loop: 'may be looping',
  collision: 'may conflict',
  failed: 'failed',
  context: 'is running long',
  plan: 'has a plan for you',
  review: 'is ready for review',
};

export function NeedsYouCard({ item }: { item: InboxItem }) {
  const key = `inbox:${item.id}`;
  const selected = useStore((s) => s.selected === key);
  const replying = useStore((s) => s.replyTo === key);
  const task = useTask(item.taskId);
  const now = useNow(5000);
  const [remember, setRemember] = useState(false);
  const [reply, setReply] = useState('');
  const suggestion = parseSuggestion(item.suggestedAnswer);
  const closed = item.status !== 'open';

  const answer = (a: string) => api.answer(item.id, a, remember);
  const select = () => setState({ selected: key });

  const isPermission = item.kind === 'permission';
  const isQuestion = item.kind === 'question';

  return (
    <article
      data-key={key}
      onClick={select}
      className={`card p-3.5 ${closed ? 'opacity-50' : 'ring-1 ring-signal/40'} ${selected ? '!ring-2 !ring-signal/70' : ''}`}
    >
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold">
          {item.taskId != null ? (
            <button className="hover:underline" onClick={() => setState({ drawer: item.taskId })}>
              Agent #{item.taskId}
            </button>
          ) : (
            'Master'
          )}{' '}
          <span className="font-sans text-[13px] font-normal text-muted">{KIND_TEXT[item.kind]}</span>
        </h3>
        <span className="shrink-0 text-[11.5px] text-faint" title="Waiting for">
          {ago(item.createdAt, now)}
        </span>
      </header>
      {task && <p className="mt-0.5 truncate text-[12px] text-faint">{task.title}</p>}

      {isPermission && item.detail.command ? (
        <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[10px] bg-base p-2.5 font-mono text-[12px] text-ink/90">{item.detail.command}</pre>
      ) : (
        item.kind !== 'failed' && <p className="mt-2 text-[13.5px]">{isPermission ? `Wants to ${item.title}` : item.title}</p>
      )}
      {isPermission && item.detail.reason && <p className="mt-1 text-[12px] text-faint">{item.detail.reason}</p>}
      {item.kind === 'plan' && item.detail.plan && <Rich text={item.detail.plan} className="mt-2 line-clamp-6 text-[12.5px] text-ink/85" />}
      {item.detail.message && !isPermission && (
        <p className={item.kind === 'failed' ? 'mt-2 whitespace-pre-wrap text-[13px]' : 'mt-1 text-[12px] text-muted'}>{item.detail.message}</p>
      )}

      {closed ? (
        <p className="mt-2 text-[12px] text-muted">{item.status === 'answered' ? `Answered: ${item.answer}` : 'Dismissed'}</p>
      ) : (
        <>
          {isQuestion &&
            item.detail.questions?.map((q) => (
              <div key={q.question} className="mt-2 flex flex-wrap gap-1.5">
                {q.options.map((o) => (
                  <button
                    key={o.label}
                    className={`btn-line ${suggestion?.answer === o.label ? 'border-signal' : ''}`}
                    title={o.description}
                    onClick={() => answer(o.label)}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
            ))}

          {suggestion && (
            <div className="mt-2 rounded-[10px] bg-signal/10 px-3 py-2 text-[12.5px]">
              <span className="text-signal">Suggested: {suggestion.answer}</span>
              {suggestion.why && <span className="text-muted"> because {suggestion.why.replace(/^[A-Z]/, (c) => c.toLowerCase())}</span>}
            </div>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            {suggestion && (
              <button className="btn-signal" onClick={() => answer(suggestion.answer)} title="Accept suggestion (a)">
                Accept suggestion
              </button>
            )}
            {isPermission && (
              <>
                <button className="btn-done" onClick={() => answer('allow')} title="Allow (y)">
                  Allow
                </button>
                <button className="btn-line" onClick={() => answer('deny')} title="Deny (n)">
                  Deny
                </button>
              </>
            )}
            {(item.kind === 'stalled' || item.kind === 'loop') && (
              <button className="btn-line" onClick={() => answer('Status check: what are you stuck on? If you are repeating yourself, step back and try a different approach.')}>
                Nudge
              </button>
            )}
            {item.kind === 'plan' && (
              <>
                <button className="btn-done" onClick={() => answer('approve')}>
                  Approve &amp; build
                </button>
                <button className="btn-line" onClick={() => setPlan({ planOpen: true, planTaskId: item.taskId })}>
                  Open plan
                </button>
              </>
            )}
            {item.kind === 'context' && (
              <>
                <button className="btn-signal" onClick={() => answer('fresh')}>
                  Start fresh session
                </button>
                <button className="btn-line" onClick={() => answer('keep going')}>
                  Keep going
                </button>
              </>
            )}
            {item.kind === 'failed' && (
              <button className="btn-run" onClick={() => answer('retry')}>
                Retry
              </button>
            )}
            {['stalled', 'loop', 'collision', 'context'].includes(item.kind) && (
              <button className="btn-danger" onClick={() => answer('stop')}>
                Stop agent
              </button>
            )}
            <button className="btn-ghost" onClick={() => setState({ replyTo: replying ? null : key })} title="Reply (r)">
              Reply
            </button>
            <button className="btn-ghost ml-auto" onClick={() => api.dismiss(item.id)}>
              Dismiss
            </button>
          </div>

          {(isPermission || isQuestion) && (
            <label className="mt-2 flex w-fit cursor-pointer items-center gap-1.5 text-[12px] text-muted">
              <input type="checkbox" className="accent-signal" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              Remember this answer
            </label>
          )}

          {replying && (
            <form
              className="mt-2 flex gap-1.5"
              onSubmit={(e) => {
                e.preventDefault();
                if (!reply.trim()) return;
                void answer(reply.trim());
                setReply('');
                setState({ replyTo: null });
              }}
            >
              <input
                autoFocus
                className="field"
                placeholder={isPermission ? 'Deny with instructions, e.g. "use the staging DB instead"' : 'Type an answer'}
                value={reply}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => e.key === 'Escape' && setState({ replyTo: null })}
              />
              <button className="btn-run">Send</button>
            </form>
          )}
        </>
      )}
    </article>
  );
}
