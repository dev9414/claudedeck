/**
 * `src/core/history.ts` — the NDJSON-per-UTC-day quota time series.
 *
 * The store's whole design premise is that a crash can damage the tail of one
 * file and nothing else, so the adversarial cases (a truncated line, a garbage
 * line, a line of the wrong shape) are the ones that matter most: each must
 * cost exactly the damaged record and nothing around it.
 */

import { describe, expect, it } from 'vitest';

import {
  HISTORY_QUERY_POINT_CAP,
  HISTORY_SUBDIR,
  HistoryWriteRefusedError,
  createHistoryStore,
  type HistoryStore,
} from '@core/history';
import type { HistoryPoint } from '@shared/types';

import { DAY, HOUR, MINUTE, MemoryFs, T0, fakeClock, makeHistoryPoint } from '../helpers/fixtures';

const ROOT = '/deck';
const HISTORY_DIR = `${ROOT}/${HISTORY_SUBDIR}`;

function dayFile(day: string): string {
  return `${HISTORY_DIR}/${day}.ndjson`;
}

function setup(opts: { safeMode?: boolean; dir?: string } = {}): {
  fs: MemoryFs;
  store: HistoryStore;
} {
  const fs = new MemoryFs(fakeClock());
  const store = createHistoryStore(opts.dir ?? ROOT, {
    fs: fs.asHistoryFs(),
    ...(opts.safeMode === undefined ? {} : { safeMode: () => opts.safeMode === true }),
  });
  return { fs, store };
}

function lines(points: HistoryPoint[]): string {
  return points.map((p) => `${JSON.stringify(p)}\n`).join('');
}

// ---------------------------------------------------------------------------

describe('append', () => {
  it('writes one line into the UTC day file that owns the instant', async () => {
    const { fs, store } = setup();
    await store.append(makeHistoryPoint({ t: T0, slot: 2, windows: { '5h': 42 } }));

    expect(fs.read(dayFile('2026-08-24'))).toBe('{"t":1787572800000,"slot":2,"windows":{"5h":42}}\n');
  });

  it('splits on the UTC day boundary, not the local one', async () => {
    const { fs, store } = setup();
    const endOfDay = Date.parse('2026-08-24T23:59:59.999Z');

    await store.append(makeHistoryPoint({ t: endOfDay }));
    await store.append(makeHistoryPoint({ t: endOfDay + 1 }));

    expect(fs.has(dayFile('2026-08-24'))).toBe(true);
    expect(fs.has(dayFile('2026-08-25'))).toBe(true);
  });

  it('appends rather than rewriting, so a big file is never re-read', async () => {
    const { fs, store } = setup();
    await store.append(makeHistoryPoint({ t: T0, slot: 1 }));
    fs.clearOps();
    await store.append(makeHistoryPoint({ t: T0 + MINUTE, slot: 1 }));

    expect(fs.opNames()).toEqual(['appendFile']);
    expect(fs.read(dayFile('2026-08-24'))?.split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('accepts either the deck home or the history directory itself', async () => {
    const { fs, store } = setup({ dir: HISTORY_DIR });
    await store.append(makeHistoryPoint({ t: T0 }));

    // No `history/history` nesting.
    expect(fs.has(dayFile('2026-08-24'))).toBe(true);
    expect(fs.has(`${HISTORY_DIR}/${HISTORY_SUBDIR}/2026-08-24.ndjson`)).toBe(false);
  });

  it.each([
    ['a non-finite timestamp', { t: Number.NaN }],
    ['an Infinity timestamp', { t: Number.POSITIVE_INFINITY }],
    ['a fractional slot', { slot: 1.5 }],
    ['a non-integer slot', { slot: Number.NaN }],
  ])('rejects %s as programmer error', async (_label, over) => {
    const { fs, store } = setup();
    await expect(store.append(makeHistoryPoint(over))).rejects.toBeInstanceOf(TypeError);
    expect(fs.files.size).toBe(0);
  });

  it('serializes concurrent appends without losing any', async () => {
    const { fs, store } = setup();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.append(makeHistoryPoint({ t: T0 + i * MINUTE }))),
    );
    expect(fs.read(dayFile('2026-08-24'))?.split('\n').filter(Boolean)).toHaveLength(10);
  });
});

// ---------------------------------------------------------------------------

describe('query', () => {
  async function seed(store: HistoryStore, points: HistoryPoint[]): Promise<void> {
    for (const p of points) await store.append(p);
  }

  it('returns nothing when nothing has been recorded', async () => {
    const { store } = setup();
    expect(await store.query({})).toEqual([]);
  });

  it('reads back across day files, oldest first', async () => {
    const { store } = setup();
    await seed(store, [
      makeHistoryPoint({ t: T0 + DAY, windows: { '5h': 3 } }),
      makeHistoryPoint({ t: T0, windows: { '5h': 1 } }),
      makeHistoryPoint({ t: T0 + HOUR, windows: { '5h': 2 } }),
    ]);

    expect((await store.query({})).map((p) => p.windows['5h'])).toEqual([1, 2, 3]);
  });

  it('filters by slot', async () => {
    const { store } = setup();
    await seed(store, [
      makeHistoryPoint({ t: T0, slot: 1 }),
      makeHistoryPoint({ t: T0 + MINUTE, slot: 2 }),
      makeHistoryPoint({ t: T0 + 2 * MINUTE, slot: 1 }),
    ]);

    expect(await store.query({ slot: 2 })).toHaveLength(1);
    expect(await store.query({ slot: 1 })).toHaveLength(2);
    expect(await store.query({ slot: 9 })).toEqual([]);
  });

  it('treats since and until as inclusive bounds', async () => {
    const { store } = setup();
    await seed(store, [
      makeHistoryPoint({ t: T0 }),
      makeHistoryPoint({ t: T0 + HOUR }),
      makeHistoryPoint({ t: T0 + 2 * HOUR }),
    ]);

    expect(await store.query({ since: T0, until: T0 })).toHaveLength(1);
    expect(await store.query({ since: T0, until: T0 + HOUR })).toHaveLength(2);
    expect(await store.query({ since: T0 + HOUR })).toHaveLength(2);
    expect(await store.query({ until: T0 + HOUR })).toHaveLength(2);
  });

  it('returns nothing for an inverted range', async () => {
    const { store } = setup();
    await seed(store, [makeHistoryPoint({ t: T0 })]);
    expect(await store.query({ since: T0 + HOUR, until: T0 })).toEqual([]);
  });

  it('sorts ties by slot', async () => {
    const { store } = setup();
    await seed(store, [
      makeHistoryPoint({ t: T0, slot: 3 }),
      makeHistoryPoint({ t: T0, slot: 1 }),
      makeHistoryPoint({ t: T0, slot: 2 }),
    ]);
    expect((await store.query({})).map((p) => p.slot)).toEqual([1, 2, 3]);
  });

  describe('damaged files', () => {
    it('skips a corrupt line and keeps the ones around it', async () => {
      const { fs, store } = setup();
      fs.put(
        dayFile('2026-08-24'),
        `${JSON.stringify({ t: T0, slot: 1, windows: { '5h': 1 } })}\n` +
          'not json at all\n' +
          `${JSON.stringify({ t: T0 + MINUTE, slot: 1, windows: { '5h': 2 } })}\n`,
      );

      expect((await store.query({})).map((p) => p.windows['5h'])).toEqual([1, 2]);
    });

    it('skips a truncated tail line, the classic crash artefact', async () => {
      const { fs, store } = setup();
      fs.put(
        dayFile('2026-08-24'),
        `${JSON.stringify({ t: T0, slot: 1, windows: { '5h': 1 } })}\n` +
          '{"t":1787572860000,"slot":1,"win',
      );

      expect(await store.query({})).toHaveLength(1);
    });

    it.each([
      ['a JSON array', '[1,2,3]'],
      ['a JSON scalar', '42'],
      ['a bare string', '"hello"'],
      ['an object with no t', '{"slot":1,"windows":{}}'],
      ['an object with a string t', '{"t":"now","slot":1,"windows":{}}'],
      ['an object with a fractional slot', '{"t":1,"slot":1.5,"windows":{}}'],
      ['an object with array windows', '{"t":1,"slot":1,"windows":[]}'],
      ['an object with null windows', '{"t":1,"slot":1,"windows":null}'],
      ['an object with no windows', '{"t":1,"slot":1}'],
      ['a blank line', ''],
      ['whitespace', '    '],
    ])('drops a line that is %s', async (_label, line) => {
      const { fs, store } = setup();
      fs.put(
        dayFile('2026-08-24'),
        `${line}\n${JSON.stringify({ t: T0, slot: 1, windows: { '5h': 9 } })}\n`,
      );
      expect(await store.query({})).toEqual([{ t: T0, slot: 1, windows: { '5h': 9 } }]);
    });

    it('drops one junk window value but keeps the observation', async () => {
      const { fs, store } = setup();
      fs.put(
        dayFile('2026-08-24'),
        `${JSON.stringify({ t: T0, slot: 1, windows: { '5h': 10, '7d': 'nope', 'Fable': null } })}\n`,
      );
      expect(await store.query({})).toEqual([{ t: T0, slot: 1, windows: { '5h': 10 } }]);
    });

    it('ignores files whose names are not day keys', async () => {
      const { fs, store } = setup();
      fs.put(`${HISTORY_DIR}/notes.txt`, 'hello');
      fs.put(`${HISTORY_DIR}/2026-8-4.ndjson`, '{"t":1,"slot":1,"windows":{}}\n');
      fs.put(dayFile('2026-08-24'), `${JSON.stringify({ t: T0, slot: 1, windows: {} })}\n`);

      expect(await store.query({})).toHaveLength(1);
    });

    it('tolerates a file pruned out from under the reader', async () => {
      const { fs, store } = setup();
      fs.put(dayFile('2026-08-24'), `${JSON.stringify({ t: T0, slot: 1, windows: {} })}\n`);
      fs.fail('readFile', { code: 'ENOENT' });

      expect(await store.query({})).toEqual([]);
    });

    it('propagates a real I/O failure rather than silently returning nothing', async () => {
      const { fs, store } = setup();
      fs.put(dayFile('2026-08-24'), '{}\n');
      fs.fail('readFile', { code: 'EIO' });

      await expect(store.query({})).rejects.toThrow();
    });
  });

  describe('downsampling', () => {
    it('returns raw samples for a small range', async () => {
      const { fs, store } = setup();
      const points = Array.from({ length: 500 }, (_, i) =>
        makeHistoryPoint({ t: T0 + i * 1000, slot: 1, windows: { '5h': i / 10 } }),
      );
      fs.put(dayFile('2026-08-24'), lines(points));

      expect(await store.query({})).toHaveLength(500);
    });

    it('folds a very large range down to the cap, keeping the peak', async () => {
      const { fs, store } = setup();
      const count = 8_500; // past the raw buffer limit, so folding kicks in
      const points = Array.from({ length: count }, (_, i) =>
        makeHistoryPoint({ t: T0 + i * 1000, slot: 1, windows: { '5h': 10 } }),
      );
      // One spike the chart must not lose.
      points[4_000] = makeHistoryPoint({ t: T0 + 4_000_000, slot: 1, windows: { '5h': 97 } });
      fs.put(dayFile('2026-08-24'), lines(points));

      const out = await store.query({});

      expect(out.length).toBeLessThanOrEqual(HISTORY_QUERY_POINT_CAP);
      expect(out.length).toBeGreaterThan(0);
      expect(Math.max(...out.map((p) => p.windows['5h'] ?? 0))).toBe(97);
      // Still ordered, and the spike keeps its position on the time axis.
      expect(out.map((p) => p.t)).toEqual([...out.map((p) => p.t)].sort((a, b) => a - b));
      expect(out.find((p) => p.windows['5h'] === 97)?.t).toBe(T0 + 4_000_000);
    });

    it('buckets each slot separately', async () => {
      const { fs, store } = setup();
      const points: HistoryPoint[] = [];
      for (let i = 0; i < 4_500; i += 1) {
        points.push(makeHistoryPoint({ t: T0 + i * 1000, slot: 1, windows: { '5h': 1 } }));
        points.push(makeHistoryPoint({ t: T0 + i * 1000, slot: 2, windows: { '5h': 2 } }));
      }
      fs.put(dayFile('2026-08-24'), lines(points));

      const out = await store.query({});
      expect(out.some((p) => p.slot === 1)).toBe(true);
      expect(out.some((p) => p.slot === 2)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------

describe('prune', () => {
  async function seedDays(fs: MemoryFs, days: string[]): Promise<void> {
    for (const day of days) {
      const t = Date.parse(`${day}T06:00:00.000Z`);
      fs.put(dayFile(day), lines([makeHistoryPoint({ t, slot: 1 })]));
    }
  }

  it('unlinks whole day files older than the cutoff and reports what went', async () => {
    const { fs, store } = setup();
    await seedDays(fs, ['2026-08-01', '2026-08-20', '2026-08-24']);

    const dropped = await store.prune(7, T0);

    expect(dropped).toBe(1);
    expect(fs.has(dayFile('2026-08-01'))).toBe(false);
    expect(fs.has(dayFile('2026-08-20'))).toBe(true);
    expect(fs.has(dayFile('2026-08-24'))).toBe(true);
  });

  it('keeps the day the cutoff lands on', async () => {
    const { fs, store } = setup();
    await seedDays(fs, ['2026-08-17', '2026-08-16']);

    // 7 days before 2026-08-24 is 2026-08-17, which survives.
    await store.prune(7, T0);
    expect(fs.has(dayFile('2026-08-17'))).toBe(true);
    expect(fs.has(dayFile('2026-08-16'))).toBe(false);
  });

  it('drops everything at zero retention except today', async () => {
    const { fs, store } = setup();
    await seedDays(fs, ['2026-08-23', '2026-08-24']);

    await store.prune(0, T0);
    expect(fs.has(dayFile('2026-08-23'))).toBe(false);
    expect(fs.has(dayFile('2026-08-24'))).toBe(true);
  });

  it('is a no-op when there is nothing recorded', async () => {
    const { store } = setup();
    expect(await store.prune(30, T0)).toBe(0);
  });

  it.each([
    ['a negative retention', -1, T0],
    ['a non-finite retention', Number.NaN, T0],
    ['a non-finite now', 30, Number.NaN],
  ])('rejects %s as programmer error', async (_label, days, now) => {
    const { store } = setup();
    await expect(store.prune(days, now)).rejects.toBeInstanceOf(TypeError);
  });
});

// ---------------------------------------------------------------------------

describe('compact', () => {
  it('sorts, de-duplicates and strips damaged lines', async () => {
    const { fs, store } = setup();
    fs.put(
      dayFile('2026-08-24'),
      [
        JSON.stringify({ t: T0 + HOUR, slot: 1, windows: { '5h': 20 } }),
        'garbage',
        JSON.stringify({ t: T0, slot: 1, windows: { '5h': 10 } }),
        // A re-poll at the same instant is a correction: last write wins.
        JSON.stringify({ t: T0, slot: 1, windows: { '5h': 11 } }),
        '',
      ].join('\n'),
    );

    await store.compact();

    expect(fs.read(dayFile('2026-08-24'))).toBe(
      `${JSON.stringify({ t: T0, slot: 1, windows: { '5h': 11 } })}\n` +
        `${JSON.stringify({ t: T0 + HOUR, slot: 1, windows: { '5h': 20 } })}\n`,
    );
  });

  it('keeps observations from different slots at the same instant', async () => {
    const { fs, store } = setup();
    fs.put(
      dayFile('2026-08-24'),
      lines([
        makeHistoryPoint({ t: T0, slot: 2, windows: { '5h': 2 } }),
        makeHistoryPoint({ t: T0, slot: 1, windows: { '5h': 1 } }),
      ]),
    );

    await store.compact();
    expect(await store.query({})).toHaveLength(2);
  });

  it('swaps the rewrite in atomically', async () => {
    const { fs, store } = setup();
    fs.put(dayFile('2026-08-24'), `junk\n${JSON.stringify(makeHistoryPoint({ t: T0 }))}\n`);
    fs.clearOps();

    await store.compact();

    const write = fs.ops.find((o) => o.op === 'writeFile');
    const rename = fs.ops.find((o) => o.op === 'rename');
    expect(write?.path).toBe(`${dayFile('2026-08-24')}.tmp`);
    expect(rename?.detail).toBe(dayFile('2026-08-24'));
    expect(fs.tempFiles()).toEqual([]);
  });

  it('does not churn a file that is already clean', async () => {
    const { fs, store } = setup();
    fs.put(dayFile('2026-08-24'), lines([makeHistoryPoint({ t: T0 })]));
    fs.clearOps();

    await store.compact();
    expect(fs.ops.some((o) => o.op === 'writeFile' || o.op === 'rename')).toBe(false);
  });

  it('unlinks a file that contained nothing salvageable', async () => {
    const { fs, store } = setup();
    fs.put(dayFile('2026-08-24'), 'junk\nmore junk\n');

    await store.compact();
    expect(fs.has(dayFile('2026-08-24'))).toBe(false);
  });

  it('is a no-op with no history directory', async () => {
    const { store } = setup();
    await expect(store.compact()).resolves.toBeUndefined();
  });

  it('does not lose an append that races it', async () => {
    const { fs, store } = setup();
    fs.put(dayFile('2026-08-24'), `junk\n${JSON.stringify(makeHistoryPoint({ t: T0 }))}\n`);

    await Promise.all([
      store.compact(),
      store.append(makeHistoryPoint({ t: T0 + HOUR, windows: { '5h': 55 } })),
    ]);

    const out = await store.query({});
    expect(out).toHaveLength(2);
    expect(out.some((p) => p.windows['5h'] === 55)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('safe mode', () => {
  it.each([
    ['append', (s: HistoryStore) => s.append(makeHistoryPoint({ t: T0 }))],
    ['prune', (s: HistoryStore) => s.prune(1, T0)],
    ['compact', (s: HistoryStore) => s.compact()],
  ])('refuses %s loudly rather than dropping the data silently', async (_label, run) => {
    const { fs, store } = setup({ safeMode: true });
    fs.put(dayFile('2026-08-01'), lines([makeHistoryPoint({ t: Date.parse('2026-08-01T00:00:00Z') })]));
    const before = fs.snapshot();

    await expect(run(store)).rejects.toBeInstanceOf(HistoryWriteRefusedError);
    expect(fs.snapshot()).toEqual(before);
  });

  it('still allows reads', async () => {
    const { fs, store } = setup({ safeMode: true });
    fs.put(dayFile('2026-08-24'), lines([makeHistoryPoint({ t: T0 })]));

    expect(await store.query({})).toHaveLength(1);
  });

  it('names the operation in the message', async () => {
    const { store } = setup({ safeMode: true });
    await expect(store.append(makeHistoryPoint({ t: T0 }))).rejects.toThrow(/refusing to append to/);
  });
});
