# Master

One chat that runs a fleet of Claude coding agents, with a dashboard to watch and steer them.

You talk to a **master**, a cheap, fast Haiku agent. It turns what you say into tasks and starts **worker agents** (real Claude Code sessions) without asking you. You can keep chatting while they work, because the master never waits on them. Each project has its own master, and a **Boss** master oversees all of them.

## Quick start

```bash
npm install
claude auth login        # once, if `claude auth status` says you're not logged in
npm start                # builds the dashboard and starts the server
```

Open **http://127.0.0.1:4545**, click **Add project…** in the sidebar, pick a folder, and tell its master what you want:

> Fix the broken signup redirect, and later add dark mode.

`npm run dev` gives hot reload for development (dashboard on http://localhost:5173, server on 4545).

After changing server code, restart with Ctrl+C and `npm start`. Dashboard-only changes need just a page reload.

## The dashboard

### Sidebar: Boss and project masters
- **Boss** sees every project. It can start work anywhere and hand bigger requests to a project's master; that request appears in the project master's chat.
- **Each project** has its own master, with its own conversation, memory and model. Selecting a project focuses the whole dashboard on it.
- Badges show what needs you (orange) and how many agents are running; ▶ means that project's app is running.
- The sidebar collapses to an icon rail (`[`).

### Layouts (toolbar, or keys `1`–`4`)
| Layout | What it shows |
|---|---|
| **Board** | Four columns; the master shrinks to a floating chat bar at the bottom (replies pop up above it) |
| **Split** | Board plus the master chat on the right |
| **Master** | The chat full screen, with status pills on top |
| **Agents** | A wall of live agent tiles: each streams what its agent is doing, takes messages, shows Allow/Deny or plan approval when it's waiting on you, and has Merge when ready |

### The board
- **Needs you**: only what really needs you. In auto mode that's pushes, deploys, deletions, real decisions, plan approvals and failures. Each card has a suggested answer, one-click buttons, and **Remember this answer**.
- **Running**: live status, model (switch it live), turns, cost. Below it, **Ready for more** holds agents kept open with their context. Includes **Compact**, **Merge all**, a **Fresh session** button for long runs, and a **Terminal** button.
- **Queue**: tasks waiting for ▶ Start (or Start all). Edit the brief, project, model or dependency, and drag to reorder.
- **Review**: only work that needs your eyes: tasks set to Review, work the automatic review flagged, or work that couldn't merge (with the reason). **Merge**, **Open PR**, **Ask for changes**, **Follow-up**, **Dismiss**, plus **Recently finished** and **Merge all**.

### Talking to the master (bottom bar)
- **Build in**: a project folder (Boss only; a project master always works in its project).
- **Model**: Auto lets the master pick per task (Haiku for trivial work, Sonnet by default, Opus for hard work); otherwise it forces your choice.
- **When done**: **Merge** (default; lands automatically after the review), **Review**, **PR**, or **Keep** (the agent stays open with its context for more instructions).
- `@3 make it blue` talks to agent #3 directly. `/` gives master commands: `/model opus`, `/when review`, `/agents 6`, `/pause`, `/resume`, `/view board`, `/new`.

The master can also **operate everything for you**:
- start, stop or restart the app, read its output, or type into it;
- run terminal commands;
- pause or resume agents, set how many run at once, switch auto mode;
- merge, PR or dismiss finished work;
- start and approve plans.

Just ask: "restart the app and tell me the URL", "what does git status say?", "pause everything".

### Agents keep their context
The master reuses an agent when your message relates to its work, instead of starting a new one. Even finished or merged agents can be continued: they reopen with their memory on a fresh branch from your latest code (click them in Recently finished, or use `@N`).

### Plan panel (`P`)
Talk an idea through with a normal Claude agent in **plan mode**: it reads the project but changes nothing. When it proposes a plan, choose **Approve & build** (the same agent builds it in its own worktree, then finishes per When done) or **Keep planning** with your notes.

### Run and Terminal (bottom panel, per project)
- **Run** starts the project's dev command (auto-detected; click to change), with Restart and Stop, live output, an **Open** button for local URLs, and an input line for typing into the app (e.g. `r` to reload Expo).
- **Terminal** runs commands in the project folder. One command at a time; not an interactive shell.
- The panel collapses to a slim bar with the run buttons; drag its edge to resize.

### Agent tools
- **Transcript** (click a title): full activity, a model switcher, and messages with `/` Claude commands (built-ins, your custom commands and skills).
- **⤢ Maximize** opens the Plan panel, master chat, console or any agent tile as a big popup.
- **Search** (`/`), the **while you were away** digest, and Mac and phone (ntfy) notifications.

### Settings
Appearance (Auto/Light/Dark, accent color), projects, models, limits (agents at once, daily $ cap, stuck timer, turn warning), auto mode, the default When done, remembered answers, preferences, notifications, and access from other devices.

## How agents work
- Each task runs in its own **git worktree and branch** (`<project>/.master-worktrees/<id>-<slug>`, `master/<id>-<slug>`). Non-git folders run in place, one task at a time.
- **Permissions:**
  - Edits inside the agent's own copy and safe commands are always fine.
  - In **auto mode** (the default), anything else routine is allowed too, and questions are answered by Haiku unless they're a real decision.
  - **Push, merge or rebase, deploy or publish, `rm -rf`, `sudo` and global installs always ask you.** Edits outside the agent's folder are refused automatically in auto mode.
- **Watchdog:** stuck or looping agents get nudged. Long sessions (100 turns by default) restart fresh with a handoff summary.
- **Finishing:** commit, summary, automatic review (blocks only real problems), then Merge, Review, PR or Keep.

## Command line

```bash
npm link                     # once, from this folder; installs the `master` command
```

```bash
master                       # chat with the Boss (master --project app for a project's master)
master status                # Needs you / Running / Queue / Review
master say "fix the login bug" --project my-app --when review --model sonnet
master inbox                 # what needs you
master answer 12 allow --remember
master logs 3 -f             # follow agent #3
master msg 3 /compact        # slash commands pass straight through
master attach 3              # pause #3 and open its session in Claude Code; hand it back when you quit
master adopt                 # hand a `claude` session you started (in this folder) to Master
master claude                # open Claude Code AS the master (your commands + Master's tools)
master install-mcp           # give every Claude Code session Master's tools
master help                  # everything else
```

Set `MASTER_URL` and `MASTER_TOKEN` to point the CLI at another machine.

## Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Move between cards |
| `a` | Accept the suggested answer |
| `y` / `n` | Allow / deny a permission request |
| `r` | Reply to the selected card |
| `s` | Start the selected queued task |
| `o` / `Enter` | Open the transcript |
| `c` | Focus the master chat |
| `/` | Search |
| `p` | Pause / resume all |
| `N` | New task |
| `P` | Plan panel |
| `1`–`4` | Board / Split / Master / Agents |
| `[` | Collapse / expand the sidebar |
| `?` | Show shortcuts |

## Development

```bash
npm run typecheck
npm test
```

Architecture, file map, design decisions and how to test against a sandbox are in **[HANDOFF.md](HANDOFF.md)**.
