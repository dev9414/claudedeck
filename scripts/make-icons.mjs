#!/usr/bin/env node
/**
 * Rasterizes the app icon from `assets/icon.svg` into the PNG sizes
 * electron-builder needs.
 *
 *   node scripts/make-icons.mjs
 *   node scripts/make-icons.mjs --sizes 512,256,128,64,32,16
 *
 * WHY ELECTRON AND NOT AN ENCODER
 * -------------------------------
 * The obvious alternative is to hand-roll a PNG encoder and draw the geometry
 * twice — once as SVG for the web, once into a pixel buffer for the file. That
 * works, but it means the icon exists in two places and they drift the first
 * time someone nudges a curve. `assets/icon.svg` is the single source of truth,
 * and Chromium — already present as a devDependency — is a far better SVG
 * renderer than anything worth writing here. No new dependency is added.
 *
 * electron-builder reads `assets/` as buildResources and derives the Windows
 * `.ico` and macOS `.icns` from `icon.png`, so 512 is the only size strictly
 * required; the rest are emitted for Linux desktop entries and the README.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'assets', 'icon.svg');
const OUT_DIR = join(ROOT, 'assets');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const sizes = arg('sizes', '512,256,128,64,32,16')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

if (!existsSync(SRC)) {
  console.error(`missing ${SRC}`);
  process.exit(1);
}
mkdirSync(OUT_DIR, { recursive: true });

const svg = readFileSync(SRC, 'utf8');
// Scratch files live outside assets/: a crashed run must not leave anything in
// the directory electron-builder reads as buildResources, and two runs sharing
// one scratch path made the second delete the page the first was still loading.
const tempDir = mkdtempSync(join(tmpdir(), 'claudedeck-icons-'));
const tmpHtml = join(tempDir, 'icon-render.html');
const tmpMain = join(tempDir, 'icon-render.cjs');

// The SVG is inlined rather than <img>-referenced so there is no second fetch
// and no chance of the renderer painting before the file resolves.
writeFileSync(
  tmpHtml,
  `<!doctype html><meta charset="utf-8">
<style>
  html,body{margin:0;padding:0;background:transparent;overflow:hidden}
  svg{display:block;width:100vw;height:100vh}
</style>
${svg.replace(/<\?xml[^>]*\?>/, '').replace(/width="512"\s+height="512"/, '')}`,
);

writeFileSync(
  tmpMain,
  `const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

const SIZES = ${JSON.stringify(sizes)};
const OUT = ${JSON.stringify(OUT_DIR)};
const HTML = ${JSON.stringify(tmpHtml)};

// capturePage() hands back device pixels, so on a 125% or 200% display the same
// window yields a 640 or 1024 raster and every emitted size is wrong by that
// factor. Pinning the scale makes the output depend on SIZES and nothing else.
app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  // One high-resolution render, then downscale. Creating and destroying an
  // offscreen window per size fails intermittently on Windows (ERR_FAILED on
  // the second load), and resampling one clean 512 raster is both reliable and
  // visually identical at these sizes.
  const master = Math.max(...SIZES, 512);
  const w = new BrowserWindow({
    width: master, height: master, show: false, frame: false,
    transparent: true, useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false },
  });
  await w.loadFile(HTML);
  await new Promise((r) => setTimeout(r, 400));
  const full = await w.webContents.capturePage();

  // Loud rather than subtle: a wrong master size silently poisons every file
  // below, and an icon that is 1.25x too big still opens fine in a viewer.
  const got = full.getSize();
  if (got.width !== master || got.height !== master) {
    console.error(
      'captured ' + got.width + 'x' + got.height + ' but expected ' + master + 'x' + master +
        ' - the display scale factor was not honoured',
    );
    w.destroy();
    app.exit(1);
    return;
  }

  for (const size of SIZES) {
    const img = size === master ? full : full.resize({ width: size, height: size, quality: 'best' });
    const name = size === 512 ? 'icon.png' : \`icon-\${size}.png\`;
    writeFileSync(join(OUT, name), img.toPNG());
    console.log('wrote', name, size + 'x' + size);
  }
  w.destroy();
  console.log('ICONS_DONE');
  app.quit();
}).catch((cause) => {
  // Without this the failure surfaces as an UnhandledPromiseRejectionWarning
  // and the exit code stays 0, which reads as success from the parent.
  console.error(String((cause && cause.stack) || cause));
  app.exit(1);
});
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electron = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const child = spawn(electron, [tmpMain], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
});

let stdout = '';
child.stdout.on('data', (d) => {
  stdout += d;
  process.stdout.write(String(d));
});
child.stderr.on('data', (d) => {
  const s = String(d);
  if (!/GPU|gpu_|network_service|DevTools|cache_util|disk_cache/i.test(s)) process.stderr.write(s);
});

child.on('exit', (code) => {
  rmSync(tempDir, { recursive: true, force: true });
  if (!stdout.includes('ICONS_DONE')) {
    console.error(`icon generation failed (electron exited ${code})`);
    process.exit(1);
  }
  process.exit(0);
});
