import { repo } from './ctx.ts';
import type { AgentCommand } from '../../shared/types.ts';

// Slash commands an agent session supports. Running agents report their own list; for the rest we
// use the last list any agent reported (saved), or a small built-in fallback.
const FALLBACK: AgentCommand[] = [
  { name: 'compact', description: 'Summarize the conversation to free up context', argumentHint: '[instructions]' },
  { name: 'clear', description: 'Start the conversation over', argumentHint: '' },
  { name: 'review', description: 'Review the current changes', argumentHint: '' },
  { name: 'init', description: 'Create a CLAUDE.md for this project', argumentHint: '' },
];

let lastKnown: AgentCommand[] | null = null;

export function rememberCommands(list: AgentCommand[], terminalOnly: string[] = []) {
  const hide = new Set(terminalOnly);
  const clean = list.filter((c) => !hide.has(c.name) && !c.name.startsWith('_')).sort((a, b) => a.name.localeCompare(b.name));
  if (!clean.length) return clean;
  lastKnown = clean;
  repo.setKv('agentCommands', JSON.stringify(clean));
  return clean;
}

export function knownCommands(): AgentCommand[] {
  if (lastKnown) return lastKnown;
  try {
    const saved = JSON.parse(repo.getKv('agentCommands') ?? 'null');
    if (Array.isArray(saved) && saved.length) return (lastKnown = saved);
  } catch {
    /* fall through */
  }
  return FALLBACK;
}
