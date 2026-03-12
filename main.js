/**
 * Live Claude Sharing — Electron main process.
 * Starts the WebSocket relay server and opens the viewer in a window.
 */
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const { LiveShareServer } = require("./server/ws-server");
const { LiveShareTray } = require("./tray");

const PORT = 3333;
const TOKEN = process.env.LIVESHARE_TOKEN === "0" ? null : true; // true = auto-generate
let mainWindow = null;
let tray = null;
let server = null;
let isQuitting = false;

// ─── Server ───

async function startServer() {
  server = new LiveShareServer({
    port: PORT,
    viewerDir: path.join(__dirname, "viewer"),
    token: TOKEN,
    onStatusChange: (status) => {
      if (tray) tray.updateStatus(status);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("status-update", status);
      }
    },
  });

  try {
    await server.start();
    console.log(`[Electron] Server started on port ${PORT}`);
  } catch (err) {
    console.error("[Electron] Failed to start server:", err.message);
  }
}

// ─── Window ───

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 700,
    minWidth: 400,
    minHeight: 300,
    title: "Live Claude Sharing",
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Load the viewer page directly (not via HTTP — avoids port conflict issues)
  mainWindow.loadFile(path.join(__dirname, "viewer", "index.html"));

  // Hide menu bar
  mainWindow.setMenuBarVisibility(false);

  // Close → hide to tray (unless quitting)
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ─── Tray ───

function createTray() {
  tray = new LiveShareTray({
    mainWindow,
    port: PORT,
    token: server ? server.token : null,
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  tray.create();
}

// ─── IPC ───

ipcMain.handle("get-status", () => {
  return server ? server.getStatus() : null;
});

ipcMain.handle("get-port", () => PORT);
ipcMain.handle("get-token", () => server ? server.token : null);

// ─── App lifecycle ───

app.whenReady().then(async () => {
  await startServer();
  createWindow();
  createTray();

  app.on("activate", () => {
    // macOS: re-create window on dock click
    if (!mainWindow) {
      createWindow();
    } else {
      mainWindow.show();
    }
  });
});

app.on("before-quit", async () => {
  isQuitting = true;
  if (server) await server.stop();
  if (tray) tray.destroy();
});

// Keep running when all windows closed (tray mode)
app.on("window-all-closed", () => {
  // Don't quit — keep server running in tray
  if (process.platform !== "darwin" && isQuitting) {
    app.quit();
  }
});
