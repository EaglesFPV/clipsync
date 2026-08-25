'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('clipsync', {
  getState: () => ipcRenderer.invoke('popup:get-state'),
  newPairingCode: () => ipcRenderer.invoke('popup:new-pairing-code'),
  revokeDevice: (deviceId) => ipcRenderer.invoke('popup:revoke-device', deviceId),
  setRemoteHost: (remoteHost) => ipcRenderer.invoke('popup:set-remote-host', remoteHost),
  setRemoteAccessEnabled: (enabled) => ipcRenderer.invoke('popup:set-remote-access-enabled', enabled),
  copyEntry: (text) => ipcRenderer.invoke('popup:copy-entry', text),
  openExternal: (url) => ipcRenderer.invoke('popup:open-external', url),
  onStateUpdate: (callback) => {
    const listener = (_evt, state) => callback(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  },
});
