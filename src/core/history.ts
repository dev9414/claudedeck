/**
 * The quota time series: an append-only, bounded, crash-safe local store of
 * `HistoryPoint`s.
 *
 * Layout is one newline-delimited-JSON file per UTC day
 * (`<deckHome>/history/YYYY-MM-DD.ndjson`). That shape is deliberate:
 *  - appending is one `appendFile` of one line, so a poll never rewrites a
 *    large file and never holds the whole series in memory;
 *  - pruning old data is an `unlink`, not a rewrite;
 *  - a torn line from a crash mid-write only damages the tail of one day, and
 *    the reader skips unparseable lines instead of failing the whole query.
 *
 * All I/O is injected so tests can run against a fake fs or a temp dir; this
 * module never imports `node:fs` itself.
 */

import { basename, join } from 'node:path';
import type { HistoryPoint } from '@shared/types';
import type { HistoryQuery } from '@shared/ipc';

const DAY_MS = 86_400_000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.ndjson$/;

/** Sub-directory of the deck home that holds the day files. */
export const HISTORY_SUBDIR = 'history';

/**
 * Upper bound on the points a single `query` may return. Beyond this the range
 * is downsampled; a chart cannot render more than a couple of thousand points
 * usefully anyway, and this array crosses the IPC boundary on every read.
 */
export const HISTORY_QUERY_POINT_CAP = 2000;

/**
 * How many raw points a query buffers before it switches to bucketed folding.
 * Below this we return the exact samples (small ranges must stay lossless);
 * above it memory is bounded by the bucket count, not by the file size.
 */
const RAW_BUFFER_LIMIT = HISTORY_QUERY_POINT_CAP * 4;

/**
 * Hard cap on lines parsed out of a single day file. A day of 30-second polls
 * across a dozen accounts is a few thousand lines, so hitting this means the
 * file is corrupt or someone else appended to it; we keep the newest lines
 * because recent quota data is what the app reasons about.
 */
const MAX_LINES_PER_FILE = 250_000;

/** The slice of `node:fs/promises` this store needs. Satisfied by it directly. */
export interface HistoryFs {
  mkdir(path: string, options: { recursive: true }): Promise<string | undefined>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  appendFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

export interface HistoryDeps {
  fs: HistoryFs;
  /**
   * Reads `settings.safeMode`. When it returns true every write is refused
   * with `HistoryWriteRefusedError` rather than dropped silently, so the guard
   * surfaces instead of losing data behind the user's back.
   */
  safeMode?: () => boolean;
}

export interface HistoryStore {
  /** Append one observation to the UTC day file that owns `p.t`. */
  append(p: HistoryPoint): Promise<void>;
  /** Read a range, downsampled to at most `HISTORY_QUERY_POINT_CAP` points. */
  query(q: HistoryQuery): Promise<HistoryPoint[]>;
  /** Unlink whole day files older than the retention cutoff; returns points dropped. */
  prune(retentionDays: number, now: number): Promise<number>;
  /** Rewrite each day file sorted, de-duplicated, and free of damaged lines. */
  compact(): Promise<void>;
}

export class HistoryWriteRefusedError extends Error {
  constructor(operation: string) {
    super(`safe mode is enabled: refusing to ${operation} history on disk`);
    this.name = 'HistoryWriteRefusedError';
  }
}

/** UTC day key (`YYYY-MM-DD`) for an epoch-ms instant. */
function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

interface DayFile {
  day: string;
  path: string;
  /** Inclusive epoch-ms bounds of the UTC day this file covers. */
  startMs: number;
  endMs: number;
}

/**
 * Parses one NDJSON line into a point, or null when the line is damaged.
 * Damage is expected -- a crash can truncate the last line -- never fatal.
 */
function parsePoint(line: string): HistoryPoint | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.charCodeAt(0) !== 0x7b /* { */) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const raw = parsed as Record<string, unknown>;
  const t = raw['t'];
  const slot = raw['slot'];
  const rawWindows = raw['windows'];
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  if (typeof slot !== 'number' || !Number.isInteger(slot)) return null;
  if (typeof rawWindows !== 'object' || rawWindows === null || Array.isArray(rawWindows)) {
    return null;
  }

  const windows: Record<string, number> = {};
  for (const [key, value] of Object.entries(rawWindows as Record<string, unknown>)) {
    // Drop an individual junk value rather than the whole observation.
    if (typeof value === 'number' && Number.isFinite(value)) windows[key] = value;
  }
  return { t, slot, windows };
}

/** Serialized form: normalized, so compaction produces byte-stable output. */
function serializePoint(p: HistoryPoint): string {
  return `${JSON.stringify({ t: p.t, slot: p.slot, windows: p.windows })}\n`;
}

/** Highest utilization in one observation -- the value that gates the account. */
function peakOf(p: HistoryPoint): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (const value of Object.values(p.windows)) if (value > peak) peak = value;
  return peak === Number.NEGATIVE_INFINITY ? 0 : peak;
}

function byTimeThenSlot(a: HistoryPoint, b: HistoryPoint): number {
  return a.t - b.t || a.slot - b.slot;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

export function createHistoryStore(dir: string, deps: HistoryDeps): HistoryStore {
  const { fs } = deps;
  // Callers disagree about whether they hand over the deck home or the history
  // directory itself; accept either rather than nesting `history/history`.
  const root = basename(dir) === HISTORY_SUBDIR ? dir : join(dir, HISTORY_SUBDIR);

  let dirReady: Promise<void> | null = null;
  const ensureDir = (): Promise<void> => {
    dirReady ??= fs.mkdir(root, { recursive: true }).then(() => undefined);
    return dirReady;
  };

  // Writers and the compactor must not interleave: compaction reads a day file
  // and renames a rewrite over it, so an append landing in between would be
  // lost. One in-process queue is enough -- the store assumes a single writer.
  let queueTail: Promise<unknown> = Promise.resolve();
  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queueTail.then(work, work);
    queueTail = run.catch(() => undefined);
    return run;
  };

  const assertWritable = (operation: string): void => {
    if (deps.safeMode?.() === true) throw new HistoryWriteRefusedError(operation);
  };

  const pathForDay = (day: string): string => join(root, `${day}.ndjson`);

  async function listDayFiles(): Promise<DayFile[]> {
    let names: string[];
    try {
      names = await fs.readdir(root);
    } catch (error) {
      if (isMissing(error)) return []; // nothing recorded yet is not an error
      throw error;
    }

    const files: DayFile[] = [];
    for (const name of names) {
      const day = DAY_FILE_RE.exec(name)?.[1];
      if (day === undefined) continue;
      const startMs = Date.parse(`${day}T00:00:00.000Z`);
      if (!Number.isFinite(startMs)) continue;
      files.push({ day, path: join(root, name), startMs, endMs: startMs + DAY_MS - 1 });
    }
    files.sort((a, b) => a.startMs - b.startMs);
    return files;
  }

  async function readPoints(file: DayFile): Promise<HistoryPoint[]> {
    let text: string;
    try {
      text = await fs.readFile(file.path, 'utf8');
    } catch (error) {
      if (isMissing(error)) return []; // pruned out from under us
      throw error;
    }
    const lines = text.split('\n');
    const bounded = lines.length > MAX_LINES_PER_FILE ? lines.slice(-MAX_LINES_PER_FILE) : lines;
    const points: HistoryPoint[] = [];
    for (const line of bounded) {
      const point = parsePoint(line);
      if (point !== null) points.push(point);
    }
    return points;
  }

  return {
    async append(p: HistoryPoint): Promise<void> {
      if (!Number.isFinite(p.t) || !Number.isInteger(p.slot)) {
        throw new TypeError('history point needs a finite `t` and an integer `slot`');
      }
      assertWritable('append to');
      const line = serializePoint(p);
      await serialized(async () => {
        await ensureDir();
        // One line, one append syscall: a crash can truncate this line but
        // cannot corrupt the lines already on disk.
        await fs.appendFile(pathForDay(dayKey(p.t)), line, 'utf8');
      });
    },

    async query(q: HistoryQuery): Promise<HistoryPoint[]> {
      const since = q.since ?? Number.NEGATIVE_INFINITY;
      const until = q.until ?? Number.POSITIVE_INFINITY;
      if (since > until) return [];

      const relevant = (await listDayFiles()).filter(
        (f) => f.endMs >= since && f.startMs <= until,
      );
      const first = relevant[0];
      const last = relevant[relevant.length - 1];
      if (first === undefined || last === undefined) return [];

      // Bucket width comes from the requested range, not the sample count, so
      // folding can happen while streaming files and stays stable across calls.
      const rangeStart = Math.max(since, first.startMs);
      const rangeEnd = Math.min(until, last.endMs);
      const bucketMs = Math.max(
        1,
        Math.ceil((rangeEnd - rangeStart + 1) / HISTORY_QUERY_POINT_CAP),
      );

      // Downsampling keeps the MAX per bucket, never the mean or the last
      // sample: on a quota chart the peak is the meaningful value -- it is what
      // trips a rate limit -- and averaging would erase exactly the spikes the
      // user opened the chart to find. The cost is that a window reset inside a
      // bucket is smoothed over; at these bucket widths that is sub-pixel.
      const buckets = new Map<string, { point: HistoryPoint; peak: number }>();
      const fold = (point: HistoryPoint): void => {
        const key = `${point.slot}:${Math.floor((point.t - rangeStart) / bucketMs)}`;
        const existing = buckets.get(key);
        const peak = peakOf(point);
        if (existing === undefined) {
          buckets.set(key, { point, peak });
          return;
        }
        const merged = existing.point.windows;
        for (const [windowKey, value] of Object.entries(point.windows)) {
          const prev = merged[windowKey];
          if (prev === undefined || value > prev) merged[windowKey] = value;
        }
        // Anchor the bucket at the instant of its highest observation so the
        // peak keeps its true position on the time axis.
        if (peak > existing.peak) {
          existing.peak = peak;
          existing.point.t = point.t;
        }
      };

      let raw: HistoryPoint[] | null = [];
      for (const file of relevant) {
        for (const point of await readPoints(file)) {
          if (q.slot !== undefined && point.slot !== q.slot) continue;
          if (point.t < since || point.t > until) continue;
          if (raw !== null) {
            raw.push(point);
            if (raw.length > RAW_BUFFER_LIMIT) {
              for (const buffered of raw) fold(buffered);
              raw = null;
            }
          } else {
            fold(point);
          }
        }
      }

      if (raw !== null) return raw.sort(byTimeThenSlot);
      return [...buckets.values()].map((b) => b.point).sort(byTimeThenSlot);
    },

    async prune(retentionDays: number, now: number): Promise<number> {
      if (!Number.isFinite(retentionDays) || retentionDays < 0) {
        throw new TypeError('retentionDays must be a non-negative finite number');
      }
      if (!Number.isFinite(now)) throw new TypeError('now must be a finite epoch-ms value');
      assertWritable('prune');

      // Whole days only. Trimming the partial day at the cutoff would mean
      // rewriting a file that is actively being appended to, to reclaim at most
      // one day of points.
      const cutoffDay = dayKey(now - retentionDays * DAY_MS);
      return serialized(async () => {
        let dropped = 0;
        for (const file of await listDayFiles()) {
          if (file.day >= cutoffDay) continue; // ISO day keys sort lexicographically
          const points = await readPoints(file);
          try {
            await fs.unlink(file.path);
          } catch (error) {
            if (isMissing(error)) continue;
            throw error;
          }
          dropped += points.length;
        }
        return dropped;
      });
    },

    async compact(): Promise<void> {
      assertWritable('compact');
      await serialized(async () => {
        for (const file of await listDayFiles()) {
          let original: string;
          try {
            original = await fs.readFile(file.path, 'utf8');
          } catch (error) {
            if (isMissing(error)) continue;
            throw error;
          }

          // Last write wins for a repeated (slot, t): a re-poll at the same
          // instant is a correction, not a second observation.
          const deduped = new Map<string, HistoryPoint>();
          const lines = original.split('\n');
          const bounded =
            lines.length > MAX_LINES_PER_FILE ? lines.slice(-MAX_LINES_PER_FILE) : lines;
          for (const line of bounded) {
            const point = parsePoint(line);
            if (point !== null) deduped.set(`${point.slot}|${point.t}`, point);
          }

          const points = [...deduped.values()].sort(byTimeThenSlot);
          if (points.length === 0) {
            try {
              await fs.unlink(file.path);
            } catch (error) {
              if (!isMissing(error)) throw error;
            }
            continue;
          }

          const rewritten = points.map(serializePoint).join('');
          if (rewritten === original) continue; // already clean; do not churn the disk

          const tmp = `${file.path}.tmp`;
          await fs.writeFile(tmp, rewritten, 'utf8');
          await fs.rename(tmp, file.path); // atomic swap: a reader sees one or the other
        }
      });
    },
  };
}
