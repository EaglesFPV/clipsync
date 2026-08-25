'use strict';

const fs = require('fs');
const path = require('path');

function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

// Remote access (UPnP port mapping + the DDNS host it's advertised under) is opt-in: until the
// user explicitly enables it, the app never touches the router and only syncs on the local
// network (same Wi-Fi, or a phone/PC hotspot), matching the "no exposure by default" choice.
function loadSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    return {
      remoteAccessEnabled: raw.remoteAccessEnabled === true,
      remoteHost: typeof raw.remoteHost === 'string' ? raw.remoteHost : null,
    };
  } catch {
    return { remoteAccessEnabled: false, remoteHost: null };
  }
}

function saveSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

module.exports = { loadSettings, saveSettings };
