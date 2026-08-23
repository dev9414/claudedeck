/**
 * `src/core/redact.ts` — hard rule 1.
 *
 * The load-bearing assertions here are the negative ones: no output of any
 * function in this module may contain the secret it was handed. Everything
 * else (prefix preservation, fingerprint stability) exists to make the redacted
 * form useful; the leak checks are what make it safe.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { fingerprint, redact, redactObject } from '@core/redact';

import {
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_API_KEY,
  SAMPLE_REFRESH_TOKEN,
  expectNoSecrets,
  makeAccount,
  makeCredentialFile,
} from '../helpers/fixtures';

describe('fingerprint', () => {
  it('is the first 12 hex chars of the SHA-256 digest', () => {
    // Hard-coded rather than recomputed, so a change to the algorithm is a
    // test failure instead of a silent redefinition.
    expect(fingerprint('hello')).toBe('2cf24dba5fb0');
    expect(fingerprint('')).toBe('e3b0c44298fc');
  });

  it('agrees with node:crypto for arbitrary input', () => {
    const expected = createHash('sha256').update(SAMPLE_ACCESS_TOKEN, 'utf8').digest('hex');
    expect(fingerprint(SAMPLE_ACCESS_TOKEN)).toBe(expected.slice(0, 12));
  });

  it('is 12 lowercase hex characters and deterministic', () => {
    const fp = fingerprint(SAMPLE_REFRESH_TOKEN);
    expect(fp).toMatch(/^[0-9a-f]{12}$/);
    expect(fingerprint(SAMPLE_REFRESH_TOKEN)).toBe(fp);
  });

  it('distinguishes two tokens that share a long prefix', () => {
    const a = `${SAMPLE_ACCESS_TOKEN}A`;
    const b = `${SAMPLE_ACCESS_TOKEN}B`;
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it('is far too short to reconstruct the secret from', () => {
    expect(fingerprint(SAMPLE_ACCESS_TOKEN).length).toBeLessThan(
      SAMPLE_ACCESS_TOKEN.length / 2,
    );
    expectNoSecrets(fingerprint(SAMPLE_ACCESS_TOKEN));
  });
});

describe('redact', () => {
  it.each([
    ['an OAuth access token', SAMPLE_ACCESS_TOKEN, 'sk-ant-oat01-'],
    ['a refresh token', SAMPLE_REFRESH_TOKEN, 'sk-ant-ort01-'],
    ['a managed API key', SAMPLE_API_KEY, 'sk-ant-api03-'],
  ])('keeps the namespace prefix of %s and nothing else', (_label, secret, prefix) => {
    const out = redact(secret);
    expect(out.startsWith(prefix)).toBe(true);
    expect(out).toBe(`${prefix}…#${fingerprint(secret)}`);
    expectNoSecrets(out, [secret]);
  });

  it('drops the prefix for values that are not Anthropic-shaped', () => {
    const out = redact('some-other-credential-material');
    expect(out).toBe(`…#${fingerprint('some-other-credential-material')}`);
    expect(out).not.toContain('some-other');
  });

  it('returns an empty string unchanged, so callers cannot infer a secret', () => {
    // A fingerprint here would make an absent credential look present.
    expect(redact('')).toBe('');
  });

  it('is stable, so two log lines can be correlated', () => {
    expect(redact(SAMPLE_ACCESS_TOKEN)).toBe(redact(SAMPLE_ACCESS_TOKEN));
    expect(redact(SAMPLE_ACCESS_TOKEN)).not.toBe(redact(SAMPLE_REFRESH_TOKEN));
  });

  it('never leaks the token body even for a short token', () => {
    expect(redact('sk-ant-oat01-x')).not.toContain('-x');
  });
});

describe('redactObject', () => {
  it.each([
    'accessToken',
    'refreshToken',
    'refresh_token',
    'ACCESS_TOKEN',
    'apiCredentials',
    'clientSecret',
    'userPassword',
  ])('redacts the value under a key named %s', (key) => {
    const out = redactObject({ [key]: SAMPLE_ACCESS_TOKEN }) as Record<string, unknown>;
    expect(out[key]).toBe(redact(SAMPLE_ACCESS_TOKEN));
    expectNoSecrets(out);
  });

  it('leaves values under keys that do not look secret', () => {
    // Documented behaviour: the pattern matches key *names*, not value shapes.
    // Callers holding a secret under an unusual key must call `redact` directly.
    const out = redactObject({ email: 'a@example.test', note: 'hello' });
    expect(out).toEqual({ email: 'a@example.test', note: 'hello' });
  });

  it('walks nested objects and arrays', () => {
    const out = redactObject({
      claudeAiOauth: { accessToken: SAMPLE_ACCESS_TOKEN, scopes: ['user:inference'] },
      accounts: [{ slot: 1, refreshToken: SAMPLE_REFRESH_TOKEN }],
    });
    expectNoSecrets(out);
    expect(out).toEqual({
      claudeAiOauth: {
        accessToken: redact(SAMPLE_ACCESS_TOKEN),
        scopes: ['user:inference'],
      },
      accounts: [{ slot: 1, refreshToken: redact(SAMPLE_REFRESH_TOKEN) }],
    });
  });

  it('keeps null and undefined under a secret key rather than faking a value', () => {
    const out = redactObject({ accessToken: null, refreshToken: undefined }) as Record<
      string,
      unknown
    >;
    expect(out['accessToken']).toBeNull();
    expect(out).toHaveProperty('refreshToken');
    expect(out['refreshToken']).toBeUndefined();
  });

  it('drops a non-string value under a secret key wholesale', () => {
    const out = redactObject({
      credentials: { nested: SAMPLE_ACCESS_TOKEN },
      tokenBytes: [1, 2, 3],
      tokenCount: 4,
    }) as Record<string, unknown>;
    expect(out['credentials']).toBe('[redacted]');
    expect(out['tokenBytes']).toBe('[redacted]');
    expect(out['tokenCount']).toBe('[redacted]');
    expectNoSecrets(out);
  });

  it('passes primitives through untouched', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject('plain')).toBe('plain');
    expect(redactObject(null)).toBeNull();
    expect(redactObject(undefined)).toBeUndefined();
    expect(redactObject(true)).toBe(true);
  });

  it('clones Dates instead of walking them', () => {
    const when = new Date('2026-08-24T12:00:00.000Z');
    const out = redactObject({ when }) as { when: Date };
    expect(out.when).toBeInstanceOf(Date);
    expect(out.when.getTime()).toBe(when.getTime());
    expect(out.when).not.toBe(when);
  });

  it('terminates on a cycle instead of hanging', () => {
    const node: Record<string, unknown> = { accessToken: SAMPLE_ACCESS_TOKEN };
    node['self'] = node;

    const out = redactObject(node) as Record<string, unknown>;
    expect(out['self']).toBe(out);
    expect(out['accessToken']).toBe(redact(SAMPLE_ACCESS_TOKEN));
  });

  it('preserves shared references so a live state object stays coherent', () => {
    const shared = { slot: 1 };
    const out = redactObject({ a: shared, b: shared }) as { a: unknown; b: unknown };
    expect(out.a).toBe(out.b);
    expect(out.a).not.toBe(shared);
  });

  it('does not mutate the input', () => {
    const input = { accessToken: SAMPLE_ACCESS_TOKEN, nested: { refreshToken: SAMPLE_REFRESH_TOKEN } };
    redactObject(input);
    expect(input.accessToken).toBe(SAMPLE_ACCESS_TOKEN);
    expect(input.nested.refreshToken).toBe(SAMPLE_REFRESH_TOKEN);
  });
});

describe('the leak detector these tests rely on', () => {
  // Every "never leaks a token" assertion in the suite is only worth something
  // if `expectNoSecrets` can actually fail. Prove it here, once.
  it('throws on a whole secret', () => {
    expect(() => expectNoSecrets({ oops: SAMPLE_ACCESS_TOKEN })).toThrow(/secret leaked/);
  });

  it('throws on the secret body even without its namespace prefix', () => {
    const body = SAMPLE_ACCESS_TOKEN.replace(/^sk-ant-[A-Za-z0-9]+-/, '');
    expect(() => expectNoSecrets(`partial: ${body}`)).toThrow(/secret body leaked/);
  });

  it('passes on redacted output', () => {
    expect(() => expectNoSecrets(redact(SAMPLE_ACCESS_TOKEN))).not.toThrow();
  });
});

describe('the no-leak invariant on realistic payloads', () => {
  it('scrubs a whole credential file', () => {
    const file = makeCredentialFile({
      extra: { mcpOAuth: { serverToken: SAMPLE_API_KEY } },
    });
    const scrubbed = redactObject(file);

    expectNoSecrets(scrubbed);
    expectNoSecrets(JSON.stringify(scrubbed));
  });

  it('scrubs an account list carrying credentials', () => {
    const payload = {
      accounts: [
        makeAccount({ slot: 1, pct: 20 }),
        makeAccount({ slot: 2, kind: 'api-key' }),
      ],
      credentials: makeCredentialFile(),
      lastError: 'refresh failed',
    };
    const scrubbed = redactObject(payload);

    expectNoSecrets(scrubbed);
    // The non-secret parts must survive; a scrubber that emptied the object
    // would trivially pass the leak check.
    expect(JSON.stringify(scrubbed)).toContain('slot1@example.test');
    expect(JSON.stringify(scrubbed)).toContain('refresh failed');
  });

  it('scrubs a deeply nested error payload', () => {
    const scrubbed = redactObject({
      level1: { level2: { level3: { credentials: makeCredentialFile() } } },
    });
    expectNoSecrets(scrubbed);
  });
});
