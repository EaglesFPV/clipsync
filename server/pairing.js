'use strict';

const fs = require('fs');
const path = require('path');
const { randomToken, generateDeviceKey } = require('./crypto');

const DEVICES_FILE = 'devices.json';
const PAIRING_TTL_MS = 2 * 60 * 1000;

class PairingManager {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.devicesPath = path.join(dataDir, DEVICES_FILE);
    this.sessions = new Map(); // code -> { expiresAt }
    this.devices = this._loadDevices(); // deviceId -> { name, key(Buffer), pairedAt }
  }

  _loadDevices() {
    const map = new Map();
    if (!fs.existsSync(this.devicesPath)) return map;
    try {
      const raw = JSON.parse(fs.readFileSync(this.devicesPath, 'utf8'));
      for (const d of raw) {
        map.set(d.id, { name: d.name, key: Buffer.from(d.key, 'base64'), pairedAt: d.pairedAt });
      }
    } catch {
      // corrupt/missing file: start fresh rather than crash the app
    }
    return map;
  }

  _saveDevices() {
    const raw = [...this.devices.entries()].map(([id, d]) => ({
      id,
      name: d.name,
      key: d.key.toString('base64'),
      pairedAt: d.pairedAt,
    }));
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.devicesPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
  }

  createPairingCode() {
    // Drop expired sessions so the map doesn't grow unbounded.
    for (const [code, session] of this.sessions) {
      if (session.expiresAt < Date.now()) this.sessions.delete(code);
    }
    const code = randomToken(24);
    this.sessions.set(code, { expiresAt: Date.now() + PAIRING_TTL_MS });
    return code;
  }

  /** Consumes a pairing code (single use) and mints a new paired device. Returns null if invalid/expired. */
  completePairing(code, deviceName) {
    const session = this.sessions.get(code);
    if (!session || session.expiresAt < Date.now()) return null;
    this.sessions.delete(code);

    const id = randomToken(12);
    const key = generateDeviceKey();
    const name = (deviceName || 'Appareil').toString().slice(0, 60);
    this.devices.set(id, { name, key, pairedAt: Date.now() });
    this._saveDevices();
    return { id, key, name };
  }

  getDevice(id) {
    return this.devices.get(id) || null;
  }

  listDevices() {
    return [...this.devices.entries()].map(([id, d]) => ({ id, name: d.name, pairedAt: d.pairedAt }));
  }

  revokeDevice(id) {
    const existed = this.devices.delete(id);
    if (existed) this._saveDevices();
    return existed;
  }
}

module.exports = { PairingManager };
