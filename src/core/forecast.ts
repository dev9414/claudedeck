/**
 * Quota forecasting: burn rate, exhaustion projection, and pace comparison.
 *
 * Pure math over the time series `history.ts` records -- no I/O, no ambient
 * clock, `now` is always a parameter. Everything here is an *estimate*, and the
 * types are built so the UI can say so: `confidence` travels with every fit and
 * `exhaustionAt` is null whenever the numbers do not support naming an instant.
 * We would rather show "not enough data yet" than a precise-looking lie.
 */

import type { BurnRate, Forecast, HistoryPoint, UsageWindow } from '@shared/types';

/** One utilization observation of a single window. */
export interface Sample {
  /** Epoch ms. */
  t: number;
  /** Utilization 0-100 at `t`. */
  pct: number;
}

export interface FitOptions {
  /** Trailing span to fit over. Older samples are ignored entirely. */
  lookbackMs?: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Trailing span the fit considers. Six hours covers a whole 5h window plus a
 * little, and for the 7d windows it answers the question the user is actually
 * asking -- "at the rate I am going *now*" -- rather than averaging in a
 * weekend of idleness.
 */
export const DEFAULT_LOOKBACK_MS = 6 * HOUR_MS;

/**
 * Utilization is monotonic inside a window, so any decrease larger than this
 * means the window rolled over. One point of slack absorbs API rounding.
 */
const RESET_DROP_PCT = 1;

/** Sample count at which the count term of confidence saturates. */
const CONFIDENT_SAMPLES = 6;
/** Time span at which the span term of confidence saturates. */
const CONFIDENT_SPAN_MS = 45 * 60_000;
/** Residual RMSE (in utilization points) at which the fit term halves. */
const RMSE_HALF_LIFE = 2.5;
/** Silence after which a fit is too stale to trust at all. */
const STALENESS_LIMIT_MS = 2 * HOUR_MS;

/** Below this confidence we refuse to name an exhaustion instant. */
export const MIN_PROJECTION_CONFIDENCE = 0.35;
/** A slope under this is polling noise, not a trend. */
const MIN_PROJECTION_SLOPE = 0.05;
/** Linear extrapolation past a month is arithmetic, not a forecast. */
const MAX_PROJECTION_HOURS = 24 * 30;

/** Absolute floor for "meaningfully" ahead of pace, in utilization points. */
const PACE_MARGIN_MIN = 5;
/** Additional relative slack, so late-window noise does not trip the flag. */
const PACE_MARGIN_FRACTION = 0.15;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const round = (v: number, places: number): number => {
  const factor = 10 ** places;
  return Math.round(v * factor) / factor;
};

function parseInstant(iso: string | undefined): number | null {
  if (iso === undefined) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * The samples since the most recent window reset. Fitting across a reset would
 * average a cliff into the slope and report a burn rate nobody is burning.
 */
function currentSegment(ascending: Sample[]): Sample[] {
  let start = 0;
  for (let i = 1; i < ascending.length; i += 1) {
    const prev = ascending[i - 1];
    const cur = ascending[i];
    if (prev === undefined || cur === undefined) continue;
    if (prev.pct - cur.pct > RESET_DROP_PCT) start = i;
  }
  return ascending.slice(start);
}

/**
 * Least-squares slope in utilization points per hour over the trailing window,
 * fitted only to the samples since the last reset.
 */
export function burnRate(points: Sample[], now: number, opts: FitOptions = {}): BurnRate {
  const lookbackMs = opts.lookbackMs ?? DEFAULT_LOOKBACK_MS;
  if (!Number.isFinite(now)) return { pctPerHour: 0, samples: 0, confidence: 0 };

  const windowStart = now - lookbackMs;
  const usable = points
    .filter(
      (p) =>
        Number.isFinite(p.t) &&
        Number.isFinite(p.pct) &&
        p.t >= windowStart &&
        // Samples from the future are clock skew, not data.
        p.t <= now,
    )
    .sort((a, b) => a.t - b.t);

  const segment = currentSegment(usable);
  const n = segment.length;
  const first = segment[0];
  const last = segment[n - 1];
  if (n < 2 || first === undefined || last === undefined) {
    return { pctPerHour: 0, samples: n, confidence: 0 };
  }

  const spanMs = last.t - first.t;
  if (spanMs <= 0) return { pctPerHour: 0, samples: n, confidence: 0 };

  // x in hours from the first sample, so the slope is already pct/hour.
  const xs = segment.map((p) => (p.t - first.t) / HOUR_MS);
  const ys = segment.map((p) => p.pct);
  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i += 1) {
    sumX += xs[i] ?? 0;
    sumY += ys[i] ?? 0;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - meanX;
    sxx += dx * dx;
    sxy += dx * ((ys[i] ?? 0) - meanY);
  }
  if (sxx <= 0) return { pctPerHour: 0, samples: n, confidence: 0 };

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let sumSquaredResiduals = 0;
  for (let i = 0; i < n; i += 1) {
    const residual = (ys[i] ?? 0) - (intercept + slope * (xs[i] ?? 0));
    sumSquaredResiduals += residual * residual;
  }
  const rmse = Math.sqrt(sumSquaredResiduals / n);

  // Four independent reasons to disbelieve a fit, multiplied so any one of them
  // can sink it: too few samples, too short a span, a poor fit, or stale data.
  // Two points an hour apart therefore lands near 0.2 -- a real number, but far
  // below the bar for stating a timestamp.
  const countTerm = clamp01((n - 1) / (CONFIDENT_SAMPLES - 1));
  const spanTerm = clamp01(spanMs / CONFIDENT_SPAN_MS);
  const fitTerm = RMSE_HALF_LIFE / (RMSE_HALF_LIFE + rmse);
  const freshTerm = clamp01(1 - (now - last.t) / STALENESS_LIMIT_MS);

  return {
    pctPerHour: round(slope, 3),
    samples: n,
    confidence: round(clamp01(countTerm * spanTerm * fitTerm * freshTerm), 3),
  };
}

/**
 * Length of a rate-limit window by key. `5h` and `7d` are the documented
 * windows; per-model scoped limits are weekly, so weekly is also the fallback.
 */
export function windowLengthMs(key: string): number {
  switch (key.trim().toLowerCase()) {
    case '5h':
      return 5 * HOUR_MS;
    case '7d':
      return 7 * DAY_MS;
    case 'spend':
      return 30 * DAY_MS;
    default:
      return 7 * DAY_MS;
  }
}

/**
 * Where utilization would sit right now if the window's budget were spread
 * evenly across it. Undefined when the API gave us no reset instant, since
 * without one we cannot tell how far into the window we are.
 */
export function expectedPace(window: UsageWindow, now: number): number | undefined {
  const resetsAt = parseInstant(window.resetsAt);
  if (resetsAt === null || !Number.isFinite(now)) return undefined;
  // A reset in the past means the snapshot predates a rollover; the honest
  // answer is "unknown", not a pace computed from stale numbers.
  if (now > resetsAt) return undefined;

  const length = windowLengthMs(window.key);
  const elapsed = clamp01((now - (resetsAt - length)) / length);
  return round(elapsed * 100, 1);
}

/** Slack above `expectedPct` before usage counts as meaningfully ahead. */
function paceMargin(expectedPct: number): number {
  return Math.max(PACE_MARGIN_MIN, expectedPct * PACE_MARGIN_FRACTION);
}

function projectExhaustion(pct: number, burn: BurnRate, now: number): string | null {
  // Already spent: an observation, not a projection, so confidence is moot.
  if (pct >= 100) return new Date(now).toISOString();
  if (burn.pctPerHour < MIN_PROJECTION_SLOPE) return null;
  if (burn.confidence < MIN_PROJECTION_CONFIDENCE) return null;

  const hours = (100 - pct) / burn.pctPerHour;
  if (!Number.isFinite(hours) || hours < 0 || hours > MAX_PROJECTION_HOURS) return null;
  return new Date(now + hours * HOUR_MS).toISOString();
}

/** Forecast one window from its live snapshot plus that window's history. */
export function forecast(
  window: UsageWindow,
  points: Sample[],
  now: number,
  opts: FitOptions = {},
): Forecast {
  const burn = burnRate(points, now, opts);

  // The live snapshot is newer than anything on disk, so it wins as the
  // starting point; history only supplies the slope.
  const latest = points.reduce<Sample | null>(
    (best, p) =>
      Number.isFinite(p.t) && Number.isFinite(p.pct) && (best === null || p.t > best.t) ? p : best,
    null,
  );
  const pct = Number.isFinite(window.pct) ? window.pct : (latest?.pct ?? 0);

  const exhaustionAt = projectExhaustion(pct, burn, now);
  const resetsAt = parseInstant(window.resetsAt);
  // No projected exhaustion means the window survives. A projection with no
  // known reset instant cannot be shown to survive, so it does not claim to.
  const lastsToReset =
    exhaustionAt === null ? true : resetsAt !== null && Date.parse(exhaustionAt) > resetsAt;

  const expectedPct = expectedPace(window, now);
  const aheadOfPace = expectedPct !== undefined && pct > expectedPct + paceMargin(expectedPct);

  return { windowKey: window.key, burn, exhaustionAt, lastsToReset, expectedPct, aheadOfPace };
}

/** Pull one window's series out of the recorded points, oldest first. */
export function seriesFor(points: HistoryPoint[], windowKey: string): Sample[] {
  const series: Sample[] = [];
  for (const point of points) {
    const pct = point.windows[windowKey];
    if (typeof pct === 'number' && Number.isFinite(pct)) series.push({ t: point.t, pct });
  }
  return series.sort((a, b) => a.t - b.t);
}

/** Convenience for the common call: forecast every window of a snapshot. */
export function forecastWindows(
  windows: UsageWindow[],
  points: HistoryPoint[],
  now: number,
  opts: FitOptions = {},
): Forecast[] {
  return windows.map((w) => forecast(w, seriesFor(points, w.key), now, opts));
}

/**
 * Roll several windows into the one line a tray tooltip or header can show.
 * `worst` is the soonest *stateable* exhaustion -- null when no window is
 * projected to run out, which is the common, healthy case.
 */
export function summarize(forecasts: Forecast[]): { worst: Forecast | null; anyAheadOfPace: boolean } {
  let worst: Forecast | null = null;
  let worstAt = Number.POSITIVE_INFINITY;
  let anyAheadOfPace = false;

  for (const f of forecasts) {
    if (f.aheadOfPace) anyAheadOfPace = true;
    if (f.exhaustionAt === null) continue;
    const at = Date.parse(f.exhaustionAt);
    if (!Number.isFinite(at)) continue;
    // Same instant: the faster burn is the one to warn about.
    const fasterTie = at === worstAt && worst !== null && f.burn.pctPerHour > worst.burn.pctPerHour;
    if (at < worstAt || fasterTie) {
      worst = f;
      worstAt = at;
    }
  }

  return { worst, anyAheadOfPace };
}
