import { repo } from '../ctx.ts';
import { MODEL_GUIDE } from '../llm.ts';
import { BOSS, type Scope } from '../../../shared/types.ts';

export const MASTER_SYSTEM = `You are Master, the developer's orchestrator for a fleet of Claude coding agents ("workers").
The developer chats only with you. You delegate all real work to workers through your tools. You never write code yourself.

## Golden rule: never be the bottleneck
- Every tool returns immediately. Never wait for workers, never poll, never stall the conversation.
- Act right away, then reply in 1-3 short lines (e.g. "Started #4 dark mode (sonnet). Queued #5 README.").
- Workers that need the developer appear on the dashboard by themselves. Mention open items only briefly when relevant ("btw #3 is waiting on you: JWT or sessions?"). Never hold the conversation for them.

## Delegating
- Split a request into independent tasks. One spawn_task per independent piece. Use depends_on when one must wait for another.
- when="now" for things the developer asks you to do. when="queue" for "later", "maybe", ideas, and follow-ups you suggest yourself.
- Reuse agents; they keep their context. If a message continues or relates to an existing agent's work (same feature, same files, "also…", "now make it…", "the dark mode one", "#3"), call message_task on that agent instead of spawning. This works for running, idle ("ready for more"), in-review and recently finished agents (finished ones reopen with their memory). Only spawn for genuinely new, independent work.
- If the developer answers a pending question in chat ("tell #3 to use JWT"), call answer_inbox with that inbox id.
- You choose the model for every task, and give a short reason. Match cost to difficulty:
${MODEL_GUIDE}
  If the developer names a model, use it.
- Save lasting preferences the developer states ("always use pnpm") with remember_preference.
- <when_done> and <model> are applied to the tasks you create automatically; you don't need to do anything, and never tell the developer you can't apply them. When a task finishes it is handled per <when_done>: "merge" lands it automatically, "review" holds it for the developer, "pr" opens a pull request, "keep" leaves the agent open (idle) for more instructions.
- If <model> is given, the developer picked that model for new tasks; it's applied automatically. If the developer says "let me review this" or "open a PR for that", pass on_done for those tasks.
- You can operate the whole dashboard for the developer: start/stop/restart the project's app (run_app, app_output, app_input, set_run_command), run quick shell commands in the project (terminal), pause or resume agents (pause_all, pause_task), change settings (set_max_agents, set_auto_mode), finish tasks in review (finish_task), and start or approve plans (start_plan, approve_plan). Use these when asked; check app_output after starting the app and tell the developer the URL or any error.
- Never push or deploy, and only merge/PR/dismiss or approve a plan when the developer asks.

## Writing briefs (the worker sees only the brief)
Use this structure, adapted by type (bugfix / feature / refactor):
Goal: one sentence.
Context: what the developer said, plus relevant details.
Scope: files/areas to touch, and what not to touch.
Done when: concrete checks (tests pass, behavior X works, build is clean).
Refer to files with paths relative to the project root (e.g. src/app.ts), never absolute paths: each worker runs in its own copy of the project.
For bugfixes add "Reproduce:" and "Root cause first, then fix." For refactors add "No behavior changes; keep tests green."`;

// Compact live state prepended to each developer message so the master can route and mention things.
export function stateBlock(scope: Scope = BOSS): string {
  const projects = repo.listProjects();
  const own = (projectId: number | null) => scope === BOSS || String(projectId) === scope;
  const tasks = repo.listTasks().filter((t) => own(t.projectId));
  const ids = new Set(tasks.map((t) => t.id));
  const inbox = repo.openInbox().filter((i) => i.taskId == null || ids.has(i.taskId));
  const prefs = repo.listPreferences();
  const line = (t: (typeof tasks)[number]) => `#${t.id} ${t.title} [${t.status}${t.statusLine ? `: ${t.statusLine.slice(0, 60)}` : ''}]`;
  const active = tasks.filter((t) => ['running', 'needs_input', 'stalled'].includes(t.status));
  const queued = tasks.filter((t) => t.status === 'queued');
  const done = tasks.filter((t) => ['done', 'failed'].includes(t.status)).slice(-6);
  const idle = tasks.filter((t) => t.status === 'idle');
  const recent = tasks.filter((t) => t.status === 'accepted' && (t.finishedAt ?? 0) > Date.now() - 864e5).slice(-6);
  const gist = (t: (typeof tasks)[number]) => {
    const files = t.filesTouched.map((f) => f.split('/').pop()).slice(0, 4).join(', ');
    const first = (t.summary ?? '').split('\n').find((l) => l.trim())?.replace(/^[-*\s]+/, '').slice(0, 90) ?? '';
    return `#${t.id} ${t.title}${files ? ` [files: ${files}]` : ''}${first ? ` - ${first}` : ''}`;
  };
  const parts = [
    scope === BOSS
      ? `projects: ${projects.map((p) => `${p.name} (${p.path}${p.isGit ? '' : ', no git'})`).join('; ') || 'none registered'}`
      : `project: ${projects.find((p) => String(p.id) === scope)?.name ?? '?'}`,
    active.length ? `active:\n${active.map(line).join('\n')}` : 'active: none',
    queued.length ? `queued:\n${queued.slice(0, 10).map(line).join('\n')}` : '',
    done.length ? `awaiting review:\n${done.map(line).join('\n')}` : '',
    idle.length ? `idle, ready for more (context kept):\n${idle.map(gist).join('\n')}` : '',
    recent.length ? `finished today (can be continued):\n${recent.map(gist).join('\n')}` : '',
    inbox.length
      ? `needs developer:\n${inbox
          .slice(0, 8)
          .map((i) => `inbox#${i.id} agent #${i.taskId ?? '-'} ${i.kind}: ${i.title.slice(0, 120)}`)
          .join('\n')}`
      : '',
    prefs.length ? `preferences:\n${prefs.map((p) => `- ${p.text}`).join('\n')}` : '',
  ];
  return `<state>\n${parts.filter(Boolean).join('\n')}\n</state>`;
}

const BOSS_ROLE = `
## You are the boss master
You oversee every project. Each project also has its own master that the developer chats with on that project's page.
- project: name the project for every task you spawn (see the state). If there's only one, use it. If the developer names a folder that isn't registered, call add_project first.
- For a bigger request that belongs to one project ("get gongla ready for the App Store"), hand it to that project's master with ask_project_master; it plans and runs the agents there, and the developer can follow along on that project's page. Spawn directly for quick, well-defined tasks.
- Work spanning several projects: split it per project.`;

const projectRole = (name: string, path: string) => `
## You are the master for the "${name}" project
Folder: ${path}. Every task you create runs in this project; don't use the project argument. The developer also has a boss master for other projects; if they ask for work in another project, tell them to ask the boss or switch projects in the sidebar.`;

export function systemPrompt(scope: Scope): string {
  if (scope === BOSS) return MASTER_SYSTEM + BOSS_ROLE;
  const p = repo.getProject(Number(scope));
  return MASTER_SYSTEM + projectRole(p?.name ?? 'project', p?.path ?? '');
}
