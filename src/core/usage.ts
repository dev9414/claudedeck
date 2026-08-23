/**
 * The usage axis: fetching Anthropic's OAuth usage endpoint, normalizing its
 * drifting payload into a `UsageSnapshot`, and reducing a snapshot to the one
 * number the switcher cares about — remaining headroom.
 *
 * `normalizeUsage`, `relevantWindows` and `headroom` are pure and total: the
 * upstream shape changes without notice, so every field is validated and
 * anything unparseable is dropped rather than thrown. A snapshot that loses one
 * window is still worth showing; an exception mid-poll is not.
 */

import type { Headroom, UsageSnapshot, UsageWindow } from '@shared/types';
import type { FetchLike } from './oauth';

export const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** The beta gate the usage endpoint requires; without it the call 404s. */
export const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

/** Stable keys for the two windows every subscription account always has. */
export const FIVE_HOUR_KEY = '5h';
export const SEVEN_DAY_KEY = '7d';
/** Sentinel accepted in `models`: fold in every scoped window an account reports. */
export const ALL_MODELS = 'all';

export type UsageError = 'unauthorized' | 'rate-limited' | 'network' | 'http' | 'malformed';

export type UsageOutcome =
  | { ok: true; usage: UsageSnapshot | null }
  | { ok: false; error: UsageError; retryAfterSec?: number };

/**
 * Fetch and normalize this token's usage.
 *
 * `usage: null` on the success branch is a real outcome, not a failure: the
 * round trip worked but the response carried no window data (API-key accounts
 * have no subscription quota at all). Callers must not read that as "empty
 * quota" — it means "this account has no windows to gate on".
 *
 * `now` is injected so `fetchedAt` and Retry-After date math are deterministic.
 */
export async function fetchUsage(
  accessToken: string,
  f: FetchLike,
  now: number = Date.now(),
): Promise<UsageOutcome> {
  let res: Response;
  try {
    res = await f(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': OAUTH_BETA_HEADER,
        Accept: 'application/json',
      },
    });
  } catch {
    return { ok: false, error: 'network' };
  }

  if (!res.ok) {
    if (res.status === 429) {
      const retryAfterSec = parseRetryAfter(res.headers.get('retry-after'), now);
      // Omit the key entirely when the server sent nothing usable, so callers
      // can tell "no hint" from "retry immediately".
      return retryAfterSec === undefined
        ? { ok: false, error: 'rate-limited' }
        : { ok: false, error: 'rate-limited', retryAfterSec };
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'unauthorized' };
    return { ok: false, error: 'http' };
  }

  let text: string;
  try {
    text = await res.text();
  } catch {
    return { ok: false, error: 'network' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'malformed' };
  }

  return { ok: true, usage: normalizeUsage(raw, now) };
}

/**
 * Turn a raw usage payload into a `UsageSnapshot`, or null when it contains
 * nothing we can use.
 *
 * Pure and total. Each window is parsed independently, so a malformed
 * `extra_usage` block never costs us the 5h/7d numbers the switcher runs on.
 */
export function normalizeUsage(raw: unknown, now: number): UsageSnapshot | null {
  if (!isRecord(raw)) return null;

  const snapshot: UsageSnapshot = { scoped: [], fetchedAt: now };

  const fiveHour = parseWindow(raw['five_hour'], FIVE_HOUR_KEY, FIVE_HOUR_KEY, 'utilization');
  if (fiveHour) snapshot.fiveHour = fiveHour;

  const sevenDay = parseWindow(raw['seven_day'], SEVEN_DAY_KEY, SEVEN_DAY_KEY, 'utilization');
  if (sevenDay) snapshot.sevenDay = sevenDay;

  // Per-model weekly windows live in the newer `limits` array; older responses
  // omit it entirely and simply report no scoped windows.
  const limits = raw['limits'];
  if (Array.isArray(limits)) {
    for (const entry of limits) {
      if (!isRecord(entry)) continue;
      const scope = isRecord(entry['scope']) ? entry['scope'] : undefined;
      const model = scope && isRecord(scope['model']) ? scope['model'] : undefined;
      const name = model ? str(model['display_name']) : undefined;
      if (name === undefined) continue;
      // `percent` is the documented field; `utilization` is accepted as a
      // fallback so a rename on this array does not blank out model gating.
      const pct = num(entry['percent']) ?? num(entry['utilization']);
      if (pct === undefined) continue;
      const window: UsageWindow = { key: name, label: name, pct: clampPct(pct) };
      const resetsAt = isoString(entry['resets_at']);
      if (resetsAt !== undefined) window.resetsAt = resetsAt;
      snapshot.scoped.push(window);
    }
  }

  const spend = parseSpend(raw['extra_usage']);
  if (spend) snapshot.spend = spend;

  const empty =
    snapshot.fiveHour === undefined &&
    snapshot.sevenDay === undefined &&
    snapshot.spend === undefined &&
    snapshot.scoped.length === 0;
  return empty ? null : snapshot;
}

/**
 * Every window that gates this account: always 5h and 7d, plus each named
 * per-model weekly window when `models` asks for it.
 *
 * Matching is case-insensitive on the API's display name, and the sentinel
 * `all` matches every scoped window the account reports. This is the single
 * canonical window source for gating, so a window that can bind a decision can
 * never be invisible to the code scheduling around it.
 *
 * Spend is deliberately excluded — pay-as-you-go credits are a separate axis,
 * not a rate limit, and folding them in would make a funded account look
 * exhausted.
 */
export function relevantWindows(
  u: UsageSnapshot | undefined,
  models: string[] = [],
): UsageWindow[] {
  if (!u) return [];

  const windows: UsageWindow[] = [];
  if (u.fiveHour) windows.push(u.fiveHour);
  if (u.sevenDay) windows.push(u.sevenDay);

  if (models.length > 0 && u.scoped.length > 0) {
    const wanted = new Set(models.map((m) => m.trim().toLowerCase()));
    const matchAll = wanted.has(ALL_MODELS);
    for (const window of u.scoped) {
      if (matchAll || wanted.has(window.key.toLowerCase())) windows.push(window);
    }
  }

  return windows;
}

/**
 * Remaining utilization points before the binding window hits 100%.
 *
 * `null` means *unknown* (no usage, or usage with no windows) and must never be
 * collapsed into "exhausted" or "wide open" — an unknown account stays a valid
 * switch target, it just cannot be ranked.
 */
export function headroom(u: UsageSnapshot | undefined, models: string[] = []): Headroom | null {
  const windows = relevantWindows(u, models);
  let binding: UsageWindow | undefined;
  // Strict `>` keeps the earliest window on a tie, so 5h/7d win over a scoped
  // window at the same percentage and the reported binder stays stable.
  for (const window of windows) {
    if (binding === undefined || window.pct > binding.pct) binding = window;
  }
  if (binding === undefined) return null;
  return { remaining: 100 - binding.pct, bindingWindow: binding.key };
}

// ---------------------------------------------------------------------------
// Parsing helpers. All private and all defensive.
// ---------------------------------------------------------------------------

function parseWindow(
  raw: unknown,
  key: string,
  label: string,
  pctField: string,
): UsageWindow | undefined {
  if (!isRecord(raw)) return undefined;
  const pct = num(raw[pctField]);
  if (pct === undefined) return undefined;
  const window: UsageWindow = { key, label, pct: clampPct(pct) };
  const resetsAt = isoString(raw['resets_at']);
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

/**
 * Pay-as-you-go credits. Amounts arrive in cents.
 *
 * `used_credits`, `monthly_limit` and `utilization` are independently nullable
 * (a null limit means unlimited), and all three are needed to render a spend
 * line — so when any is missing we drop just this entry and leave the quota
 * windows untouched.
 */
function parseSpend(raw: unknown): UsageSnapshot['spend'] {
  if (!isRecord(raw)) return undefined;
  if (raw['is_enabled'] === false) return undefined;

  const used = num(raw['used_credits']);
  const limit = num(raw['monthly_limit']);
  const pct = num(raw['utilization']);
  if (used === undefined || limit === undefined || pct === undefined) return undefined;

  const spend = {
    used: used / 100,
    limit: limit / 100,
    pct: clampPct(pct),
    currency: str(raw['currency']) ?? 'USD',
  };
  const resetsAt = isoString(raw['resets_at']);
  return resetsAt === undefined ? spend : { ...spend, resetsAt };
}

/**
 * `Retry-After` in either RFC 7231 form: delta-seconds, or an HTTP date we
 * convert against the injected `now`. Never negative, so a clock skew cannot
 * turn into an instant retry loop's justification.
 */
function parseRetryAfter(raw: string | null, now: number): number | undefined {
  if (raw === null) return undefined;
  const text = raw.trim();
  if (text === '') return undefined;

  const seconds = Number(text);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.round((at - now) / 1000));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Finite number, or undefined. Rejects null, strings and NaN alike. */
function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A timestamp we can actually render a countdown from, or undefined. */
function isoString(value: unknown): string | undefined {
  const text = str(value);
  if (text === undefined) return undefined;
  return Number.isNaN(Date.parse(text)) ? undefined : text;
}

/** Utilization is a percentage; negatives are junk, overshoot above 100 is not. */
function clampPct(pct: number): number {
  return pct < 0 ? 0 : pct;
}
