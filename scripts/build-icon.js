'use strict';

// Generates build/icon.ico (a single 256x256 PNG-compressed image, the modern ICO format
// Windows/electron-builder both accept) from our hand-rolled icon generator, so the app
// ships its own installer/taskbar icon without needing an external image asset.

const fs = require('fs');
const path = require('path');
const { buildIconPng } = require('../electron/icon');

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });

const png = buildIconPng(256);

const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0); // reserved
iconDir.writeUInt16LE(1, 2); // type: icon
iconDir.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width (0 = 256)
entry.writeUInt8(0, 1); // height (0 = 256)
entry.writeUInt8(0, 2); // color count
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // color planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // image data size
entry.writeUInt32LE(22, 12); // offset (6-byte header + 16-byte entry)

const ico = Buffer.concat([iconDir, entry, png]);
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
console.log('Wrote build/icon.ico (', ico.length, 'bytes )');
