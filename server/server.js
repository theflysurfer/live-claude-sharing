/**
 * Standalone server (for running without Electron).
 * Usage: node server.js
 */
const path = require("path");
const { LiveShareServer } = require("./ws-server");

const server = new LiveShareServer({
  port: 3333,
  viewerDir: path.join(__dirname, "..", "viewer"),
  onStatusChange: (status) => {
    // Optional: log status changes
  },
});

server.start().then(() => {
  const s = server.getStatus();
  console.log(`\n🟢 Live Claude Sharing server running`);
  if (server.token) {
    console.log(`   Viewer:  http://localhost:${s.port}?token=${server.token}`);
  } else {
    console.log(`   Viewer:  http://localhost:${s.port}`);
  }
  console.log(`   Source:  ws://localhost:${s.port}/ws/source`);
  console.log(`   Viewer WS: ws://localhost:${s.port}/ws/viewer${server.token ? `?token=${server.token}` : ""}\n`);
});
