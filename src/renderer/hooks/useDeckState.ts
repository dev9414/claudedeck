/**
 * The renderer's single subscription to `DeckState`.
 *
 * Seeds from `getState()`, then follows `onStateChanged`. Every view calls this
 * hook directly instead of taking state through props — the bridge is the store.
 *
 * When the preload bridge is missing (a plain browser tab during UI work) the
 * hook falls back to a clearly-marked in-memory stub: `stubbed` is true, the
 * state reports `demoMode`, and the version string says so, so nobody mistakes
 * fixture numbers for a real account.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AddAccountOptions, AddTokenOptions, DeckApi, HistoryQuery } from '@shared/ipc';
import type {
  Account,
  DeckState,
  DirectoryMapping,
  Forecast,
  HistoryPoint,
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageSnapshot,
  UsageWindow,
} from '@shared/types';
import { err, ok } from '@shared/types';

const NO_BRIDGE = 'No main-process bridge: ClaudeDeck is showing stub data.';
const HOUR = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Stub fixtures
// ---------------------------------------------------------------------------

function stubSettings(): Settings {
  return {
    theme: 'system',
    autoswitch: {
      enabled: false,
      threshold: 85,
      pollIntervalSec: 120,
      cooldownSec: 300,
      hysteresisMargin: 10,
      strategy: 'best',
      models: [],
      includeApiKeyAccounts: false,
      dryRun: false,
    },
    notifications: {
      enabled: true,
      warnAtPct: 80,
      onSwitch: true,
      onQuarantine: true,
      onExhausted: true,
    },
    minimizeToTray: true,
    launchAtLogin: false,
    historyRetentionDays: 30,
    safeMode: false,
    directoryMappings: [],
  };
}

function stubWindow(key: string, label: string, pct: number, resetsInHours: number, now: number): UsageWindow {
  return {
    key,
    label,
    pct,
    resetsAt: new Date(now + resetsInHours * HOUR).toISOString(),
  };
}

function stubUsage(now: number, fiveHour: number, sevenDay: number, opus: number): UsageSnapshot {
  return {
    fiveHour: stubWindow('5h', '5-hour', fiveHour, 2.5, now),
    sevenDay: stubWindow('7d', '7-day', sevenDay, 61, now),
    scoped: [stubWindow('Fable', 'Fable weekly', opus, 61, now)],
    fetchedAt: now,
  };
}

function stubState(now: number): DeckState {
  const accounts: Account[] = [
    {
      slot: 1,
      email: 'ada@stub.invalid',
      alias: 'primary',
      kind: 'oauth',
      active: true,
      disabled: false,
      identity: { emailAddress: 'ada@stub.invalid', organizationName: 'Stub Fixtures' },
      usage: stubUsage(now, 62, 41, 18),
      usageStatus: 'ok',
      tokenExpiresAt: now + 6 * HOUR,
      addedAt: now - 40 * 24 * HOUR,
    },
    {
      slot: 2,
      email: 'grace@stub.invalid',
      alias: 'backup',
      kind: 'oauth',
      active: false,
      disabled: false,
      identity: { emailAddress: 'grace@stub.invalid', organizationName: 'Stub Fixtures' },
      usage: stubUsage(now, 12, 27, 4),
      usageStatus: 'ok',
      tokenExpiresAt: now + 3 * HOUR,
      addedAt: now - 21 * 24 * HOUR,
    },
    {
      slot: 3,
      email: 'ci@stub.invalid',
      kind: 'api-key',
      active: false,
      disabled: true,
      usageStatus: 'no-quota',
      addedAt: now - 5 * 24 * HOUR,
    },
  ];

  return {
    accounts,
    activeSlot: 1,
    settings: stubSettings(),
    paths: {
      configHome: '(stub)/.claude',
      globalConfig: '(stub)/.claude.json',
      credentials: '(stub)/.claude/.credentials.json',
      deckHome: '(stub)/.claudedeck',
    },
    platform: 'windows',
    onboarded: true,
    autoSwitchRunning: false,
    lastEvents: [
      { kind: 'poll', ts: now - 4 * 60 * 1000, message: 'Polled 2 accounts (stub).' },
      { kind: 'no-switch', ts: now - 4 * 60 * 1000, message: 'Slot 1 still has the most headroom.', slot: 1 },
    ],
    demoMode: true,
    version: '0.0.0-no-bridge',
  };
}

// ---------------------------------------------------------------------------
// Stub bridge
// ---------------------------------------------------------------------------

function maxPct(account: Account): number {
  const usage = account.usage ?? account.lastGoodUsage;
  if (!usage) return 0;
  const values = [usage.fiveHour?.pct ?? 0, usage.sevenDay?.pct ?? 0, ...usage.scoped.map((w) => w.pct)];
  return values.reduce((a, b) => Math.max(a, b), 0);
}

function matchAccount(accounts: Account[], target: string | number): Account | undefined {
  const raw = String(target).trim();
  const slot = Number(raw);
  if (raw !== '' && Number.isInteger(slot)) return accounts.find((a) => a.slot === slot);
  const needle = raw.toLowerCase();
  return accounts.find((a) => a.email.toLowerCase() === needle || a.alias?.toLowerCase() === needle);
}

function pickTarget(state: DeckState, req: SwitchRequest): Account | undefined {
  if (req.target !== undefined) return matchAccount(state.accounts, req.target);
  const eligible = state.accounts.filter((a) => !a.disabled && !a.quarantinedAt && a.kind !== 'api-key');
  if (eligible.length === 0) return undefined;
  if (req.strategy === 'best') {
    return eligible.reduce<Account | undefined>((best, a) => (!best || maxPct(a) < maxPct(best) ? a : best), undefined);
  }
  const activeAt = eligible.findIndex((a) => a.active);
  if (req.strategy === 'next-available') {
    const rotated = [...eligible.slice(activeAt + 1), ...eligible.slice(0, Math.max(activeAt, 0))];
    return rotated.find((a) => maxPct(a) < 100) ?? rotated[0];
  }
  return eligible[(activeAt + 1) % eligible.length];
}

/**
 * A working, in-memory `DeckApi`. Mutations that only move UI state (switch,
 * alias, disable, settings) are honoured so the shell is explorable; anything
 * that would touch a real Claude Code install returns an error instead.
 */
function createStubApi(): DeckApi {
  let state = stubState(Date.now());
  const listeners = new Set<(next: DeckState) => void>();

  const commit = (next: DeckState): DeckState => {
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  };

  const patchAccount = (slot: number, patch: Partial<Account>): Account | undefined => {
    const accounts = state.accounts.map((a) => (a.slot === slot ? { ...a, ...patch } : a));
    const next = accounts.find((a) => a.slot === slot);
    if (!next) return undefined;
    commit({ ...state, accounts });
    return next;
  };

  // Self-referential so `previewSwitch` can reuse `switchAccount`.
  const api: DeckApi = {
    getState: async () => state,

    refreshUsage: async (slot?: number) => {
      const now = Date.now();
      const accounts = state.accounts.map((account) => {
        if (slot !== undefined && account.slot !== slot) return account;
        if (!account.usage) return account;
        const bump = (pct: number, step: number) => Math.min(100, Math.round((pct + step) * 10) / 10);
        const usage: UsageSnapshot = {
          ...account.usage,
          fiveHour: account.usage.fiveHour
            ? { ...account.usage.fiveHour, pct: bump(account.usage.fiveHour.pct, 1.4) }
            : undefined,
          sevenDay: account.usage.sevenDay
            ? { ...account.usage.sevenDay, pct: bump(account.usage.sevenDay.pct, 0.3) }
            : undefined,
          scoped: account.usage.scoped.map((w) => ({ ...w, pct: bump(w.pct, 0.6) })),
          fetchedAt: now,
        };
        return { ...account, usage, lastGoodUsage: usage };
      });
      commit({ ...state, accounts });
      return ok(accounts);
    },

    addCurrentAccount: async (_opts?: AddAccountOptions) => err(NO_BRIDGE, 'no-bridge'),
    addToken: async (_opts: AddTokenOptions) => err(NO_BRIDGE, 'no-bridge'),

    removeAccount: async (slot: number) => {
      if (!state.accounts.some((a) => a.slot === slot)) return err(`No account in slot ${slot}.`, 'not-found');
      const accounts = state.accounts.filter((a) => a.slot !== slot);
      commit({
        ...state,
        accounts,
        activeSlot: state.activeSlot === slot ? (accounts[0]?.slot ?? null) : state.activeSlot,
      });
      return ok(undefined);
    },

    setAlias: async (slot: number, alias: string | null) => {
      const next = patchAccount(slot, { alias: alias ?? undefined });
      return next ? ok(next) : err(`No account in slot ${slot}.`, 'not-found');
    },

    setDisabled: async (slot: number, disabled: boolean) => {
      const next = patchAccount(slot, { disabled });
      return next ? ok(next) : err(`No account in slot ${slot}.`, 'not-found');
    },

    moveAccount: async (from: number, to: number) => {
      const source = state.accounts.find((a) => a.slot === from);
      if (!source) return err(`No account in slot ${from}.`, 'not-found');
      const rest = state.accounts.filter((a) => a.slot !== from);
      const at = Math.max(0, Math.min(rest.length, to - 1));
      const ordered = [...rest.slice(0, at), source, ...rest.slice(at)];
      const accounts = ordered.map((a, i) => ({ ...a, slot: i + 1 }));
      commit({ ...state, accounts, activeSlot: accounts.find((a) => a.active)?.slot ?? null });
      return ok(accounts);
    },

    switchAccount: async (req: SwitchRequest) => {
      const previous = state.accounts.find((a) => a.active);
      const target = pickTarget(state, req);
      if (!target) {
        return { switched: false, reason: 'No eligible account.', dryRun: req.dryRun === true, error: 'not-found' };
      }
      if (target.active && req.force !== true) {
        return {
          switched: false,
          to: { slot: target.slot, email: target.email },
          reason: 'Already active.',
          dryRun: req.dryRun === true,
        };
      }
      const result: SwitchResult = {
        switched: req.dryRun !== true,
        from: previous ? { slot: previous.slot, email: previous.email } : undefined,
        to: { slot: target.slot, email: target.email },
        reason: req.reason ?? 'manual',
        dryRun: req.dryRun === true,
        plannedWrites: ['(stub) .credentials.json', '(stub) .claude.json'],
      };
      if (req.dryRun !== true) {
        commit({
          ...state,
          accounts: state.accounts.map((a) => ({ ...a, active: a.slot === target.slot })),
          activeSlot: target.slot,
        });
      }
      return result;
    },

    previewSwitch: async (req: SwitchRequest) => api.switchAccount({ ...req, dryRun: true }),

    startAutoSwitch: async () => {
      commit({ ...state, autoSwitchRunning: true });
      return ok(undefined);
    },

    stopAutoSwitch: async () => {
      commit({ ...state, autoSwitchRunning: false });
      return ok(undefined);
    },

    getHistory: async (query: HistoryQuery) => {
      const now = Date.now();
      const since = query.since ?? now - 24 * HOUR;
      const until = query.until ?? now;
      const step = Math.max(HOUR / 4, (until - since) / 48);
      const slots = state.accounts
        .filter((a) => (query.slot === undefined ? a.usage !== undefined : a.slot === query.slot))
        .map((a) => a.slot);
      const points: HistoryPoint[] = [];
      for (const slot of slots) {
        // A deterministic saw wave: enough shape to lay out a chart, obviously
        // synthetic to anyone reading the numbers.
        for (let t = since, i = 0; t <= until; t += step, i += 1) {
          const phase = (i + slot * 7) % 24;
          points.push({
            t: Math.round(t),
            slot,
            windows: {
              '5h': Math.round(phase * 4.1 * 10) / 10,
              '7d': Math.round((10 + i * 0.6 + slot * 3) * 10) / 10,
            },
          });
        }
      }
      return points.sort((a, b) => a.t - b.t);
    },

    getForecasts: async (slot: number) => {
      const account = state.accounts.find((a) => a.slot === slot);
      const usage = account?.usage;
      if (!usage) return [];
      const windows = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter(
        (w): w is UsageWindow => w !== undefined,
      );
      return windows.map<Forecast>((w) => ({
        windowKey: w.key,
        burn: { pctPerHour: 3.2, samples: 12, confidence: 0.35 },
        exhaustionAt: w.pct >= 99 ? new Date().toISOString() : null,
        lastsToReset: w.pct < 80,
        expectedPct: Math.max(0, w.pct - 6),
        aheadOfPace: w.pct > 55,
      }));
    },

    getSettings: async () => state.settings,

    updateSettings: async (patch: Partial<Settings>) => {
      const settings = { ...state.settings, ...patch };
      commit({ ...state, settings });
      return ok(settings);
    },

    mapDirectory: async (path: string, slot: number) => {
      const directoryMappings: DirectoryMapping[] = [
        ...state.settings.directoryMappings.filter((m) => m.path !== path),
        { path, slot },
      ];
      commit({ ...state, settings: { ...state.settings, directoryMappings } });
      return ok(directoryMappings);
    },

    unmapDirectory: async (path: string) => {
      const directoryMappings = state.settings.directoryMappings.filter((m) => m.path !== path);
      commit({ ...state, settings: { ...state.settings, directoryMappings } });
      return ok(directoryMappings);
    },

    pickDirectory: async () => null,

    exportAccounts: async () => err(NO_BRIDGE, 'no-bridge'),
    importAccounts: async () => err(NO_BRIDGE, 'no-bridge'),

    openExternal: async (url: string) => {
      if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
    },
    revealPath: async () => {
      /* nothing to reveal without a shell */
    },

    onStateChanged: (cb: (next: DeckState) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    onAutoSwitchEvent: () => () => {
      /* the stub never emits engine events */
    },
  };

  return api;
}

// The stub is a module singleton so every hook instance shares one store, the
// way the real bridge shares the main process.
let stubSingleton: DeckApi | null = null;

function stubApi(): DeckApi {
  if (stubSingleton === null) stubSingleton = createStubApi();
  return stubSingleton;
}

export interface DeckBridge {
  api: DeckApi;
  /** True when `window.claudedeck` was absent and the stub took over. */
  stubbed: boolean;
}

/** Resolves the bridge once. Safe to call from anywhere in the renderer. */
export function getDeckBridge(): DeckBridge {
  const injected: DeckApi | undefined = typeof window === 'undefined' ? undefined : window.claudedeck;
  if (injected && typeof injected.getState === 'function') return { api: injected, stubbed: false };
  return { api: stubApi(), stubbed: true };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface DeckStateSlice {
  state: DeckState | null;
  loading: boolean;
  error: string | null;
  api: DeckApi;
  stubbed: boolean;
  /** Re-pull `getState()`; the push channel normally makes this unnecessary. */
  reload: () => Promise<void>;
}

function messageOf(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === 'string' ? cause : 'Unknown error talking to the main process.';
}

export function useDeckState(): DeckStateSlice {
  const [bridge] = useState<DeckBridge>(getDeckBridge);
  const [state, setState] = useState<DeckState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (signal: { cancelled: boolean }) => {
      try {
        const next = await bridge.api.getState();
        if (signal.cancelled) return;
        setState(next);
        setError(null);
      } catch (cause) {
        if (signal.cancelled) return;
        setError(messageOf(cause));
      } finally {
        if (!signal.cancelled) setLoading(false);
      }
    },
    [bridge],
  );

  useEffect(() => {
    const signal = { cancelled: false };
    // Subscribe before the first read so a change landing mid-flight is not lost.
    const unsubscribe = bridge.api.onStateChanged((next) => {
      if (!signal.cancelled) {
        setState(next);
        setError(null);
        setLoading(false);
      }
    });
    void load(signal);
    return () => {
      signal.cancelled = true;
      unsubscribe();
    };
  }, [bridge, load]);

  const reload = useCallback(async () => {
    await load({ cancelled: false });
  }, [load]);

  return { state, loading, error, api: bridge.api, stubbed: bridge.stubbed, reload };
}
