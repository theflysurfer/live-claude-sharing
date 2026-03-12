/**
 * System tray management for Live Claude Sharing.
 */
const { Tray, Menu, nativeImage, clipboard } = require("electron");
const path = require("path");

class LiveShareTray {
  constructor(options = {}) {
    this.tray = null;
    this.mainWindow = options.mainWindow;
    this.port = options.port || 3333;
    this.token = options.token || null;
    this.status = { sources: 0, viewers: 0, messages: 0, streaming: false };
    this.onQuit = options.onQuit || (() => {});
  }

  create() {
    // Use a simple 16x16 icon
    const iconPath = path.join(__dirname, "assets", "tray-icon.png");
    let icon;
    try {
      icon = nativeImage.createFromPath(iconPath);
      if (icon.isEmpty()) throw new Error("empty");
    } catch {
      // Fallback: create a simple colored icon programmatically
      icon = this._createDefaultIcon();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip("Live Claude Sharing");
    this._updateMenu();

    // Click to show/hide window
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
    
    // Update tray icon color based on status
    if (this.tray) {
      const icon = this.status.sources > 0
        ? this._createDefaultIcon("#22c55e") // green
        : this._createDefaultIcon("#ef4444"); // red
      this.tray.setImage(icon);
      
      const tooltip = this.status.sources > 0
        ? `Live Claude Sharing — Connected (${this.status.viewers} viewer${this.status.viewers !== 1 ? "s" : ""})`
        : "Live Claude Sharing — Waiting for source";
      this.tray.setToolTip(tooltip);
    }
  }

  _updateMenu() {
    const statusLabel = this.status.sources > 0
      ? `🟢 Source connected`
      : `🔴 Waiting for source`;

    const viewerLabel = `👥 ${this.status.viewers} viewer${this.status.viewers !== 1 ? "s" : ""}`;

    const menu = Menu.buildFromTemplate([
      { label: "Live Claude Sharing", enabled: false },
      { type: "separator" },
      { label: statusLabel, enabled: false },
      { label: viewerLabel, enabled: false },
      { type: "separator" },
      {
        label: "📋 Copy Viewer URL",
        click: () => clipboard.writeText(this._viewerUrl()),
      },
      {
        label: "🌐 Open Viewer in Browser",
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
        click: () => this.onQuit(),
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
    // Create a 32x32 icon via data URL (PNG from SVG via Electron)
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
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}

module.exports = { LiveShareTray };
