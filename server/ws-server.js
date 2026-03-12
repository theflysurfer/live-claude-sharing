/**
 * WebSocket relay server — extracted as reusable module.
 * Used by both standalone server.js and Electron main process.
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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

      // Check existing file size
      let existingSize = 0;
      try {
        existingSize = fs.statSync(this.filePath).size;
      } catch {}

      if (existingSize >= this.maxBytes) {
        this._rotate();
        existingSize = 0;
      }

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

    // Also print to stdout
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
    if (this.fd) {
      try { fs.closeSync(this.fd); } catch {}
      this.fd = null;
    }
  }
}

// ─── LiveShareServer ───

class LiveShareServer {
  constructor(options = {}) {
    this.port = options.port || 3333;
    this.viewerDir = options.viewerDir || path.join(__dirname, "..", "viewer");
    this.conversation = [];
    this.streamingId = null;
    this.sources = new Set();
    this.viewers = new Set();
    this.server = null;
    this.wss = null;

    // Auth token (null = no auth)
    this.token = options.token || null;
    if (this.token === true) {
      this.token = crypto.randomBytes(16).toString("hex");
    }

    // Persistence
    this.persist = options.persist || false;
    this.persistPath = options.persistPath || path.join(__dirname, "conversation-backup.json");

    // Rolling logger
    const logDir = options.logDir || path.join(__dirname, "..", "logs");
    const logFile = options.logFile || path.join(logDir, "liveshare-server.log");
    const maxLogBytes = options.maxLogBytes || 2 * 1024 * 1024; // 2 MB
    this.logger = options.logger || new RollingLogger(logFile, maxLogBytes);

    // Event callbacks
    this.onStatusChange = options.onStatusChange || (() => {});
  }

  start() {
    this.logger.info(`Server starting on port ${this.port}`);
    this.logger.info(`Viewer dir: ${this.viewerDir}`);
    this.logger.info(`Token: ${this.token || "disabled"}`);
    if (this.token) {
      this.logger.info(`Share URL: http://localhost:${this.port}?token=${this.token}`);
    }
    this.logger.info(`Persistence: ${this.persist ? this.persistPath : "disabled"}`);

    // Load persisted conversation if available
    this._loadConversation();

    return new Promise((resolve, reject) => {
      // HTTP server
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
            res.end("<html><body><h1>Live Claude Sharing</h1><p>Viewer file not found.</p></body></html>");
          }
        } else {
          res.writeHead(404);
          res.end("Not found");
        }
      });

      // WebSocket server
      this.wss = new WebSocketServer({ server: this.server });
      this.wss.on("connection", (ws, req) => this._handleConnection(ws, req));

      this.server.listen(this.port, () => {
        this.logger.info(`Server running on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (err) => {
        this.logger.error(`Server error: ${err.code} — ${err.message}`);
        reject(err);
      });
    });
  }

  stop() {
    this.logger.info("Server stopping...");
    return new Promise((resolve) => {
      for (const ws of this.sources) ws.close();
      for (const ws of this.viewers) ws.close();
      this.sources.clear();
      this.viewers.clear();

      if (this.wss) this.wss.close();
      if (this.server) {
        this.server.close(() => {
          this.logger.info("Server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  getStatus() {
    return {
      sources: this.sources.size,
      viewers: this.viewers.size,
      messages: this.conversation.length,
      streaming: this.streamingId !== null,
      port: this.port,
    };
  }

  _emitStatus() {
    const s = this.getStatus();
    this.onStatusChange(s);
  }

  _broadcastToViewers(data) {
    const msg = JSON.stringify(data);
    const viewerCount = this.viewers.size;
    let sent = 0;
    for (const ws of this.viewers) {
      if (ws.readyState === 1) {
        ws.send(msg);
        sent++;
      }
    }
    if (data.type !== "delta" && data.type !== "delta_replace") {
      // Don't log every delta (too noisy), but log everything else
      this.logger.debug(`broadcast type=${data.type} to ${sent}/${viewerCount} viewers (${msg.length} bytes)`);
    }
  }

  _handleConnection(ws, req) {
    const rawUrl = req.url || "";
    const url = new URL(rawUrl, `http://localhost:${this.port}`);
    const ip = req.socket.remoteAddress;

    this.logger.info(`WS connection from ${ip} — ${rawUrl}`);

    if (url.pathname.startsWith("/ws/source")) {
      this._handleSource(ws);
    } else if (url.pathname.startsWith("/ws/viewer") || url.pathname === "/ws" || url.pathname === "/") {
      // Validate token for viewers (if token auth is enabled)
      if (this.token) {
        const clientToken = url.searchParams.get("token");
        if (clientToken !== this.token) {
          this.logger.warn(`Viewer REJECTED from ${ip} — invalid token (got "${clientToken?.slice(0, 8) || "null"}...", expected "${this.token.slice(0, 8)}...")`);
          ws.close(4001, "Invalid token");
          return;
        }
        this.logger.info(`Viewer authenticated from ${ip} — token OK`);
      }
      this._handleViewer(ws);
    } else {
      this.logger.warn(`Unknown WS path: ${rawUrl} — treating as viewer`);
      this._handleViewer(ws);
    }
  }

  _persistConversation() {
    if (!this.persist) return;
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(this.conversation, null, 2));
      this.logger.debug(`Persisted ${this.conversation.length} messages to ${this.persistPath}`);
    } catch (err) {
      this.logger.error(`Persist failed: ${err.message}`);
    }
  }

  _loadConversation() {
    if (!this.persist) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        this.conversation = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
        this.logger.info(`Loaded ${this.conversation.length} messages from backup`);
      }
    } catch (err) {
      this.logger.error(`Load backup failed: ${err.message}`);
    }
  }

  _handleSource(ws) {
    this.sources.add(ws);
    this.logger.info(`SOURCE connected (${this.sources.size} total)`);
    this._emitStatus();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch (err) {
        this.logger.warn(`SOURCE bad JSON: ${err.message} — ${raw.toString().slice(0, 100)}`);
        return;
      }

      const rawLen = raw.length || raw.toString().length;

      switch (msg.type) {
        case "full_sync": {
          const count = (msg.messages || []).length;
          this.conversation = msg.messages || [];
          this.streamingId = null;
          this.logger.info(`SOURCE full_sync: ${count} messages, ${rawLen} bytes, version=${msg.version || "?"}`);
          if (count > 0) {
            this.logger.debug(`  first: ${this.conversation[0].role} "${(this.conversation[0].text || "").slice(0, 80)}"`);
            this.logger.debug(`  last:  ${this.conversation[count - 1].role} "${(this.conversation[count - 1].text || "").slice(0, 80)}"`);
          }
          this._broadcastToViewers({ type: "full_sync", messages: this.conversation });
          this._persistConversation();
          break;
        }

        case "message_start": {
          const newMsg = { id: msg.id, role: msg.role, text: "" };
          this.conversation.push(newMsg);
          this.streamingId = msg.role === "assistant" ? msg.id : null;
          this.logger.info(`SOURCE message_start: id=${msg.id} role=${msg.role} (total: ${this.conversation.length})`);
          this._broadcastToViewers(msg);
          break;
        }

        case "delta": {
          const target = this.conversation.find((m) => m.id === msg.id);
          if (target) {
            target.text += msg.text;
            this.logger.debug(`SOURCE delta: id=${msg.id} +${(msg.text || "").length} chars (total: ${target.text.length})`);
          } else {
            this.logger.warn(`SOURCE delta: id=${msg.id} — NOT FOUND in conversation`);
          }
          this.streamingId = msg.id;
          this._broadcastToViewers(msg);
          break;
        }

        case "delta_replace": {
          const target = this.conversation.find((m) => m.id === msg.id);
          if (target) {
            const oldLen = target.text.length;
            target.text = msg.text;
            this.logger.debug(`SOURCE delta_replace: id=${msg.id} ${oldLen}→${(msg.text || "").length} chars`);
          } else {
            this.logger.warn(`SOURCE delta_replace: id=${msg.id} — NOT FOUND`);
          }
          this.streamingId = msg.id;
          this._broadcastToViewers(msg);
          break;
        }

        case "message_end":
          this.streamingId = null;
          this.logger.info(`SOURCE message_end: id=${msg.id}`);
          this._broadcastToViewers(msg);
          this._persistConversation();
          break;

        case "__debug":
          this.logger.debug(`EXT_DEBUG ${msg.key}: ${JSON.stringify(msg.val)}`);
          break;

        default:
          this.logger.info(`SOURCE unknown type="${msg.type}" — forwarding to viewers`);
          this._broadcastToViewers(msg);
      }

      this._emitStatus();
    });

    ws.on("close", (code, reason) => {
      this.sources.delete(ws);
      this.logger.info(`SOURCE disconnected (${this.sources.size} remaining) code=${code} reason=${reason || ""}`);
      this._emitStatus();
    });

    ws.on("error", (err) => {
      this.logger.error(`SOURCE error: ${err.message}`);
    });
  }

  _handleViewer(ws) {
    this.viewers.add(ws);
    this.logger.info(`VIEWER connected (${this.viewers.size} total) — sending ${this.conversation.length} messages, streamingId=${this.streamingId || "null"}`);
    this._emitStatus();

    // Send current state
    const payload = JSON.stringify({
      type: "full_sync",
      messages: this.conversation,
      streamingId: this.streamingId,
    });
    this.logger.debug(`VIEWER initial full_sync: ${payload.length} bytes`);

    try {
      ws.send(payload);
      this.logger.debug(`VIEWER initial full_sync sent OK`);
    } catch (err) {
      this.logger.error(`VIEWER initial full_sync FAILED: ${err.message}`);
    }

    ws.on("close", (code, reason) => {
      this.viewers.delete(ws);
      this.logger.info(`VIEWER disconnected (${this.viewers.size} remaining) code=${code} reason=${reason || ""}`);
      this._emitStatus();
    });

    ws.on("error", (err) => {
      this.logger.error(`VIEWER error: ${err.message}`);
    });
  }
}

module.exports = { LiveShareServer, RollingLogger };
