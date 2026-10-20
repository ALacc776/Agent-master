// Types shared by the server and the dashboard.

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'needs_input'
  | 'stalled'
  | 'done'
  | 'accepted'
  | 'failed'
  | 'stopped';

export type CreatedBy = 'user' | 'master';

// What happens when a task finishes: merge it in, hold it for review, or open a pull request.
export type OnDone = 'merge' | 'review' | 'pr';

export interface Project {
  id: number;
  name: string;
  path: string;
  isGit: boolean;
}

export interface Task {
  id: number;
  title: string;
  brief: string;
  projectId: number | null;
  model: string;
  status: TaskStatus;
  autoStart: boolean;
  dependsOn: number | null;
  position: number;
  sessionId: string | null;
  worktree: string | null;
  branch: string | null;
  baseBranch: string | null;
  costUsd: number;
  tokens: number;
  turns: number; // model turns in the current session
  modelReason: string | null;
  onDone: OnDone;
  outcome: string | null; // e.g. "Merged into main", a PR URL, or why it needs review
  statusLine: string;
  filesTouched: string[];
  flags: string[]; // 'stalled' | 'looping' | 'collision'
  summary: string | null;
  diffStat: string | null;
  reviewVerdict: string | null;
  createdBy: CreatedBy;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  lastEventAt: number | null;
}

export type InboxKind =
  | 'permission'
  | 'question'
  | 'stalled'
  | 'loop'
  | 'collision'
  | 'failed'
  | 'context'
  | 'review';

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface InboxDetail {
  toolName?: string;
  input?: Record<string, unknown>;
  command?: string;
  path?: string;
  reason?: string;
  questions?: { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean }[];
  message?: string;
}

export interface InboxItem {
  id: number;
  taskId: number | null;
  kind: InboxKind;
  title: string;
  detail: InboxDetail;
  suggestedAnswer: string | null;
  status: 'open' | 'answered' | 'dismissed';
  answer: string | null;
  createdAt: number;
}

export interface Rule {
  id: number;
  kind: 'permission' | 'question';
  tool: string | null;
  pattern: string;
  decision: 'allow' | 'deny' | null;
  answer: string | null;
  createdAt: number;
}

export interface Preference {
  id: number;
  text: string;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  type: 'assistant' | 'tool' | 'tool_result' | 'user' | 'system' | 'result' | 'error' | 'permission';
  text: string;
  ts: number;
}

export interface MasterMessage {
  id: number;
  role: 'user' | 'master' | 'system';
  text: string;
  ts: number;
}

export interface Settings {
  masterModel: string;
  workerModel: string;
  reviewerModel: string;
  cheapModel: string;
  maxConcurrent: number;
  dailyCapUsd: number;
  reviewerEnabled: boolean;
  autoAllowEdits: boolean;
  autoAllowSafeBash: boolean;
  stallMinutes: number;
  turnWarning: number;
  autoMode: boolean;
  defaultOnDone: OnDone;
  ntfyTopic: string;
  macNotifications: boolean;
  lanAccess: boolean;
  accessToken: string;
  paused: boolean;
}

export interface Snapshot {
  projects: Project[];
  tasks: Task[];
  inbox: InboxItem[];
  rules: Rule[];
  preferences: Preference[];
  master: MasterMessage[];
  masterBusy: boolean;
  masterQueue: number;
  settings: Settings;
  spentToday: number;
}

export type WsMessage =
  | { type: 'snapshot'; data: Snapshot }
  | { type: 'task'; data: Task }
  | { type: 'task_removed'; id: number }
  | { type: 'inbox'; data: InboxItem }
  | { type: 'event'; data: TaskEvent }
  | { type: 'master_message'; data: MasterMessage }
  | { type: 'master_state'; busy: boolean; queue: number }
  | { type: 'settings'; data: Settings }
  | { type: 'projects'; data: Project[] }
  | { type: 'rules'; data: Rule[] }
  | { type: 'preferences'; data: Preference[] }
  | { type: 'spent'; value: number }
  | { type: 'toast'; text: string };

export interface DirEntry {
  name: string;
  path: string;
  isGit: boolean;
}

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: DirEntry[];
  isGit: boolean;
}

export interface SearchHit {
  kind: 'task' | 'event' | 'master';
  taskId: number | null;
  text: string;
  ts: number;
}

export const MODELS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
} as const;
