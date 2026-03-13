/**
 * Autonomous test for the WebSocket relay server.
 * Tests: multi-session, full_sync, delta, delta_replace, message_end, token auth, persistence, visibility.
 * No browser or extension needed — pure Node.js.
 *
 * Usage: node test-server.js
 * Exit code: 0 = all pass, 1 = failure
 */
const WebSocket = require("ws");
const path = require("path");
const fs = require("fs");
const { LiveShareServer } = require("./server/ws-server");

const PORT = 13333;
const PERSIST_PATH = path.join(__dirname, "test-sessions-backup.json");
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
  if (ws._msgQueue.length > 0) return Promise.resolve(ws._msgQueue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws._msgWaiters = ws._msgWaiters.filter((w) => w.resolve !== resolve);
      reject(new Error("Timeout waiting for message"));
    }, timeout);
    ws._msgWaiters.push({ resolve, timer });
  });
}

/** Wait for a specific message type, skipping others */
async function waitForType(ws, type, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const msg = await waitForMessage(ws, deadline - Date.now());
    if (msg.type === type) return msg;
  }
  throw new Error(`Timeout waiting for type=${type}`);
}

/** Drain the initial server_info + session_list + optional full_sync that viewers get on connect */
async function drainInitial(ws) {
  let serverInfo = null;
  let sessionList = await waitForMessage(ws);
  // First message may be server_info, skip it to get session_list
  if (sessionList.type === "server_info") {
    serverInfo = sessionList;
    sessionList = await waitForMessage(ws);
  }
  // May also get an auto-selected full_sync
  let fullSync = null;
  try {
    const next = await waitForMessage(ws, 500);
    if (next.type === "full_sync") fullSync = next;
    else ws._msgQueue.unshift(next); // put it back
  } catch {}
  return { serverInfo, sessionList, fullSync };
}

async function cleanup() {
  if (server) await server.stop();
  try { fs.unlinkSync(PERSIST_PATH); } catch {}
}

// ─── Test 1: Basic relay with sessionId ───

async function test1_BasicRelay() {
  console.log("\n── Test 1: Basic relay (source → viewer) ──");

  server = new LiveShareServer({ port: PORT, persist: false });
  await server.start();

  const source = await connectWs("/ws/source");
  const viewer = await connectWs("/ws/viewer");

  // Viewer gets session_list on connect (empty)
  const { sessionList } = await drainInitial(viewer);
  assert(sessionList.type === "session_list", "Viewer gets session_list on connect");
  assert(sessionList.sessions.length === 0, "No sessions initially");

  // Source registers a session and sends full_sync
  source.send(JSON.stringify({
    type: "register_session",
    sessionId: "test-session",
    label: "Test Session",
    sourceType: "pi",
    project: "test-project",
  }));

  // Viewer gets updated session_list
  const list1 = await waitForType(viewer, "session_list");
  assert(list1.sessions.length === 1, "1 session after register");
  assert(list1.sessions[0].label === "Test Session", "Session label correct");
  assert(list1.sessions[0].sourceType === "pi", "Source type correct");

  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "test-session",
    messages: [
      { id: "msg-0", role: "user", text: "Hello" },
      { id: "msg-1", role: "assistant", text: "Hi there!" },
    ],
  }));

  // Viewer should get session_list update (message count changed) AND the full_sync
  // Since auto-select may send full_sync, collect both
  let gotSync = false;
  let gotList = false;
  for (let i = 0; i < 4; i++) {
    try {
      const m = await waitForMessage(viewer, 1000);
      if (m.type === "full_sync" && m.messages && m.messages.length === 2) gotSync = true;
      if (m.type === "session_list") gotList = true;
    } catch { break; }
  }
  assert(gotSync, "Viewer receives full_sync from source");

  // Source sends streaming delta
  source.send(JSON.stringify({ type: "message_start", id: "msg-2", role: "assistant", sessionId: "test-session" }));
  const start = await waitForType(viewer, "message_start");
  assert(start.type === "message_start", "message_start relayed");
  assert(start.id === "msg-2", "Correct message id");

  source.send(JSON.stringify({ type: "delta", id: "msg-2", text: "Streaming ", sessionId: "test-session" }));
  const delta1 = await waitForType(viewer, "delta");
  assert(delta1.type === "delta" && delta1.text === "Streaming ", "delta relayed");

  source.send(JSON.stringify({ type: "delta_replace", id: "msg-2", text: "Full replace content", sessionId: "test-session" }));
  const replace = await waitForType(viewer, "delta_replace");
  assert(replace.type === "delta_replace", "delta_replace relayed");
  assert(replace.text === "Full replace content", "Replaced text correct");

  source.send(JSON.stringify({ type: "message_end", id: "msg-2", sessionId: "test-session" }));
  const end = await waitForType(viewer, "message_end");
  assert(end.type === "message_end", "message_end relayed");

  const status = server.getStatus();
  assert(status.sources === 1, "1 source connected");
  assert(status.viewers === 1, "1 viewer connected");
  assert(status.sessions === 1, "1 session registered");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 2: Token authentication ───

async function test2_TokenAuth() {
  console.log("\n── Test 2: Token authentication ──");

  server = new LiveShareServer({ port: PORT, token: "secret123" });
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
  const { sessionList } = await drainInitial(goodViewer);
  assert(sessionList.type === "session_list", "Viewer with valid token gets session_list");

  // Source doesn't need token
  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "auth-test", label: "Auth Test", sourceType: "pi" }));
  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "auth-test",
    messages: [{ id: "msg-0", role: "user", text: "Auth test" }],
  }));

  // Viewer gets updated list + full_sync
  let gotSync = false;
  for (let i = 0; i < 5; i++) {
    try {
      const m = await waitForMessage(goodViewer, 1000);
      if (m.type === "full_sync" && m.messages?.length === 1) gotSync = true;
    } catch { break; }
  }
  assert(gotSync, "Authenticated viewer receives messages");

  source.close();
  goodViewer.close();
  await server.stop();
  server = null;
}

// ─── Test 3: Persistence ───

async function test3_Persistence() {
  console.log("\n── Test 3: Persistence ──");
  try { fs.unlinkSync(PERSIST_PATH); } catch {}

  server = new LiveShareServer({ port: PORT, persist: true, persistPath: PERSIST_PATH });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "persist-test", label: "Persist", sourceType: "claude-code" }));
  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "persist-test",
    messages: [
      { id: "msg-0", role: "user", text: "Persisted message" },
      { id: "msg-1", role: "assistant", text: "I will survive" },
    ],
  }));

  await new Promise((r) => setTimeout(r, 500));
  assert(fs.existsSync(PERSIST_PATH), "Backup file created");

  const backup = JSON.parse(fs.readFileSync(PERSIST_PATH, "utf-8"));
  assert(backup["persist-test"] !== undefined, "Session in backup");
  assert(backup["persist-test"].conversation.length === 2, "2 messages in backup");

  source.close();
  await server.stop();

  // Restart — should load from backup
  server = new LiveShareServer({ port: PORT, persist: true, persistPath: PERSIST_PATH });
  await server.start();

  const viewer = await connectWs("/ws/viewer");
  const { sessionList, fullSync } = await drainInitial(viewer);
  assert(sessionList.sessions.length === 1, "Persisted session loaded");
  assert(sessionList.sessions[0].id === "persist-test", "Session id preserved");

  // The server auto-selects the first session
  let sync = fullSync;
  if (!sync) sync = await waitForType(viewer, "full_sync", 2000);
  assert(sync.messages.length === 2, "Persisted messages loaded");
  assert(sync.messages[0].text === "Persisted message", "Message content preserved");

  viewer.close();
  await server.stop();
  server = null;
  try { fs.unlinkSync(PERSIST_PATH); } catch {}
}

// ─── Test 4: Multiple viewers ───

async function test4_MultipleViewers() {
  console.log("\n── Test 4: Multiple viewers ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "multi", label: "Multi", sourceType: "pi" }));

  const viewer1 = await connectWs("/ws/viewer");
  const viewer2 = await connectWs("/ws/viewer");

  await drainInitial(viewer1);
  await drainInitial(viewer2);

  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "multi",
    messages: [{ id: "msg-0", role: "user", text: "Broadcast test" }],
  }));

  // Both viewers should get the full_sync (they auto-selected the session)
  let v1Got = false, v2Got = false;
  for (let i = 0; i < 4; i++) {
    try {
      const m = await waitForMessage(viewer1, 500);
      if (m.type === "full_sync" && m.messages?.length === 1) v1Got = true;
    } catch { break; }
  }
  for (let i = 0; i < 4; i++) {
    try {
      const m = await waitForMessage(viewer2, 500);
      if (m.type === "full_sync" && m.messages?.length === 1) v2Got = true;
    } catch { break; }
  }
  assert(v1Got, "Viewer 1 received full_sync");
  assert(v2Got, "Viewer 2 received full_sync");

  const status = server.getStatus();
  assert(status.viewers === 2, "2 viewers in status");

  source.close();
  viewer1.close();
  viewer2.close();
  await server.stop();
  server = null;
}

// ─── Test 5: Late viewer gets current state ───

async function test5_LateViewer() {
  console.log("\n── Test 5: Late viewer gets current state ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "late", label: "Late", sourceType: "pi" }));
  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "late",
    messages: [
      { id: "msg-0", role: "user", text: "Already here" },
      { id: "msg-1", role: "assistant", text: "Me too" },
    ],
  }));
  await new Promise((r) => setTimeout(r, 300));

  const viewer = await connectWs("/ws/viewer");
  const { sessionList, fullSync } = await drainInitial(viewer);
  assert(sessionList.sessions.length === 1, "Late viewer sees 1 session");

  let sync = fullSync;
  if (!sync) sync = await waitForType(viewer, "full_sync");
  assert(sync.messages.length === 2, "Late viewer gets all existing messages");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 6: Multi-session switching ───

async function test6_SessionSwitching() {
  console.log("\n── Test 6: Session switching ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");

  // Register 2 sessions
  source.send(JSON.stringify({ type: "register_session", sessionId: "s1", label: "Session 1", sourceType: "pi" }));
  source.send(JSON.stringify({ type: "full_sync", sessionId: "s1", messages: [{ id: "s1-0", role: "user", text: "Session 1 msg" }] }));
  source.send(JSON.stringify({ type: "register_session", sessionId: "s2", label: "Session 2", sourceType: "claude-code" }));
  source.send(JSON.stringify({ type: "full_sync", sessionId: "s2", messages: [{ id: "s2-0", role: "user", text: "Session 2 msg" }] }));

  await new Promise((r) => setTimeout(r, 300));

  const viewer = await connectWs("/ws/viewer");
  const { sessionList } = await drainInitial(viewer);
  assert(sessionList.sessions.length === 2, "Viewer sees 2 sessions");

  // Switch to session 2
  viewer.send(JSON.stringify({ type: "switch_session", sessionId: "s2" }));
  const sync = await waitForType(viewer, "full_sync");
  assert(sync.sessionId === "s2", "Switched to session 2");
  assert(sync.messages[0].text === "Session 2 msg", "Session 2 content correct");

  // Messages to s1 should NOT be relayed (viewer is watching s2)
  source.send(JSON.stringify({ type: "message_start", id: "s1-1", role: "assistant", sessionId: "s1" }));
  source.send(JSON.stringify({ type: "delta", id: "s1-1", text: "Should not reach viewer", sessionId: "s1" }));
  source.send(JSON.stringify({ type: "message_end", id: "s1-1", sessionId: "s1" }));

  // Messages to s2 SHOULD be relayed
  source.send(JSON.stringify({ type: "message_start", id: "s2-1", role: "assistant", sessionId: "s2" }));
  source.send(JSON.stringify({ type: "delta", id: "s2-1", text: "Should reach viewer", sessionId: "s2" }));

  // Collect messages — should only get s2 messages (and session_list updates)
  let gotS2 = false;
  let gotS1 = false;
  for (let i = 0; i < 10; i++) {
    try {
      const m = await waitForMessage(viewer, 500);
      if (m.type === "delta" && m.id === "s2-1") gotS2 = true;
      if (m.type === "delta" && m.id === "s1-1") gotS1 = true;
    } catch { break; }
  }
  assert(gotS2, "Viewer gets messages for watched session");
  assert(!gotS1, "Viewer does NOT get messages for other session");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 7: Owner visibility controls ───

async function test7_OwnerVisibility() {
  console.log("\n── Test 7: Owner visibility controls ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "vis-test", label: "Visible", sourceType: "pi" }));
  source.send(JSON.stringify({ type: "full_sync", sessionId: "vis-test", messages: [{ id: "v-0", role: "user", text: "test" }] }));
  await new Promise((r) => setTimeout(r, 300));

  // Owner connects
  const owner = await connectWs("/ws/viewer?owner=true");
  const { sessionList: ownerList } = await drainInitial(owner);
  assert(ownerList.isOwner === true, "Owner flag set");
  assert(ownerList.sessions.length === 1, "Owner sees session");
  assert(ownerList.sessions[0].visible === true, "Session visible by default");

  // Owner hides the session
  owner.send(JSON.stringify({ type: "set_visibility", sessionId: "vis-test", visible: false }));
  const updatedList = await waitForType(owner, "session_list");
  assert(updatedList.sessions[0].visible === false, "Session hidden after set_visibility");

  // Regular viewer connects — should NOT see the hidden session
  const viewer = await connectWs("/ws/viewer");
  const { sessionList: viewerList } = await drainInitial(viewer);
  assert(viewerList.sessions.length === 0, "Regular viewer does NOT see hidden session");

  // Owner makes it visible again
  owner.send(JSON.stringify({ type: "set_visibility", sessionId: "vis-test", visible: true }));
  const restored = await waitForType(viewer, "session_list");
  assert(restored.sessions.length === 1, "Viewer sees session after visibility restored");

  source.close();
  owner.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 8: Backward compat (no sessionId) ───

async function test8_BackwardCompat() {
  console.log("\n── Test 8: Backward compat (no sessionId) ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  // Source sends without sessionId (like Chrome extension)
  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({
    type: "full_sync",
    messages: [
      { id: "msg-0", role: "user", text: "No session id" },
      { id: "msg-1", role: "assistant", text: "Still works" },
    ],
  }));

  await new Promise((r) => setTimeout(r, 300));

  const viewer = await connectWs("/ws/viewer");
  const { sessionList, fullSync } = await drainInitial(viewer);
  assert(sessionList.sessions.length === 1, "Default session created");
  assert(sessionList.sessions[0].id === "claude-ai", "Default session id is 'claude-ai'");

  let sync = fullSync;
  if (!sync) sync = await waitForType(viewer, "full_sync");
  assert(sync.messages.length === 2, "Messages relayed via default session");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 9: New roles (thinking, tool_call, tool_result) ───

async function test9_NewRoles() {
  console.log("\n── Test 9: New roles (thinking, tool_call, tool_result) ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "roles", label: "Roles", sourceType: "pi" }));
  source.send(JSON.stringify({
    type: "full_sync",
    sessionId: "roles",
    messages: [
      { id: "r-0", role: "user", text: "Hello" },
      { id: "r-1", role: "thinking", text: "Let me think..." },
      { id: "r-2", role: "assistant", text: "Hi" },
      { id: "r-3", role: "tool_call", text: '{"path":"x.js"}', toolName: "read", toolCallId: "tc-1" },
      { id: "r-4", role: "tool_result", text: "file contents", toolName: "read", toolCallId: "tc-1" },
    ],
  }));

  await new Promise((r) => setTimeout(r, 300));

  const viewer = await connectWs("/ws/viewer");
  const { fullSync } = await drainInitial(viewer);
  let sync = fullSync;
  if (!sync) sync = await waitForType(viewer, "full_sync");

  assert(sync.messages.length === 5, "5 messages including all roles");
  assert(sync.messages[1].role === "thinking", "Thinking role preserved");
  assert(sync.messages[3].role === "tool_call", "Tool call role preserved");
  assert(sync.messages[3].toolName === "read", "toolName preserved");
  assert(sync.messages[4].role === "tool_result", "Tool result role preserved");
  assert(sync.messages[4].toolCallId === "tc-1", "toolCallId preserved");

  source.close();
  viewer.close();
  await server.stop();
  server = null;
}

// ─── Test 10: Source disconnect marks sessions offline ───

async function test10_SourceDisconnect() {
  console.log("\n── Test 10: Source disconnect marks sessions offline ──");

  server = new LiveShareServer({ port: PORT });
  await server.start();

  const source = await connectWs("/ws/source");
  source.send(JSON.stringify({ type: "register_session", sessionId: "disc", label: "Disconnect Test", sourceType: "pi" }));
  source.send(JSON.stringify({ type: "full_sync", sessionId: "disc", messages: [{ id: "d-0", role: "user", text: "test" }] }));

  await new Promise((r) => setTimeout(r, 300));

  const viewer = await connectWs("/ws/viewer");
  const { sessionList } = await drainInitial(viewer);
  assert(sessionList.sessions[0].connected === true, "Session connected initially");

  // Disconnect source
  source.close();
  const updated = await waitForType(viewer, "session_list");
  assert(updated.sessions[0].connected === false, "Session marked disconnected after source closes");

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
    await test6_SessionSwitching();
    await test7_OwnerVisibility();
    await test8_BackwardCompat();
    await test9_NewRoles();
    await test10_SourceDisconnect();
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
