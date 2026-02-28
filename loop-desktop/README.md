# Loop Desktop

Electron + React + Tailwind + TypeScript desktop client for the `loop` agent backend.

## Features

- Chat-style task input for Loop Agent conversations
- Live progress timeline from SSE turn events (`status`, `tool_call_start`, `tool_result`, etc.)
- Workspace and conversation management from backend APIs
- Native folder picker in Electron (`Choose Folder`)
- Stream cancel/stop support

## Backend expectation

Run the loop backend first (default URL in the app is `http://localhost:8080`):

- `GET /workspaces`
- `POST /workspaces`
- `GET /workspaces/{wsID}/conversations`
- `POST /conversations`
- `POST /conversations/{id}/reply` (SSE)

## Run

```bash
npm install
npm run dev
```

This starts Vite on `http://localhost:5173` and Electron together.

## Build frontend

```bash
npm run build
```

Start desktop app (this script now builds first to avoid stale/missing `dist`):

```bash
npm run start
```
