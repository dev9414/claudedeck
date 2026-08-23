/**
 * ClaudeDeck's own preferences file (`<deckHome>/settings.json`).
 *
 * Everything the user can tune lives here. The file is hand-editable, so it is
 * read defensively: a missing, truncated or hostile value is clamped or
 * replaced rather than allowed to crash startup or poison the auto-switcher.
 * Keys this build does not recognise are carried through untouched, so an older
 * ClaudeDeck cannot silently delete a newer one's configuration.
 */

import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  AutoSwitchConfig,
  DirectoryMapping,
  NotificationConfig,
  Result,
  Settings,
  SwitchStrategy,
  ThemeMode,
} from '@shared/types';
import { err, ok } from '@shared/types';

export const SETTINGS_FILENAME = 'settings.json';

const THEMES: readonly ThemeMode[] = ['light', 'dark', 'system'];
const STRATEGIES: readonly SwitchStrategy[] = ['next', 'best', 'next-available', 'consume-first'];

/**
 * Inclusive bounds for every numeric setting. Exported because the renderer
 * builds its inputs from the same table — one definition, no drift.
 */
export const SETTING_BOUNDS = {
  threshold: { min: 1, max: 100 },
  pollIntervalSec: { min: 15, max: 6 * 60 * 60 },
  cooldownSec: { min: 0, max: 24 * 60 * 60 },
  hysteresisMargin: { min: 0, max: 50 },
  warnAtPct: { min: 1, max: 100 },
  historyRetentionDays: { min: 1, max: 730 },
} as const;

export type SettingBoundKey = keyof typeof SETTING_BOUNDS;

/** Auto-switch ships disabled: rotating someone's login is opt-in, always. */
export const DEFAULT_AUTOSWITCH: Readonly<AutoSwitchConfig> = Object.freeze({
  enabled: false,
  threshold: 85,
  pollIntervalSec: 300,
  cooldownSec: 900,
  hysteresisMargin: 5,
  strategy: 'best' as SwitchStrategy,
  models: [] as string[],
  includeApiKeyAccounts: false,
  dryRun: false,
});

export const DEFAULT_NOTIFICATIONS: Readonly<NotificationConfig> = Object.freeze({
  enabled: true,
  warnAtPct: 90,
  onSwitch: true,
  onQuarantine: true,
  onExhausted: true,
});

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  theme: 'system' as ThemeMode,
  autoswitch: DEFAULT_AUTOSWITCH as AutoSwitchConfig,
  notifications: DEFAULT_NOTIFICATIONS as NotificationConfig,
  minimizeToTray: true,
  launchAtLogin: false,
  historyRetentionDays: 30,
  safeMode: false,
  directoryMappings: [] as DirectoryMapping[],
});

/** Deep copy, so callers can never mutate the frozen defaults by reference. */
export function cloneSettings(settings: Settings): Settings {
  return {
    theme: settings.theme,
    autoswitch: { ...settings.autoswitch, models: [...settings.autoswitch.models] },
    notifications: { ...settings.notifications },
    minimizeToTray: settings.minimizeToTray,
    launchAtLogin: settings.launchAtLogin,
    historyRetentionDays: settings.historyRetentionDays,
    safeMode: settings.safeMode,
    directoryMappings: settings.directoryMappings.map((mapping) => ({ ...mapping })),
  };
}

export function defaultSettings(): Settings {
  return cloneSettings(DEFAULT_SETTINGS as Settings);
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function num(value: unknown, fallback: number, bound: SettingBoundKey): number {
  const raw = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(raw)) return fallback;
  const bounds = SETTING_BOUNDS[bound];
  return clamp(Math.round(raw), bounds.min, bounds.max);
}

function bool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  // Hand-edited JSON and shell exports both tend to produce string flags.
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const trimmed = entry.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Directory mappings are keyed case-insensitively with trailing separators
 * stripped: Windows and macOS both hand us the same folder spelled several ways
 * depending on whether it arrived from a picker, a shell, or a symlink.
 */
export function normalizeMappingKey(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '');
  return (trimmed || path.trim()).toLowerCase();
}

function mappings(value: unknown): DirectoryMapping[] {
  if (!Array.isArray(value)) return [];
  // Later entries win, so re-mapping a directory replaces its earlier binding.
  const byPath = new Map<string, DirectoryMapping>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = typeof entry['path'] === 'string' ? entry['path'].trim() : '';
    const slotRaw = entry['slot'];
    const slot = typeof slotRaw === 'number' ? Math.trunc(slotRaw) : NaN;
    if (!path || !Number.isFinite(slot) || slot < 1) continue;
    byPath.set(normalizeMappingKey(path), { path, slot });
  }
  return [...byPath.values()];
}

/** Keys we own at each level; anything else is forward-compatible payload. */
const KNOWN_TOP = new Set(Object.keys(DEFAULT_SETTINGS));
const KNOWN_AUTOSWITCH = new Set(Object.keys(DEFAULT_AUTOSWITCH));
const KNOWN_NOTIFICATIONS = new Set(Object.keys(DEFAULT_NOTIFICATIONS));

function extrasOf(raw: unknown, known: Set<string>): Record<string, unknown> {
  if (!isRecord(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) out[key] = value;
  }
  return out;
}

/** Unrecognised keys, captured per level so a round-trip loses nothing. */
export interface SettingsExtras {
  top: Record<string, unknown>;
  autoswitch: Record<string, unknown>;
  notifications: Record<string, unknown>;
}

export interface NormalizedSettings {
  settings: Settings;
  extras: SettingsExtras;
}

export function emptyExtras(): SettingsExtras {
  return { top: {}, autoswitch: {}, notifications: {} };
}

/** Turn arbitrary parsed JSON into a valid `Settings`, keeping what we cannot type. */
export function normalizeSettings(raw: unknown): NormalizedSettings {
  const base = defaultSettings();
  if (!isRecord(raw)) return { settings: base, extras: emptyExtras() };

  const rawAuto = isRecord(raw['autoswitch']) ? raw['autoswitch'] : {};
  const rawNotify = isRecord(raw['notifications']) ? raw['notifications'] : {};

  const autoswitch: AutoSwitchConfig = {
    enabled: bool(rawAuto['enabled'], base.autoswitch.enabled),
    threshold: num(rawAuto['threshold'], base.autoswitch.threshold, 'threshold'),
    pollIntervalSec: num(rawAuto['pollIntervalSec'], base.autoswitch.pollIntervalSec, 'pollIntervalSec'),
    cooldownSec: num(rawAuto['cooldownSec'], base.autoswitch.cooldownSec, 'cooldownSec'),
    hysteresisMargin: num(rawAuto['hysteresisMargin'], base.autoswitch.hysteresisMargin, 'hysteresisMargin'),
    strategy: oneOf(rawAuto['strategy'], STRATEGIES, base.autoswitch.strategy),
    models: strings(rawAuto['models']),
    includeApiKeyAccounts: bool(rawAuto['includeApiKeyAccounts'], base.autoswitch.includeApiKeyAccounts),
    dryRun: bool(rawAuto['dryRun'], base.autoswitch.dryRun),
  };

  const notifications: NotificationConfig = {
    enabled: bool(rawNotify['enabled'], base.notifications.enabled),
    warnAtPct: num(rawNotify['warnAtPct'], base.notifications.warnAtPct, 'warnAtPct'),
    onSwitch: bool(rawNotify['onSwitch'], base.notifications.onSwitch),
    onQuarantine: bool(rawNotify['onQuarantine'], base.notifications.onQuarantine),
    onExhausted: bool(rawNotify['onExhausted'], base.notifications.onExhausted),
  };

  const settings: Settings = {
    theme: oneOf(raw['theme'], THEMES, base.theme),
    autoswitch,
    notifications,
    minimizeToTray: bool(raw['minimizeToTray'], base.minimizeToTray),
    launchAtLogin: bool(raw['launchAtLogin'], base.launchAtLogin),
    historyRetentionDays: num(raw['historyRetentionDays'], base.historyRetentionDays, 'historyRetentionDays'),
    safeMode: bool(raw['safeMode'], base.safeMode),
    directoryMappings: mappings(raw['directoryMappings']),
  };

  return {
    settings,
    extras: {
      top: extrasOf(raw, KNOWN_TOP),
      autoswitch: extrasOf(rawAuto, KNOWN_AUTOSWITCH),
      notifications: extrasOf(rawNotify, KNOWN_NOTIFICATIONS),
    },
  };
}

/**
 * Overlay a patch on the current settings.
 *
 * `Partial<Settings>` types the nested objects as whole values, but the
 * renderer legitimately sends fragments (one toggle at a time), so nested
 * records are merged rather than replaced. The result is deliberately `unknown`
 * — it is only ever fed straight back through `normalizeSettings`.
 */
export function mergeSettings(current: Settings, patch: Partial<Settings>): unknown {
  const incoming = patch as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    if (key === 'autoswitch' && isRecord(value)) {
      merged['autoswitch'] = { ...current.autoswitch, ...value };
    } else if (key === 'notifications' && isRecord(value)) {
      merged['notifications'] = { ...current.notifications, ...value };
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export interface SettingsFileDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export function defaultSettingsFileDeps(): SettingsFileDeps {
  return {
    readFile: (path) => fs.readFile(path, 'utf8'),
    writeFile: (path, data) => fs.writeFile(path, data, { encoding: 'utf8', mode: 0o600 }),
    rename: (from, to) => fs.rename(from, to),
    mkdir: async (path) => {
      await fs.mkdir(path, { recursive: true });
    },
  };
}

export interface SettingsStore {
  readonly file: string;
  /** Last loaded/saved value; a fresh copy every call, never a live reference. */
  get(): Settings;
  load(): Promise<Settings>;
  update(patch: Partial<Settings>): Promise<Result<Settings>>;
  onChange(listener: (settings: Settings) => void): () => void;
}

export function createSettingsStore(
  deckHome: string,
  deps: SettingsFileDeps = defaultSettingsFileDeps(),
): SettingsStore {
  const file = join(deckHome, SETTINGS_FILENAME);
  let current = defaultSettings();
  let extras = emptyExtras();
  const listeners = new Set<(settings: Settings) => void>();

  function emit(): void {
    const snapshot = cloneSettings(current);
    for (const listener of listeners) listener(snapshot);
  }

  async function persist(): Promise<Result<Settings>> {
    // Unknown keys go first so our validated values win any collision, while
    // genuinely foreign keys survive the round-trip.
    const payload = {
      ...extras.top,
      ...cloneSettings(current),
      autoswitch: { ...extras.autoswitch, ...current.autoswitch },
      notifications: { ...extras.notifications, ...current.notifications },
    };
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await deps.mkdir(dirname(file));
      await deps.writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      await deps.rename(tmp, file);
      return ok(cloneSettings(current));
    } catch (cause) {
      return err(`could not write ${file}: ${describe(cause)}`, 'settings-write-failed');
    }
  }

  return {
    file,

    get: () => cloneSettings(current),

    async load() {
      try {
        const text = await deps.readFile(file);
        const parsed: unknown = JSON.parse(text);
        const normalized = normalizeSettings(parsed);
        current = normalized.settings;
        extras = normalized.extras;
      } catch {
        // A missing file is simply the first run, and a corrupt one must not
        // brick the app; either way, fall back to defaults and rewrite on the
        // next change rather than clobbering a file we failed to understand.
        current = defaultSettings();
        extras = emptyExtras();
      }
      emit();
      return cloneSettings(current);
    },

    async update(patch) {
      const previous = current;
      current = normalizeSettings(mergeSettings(current, patch)).settings;
      const saved = await persist();
      if (!saved.ok) {
        current = previous;
        return saved;
      }
      emit();
      return saved;
    },

    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
