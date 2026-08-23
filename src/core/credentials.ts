/**
 * Claude Code's *own* credential store — the files (and, on macOS, the Keychain
 * item) that Claude Code itself authenticates from.
 *
 * This module owns a store another program writes to, so every write merges
 * into what is currently there instead of replacing it, and lands atomically:
 * a crash mid-write must never leave Claude Code logged out of an account it
 * still believes it has. ClaudeDeck's own at-rest storage is `vault.ts`.
 *
 * It also defines the dependency-injection surface shared by all of `src/core`
 * (`FsDeps` / `CoreDeps`), so core stays free of ambient I/O and every test can
 * point at a temp dir.
 */

import { execFile } from 'node:child_process';
import {
  mkdir as nodeMkdir,
  readdir as nodeReaddir,
  readFile as nodeReadFile,
  rename as nodeRename,
  stat as nodeStat,
  unlink as nodeUnlink,
  writeFile as nodeWriteFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  ClaudeAccountIdentity,
  ClaudeCredentialFile,
  ClaudePaths,
  CredentialKind,
  PlatformKind,
  Result,
} from '@shared/types';
import { err, ok } from '@shared/types';

import { detectPlatform } from './platform';

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/** The slice of `fs.Stats` core actually looks at. */
export interface FileStat {
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  mtimeMs: number;
}

export interface WriteFileOptions {
  /** POSIX mode applied when the file is created. Ignored on Windows. */
  mode?: number;
}

/**
 * Text-only filesystem surface. Binary payloads (the vault's ciphertext) travel
 * base64 inside JSON, which keeps every file core writes human-inspectable and
 * keeps this interface trivial to fake.
 */
export interface FsDeps {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string, opts?: WriteFileOptions): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
}

/** A finished child process. Never rejects — failure is a non-zero `code`. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CoreDeps {
  fs: FsDeps;
  /** Epoch ms. Injected so tests can freeze time. */
  now(): number;
  /** Absent means "cannot shell out" — the macOS Keychain path is skipped. */
  run?(cmd: string, args: string[]): Promise<RunResult>;
  /** Filled by `defaultDeps()`; force it in tests to drive the macOS branch. */
  platform?: PlatformKind;
  /** Environment view. Used only to derive the Keychain account name. */
  env?: Record<string, string | undefined>;
  /**
   * The single choke point for hard rule 3 (`settings.safeMode`). Every write
   * in core calls this first, so wiring one function here disables all disk
   * mutation without any core module needing to know about `Settings`.
   */
  writeGuard?(target: string): Result<void>;
}

/** Bound every spawn: a wedged Keychain must not hang the app. */
const RUN_TIMEOUT_MS = 5_000;

function runCommand(cmd: string, args: string[]): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: RUN_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        let code = 0;
        if (error) {
          const raw = (error as { code?: unknown }).code;
          // A spawn failure reports a string errno ('ENOENT'); only a numeric
          // code is a real exit status, and callers switch on the number.
          code = typeof raw === 'number' ? raw : -1;
        }
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });
}

/** Real dependencies, for the main process and the CLI. */
export function defaultDeps(overrides: Partial<CoreDeps> = {}): CoreDeps {
  const env = overrides.env ?? process.env;
  const fs: FsDeps = {
    readFile: (path) => nodeReadFile(path, 'utf8'),
    writeFile: (path, data, opts) =>
      nodeWriteFile(path, data, { encoding: 'utf8', mode: opts?.mode ?? 0o600 }),
    rename: (from, to) => nodeRename(from, to),
    mkdir: async (path, opts) => {
      await nodeMkdir(path, { recursive: opts?.recursive ?? false });
    },
    unlink: (path) => nodeUnlink(path),
    stat: (path) => nodeStat(path),
    readdir: (path) => nodeReaddir(path),
  };
  return {
    fs,
    now: () => Date.now(),
    run: runCommand,
    platform: detectPlatform(process.platform, env),
    env,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers — vault.ts and store.ts are built on these
// ---------------------------------------------------------------------------

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function codeOf(e: unknown): string | undefined {
  const raw = (e as { code?: unknown } | null)?.code;
  return typeof raw === 'string' ? raw : undefined;
}

function isMissing(e: unknown): boolean {
  const code = codeOf(e);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let tempCounter = 0;

function tempPathFor(target: string, deps: CoreDeps): string {
  tempCounter = (tempCounter + 1) % 0xffff;
  return `${target}.${deps.now().toString(36)}-${tempCounter.toString(36)}.tmp`;
}

/**
 * Windows hands out a transient EPERM/EBUSY when an indexer or AV holds the
 * destination open for the microsecond the rename needs. Retrying is the
 * documented workaround; a genuine permission problem still fails after these.
 */
async function renameWithRetry(deps: CoreDeps, from: string, to: string): Promise<void> {
  const transient = new Set(['EPERM', 'EACCES', 'EBUSY']);
  for (let attempt = 0; ; attempt++) {
    try {
      await deps.fs.rename(from, to);
      return;
    } catch (e) {
      if (attempt >= 2 || !transient.has(codeOf(e) ?? '')) throw e;
      await sleep(25 * (attempt + 1));
    }
  }
}

/**
 * Write `text` so readers see either the whole old file or the whole new one:
 * temp file in the same directory, then rename. Same-directory matters — a
 * cross-device rename degrades to a copy, and copies are not atomic.
 */
export async function atomicWriteText(
  path: string,
  text: string,
  deps: CoreDeps,
  opts: WriteFileOptions = {},
): Promise<Result<void>> {
  const guard = deps.writeGuard?.(path);
  if (guard && !guard.ok) return guard;

  const tmp = tempPathFor(path, deps);
  try {
    await deps.fs.mkdir(dirname(path), { recursive: true });
    // 0o600 by default: everything core writes is a secret or a pointer to one,
    // and Claude Code's own files are user-private too.
    await deps.fs.writeFile(tmp, text, { mode: opts.mode ?? 0o600 });
    await renameWithRetry(deps, tmp, path);
    return ok(undefined);
  } catch (e) {
    try {
      await deps.fs.unlink(tmp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return err(`failed to write ${path}: ${messageOf(e)}`, 'io-error');
  }
}

/**
 * Read a JSON object. The failure modes stay distinguishable because callers
 * treat them differently: "absent" is a fresh start, "unparseable" is a file
 * that must not be overwritten blind.
 */
export async function readJsonObject(
  path: string,
  deps: CoreDeps,
): Promise<Result<Record<string, unknown>>> {
  let text: string;
  try {
    text = await deps.fs.readFile(path);
  } catch (e) {
    if (isMissing(e)) return err(`${path} does not exist`, 'not-found');
    return err(`failed to read ${path}: ${messageOf(e)}`, 'io-error');
  }
  return parseJsonObject(text, path);
}

export function parseJsonObject(text: string, label: string): Result<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err(`${label} is not valid JSON: ${messageOf(e)}`, 'parse-error');
  }
  if (!isRecord(parsed)) return err(`${label} is not a JSON object`, 'parse-error');
  return ok(parsed);
}

// ---------------------------------------------------------------------------
// macOS Keychain
// ---------------------------------------------------------------------------

/** Where Claude Code keeps the credential blob on macOS instead of the file. */
export const CLAUDE_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/**
 * Apple's binary, pinned absolutely: this reads secrets, so a `security`
 * planted earlier on PATH must not be able to intercept them.
 */
const SECURITY_BIN = '/usr/bin/security';

/** `errSecItemNotFound`, as surfaced by find-/delete-generic-password. */
const KEYCHAIN_NOT_FOUND = 44;

/**
 * The Keychain item's account name, mirroring Claude Code's own choice
 * (`$USER`, then the OS login name). Divergence here is invisible but fatal:
 * we would read and write a *different* item than Claude Code, so a switch
 * would report success while Claude Code kept the previous login.
 */
export function keychainAccountName(deps: CoreDeps): string {
  const env = deps.env ?? {};
  return env['USER'] || env['LOGNAME'] || env['USERNAME'] || 'claude-code-user';
}

function usesKeychain(deps: CoreDeps): boolean {
  return deps.platform === 'macos' && typeof deps.run === 'function';
}

/** `ok(null)` means "no such item" — a genuine miss, not a failure. */
async function readKeychainItem(
  service: string,
  account: string,
  deps: CoreDeps,
): Promise<Result<string | null>> {
  if (!deps.run) return err('no command runner available', 'no-runner');
  let res: RunResult;
  try {
    res = await deps.run(SECURITY_BIN, [
      'find-generic-password',
      '-a',
      account,
      '-w',
      '-s',
      service,
    ]);
  } catch (e) {
    return err(`security find-generic-password failed: ${messageOf(e)}`, 'keychain-error');
  }
  if (res.code === 0) {
    // `-w` appends exactly one newline; strip that and nothing else.
    return ok(res.stdout.endsWith('\n') ? res.stdout.slice(0, -1) : res.stdout);
  }
  if (res.code === KEYCHAIN_NOT_FOUND) return ok(null);
  return err(
    `security find-generic-password exited ${res.code}: ${res.stderr.trim()}`,
    'keychain-error',
  );
}

async function writeKeychainItem(
  service: string,
  account: string,
  value: string,
  deps: CoreDeps,
): Promise<Result<void>> {
  if (!deps.run) return err('no command runner available', 'no-runner');
  // `-X` takes the secret as hex. The injected runner has no stdin channel, so
  // the value rides in argv either way; hex at least defeats a plaintext scan
  // of the process table and sidesteps every quoting hazard.
  const hex = Buffer.from(value, 'utf8').toString('hex');
  let res: RunResult;
  try {
    res = await deps.run(SECURITY_BIN, [
      'add-generic-password',
      '-U',
      '-a',
      account,
      '-s',
      service,
      '-X',
      hex,
    ]);
  } catch (e) {
    return err(`security add-generic-password failed: ${messageOf(e)}`, 'keychain-error');
  }
  if (res.code === 0) return ok(undefined);
  return err(
    `security add-generic-password exited ${res.code}: ${res.stderr.trim()}`,
    'keychain-error',
  );
}

/**
 * Best effort by design: the case where this cannot run is exactly the case
 * where the caller already gave up on the Keychain and wrote the file.
 */
async function deleteKeychainItem(
  service: string,
  account: string,
  deps: CoreDeps,
): Promise<boolean> {
  if (!deps.run) return false;
  try {
    const res = await deps.run(SECURITY_BIN, [
      'delete-generic-password',
      '-a',
      account,
      '-s',
      service,
    ]);
    return res.code === 0 || res.code === KEYCHAIN_NOT_FOUND;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The credential blob
// ---------------------------------------------------------------------------

/**
 * Read whatever Claude Code is currently logged in as.
 *
 * macOS tries the Keychain first because that is the order Claude Code itself
 * resolves in; a missing or non-JSON item falls through to the file, which is
 * where older installs — and every non-macOS install — keep the blob.
 */
export async function readClaudeCredentials(
  paths: ClaudePaths,
  deps: CoreDeps,
): Promise<Result<ClaudeCredentialFile>> {
  if (usesKeychain(deps)) {
    const item = await readKeychainItem(CLAUDE_KEYCHAIN_SERVICE, keychainAccountName(deps), deps);
    if (item.ok && item.value !== null) {
      const parsed = parseJsonObject(item.value, `Keychain item ${CLAUDE_KEYCHAIN_SERVICE}`);
      if (parsed.ok) return ok(parsed.value as ClaudeCredentialFile);
    }
  }
  const file = await readJsonObject(paths.credentials, deps);
  if (!file.ok) return file;
  return ok(file.value as ClaudeCredentialFile);
}

/** The merge base for a write: the same store a read would have used. */
async function readMergeBase(paths: ClaudePaths, deps: CoreDeps): Promise<Record<string, unknown>> {
  const current = await readClaudeCredentials(paths, deps);
  // An unreadable credential store carries nothing worth preserving — the blob
  // *is* the login — so a corrupt one is replaced rather than defended. The
  // global config (`writeAccountIdentity`) is the opposite case and refuses.
  return current.ok ? { ...current.value } : {};
}

/**
 * Make `file` the credential Claude Code authenticates with.
 *
 * Top-level keys we were not handed (`mcpOAuth`, `pluginSecrets`, device
 * tokens, whatever a newer Claude Code adds) are carried over from the current
 * store: they are machine state rather than account state, and dropping them
 * silently logs the user out of integrations ClaudeDeck never claimed to own.
 */
export async function writeClaudeCredentials(
  paths: ClaudePaths,
  file: ClaudeCredentialFile,
  deps: CoreDeps,
): Promise<Result<void>> {
  const guard = deps.writeGuard?.(paths.credentials);
  if (guard && !guard.ok) return guard;

  const merged: ClaudeCredentialFile = { ...(await readMergeBase(paths, deps)), ...file };
  const text = JSON.stringify(merged, null, 2);

  if (usesKeychain(deps)) {
    const wrote = await writeKeychainItem(
      CLAUDE_KEYCHAIN_SERVICE,
      keychainAccountName(deps),
      text,
      deps,
    );
    if (wrote.ok) return ok(undefined);
    // Keychain unusable (locked, denied, headless): fall through to the file.
  }

  const written = await atomicWriteText(paths.credentials, text, deps, { mode: 0o600 });
  if (!written.ok) return written;

  if (usesKeychain(deps)) {
    // Claude Code prefers the Keychain, so a stale item left behind would
    // shadow the file we just wrote and resurrect the previous account.
    await deleteKeychainItem(CLAUDE_KEYCHAIN_SERVICE, keychainAccountName(deps), deps);
  }
  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Account identity (the global config's `oauthAccount`)
// ---------------------------------------------------------------------------

const IDENTITY_FIELDS = [
  'emailAddress',
  'accountUuid',
  'organizationUuid',
  'organizationName',
  'displayName',
] as const;

function pickIdentity(raw: Record<string, unknown>): ClaudeAccountIdentity {
  const out: ClaudeAccountIdentity = {};
  for (const field of IDENTITY_FIELDS) {
    const value = raw[field];
    if (typeof value === 'string' && value.length > 0) out[field] = value;
  }
  return out;
}

/** Undefined fields are dropped so a merge never *deletes* a known value. */
function definedFields(identity: ClaudeAccountIdentity): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of IDENTITY_FIELDS) {
    const value = identity[field];
    if (typeof value === 'string') out[field] = value;
  }
  return out;
}

export async function readAccountIdentity(
  paths: ClaudePaths,
  deps: CoreDeps,
): Promise<Result<ClaudeAccountIdentity>> {
  const config = await readJsonObject(paths.globalConfig, deps);
  if (!config.ok) return config;
  const raw = config.value['oauthAccount'];
  if (!isRecord(raw)) {
    // Distinct from a missing file: the install exists, it is just logged out
    // (or authenticated with a managed API key, which has no oauthAccount).
    return err(`${paths.globalConfig} has no oauthAccount`, 'no-identity');
  }
  return ok(pickIdentity(raw));
}

/**
 * Point the global config's `oauthAccount` at `identity`.
 *
 * That file also holds the user's projects, MCP servers and history, so a
 * config that exists but cannot be parsed is never overwritten: a torn file
 * (valid prefix, truncated tail) would otherwise be "repaired" into an object
 * containing nothing but `oauthAccount`.
 */
export async function writeAccountIdentity(
  paths: ClaudePaths,
  identity: ClaudeAccountIdentity,
  deps: CoreDeps,
): Promise<Result<void>> {
  const guard = deps.writeGuard?.(paths.globalConfig);
  if (guard && !guard.ok) return guard;

  const current = await readJsonObject(paths.globalConfig, deps);
  let base: Record<string, unknown>;
  if (current.ok) {
    base = current.value;
  } else if (current.code === 'not-found') {
    base = {};
  } else {
    return err(`refusing to overwrite ${paths.globalConfig}: ${current.error}`, 'unreadable');
  }

  // Merge rather than replace: `oauthAccount` carries sub-keys we do not model,
  // and only the fields we were actually handed may change.
  const previous = isRecord(base['oauthAccount']) ? base['oauthAccount'] : {};
  const merged = { ...base, oauthAccount: { ...previous, ...definedFields(identity) } };

  return atomicWriteText(paths.globalConfig, JSON.stringify(merged, null, 2), deps, {
    mode: 0o600,
  });
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a bare token string.
 *
 * `sk-ant-api…` is a managed API key, which has no subscription quota at all —
 * the distinction the usage layer needs so such an account reports `no-quota`
 * instead of being mistaken for rate-limited. A bare `sk-ant-oat…` is a setup
 * token; the same prefix inside a full blob that also has a refresh token is an
 * interactive login, which `credentialKindFromFile` resolves.
 */
export function detectCredentialKind(token: string): CredentialKind {
  const value = token.trim().toLowerCase();
  if (value.startsWith('sk-ant-api')) return 'api-key';
  if (value.startsWith('sk-ant-oat')) return 'setup-token';
  return 'oauth';
}

/** Classify a whole credential blob, using the refresh token as the tiebreak. */
export function credentialKindFromFile(file: ClaudeCredentialFile): CredentialKind {
  const oauth = file.claudeAiOauth;
  if (!oauth || typeof oauth.accessToken !== 'string') return 'oauth';
  // Only an interactive login is issued a refresh token; setup tokens never are.
  if (typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0) return 'oauth';
  return detectCredentialKind(oauth.accessToken);
}
