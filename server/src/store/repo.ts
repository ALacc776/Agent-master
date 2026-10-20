import type { DatabaseSync } from 'node:sqlite';
import type {
  InboxItem,
  MasterMessage,
  Preference,
  Project,
  Rule,
  SearchHit,
  Settings,
  Task,
  TaskEvent,
} from '../../../shared/types.ts';
import { MODELS } from '../../../shared/types.ts';
import { randomBytes } from 'node:crypto';

type Row = Record<string, any>;

export const DEFAULT_SETTINGS: Settings = {
  masterModel: MODELS.haiku,
  workerModel: MODELS.sonnet,
  reviewerModel: MODELS.haiku,
  cheapModel: MODELS.haiku,
  maxConcurrent: 4,
  dailyCapUsd: 20,
  reviewerEnabled: true,
  autoAllowEdits: true,
  autoAllowSafeBash: true,
  stallMinutes: 10,
  turnWarning: 100,
  ntfyTopic: '',
  macNotifications: true,
  lanAccess: false,
  accessToken: '',
  paused: false,
};

const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export const today = () => new Date().toLocaleDateString('en-CA');

function toTask(r: Row): Task {
  return {
    id: r.id,
    title: r.title,
    brief: r.brief,
    projectId: r.project_id ?? null,
    model: r.model,
    status: r.status,
    autoStart: !!r.auto_start,
    dependsOn: r.depends_on ?? null,
    position: r.position,
    sessionId: r.session_id ?? null,
    worktree: r.worktree ?? null,
    branch: r.branch ?? null,
    baseBranch: r.base_branch ?? null,
    costUsd: r.cost_usd,
    tokens: r.tokens,
    turns: r.turns ?? 0,
    modelReason: r.model_reason ?? null,
    statusLine: r.status_line,
    filesTouched: parse(r.files_touched, []),
    flags: parse(r.flags, []),
    summary: r.summary ?? null,
    diffStat: r.diff_stat ?? null,
    reviewVerdict: r.review_verdict ?? null,
    createdBy: r.created_by,
    createdAt: r.created_at,
    startedAt: r.started_at ?? null,
    finishedAt: r.finished_at ?? null,
    lastEventAt: r.last_event_at ?? null,
  };
}

const TASK_COLUMNS: Record<string, string> = {
  title: 'title',
  brief: 'brief',
  projectId: 'project_id',
  model: 'model',
  status: 'status',
  autoStart: 'auto_start',
  dependsOn: 'depends_on',
  position: 'position',
  sessionId: 'session_id',
  worktree: 'worktree',
  branch: 'branch',
  baseBranch: 'base_branch',
  costUsd: 'cost_usd',
  tokens: 'tokens',
  turns: 'turns',
  modelReason: 'model_reason',
  statusLine: 'status_line',
  filesTouched: 'files_touched',
  flags: 'flags',
  summary: 'summary',
  diffStat: 'diff_stat',
  reviewVerdict: 'review_verdict',
  createdBy: 'created_by',
  startedAt: 'started_at',
  finishedAt: 'finished_at',
  lastEventAt: 'last_event_at',
};

function toDb(key: string, v: unknown): any {
  if (key === 'filesTouched' || key === 'flags') return json(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v ?? null;
}

function toInbox(r: Row): InboxItem {
  return {
    id: r.id,
    taskId: r.task_id ?? null,
    kind: r.kind,
    title: r.title,
    detail: parse(r.detail, {}),
    suggestedAnswer: r.suggested_answer ?? null,
    status: r.status,
    answer: r.answer ?? null,
    createdAt: r.created_at,
  };
}

export class Repo {
  constructor(readonly db: DatabaseSync) {}

  // ---------- projects
  listProjects(): Project[] {
    return (this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Row[]).map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path,
      isGit: !!r.is_git,
    }));
  }
  getProject(id: number | null | undefined): Project | undefined {
    if (id == null) return undefined;
    return this.listProjects().find((p) => p.id === id);
  }
  findProject(nameOrPath: string): Project | undefined {
    const q = nameOrPath.toLowerCase();
    const all = this.listProjects();
    return (
      all.find((p) => p.name.toLowerCase() === q || p.path === nameOrPath) ??
      all.find((p) => p.name.toLowerCase().includes(q))
    );
  }
  addProject(name: string, path: string, isGit: boolean): Project {
    this.db
      .prepare('INSERT INTO projects (name, path, is_git) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET name = excluded.name, is_git = excluded.is_git')
      .run(name, path, isGit ? 1 : 0);
    return this.listProjects().find((p) => p.path === path)!;
  }
  removeProject(id: number) {
    this.db.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id);
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  // ---------- tasks
  createTask(t: {
    title: string;
    brief: string;
    projectId: number | null;
    model: string;
    modelReason?: string | null;
    autoStart?: boolean;
    dependsOn?: number | null;
    createdBy: 'user' | 'master';
  }): Task {
    const pos = (this.db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM tasks').get() as Row).p;
    const res = this.db
      .prepare(
        `INSERT INTO tasks (title, brief, project_id, model, model_reason, status, auto_start, depends_on, position, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
      )
      .run(t.title, t.brief, t.projectId, t.model, t.modelReason ?? null, t.autoStart ? 1 : 0, t.dependsOn ?? null, pos, t.createdBy, Date.now());
    const task = this.getTask(Number(res.lastInsertRowid))!;
    this.index('task', task.id, `#${task.id} ${task.title}\n${task.brief}`);
    return task;
  }
  getTask(id: number): Task | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }
  listTasks(): Task[] {
    return (this.db.prepare("SELECT * FROM tasks WHERE status != 'accepted' OR finished_at > ? ORDER BY position").all(Date.now() - 7 * 864e5) as Row[]).map(toTask);
  }
  updateTask(id: number, patch: Partial<Task>): Task {
    const keys = Object.keys(patch).filter((k) => TASK_COLUMNS[k]);
    if (keys.length) {
      const sql = `UPDATE tasks SET ${keys.map((k) => `${TASK_COLUMNS[k]} = ?`).join(', ')} WHERE id = ?`;
      this.db.prepare(sql).run(...keys.map((k) => toDb(k, (patch as any)[k])), id);
    }
    return this.getTask(id)!;
  }
  deleteTask(id: number) {
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM events WHERE task_id = ?').run(id);
    this.db.prepare("UPDATE inbox SET status = 'dismissed' WHERE task_id = ? AND status = 'open'").run(id);
  }

  // ---------- inbox
  addInbox(i: { taskId: number | null; kind: InboxItem['kind']; title: string; detail?: InboxItem['detail'] }): InboxItem {
    const res = this.db
      .prepare('INSERT INTO inbox (task_id, kind, title, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(i.taskId, i.kind, i.title, json(i.detail ?? {}), Date.now());
    return this.getInbox(Number(res.lastInsertRowid))!;
  }
  getInbox(id: number): InboxItem | undefined {
    const r = this.db.prepare('SELECT * FROM inbox WHERE id = ?').get(id) as Row | undefined;
    return r ? toInbox(r) : undefined;
  }
  listInbox(includeClosedSince = Date.now() - 3600e3): InboxItem[] {
    return (
      this.db
        .prepare("SELECT * FROM inbox WHERE status = 'open' OR created_at > ? ORDER BY created_at")
        .all(includeClosedSince) as Row[]
    ).map(toInbox);
  }
  openInbox(): InboxItem[] {
    return (this.db.prepare("SELECT * FROM inbox WHERE status = 'open' ORDER BY created_at").all() as Row[]).map(toInbox);
  }
  updateInbox(id: number, patch: Partial<Pick<InboxItem, 'status' | 'answer' | 'suggestedAnswer'>>): InboxItem {
    if (patch.status !== undefined) this.db.prepare('UPDATE inbox SET status = ? WHERE id = ?').run(patch.status, id);
    if (patch.answer !== undefined) this.db.prepare('UPDATE inbox SET answer = ? WHERE id = ?').run(patch.answer, id);
    if (patch.suggestedAnswer !== undefined)
      this.db.prepare('UPDATE inbox SET suggested_answer = ? WHERE id = ?').run(patch.suggestedAnswer, id);
    return this.getInbox(id)!;
  }
  closeTaskInbox(taskId: number, kinds?: InboxItem['kind'][]): InboxItem[] {
    const open = this.openInbox().filter((i) => i.taskId === taskId && (!kinds || kinds.includes(i.kind)));
    return open.map((i) => this.updateInbox(i.id, { status: 'dismissed' }));
  }

  // ---------- rules
  listRules(): Rule[] {
    return (this.db.prepare('SELECT * FROM rules ORDER BY id').all() as Row[]).map((r) => ({
      id: r.id,
      kind: r.kind,
      tool: r.tool ?? null,
      pattern: r.pattern,
      decision: r.decision ?? null,
      answer: r.answer ?? null,
      createdAt: r.created_at,
    }));
  }
  addRule(r: Omit<Rule, 'id' | 'createdAt'>): Rule {
    this.db
      .prepare('INSERT INTO rules (kind, tool, pattern, decision, answer, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.kind, r.tool, r.pattern, r.decision, r.answer, Date.now());
    return this.listRules().at(-1)!;
  }
  removeRule(id: number) {
    this.db.prepare('DELETE FROM rules WHERE id = ?').run(id);
  }

  // ---------- preferences
  listPreferences(): Preference[] {
    return this.db.prepare('SELECT id, text FROM preferences ORDER BY id').all() as unknown as Preference[];
  }
  addPreference(text: string): Preference {
    this.db.prepare('INSERT INTO preferences (text) VALUES (?)').run(text);
    return this.listPreferences().at(-1)!;
  }
  removePreference(id: number) {
    this.db.prepare('DELETE FROM preferences WHERE id = ?').run(id);
  }

  // ---------- events
  addEvent(taskId: number, type: TaskEvent['type'], text: string): TaskEvent {
    const ts = Date.now();
    const res = this.db.prepare('INSERT INTO events (task_id, type, text, ts) VALUES (?, ?, ?, ?)').run(taskId, type, text, ts);
    if (type === 'assistant' || type === 'result') this.index('event', taskId, text, ts);
    return { id: Number(res.lastInsertRowid), taskId, type, text, ts };
  }
  listEvents(taskId: number, limit = 500): TaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT ?')
      .all(taskId, limit) as Row[];
    return rows.reverse().map((r) => ({ id: r.id, taskId: r.task_id, type: r.type, text: r.text, ts: r.ts }));
  }
  eventsSince(ts: number, limit = 400): TaskEvent[] {
    return (
      this.db.prepare("SELECT * FROM events WHERE ts > ? AND type IN ('assistant','result','error','permission') ORDER BY id DESC LIMIT ?").all(ts, limit) as Row[]
    )
      .reverse()
      .map((r) => ({ id: r.id, taskId: r.task_id, type: r.type, text: r.text, ts: r.ts }));
  }

  // ---------- master chat
  addMasterMessage(role: MasterMessage['role'], text: string): MasterMessage {
    const ts = Date.now();
    const res = this.db.prepare('INSERT INTO master_messages (role, text, ts) VALUES (?, ?, ?)').run(role, text, ts);
    this.index('master', null, text, ts);
    return { id: Number(res.lastInsertRowid), role, text, ts };
  }
  listMasterMessages(limit = 200): MasterMessage[] {
    return (this.db.prepare('SELECT * FROM master_messages ORDER BY id DESC LIMIT ?').all(limit) as Row[])
      .reverse()
      .map((r) => ({ id: r.id, role: r.role, text: r.text, ts: r.ts }));
  }

  // ---------- spend
  addSpend(taskId: number | null, usd: number) {
    if (usd > 0) this.db.prepare('INSERT INTO spend (day, task_id, usd) VALUES (?, ?, ?)').run(today(), taskId, usd);
  }
  spentToday(): number {
    return (this.db.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM spend WHERE day = ?').get(today()) as Row).s;
  }

  // ---------- settings / kv
  getKv(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as Row | undefined)?.value;
  }
  setKv(key: string, value: string) {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }
  getSettings(): Settings {
    const s = { ...DEFAULT_SETTINGS, ...parse<Partial<Settings>>(this.getKv('settings'), {}) };
    if (!s.accessToken) {
      s.accessToken = randomBytes(12).toString('hex');
      this.setKv('settings', json(s));
    }
    return s;
  }
  updateSettings(patch: Partial<Settings>): Settings {
    const s = { ...this.getSettings(), ...patch };
    this.setKv('settings', json(s));
    return s;
  }

  // ---------- search
  index(kind: SearchHit['kind'], taskId: number | null, text: string, ts = Date.now()) {
    this.db.prepare('INSERT INTO search_fts (kind, task_id, ts, text) VALUES (?, ?, ?, ?)').run(kind, taskId, ts, text.slice(0, 4000));
  }
  search(q: string): SearchHit[] {
    const terms = q
      .split(/\s+/)
      .map((t) => t.replace(/["*]/g, ''))
      .filter(Boolean)
      .map((t) => `"${t}"*`)
      .join(' ');
    if (!terms) return [];
    return (
      this.db
        .prepare("SELECT kind, task_id, ts, snippet(search_fts, 3, '«', '»', '…', 16) AS text FROM search_fts WHERE search_fts MATCH ? ORDER BY rank LIMIT 40")
        .all(terms) as Row[]
    ).map((r) => ({ kind: r.kind, taskId: r.task_id ?? null, ts: Number(r.ts), text: r.text }));
  }
}
