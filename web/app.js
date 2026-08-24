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

// ---- crypto ---------------------------------------------------------------

async function loadDeviceKeys(rawKeyB64) {
  const raw = b64urlToBytesFromStandardBase64(rawKeyB64);
  hmacKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  aesKey = await crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function b64urlToBytesFromStandardBase64(str) {
  // The server sends the raw device key as plain (non-url) base64 in the /api/pair response.
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
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

async function decryptFromServer(envelopeB64url) {
  const bytes = b64urlToBytes(envelopeB64url);
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);
  const ptBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, data);
  return JSON.parse(new TextDecoder().decode(ptBuf));
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
        await navigator.clipboard.writeText(entry.text);
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
    const text = await navigator.clipboard.readText();
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

function renderPairingForm(code) {
  appEl.innerHTML = `
    <div class="card pair-form">
      <p class="message">Nouvel appareil détecté. Donnez-lui un nom puis appairez-le avec votre PC.</p>
      <label for="device-name">Nom de cet appareil</label>
      <input type="text" id="device-name" value="Mon téléphone" />
      <button id="pair-btn">Appairer</button>
    </div>
  `;
  document.getElementById('pair-btn').addEventListener('click', async () => {
    const name = document.getElementById('device-name').value || 'Mon téléphone';
    await completePairing(code, name);
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

async function completePairing(code, deviceName) {
  const res = await fetch('/api/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, deviceName }),
  });
  if (!res.ok) {
    appEl.innerHTML = `<div class="card"><p class="message">Ce code d'appairage est invalide ou a expiré. Générez-en un nouveau depuis le PC et rescannez.</p></div>`;
    return;
  }
  const device = await res.json();
  storeDevice(device);
  window.history.replaceState({}, '', '/');
  await loadDeviceKeys(device.key);
  connect(device.deviceId);
}

function connect(deviceId) {
  clearTimeout(reconnectTimer);
  setStatus(false, 'Connexion…');
  ws = new WebSocket(`wss://${location.host}/ws?deviceId=${encodeURIComponent(deviceId)}`);

  ws.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === 'challenge') {
      const proof = await signChallenge(msg.challenge);
      ws.send(JSON.stringify({ type: 'authResponse', proof }));
      return;
    }

    if (msg.type === 'authOk') {
      const data = await decryptFromServer(msg.payload);
      history = data.history || [];
      setStatus(true, 'Synchronisé');
      renderSyncedApp();
      return;
    }

    if (msg.type === 'clip') {
      const entry = await decryptFromServer(msg.payload);
      history = [entry, ...history].slice(0, 25);
      renderHistory();
      showToast('Nouveau texte reçu du PC.');
    }
  });

  ws.addEventListener('close', () => {
    setStatus(false, 'Hors ligne');
    reconnectTimer = setTimeout(() => connect(deviceId), 2000);
  });

  ws.addEventListener('error', () => ws.close());
}

document.addEventListener('visibilitychange', () => {
  const device = getStoredDevice();
  if (document.visibilityState === 'visible' && device && (!ws || ws.readyState === WebSocket.CLOSED)) {
    connect(device.deviceId);
  }
});

// ---- boot -----------------------------------------------------------------

async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/service-worker.js').catch(() => {});
  }

  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const stored = getStoredDevice();

  if (stored) {
    await loadDeviceKeys(stored.key);
    connect(stored.deviceId);
    return;
  }

  if (code) {
    renderPairingForm(code);
    return;
  }

  renderNotPaired();
}

boot();
