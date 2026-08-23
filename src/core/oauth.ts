/**
 * The OAuth edge: exchanging a refresh token for a live access token, and
 * asking Anthropic who a token belongs to.
 *
 * Everything here is pure apart from the injected `fetch`, so the whole module
 * is exercisable against a fake without touching the network. Nothing in here
 * logs — token values must never reach a sink (see `redact.ts` for the
 * fingerprinting helpers callers use when they do need to say something).
 */

import type { ClaudeAccountIdentity, ClaudeOAuth, Result } from '@shared/types';
import { err, ok } from '@shared/types';

/** Injected `fetch`, so core stays testable without touching the network. */
export type FetchLike = typeof fetch;

/** Claude Code's public OAuth client. Not a secret; it ships in the CLI. */
export const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const OAUTH_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/** Treat a token as spent this long before its stated expiry. */
export const DEFAULT_EXPIRY_SKEW_MS = 60_000;

export type RefreshError =
  | 'no-refresh-token'
  | 'invalid-grant'
  | 'network'
  | 'http'
  | 'malformed';

export type RefreshOutcome =
  | { ok: true; oauth: ClaudeOAuth }
  | { ok: false; error: RefreshError; permanent: boolean };

/**
 * Only a server-side rejection of the grant itself, or a credential with no
 * refresh token at all, is a permanent verdict. A misclassified transient
 * costs one retry; a misclassified permanent quarantines a live account, so
 * everything ambiguous stays retryable.
 */
const PERMANENT: ReadonlySet<RefreshError> = new Set<RefreshError>([
  'no-refresh-token',
  'invalid-grant',
]);

const fail = (error: RefreshError): RefreshOutcome => ({
  ok: false,
  error,
  permanent: PERMANENT.has(error),
});

/**
 * Is `oauth`'s access token spent as of `now`?
 *
 * A credential with no `expiresAt` reports *not* expired: we have no evidence
 * either way, and guessing "expired" would burn a refresh — and possibly a
 * one-shot rotated refresh token — on every single poll.
 */
export function isExpired(
  oauth: ClaudeOAuth,
  now: number,
  skewMs: number = DEFAULT_EXPIRY_SKEW_MS,
): boolean {
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return false;
  return now + skewMs >= expiresAt;
}

/**
 * Run the refresh-token grant and return the rotated credential.
 *
 * `now` is injected rather than read from the clock so expiry math is
 * deterministic under test; callers in the app just omit it.
 */
export async function refreshToken(
  oauth: ClaudeOAuth,
  f: FetchLike,
  now: number = Date.now(),
): Promise<RefreshOutcome> {
  const refresh = oauth.refreshToken;
  if (typeof refresh !== 'string' || refresh.trim() === '') return fail('no-refresh-token');

  let res: Response;
  try {
    res = await f(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: OAUTH_CLIENT_ID,
      }),
    });
  } catch {
    return fail('network');
  }

  if (!res.ok) return fail(await classifyGrantFailure(res));

  const body = await readJson(res);
  if (body.kind !== 'json') return fail(body.kind === 'network' ? 'network' : 'malformed');
  if (!isRecord(body.value)) return fail('malformed');

  const parsed = body.value;
  const accessToken = parsed['access_token'];
  if (typeof accessToken !== 'string' || accessToken === '') return fail('malformed');

  // Every field but the access token is optional in practice, so each one
  // falls back to what we already held rather than erasing it.
  const next: ClaudeOAuth = { ...oauth, accessToken };

  const expiresIn = parsed['expires_in'];
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn)) {
    next.expiresAt = now + Math.round(expiresIn * 1000);
  }

  // The endpoint may hand back a successor refresh token; its absence means the
  // current one is still live, so we keep it rather than dropping the lineage.
  const rotated = parsed['refresh_token'];
  if (typeof rotated === 'string' && rotated !== '') next.refreshToken = rotated;

  const scope = parsed['scope'];
  if (typeof scope === 'string' && scope.trim() !== '') {
    next.scopes = scope.trim().split(/\s+/);
  } else if (Array.isArray(scope)) {
    const scopes = scope.filter((s): s is string => typeof s === 'string' && s !== '');
    if (scopes.length > 0) next.scopes = scopes;
  }

  return { ok: true, oauth: next };
}

/**
 * RFC 6749 section 5.2 puts the verdict in the body's top-level `error` member.
 * We only read it on the status codes that can carry one, and only an exact
 * `invalid_grant` is fatal — a substring scan would match the word inside some
 * other envelope's prose and quarantine a healthy account.
 */
async function classifyGrantFailure(res: Response): Promise<RefreshError> {
  if (res.status !== 400 && res.status !== 401 && res.status !== 403) return 'http';
  let text: string;
  try {
    text = await res.text();
  } catch {
    return 'http';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'http';
  }
  // `invalid_client` also lands here, but it indicts *our* client id rather
  // than this account's token, so it stays a retryable `http`.
  if (isRecord(parsed) && parsed['error'] === 'invalid_grant') return 'invalid-grant';
  return 'http';
}

/**
 * Resolve an access token to the identity behind it.
 *
 * The `Err` branch carries a `code` drawn from the same vocabulary the refresh
 * and usage outcomes use (`unauthorized` | `network` | `http` | `malformed`) so
 * callers can branch on the cause without parsing the message.
 */
export async function fetchProfile(
  accessToken: string,
  f: FetchLike,
): Promise<Result<ClaudeAccountIdentity>> {
  let res: Response;
  try {
    res = await f(OAUTH_PROFILE_URL, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
  } catch {
    return err('profile request failed to reach the network', 'network');
  }

  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return err('access token was rejected by the profile endpoint', 'unauthorized');
    }
    return err(`profile endpoint returned HTTP ${res.status}`, 'http');
  }

  const body = await readJson(res);
  if (body.kind !== 'json') {
    return body.kind === 'network'
      ? err('profile response body could not be read', 'network')
      : err('profile response was not valid JSON', 'malformed');
  }
  if (!isRecord(body.value)) return err('profile response was not an object', 'malformed');

  const identity = parseIdentity(body.value);
  // A response with neither a uuid nor an email identifies nobody; reporting it
  // as an empty success would let a schema change quietly blank out an account.
  if (identity === null) return err('profile response carried no usable identity', 'malformed');
  return ok(identity);
}

/** Pull a `ClaudeAccountIdentity` out of a profile payload; null when unusable. */
function parseIdentity(data: Record<string, unknown>): ClaudeAccountIdentity | null {
  const account = isRecord(data['account']) ? data['account'] : {};
  const organization = isRecord(data['organization']) ? data['organization'] : {};

  const identity: ClaudeAccountIdentity = {};
  const uuid = str(account['uuid']);
  if (uuid !== undefined) identity.accountUuid = uuid;
  const email = str(account['email']) ?? str(account['email_address']);
  if (email !== undefined) identity.emailAddress = email;
  const displayName = str(account['display_name']) ?? str(account['full_name']);
  if (displayName !== undefined) identity.displayName = displayName;
  const orgUuid = str(organization['uuid']);
  if (orgUuid !== undefined) identity.organizationUuid = orgUuid;
  const orgName = str(organization['name']);
  if (orgName !== undefined) identity.organizationName = orgName;

  if (identity.accountUuid === undefined && identity.emailAddress === undefined) return null;
  return identity;
}

// ---------------------------------------------------------------------------
// Local helpers. Deliberately private: `usage.ts` keeps its own copies so
// neither module depends on the other's internals.
// ---------------------------------------------------------------------------

type JsonRead = { kind: 'json'; value: unknown } | { kind: 'network' } | { kind: 'malformed' };

/** Distinguishes "the body never arrived" from "the body was not JSON". */
async function readJson(res: Response): Promise<JsonRead> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return { kind: 'network' };
  }
  try {
    return { kind: 'json', value: JSON.parse(text) };
  } catch {
    return { kind: 'malformed' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Non-empty trimmed string, or undefined. */
function str(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
