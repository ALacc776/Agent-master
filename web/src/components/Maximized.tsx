import { useEffect, useRef } from 'react';
import { setMaximized, useStore } from '../store.ts';
import { AgentTile } from './AgentsView.tsx';
import { ConsolePanel } from './ConsolePanel.tsx';
import { MasterPanel } from './MasterChat.tsx';
import { PlanPanel } from './PlanPanel.tsx';

// A panel or agent blown up into a big centered popup. Esc or clicking outside goes back.
export function Maximized() {
  const target = useStore((s) => s.maximized);
  const tasks = useStore((s) => s.tasks);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, textarea')) setMaximized(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [target]);

  if (!target) return null;
  const task = target.kind === 'agent' ? tasks.find((t) => t.id === target.id) : undefined;
  if (target.kind === 'agent' && !task) return null;

  return (
    <div className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[3px]" onMouseDown={() => setMaximized(null)}>
      <div
        role="dialog"
        aria-modal="true"
        className="absolute inset-x-[3vw] inset-y-[4vh] flex flex-col overflow-hidden rounded-sheet bg-panel shadow-sheet [&_aside]:border-0 [&_aside]:bg-transparent"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {target.kind === 'plan' && <PlanPanel big />}
        {target.kind === 'master' && <MasterPanel inputRef={inputRef} />}
        {target.kind === 'console' && <ConsolePanel big />}
        {task && <AgentTile task={task} big />}
      </div>
    </div>
  );
}
