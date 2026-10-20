import { apply, pushToast, setState } from './store.ts';
import type { DirListing, Project, SearchHit, Settings, Task, TaskEvent } from '../../shared/types.ts';

// Access token for phone/LAN use: pass ?token=… once, it's remembered.
function token(): string {
  try {
    const fromUrl = new URLSearchParams(location.search).get('token');
    if (fromUrl) localStorage.setItem('masterToken', fromUrl);
    return fromUrl ?? localStorage.getItem('masterToken') ?? '';
  } catch {
    return '';
  }
}

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), 'x-master-token': token() },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    pushToast(data.error ?? `Request failed (${res.status})`);
    throw new Error(data.error);
  }
  return data as T;
}

export const api = {
  sendMaster: (text: string, projectId: number | null) => call('POST', '/api/master/message', { text, projectId }),
  resetMaster: () => call('POST', '/api/master/reset'),
  createTask: (t: { title: string; brief: string; projectId: number | null; model: string; start?: boolean; dependsOn?: number | null }) =>
    call<{ task: Task; waiting: string | null }>('POST', '/api/tasks', t),
  updateTask: (id: number, patch: Partial<Task>) => call('PATCH', `/api/tasks/${id}`, patch),
  deleteTask: (id: number) => call('DELETE', `/api/tasks/${id}`),
  start: (id: number) => call<{ waiting: string | null }>('POST', `/api/tasks/${id}/start`),
  startAll: () => call<{ started: number }>('POST', '/api/tasks/start-all'),
  stop: (id: number) => call('POST', `/api/tasks/${id}/stop`),
  pause: (id: number) => call('POST', `/api/tasks/${id}/pause`),
  message: (id: number, text: string) => call<{ result: string }>('POST', `/api/tasks/${id}/message`, { text }),
  changes: (id: number, text: string) => call<{ result: string }>('POST', `/api/tasks/${id}/changes`, { text }),
  followUp: (id: number, text: string) => call<Task>('POST', `/api/tasks/${id}/followup`, { text }),
  accept: (id: number) => call('POST', `/api/tasks/${id}/accept`),
  merge: (id: number) => call('POST', `/api/tasks/${id}/merge`),
  pr: (id: number) => call<{ url: string }>('POST', `/api/tasks/${id}/pr`),
  events: (id: number) => call<TaskEvent[]>('GET', `/api/tasks/${id}/events`),
  diff: (id: number) => call<{ diff: string }>('GET', `/api/tasks/${id}/diff`),
  answer: (id: number, answer: string, remember = false) => call<{ result: string }>('POST', `/api/inbox/${id}/answer`, { answer, remember }),
  dismiss: (id: number) => call('POST', `/api/inbox/${id}/dismiss`),
  settings: (patch: Partial<Settings>) => call<{ settings: Settings; restartNeeded: boolean }>('PATCH', '/api/settings', patch),
  pauseAll: (paused: boolean) => call('POST', '/api/pause', { paused }),
  addProject: (path: string, name?: string) => call<Project>('POST', '/api/projects', { path, name }),
  listDirs: (path: string) => call<DirListing>('GET', `/api/fs/list?path=${encodeURIComponent(path)}`),
  chooseFolder: () => call<{ path: string | null }>('POST', '/api/fs/choose'),
  fresh: (id: number) => call<{ result: string }>('POST', `/api/tasks/${id}/fresh`),
  removeProject: (id: number) => call('DELETE', `/api/projects/${id}`),
  removeRule: (id: number) => call('DELETE', `/api/rules/${id}`),
  addPreference: (text: string) => call('POST', '/api/preferences', { text }),
  removePreference: (id: number) => call('DELETE', `/api/preferences/${id}`),
  search: (q: string) => call<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
  digest: (since: number) => call<{ text: string; counts: Record<string, number> }>('GET', `/api/digest?since=${since}`),
};

export async function loadEvents(taskId: number) {
  const events = await api.events(taskId);
  setState((s) => ({ events: { ...s.events, [taskId]: events } }));
}

export function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(token())}`);
  ws.onopen = () => setState({ connected: true });
  ws.onmessage = (e) => apply(JSON.parse(e.data));
  ws.onclose = () => {
    setState({ connected: false });
    setTimeout(connect, 1500);
  };
}
