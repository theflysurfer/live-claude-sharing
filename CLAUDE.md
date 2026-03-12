# CLAUDE.md — Live Claude Sharing

## Project Overview

Real-time sharing of Claude.ai conversations via Chrome extension + WebSocket relay + viewer page. Also packaged as an Electron desktop app.

## Architecture

```
Chrome extension (content-v2.js) ──→ WS Server (ws-server.js) ──→ Viewer (viewer/index.html)
    MutationObserver on claude.ai       /ws/source → relay → /ws/viewer       Markdown + highlight.js
```

**3 components:**
- `extension/content-v2.js` — Content script injected on claude.ai, observes DOM, sends messages via WebSocket
- `server/ws-server.js` — HTTP + WS relay server, single dependency (`ws`), manages source/viewer connections
- `viewer/index.html` — Single HTML file used by both standalone server and Electron app

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

`full_sync` → `message_start` → `delta`/`delta_replace` (streaming) → `message_end`

- `delta` = append text (optimized, used when text is only appended)
- `delta_replace` = full innerHTML replace (used when content restructures)
- `__debug` = extension diagnostics (selector_broken, container info)

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
