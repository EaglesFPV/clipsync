'use strict';

const crypto = require('crypto');

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function generateDeviceKey() {
  return crypto.randomBytes(32); // AES-256
}

/**
 * Encrypts a JS value for a given device key. Returns a compact base64url envelope:
 * iv (12 bytes) || ciphertext || authTag (16 bytes) — same byte order the browser's
 * SubtleCrypto AES-GCM produces/expects, so the web client needs no byte reshuffling.
 */
function encryptForDevice(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, ciphertext, authTag]).toString('base64url');
}

/**
 * Reverses encryptForDevice. Throws if the key is wrong or the payload was tampered with.
 */
function decryptFromDevice(key, envelopeB64) {
  const buf = Buffer.from(envelopeB64, 'base64url');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(buf.length - 16);
  const ciphertext = buf.subarray(12, buf.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}

function hmac(key, dataBuf) {
  return crypto.createHmac('sha256', key).update(dataBuf).digest();
}

function timingSafeEqualB64(a, b) {
  const bufA = Buffer.from(a, 'base64url');
  const bufB = Buffer.from(b, 'base64url');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = {
  randomToken,
  generateDeviceKey,
  encryptForDevice,
  decryptFromDevice,
  hmac,
  timingSafeEqualB64,
};
