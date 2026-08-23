/**
 * Secret hygiene.
 *
 * ClaudeDeck holds OAuth access/refresh tokens and managed API keys, and hard
 * rule #1 is that none of them ever reach a log line, a crash report, an
 * exported file, or the renderer. Anything that needs to *talk about* a secret
 * goes through here: a fingerprint is stable enough to tell two sightings of
 * the same token apart across a session, and far too short to be usable as a
 * credential.
 *
 * Every other module imports this one, including code that runs before the app
 * is configured, so it stays dependency-free apart from `node:crypto`.
 */

import { createHash } from 'node:crypto';

/**
 * Key names whose values are treated as secret wherever they appear. Matched
 * as a substring so `accessToken`, `refresh_token` and `apiCredentials` are all
 * caught without enumerating spellings.
 */
const SECRET_KEY_PATTERN = /token|secret|credential|password/i;

/**
 * Anthropic namespaces its key material (`sk-ant-oat01-…`, `sk-ant-api03-…`).
 * The prefix carries no entropy, and it is the one part worth keeping: it tells
 * a reader which *kind* of credential they are looking at.
 */
const KEY_PREFIX_PATTERN = /^(sk-ant-[A-Za-z0-9]+-)/;

const ELLIPSIS = '…';
const REDACTED = '[redacted]';

/**
 * First 12 hex chars of the SHA-256 digest — 48 bits. Collisions are
 * irrelevant here (we compare fingerprints of a handful of tokens, never
 * authenticate with them) and the truncation makes the digest useless for
 * offline guessing of the original.
 */
export function fingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Render a secret for human eyes: `sk-ant-oat01-…#a1b2c3d4e5f6`.
 *
 * The suffix is the fingerprint, so two log lines can be correlated to the same
 * credential; nothing from the secret body is ever emitted. Values that do not
 * look like Anthropic keys lose their prefix too, since we cannot know which
 * leading characters are safe.
 */
export function redact(value: string): string {
  // An empty string is not a secret; inventing a fingerprint for it would only
  // make callers think one is present.
  if (value === '') return '';
  const prefix = KEY_PREFIX_PATTERN.exec(value)?.[1] ?? '';
  return `${prefix}${ELLIPSIS}#${fingerprint(value)}`;
}

/**
 * Deep-clone `o`, replacing every value whose key looks secret. Use this on any
 * structure headed for a log, an IPC event, or an error payload.
 *
 * Handles JSON-shaped data (objects, arrays, primitives) plus `Date`, which is
 * everything that crosses our own boundaries. Shared references are preserved
 * and cycles terminate, so logging a live state object cannot hang the app.
 */
export function redactObject(o: unknown): unknown {
  return cloneRedacted(o, new WeakMap<object, unknown>());
}

function cloneRedacted(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());

  const already = seen.get(value);
  if (already !== undefined) return already;

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(cloneRedacted(item, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, item] of Object.entries(value)) {
    if (!SECRET_KEY_PATTERN.test(key)) {
      out[key] = cloneRedacted(item, seen);
      continue;
    }
    // A secret key with no value carries nothing to hide, and blanking it would
    // wrongly suggest a credential is present.
    if (item === null || item === undefined) {
      out[key] = item;
    } else if (typeof item === 'string') {
      out[key] = redact(item);
    } else {
      // Non-strings under a secret key (nested credential blobs, byte arrays)
      // are dropped wholesale rather than walked — there is no safe rendering.
      out[key] = REDACTED;
    }
  }
  return out;
}
