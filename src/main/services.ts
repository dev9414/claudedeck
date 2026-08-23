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

import { promises as fsp } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';

import type {
  Account,
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
  Settings,
  SwitchRequest,
  SwitchResult,
  UsageSnapshot,
  UsageStatus,
} from '@shared/types';
import { err, ok } from '@shared/types';
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

import { createSettingsStore, type SettingsStore } from './settings';

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
}

export const SAFE_MODE_CODE = 'safe-mode';

const MAX_RETAINED_EVENTS = 100;
/** Enough history to fit a 7-day window plus a week of context either side. */
const FORECAST_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;
/** Sits beside the vault so a concurrent CLI sees the same lock. */
const REGISTRY_LOCK_SUFFIX = '.claudedeck.lock';

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
    if (usage.fiveHour) windows[usage.fiveHour.key] = usage.fiveHour.pct;
    if (usage.sevenDay) windows[usage.sevenDay.key] = usage.sevenDay.pct;
    for (const scoped of usage.scoped) windows[scoped.key] = scoped.pct;
    const point: HistoryPoint = { t: usage.fetchedAt, slot, windows };
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
