# Master: handoff notes

Context for whoever picks this project up next, whether a person or a Claude session. It covers what the project is for, how it's built, why it's built that way, and how to work on it safely. User-facing docs are in [README.md](README.md).

## What it is and who it's for

The owner vibe-codes with many Claude agents in parallel and wanted **one chat** that runs them all, plus a dashboard. The goal is to make vibe coding faster: say what you want, agents do it, and only real decisions come back to you.

Repository: https://github.com/ALacc776/Agent-master (private, owner ALacc776).

## The owner's requirements and preferences

These came up repeatedly; keep honoring them.
- **The master never blocks.** Its tools return immediately. It never waits on workers or holds the chat. Worker questions go to the dashboard ("Agent #3 needs: …") and you keep chatting.
- **A cheap model for the master** (Haiku), and for summaries, suggestions, auto-answers and review. Workers use Sonnet by default, Opus for hard work, Haiku for trivial work.
- **Auto mode by default:** ask the developer as little as possible.
- **No "accept everything" chores:** finished work merges itself. Review only holds what needs eyes.
- **Agents keep context:** reuse agents rather than creating a new one per message.
- **One master per project, plus a Boss.**
- **Apple-like UI:** SF system font, light/dark, a Graphite accent by default (the owner dislikes blue), frosted glass, pill buttons, iOS-style settings.
- **Everything collapsible or maximizable,** keyboard-friendly.
- **Ask minimal questions when building features:** pick sensible defaults, state them, build, and test for real.

## Architecture

```
Browser dashboard ─┐                       ┌─ Boss master + one master per project (Haiku SDK sessions, MCP tools)
master CLI ────────┼─ REST + WebSocket ──► │  Fastify server (127.0.0.1:4545)
Claude Code + MCP ─┘                       ├─ Workers: one Claude Agent SDK query() per task, in its own git worktree
                                           ├─ PermissionGate (canUseTool) → rules / policy / auto mode / Needs you
                                           ├─ Scheduler (caps, deps, autoStart), Watchdog (stalls, loops, long sessions)
                                           ├─ Processes (Run panel dev server + terminal commands)
                                           └─ SQLite (node:sqlite) in data/master.db, EventBus → WebSocket
```

- **Stack:** TypeScript, Node 26, npm workspaces (`server/`, `web/`). The server runs with `tsx` (no build step). The web side is Vite + React 18 + Tailwind 3. The database is `node:sqlite`, built into Node, so there are no native modules. Agents run through `@anthropic-ai/claude-agent-sdk`, using the developer's `claude` login (or `ANTHROPIC_API_KEY`).
- **State flow:** everything that changes goes through `ctx.ts` helpers (`updateTask`, `addInbox`, `closeTaskInbox`, `addEvent`, …), which persist to SQLite **and** publish on `bus`. `index.ts` fans bus messages out to every WebSocket. The dashboard keeps a client store (`web/src/store.ts`) fed by a snapshot plus incremental messages.

## Key concepts

### Task status lifecycle
`queued` → `running` ⇄ `needs_input` / `stalled` → then one of:
- **`done`**: waiting in Review;
- **`idle`**: "Ready for more", either Keep or planning and waiting for your reply;
- **`accepted`**: finished; merged, PR'd, dismissed or no changes;
- **`failed`** or **`stopped`**.

Flags in `tasks.flags`:
- `paused`, `stalled`, `looping`, `collision`, `long`, `nudged`;
- `attached`: open in the developer's terminal;
- `adopted`: taken over from a `claude` session the developer started;
- `plan`: in plan mode;
- `planned`: was a plan conversation.

### When done (`tasks.on_done`)
After a turn finishes, `land()` in `workers/manager.ts` decides:
- **`keep`**: stays idle with its context.
- **`review`**: held for the developer.
- **`merge`**: automatic review first, then merge into the base branch. Merges into one project are serialized by a per-project lock.
- **`pr`**: push and `gh pr create`.

If the review finds concerns, or the merge or PR fails, the task goes to Review with an `outcome` explaining why.

### Masters and scopes
- A scope is `'boss'` or a project id string. `master/agent.ts` keeps one `MasterAgent` per scope.
- Each master has its own SDK session (`masterSessionId[:scope]` in the kv table), its own model (`masterModel:scope`), and its own messages (the `master_messages.scope` column).
- A project master's tools force its own project. The Boss has `ask_project_master`.
- Every user message gets a `<state>` block (tasks, idle agents, recently finished, inbox, preferences) plus `<when_done>` and `<model>` from the bottom bar.

### Permissions (`permissions/`)
- **`policy.ts`** (pure, tested) classifies each tool call as **allow**, **ask** or **always_ask**.
  - The always-ask list: push, merge/rebase/pull, reset --hard, `gh pr`, `rm -rf`, publish, deploy, global installs, `sudo`, `curl | sh`, and edits outside the worktree.
  - The safe-command splitter understands quotes and `$(…)`, so multi-line commit messages work.
- **`gate.ts`** applies, in order:
  1. remembered deny rules;
  2. policy allow;
  3. in auto mode, an automatic refusal for edits outside the folder;
  4. in auto mode, allow anything else on the "ask" list;
  5. remembered allow rules;
  6. otherwise a Needs-you item, where **only that worker waits**.

  It also routes `AskUserQuestion` (auto-answered by Haiku in auto mode unless it's a real decision) and `ExitPlanMode` (plan approval).
- **The registration race:** the pending answer must be registered **before** calling `onPendingChange`, or the status never flips to `needs_input`. There's a test for this.

### Plan mode
- `createPlan` creates a task with flag `plan`. The runner starts it with `permissionMode: 'plan'` and plan-specific rules.
- The SDK sends `ExitPlanMode` to `canUseTool`. The gate creates a `plan` inbox item and waits.
- **Approve** removes the `plan` flag and adds `planned`, then returns allow with `updatedPermissions: [{type:'setMode', mode:'default'}]`. The same session goes on to build.
- **Keep planning** denies, sending your notes to the agent.

### Reusing and reopening agents
`messageTask` on an `accepted` task calls `reopenWorktree`, which recreates the worktree **at the same path**. Claude sessions are stored per working directory, so the same path means `resume` still works. Merged tasks get a fresh branch from the base branch; dismissed ones reuse their kept branch.

### Processes (`processes.ts`)
- The Run panel's dev server and terminal commands run through the user's login shell (`$SHELL -lc`, `detached`), so their PATH matches the user's terminal.
- Stop kills the whole process group. All processes are killed when Master exits.
- Output is ANSI-stripped and sent to the dashboard in 80 ms batches.

## File map

```
server/src/
  index.ts              REST + WebSocket routes, snapshot, static dashboard (index.html served no-cache)
  ctx.ts                repo + bus helpers that persist AND broadcast; use these, not repo directly, for live data
  bus.ts, channel.ts    event bus; InputChannel (async iterable for streaming SDK input)
  store/                schema.sql, db.ts (open + migrations), repo.ts (all SQL)
  master/agent.ts       MasterAgent per scope, getMaster(scope), masterStates()
  master/tools.ts       the masters' MCP tools (spawn/message/control/app/terminal/plans/…)
  master/prompt.ts      system prompts (base + boss/project role) and the <state> block
  workers/runner.ts     one SDK query() per task: worktree, streaming, turns, loop detection, finish
  workers/manager.ts    runners map, scheduling glue, land(), merge/PR/accept, reopen, fresh session,
                        plans, detach/hand back (CLI attach), adopt
  workers/worktree.ts   git helpers (create/reopen/remove worktrees, commit, diff, merge, PR)
  workers/summarize.ts  summaries and the automatic review (blocks only real problems)
  permissions/          policy.ts, rules.ts, gate.ts, suggest.ts (suggested answers, auto-answers)
  scheduler.ts          pure pickStartable/blockReason (caps, budget, deps, non-git lock)
  watchdog.ts           stalled/looping/collision/long-session flags; auto-nudge/fresh in auto mode
  processes.ts          Run panel + terminal processes
  commands.ts           slash-command lists reported by agents (for the / menu)
  sessions.ts           reading ~/.claude/projects/<cwd>/*.jsonl (for `master adopt`)
  inbox.ts              answerItem(): one entry point for answering Needs-you items
  llm.ts                oneShot() cheap-model helper, pickModel, MODEL_GUIDE, explainError
  digest.ts, notify.ts, fs.ts, projects.ts, loop.ts
web/src/
  App.tsx               layout (sidebar, views, panels, popups) + keyboard shortcuts
  store.ts              client store (snapshot + WS messages), per-browser prefs in localStorage
  api.ts                REST client + WebSocket connect
  theme.ts, index.css   light/dark tokens, accents (Graphite default)
  ui.tsx                shared bits: useBoard/useScopedTasks, ModelSelect, WhenDone, MaximizeButton, …
  components/           Board, cards, MasterChat (panel/full/bar), AgentsView, PlanPanel, ConsolePanel,
                        Sidebar, TopBar, Settings, Modals, FolderPicker, TranscriptDrawer, Maximized, CommandMenu
bin/master.mjs          `master` CLI (plain JS, no build)
bin/master-mcp.mjs      MCP server giving Claude Code the master tools (`master claude`, `install-mcp`)
shared/types.ts         types shared by server and web
test/                   node:test via tsx: policy, scheduler, gate (isolated DB), worktree (real git)
```

## Working on it safely

- **Never test against the owner's real server or data.** They run `npm start` on port **4545** with `data/master.db`. Run a separate test server:
  ```bash
  PORT=4546 MASTER_DATA_DIR=<scratch>/data npx tsx server/src/index.ts
  ```
  Point the CLI at it with `MASTER_URL=http://127.0.0.1:4546`.
- **Use throwaway git repos** as test projects. Agent runs cost real money, so prefer `claude-haiku-5-5` for tests.
- **Verify for real:** drive the dashboard in a browser (switch views with `localStorage.masterView` or by clicking the segmented control) and use the CLI or REST to check state. Several real bugs were only found this way: the policy splitter, the status race, garbled paths from Haiku, a reviewer that was too strict, and plan flags being lost.
- **Checks:** `npm run typecheck` and `npm test` (tests run with `tsx --test`; Node's own strip-types mode can't handle constructor parameter properties).
- **After server changes,** tell the owner to restart (Ctrl+C, `npm start`). A stale server answers new routes with 404, which the dashboard reports as "server is older than this page".
- **React:** keep hooks unconditional. Don't call hooks inside conditional JSX, and don't return early before hooks.
- **Migrations:** add columns in `store/db.ts` `migrate()` (`schema.sql` only applies to new databases).
- **Commits** end with the Co-Authored-By line used in the history. Push only when asked.

## Known limits / ideas for later

- **Phone width:** the sidebar is hidden, and there's no other project switcher there yet.
- **Terminal:** runs one command at a time and isn't a pty. Interactive tools need `master attach` or the Terminal button.
- **Untested end to end:** the PR path (needs `gh auth login`), the native Finder folder dialog, and the dashboard's "Open in Terminal" button (opens Terminal.app).
- **Command output tables** like `/context` show as raw markdown.
- **Possible next steps:**
  - cost charts per project;
  - richer markdown rendering;
  - a pty terminal (`node-pty` would need a native build on Node 26);
  - project-level CLAUDE.md editing from Settings;
  - notifications when a plan is ready;
  - drag-and-drop between columns.

## History (high level)

1. Core: Haiku master, workers in worktrees, permission gate and Needs you, scheduler, watchdog, dashboard, CLI.
2. Folder picker, turn counter and fresh sessions, the master picks models, up to 20 agents.
3. Apple-style redesign, themes, Board/Split/Master layouts.
4. Auto mode and When done (merge/review/PR), Review trimmed to real issues.
5. CLI: `master` command, `attach`, `adopt`, Claude Code as master (MCP).
6. Claude commands and live model switching in the dashboard.
7. Keep option, agent reuse and reopening, `@agent`, the Model toggle.
8. Merge all, Compact, the Agents wall.
9. Boss and per-project masters, collapsible sidebar.
10. Run and Terminal panel, Plan panel (plan mode with approval), maximize popups.
11. Masters can operate everything: app, terminal, pause, settings, finish tasks, plans.
