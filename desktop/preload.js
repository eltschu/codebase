'use strict';
// Only used by the "Connect to a server" window: lets it hand the address to the app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('codebase', {
  setServer: url => ipcRenderer.invoke('codebase:set-server', url),
});
