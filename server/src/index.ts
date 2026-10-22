import Fastify, { type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bus } from './bus.ts';
import { addSpend, onNewInbox, publishTask, repo, toast } from './ctx.ts';
import { pickModel } from './llm.ts';
import { chooseFolderNative, listDirs } from './fs.ts';
import { getMaster, masterStates } from './master/agent.ts';
import { answerItem, dismissItem } from './inbox.ts';
import { notify } from './notify.ts';
import { suggestAnswer } from './permissions/suggest.ts';
import { addProjectFromPath } from './projects.ts';
import { digest } from './digest.ts';
import { listSessions } from './sessions.ts';
import { clearTerminal, listProcs, restartRun, runCommands, runTerminal, sendInput, setRunCommand, startRun, stopProc, stopRun } from './processes.ts';
import { startWatchdog } from './watchdog.ts';
import { fullDiff } from './workers/worktree.ts';
import {
  acceptTask,
  deleteTask,
  followUp,
  freshSession,
  detachTask,
  createPlan,
  setTaskModel,
  taskCommands,
  adoptSession,
  handBack,
  openInTerminal,
  mergeTask,
  messageTask,
  openPr,
  pauseTask,
  recoverOnBoot,
  requestChanges,
  setPaused,
  startAll,
  startTask,
  stopTask,
  tick,
} from './workers/manager.ts';
import { BOSS, type OnDone, type Settings, type Snapshot, type Task } from '../../shared/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4545);

recoverOnBoot();
startWatchdog();

onNewInbox((item) => {
  if (item.kind === 'review') return;
  const who = item.taskId != null ? `Agent #${item.taskId}` : 'Master';
  notify(`${who} needs you`, item.title);
  void suggestAnswer(item);
});

function snapshot(): Snapshot {
  return {
    projects: repo.listProjects(),
    tasks: repo.listTasks(),
    inbox: repo.listInbox(),
    rules: repo.listRules(),
    preferences: repo.listPreferences(),
    master: repo.listMasterMessages(),
    masters: masterStates(),
    procs: listProcs(),
    runCommands: runCommands(),
    settings: repo.getSettings(),
    spentToday: repo.spentToday(),
  };
}

const settingsAtBoot = repo.getSettings();
const app = Fastify({ logger: false });
await app.register(websocket);

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
function authorized(req: FastifyRequest): boolean {
  if (isLoopback(req.ip)) return true;
  const token = (req.headers['x-master-token'] as string) ?? (req.query as any)?.token;
  return !!token && token === repo.getSettings().accessToken;
}
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/api') || req.url.startsWith('/ws')) {
    if (!authorized(req)) return reply.code(401).send({ error: 'Access token required' });
  }
});

app.get('/ws', { websocket: true }, (socket) => {
  socket.send(JSON.stringify({ type: 'snapshot', data: snapshot() }));
  const off = bus.subscribe((msg) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  });
  socket.on('close', off);
});

const id = (req: FastifyRequest) => Number((req.params as any).id);
const body = <T = any>(req: FastifyRequest) => (req.body ?? {}) as T;
const fail = (reply: any, err: unknown, code = 400) => reply.code(code).send({ error: (err as Error).message ?? String(err) });

app.get('/api/snapshot', async () => snapshot());

// ----- master
app.post('/api/master/message', async (req) => {
  const { text, projectId, onDone, model, scope } = body<{ text: string; projectId?: number | null; onDone?: OnDone; model?: string; scope?: string }>(req);
  if (text?.trim()) getMaster(scope ?? BOSS).send(text.trim(), { projectId, onDone, model });
  return { ok: true };
});
app.post('/api/master/model', async (req) => {
  await getMaster(body(req).scope ?? BOSS).setModel(String(body(req).model));
  return { ok: true };
});
app.post('/api/master/reset', async (req) => {
  await getMaster(body(req).scope ?? BOSS).reset();
  return { ok: true };
});

// ----- tasks
app.post('/api/tasks', async (req) => {
  const b = body(req);
  let model = b.model || repo.getSettings().workerModel;
  let modelReason: string | null = null;
  if (model === 'auto') {
    const pick = await pickModel(b.title ?? '', b.brief ?? '', repo.getSettings().cheapModel);
    addSpend(null, pick.costUsd);
    model = pick.model;
    modelReason = pick.reason;
  }
  const task = repo.createTask({
    title: b.title || 'Untitled task',
    brief: b.brief ?? '',
    projectId: b.projectId ?? null,
    model,
    modelReason,
    onDone: b.onDone,
    dependsOn: b.dependsOn ?? null,
    createdBy: b.createdBy === 'master' ? 'master' : 'user',
  });
  publishTask(task);
  const waiting = b.start ? startTask(task.id) : null;
  return { task, waiting };
});
app.patch('/api/tasks/:id', async (req) => {
  const b = body<Partial<Task>>(req);
  const allowed: (keyof Task)[] = ['title', 'brief', 'projectId', 'model', 'dependsOn', 'position', 'autoStart', 'onDone'];
  const patch = Object.fromEntries(Object.entries(b).filter(([k]) => allowed.includes(k as keyof Task)));
  const task = repo.updateTask(id(req), patch);
  publishTask(task);
  tick();
  return task;
});
app.delete('/api/tasks/:id', async (req) => {
  deleteTask(id(req));
  return { ok: true };
});
app.post('/api/tasks/start-all', async () => ({ started: startAll() }));
app.post('/api/tasks/:id/start', async (req) => ({ waiting: startTask(id(req)) }));
app.post('/api/tasks/:id/stop', async (req) => {
  stopTask(id(req));
  return { ok: true };
});
app.post('/api/tasks/:id/pause', async (req) => {
  pauseTask(id(req));
  return { ok: true };
});
app.post('/api/tasks/:id/message', async (req) => ({ result: messageTask(id(req), body(req).text) }));
app.post('/api/tasks/:id/changes', async (req) => ({ result: requestChanges(id(req), body(req).text) }));
app.post('/api/tasks/:id/followup', async (req) => {
  const t = followUp(id(req), body(req).text);
  if (body(req).start) startTask(t.id);
  return t;
});
app.post('/api/tasks/:id/accept', async (req, reply) => {
  try {
    await acceptTask(id(req));
    return { ok: true };
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/tasks/:id/merge', async (req, reply) => {
  try {
    await mergeTask(id(req));
    toast(`Merged #${id(req)}`);
    return { ok: true };
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/tasks/:id/pr', async (req, reply) => {
  try {
    const url = await openPr(id(req));
    return { url };
  } catch (e) {
    return fail(reply, e);
  }
});
app.get('/api/tasks/:id/events', async (req) => repo.listEvents(id(req), 1000));
app.get('/api/tasks/:id/diff', async (req) => {
  const t = repo.getTask(id(req));
  if (!t?.worktree || !t.baseBranch) return { diff: '' };
  return { diff: await fullDiff(t.worktree, t.baseBranch) };
});

// ----- inbox
app.post('/api/inbox/:id/answer', async (req) => {
  const { answer, remember } = body<{ answer: string; remember?: boolean }>(req);
  return { result: answerItem(id(req), answer, !!remember) };
});
app.post('/api/inbox/:id/dismiss', async (req) => {
  dismissItem(id(req));
  return { ok: true };
});

// ----- settings, projects, rules, preferences
app.get('/api/settings', async () => repo.getSettings());
app.patch('/api/settings', async (req) => {
  const b = body<Partial<Settings>>(req);
  if (b.paused !== undefined) setPaused(b.paused);
  const s = repo.updateSettings(b);
  bus.publish({ type: 'settings', data: s });
  tick();
  return { settings: s, restartNeeded: s.lanAccess !== settingsAtBoot.lanAccess };
});
app.post('/api/pause', async (req) => {
  setPaused(!!body(req).paused);
  return { ok: true };
});
app.post('/api/projects', async (req, reply) => {
  try {
    return await addProjectFromPath(body(req).path, body(req).name);
  } catch (e) {
    return fail(reply, e);
  }
});
app.delete('/api/projects/:id', async (req) => {
  repo.removeProject(id(req));
  bus.publish({ type: 'projects', data: repo.listProjects() });
  return { ok: true };
});
app.delete('/api/rules/:id', async (req) => {
  repo.removeRule(id(req));
  bus.publish({ type: 'rules', data: repo.listRules() });
  return { ok: true };
});
app.post('/api/preferences', async (req) => {
  repo.addPreference(body(req).text);
  bus.publish({ type: 'preferences', data: repo.listPreferences() });
  return { ok: true };
});
app.delete('/api/preferences/:id', async (req) => {
  repo.removePreference(id(req));
  bus.publish({ type: 'preferences', data: repo.listPreferences() });
  return { ok: true };
});

// rules list changes when "remember" is ticked
bus.subscribe((msg) => {
  if (msg.type === 'inbox' && msg.data.status === 'answered') bus.emit('msg', { type: 'rules', data: repo.listRules() });
});

// ----- folder picking
app.get('/api/fs/list', async (req, reply) => {
  try {
    return await listDirs(String((req.query as any).path ?? ''));
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/fs/choose', async (req, reply) => {
  if (!isLoopback(req.ip)) return reply.code(400).send({ error: 'The native folder dialog only works on this Mac' });
  return { path: await chooseFolderNative() };
});
app.get('/api/sessions', async (req, reply) => {
  const cwd = String((req.query as any).cwd ?? '');
  if (!cwd) return reply.code(400).send({ error: 'cwd is required' });
  return listSessions(cwd);
});
app.post('/api/tasks/adopt', async (req, reply) => {
  try {
    return await adoptSession(body(req));
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/plans', async (req, reply) => {
  try {
    return createPlan(body(req));
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/tasks/:id/detach', async (req, reply) => {
  try {
    return await detachTask(id(req));
  } catch (e) {
    return fail(reply, e);
  }
});
app.post('/api/tasks/:id/handback', async (req) => ({ result: handBack(id(req), !!body(req).carryOn) }));
app.post('/api/tasks/:id/terminal', async (req, reply) => {
  if (!isLoopback(req.ip)) return reply.code(400).send({ error: 'Opening a terminal only works on this Mac' });
  try {
    await openInTerminal(id(req));
    return { ok: true };
  } catch (e) {
    return fail(reply, e);
  }
});
app.get('/api/tasks/:id/commands', async (req) => taskCommands(id(req)));
app.post('/api/tasks/:id/model', async (req) => ({ result: await setTaskModel(id(req), String(body(req).model)) }));
app.post('/api/tasks/:id/fresh', async (req) => ({ result: await freshSession(id(req)) }));

// ----- run + terminal
const pid = (req: FastifyRequest) => Number((req.params as any).projectId);
const procCall = async (reply: any, fn: () => unknown) => {
  try {
    return (await fn()) ?? { ok: true };
  } catch (e) {
    return fail(reply, e);
  }
};
app.post('/api/projects/:projectId/run', (req, reply) => procCall(reply, () => startRun(pid(req))));
app.post('/api/projects/:projectId/run/stop', (req, reply) => procCall(reply, () => stopRun(pid(req))));
app.post('/api/projects/:projectId/run/restart', (req, reply) => procCall(reply, () => restartRun(pid(req))));
app.put('/api/projects/:projectId/run/command', (req, reply) => procCall(reply, () => setRunCommand(pid(req), String(body(req).command ?? ''))));
app.post('/api/projects/:projectId/terminal', (req, reply) => procCall(reply, () => runTerminal(pid(req), String(body(req).command ?? ''))));
app.delete('/api/projects/:projectId/terminal', (req, reply) => procCall(reply, () => clearTerminal(pid(req))));
app.post('/api/procs/:procId/input', (req, reply) => procCall(reply, () => sendInput(String((req.params as any).procId), String(body(req).text ?? ''))));
app.post('/api/procs/:procId/stop', (req, reply) => procCall(reply, () => stopProc(String((req.params as any).procId))));

// ----- search & digest
app.get('/api/search', async (req) => repo.search(String((req.query as any).q ?? '')));
app.get('/api/digest', async (req) => digest(Number((req.query as any).since ?? Date.now() - 3600e3)));

// ----- built dashboard
const dist = join(here, '..', '..', 'web', 'dist');
if (existsSync(dist)) {
  // index.html must not be cached, or a rebuilt dashboard keeps loading old bundles.
  await app.register(fastifyStatic, {
    root: dist,
    setHeaders: (res, path) => {
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => (req.url.startsWith('/api') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html')));
}

const host = settingsAtBoot.lanAccess ? '0.0.0.0' : '127.0.0.1';
await app.listen({ port: PORT, host });
console.log(`Master server on http://${host}:${PORT}${settingsAtBoot.lanAccess ? `  (LAN token: ${settingsAtBoot.accessToken})` : ''}`);
tick();
