import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

// Claude Code keeps each folder's sessions in ~/.claude/projects/<folder path with non-alphanumerics as dashes>/<id>.jsonl.
export interface SessionInfo {
  id: string;
  cwd: string;
  updatedAt: number;
  firstPrompt: string;
}

const projectsDir = () => join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects');
export const sessionDir = (cwd: string) => join(projectsDir(), resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-'));

async function firstPrompt(file: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }) });
  let lines = 0;
  try {
    for await (const line of rl) {
      if (++lines > 200) break;
      try {
        const e = JSON.parse(line);
        if (e.type !== 'user' || e.isMeta) continue;
        const c = e.message?.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b.type === 'text')?.text : '';
        if (text && !text.startsWith('<')) return text.trim().slice(0, 300);
      } catch {
        /* skip partial lines */
      }
    }
  } finally {
    rl.close();
  }
  return '';
}

export async function listSessions(cwd: string, limit = 10): Promise<SessionInfo[]> {
  const dir = sessionDir(cwd);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit);
  return Promise.all(
    files.map(async ({ f, mtime }) => ({ id: f.replace(/\.jsonl$/, ''), cwd: resolve(cwd), updatedAt: mtime, firstPrompt: await firstPrompt(join(dir, f)) })),
  );
}

export function sessionExists(cwd: string, id: string): boolean {
  return existsSync(join(sessionDir(cwd), `${id}.jsonl`));
}
