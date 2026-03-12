/**
 * WebSocket relay server — extracted as reusable module.
 * Used by both standalone server.js and Electron main process.
 */
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

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

    // Logging
    this.debug = options.debug || process.env.LIVESHARE_DEBUG === "1";

    // Auth token (null = no auth)
    this.token = options.token || null;
    if (this.token === true) {
      this.token = crypto.randomBytes(16).toString("hex");
    }

    // Persistence
    this.persist = options.persist || false;
    this.persistPath = options.persistPath || path.join(__dirname, "conversation-backup.json");

    // Event callbacks
    this.onStatusChange = options.onStatusChange || (() => {});
  }

  start() {
    // Load persisted conversation if available
    this._loadConversation();

    return new Promise((resolve, reject) => {
      // HTTP server
      this.server = http.createServer((req, res) => {
        if (req.url === "/" || req.url === "/index.html") {
          const file = path.join(this.viewerDir, "index.html");
          if (fs.existsSync(file)) {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            fs.createReadStream(file).pipe(res);
          } else {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end("<html><body><h1>Live Claude Sharing</h1><p>Viewer available in Electron app window.</p></body></html>");
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
        console.log(`[LiveShare] Server running on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          console.error(`[LiveShare] Port ${this.port} already in use`);
        }
        reject(err);
      });
    });
  }

  stop() {
    return new Promise((resolve) => {
      // Close all WebSocket connections
      for (const ws of this.sources) ws.close();
      for (const ws of this.viewers) ws.close();
      this.sources.clear();
      this.viewers.clear();

      if (this.wss) this.wss.close();
      if (this.server) {
        this.server.close(() => resolve());
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

  _log(msg) {
    if (this.debug) console.log(`[LiveShare] ${msg}`);
  }

  _emitStatus() {
    this.onStatusChange(this.getStatus());
  }

  _broadcastToViewers(data) {
    const msg = JSON.stringify(data);
    for (const ws of this.viewers) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  _handleConnection(ws, req) {
    const url = new URL(req.url || "", `http://localhost:${this.port}`);

    if (url.pathname.startsWith("/ws/source")) {
      this._handleSource(ws);
    } else {
      // Validate token for viewers (if token auth is enabled)
      if (this.token) {
        const clientToken = url.searchParams.get("token");
        if (clientToken !== this.token) {
          this._log(`[viewer] rejected — invalid token`);
          ws.close(4001, "Invalid token");
          return;
        }
      }
      this._handleViewer(ws);
    }
  }

  _persistConversation() {
    if (!this.persist) return;
    try {
      fs.writeFileSync(this.persistPath, JSON.stringify(this.conversation, null, 2));
    } catch (err) {
      this._log(`Persist failed: ${err.message}`);
    }
  }

  _loadConversation() {
    if (!this.persist) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        this.conversation = JSON.parse(fs.readFileSync(this.persistPath, "utf-8"));
        this._log(`Loaded ${this.conversation.length} messages from backup`);
      }
    } catch (err) {
      this._log(`Load backup failed: ${err.message}`);
    }
  }

  _handleSource(ws) {
    this.sources.add(ws);
    console.log(`[source] connected (${this.sources.size} sources)`);
    this._emitStatus();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      this._log(`[source] type=${msg.type} keys=${Object.keys(msg).join(",")}`);

      switch (msg.type) {
        case "full_sync":
          this.conversation = msg.messages || [];
          this.streamingId = null;
          this._broadcastToViewers({ type: "full_sync", messages: this.conversation });
          console.log(`[sync] ${this.conversation.length} messages`);
          this._persistConversation();
          break;

        case "message_start": {
          const newMsg = { id: msg.id, role: msg.role, text: "" };
          this.conversation.push(newMsg);
          this.streamingId = msg.role === "assistant" ? msg.id : null;
          this._broadcastToViewers(msg);
          break;
        }

        case "delta": {
          const target = this.conversation.find((m) => m.id === msg.id);
          if (target) target.text += msg.text;
          this.streamingId = msg.id;
          this._broadcastToViewers(msg);
          break;
        }

        case "delta_replace": {
          const target = this.conversation.find((m) => m.id === msg.id);
          if (target) target.text = msg.text;
          this.streamingId = msg.id;
          this._broadcastToViewers(msg);
          break;
        }

        case "message_end":
          this.streamingId = null;
          this._broadcastToViewers(msg);
          this._persistConversation();
          break;

        case "__debug":
          this._log(`[DEBUG] ${msg.key}: ${JSON.stringify(msg.val)}`);
          break;

        default:
          this._broadcastToViewers(msg);
      }

      this._emitStatus();
    });

    ws.on("close", () => {
      this.sources.delete(ws);
      console.log(`[source] disconnected (${this.sources.size} sources)`);
      this._emitStatus();
    });
  }

  _handleViewer(ws) {
    this.viewers.add(ws);
    console.log(`[viewer] connected (${this.viewers.size} viewers)`);
    this._emitStatus();

    // Send current state
    ws.send(
      JSON.stringify({
        type: "full_sync",
        messages: this.conversation,
        streamingId: this.streamingId,
      })
    );

    ws.on("close", () => {
      this.viewers.delete(ws);
      console.log(`[viewer] disconnected (${this.viewers.size} viewers)`);
      this._emitStatus();
    });
  }
}

module.exports = { LiveShareServer };
