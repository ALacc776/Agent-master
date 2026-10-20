import { dirname } from 'node:path';
import type { Rule } from '../../../shared/types.ts';

// Deterministic matching of remembered permission answers.

export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`, 's');
}

export function ruleSubject(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') return String(input.command ?? '').trim();
  const p = input.file_path ?? input.notebook_path ?? input.path ?? input.url;
  return p ? String(p) : '*';
}

// The pattern saved when the user ticks "remember this".
export function derivePattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === 'Bash') {
    const tokens = String(input.command ?? '').trim().split(/\s+/);
    const keep = tokens[1] && !tokens[1].startsWith('-') ? tokens.slice(0, 2) : tokens.slice(0, 1);
    return `${keep.join(' ')}*`;
  }
  const subject = ruleSubject(toolName, input);
  if (subject === '*') return '*';
  if (/^https?:\/\//.test(subject)) return `${new URL(subject).origin}/*`;
  return `${dirname(subject)}/*`;
}

export function matchPermissionRule(
  rules: Rule[],
  toolName: string,
  input: Record<string, unknown>,
): Rule | undefined {
  const subject = ruleSubject(toolName, input);
  return rules.find(
    (r) => r.kind === 'permission' && (r.tool === null || r.tool === toolName) && globToRegExp(r.pattern).test(subject),
  );
}

export const normalizeQuestion = (q: string) => q.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

export function exactQuestionRule(rules: Rule[], question: string): Rule | undefined {
  const n = normalizeQuestion(question);
  return rules.find((r) => r.kind === 'question' && normalizeQuestion(r.pattern) === n);
}
