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

function renderRemoteAccess() {
  const enabled = !!currentState.remoteAccessEnabled;
  const toggle = document.getElementById('remote-access-toggle');
  if (document.activeElement !== toggle) toggle.checked = enabled;
  document.getElementById('remote-access-panel').style.display = enabled ? '' : 'none';
  document.getElementById('remote-off-hint').style.display = enabled ? 'none' : '';
  if (!enabled) return;

  const statusEl = document.getElementById('upnp-status');
  const upnp = currentState.upnp || { active: false, externalIp: null, error: null };
  if (upnp.active) {
    statusEl.className = 'status-line ok';
    statusEl.textContent = `Redirection de port automatique réussie${upnp.externalIp ? ' — IP publique actuelle : ' + upnp.externalIp : ''}.`;
  } else {
    statusEl.className = 'status-line warn';
    statusEl.textContent = "Redirection automatique indisponible sur ce routeur (UPnP désactivé ou non supporté) — ouvre le port manuellement, voir ci-dessous.";
  }

  const input = document.getElementById('remote-host');
  if (document.activeElement !== input) {
    input.value = currentState.remoteHost || '';
  }

  const lan = (currentState.lanIps && currentState.lanIps[0]) || '?';
  document.getElementById('remote-hint').textContent =
    `Redirige les ports TCP ${currentState.port} (navigateur) et ${currentState.httpPort} (app Android) vers ${lan} sur ton routeur (automatique si le statut ci-dessus est vert), puis renseigne ici le nom d'hôte DDNS — ex. active-le depuis le NAS : DSM > Panneau de configuration > Accès externe > DDNS.`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

let pairingInfo = null;
let activeTab = 'app';

function renderActiveQr() {
  if (!pairingInfo) return;
  const el = document.getElementById('qr');
  const urlEl = document.getElementById('pair-url');
  if (activeTab === 'app') {
    el.src = pairingInfo.appQrDataUrl;
    urlEl.textContent = 'Scanne avec l\'appareil photo — ouvre directement dans l\'app ClipSync.';
  } else {
    el.src = pairingInfo.qrDataUrl;
    urlEl.textContent = pairingInfo.url;
  }
  document.getElementById('tab-app').classList.toggle('active', activeTab === 'app');
  document.getElementById('tab-browser').classList.toggle('active', activeTab === 'browser');
}

async function refreshQr() {
  pairingInfo = await window.clipsync.newPairingCode();
  renderActiveQr();
}

async function init() {
  currentState = await window.clipsync.getState();
  renderDevices();
  renderHistory();
  renderRemoteAccess();
  await refreshQr();

  document.getElementById('refresh-qr').onclick = refreshQr;
  document.getElementById('tab-app').onclick = () => { activeTab = 'app'; renderActiveQr(); };
  document.getElementById('tab-browser').onclick = () => { activeTab = 'browser'; renderActiveQr(); };
  document.getElementById('save-remote-host').onclick = async () => {
    const value = document.getElementById('remote-host').value;
    currentState.remoteHost = await window.clipsync.setRemoteHost(value);
  };
  document.getElementById('remote-access-toggle').onchange = async (e) => {
    currentState.remoteAccessEnabled = await window.clipsync.setRemoteAccessEnabled(e.target.checked);
    renderRemoteAccess();
  };

  window.clipsync.onStateUpdate((state) => {
    currentState = state;
    renderDevices();
    renderHistory();
    renderRemoteAccess();
  });
}

init();
