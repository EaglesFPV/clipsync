'use strict';

/**
 * In-memory per-IP throttle for authentication attempts. Now that the server can be reached
 * from the internet (port-forwarded), this blunts brute-force/scanning against /api/pair and
 * the WS challenge/response handshake — neither of which is guessable (192-bit pairing codes,
 * 256-bit device keys), but a temporary block costs nothing and removes the incentive to try.
 */
class RateLimiter {
  constructor({ maxFailures = 5, windowMs = 5 * 60 * 1000, blockMs = 15 * 60 * 1000 } = {}) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.blockMs = blockMs;
    this.byIp = new Map(); // ip -> { failures: number[], blockedUntil: number }
    this.sweepInterval = setInterval(() => this._sweep(), windowMs).unref();
  }

  isBlocked(ip) {
    const entry = this.byIp.get(ip);
    return !!entry && entry.blockedUntil > Date.now();
  }

  recordFailure(ip) {
    const now = Date.now();
    let entry = this.byIp.get(ip);
    if (!entry) {
      entry = { failures: [], blockedUntil: 0 };
      this.byIp.set(ip, entry);
    }
    entry.failures = entry.failures.filter((t) => now - t < this.windowMs);
    entry.failures.push(now);
    if (entry.failures.length >= this.maxFailures) {
      entry.blockedUntil = now + this.blockMs;
      entry.failures = [];
    }
  }

  recordSuccess(ip) {
    this.byIp.delete(ip);
  }

  _sweep() {
    const now = Date.now();
    for (const [ip, entry] of this.byIp) {
      if (entry.blockedUntil < now && entry.failures.every((t) => now - t > this.windowMs)) {
        this.byIp.delete(ip);
      }
    }
  }

  stop() {
    clearInterval(this.sweepInterval);
  }
}

module.exports = { RateLimiter };
