'use strict';

// electron-builder's generated release/latest.yml references a hyphenated filename that does
// NOT always match the actual NSIS installer filename it builds (a long-standing electron-builder
// quirk — see electron-userland/electron-builder#3937). This only stays in sync automatically
// when electron-builder does its own publish/upload, which we don't use (see .github/workflows/
// build.yml, we upload via softprops/action-gh-release instead). Rename the installer to exactly
// what latest.yml expects so electron-updater can actually find it on the GitHub release.

const fs = require('fs');
const path = require('path');

const releaseDir = path.join(__dirname, '..', 'release');
const yamlPath = path.join(releaseDir, 'latest.yml');

const yaml = fs.readFileSync(yamlPath, 'utf8');
const match = yaml.match(/^path:\s*(.+)$/m);
if (!match) throw new Error('No top-level "path:" field found in release/latest.yml');
const expectedName = match[1].trim();

const candidates = fs.readdirSync(releaseDir).filter((f) => f.endsWith('.exe') && /setup/i.test(f));
if (candidates.length !== 1) {
  throw new Error(`Expected exactly one Setup .exe in release/, found: ${candidates.join(', ') || '(none)'}`);
}
const actualName = candidates[0];

if (actualName === expectedName) {
  console.log('Installer filename already matches latest.yml:', actualName);
} else {
  fs.renameSync(path.join(releaseDir, actualName), path.join(releaseDir, expectedName));
  console.log(`Renamed "${actualName}" -> "${expectedName}" to match latest.yml`);

  // electron-updater's differential-download feature looks for "<installer>.blockmap" next to
  // the installer it just fetched, so it has to follow the same rename.
  const blockmapOld = `${actualName}.blockmap`;
  const blockmapNew = `${expectedName}.blockmap`;
  if (fs.existsSync(path.join(releaseDir, blockmapOld))) {
    fs.renameSync(path.join(releaseDir, blockmapOld), path.join(releaseDir, blockmapNew));
    console.log(`Renamed "${blockmapOld}" -> "${blockmapNew}"`);
  }
}
