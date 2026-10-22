import { useSyncExternalStore } from 'react';
import type { OnDone, ProcInfo, Scope, Snapshot, TaskEvent, WsMessage } from '../../shared/types.ts';

export interface State extends Omit<Snapshot, 'procs'> {
  procs: Record<string, ProcInfo>;
  consoleOpen: boolean;
  planOpen: boolean;
  maximized: Maximized | null; // a panel or agent shown as a big popup
  planTaskId: number | null;
  consoleTab: 'run' | 'term';
  consoleHeight: number;
  connected: boolean;
  events: Record<number, TaskEvent[]>;
  toasts: { id: number; text: string }[];
  selected: string | null; // 'inbox:5' | 'task:3'
  drawer: number | null;
  modal: null | 'settings' | 'search' | 'new' | { diff: number } | { folder: 'settings' | 'chat' | 'sidebar' };
  buildProjectId: number | null; // project the chat is pointed at
  view: View;
  scope: Scope; // which master is open: 'boss' or a project id
  sidebar: boolean;
  onDone: OnDone; // "When done" choice for new messages and tasks
  taskModel: string; // "Model" choice for new tasks: 'auto' or a model id
  compact: Record<string, boolean>; // board columns shown as one-line rows
  replyTo: string | null; // card key whose reply box is open
}

let state: State = {
  connected: false,
  projects: [],
  tasks: [],
  inbox: [],
  rules: [],
  preferences: [],
  master: [],
  masters: {},
  procs: {},
  runCommands: {},
  consoleOpen: readKey('masterConsoleOpen', '0') === '1',
  planOpen: readKey('masterPlanOpen', '0') === '1',
  planTaskId: null,
  maximized: null,
  consoleTab: readKey('masterConsoleTab', 'run') === 'term' ? 'term' : 'run',
  consoleHeight: Number(readKey('masterConsoleHeight', '280')) || 280,
  settings: {} as State['settings'],
  spentToday: 0,
  events: {},
  toasts: [],
  selected: null,
  drawer: null,
  modal: null,
  replyTo: null,
  buildProjectId: readBuildProject(),
  view: readView(),
  scope: readKey('masterScope', 'boss'),
  sidebar: readKey('masterSidebar', '1') === '1',
  onDone: readOnDone(),
  taskModel: readKey('masterTaskModel', 'auto'),
  compact: (() => {
    try {
      return JSON.parse(localStorage.getItem('masterCompact') ?? '{}');
    } catch {
      return {};
    }
  })(),
};

export function toggleCompact(column: string) {
  const compact = { ...state.compact, [column]: !state.compact[column] };
  setState({ compact });
  try {
    localStorage.setItem('masterCompact', JSON.stringify(compact));
  } catch {
    /* storage unavailable */
  }
}

function readKey(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

export type Maximized = { kind: 'plan' } | { kind: 'master' } | { kind: 'console' } | { kind: 'agent'; id: number };

export function setMaximized(maximized: Maximized | null) {
  setState({ maximized });
}

export function setPlan(patch: Partial<Pick<State, 'planOpen' | 'planTaskId'>>) {
  setState(patch);
  try {
    if (patch.planOpen !== undefined) localStorage.setItem('masterPlanOpen', patch.planOpen ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export function setConsole(patch: Partial<Pick<State, 'consoleOpen' | 'consoleTab' | 'consoleHeight'>>) {
  setState(patch);
  try {
    if (patch.consoleOpen !== undefined) localStorage.setItem('masterConsoleOpen', patch.consoleOpen ? '1' : '0');
    if (patch.consoleTab) localStorage.setItem('masterConsoleTab', patch.consoleTab);
    if (patch.consoleHeight) localStorage.setItem('masterConsoleHeight', String(patch.consoleHeight));
  } catch {
    /* storage unavailable */
  }
}

/** Append streamed text to a line buffer whose last entry is the line still being written. */
function appendText(lines: string[], text: string) {
  const out = lines.slice();
  const parts = text.split('\n');
  if (!out.length) out.push('');
  out[out.length - 1] += parts.shift() ?? '';
  out.push(...parts);
  return out.length > 2000 ? out.slice(-2000) : out;
}

export function setScope(scope: Scope) {
  setState({ scope, selected: null });
  try {
    localStorage.setItem('masterScope', scope);
  } catch {
    /* storage unavailable */
  }
}

export function toggleSidebar() {
  const sidebar = !state.sidebar;
  setState({ sidebar });
  try {
    localStorage.setItem('masterSidebar', sidebar ? '1' : '0');
  } catch {
    /* storage unavailable */
  }
}

export function setTaskModel(taskModel: string) {
  setState({ taskModel });
  try {
    localStorage.setItem('masterTaskModel', taskModel);
  } catch {
    /* storage unavailable */
  }
}

function readOnDone(): OnDone {
  try {
    const v = localStorage.getItem('masterOnDone');
    return v === 'review' || v === 'pr' || v === 'keep' ? v : 'merge';
  } catch {
    return 'merge';
  }
}

export function setOnDone(onDone: OnDone) {
  setState({ onDone });
  try {
    localStorage.setItem('masterOnDone', onDone);
  } catch {
    /* storage unavailable */
  }
}

export type View = 'board' | 'split' | 'master' | 'agents';

function readView(): View {
  try {
    const v = localStorage.getItem('masterView');
    return v === 'board' || v === 'master' || v === 'agents' ? v : 'split';
  } catch {
    return 'split';
  }
}

export function setView(view: View) {
  setState({ view });
  try {
    localStorage.setItem('masterView', view);
  } catch {
    /* storage unavailable */
  }
}

function readBuildProject(): number | null {
  try {
    const v = localStorage.getItem('masterBuildProject');
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

export function setBuildProject(id: number | null) {
  setState({ buildProjectId: id });
  try {
    if (id == null) localStorage.removeItem('masterBuildProject');
    else localStorage.setItem('masterBuildProject', String(id));
  } catch {
    /* storage unavailable */
  }
}

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  emit();
}

export function useStore<T>(select: (s: State) => T): T {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => select(state),
  );
}

export const getState = () => state;

const upsert = <T extends { id: number }>(list: T[], item: T) => {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [...list, item];
  const next = list.slice();
  next[i] = item;
  return next;
};

let toastId = 0;
export function pushToast(text: string) {
  const id = ++toastId;
  setState((s) => ({ toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 5000);
}

export function apply(msg: WsMessage) {
  switch (msg.type) {
    case 'snapshot':
      // A project that was removed can't stay selected.
      return setState((s) => ({ ...msg.data, procs: Object.fromEntries(msg.data.procs.map((p) => [p.id, p])), scope: s.scope === 'boss' || msg.data.projects.some((p) => String(p.id) === s.scope) ? s.scope : 'boss' }));
    case 'task':
      return setState((s) => ({ tasks: upsert(s.tasks, msg.data).sort((a, b) => a.position - b.position) }));
    case 'task_removed':
      return setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== msg.id) }));
    case 'inbox':
      return setState((s) => ({ inbox: upsert(s.inbox, msg.data) }));
    case 'event':
      return setState((s) => {
        const cur = s.events[msg.data.taskId];
        if (!cur) return {};
        return { events: { ...s.events, [msg.data.taskId]: [...cur, msg.data].slice(-1500) } };
      });
    case 'master_message':
      return setState((s) => ({ master: [...s.master, msg.data].slice(-1500) }));
    case 'master_state':
      return setState((s) => ({ masters: { ...s.masters, [msg.scope]: msg.state } }));
    case 'settings':
      return setState({ settings: msg.data });
    case 'projects':
      return setState({ projects: msg.data });
    case 'rules':
      return setState({ rules: msg.data });
    case 'preferences':
      return setState({ preferences: msg.data });
    case 'spent':
      return setState({ spentToday: msg.value });
    case 'toast':
      return pushToast(msg.text);
    case 'proc':
      return setState((s) => ({ procs: { ...s.procs, [msg.data.id]: { ...msg.data, lines: s.procs[msg.data.id]?.lines ?? msg.data.lines } } }));
    case 'proc_output':
      return setState((s) => {
        const p = s.procs[msg.id];
        if (!p) return {};
        return { procs: { ...s.procs, [msg.id]: { ...p, lines: appendText(p.lines, msg.text) } } };
      });
    case 'procs_cleared':
      return setState((s) => ({ procs: Object.fromEntries(Object.entries(s.procs).filter(([, p]) => !(p.kind === 'term' && p.projectId === msg.projectId && p.status !== 'running'))) }));
    case 'run_command':
      return setState((s) => ({ runCommands: { ...s.runCommands, [String(msg.projectId)]: msg.command } }));
  }
}
