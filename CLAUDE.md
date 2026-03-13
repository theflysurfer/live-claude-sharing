# CLAUDE.md — Live Claude Sharing

## Project Overview

Real-time sharing of Claude.ai conversations via Chrome extension + WebSocket relay + viewer page. Also packaged as an Electron desktop app.

## Architecture

```
Chrome extension (claude.ai)  ──→  WS Server (ws-server.js)  ──→  Viewer (viewer/index.html)
    MutationObserver on DOM         /ws/source → relay            Session selector + owner controls
                                    /ws/viewer → read-only        💭 thinking + 🔧 tools
Pi/CC JSONL watcher ───────────→    /ws/owner  → full control
    Scans ALL recent sessions       Multi-session store
    fs.watch + tail on JSONL        Visibility per session
```

**4 components:**
- `extension/content-v2.js` — Content script on claude.ai, DOM observer → WS source (backward compat, no sessionId)
- `server/pi-source.js` — Multi-session JSONL watcher, discovers ALL recent Pi + Claude Code sessions
- `server/ws-server.js` — Multi-session WS relay: per-session conversations, owner/viewer roles, visibility control
- `viewer/index.html` — Session selector sidebar, thinking/tool collapsibles, owner visibility toggles

**Electron wrapper:** `main.js` + `preload.js` + `tray.js`

## Key Files

| File | Purpose |
|------|---------|
| `extension/content-v2.js` | Content script — DOM parsing, WS source, MutationObserver |
| `extension/manifest.json` | Chrome Manifest V3, matches `claude.ai/*` |
| `server/ws-server.js` | `LiveShareServer` class — HTTP server + WS relay |
| `server/server.js` | Standalone server entry point |
| `viewer/index.html` | Viewer page (works in browser + Electron) |
| `main.js` | Electron main process |
| `tray.js` | System tray with status, copy URL, open browser |
| `preload.js` | IPC bridge for Electron renderer |
| `test-server.js` | Level 1 tests — server relay (29 tests) |
| `test-extension.py` | Level 2 tests — extension on mock DOM (10 tests) |
| `test-mock-page.html` | Mock claude.ai DOM for extension testing |
| `server/pi-source.js` | JSONL watcher — Pi + Claude Code session files → WS source |
| `test-auto.py` | Level 3 tests — full E2E with real claude.ai |

## DOM Selectors (Fragile!)

The extension relies on claude.ai's DOM structure. Selectors are centralized in `SELECTORS` object at the top of `content-v2.js`:

```js
const SELECTORS = {
  userMessage: "[data-testid='user-message']",
  claudeResponse: "[class*='font-claude-response']",
  scroller: "[class*='scrollbar-gutter'], [class*='overflow-y-auto']...",
  contents: ".contents",
};
```

**Last validated:** March 2026 — all selectors working on real claude.ai.

If claude.ai redesigns, update SELECTORS and run `test-extension.py` with updated `test-mock-page.html`.

## Server Options

`LiveShareServer({ port, viewerDir, token, persist, persistPath, debug })`

- `token: true` → auto-generate hex token, viewers need `?token=xxx`
- `persist: true` → save/load conversation JSON to disk
- `debug: true` or `LIVESHARE_DEBUG=1` → verbose logging

## Protocol

All messages include `sessionId`. Chrome extension backward-compat: no `sessionId` → uses default `"claude-ai"`.

### Source → Server
- `register_session` — `{ sessionId, label, sourceType, project }` — register a new session
- `full_sync` — `{ sessionId, messages, version }` — replace conversation
- `message_start` → `delta`/`delta_replace` → `message_end` — streaming

### Server → Viewer
- `session_list` — `{ sessions: [...], isOwner }` — available sessions with metadata
- `full_sync` — `{ sessionId, messages, streamingId }` — current conversation
- `message_start` → `delta`/`delta_replace` → `message_end` — streaming

### Viewer/Owner → Server
- `switch_session` — `{ sessionId }` — change watched session
- `set_visibility` — `{ sessionId, visible }` — owner only, toggle session visibility
- `remove_session` — `{ sessionId }` — owner only

### Message roles
`user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `system`

### WS paths
- `/ws/source` — data sources (extension, pi-source.js)
- `/ws/viewer` — read-only viewers (see only visible sessions)
- `/ws/viewer?owner=true` — owner mode (see all sessions + visibility controls)

## Pi / Claude Code JSONL Source

`pi-source.js` discovers and watches ALL recent sessions across all projects.

```bash
node server/pi-source.js                          # Scan all recent sessions
node server/pi-source.js --session <path.jsonl>    # Watch a specific file
node server/pi-source.js --max-age 120             # Max session age in minutes
node server/server.js --pi                         # Server + watcher together
```

**Session paths:**
- Pi: `~/.pi/agent/sessions/--<encoded-path>--/<session>.jsonl`
- Claude Code: `~/.claude/projects/<encoded-path>/<session>.jsonl`

**Viewer URLs:**
- `http://localhost:3333` — Viewer (sees visible sessions only)
- `http://localhost:3333?owner=true` — Owner (sees all sessions, can toggle visibility)

## Testing

```bash
node test-server.js        # Level 1: 29 server tests (no deps)
python test-extension.py   # Level 2: 10 extension tests (needs patchright)
python test-auto.py        # Level 3: E2E (needs claude.ai session)
```

## Build

```bash
npm run dev          # Electron dev
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG
```

## Gotchas

- **Viewer is unified** — `viewer/index.html` serves both standalone HTTP and Electron. Don't create `server/public/`.
- **Token auth** — Only protects viewer connections. Source (extension) connects without token (localhost only).
- **Extension version** — Included in `full_sync` messages for debugging selector mismatches.
- **Debounce** — 150ms normally, 300ms for conversations with >20 messages.
