import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { DirListing } from '../../shared/types.ts';

// Folder browsing for the "choose folder" picker. Lists directories only, hides dot-folders.
export async function listDirs(rawPath: string): Promise<DirListing> {
  const path = resolve((rawPath || homedir()).replace(/^~(?=\/|$)/, homedir()));
  const entries = await readdir(path, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
    .map((e) => ({ name: e.name, path: join(path, e.name), isGit: existsSync(join(path, e.name, '.git')) }))
    .sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent === path ? null : parent, dirs, isGit: existsSync(join(path, '.git')) };
}

// macOS Finder dialog. Resolves null if cancelled or unavailable.
export function chooseFolderNative(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null);
  const script = `tell application (path to frontmost application as text)
  activate
  POSIX path of (choose folder with prompt "Choose a project folder for Master")
end tell`;
  return new Promise((res) => {
    execFile('osascript', ['-e', script], { timeout: 5 * 60_000 }, (err, stdout) => {
      res(err ? null : stdout.trim().replace(/\/$/, '') || null);
    });
  });
}
