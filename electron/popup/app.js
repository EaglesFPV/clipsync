'use strict';

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
}

let currentState = { devices: [], connected: [], history: [] };

function renderDevices() {
  const el = document.getElementById('devices');
  if (currentState.devices.length === 0) {
    el.innerHTML = '<div class="empty">Aucun appareil appairé pour le moment.</div>';
    return;
  }
  el.innerHTML = '';
  for (const device of currentState.devices) {
    const online = currentState.connected.includes(device.id);
    const row = document.createElement('div');
    row.className = 'device-row';
    row.innerHTML = `
      <div>
        <div class="device-name"><span class="dot ${online ? 'online' : ''}"></span>${escapeHtml(device.name)}</div>
        <div class="device-meta">Appairé le ${fmtDate(device.pairedAt)} · ${online ? 'connecté' : 'hors ligne'}</div>
      </div>
    `;
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'ghost';
    revokeBtn.textContent = 'Révoquer';
    revokeBtn.onclick = async () => {
      const devices = await window.clipsync.revokeDevice(device.id);
      currentState.devices = devices;
      currentState.connected = currentState.connected.filter((id) => id !== device.id);
      renderDevices();
    };
    row.appendChild(revokeBtn);
    el.appendChild(row);
  }
}

function renderHistory() {
  const el = document.getElementById('history');
  if (currentState.history.length === 0) {
    el.innerHTML = '<div class="empty">Rien copié pour l\'instant.</div>';
    return;
  }
  el.innerHTML = '';
  for (const entry of currentState.history.slice(0, 12)) {
    const row = document.createElement('div');
    row.className = 'history-row';
    const textEl = document.createElement('div');
    textEl.className = 'history-text';
    textEl.textContent = entry.text;
    textEl.title = entry.text;
    const metaEl = document.createElement('div');
    metaEl.className = 'history-meta';
    metaEl.textContent = `${entry.deviceName} · ${fmtTime(entry.ts)}`;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'ghost';
    copyBtn.textContent = 'Copier';
    copyBtn.onclick = () => window.clipsync.copyEntry(entry.text);
    row.appendChild(textEl);
    row.appendChild(metaEl);
    row.appendChild(copyBtn);
    el.appendChild(row);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function refreshQr() {
  const { url, qrDataUrl } = await window.clipsync.newPairingCode();
  document.getElementById('qr').src = qrDataUrl;
  document.getElementById('pair-url').textContent = url;
}

async function init() {
  currentState = await window.clipsync.getState();
  renderDevices();
  renderHistory();
  await refreshQr();

  document.getElementById('refresh-qr').onclick = refreshQr;

  window.clipsync.onStateUpdate((state) => {
    currentState = state;
    renderDevices();
    renderHistory();
  });
}

init();
