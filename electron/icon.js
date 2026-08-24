'use strict';

const zlib = require('zlib');

// Minimal from-scratch PNG encoder (RGBA, 8-bit, filter type 0) so the app ships its own
// tray/window icon without depending on an external image asset or a native image library.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** pixelFn(x, y) must return [r, g, b, a] (0-255). */
function encodePng(width, height, pixelFn) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: RGBA
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = chunk('IHDR', ihdrData);

  const raw = Buffer.alloc(height * (1 + width * 4));
  let offset = 0;
  for (let y = 0; y < height; y++) {
    raw[offset++] = 0; // filter type: none
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y);
      raw[offset++] = r;
      raw[offset++] = g;
      raw[offset++] = b;
      raw[offset++] = a;
    }
  }
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdr, idat, iend]);
}

/** Simple rounded-square "clipboard" glyph in a single accent color, good enough for a tray icon. */
function buildIconPng(size = 32) {
  const accent = [79, 70, 229]; // indigo
  const paper = [255, 255, 255];
  const radius = size * 0.22;

  function insideRoundedRect(x, y) {
    const inset = size * 0.12;
    const left = inset;
    const right = size - inset;
    const top = inset;
    const bottom = size - inset;
    const cx = Math.min(Math.max(x, left + radius), right - radius);
    const cy = Math.min(Math.max(y, top + radius), bottom - radius);
    if (x < left || x > right || y < top || y > bottom) return false;
    const dx = x - cx;
    const dy = y - cy;
    return dx * dx + dy * dy <= radius * radius || (x >= left + radius && x <= right - radius) || (y >= top + radius && y <= bottom - radius);
  }

  return encodePng(size, size, (x, y) => {
    if (!insideRoundedRect(x + 0.5, y + 0.5)) return [0, 0, 0, 0];
    // Inner "paper" strip to suggest a clipboard.
    const stripLeft = size * 0.32;
    const stripRight = size * 0.68;
    const stripTop = size * 0.2;
    const stripBottom = size * 0.42;
    if (x >= stripLeft && x <= stripRight && y >= stripTop && y <= stripBottom) {
      return [...paper, 255];
    }
    return [...accent, 255];
  });
}

module.exports = { buildIconPng };
