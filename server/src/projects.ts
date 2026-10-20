import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { bus } from './bus.ts';
import { repo } from './ctx.ts';
import { isGitRepo } from './workers/worktree.ts';
import type { Project } from '../../shared/types.ts';

export async function addProjectFromPath(rawPath: string, name?: string): Promise<Project> {
  const path = resolve(rawPath.trim().replace(/^~(?=\/|$)/, homedir()));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Folder not found: ${path}`);
  const project = repo.addProject(name?.trim() || basename(path), path, await isGitRepo(path));
  bus.publish({ type: 'projects', data: repo.listProjects() });
  return project;
}
