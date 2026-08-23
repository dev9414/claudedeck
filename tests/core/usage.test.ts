/**
 * `src/core/usage.ts` — parsing the usage endpoint and reducing a snapshot to
 * headroom.
 *
 * The parser is the app's contact surface with a payload that changes without
 * notice, so most of this file is a table of malformed inputs. The rule being
 * enforced throughout: one bad field costs that field, never the whole
 * snapshot, and never an exception.
 */

import { describe, expect, it } from 'vitest';

import {
  ALL_MODELS,
  FIVE_HOUR_KEY,
  OAUTH_BETA_HEADER,
  SEVEN_DAY_KEY,
  USAGE_URL,
  fetchUsage,
  headroom,
  normalizeUsage,
  relevantWindows,
} from '@core/usage';

import {
  DAY,
  HOUR,
  SAMPLE_ACCESS_TOKEN,
  T0,
  expectNoSecrets,
  isoAt,
  makeUsage,
  rawUsagePayload,
  scriptedFetch,
} from '../helpers/fixtures';

// ---------------------------------------------------------------------------

describe('normalizeUsage', () => {
  it('parses the documented payload end to end', () => {
    const snapshot = normalizeUsage(rawUsagePayload(), T0);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.fetchedAt).toBe(T0);
    expect(snapshot?.fiveHour).toEqual({
      key: FIVE_HOUR_KEY,
      label: FIVE_HOUR_KEY,
      pct: 25,
      resetsAt: isoAt(4 * HOUR),
    });
    expect(snapshot?.sevenDay?.pct).toBe(16);
    expect(snapshot?.scoped).toEqual([
      { key: 'Fable', label: 'Fable', pct: 12, resetsAt: isoAt(4 * DAY) },
    ]);
    expect(snapshot?.spend).toEqual({
      used: 12.34,
      limit: 50,
      pct: 24.7,
      currency: 'USD',
    });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', []],
    ['a string', 'nope'],
    ['a number', 7],
    ['an empty object', {}],
    ['an object of unrelated keys', { hello: 'world' }],
  ])('returns null for %s', (_label, raw) => {
    expect(normalizeUsage(raw, T0)).toBeNull();
  });

  it.each([
    ['a null utilization', { utilization: null }],
    ['a string utilization', { utilization: '25' }],
    ['a NaN utilization', { utilization: Number.NaN }],
    ['an Infinity utilization', { utilization: Number.POSITIVE_INFINITY }],
    ['no utilization key', { resets_at: isoAt(HOUR) }],
    ['a non-object window', 'five_hour'],
    ['an array window', []],
  ])('drops the 5h window given %s but keeps the 7d one', (_label, fiveHour) => {
    const snapshot = normalizeUsage(
      { five_hour: fiveHour, seven_day: { utilization: 30 } },
      T0,
    );
    expect(snapshot?.fiveHour).toBeUndefined();
    expect(snapshot?.sevenDay?.pct).toBe(30);
  });

  it('clamps a negative utilization to zero but keeps overshoot above 100', () => {
    const snapshot = normalizeUsage(
      { five_hour: { utilization: -5 }, seven_day: { utilization: 137.5 } },
      T0,
    );
    expect(snapshot?.fiveHour?.pct).toBe(0);
    expect(snapshot?.sevenDay?.pct).toBe(137.5);
  });

  it.each([
    ['a missing resets_at', {}],
    ['a null resets_at', { resets_at: null }],
    ['an unparseable resets_at', { resets_at: 'sometime next week' }],
    ['an empty resets_at', { resets_at: '   ' }],
    ['a numeric resets_at', { resets_at: 1770000000000 }],
  ])('omits resetsAt given %s', (_label, extra) => {
    const snapshot = normalizeUsage({ five_hour: { utilization: 10, ...extra } }, T0);
    expect(snapshot?.fiveHour).toEqual({ key: '5h', label: '5h', pct: 10 });
  });

  describe('the per-model limits array', () => {
    it('reports no scoped windows when limits is absent (older responses)', () => {
      const snapshot = normalizeUsage({ five_hour: { utilization: 1 } }, T0);
      expect(snapshot?.scoped).toEqual([]);
    });

    it.each([
      ['not an array', { limits: { a: 1 } }],
      ['a string', { limits: 'nope' }],
      ['null', { limits: null }],
    ])('ignores a limits field that is %s', (_label, over) => {
      const snapshot = normalizeUsage({ five_hour: { utilization: 1 }, ...over }, T0);
      expect(snapshot?.scoped).toEqual([]);
    });

    it('keeps the good entries and drops the junk ones', () => {
      const snapshot = normalizeUsage(
        {
          limits: [
            null,
            'nope',
            [],
            { scope: {} },
            { scope: { model: {} }, percent: 5 },
            { scope: { model: { display_name: 'NoPct' } } },
            { scope: { model: { display_name: 'Good' } }, percent: 42 },
          ],
        },
        T0,
      );
      expect(snapshot?.scoped).toEqual([{ key: 'Good', label: 'Good', pct: 42 }]);
    });

    it('falls back to `utilization` when `percent` is absent', () => {
      const snapshot = normalizeUsage(
        { limits: [{ scope: { model: { display_name: 'M' } }, utilization: 33 }] },
        T0,
      );
      expect(snapshot?.scoped[0]?.pct).toBe(33);
    });

    it('prefers `percent` when both are present', () => {
      const snapshot = normalizeUsage(
        { limits: [{ scope: { model: { display_name: 'M' } }, percent: 1, utilization: 99 }] },
        T0,
      );
      expect(snapshot?.scoped[0]?.pct).toBe(1);
    });

    it('is a usable snapshot even when limits is the only thing present', () => {
      const snapshot = normalizeUsage(
        { limits: [{ scope: { model: { display_name: 'M' } }, percent: 5 }] },
        T0,
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot?.fiveHour).toBeUndefined();
    });
  });

  describe('extra_usage (spend)', () => {
    it('converts cents to currency units', () => {
      const snapshot = normalizeUsage(
        {
          extra_usage: {
            is_enabled: true,
            used_credits: 1,
            monthly_limit: 100_000,
            utilization: 0.001,
          },
        },
        T0,
      );
      expect(snapshot?.spend).toMatchObject({ used: 0.01, limit: 1000 });
    });

    it.each([
      ['a null used_credits', { used_credits: null }],
      ['a null monthly_limit', { monthly_limit: null }],
      ['a null utilization', { utilization: null }],
      ['a missing used_credits', { used_credits: undefined }],
      ['a string monthly_limit', { monthly_limit: '5000' }],
    ])('skips the spend entry given %s but keeps the quota windows', (_label, over) => {
      const raw = rawUsagePayload();
      raw['extra_usage'] = { ...(raw['extra_usage'] as object), ...over };

      const snapshot = normalizeUsage(raw, T0);
      expect(snapshot?.spend).toBeUndefined();
      expect(snapshot?.fiveHour?.pct).toBe(25);
      expect(snapshot?.sevenDay?.pct).toBe(16);
    });

    it('skips the entry entirely when extra usage is switched off', () => {
      const raw = rawUsagePayload({
        extra_usage: {
          is_enabled: false,
          used_credits: 100,
          monthly_limit: 5000,
          utilization: 2,
        },
      });
      expect(normalizeUsage(raw, T0)?.spend).toBeUndefined();
    });

    it('defaults the currency to USD', () => {
      const raw = rawUsagePayload({
        extra_usage: { is_enabled: true, used_credits: 0, monthly_limit: 100, utilization: 0 },
      });
      expect(normalizeUsage(raw, T0)?.spend?.currency).toBe('USD');
    });

    it('honours a reported currency and reset instant', () => {
      const raw = rawUsagePayload({
        extra_usage: {
          is_enabled: true,
          used_credits: 0,
          monthly_limit: 100,
          utilization: 0,
          currency: 'EUR',
          resets_at: isoAt(30 * DAY),
        },
      });
      expect(normalizeUsage(raw, T0)?.spend).toMatchObject({
        currency: 'EUR',
        resetsAt: isoAt(30 * DAY),
      });
    });

    it('is enough on its own to make a snapshot non-null', () => {
      const snapshot = normalizeUsage(
        {
          extra_usage: { is_enabled: true, used_credits: 500, monthly_limit: 1000, utilization: 50 },
        },
        T0,
      );
      expect(snapshot).not.toBeNull();
      expect(snapshot?.spend?.pct).toBe(50);
    });
  });
});

// ---------------------------------------------------------------------------

describe('relevantWindows', () => {
  const usage = makeUsage({
    fiveHourPct: 10,
    sevenDayPct: 20,
    scoped: [
      { key: 'Fable', pct: 30 },
      { key: 'Sonnet', pct: 40 },
    ],
  });

  it('returns nothing for undefined usage', () => {
    expect(relevantWindows(undefined)).toEqual([]);
  });

  it('returns 5h then 7d, and no scoped windows, when no models are named', () => {
    expect(relevantWindows(usage).map((w) => w.key)).toEqual(['5h', '7d']);
  });

  it('folds in a named model, case-insensitively and ignoring whitespace', () => {
    expect(relevantWindows(usage, ['  fABLE  ']).map((w) => w.key)).toEqual(['5h', '7d', 'Fable']);
  });

  it('folds in every scoped window for the `all` sentinel', () => {
    expect(relevantWindows(usage, [ALL_MODELS]).map((w) => w.key)).toEqual([
      '5h',
      '7d',
      'Fable',
      'Sonnet',
    ]);
  });

  it('ignores a model the account does not report', () => {
    expect(relevantWindows(usage, ['Nonexistent']).map((w) => w.key)).toEqual(['5h', '7d']);
  });

  it('never includes spend — credits are a separate axis, not a rate limit', () => {
    const withSpend = makeUsage({
      fiveHourPct: 5,
      spend: { used: 40, limit: 50, pct: 80 },
    });
    expect(relevantWindows(withSpend, [ALL_MODELS]).map((w) => w.key)).toEqual(['5h']);
  });

  it('handles a snapshot with only scoped windows', () => {
    const scopedOnly = makeUsage({ scoped: [{ key: 'M', pct: 5 }] });
    expect(relevantWindows(scopedOnly).map((w) => w.key)).toEqual([]);
    expect(relevantWindows(scopedOnly, ['m']).map((w) => w.key)).toEqual(['M']);
  });
});

describe('headroom', () => {
  it('returns null when nothing is known — unknown is not "wide open"', () => {
    expect(headroom(undefined)).toBeNull();
    expect(headroom(makeUsage())).toBeNull();
    // Scoped windows exist but are not being gated on.
    expect(headroom(makeUsage({ scoped: [{ key: 'M', pct: 90 }] }))).toBeNull();
  });

  it('binds on the highest window', () => {
    const usage = makeUsage({ fiveHourPct: 10, sevenDayPct: 72 });
    expect(headroom(usage)).toEqual({ remaining: 28, bindingWindow: '7d' });
  });

  it('keeps the earliest window on a tie, so the reported binder is stable', () => {
    const usage = makeUsage({
      fiveHourPct: 50,
      sevenDayPct: 50,
      scoped: [{ key: 'M', pct: 50 }],
    });
    expect(headroom(usage, [ALL_MODELS])?.bindingWindow).toBe('5h');
  });

  it('lets a scoped window bind when it is the highest and is being gated on', () => {
    const usage = makeUsage({
      fiveHourPct: 10,
      sevenDayPct: 20,
      scoped: [{ key: 'Fable', pct: 95 }],
    });
    expect(headroom(usage, [])).toEqual({ remaining: 80, bindingWindow: '7d' });
    expect(headroom(usage, ['Fable'])).toEqual({ remaining: 5, bindingWindow: 'Fable' });
  });

  it('goes negative when the API reports overshoot past 100', () => {
    expect(headroom(makeUsage({ fiveHourPct: 105 }))).toEqual({
      remaining: -5,
      bindingWindow: '5h',
    });
  });

  it('reports full headroom at zero utilization', () => {
    expect(headroom(makeUsage({ fiveHourPct: 0 }))).toEqual({ remaining: 100, bindingWindow: '5h' });
  });
});

// ---------------------------------------------------------------------------

describe('fetchUsage', () => {
  it('sends the bearer token and the beta gate the endpoint requires', async () => {
    const f = scriptedFetch({ json: rawUsagePayload() });
    await fetchUsage(SAMPLE_ACCESS_TOKEN, f, T0);

    const call = f.calls[0]!;
    expect(call.url).toBe(USAGE_URL);
    expect(call.headers['authorization']).toBe(`Bearer ${SAMPLE_ACCESS_TOKEN}`);
    expect(call.headers['anthropic-beta']).toBe(OAUTH_BETA_HEADER);
  });

  it('normalizes a successful response', async () => {
    const out = await fetchUsage('t', scriptedFetch({ json: rawUsagePayload() }), T0);
    expect(out).toMatchObject({ ok: true });
    expect(out.ok && out.usage?.fiveHour?.pct).toBe(25);
  });

  it('reports usage: null for an account with no subscription quota', async () => {
    // An API-key account round-trips fine but carries no windows; that is a
    // success, not a failure, and must not read as "exhausted".
    const out = await fetchUsage('t', scriptedFetch({ json: {} }), T0);
    expect(out).toEqual({ ok: true, usage: null });
  });

  it.each([
    ['401', 401, 'unauthorized'],
    ['403', 403, 'unauthorized'],
    ['404', 404, 'http'],
    ['500', 500, 'http'],
    ['503', 503, 'http'],
  ])('maps HTTP %s to %s', async (_label, status, error) => {
    const out = await fetchUsage('t', scriptedFetch({ status, text: '{}' }), T0);
    expect(out).toEqual({ ok: false, error });
  });

  it('maps a transport failure to network', async () => {
    const out = await fetchUsage('t', scriptedFetch({ throws: new Error('offline') }), T0);
    expect(out).toEqual({ ok: false, error: 'network' });
  });

  it('maps a truncated body to network', async () => {
    const out = await fetchUsage('t', scriptedFetch({ bodyThrows: true }), T0);
    expect(out).toEqual({ ok: false, error: 'network' });
  });

  it('maps an unparseable body to malformed', async () => {
    const out = await fetchUsage('t', scriptedFetch({ text: '<html>' }), T0);
    expect(out).toEqual({ ok: false, error: 'malformed' });
  });

  describe('429 handling', () => {
    it('reads a delta-seconds Retry-After', async () => {
      const f = scriptedFetch({ status: 429, text: '', headers: { 'retry-after': '120' } });
      expect(await fetchUsage('t', f, T0)).toEqual({
        ok: false,
        error: 'rate-limited',
        retryAfterSec: 120,
      });
    });

    it('converts an HTTP-date Retry-After against the injected clock', async () => {
      const f = scriptedFetch({
        status: 429,
        text: '',
        headers: { 'retry-after': new Date(T0 + 90_000).toUTCString() },
      });
      expect(await fetchUsage('t', f, T0)).toEqual({
        ok: false,
        error: 'rate-limited',
        retryAfterSec: 90,
      });
    });

    it('never returns a negative hint, even for a date in the past', async () => {
      const f = scriptedFetch({
        status: 429,
        text: '',
        headers: { 'retry-after': new Date(T0 - 600_000).toUTCString() },
      });
      expect(await fetchUsage('t', f, T0)).toMatchObject({ retryAfterSec: 0 });
    });

    it('clamps a negative delta-seconds to zero', async () => {
      const f = scriptedFetch({ status: 429, text: '', headers: { 'retry-after': '-30' } });
      expect(await fetchUsage('t', f, T0)).toMatchObject({ retryAfterSec: 0 });
    });

    it.each([
      ['no header', undefined],
      ['an empty header', ''],
      ['a junk header', 'soon-ish'],
    ])('omits the key entirely given %s', async (_label, value) => {
      const headers: Record<string, string> = value === undefined ? {} : { 'retry-after': value };
      const out = await fetchUsage('t', scriptedFetch({ status: 429, text: '', headers }), T0);

      // Omitted, not zero: callers must be able to tell "no hint" from "now".
      expect(out).toEqual({ ok: false, error: 'rate-limited' });
      expect('retryAfterSec' in out).toBe(false);
    });
  });

  it('never leaks the access token into an outcome', async () => {
    for (const entry of [
      { status: 429, text: SAMPLE_ACCESS_TOKEN },
      { status: 500, text: SAMPLE_ACCESS_TOKEN },
      { text: SAMPLE_ACCESS_TOKEN },
      { throws: new Error(SAMPLE_ACCESS_TOKEN) },
    ]) {
      expectNoSecrets(await fetchUsage(SAMPLE_ACCESS_TOKEN, scriptedFetch(entry), T0));
    }
  });
});
