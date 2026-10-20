# Master

One chat that runs a fleet of Claude coding agents, plus a dashboard to keep track of them.

You talk to **the master** (a cheap, fast Haiku agent). It turns what you say into tasks and starts worker agents (Sonnet by default, Opus for hard work) without asking you. You can keep chatting while they work. The master never waits on them.

The dashboard has four columns:

- **Needs you**: "Agent #3 wants permission: `git push`", "Agent #5 has a question: JWT or sessions?", stalled or looping agents, failures. Each card has a suggested answer from a cheap model, one-click buttons, and **Remember this answer** so you aren't asked again.
- **Running**: live status line ("Editing theme.ts", "Running npm test"), elapsed time, cost, warnings. Peek, pause or stop.
- **Queue**: tasks waiting for you to press **▶ Start** (or **Start all**). Edit the brief, project, model or dependency. Drag to reorder.
- **Review**: finished work with a summary, diff, and an automatic review. **Accept**, **Merge**, **Open PR**, **Ask for changes**, or queue a **Follow-up**.

## Setup

```bash
npm install
```

The agents run through the Claude Agent SDK, which uses your `claude` CLI login. If `claude auth status` says you're not logged in:

```bash
claude auth login
```

(Or export `ANTHROPIC_API_KEY` before starting.)

## Run

```bash
npm start
```

Open http://127.0.0.1:4545. Pick where to build with **Build in → Choose a folder…** under the chat (a Finder dialog or a built-in folder browser), then tell the master what you want, e.g. *"Fix the broken signup redirect, and later add dark mode."*

For development with hot reload: `npm run dev` (dashboard on http://localhost:5173).

## How it works

- **Workers:** each task gets its own git worktree and branch (`<project>/.master-worktrees/<id>-<slug>`, branch `master/<id>-<slug>`), so parallel agents never edit the same checkout. Non-git folders run in place, one task at a time.
- **Permissions:**
  - Agents edit files inside their worktree and run safe commands (tests, builds, git status/commit, local installs) without asking.
  - **Always asks:** push, merge or rebase, deploy or publish, `rm -rf`, `sudo`, global installs, and edits outside the worktree.
  - Everything else becomes a Needs-you card. Only that one agent waits.
- **"Now" vs "queue":** direct requests start right away. "Later" requests and things the master suggests on its own go to the queue.
- **Models:** the master picks a model for every task and says why (Haiku for trivial work, Sonnet by default, Opus for hard work). Tasks you add yourself can use **Auto**, which picks the same way.
- **Limits:** 4 agents at once by default; change it with the − / + in the top bar (up to 20). $20/day spending cap by default (Settings). Over the limit, tasks wait and start themselves when a slot frees up.
- **Turns:** every card shows how many model turns the agent has used in its current session. At 100 (configurable), you get a Needs-you card: **Start fresh session** stops the agent, writes a handoff summary, and continues in a new session to save context.
- **Pause all** interrupts every agent. **Resume all** continues each from where it stopped.
- **Watchdog:** flags agents with no activity for 10 minutes, agents repeating the same action 3 times, and two agents editing the same files.
- **Notifications:** a Mac notification when something needs you or finishes. Optional phone push via [ntfy.sh](https://ntfy.sh): set a topic in Settings and subscribe to it in the ntfy app.
- **Phone access:** off by default. Turn on "Open the dashboard from other devices" in Settings, restart, and open the URL with the token shown there.
- **While you were away:** come back after 30+ minutes and you get a short digest of what happened.
- **Layouts:** **Board** hides the master behind a floating chat bar at the bottom (replies peek above it), **Split** shows the board with the chat on the right, **Master** makes the chat full screen with status pills on top.
- **Appearance:** Settings → Appearance: Auto/Light/Dark and an accent color (Graphite by default). Saved per browser.
- **Search** (`/`) covers tasks, agent output and master chat. **Voice input**: the mic button in the chat.

## Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Move between cards |
| `a` | Accept the suggested answer (or accept a finished task) |
| `y` / `n` | Allow / deny a permission request |
| `r` | Reply to the selected card |
| `s` | Start the selected queued task |
| `o` / `Enter` | Open the transcript |
| `c` | Focus the master chat |
| `/` | Search |
| `p` | Pause all / resume all |
| `N` | New task |
| `1` / `2` / `3` | Board / Split / Master layout |
| `?` | Show shortcuts |

## Layout

```
server/src/
  index.ts            HTTP + WebSocket API
  master/             the master agent (Haiku) and its tools
  workers/            worker runner, worktrees, scheduler glue, summaries/review
  permissions/        policy, remembered rules, Needs-you gate, suggested answers
  scheduler.ts        concurrency, budget and dependency rules
  watchdog.ts         stalled / looping / collision detection
web/src/              React dashboard
shared/types.ts       types shared by both
data/                 SQLite database (created on first run)
```

Tests: `npm test`. Typecheck: `npm run typecheck`.
