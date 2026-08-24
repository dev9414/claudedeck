/**
 * Shared test scaffolding: sandboxed temp dirs, a fake clock, an in-memory
 * filesystem, a scripted `fetch`, and builders for the domain types.
 *
 * The rule this file exists to enforce is hard rule 2 — no test may ever read
 * or write the developer's real `~/.claude`. Every path a test uses comes from
 * `tempDir()` (or is purely in-memory), and `assertSandboxed` is the assertion
 * that proves it. Anything that would land inside the real install throws
 * before the test body ever runs.
 */

import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { afterEach } from 'vitest';

import type {
  Account,
  AutoSwitchConfig,
  ClaudeCredentialFile,
  ClaudePaths,
  CredentialKind,
  HistoryPoint,
  NotificationConfig,
  Result,
  Settings,
  SpendWindow,
  UsageSnapshot,
  UsageWindow,
} from '@shared/types';
import type { FileStat, FsDeps, RunResult, WriteFileOptions } from '@core/credentials';
import { DEFAULT_SCHEDULE } from '@core/schedule';
import type { HistoryFs } from '@core/history';
import type { LockFs } from '@core/locks';
import type { FetchLike } from '@core/oauth';
import type { Encryptor, Vault, VaultData } from '@core/vault';

// ---------------------------------------------------------------------------
// Obviously-fake secrets. Tests assert these strings never escape into logs,
// serialized output or error messages, so they must be distinctive.
// ---------------------------------------------------------------------------

export const SAMPLE_ACCESS_TOKEN = 'sk-ant-oat01-FAKEaccessTOKENvalue0000000000001';
export const SAMPLE_REFRESH_TOKEN = 'sk-ant-ort01-FAKErefreshTOKENvalue000000000002';
export const SAMPLE_API_KEY = 'sk-ant-api03-FAKEmanagedAPIKEYvalue00000000003';
export const SAMPLE_SETUP_TOKEN = 'sk-ant-oat01-FAKEsetupTOKENvalue00000000000004';

/** Every fake secret, for `expectNoSecrets`. */
export const ALL_SAMPLE_SECRETS = [
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_REFRESH_TOKEN,
  SAMPLE_API_KEY,
  SAMPLE_SETUP_TOKEN,
];

/** A fixed instant every builder defaults to: 2026-08-24T12:00:00Z. */
export const T0 = Date.parse('2026-08-24T12:00:00.000Z');

export const MINUTE = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** ISO string for `T0 + offsetMs`, for `resetsAt` fields. */
export function isoAt(offsetMs: number, base: number = T0): string {
  return new Date(base + offsetMs).toISOString();
}

// ---------------------------------------------------------------------------
// Temp directories — the sandbox
// ---------------------------------------------------------------------------

const REAL_HOME = homedir();
const TMP_ROOT = safeRealpath(tmpdir());

/**
 * Paths a test must never touch. `.claude.json` lives beside `.claude/`, not
 * inside it, so both are listed.
 */
const FORBIDDEN_ROOTS = [
  join(REAL_HOME, '.claude'),
  join(REAL_HOME, '.claude.json'),
  join(REAL_HOME, '.config', 'claude'),
];

const createdDirs: string[] = [];

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Windows paths compare case-insensitively; POSIX ones do not. */
function cmp(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

function isUnder(child: string, parent: string): boolean {
  const c = cmp(resolve(child));
  const p = cmp(resolve(parent));
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Throw unless every path lives inside a temp directory this helper created
 * (or inside the OS temp root), and outside the real Claude Code install.
 *
 * This is the single assertion that hard rule 2 is being honoured; it is called
 * by `sandboxPaths` and re-asserted directly in `paths.test.ts`.
 */
export function assertSandboxed(...candidates: string[]): void {
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) {
      throw new Error(`sandbox violation: "${candidate}" is not an absolute path`);
    }
    for (const forbidden of FORBIDDEN_ROOTS) {
      if (isUnder(candidate, forbidden)) {
        throw new Error(
          `sandbox violation: "${candidate}" is inside the real Claude Code install at "${forbidden}"`,
        );
      }
    }
    const inTemp =
      isUnder(candidate, TMP_ROOT) || createdDirs.some((dir) => isUnder(candidate, dir));
    if (!inTemp) {
      throw new Error(`sandbox violation: "${candidate}" is not inside a test temp directory`);
    }
  }
}

/**
 * A fresh, tracked temp directory. Removed by the `afterEach` registered at the
 * bottom of this module, so a test never has to clean up by hand.
 */
export function tempDir(prefix = 'claudedeck-test-'): string {
  const dir = safeRealpath(mkdtempSync(join(TMP_ROOT, prefix)));
  createdDirs.push(dir);
  assertSandboxed(dir);
  return dir;
}

/** Remove every temp directory created so far. Idempotent. */
export function cleanupTempDirs(): void {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A Windows file handle can still be open; the OS reaps %TEMP% anyway.
    }
  }
}

/**
 * A `ClaudePaths` rooted entirely inside `root`. Pass a `tempDir()`; anything
 * else trips `assertSandboxed`.
 */
export function sandboxPaths(root: string, overrides: Partial<ClaudePaths> = {}): ClaudePaths {
  const configHome = join(root, '.claude');
  const paths: ClaudePaths = {
    configHome,
    globalConfig: join(root, '.claude.json'),
    credentials: join(configHome, '.credentials.json'),
    deckHome: join(root, 'deck'),
    ...overrides,
  };
  assertSandboxed(paths.configHome, paths.globalConfig, paths.credentials, paths.deckHome);
  return paths;
}

/** An env view that points Claude Code's own resolver at `root`. */
export function sandboxEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  assertSandboxed(root);
  return {
    HOME: root,
    USERPROFILE: root,
    CLAUDE_CONFIG_DIR: join(root, '.claude'),
    CLAUDEDECK_HOME: join(root, 'deck'),
    ...extra,
  };
}

/**
 * In-memory `ClaudePaths` for tests that use `MemoryFs` instead of real disk.
 * The prefix is a POSIX-looking fake root that exists only inside `MemoryFs`.
 */
export function memoryPaths(root = '/sandbox', overrides: Partial<ClaudePaths> = {}): ClaudePaths {
  return {
    configHome: `${root}/.claude`,
    globalConfig: `${root}/.claude.json`,
    credentials: `${root}/.claude/.credentials.json`,
    deckHome: `${root}/deck`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fake clock
// ---------------------------------------------------------------------------

export interface FakeClock {
  /** Epoch ms. Pass this as `deps.now`. */
  now(): number;
  advance(ms: number): void;
  set(t: number): void;
  /** Advances the clock instead of waiting; records what it was asked for. */
  sleep(ms: number): Promise<void>;
  /** Every duration `sleep` was called with, in order. */
  readonly sleeps: number[];
}

export function fakeClock(start: number = T0): FakeClock {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    advance(ms: number): void {
      t += ms;
    },
    set(next: number): void {
      t = next;
    },
    async sleep(ms: number): Promise<void> {
      sleeps.push(ms);
      t += ms;
      // Yield so interleaved promises make progress, like a real timer would.
      await Promise.resolve();
    },
    sleeps,
  };
}

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

export type FsOpName =
  | 'readFile'
  | 'writeFile'
  | 'appendFile'
  | 'rename'
  | 'mkdir'
  | 'unlink'
  | 'stat'
  | 'readdir';

export interface FsOpRecord {
  op: FsOpName;
  path: string;
  /** Rename destination, or the write flag, when relevant. */
  detail?: string;
}

interface FaultRule {
  op: FsOpName;
  match: ((path: string) => boolean) | undefined;
  code: string;
  message: string;
  remaining: number;
}

function fsError(code: string, message: string): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

/** Collapse separators so `node:path` output and POSIX literals agree. */
function normPath(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

function parentOf(p: string): string {
  const cut = p.lastIndexOf('/');
  if (cut < 0) return '';
  return cut === 0 ? '/' : p.slice(0, cut);
}

function baseOf(p: string): string {
  const cut = p.lastIndexOf('/');
  return cut < 0 ? p : p.slice(cut + 1);
}

/**
 * A tiny POSIX-ish filesystem with fault injection and an operation log.
 *
 * Strict about parent directories on purpose: a module that forgets to `mkdir`
 * before writing gets an ENOENT here rather than silently working.
 */
export class MemoryFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>(['/']);
  readonly ops: FsOpRecord[] = [];
  #faults: FaultRule[] = [];
  #clock: FakeClock;

  constructor(clock: FakeClock = fakeClock()) {
    this.#clock = clock;
  }

  // --- authoring helpers (do not go through the op log) --------------------

  /** Seed a file, creating its parents. */
  put(path: string, contents: string): this {
    const p = normPath(path);
    this.mkdirp(parentOf(p));
    this.files.set(p, contents);
    return this;
  }

  putJson(path: string, value: unknown): this {
    return this.put(path, JSON.stringify(value, null, 2));
  }

  mkdirp(path: string): this {
    const p = normPath(path);
    if (p === '' || p === '/') return this;
    const parts = p.split('/');
    let acc = parts[0] === '' ? '' : parts[0]!;
    this.dirs.add(acc === '' ? '/' : acc);
    for (let i = 1; i < parts.length; i += 1) {
      acc = `${acc}/${parts[i]}`;
      this.dirs.add(acc);
    }
    return this;
  }

  read(path: string): string | undefined {
    return this.files.get(normPath(path));
  }

  has(path: string): boolean {
    return this.files.has(normPath(path));
  }

  /** Every file, path -> contents. Use to prove a failed write changed nothing. */
  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.files.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  /** Paths of every file whose name looks like an atomic-write temp file. */
  tempFiles(): string[] {
    return [...this.files.keys()].filter((p) => p.endsWith('.tmp'));
  }

  opNames(): FsOpName[] {
    return this.ops.map((o) => o.op);
  }

  clearOps(): void {
    this.ops.length = 0;
  }

  // --- fault injection -----------------------------------------------------

  /**
   * Make the next `times` calls to `op` fail. `match` narrows by path
   * (substring or predicate).
   */
  fail(
    op: FsOpName,
    opts: {
      match?: string | RegExp | ((path: string) => boolean);
      code?: string;
      message?: string;
      times?: number;
    } = {},
  ): this {
    const raw = opts.match;
    const match =
      raw === undefined
        ? undefined
        : typeof raw === 'string'
          ? (p: string): boolean => p.includes(normPath(raw))
          : raw instanceof RegExp
            ? (p: string): boolean => raw.test(p)
            : raw;
    this.#faults.push({
      op,
      match,
      code: opts.code ?? 'EIO',
      message: opts.message ?? `injected ${opts.code ?? 'EIO'} on ${op}`,
      remaining: opts.times ?? 1,
    });
    return this;
  }

  clearFaults(): void {
    this.#faults = [];
  }

  #maybeFail(op: FsOpName, path: string): void {
    for (const rule of this.#faults) {
      if (rule.op !== op || rule.remaining <= 0) continue;
      if (rule.match !== undefined && !rule.match(path)) continue;
      rule.remaining -= 1;
      throw fsError(rule.code, rule.message);
    }
  }

  #record(op: FsOpName, path: string, detail?: string): void {
    const entry: FsOpRecord = { op, path };
    if (detail !== undefined) entry.detail = detail;
    this.ops.push(entry);
  }

  // --- primitive operations ------------------------------------------------

  async doReadFile(path: string): Promise<string> {
    const p = normPath(path);
    this.#record('readFile', p);
    this.#maybeFail('readFile', p);
    if (this.dirs.has(p)) throw fsError('EISDIR', `EISDIR: illegal operation on ${p}`);
    const value = this.files.get(p);
    if (value === undefined) throw fsError('ENOENT', `ENOENT: no such file ${p}`);
    return value;
  }

  async doWriteFile(path: string, data: string, flag?: string): Promise<void> {
    const p = normPath(path);
    this.#record('writeFile', p, flag);
    this.#maybeFail('writeFile', p);
    if (this.dirs.has(p)) throw fsError('EISDIR', `EISDIR: ${p} is a directory`);
    if (flag === 'wx' && this.files.has(p)) throw fsError('EEXIST', `EEXIST: file exists ${p}`);
    const parent = parentOf(p);
    if (parent !== '' && !this.dirs.has(parent)) {
      throw fsError('ENOENT', `ENOENT: no such directory ${parent}`);
    }
    this.files.set(p, data);
  }

  async doAppendFile(path: string, data: string): Promise<void> {
    const p = normPath(path);
    this.#record('appendFile', p);
    this.#maybeFail('appendFile', p);
    const parent = parentOf(p);
    if (parent !== '' && !this.dirs.has(parent)) {
      throw fsError('ENOENT', `ENOENT: no such directory ${parent}`);
    }
    this.files.set(p, (this.files.get(p) ?? '') + data);
  }

  async doRename(from: string, to: string): Promise<void> {
    const a = normPath(from);
    const b = normPath(to);
    this.#record('rename', a, b);
    this.#maybeFail('rename', a);
    const value = this.files.get(a);
    if (value === undefined) throw fsError('ENOENT', `ENOENT: no such file ${a}`);
    const parent = parentOf(b);
    if (parent !== '' && !this.dirs.has(parent)) {
      throw fsError('ENOENT', `ENOENT: no such directory ${parent}`);
    }
    this.files.delete(a);
    this.files.set(b, value);
  }

  async doMkdir(path: string, recursive: boolean): Promise<string | undefined> {
    const p = normPath(path);
    this.#record('mkdir', p);
    this.#maybeFail('mkdir', p);
    if (this.dirs.has(p)) return undefined;
    const parent = parentOf(p);
    if (!recursive && parent !== '' && !this.dirs.has(parent)) {
      throw fsError('ENOENT', `ENOENT: no such directory ${parent}`);
    }
    this.mkdirp(p);
    return p;
  }

  async doUnlink(path: string): Promise<void> {
    const p = normPath(path);
    this.#record('unlink', p);
    this.#maybeFail('unlink', p);
    if (!this.files.delete(p)) throw fsError('ENOENT', `ENOENT: no such file ${p}`);
  }

  async doStat(path: string): Promise<FileStat> {
    const p = normPath(path);
    this.#record('stat', p);
    this.#maybeFail('stat', p);
    const file = this.files.get(p);
    if (file !== undefined) {
      return {
        isFile: () => true,
        isDirectory: () => false,
        size: Buffer.byteLength(file, 'utf8'),
        mtimeMs: this.#clock.now(),
      };
    }
    if (this.dirs.has(p)) {
      return {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
        mtimeMs: this.#clock.now(),
      };
    }
    throw fsError('ENOENT', `ENOENT: no such file or directory ${p}`);
  }

  async doReaddir(path: string): Promise<string[]> {
    const p = normPath(path);
    this.#record('readdir', p);
    this.#maybeFail('readdir', p);
    if (!this.dirs.has(p)) throw fsError('ENOENT', `ENOENT: no such directory ${p}`);
    const prefix = p === '/' ? '/' : `${p}/`;
    const names = new Set<string>();
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) names.add(baseOf(key.slice(prefix.length).split('/')[0] ?? ''));
    }
    for (const key of this.dirs) {
      if (key !== p && key.startsWith(prefix)) {
        const rest = key.slice(prefix.length).split('/')[0];
        if (rest) names.add(rest);
      }
    }
    return [...names].sort();
  }

  // --- adapters ------------------------------------------------------------

  /** The `FsDeps` shape `credentials.ts`, `vault.ts` and `store.ts` take. */
  asFsDeps(): FsDeps {
    return {
      readFile: (p) => this.doReadFile(p),
      writeFile: (p, data, _opts?: WriteFileOptions) => this.doWriteFile(p, data),
      rename: (from, to) => this.doRename(from, to),
      mkdir: async (p, opts) => {
        await this.doMkdir(p, opts?.recursive === true);
      },
      unlink: (p) => this.doUnlink(p),
      stat: (p) => this.doStat(p),
      readdir: (p) => this.doReaddir(p),
    };
  }

  /** The `HistoryFs` shape `history.ts` takes. */
  asHistoryFs(): HistoryFs {
    return {
      mkdir: (p) => this.doMkdir(p, true),
      readdir: (p) => this.doReaddir(p),
      readFile: (p) => this.doReadFile(p),
      appendFile: (p, data) => this.doAppendFile(p, data),
      writeFile: (p, data) => this.doWriteFile(p, data),
      rename: (from, to) => this.doRename(from, to),
      unlink: (p) => this.doUnlink(p),
    };
  }

  /** The `LockFs` shape `locks.ts` takes; honours the `wx` exclusive flag. */
  asLockFs(): LockFs {
    return {
      mkdir: (p) => this.doMkdir(p, true),
      writeFile: (p, data, options) => this.doWriteFile(p, data, options.flag),
      readFile: (p) => this.doReadFile(p),
      unlink: (p) => this.doUnlink(p),
    };
  }
}

/** Records every `writeGuard` call, so "safe mode blocked it" is provable. */
export function denyingWriteGuard(
  message = 'safe mode is enabled: refusing to write',
): ((target: string) => Result<void>) & { targets: string[] } {
  const targets: string[] = [];
  const guard = (target: string): Result<void> => {
    targets.push(target);
    return { ok: false, error: `${message} ${target}`, code: 'safe-mode' };
  };
  return Object.assign(guard, { targets });
}

/** Allows every write but records what was attempted. */
export function allowingWriteGuard(): ((target: string) => Result<void>) & { targets: string[] } {
  const targets: string[] = [];
  const guard = (target: string): Result<void> => {
    targets.push(target);
    return { ok: true, value: undefined };
  };
  return Object.assign(guard, { targets });
}

// ---------------------------------------------------------------------------
// Scripted child-process runner (macOS Keychain branch)
// ---------------------------------------------------------------------------

export interface RunCall {
  cmd: string;
  args: string[];
}

/**
 * A `CoreDeps['run']` driven by a lookup on the `security` subcommand, so a
 * test can say "find returns this, add succeeds" without ordering constraints.
 */
export function scriptedRun(
  handler: (call: RunCall) => Partial<RunResult> | undefined,
): ((cmd: string, args: string[]) => Promise<RunResult>) & { calls: RunCall[] } {
  const calls: RunCall[] = [];
  const run = async (cmd: string, args: string[]): Promise<RunResult> => {
    calls.push({ cmd, args });
    const out = handler({ cmd, args }) ?? {};
    return { code: out.code ?? 0, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
  };
  return Object.assign(run, { calls });
}

// ---------------------------------------------------------------------------
// Scripted fetch
// ---------------------------------------------------------------------------

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface ScriptEntry {
  status?: number;
  /** Serialized with `JSON.stringify`. Ignored when `text` is given. */
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Reject the `fetch` call itself — a transport failure. */
  throws?: unknown;
  /** Resolve, then reject when the body is read — a truncated response. */
  bodyThrows?: boolean;
}

const NO_BODY_STATUS = new Set([101, 103, 204, 205, 304]);

function toResponse(entry: ScriptEntry): Response {
  const status = entry.status ?? 200;
  const body =
    entry.text !== undefined
      ? entry.text
      : entry.json !== undefined
        ? JSON.stringify(entry.json)
        : '';

  if (entry.bodyThrows === true) {
    const failure = (): Promise<never> => Promise.reject(new Error('body stream terminated'));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(entry.headers ?? {}),
      text: failure,
      json: failure,
    } as unknown as Response;
  }

  const init: ResponseInit = { status };
  if (entry.headers !== undefined) init.headers = entry.headers;
  return new Response(NO_BODY_STATUS.has(status) ? null : body, init);
}

function readHeaders(init: RequestInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = init?.headers;
  if (raw === undefined) return out;
  new Headers(raw as HeadersInit).forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

export type ScriptedFetch = FetchLike & { calls: FetchCall[] };

/**
 * A `fetch` that replays `script`, in order for an array or per-call for a
 * function. Running past the end of an array throws, so an unexpected extra
 * request fails the test loudly instead of hanging or returning a default.
 */
export function scriptedFetch(
  script: ScriptEntry | ScriptEntry[] | ((call: FetchCall, index: number) => ScriptEntry),
): ScriptedFetch {
  const calls: FetchCall[] = [];
  const entries = Array.isArray(script) ? script : null;

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call: FetchCall = {
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers: readHeaders(init),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    const index = calls.length;
    calls.push(call);

    let entry: ScriptEntry;
    if (entries !== null) {
      const next = entries[index];
      if (next === undefined) {
        throw new Error(`scriptedFetch: unexpected request #${index + 1} to ${url}`);
      }
      entry = next;
    } else if (typeof script === 'function') {
      entry = script(call, index);
    } else if (!Array.isArray(script)) {
      // `entries` being null already implies this, but the compiler cannot
      // correlate the two variables -- narrow on `script` directly.
      entry = script;
    } else {
      throw new Error('scriptedFetch: unreachable -- array script without entries');
    }

    if (entry.throws !== undefined) throw entry.throws;
    return toResponse(entry);
  };

  return Object.assign(impl as FetchLike, { calls });
}

/** A `fetch` that fails the test if it is ever called. */
export function forbiddenFetch(): ScriptedFetch {
  return scriptedFetch(() => {
    throw new Error('fetch must not be called by this code path');
  });
}

// ---------------------------------------------------------------------------
// Fake vault + encryptor (store.ts / vault.ts)
// ---------------------------------------------------------------------------

export interface FakeVault<T extends VaultData> extends Vault<T> {
  /** Every payload handed to `save`, in order. */
  readonly saves: T[];
  /** The most recent successfully saved payload, or the seeded one. */
  current: unknown;
  loadError: { ok: false; error: string; code?: string } | null;
  saveError: { ok: false; error: string; code?: string } | null;
}

export function fakeVault<T extends VaultData>(
  opts: {
    initial?: unknown;
    loadError?: { error: string; code?: string };
    saveError?: { error: string; code?: string };
  } = {},
): FakeVault<T> {
  const saves: T[] = [];
  const vault: FakeVault<T> = {
    path: '/sandbox/deck/vault.json',
    saves,
    current: opts.initial,
    loadError: opts.loadError
      ? { ok: false, error: opts.loadError.error, code: opts.loadError.code }
      : null,
    saveError: opts.saveError
      ? { ok: false, error: opts.saveError.error, code: opts.saveError.code }
      : null,
    async load() {
      if (vault.loadError) return vault.loadError;
      if (vault.current === undefined) {
        return { ok: false, error: 'vault does not exist', code: 'not-found' };
      }
      return { ok: true, value: structuredClone(vault.current) as T };
    },
    async save(data: T) {
      if (vault.saveError) return vault.saveError;
      saves.push(structuredClone(data));
      vault.current = structuredClone(data);
      return { ok: true, value: undefined };
    },
    async status() {
      return {
        path: vault.path,
        exists: vault.current !== undefined,
        plaintext: true,
        encryption: 'none',
      };
    },
  };
  return vault;
}

/**
 * A reversible byte-flip standing in for OS secure storage. Not cryptography —
 * its only job is to make the ciphertext *not equal* the plaintext, so a test
 * can prove tokens are not readable in the vault file.
 */
export function fakeEncryptor(
  opts: { available?: boolean; failEncrypt?: boolean; failDecrypt?: boolean } = {},
): Encryptor & { encrypts: number; decrypts: number } {
  const state = { encrypts: 0, decrypts: 0 };
  return {
    get encrypts() {
      return state.encrypts;
    },
    get decrypts() {
      return state.decrypts;
    },
    available: () => opts.available !== false,
    encrypt(s: string): Buffer {
      state.encrypts += 1;
      if (opts.failEncrypt === true) throw new Error('secure storage refused the write');
      return Buffer.from(Buffer.from(s, 'utf8').map((b) => b ^ 0x5a));
    },
    decrypt(b: Buffer): string {
      state.decrypts += 1;
      if (opts.failDecrypt === true) throw new Error('secure storage refused the read');
      return Buffer.from(b.map((x) => x ^ 0x5a)).toString('utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// Domain builders
// ---------------------------------------------------------------------------

export interface UsageSpec {
  fiveHourPct?: number;
  fiveHourResetsAt?: string;
  sevenDayPct?: number;
  sevenDayResetsAt?: string;
  scoped?: Array<{ key: string; pct: number; resetsAt?: string; label?: string }>;
  spend?: Partial<SpendWindow>;
  fetchedAt?: number;
}

export function makeWindow(key: string, pct: number, resetsAt?: string): UsageWindow {
  const window: UsageWindow = { key, label: key, pct };
  if (resetsAt !== undefined) window.resetsAt = resetsAt;
  return window;
}

export function makeUsage(spec: UsageSpec = {}): UsageSnapshot {
  const snapshot: UsageSnapshot = { scoped: [], fetchedAt: spec.fetchedAt ?? T0 };
  if (spec.fiveHourPct !== undefined) {
    snapshot.fiveHour = makeWindow('5h', spec.fiveHourPct, spec.fiveHourResetsAt);
  }
  if (spec.sevenDayPct !== undefined) {
    snapshot.sevenDay = makeWindow('7d', spec.sevenDayPct, spec.sevenDayResetsAt);
  }
  for (const s of spec.scoped ?? []) {
    const window: UsageWindow = { key: s.key, label: s.label ?? s.key, pct: s.pct };
    if (s.resetsAt !== undefined) window.resetsAt = s.resetsAt;
    snapshot.scoped.push(window);
  }
  if (spec.spend !== undefined) {
    snapshot.spend = {
      used: spec.spend.used ?? 0,
      limit: spec.spend.limit ?? 50,
      pct: spec.spend.pct ?? 0,
      currency: spec.spend.currency ?? 'USD',
      ...(spec.spend.resetsAt !== undefined ? { resetsAt: spec.spend.resetsAt } : {}),
    };
  }
  return snapshot;
}

export interface AccountSpec extends Partial<Omit<Account, 'usage'>> {
  /** Shorthand: build `usage` from a spec instead of a full snapshot. */
  usage?: UsageSnapshot | UsageSpec;
  /** Shorthand for `usage: { fiveHourPct: n }`. */
  pct?: number;
}

/** An `Account` with sane defaults; only name what the test is about. */
export function makeAccount(spec: AccountSpec = {}): Account {
  const slot = spec.slot ?? 1;
  const kind: CredentialKind = spec.kind ?? 'oauth';

  let usage: UsageSnapshot | undefined;
  if (spec.usage !== undefined) {
    usage = isUsageSnapshot(spec.usage) ? spec.usage : makeUsage(spec.usage);
  } else if (spec.pct !== undefined) {
    usage = makeUsage({ fiveHourPct: spec.pct });
  }

  const account: Account = {
    slot,
    email: spec.email ?? `slot${slot}@example.test`,
    kind,
    active: spec.active ?? false,
    disabled: spec.disabled ?? false,
    usageStatus: spec.usageStatus ?? (usage === undefined ? 'unavailable' : 'ok'),
    addedAt: spec.addedAt ?? T0 - DAY,
  };
  if (spec.alias !== undefined) account.alias = spec.alias;
  if (spec.identity !== undefined) account.identity = spec.identity;
  if (usage !== undefined) account.usage = usage;
  if (spec.lastGoodUsage !== undefined) account.lastGoodUsage = spec.lastGoodUsage;
  if (spec.tokenExpiresAt !== undefined) account.tokenExpiresAt = spec.tokenExpiresAt;
  if (spec.quarantinedAt !== undefined) account.quarantinedAt = spec.quarantinedAt;
  if (spec.quarantineReason !== undefined) account.quarantineReason = spec.quarantineReason;
  return account;
}

/**
 * Both shapes carry a `scoped` array, so that key cannot discriminate them.
 * The spec-only percentage keys can, and a real snapshot always has
 * `fetchedAt` — a spec that names neither is still unambiguously a spec.
 */
const USAGE_SPEC_KEYS = [
  'fiveHourPct',
  'fiveHourResetsAt',
  'sevenDayPct',
  'sevenDayResetsAt',
] as const;

function isUsageSnapshot(value: UsageSnapshot | UsageSpec): value is UsageSnapshot {
  if (USAGE_SPEC_KEYS.some((key) => key in value)) return false;
  return 'fetchedAt' in value && Array.isArray((value as UsageSnapshot).scoped);
}

/** Several accounts at once; the index supplies the default slot. */
export function makeAccounts(specs: AccountSpec[]): Account[] {
  return specs.map((spec, i) => makeAccount({ slot: i + 1, ...spec }));
}

export function makeHistoryPoint(spec: Partial<HistoryPoint> = {}): HistoryPoint {
  return {
    t: spec.t ?? T0,
    slot: spec.slot ?? 1,
    windows: spec.windows ?? { '5h': 10 },
  };
}

/** A rising series for one window key, `count` samples `stepMs` apart. */
export function makeSeries(opts: {
  count: number;
  startPct: number;
  pctPerHour: number;
  stepMs: number;
  endAt?: number;
  slot?: number;
  windowKey?: string;
}): HistoryPoint[] {
  const endAt = opts.endAt ?? T0;
  const slot = opts.slot ?? 1;
  const key = opts.windowKey ?? '5h';
  const points: HistoryPoint[] = [];
  for (let i = 0; i < opts.count; i += 1) {
    const back = (opts.count - 1 - i) * opts.stepMs;
    const t = endAt - back;
    const hours = (t - (endAt - (opts.count - 1) * opts.stepMs)) / HOUR;
    points.push({ t, slot, windows: { [key]: opts.startPct + hours * opts.pctPerHour } });
  }
  return points;
}

export function makeAutoSwitchConfig(spec: Partial<AutoSwitchConfig> = {}): AutoSwitchConfig {
  return {
    enabled: true,
    threshold: 80,
    pollIntervalSec: 300,
    cooldownSec: 300,
    hysteresisMargin: 10,
    strategy: 'best',
    models: [],
    includeApiKeyAccounts: false,
    dryRun: false,
    ...spec,
  };
}

/** `Partial<Settings>`, but the two nested config objects are partial too. */
export interface SettingsSpec extends Partial<Omit<Settings, 'autoswitch' | 'notifications'>> {
  autoswitch?: Partial<AutoSwitchConfig>;
  notifications?: Partial<NotificationConfig>;
}

export function makeSettings(spec: SettingsSpec = {}): Settings {
  const base: Settings = {
    theme: 'system',
    autoswitch: makeAutoSwitchConfig(),
    notifications: {
      enabled: true,
      warnAtPct: 85,
      onSwitch: true,
      onQuarantine: true,
      onExhausted: true,
    },
    minimizeToTray: true,
    launchAtLogin: false,
    historyRetentionDays: 30,
    safeMode: false,
    directoryMappings: [],
    planner: {
      enabled: false,
      configured: false,
      schedules: [DEFAULT_SCHEDULE],
      peakWeight: 3,
      remind: true,
      remindLeadMin: 10,
      autoAnchor: false,
      anchorPrompt: 'hi',
    },
  };
  // Nested config gets merged rather than replaced, so a test can override one
  // knob (`{ autoswitch: { threshold: 95 } }`) without restating the rest.
  return {
    ...base,
    ...spec,
    autoswitch: makeAutoSwitchConfig(spec.autoswitch),
    notifications: { ...base.notifications, ...spec.notifications },
  };
}

export function makeCredentialFile(
  spec: {
    accessToken?: string;
    refreshToken?: string | null;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
    extra?: Record<string, unknown>;
  } = {},
): ClaudeCredentialFile {
  const file: ClaudeCredentialFile = {
    claudeAiOauth: {
      accessToken: spec.accessToken ?? SAMPLE_ACCESS_TOKEN,
      ...(spec.refreshToken === null ? {} : { refreshToken: spec.refreshToken ?? SAMPLE_REFRESH_TOKEN }),
      ...(spec.expiresAt === undefined ? { expiresAt: T0 + HOUR } : { expiresAt: spec.expiresAt }),
      scopes: spec.scopes ?? ['user:inference', 'user:profile'],
      subscriptionType: spec.subscriptionType ?? 'max',
    },
    ...spec.extra,
  };
  return file;
}

/** The raw payload shape the usage endpoint returns, for parser tests. */
export function rawUsagePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    five_hour: { utilization: 25, resets_at: isoAt(4 * HOUR) },
    seven_day: { utilization: 16, resets_at: isoAt(4 * DAY) },
    extra_usage: {
      is_enabled: true,
      used_credits: 1234,
      monthly_limit: 5000,
      utilization: 24.7,
      currency: 'USD',
    },
    limits: [{ scope: { model: { display_name: 'Fable' } }, percent: 12, resets_at: isoAt(4 * DAY) }],
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/**
 * Throw if any of `secrets` shows up in `value` once serialized. The workhorse
 * for hard rule 1: every log line, error message and persisted blob a test
 * produces gets run through this.
 */
export function expectNoSecrets(value: unknown, secrets: string[] = ALL_SAMPLE_SECRETS): void {
  const text = typeof value === 'string' ? value : safeStringify(value);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    if (text.includes(secret)) {
      throw new Error(`secret leaked into output: found "${secret.slice(0, 16)}…" in ${text}`);
    }
    // Catch a partial leak too: the body after the `sk-ant-xxx-` namespace.
    const body = secret.replace(/^sk-ant-[A-Za-z0-9]+-/, '');
    if (body.length >= 12 && text.includes(body)) {
      throw new Error(`secret body leaked into output: found "${body.slice(0, 16)}…"`);
    }
  }
}

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[cycle]';
        seen.add(v);
      }
      if (typeof v === 'bigint') return v.toString();
      return v;
    },
  ) ?? String(value);
}

/** Narrow a `Result` to its `ok` branch, failing loudly with the error text. */
export function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error}`);
  return result.value;
}

/** Narrow a `Result` to its error branch. */
export function unwrapErr<T>(result: Result<T>): { error: string; code?: string } {
  if (result.ok) throw new Error(`expected an error, got ok: ${safeStringify(result.value)}`);
  return { error: result.error, ...(result.code === undefined ? {} : { code: result.code }) };
}

// Registering here means every test file that imports these fixtures gets temp
// cleanup for free — the sandbox cannot be left behind by a forgetful test.
try {
  afterEach(cleanupTempDirs);
} catch {
  // Imported outside a Vitest collection (a script, a type check): nothing to
  // register, and `cleanupTempDirs` is exported for manual use.
}
