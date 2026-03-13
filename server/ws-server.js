/**
 * WebSocket relay server — multi-session support.
 * Used by both standalone server.js and Electron main process.
 * 
 * Session model:
 *   Each source registers one or more sessions (sessionId + label + sourceType).
 *   Server stores conversations per session.
 *   Viewers pick which session to watch. Owners can toggle visibility.
 * 
 * WS paths:
 *   /ws/source  — data sources (Chrome extension, pi-source.js)
 *   /ws/viewer  — read-only viewers (see only visible sessions)
 *   /ws/owner   — owner view (see all sessions, toggle visibility)
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

// ─── Rolling file logger (2 MB max, auto-rotate) ───

class RollingLogger {
  constructor(filePath, maxBytes = 2 * 1024 * 1024) {
    this.filePath = filePath;
    this.maxBytes = maxBytes;
    this.fd = null;
    this.bytesWritten = 0;
    this._open();
  }

  _open() {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      let existingSize = 0;
      try { existingSize = fs.statSync(this.filePath).size; } catch {}
      if (existingSize >= this.maxBytes) { this._rotate(); existingSize = 0; }
      this.fd = fs.openSync(this.filePath, "a");
      this.bytesWritten = existingSize;
    } catch (err) {
      console.error(`[Logger] Failed to open ${this.filePath}: ${err.message}`);
    }
  }

  _rotate() {
    const backup = this.filePath + ".old";
    try {
      if (fs.existsSync(backup)) fs.unlinkSync(backup);
      if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, backup);
    } catch {}
  }

  log(level, msg) {
    const line = `${new Date().toISOString()} [${level}] ${msg}\n`;
    const lineBytes = Buffer.byteLength(line);
    process.stdout.write(line);
    if (!this.fd) return;
    try {
      if (this.bytesWritten + lineBytes > this.maxBytes) {
        fs.closeSync(this.fd);
        this._rotate();
        this.fd = fs.openSync(this.filePath, "a");
        this.bytesWritten = 0;
      }
      fs.writeSync(this.fd, line);
      this.bytesWritten += lineBytes;
    } catch {}
  }

  info(msg) { this.log("INFO", msg); }
  debug(msg) { this.log("DEBUG", msg); }
  warn(msg) { this.log("WARN", msg); }
  error(msg) { this.log("ERROR", msg); }

  close() {
    if (this.fd) { try { fs.closeSync(this.fd); } catch {} this.fd = null; }
  }
}

// ─── LiveShareServer ───

class LiveShareServer {
  constructor(options = {}) {
    this.port = options.port || 3333;
    this.viewerDir = options.viewerDir || path.join(__dirname, "..", "viewer");
    this.server = null;
    this.wss = null;

    // Multi-session state
    // sessions: Map<sessionId, { id, label, sourceType, project, conversation, streamingId, visible, connectedAt, lastUpdate }>
    this.sessions = new Map();
    
    // Connection tracking
    this.sources = new Set();       // all source WebSockets
    this.viewers = new Map();       // ws → { isOwner, watchingSessionId }
    this.sourceToSessions = new Map(); // ws → Set<sessionId>

    // Default session for backward-compat (Chrome extension sends no sessionId)
    this.defaultSessionId = "claude-ai";

    // Debounce session list broadcasts (avoid spam on every message event)
    this._sessionListTimer = null;
    this._sessionListImmediate = false;

    // Detect LAN IP for share URL
    this.lanIp = this._detectLanIp();
    this.shareUrl = `http://${this.lanIp}:${this.port}/`;

    // Cloudflare Tunnel
    this.tunnel = !!options.tunnel;
    this.tunnelProcess = null;
    this.tunnelUrl = null;

    // Auth token (null = no auth)
    this.token = options.token || null;
    if (this.token === true) {
      this.token = crypto.randomBytes(16).toString("hex");
    }

    // Persistence
    this.persist = options.persist || false;
    this.persistPath = options.persistPath || path.join(__dirname, "sessions-backup.json");

    // Rolling logger
    const logDir = options.logDir || path.join(__dirname, "..", "logs");
    const logFile = options.logFile || path.join(logDir, "liveshare-server.log");
    const maxLogBytes = options.maxLogBytes || 2 * 1024 * 1024;
    this.logger = options.logger || new RollingLogger(logFile, maxLogBytes);

    this.onStatusChange = options.onStatusChange || (() => {});
  }

  // ─── Session management ───

  _getOrCreateSession(sessionId, defaults = {}) {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        id: sessionId,
        label: defaults.label || sessionId,
        sourceType: defaults.sourceType || "unknown",
        project: defaults.project || null,
        conversation: [],
        streamingId: null,
        visible: true,
        connected: true,
        connectedAt: new Date().toISOString(),
        lastUpdate: new Date().toISOString(),
      });
      this.logger.info(`SESSION created: ${sessionId} (${defaults.sourceType || "unknown"}) "${defaults.label || sessionId}"`);
    }
    return this.sessions.get(sessionId);
  }

  _detectLanIp() {
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === "IPv4" && !net.internal) {
          return net.address;
        }
      }
    }
    return "localhost";
  }

  _getSessionList(includeHidden = false) {
    const list = [];
    for (const [id, s] of this.sessions) {
      if (!includeHidden && !s.visible) continue;
      list.push({
        id: s.id,
        label: s.label,
        sourceType: s.sourceType,
        project: s.project,
        visible: s.visible,
        connected: s.connected,
        messageCount: s.conversation.length,
        streaming: s.streamingId !== null,
        lastUpdate: s.lastUpdate,
      });
    }
    // Sort: connected first, then by lastUpdate desc
    list.sort((a, b) => {
      if (a.connected !== b.connected) return b.connected ? 1 : -1;
      return new Date(b.lastUpdate) - new Date(a.lastUpdate);
    });
    return list;
  }

  // ─── Broadcasting ───

  _broadcastSessionList() {
    // Send full list to owners, filtered list to viewers
    // Also auto-assign viewers to first session if they're watching nothing
    for (const [ws, info] of this.viewers) {
      if (ws.readyState !== 1) continue;
      const list = this._getSessionList(info.isOwner);
      this._sendToWs(ws, { type: "session_list", sessions: list });

      // Auto-assign if viewer has no session and sessions are available
      if (!info.watchingSessionId && list.length > 0) {
        info.watchingSessionId = list[0].id;
        const s = this.sessions.get(list[0].id);
        if (s) {
          this._sendToWs(ws, { type: "full_sync", sessionId: list[0].id, messages: s.conversation, streamingId: s.streamingId });
        }
      }
    }
  }

  /** Debounced session list broadcast — coalesces rapid updates (message events) */
  _broadcastSessionListDebounced() {
    if (this._sessionListTimer) return; // already scheduled
    this._sessionListTimer = setTimeout(() => {
      this._sessionListTimer = null;
      this._broadcastSessionList();
    }, 2000); // max 1 broadcast per 2 seconds for count updates
  }

  _broadcastToSessionViewers(sessionId, data) {
    const msg = JSON.stringify(data);
    let sent = 0;
    for (const [ws, info] of this.viewers) {
      if (ws.readyState !== 1) continue;
      if (info.watchingSessionId === sessionId) {
        ws.send(msg);
        sent++;
      }
    }
    if (data.type !== "delta" && data.type !== "delta_replace") {
      this.logger.debug(`broadcast [${sessionId}] type=${data.type} to ${sent} viewers (${msg.length} bytes)`);
    }
  }

  _sendToWs(ws, data) {
    if (ws.readyState === 1) {
      try { ws.send(JSON.stringify(data)); } catch {}
    }
  }

  // ─── Server lifecycle ───

  start() {
    this.logger.info(`Server starting on port ${this.port}`);
    this.logger.info(`LAN IP: ${this.lanIp}`);
    this.logger.info(`Share URL: ${this.shareUrl}`);
    this.logger.info(`Viewer dir: ${this.viewerDir}`);
    this.logger.info(`Token: ${this.token || "disabled"}`);
    if (this.token) {
      this.logger.info(`Share URL: http://localhost:${this.port}?token=${this.token}`);
    }
    this.logger.info(`Persistence: ${this.persist ? this.persistPath : "disabled"}`);

    this._loadSessions();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.logger.debug(`HTTP ${req.method} ${req.url}`);
        if (req.url === "/" || req.url === "/index.html" || req.url?.startsWith("/?")) {
          const file = path.join(this.viewerDir, "index.html");
          if (fs.existsSync(file)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(file).pipe(res);
          } else {
            this.logger.error(`Viewer file not found: ${file}`);
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body><h1>Live Claude Sharing</h1><p>Viewer not found.</p></body></html>");
          }
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on("connection", (ws, req) => this._handleConnection(ws, req));

      this.server.listen(this.port, () => {
        this.logger.info(`Server running on port ${this.port}`);
        if (this.tunnel) this.startTunnel();
        resolve();
      });

      this.server.on("error", (err) => {
        this.logger.error(`Server error: ${err.code} — ${err.message}`);
        reject(err);
      });
    });
  }

  // ─── Cloudflare Tunnel ───

  startTunnel() {
    if (this.tunnelProcess) this.stopTunnel();
    this.tunnelUrl = null;
    this.logger.info("Starting Cloudflare Tunnel...");

    this.tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${this.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onData = (data) => {
      const line = data.toString();
      const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !this.tunnelUrl) {
        this.tunnelUrl = urlMatch[0];
        this.shareUrl = this.token ? `${this.tunnelUrl}?token=${this.token}` : this.tunnelUrl;
        this.logger.info(`Tunnel ready: ${this.tunnelUrl}`);
        this.logger.info(`Share URL: ${this.shareUrl}`);
        // Broadcast updated share URL to all connected viewers
        this._broadcastServerInfo();
      }
    };

    this.tunnelProcess.stdout.on("data", onData);
    this.tunnelProcess.stderr.on("data", onData);

    this.tunnelProcess.on("error", (err) => {
      this.logger.error(`Tunnel error: ${err.message}`);
      if (err.code === "ENOENT") {
        this.logger.error("cloudflared not found — install: winget install Cloudflare.cloudflared");
      }
    });

    this.tunnelProcess.on("exit", (code) => {
      this.logger.info(`Tunnel exited (code ${code})`);
      this.tunnelProcess = null;
    });
  }

  stopTunnel() {
    if (this.tunnelProcess) {
      this.logger.info("Stopping tunnel...");
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
      this.tunnelUrl = null;
    }
  }

  _broadcastServerInfo() {
    const shareUrl = this.shareUrl;
    for (const [ws] of this.viewers) {
      this._sendToWs(ws, { type: "server_info", shareUrl });
    }
  }

  stop() {
    this.logger.info("Server stopping...");
    this.stopTunnel();
    return new Promise((resolve) => {
      for (const ws of this.sources) ws.close();
      for (const [ws] of this.viewers) ws.close();
      this.sources.clear();
      this.viewers.clear();
      if (this.wss) this.wss.close();
      if (this.server) {
        this.server.close(() => { this.logger.info("Server stopped"); resolve(); });
      } else {
        resolve();
      }
    });
  }

  getStatus() {
    return {
      sources: this.sources.size,
      viewers: this.viewers.size,
      sessions: this.sessions.size,
      port: this.port,
    };
  }

  _emitStatus() {
    this.onStatusChange(this.getStatus());
  }

  // ─── Persistence ───

  _persistSessions() {
    if (!this.persist) return;
    try {
      const data = {};
      for (const [id, s] of this.sessions) {
        data[id] = { id: s.id, label: s.label, sourceType: s.sourceType, project: s.project, conversation: s.conversation, visible: s.visible };
      }
      fs.writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
      this.logger.debug(`Persisted ${this.sessions.size} sessions`);
    } catch (err) {
      this.logger.error(`Persist failed: ${err.message}`);
    }
  }

  _loadSessions() {
    if (!this.persist) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
        for (const [id, s] of Object.entries(data)) {
          this.sessions.set(id, {
            ...s,
            streamingId: null,
            connected: false,
            connectedAt: null,
            lastUpdate: s.lastUpdate || new Date().toISOString(),
          });
        }
        this.logger.info(`Loaded ${this.sessions.size} sessions from backup`);
      }
    } catch (err) {
      this.logger.error(`Load sessions failed: ${err.message}`);
    }
  }

  // ─── Connection handling ───

  _handleConnection(ws, req) {
    const rawUrl = req.url || "";
    const url = new URL(rawUrl, `http://localhost:${this.port}`);
    const ip = req.socket.remoteAddress;

    this.logger.info(`WS connection from ${ip} — ${rawUrl}`);

    if (url.pathname.startsWith("/ws/source")) {
      this._handleSource(ws);
    } else if (url.pathname.startsWith("/ws/owner")) {
      // Owner — token auth if enabled
      if (this.token) {
        const clientToken = url.searchParams.get("token");
        if (clientToken !== this.token) {
          this.logger.warn(`Owner REJECTED from ${ip} — invalid token`);
          ws.close(4001, "Invalid token");
          return;
        }
      }
      this._handleViewer(ws, true);
    } else if (url.pathname.startsWith("/ws/viewer") || url.pathname === "/ws" || url.pathname === "/") {
      // Viewer — token auth if enabled
      if (this.token) {
        const clientToken = url.searchParams.get("token");
        if (clientToken !== this.token) {
          this.logger.warn(`Viewer REJECTED from ${ip} — invalid token`);
          ws.close(4001, "Invalid token");
          return;
        }
      }
      // Check if owner param is set (localhost shortcut)
      const isOwner = url.searchParams.get("owner") === "true";
      this._handleViewer(ws, isOwner);
    } else {
      this.logger.warn(`Unknown WS path: ${rawUrl} — treating as viewer`);
      this._handleViewer(ws, false);
    }
  }

  // ─── Source handling ───

  _handleSource(ws) {
    this.sources.add(ws);
    this.sourceToSessions.set(ws, new Set());
    this.logger.info(`SOURCE connected (${this.sources.size} total)`);
    this._emitStatus();

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch (err) {
        this.logger.warn(`SOURCE bad JSON: ${err.message}`);
        return;
      }

      // Resolve sessionId — use default for backward compat
      const sessionId = msg.sessionId || this.defaultSessionId;

      switch (msg.type) {
        case "register_session": {
          const s = this._getOrCreateSession(msg.sessionId, {
            label: msg.label,
            sourceType: msg.sourceType,
            project: msg.project,
          });
          s.label = msg.label || s.label;
          s.sourceType = msg.sourceType || s.sourceType;
          s.project = msg.project || s.project;
          s.connected = true;
          s.connectedAt = new Date().toISOString();
          this.sourceToSessions.get(ws).add(msg.sessionId);
          this.logger.info(`SESSION registered: ${msg.sessionId} "${msg.label}" (${msg.sourceType})`);
          this._broadcastSessionList();
          break;
        }

        case "full_sync": {
          const s = this._getOrCreateSession(sessionId, {});
          s.conversation = msg.messages || [];
          s.streamingId = null;
          s.lastUpdate = new Date().toISOString();
          s.connected = true;
          this.sourceToSessions.get(ws).add(sessionId);
          
          const count = s.conversation.length;
          this.logger.info(`SOURCE [${sessionId}] full_sync: ${count} messages, version=${msg.version || "?"}`);
          
          this._broadcastToSessionViewers(sessionId, { type: "full_sync", sessionId, messages: s.conversation });
          this._broadcastSessionListDebounced();
          this._persistSessions();
          break;
        }

        case "message_start": {
          const s = this._getOrCreateSession(sessionId, {});
          const newMsg = { id: msg.id, role: msg.role, text: "" };
          if (msg.toolName) newMsg.toolName = msg.toolName;
          if (msg.toolCallId) newMsg.toolCallId = msg.toolCallId;
          if (msg.model) newMsg.model = msg.model;
          s.conversation.push(newMsg);
          s.streamingId = msg.role === "assistant" ? msg.id : null;
          s.lastUpdate = new Date().toISOString();
          this.logger.info(`SOURCE [${sessionId}] message_start: id=${msg.id} role=${msg.role}`);
          this._broadcastToSessionViewers(sessionId, { ...msg, sessionId });
          this._broadcastSessionListDebounced(); // debounced — just count update
          break;
        }

        case "delta": {
          const s = this._getOrCreateSession(sessionId, {});
          const target = s.conversation.find(m => m.id === msg.id);
          if (target) {
            target.text += msg.text;
          }
          s.streamingId = msg.id;
          s.lastUpdate = new Date().toISOString();
          this._broadcastToSessionViewers(sessionId, { ...msg, sessionId });
          break;
        }

        case "delta_replace": {
          const s = this._getOrCreateSession(sessionId, {});
          const target = s.conversation.find(m => m.id === msg.id);
          if (target) target.text = msg.text;
          s.streamingId = msg.id;
          s.lastUpdate = new Date().toISOString();
          this._broadcastToSessionViewers(sessionId, { ...msg, sessionId });
          break;
        }

        case "message_end": {
          const s = this._getOrCreateSession(sessionId, {});
          s.streamingId = null;
          s.lastUpdate = new Date().toISOString();
          this.logger.info(`SOURCE [${sessionId}] message_end: id=${msg.id}`);
          this._broadcastToSessionViewers(sessionId, { ...msg, sessionId });
          this._persistSessions();
          break;
        }

        case "__debug":
          this.logger.debug(`EXT_DEBUG [${sessionId}] ${msg.key}: ${JSON.stringify(msg.val)}`);
          break;

        default:
          this.logger.info(`SOURCE [${sessionId}] unknown type="${msg.type}" — forwarding`);
          this._broadcastToSessionViewers(sessionId, { ...msg, sessionId });
      }

      this._emitStatus();
    });

    ws.on("close", (code, reason) => {
      // Mark all sessions from this source as disconnected
      const sessionIds = this.sourceToSessions.get(ws) || new Set();
      for (const sid of sessionIds) {
        const s = this.sessions.get(sid);
        if (s) {
          s.connected = false;
          s.streamingId = null;
        }
      }
      this.sources.delete(ws);
      this.sourceToSessions.delete(ws);
      this.logger.info(`SOURCE disconnected (${this.sources.size} remaining), sessions marked offline: [${[...sessionIds].join(", ")}]`);
      this._broadcastSessionList();
      this._emitStatus();
    });

    ws.on("error", (err) => {
      this.logger.error(`SOURCE error: ${err.message}`);
    });
  }

  // ─── Viewer / Owner handling ───

  _handleViewer(ws, isOwner) {
    const role = isOwner ? "OWNER" : "VIEWER";
    this.viewers.set(ws, { isOwner, watchingSessionId: null });
    this.logger.info(`${role} connected (${this.viewers.size} total)`);
    this._emitStatus();

    // Send server info (share URL with LAN IP)
    const token = this.token;
    const shareUrl = token ? `${this.shareUrl}?token=${token}` : this.shareUrl;
    this._sendToWs(ws, { type: "server_info", shareUrl });

    // Send session list
    const list = this._getSessionList(isOwner);
    this._sendToWs(ws, { type: "session_list", sessions: list, isOwner });

    // Auto-select first visible session if any
    if (list.length > 0) {
      const autoSession = list[0];
      this.viewers.get(ws).watchingSessionId = autoSession.id;
      const s = this.sessions.get(autoSession.id);
      if (s) {
        this._sendToWs(ws, { type: "full_sync", sessionId: autoSession.id, messages: s.conversation, streamingId: s.streamingId });
      }
    }

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {
        case "switch_session": {
          const info = this.viewers.get(ws);
          if (!info) break;
          const s = this.sessions.get(msg.sessionId);
          if (!s) {
            this.logger.warn(`${role} switch_session: ${msg.sessionId} not found`);
            break;
          }
          // Non-owners can only switch to visible sessions
          if (!isOwner && !s.visible) {
            this.logger.warn(`${role} switch_session: ${msg.sessionId} not visible`);
            break;
          }
          info.watchingSessionId = msg.sessionId;
          this.logger.info(`${role} switched to session ${msg.sessionId}`);
          this._sendToWs(ws, { type: "full_sync", sessionId: msg.sessionId, messages: s.conversation, streamingId: s.streamingId });
          break;
        }

        case "set_visibility": {
          if (!isOwner) {
            this.logger.warn(`VIEWER tried set_visibility — denied`);
            break;
          }
          const s = this.sessions.get(msg.sessionId);
          if (!s) break;
          s.visible = !!msg.visible;
          this.logger.info(`OWNER set_visibility: ${msg.sessionId} → ${s.visible}`);
          this._broadcastSessionList();
          this._persistSessions();
          break;
        }

        case "remove_session": {
          if (!isOwner) break;
          if (this.sessions.has(msg.sessionId)) {
            this.sessions.delete(msg.sessionId);
            this.logger.info(`OWNER removed session: ${msg.sessionId}`);
            this._broadcastSessionList();
            this._persistSessions();
          }
          break;
        }
      }
    });

    ws.on("close", (code, reason) => {
      this.viewers.delete(ws);
      this.logger.info(`${role} disconnected (${this.viewers.size} remaining)`);
      this._emitStatus();
    });

    ws.on("error", (err) => {
      this.logger.error(`${role} error: ${err.message}`);
    });
  }
}

module.exports = { LiveShareServer, RollingLogger };
