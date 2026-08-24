/**
 * Session window planning: where to place the 5-hour anchor.
 *
 * The window starts at your *first message*, not on the hour, so the anchor is
 * the one property of it you control. Message at 09:00 and the resets land at
 * 14:00, 19:00; message at 11:00 and they land at 16:00, 21:00. When a heavy
 * stretch would drain a window mid-flight, an earlier anchor makes the reset
 * arrive *during* that stretch instead of after it -- which is the difference
 * between working through the afternoon and staring at a rate-limit message.
 *
 * So this module simulates the working day minute by minute against the learned
 * demand curve from `profile.ts`, and reports the anchor that costs the fewest
 * blocked minutes, weighting the user's peak hours heavier. It is pure: `now`
 * never appears, the day being planned arrives as `dayStartMs`, and nothing is
 * random -- the same input always yields the same plan, so the UI can show it
 * without it shifting under the user.
 */

import { FIVE_HOUR_MS } from '@shared/types';
import type {
  AccountPlan,
  DaySpan,
  PlanOutcome,
  SessionPlan,
  UsageProfile,
  WindowSpan,
  WorkSchedule,
} from '@shared/types';
import {
  MIN_ACTIONABLE_CONFIDENCE,
  emptyProfile,
  localDayKey,
  localHourAt,
  localWeekday,
  normalizeMinute,
  spanLengthMin,
} from './profile';

/** Simulation resolution. Fine enough to place an anchor usefully, coarse enough to brute-force. */
export const STEP_MIN = 5;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const STEP_MS = STEP_MIN * MINUTE_MS;

/** A window is spent at 100 utilization points; there is no partial credit past it. */
const FULL_PCT = 100;

/**
 * How far before the start of work a candidate anchor may sit. Six hours is
 * more than a whole window, so every phase of the window relative to the
 * working day is reachable -- searching further back only repeats them.
 */
export const ANCHOR_LOOKBACK_MIN = 360;

/** Coordinate-descent passes before we accept the anchors we have. */
export const DEFAULT_MAX_PASSES = 8;

/** Costs are sums of floats; anything inside this is a tie, not a difference. */
const COST_EPS = 1e-9;

/**
 * Utilization is accumulated in fractions of a percent, so a window that fills
 * exactly to the brim lands at 99.999999999999 as often as at 100. Both mean
 * spent, and both the "has room" test and the exhaustion instant must agree
 * about that or a window reads as full while claiming it never filled.
 */
const FULL_EPS = 1e-9;

/** Guard rail for a config value that reaches us from disk. */
const MAX_PEAK_WEIGHT = 1000;

export interface SimInput {
  /** Epoch ms of local midnight for the day being planned. */
  dayStartMs: number;
  schedule: WorkSchedule;
  /** One profile per account, in the same order as `anchors`. */
  profiles: UsageProfile[];
  peakWeight: number;
  tzOffsetMin: number;
}

/** One account the plan may place an anchor for. */
export interface PlanAccount {
  slot: number;
  email: string;
  alias?: string;
  /**
   * The demand curve to charge this account with. Usually the *same* fleet-wide
   * profile for every account: whichever account is active absorbs the whole
   * day's demand, so per-account curves would model a split that does not
   * happen.
   */
  profile: UsageProfile;
}

export interface PlanInput {
  /** Epoch ms of local midnight of the day to plan. */
  dayStartMs: number;
  /** Minutes to add to UTC to get local time; must agree with `dayStartMs`. */
  tzOffsetMin: number;
  schedule: WorkSchedule;
  /** Accounts available to rotate through, in slot order. May be empty. */
  accounts: PlanAccount[];
  /** How many times heavier a blocked peak minute counts. */
  peakWeight: number;
  /**
   * `PlannerConfig.configured`: whether `schedule` is hours the user actually
   * confirmed. Absent or false means the app invented them, which the plan has
   * to admit -- excellent history against guessed hours is still guesswork.
   */
  scheduleConfigured?: boolean;
  /** Coordinate-descent pass cap; `DEFAULT_MAX_PASSES` when omitted. */
  maxPasses?: number;
}

const round = (v: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(v * factor) / factor;
};

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sanePeakWeight(weight: number): number {
  const w = finite(weight);
  // A missing or absurd weight must not silently disable peak protection, which
  // is the whole reason the user configured a peak.
  if (w === null || w < 0) return 1;
  return Math.min(w, MAX_PEAK_WEIGHT);
}

/** 24 non-negative rates, whatever the profile actually contains. */
function sanitizeHourly(profile: UsageProfile | undefined): number[] {
  const hourly = new Array<number>(HOURS_PER_DAY).fill(0);
  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    const v = profile?.hourly[hour];
    hourly[hour] = typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
  }
  return hourly;
}

/** Half-open epoch-ms interval. */
interface Interval {
  startMs: number;
  endMs: number;
}

/**
 * A `DaySpan` as instants on the planned day. `spanLengthMin` already reads
 * `end <= start` as running past midnight, so a night shift simply extends past
 * `dayStartMs + 24h` instead of needing a second day of bookkeeping.
 */
function spanInterval(span: DaySpan, dayStartMs: number): Interval {
  const startMs = dayStartMs + normalizeMinute(span.start) * MINUTE_MS;
  return { startMs, endMs: startMs + spanLengthMin(span) * MINUTE_MS };
}

interface ResolvedPeak {
  interval: Interval;
  /** True when the peak had to be trimmed to fit inside working hours. */
  clamped: boolean;
  /** True when it does not overlap working hours at all and was dropped. */
  outside: boolean;
}

/**
 * The peak, clamped into the working day.
 *
 * A peak of 01:00-03:00 inside a 20:00-04:00 night shift means the *next*
 * calendar day, so the day either side is tried before giving up. If nothing
 * overlaps, the peak is dropped rather than relocated: inventing a peak
 * somewhere inside working hours would be a guess presented as the user's own
 * setting. Scoring then falls back to plain blocked working minutes, and
 * `planDay` says so in the rationale.
 */
function resolvePeak(work: Interval, peak: DaySpan, dayStartMs: number): ResolvedPeak {
  const raw = spanInterval(peak, dayStartMs);
  let best: Interval | null = null;
  let bestLen = 0;

  for (const shiftMs of [0, DAY_MS, -DAY_MS]) {
    const startMs = Math.max(work.startMs, raw.startMs + shiftMs);
    const endMs = Math.min(work.endMs, raw.endMs + shiftMs);
    if (endMs - startMs > bestLen) {
      bestLen = endMs - startMs;
      best = { startMs, endMs };
    }
  }

  if (best === null || bestLen <= 0) {
    return {
      interval: { startMs: work.startMs, endMs: work.startMs },
      clamped: false,
      outside: true,
    };
  }
  return { interval: best, clamped: bestLen < raw.endMs - raw.startMs, outside: false };
}

/** Minutes of `[from, to)` that fall inside `interval`. */
function overlapMin(from: number, to: number, interval: Interval): number {
  const start = Math.max(from, interval.startMs);
  const end = Math.min(to, interval.endMs);
  return end > start ? (end - start) / MINUTE_MS : 0;
}

/** One account's evolving state through the simulated day. */
interface AccountSim {
  anchor: number;
  hourly: number[];
  /** Utilization accumulated inside the *current* window only. */
  used: number;
  windowIdx: number | null;
  current: WindowSpan | null;
  windows: WindowSpan[];
}

interface SimRun {
  sims: AccountSim[];
  /** Fleet-wide: minutes with no usable account anywhere. */
  blockedWorkMin: number;
  blockedPeakMin: number;
}

function closeWindow(sim: AccountSim): void {
  const current = sim.current;
  if (current === null) return;
  current.endPct = round(sim.used, 2);
  current.blockedMin = round(current.blockedMin, 2);
  sim.windows.push(current);
  sim.current = null;
}

/**
 * Advance an account to the window containing `t`. Crossing a boundary is what
 * a reset *is*: the accumulated utilization goes back to zero.
 */
function rollWindow(sim: AccountSim, t: number): void {
  if (t < sim.anchor) return;
  const idx = Math.floor((t - sim.anchor) / FIVE_HOUR_MS);
  if (sim.windowIdx === idx) return;
  closeWindow(sim);
  sim.windowIdx = idx;
  sim.used = 0;
  const start = sim.anchor + idx * FIVE_HOUR_MS;
  sim.current = { start, end: start + FIVE_HOUR_MS, endPct: 0, exhaustedAt: null, blockedMin: 0 };
}

/**
 * An account is usable only once anchored, and only while its current window
 * has headroom. The first half matters: touching an account *before* its
 * recommended anchor would move the anchor, so the simulation is not allowed to
 * cheat by using capacity the plan has not asked for yet.
 */
function hasRoom(sim: AccountSim, t: number): boolean {
  return t >= sim.anchor && sim.used < FULL_PCT - FULL_EPS;
}

/**
 * Walk the working day in `STEP_MIN` steps.
 *
 * One account is in use at a time; when its window is spent the next account
 * with headroom takes over; only when every account is spent is the user
 * blocked. That is exactly what the app's auto-switch already does, and it is
 * what makes staggered anchors worth anything -- with all anchors identical,
 * every account resets at the same instant and the fleet has one shape instead
 * of several.
 *
 * Only working minutes are simulated. An anchor before work starts therefore
 * consumes nothing until work starts: the anchoring message itself costs a
 * negligible sliver of the window, far below the resolution of anything we can
 * predict, so it is modelled as free.
 */
function runSim(anchors: number[], input: SimInput): SimRun {
  const dayStartMs = finite(input.dayStartMs) ?? 0;
  const tzOffsetMin = finite(input.tzOffsetMin) ?? 0;
  const weight = sanePeakWeight(input.peakWeight);
  const work = spanInterval(input.schedule.work, dayStartMs);
  const peak = resolvePeak(work, input.schedule.peak, dayStartMs);

  const sims: AccountSim[] = anchors.map((anchor, i) => ({
    anchor: finite(anchor) ?? work.startMs,
    hourly: sanitizeHourly(input.profiles[i]),
    used: 0,
    windowIdx: null,
    current: null,
    windows: [],
  }));

  let blockedWorkMin = 0;
  let blockedPeakMin = 0;
  // Sticky selection: the account already in use keeps the work while it can,
  // so the fleet drains one window at a time instead of skimming all of them.
  let inUse = -1;

  for (let t = work.startMs; t < work.endMs; t += STEP_MS) {
    // The last step of an odd-length working day is short; charging it a full
    // STEP_MIN would invent minutes outside the user's own hours.
    const stepMin = Math.min(STEP_MIN, (work.endMs - t) / MINUTE_MS);
    if (stepMin <= 0) break;
    const stepEnd = t + stepMin * MINUTE_MS;

    for (const sim of sims) rollWindow(sim, t);

    let chosen = -1;
    const incumbent = inUse >= 0 ? sims[inUse] : undefined;
    if (incumbent !== undefined && hasRoom(incumbent, t)) {
      chosen = inUse;
    } else {
      let bestRoom = -1;
      for (let i = 0; i < sims.length; i += 1) {
        const sim = sims[i];
        if (sim === undefined || !hasRoom(sim, t)) continue;
        const room = FULL_PCT - sim.used;
        // Strictly greater, so an exact tie keeps the lower slot: determinism
        // beats cleverness in a plan the user reads every morning.
        if (room > bestRoom) {
          bestRoom = room;
          chosen = i;
        }
      }
    }

    if (chosen < 0) {
      blockedWorkMin += stepMin;
      blockedPeakMin += overlapMin(t, stepEnd, peak.interval);
      // Charge the stall to every window that was live for it, so each
      // account's timeline shows the stall it was part of. Accounts not yet
      // anchored have no live window and are correctly charged nothing.
      for (const sim of sims) if (sim.current !== null) sim.current.blockedMin += stepMin;
      continue;
    }

    inUse = chosen;
    const sim = sims[chosen];
    if (sim === undefined) continue;

    // The hour the step begins in. Steps are 5 minutes and hours are 60, so
    // this only rounds at all when the working day starts off-grid.
    const hour = localHourAt(t, tzOffsetMin);
    const demand = (sim.hourly[hour] ?? 0) * (stepMin / MIN_PER_HOUR);
    const before = sim.used;
    sim.used = before + demand;

    const current = sim.current;
    if (current !== null && current.exhaustedAt === null && sim.used >= FULL_PCT - FULL_EPS) {
      // Interpolate inside the step rather than rounding to its edge: the UI
      // draws this instant, and "12:58" is more use than "13:00".
      const fraction = demand > 0 ? (FULL_PCT - before) / demand : 0;
      const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
      current.exhaustedAt = Math.round(t + clamped * stepMin * MINUTE_MS);
    }
  }

  for (const sim of sims) closeWindow(sim);

  return {
    sims,
    blockedWorkMin: round(blockedWorkMin, 2),
    blockedPeakMin: round(blockedPeakMin, 2),
  };
}

/**
 * Simulate the day with one anchor per account.
 *
 * Note what the blocked counters mean: being blocked is a property of the
 * *fleet*, not of one account, so every returned outcome reports the same
 * `blockedWorkMin`, `blockedPeakMin` and `cost`. Per-account detail lives in
 * `windows` -- each `WindowSpan` carries its own `endPct`, `exhaustedAt` and the
 * blocked minutes that fell inside it.
 */
export function simulateFleet(anchors: number[], input: SimInput): PlanOutcome[] {
  const run = runSim(anchors, input);
  const weight = sanePeakWeight(input.peakWeight);
  const cost = round(run.blockedWorkMin + weight * run.blockedPeakMin, 3);
  return run.sims.map((sim) => ({
    anchorAt: sim.anchor,
    windows: sim.windows,
    blockedWorkMin: run.blockedWorkMin,
    blockedPeakMin: run.blockedPeakMin,
    cost,
  }));
}

/**
 * The number the search minimises: blocked working minutes, with blocked peak
 * minutes counted `peakWeight` times over.
 *
 * The maximum, never the sum -- the outcomes all describe the same simulated
 * day, so adding them would multiply one stall by the size of the fleet.
 * Recomputed from the minutes rather than read from `cost`, so a caller can
 * score an existing outcome under a different weight.
 */
export function fleetCost(outcomes: PlanOutcome[], peakWeight: number): number {
  const weight = sanePeakWeight(peakWeight);
  let worst = 0;
  for (const outcome of outcomes) {
    const work = finite(outcome.blockedWorkMin) ?? 0;
    const peak = finite(outcome.blockedPeakMin) ?? 0;
    const cost = work + weight * peak;
    if (cost > worst) worst = cost;
  }
  return round(worst, 3);
}

/**
 * Every anchor worth trying: `STEP_MIN` apart, from six hours before work
 * starts to the end of the peak, clamped to the planned day. Later anchors than
 * that are strictly worse -- they withhold an account through the very hours the
 * plan is protecting. Around 150-250 candidates, so the search is exhaustive
 * rather than clever.
 */
export function candidateAnchors(input: SimInput): number[] {
  const dayStartMs = finite(input.dayStartMs) ?? 0;
  const work = spanInterval(input.schedule.work, dayStartMs);
  const peak = resolvePeak(work, input.schedule.peak, dayStartMs);

  const earliest = Math.max(dayStartMs, work.startMs - ANCHOR_LOOKBACK_MIN * MINUTE_MS);
  const latest = Math.max(earliest, peak.outside ? work.endMs : peak.interval.endMs);

  const seen = new Set<number>();
  for (let t = earliest; t <= latest; t += STEP_MS) seen.add(t);
  // The start of work is the baseline anchor, so it is always a candidate even
  // when the grid steps past it on a working day that starts off-grid.
  if (work.startMs >= earliest && work.startMs <= latest) seen.add(work.startMs);
  if (seen.size === 0) seen.add(work.startMs);

  return [...seen].sort((a, b) => a - b);
}

/**
 * Coordinate descent over the anchors: start every account at the baseline,
 * then repeatedly re-optimise one account exhaustively with the others held
 * fixed, until a pass stops improving or the cap is hit. With one account a
 * single pass already *is* the exhaustive search.
 *
 * Deterministic by construction -- candidates ascend, ties resolve one way, and
 * `Math.random` appears nowhere.
 */
function optimizeAnchors(
  input: SimInput,
  candidates: number[],
  accountCount: number,
  maxPasses: number,
): { anchors: number[]; cost: number } {
  const dayStartMs = finite(input.dayStartMs) ?? 0;
  const workStart = spanInterval(input.schedule.work, dayStartMs).startMs;
  const weight = sanePeakWeight(input.peakWeight);

  const anchors = new Array<number>(accountCount).fill(workStart);
  let cost = fleetCost(simulateFleet(anchors, input), weight);

  const passes = accountCount <= 1 ? 1 : Math.max(1, maxPasses);
  for (let pass = 0; pass < passes; pass += 1) {
    let improved = false;

    for (let i = 0; i < accountCount; i += 1) {
      const trial = [...anchors];
      let bestAnchor = anchors[i] ?? workStart;
      let bestCost = cost;

      for (const candidate of candidates) {
        trial[i] = candidate;
        const trialCost = fleetCost(simulateFleet(trial, input), weight);
        // `<=` over ascending candidates resolves a tie toward the *later*
        // anchor: a plan that asks the user to start earlier than the numbers
        // require is a worse plan, however equal its score.
        if (trialCost <= bestCost + COST_EPS) {
          if (trialCost < bestCost - COST_EPS) improved = true;
          bestCost = Math.min(bestCost, trialCost);
          bestAnchor = candidate;
        }
      }

      anchors[i] = bestAnchor;
      cost = bestCost;
    }

    if (!improved) break;
  }

  return { anchors, cost };
}

const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

/** `HH:MM` in the user's local clock. */
function hhmm(ms: number, tzOffsetMin: number): string {
  const shifted = ms + tzOffsetMin * MINUTE_MS;
  const intoDay = ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
  const minutes = Math.floor(intoDay / MINUTE_MS);
  const hh = Math.floor(minutes / MIN_PER_HOUR);
  const mm = minutes % MIN_PER_HOUR;
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Minutes, rendered the way a person would say them. */
function minutesText(value: number): string {
  const rounded = Math.round(value);
  return `${rounded} minute${rounded === 1 ? '' : 's'}`;
}

function zeroOutcome(anchorAt: number): PlanOutcome {
  return { anchorAt, windows: [], blockedWorkMin: 0, blockedPeakMin: 0, cost: 0 };
}

/** Blocked minutes charged to one account's own windows. */
function blockedInWindows(windows: WindowSpan[]): number {
  let total = 0;
  for (const window of windows) total += finite(window.blockedMin) ?? 0;
  return total;
}

/**
 * Plan one local day.
 *
 * The plan must beat "just start working" to be worth showing, so the baseline
 * -- every account anchored at the start of work -- is simulated too, and when
 * nothing beats it the recommendation *is* the baseline and the rationale says
 * as much. That matters more than it sounds: with a flat or empty profile
 * nothing is ever blocked, every anchor ties, and a planner that resolved that
 * tie into advice would be telling the user to delay their morning for nothing.
 */
export function planDay(input: PlanInput): SessionPlan {
  const dayStartMs = finite(input.dayStartMs) ?? 0;
  const tzOffsetMin = finite(input.tzOffsetMin) ?? 0;
  const weight = sanePeakWeight(input.peakWeight);
  const schedule = input.schedule;
  // Schedules and account lists arrive from a settings file, so they are read
  // defensively: a malformed blob should produce a poor plan, not a crash in
  // the main process.
  const accounts = Array.isArray(input.accounts) ? input.accounts : [];
  const scheduleDays = Array.isArray(schedule.days) ? schedule.days : [];
  const maxPasses = finite(input.maxPasses) ?? DEFAULT_MAX_PASSES;

  const sim: SimInput = {
    dayStartMs,
    schedule,
    profiles: accounts.map((a) => a.profile ?? emptyProfile()),
    peakWeight: weight,
    tzOffsetMin,
  };

  const work = spanInterval(schedule.work, dayStartMs);
  const peak = resolvePeak(work, schedule.peak, dayStartMs);
  const rawPeak = spanInterval(schedule.peak, dayStartMs);
  const day = localDayKey(dayStartMs, tzOffsetMin);
  const weekday = localWeekday(dayStartMs, tzOffsetMin);
  /** The plan's clock is fixed, so every time in the prose reads the same way. */
  const at = (ms: number): string => hhmm(ms, tzOffsetMin);

  // The profile the plan was scored against. Per-account curves are normally
  // the same fleet-wide curve, so the first one is the plan's own model.
  const profile = accounts[0]?.profile ?? emptyProfile();
  let weakest = profile.confidence;
  for (const account of accounts) {
    const c = finite(account.profile?.confidence) ?? 0;
    if (c < weakest) weakest = c;
  }
  const lowConfidence = (finite(weakest) ?? 0) < MIN_ACTIONABLE_CONFIDENCE;
  const usingDefaultSchedule = input.scheduleConfigured !== true;

  const caveats: string[] = [];
  if (usingDefaultSchedule) {
    caveats.push(
      `These are ClaudeDeck's default hours (${at(work.startMs)}-${at(work.endMs)}), not hours you confirmed -- set your own and the plan gets sharper.`,
    );
  }
  if (lowConfidence) {
    const observedHours = (Array.isArray(profile.samples) ? profile.samples : []).filter(
      (s) => s > 0,
    ).length;
    const observedDays = (Array.isArray(profile.days) ? profile.days : []).length;
    caveats.push(
      observedHours === 0
        ? 'There is no recorded usage to learn from yet, so this day was simulated from a placeholder load -- it will sharpen once ClaudeDeck has watched you work.'
        : `History is thin -- ${observedHours} hour${observedHours === 1 ? '' : 's'} of the day observed across ${observedDays} day${observedDays === 1 ? '' : 's'} -- so treat this schedule as a guess, not a measurement.`,
    );
  }
  if (peak.outside) {
    caveats.push(
      `Your peak ${at(rawPeak.startMs)}-${at(rawPeak.endMs)} falls outside working hours ${at(work.startMs)}-${at(work.endMs)}, so it was left out of the scoring.`,
    );
  } else if (peak.clamped) {
    caveats.push(
      `Your peak was trimmed to the part inside working hours, ${at(peak.interval.startMs)}-${at(peak.interval.endMs)}.`,
    );
  }
  if (!scheduleDays.includes(weekday)) {
    const label = (schedule.label ?? '').trim() === '' ? 'this schedule' : `"${schedule.label}"`;
    caveats.push(
      `${WEEKDAY_NAMES[weekday] ?? 'This day'} is not a working day in ${label}, so it was planned as if it were.`,
    );
  }

  // No accounts: every working minute is blocked, and no anchor can change that.
  // Reported honestly rather than as a tidy empty plan.
  if (accounts.length === 0) {
    const run = runSim([], sim);
    const baseline: PlanOutcome = {
      anchorAt: work.startMs,
      windows: [],
      blockedWorkMin: run.blockedWorkMin,
      blockedPeakMin: run.blockedPeakMin,
      cost: round(run.blockedWorkMin + weight * run.blockedPeakMin, 3),
    };
    const rationale = [
      'No accounts are set up, so there is no first message to place.',
      `All ${minutesText(run.blockedWorkMin)} of the working day would be blocked; add an account and the planner can anchor it.`,
      ...caveats,
    ];
    return {
      day,
      schedule,
      profile,
      accounts: [],
      baseline,
      peakMinutesSaved: 0,
      rationale: rationale.slice(0, 5),
      lowConfidence,
      usingDefaultSchedule,
    };
  }

  const baselineAnchors = accounts.map(() => work.startMs);
  const baselineOutcomes = simulateFleet(baselineAnchors, sim);
  const baseline = baselineOutcomes[0] ?? zeroOutcome(work.startMs);
  const baselineCost = fleetCost(baselineOutcomes, weight);

  const best = optimizeAnchors(sim, candidateAnchors(sim), accounts.length, maxPasses);
  const beatsBaseline = best.cost < baselineCost - COST_EPS;
  const anchors = beatsBaseline ? best.anchors : baselineAnchors;
  const outcomes = beatsBaseline ? simulateFleet(anchors, sim) : baselineOutcomes;

  const planned = outcomes[0] ?? baseline;
  const peakMinutesSaved = Math.max(0, round(baseline.blockedPeakMin - planned.blockedPeakMin, 2));

  const accountPlans: AccountPlan[] = accounts.map((account, i) => {
    const outcome = outcomes[i] ?? zeroOutcome(anchors[i] ?? work.startMs);
    const anchorAt = outcome.anchorAt;
    const resets = outcome.windows
      .map((w) => w.end)
      .slice(0, 2)
      .map((end) => at(end));
    const stalled = blockedInWindows(outcome.windows);
    const note = beatsBaseline
      ? `Anchor at ${at(anchorAt)}${resets.length > 0 ? `, resetting ${resets.join(' and ')}` : ''}; ${minutesText(stalled)} blocked inside its windows.`
      : `Nothing to do differently: start slot ${account.slot} whenever you start, around ${at(anchorAt)}.`;
    return { slot: account.slot, email: account.email, alias: account.alias, outcome, note };
  });

  const totalDemand = sim.profiles.reduce(
    (sum, p) => sum + sanitizeHourly(p).reduce((a, b) => a + b, 0),
    0,
  );

  const rationale: string[] = [];
  if (totalDemand <= 0) {
    rationale.push(
      'Your history shows no quota being burned on a day like this, so anchoring changes nothing today.',
    );
  } else if (!beatsBaseline && baseline.blockedWorkMin <= 0) {
    rationale.push(
      `Today's predicted load fits inside the windows you get anyway, so anchoring changes nothing -- just start at ${at(work.startMs)}.`,
    );
  } else if (!beatsBaseline) {
    rationale.push(
      `No anchor beats simply starting at ${at(work.startMs)}: ${minutesText(baseline.blockedWorkMin)} come out blocked either way, and pretending otherwise would not help.`,
    );
  } else {
    for (const plan of accountPlans.slice(0, 2)) {
      const anchorAt = plan.outcome.anchorAt;
      const resetAt = anchorAt + FIVE_HOUR_MS;
      const intoPeak =
        !peak.outside && resetAt >= peak.interval.startMs && resetAt < peak.interval.endMs;
      rationale.push(
        intoPeak
          ? `Anchoring slot ${plan.slot} at ${at(anchorAt)} puts its reset at ${at(resetAt)} -- inside your ${at(peak.interval.startMs)}-${at(peak.interval.endMs)} peak, where it would otherwise have run dry.`
          : `Anchoring slot ${plan.slot} at ${at(anchorAt)} puts its reset at ${at(resetAt)}, keeping a fresh window over the rest of the working day.`,
      );
    }
  }

  // Peak minutes are the headline, but when the peak was dropped or was never
  // the binding constraint, saved *working* minutes are the real result and
  // reporting "no change" would undersell a plan that did help.
  const workMinutesSaved = Math.max(0, round(baseline.blockedWorkMin - planned.blockedWorkMin, 2));
  rationale.push(
    peakMinutesSaved > 0
      ? `Predicted blocked peak minutes: ${Math.round(planned.blockedPeakMin)}, down from ${Math.round(baseline.blockedPeakMin)} with no anchoring.`
      : workMinutesSaved > 0
        ? `Predicted blocked working minutes: ${Math.round(planned.blockedWorkMin)}, down from ${Math.round(baseline.blockedWorkMin)} with no anchoring.`
        : `Predicted blocked peak minutes: ${Math.round(planned.blockedPeakMin)}, the same as with no anchoring.`,
  );
  rationale.push(...caveats);

  return {
    day,
    schedule,
    profile,
    accounts: accountPlans,
    baseline,
    peakMinutesSaved,
    rationale: rationale.slice(0, 5),
    lowConfidence,
    usingDefaultSchedule,
  };
}
