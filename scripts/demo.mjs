#!/usr/bin/env node
/**
 * Launch ClaudeDeck in demo mode.
 *
 *   npm run demo
 *
 * Sets CLAUDEDECK_DEMO=1, which makes the main process serve deterministic
 * synthetic accounts and refuse every disk write, so the app can be explored
 * and screenshotted without touching a real Claude Code install.
 *
 * This exists instead of `cross-env` because the project ships no runtime or
 * script dependencies, and bare `VAR=1 cmd` is not portable to Windows shells.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.includes('--dev') ? 'dev' : 'preview';

if (mode === 'preview' && !existsSync(resolve(ROOT, 'out', 'main', 'index.js'))) {
  console.error('No build found at out/. Run `npm run build` first, or use `npm run demo -- --dev`.');
  process.exit(1);
}

const bin = resolve(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite');

const child = spawn(bin, [mode], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, CLAUDEDECK_DEMO: '1' },
});

child.on('exit', (code) => process.exit(code ?? 0));
