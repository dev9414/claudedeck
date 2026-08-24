/**
 * The composition root.
 *
 * `src/core` is deliberately pure: every module there takes its filesystem,
 * clock, network and crypto as parameters. This file is the one place that
 * hands them the real thing, and the one place that knows how they fit
 * together. Everything else in `src/main` talks to the resulting `AppServices`
 * object and never imports `@core/*`, so substituting the demo backend (or a
 * test double) is a one-line change in `index.ts`.
 *
 * Two invariants are enforced here rather than scattered:
 *
 *   - Safe mode is wired once, into `CoreDeps.writeGuard` and the history
 *     store's `safeMode` hook. Every disk write in core funnels through those,
 *     so no call site has to remember the rule.
 *   - Live usage is runtime state, not registry state. `AccountStore` persists
 *     what an account *is*; the percentages it is sitting at right now live in
 *     memory and are merged in by `toAccount`.
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';

import type {
  Account,
  AnchorObservation,
  AnchorResult,
  AutoSwitchEvent,
  ClaudeAccountIdentity,
  ClaudeCredentialFile,
  ClaudeOAuth,
  ClaudePaths,
  DeckState,
  DirectoryMapping,
  Forecast,
  Headroom,
  HistoryPoint,
  PlatformKind,
  Result,
  SessionPlan,
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageProfile,
  UsageSnapshot,
  UsageStatus,
  UsageWindow,
  Weekday,
  WorkSchedule,
} from '@shared/types';
import { FIVE_HOUR_MS, err, ok } from '@shared/types';
import type { AddAccountOptions, AddTokenOptions, DeckApi, HistoryQuery } from '@shared/ipc';

import { detectClaudeCode, resolvePaths } from '@core/paths';
import { detectPlatform } from '@core/platform';
import {
  type CoreDeps,
  defaultDeps,
  detectCredentialKind,
  readAccountIdentity,
  readClaudeCredentials,
  writeAccountIdentity,
  writeClaudeCredentials,
} from '@core/credentials';
import { type Encryptor } from '@core/vault';
import {
  type AccountRecord,
  createAccountStore,
  toAccount,
} from '@core/store';
import { fetchProfile, isExpired, refreshToken } from '@core/oauth';
import { fetchUsage, headroom, relevantWindows } from '@core/usage';
import { type HistoryFs, createHistoryStore } from '@core/history';
import { forecastWindows } from '@core/forecast';
import {
  type SwitchContext,
  type SwitchDeps,
  applySwitch,
  planSwitch,
} from '@core/switcher';
import { type AutoSwitchSnapshot, type PollOutcome, createAutoSwitcher } from '@core/autoswitch';
import { type LockDeps, CONFIG_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS, withLock } from '@core/locks';
import { DEFAULT_LOOKBACK_DAYS, buildProfile, flatProfile } from '@core/profile';
import {
  claudeFileNames,
  claudeSearchDirs,
  isClaudeCodeVersion,
  vscodeExtensionsRoot,
} from '@core/claude-cli';
import { type PlanAccount, planDay } from '@core/planner';
import { DEFAULT_SCHEDULE, resolveSchedule } from '@core/schedule';

import { scrubSecrets } from './notifications';
import { DEFAULT_PLANNER, createSettingsStore, type SettingsStore } from './settings';

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Everything `DeckApi` promises except the three calls that are pure Electron
 * shell (folder picker, external browser, reveal in file manager). Those live
 * in `ipc.ts`; they have no business in a headless service object.
 */
export type DeckCore = Omit<DeckApi, 'pickDirectory' | 'openExternal' | 'revealPath'>;

export interface AppServices extends DeckCore {
  readonly paths: ClaudePaths;
  readonly platform: PlatformKind;
  readonly version: string;
  readonly demoMode: boolean;
  /** Settings without awaiting, for code that cannot (tray menus, close handler). */
  currentSettings(): Settings;
  /** The last published state, for the same reason. */
  currentState(): DeckState;
  /** Binding window and remaining percent, or null when we have never polled. */
  headroomFor(account: Account): Headroom | null;
  /** Rebuild the state snapshot and push it to subscribers. */
  publish(): void;
  dispose(): Promise<void>;
}

export interface CreateServicesOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  version?: string;
  now?: () => number;
  /**
   * How to run the Claude Code CLI when placing an anchor. Injected so tests
   * exercise `anchorNow` without spawning anything — nothing else in the app
   * starts a child process.
   */
  runAnchor?: AnchorRunner;
}

export const SAFE_MODE_CODE = 'safe-mode';

const MAX_RETAINED_EVENTS = 100;
/** Enough history to fit a 7-day window plus a week of context either side. */
const FORECAST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** The profiler's own default depth, so the plan sees what the profiler expects. */
const PROFILE_LOOKBACK_MS = DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
/** Sits beside the vault so a concurrent CLI sees the same lock. */
const REGISTRY_LOCK_SUFFIX = '.claudedeck.lock';

/**
 * Cold-start burn: one 5-hour window spent every four working hours.
 *
 * Used only when history has nothing in it at all. Deliberately heavy enough
 * that anchor placement changes the outcome — a placeholder so light that
 * nothing is ever blocked would make the planner answer "it makes no
 * difference" on day one, which is the day it most needs to be interesting.
 * `flatProfile` reports zero confidence, so `planDay` labels it a guess.
 */
const FLAT_PCT_PER_WORKING_HOUR = 25;

// ---------------------------------------------------------------------------
// Concrete dependencies
// ---------------------------------------------------------------------------

/**
 * Vault encryption, backed by the OS keychain (DPAPI / Keychain / libsecret).
 *
 * There is deliberately no home-grown fallback cipher. A key file sitting next
 * to the ciphertext it protects is theatre, and the vault's `plaintext` marker
 * exists precisely so the UI can tell the truth when no secret service is
 * available. Reporting `available: false` is the honest answer.
 */
export function createSafeStorageEncryptor(): Encryptor {
  return {
    available() {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        // Throws when called before `app.whenReady()`, and on hosts with no
        // backend at all. Either way we have no encryption right now.
        return false;
      }
    },
    encrypt: (value) => safeStorage.encryptString(value),
    decrypt: (payload) => safeStorage.decryptString(payload),
  };
}

/** `node:fs/promises` narrowed to exactly what the history store may call. */
function historyFs(): HistoryFs {
  return {
    mkdir: (path, options) => fsp.mkdir(path, options),
    readdir: (path) => fsp.readdir(path),
    readFile: (path, encoding) => fsp.readFile(path, encoding),
    appendFile: (path, data, encoding) => fsp.appendFile(path, data, encoding),
    writeFile: (path, data, encoding) => fsp.writeFile(path, data, encoding),
    rename: (from, to) => fsp.rename(from, to),
    unlink: (path) => fsp.unlink(path),
  };
}

function lockDeps(now: () => number): LockDeps {
  return {
    fs: {
      mkdir: (path, options) => fsp.mkdir(path, options),
      writeFile: (path, data, options) => fsp.writeFile(path, data, options),
      readFile: (path, encoding) => fsp.readFile(path, encoding),
      unlink: (path) => fsp.unlink(path),
    },
    now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    pid: process.pid,
    host: hostname(),
  };
}

// ---------------------------------------------------------------------------
// Anchoring the 5-hour window
// ---------------------------------------------------------------------------

/**
 * The binary we anchor with.
 *
 * Anchoring runs *the Claude Code CLI*, on purpose. A hand-rolled inference
 * request would need a token in this process and would anchor the window of
 * whatever credential we happened to send — the official client already holds
 * the login, already refreshes it, and already is what the user's quota is
 * measured against. Using anything else would be reimplementing the product
 * this app exists to manage.
 */
export const CLAUDE_BIN = 'claude';

/** The flag that makes the CLI answer once and exit instead of opening a REPL. */
const CLAUDE_PRINT_FLAG = '-p';

/**
 * Ceiling on one anchoring run. A one-word prompt answers in seconds; this only
 * stops a wedged child from pinning the main process.
 *
 * Note it is not `CoreDeps.run`: that runner exists for the macOS Keychain and
 * kills its child after five seconds. Killing a real inference call that early
 * would report a failure for a window that had, in fact, just been anchored.
 */
export const ANCHOR_TIMEOUT_MS = 90_000;

/** A `-p` reply is a sentence or two; anything past this is a runaway. */
const ANCHOR_MAX_OUTPUT = 256 * 1024;

/** How much of the CLI's own complaint we pass on to the user. */
const ANCHOR_ERROR_CHARS = 400;

/** One finished anchoring run. Never rejects: a failure is data, not a throw. */
export interface AnchorRun {
  /** Process exit status; -1 when it never got as far as an exit. */
  code: number;
  stdout: string;
  stderr: string;
  /** True when `claude` is not on PATH at all — a setup problem, not a failure. */
  notFound?: boolean;
  /** True when we killed it for taking longer than the timeout. */
  timedOut?: boolean;
}

export type AnchorRunner = (prompt: string, timeoutMs: number) => Promise<AnchorRun>;

/**
 * Characters the anchoring prompt may contain.
 *
 * On Windows the `claude` on PATH is normally a `.cmd` shim, which only
 * `cmd.exe` can execute — so that one platform genuinely needs a shell, and a
 * prompt carrying `"` or `&` could otherwise turn into a second command. Since
 * the prompt is a throwaway greeting and nothing else, dropping what a shell
 * might reinterpret is safer than trying to escape it correctly on three
 * platforms.
 */
const PROMPT_UNSAFE = /[^A-Za-z0-9 ,.'?!-]+/g;

export function sanitizeAnchorPrompt(prompt: string, fallback: string): string {
  const safe = prompt.replace(PROMPT_UNSAFE, ' ').trim().replace(/\s+/g, ' ');
  return safe || fallback;
}

/** What we report having run. The prompt is user text, so it is scrubbed too. */
export function anchorCommandText(prompt: string): string {
  return scrubSecrets(`${CLAUDE_BIN} ${CLAUDE_PRINT_FLAG} "${prompt}"`);
}

/**
 * Look `cmd` up the way the OS would, without a shell.
 *
 * Explicit rather than left to the spawn, for two reasons: "not installed" is
 * then a distinguishable, actionable answer instead of a bare errno, and on
 * Windows the thing actually on PATH is `claude.cmd`, which a plain spawn of
 * `claude` never finds.
 */
async function locateOnPath(
  cmd: string,
  env: NodeJS.ProcessEnv,
  windows: boolean,
): Promise<string | null> {
  const raw = env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
  const dirs = raw.split(windows ? ';' : ':').filter((entry) => entry.trim().length > 0);
  const exts = windows
    ? (env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
        .split(';')
        .map((ext) => ext.trim())
        .filter((ext) => ext.startsWith('.'))
    : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir.replace(/^"|"$/g, '').trim(), `${cmd}${ext}`);
      try {
        if ((await fsp.stat(candidate)).isFile()) return candidate;
      } catch {
        // A missing entry, or a PATH directory we cannot read. Keep looking:
        // one unreadable directory must not hide an install in the next one.
      }
    }
  }
  return null;
}

/** Runs the real CLI. The only place in ClaudeDeck that starts a child process. */
/**
 * Find a real Claude Code CLI, or null.
 *
 * PATH is only the first place to look. A GUI app inherits a login
 * environment rather than a shell one, and the most common way to have Claude
 * Code at all is the VS Code extension, which keeps the binary inside its own
 * extension directory and never exports it. Each candidate is probed with
 * `--version` because Claude *Desktop* also installs a `claude.exe`, and
 * running that instead would fail in a way that looks like our bug.
 */
export async function findClaudeCli(
  env: NodeJS.ProcessEnv,
  platform: PlatformKind,
  homeDir: string,
  override?: string,
): Promise<{ path: string; version: string } | null> {
  const probe = async (candidate: string) => {
    try {
      if (!(await fsp.stat(candidate)).isFile()) return null;
    } catch {
      return null;
    }
    const shell = platform === 'windows' && /\.(cmd|bat)$/i.test(candidate);
    try {
      const out = await new Promise<string>((resolve, reject) => {
        execFile(
          shell ? `"${candidate}"` : candidate,
          ['--version'],
          { timeout: 15_000, encoding: 'utf8', windowsHide: true, shell, maxBuffer: 1 << 16 },
          (error, stdout, stderr) => (error ? reject(error) : resolve(`${stdout}${stderr}`)),
        );
      });
      return isClaudeCodeVersion(out)
        ? { path: candidate, version: out.trim().split(/\r?\n/)[0] ?? '' }
        : null;
    } catch {
      return null;
    }
  };

  // An explicit setting wins outright, and is reported as a failure rather than
  // silently falling back: if someone named a path, a different binary running
  // instead is not what they asked for.
  if (override !== undefined && override.trim().length > 0) return probe(override.trim());

  let extensionDirs: string[] = [];
  try {
    extensionDirs = await fsp.readdir(vscodeExtensionsRoot(homeDir, platform));
  } catch {
    // No VS Code, or no permission. Not an error: just one fewer place to look.
  }

  const names = claudeFileNames(platform);
  for (const dir of claudeSearchDirs({ env, homeDir, platform, extensionDirs })) {
    for (const name of names) {
      const hit = await probe(join(dir, name));
      if (hit !== null) return hit;
    }
  }
  return null;
}

export function defaultAnchorRunner(
  env: NodeJS.ProcessEnv,
  platform: PlatformKind,
  homeDir: string = homedir(),
  override?: string,
): AnchorRunner {
  const windows = platform === 'windows';
  // Resolving walks directories and spawns `--version` probes, so the answer is
  // cached for the process: it cannot change without an install, and anchoring
  // should not pay for the search twice.
  let cached: { path: string; version: string } | null | undefined;

  return async (prompt, timeoutMs) => {
    if (cached === undefined) cached = await findClaudeCli(env, platform, homeDir, override);
    if (cached === null) return { code: -1, stdout: '', stderr: '', notFound: true };
    const found = cached.path;

    // A `.cmd`/`.bat` shim is a script, not an image: `CreateProcess` cannot run
    // one. Those go through the shell; everything else, including every POSIX
    // host, is executed directly with no shell in the picture.
    const shell = windows && /\.(cmd|bat)$/i.test(found);
    const file = shell ? `"${found}"` : found;
    const args = shell
      ? [CLAUDE_PRINT_FLAG, `"${prompt}"`]
      : [CLAUDE_PRINT_FLAG, prompt];

    return new Promise<AnchorRun>((resolve) => {
      execFile(
        file,
        args,
        {
          timeout: timeoutMs,
          maxBuffer: ANCHOR_MAX_OUTPUT,
          encoding: 'utf8',
          windowsHide: true,
          shell,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ code: 0, stdout, stderr });
            return;
          }
          const raw = (error as { code?: unknown }).code;
          const run: AnchorRun = {
            // A spawn failure reports a string errno; only a number is an exit
            // status, and callers switch on the number.
            code: typeof raw === 'number' ? raw : -1,
            stdout: stdout ?? '',
            stderr: stderr ?? (error.message || ''),
          };
          if (raw === 'ENOENT') run.notFound = true;
          if ((error as { killed?: boolean }).killed === true) run.timedOut = true;
          resolve(run);
        },
      );
    });
  };
}

// ---------------------------------------------------------------------------
// Local days
// ---------------------------------------------------------------------------

/**
 * A local calendar day, resolved through the host's own calendar.
 *
 * `@core/planner` and `@core/profile` are pure and take the zone as a number,
 * so this is where the host's zone enters the feature. It is read *for the day
 * being planned* rather than for `now`, which is what keeps a plan either side
 * of a DST change starting at the user's real midnight.
 */
interface LocalDay {
  /** Epoch ms of local midnight. */
  dayStartMs: number;
  /** Minutes to add to UTC to get local time — the opposite sign to `Date`. */
  tzOffsetMin: number;
  weekday: Weekday;
}

function localDayOf(start: Date): LocalDay {
  return {
    dayStartMs: start.getTime(),
    tzOffsetMin: -start.getTimezoneOffset(),
    weekday: start.getDay() as Weekday,
  };
}

/** The local day containing `at`. */
function today(at: number): LocalDay {
  const clock = new Date(at);
  return localDayOf(new Date(clock.getFullYear(), clock.getMonth(), clock.getDate()));
}

/** `YYYY-MM-DD` in local time, or null when that is not a real calendar day. */
function localDayFromKey(day: string): LocalDay | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day.trim());
  if (!parts || parts[1] === undefined || parts[2] === undefined || parts[3] === undefined) {
    return null;
  }
  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const date = Number(parts[3]);
  const start = new Date(year, month - 1, date);
  // `Date` rolls 2026-02-31 forward into March instead of refusing it, so the
  // parts have to be read back to catch a day that never existed.
  if (
    start.getFullYear() !== year ||
    start.getMonth() !== month - 1 ||
    start.getDate() !== date
  ) {
    return null;
  }
  return localDayOf(start);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createServices(options: CreateServicesOptions = {}): Promise<AppServices> {
  const now = options.now ?? (() => Date.now());
  const env = options.env ?? process.env;
  const paths = resolvePaths(env, options.homeDir);
  const platform = detectPlatform(process.platform, env);
  const version = options.version ?? '0.0.0';
  await fsp.mkdir(paths.deckHome, { recursive: true });

  const settings: SettingsStore = createSettingsStore(paths.deckHome);

  // Constructed after settings so an explicit `planner.claudePath` is honoured.
  const runAnchor =
    options.runAnchor ??
    defaultAnchorRunner(
      env,
      platform,
      options.homeDir ?? homedir(),
      settings.get().planner.claudePath,
    );
  await settings.load();

  /**
   * Hard rule 3, wired exactly once. Core calls this before every write, so no
   * individual call site has to remember safe mode exists.
   *
   * `settings.json` is intentionally outside this guard — it is ClaudeDeck's
   * own preferences, and blocking it would make safe mode a one-way door with
   * no way to turn it back off from the UI.
   */
  const writeGuard = (target: string): Result<void> =>
    settings.get().safeMode
      ? err(`safe mode is enabled: refusing to write ${target}`, SAFE_MODE_CODE)
      : ok(undefined);

  const coreDeps: CoreDeps = defaultDeps({ env, now, platform, writeGuard });
  const store = createAccountStore(paths.deckHome, createSafeStorageEncryptor(), coreDeps);
  await store.load();

  const history = createHistoryStore(paths.deckHome, {
    fs: historyFs(),
    safeMode: () => settings.get().safeMode,
  });

  const detection = await detectClaudeCode(paths);
  const locks = lockDeps(now);
  const registryLockPath = `${join(paths.deckHome, 'vault.json')}${REGISTRY_LOCK_SUFFIX}`;

  // Runtime-only state. `AccountStore` owns what an account *is*; these are the
  // numbers it happens to be sitting at, which are meaningless after a restart.
  const live = new Map<number, { usage?: UsageSnapshot; status?: UsageStatus }>();
  let lastSwitchAt: number | null = null;

  const stateListeners = new Set<(state: DeckState) => void>();
  const eventListeners = new Set<(event: AutoSwitchEvent) => void>();
  const recentEvents: AutoSwitchEvent[] = [];

  // -- projection -----------------------------------------------------------

  function listAccounts(): Account[] {
    const activeSlot = store.activeSlot;
    return store.list().map((record) => {
      const runtime = live.get(record.slot);
      return toAccount(record, {
        active: record.slot === activeSlot,
        usage: runtime?.usage,
        usageStatus: runtime?.status,
      });
    });
  }

  function buildState(): DeckState {
    const accounts = listAccounts();
    return {
      accounts,
      activeSlot: store.activeSlot,
      settings: settings.get(),
      paths,
      platform,
      onboarded: detection.installed && accounts.length > 0,
      autoSwitchRunning: autoswitcher.isRunning(),
      lastEvents: [...recentEvents],
      demoMode: false,
      version,
    };
  }

  let snapshot: DeckState;

  function publish(): void {
    snapshot = buildState();
    for (const listener of stateListeners) listener(snapshot);
  }

  function record(event: AutoSwitchEvent): void {
    recentEvents.push(event);
    if (recentEvents.length > MAX_RETAINED_EVENTS) {
      recentEvents.splice(0, recentEvents.length - MAX_RETAINED_EVENTS);
    }
    for (const listener of eventListeners) listener(event);
    publish();
  }

  // -- registry lock --------------------------------------------------------

  /**
   * Serialise registry mutations across processes: the GUI and a `claudedeck`
   * CLI invocation share one vault file, and a lost update there loses a
   * credential.
   */
  async function underLock<T>(owner: string, body: () => Promise<Result<T>>): Promise<Result<T>> {
    const outcome = await withLock(
      registryLockPath,
      { timeoutMs: DEFAULT_LOCK_TIMEOUT_MS, staleMs: CONFIG_STALE_MS, owner },
      locks,
      body,
    );
    return outcome.ok ? outcome.value : outcome;
  }

  // -- usage ----------------------------------------------------------------

  function markLive(slot: number, status: UsageStatus, usage?: UsageSnapshot): void {
    live.set(slot, { status, usage });
  }

  /**
   * The credential to poll with. For the active slot Claude Code's own file is
   * authoritative — it rotates the access token behind our back, and our copy
   * goes stale within the hour.
   */
  async function credentialFor(item: AccountRecord): Promise<ClaudeCredentialFile | null> {
    if (item.slot === store.activeSlot) {
      const liveFile = await readClaudeCredentials(paths, coreDeps);
      if (liveFile.ok && liveFile.value.claudeAiOauth?.accessToken) return liveFile.value;
    }
    return item.credentials ?? null;
  }

  interface RefreshFailure {
    error: string;
    rateLimited?: boolean;
    retryAfterSec?: number;
  }

  /**
   * Refresh one account end to end: unseal, renew a spent token, pull usage,
   * append a history point. Never throws — every failure becomes a
   * `usageStatus` the UI can explain.
   */
  async function refreshOne(item: AccountRecord): Promise<RefreshFailure | null> {
    const slot = item.slot;
    if (item.quarantinedAt) {
      markLive(slot, 'quarantined');
      return null;
    }

    const file = await credentialFor(item);
    const oauth = file?.claudeAiOauth;
    if (!file || !oauth?.accessToken) {
      markLive(slot, 'unavailable');
      return { error: `slot ${slot} has no stored credential` };
    }

    // Managed API keys bill per token and have no subscription window at all.
    // Calling them "rate limited" would be a lie that triggers a rotation.
    if (detectCredentialKind(oauth.accessToken) === 'api-key') {
      markLive(slot, 'no-quota');
      return null;
    }

    let current: ClaudeOAuth = oauth;
    if (isExpired(current, now())) {
      const renewed = await refreshToken(current, globalThis.fetch, now());
      if (!renewed.ok) {
        if (renewed.permanent) {
          await store.quarantine(slot, `refresh failed: ${renewed.error}`);
          markLive(slot, 'quarantined');
          emitQuarantined(slot, renewed.error);
          return { error: `slot ${slot} quarantined (${renewed.error})` };
        }
        markLive(slot, 'token-expired');
        return { error: `slot ${slot} token refresh failed (${renewed.error})` };
      }
      current = renewed.oauth;
      const rotated: ClaudeCredentialFile = { ...file, claudeAiOauth: current };
      await store.setCredentials(slot, rotated);
      // A rotated refresh token is one-shot: Claude Code must get it too, or
      // the next CLI invocation strands the account.
      if (slot === store.activeSlot) await writeClaudeCredentials(paths, rotated, coreDeps);
    }

    const outcome = await fetchUsage(current.accessToken, globalThis.fetch, now());
    if (!outcome.ok) {
      const status: UsageStatus =
        outcome.error === 'unauthorized'
          ? 'token-expired'
          : outcome.error === 'rate-limited'
            ? 'rate-limited'
            : 'unavailable';
      markLive(slot, status);
      return {
        error: `slot ${slot} usage unavailable (${outcome.error})`,
        rateLimited: outcome.error === 'rate-limited',
        retryAfterSec: outcome.retryAfterSec,
      };
    }

    if (outcome.usage === null) {
      // A clean round trip that reported no windows: this account is simply
      // not gated by a subscription quota.
      markLive(slot, 'no-quota');
      return null;
    }

    markLive(slot, 'ok', outcome.usage);
    await store.setLastGoodUsage(slot, outcome.usage);
    await appendHistory(slot, outcome.usage);
    return null;
  }

  function emitQuarantined(slot: number, reason: string): void {
    record({
      kind: 'account-quarantined',
      ts: now(),
      message: `slot ${slot} quarantined: ${reason}`,
      slot,
    });
  }

  async function appendHistory(slot: number, usage: UsageSnapshot): Promise<void> {
    const windows: Record<string, number> = {};
    const resets: Record<string, number> = {};

    const observe = (window: UsageWindow | undefined): void => {
      if (!window) return;
      windows[window.key] = window.pct;
      // The reset instant *is* the window's identity, so recording it lets the
      // profiler segment history exactly rather than inferring a boundary from a
      // drop in utilization. Points written before the planner existed have no
      // `resets`, which is why that inference has to survive anyway.
      if (window.resetsAt === undefined) return;
      const at = Date.parse(window.resetsAt);
      if (!Number.isNaN(at)) resets[window.key] = at;
    };

    observe(usage.fiveHour);
    observe(usage.sevenDay);
    for (const scoped of usage.scoped) observe(scoped);

    const point: HistoryPoint = { t: usage.fetchedAt, slot, windows };
    // Left off entirely when the API reported no reset instants, so a point
    // never claims to know a boundary it does not.
    if (Object.keys(resets).length > 0) point.resets = resets;
    try {
      await history.append(point);
    } catch {
      // Safe mode refuses, and a full disk fails. Neither is worth failing a
      // poll over: history is a nicety, current usage is the product.
    }
  }

  async function refreshAll(slot?: number): Promise<Result<Account[]>> {
    const records = slot === undefined ? store.list() : store.list().filter((r) => r.slot === slot);
    if (slot !== undefined && records.length === 0) {
      return err(`no account in slot ${slot}`, 'not-found');
    }
    // Sequential on purpose: parallel refreshes of the same credential file are
    // how you corrupt it, and four accounts is not worth the risk.
    for (const item of records) await refreshOne(item);
    publish();
    return ok(listAccounts());
  }

  // -- switching ------------------------------------------------------------

  function switchContext(): SwitchContext {
    return {
      accounts: listAccounts(),
      activeSlot: store.activeSlot,
      paths,
      settings: settings.get(),
      platform,
      now: now(),
      storePath: join(paths.deckHome, 'vault.json'),
    };
  }

  /**
   * `emitEvents` is false when the auto-switcher drives the call: it publishes
   * its own switch event, and core warns that wiring both double-reports.
   */
  function switchDeps(emitEvents: boolean): SwitchDeps {
    const deps: SwitchDeps = {
      now,
      fetch: globalThis.fetch,
      lock: locks,

      async loadStoredCredentials(slot) {
        const found = store.get(slot);
        if (!found) return err(`no account in slot ${slot}`, 'not-found');
        if (!found.credentials) {
          return err(`slot ${slot} has no stored credential`, 'not-found');
        }
        return ok(found.credentials);
      },

      async readLiveCredentials() {
        const result = await readClaudeCredentials(paths, coreDeps);
        if (result.ok) return ok(result.value);
        // Nothing to capture is a normal state, not a failure to report.
        if (result.code === 'not-found') return ok(null);
        return err(result.error, result.code);
      },

      writeLiveCredentials: (file) => writeClaudeCredentials(paths, file, coreDeps),
      writeIdentity: (identity) => writeAccountIdentity(paths, identity, coreDeps),

      async persist(update) {
        for (const entry of update.credentials ?? []) {
          const saved = await store.setCredentials(entry.slot, entry.credentials);
          if (!saved.ok) return err(saved.error, saved.code);
        }
        const activated = await store.setActiveSlot(update.activeSlot);
        if (!activated.ok) return activated;
        lastSwitchAt = update.switchedAt;
        // The outgoing account's numbers are still true; the incoming one's are
        // unknown until the next poll, so drop only that entry.
        live.delete(update.activeSlot);
        return ok(undefined);
      },

      async quarantine(slot, reason) {
        const marked = await store.quarantine(slot, reason);
        if (!marked.ok) return err(marked.error, marked.code);
        markLive(slot, 'quarantined');
        emitQuarantined(slot, reason);
        return ok(undefined);
      },
    };
    if (emitEvents) deps.emit = record;
    return deps;
  }

  async function runSwitch(request: SwitchRequest, emitEvents: boolean): Promise<SwitchResult> {
    const result = await applySwitch(switchContext(), request, switchDeps(emitEvents));
    if (result.switched && result.to) void refreshAll(result.to.slot);
    publish();
    return result;
  }

  // -- auto-switch ----------------------------------------------------------

  const autoswitcher = createAutoSwitcher({
    now,

    async snapshot(): Promise<AutoSwitchSnapshot> {
      return {
        accounts: listAccounts(),
        activeSlot: store.activeSlot,
        config: settings.get().autoswitch,
        lastSwitchAt,
      };
    },

    async pollUsage(): Promise<PollOutcome> {
      const failures: RefreshFailure[] = [];
      for (const item of store.list()) {
        const failure = await refreshOne(item);
        if (failure) failures.push(failure);
      }
      publish();

      // A partial failure is still a usable poll; only a total one is an error,
      // and a 429 has to carry its Retry-After into the cadence.
      if (failures.length > 0 && failures.length === store.list().length) {
        const rateLimited = failures.find((entry) => entry.rateLimited);
        const first = failures[0];
        return {
          ok: false,
          error: rateLimited?.error ?? first?.error ?? 'usage refresh failed',
          rateLimited: rateLimited !== undefined,
          retryAfterSec: rateLimited?.retryAfterSec,
        };
      }
      return { ok: true, accounts: listAccounts() };
    },

    performSwitch: (request) => runSwitch(request, false),
    emit: record,
  });

  // -- account lifecycle ----------------------------------------------------

  async function upsertAccount(
    email: string,
    credentials: ClaudeCredentialFile,
    identity: ClaudeAccountIdentity,
    opts: AddAccountOptions,
    activate: boolean,
  ): Promise<Result<Account>> {
    const token = credentials.claudeAiOauth?.accessToken;
    const saved = await store.upsert({
      email,
      slot: opts.slot,
      alias: opts.alias,
      kind: token ? detectCredentialKind(token) : 'oauth',
      identity,
      credentials,
      tokenExpiresAt: credentials.claudeAiOauth?.expiresAt,
      force: opts.force,
    });
    if (!saved.ok) return saved;

    if (activate) {
      const activated = await store.setActiveSlot(saved.value.slot);
      if (!activated.ok) return err(activated.error, activated.code);
    }
    publish();
    // Fire-and-forget: the account is usable now, the percentages catch up.
    void refreshAll(saved.value.slot);
    return ok(toAccount(saved.value, { active: saved.value.slot === store.activeSlot }));
  }

  function accountOf(record: AccountRecord): Account {
    const runtime = live.get(record.slot);
    return toAccount(record, {
      active: record.slot === store.activeSlot,
      usage: runtime?.usage,
      usageStatus: runtime?.status,
    });
  }

  // -- session planning -----------------------------------------------------

  /**
   * Accounts an anchor can be placed on. A managed API key has no subscription
   * window to anchor, a quarantined account cannot send the message that would
   * anchor it, and a disabled one is deliberately out of the rotation the plan
   * is staggering.
   */
  function plannableAccounts(): AccountRecord[] {
    return store
      .list()
      .filter((item) => item.kind !== 'api-key' && !item.disabled && !item.quarantinedAt);
  }

  /** The schedule for a day, and whether it is one the user actually declared. */
  function scheduleFor(day: LocalDay): { schedule: WorkSchedule; declared: boolean } {
    const planner = settings.get().planner;
    const matched = resolveSchedule(planner.schedules, day.weekday);
    if (matched !== null) return { schedule: matched, declared: planner.configured };
    // A day no schedule covers is still planned — against the first schedule the
    // user has, or the app's own default — and reported as not their hours.
    // Refusing would leave the Planner view blank every Saturday.
    return { schedule: planner.schedules[0] ?? DEFAULT_SCHEDULE, declared: false };
  }

  /**
   * The demand curve to simulate against.
   *
   * Built from every account's points at once rather than one account's, because
   * whichever account is active absorbs the whole day's load: a per-account
   * curve would model a split that never happens, and `@core/planner` says so
   * where `PlanAccount.profile` is declared. Restricted to the weekdays this
   * schedule covers, since a Tuesday's routine is not a Sunday's.
   */
  async function learnProfile(day: LocalDay, schedule: WorkSchedule, slot?: number): Promise<UsageProfile> {
    const points = await api.getHistory({ slot, since: now() - PROFILE_LOOKBACK_MS });
    return buildProfile(points, now(), {
      slot,
      days: schedule.days.length > 0 ? schedule.days : undefined,
      tzOffsetMin: day.tzOffsetMin,
    });
  }

  // -- api ------------------------------------------------------------------

  const api: AppServices = {
    paths,
    platform,
    version,
    demoMode: false,

    currentSettings: () => settings.get(),
    currentState: () => snapshot,
    headroomFor: (account) =>
      headroom(account.usage ?? account.lastGoodUsage, settings.get().autoswitch.models),
    publish,

    async getState() {
      return buildState();
    },

    refreshUsage: (slot) => refreshAll(slot),

    async addCurrentAccount(opts: AddAccountOptions = {}) {
      const credentials = await readClaudeCredentials(paths, coreDeps);
      if (!credentials.ok) return err(credentials.error, credentials.code);
      if (!credentials.value.claudeAiOauth?.accessToken) {
        return err('Claude Code is not signed in right now', 'not-signed-in');
      }

      const found = await readAccountIdentity(paths, coreDeps);
      const identity: ClaudeAccountIdentity = found.ok ? found.value : {};
      const email = identity.emailAddress?.trim();
      if (!email) {
        return err(
          'could not read the signed-in email address from Claude Code',
          'no-identity',
        );
      }

      return underLock(`add:${email}`, () =>
        upsertAccount(email, credentials.value, identity, opts, true),
      );
    },

    async addToken(opts: AddTokenOptions) {
      const token = opts.token.trim();
      if (!token) return err('token is empty', 'bad-token');
      const kind = detectCredentialKind(token);

      let identity: ClaudeAccountIdentity = opts.email ? { emailAddress: opts.email } : {};
      if (kind !== 'api-key') {
        // A setup token knows who it belongs to; asking is friendlier than
        // making the user retype an address we can look up.
        const profile = await fetchProfile(token, globalThis.fetch);
        if (profile.ok) identity = { ...identity, ...profile.value };
      }

      const email = identity.emailAddress?.trim() ?? opts.email?.trim();
      if (!email) {
        return err('could not determine the account email — pass one explicitly', 'no-identity');
      }

      const credentials: ClaudeCredentialFile = { claudeAiOauth: { accessToken: token } };
      return underLock(`add:${email}`, () =>
        upsertAccount(email, credentials, identity, opts, false),
      );
    },

    async removeAccount(slot: number) {
      return underLock(`remove:${slot}`, async () => {
        const removed = await store.remove(slot);
        if (!removed.ok) return removed;
        live.delete(slot);
        publish();
        return ok(undefined);
      });
    },

    async setAlias(slot: number, alias: string | null) {
      const updated = await store.setAlias(slot, alias);
      if (!updated.ok) return err(updated.error, updated.code);
      publish();
      return ok(accountOf(updated.value));
    },

    async setDisabled(slot: number, disabled: boolean) {
      const updated = await store.setDisabled(slot, disabled);
      if (!updated.ok) return err(updated.error, updated.code);
      publish();
      return ok(accountOf(updated.value));
    },

    async moveAccount(from: number, to: number) {
      return underLock(`move:${from}->${to}`, async () => {
        const moved = await store.move(from, to);
        if (!moved.ok) return err(moved.error, moved.code);
        // Slots are the identity the runtime map is keyed by; a move
        // invalidates every entry rather than silently mislabelling two.
        live.clear();
        publish();
        return ok(listAccounts());
      });
    },

    switchAccount: (request) => runSwitch(request, true),

    async previewSwitch(request: SwitchRequest) {
      return planSwitch(switchContext(), { ...request, dryRun: true });
    },

    async startAutoSwitch() {
      if (store.list().length < 2) {
        return err('auto-switch needs at least two accounts', 'too-few-accounts');
      }
      const current = settings.get();
      if (current.safeMode && !current.autoswitch.dryRun) {
        return err(
          'safe mode is enabled: auto-switch can only run with dry-run turned on',
          SAFE_MODE_CODE,
        );
      }
      autoswitcher.start();
      publish();
      return ok(undefined);
    },

    async stopAutoSwitch() {
      autoswitcher.stop();
      publish();
      return ok(undefined);
    },

    async getHistory(query: HistoryQuery) {
      try {
        return await history.query(query);
      } catch {
        return [];
      }
    },

    async getForecasts(slot: number) {
      const found = store.get(slot);
      if (!found) return [];
      const usage = live.get(slot)?.usage ?? found.lastGoodUsage;
      // `all` folds in every scoped window: the chart shows what exists, unlike
      // the switcher, which only ranks on the models the user opted into.
      const windows = relevantWindows(usage, ['all']);
      if (windows.length === 0) return [];
      const points = await api.getHistory({ slot, since: now() - FORECAST_LOOKBACK_MS });
      const forecasts: Forecast[] = forecastWindows(windows, points, now());
      return forecasts;
    },

    async getSessionPlan(day?: string): Promise<Result<SessionPlan>> {
      const resolved = day === undefined ? today(now()) : localDayFromKey(day);
      if (resolved === null) {
        return err(`"${day}" is not a calendar day — use YYYY-MM-DD`, 'bad-day');
      }

      const planner = settings.get().planner;
      const { schedule, declared } = scheduleFor(resolved);
      const learned = await learnProfile(resolved, schedule);
      // A curve with no load in it cannot be simulated: every anchor ties and
      // the planner has nothing to say. A *thin* curve is still real evidence
      // and is kept — `planDay` marks that low confidence rather than throwing
      // the user's own history away in favour of an invented flat day.
      const profile = learned.hourly.some((value) => value > 0)
        ? learned
        : flatProfile(FLAT_PCT_PER_WORKING_HOUR, schedule.work);

      const accounts: PlanAccount[] = plannableAccounts().map((item) => ({
        slot: item.slot,
        email: item.email,
        alias: item.alias,
        profile,
      }));

      return ok(
        planDay({
          dayStartMs: resolved.dayStartMs,
          tzOffsetMin: resolved.tzOffsetMin,
          schedule,
          accounts,
          peakWeight: planner.peakWeight,
          scheduleConfigured: declared,
        }),
      );
    },

    async getUsageProfile(slot?: number) {
      if (slot !== undefined && !store.get(slot)) {
        return err(`no account in slot ${slot}`, 'not-found');
      }
      const day = today(now());
      // Deliberately *not* the flat fallback the plan uses: this endpoint's job
      // is to show what was learned, and drawing an invented curve as "your
      // usage" would be a chart that lies. An empty profile is the honest one.
      return ok(await learnProfile(day, scheduleFor(day).schedule, slot));
    },

    async getAnchors() {
      const observed: AnchorObservation[] = [];
      for (const item of store.list()) {
        const usage = live.get(item.slot)?.usage ?? item.lastGoodUsage;
        const resetsAt = usage?.fiveHour?.resetsAt;
        // No 5-hour window means nothing to derive an anchor from. Omitted
        // rather than guessed: an invented anchor would be indistinguishable
        // from an observed one everywhere downstream.
        if (usage === undefined || resetsAt === undefined) continue;
        const reset = Date.parse(resetsAt);
        if (Number.isNaN(reset)) continue;
        observed.push({
          slot: item.slot,
          // The whole reason the anchor is knowable at all.
          anchorAt: reset - FIVE_HOUR_MS,
          observedAt: usage.fetchedAt,
        });
      }
      return observed;
    },

    async anchorNow(slot: number) {
      const current = settings.get();
      if (current.safeMode) {
        return {
          ok: false,
          slot,
          error:
            'safe mode is enabled: ClaudeDeck will not switch accounts or send a message. Turn it off in Settings to anchor.',
        };
      }

      const item = store.get(slot);
      if (!item) return { ok: false, slot, error: `no account in slot ${slot}` };
      if (item.kind === 'api-key') {
        return {
          ok: false,
          slot,
          error: `slot ${slot} is a managed API key — it bills per token and has no 5-hour window to anchor.`,
        };
      }
      if (item.quarantinedAt) {
        return {
          ok: false,
          slot,
          error: `slot ${slot} is quarantined (${item.quarantineReason ?? 'sign in again'}), so it cannot send the anchoring message.`,
        };
      }

      // The CLI reads Claude Code's own credential file, so anchoring *this*
      // account means making it the active one first. Nothing else can aim the
      // CLI at a particular login.
      if (store.activeSlot !== slot) {
        const switched = await runSwitch({ target: slot, reason: 'manual' }, true);
        if (!switched.switched) {
          return {
            ok: false,
            slot,
            error: `could not activate slot ${slot} to anchor it: ${switched.error ?? switched.reason}`,
          };
        }
      }

      const prompt = sanitizeAnchorPrompt(current.planner.anchorPrompt, DEFAULT_PLANNER.anchorPrompt);
      const command = anchorCommandText(prompt);
      const startedAt = now();

      let run: AnchorRun;
      try {
        run = await runAnchor(prompt, ANCHOR_TIMEOUT_MS);
      } catch (cause) {
        // A runner that throws is a bug in the runner, not a rejected promise
        // the UI should see raw.
        return { ok: false, slot, command, error: scrubSecrets(describe(cause)) };
      }

      if (run.notFound) {
        return {
          ok: false,
          slot,
          command,
          error:
            `ClaudeDeck could not find the Claude Code CLI. It looked on PATH, in npm's global bin, in ~/.claude/local, and inside the VS Code extension (resources/native-binary) — and it only accepts a binary whose \`--version\` says "Claude Code", so Claude Desktop's \`claude\` does not count. ` +
            `If you have it somewhere else, set its full path in Settings (planner.claudePath) or start ClaudeDeck from a terminal where \`${CLAUDE_BIN} --version\` works.`,
        };
      }
      if (run.timedOut) {
        return {
          ok: false,
          slot,
          command,
          error: `\`${CLAUDE_BIN}\` did not finish within ${Math.round(ANCHOR_TIMEOUT_MS / 1000)}s. The window may still have been anchored — check the 5-hour reset time before trying again.`,
        };
      }
      if (run.code !== 0) {
        const detail = scrubSecrets((run.stderr || run.stdout).trim()).slice(0, ANCHOR_ERROR_CHARS);
        return {
          ok: false,
          slot,
          command,
          error: detail
            ? `\`${CLAUDE_BIN}\` exited ${run.code}: ${detail}`
            : `\`${CLAUDE_BIN}\` exited ${run.code} without saying why.`,
        };
      }

      // The window is anchored the instant the message lands, but only the API
      // knows where the boundary actually fell — so re-poll and read it back
      // instead of reporting the moment we happened to return.
      await refreshAll(slot);
      const resetsAt = live.get(slot)?.usage?.fiveHour?.resetsAt;
      const reset = resetsAt === undefined ? NaN : Date.parse(resetsAt);
      const result: AnchorResult = { ok: true, slot, command };
      if (Number.isNaN(reset)) {
        result.anchoredAt = startedAt;
      } else {
        result.resetsAt = reset;
        result.anchoredAt = reset - FIVE_HOUR_MS;
      }
      return result;
    },

    async getSettings() {
      return settings.get();
    },

    async updateSettings(patch: Partial<Settings>) {
      const saved = await settings.update(patch);
      if (!saved.ok) return saved;
      // Turning the engine off in Settings has to actually stop the timer.
      if (!saved.value.autoswitch.enabled && autoswitcher.isRunning()) autoswitcher.stop();
      publish();
      return saved;
    },

    async mapDirectory(path: string, slot: number) {
      const trimmed = path.trim();
      if (!trimmed) return err('directory path is empty', 'bad-path');
      if (!store.get(slot)) return err(`no account in slot ${slot}`, 'not-found');
      const next: DirectoryMapping[] = [
        ...settings.get().directoryMappings.filter((entry) => !samePath(entry.path, trimmed)),
        { path: trimmed, slot },
      ];
      const saved = await settings.update({ directoryMappings: next });
      if (!saved.ok) return err(saved.error, saved.code);
      publish();
      return ok(saved.value.directoryMappings);
    },

    async unmapDirectory(path: string) {
      const next = settings.get().directoryMappings.filter((entry) => !samePath(entry.path, path));
      const saved = await settings.update({ directoryMappings: next });
      if (!saved.ok) return err(saved.error, saved.code);
      publish();
      return ok(saved.value.directoryMappings);
    },

    async exportAccounts(opts: { slot?: number; full?: boolean }) {
      const records =
        opts.slot === undefined ? store.list() : store.list().filter((r) => r.slot === opts.slot);
      if (records.length === 0) return err('nothing to export', 'not-found');

      const accounts: ExportedAccount[] = [];
      for (const item of records) {
        if (!item.credentials) continue;
        accounts.push({
          slot: item.slot,
          email: item.email,
          alias: item.alias,
          kind: item.kind,
          identity: item.identity,
          // Slim by default: only the account's own login travels. `full` is
          // for a same-machine backup and keeps every sibling key.
          credentials: opts.full
            ? item.credentials
            : { claudeAiOauth: item.credentials.claudeAiOauth },
        });
      }
      if (accounts.length === 0) return err('no exportable credentials found', 'no-credentials');

      const payload: ExportPayload = {
        format: EXPORT_FORMAT,
        version: 1,
        exportedAt: new Date(now()).toISOString(),
        warning: 'This file contains live Claude credentials in plaintext. Treat it as a password.',
        accounts,
      };
      return ok(JSON.stringify(payload, null, 2));
    },

    async importAccounts(payloadText: string, opts: { force?: boolean }) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payloadText);
      } catch (cause) {
        return err(`not valid JSON: ${describe(cause)}`, 'bad-payload');
      }
      if (!isRecord(parsed) || parsed['format'] !== EXPORT_FORMAT) {
        return err('this is not a ClaudeDeck export', 'bad-payload');
      }
      const entries = parsed['accounts'];
      if (!Array.isArray(entries) || entries.length === 0) {
        return err('the export contains no accounts', 'bad-payload');
      }

      return underLock('import', async () => {
        const failures: string[] = [];
        for (const raw of entries) {
          if (!isRecord(raw)) continue;
          const email = typeof raw['email'] === 'string' ? raw['email'].trim() : '';
          const credentials = raw['credentials'];
          if (!email || !isRecord(credentials)) continue;
          const added = await upsertAccount(
            email,
            credentials as ClaudeCredentialFile,
            isRecord(raw['identity'])
              ? (raw['identity'] as ClaudeAccountIdentity)
              : { emailAddress: email },
            {
              slot: typeof raw['slot'] === 'number' ? raw['slot'] : undefined,
              alias: typeof raw['alias'] === 'string' ? raw['alias'] : undefined,
              force: opts.force,
            },
            false,
          );
          if (!added.ok) failures.push(`${email}: ${added.error}`);
        }
        publish();
        // One bad slot must not discard the accounts that did import, but the
        // caller still needs to hear about it.
        if (failures.length === entries.length) {
          return err(`nothing could be imported — ${failures.join('; ')}`, 'import-failed');
        }
        return ok(listAccounts());
      });
    },

    onStateChanged(callback) {
      stateListeners.add(callback);
      return () => {
        stateListeners.delete(callback);
      };
    },

    onAutoSwitchEvent(callback) {
      eventListeners.add(callback);
      return () => {
        eventListeners.delete(callback);
      };
    },

    async dispose() {
      autoswitcher.stop();
      stateListeners.clear();
      eventListeners.clear();
      try {
        await history.prune(settings.get().historyRetentionDays, now());
      } catch {
        // Best effort on the way out; never block quit on housekeeping.
      }
    },
  };

  settings.onChange(() => publish());
  snapshot = buildState();
  return api;
}

// ---------------------------------------------------------------------------
// Export payload
// ---------------------------------------------------------------------------

export const EXPORT_FORMAT = 'claudedeck.accounts';

export interface ExportedAccount {
  slot: number;
  email: string;
  alias?: string;
  kind: Account['kind'];
  identity?: ClaudeAccountIdentity;
  credentials: ClaudeCredentialFile;
}

export interface ExportPayload {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: string;
  warning: string;
  accounts: ExportedAccount[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) => value.trim().replace(/[\\/]+$/, '').toLowerCase();
  return normalize(left) === normalize(right);
}
