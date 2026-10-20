import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { addEvent, addInbox, repo, settings, updateInbox } from '../ctx.ts';
import { classify, describeTool } from './policy.ts';
import { derivePattern, exactQuestionRule, matchPermissionRule } from './rules.ts';
import { fuzzyQuestionRule } from './suggest.ts';
import type { InboxItem } from '../../../shared/types.ts';

// The Needs-You engine. A worker's canUseTool promise stays pending until the user answers
// in the dashboard (or via the master), so only that one worker waits.

type Resolver = (answer: string) => void;
const pending = new Map<number, { resolve: Resolver; taskId: number }>();

export function pendingCount(taskId: number): number {
  let n = 0;
  for (const p of pending.values()) if (p.taskId === taskId) n++;
  return n;
}

function waitForAnswer(item: InboxItem, taskId: number, signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const done = (a: string) => {
      pending.delete(item.id);
      resolve(a);
    };
    pending.set(item.id, { resolve: done, taskId });
    signal.addEventListener('abort', () => {
      if (pending.has(item.id)) {
        updateInbox(item.id, { status: 'dismissed' });
        done('deny');
      }
    });
  });
}

export function isPending(inboxId: number) {
  return pending.has(inboxId);
}

// Called from the dashboard / master. Returns false if nothing was waiting on this item.
export function answerInbox(id: number, answer: string, remember = false): boolean {
  const item = repo.getInbox(id);
  if (!item || item.status !== 'open') return false;
  if (remember) rememberAnswer(item, answer);
  updateInbox(id, { status: 'answered', answer });
  const p = pending.get(id);
  if (p) p.resolve(answer);
  return true;
}

function rememberAnswer(item: InboxItem, answer: string) {
  if (item.kind === 'permission' && item.detail.toolName && item.detail.input) {
    const decision = /^(allow|approve|yes|y)$/i.test(answer.trim()) ? 'allow' : 'deny';
    repo.addRule({
      kind: 'permission',
      tool: item.detail.toolName,
      pattern: derivePattern(item.detail.toolName, item.detail.input),
      decision,
      answer: decision === 'deny' && !/^(deny|no|n)$/i.test(answer.trim()) ? answer : null,
    });
  } else if (item.kind === 'question') {
    for (const q of item.detail.questions ?? []) {
      repo.addRule({ kind: 'question', tool: null, pattern: q.question, decision: null, answer });
    }
  }
}

export function denyAllPending(taskId: number) {
  for (const [id, p] of pending) {
    if (p.taskId === taskId) {
      updateInbox(id, { status: 'dismissed' });
      p.resolve('deny');
    }
  }
}

const isAllow = (a: string) => /^(allow|approve|approved|yes|y|ok)$/i.test(a.trim());
const isDeny = (a: string) => /^(deny|no|n|reject)$/i.test(a.trim());

export function createGate(taskId: number, cwd: string, onPendingChange: () => void): CanUseTool {
  return async (toolName, input, { signal }): Promise<PermissionResult> => {
    const rules = repo.listRules();

    // Worker questions → Needs You (unless a remembered answer settles it).
    if (toolName === 'AskUserQuestion') {
      const questions = ((input.questions as any[]) ?? []).map((q) => ({
        question: String(q.question ?? ''),
        header: q.header,
        multiSelect: !!q.multiSelect,
        options: ((q.options as any[]) ?? []).map((o) => ({ label: String(o.label), description: o.description })),
      }));
      const answers: Record<string, string> = {};
      for (const q of questions) {
        const rule =
          exactQuestionRule(rules, q.question) ??
          (await fuzzyQuestionRule(rules, q.question, q.options.map((o) => o.label)));
        if (rule?.answer) answers[q.question] = rule.answer;
      }
      if (questions.length && questions.every((q) => answers[q.question])) {
        addEvent(taskId, 'permission', `Auto-answered from remembered rules: ${JSON.stringify(answers)}`);
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      const item = addInbox({
        taskId,
        kind: 'question',
        title: questions.map((q) => q.question).join(' / ') || 'Agent has a question',
        detail: { questions },
      });
      onPendingChange();
      const answer = await waitForAnswer(item, taskId, signal);
      onPendingChange();
      if (signal.aborted) return { behavior: 'deny', message: 'Cancelled' };
      for (const q of questions) answers[q.question] ??= answer;
      addEvent(taskId, 'user', `Answered: ${answer}`);
      return { behavior: 'allow', updatedInput: { ...input, answers } };
    }

    const s = settings();
    const verdict = classify(toolName, input, {
      cwd,
      autoAllowEdits: s.autoAllowEdits,
      autoAllowSafeBash: s.autoAllowSafeBash,
    });

    const rule = matchPermissionRule(rules, toolName, input);
    if (rule?.decision === 'deny') {
      addEvent(taskId, 'permission', `Auto-denied by rule "${rule.pattern}": ${describeTool(toolName, input)}`);
      return { behavior: 'deny', message: rule.answer ? `The user says: ${rule.answer}` : 'The user has a standing rule denying this. Do not retry; find another way or finish without it.' };
    }
    if (verdict.decision === 'allow') return { behavior: 'allow', updatedInput: input };
    if (rule?.decision === 'allow' && verdict.decision === 'ask') {
      addEvent(taskId, 'permission', `Auto-allowed by rule "${rule.pattern}": ${describeTool(toolName, input)}`);
      return { behavior: 'allow', updatedInput: input };
    }

    const item = addInbox({
      taskId,
      kind: 'permission',
      title: describeTool(toolName, input),
      detail: { toolName, input, reason: verdict.reason, command: toolName === 'Bash' ? String(input.command) : undefined },
    });
    addEvent(taskId, 'permission', `Waiting for you: ${describeTool(toolName, input)} (${verdict.reason})`);
    onPendingChange();
    const answer = await waitForAnswer(item, taskId, signal);
    onPendingChange();
    if (signal.aborted) return { behavior: 'deny', message: 'Cancelled' };
    if (isAllow(answer)) {
      addEvent(taskId, 'permission', `You allowed: ${describeTool(toolName, input)}`);
      return { behavior: 'allow', updatedInput: input };
    }
    addEvent(taskId, 'permission', `You denied: ${describeTool(toolName, input)}${isDeny(answer) ? '' : ` — "${answer}"`}`);
    return {
      behavior: 'deny',
      message: isDeny(answer) ? 'The user denied this. Do not retry it; continue another way or wrap up.' : `The user denied this and says: ${answer}`,
    };
  };
}
