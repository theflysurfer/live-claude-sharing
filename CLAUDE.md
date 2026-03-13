# CLAUDE.md — Live Claude Sharing

## Project Overview

Real-time sharing of AI coding conversations. Three source types:
1. **Chrome extension** — scrapes claude.ai DOM via MutationObserver
2. **Pi JSONL watcher** — reads Pi session files (`~/.pi/agent/sessions/`)
3. **Claude Code JSONL watcher** — reads Claude Code session files (`~/.claude/projects/`)

All sources connect to a WebSocket relay server. Viewers see conversations in real-time with thinking blocks, tool calls, and tool results. Cloudflare Tunnel provides public sharing URLs.

Also packaged as an Electron desktop app with system tray.

## Architecture

```
Chrome extension (claude.ai)  ──┐
    MutationObserver on DOM      │
                                 ├──→  WS Server (ws-server.js)  ──→  Viewer (viewer/index.html)
Pi/CC JSONL watcher ─────────────┘      /ws/source → relay            Session selector sidebar
    fs.watch + tail on .jsonl           /ws/viewer → read-only        💭 thinking + 🔧 tools
    Discovers ALL recent sessions       /ws/viewer?owner=true         Owner visibility toggles
                                        Multi-session Map             Share link (Cloudflare)
                                        Cloudflare Tunnel built-in
```

**4 components:**
- `extension/content-v2.js` — Content script on claude.ai, DOM observer → WS source (backward compat, no sessionId → default `"claude-ai"`)
- `server/pi-source.js` — Multi-session JSONL watcher, discovers ALL recent Pi + Claude Code sessions
- `server/ws-server.js` — `LiveShareServer` class: multi-session WS relay, owner/viewer roles, visibility, Cloudflare Tunnel
- `viewer/index.html` — Unified viewer (works in browser + Electron): session sidebar, collapsible thinking/tools, share link

**Electron wrapper:** `main.js` + `preload.js` + `tray.js` (system tray with tunnel toggle)

## Key Files

| File | Purpose |
|------|---------|
| `extension/content-v2.js` | Content script — DOM parsing, WS source, MutationObserver |
| `extension/manifest.json` | Chrome Manifest V3 (`claude.ai/*`) |
| `extension/popup.html` + `popup.js` | Extension popup UI (connect/disconnect) |
| `server/ws-server.js` | `LiveShareServer` class — HTTP + WS relay + Cloudflare Tunnel |
| `server/pi-source.js` | JSONL watcher — Pi + Claude Code sessions → WS source |
| `server/server.js` | Standalone server entry point (`--tunnel`, `--pi` flags) |
| `server/package.json` | Server-only deps (`ws`) |
| `viewer/index.html` | Unified viewer (browser + Electron) |
| `main.js` | Electron main process |
| `tray.js` | System tray — status, tunnel toggle, copy URL |
| `preload.js` | IPC bridge for Electron renderer |
| `package.json` | Root — Electron + electron-builder config |
| `test-server.js` | Server relay tests (52 assertions, 10 test cases) |
| `test-extension.py` | Extension tests on mock DOM (10 tests, needs patchright) |
| `test-mock-page.html` | Mock claude.ai DOM for extension testing |
| `test-auto.py` | Full E2E tests (needs claude.ai session) |
| `start-server.bat` | Windows: start server with `--tunnel` |
| `start-source.bat` | Windows: start pi-source watcher |
| `.github/workflows/build.yml` | CI: build Win EXE + macOS DMG, create GitHub Release on tags |

## Server Options

`LiveShareServer({ port, viewerDir, token, tunnel, persist, persistPath, debug, onStatusChange })`

- `port` — default `3333`
- `token: true` → auto-generate hex token, viewers need `?token=xxx`
- `tunnel: true` → auto-start Cloudflare Tunnel, broadcast public URL to viewers
- `persist: true` → save/load conversation JSON to disk
- `debug: true` or `LIVESHARE_DEBUG=1` → verbose logging

## Protocol

All messages include `sessionId`. Chrome extension backward-compat: no `sessionId` → uses default `"claude-ai"`.

### Source → Server
- `register_session` — `{ sessionId, label, sourceType, project }`
- `full_sync` — `{ sessionId, messages, version }`
- `message_start` → `delta`/`delta_replace` → `message_end` (streaming)

### Server → Viewer
- `server_info` — `{ shareUrl }` — sent on connect (Cloudflare URL or LAN IP fallback)
- `session_list` — `{ sessions: [...], isOwner }` — debounced for count updates, immediate for structural changes
- `full_sync` — `{ sessionId, messages, streamingId }`
- `message_start` → `delta`/`delta_replace` → `message_end` (streaming)

### Viewer/Owner → Server
- `switch_session` — `{ sessionId }`
- `set_visibility` — `{ sessionId, visible }` — owner only
- `remove_session` — `{ sessionId }` — owner only

### Message roles
`user`, `assistant`, `thinking`, `tool_call`, `tool_result`, `system`

### WS paths
- `/ws/source` — data sources (extension, pi-source.js)
- `/ws/viewer` — read-only viewers (see only visible sessions)
- `/ws/viewer?owner=true` — owner (see all sessions + visibility controls)

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

**Last validated:** March 2026. If claude.ai redesigns, update SELECTORS and run `test-extension.py`.

## Pi / Claude Code JSONL Source

`pi-source.js` discovers and watches ALL recent sessions across all projects.

```bash
node server/pi-source.js                          # Scan all recent sessions (default 120min)
node server/pi-source.js --session <path.jsonl>    # Watch a specific file
node server/pi-source.js --max-age 30              # Max session age in minutes
node server/pi-source.js --ws-url ws://host:port/ws/source
```

**Session paths:**
- Pi: `~/.pi/agent/sessions/--<encoded-path>--/<session>.jsonl`
- Claude Code: `~/.claude/projects/<encoded-path>/<session>.jsonl`

**Format detection:** First JSONL line — `type:"session"` = Pi, `uuid`/`parentUuid` = Claude Code.

## Usage

### Standalone (recommended for Pi/Claude Code)

```bash
# Terminal 1: Server with Cloudflare Tunnel
node server/server.js --tunnel

# Terminal 2: JSONL watcher
node server/pi-source.js --max-age 30

# Open viewer
# Owner: http://localhost:3333?owner=true
# Share: https://xxx.trycloudflare.com (shown in header)
```

### Windows helpers
```batch
start-server.bat          # server + tunnel
start-source.bat          # pi-source watcher
C:\temp\ls-server.bat     # same, from fixed path (avoids OneDrive space issues)
C:\temp\ls-source.bat     # same
```

### Electron desktop app
```bash
npm run dev               # Development
npm run build:win         # Windows NSIS installer → dist/*.exe
npm run build:mac         # macOS DMG → dist/*.dmg (needs macOS)
```

## CI / CD

**GitHub Actions** (`.github/workflows/build.yml`):
- **Trigger**: push tag `v*` or `workflow_dispatch`
- **Matrix**: `windows-latest` (exe) + `macos-latest` (dmg)
- **Steps**: `npm ci` → `node test-server.js` → `electron-builder` → upload artifacts
- **Release**: On tags, creates GitHub Release with exe + dmg + zip
- **To release**: `git tag v1.1.0 && git push --tags`

## Testing

```bash
node test-server.js        # Level 1: 52 assertions, 10 test cases (no deps)
python test-extension.py   # Level 2: 10 extension tests (needs patchright)
python test-auto.py        # Level 3: E2E (needs claude.ai session)
```

## Build

```bash
npm run dev          # Electron dev
npm run build:win    # Windows NSIS installer
npm run build:mac    # macOS DMG (needs macOS or CI)
npm run build        # Both
```

## Gotchas

- **Viewer is unified** — `viewer/index.html` serves both standalone HTTP and Electron. Don't create `server/public/`.
- **Token auth** — Only protects viewer connections. Source (extension) connects without token (localhost only).
- **Extension version** — Included in `full_sync` messages for debugging selector mismatches.
- **Debounce** — Extension: 150ms normally, 300ms for >20 messages. Server: `session_list` debounced 2s for count updates.
- **Cloudflare Tunnel** — Both server (`--tunnel` flag) and Electron (tray button) can start tunnels. Don't run both simultaneously.
- **OneDrive paths** — Windows paths with spaces break `spawn()`. Use `.bat` launchers in `C:\temp\` as workaround.
- **DMG build** — Cannot cross-compile from Windows. Use GitHub Actions (`workflow_dispatch`) or a Mac.
