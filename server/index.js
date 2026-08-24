'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { getOrCreateCert, detectLanIps } = require('./tls');
const { PairingManager } = require('./pairing');
const { ClipboardHub } = require('./clipboardHub');
const { encryptForDevice, decryptFromDevice, hmac, timingSafeEqualB64 } = require('./crypto');
const { RateLimiter } = require('./rateLimiter');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function readJsonBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function serveStatic(webDir, req, res) {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(webDir, relPath));

  if (!filePath.startsWith(path.normalize(webDir))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/**
 * Boots the local HTTPS + WebSocket server. Nothing here ever talks to the internet:
 * it binds on the LAN interface and every payload beyond the pairing handshake is
 * encrypted with a per-device key that only ever leaves the PC via the QR code.
 *
 * options.onRemoteClip(text, device) is called when a paired phone pushes a clip to sync locally.
 * options.getRemoteHost() optionally returns the "host:port" reachable from outside the LAN
 * (DDNS hostname + forwarded port), read live on every call so a change in settings propagates
 * to clients without a server restart.
 */
function createServer({ dataDir, webDir, port = 51828, onRemoteClip, getRemoteHost }) {
  const { key, cert, fingerprint } = getOrCreateCert(dataDir);
  const pairing = new PairingManager(dataDir);
  const hub = new ClipboardHub();
  const pairLimiter = new RateLimiter({ maxFailures: 5, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 });
  const authLimiter = new RateLimiter({ maxFailures: 5, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 });

  // deviceId -> Set<WebSocket>, only ever contains sockets that passed the challenge/response auth.
  const sockets = new Map();

  function connectionInfo() {
    return {
      lanHosts: detectLanIps().map((ip) => `${ip}:${port}`),
      remoteHost: typeof getRemoteHost === 'function' ? getRemoteHost() || null : null,
    };
  }

  const httpServer = https.createServer({ key, cert }, (req, res) => {
    if (req.method === 'POST' && req.url === '/api/pair') {
      const ip = req.socket.remoteAddress || 'unknown';
      if (pairLimiter.isBlocked(ip)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'too_many_attempts' }));
        return;
      }
      readJsonBody(req)
        .then((body) => {
          const result = pairing.completePairing(body.code, body.deviceName);
          if (!result) {
            pairLimiter.recordFailure(ip);
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid_or_expired_code' }));
            return;
          }
          pairLimiter.recordSuccess(ip);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              deviceId: result.id,
              key: result.key.toString('base64'),
              name: result.name,
              ...connectionInfo(),
            })
          );
        })
        .catch(() => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
        });
      return;
    }
    serveStatic(webDir, req, res);
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress || 'unknown';
    if (authLimiter.isBlocked(ip)) {
      ws.close(4029, 'too_many_attempts');
      return;
    }

    const url = new URL(req.url, 'https://placeholder');
    const deviceId = url.searchParams.get('deviceId');
    const device = deviceId ? pairing.getDevice(deviceId) : null;

    if (!device) {
      ws.close(4001, 'unknown_device');
      return;
    }

    let authenticated = false;
    const challenge = crypto.randomBytes(16);
    ws.send(JSON.stringify({ type: 'challenge', challenge: challenge.toString('base64url') }));

    const authTimeout = setTimeout(() => {
      if (!authenticated) ws.close(4002, 'auth_timeout');
    }, 10_000);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (!authenticated) {
        if (msg.type !== 'authResponse') return;
        const expected = hmac(device.key, challenge).toString('base64url');
        if (typeof msg.proof === 'string' && timingSafeEqualB64(msg.proof, expected)) {
          authenticated = true;
          clearTimeout(authTimeout);
          authLimiter.recordSuccess(ip);
          if (!sockets.has(deviceId)) sockets.set(deviceId, new Set());
          sockets.get(deviceId).add(ws);
          ws.send(
            JSON.stringify({
              type: 'authOk',
              payload: encryptForDevice(device.key, { history: hub.getHistory(), ...connectionInfo() }),
            })
          );
        } else {
          authLimiter.recordFailure(ip);
          ws.close(4003, 'bad_proof');
        }
        return;
      }

      if (msg.type === 'clip' && typeof msg.payload === 'string') {
        let data;
        try {
          data = decryptFromDevice(device.key, msg.payload);
        } catch {
          return; // tampered or wrong key: drop silently
        }
        if (typeof data.text !== 'string' || !data.text) return;
        const entry = hub.addEntry({ text: data.text, source: 'device', deviceId, deviceName: device.name });
        if (typeof onRemoteClip === 'function') onRemoteClip(entry.text, device);
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimeout);
      const set = sockets.get(deviceId);
      if (set) {
        set.delete(ws);
        if (set.size === 0) sockets.delete(deviceId);
      }
    });

    ws.on('error', () => ws.close());
  });

  // Keep LAN connections alive through idle NAT/router timeouts.
  const pingInterval = setInterval(() => {
    for (const set of sockets.values()) {
      for (const ws of set) {
        try {
          ws.ping();
        } catch {
          // socket already going away; the 'close' handler will clean it up
        }
      }
    }
  }, 25_000);

  hub.on('entry', (entry) => {
    for (const [deviceId, set] of sockets) {
      if (deviceId === entry.deviceId) continue; // don't echo back to the sender
      const device = pairing.getDevice(deviceId);
      if (!device) continue;
      const payload = encryptForDevice(device.key, entry);
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'clip', payload }));
      }
    }
  });

  function broadcastLocalClip(text) {
    hub.addEntry({ text, source: 'pc', deviceName: 'PC' });
  }

  function disconnectDevice(deviceId) {
    const set = sockets.get(deviceId);
    if (!set) return;
    for (const ws of set) ws.close(4004, 'revoked');
    sockets.delete(deviceId);
  }

  function stop() {
    clearInterval(pingInterval);
    pairLimiter.stop();
    authLimiter.stop();
    wss.close();
    httpServer.close();
  }

  httpServer.listen(port, '0.0.0.0');

  return {
    port,
    fingerprint,
    lanIps: detectLanIps(),
    pairing,
    hub,
    broadcastLocalClip,
    disconnectDevice,
    connectedDeviceIds: () => [...sockets.keys()],
    stop,
  };
}

module.exports = { createServer };
