#!/usr/bin/env node
/**
 * Pi / Claude Code JSONL Session Source
 * 
 * Scans all Pi and Claude Code sessions, watches active ones,
 * and sends updates to the Live Share WS server.
 * 
 * Usage:
 *   node pi-source.js                          # Scan all recent sessions
 *   node pi-source.js --session <path.jsonl>    # Watch a specific file
 *   node pi-source.js --ws-url ws://host:3333   # Custom WS server URL
 *   node pi-source.js --max-age 60              # Max session age in minutes (default: 120)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const WebSocket = require("ws");
const { RollingLogger } = require("./ws-server");

// ─── Config ───

const RECONNECT_DELAY = 3000;
const POLL_INTERVAL = 500;
const SCAN_INTERVAL = 30000; // re-scan for new sessions every 30s
const VERSION = "2.0.0";

// ─── Rolling logger (2 MB max, auto-rotate) ───
const LOG_DIR = path.join(__dirname, "..", "logs");
const logger = new RollingLogger(path.join(LOG_DIR, "pi-source.log"), 2 * 1024 * 1024);

// ─── CLI Args ───

function getArg(name) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}
function hasFlag(name) { return process.argv.includes(name); }

const WS_URL = getArg("--ws-url") || "ws://localhost:3333/ws/source";
const MAX_AGE_MINUTES = parseInt(getArg("--max-age") || "120", 10);
const EXPLICIT_SESSION = getArg("--session");

// ─── Path helpers ───

function decodePiDirName(dirName) {
  // --C--Users-julien-OneDrive-Coding-_Projets de code-2023.06 Live Claude Sharing--
  // → extract project name (last meaningful part)
  const inner = dirName.replace(/^--/, "").replace(/--$/, "");
  const parts = inner.split("-");
  // Find the project part after the coding dir
  const projIdx = inner.lastIndexOf("Projets de code-");
  if (projIdx !== -1) {
    return inner.slice(projIdx + "Projets de code-".length);
  }
  // Fallback: last few segments
  return parts.slice(-3).join("-");
}

function decodeClaudeDirName(dirName) {
  // C--Users-julien-OneDrive-Coding--Projets-de-code-2025-09-Cooking-manager
  const parts = dirName.split("-");
  // Find index after "code" (project dirs usually have the project name at the end)
  const codeIdx = dirName.lastIndexOf("-de-code-");
  if (codeIdx !== -1) {
    return dirName.slice(codeIdx + "-de-code-".length);
  }
  return parts.slice(-3).join("-");
}

// ─── Session Discovery ───

function discoverAllSessions() {
  const sessions = [];
  const now = Date.now();
  const maxAge = MAX_AGE_MINUTES * 60 * 1000;

  // 1. Scan Pi sessions
  const piBase = path.join(os.homedir(), ".pi", "agent", "sessions");
  if (fs.existsSync(piBase)) {
    try {
      for (const dir of fs.readdirSync(piBase)) {
        const dirPath = path.join(piBase, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;
        
        try {
          const files = fs.readdirSync(dirPath)
            .filter(f => f.endsWith(".jsonl"))
            .map(f => ({ name: f, path: path.join(dirPath, f), mtime: fs.statSync(path.join(dirPath, f)).mtimeMs }))
            .filter(f => now - f.mtime < maxAge)
            .sort((a, b) => b.mtime - a.mtime);

          for (const f of files) {
            const project = decodePiDirName(dir);
            sessions.push({
              sessionId: `pi:${path.basename(f.name, ".jsonl")}`,
              file: f.path,
              format: "pi",
              sourceType: "pi",
              label: `Pi — ${project}`,
              project,
              mtime: f.mtime,
            });
          }
        } catch (e) {
          // Skip unreadable dirs
        }
      }
    } catch (e) {
      logger.error(`Error scanning Pi sessions: ${e.message}`);
    }
  }

  // 2. Scan Claude Code sessions
  const ccBase = path.join(os.homedir(), ".claude", "projects");
  if (fs.existsSync(ccBase)) {
    try {
      for (const dir of fs.readdirSync(ccBase)) {
        const dirPath = path.join(ccBase, dir);
        if (!fs.statSync(dirPath).isDirectory()) continue;

        try {
          const files = fs.readdirSync(dirPath)
            .filter(f => f.endsWith(".jsonl"))
            .map(f => ({ name: f, path: path.join(dirPath, f), mtime: fs.statSync(path.join(dirPath, f)).mtimeMs }))
            .filter(f => now - f.mtime < maxAge)
            .sort((a, b) => b.mtime - a.mtime);

          for (const f of files) {
            const project = decodeClaudeDirName(dir);
            sessions.push({
              sessionId: `cc:${path.basename(f.name, ".jsonl")}`,
              file: f.path,
              format: "claude-code",
              sourceType: "claude-code",
              label: `Claude Code — ${project}`,
              project,
              mtime: f.mtime,
            });
          }
        } catch (e) {
          // Skip
        }
      }
    } catch (e) {
      logger.error(`Error scanning Claude Code sessions: ${e.message}`);
    }
  }

  // Sort by most recent first
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions;
}

// ─── JSONL Parsers ───

let msgCounter = 0;
function nextId(sessionId) {
  return `${sessionId}:msg-${msgCounter++}`;
}

function parsePiLine(obj, sessionId) {
  const messages = [];

  if (obj.type === "message" && obj.message) {
    const msg = obj.message;
    
    if (msg.role === "user") {
      const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      if (text) {
        const id = nextId(sessionId);
        messages.push({ type: "message_start", id, role: "user", sessionId });
        messages.push({ type: "delta", id, text, sessionId });
        messages.push({ type: "message_end", id, sessionId });
      }
    }
    
    if (msg.role === "assistant") {
      for (const block of (msg.content || [])) {
        if (block.type === "thinking" && block.thinking) {
          const id = nextId(sessionId);
          messages.push({ type: "message_start", id, role: "thinking", sessionId });
          messages.push({ type: "delta", id, text: block.thinking, sessionId });
          messages.push({ type: "message_end", id, sessionId });
        }
        if (block.type === "text" && block.text) {
          const id = nextId(sessionId);
          messages.push({ type: "message_start", id, role: "assistant", sessionId });
          messages.push({ type: "delta", id, text: block.text, sessionId });
          messages.push({ type: "message_end", id, sessionId });
        }
        if (block.type === "toolCall") {
          const id = nextId(sessionId);
          const argsStr = typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments, null, 2);
          messages.push({ type: "message_start", id, role: "tool_call", toolName: block.name, toolCallId: block.id, sessionId });
          messages.push({ type: "delta", id, text: argsStr, sessionId });
          messages.push({ type: "message_end", id, sessionId });
        }
      }
      if (msg.model && messages.length > 0) messages[0].model = msg.model;
    }

    if (msg.role === "toolResult") {
      const id = nextId(sessionId);
      const text = (msg.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
      messages.push({ type: "message_start", id, role: "tool_result", toolName: msg.toolName, toolCallId: msg.toolCallId, sessionId });
      messages.push({ type: "delta", id, text: text || "(no output)", sessionId });
      messages.push({ type: "message_end", id, sessionId });
    }
  }

  if (obj.type === "custom_message" && obj.content && obj.display) {
    const id = nextId(sessionId);
    messages.push({ type: "message_start", id, role: "system", sessionId });
    messages.push({ type: "delta", id, text: obj.content, sessionId });
    messages.push({ type: "message_end", id, sessionId });
  }

  return messages;
}

function parseClaudeCodeLine(obj, sessionId) {
  const messages = [];

  if (obj.type === "user" && obj.message) {
    const content = obj.message.content;
    let text = typeof content === "string" ? content : (Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join("\n") : "");
    if (text) {
      const id = nextId(sessionId);
      messages.push({ type: "message_start", id, role: "user", sessionId });
      messages.push({ type: "delta", id, text, sessionId });
      messages.push({ type: "message_end", id, sessionId });
    }
  }

  if (obj.type === "assistant" && obj.message) {
    for (const block of (obj.message.content || [])) {
      if (block.type === "thinking" && block.thinking) {
        const id = nextId(sessionId);
        messages.push({ type: "message_start", id, role: "thinking", sessionId });
        messages.push({ type: "delta", id, text: block.thinking, sessionId });
        messages.push({ type: "message_end", id, sessionId });
      }
      if (block.type === "text" && block.text) {
        const id = nextId(sessionId);
        messages.push({ type: "message_start", id, role: "assistant", sessionId });
        messages.push({ type: "delta", id, text: block.text, sessionId });
        messages.push({ type: "message_end", id, sessionId });
      }
      if (block.type === "tool_use") {
        const id = nextId(sessionId);
        const argsStr = typeof block.input === "string" ? block.input : JSON.stringify(block.input, null, 2);
        messages.push({ type: "message_start", id, role: "tool_call", toolName: block.name, toolCallId: block.id, sessionId });
        messages.push({ type: "delta", id, text: argsStr, sessionId });
        messages.push({ type: "message_end", id, sessionId });
      }
    }
    if (obj.message.model && messages.length > 0) messages[0].model = obj.message.model;
  }

  if (obj.type === "tool_result") {
    const content = obj.message?.content;
    let text = typeof content === "string" ? content : (Array.isArray(content) ? content.filter(b => b.type === "text").map(b => b.text).join("\n") : "");
    const id = nextId(sessionId);
    messages.push({ type: "message_start", id, role: "tool_result", toolName: obj.toolName || "", toolCallId: obj.toolUseId || "", sessionId });
    messages.push({ type: "delta", id, text: text || "(no output)", sessionId });
    messages.push({ type: "message_end", id, sessionId });
  }

  return messages;
}

// ─── Session Watcher ───

class SessionWatcher {
  constructor(sessionInfo, sendFn) {
    this.sessionId = sessionInfo.sessionId;
    this.file = sessionInfo.file;
    this.format = sessionInfo.format;
    this.label = sessionInfo.label;
    this.sourceType = sessionInfo.sourceType;
    this.project = sessionInfo.project;
    this.send = sendFn;
    this.fileOffset = 0;
    this.allMessages = [];
    this.watcher = null;
    this.active = true;
  }

  readExisting() {
    try {
      const content = fs.readFileSync(this.file, "utf-8");
      this.fileOffset = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const msgs = this.format === "pi" ? parsePiLine(obj, this.sessionId) : parseClaudeCodeLine(obj, this.sessionId);
          this._accumulate(msgs);
        } catch {}
      }
      return this.allMessages;
    } catch (e) {
      logger.error(`Failed to read ${this.file}: ${e.message}`);
      return [];
    }
  }

  startWatching() {
    fs.watchFile(this.file, { interval: POLL_INTERVAL }, (curr, prev) => {
      if (this.active && curr.size > prev.size) this._readNew();
    });

    try {
      this.watcher = fs.watch(this.file, (eventType) => {
        if (this.active && eventType === "change") this._readNew();
      });
      this.watcher.on("error", () => {});
    } catch {}
  }

  stop() {
    this.active = false;
    if (this.watcher) this.watcher.close();
    fs.unwatchFile(this.file);
  }

  _accumulate(msgs) {
    for (const msg of msgs) {
      if (msg.type === "message_start") {
        this.allMessages.push({
          id: msg.id, role: msg.role, text: "",
          toolName: msg.toolName || null, toolCallId: msg.toolCallId || null, model: msg.model || null,
        });
      } else if (msg.type === "delta") {
        const m = this.allMessages.find(m => m.id === msg.id);
        if (m) m.text += msg.text;
      }
    }
  }

  _readNew() {
    try {
      const fd = fs.openSync(this.file, "r");
      const stat = fs.fstatSync(fd);
      if (stat.size <= this.fileOffset) { fs.closeSync(fd); return; }

      const newBytes = stat.size - this.fileOffset;
      const buffer = Buffer.alloc(newBytes);
      fs.readSync(fd, buffer, 0, newBytes, this.fileOffset);
      fs.closeSync(fd);
      this.fileOffset = stat.size;

      const lines = buffer.toString("utf-8").split("\n").filter(l => l.trim());
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          const msgs = this.format === "pi" ? parsePiLine(obj, this.sessionId) : parseClaudeCodeLine(obj, this.sessionId);
          this._accumulate(msgs);
          for (const msg of msgs) this.send(msg);

          for (const msg of msgs) {
            if (msg.type === "message_start") {
              const icons = { user: "👤", assistant: "🤖", thinking: "💭", tool_call: "🔧", tool_result: "📋", system: "⚙️" };
              logger.info(`${icons[msg.role] || "?"} [${this.sessionId.slice(0, 20)}] ${msg.role}${msg.toolName ? ` (${msg.toolName})` : ""}`);
            }
          }
        } catch {}
      }
    } catch (e) {
      logger.error(`Read error [${this.sessionId}]: ${e.message}`);
    }
  }
}

// ─── Multi-Session Manager ───

class MultiSessionManager {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.connected = false;
    this.watchers = new Map(); // sessionId → SessionWatcher
    this.pendingRegistrations = []; // queue while disconnected
  }

  start() {
    logger.info("🔍 Live Claude Sharing — Multi-Session Source");
    logger.info(`🔌 WS: ${this.wsUrl}`);
    logger.info(`⏱️  Max session age: ${MAX_AGE_MINUTES} minutes`);

    this._connect();

    // Periodic re-scan for new sessions
    setInterval(() => this._scanForNewSessions(), SCAN_INTERVAL);
  }

  _connect() {
    logger.info(`🔌 Connecting to ${this.wsUrl}...`);
    this.ws = new WebSocket(this.wsUrl);

    this.ws.on("open", () => {
      this.connected = true;
      logger.info("✅ Connected to WS server");
      this._discoverAndWatch();
    });

    this.ws.on("close", () => {
      this.connected = false;
      logger.warn("❌ WS disconnected — reconnecting in 3s...");
      setTimeout(() => this._connect(), RECONNECT_DELAY);
    });

    this.ws.on("error", (err) => {
      logger.error(`WS error: ${err.message}`);
    });
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        const json = JSON.stringify(data);
        this.ws.send(json);
        if (data.type === "register_session") {
          logger.info(`📤 register_session: ${data.sessionId} "${data.label}" (${data.sourceType})`);
        } else if (data.type === "full_sync") {
          logger.info(`📤 full_sync [${data.sessionId}]: ${(data.messages || []).length} messages (${json.length} bytes)`);
        }
        return true;
      } catch (err) {
        logger.error(`WS send failed: ${err.message}`);
        return false;
      }
    }
    return false;
  }

  _discoverAndWatch() {
    if (EXPLICIT_SESSION) {
      // Single explicit session
      const firstLine = fs.readFileSync(EXPLICIT_SESSION, "utf-8").split("\n")[0];
      let format = "pi";
      try {
        const obj = JSON.parse(firstLine);
        format = obj.type === "session" ? "pi" : "claude-code";
      } catch {}
      
      const info = {
        sessionId: `explicit:${path.basename(EXPLICIT_SESSION, ".jsonl")}`,
        file: EXPLICIT_SESSION,
        format,
        sourceType: format === "pi" ? "pi" : "claude-code",
        label: path.basename(EXPLICIT_SESSION),
        project: path.basename(path.dirname(EXPLICIT_SESSION)),
      };
      this._watchSession(info);
      return;
    }

    const sessions = discoverAllSessions();
    logger.info(`📋 Found ${sessions.length} recent sessions`);
    for (const s of sessions) {
      const age = Math.round((Date.now() - s.mtime) / 60000);
      logger.info(`  ${s.sourceType === "pi" ? "🥧" : "🔷"} ${s.label} (${age}min ago)`);
    }

    for (const s of sessions) {
      this._watchSession(s);
    }
  }

  _watchSession(info) {
    if (this.watchers.has(info.sessionId)) return; // already watching

    const watcher = new SessionWatcher(info, (msg) => this._send(msg));
    this.watchers.set(info.sessionId, watcher);

    // Register session
    this._send({
      type: "register_session",
      sessionId: info.sessionId,
      label: info.label,
      sourceType: info.sourceType,
      project: info.project,
    });

    // Read existing and send full_sync
    const messages = watcher.readExisting();
    this._send({
      type: "full_sync",
      sessionId: info.sessionId,
      messages,
      version: `pi-source/${VERSION}`,
    });

    logger.info(`👁️  Watching: ${info.sessionId} (${messages.length} messages)`);

    // Start watching for changes
    watcher.startWatching();
  }

  _scanForNewSessions() {
    if (!this.connected || EXPLICIT_SESSION) return;

    const sessions = discoverAllSessions();
    let newCount = 0;
    for (const s of sessions) {
      if (!this.watchers.has(s.sessionId)) {
        this._watchSession(s);
        newCount++;
      }
    }
    if (newCount > 0) {
      logger.info(`🔄 Discovered ${newCount} new session(s)`);
    }
  }

  stop() {
    for (const [, w] of this.watchers) w.stop();
    this.watchers.clear();
    if (this.ws) this.ws.close();
    logger.info("🛑 Stopped");
  }
}

// ─── Main ───

const manager = new MultiSessionManager(WS_URL);
manager.start();

process.on("SIGINT", () => { manager.stop(); process.exit(0); });
process.on("SIGTERM", () => { manager.stop(); process.exit(0); });
