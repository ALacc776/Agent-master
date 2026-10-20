import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { bus } from '../bus.ts';
import { publishTask, repo, settings } from '../ctx.ts';
import { answerItem } from '../inbox.ts';
import { addProjectFromPath } from '../projects.ts';
import { freshSession, messageTask, startTask, stopTask } from '../workers/manager.ts';
import { modelId } from '../llm.ts';

// The master's only tools. Each returns immediately so the chat never blocks on workers.

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

function note(t: string) {
  bus.publish({ type: 'master_message', data: repo.addMasterMessage('system', t) });
}

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
].map((n) => `mcp__master__${n}`);

export function createMasterTools() {
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
        },
        async (a) => {
          const project = a.project ? repo.findProject(a.project) : repo.listProjects().length === 1 ? repo.listProjects()[0] : undefined;
          if (a.project && !project) return text(`Unknown project "${a.project}". Known: ${repo.listProjects().map((p) => p.name).join(', ') || 'none'}. Use add_project first.`);
          const task = repo.createTask({
            title: a.title,
            brief: a.brief,
            projectId: project?.id ?? null,
            model: modelId(a.model, settings().workerModel),
            modelReason: a.model_reason,
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
      tool('message_task', 'Send a message/instruction to a worker (running or finished; finished ones resume).', { id: z.number().int(), text: z.string() }, async (a) => {
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
        const tasks = repo.listTasks().filter((t) => !a.status || t.status === a.status);
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
      tool('remember_preference', 'Save a lasting developer preference; it is included in every worker brief.', { text: z.string() }, async (a) => {
        repo.addPreference(a.text);
        bus.publish({ type: 'preferences', data: repo.listPreferences() });
        note(`🧠 Remembered: ${a.text}`);
        return text('Saved');
      }),
      tool('list_projects', 'List registered projects.', {}, async () =>
        text(repo.listProjects().map((p) => `${p.name}: ${p.path}${p.isGit ? '' : ' (no git)'}`).join('\n') || 'None'),
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
