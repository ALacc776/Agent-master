import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { bus } from '../bus.ts';
import { publishTask, repo, settings } from '../ctx.ts';
import { answerItem } from '../inbox.ts';
import { addProjectFromPath } from '../projects.ts';
import { acceptTask, createPlan, freshSession, mergeTask, messageTask, openPr, pauseTask, setPaused, startTask, stopTask, tick } from '../workers/manager.ts';
import { procSummary, restartRun, runProcId, runSummary, runTerminal, sendInput, setRunCommand, startRun, stopRun, waitForProc } from '../processes.ts';
import { modelId } from '../llm.ts';
import { BOSS, type OnDone, type Scope } from '../../../shared/types.ts';

// The master's only tools. Each returns immediately so the chat never blocks on workers.

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

export const MASTER_TOOL_NAMES = [
  'spawn_task',
  'message_task',
  'start_task',
  'stop_task',
  'set_task_model',
  'fresh_session',
  'list_tasks',
  'get_task',
  'list_inbox',
  'answer_inbox',
  'remember_preference',
  'list_projects',
  'add_project',
  'ask_project_master',
  'run_app',
  'app_output',
  'app_input',
  'set_run_command',
  'terminal',
  'terminal_output',
  'pause_all',
  'pause_task',
  'finish_task',
  'set_max_agents',
  'set_auto_mode',
  'start_plan',
  'approve_plan',
].map((n) => `mcp__master__${n}`);

export interface MasterToolContext {
  scope: Scope;
  current: () => { onDone: OnDone; model: string };
  note: (text: string) => void; // a line in this master's chat
  delegate: (projectScope: Scope, text: string) => void; // boss → a project's master
}

export function createMasterTools(ctx: MasterToolContext) {
  const { current, note } = ctx;
  const own = ctx.scope === BOSS ? null : repo.getProject(Number(ctx.scope));
  // The project a control tool acts on: a project master's own, else the named one (or the only one).
  const projectFor = (name?: string) => {
    if (own) return own;
    const all = repo.listProjects();
    const p = name ? repo.findProject(name) : all.length === 1 ? all[0] : undefined;
    return p ?? (name ? `Unknown project "${name}". Known: ${all.map((x) => x.name).join(', ') || 'none'}` : `Which project? ${all.map((x) => x.name).join(', ')}`);
  };
  return createSdkMcpServer({
    name: 'master',
    version: '1.0.0',
    tools: [
      tool(
        'spawn_task',
        'Create a worker task. when="now" starts it immediately (or as soon as a slot frees); when="queue" puts it in the queue for the developer to start.',
        {
          title: z.string().describe('Short title, max ~8 words'),
          brief: z.string().describe('Full brief: Goal / Context / Scope / Done when'),
          project: z.string().optional().describe('Project name from state'),
          model: z.enum(['haiku', 'sonnet', 'opus']).describe('You must choose: haiku for trivial, sonnet by default, opus for hard work'),
          model_reason: z.string().describe('Why this model, max 8 words'),
          when: z.enum(['now', 'queue']),
          depends_on: z.number().int().optional().describe('Task id that must finish first'),
          on_done: z
            .enum(['merge', 'review', 'pr', 'keep'])
            .optional()
            .describe('Only if the developer asked for this task specifically: merge it in, hold it for review, open a PR, or keep the agent open for more. Otherwise omit and the <when_done> setting applies.'),
        },
        async (a) => {
          // A project's master always works in its own project.
          const project = own ?? (a.project ? repo.findProject(a.project) : repo.listProjects().length === 1 ? repo.listProjects()[0] : undefined);
          if (!own && a.project && !project) return text(`Unknown project "${a.project}". Known: ${repo.listProjects().map((p) => p.name).join(', ') || 'none'}. Use add_project first.`);
          const task = repo.createTask({
            title: a.title,
            brief: a.brief,
            projectId: project?.id ?? null,
            // The bottom-bar Model choice wins over the master's pick.
            model: current().model !== 'auto' ? current().model : modelId(a.model, settings().workerModel),
            modelReason: current().model !== 'auto' ? 'Chosen by you' : a.model_reason,
            onDone: a.on_done ?? current().onDone,
            autoStart: false,
            dependsOn: a.depends_on ?? null,
            createdBy: 'master',
          });
          publishTask(task);
          if (a.when === 'now') {
            const waiting = startTask(task.id);
            const m = `${a.model}: ${a.model_reason}`;
            note(waiting ? `⏳ #${task.id} ${task.title} (${m}). ${waiting}` : `▶ Started #${task.id} ${task.title} (${m})`);
            return text(waiting ? `Created #${task.id}; waiting: ${waiting}` : `Started #${task.id}`);
          }
          note(`📋 Queued #${task.id} ${task.title} (${a.model}: ${a.model_reason})`);
          return text(`Queued #${task.id}`);
        },
      ),
      tool('message_task', 'Continue an existing agent: it keeps its full context. Works for running, idle, in-review and even finished/merged agents (they reopen on a fresh branch). Prefer this over spawning when the request relates to an agent\'s work.', { id: z.number().int(), text: z.string() }, async (a) => {
        const r = messageTask(a.id, a.text);
        note(`✉️ → #${a.id}: ${a.text.slice(0, 120)}`);
        return text(r);
      }),
      tool('start_task', 'Start a queued/stopped/failed task.', { id: z.number().int() }, async (a) => {
        const r = startTask(a.id);
        note(r ? `⏳ #${a.id} — ${r}` : `▶ Started #${a.id}`);
        return text(r ?? `Started #${a.id}`);
      }),
      tool(
        'set_task_model',
        'Change the model of a task that has not started yet (or will restart).',
        { id: z.number().int(), model: z.enum(['haiku', 'sonnet', 'opus']), model_reason: z.string() },
        async (a) => {
          const t = repo.getTask(a.id);
          if (!t) return text('No such task');
          publishTask(repo.updateTask(a.id, { model: modelId(a.model, t.model), modelReason: a.model_reason }));
          note(`🔁 #${a.id} now uses ${a.model}: ${a.model_reason}`);
          return text('Updated');
        },
      ),
      tool('fresh_session', 'Restart a long-running task in a new session with a handoff summary (frees up context).', { id: z.number().int() }, async (a) => {
        const r = await freshSession(a.id);
        note(`♻️ ${r}`);
        return text(r);
      }),
      tool('stop_task', 'Stop a running or queued task.', { id: z.number().int() }, async (a) => {
        stopTask(a.id);
        note(`■ Stopped #${a.id}`);
        return text(`Stopped #${a.id}`);
      }),
      tool('list_tasks', 'List tasks, optionally filtered by status.', { status: z.string().optional() }, async (a) => {
        const tasks = repo.listTasks().filter((t) => (!a.status || t.status === a.status) && (!own || t.projectId === own.id));
        return text(
          tasks.map((t) => `#${t.id} [${t.status}] ${t.title} — ${t.statusLine} ($${t.costUsd.toFixed(2)})`).join('\n') || 'No tasks',
        );
      }),
      tool('get_task', 'Details of one task: brief, status, summary and latest activity.', { id: z.number().int() }, async (a) => {
        const t = repo.getTask(a.id);
        if (!t) return text('No such task');
        const events = repo
          .listEvents(t.id, 10)
          .map((e) => `${e.type}: ${e.text.slice(0, 200)}`)
          .join('\n');
        return text(
          `#${t.id} ${t.title} [${t.status}] model=${t.model} branch=${t.branch ?? '-'} cost=$${t.costUsd.toFixed(2)}\nStatus: ${t.statusLine}\nBrief: ${t.brief.slice(0, 800)}\nSummary: ${t.summary ?? '-'}\nReview: ${t.reviewVerdict ?? '-'}\nRecent:\n${events}`,
        );
      }),
      tool('list_inbox', 'Open items waiting on the developer.', {}, async () => {
        const items = repo.openInbox();
        return text(
          items
            .map((i) => `inbox#${i.id} agent #${i.taskId ?? '-'} ${i.kind}: ${i.title}${i.suggestedAnswer ? ` (suggested: ${i.suggestedAnswer.split('\n')[0]})` : ''}`)
            .join('\n') || 'Nothing waiting',
        );
      }),
      tool(
        'answer_inbox',
        'Answer a Needs-You item ONLY when the developer told you the answer. Permissions: "allow"/"deny" or an instruction. Questions: the option label or free text. Stalled/loop: a nudge message, "stop", "retry" or "dismiss".',
        { inbox_id: z.number().int(), answer: z.string() },
        async (a) => {
          const r = answerItem(a.inbox_id, a.answer);
          note(`✅ ${r}`);
          return text(r);
        },
      ),
      // ---------- the project's app and terminal
      tool(
        'run_app',
        "Start, stop or restart the project's app (its dev command, shown in the Run panel). Returns immediately.",
        { action: z.enum(['start', 'stop', 'restart']), project: z.string().optional().describe('Boss only: which project') },
        async (a) => {
          const p = projectFor(a.project);
          if (typeof p === 'string') return text(p);
          if (a.action === 'start') startRun(p.id);
          else if (a.action === 'stop') await stopRun(p.id);
          else await restartRun(p.id);
          note(`▶ ${a.action === 'start' ? 'Started' : a.action === 'stop' ? 'Stopped' : 'Restarted'} the ${p.name} app`);
          return text(`${a.action}ed. ${a.action === 'stop' ? '' : 'Check app_output in a few seconds to see how it is doing.'}`);
        },
      ),
      tool('app_output', "Recent output of the project's app (to check it started, find its URL, or see errors).", { project: z.string().optional(), lines: z.number().int().min(5).max(200).optional() }, async (a) => {
        const p = projectFor(a.project);
        return text(typeof p === 'string' ? p : runSummary(p.id, a.lines ?? 40));
      }),
      tool('app_input', 'Type a line into the running app (e.g. "r" to reload Expo).', { text: z.string(), project: z.string().optional() }, async (a) => {
        const p = projectFor(a.project);
        if (typeof p === 'string') return text(p);
        const id = runProcId(p.id);
        if (!id) return text("The app isn't running.");
        try {
          sendInput(id, a.text);
          return text('Sent.');
        } catch (err) {
          return text((err as Error).message);
        }
      }),
      tool('set_run_command', "Change the command the Run panel uses to start the project's app.", { command: z.string(), project: z.string().optional() }, async (a) => {
        const p = projectFor(a.project);
        if (typeof p === 'string') return text(p);
        setRunCommand(p.id, a.command);
        note(`⚙ Run command for ${p.name}: ${a.command}`);
        return text('Saved.');
      }),
      tool(
        'terminal',
        "Run a shell command in the project's folder (shows in the Terminal tab) and return its output. For quick commands like git status, npm test, ls. Long-running servers belong in run_app.",
        { command: z.string(), project: z.string().optional(), wait_seconds: z.number().int().min(0).max(60).optional().describe('How long to wait for it to finish (default 20)') },
        async (a) => {
          const p = projectFor(a.project);
          if (typeof p === 'string') return text(p);
          const proc = runTerminal(p.id, a.command);
          await waitForProc(proc.id, (a.wait_seconds ?? 20) * 1000);
          const out = procSummary(proc.id, 80) ?? '';
          return text(out.includes('[running]') ? `${out}\n(still running; check terminal_output with id ${proc.id})` : out);
        },
      ),
      tool('terminal_output', 'Output of an earlier terminal command, by id.', { id: z.string() }, async (a) => text(procSummary(a.id, 120) ?? 'No such command.')),

      // ---------- fleet controls
      tool('pause_all', 'Pause every agent (paused: true) or resume them (paused: false).', { paused: z.boolean() }, async (a) => {
        setPaused(a.paused);
        note(a.paused ? '⏸ Paused all agents' : '▶ Resumed all agents');
        return text(a.paused ? 'Paused.' : 'Resumed.');
      }),
      tool('pause_task', 'Pause one running agent (it can be started again later).', { id: z.number().int() }, async (a) => {
        pauseTask(a.id);
        note(`⏸ Paused #${a.id}`);
        return text(`Paused #${a.id}`);
      }),
      tool(
        'finish_task',
        'Finish a task that is waiting in Review or Ready for more: merge it, open a PR, or dismiss it (closes without merging; branch kept). Only when the developer asks.',
        { id: z.number().int(), action: z.enum(['merge', 'pr', 'dismiss']) },
        async (a) => {
          try {
            if (a.action === 'merge') await mergeTask(a.id);
            else if (a.action === 'pr') {
              const url = await openPr(a.id);
              note(`🔗 #${a.id} PR: ${url}`);
              return text(`Opened ${url}`);
            } else await acceptTask(a.id);
            note(`✓ #${a.id} ${a.action === 'merge' ? 'merged' : 'dismissed'}`);
            return text('Done.');
          } catch (err) {
            return text(`Couldn't ${a.action}: ${(err as Error).message}`);
          }
        },
      ),
      tool('set_max_agents', 'Set how many agents may run at once (1-20).', { n: z.number().int().min(1).max(20) }, async (a) => {
        bus.publish({ type: 'settings', data: repo.updateSettings({ maxConcurrent: a.n }) });
        tick();
        note(`⚙ Up to ${a.n} agents at once`);
        return text('Saved.');
      }),
      tool('set_auto_mode', 'Turn auto mode on (agents decide routine things themselves) or off (more things ask the developer).', { on: z.boolean() }, async (a) => {
        bus.publish({ type: 'settings', data: repo.updateSettings({ autoMode: a.on }) });
        note(`⚙ Auto mode ${a.on ? 'on' : 'off'}`);
        return text('Saved.');
      }),

      // ---------- plans
      tool(
        'start_plan',
        'Start a plan conversation in the Plan panel: a Claude agent in plan mode explores the idea with the developer and proposes a plan before building. Use when the developer wants to think something through first.',
        { idea: z.string().describe("The developer's idea, in their words plus any context"), project: z.string().optional() },
        async (a) => {
          const p = projectFor(a.project);
          if (typeof p === 'string') return text(p);
          const t = createPlan({ projectId: p.id, text: a.idea, onDone: current().onDone });
          note(`💡 Started plan #${t.id} in the Plan panel`);
          return text(`Started plan #${t.id}. It will reply in the Plan panel; tell the developer to open it there (Plan button).`);
        },
      ),
      tool('approve_plan', "Approve a task's proposed plan so it starts building. Only when the developer says so.", { id: z.number().int() }, async (a) => {
        const item = repo.openInbox().find((i) => i.taskId === a.id && i.kind === 'plan');
        if (!item) return text(`#${a.id} has no plan waiting for approval.`);
        note(`✓ Approved #${a.id}'s plan`);
        return text(answerItem(item.id, 'approve'));
      }),

      tool('remember_preference', 'Save a lasting developer preference; it is included in every worker brief.', { text: z.string() }, async (a) => {
        repo.addPreference(a.text);
        bus.publish({ type: 'preferences', data: repo.listPreferences() });
        note(`🧠 Remembered: ${a.text}`);
        return text('Saved');
      }),
      tool('list_projects', 'List registered projects.', {}, async () =>
        text(repo.listProjects().map((p) => `${p.name}: ${p.path}${p.isGit ? '' : ' (no git)'}`).join('\n') || 'None'),
      ),
      tool(
        'ask_project_master',
        "Boss only: hand a request to a project's own master. It plans and runs the agents in that project; the developer can follow along on that project's page. Returns immediately.",
        { project: z.string().describe('Project name'), message: z.string().describe('What that project needs, with any context') },
        async (a) => {
          if (own) return text("You are a project master; there's no other master to delegate to.");
          const p = repo.findProject(a.project);
          if (!p) return text(`Unknown project "${a.project}". Known: ${repo.listProjects().map((x) => x.name).join(', ') || 'none'}`);
          ctx.delegate(String(p.id), a.message);
          note(`↪ Asked the ${p.name} master: ${a.message.slice(0, 140)}`);
          return text(`Handed to the ${p.name} master.`);
        },
      ),
      tool('add_project', 'Register a project folder so tasks can run in it.', { path: z.string(), name: z.string().optional() }, async (a) => {
        try {
          const p = await addProjectFromPath(a.path, a.name);
          note(`📁 Added project ${p.name}`);
          return text(`Added ${p.name} (${p.path})${p.isGit ? '' : ' — not a git repo, tasks run in place one at a time'}`);
        } catch (err) {
          return text((err as Error).message);
        }
      }),
    ],
  });
}
