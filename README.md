# DevPilot AI

A local-first developer workspace that orchestrates multiple AI coding CLIs in parallel. Describe what you want built — DevPilot splits the work into tasks, launches an AI agent per task in isolated git worktrees, and merges the results.

## Features

- **Parallel AI orchestration** — up to 4 tasks running simultaneously, each in its own terminal with its own git worktree and branch
- **5 CLI profiles** — Claude Code, GitHub Copilot CLI, OpenCode, Freebuff, Antigravity
- **Per-task picker** — override CLI, model, and skills per task (built for free-tier quota management: switch a task to whichever CLI still has quota)
- **Automatic task injection** — tasks are typed into each CLI automatically, including TUI-based CLIs (OpenCode, Freebuff)
- **Isolated worktrees** — each task works on `devpilot/<session>/<terminal>` branch; **Merge all** integrates into your local `main`
- **Validation gates** — configurable build/test checks that must pass before merge
- **Skills as mandate** — picked skills are injected as explicit instructions, not just labels
- **Local-first** — backend binds to loopback only; 32-byte rotating session token; no cloud, no telemetry

## Quick Start

### Prerequisites

- Node.js 20+
- Git
- At least one AI CLI installed and verified (Claude Code, Copilot CLI, OpenCode, Freebuff, or Antigravity)

### Install

```bash
git clone https://github.com/xcell321/DevPilotAI.git
cd DevPilotAI
npm install
```

### Run

```bash
npm run dev
```

This starts both the backend (`127.0.0.1:49675`) and the web UI. Open the printed URL in your browser.

### First workflow

1. Go to **Terminals** → pick a project
2. Describe what you want built in one prompt
3. Review the plan — override CLI / model / skills per task if needed
4. Click **Start workflow** — agents work in parallel
5. Click **Merge all** when tasks complete

## CLI Profiles

| CLI | Notes |
|-----|-------|
| Claude Code | Via FreeLLMAPI router or direct API key |
| GitHub Copilot CLI | Automatic model selection |
| OpenCode | Free tier supported; TUI auto-injection |
| Freebuff | Free tier supported; TUI auto-injection |
| Antigravity | Gemini models |

Verify a CLI profile under **CLI Tools** before using it in workflows.

### Per-task defaults

| CLI | Default model |
|-----|---------------|
| Antigravity | Gemini 3.8 Flash (medium) |
| OpenCode | DeepSeek V4.1 Flash (free) |
| Freebuff | DeepSeek V4.1 Flash 10/17 (high) |
| Claude Code | FreeLLMAPI (router) |
| GitHub Copilot | Automatic |

## Architecture

```
DevPilotAI/
├── server/          # Express 5 backend (127.0.0.1 only)
│   └── src/
│       ├── api/         # REST routes (zod-validated, token-gated)
│       ├── services/    # orchestration, sessions, workflow planner, terminals
│       ├── security/    # token auth, origin guards, audit logging
│       └── db/          # SQLite (better-sqlite3)
├── apps/web/        # React 19 + Vite + Tailwind frontend
├── shared/          # Shared types and limits
├── scripts/         # dev.mjs (dual-process launcher)
└── electron/        # Optional desktop wrapper
```

### Key design decisions

- **Deterministic planner** — no LLM needed to split tasks; the planner inspects your git-tracked files and decomposes the prompt into non-overlapping scopes
- **argv-only spawning** — CLIs are launched via `node-pty` with argument arrays, never shell strings
- **Worktree isolation** — each task gets its own git worktree; the shared project folder is never touched directly
- **Staggered injection** — parallel terminal launches are staggered so TUI-based CLIs have time to initialize

## Security Model

DevPilotAI is a **local-only** application. Its security model assumes loopback-only access:

- 256-bit random token, rotated per backend run, compared with `timingSafeEqual`
- Host + Origin guards on HTTP and WebSocket
- Content-Security-Policy, `Cache-Control: no-store` on API responses
- Auth failure audit logging (never logs the token)
- ANSI/control-sequence sanitization before terminal injection
- Parameterized SQL throughout; no `eval`, no `innerHTML`

> ⚠️ **Do not expose beyond 127.0.0.1.** The backend performs arbitrary command execution by design (it's a developer tool). For remote access, use a VPN such as Tailscale — never port-forward or reverse-proxy it publicly.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start backend + frontend (dev) |
| `npm run build` | Build server + web |
| `npm run typecheck` | TypeScript checks |
| `npm run lint` | ESLint |
| `npm run test` | Server test suite (154 tests) |
| `npm run verify` | Full gate: typecheck + lint + test + build + e2e |

## Configuration

Environment variables (all optional):

| Variable | Description |
|----------|-------------|
| `DEVPILOT_DB_PATH` | SQLite path (default: `./data/devpilot.db`) |
| `DEVPILOT_GIT_AUTHOR_EMAIL` | Git author email for agent commits |
| `DEVPILOT_GIT_COMMITTER_EMAIL` | Git committer email for agent commits |
| `DEVPILOT_WEB_HOST` | Dev web server host |

## License

MIT
