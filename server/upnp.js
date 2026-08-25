'use strict';

const MAPPING_TTL_SECONDS = 3600;
const REFRESH_MS = 45 * 60 * 1000;
const DISCOVERY_TIMEOUT_MS = 8000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ms)),
  ]);
}

/**
 * Best-effort automatic port forwarding via UPnP IGD, so the router doesn't need manual
 * configuration for the PC to be reachable from outside the LAN. Many routers ship with UPnP
 * disabled or don't support it at all, and this library's exact surface can shift between
 * versions — every failure mode here (unsupported router, timeout, API mismatch) collapses to
 * the same soft "active: false" result. Callers must treat that as a normal outcome and fall
 * back to showing manual port-forward instructions, never as a hard error.
 */
function startUpnp(ports) {
  const portList = Array.isArray(ports) ? ports : [ports];
  let gateway = null;
  let refreshTimer = null;
  let lastResult = { active: false, externalIp: null, error: null };

  async function mapOnce() {
    const attempt = (async () => {
      const { upnpNat } = await import('@achingbrain/nat-port-mapper');
      if (!gateway) {
        const client = upnpNat();
        for await (const gw of client.findGateways()) {
          gateway = gw;
          break;
        }
        if (!gateway) throw new Error('no_upnp_gateway_found');
      }
      for (const port of portList) {
        await gateway.mapAll(port, { protocol: 'tcp', ttl: MAPPING_TTL_SECONDS });
      }
      const ip = await gateway.externalIp();
      return { active: true, externalIp: ip, error: null };
    })();

    const result = await withTimeout(attempt.catch((err) => ({ active: false, externalIp: null, error: err.message || String(err) })), DISCOVERY_TIMEOUT_MS);
    lastResult = result.timedOut ? { active: false, externalIp: null, error: 'upnp_timeout' } : result;
    return lastResult;
  }

  async function start() {
    await mapOnce();
    refreshTimer = setInterval(mapOnce, REFRESH_MS);
    if (refreshTimer.unref) refreshTimer.unref();
    return lastResult;
  }

  function stop() {
    clearInterval(refreshTimer);
    if (gateway) {
      Promise.resolve(gateway.stop()).catch(() => {
        // best-effort cleanup only; the router expires the mapping via its TTL regardless
      });
    }
  }

  function getStatus() {
    return lastResult;
  }

  return { start, stop, getStatus };
}

module.exports = { startUpnp };
