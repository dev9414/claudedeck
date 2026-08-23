/**
 * The main BrowserWindow: creation, hardening, and remembered geometry.
 *
 * The renderer is treated as untrusted. It runs sandboxed, with context
 * isolation on and Node integration off, and it may not open windows or
 * navigate anywhere outside the bundled app — links go to the system browser
 * through `ipc.ts` instead.
 *
 * Geometry lives beside the rest of our data in `<deckHome>/window.json` rather
 * than in `settings.json`, because it is machine state, not a preference, and
 * syncing it between machines would be actively annoying.
 */

import { promises as fs, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { BrowserWindow, screen, shell } from 'electron';
import type { AppServices } from './services';

export const WINDOW_STATE_FILENAME = 'window.json';

const DEFAULT_BOUNDS = { width: 1140, height: 780 } as const;
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;
/** Coalesce the storm of resize events a drag produces into one write. */
const PERSIST_DEBOUNCE_MS = 400;

interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface WindowDeps {
  /** True once the app has committed to quitting, so `close` must not be vetoed. */
  isQuitting(): boolean;
}

export interface WindowController {
  /** The live window, creating it if it does not exist yet. */
  ensure(): BrowserWindow;
  /** Bring the window to the front, restoring and un-hiding as needed. */
  show(): void;
  /** Show if hidden or in the background, hide if already focused. */
  toggle(): void;
  current(): BrowserWindow | null;
  destroy(): void;
}

// The main bundle is CommonJS (Electron's loader cannot bridge the CJS
// `electron` builtin from an ES module), so `__dirname` is the bundle dir.
const here = __dirname;
/** Sandboxed preloads cannot be ES modules, so the bundle emits `.cjs`. */
const PRELOAD = join(here, '../preload/index.cjs');
const RENDERER_HTML = join(here, '../renderer/index.html');

export function createWindowController(
  services: AppServices,
  deps: WindowDeps,
): WindowController {
  const stateFile = join(services.paths.deckHome, WINDOW_STATE_FILENAME);
  let window: BrowserWindow | null = null;
  let persistTimer: NodeJS.Timeout | null = null;
  // Read synchronously: `ensure()` is typically called in the same tick as this
  // factory, and an async read would lose the race and open at default size on
  // every launch. One small file at startup is not worth the bug.
  let restored: WindowState = readState(stateFile) ?? { ...DEFAULT_BOUNDS, maximized: false };

  function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  async function persist(): Promise<void> {
    const win = window;
    if (!win || win.isDestroyed()) return;
    const maximized = win.isMaximized();
    // `getNormalBounds` reports the pre-maximize rectangle, which is the one
    // worth restoring to when the user un-maximizes later.
    const bounds = win.getNormalBounds();
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: Math.max(MIN_WIDTH, bounds.width),
      height: Math.max(MIN_HEIGHT, bounds.height),
      maximized,
    };
    restored = state;
    try {
      await fs.mkdir(dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    } catch {
      // Losing window geometry is not worth surfacing to the user.
    }
  }

  function create(): BrowserWindow {
    const bounds = fitToVisibleDisplay(restored);

    const win = new BrowserWindow({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      // Painting only once the renderer has content avoids the white flash.
      show: false,
      backgroundColor: '#0b0d10',
      autoHideMenuBar: true,
      title: services.demoMode ? 'ClaudeDeck (demo)' : 'ClaudeDeck',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: false,
      },
    });

    if (restored.maximized) win.maximize();

    win.once('ready-to-show', () => win.show());

    win.on('resize', schedulePersist);
    win.on('move', schedulePersist);
    win.on('maximize', schedulePersist);
    win.on('unmaximize', schedulePersist);

    win.on('close', (event) => {
      if (deps.isQuitting()) return;
      if (!services.currentSettings().minimizeToTray) return;
      // Keep the process (and the tray) alive; the window is only a view.
      event.preventDefault();
      void persist();
      win.hide();
    });

    win.on('closed', () => {
      window = null;
    });

    // The renderer never opens a window of its own; anything that tries is a
    // link, and links belong in the user's browser.
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (isExternalUrl(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, url) => {
      if (url === win.webContents.getURL()) return;
      event.preventDefault();
      if (isExternalUrl(url)) void shell.openExternal(url);
    });

    void load(win);
    return win;
  }

  return {
    ensure() {
      if (!window || window.isDestroyed()) window = create();
      return window;
    },

    show() {
      const win = this.ensure();
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    },

    toggle() {
      const win = window;
      if (!win || win.isDestroyed()) {
        this.show();
        return;
      }
      if (win.isVisible() && win.isFocused()) {
        win.hide();
        return;
      }
      this.show();
    },

    current: () => window,

    destroy() {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      const win = window;
      window = null;
      if (win && !win.isDestroyed()) win.destroy();
    },
  };
}

async function load(win: BrowserWindow): Promise<void> {
  // electron-vite serves the renderer over HTTP in dev and bundles it in prod.
  const devServer = process.env['ELECTRON_RENDERER_URL'];
  if (devServer) {
    await win.loadURL(devServer);
    return;
  }
  await win.loadFile(RENDERER_HTML);
}

function readState(file: string): WindowState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const raw = parsed as Record<string, unknown>;
    const width = numberOr(raw['width'], DEFAULT_BOUNDS.width);
    const height = numberOr(raw['height'], DEFAULT_BOUNDS.height);
    return {
      x: typeof raw['x'] === 'number' ? raw['x'] : undefined,
      y: typeof raw['y'] === 'number' ? raw['y'] : undefined,
      width: Math.max(MIN_WIDTH, width),
      height: Math.max(MIN_HEIGHT, height),
      maximized: raw['maximized'] === true,
    };
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A remembered position can point at a monitor that no longer exists — the
 * classic "my window opened off-screen after I undocked" bug. Drop the
 * coordinates unless they still land inside a work area.
 */
function fitToVisibleDisplay(state: WindowState): WindowState {
  const { x, y } = state;
  if (x === undefined || y === undefined) return state;
  // A slack of a few dozen pixels tolerates the title bar sitting just above a
  // work area, which is normal on Windows with a hidden taskbar.
  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const withinX = x >= workArea.x - 40 && x < workArea.x + workArea.width - 80;
    const withinY = y >= workArea.y - 40 && y < workArea.y + workArea.height - 40;
    return withinX && withinY;
  });
  if (visible) return state;
  return { width: state.width, height: state.height, maximized: state.maximized };
}

function isExternalUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}
