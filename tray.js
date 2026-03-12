/**
 * System tray management for Live Claude Sharing.
 * Includes one-click Cloudflare Tunnel sharing.
 */
const { Tray, Menu, nativeImage, clipboard, Notification } = require("electron");
const { spawn } = require("child_process");
const path = require("path");

class LiveShareTray {
  constructor(options = {}) {
    this.tray = null;
    this.mainWindow = options.mainWindow;
    this.port = options.port || 3333;
    this.token = options.token || null;
    this.status = { sources: 0, viewers: 0, messages: 0, streaming: false };
    this.onQuit = options.onQuit || (() => {});

    // Tunnel state
    this.tunnelProcess = null;
    this.tunnelUrl = null;
    this.tunnelState = "stopped"; // stopped, starting, running, error
  }

  create() {
    const iconPath = path.join(__dirname, "assets", "tray-icon.png");
    let icon;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error("empty");
    } catch {
      icon = this._createDefaultIcon();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("Live Claude Sharing");
    this._updateMenu();

    this.tray.on("click", () => {
      if (this.mainWindow) {
        if (this.mainWindow.isVisible()) {
          this.mainWindow.hide();
        } else {
          this.mainWindow.show();
          this.mainWindow.focus();
        }
      }
    });
  }

  updateStatus(status) {
    this.status = status;
    this._updateMenu();

    if (this.tray) {
      const icon = this.status.sources > 0
        ? this._createDefaultIcon("#22c55e")
        : this._createDefaultIcon("#ef4444");
      this.tray.setImage(icon);

      const tooltip = this.status.sources > 0
        ? `Live Claude Sharing — Connected (${this.status.viewers} viewer${this.status.viewers !== 1 ? "s" : ""})`
        : "Live Claude Sharing — Waiting for source";
      this.tray.setToolTip(tooltip);
    }
  }

  // ─── Tunnel Management ───

  startTunnel() {
    if (this.tunnelProcess) {
      this.stopTunnel();
    }

    this.tunnelState = "starting";
    this.tunnelUrl = null;
    this._updateMenu();

    console.log("[Tray] Starting Cloudflare Tunnel...");

    this.tunnelProcess = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${this.port}`], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    const onData = (data) => {
      const line = data.toString();
      // Extract tunnel URL from output
      const urlMatch = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (urlMatch && !this.tunnelUrl) {
        this.tunnelUrl = urlMatch[0];
        this.tunnelState = "running";
        console.log(`[Tray] Tunnel ready: ${this.tunnelUrl}`);

        // Build share URL with token and copy to clipboard
        const shareUrl = this._shareUrl();
        clipboard.writeText(shareUrl);
        this._updateMenu();

        // Show notification
        if (Notification.isSupported()) {
          const notif = new Notification({
            title: "🔗 Share link copied!",
            body: shareUrl,
            silent: false,
          });
          notif.show();
        }
      }
    };

    this.tunnelProcess.stdout.on("data", onData);
    this.tunnelProcess.stderr.on("data", onData);

    this.tunnelProcess.on("error", (err) => {
      console.error(`[Tray] Tunnel error: ${err.message}`);
      this.tunnelState = "error";
      this.tunnelUrl = null;
      this._updateMenu();

      if (err.code === "ENOENT") {
        if (Notification.isSupported()) {
          new Notification({
            title: "❌ cloudflared not found",
            body: "Install it: winget install Cloudflare.cloudflared",
          }).show();
        }
      }
    });

    this.tunnelProcess.on("exit", (code) => {
      console.log(`[Tray] Tunnel exited with code ${code}`);
      this.tunnelProcess = null;
      if (this.tunnelState !== "stopped") {
        this.tunnelState = "stopped";
        this.tunnelUrl = null;
        this._updateMenu();
      }
    });
  }

  stopTunnel() {
    if (this.tunnelProcess) {
      console.log("[Tray] Stopping tunnel...");
      this.tunnelProcess.kill();
      this.tunnelProcess = null;
    }
    this.tunnelState = "stopped";
    this.tunnelUrl = null;
    this._updateMenu();
  }

  _shareUrl() {
    if (!this.tunnelUrl) return this._viewerUrl();
    return this.token
      ? `${this.tunnelUrl}?token=${this.token}`
      : this.tunnelUrl;
  }

  // ─── Menu ───

  _updateMenu() {
    const statusLabel = this.status.sources > 0
      ? `🟢 Source connected`
      : `🔴 Waiting for source`;

    const viewerLabel = `👥 ${this.status.viewers} viewer${this.status.viewers !== 1 ? "s" : ""}`;

    // Tunnel menu items
    let tunnelItems = [];
    switch (this.tunnelState) {
      case "stopped":
        tunnelItems = [
          {
            label: "🌍 Share online (start tunnel)",
            click: () => this.startTunnel(),
          },
        ];
        break;
      case "starting":
        tunnelItems = [
          { label: "⏳ Tunnel starting...", enabled: false },
        ];
        break;
      case "running":
        tunnelItems = [
          { label: `🌍 Sharing: ${this.tunnelUrl}`, enabled: false },
          {
            label: "📋 Copy share link",
            click: () => {
              clipboard.writeText(this._shareUrl());
              if (Notification.isSupported()) {
                new Notification({ title: "📋 Link copied!", body: this._shareUrl() }).show();
              }
            },
          },
          {
            label: "🛑 Stop sharing",
            click: () => this.stopTunnel(),
          },
        ];
        break;
      case "error":
        tunnelItems = [
          { label: "❌ Tunnel failed", enabled: false },
          {
            label: "🔄 Retry",
            click: () => this.startTunnel(),
          },
        ];
        break;
    }

    const menu = Menu.buildFromTemplate([
      { label: "Live Claude Sharing", enabled: false },
      { type: "separator" },
      { label: statusLabel, enabled: false },
      { label: viewerLabel, enabled: false },
      { type: "separator" },
      ...tunnelItems,
      { type: "separator" },
      {
        label: "📋 Copy local URL",
        click: () => clipboard.writeText(this._viewerUrl()),
      },
      {
        label: "🌐 Open viewer in browser",
        click: () => {
          const { shell } = require("electron");
          shell.openExternal(this._viewerUrl());
        },
      },
      { type: "separator" },
      {
        label: "Show Window",
        click: () => {
          if (this.mainWindow) {
            this.mainWindow.show();
            this.mainWindow.focus();
          }
        },
      },
      { type: "separator" },
      {
        label: "❌ Quit",
        click: () => {
          this.stopTunnel();
          this.onQuit();
        },
      },
    ]);

    if (this.tray) {
      this.tray.setContextMenu(menu);
    }
  }

  _viewerUrl() {
    const base = `http://localhost:${this.port}`;
    return this.token ? `${base}?token=${this.token}` : base;
  }

  _createDefaultIcon(color = "#d97706") {
    const size = 32;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <circle cx="${size/2}" cy="${size/2}" r="${size/2 - 1}" fill="${color}"/>
      <text x="${size/2}" y="${size/2 + 2}" text-anchor="middle" dominant-baseline="middle" 
            fill="white" font-size="18" font-weight="bold" font-family="sans-serif">C</text>
    </svg>`;

    const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
    const img = nativeImage.createFromDataURL(dataUrl);
    return img.isEmpty() ? nativeImage.createEmpty() : img;
  }

  destroy() {
    this.stopTunnel();
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { LiveShareTray };
