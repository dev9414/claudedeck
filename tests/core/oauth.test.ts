/**
 * `src/core/oauth.ts` — the refresh grant and the profile lookup.
 *
 * Everything is driven through the injected `fetch`, so there is no network
 * here. The classification table is what matters: a misclassified permanent
 * failure quarantines a live account, and a misclassified transient one wastes
 * a poll, so each status/body combination is pinned.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EXPIRY_SKEW_MS,
  OAUTH_CLIENT_ID,
  OAUTH_PROFILE_URL,
  OAUTH_TOKEN_URL,
  fetchProfile,
  isExpired,
  refreshToken,
  type RefreshError,
} from '@core/oauth';
import type { ClaudeOAuth } from '@shared/types';

import {
  HOUR,
  MINUTE,
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_REFRESH_TOKEN,
  T0,
  expectNoSecrets,
  scriptedFetch,
  unwrap,
  unwrapErr,
} from '../helpers/fixtures';

const oauth = (over: Partial<ClaudeOAuth> = {}): ClaudeOAuth => ({
  accessToken: SAMPLE_ACCESS_TOKEN,
  refreshToken: SAMPLE_REFRESH_TOKEN,
  expiresAt: T0 + HOUR,
  scopes: ['user:inference'],
  subscriptionType: 'max',
  ...over,
});

// ---------------------------------------------------------------------------

describe('isExpired', () => {
  it.each([
    ['no expiresAt at all', {}, T0, false],
    ['a NaN expiresAt', { expiresAt: Number.NaN }, T0, false],
    ['an Infinity expiresAt', { expiresAt: Number.POSITIVE_INFINITY }, T0, false],
    ['an hour of life left', { expiresAt: T0 + HOUR }, T0, false],
    ['expiry in the past', { expiresAt: T0 - 1 }, T0, true],
    ['expiry exactly now', { expiresAt: T0 }, T0, true],
  ])('%s -> %s', (_label, over, now, expected) => {
    expect(isExpired(oauth(over as Partial<ClaudeOAuth>), now)).toBe(expected);
  });

  it('treats a token inside the default skew as already spent', () => {
    const at = T0 + DEFAULT_EXPIRY_SKEW_MS;
    expect(isExpired(oauth({ expiresAt: at }), T0)).toBe(true);
    expect(isExpired(oauth({ expiresAt: at + 1 }), T0)).toBe(false);
  });

  it('honours a caller-supplied skew', () => {
    const o = oauth({ expiresAt: T0 + 10 * MINUTE });
    expect(isExpired(o, T0, 5 * MINUTE)).toBe(false);
    expect(isExpired(o, T0, 15 * MINUTE)).toBe(true);
  });

  it('never reports an undated credential as expired, so it cannot burn a refresh', () => {
    const o = oauth();
    delete o.expiresAt;
    expect(isExpired(o, Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('refreshToken', () => {
  it('posts the documented grant to the documented endpoint', async () => {
    const f = scriptedFetch({ json: { access_token: 'new-access', expires_in: 3600 } });
    await refreshToken(oauth(), f, T0);

    const call = f.calls[0]!;
    expect(call.url).toBe(OAUTH_TOKEN_URL);
    expect(call.method).toBe('POST');
    expect(call.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call.body ?? '{}')).toEqual({
      grant_type: 'refresh_token',
      refresh_token: SAMPLE_REFRESH_TOKEN,
      client_id: OAUTH_CLIENT_ID,
    });
    expect(OAUTH_CLIENT_ID).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });

  it('returns the rotated credential with expiry derived from the injected clock', async () => {
    const f = scriptedFetch({ json: { access_token: 'new-access', expires_in: 3600 } });
    const out = await refreshToken(oauth(), f, T0);

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.oauth.accessToken).toBe('new-access');
    expect(out.oauth.expiresAt).toBe(T0 + 3_600_000);
    // Unrotated fields survive.
    expect(out.oauth.refreshToken).toBe(SAMPLE_REFRESH_TOKEN);
    expect(out.oauth.subscriptionType).toBe('max');
  });

  it('adopts a rotated refresh token when one comes back', async () => {
    const f = scriptedFetch({
      json: { access_token: 'a', refresh_token: 'sk-ant-ort01-rotated' },
    });
    const out = await refreshToken(oauth(), f, T0);
    expect(out.ok && out.oauth.refreshToken).toBe('sk-ant-ort01-rotated');
  });

  it.each([
    ['an empty rotated token', ''],
    ['a non-string rotated token', 42],
  ])('keeps the existing refresh token given %s', async (_label, rotated) => {
    const f = scriptedFetch({ json: { access_token: 'a', refresh_token: rotated } });
    const out = await refreshToken(oauth(), f, T0);
    expect(out.ok && out.oauth.refreshToken).toBe(SAMPLE_REFRESH_TOKEN);
  });

  it.each([
    ['a space-delimited scope string', 'user:inference user:profile', ['user:inference', 'user:profile']],
    ['a scope string with ragged whitespace', '  a   b  ', ['a', 'b']],
    ['a scope array', ['x', 'y'], ['x', 'y']],
    ['a scope array with junk entries', ['x', 42, '', 'y'], ['x', 'y']],
  ])('parses %s', async (_label, scope, expected) => {
    const f = scriptedFetch({ json: { access_token: 'a', scope } });
    const out = await refreshToken(oauth(), f, T0);
    expect(out.ok && out.oauth.scopes).toEqual(expected);
  });

  it.each([
    ['an empty scope string', ''],
    ['a whitespace scope string', '   '],
    ['an empty scope array', []],
    ['no scope at all', undefined],
  ])('keeps the previous scopes given %s', async (_label, scope) => {
    const body: Record<string, unknown> = { access_token: 'a' };
    if (scope !== undefined) body['scope'] = scope;
    const f = scriptedFetch({ json: body });
    const out = await refreshToken(oauth(), f, T0);
    expect(out.ok && out.oauth.scopes).toEqual(['user:inference']);
  });

  it.each([
    ['a string expires_in', '3600'],
    ['a NaN expires_in', Number.NaN],
    ['no expires_in', undefined],
  ])('leaves expiresAt alone given %s', async (_label, expiresIn) => {
    const body: Record<string, unknown> = { access_token: 'a' };
    if (expiresIn !== undefined) body['expires_in'] = expiresIn;
    const f = scriptedFetch({ json: body });
    const out = await refreshToken(oauth({ expiresAt: T0 + 42 }), f, T0);
    expect(out.ok && out.oauth.expiresAt).toBe(T0 + 42);
  });

  it('rounds a fractional expires_in to whole milliseconds', async () => {
    const f = scriptedFetch({ json: { access_token: 'a', expires_in: 1.2345 } });
    const out = await refreshToken(oauth(), f, T0);
    expect(out.ok && out.oauth.expiresAt).toBe(T0 + 1235);
  });

  // --- failure classification ---------------------------------------------

  const permanentCases: Array<[string, ClaudeOAuth]> = [
    ['no refresh token at all', { accessToken: SAMPLE_ACCESS_TOKEN }],
    ['an empty refresh token', { accessToken: SAMPLE_ACCESS_TOKEN, refreshToken: '' }],
    ['a whitespace refresh token', { accessToken: SAMPLE_ACCESS_TOKEN, refreshToken: '   ' }],
  ];

  it.each(permanentCases)('refuses to call the endpoint with %s', async (_label, credential) => {
    const f = scriptedFetch([]);
    const out = await refreshToken(credential, f, T0);

    expect(out).toEqual({ ok: false, error: 'no-refresh-token', permanent: true });
    expect(f.calls).toHaveLength(0);
  });

  const httpCases: Array<{
    name: string;
    status: number;
    body: string;
    error: RefreshError;
    permanent: boolean;
  }> = [
    {
      name: '400 invalid_grant is permanently dead',
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant' }),
      error: 'invalid-grant',
      permanent: true,
    },
    {
      name: '401 invalid_grant is permanently dead too',
      status: 401,
      body: JSON.stringify({ error: 'invalid_grant' }),
      error: 'invalid-grant',
      permanent: true,
    },
    {
      name: '403 invalid_grant is permanently dead too',
      status: 403,
      body: JSON.stringify({ error: 'invalid_grant' }),
      error: 'invalid-grant',
      permanent: true,
    },
    {
      name: '400 invalid_client indicts our client, not the account',
      status: 400,
      body: JSON.stringify({ error: 'invalid_client' }),
      error: 'http',
      permanent: false,
    },
    {
      name: 'prose merely containing the words is not a verdict',
      status: 400,
      body: JSON.stringify({ message: 'the invalid_grant flow is deprecated' }),
      error: 'http',
      permanent: false,
    },
    {
      name: 'a 400 with a non-JSON body stays retryable',
      status: 400,
      body: '<html>bad request</html>',
      error: 'http',
      permanent: false,
    },
    {
      name: 'a 500 stays retryable',
      status: 500,
      body: JSON.stringify({ error: 'invalid_grant' }),
      error: 'http',
      permanent: false,
    },
    {
      name: 'a 429 stays retryable',
      status: 429,
      body: '',
      error: 'http',
      permanent: false,
    },
  ];

  it.each(httpCases)('$name', async ({ status, body, error, permanent }) => {
    const f = scriptedFetch({ status, text: body });
    expect(await refreshToken(oauth(), f, T0)).toEqual({ ok: false, error, permanent });
  });

  it('classifies a transport failure as network', async () => {
    const f = scriptedFetch({ throws: new TypeError('fetch failed') });
    expect(await refreshToken(oauth(), f, T0)).toEqual({
      ok: false,
      error: 'network',
      permanent: false,
    });
  });

  it('classifies a truncated success body as network, not malformed', async () => {
    const f = scriptedFetch({ bodyThrows: true });
    expect(await refreshToken(oauth(), f, T0)).toMatchObject({ error: 'network' });
  });

  it('classifies a truncated error body as http', async () => {
    const f = scriptedFetch({ status: 400, bodyThrows: true });
    expect(await refreshToken(oauth(), f, T0)).toMatchObject({ error: 'http' });
  });

  it.each([
    ['a non-JSON body', { text: 'not json' }],
    ['a JSON array', { json: [] }],
    ['a JSON scalar', { json: 7 }],
    ['no access_token', { json: { expires_in: 60 } }],
    ['an empty access_token', { json: { access_token: '' } }],
    ['a non-string access_token', { json: { access_token: 42 } }],
  ])('classifies %s as malformed', async (_label, entry) => {
    const f = scriptedFetch(entry);
    expect(await refreshToken(oauth(), f, T0)).toEqual({
      ok: false,
      error: 'malformed',
      permanent: false,
    });
  });

  it('never puts a token value into the outcome', async () => {
    for (const entry of [
      { status: 400, json: { error: 'invalid_grant', hint: SAMPLE_REFRESH_TOKEN } },
      { status: 500, text: SAMPLE_REFRESH_TOKEN },
      { throws: new Error(SAMPLE_REFRESH_TOKEN) },
    ]) {
      const out = await refreshToken(oauth(), scriptedFetch(entry), T0);
      expectNoSecrets(out);
    }
  });

  it('does not mutate the credential it was given', async () => {
    const original = oauth();
    const before = structuredClone(original);
    await refreshToken(original, scriptedFetch({ json: { access_token: 'x', expires_in: 1 } }), T0);
    expect(original).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe('fetchProfile', () => {
  it('sends a bearer token to the documented endpoint', async () => {
    const f = scriptedFetch({ json: { account: { uuid: 'u-1' } } });
    await fetchProfile(SAMPLE_ACCESS_TOKEN, f);

    expect(f.calls[0]?.url).toBe(OAUTH_PROFILE_URL);
    expect(f.calls[0]?.headers['authorization']).toBe(`Bearer ${SAMPLE_ACCESS_TOKEN}`);
  });

  it('maps the full payload onto ClaudeAccountIdentity', async () => {
    const f = scriptedFetch({
      json: {
        account: { uuid: 'u-1', email: 'a@example.test', display_name: 'Ada' },
        organization: { uuid: 'o-1', name: 'Acme' },
      },
    });

    expect(unwrap(await fetchProfile('t', f))).toEqual({
      accountUuid: 'u-1',
      emailAddress: 'a@example.test',
      displayName: 'Ada',
      organizationUuid: 'o-1',
      organizationName: 'Acme',
    });
  });

  it.each([
    ['email_address', { account: { uuid: 'u', email_address: 'x@y.test' } }, 'emailAddress', 'x@y.test'],
    ['full_name', { account: { uuid: 'u', full_name: 'Grace' } }, 'displayName', 'Grace'],
  ])('accepts the %s spelling', async (_label, body, key, expected) => {
    const identity = unwrap(await fetchProfile('t', scriptedFetch({ json: body })));
    expect(identity[key as keyof typeof identity]).toBe(expected);
  });

  it('prefers `email` over `email_address` when both are present', async () => {
    const f = scriptedFetch({
      json: { account: { uuid: 'u', email: 'first@x.test', email_address: 'second@x.test' } },
    });
    expect(unwrap(await fetchProfile('t', f)).emailAddress).toBe('first@x.test');
  });

  it('trims values and drops whitespace-only ones', async () => {
    const f = scriptedFetch({
      json: { account: { uuid: '  u-1  ', email: '   ' }, organization: { name: '' } },
    });
    expect(unwrap(await fetchProfile('t', f))).toEqual({ accountUuid: 'u-1' });
  });

  it('ignores a non-object account or organization block', async () => {
    const f = scriptedFetch({ json: { account: 'nope', organization: [], uuid: 'top-level' } });
    expect(unwrapErr(await fetchProfile('t', f)).code).toBe('malformed');
  });

  it.each([
    ['401', 401, 'unauthorized'],
    ['403', 403, 'unauthorized'],
    ['404', 404, 'http'],
    ['500', 500, 'http'],
  ])('maps HTTP %s to %s', async (_label, status, code) => {
    const e = unwrapErr(await fetchProfile('t', scriptedFetch({ status, text: '{}' })));
    expect(e.code).toBe(code);
  });

  it('maps a transport failure to network', async () => {
    const e = unwrapErr(await fetchProfile('t', scriptedFetch({ throws: new Error('boom') })));
    expect(e.code).toBe('network');
  });

  it('maps a truncated body to network', async () => {
    const e = unwrapErr(await fetchProfile('t', scriptedFetch({ bodyThrows: true })));
    expect(e.code).toBe('network');
  });

  it.each([
    ['a non-JSON body', { text: 'nope' }],
    ['a JSON array', { json: [] }],
    ['an empty object', { json: {} }],
    ['an account with neither uuid nor email', { json: { account: { display_name: 'X' } } }],
  ])('maps %s to malformed rather than an empty identity', async (_label, entry) => {
    // An "empty success" here would let a schema change silently blank an
    // account's identity on disk.
    expect(unwrapErr(await fetchProfile('t', scriptedFetch(entry))).code).toBe('malformed');
  });

  it('never puts the access token into an error message', async () => {
    for (const entry of [
      { status: 401, text: SAMPLE_ACCESS_TOKEN },
      { status: 500, text: SAMPLE_ACCESS_TOKEN },
      { text: SAMPLE_ACCESS_TOKEN },
      { throws: new Error(SAMPLE_ACCESS_TOKEN) },
    ]) {
      expectNoSecrets(await fetchProfile(SAMPLE_ACCESS_TOKEN, scriptedFetch(entry)));
    }
  });
});
