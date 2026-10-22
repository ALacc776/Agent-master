import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { DATA_DIR } from '../store/db.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from '../bus.ts';
import { InputChannel } from '../channel.ts';
import { addSpend, repo, settings } from '../ctx.ts';
import { systemPrompt, stateBlock } from './prompt.ts';
import { explainError } from '../llm.ts';
import { createMasterTools, MASTER_TOOL_NAMES } from './tools.ts';
import { BOSS, type MasterState, type OnDone, type Scope } from '../../../shared/types.ts';
export type TurnOptions = { onDone: OnDone; model: string };

// One master per scope: the boss (all projects) and one per project. Each is a long-lived,
// cheap-model session; messages are pushed into its input stream as they arrive, so the
// developer can keep typing while it works.

// The boss keeps the original keys so its conversation carries over.
const sessionKey = (scope: Scope) => (scope === BOSS ? 'masterSessionId' : `masterSessionId:${scope}`);
const modelKey = (scope: Scope) => `masterModel:${scope}`;

export function masterModel(scope: Scope): string {
  return (scope !== BOSS && repo.getKv(modelKey(scope))) || settings().masterModel;
}

class MasterAgent {
  private channel: InputChannel | null = null;
  private q: Query | null = null;
  private lastCost = 0;
  private queued = 0;
  // Bottom-bar choices (When done, Model) for each message still being handled, oldest first; tools use the head.
  private turnOptions: TurnOptions[] = [];

  constructor(readonly scope: Scope) {}

  get currentOptions(): TurnOptions {
    return this.turnOptions[0] ?? { onDone: settings().defaultOnDone, model: 'auto' };
  }

  get state(): MasterState {
    return { busy: this.queued > 0, queue: Math.max(0, this.queued - 1), model: masterModel(this.scope) };
  }

  private publishState() {
    bus.publish({ type: 'master_state', scope: this.scope, state: this.state });
  }

  say(role: 'user' | 'master' | 'system', text: string) {
    bus.publish({ type: 'master_message', data: repo.addMasterMessage(role, text, this.scope) });
  }

  private ensureSession() {
    if (this.q && this.channel && !this.channel.closed) return;
    const cwd = join(DATA_DIR, 'master-home', this.scope === BOSS ? '' : `project-${this.scope}`);
    mkdirSync(cwd, { recursive: true });
    this.channel = new InputChannel();
    this.lastCost = 0;
    const resume = repo.getKv(sessionKey(this.scope));
    this.q = query({
      prompt: this.channel,
      options: {
        cwd,
        model: masterModel(this.scope),
        systemPrompt: systemPrompt(this.scope),
        tools: [],
        mcpServers: {
          master: createMasterTools({
            scope: this.scope,
            current: () => this.currentOptions,
            note: (t) => this.say('system', t),
            delegate: (projectScope, text) => getMaster(projectScope).send(`(From the boss) ${text}`),
          }),
        },
        // Built-in tools are off (tools: []), so the master can only call its own tools, all pre-approved here.
        allowedTools: MASTER_TOOL_NAMES,
        settingSources: [],
        resume: resume || undefined,
      },
    });
    void this.consume(this.q, this.channel);
  }

  private async consume(q: Query, channel: InputChannel) {
    try {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          repo.setKv(sessionKey(this.scope), msg.session_id);
        } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          const t = (msg.message.content as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          // Auth/API failures arrive as synthetic assistant text; the result error below explains them.
          if (t && !msg.error) this.say('master', t);
        } else if (msg.type === 'result') {
          const cost = msg.total_cost_usd ?? 0;
          addSpend(null, Math.max(0, cost - this.lastCost));
          this.lastCost = cost;
          this.queued = msg.queued_turn_count ?? Math.max(0, this.queued - 1);
          this.turnOptions = this.queued > 0 ? this.turnOptions.slice(-this.queued) : [];
          if (msg.is_error) {
            const why = msg.subtype === 'success' ? msg.result : msg.subtype;
            this.say('system', `Master hit an error: ${explainError(why)}`);
          }
          this.publishState();
        }
      }
    } catch (err) {
      const m = (err as Error).message;
      console.error(`[master ${this.scope}] session ended:`, m);
      this.say('system', `Master session restarted (${m.slice(0, 160)})`);
      // A broken resume shouldn't brick the master; start fresh next time.
      if (/session|resume|conversation/i.test(m)) repo.setKv(sessionKey(this.scope), '');
    } finally {
      channel.close();
      if (this.q === q) {
        this.q = null;
        this.queued = 0;
        this.turnOptions = [];
        this.publishState();
      }
    }
  }

  send(text: string, opts: { projectId?: number | null; onDone?: OnDone | null; model?: string | null } = {}) {
    this.turnOptions.push({ onDone: opts.onDone ?? settings().defaultOnDone, model: opts.model || 'auto' });
    this.say('user', text);
    this.ensureSession();
    this.queued++;
    this.publishState();
    // Only the boss gets a "Build in" choice; a project master always works in its own project.
    const project = this.scope === BOSS ? repo.getProject(opts.projectId) : undefined;
    const focus = project ? `\n<selected_project>${project.name} (${project.path}). Use it for new tasks unless the developer names another project.</selected_project>` : '';
    const o = this.turnOptions.at(-1)!;
    const when = `\n<when_done>${o.onDone}</when_done>${o.model !== 'auto' ? `\n<model>${o.model} (the developer chose this for new tasks)</model>` : ''}`;
    this.channel!.push(`${stateBlock(this.scope)}${focus}${when}\n\n${text}`);
  }

  /** Switch this master's model; a running session switches live. */
  async setModel(model: string) {
    if (this.scope === BOSS) {
      repo.updateSettings({ masterModel: model });
      bus.publish({ type: 'settings', data: repo.getSettings() });
    } else repo.setKv(modelKey(this.scope), model);
    if (this.q) await this.q.setModel(model).catch(() => {});
    this.publishState();
    this.say('system', `Now using ${model}`);
  }

  async reset() {
    repo.setKv(sessionKey(this.scope), '');
    this.channel?.close();
    this.q?.close();
    this.q = null;
    this.queued = 0;
    this.turnOptions = [];
    this.publishState();
  }
}

const masters = new Map<Scope, MasterAgent>();

export function getMaster(scope: Scope = BOSS): MasterAgent {
  const key = scope === BOSS || repo.getProject(Number(scope)) ? scope : BOSS;
  let m = masters.get(key);
  if (!m) masters.set(key, (m = new MasterAgent(key)));
  return m;
}

/** State of the boss and every project's master, for the dashboard. */
export function masterStates(): Record<Scope, MasterState> {
  const out: Record<Scope, MasterState> = { [BOSS]: getMaster(BOSS).state };
  for (const p of repo.listProjects()) out[String(p.id)] = getMaster(String(p.id)).state;
  return out;
}
