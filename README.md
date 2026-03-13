# 🔴 Live Claude Sharing

**Share your Claude.ai conversation in real-time with anyone via a web link.**

Watch Claude think and type — live — from any browser, anywhere.

![Live Claude Sharing screenshot](assets/screenshot.png)

---

## ✨ Features

- 🔴 **Real-time streaming** — see text appear as Claude types
- 🔗 **One-click sharing** — right-click tray → "Share online" → link copied
- 🌍 **Cloudflare Tunnel** — built-in, no manual setup needed
- 🔐 **Token auth** — viewers need the link, sources connect locally
- 📎 **Artifact support** — code blocks, iframes, interactive content captured
- 💾 **Persistence** — conversation survives server restart
- 🔄 **Auto-reconnect** — on disconnect, for both source and viewer
- 🎨 **Claude-style UI** — warm sand theme matching claude.ai aesthetic
- 📦 **Desktop app** — Electron with system tray (Windows & macOS)

## How it works

```
claude.ai (Chrome)  →  Extension  →  WS Server  →  Viewers (anyone with the link)
   DOM observer          content       :3333         via Cloudflare Tunnel
```

## 🚀 Quick Start

### Option A — Desktop App (recommended)

1. Download from [Releases](https://github.com/theflysurfer/live-claude-sharing/releases)
2. Install the Chrome extension (see below)
3. Open claude.ai → start chatting
4. Right-click tray icon → **"🌍 Share online"**
5. Link is copied to clipboard — send it to anyone!

### Option B — From source

```bash
git clone https://github.com/theflysurfer/live-claude-sharing.git
cd live-claude-sharing
npm install
npm run dev
```

### Install the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select the `extension/` folder
4. Go to `claude.ai` — the extension auto-connects

## 🌍 Sharing

### One-click (Electron app)

Right-click the tray icon → **"🌍 Share online"**:
- Cloudflare Tunnel starts automatically
- Public URL with auth token is copied to clipboard
- Windows notification confirms the link
- **"🛑 Stop sharing"** to close the tunnel

### Manual

```bash
# Option 1: Cloudflare Tunnel (free, no account needed)
cloudflared tunnel --url http://localhost:3333

# Option 2: ngrok
ngrok http 3333
```

Add `?token=YOUR_TOKEN` to the URL (check server logs for the token).

## 🏗️ Architecture

| Component | Path | Description |
|-----------|------|-------------|
| **Extension** | `extension/` | Chrome MV3, MutationObserver on claude.ai DOM |
| **Server** | `server/` | Node.js HTTP + WebSocket relay (dep: `ws`) |
| **Viewer** | `viewer/` | Standalone HTML, markdown + syntax highlighting |
| **Electron** | `main.js` | Desktop wrapper with tray, tunnel, IPC |

## ⚙️ Server Options

```js
new LiveShareServer({
  port: 3333,           // HTTP + WebSocket port
  token: true,          // true = auto-generate, string = custom, null = no auth
  persist: true,        // Save conversation to JSON (survives restart)
  persistPath: "...",   // Backup file path
  viewerDir: "../viewer"
});
```

## 🧪 Testing

```bash
# Level 1 — Server relay (29 tests, pure Node.js)
node test-server.js

# Level 2 — Extension on mock DOM (10 tests, Patchright)
python test-extension.py

# Level 3 — E2E on real claude.ai (needs auth session)
python test-auto.py
```

## 📡 Protocol

| Type | Payload | Description |
|------|---------|-------------|
| `full_sync` | `{ messages: [{id, role, text}], version }` | Full conversation state |
| `message_start` | `{ id, role }` | New message begins |
| `delta` | `{ id, text }` | Text appended (streaming) |
| `delta_replace` | `{ id, text }` | Full text replacement |
| `message_end` | `{ id }` | Message complete |

## 🔧 Extension Selectors

The content script uses centralized DOM selectors for claude.ai (March 2026):

```js
const SELECTORS = {
  userMessage: "[data-testid='user-message']",
  claudeResponse: "[class*='font-claude-response']",
  artifactCard: "[data-testid='artifact-card']",
  artifactIframe: "iframe[sandbox]",
};
```

If claude.ai redesigns, update `SELECTORS` in `extension/content-v2.js`. The extension auto-reports `selector_broken` after 30s with no messages found.

## 📦 Building

```bash
npm run build:win   # Windows .exe
npm run build:mac   # macOS .dmg (needs macOS)
npm run build       # Both
```

Or let GitHub Actions build on tag push:
```bash
git tag v1.2.0
git push origin v1.2.0
# → .exe + .dmg in GitHub Releases
```

## License

MIT
