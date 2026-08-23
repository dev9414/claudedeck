/**
 * `src/core/locks.ts` — the cross-process advisory lock guarding the credential
 * store.
 *
 * Two failure modes matter more than the happy path: a lock left behind by a
 * killed process must eventually be breakable (or the app wedges forever), and
 * a lock that was broken out from under us must never be deleted by its former
 * owner (or two processes both believe they hold it). Both get direct tests.
 *
 * The clock and `sleep` are injected, so the waiting loops run instantly and
 * deterministically — no timers, no flake.
 */

import { describe, expect, it } from 'vitest';

import {
  CONFIG_STALE_MS,
  CREDENTIALS_STALE_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_RETRY_MS,
  LOCK_BODY_CODE,
  LOCK_IO_CODE,
  LOCK_TIMEOUT_CODE,
  acquireLock,
  withLock,
  type LockDeps,
  type LockOptions,
  type LockRecord,
} from '@core/locks';

import {
  MINUTE,
  MemoryFs,
  SAMPLE_ACCESS_TOKEN,
  T0,
  expectNoSecrets,
  fakeClock,
  unwrap,
  unwrapErr,
} from '../helpers/fixtures';

const LOCK = '/sandbox/.claude/.credentials.json.claudedeck.lock';

function setup(over: Partial<LockDeps> = {}): {
  fs: MemoryFs;
  clock: ReturnType<typeof fakeClock>;
  deps: LockDeps;
} {
  const clock = fakeClock();
  const fs = new MemoryFs(clock);
  const deps: LockDeps = {
    fs: fs.asLockFs(),
    now: clock.now,
    sleep: clock.sleep,
    pid: 4242,
    random: () => 0.5,
    host: 'test-host',
    ...over,
  };
  return { fs, clock, deps };
}

function opts(over: Partial<LockOptions> = {}): LockOptions {
  return { timeoutMs: 1000, staleMs: CREDENTIALS_STALE_MS, ...over };
}

function readRecord(fs: MemoryFs, path = LOCK): LockRecord {
  return JSON.parse(fs.read(path) ?? '{}') as LockRecord;
}

// ---------------------------------------------------------------------------

describe('acquireLock', () => {
  it('creates the lockfile exclusively and records who holds it', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts({ owner: 'switch:slot-2' }), deps));

    expect(handle.path).toBe(LOCK);
    expect(handle.acquiredAt).toBe(T0);
    expect(readRecord(fs)).toMatchObject({
      pid: 4242,
      ts: T0,
      owner: 'switch:slot-2',
      host: 'test-host',
    });
    expect(readRecord(fs).token).toBeTruthy();

    // The exclusive create flag is what makes this a mutex at all.
    expect(fs.ops.find((o) => o.op === 'writeFile')?.detail).toBe('wx');
  });

  it('creates the parent directory first', async () => {
    const { fs, deps } = setup();
    await acquireLock(LOCK, opts(), deps);
    expect(fs.opNames()[0]).toBe('mkdir');
  });

  it('omits owner and host when they were not supplied', async () => {
    const { fs, deps } = setup({ host: undefined });
    await acquireLock(LOCK, opts(), deps);

    const record = readRecord(fs);
    expect(record).not.toHaveProperty('owner');
    expect(record).not.toHaveProperty('host');
  });

  it('mints a distinct token per acquisition', async () => {
    let seed = 0;
    const { fs, deps } = setup({ random: () => (seed += 0.11) % 1 });

    const first = unwrap(await acquireLock(LOCK, opts(), deps));
    const tokenA = readRecord(fs).token;
    await first.release();
    await acquireLock(LOCK, opts(), deps);

    expect(readRecord(fs).token).not.toBe(tokenA);
  });

  it('never writes a secret into the lockfile', async () => {
    const { fs, deps } = setup();
    await acquireLock(LOCK, opts({ owner: `switch:${SAMPLE_ACCESS_TOKEN.slice(0, 6)}` }), deps);
    expectNoSecrets(fs.read(LOCK) ?? '');
  });

  describe('contention', () => {
    it('times out against a live holder and names it', async () => {
      const { fs, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0, token: 'theirs', owner: 'claude-code' }));

      const e = unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 1000 }), deps));

      expect(e.code).toBe(LOCK_TIMEOUT_CODE);
      expect(e.error).toContain('pid 99');
      expect(e.error).toContain('claude-code');
      expect(e.error).toContain('Claude Code may be refreshing its token');
      // The holder's file is untouched.
      expect(readRecord(fs).token).toBe('theirs');
    });

    it('gives up immediately with a zero timeout', async () => {
      const { fs, clock, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0, token: 'theirs' }));

      expect(unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 0 }), deps)).code).toBe(
        LOCK_TIMEOUT_CODE,
      );
      expect(clock.sleeps).toEqual([]);
    });

    it('waits with jittered retries between attempts', async () => {
      const { fs, clock, deps } = setup({ random: () => 0.5 });
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0 + MINUTE, token: 'theirs' }));

      await acquireLock(LOCK, opts({ timeoutMs: 1000, retryMs: 200 }), deps);

      expect(clock.sleeps.length).toBeGreaterThan(0);
      // base + floor(random * base)
      for (const slept of clock.sleeps) expect(slept).toBe(300);
    });

    it('defaults the retry gap when none is given', async () => {
      const { fs, clock, deps } = setup({ random: () => 0 });
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0 + MINUTE, token: 'theirs' }));

      await acquireLock(LOCK, opts({ timeoutMs: DEFAULT_RETRY_MS }), deps);
      expect(clock.sleeps[0]).toBe(DEFAULT_RETRY_MS);
    });

    it('retries immediately when the holder releases between our create and our read', async () => {
      const { fs, clock, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0, token: 'theirs' }));
      // The create fails EEXIST, then the read finds the file already gone.
      fs.fail('readFile', { code: 'ENOENT' });
      fs.files.delete(LOCK);

      expect((await acquireLock(LOCK, opts(), deps)).ok).toBe(true);
      expect(clock.sleeps).toEqual([]);
    });
  });

  describe('breaking an abandoned lock', () => {
    it('takes over a lock whose timestamp is older than staleMs', async () => {
      const { fs, deps } = setup();
      fs.put(
        LOCK,
        JSON.stringify({ pid: 99, ts: T0 - CREDENTIALS_STALE_MS - 1, token: 'dead' }),
      );

      const handle = unwrap(await acquireLock(LOCK, opts(), deps));

      expect(handle.acquiredAt).toBe(T0);
      expect(readRecord(fs).pid).toBe(4242);
    });

    it('respects a lock that is stale by less than the threshold', async () => {
      const { fs, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0 - CREDENTIALS_STALE_MS + 1, token: 'alive' }));

      expect(unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 0 }), deps)).code).toBe(
        LOCK_TIMEOUT_CODE,
      );
    });

    it('does not break a lock the holder renewed between the verdict and the unlink', async () => {
      const { fs, clock, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0 - CREDENTIALS_STALE_MS - 1, token: 'old' }));

      // The first read sees a stale record and condemns it. Before the unlink
      // lands, the (very much alive) holder renews — so the re-read inside
      // `breakLock` must abort the delete.
      let reads = 0;
      const renewed = JSON.stringify({ pid: 99, ts: clock.now(), token: 'renewed' });
      const racing: LockDeps = {
        ...deps,
        fs: {
          ...deps.fs,
          async readFile(path, encoding) {
            reads += 1;
            if (reads >= 2) fs.put(LOCK, renewed);
            return deps.fs.readFile(path, encoding);
          },
        },
      };

      const result = await acquireLock(LOCK, opts({ timeoutMs: 0 }), racing);

      expect(result.ok).toBe(false);
      expect(readRecord(fs).token).toBe('renewed');
    });

    it('respects a corrupt lockfile at first, then breaks it once the sighting ages out', async () => {
      const { fs, clock, deps } = setup();
      fs.put(LOCK, 'this is not JSON');

      // A corrupt-but-live lock has no timestamp, so it is dated from when we
      // first saw it; sleeping past staleMs is what makes it breakable.
      const result = await acquireLock(
        LOCK,
        opts({ timeoutMs: 5 * CREDENTIALS_STALE_MS, retryMs: 20_000, staleMs: CONFIG_STALE_MS }),
        deps,
      );

      expect(result.ok).toBe(true);
      expect(readRecord(fs).pid).toBe(4242);
      expect(clock.sleeps.length).toBeGreaterThan(0);
    });

    it('never breaks a corrupt lockfile on the first sighting', async () => {
      const { fs, deps } = setup();
      fs.put(LOCK, '{{{');

      expect(unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 0 }), deps)).code).toBe(
        LOCK_TIMEOUT_CODE,
      );
      expect(fs.read(LOCK)).toBe('{{{');
    });

    it.each([
      ['a record with no ts', '{"pid":1,"token":"x"}'],
      ['a record with a string ts', '{"pid":1,"ts":"now","token":"x"}'],
      ['a JSON scalar', '7'],
      ['null', 'null'],
    ])('treats %s as unparseable rather than stale', async (_label, body) => {
      const { fs, deps } = setup();
      fs.put(LOCK, body);
      expect(unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 0 }), deps)).code).toBe(
        LOCK_TIMEOUT_CODE,
      );
    });

    it('tolerates a record missing pid and token', async () => {
      const { fs, deps } = setup();
      fs.put(LOCK, JSON.stringify({ ts: T0 - CREDENTIALS_STALE_MS - 1 }));

      expect((await acquireLock(LOCK, opts(), deps)).ok).toBe(true);
    });
  });

  describe('I/O failures', () => {
    it('reports a mkdir failure', async () => {
      const { fs, deps } = setup();
      fs.fail('mkdir', { code: 'EACCES' });

      const e = unwrapErr(await acquireLock(LOCK, opts(), deps));
      expect(e.code).toBe(LOCK_IO_CODE);
      expect(e.error).toContain('cannot create lock directory');
    });

    it('reports a non-EEXIST create failure', async () => {
      const { fs, deps } = setup();
      fs.fail('writeFile', { code: 'EROFS' });

      const e = unwrapErr(await acquireLock(LOCK, opts(), deps));
      expect(e.code).toBe(LOCK_IO_CODE);
      expect(e.error).toContain('cannot create lockfile');
    });

    it('reports a non-ENOENT read failure', async () => {
      const { fs, deps } = setup();
      fs.put(LOCK, JSON.stringify({ pid: 1, ts: T0, token: 'x' }));
      fs.fail('readFile', { code: 'EIO' });

      const e = unwrapErr(await acquireLock(LOCK, opts(), deps));
      expect(e.code).toBe(LOCK_IO_CODE);
      expect(e.error).toContain('cannot read lockfile');
    });
  });

  it('handles a path with no parent directory', async () => {
    const { fs, deps } = setup();
    fs.mkdirp('/');
    expect((await acquireLock('/root.lock', opts(), deps)).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('LockHandle', () => {
  it('release removes the lockfile', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));

    await handle.release();
    expect(fs.has(LOCK)).toBe(false);
  });

  it('release is idempotent', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));

    await handle.release();
    fs.clearOps();
    await handle.release();

    expect(fs.ops).toEqual([]);
  });

  it('release never throws, even when the file is already gone', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));
    fs.files.delete(LOCK);

    await expect(handle.release()).resolves.toBeUndefined();
  });

  it('release does not delete a lock that was taken over while we ran', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));

    // Somebody broke ours as stale and took it.
    fs.put(LOCK, JSON.stringify({ pid: 777, ts: T0, token: 'theirs' }));
    await handle.release();

    // Deleting here would hand a third process a lock two others hold.
    expect(readRecord(fs).token).toBe('theirs');
  });

  it('renew pushes the timestamp forward', async () => {
    const { fs, clock, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts({ owner: 'switch' }), deps));
    const token = readRecord(fs).token;

    clock.advance(30_000);
    expect(unwrap(await handle.renew())).toBeUndefined();

    expect(readRecord(fs)).toMatchObject({ ts: T0 + 30_000, token, owner: 'switch' });
  });

  it('renew fails after release', async () => {
    const { deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));
    await handle.release();

    const e = unwrapErr(await handle.renew());
    expect(e.code).toBe(LOCK_IO_CODE);
    expect(e.error).toContain('already released');
  });

  it('renew fails after a takeover', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));
    fs.put(LOCK, JSON.stringify({ pid: 777, ts: T0, token: 'theirs' }));

    expect(unwrapErr(await handle.renew()).error).toContain('taken over');
  });

  it('renew reports a write failure', async () => {
    const { fs, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts(), deps));
    fs.fail('writeFile', { code: 'EIO' });

    expect(unwrapErr(await handle.renew()).code).toBe(LOCK_IO_CODE);
  });

  it('a renewed lock is no longer stale to a waiter', async () => {
    const { fs, clock, deps } = setup();
    const handle = unwrap(await acquireLock(LOCK, opts({ staleMs: CONFIG_STALE_MS }), deps));

    clock.advance(CONFIG_STALE_MS - 1);
    await handle.renew();
    clock.advance(CONFIG_STALE_MS - 1);

    const other = setup({ pid: 999 });
    const contender = { ...other.deps, fs: fs.asLockFs(), now: clock.now, sleep: clock.sleep };
    expect(
      unwrapErr(await acquireLock(LOCK, opts({ timeoutMs: 0, staleMs: CONFIG_STALE_MS }), contender))
        .code,
    ).toBe(LOCK_TIMEOUT_CODE);
  });
});

// ---------------------------------------------------------------------------

describe('withLock', () => {
  it('runs the body under the lock and releases afterwards', async () => {
    const { fs, deps } = setup();
    const seen: boolean[] = [];

    const result = await withLock(LOCK, opts(), deps, () => {
      seen.push(fs.has(LOCK));
      return 'value';
    });

    expect(unwrap(result)).toBe('value');
    expect(seen).toEqual([true]);
    expect(fs.has(LOCK)).toBe(false);
  });

  it('awaits an async body', async () => {
    const { deps } = setup();
    const result = await withLock(LOCK, opts(), deps, async () => 42);
    expect(unwrap(result)).toBe(42);
  });

  it('turns a throwing body into an Err and still releases', async () => {
    const { fs, deps } = setup();
    const result = await withLock(LOCK, opts(), deps, () => {
      throw new Error('body exploded');
    });

    const e = unwrapErr(result);
    expect(e.code).toBe(LOCK_BODY_CODE);
    expect(e.error).toBe('body exploded');
    expect(fs.has(LOCK)).toBe(false);
  });

  it('handles a body that throws a non-Error', async () => {
    const { deps } = setup();
    expect(unwrapErr(await withLock(LOCK, opts(), deps, () => Promise.reject('nope'))).error).toBe(
      'nope',
    );
  });

  it('does not run the body when the lock cannot be taken', async () => {
    const { fs, deps } = setup();
    fs.put(LOCK, JSON.stringify({ pid: 99, ts: T0, token: 'theirs' }));
    let ran = false;

    const result = await withLock(LOCK, opts({ timeoutMs: 0 }), deps, () => {
      ran = true;
    });

    expect(ran).toBe(false);
    expect(unwrapErr(result).code).toBe(LOCK_TIMEOUT_CODE);
    expect(readRecord(fs).token).toBe('theirs');
  });

  it('hands the body a renewable handle', async () => {
    const { fs, clock, deps } = setup();
    await withLock(LOCK, opts(), deps, async (handle) => {
      clock.advance(10_000);
      expect((await handle.renew()).ok).toBe(true);
      expect(readRecord(fs).ts).toBe(T0 + 10_000);
    });
  });

  it('serialises two callers against each other', async () => {
    const { clock, deps } = setup();
    const order: string[] = [];

    const first = withLock(LOCK, opts({ timeoutMs: 5000, retryMs: 50 }), deps, async () => {
      order.push('first:start');
      await clock.sleep(10);
      order.push('first:end');
    });
    const second = withLock(LOCK, opts({ timeoutMs: 5000, retryMs: 50 }), deps, () => {
      order.push('second');
    });

    expect(unwrap(await first)).toBeUndefined();
    expect(unwrap(await second)).toBeUndefined();
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});

describe('the tuning constants', () => {
  it('match what Claude Code itself considers abandoned', () => {
    expect(CREDENTIALS_STALE_MS).toBe(60_000);
    expect(CONFIG_STALE_MS).toBe(10_000);
    expect(DEFAULT_LOCK_TIMEOUT_MS).toBe(9_000);
  });
});
