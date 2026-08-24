'use strict';

// Replaces Capacitor's placeholder launcher icons with ours, generated from the same
// hand-rolled PNG encoder used for the desktop tray icon (electron/icon.js) — no image
// asset or native rasterizer needed.

const fs = require('fs');
const path = require('path');
const { buildIconPng, buildAdaptiveForegroundPng } = require('../electron/icon');

const RES_DIR = path.join(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

// Legacy launcher icon (also used as the round variant) and adaptive-icon foreground, per density.
const LEGACY_SIZES = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
const FOREGROUND_SIZES = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };

for (const [density, size] of Object.entries(LEGACY_SIZES)) {
  const png = buildIconPng(size);
  const dir = path.join(RES_DIR, `mipmap-${density}`);
  fs.writeFileSync(path.join(dir, 'ic_launcher.png'), png);
  fs.writeFileSync(path.join(dir, 'ic_launcher_round.png'), png);
}

for (const [density, size] of Object.entries(FOREGROUND_SIZES)) {
  const png = buildAdaptiveForegroundPng(size);
  fs.writeFileSync(path.join(RES_DIR, `mipmap-${density}`, 'ic_launcher_foreground.png'), png);
}

console.log('Wrote Android launcher icons for densities:', Object.keys(LEGACY_SIZES).join(', '));
