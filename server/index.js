'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { getOrCreateCert, detectLanIps } = require('./tls');
const { PairingManager } = require('./pairing');
const { ClipboardHub } = require('./clipboardHub');
const {
  encryptForDevice,
  decryptFromDevice,
  deriveCodeKey,
  hmac,
  timingSafeEqualB64,
} = require('./crypto');
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
 * Boots the local server(s) that everything talks to. Nothing here ever depends on the
 * internet: it binds on the LAN interface(s) and every payload beyond the initial pairing
 * exchange is encrypted with a per-device key that only ever leaves the PC via the QR code —
 * and even that initial exchange is encrypted with a key derived from the (out-of-band) pairing
 * code itself, so it stays confidential regardless of transport.
 *
 * Two listeners run side by side, sharing all state and logic:
 *  - HTTPS/WSS on `port`, for the browser/PWA path (needs a secure context for the Clipboard
 *    and service worker APIs, and browsers let a user click through the self-signed cert once).
 *  - plain HTTP/WS on `httpPort`, for the Android app: its WebView has no interactive way to
 *    accept a self-signed certificate, so it talks to the PC over plain HTTP instead — safe
 *    because nothing sent over it is meaningful without the AES-256-GCM keys layered on top.
 *
 * options.onRemoteClip(text, device) is called when a paired phone pushes a clip to sync locally.
 * options.getRemoteHost() optionally returns the "host:port" reachable from outside the LAN
 * (DDNS hostname + forwarded port), read live on every call so a change in settings propagates
 * to clients without a server restart.
 * options.onListenError(err) is called if a server fails to bind (e.g. port already in use).
 */
function createServer({ dataDir, webDir, port = 51828, httpPort = 51829, onRemoteClip, getRemoteHost, onListenError }) {
  const { key, cert, fingerprint } = getOrCreateCert(dataDir);
  const pairing = new PairingManager(dataDir);
  const hub = new ClipboardHub();
  const pairLimiter = new RateLimiter({ maxFailures: 5, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 });
  const authLimiter = new RateLimiter({ maxFailures: 5, windowMs: 5 * 60 * 1000, blockMs: 15 * 60 * 1000 });

  // deviceId -> Set<WebSocket>, only ever contains sockets that passed the challenge/response auth.
  const sockets = new Map();

  function connectionInfo(reportPort) {
    return {
      lanHosts: detectLanIps().map((ip) => `${ip}:${reportPort}`),
      remoteHost: typeof getRemoteHost === 'function' ? getRemoteHost() || null : null,
    };
  }

  function handleRequest(req, res) {
    // The Android app's page (served from Capacitor's own http://localhost origin) always pairs
    // against an absolute host:port picked from the deep link, so this request is genuinely
    // cross-origin — the JSON POST body makes the browser send a CORS preflight first, which
    // would otherwise 404 here and silently block the real request.
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
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
          const codeKey = deriveCodeKey(body.code);
          const payload = encryptForDevice(codeKey, {
            deviceId: result.id,
            key: result.key.toString('base64'),
            name: result.name,
            ...connectionInfo(req.socket.localPort),
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ payload }));
        })
        .catch(() => {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'bad_request' }));
        });
      return;
    }
    serveStatic(webDir, req, res);
  }

  function handleWsConnection(ws, req) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (authLimiter.isBlocked(ip)) {
      ws.close(4029, 'too_many_attempts');
      return;
    }

    const url = new URL(req.url, 'http://placeholder');
    const deviceId = url.searchParams.get('deviceId');
    const device = deviceId ? pairing.getDevice(deviceId) : null;

    if (!device) {
      ws.close(4001, 'unknown_device');
      return;
    }

    const reportPort = req.socket.localPort;
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
              payload: encryptForDevice(device.key, { history: hub.getHistory(), ...connectionInfo(reportPort) }),
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
  }

  function handleListenError(err) {
    if (typeof onListenError === 'function') onListenError(err);
    else console.error('ClipSync server failed to start:', err);
  }

  // A bind failure (e.g. port already taken by another running instance) would otherwise throw
  // as an uncaught exception and crash the whole Electron process — surface it instead.
  const httpsServer = https.createServer({ key, cert }, handleRequest);
  httpsServer.on('error', handleListenError);
  const wssHttps = new WebSocketServer({ server: httpsServer, path: '/ws' });
  wssHttps.on('connection', handleWsConnection);

  const plainServer = http.createServer(handleRequest);
  plainServer.on('error', handleListenError);
  const wssHttp = new WebSocketServer({ server: plainServer, path: '/ws' });
  wssHttp.on('connection', handleWsConnection);

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
    wssHttps.close();
    wssHttp.close();
    httpsServer.close();
    plainServer.close();
  }

  httpsServer.listen(port, '0.0.0.0');
  plainServer.listen(httpPort, '0.0.0.0');

  return {
    port,
    httpPort,
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
