/**
 * The system tray: a real one, on Windows, macOS and Linux alike.
 *
 * The icon is drawn here rather than shipped as a binary asset, for two
 * reasons. It has to encode live data — the active account's remaining
 * headroom, as both an arc length and a colour — and a generated data URL keeps
 * `electron-builder` from needing a per-platform icon matrix just to show a
 * ring. The renderer is a 4x supersampled rasteriser feeding a hand-rolled PNG
 * encoder; `node:zlib` does the only heavy lifting.
 *
 * Colour alone is never the message: the tooltip states the same number in
 * words, which is also what a screen reader gets.
 */

import { deflateSync } from 'node:zlib';
import { Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron';
import type { Account, DeckState } from '@shared/types';
import type { AppServices } from './services';

export interface TrayDeps {
  services: AppServices;
  showWindow(): void;
  quit(): void;
}

export interface TrayController {
  /** Redraw icon, tooltip and menu from the given state. */
  refresh(state: DeckState): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const HEADROOM_COLORS: readonly { min: number; color: Rgb }[] = [
  { min: 50, color: { r: 0x35, g: 0xc4, b: 0x6a } },
  { min: 25, color: { r: 0xf2, g: 0xb5, b: 0x3c } },
  { min: 10, color: { r: 0xf2, g: 0x8b, b: 0x3c } },
  { min: 0, color: { r: 0xe5, g: 0x47, b: 0x4d } },
];

const UNKNOWN_COLOR: Rgb = { r: 0x8b, g: 0x93, b: 0xa1 };

/** Green while there is room, red as it runs out. Exported for the tests. */
export function headroomColor(remaining: number | null): Rgb {
  if (remaining === null || !Number.isFinite(remaining)) return UNKNOWN_COLOR;
  for (const band of HEADROOM_COLORS) {
    if (remaining >= band.min) return band.color;
  }
  return UNKNOWN_COLOR;
}

// ---------------------------------------------------------------------------
// Icon rendering
// ---------------------------------------------------------------------------

const SUPERSAMPLE = 4;

export interface RingOptions {
  /** Logical pixel size of the square icon. */
  size: number;
  /** 0-1 fraction of the ring to fill, clockwise from 12 o'clock. */
  fill: number;
  color: Rgb;
}

/**
 * Rasterise the ring into RGBA and wrap it as a `data:image/png;base64,` URL.
 *
 * Supersampling is what makes a 16px ring legible: each output pixel averages
 * SUPERSAMPLE^2 coverage samples, which is cheap antialiasing without pulling
 * in a canvas.
 */
export function renderRingDataUrl(options: RingOptions): string {
  const { size, color } = options;
  const fill = Math.max(0, Math.min(1, options.fill));
  const pixels = Buffer.alloc(size * size * 4);

  const n = size * SUPERSAMPLE;
  const center = (n - 1) / 2;
  const outer = n * 0.46;
  const inner = n * 0.29;
  const sweep = fill * Math.PI * 2;
  const samples = SUPERSAMPLE * SUPERSAMPLE;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let litCoverage = 0;
      let trackCoverage = 0;

      for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
        for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
          const px = x * SUPERSAMPLE + sx;
          const py = y * SUPERSAMPLE + sy;
          const dx = px - center;
          const dy = py - center;
          const distance = Math.hypot(dx, dy);
          if (distance < inner || distance > outer) continue;
          // atan2(dx, -dy) puts zero at 12 o'clock and grows clockwise, which
          // is how a progress ring reads.
          let angle = Math.atan2(dx, -dy);
          if (angle < 0) angle += Math.PI * 2;
          if (angle <= sweep) litCoverage += 1;
          else trackCoverage += 1;
        }
      }

      if (litCoverage === 0 && trackCoverage === 0) continue;
      // The unfilled remainder stays visible as a dim track, so an almost-empty
      // ring still reads as a ring rather than as a stray dot.
      const alpha = (litCoverage * 255 + trackCoverage * 64) / samples;
      const offset = (y * size + x) * 4;
      pixels[offset] = color.r;
      pixels[offset + 1] = color.g;
      pixels[offset + 2] = color.b;
      pixels[offset + 3] = Math.round(Math.min(255, alpha));
    }
  }

  return `data:image/png;base64,${encodePng(size, size, pixels).toString('base64')}`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, body: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length, 0);
  const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

/** Minimal 8-bit RGBA PNG. No interlacing, one filter-none scanline per row. */
function encodePng(width: number, height: number, rgba: Buffer): Buffer {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function label(account: Account): string {
  return account.alias ?? account.email;
}

interface Reading {
  /** Percent of the binding window consumed, or null when unknown. */
  used: number | null;
  remaining: number | null;
  window: string;
  note: string;
}

function readingFor(services: AppServices, account: Account): Reading {
  if (account.quarantinedAt) {
    return { used: null, remaining: null, window: '', note: 'quarantined' };
  }
  if (account.kind === 'api-key' || account.usageStatus === 'no-quota') {
    return { used: null, remaining: null, window: '', note: 'API key — no quota' };
  }
  const usage = account.usage ?? account.lastGoodUsage;
  if (!usage) {
    return { used: null, remaining: null, window: '', note: statusNote(account) };
  }
  const headroom = services.headroomFor(account);
  // Null means "never polled", which must not be rendered as either full or
  // empty — an unknown account is still a valid switch target.
  if (!headroom) return { used: null, remaining: null, window: '', note: statusNote(account) };
  const used = Math.round(100 - headroom.remaining);
  return {
    used,
    remaining: headroom.remaining,
    window: headroom.bindingWindow,
    note: `${used}% used (${headroom.bindingWindow})`,
  };
}

function statusNote(account: Account): string {
  switch (account.usageStatus) {
    case 'token-expired':
      return 'sign-in expired';
    case 'rate-limited':
      return 'rate limited';
    case 'unavailable':
      return 'usage unavailable';
    default:
      return 'no data yet';
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/** macOS menu bars are short; Windows and Linux trays are not. */
function iconSize(): number {
  return process.platform === 'darwin' ? 18 : 20;
}

export function createTray(deps: TrayDeps): TrayController {
  const { services } = deps;
  const tray = new Tray(imageFor(null));
  let disposed = false;

  // On Windows and Linux the primary click is expected to open the app; on
  // macOS it opens the menu, which is the platform convention there.
  if (process.platform !== 'darwin') {
    tray.on('click', () => deps.showWindow());
  }
  tray.on('double-click', () => deps.showWindow());

  function imageFor(remaining: number | null): Electron.NativeImage {
    const size = iconSize();
    const fill = remaining === null ? 1 : Math.max(0.04, remaining / 100);
    const url = renderRingDataUrl({ size, fill, color: headroomColor(remaining) });
    const image = nativeImage.createFromDataURL(url);
    // Not a template image: the whole point is that the colour carries meaning.
    image.setTemplateImage(false);
    return image;
  }

  function refresh(state: DeckState): void {
    if (disposed) return;

    const active = state.accounts.find((account) => account.slot === state.activeSlot);
    const activeReading = active ? readingFor(services, active) : null;

    tray.setImage(imageFor(activeReading?.remaining ?? null));
    tray.setToolTip(tooltipFor(state, active, activeReading));
    tray.setContextMenu(Menu.buildFromTemplate(template(state)));
  }

  function tooltipFor(
    state: DeckState,
    active: Account | undefined,
    reading: Reading | null,
  ): string {
    const prefix = state.demoMode ? 'ClaudeDeck (demo)' : 'ClaudeDeck';
    if (!active || !reading) return `${prefix} — no active account`;
    const headline =
      reading.remaining === null
        ? `${label(active)}: ${reading.note}`
        : `${label(active)}: ${Math.round(reading.remaining)}% left on ${reading.window}`;
    const engine = state.autoSwitchRunning ? 'auto-switch on' : 'auto-switch off';
    return `${prefix} — ${headline} · ${engine}`;
  }

  function template(state: DeckState): MenuItemConstructorOptions[] {
    const items: MenuItemConstructorOptions[] = [];

    if (state.demoMode) {
      items.push({ label: 'DEMO MODE — synthetic data', enabled: false });
      items.push({ type: 'separator' });
    }

    if (state.accounts.length === 0) {
      items.push({ label: 'No accounts yet', enabled: false });
    } else {
      items.push({ label: 'Accounts', enabled: false });
      for (const account of state.accounts) {
        const reading = readingFor(services, account);
        const suffix = account.disabled ? ' · off' : '';
        items.push({
          label: `${account.slot}  ${label(account)} — ${reading.note}${suffix}`,
          type: 'checkbox',
          checked: account.active,
          // Re-activating the current account is a no-op we would rather not
          // perform, but every other slot is a legal explicit target.
          enabled: !account.active,
          click: () => {
            void services.switchAccount({ target: account.slot, reason: 'manual' });
          },
        });
      }
    }

    const switchable = state.accounts.length > 1;
    items.push({ type: 'separator' });
    items.push({
      label: 'Rotate to next account',
      enabled: switchable,
      click: () => {
        void services.switchAccount({ strategy: 'next', reason: 'manual' });
      },
    });
    items.push({
      label: 'Switch to most headroom',
      enabled: switchable,
      click: () => {
        void services.switchAccount({ strategy: 'best', reason: 'manual' });
      },
    });
    items.push({
      label: 'Switch to next available',
      enabled: switchable,
      click: () => {
        void services.switchAccount({ strategy: 'next-available', reason: 'manual' });
      },
    });

    items.push({ type: 'separator' });
    items.push({
      label: state.autoSwitchRunning ? 'Auto-switch is running' : 'Start auto-switch',
      type: 'checkbox',
      checked: state.autoSwitchRunning,
      enabled: switchable,
      click: () => {
        void (state.autoSwitchRunning ? services.stopAutoSwitch() : services.startAutoSwitch());
      },
    });

    items.push({ type: 'separator' });
    items.push({ label: 'Open ClaudeDeck', click: () => deps.showWindow() });
    items.push({ label: 'Quit ClaudeDeck', click: () => deps.quit() });

    return items;
  }

  refresh(services.currentState());

  return {
    refresh,
    destroy() {
      disposed = true;
      tray.destroy();
    },
  };
}
