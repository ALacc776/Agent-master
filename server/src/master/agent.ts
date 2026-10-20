import { query, type Query } from '@anthropic-ai/claude-agent-sdk';
import { DATA_DIR } from '../store/db.ts';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bus } from '../bus.ts';
import { InputChannel } from '../channel.ts';
import { addSpend, repo, settings } from '../ctx.ts';
import { MASTER_SYSTEM, stateBlock } from './prompt.ts';
import { explainError } from '../llm.ts';
import { createMasterTools, MASTER_TOOL_NAMES } from './tools.ts';

// One long-lived, cheap-model session. Messages are pushed into its input stream as they arrive,
// so the developer can keep typing while it works; the SDK runs them in order.

class MasterAgent {
  private channel: InputChannel | null = null;
  private q: Query | null = null;
  private lastCost = 0;
  private queued = 0;

  private publishState() {
    bus.publish({ type: 'master_state', busy: this.queued > 0, queue: Math.max(0, this.queued - 1) });
  }

  get busy() {
    return this.queued > 0;
  }
  get queueLength() {
    return Math.max(0, this.queued - 1);
  }

  private ensureSession() {
    if (this.q && this.channel && !this.channel.closed) return;
    const cwd = join(DATA_DIR, 'master-home');
    mkdirSync(cwd, { recursive: true });
    this.channel = new InputChannel();
    this.lastCost = 0;
    const resume = repo.getKv('masterSessionId');
    this.q = query({
      prompt: this.channel,
      options: {
        cwd,
        model: settings().masterModel,
        systemPrompt: MASTER_SYSTEM,
        tools: [],
        mcpServers: { master: createMasterTools() },
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
          repo.setKv('masterSessionId', msg.session_id);
        } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
          const t = (msg.message.content as any[])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
          // Auth/API failures arrive as synthetic assistant text; the result error below explains them.
          if (t && !msg.error) bus.publish({ type: 'master_message', data: repo.addMasterMessage('master', t) });
        } else if (msg.type === 'result') {
          const cost = msg.total_cost_usd ?? 0;
          addSpend(null, Math.max(0, cost - this.lastCost));
          this.lastCost = cost;
          this.queued = msg.queued_turn_count ?? Math.max(0, this.queued - 1);
          if (msg.is_error) {
            const why = msg.subtype === 'success' ? msg.result : msg.subtype;
            bus.publish({ type: 'master_message', data: repo.addMasterMessage('system', `Master hit an error: ${explainError(why)}`) });
          }
          this.publishState();
        }
      }
    } catch (err) {
      const m = (err as Error).message;
      console.error('[master] session ended:', m);
      bus.publish({ type: 'master_message', data: repo.addMasterMessage('system', `Master session restarted (${m.slice(0, 160)})`) });
      // A broken resume shouldn't brick the master; start fresh next time.
      if (/session|resume|conversation/i.test(m)) repo.setKv('masterSessionId', '');
    } finally {
      channel.close();
      if (this.q === q) {
        this.q = null;
        this.queued = 0;
        this.publishState();
      }
    }
  }

  send(text: string, projectId: number | null = null) {
    bus.publish({ type: 'master_message', data: repo.addMasterMessage('user', text) });
    this.ensureSession();
    this.queued++;
    this.publishState();
    const project = repo.getProject(projectId);
    const focus = project ? `\n<selected_project>${project.name} (${project.path}). Use it for new tasks unless the developer names another project.</selected_project>` : '';
    this.channel!.push(`${stateBlock()}${focus}\n\n${text}`);
  }

  async reset() {
    repo.setKv('masterSessionId', '');
    this.channel?.close();
    this.q?.close();
    this.q = null;
    this.queued = 0;
    this.publishState();
  }
}

export const master = new MasterAgent();
