'use strict';

const STORAGE_KEY = 'clipsync-device';
const appEl = document.getElementById('app');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const toastEl = document.getElementById('toast');

let ws = null;
let hmacKey = null;
let aesKey = null;
let history = [];
let reconnectTimer = null;
let activeHosts = [];

// ---- base64url <-> bytes -------------------------------------------------

function b64urlToBytes(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stdBase64ToBytes(str) {
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---- crypto ---------------------------------------------------------------

async function loadDeviceKeys(rawKeyB64) {
  // The server sends the raw device key as plain (non-url) base64.
  const raw = stdBase64ToBytes(rawKeyB64);
  hmacKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function signChallenge(challengeB64url) {
  const challengeBytes = b64urlToBytes(challengeB64url);
  const sig = await crypto.subtle.sign('HMAC', hmacKey, challengeBytes);
  return bytesToB64url(new Uint8Array(sig));
}

async function encryptForServer(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(value));
  const ctBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, pt);
  const combined = new Uint8Array(iv.length + ctBuf.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ctBuf), iv.length);
  return bytesToB64url(combined);
}

async function decryptWithKey(key, envelopeB64url) {
  const bytes = b64urlToBytes(envelopeB64url);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  return JSON.parse(new TextDecoder().decode(ptBuf));
}

function decryptFromServer(envelopeB64url) {
  return decryptWithKey(aesKey, envelopeB64url);
}

/**
 * Derives the same AES-256 key the server derives from the pairing code (SHA-256 of the code
 * string) to decrypt the one-time /api/pair response — confidential even over plain HTTP, which
 * is what the Android app uses since its WebView can't accept our self-signed HTTPS cert.
 */
async function deriveCodeKey(code) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM' }, false, ['decrypt']);
}

// ---- native app (Capacitor) detection --------------------------------------

function isNative() {
  return !!(window.Capacitor && window.Capacitor.Plugins);
}

function httpScheme() {
  return isNative() ? 'http' : 'https';
}

function wsScheme() {
  return isNative() ? 'ws' : 'wss';
}

// ---- app update check (Android only — the browser/PWA always serves the latest code) --------

function isNewerVersion(candidate, current) {
  const a = String(candidate).split('.').map((n) => parseInt(n, 10) || 0);
  const b = String(current).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function showUpdateBanner(version, downloadUrl) {
  const banner = document.getElementById('update-banner');
  if (!banner) return;
  banner.style.display = 'flex';
  banner.innerHTML = `<span>Nouvelle version disponible (v${version})</span>`;
  if (downloadUrl) {
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.textContent = 'Télécharger';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      window.open(downloadUrl, '_system');
    });
    banner.appendChild(link);
  }
}

async function checkForAppUpdate() {
  const AppPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (!AppPlugin) return; // only the packaged Android app ships as a versioned APK
  try {
    const info = await AppPlugin.getInfo();
    const res = await fetch('https://api.github.com/repos/EaglesFPV/clipsync/releases/latest');
    if (!res.ok) return;
    const release = await res.json();
    const latest = (release.tag_name || '').replace(/^v/, '');
    if (!latest || !isNewerVersion(latest, info.version)) return;
    const apkAsset = (release.assets || []).find((a) => a.name.endsWith('.apk'));
    showUpdateBanner(latest, apkAsset && apkAsset.browser_download_url);
  } catch {
    // offline, rate-limited, or the API shape changed: skip silently, try again next time
  }
}

// ---- native clipboard (Capacitor) with browser fallback -----------------------

function nativeClipboard() {
  return window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Clipboard;
}

async function readClipboard() {
  const plugin = nativeClipboard();
  if (plugin) {
    const { value } = await plugin.read();
    return value || '';
  }
  return navigator.clipboard.readText();
}

async function writeClipboard(text) {
  const plugin = nativeClipboard();
  if (plugin) {
    await plugin.write({ string: text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

// ---- device storage ---------------------------------------------------------

function getStoredDevice() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function storeDevice(device) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(device));
}

/** LAN hosts first (fastest on the home network), then the remote/DDNS host, last-good-host first. */
function candidateHosts(device) {
  const hosts = [...(device.lanHosts || [])];
  if (device.remoteHost && !hosts.includes(device.remoteHost)) hosts.push(device.remoteHost);
  if (device.lastGoodHost && hosts.includes(device.lastGoodHost)) {
    return [device.lastGoodHost, ...hosts.filter((h) => h !== device.lastGoodHost)];
  }
  return hosts;
}

// ---- UI ---------------------------------------------------------------------

function setStatus(online, label) {
  statusDot.classList.toggle('online', online);
  statusText.textContent = label;
}

function showToast(text) {
  toastEl.textContent = text;
  toastEl.classList.add('show');
  setTimeout(() => toastEl.classList.remove('show'), 2200);
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function renderSyncedApp() {
  appEl.innerHTML = `
    <div class="card">
      <button class="send-btn" id="send-btn">Envoyer le presse-papier au PC</button>
      <div class="hint">Le PC reçoit le texte copié sur ce téléphone.</div>
    </div>
    <div class="card">
      <div id="history-list"></div>
    </div>
  `;
  document.getElementById('send-btn').addEventListener('click', onSendClicked);
  renderHistory();
}

function renderHistory() {
  const el = document.getElementById('history-list');
  if (!el) return;
  if (history.length === 0) {
    el.innerHTML = '<div class="empty">Rien de synchronisé pour l\'instant.</div>';
    return;
  }
  el.innerHTML = '';
  for (const entry of history.slice(0, 20)) {
    const row = document.createElement('div');
    row.className = 'history-item';
    const textEl = document.createElement('div');
    textEl.className = 'history-text';
    textEl.textContent = entry.text;
    const metaEl = document.createElement('div');
    metaEl.className = 'history-meta';
    metaEl.textContent = `${entry.deviceName} · ${fmtTime(entry.ts)}`;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'copy-btn';
    copyBtn.textContent = 'Copier';
    copyBtn.addEventListener('click', async () => {
      try {
        await writeClipboard(entry.text);
        showToast('Copié dans le presse-papier.');
      } catch {
        showToast("Impossible de copier — autorisez l'accès au presse-papier.");
      }
    });
    row.appendChild(textEl);
    row.appendChild(metaEl);
    row.appendChild(copyBtn);
    el.appendChild(row);
  }
}

async function onSendClicked() {
  try {
    const text = await readClipboard();
    if (!text) {
      showToast('Le presse-papier est vide.');
      return;
    }
    const payload = await encryptForServer({ text });
    ws.send(JSON.stringify({ type: 'clip', payload }));
    showToast('Envoyé au PC.');
  } catch {
    showToast("Impossible de lire le presse-papier — autorisez l'accès.");
  }
}

function renderPairingForm(code, hosts) {
  appEl.innerHTML = `
    <div class="card pair-form">
      <p class="message">Nouvel appareil détecté. Donnez-lui un nom puis appairez-le avec votre PC.</p>
      <label for="device-name">Nom de cet appareil</label>
      <input type="text" id="device-name" value="Mon téléphone" />
      <button id="pair-btn">Appairer</button>
      <p class="message" id="pair-error" style="color:#e0574c;margin-top:10px;"></p>
    </div>
  `;
  document.getElementById('pair-btn').addEventListener('click', async () => {
    const name = document.getElementById('device-name').value || 'Mon téléphone';
    await completePairing(code, name, hosts);
  });
}

function renderNotPaired() {
  appEl.innerHTML = `
    <div class="card">
      <p class="message">Cet appareil n'est pas encore appairé. Scannez le QR code affiché dans ClipSync sur votre PC pour continuer.</p>
    </div>
  `;
}

// ---- pairing + connection -----------------------------------------------------

/**
 * hosts: explicit "host:port" candidates to pair against (used by the Android app's deep-link
 * flow, which has no page origin to fall back on). When omitted, pairs against the page's own
 * origin — the browser/PWA flow, reached by navigating to the PC's URL, already IS that host.
 */
async function completePairing(code, deviceName, hosts) {
  const targets = hosts && hosts.length ? hosts.map((h) => `${httpScheme()}://${h}/api/pair`) : ['/api/pair'];
  let response = null;
  // Diagnostic detail per attempted host — fetch() only exposes a generic error to JS, but the
  // status code / response body still tells apart "unreachable" from "reached but rejected".
  const attempts = [];
  const codeKey = await deriveCodeKey(code);
  for (const url of targets) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, deviceName }),
      });
      if (res.ok) {
        const { payload } = await res.json();
        response = await decryptWithKey(codeKey, payload);
        break;
      }
      let body = '';
      try {
        body = await res.text();
      } catch {
        // ignore — status code alone is still useful
      }
      attempts.push(`${url} → HTTP ${res.status} ${body}`.trim());
    } catch (err) {
      attempts.push(`${url} → ${(err && err.message) || err}`);
    }
  }

  if (!response) {
    const errorEl = document.getElementById('pair-error');
    const detail = attempts.length ? attempts.join(' | ') : 'aucun hôte à essayer';
    const msg = `Impossible d'appairer. Détails : ${detail}`;
    if (errorEl) {
      errorEl.textContent = msg;
    } else {
      appEl.innerHTML = '<div class="card"><p class="message" id="pair-error-fallback"></p></div>';
      document.getElementById('pair-error-fallback').textContent = msg;
    }
    return;
  }

  const device = {
    deviceId: response.deviceId,
    key: response.key,
    name: response.name,
    lanHosts: response.lanHosts || (hosts ? [] : [location.host]),
    remoteHost: response.remoteHost || null,
    lastGoodHost: null,
  };
  storeDevice(device);
  if (!hosts) window.history.replaceState({}, '', '/');
  await loadDeviceKeys(device.key);
  connect(device.deviceId, candidateHosts(device));
}

function connectToHost(host, deviceId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = new WebSocket(`${wsScheme()}://${host}/ws?deviceId=${encodeURIComponent(deviceId)}`);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.close();
      reject(new Error('timeout'));
    }, timeoutMs);

    socket.addEventListener('message', async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'challenge') {
        const proof = await signChallenge(msg.challenge);
        socket.send(JSON.stringify({ type: 'authResponse', proof }));
      } else if (msg.type === 'authOk' && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ socket, host, payload: msg.payload });
      }
    });
    socket.addEventListener('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('ws_error'));
    });
    socket.addEventListener('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('closed'));
    });
  });
}

async function connect(deviceId, hosts) {
  clearTimeout(reconnectTimer);
  activeHosts = hosts;
  if (!hosts || hosts.length === 0) {
    setStatus(false, "Aucun hôte connu — réappaire cet appareil.");
    return;
  }
  setStatus(false, 'Connexion…');

  const attempts = hosts.map((host) =>
    connectToHost(host, deviceId, 6000).catch((err) => ({ failed: true, host, err }))
  );
  const results = await Promise.all(attempts);
  const winner = results.find((r) => !r.failed);
  for (const r of results) {
    if (!r.failed && r.socket !== (winner && winner.socket)) r.socket.close();
  }

  if (!winner) {
    setStatus(false, 'Hors ligne');
    reconnectTimer = setTimeout(() => connect(deviceId, hosts), 3000);
    return;
  }

  ws = winner.socket;
  const data = await decryptFromServer(winner.payload);
  history = data.history || [];

  const device = getStoredDevice();
  if (device) {
    device.lastGoodHost = winner.host;
    if (Array.isArray(data.lanHosts)) device.lanHosts = data.lanHosts;
    if ('remoteHost' in data) device.remoteHost = data.remoteHost;
    storeDevice(device);
  }

  setStatus(true, 'Synchronisé');
  renderSyncedApp();

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'clip') {
      const entry = await decryptFromServer(msg.payload);
      history = [entry, ...history].slice(0, 25);
      renderHistory();
      // Best-effort: write straight to the OS clipboard so the entry is immediately pasteable.
      // Only reliable while this app is open in the foreground (native ClipboardManager writes
      // need that); the "Copier" button in the history list stays as the always-works fallback.
      try {
        await writeClipboard(entry.text);
        showToast('Texte copié automatiquement depuis le PC.');
      } catch {
        showToast('Nouveau texte reçu du PC.');
      }
    }
  });

  ws.addEventListener('close', () => {
    setStatus(false, 'Hors ligne');
    reconnectTimer = setTimeout(() => connect(deviceId, hosts), 2000);
  });
}

document.addEventListener('visibilitychange', () => {
  const device = getStoredDevice();
  if (document.visibilityState === 'visible' && device && (!ws || ws.readyState === WebSocket.CLOSED)) {
    connect(device.deviceId, candidateHosts(device));
  }
});

// ---- deep-link pairing (Android app, clipsync://pair?code=...&lan=...&remote=...) ------------

window.__clipsyncHandleDeepLink = function handleDeepLink(url) {
  try {
    const parsed = new URL(url);
    const code = parsed.searchParams.get('code');
    if (!code) return;
    const hosts = [];
    if (parsed.searchParams.get('lan')) hosts.push(...parsed.searchParams.get('lan').split(','));
    if (parsed.searchParams.get('remote')) hosts.push(parsed.searchParams.get('remote'));
    renderPairingForm(code, hosts);
  } catch {
    // malformed deep link: ignore rather than crash the app
  }
};

// ---- boot -----------------------------------------------------------------

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }

  checkForAppUpdate();
  setInterval(checkForAppUpdate, 6 * 60 * 60 * 1000);

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const stored = getStoredDevice();

  if (stored) {
    await loadDeviceKeys(stored.key);
    connect(stored.deviceId, candidateHosts(stored));
    return;
  }

  if (code) {
    renderPairingForm(code, null);
    return;
  }

  renderNotPaired();
}

boot();
