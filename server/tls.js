'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const selfsigned = require('selfsigned');

const KEY_FILE = 'tls-key.pem';
const CERT_FILE = 'tls-cert.pem';

function detectLanIps() {
  const os = require('os');
  const ifaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) ips.push(iface.address);
    }
  }
  return ips;
}

function generateCert() {
  const lanIps = detectLanIps();
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    ...lanIps.map((ip) => ({ type: 7, ip })),
  ];
  const attrs = [{ name: 'commonName', value: 'clipsync.local' }];
  const pems = selfsigned.generate(attrs, {
    keySize: 2048,
    days: 3650,
    algorithm: 'sha256',
    extensions: [{ name: 'subjectAltName', altNames }],
  });
  return { key: pems.private, cert: pems.cert };
}

/**
 * Loads a persisted self-signed cert from dataDir, or generates and persists a new one.
 * Reused across restarts so paired devices don't see a new "untrusted cert" warning each time.
 */
function getOrCreateCert(dataDir) {
  const keyPath = path.join(dataDir, KEY_FILE);
  const certPath = path.join(dataDir, CERT_FILE);

  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    const key = fs.readFileSync(keyPath, 'utf8');
    const cert = fs.readFileSync(certPath, 'utf8');
    return { key, cert, fingerprint: fingerprintOf(cert) };
  }

  const { key, cert } = generateCert();
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  fs.writeFileSync(certPath, cert, { mode: 0o600 });
  return { key, cert, fingerprint: fingerprintOf(cert) };
}

function fingerprintOf(certPem) {
  const der = Buffer.from(
    certPem.replace(/-----BEGIN CERTIFICATE-----/, '').replace(/-----END CERTIFICATE-----/, '').replace(/\s+/g, ''),
    'base64'
  );
  return crypto.createHash('sha256').update(der).digest('hex').match(/.{2}/g).join(':');
}

module.exports = { getOrCreateCert, detectLanIps };
