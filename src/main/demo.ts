/**
 * Demo backend: a complete, synthetic `AppServices` for screenshots and demos.
 *
 * Two properties make this safe to point at a real machine:
 *
 *   1. This module imports nothing from `node:fs`, `electron`, or `@core/*`.
 *      It physically cannot read or write a credential, so "demo mode never
 *      touches your account" is a structural guarantee, not a promise.
 *   2. Every mutating call that would persist something returns an error whose
 *      message says so, and `DeckState.demoMode` is true, so the UI is expected
 *      to badge itself loudly.
 *
 * Switching and settings edits are allowed but live only in memory — those are
 * the flows the screenshots exist to show, and neither reaches a disk.
 *
 * Everything is generated from a fixed clock and a seeded PRNG, so two runs a
 * month apart produce byte-identical screenshots.
 */

import type {
  Account,
  AutoSwitchEvent,
  ClaudePaths,
  DeckState,
  DirectoryMapping,
  Forecast,
  Headroom,
  HistoryPoint,
  PlatformKind,
  Result,
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageSnapshot,
  UsageWindow,
} from '@shared/types';
import { err, ok } from '@shared/types';
import type { HistoryQuery } from '@shared/ipc';
import type { AppServices } from './services';
import { defaultSettings } from './settings';

/** Frozen "now" so generated history and reset times never drift. */
export const DEMO_NOW = Date.UTC(2026, 7, 24, 14, 30, 0);

/** Ten days of history at a 20-minute cadence. */
const HISTORY_DAYS = 10;
const HISTORY_STEP_MS = 20 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

const DEMO_CODE = 'demo-mode';
const DEMO_REFUSAL = 'ClaudeDeck is in demo mode — no credential is ever read or written';

export function isDemoMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env['CLAUDEDECK_DEMO'] === '1';
}

/** Demo mode, but staged as a first run rather than a populated install. */
export function isDemoOnboarding(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDemoMode(env) && env['CLAUDEDECK_DEMO_ONBOARDING'] === '1';
}

export interface DemoOptions {
  version?: string;
  /** Override the frozen clock; only tests should need this. */
  now?: number;
  /**
   * Present the app as a fresh install: no accounts, `onboarded` false. Lets
   * the onboarding wizard and every empty state be exercised and screenshotted
   * without deleting anyone's real setup. Set by `CLAUDEDECK_DEMO_ONBOARDING=1`.
   */
  onboarding?: boolean;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32 — 32-bit, seeded, and about ten lines. `Math.random` is banned
 * here: reproducible screenshots are the entire point of this module.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface DemoSeed {
  slot: number;
  email: string;
  alias?: string;
  seed: number;
  /** Rough utilization points per hour; shapes both history and the snapshot. */
  intensity: number;
  fiveHour: number;
  sevenDay: number;
  model: number;
  state: 'active' | 'idle' | 'quarantined' | 'api-key';
}

const SEEDS: readonly DemoSeed[] = [
  { slot: 1, email: 'ada@example.com', alias: 'ada', seed: 0x5eed01, intensity: 7.4, fiveHour: 34.2, sevenDay: 61.5, model: 22.8, state: 'active' },
  { slot: 2, email: 'grace@example.com', alias: 'grace', seed: 0x5eed02, intensity: 11.9, fiveHour: 78.4, sevenDay: 44.1, model: 51.2, state: 'idle' },
  { slot: 3, email: 'linus@example.com', seed: 0x5eed03, intensity: 4.1, fiveHour: 12.0, sevenDay: 19.7, model: 6.4, state: 'quarantined' },
  { slot: 4, email: 'ops-bot@example.com', alias: 'bot', seed: 0x5eed04, intensity: 0, fiveHour: 0, sevenDay: 0, model: 0, state: 'api-key' },
];

const MODEL_NAME = 'Fable';

function demoPlatform(): PlatformKind {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  return 'linux';
}

function demoPaths(platform: PlatformKind): ClaudePaths {
  // Plausible-looking but obviously fictional, so a screenshot never leaks a
  // real username.
  const home = platform === 'windows' ? 'C:\\Users\\demo' : '/home/demo';
  const sep = platform === 'windows' ? '\\' : '/';
  return {
    configHome: `${home}${sep}.claude`,
    globalConfig: `${home}${sep}.claude.json`,
    credentials: `${home}${sep}.claude${sep}.credentials.json`,
    deckHome: `${home}${sep}.claudedeck`,
  };
}

function window_(key: string, label: string, pct: number, resetsAt: number): UsageWindow {
  return { key, label, pct: round1(pct), resetsAt: new Date(resetsAt).toISOString() };
}

function snapshotFor(seed: DemoSeed, now: number): UsageSnapshot | undefined {
  if (seed.state === 'api-key' || seed.state === 'quarantined') return undefined;
  const fiveHourReset = now - (now % FIVE_HOUR_MS) + FIVE_HOUR_MS;
  const sevenDayReset = now - (now % SEVEN_DAY_MS) + SEVEN_DAY_MS;
  const snapshot: UsageSnapshot = {
    fiveHour: window_('5h', '5-hour', seed.fiveHour, fiveHourReset),
    sevenDay: window_('7d', '7-day', seed.sevenDay, sevenDayReset),
    scoped: [window_(MODEL_NAME, `${MODEL_NAME} weekly`, seed.model, sevenDayReset)],
    fetchedAt: now - 42_000,
  };
  if (seed.slot === 1) {
    snapshot.spend = {
      used: 12.34,
      limit: 50,
      pct: 24.7,
      currency: 'USD',
      resetsAt: new Date(sevenDayReset).toISOString(),
    };
  }
  return snapshot;
}

function accountFor(seed: DemoSeed, now: number): Account {
  const usage = snapshotFor(seed, now);
  const base: Account = {
    slot: seed.slot,
    email: seed.email,
    alias: seed.alias,
    kind: seed.state === 'api-key' ? 'api-key' : 'oauth',
    active: seed.state === 'active',
    disabled: seed.state === 'api-key',
    identity: {
      emailAddress: seed.email,
      accountUuid: `00000000-0000-4000-8000-${String(seed.slot).padStart(12, '0')}`,
      organizationName: 'Demo Org',
    },
    usage,
    lastGoodUsage: usage,
    usageStatus: 'ok',
    tokenExpiresAt: now + 6 * 60 * 60 * 1000,
    addedAt: now - (12 - seed.slot) * 24 * 60 * 60 * 1000,
  };
  if (seed.state === 'quarantined') {
    return {
      ...base,
      usageStatus: 'quarantined',
      quarantinedAt: now - 3 * 60 * 60 * 1000,
      quarantineReason: 'refresh token was rejected — sign in again',
    };
  }
  if (seed.state === 'api-key') {
    return { ...base, usageStatus: 'no-quota' };
  }
  return base;
}

/**
 * A sawtooth per rate-limit window with seeded jitter and a working-hours
 * envelope, so the charts look like someone actually used the account rather
 * than like a random walk.
 */
function historyFor(seed: DemoSeed, now: number): HistoryPoint[] {
  if (seed.state === 'api-key') return [];
  const random = mulberry32(seed.seed);
  const start = now - HISTORY_DAYS * 24 * 60 * 60 * 1000;
  const points: HistoryPoint[] = [];
  let fiveHour = 0;
  let sevenDay = 0;
  let model = 0;
  let lastFiveHourBlock = Math.floor(start / FIVE_HOUR_MS);
  let lastSevenDayBlock = Math.floor(start / SEVEN_DAY_MS);

  for (let t = start; t <= now; t += HISTORY_STEP_MS) {
    const fiveHourBlock = Math.floor(t / FIVE_HOUR_MS);
    if (fiveHourBlock !== lastFiveHourBlock) {
      fiveHour = 0;
      lastFiveHourBlock = fiveHourBlock;
    }
    const sevenDayBlock = Math.floor(t / SEVEN_DAY_MS);
    if (sevenDayBlock !== lastSevenDayBlock) {
      sevenDay = 0;
      model = 0;
      lastSevenDayBlock = sevenDayBlock;
    }

    const hour = new Date(t).getUTCHours();
    const weekday = new Date(t).getUTCDay();
    // Quiet overnight and at weekends; that shape is what makes a burn-rate
    // chart legible.
    const awake = hour >= 8 && hour < 21 ? 1 : 0.08;
    const weekly = weekday === 0 || weekday === 6 ? 0.35 : 1;
    const burst = random() < 0.12 ? 2.4 : 1;
    const step = (seed.intensity / 3) * awake * weekly * burst * (0.6 + random() * 0.8);

    fiveHour = Math.min(100, fiveHour + step);
    sevenDay = Math.min(100, sevenDay + step * 0.14);
    model = Math.min(100, model + step * 0.07);

    points.push({
      t,
      slot: seed.slot,
      windows: { '5h': round1(fiveHour), '7d': round1(sevenDay), [MODEL_NAME]: round1(model) },
    });
  }
  return points;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

// ---------------------------------------------------------------------------
// Forecasting (inline, so this module stays dependency-free)
// ---------------------------------------------------------------------------

/** Least-squares slope in utilization points per hour over the given points. */
function fit(points: readonly HistoryPoint[], key: string): { slope: number; last: number; n: number } {
  let n = 0;
  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumXX = 0;
  let last = 0;
  let firstT = 0;
  for (const point of points) {
    const value = point.windows[key];
    if (value === undefined) continue;
    if (n === 0) firstT = point.t;
    const x = (point.t - firstT) / 3_600_000;
    n += 1;
    sumX += x;
    sumY += value;
    sumXY += x * value;
    sumXX += x * x;
    last = value;
  }
  if (n < 2) return { slope: 0, last, n };
  const denominator = n * sumXX - sumX * sumX;
  const slope = denominator === 0 ? 0 : (n * sumXY - sumX * sumY) / denominator;
  return { slope, last, n };
}

function forecastFor(points: readonly HistoryPoint[], key: string, now: number, resetsAt?: string): Forecast {
  // Only the current window matters for a projection; older blocks were reset.
  const windowMs = key === '5h' ? FIVE_HOUR_MS : SEVEN_DAY_MS;
  const blockStart = now - (now % windowMs);
  const recent = points.filter((point) => point.t >= blockStart);
  const { slope, last, n } = fit(recent, key);
  const confidence = Math.max(0, Math.min(1, n / 12));
  const hoursLeft = slope > 0.01 ? (100 - last) / slope : Infinity;
  const exhaustionAt = Number.isFinite(hoursLeft)
    ? new Date(now + hoursLeft * 3_600_000).toISOString()
    : null;
  const resetMs = resetsAt ? Date.parse(resetsAt) : blockStart + windowMs;
  const elapsed = (now - blockStart) / windowMs;
  const expectedPct = round1(Math.max(0, Math.min(100, elapsed * 100)));
  return {
    windowKey: key,
    burn: { pctPerHour: round1(slope), samples: n, confidence: round1(confidence) },
    exhaustionAt,
    lastsToReset: exhaustionAt === null || Date.parse(exhaustionAt) >= resetMs,
    expectedPct,
    aheadOfPace: last > expectedPct + 5,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDemoServices(options: DemoOptions = {}): AppServices {
  const now = options.now ?? DEMO_NOW;
  const version = options.version ?? '0.0.0-demo';
  const platform = demoPlatform();
  const paths = demoPaths(platform);
  const onboarding = options.onboarding ?? isDemoOnboarding();

  // A first-run demo starts with nothing managed, so the wizard and every
  // empty state render exactly as they would on a real fresh install.
  let accounts = onboarding ? [] : SEEDS.map((seed) => accountFor(seed, now));
  const historyBySlot = new Map<number, HistoryPoint[]>(
    SEEDS.map((seed) => [seed.slot, historyFor(seed, now)]),
  );

  let settings: Settings = {
    ...defaultSettings(),
    autoswitch: { ...defaultSettings().autoswitch, enabled: true, threshold: 85, models: [MODEL_NAME] },
  };
  let autoRunning = true;

  const stateListeners = new Set<(state: DeckState) => void>();
  const eventListeners = new Set<(event: AutoSwitchEvent) => void>();
  // A fresh install has no decision history either.
  const events: AutoSwitchEvent[] = onboarding ? [] : [
    { kind: 'poll', ts: now - 300_000, message: 'polled 3 accounts', slot: 1 },
    { kind: 'no-switch', ts: now - 300_000, message: 'slot 1 at 34% — below the 85% threshold', slot: 1 },
    { kind: 'switch', ts: now - 5_400_000, message: 'switched slot 2 -> slot 1 (threshold)', slot: 1 },
  ];

  function state(): DeckState {
    return {
      accounts: accounts.map((account) => ({ ...account })),
      activeSlot: accounts.find((account) => account.active)?.slot ?? null,
      settings,
      paths,
      platform,
      onboarded: !onboarding,
      autoSwitchRunning: autoRunning,
      lastEvents: [...events],
      demoMode: true,
      version,
    };
  }

  let snapshot = state();

  function publish(): void {
    snapshot = state();
    for (const listener of stateListeners) listener(snapshot);
  }

  function emit(event: AutoSwitchEvent): void {
    events.push(event);
    for (const listener of eventListeners) listener(event);
    publish();
  }

  function refuse<T>(): Result<T> {
    return err(DEMO_REFUSAL, DEMO_CODE);
  }

  function resolve(target: string | number | undefined): Account | undefined {
    if (target === undefined) return undefined;
    const key = String(target).trim().toLowerCase();
    return accounts.find(
      (account) =>
        String(account.slot) === key ||
        account.email.toLowerCase() === key ||
        account.alias?.toLowerCase() === key,
    );
  }

  function headroomOf(account: Account): Headroom {
    const usage = account.usage ?? account.lastGoodUsage;
    if (!usage) return { remaining: 100, bindingWindow: 'none' };
    const candidates: UsageWindow[] = [usage.fiveHour, usage.sevenDay, ...usage.scoped].filter(
      (entry): entry is UsageWindow => entry !== undefined,
    );
    if (candidates.length === 0) return { remaining: 100, bindingWindow: 'none' };
    const binding = candidates.reduce((worst, entry) => (entry.pct > worst.pct ? entry : worst));
    return { remaining: round1(100 - binding.pct), bindingWindow: binding.key };
  }

  const services: AppServices = {
    paths,
    platform,
    version,
    demoMode: true,

    currentSettings: () => settings,
    currentState: () => snapshot,
    headroomFor: headroomOf,
    publish,

    async getState() {
      return state();
    },

    async refreshUsage() {
      // No network in demo mode: hand back exactly what we already generated.
      emit({ kind: 'poll', ts: now, message: 'demo mode — usage is synthetic' });
      return ok(accounts.map((account) => ({ ...account })));
    },

    async addCurrentAccount() {
      return refuse<Account>();
    },
    async addToken() {
      return refuse<Account>();
    },
    async removeAccount() {
      return refuse<void>();
    },
    async setAlias() {
      return refuse<Account>();
    },
    async setDisabled() {
      return refuse<Account>();
    },
    async moveAccount() {
      return refuse<Account[]>();
    },

    async switchAccount(request: SwitchRequest) {
      return performSwitch(request, request.dryRun === true);
    },

    async previewSwitch(request: SwitchRequest) {
      return performSwitch(request, true);
    },

    async startAutoSwitch() {
      autoRunning = true;
      publish();
      return ok(undefined);
    },

    async stopAutoSwitch() {
      autoRunning = false;
      publish();
      return ok(undefined);
    },

    async getHistory(query: HistoryQuery) {
      const slots = query.slot === undefined ? [...historyBySlot.keys()] : [query.slot];
      const out: HistoryPoint[] = [];
      for (const slot of slots) {
        for (const point of historyBySlot.get(slot) ?? []) {
          if (query.since !== undefined && point.t < query.since) continue;
          if (query.until !== undefined && point.t > query.until) continue;
          out.push(point);
        }
      }
      return out.sort((left, right) => left.t - right.t);
    },

    async getForecasts(slot: number) {
      const account = accounts.find((entry) => entry.slot === slot);
      const usage = account?.usage ?? account?.lastGoodUsage;
      if (!account || !usage) return [];
      const points = historyBySlot.get(slot) ?? [];
      const out: Forecast[] = [];
      if (usage.fiveHour) out.push(forecastFor(points, '5h', now, usage.fiveHour.resetsAt));
      if (usage.sevenDay) out.push(forecastFor(points, '7d', now, usage.sevenDay.resetsAt));
      for (const scoped of usage.scoped) {
        out.push(forecastFor(points, scoped.key, now, scoped.resetsAt));
      }
      return out;
    },

    async getSettings() {
      return settings;
    },

    async updateSettings(patch: Partial<Settings>) {
      // In-memory only: nothing here reaches settings.json.
      settings = {
        ...settings,
        ...patch,
        autoswitch: { ...settings.autoswitch, ...(patch.autoswitch ?? {}) },
        notifications: { ...settings.notifications, ...(patch.notifications ?? {}) },
      };
      publish();
      return ok(settings);
    },

    async mapDirectory(path: string, slot: number) {
      const next: DirectoryMapping[] = [
        ...settings.directoryMappings.filter((mapping) => mapping.path !== path),
        { path, slot },
      ];
      settings = { ...settings, directoryMappings: next };
      publish();
      return ok(next);
    },

    async unmapDirectory(path: string) {
      const next = settings.directoryMappings.filter((mapping) => mapping.path !== path);
      settings = { ...settings, directoryMappings: next };
      publish();
      return ok(next);
    },

    async exportAccounts() {
      // Shaped like a real export so the UI can be screenshotted, but the
      // credential field is a literal placeholder — there is nothing to leak.
      return ok(
        JSON.stringify(
          {
            format: 'claudedeck.accounts',
            version: 1,
            exportedAt: new Date(now).toISOString(),
            warning: 'DEMO MODE — these are not credentials.',
            accounts: accounts.map((account) => ({
              slot: account.slot,
              email: account.email,
              alias: account.alias,
              kind: account.kind,
              credentials: { claudeAiOauth: { accessToken: '<demo-mode: no credential>' } },
            })),
          },
          null,
          2,
        ),
      );
    },

    async importAccounts() {
      return refuse<Account[]>();
    },

    onStateChanged(callback) {
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    },

    onAutoSwitchEvent(callback) {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    },

    async dispose() {
      stateListeners.clear();
      eventListeners.clear();
    },
  };

  function performSwitch(request: SwitchRequest, dryRun: boolean): SwitchResult {
    const from = accounts.find((account) => account.active);
    const explicit = resolve(request.target);
    const candidates = accounts.filter(
      (account) => !account.active && !account.disabled && !account.quarantinedAt,
    );
    const byHeadroom = [...candidates].sort(
      (left, right) => headroomOf(right).remaining - headroomOf(left).remaining,
    );
    const to =
      explicit ??
      (request.strategy === 'next' ? candidates[0] : byHeadroom[0]) ??
      candidates[0];

    if (!to) {
      return { switched: false, dryRun, reason: 'no eligible account to switch to' };
    }
    if (to.active && !request.force) {
      return {
        switched: false,
        dryRun,
        reason: `slot ${to.slot} is already active`,
        from: from ? { slot: from.slot, email: from.email } : undefined,
      };
    }

    const result: SwitchResult = {
      switched: !dryRun,
      dryRun,
      from: from ? { slot: from.slot, email: from.email } : undefined,
      to: { slot: to.slot, email: to.email },
      reason: dryRun
        ? `would activate slot ${to.slot} (${to.email})`
        : `activated slot ${to.slot} (${to.email})`,
      plannedWrites: [paths.credentials, paths.globalConfig],
    };
    if (dryRun) return result;

    accounts = accounts.map((account) => ({ ...account, active: account.slot === to.slot }));
    emit({
      kind: 'switch',
      ts: now,
      message: result.reason,
      slot: to.slot,
      detail: { demo: true },
    });
    return result;
  }

  return services;
}
