/**
 * The auto-switch engine: when to rotate, how often to look, and the loop that
 * ties the two together.
 *
 * `decide` and `nextPollDelay` are pure functions of their inputs — every rule
 * in here is unit-testable without a clock, a socket or a filesystem.
 * `createAutoSwitcher` is the only stateful part, and it owns nothing but a
 * timer, a few counters and the last-known account list.
 *
 * The engine fails safe by construction: it decides only on data that a poll
 * just confirmed. A failed fetch keeps the previous numbers, backs the cadence
 * off, and skips the decision entirely rather than rotating on a guess.
 */

import type {
  Account,
  AutoSwitchConfig,
  AutoSwitchEvent,
  Forecast,
  SwitchReason,
  SwitchRequest,
  SwitchResult,
  UsageSnapshot,
} from '@shared/types';
import { accountHeadroom, headroomScore, isExhausted, rotationCandidates } from './switcher';
import { relevantWindows } from './usage';

// ---------------------------------------------------------------------------
// decide()
// ---------------------------------------------------------------------------

export interface DecideInput {
  accounts: Account[];
  activeSlot: number | null;
  config: AutoSwitchConfig;
  /** Epoch ms of the previous switch; null or absent when there was none. */
  lastSwitchAt?: number | null;
  /** Epoch ms. */
  now: number;
  /** Fresher usage than the accounts carry, keyed by slot. */
  usage?: Record<number, UsageSnapshot | undefined>;
  /** Forecast for the active account. Present enables the `pace` trigger. */
  activeForecast?: Forecast;
  /** A snapshot older than this cannot justify a proactive switch. */
  maxUsageAgeMs?: number;
}

export type Decision =
  | { action: 'switch'; target: number; reason: SwitchReason }
  | { action: 'hold'; reason: string }
  | { action: 'blocked'; reason: string };

/**
 * Usage this old is a memory, not a measurement. Switching on it would burn a
 * good account because of numbers from before the last reset.
 */
export const DEFAULT_MAX_USAGE_AGE_MS = 15 * 60_000;

/** A forecast below this confidence is a hint for the UI, never a trigger. */
export const PACE_CONFIDENCE_FLOOR = 0.6;

/**
 * Should the engine rotate right now, and onto what?
 *
 * Pure. The three outcomes are distinct on purpose: `hold` means "everything is
 * fine, look again later", `blocked` means "there is nowhere to go" and belongs
 * in front of the user.
 */
export function decide(input: DecideInput): Decision {
  const { config, now } = input;
  if (!config.enabled) return hold('auto-switch is turned off');

  const accounts = withFreshUsage(input);
  const models = config.models ?? [];
  const threshold = clamp(config.threshold, 1, 100);
  const margin = Math.max(0, config.hysteresisMargin);
  const maxAge = input.maxUsageAgeMs ?? DEFAULT_MAX_USAGE_AGE_MS;

  const active = findActive(accounts, input.activeSlot);

  // Rotation targets. `next` deliberately does not filter on quota when a human
  // asks for it, but the engine never picks an account it knows is spent, so
  // the exhaustion filter is applied here for every strategy.
  const candidates = rotationCandidates(accounts, {
    strategy: config.strategy,
    activeSlot: active?.slot ?? input.activeSlot,
    includeApiKeyAccounts: config.includeApiKeyAccounts,
    models,
  }).filter((a) => !isExhausted(a, models));

  if (active === undefined) {
    const first = candidates[0];
    if (first === undefined) return blockedResult(accounts, models, now, config);
    return { action: 'switch', target: first.slot, reason: 'startup' };
  }

  const activeQuarantined =
    active.quarantinedAt !== undefined || active.usageStatus === 'quarantined';
  const activeSpent = isExhausted(active, models);

  // --- is a switch wanted at all? ------------------------------------------
  let trigger: SwitchReason | null = null;
  let why = '';

  if (activeQuarantined) {
    trigger = 'quarantine';
    why = `slot ${active.slot} needs re-authentication`;
  } else if (activeSpent) {
    trigger = 'threshold';
    why = `slot ${active.slot} is out of quota`;
  } else if (active.kind === 'api-key') {
    return hold(`slot ${active.slot} is an API-key account — it has no quota to watch`);
  } else {
    const room = accountHeadroom(active, models);
    const snapshot = active.usage ?? active.lastGoodUsage;
    if (room === null || snapshot === undefined) {
      return hold(`no usage data for slot ${active.slot} yet`);
    }
    if (now - snapshot.fetchedAt > maxAge) {
      return hold(
        `usage for slot ${active.slot} is ${Math.round((now - snapshot.fetchedAt) / 60_000)}m ` +
          'old — waiting for a fresh reading',
      );
    }
    const pct = 100 - room.remaining;
    if (pct >= threshold) {
      trigger = 'threshold';
      why = `slot ${active.slot} is at ${fmtPct(pct)}% of its ${room.bindingWindow} window`;
    } else if (pacePressure(input.activeForecast)) {
      trigger = 'pace';
      why = `slot ${active.slot} is burning faster than its window resets`;
    } else {
      return hold(
        `slot ${active.slot} is at ${fmtPct(pct)}% (${room.bindingWindow}), under the ` +
          `${threshold}% threshold`,
      );
    }
  }

  // --- cooldown -------------------------------------------------------------
  const reactive = activeQuarantined || activeSpent;
  const lastSwitchAt = input.lastSwitchAt ?? null;
  if (!reactive && lastSwitchAt !== null) {
    const waited = now - lastSwitchAt;
    const cooldownMs = Math.max(0, config.cooldownSec) * 1000;
    if (waited < cooldownMs) {
      return hold(
        `${why}, but the ${config.cooldownSec}s cooldown has ` +
          `${Math.ceil((cooldownMs - waited) / 1000)}s left`,
      );
    }
  }
  // A reactive switch skips the cooldown on purpose: the incumbent is unusable,
  // and every candidate below has real headroom, so there is nothing to flap
  // between — worst case the engine walks each account once.

  // --- pick a target --------------------------------------------------------
  if (candidates.length === 0) {
    if (reactive) return blockedResult(accounts, models, now, config);
    return hold(`${why}, but no other account is eligible right now`);
  }

  const incumbentScore = reactive ? -1 : headroomScore(active, models);
  const chosen = candidates.find((c) => {
    const score = headroomScore(c, models);
    if (reactive) return score > incumbentScore;
    // Proactive: land only below the threshold, and only on an account that
    // beats the incumbent by the margin. Two accounts hovering either side of
    // the line therefore cannot trade places every poll, while a genuinely
    // fresher account still clears the bar immediately.
    return 100 - score < threshold && score >= incumbentScore + margin;
  });

  if (chosen === undefined) {
    const best = candidates.reduce((a, b) =>
      headroomScore(b, models) > headroomScore(a, models) ? b : a,
    );
    return hold(
      `${why}, but the best alternative (slot ${best.slot}, ` +
        `${fmtPct(headroomScore(best, models))}% headroom) does not beat it by the ` +
        `${margin}-point margin`,
    );
  }

  return { action: 'switch', target: chosen.slot, reason: trigger };
}

/** Every managed account is spent — the state the user has to be told about. */
export function allExhausted(accounts: Account[], config: AutoSwitchConfig): boolean {
  const models = config.models ?? [];
  const managed = accounts.filter(
    (a) => !a.disabled && (a.kind !== 'api-key' || config.includeApiKeyAccounts),
  );
  return managed.length > 0 && managed.every((a) => isExhausted(a, models));
}

// ---------------------------------------------------------------------------
// nextPollDelay()
// ---------------------------------------------------------------------------

export interface PollState {
  accounts: Account[];
  activeSlot: number | null;
  /** Consecutive failed usage fetches. */
  consecutiveErrors?: number;
  /** Epoch ms of the most recent 429 from the usage endpoint. */
  lastRateLimitAt?: number;
  /** `Retry-After` seconds that came with it. */
  retryAfterSec?: number;
  /** Epoch ms the active account's binding window last moved. */
  lastChangeAt?: number;
  /** Nobody is watching: tray-only, window closed. */
  idle?: boolean;
}

/**
 * Cadence floor. The usage endpoint budgets non-first-party clients to roughly
 * 28-30 requests per identity per rolling hour, so the sustained target is one
 * request every three minutes, leaving room for manual refreshes on top.
 */
export const BASE_POLL_FLOOR_MS = 180_000;
/** Urgent floor: only for an active account closing on the threshold. */
export const MIN_POLL_MS = 60_000;
export const MAX_POLL_MS = 1_800_000;
/** An idle account still gets looked at, just rarely. */
export const IDLE_POLL_MS = 600_000;
/** Exhaustion is stable, but quota grants and corrections do happen. */
export const EXHAUSTED_POLL_MS = 600_000;
/**
 * After a 429 the budget only recovers as old requests age out of the trailing
 * hour, so probing sooner re-spends the capacity that just freed up.
 */
export const POST_429_FLOOR_MS = 360_000;
export const RATE_LIMIT_MEMORY_MS = 3_600_000;
/** Watch closely once the active account is within this much of the threshold. */
export const ESCALATION_MARGIN_PCT = 15;
/** Wake this long after a reported reset, never before it. */
export const RESET_SLACK_MS = 60_000;
/** No movement for this long and the account is treated as idle. */
export const IDLE_AFTER_MS = 1_800_000;

/**
 * How long to wait before the next poll.
 *
 * Pure, bounded at both ends, and ordered so the safety rules win: a fetch
 * failure or a 429 backs the cadence off before any "watch this closely" rule
 * gets to pull it back in, and only a known window reset can shorten it again.
 */
export function nextPollDelay(state: PollState, config: AutoSwitchConfig, now: number): number {
  const models = config.models ?? [];
  const base = clamp(Math.max(0, config.pollIntervalSec) * 1000, BASE_POLL_FLOOR_MS, MAX_POLL_MS);

  const errors = Math.max(0, state.consecutiveErrors ?? 0);
  const rateLimited =
    state.lastRateLimitAt !== undefined && now - state.lastRateLimitAt < RATE_LIMIT_MEMORY_MS;

  let delay = base;
  if (errors > 0) {
    // Doubling capped at 32x keeps a broken network from hammering the API
    // while still recovering within one interval once it comes back.
    delay = Math.min(MAX_POLL_MS, base * 2 ** Math.min(errors, 5));
  }
  if (rateLimited) {
    delay = Math.max(delay, POST_429_FLOOR_MS, (state.retryAfterSec ?? 0) * 1000);
  }

  const active = findActive(state.accounts, state.activeSlot);
  if (errors === 0 && !rateLimited && active !== undefined) {
    const threshold = clamp(config.threshold, 1, 100);
    const room = accountHeadroom(active, models);
    const idle =
      state.idle === true ||
      (state.lastChangeAt !== undefined && now - state.lastChangeAt > IDLE_AFTER_MS);

    if (isExhausted(active, models)) delay = EXHAUSTED_POLL_MS;
    else if (room !== null && 100 - room.remaining >= threshold - ESCALATION_MARGIN_PCT) {
      delay = MIN_POLL_MS;
    } else if (idle) delay = IDLE_POLL_MS;
  }

  // Stored usage is obsolete the instant a window rolls over, and an exhausted
  // account becomes usable again exactly then — so never sleep past a reset we
  // already know about. The 429 floor still applies: waking into a blocked
  // endpoint would only spend budget we do not have.
  const floor = rateLimited ? Math.max(MIN_POLL_MS, POST_429_FLOOR_MS) : MIN_POLL_MS;
  const reset = nextRelevantReset(state, models, now);
  if (reset !== null) {
    const untilReset = reset - now + RESET_SLACK_MS;
    if (untilReset < delay) delay = Math.max(floor, untilReset);
  }

  return clamp(delay, MIN_POLL_MS, MAX_POLL_MS);
}

/**
 * Soonest future reset worth waking for: the active account (its numbers drive
 * every decision) plus any exhausted account, whose reset is the moment it
 * becomes a candidate again.
 */
function nextRelevantReset(state: PollState, models: string[], now: number): number | null {
  const watched = state.accounts.filter(
    (a) => a.slot === state.activeSlot || isExhausted(a, models),
  );
  let soonest: number | null = null;
  for (const account of watched) {
    for (const window of relevantWindows(account.usage ?? account.lastGoodUsage, models)) {
      if (window.resetsAt === undefined) continue;
      const at = Date.parse(window.resetsAt);
      if (Number.isNaN(at) || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
  }
  return soonest;
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** The world as one tick sees it. */
export interface AutoSwitchSnapshot {
  accounts: Account[];
  activeSlot: number | null;
  config: AutoSwitchConfig;
  lastSwitchAt?: number | null;
}

/**
 * Result of refreshing usage. Modelled after `UsageOutcome` rather than
 * `Result` so a 429 can carry its `Retry-After` into the cadence.
 */
export type PollOutcome =
  | { ok: true; accounts: Account[] }
  | { ok: false; error: string; rateLimited?: boolean; retryAfterSec?: number };

export interface AutoSwitchDeps {
  /** Epoch ms. */
  now(): number;
  /**
   * One-shot timer returning its own cancel. Defaults to `setTimeout`; inject
   * it to drive the loop deterministically in tests.
   */
  schedule?(ms: number, fn: () => void): () => void;
  /** Current accounts, active slot and config. Called once per tick. */
  snapshot(): Promise<AutoSwitchSnapshot>;
  /** Refresh usage for the accounts worth polling. */
  pollUsage(): Promise<PollOutcome>;
  /**
   * Perform a switch — wire to `applySwitch`. Do not also give `applySwitch`
   * an `emit`, or every rotation is reported twice.
   */
  performSwitch(req: SwitchRequest): Promise<SwitchResult>;
  emit(event: AutoSwitchEvent): void;
}

export interface AutoSwitcher {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  /** One poll-decide-act cycle. For tests, and for a manual "check now". */
  runOnce(): Promise<void>;
}

export function createAutoSwitcher(deps: AutoSwitchDeps): AutoSwitcher {
  const schedule = deps.schedule ?? defaultSchedule;

  let running = false;
  let cancel: (() => void) | null = null;
  let inflight: Promise<void> | null = null;

  // Everything the cadence remembers between ticks. Held here, not in
  // nextPollDelay, so the policy itself stays a pure function.
  let accounts: Account[] = [];
  let activeSlot: number | null = null;
  let config: AutoSwitchConfig | null = null;
  let lastSwitchAt: number | null = null;
  let consecutiveErrors = 0;
  let lastRateLimitAt: number | undefined;
  let retryAfterSec: number | undefined;
  let lastChangeAt: number | undefined;
  let lastBindingPct: number | null = null;

  const emit = (
    kind: AutoSwitchEvent['kind'],
    message: string,
    slot?: number,
    detail?: Record<string, unknown>,
  ): void => {
    const event: AutoSwitchEvent = { kind, ts: deps.now(), message };
    if (slot !== undefined) event.slot = slot;
    if (detail !== undefined) event.detail = detail;
    deps.emit(event);
  };

  const cycle = async (): Promise<void> => {
    let snap: AutoSwitchSnapshot;
    try {
      snap = await deps.snapshot();
    } catch (e) {
      consecutiveErrors += 1;
      emit('error', `could not read the account list: ${describe(e)}`);
      return;
    }

    accounts = snap.accounts;
    activeSlot = snap.activeSlot;
    config = snap.config;
    if (snap.lastSwitchAt !== undefined && snap.lastSwitchAt !== null) {
      lastSwitchAt = snap.lastSwitchAt;
    }

    if (!config.enabled) {
      emit('no-switch', 'auto-switch is turned off');
      return;
    }

    let poll: PollOutcome;
    try {
      poll = await deps.pollUsage();
    } catch (e) {
      poll = { ok: false, error: describe(e) };
    }

    if (!poll.ok) {
      // Keep the last known numbers and back off. Deciding here is what would
      // rotate a healthy account away on the strength of a network blip.
      consecutiveErrors += 1;
      if (poll.rateLimited === true) {
        lastRateLimitAt = deps.now();
        retryAfterSec = poll.retryAfterSec;
      }
      emit('error', `usage poll failed (${poll.error}) — holding on the last known numbers`, undefined, {
        consecutiveErrors,
      });
      return;
    }

    consecutiveErrors = 0;
    accounts = poll.accounts;
    trackMovement(deps.now());

    const active = findActive(accounts, activeSlot);
    const room = active === undefined ? null : accountHeadroom(active, config.models ?? []);
    emit('poll', pollMessage(active, room), active?.slot, {
      accounts: accounts.length,
    });

    const decision = decide({
      accounts,
      activeSlot,
      config,
      lastSwitchAt,
      now: deps.now(),
    });

    if (decision.action === 'hold') {
      emit('no-switch', decision.reason, active?.slot);
      return;
    }
    if (decision.action === 'blocked') {
      const kind = allExhausted(accounts, config) ? 'all-exhausted' : 'blocked';
      emit(kind, decision.reason, active?.slot);
      return;
    }

    if (config.dryRun) {
      emit('no-switch', `dry run: would switch to slot ${decision.target} (${decision.reason})`, decision.target);
      return;
    }

    const request: SwitchRequest = { target: decision.target, reason: decision.reason };
    if (config.strategy !== undefined) request.strategy = config.strategy;

    let result: SwitchResult;
    try {
      result = await deps.performSwitch(request);
    } catch (e) {
      emit('error', `switch to slot ${decision.target} threw: ${describe(e)}`, decision.target);
      return;
    }

    if (result.switched) {
      lastSwitchAt = deps.now();
      activeSlot = decision.target;
      // Movement is measured per account, so the baseline is meaningless now.
      lastBindingPct = null;
      emit('switch', `switched to slot ${decision.target}: ${decision.reason}`, decision.target, {
        from: result.from?.slot ?? null,
        reason: decision.reason,
      });
      if (result.error !== undefined) emit('error', result.error, decision.target);
      return;
    }

    emit('error', result.error ?? `switch to slot ${decision.target} did not happen: ${result.reason}`, decision.target);
  };

  /**
   * Did the active account's binding window move since the last poll? A window
   * that is not moving is not being spent, which is what earns a slower
   * cadence; a moving one keeps the loop attentive.
   */
  const trackMovement = (now: number): void => {
    const active = findActive(accounts, activeSlot);
    const room = active === undefined ? null : accountHeadroom(active, config?.models ?? []);
    const pct = room === null ? null : 100 - room.remaining;
    if (pct !== null && (lastBindingPct === null || Math.abs(pct - lastBindingPct) >= 1)) {
      lastChangeAt = now;
    }
    lastBindingPct = pct;
  };

  const tick = (): void => {
    if (!running) return;
    inflight = cycle()
      .catch((e: unknown) => {
        emit('error', `auto-switch tick failed: ${describe(e)}`);
      })
      .finally(() => {
        inflight = null;
        if (!running) return;
        const state: PollState = { accounts, activeSlot };
        if (consecutiveErrors > 0) state.consecutiveErrors = consecutiveErrors;
        if (lastRateLimitAt !== undefined) state.lastRateLimitAt = lastRateLimitAt;
        if (retryAfterSec !== undefined) state.retryAfterSec = retryAfterSec;
        if (lastChangeAt !== undefined) state.lastChangeAt = lastChangeAt;
        const delay = nextPollDelay(state, config ?? FALLBACK_CONFIG, deps.now());
        cancel = schedule(delay, tick);
      });
  };

  return {
    start(): void {
      if (running) return;
      running = true;
      emit('poll', 'auto-switch started');
      // First look happens immediately; the adaptive cadence takes over after.
      cancel = schedule(0, tick);
    },
    stop(): void {
      if (!running) return;
      running = false;
      cancel?.();
      cancel = null;
      emit('no-switch', 'auto-switch stopped');
    },
    isRunning(): boolean {
      return running;
    },
    runOnce(): Promise<void> {
      return inflight ?? cycle();
    },
  };
}

/**
 * Used only if a tick fails before the first snapshot lands, so the loop still
 * has a cadence to reschedule on.
 */
const FALLBACK_CONFIG: AutoSwitchConfig = {
  enabled: true,
  threshold: 90,
  pollIntervalSec: BASE_POLL_FLOOR_MS / 1000,
  cooldownSec: 300,
  hysteresisMargin: 10,
  strategy: 'best',
  models: [],
  includeApiKeyAccounts: false,
  dryRun: false,
};

function defaultSchedule(ms: number, fn: () => void): () => void {
  const handle = setTimeout(fn, ms);
  return () => clearTimeout(handle);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const hold = (reason: string): Decision => ({ action: 'hold', reason });

function blockedResult(
  accounts: Account[],
  models: string[],
  now: number,
  config: AutoSwitchConfig,
): Decision {
  const managed = accounts.filter(
    (a) => !a.disabled && (a.kind !== 'api-key' || config.includeApiKeyAccounts),
  );
  if (managed.length === 0) {
    return { action: 'blocked', reason: 'no account is available to auto-switch to' };
  }
  const reset = earliestRecovery(managed, models, now);
  const when = reset === null ? 'no reset time reported' : `earliest reset ${humanizeIn(reset - now)}`;
  return {
    action: 'blocked',
    reason: `all ${managed.length} eligible accounts are out of quota — ${when}`,
  };
}

/** Soonest reset among the windows that are currently at or over 100%. */
function earliestRecovery(accounts: Account[], models: string[], now: number): number | null {
  let soonest: number | null = null;
  for (const account of accounts) {
    for (const window of relevantWindows(account.usage ?? account.lastGoodUsage, models)) {
      if (window.pct < 100 || window.resetsAt === undefined) continue;
      const at = Date.parse(window.resetsAt);
      if (Number.isNaN(at) || at <= now) continue;
      if (soonest === null || at < soonest) soonest = at;
    }
  }
  return soonest;
}

/** Replace each account's usage with a fresher snapshot when one was supplied. */
function withFreshUsage(input: DecideInput): Account[] {
  const overrides = input.usage;
  if (overrides === undefined) return input.accounts;
  return input.accounts.map((a) => {
    const fresh = overrides[a.slot];
    return fresh === undefined ? a : { ...a, usage: fresh };
  });
}

function findActive(accounts: Account[], activeSlot: number | null): Account | undefined {
  if (activeSlot !== null) {
    const bySlot = accounts.find((a) => a.slot === activeSlot);
    if (bySlot !== undefined) return bySlot;
  }
  return accounts.find((a) => a.active);
}

/**
 * A forecast only triggers a switch when it is confident *and* says the window
 * dies before it resets. Anything softer is a UI hint, not a reason to move.
 */
function pacePressure(forecast: Forecast | undefined): boolean {
  if (forecast === undefined) return false;
  if (forecast.burn.confidence < PACE_CONFIDENCE_FLOOR) return false;
  return forecast.exhaustionAt !== null && !forecast.lastsToReset;
}

function pollMessage(
  active: Account | undefined,
  room: { remaining: number; bindingWindow: string } | null,
): string {
  if (active === undefined) return 'polled usage; no active account';
  if (room === null) return `polled usage; slot ${active.slot} reports no quota windows`;
  return `slot ${active.slot} at ${fmtPct(100 - room.remaining)}% (${room.bindingWindow})`;
}

function humanizeIn(ms: number): string {
  if (ms <= 0) return 'now';
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours}h ${minutes % 60}m`;
  return `in ${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function fmtPct(pct: number): string {
  return (Math.round(pct * 10) / 10).toString();
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
