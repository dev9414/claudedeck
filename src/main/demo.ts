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
  AnchorObservation,
  AnchorResult,
  AutoSwitchEvent,
  ClaudePaths,
  DeckState,
  DirectoryMapping,
  Forecast,
  Headroom,
  HistoryPoint,
  PlatformKind,
  Result,
  SessionPlan,
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageProfile,
  UsageSnapshot,
  UsageWindow,
  Weekday,
  WorkSchedule,
} from '@shared/types';
import { err, ok } from '@shared/types';
import type { HistoryQuery } from '@shared/ipc';
import type { AppServices } from './services';
import { defaultSettings } from './settings';
import { localDayStart } from '@core/schedule';
import { planDay } from '@core/planner';

/** Frozen "now" so generated history and reset times never drift. */
export const DEMO_NOW = Date.UTC(2026, 7, 24, 14, 30, 0);

/** Ten days of history at a 20-minute cadence. */
const HISTORY_DAYS = 10;
const HISTORY_STEP_MS = 20 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minutes each slot's 5-hour window is offset from the one before it.
 *
 * Real accounts are anchored by whenever they were last used first, so they
 * never share a boundary — and the planner's whole subject is that offset. A
 * demo where every window resets at the same instant would show the one thing
 * the feature exists to talk about as if it did not exist.
 */
const DEMO_ANCHOR_SKEW_MIN = 80;

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
  const fiveHourReset =
    now - (now % FIVE_HOUR_MS) + FIVE_HOUR_MS + (seed.slot - 1) * DEMO_ANCHOR_SKEW_MIN * MINUTE_MS;
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
// Session planning (inline, for the same reason as the forecasts above)
// ---------------------------------------------------------------------------


/**
 * Utilization points the whole demo fleet burns in each local hour.
 *
 * A morning ramp, a heavy late morning, a lighter afternoon and a quiet night —
 * the shape someone's day actually has, and the shape that makes an anchor
 * recommendation mean something. Written down rather than generated: a planner
 * screenshot has to be the same one every time.
 */
const DEMO_HOURLY: readonly number[] = [
  0, 0, 0, 0, 0, 0, 0.8, 3.4, 18.2, 44.2, 58.6, 61.4, 48.3, 26.3, 22.7, 25.4, 18.6, 11.2, 5.8, 3.1,
  1.4, 0.6, 0.2, 0,
];

/** Three polls an hour, across the weekdays of the ten days of demo history. */
const DEMO_SAMPLES_PER_HOUR = 63;
const DEMO_PROFILE_CONFIDENCE = 0.82;
const DEMO_WEEKDAYS: readonly Weekday[] = [1, 2, 3, 4, 5];

/**
 * Where the demo plan puts each account's first message, in minutes from local
 * midnight. Staggered on purpose: the second account's window has to still be
 * fresh at the moment the first one runs dry, which is the entire argument for
 * choosing an anchor at all.
 */

/** The hours the demo plans against — the app's own defaults, as a real install. */
const DEMO_SCHEDULE: WorkSchedule = defaultSettings().planner.schedules[0] ?? {
  label: 'Weekdays',
  days: [1, 2, 3, 4, 5],
  work: { start: 9 * 60, end: 18 * 60 },
  peak: { start: 10 * 60, end: 13 * 60 },
};









/** The learned curve, fleet-wide or scaled to one account's share of it. */
function demoProfile(slot?: number): UsageProfile {
  const fleet = SEEDS.reduce((sum, seed) => sum + seed.intensity, 0);
  const seed = slot === undefined ? undefined : SEEDS.find((entry) => entry.slot === slot);
  const share = seed === undefined ? 1 : fleet > 0 ? seed.intensity / fleet : 0;
  return {
    hourly: DEMO_HOURLY.map((value) => round1(value * share)),
    // One account was observed by one account's polls, so its evidence is
    // thinner than the fleet's, and the confidence has to say so.
    samples: DEMO_HOURLY.map(() =>
      slot === undefined ? DEMO_SAMPLES_PER_HOUR : Math.round(DEMO_SAMPLES_PER_HOUR / SEEDS.length),
    ),
    confidence: slot === undefined ? DEMO_PROFILE_CONFIDENCE : round1(DEMO_PROFILE_CONFIDENCE - 0.11),
    days: [...DEMO_WEEKDAYS],
  };
}

/**
 * Local midnight of the day to plan, or null when the key is not a real day.
 *
 * "Local" matters and used to be wrong here. The renderer formats every instant
 * in the host's timezone, so a demo day laid out at UTC midnight put the anchor
 * label and the anchor's position a whole UTC offset apart -- the note said
 * 07:30 while the bullet above it said 13:00 on a +05:30 host. The real service
 * uses `-getTimezoneOffset()`; this now does the same.
 */
function demoDayStart(now: number, day?: string): number | null {
  if (day === undefined) return localDayStart(now, -new Date(now).getTimezoneOffset());

  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!parts || parts[1] === undefined || parts[2] === undefined || parts[3] === undefined) {
    return null;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const date = Number(parts[3]);

  // Built through the local constructor so the result is local midnight, and
  // read back because `new Date(2026, 1, 31)` rolls into March rather than
  // refusing a day that never existed.
  const at = new Date(year, month - 1, date, 0, 0, 0, 0);
  if (at.getFullYear() !== year || at.getMonth() !== month - 1 || at.getDate() !== date) {
    return null;
  }
  return at.getTime();
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
    // Presented as an install where the user has already declared their hours:
    // the planner's own screenshots are of a configured planner, and
    // `configured` is what stops every surface labelling the plan a guess.
    planner: { ...defaultSettings().planner, enabled: true, configured: true },
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

    async getSessionPlan(day?: string): Promise<Result<SessionPlan>> {
      const dayStart = demoDayStart(now, day);
      if (dayStart === null) {
        return err(`"${day}" is not a calendar day — use YYYY-MM-DD`, 'bad-day');
      }

      // The real optimiser, not a copy of it. This used to be a second
      // simulator living here, and it drifted exactly as you would expect: it
      // recommended fixed anchors and then narrated a benefit its own numbers
      // said was zero. Demo mode supplies synthetic *inputs*; the planning is
      // the same code the app runs for real.
      const plannable = accounts.filter(
        (account) => account.kind !== 'api-key' && !account.disabled && !account.quarantinedAt,
      );
      const profile = demoProfile();

      const plan = planDay({
        dayStartMs: dayStart,
        tzOffsetMin: -new Date(dayStart).getTimezoneOffset(),
        schedule: DEMO_SCHEDULE,
        accounts: plannable.map((account) => ({
          slot: account.slot,
          email: account.email,
          ...(account.alias === undefined ? {} : { alias: account.alias }),
          profile,
        })),
        peakWeight: settings.planner.peakWeight,
        scheduleConfigured: settings.planner.configured,
      });

      return ok({
        ...plan,
        rationale: [
          ...plan.rationale,
          'Demo mode — this plan is simulated from synthetic history, not from your own usage.',
        ],
      });
    },

    async getUsageProfile(slot?: number): Promise<Result<UsageProfile>> {
      if (slot !== undefined && !accounts.some((account) => account.slot === slot)) {
        return err(`no account in slot ${slot}`, 'not-found');
      }
      return ok(demoProfile(slot));
    },

    async getAnchors() {
      const observed: AnchorObservation[] = [];
      for (const account of accounts) {
        const usage = account.usage ?? account.lastGoodUsage;
        const resetsAt = usage?.fiveHour?.resetsAt;
        // No 5-hour window, no anchor to derive. Omitted rather than invented:
        // the anchor is only meaningful because it is observed.
        if (usage === undefined || resetsAt === undefined) continue;
        const reset = Date.parse(resetsAt);
        if (Number.isNaN(reset)) continue;
        observed.push({
          slot: account.slot,
          anchorAt: reset - FIVE_HOUR_MS,
          observedAt: usage.fetchedAt,
        });
      }
      return observed;
    },

    async anchorNow(slot: number): Promise<AnchorResult> {
      // Anchoring is the one planner action with a side effect outside this
      // process: it spawns the Claude Code CLI and spends real quota. Demo mode
      // refuses every write, and it must refuse this one loudest — there is no
      // account here to bill and nothing on PATH we are entitled to run.
      return {
        ok: false,
        slot,
        error: `${DEMO_REFUSAL} — anchoring would run the Claude Code CLI and spend real quota, so it is disabled in demo mode.`,
      };
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
