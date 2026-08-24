'use strict';

const path = require('path');
const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, nativeImage, shell } = require('electron');
const QRCode = require('qrcode');

const { createServer } = require('../server');
const { buildIconPng } = require('./icon');

const PORT = 51828;
const POLL_MS = 700;

let tray = null;
let popupWindow = null;
let server = null;
let lastKnownText = '';

function pickLanIp(lanIps) {
  return lanIps[0] || '127.0.0.1';
}

function buildJoinUrl(code) {
  const ip = pickLanIp(server.lanIps);
  return `https://${ip}:${server.port}/?code=${encodeURIComponent(code)}`;
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

function updatePopupState() {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.webContents.send('state:update', {
      devices: server.pairing.listDevices(),
      connected: server.connectedDeviceIds(),
      history: server.hub.getHistory(),
      lanIps: server.lanIps,
      port: server.port,
    });
  }
}

function registerIpc() {
  ipcMain.handle('popup:get-state', () => ({
    devices: server.pairing.listDevices(),
    connected: server.connectedDeviceIds(),
    history: server.hub.getHistory(),
    lanIps: server.lanIps,
    port: server.port,
  }));

  ipcMain.handle('popup:new-pairing-code', async () => {
    const code = server.pairing.createPairingCode();
    const url = buildJoinUrl(code);
    const qrDataUrl = await QRCode.toDataURL(url, { margin: 1, width: 260 });
    return { url, qrDataUrl, expiresInMs: 2 * 60 * 1000 };
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

app.whenReady().then(() => {
  // Reading the clipboard before the app is ready can hang on Windows (no message pump yet),
  // so this is the earliest point it's safe to touch electron.clipboard.
  lastKnownText = clipboard.readText() || '';

  const dataDir = app.getPath('userData');
  const webDir = path.join(__dirname, '..', 'web');

  server = createServer({
    dataDir,
    webDir,
    port: PORT,
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
});

app.on('window-all-closed', (e) => {
  // Tray app: stay alive in the background instead of quitting when the popup closes.
  e.preventDefault?.();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (server) server.stop();
});
