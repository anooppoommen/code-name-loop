# Loop

Loop is a local-first desktop coding agent powered by Gemini. It combines a Go
backend for agent execution and persistence with an Electron + React desktop UI
for managing workspaces, conversations, patches, checkpoints, and Git workflows.

> [!WARNING]
> Loop is experimental. It can read and modify files, run shell commands, and
> perform Git operations in workspaces you add. Use it with source-controlled
> projects and review command approvals and patches carefully.

## Features

- Workspace and conversation management with local SQLite persistence
- Streaming agent activity, tool calls, results, and token statistics
- File inspection, search, patching, and guarded command execution
- Command approval prompts for sensitive operations
- Git status, branch checkout/creation, worktrees, and upstream pushes
- Conversation checkpoints, undo, restore, and patch application
- Local and SSH-tunneled backend connections from the desktop app
- Searchable command palette and conversation history

## Architecture

| Component | Technology | Purpose |
| --- | --- | --- |
| `loop/` | Go, SQLite, Gemini API | Agent runtime, tools, persistence, and HTTP/SSE API |
| `loop-desktop/` | Electron, React, TypeScript, Vite | Desktop interface |
| `Makefile` | Bash/Make | Runs and supervises both services locally |

## Requirements

- Go 1.25 or newer
- Node.js and npm
- Git
- A Gemini API key
- macOS or Linux for the included Make-based development workflow

## Quick start

Clone the repository:

```bash
git clone https://github.com/anooppoommen/code-name-loop.git
cd code-name-loop
```

Create the backend configuration:

```bash
cp loop/.env.example loop/.env
```

Set `GEMINI_API_KEY` in `loop/.env`, then start the backend and desktop app:

```bash
make dev
```

The backend listens on `http://localhost:8080` and Vite uses
`http://localhost:5173` by default. Press `Ctrl+C` to stop both processes.

Useful development commands:

```bash
make backend  # backend only
make desktop  # desktop only
make status   # process and listener status
make logs     # follow backend and desktop logs
make stop     # stop processes started by make dev
```

## Run components separately

Start the backend:

```bash
cd loop
cp .env.example .env
# Add your GEMINI_API_KEY to .env
go run .
```

In another terminal, start the desktop app:

```bash
cd loop-desktop
npm install
npm run dev
```

## Configuration

The backend reads `loop/.env` and environment variables. Environment variables
take precedence.

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `GEMINI_API_KEY` | Yes | — | Gemini API credential |
| `LOOP_MODEL` | No | `gemini-3.1-pro-preview` | Gemini model used by the agent |
| `LOOP_PORT` | No | `:8080` | Backend listen address |
| `LOOP_DB_PATH` | No | `loop.db` | SQLite database path |

To override Make defaults inline:

```bash
LOOP_PORT=:9090 LOOP_DB_PATH=development.db make dev
```

## Tests and checks

Run the backend test suite:

```bash
cd loop
go test ./...
```

Run the desktop checks:

```bash
cd loop-desktop
npm install
npm test
npm run lint
npm run build
```

The optional SSH end-to-end test uses the test-key setup script and Docker
Compose configuration in the repository:

```bash
./scripts/setup-test-keys.sh
docker compose -f docker-compose.test.yml up --build -d
cd loop-desktop && npm run test:e2e:ssh
```

## Local data and security

- `loop/.env`, SQLite databases, runtime logs, test keys, and generated
  evaluation results are ignored by Git.
- Conversations and messages are stored in the configured local SQLite file.
- The Gemini API key is read by the backend and should never be committed.
- Generated prompt-evaluation datasets can contain messages, paths, and model
  outputs; keep them local.
- Use the desktop command-approval flow to inspect sensitive commands before
  allowing them to run.

## Repository layout

```text
.
├── loop/               # Go backend and agent runtime
├── loop-desktop/       # Electron + React desktop app
├── scripts/            # Development and test helpers
├── Makefile            # Local development orchestration
└── docker-compose.test.yml
```

