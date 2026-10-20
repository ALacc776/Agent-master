import { useSyncExternalStore } from 'react';
import type { Snapshot, TaskEvent, WsMessage } from '../../shared/types.ts';

export interface State extends Snapshot {
  connected: boolean;
  events: Record<number, TaskEvent[]>;
  toasts: { id: number; text: string }[];
  selected: string | null; // 'inbox:5' | 'task:3'
  drawer: number | null;
  modal: null | 'settings' | 'search' | 'new' | { diff: number } | { folder: 'settings' | 'chat' };
  buildProjectId: number | null; // project the chat is pointed at
  view: View;
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
  masterBusy: false,
  masterQueue: 0,
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
};

export type View = 'board' | 'split' | 'master';

function readView(): View {
  try {
    const v = localStorage.getItem('masterView');
    return v === 'board' || v === 'master' ? v : 'split';
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
      return setState({ ...msg.data });
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
      return setState((s) => ({ master: [...s.master, msg.data].slice(-300) }));
    case 'master_state':
      return setState({ masterBusy: msg.busy, masterQueue: msg.queue });
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
  }
}
