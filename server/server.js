/**
 * Standalone server (for running without Electron).
 * Usage: node server.js [--pi] [--tunnel] [--cwd <path>] [--claude]
 * 
 * Options:
 *   --pi       Auto-start JSONL file watcher (Pi / Claude Code sessions)
 *   --tunnel   Start Cloudflare Tunnel for public sharing
 *   --cwd      Working directory for session discovery (default: process.cwd())
 *   --claude   Force Claude Code session format
 */
const path = require("path");
const { spawn } = require("child_process");
const { LiveShareServer } = require("./ws-server");

const hasFlag = (name) => process.argv.includes(name);
const getArg = (name) => {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
};

const server = new LiveShareServer({
  port: 3333,
  viewerDir: path.join(__dirname, "..", "viewer"),
  tunnel: hasFlag("--tunnel"),
  onStatusChange: (status) => {},
});

server.start().then(() => {
  const s = server.getStatus();
  console.log(`\n🟢 Live Claude Sharing server running`);
  if (server.token) {
    console.log(`   Viewer:  http://localhost:${s.port}?token=${server.token}`);
    console.log(`   Owner:   http://localhost:${s.port}?owner=true&token=${server.token}`);
  } else {
    console.log(`   Viewer:  http://localhost:${s.port}`);
    console.log(`   Owner:   http://localhost:${s.port}?owner=true`);
  }

  // Auto-start JSONL watcher if --pi flag is set
  if (hasFlag("--pi")) {
    const args = [path.join(__dirname, "pi-source.js")];
    const cwd = getArg("--cwd");
    if (cwd) args.push("--cwd", cwd);
    if (hasFlag("--claude")) args.push("--claude");
    args.push("--ws-url", `ws://localhost:${s.port}/ws/source`);

    const maxAge = getArg("--max-age");
    if (maxAge) args.push("--max-age", maxAge);

    console.log(`\n📡 Starting JSONL watcher...`);
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      cwd: cwd || process.cwd(),
    });

    child.on("exit", (code) => {
      console.log(`JSONL watcher exited with code ${code}`);
    });

    process.on("SIGINT", () => { child.kill(); process.exit(0); });
    process.on("SIGTERM", () => { child.kill(); process.exit(0); });
  }

  console.log();
});
