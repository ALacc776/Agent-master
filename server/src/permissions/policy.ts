import { isAbsolute, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

// Pure permission policy: decides whether a worker's tool call is auto-allowed, needs the user,
// or is on the always-ask list (push/merge/deploy/destructive/outside-worktree).

export type PolicyDecision = { decision: 'allow' | 'ask' | 'always_ask'; reason: string; subject: string; outside?: boolean };

export interface PolicyOptions {
  cwd: string;
  autoAllowEdits: boolean;
  autoAllowSafeBash: boolean;
}

const ALWAYS_ASK_BASH: [RegExp, string][] = [
  [/\bgit\s+push\b/, 'pushes to a remote'],
  [/\bgit\s+(merge|rebase|pull)\b/, 'merges or rebases branches'],
  [/\bgit\s+(reset\s+--hard|branch\s+-D|clean\s+-\w*f|push\s+--force)\b/, 'discards git history or files'],
  [/\bgh\s+(pr\s+(merge|create)|release|repo\s+(delete|create))\b/, 'acts on GitHub'],
  [/\brm\s+(-\w*r\w*f|-\w*f\w*r|-r\s+-f|-f\s+-r)\b/, 'force-deletes files recursively'],
  [/\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, 'publishes a package'],
  [/\b(deploy|vercel|netlify|wrangler|flyctl|heroku|firebase\s+deploy|terraform\s+apply|kubectl\s+(apply|delete)|docker\s+push)\b/, 'deploys or changes infrastructure'],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add)\b[^|;&]*\s(-g|--global)\b|\bbrew\s+(install|uninstall|upgrade)\b/, 'installs software globally'],
  [/\bsudo\b/, 'runs as root'],
  [/\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, 'pipes a download into a shell'],
];

const SAFE_COMMANDS = new Set([
  'ls', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'pwd', 'echo', 'printf', 'which', 'sed', 'awk', 'sort',
  'uniq', 'diff', 'tree', 'mkdir', 'touch', 'cp', 'mv', 'cd', 'true', 'test', 'node', 'tsx', 'ts-node', 'npx', 'tsc',
  'vitest', 'jest', 'pytest', 'python', 'python3', 'make', 'prettier', 'eslint', 'ruff', 'black', 'deno', 'bun', 'go',
  'cargo', 'rustc', 'jq', 'basename', 'dirname', 'date', 'env', 'xargs', 'file', 'stat', 'du', 'sleep', 'tr', 'cut',
  'tee', 'chmod',
]);
const SAFE_PKG = /^(npm|pnpm|yarn)\s+(run|test|t|ci|install|i|add|exec|ls|why|outdated|init|create|build|start|dev|lint|typecheck|format|remove|uninstall)\b/;
const SAFE_GIT = /^git\s+(status|diff|log|show|add|commit|branch(?!\s+-D)|checkout\s+-b|switch\s+-c|stash|rev-parse|ls-files|restore|mv|rm|init|config\s+--get|blame|grep)\b/;
const SAFE_PIP = /^(pip3?|uv)\s+(install|sync|add)\b/;

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS']);
const ALWAYS_SAFE_TOOLS = new Set([
  'TodoWrite', 'Task', 'Agent', 'WebFetch', 'WebSearch', 'BashOutput', 'KillShell', 'KillBash', 'ToolSearch',
  'ExitPlanMode', 'TaskOutput', 'TaskStop', 'Skill', 'SlashCommand', 'ListMcpResources', 'ReadMcpResource', 'Monitor',
]);

export function isInside(cwd: string, p: string): boolean {
  const abs = resolve(cwd, p.replace(/^~(?=\/|$)/, homedir()));
  const rel = relative(resolve(cwd), abs);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function filePathOf(input: Record<string, unknown>): string {
  return String(input.file_path ?? input.notebook_path ?? input.path ?? '');
}

// Splits on && || ; | and newlines, but not inside quotes or $( … ) (e.g. multi-line commit messages).
export function splitCommand(cmd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let depth = 0;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === '\\' && quote === '"') {
        cur += c + (cmd[++i] ?? '');
        continue;
      }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '$' && cmd[i + 1] === '(') depth++;
    else if (c === ')' && depth > 0) depth--;
    else if (depth === 0 && (c === ';' || c === '\n' || c === '|' || (c === '&' && cmd[i + 1] === '&'))) {
      if ((c === '|' && cmd[i + 1] === '|') || c === '&') i++;
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((s) => s.trim()).filter(Boolean);
}

function pathsOutside(cmd: string, cwd: string): string[] {
  const tokens = cmd.match(/(?:^|\s)(~?\/[^\s'"`;|&)]+)/g) ?? [];
  return tokens
    .map((t) => t.trim())
    .filter((t) => !/^\/(dev\/null|tmp\/|private\/tmp\/|usr\/bin\/env)/.test(t) && t !== '/tmp')
    .filter((t) => !isInside(cwd, t));
}

function isSafeSegment(seg: string): boolean {
  const s = seg
    .replace(/^(\w+=\S+\s+)+/, '') // strip env assignments
    .replace(/^git\s+((-c|-C)\s+(?:[^\s"']|"[^"]*"|'[^']*')+\s+)+/, 'git '); // strip git global options
  if (SAFE_PKG.test(s) || SAFE_GIT.test(s) || SAFE_PIP.test(s)) return true;
  const first = s.split(/\s+/)[0]?.replace(/^\.\//, '') ?? '';
  return SAFE_COMMANDS.has(first);
}

export function classify(toolName: string, input: Record<string, unknown>, opts: PolicyOptions): PolicyDecision {
  if (toolName === 'Bash') {
    const cmd = String(input.command ?? '');
    for (const [re, why] of ALWAYS_ASK_BASH) {
      if (re.test(cmd)) return { decision: 'always_ask', reason: `Command ${why}`, subject: cmd };
    }
    const outside = pathsOutside(cmd, opts.cwd);
    if (outside.length) return { decision: 'ask', reason: `Touches paths outside the worktree: ${outside.join(', ')}`, subject: cmd };
    if (opts.autoAllowSafeBash && splitCommand(cmd).every(isSafeSegment)) return { decision: 'allow', reason: 'Safe command', subject: cmd };
    return { decision: 'ask', reason: 'Command is not on the safe list', subject: cmd };
  }

  if (EDIT_TOOLS.has(toolName)) {
    const p = filePathOf(input);
    if (!isInside(opts.cwd, p)) return { decision: 'always_ask', reason: 'Edits a file outside the worktree', subject: p, outside: true };
    return opts.autoAllowEdits
      ? { decision: 'allow', reason: 'Edit inside worktree', subject: p }
      : { decision: 'ask', reason: 'Edit (auto-allow is off)', subject: p };
  }

  if (READ_TOOLS.has(toolName)) {
    const p = filePathOf(input);
    if (!p || isInside(opts.cwd, p)) return { decision: 'allow', reason: 'Read inside worktree', subject: p };
    return { decision: 'ask', reason: 'Reads outside the worktree', subject: p };
  }

  if (ALWAYS_SAFE_TOOLS.has(toolName)) return { decision: 'allow', reason: 'Safe tool', subject: toolName };

  return { decision: 'ask', reason: `Tool ${toolName} needs approval`, subject: toolName };
}

export function describeTool(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return `run \`${String(input.command ?? '').slice(0, 200)}\``;
    case 'Edit':
    case 'MultiEdit':
      return `edit ${filePathOf(input)}`;
    case 'Write':
      return `write ${filePathOf(input)}`;
    case 'Read':
      return `read ${filePathOf(input)}`;
    case 'WebFetch':
      return `fetch ${String(input.url ?? '')}`;
    default:
      return `use ${toolName}`;
  }
}
