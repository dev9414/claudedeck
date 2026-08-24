/**
 * Learning *when* the user burns quota.
 *
 * The 5-hour window is anchored by the first message of a session, so placing
 * that anchor well requires knowing which hours of the day actually spend
 * quota. This module turns recorded history into a per-local-hour demand curve:
 * utilization points gained during each hour of a typical active day.
 *
 * Pure, like the rest of `src/core`: no I/O, no ambient clock, no ambient
 * timezone. `now` and `tzOffsetMin` are always parameters, which is also what
 * makes the whole thing testable at an arbitrary instant in an arbitrary zone.
 *
 * Every number here is an estimate and the types say so: `samples` travels with
 * the curve and `confidence` is deliberately unforgiving, because a plan built
 * on one afternoon of data must not look like a plan built on a month of it.
 */

import { FIVE_HOUR_MS } from '@shared/types';
import type { DaySpan, HistoryPoint, UsageProfile, Weekday } from '@shared/types';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const HOURS_PER_DAY = 24;
const MIN_PER_HOUR = 60;
const MIN_PER_DAY = 1440;

/** The only window whose anchor the user controls, and so the only one profiled. */
export const PLANNER_WINDOW_KEY = '5h';

/**
 * Default history depth: long enough to see a week's shape, short enough to
 * forget a routine the user has already moved on from.
 */
export const DEFAULT_LOOKBACK_DAYS = 21;

/**
 * Utilization is monotonic inside a window, so any decrease larger than this
 * means the window rolled over. One point of slack absorbs API rounding -- the
 * same allowance `forecast.ts` makes for the same reason.
 */
const DROP_EPSILON_PCT = 1;

/**
 * An interval can only be sliced across so many hours before the input is
 * malformed rather than long. Two points inside one window are at most 5h
 * apart, so 26 slices is pure belt-and-braces against a bogus `resets` value
 * pinning two far-apart points into a single segment.
 */
const MAX_SLICES = 26;

/**
 * Fraction of an hour that must be observed before that hour's gain counts.
 * Below this the sample is a sliver, and scaling a sliver up to a full hour
 * invents a burn rate. At or above it, gain *is* normalized to a full hour, so
 * partial coverage no longer understates a busy hour.
 */
const MIN_HOUR_COVERAGE = 0.4;

/** Hours of the day observed at which the coverage term of confidence saturates. */
const CONFIDENT_HOURS = 8;
/** Distinct active days at which the days term saturates. */
const CONFIDENT_DAYS = 5;
/** Observation span at which the span term saturates. */
const CONFIDENT_SPAN_MS = 7 * DAY_MS;

/**
 * Below this a profile is worth showing but not worth presenting as fact. The
 * planner turns it into `SessionPlan.lowConfidence` and says so in words.
 */
export const MIN_ACTIONABLE_CONFIDENCE = 0.35;

export interface ProfileOptions {
  /** One account, or all of them summed into one demand curve when omitted. */
  slot?: number;
  /** Restrict to these local weekdays: a working day's routine is not a weekend's. */
  days?: Weekday[];
  /** Minutes to add to UTC to get the user's local time. */
  tzOffsetMin?: number;
  /** Ignore points older than this many days. */
  lookbackDays?: number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

const round = (v: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(v * factor) / factor;
};

/** `value` when it is a usable number, else null. Index reads are `T | undefined` here. */
function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The instant shifted so that the UTC accessors read as local time. Doing the
 * shift once and then using `getUTC*` keeps this module independent of the
 * host's zone, which is the only way a pure function can talk about "the user's
 * 9am" at all.
 */
function shift(t: number, tzOffsetMin: number): number {
  return t + tzOffsetMin * MINUTE_MS;
}

/** Floor-mod, so instants before the epoch cannot produce a negative hour. */
function msIntoLocalDay(t: number, tzOffsetMin: number): number {
  const shifted = shift(t, tzOffsetMin);
  return ((shifted % DAY_MS) + DAY_MS) % DAY_MS;
}

/** Local hour of the day, 0-23. */
export function localHourAt(t: number, tzOffsetMin: number): number {
  if (!Number.isFinite(t)) return 0;
  return Math.floor(msIntoLocalDay(t, tzOffsetMin) / HOUR_MS);
}

/** Index of the local day, so two instants can be compared for "same day" cheaply. */
export function localDayIndex(t: number, tzOffsetMin: number): number {
  return Math.floor(shift(t, tzOffsetMin) / DAY_MS);
}

/** Local calendar day as `YYYY-MM-DD`. */
export function localDayKey(t: number, tzOffsetMin: number): string {
  if (!Number.isFinite(t)) return '1970-01-01';
  return new Date(shift(t, tzOffsetMin)).toISOString().slice(0, 10);
}

/*
 * `localWeekday`, `normalizeMinute` and `spanLengthMin` live in `./schedule`,
 * which owns the meaning of a `DaySpan`. They are re-exported here because this
 * module's own callers and tests reach for them alongside the profile helpers,
 * and one implementation that two modules share cannot drift from itself.
 */
import { localWeekday, normalizeMinute, spanLengthMin } from './schedule';

export { localWeekday, normalizeMinute, spanLengthMin };

/** All zeros, no observations, no confidence: the honest answer to "no data". */
export function emptyProfile(): UsageProfile {
  return {
    hourly: new Array<number>(HOURS_PER_DAY).fill(0),
    samples: new Array<number>(HOURS_PER_DAY).fill(0),
    confidence: 0,
    days: [],
  };
}

/** Which signal says a window boundary sits between two consecutive points. */
export type BoundarySignal = 'reset' | 'anchor' | 'drop' | 'gap' | 'slot';

/**
 * The boundary test, ordered by how much each signal deserves to be trusted.
 *
 * - `reset`: both points report the window's reset instant and they disagree.
 *   The reset instant *is* the window's identity, so this is never second
 *   guessed -- and an *unchanged* reset instant likewise outranks every
 *   heuristic below, even across a long silence.
 * - `anchor`: only one point knows its reset instant. Since the anchor is
 *   `resetsAt - 5h`, the other point can still be placed inside or outside that
 *   span with certainty.
 * - `drop` / `gap`: points recorded before this feature existed carry no
 *   `resets` at all, so a fall in utilization is the boundary, and a silence
 *   longer than the window itself must contain one.
 * - `slot`: two accounts never share a window. Callers are expected to pass one
 *   slot at a time; this is the safety net for when they do not.
 */
export function boundarySignal(
  prev: HistoryPoint,
  cur: HistoryPoint,
  windowKey: string,
): BoundarySignal | null {
  if (prev.slot !== cur.slot) return 'slot';

  const prevReset = finite(prev.resets?.[windowKey]);
  const curReset = finite(cur.resets?.[windowKey]);
  if (prevReset !== null && curReset !== null) return prevReset === curReset ? null : 'reset';
  if (curReset !== null && prev.t < curReset - FIVE_HOUR_MS) return 'anchor';
  if (prevReset !== null && cur.t >= prevReset) return 'anchor';

  const prevPct = finite(prev.windows[windowKey]);
  const curPct = finite(cur.windows[windowKey]);
  if (prevPct !== null && curPct !== null && prevPct - curPct > DROP_EPSILON_PCT) return 'drop';
  if (cur.t - prev.t > FIVE_HOUR_MS) return 'gap';

  return null;
}

/**
 * Split a window's series into runs belonging to the same 5-hour window, oldest
 * first. Deltas may only be taken *within* a segment: across a boundary the
 * utilization cliff is a reset, not a refund.
 *
 * Pass one slot's points at a time. Interleaved slots are shredded into
 * single-point segments by the `slot` signal -- odd-looking, but never wrong.
 */
export function segmentByWindow(points: HistoryPoint[], windowKey: string): HistoryPoint[][] {
  const usable = points
    .filter((p) => Number.isFinite(p.t) && finite(p.windows[windowKey]) !== null)
    .sort((a, b) => a.t - b.t || a.slot - b.slot);

  const segments: HistoryPoint[][] = [];
  let current: HistoryPoint[] = [];
  for (const point of usable) {
    const prev = current[current.length - 1];
    if (prev !== undefined && boundarySignal(prev, point, windowKey) !== null) {
      segments.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/** Per local day: what was gained in each hour, and how much of each hour we watched. */
interface DayBucket {
  weekday: Weekday;
  /** Utilization points gained across the whole day. Zero means an idle day. */
  total: number;
  gain: number[];
  coveredMs: number[];
  observations: number[];
}

function newDayBucket(weekday: Weekday): DayBucket {
  return {
    weekday,
    total: 0,
    gain: new Array<number>(HOURS_PER_DAY).fill(0),
    coveredMs: new Array<number>(HOURS_PER_DAY).fill(0),
    observations: new Array<number>(HOURS_PER_DAY).fill(0),
  };
}

/** Start of the local hour after the one containing `t`, back in epoch terms. */
function nextLocalHourStart(t: number, tzOffsetMin: number): number {
  const shifted = shift(t, tzOffsetMin);
  return (Math.floor(shifted / HOUR_MS) + 1) * HOUR_MS - tzOffsetMin * MINUTE_MS;
}

/**
 * Attribute one interval's utilization gain to the local hours it spans,
 * pro-rata by the time spent in each. An interval straddling 10:50-11:10 says
 * as much about hour 10 as about hour 11, and splitting it is the only way a
 * 5-minute poll cadence and a 30-minute one produce the same curve.
 */
function attributeInterval(
  buckets: Map<number, DayBucket>,
  from: number,
  to: number,
  delta: number,
  tzOffsetMin: number,
  allowedDays: Set<Weekday> | null,
): void {
  const dt = to - from;
  if (dt <= 0) return;

  let cursor = from;
  for (let slice = 0; slice < MAX_SLICES && cursor < to; slice += 1) {
    const sliceEnd = Math.min(nextLocalHourStart(cursor, tzOffsetMin), to);
    const sliceMs = sliceEnd - cursor;
    if (sliceMs <= 0) break;

    const weekday = localWeekday(cursor, tzOffsetMin);
    if (allowedDays === null || allowedDays.has(weekday)) {
      const dayIndex = localDayIndex(cursor, tzOffsetMin);
      let bucket = buckets.get(dayIndex);
      if (bucket === undefined) {
        bucket = newDayBucket(weekday);
        buckets.set(dayIndex, bucket);
      }
      const hour = localHourAt(cursor, tzOffsetMin);
      const share = delta * (sliceMs / dt);
      bucket.gain[hour] = (bucket.gain[hour] ?? 0) + share;
      bucket.coveredMs[hour] = (bucket.coveredMs[hour] ?? 0) + sliceMs;
      // A zero-gain interval is still an observation: it is the evidence that
      // this hour is *quiet*, and the mean needs it to stay honest.
      bucket.observations[hour] = (bucket.observations[hour] ?? 0) + 1;
      bucket.total += share;
    }
    cursor = sliceEnd;
  }
}

/**
 * Build the hourly demand curve from recorded history.
 *
 * `hourly[h]` is the mean utilization gained during local hour `h` on a day
 * that had *any* activity. Idle days are excluded deliberately: averaging in
 * weekends the user never worked would flatten the curve until every anchor
 * looked equally good, which is precisely the useless advice this planner
 * exists to avoid.
 */
export function buildProfile(
  points: HistoryPoint[],
  now: number,
  opts: ProfileOptions = {},
): UsageProfile {
  const tzOffsetMin = finite(opts.tzOffsetMin) ?? 0;
  const lookbackDays = finite(opts.lookbackDays) ?? DEFAULT_LOOKBACK_DAYS;
  const nowMs = finite(now);
  if (nowMs === null) return emptyProfile();

  const floor = nowMs - Math.max(0, lookbackDays) * DAY_MS;
  const allowedDays = opts.days === undefined ? null : new Set<Weekday>(opts.days);
  const wantSlot = finite(opts.slot);

  // Points from the future are clock skew, not data.
  const usable = points.filter(
    (p) =>
      Number.isFinite(p.t) &&
      p.t >= floor &&
      p.t <= nowMs &&
      (wantSlot === null || p.slot === wantSlot),
  );
  if (usable.length === 0) return emptyProfile();

  // One account's series at a time, because a delta between two accounts'
  // utilization is meaningless. With `slot` omitted the gains still land in the
  // same buckets, which is what the planner wants: the *demand* the fleet saw,
  // since whichever account is active absorbs all of it.
  const bySlot = new Map<number, HistoryPoint[]>();
  for (const point of usable) {
    const list = bySlot.get(point.slot);
    if (list === undefined) bySlot.set(point.slot, [point]);
    else list.push(point);
  }

  const buckets = new Map<number, DayBucket>();
  let firstT = Number.POSITIVE_INFINITY;
  let lastT = Number.NEGATIVE_INFINITY;

  for (const slotPoints of bySlot.values()) {
    for (const segment of segmentByWindow(slotPoints, PLANNER_WINDOW_KEY)) {
      for (let i = 1; i < segment.length; i += 1) {
        const prev = segment[i - 1];
        const cur = segment[i];
        if (prev === undefined || cur === undefined) continue;
        const prevPct = finite(prev.windows[PLANNER_WINDOW_KEY]);
        const curPct = finite(cur.windows[PLANNER_WINDOW_KEY]);
        if (prevPct === null || curPct === null) continue;

        // Inside a segment a fall is polling noise or rounding, never a refund.
        const delta = Math.max(0, curPct - prevPct);
        attributeInterval(buckets, prev.t, cur.t, delta, tzOffsetMin, allowedDays);
        if (prev.t < firstT) firstT = prev.t;
        if (cur.t > lastT) lastT = cur.t;
      }
    }
  }

  const activeDays = [...buckets.values()].filter((d) => d.total > 0);
  if (activeDays.length === 0) return emptyProfile();

  const hourly = new Array<number>(HOURS_PER_DAY).fill(0);
  const samples = new Array<number>(HOURS_PER_DAY).fill(0);
  let hoursCovered = 0;

  for (let hour = 0; hour < HOURS_PER_DAY; hour += 1) {
    let sum = 0;
    let days = 0;
    let observations = 0;
    for (const day of activeDays) {
      observations += day.observations[hour] ?? 0;
      const covered = day.coveredMs[hour] ?? 0;
      if (covered < MIN_HOUR_COVERAGE * HOUR_MS) continue;
      // Normalize to a whole hour, so a half-watched hour is not read as half as
      // busy. Capped at one hour, so several accounts polled in parallel sum to
      // the fleet's demand instead of diluting it.
      sum += ((day.gain[hour] ?? 0) * HOUR_MS) / Math.min(covered, HOUR_MS);
      days += 1;
    }
    samples[hour] = observations;
    // Days that never watched this hour are left out of the mean entirely --
    // counting them as zero would report an hour as idle on no evidence.
    if (days > 0) {
      hourly[hour] = round(sum / days, 3);
      hoursCovered += 1;
    }
  }

  const spanMs = lastT > firstT ? lastT - firstT : 0;
  const weekdays = [...new Set(activeDays.map((d) => d.weekday))].sort((a, b) => a - b);

  // Three independent reasons to disbelieve a profile. Hours-of-the-day coverage
  // multiplies, because a curve that has never seen your afternoon cannot plan
  // it. Days and span are averaged rather than multiplied: they measure nearly
  // the same thing, and multiplying both would sink even an honest week of data.
  // One busy day therefore lands near 0.15 -- real, but well under
  // MIN_ACTIONABLE_CONFIDENCE, which is the point.
  const hoursTerm = clamp01(hoursCovered / CONFIDENT_HOURS);
  const daysTerm = clamp01(activeDays.length / CONFIDENT_DAYS);
  const spanTerm = clamp01(spanMs / CONFIDENT_SPAN_MS);
  const confidence = round(hoursTerm * (daysTerm + spanTerm) * 0.5, 3);

  return { hourly, samples, confidence, days: weekdays };
}

/**
 * Cold-start curve: a flat burn across the working day, zero outside it.
 *
 * Day one has no history, and a planner that returns nothing on day one is a
 * planner nobody comes back to on day two. `confidence` is 0 and `samples` is
 * all zeros, so every consumer can see this for the placeholder it is.
 */
export function flatProfile(pctPerWorkingHour: number, work: DaySpan): UsageProfile {
  const profile = emptyProfile();
  const rate = finite(pctPerWorkingHour);
  if (rate === null || rate <= 0) return profile;

  const start = normalizeMinute(work.start);
  const length = spanLengthMin(work);
  // Minute by minute, so an hour the working day only half covers gets half the
  // rate: a 09:30 start must not bill the whole of hour 9.
  for (let m = 0; m < length; m += 1) {
    const hour = Math.floor(((start + m) % MIN_PER_DAY) / MIN_PER_HOUR);
    profile.hourly[hour] = (profile.hourly[hour] ?? 0) + rate / MIN_PER_HOUR;
  }
  profile.hourly = profile.hourly.map((v) => round(v, 3));
  return profile;
}
