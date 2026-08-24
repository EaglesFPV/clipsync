'use strict';

const fs = require('fs');
const path = require('path');

function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json');
}

function loadSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(dataDir), 'utf8'));
    return { remoteHost: typeof raw.remoteHost === 'string' ? raw.remoteHost : null };
  } catch {
    return { remoteHost: null };
  }
}

function saveSettings(dataDir, settings) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

module.exports = { loadSettings, saveSettings };
