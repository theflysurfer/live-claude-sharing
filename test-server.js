/**
 * Autonomous test for the WebSocket relay server.
 * Tests: full_sync, delta, delta_replace, message_end, token auth, persistence.
 * No browser or extension needed — pure Node.js.
 *
 * Usage: node test-server.js
 * Exit code: 0 = all pass, 1 = failure
 */
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const { LiveShareServer } = require("./server/ws-server");

const PORT = 13333; // Avoid conflict with real server
const PERSIST_PATH = path.join(__dirname, "test-conversation-backup.json");
let server = null;
let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function connectWs(urlPath) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}${urlPath}`);
    // Buffer messages that arrive before anyone calls waitForMessage
    ws._msgQueue = [];
    ws._msgWaiters = [];
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (ws._msgWaiters.length > 0) {
        const waiter = ws._msgWaiters.shift();
        waiter.resolve(msg);
        clearTimeout(waiter.timer);
      } else {
        ws._msgQueue.push(msg);
      }
    });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws, timeout = 3000) {
  // Check if there's already a buffered message
  if (ws._msgQueue.length > 0) {
    return Promise.resolve(ws._msgQueue.shift());
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws._msgWaiters = ws._msgWaiters.filter((w) => w.resolve !== resolve);
      reject(new Error("Timeout waiting for message"));
    }, timeout);
    ws._msgWaiters.push({ resolve, timer });
  });
}

async function cleanup() {
  if (server) await server.stop();
  try { fs.unlinkSync(PERSIST_PATH); } catch {}
}

async function test1_BasicRelay() {
  console.log("\n── Test 1: Basic relay (source → viewer) ──");

  server = new LiveShareServer({ port: PORT, persist: false, debug: false });
  await server.start();

  const source = await connectWs("/ws/source");
  const viewer = await connectWs("/ws/viewer");

  // Viewer gets empty full_sync on connect
  const initial = await waitForMessage(viewer);
  assert(initial.type === "full_sync", "Viewer gets full_sync on connect");
  assert(initial.messages.length === 0, "Initial state is empty");

  // Source sends full_sync
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [
      { id: "msg-0", role: "user", text: "Hello" },
      { id: "msg-1", role: "assistant", text: "Hi there!" },
    ],
  }));
  const sync = await waitForMessage(viewer);
  assert(sync.type === "full_sync", "Viewer receives full_sync from source");
  assert(sync.messages.length === 2, "2 messages relayed");
  assert(sync.messages[0].text === "Hello", "User message preserved");
  assert(sync.messages[1].text === "Hi there!", "Assistant message preserved");

  // Source sends streaming delta
  source.send(JSON.stringify({ type: "message_start", id: "msg-2", role: "assistant" }));
  const start = await waitForMessage(viewer);
  assert(start.type === "message_start", "message_start relayed");
  assert(start.id === "msg-2", "Correct message id");

  source.send(JSON.stringify({ type: "delta", id: "msg-2", text: "Streaming " }));
  const delta1 = await waitForMessage(viewer);
  assert(delta1.type === "delta" && delta1.text === "Streaming ", "delta relayed");

  source.send(JSON.stringify({ type: "delta_replace", id: "msg-2", text: "Full replace content" }));
  const replace = await waitForMessage(viewer);
  assert(replace.type === "delta_replace", "delta_replace relayed");
  assert(replace.text === "Full replace content", "Replaced text correct");

  source.send(JSON.stringify({ type: "message_end", id: "msg-2" }));
  const end = await waitForMessage(viewer);
  assert(end.type === "message_end", "message_end relayed");

  // Check server status
  const status = server.getStatus();
  assert(status.sources === 1, "1 source connected");
  assert(status.viewers === 1, "1 viewer connected");
  assert(status.messages === 3, "3 messages in conversation");
  assert(status.streaming === false, "Not streaming after message_end");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

async function test2_TokenAuth() {
  console.log("\n── Test 2: Token authentication ──");

  server = new LiveShareServer({ port: PORT, token: "secret123", debug: false });
  await server.start();

  // Viewer without token → rejected
  const badViewer = await connectWs("/ws/viewer");
  const closeCode = await new Promise((resolve) => {
    badViewer.on("close", (code) => resolve(code));
    setTimeout(() => resolve("timeout"), 3000);
  });
  assert(closeCode === 4001, `Viewer without token rejected with 4001 (got ${closeCode})`);

  // Viewer with correct token → accepted
  const goodViewer = await connectWs("/ws/viewer?token=secret123");
  const sync = await waitForMessage(goodViewer);
  assert(sync.type === "full_sync", "Viewer with valid token gets full_sync");

  // Source doesn't need token
  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [{ id: "msg-0", role: "user", text: "Auth test" }],
  }));
  const relayed = await waitForMessage(goodViewer);
  assert(relayed.type === "full_sync" && relayed.messages.length === 1, "Authenticated viewer receives messages");

  source.close();
  goodViewer.close();
  await server.stop();
  server = null;
}

async function test3_Persistence() {
  console.log("\n── Test 3: Persistence ──");

  // Clean up
  try { fs.unlinkSync(PERSIST_PATH); } catch {}

  // Start server with persistence
  server = new LiveShareServer({ port: PORT, persist: true, persistPath: PERSIST_PATH, debug: false });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [
      { id: "msg-0", role: "user", text: "Persisted message" },
      { id: "msg-1", role: "assistant", text: "I will survive a restart" },
    ],
  }));

  // Wait for the broadcast to process
  await new Promise((r) => setTimeout(r, 500));

  assert(fs.existsSync(PERSIST_PATH), "Backup file created");
  const backup = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf-8"));
  assert(backup.length === 2, "2 messages in backup");

  source.close();
  await server.stop();

  // Restart server — should load from backup
  server = new LiveShareServer({ port: PORT, persist: true, persistPath: PERSIST_PATH, debug: false });
  await server.start();

  const viewer = await connectWs("/ws/viewer");
  const sync = await waitForMessage(viewer);
  assert(sync.type === "full_sync", "Viewer gets full_sync after restart");
  assert(sync.messages.length === 2, "Persisted messages loaded on restart");
  assert(sync.messages[0].text === "Persisted message", "Message content preserved");

  viewer.close();
  await server.stop();
  server = null;
  try { fs.unlinkSync(PERSIST_PATH); } catch {}
}

async function test4_MultipleViewers() {
  console.log("\n── Test 4: Multiple viewers ──");

  server = new LiveShareServer({ port: PORT, debug: false });
  await server.start();

  const source = await connectWs("/ws/source");
  const viewer1 = await connectWs("/ws/viewer");
  const viewer2 = await connectWs("/ws/viewer");

  // Both get initial sync
  await waitForMessage(viewer1);
  await waitForMessage(viewer2);

  // Source sends message
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [{ id: "msg-0", role: "user", text: "Broadcast test" }],
  }));

  const msg1 = await waitForMessage(viewer1);
  const msg2 = await waitForMessage(viewer2);
  assert(msg1.type === "full_sync" && msg1.messages.length === 1, "Viewer 1 received");
  assert(msg2.type === "full_sync" && msg2.messages.length === 1, "Viewer 2 received");

  const status = server.getStatus();
  assert(status.viewers === 2, "2 viewers in status");

  source.close();
  viewer1.close();
  viewer2.close();
  await server.stop();
  server = null;
}

async function test5_LateViewer() {
  console.log("\n── Test 5: Late viewer gets current state ──");

  server = new LiveShareServer({ port: PORT, debug: false });
  await server.start();

  // Source sends messages BEFORE viewer connects
  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [
      { id: "msg-0", role: "user", text: "Already here" },
      { id: "msg-1", role: "assistant", text: "Me too" },
    ],
  }));
  await new Promise((r) => setTimeout(r, 300));

  // Late viewer connects
  const viewer = await connectWs("/ws/viewer");
  const sync = await waitForMessage(viewer);
  assert(sync.type === "full_sync", "Late viewer gets full_sync");
  assert(sync.messages.length === 2, "Late viewer gets all existing messages");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Run all tests ───

(async () => {
  console.log("🧪 Live Claude Sharing — Server Tests\n");

  try {
    await test1_BasicRelay();
    await test2_TokenAuth();
    await test3_Persistence();
    await test4_MultipleViewers();
    await test5_LateViewer();
  } catch (err) {
    console.error("\n💥 Test crashed:", err);
    failed++;
  }

  await cleanup();

  console.log(`\n${"─".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log("\n❌ SOME TESTS FAILED");
    process.exit(1);
  } else {
    console.log("\n✅ ALL TESTS PASSED");
    process.exit(0);
  }
})();
