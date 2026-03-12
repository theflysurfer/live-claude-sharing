# 🔴 Live Claude Sharing

Share your Claude.ai conversation in real-time with anyone via a web link.

## How it works

```
Your Chrome (claude.ai)  →  Extension  →  WebSocket Server  →  Viewer page (colleague)
                         DOM observer      localhost:3333       via ngrok tunnel
```

## Quick Start

### 1. Start the server

```bash
cd server
npm install
npm start
```

Server runs on `http://localhost:3333`.

### 2. Install the Chrome extension

1. Open `chrome://extensions/` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `extension/` folder

### 3. Open a Claude conversation

Go to `https://claude.ai` and open any conversation. The extension auto-connects to the server and starts streaming.

### 4. Share with your colleague

**Local network:**
```
http://localhost:3333
```

**Internet (via ngrok):**
```bash
ngrok http 3333
```
Share the ngrok URL with your colleague.

## Architecture

- **Extension** (`extension/`) — Chrome Manifest V3 extension with MutationObserver on claude.ai DOM
- **Server** (`server/`) — Node.js HTTP + WebSocket relay (single dependency: `ws`)
- **Viewer** (`viewer/index.html`) — Standalone HTML page with live WebSocket updates, markdown rendering, code highlighting
- **Electron** (`main.js`, `tray.js`, `preload.js`) — Desktop app wrapper with system tray

## Features

- ✅ Real-time streaming (sees text appear as Claude types)
- ✅ Full conversation sync on connect (join mid-conversation)
- ✅ Auto-reconnect on disconnect
- ✅ Markdown + code syntax highlighting
- ✅ SPA navigation detection (switching conversations)
- ✅ Responsive design
- ✅ Token authentication for viewer access
- ✅ Optional conversation persistence (survives server restart)
- ✅ Conditional debug logging
- ✅ Electron desktop app with system tray

## Server Options

The `LiveShareServer` constructor accepts:

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `port` | number | `3333` | HTTP + WebSocket port |
| `viewerDir` | string | `../viewer` | Path to the viewer HTML directory |
| `token` | string/boolean | `null` | `true` = auto-generate, string = use as token, `null` = no auth |
| `persist` | boolean | `false` | Save conversation to JSON on each sync/message_end |
| `persistPath` | string | `server/conversation-backup.json` | Backup file path |
| `debug` | boolean | `false` | Enable verbose logging (also via `LIVESHARE_DEBUG=1`) |

### Token Authentication

When token auth is enabled, viewers must include `?token=<token>` in the URL. Sources (the Chrome extension) connect without a token.

```bash
# Auto-generate token
node -e "const {LiveShareServer}=require('./server/ws-server'); const s=new LiveShareServer({token:true}); s.start().then(()=>console.log('Token:', s.token))"
```

### Persistence

With `persist: true`, the conversation is saved to disk on every `full_sync` and `message_end`. On restart, the server loads the backup automatically.

## Extension Details

The content script (`extension/content-v2.js`) uses centralized DOM selectors:

```js
const SELECTORS = {
  userMessage: "[data-testid='user-message']",
  claudeResponse: "[class*='font-claude-response']",
  scroller: "[class*='scrollbar-gutter'], ...",
  contents: ".contents",
};
```

If selectors break after a claude.ai redesign, update `SELECTORS` in `content-v2.js`. The extension reports `selector_broken` debug events after 30s with no messages detected.

## Testing

Three test levels, no manual interaction needed for levels 1-2:

```bash
# Level 1 — Server relay (29 tests, pure Node.js)
node test-server.js

# Level 2 — Extension on mock DOM (10 tests, requires patchright)
python test-extension.py

# Level 3 — E2E on real claude.ai (requires authenticated session)
python test-auto.py
```

## Electron App

```bash
# Development
npm run dev

# Build
npm run build:win   # Windows
npm run build:mac   # macOS
```

## Protocol

Messages between extension → server → viewer:

| Type | Direction | Payload |
|------|-----------|---------|
| `full_sync` | source → server → viewers | `{ messages: [{id, role, text}], version }` |
| `message_start` | source → server → viewers | `{ id, role }` |
| `delta` | source → server → viewers | `{ id, text }` (appended) |
| `delta_replace` | source → server → viewers | `{ id, text }` (full replace) |
| `message_end` | source → server → viewers | `{ id }` |
| `__debug` | source → server (logged) | `{ key, val }` |
