/**
 * Preload script — exposes server status to the renderer (viewer page).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("liveShare", {
  // Get server status
  getStatus: () => ipcRenderer.invoke("get-status"),

  // Listen for status updates
  onStatusUpdate: (callback) => {
    ipcRenderer.on("status-update", (_event, status) => callback(status));
  },

  // Get the port
  getPort: () => ipcRenderer.invoke("get-port"),

  // Get the auth token
  getToken: () => ipcRenderer.invoke("get-token"),
});
