/**
 * The `ipcMain` side of `DeckApi`.
 *
 * One handler per entry in `INVOKE_CHANNELS`, registered from a map that is
 * typed `Record<InvokeChannel, …>` — adding a method to the contract without
 * implementing it here is a compile error, which is the whole point.
 *
 * Arguments arriving over IPC are treated as untrusted input even though the
 * renderer is ours: it is the one surface a compromised page could reach, so
 * every payload is narrowed before it touches a service. Errors are scrubbed on
 * the way back out so an upstream message can never carry a token into the
 * renderer's console.
 */

import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { normalize, relative, isAbsolute } from 'node:path';
import type { Settings, SwitchRequest, SwitchStrategy } from '@shared/types';
import { err } from '@shared/types';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type InvokeChannel } from '@shared/ipc';
import type { AddAccountOptions, AddTokenOptions, HistoryQuery } from '@shared/ipc';
import { scrubSecrets } from './notifications';
import type { AppServices } from './services';

export interface IpcDeps {
  services: AppServices;
  /** Parent for modal dialogs; null when the window is hidden or closed. */
  getWindow(): BrowserWindow | null;
}

type Handler = (args: readonly unknown[]) => Promise<unknown>;

/** Channels whose contract is `Result<T>`, so a failure is a value, not a throw. */
const RESULT_CHANNELS = new Set<InvokeChannel>([
  'refreshUsage',
  'addCurrentAccount',
  'addToken',
  'removeAccount',
  'setAlias',
  'setDisabled',
  'moveAccount',
  'startAutoSwitch',
  'stopAutoSwitch',
  'updateSettings',
  'mapDirectory',
  'unmapDirectory',
  'exportAccounts',
  'importAccounts',
]);

class IpcArgumentError extends Error {}

/**
 * Wire every channel and start broadcasting state. Returns a teardown function
 * that removes the handlers and unsubscribes — needed because a second
 * `ipcMain.handle` on the same channel throws.
 */
export function registerIpc(deps: IpcDeps): () => void {
  const { services } = deps;

  const handlers: Record<InvokeChannel, Handler> = {
    // --- state ------------------------------------------------------------
    getState: async () => services.getState(),

    refreshUsage: async ([slot]) => services.refreshUsage(optionalNumber(slot, 'slot')),

    // --- account lifecycle ------------------------------------------------
    addCurrentAccount: async ([opts]) => services.addCurrentAccount(addAccountOptions(opts)),

    addToken: async ([opts]) => {
      const record = requireRecord(opts, 'options');
      const options: AddTokenOptions = {
        ...addAccountOptions(record),
        token: requireString(record['token'], 'token'),
        email: optionalString(record['email'], 'email'),
      };
      return services.addToken(options);
    },

    removeAccount: async ([slot]) => services.removeAccount(requireNumber(slot, 'slot')),

    setAlias: async ([slot, alias]) =>
      services.setAlias(requireNumber(slot, 'slot'), nullableString(alias, 'alias')),

    setDisabled: async ([slot, disabled]) =>
      services.setDisabled(requireNumber(slot, 'slot'), requireBoolean(disabled, 'disabled')),

    moveAccount: async ([from, to]) =>
      services.moveAccount(requireNumber(from, 'from'), requireNumber(to, 'to')),

    // --- switching ---------------------------------------------------------
    switchAccount: async ([request]) => services.switchAccount(switchRequest(request)),

    previewSwitch: async ([request]) => services.previewSwitch(switchRequest(request)),

    // --- auto-switch -------------------------------------------------------
    startAutoSwitch: async () => services.startAutoSwitch(),
    stopAutoSwitch: async () => services.stopAutoSwitch(),

    // --- history + forecasting --------------------------------------------
    getHistory: async ([query]) => services.getHistory(historyQuery(query)),
    getForecasts: async ([slot]) => services.getForecasts(requireNumber(slot, 'slot')),

    // --- settings ----------------------------------------------------------
    getSettings: async () => services.getSettings(),

    updateSettings: async ([patch]) =>
      // `settings.ts` validates and clamps, so a shallow shape check is enough.
      services.updateSettings(requireRecord(patch, 'settings') as Partial<Settings>),

    mapDirectory: async ([path, slot]) =>
      services.mapDirectory(requireString(path, 'path'), requireNumber(slot, 'slot')),

    unmapDirectory: async ([path]) => services.unmapDirectory(requireString(path, 'path')),

    pickDirectory: async () => {
      const parent = deps.getWindow();
      const result = parent
        ? await dialog.showOpenDialog(parent, DIRECTORY_DIALOG)
        : await dialog.showOpenDialog(DIRECTORY_DIALOG);
      if (result.canceled) return null;
      return result.filePaths[0] ?? null;
    },

    // --- transfer ----------------------------------------------------------
    exportAccounts: async ([opts]) => {
      const record = isRecord(opts) ? opts : {};
      return services.exportAccounts({
        slot: optionalNumber(record['slot'], 'slot'),
        full: record['full'] === true,
      });
    },

    importAccounts: async ([payload, opts]) => {
      const record = isRecord(opts) ? opts : {};
      return services.importAccounts(requireString(payload, 'payload'), {
        force: record['force'] === true,
      });
    },

    // --- misc --------------------------------------------------------------
    openExternal: async ([url]) => {
      const target = requireString(url, 'url');
      // Only ever hand the OS a web link. `file:` would open a local document
      // and custom schemes can launch arbitrary registered handlers.
      if (!isWebUrl(target)) throw new IpcArgumentError('refusing to open a non-web URL');
      await shell.openExternal(target);
    },

    revealPath: async ([path]) => {
      const target = requireString(path, 'path');
      // The renderer may only reveal paths we told it about, not browse the disk.
      if (!isOwnedPath(services, target)) {
        throw new IpcArgumentError('refusing to reveal a path outside ClaudeDeck');
      }
      shell.showItemInFolder(normalize(target));
    },
  };

  for (const channel of INVOKE_CHANNELS) {
    const handler = handlers[channel];
    ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
      try {
        return await handler(args);
      } catch (cause) {
        const message = scrubSecrets(cause instanceof Error ? cause.message : String(cause));
        if (RESULT_CHANNELS.has(channel)) {
          return err(message, cause instanceof IpcArgumentError ? 'bad-request' : 'internal');
        }
        throw new Error(`${channel}: ${message}`);
      }
    });
  }

  const stopState = services.onStateChanged((state) => {
    broadcast(EVENT_CHANNELS.stateChanged, state);
  });
  const stopEvents = services.onAutoSwitchEvent((event) => {
    broadcast(EVENT_CHANNELS.autoSwitchEvent, event);
  });

  return () => {
    stopState();
    stopEvents();
    for (const channel of INVOKE_CHANNELS) ipcMain.removeHandler(channel);
  };
}

const DIRECTORY_DIALOG = {
  title: 'Choose a project directory',
  properties: ['openDirectory', 'createDirectory'],
} as const satisfies Electron.OpenDialogOptions;

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    if (window.webContents.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------------
// Argument narrowing
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) throw new IpcArgumentError(`${name} must be an object`);
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new IpcArgumentError(`${name} must be a number`);
  }
  return value;
}

function optionalNumber(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNumber(value, name);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new IpcArgumentError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, name);
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  return requireString(value, name);
}

function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new IpcArgumentError(`${name} must be a boolean`);
  return value;
}

function addAccountOptions(value: unknown): AddAccountOptions {
  const record = isRecord(value) ? value : {};
  return {
    slot: optionalNumber(record['slot'], 'slot'),
    alias: optionalString(record['alias'], 'alias'),
    force: record['force'] === true,
  };
}

const STRATEGIES: readonly SwitchStrategy[] = ['next', 'best', 'next-available', 'consume-first'];

function switchRequest(value: unknown): SwitchRequest {
  const record = isRecord(value) ? value : {};
  const target = record['target'];
  const strategy = record['strategy'];
  return {
    target: typeof target === 'string' || typeof target === 'number' ? target : undefined,
    strategy:
      typeof strategy === 'string' && (STRATEGIES as readonly string[]).includes(strategy)
        ? (strategy as SwitchStrategy)
        : undefined,
    dryRun: record['dryRun'] === true,
    force: record['force'] === true,
    // A switch arriving over IPC came from a click, whatever the caller claims.
    reason: 'manual',
  };
}

function historyQuery(value: unknown): HistoryQuery {
  const record = isRecord(value) ? value : {};
  return {
    slot: optionalNumber(record['slot'], 'slot'),
    since: optionalNumber(record['since'], 'since'),
    until: optionalNumber(record['until'], 'until'),
  };
}

function isWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:';
  } catch {
    return false;
  }
}

/** True when `target` is one of our files, or lives under one of our roots. */
function isOwnedPath(services: AppServices, target: string): boolean {
  const candidate = normalize(target);
  const { deckHome, configHome, globalConfig, credentials } = services.paths;
  if (candidate === normalize(globalConfig) || candidate === normalize(credentials)) return true;
  return [deckHome, configHome].some((root) => isInside(normalize(root), candidate));
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}
