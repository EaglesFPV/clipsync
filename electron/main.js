'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, nativeImage, shell } = require('electron');
const QRCode = require('qrcode');

const { createServer } = require('../server');
const { startUpnp } = require('../server/upnp');
const { buildIconPng } = require('./icon');
const { loadSettings, saveSettings } = require('./settings');

const PORT = 51828;
const POLL_MS = 700;

let tray = null;
let popupWindow = null;
let server = null;
let upnp = null;
let settings = { remoteAccessEnabled: false, remoteHost: null };
let dataDir = '';
let lastKnownText = '';

function pickLanIp(lanIps) {
  return lanIps[0] || '127.0.0.1';
}

function buildJoinUrl(code) {
  // Pairing happens next to the PC, so the LAN address is the fastest/most reliable choice —
  // the phone learns the remote (DDNS) host too as part of the pairing response and switches
  // to it automatically once it's away from the home network.
  const ip = pickLanIp(server.lanIps);
  return `https://${ip}:${server.port}/?code=${encodeURIComponent(code)}`;
}

function buildAppJoinUrl(code) {
  // The Android app has no page origin to pair against, so the deep link carries every host
  // it should try (LAN candidates + the configured remote/DDNS host, if any).
  const lan = server.lanIps.map((ip) => `${ip}:${server.port}`).join(',');
  const params = new URLSearchParams({ code, lan });
  if (settings.remoteAccessEnabled && settings.remoteHost) params.set('remote', settings.remoteHost);
  return `clipsync://pair?${params.toString()}`;
}

function startClipboardWatcher() {
  setInterval(() => {
    const text = clipboard.readText();
    if (typeof text === 'string' && text && text !== lastKnownText) {
      lastKnownText = text;
      server.broadcastLocalClip(text);
      updatePopupState();
    }
  }, POLL_MS);
}

function createPopupWindow() {
  popupWindow = new BrowserWindow({
    width: 380,
    height: 600,
    show: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    title: 'ClipSync',
    icon: nativeImage.createFromBuffer(buildIconPng(256)),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  popupWindow.setMenuBarVisibility(false);
  popupWindow.loadFile(path.join(__dirname, 'popup', 'index.html'));
  popupWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      popupWindow.hide();
    }
  });
  popupWindow.on('blur', () => {
    if (popupWindow && !popupWindow.webContents.isDevToolsOpened()) popupWindow.hide();
  });
}

function togglePopup() {
  if (!popupWindow) return;
  if (popupWindow.isVisible()) {
    popupWindow.hide();
    return;
  }
  const trayBounds = tray.getBounds();
  const { width, height } = popupWindow.getBounds();
  const x = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const y = Math.round(trayBounds.y > height ? trayBounds.y - height : trayBounds.y + trayBounds.height);
  popupWindow.setPosition(Math.max(0, x), Math.max(0, y));
  popupWindow.show();
  popupWindow.focus();
}

function createTray() {
  const icon = nativeImage.createFromBuffer(buildIconPng(32));
  tray = new Tray(icon);
  tray.setToolTip('ClipSync — presse-papier synchronisé');
  tray.on('click', togglePopup);
  const menu = Menu.buildFromTemplate([
    { label: 'Ouvrir ClipSync', click: togglePopup },
    { type: 'separator' },
    {
      label: 'Quitter',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function snapshotState() {
  return {
    devices: server.pairing.listDevices(),
    connected: server.connectedDeviceIds(),
    history: server.hub.getHistory(),
    lanIps: server.lanIps,
    port: server.port,
    remoteAccessEnabled: settings.remoteAccessEnabled,
    remoteHost: settings.remoteHost,
    upnp: upnp ? upnp.getStatus() : { active: false, externalIp: null, error: null },
  };
}

// UPnP only ever runs while remote access is explicitly enabled — until then the app never
// touches the router, matching the "local by default" choice.
async function enableRemoteAccess() {
  if (upnp) return;
  upnp = startUpnp(PORT);
  try {
    await upnp.start();
  } finally {
    updatePopupState();
  }
}

function disableRemoteAccess() {
  if (!upnp) return;
  upnp.stop();
  upnp = null;
  updatePopupState();
}

function updatePopupState() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('state:update', snapshotState());
  }
}

function registerIpc() {
  ipcMain.handle('popup:get-state', () => snapshotState());

  ipcMain.handle('popup:new-pairing-code', async () => {
    const code = server.pairing.createPairingCode();
    const url = buildJoinUrl(code);
    const appUrl = buildAppJoinUrl(code);
    const [qrDataUrl, appQrDataUrl] = await Promise.all([
      QRCode.toDataURL(url, { margin: 1, width: 260 }),
      QRCode.toDataURL(appUrl, { margin: 1, width: 260 }),
    ]);
    return { url, qrDataUrl, appUrl, appQrDataUrl, expiresInMs: 2 * 60 * 1000 };
  });

  ipcMain.handle('popup:set-remote-host', (_evt, remoteHost) => {
    const trimmed = typeof remoteHost === 'string' ? remoteHost.trim() : '';
    settings.remoteHost = trimmed || null;
    saveSettings(dataDir, settings);
    updatePopupState();
    return settings.remoteHost;
  });

  ipcMain.handle('popup:set-remote-access-enabled', async (_evt, enabled) => {
    settings.remoteAccessEnabled = enabled === true;
    saveSettings(dataDir, settings);
    if (settings.remoteAccessEnabled) await enableRemoteAccess();
    else disableRemoteAccess();
    updatePopupState();
    return settings.remoteAccessEnabled;
  });

  ipcMain.handle('popup:revoke-device', (_evt, deviceId) => {
    server.disconnectDevice(deviceId);
    server.pairing.revokeDevice(deviceId);
    updatePopupState();
    return server.pairing.listDevices();
  });

  ipcMain.handle('popup:copy-entry', (_evt, text) => {
    lastKnownText = text;
    clipboard.writeText(text);
    return true;
  });

  ipcMain.handle('popup:open-external', (_evt, url) => {
    if (typeof url === 'string' && url.startsWith('https://')) shell.openExternal(url);
  });
}

app.whenReady().then(async () => {
  // Reading the clipboard before the app is ready can hang on Windows (no message pump yet),
  // so this is the earliest point it's safe to touch electron.clipboard.
  lastKnownText = clipboard.readText() || '';

  dataDir = app.getPath('userData');
  settings = loadSettings(dataDir);
  const webDir = path.join(__dirname, '..', 'web');

  server = createServer({
    dataDir,
    webDir,
    port: PORT,
    getRemoteHost: () => (settings.remoteAccessEnabled ? settings.remoteHost : null),
    onRemoteClip: (text) => {
      lastKnownText = text;
      clipboard.writeText(text);
      updatePopupState();
    },
  });

  server.hub.on('entry', () => updatePopupState());

  createTray();
  registerIpc();
  createPopupWindow();
  startClipboardWatcher();

  if (settings.remoteAccessEnabled) enableRemoteAccess();
});

app.on('window-all-closed', (e) => {
  // Tray app: stay alive in the background instead of quitting when the popup closes.
  e.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (server) server.stop();
  if (upnp) upnp.stop();
});
