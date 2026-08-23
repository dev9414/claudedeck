#!/usr/bin/env node
/**
 * Regenerates the README screenshot set in `assets/screenshots/`.
 *
 * HOW TO RUN
 * ----------
 *   npm run build          # required first; this script never builds for you
 *   npm run screenshots
 *
 * On a headless Linux box there is no compositor to capture, so wrap it:
 *   xvfb-run -a npm run screenshots
 *
 * Flags:
 *   --out <dir>    where the PNGs land        (default assets/screenshots)
 *   --only <a,b>   capture just these ids
 *   --width <n>    CSS width                  (default 1440)
 *   --height <n>   CSS height                 (default 936)
 *   --scale <n>    device scale factor        (default 2)
 *   --help
 *
 * WHY IT DRIVES THE REAL APP
 * --------------------------
 * The tempting shortcut is to load the built renderer on its own and stub
 * `window.claudedeck` with fixture data. That produces a picture of a mock, not
 * of the product: the real main process, its IPC, its state pushes and its
 * chart data never run, so the screenshots can look right while the app is
 * broken.
 *
 * Instead this launches the actual app with `CLAUDEDECK_DEMO=1` and a remote
 * debugging port, then drives it over the Chrome DevTools Protocol — set the
 * hash route, stamp the theme, wait for paint, capture. Nothing needs to be
 * added to production code, and what you see is what the app really renders.
 *
 * `CLAUDEDECK_DEMO=1` makes `src/main/demo.ts` serve four deterministic
 * synthetic accounts from a seeded PRNG and refuse every disk write, so this is
 * safe to run on a machine with a real Claude Code login and produces the same
 * images every time.
 *
 * The onboarding wizard only exists before any account is managed, so it cannot
 * be reached by changing route. It gets a second launch with
 * `CLAUDEDECK_DEMO_ONBOARDING=1`, which stages the demo as a fresh install.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `id` is the PNG filename. `firstRun` shots need the fresh-install launch. */
const SHOTS = [
  { id: 'dashboard-dark', route: 'dashboard', theme: 'dark' },
  { id: 'dashboard-light', route: 'dashboard', theme: 'light' },
  { id: 'accounts', route: 'accounts', theme: 'dark' },
  { id: 'timeline', route: 'timeline', theme: 'dark' },
  { id: 'automation', route: 'automation', theme: 'dark' },
  { id: 'settings', route: 'settings', theme: 'light' },
  { id: 'onboarding', route: 'dashboard', theme: 'dark', firstRun: true },
];

function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

if (has('help')) {
  console.log(
    [
      'Usage: node scripts/capture-screenshots.mjs [options]',
      '  --out DIR      output directory (default assets/screenshots)',
      `  --only a,b     subset of: ${SHOTS.map((s) => s.id).join(', ')}`,
      '  --width N --height N --scale N',
    ].join('\n'),
  );
  process.exit(0);
}

const OUT = resolve(ROOT, flag('out', join('assets', 'screenshots')));
const WIDTH = Number(flag('width', 1440));
const HEIGHT = Number(flag('height', 936));
const SCALE = Number(flag('scale', 2));

const only = flag('only', '');
const wanted = only ? new Set(only.split(',').map((s) => s.trim())) : null;
const shots = wanted ? SHOTS.filter((s) => wanted.has(s.id)) : SHOTS;

if (!shots.length) {
  console.error(`--only matched nothing. Known ids: ${SHOTS.map((s) => s.id).join(', ')}`);
  process.exit(1);
}

const mainEntry = join(ROOT, 'out', 'main', 'index.js');
if (!existsSync(mainEntry)) {
  console.error(`No build found at ${mainEntry}\nRun \`npm run build\` first.`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const electronBin = join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');

/** The smallest CDP client that does the job. */
function connect(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
  });
  return function send(method, params = {}) {
    const mid = ++id;
    ws.send(JSON.stringify({ id: mid, method, params }));
    return new Promise((res, rej) => {
      pending.set(mid, { resolve: res, reject: rej });
      setTimeout(() => rej(new Error(`${method} timed out`)), 30_000);
    });
  };
}

async function findPage(port, attempts = 80) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      /* the port is not listening yet */
    }
    await sleep(500);
  }
  throw new Error(`no DevTools page target on :${port} — did the app fail to start?`);
}

/**
 * Launches the app once, captures `group`, and shuts it down again.
 * `firstRun` stages the demo backend as a fresh install.
 */
async function captureGroup(group, { firstRun }) {
  if (!group.length) return 0;

  // A per-process, per-group port so two runs cannot collide.
  const port = 9400 + (process.pid % 400) + (firstRun ? 1 : 0);

  const env = { ...process.env, CLAUDEDECK_DEMO: '1' };
  if (firstRun) env.CLAUDEDECK_DEMO_ONBOARDING = '1';
  // Some editors export this; it would make Electron run as plain Node and no
  // window would ever appear.
  delete env.ELECTRON_RUN_AS_NODE;

  // Each launch gets its own user-data dir. The app holds a single-instance
  // lock, so without this the second launch would see the first still running
  // and exit immediately instead of opening a window.
  const userData = join(tmpdir(), `claudedeck-shots-${process.pid}-${firstRun ? 'first' : 'main'}`);

  const child = spawn(
    electronBin,
    [mainEntry, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
  );
  child.stderr.on('data', (d) => {
    const s = String(d);
    // Chromium is noisy about GPU and cache details that mean nothing here.
    if (!/GPU|gpu_|network_service|DevTools listening|Autofill|cache_util|disk_cache/i.test(s)) {
      process.stderr.write(`[app] ${s}`);
    }
  });

  let captured = 0;
  try {
    const page = await findPage(port);
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('devtools websocket refused')), { once: true });
    });

    const send = connect(ws);
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: SCALE,
      mobile: false,
    });

    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} :: ${expression}`);
      return r.result?.value;
    };

    // React mount plus the first state push from the main process.
    await sleep(3500);

    const mounted = await evaluate('document.getElementById("root")?.childElementCount ?? 0');
    if (!mounted) {
      const body = await evaluate('document.body.innerText.slice(0, 400)');
      throw new Error(`renderer mounted nothing. Page said:\n${body}`);
    }

    for (const shot of group) {
      await evaluate(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(shot.theme)})`);
      await evaluate(`window.location.hash = '#/${shot.route}'`);
      // Let the view mount, its data settle, and entrance motion finish.
      await sleep(1800);
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(join(OUT, `${shot.id}.png`), Buffer.from(data, 'base64'));
      console.log(`captured ${shot.id}.png  (${shot.route}, ${shot.theme}${firstRun ? ', first run' : ''})`);
      captured += 1;
    }

    ws.close();
  } finally {
    // Electron spawns a process tree; on Windows killing the shell wrapper
    // leaves the app alive, which would then hold the single-instance lock.
    if (process.platform === 'win32' && child.pid) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    child.kill();
    await sleep(1200);
    try {
      rmSync(userData, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  return captured;
}

try {
  let total = 0;
  total += await captureGroup(shots.filter((s) => !s.firstRun), { firstRun: false });
  total += await captureGroup(shots.filter((s) => s.firstRun), { firstRun: true });
  console.log(`\n${total} screenshot(s) written to ${OUT}`);
  process.exit(0);
} catch (error) {
  console.error(`screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
