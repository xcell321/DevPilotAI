/**
 * DevPilot AI - Electron preload script.
 *
 * Context-isolated bridge. Exposes only what the renderer needs;
 * no direct Node access from the web UI.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('devpilotDesktop', {
  platform: process.platform,
  isDesktop: true,
  onBackendStopped: (callback) => ipcRenderer.on('backend-stopped', (_e, code) => callback(code)),
});
