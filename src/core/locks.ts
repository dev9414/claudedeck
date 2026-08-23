/**
 * Cross-process advisory file locking.
 *
 * Claude Code refreshes its own OAuth token in the background, and ClaudeDeck
 * itself can be running twice (window plus tray, or GUI plus CLI). Every
 * mutation of the live credential store therefore happens under a lockfile, so
 * a swap can never land in the middle of somebody else's read-modify-write.
 *
 * The mutex is an atomic exclusive create (`wx`): exactly one process wins the
 * create, everyone else waits. The file holds the owner's pid and the instant
 * it was taken, so a lock left behind by a killed process can be broken once it
 * is provably older than `staleMs` instead of wedging the app forever.
 *
 * Claude Code's own locks are proper-lockfile *directories* with different
 * names; this module deliberately does not impersonate them. It serialises
 * ClaudeDeck against itself and against anything adopting the same convention,
 * and `staleMs` defaults are matched to Claude Code's so the two agree on what
 * "abandoned" means.
 *
 * The filesystem is injected, so tests never go near the real `~/.claude`.
 */

import { type Result, err, ok } from '@shared/types';

/** The slice of `node:fs/promises` a lock needs. Satisfied by it directly. */
export interface LockFs {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  /** With `flag: 'wx'` this MUST reject with `code: 'EEXIST'` when the file exists. */
  writeFile(
    path: string,
    data: string,
    options: { encoding: 'utf8'; flag?: 'wx' },
  ): Promise<void>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  unlink(path: string): Promise<void>;
}

export interface LockDeps {
  fs: LockFs;
  /** Epoch ms. */
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Recorded for diagnostics only; never used to signal a process. */
  pid?: number;
  /** 0-1. Injected so retry jitter is deterministic under test. */
  random?(): number;
  host?: string;
}

export interface LockOptions {
  /** Total time to wait for a contended lock before giving up. */
  timeoutMs: number;
  /** A lock whose timestamp is older than this counts as abandoned. */
  staleMs: number;
  /** Base gap between attempts, jittered upward. Defaults to `DEFAULT_RETRY_MS`. */
  retryMs?: number;
  /** Free-form label stored in the lockfile, e.g. `switch:slot-2`. */
  owner?: string;
}

/** What we persist inside the lockfile. Never contains a secret. */
export interface LockRecord {
  pid: number;
  /** Epoch ms of acquisition or last renewal; this is what staleness measures. */
  ts: number;
  /** Random per-acquisition id, so a release only ever removes *our* lock. */
  token: string;
  owner?: string;
  host?: string;
}

export interface LockHandle {
  readonly path: string;
  /** Epoch ms of acquisition. */
  readonly acquiredAt: number;
  /** Idempotent, and never throws. */
  release(): Promise<void>;
  /**
   * Push the timestamp forward. A slow operation under the lock (a network
   * token refresh) would otherwise look like a dead holder to a waiter using
   * the same `staleMs`.
   */
  renew(): Promise<Result<void>>;
}

/**
 * Claude Code treats its credential lock as stale only past 60s (a live holder
 * touches it every 5s). Matching that number means we never declare a working
 * Claude Code dead, and our own holder is judged by the same yardstick.
 */
export const CREDENTIALS_STALE_MS = 60_000;
/** The global config lock guards a local read-modify-write; 10s is generous. */
export const CONFIG_STALE_MS = 10_000;
/**
 * A credential refresh is one token-endpoint round trip. Nine seconds of
 * bounded waiting outlasts it without hanging a click forever.
 */
export const DEFAULT_LOCK_TIMEOUT_MS = 9_000;
export const DEFAULT_RETRY_MS = 250;

export const LOCK_TIMEOUT_CODE = 'lock-timeout';
export const LOCK_IO_CODE = 'lock-io';
export const LOCK_BODY_CODE = 'lock-body-threw';

/**
 * Take an exclusive advisory lock on `path`, waiting up to `timeoutMs`.
 *
 * Returns an `Err` rather than throwing on timeout or I/O failure, so callers
 * can surface "Claude Code is busy, try again" instead of a stack trace.
 */
export async function acquireLock(
  path: string,
  opts: LockOptions,
  deps: LockDeps,
): Promise<Result<LockHandle>> {
  const dir = dirnameOf(path);
  if (dir !== '') {
    try {
      await deps.fs.mkdir(dir, { recursive: true });
    } catch (e) {
      return err(`cannot create lock directory ${dir}: ${describe(e)}`, LOCK_IO_CODE);
    }
  }

  const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
  const deadline = deps.now() + Math.max(0, opts.timeoutMs);
  // A lockfile we cannot parse carries no timestamp of its own, so we date it
  // from the moment we first saw it and break it only once *that* observation
  // is older than staleMs. A corrupt but live lock is still respected.
  let unreadableSince: number | null = null;
  let holderLabel = '';

  for (;;) {
    const now = deps.now();
    const record: LockRecord = {
      pid: deps.pid ?? 0,
      ts: now,
      token: mintToken(deps, now),
    };
    if (opts.owner !== undefined) record.owner = opts.owner;
    if (deps.host !== undefined) record.host = deps.host;

    try {
      await deps.fs.writeFile(path, JSON.stringify(record), { encoding: 'utf8', flag: 'wx' });
      return ok(makeHandle(path, now, record, deps));
    } catch (e) {
      if (errnoCode(e) !== 'EEXIST') {
        return err(`cannot create lockfile ${path}: ${describe(e)}`, LOCK_IO_CODE);
      }
    }

    // Contended. Decide whether the holder is alive or abandoned.
    let raw: string;
    try {
      raw = await deps.fs.readFile(path, 'utf8');
    } catch (e) {
      // Released between our create and our read: retry immediately.
      if (errnoCode(e) === 'ENOENT') continue;
      return err(`cannot read lockfile ${path}: ${describe(e)}`, LOCK_IO_CODE);
    }

    const held = parseRecord(raw);
    if (held !== null) {
      unreadableSince = null;
      holderLabel = `pid ${held.pid}${held.owner === undefined ? '' : ` (${held.owner})`}`;
      if (deps.now() - held.ts > opts.staleMs) {
        await breakLock(path, held.token, deps);
        continue;
      }
    } else if (unreadableSince === null) {
      unreadableSince = deps.now();
    } else if (deps.now() - unreadableSince > opts.staleMs) {
      await breakLock(path, null, deps);
      unreadableSince = null;
      continue;
    }

    if (deps.now() >= deadline) {
      const who = holderLabel === '' ? '' : ` held by ${holderLabel}`;
      return err(
        `timed out after ${opts.timeoutMs}ms waiting for ${path}${who} — Claude Code may be ` +
          'refreshing its token; try again in a moment',
        LOCK_TIMEOUT_CODE,
      );
    }

    const jitter = deps.random === undefined ? Math.random() : deps.random();
    await deps.sleep(retryMs + Math.floor(jitter * retryMs));
  }
}

/**
 * Run `fn` while holding `path`. The lock is released in a `finally`, so a
 * throw inside `fn` cannot strand it; that throw comes back as an `Err`.
 */
export async function withLock<T>(
  path: string,
  opts: LockOptions,
  deps: LockDeps,
  fn: (handle: LockHandle) => Promise<T> | T,
): Promise<Result<T>> {
  const acquired = await acquireLock(path, opts, deps);
  if (!acquired.ok) return acquired;
  try {
    return ok(await fn(acquired.value));
  } catch (e) {
    return err(describe(e), LOCK_BODY_CODE);
  } finally {
    await acquired.value.release();
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function makeHandle(
  path: string,
  acquiredAt: number,
  record: LockRecord,
  deps: LockDeps,
): LockHandle {
  let released = false;
  return {
    path,
    acquiredAt,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only remove what is still ours. A lock broken as stale while we ran
      // belongs to whoever took it next, and deleting that would hand a third
      // process a lock two others believe they hold.
      if (!(await stillOurs(path, record.token, deps))) return;
      try {
        await deps.fs.unlink(path);
      } catch {
        // An orphan is broken by the next waiter's staleness check.
      }
    },
    async renew(): Promise<Result<void>> {
      if (released) return err('lock already released', LOCK_IO_CODE);
      if (!(await stillOurs(path, record.token, deps))) {
        return err(`lock ${path} was taken over by another process`, LOCK_IO_CODE);
      }
      try {
        const renewed: LockRecord = { ...record, ts: deps.now() };
        await deps.fs.writeFile(path, JSON.stringify(renewed), { encoding: 'utf8' });
        return ok(undefined);
      } catch (e) {
        return err(`cannot renew lockfile ${path}: ${describe(e)}`, LOCK_IO_CODE);
      }
    },
  };
}

/**
 * Remove a lock believed abandoned. When `token` is known we re-read first, so
 * we never delete a lock the old holder already replaced with a fresh one. Two
 * waiters can still race between that read and the unlink; the loser just loops
 * and waits again, which is why breaking is always followed by a retry rather
 * than an assumption of ownership.
 */
async function breakLock(path: string, token: string | null, deps: LockDeps): Promise<void> {
  if (token !== null && !(await stillOurs(path, token, deps))) return;
  try {
    await deps.fs.unlink(path);
  } catch {
    // Already gone, or not ours to remove: fall through to the normal wait
    // instead of spinning hot on a permission error.
  }
}

async function stillOurs(path: string, token: string, deps: LockDeps): Promise<boolean> {
  try {
    const current = parseRecord(await deps.fs.readFile(path, 'utf8'));
    return current !== null && current.token === token;
  } catch {
    return false;
  }
}

function parseRecord(raw: string): LockRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as Partial<LockRecord>;
  if (typeof candidate.ts !== 'number' || !Number.isFinite(candidate.ts)) return null;

  const record: LockRecord = {
    pid: typeof candidate.pid === 'number' ? candidate.pid : -1,
    ts: candidate.ts,
    token: typeof candidate.token === 'string' ? candidate.token : '',
  };
  if (typeof candidate.owner === 'string') record.owner = candidate.owner;
  if (typeof candidate.host === 'string') record.host = candidate.host;
  return record;
}

function mintToken(deps: LockDeps, now: number): string {
  const rand = deps.random === undefined ? Math.random() : deps.random();
  return `${deps.pid ?? 0}-${now}-${Math.floor(rand * 0xffffffff).toString(36)}`;
}

/** Structural errno read: the injected fs is not necessarily node's. */
function errnoCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Pure dirname that handles both separators; '' when the path has no parent. */
function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? '' : path.slice(0, cut);
}
