# Master

A dashboard plus a chat "master" that runs a fleet of Claude coding agents. Read **HANDOFF.md** first: it has the owner's preferences, the architecture, a file map, design decisions and how to test safely. README.md is the user-facing guide.

Rules of thumb:
- The owner runs the real server on port 4545 with `data/master.db`. Never test against it; run a test server with `PORT=4546 MASTER_DATA_DIR=<scratch>/data npx tsx server/src/index.ts` and throwaway git repos.
- Keep the master non-blocking and on a cheap model; keep auto mode quiet; keep the Apple-style UI (Graphite accent, no blue default).
- Change live data through `server/src/ctx.ts` helpers so it's persisted and broadcast.
- Run `npm run typecheck` and `npm test`, and verify features for real (browser + CLI/REST) before saying they work.
- After server changes, the owner must restart (`npm start`). Push only when asked.
