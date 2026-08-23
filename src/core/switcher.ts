/**
 * The account swap.
 *
 * Two halves, deliberately separated:
 *
 * - `planSwitch` is pure. It resolves the target (slot, email or alias),
 *   applies the rotation strategy, and reports the exact files a real run would
 *   touch. That is what the GUI's preview panel renders, so the user sees every
 *   write before it happens instead of switching blind.
 * - `applySwitch` performs the same plan for real, under the credential lock,
 *   refreshing the target token first when it is spent.
 *
 * Everything that touches disk, the network or the clock arrives through
 * `SwitchDeps`; nothing here reaches for a global.
 */

import type {
  Account,
  AutoSwitchEvent,
  ClaudeAccountIdentity,
  ClaudeCredentialFile,
  ClaudePaths,
  Headroom,
  PlatformKind,
  Result,
  Settings,
  SwitchRequest,
  SwitchResult,
  SwitchStrategy,
} from '@shared/types';
import { withLock, type LockDeps, CREDENTIALS_STALE_MS, DEFAULT_LOCK_TIMEOUT_MS } from './locks';
import { type FetchLike, isExpired, refreshToken } from './oauth';
import { headroom } from './usage';

// ---------------------------------------------------------------------------
// Context, deps and the plan
// ---------------------------------------------------------------------------

/** Everything `planSwitch` needs. All of it is data; none of it is I/O. */
export interface SwitchContext {
  accounts: Account[];
  activeSlot: number | null;
  paths: ClaudePaths;
  settings: Settings;
  /** Drives whether credentials live in a file or the macOS Keychain. */
  platform?: PlatformKind;
  /** Epoch ms. */
  now: number;
  /** Overrides `<deckHome>/accounts.json` in the planned-write list. */
  storePath?: string;
}

/** Credential blobs and flags a completed switch asks the store to persist. */
export interface SwitchPersist {
  activeSlot: number;
  previousSlot?: number;
  /** Epoch ms. */
  switchedAt: number;
  /**
   * Slot-keyed credentials to save: the target's rotated token, and the live
   * blob captured off the outgoing account before it was overwritten.
   */
  credentials?: Array<{ slot: number; credentials: ClaudeCredentialFile }>;
}

export interface SwitchDeps {
  /** Epoch ms. */
  now(): number;
  /** Only used to refresh a spent target token. */
  fetch: FetchLike;
  lock: LockDeps;
  /** Defaults to `<credentials>.claudedeck.lock`. */
  lockPath?: string;
  lockTimeoutMs?: number;
  lockStaleMs?: number;

  /** The credential blob ClaudeDeck holds for a slot. */
  loadStoredCredentials(slot: number): Promise<Result<ClaudeCredentialFile>>;
  /**
   * What Claude Code is live on right now, or null when there is nothing.
   * Read so a token Claude Code rotated behind our back is captured back into
   * the store before we overwrite it — a rotated refresh token is one-shot, and
   * losing it strands the outgoing account.
   */
  readLiveCredentials(): Promise<Result<ClaudeCredentialFile | null>>;
  /** Write the live credential store: the file, or the macOS Keychain item. */
  writeLiveCredentials(file: ClaudeCredentialFile): Promise<Result<void>>;
  /** Merge `oauthAccount` into Claude Code's global config. */
  writeIdentity(identity: ClaudeAccountIdentity): Promise<Result<void>>;
  /** Record the completed swap. */
  persist(update: SwitchPersist): Promise<Result<void>>;
  /** Mark a slot unusable because its refresh token is permanently dead. */
  quarantine(slot: number, reason: string, at: number): Promise<Result<void>>;
  emit?(event: AutoSwitchEvent): void;
}

/** The resolved intent, shared by the preview and the real run. */
export interface SwitchPlan {
  from?: { slot: number; email: string };
  to: { slot: number; email: string };
  target: Account;
  /** Target is already active and `force` was not set. */
  noop: boolean;
  reason: string;
  plannedWrites: string[];
}

/**
 * Refresh a token that expires within this window rather than handing Claude
 * Code a credential that dies mid-request. Wider than the poll-time skew: a
 * switch is followed by a long-lived session, not one API call.
 */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;

/** Ranking stand-in for an account we have never polled. */
export const UNKNOWN_HEADROOM = 50;

/** Mirrors `VAULT_FILENAME` in `vault.ts`; kept literal so this module needs no
 * node imports and stays loadable from the renderer. */
export const DEFAULT_STORE_FILENAME = 'vault.json';
/** Sits beside the credential file so any ClaudeDeck process sees the same lock. */
export const LOCK_SUFFIX = '.claudedeck.lock';
/** macOS keeps the credential blob here instead of in a file. */
export const MACOS_KEYCHAIN_SERVICE = 'Claude Code-credentials';

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a slot number, email or alias to an account.
 *
 * Aliases and emails are matched case-insensitively, and a unique prefix of an
 * email (or of its local part) is accepted so `claudedeck switch work` does the
 * obvious thing. An ambiguous prefix is an error, never a coin flip.
 */
export function resolveTarget(accounts: Account[], target: string | number): Result<Account> {
  const raw = typeof target === 'number' ? String(target) : target.trim();
  if (raw === '') return { ok: false, error: 'no switch target given' };

  if (/^\d+$/.test(raw)) {
    const slot = Number(raw);
    const bySlot = accounts.find((a) => a.slot === slot);
    return bySlot === undefined
      ? { ok: false, error: `no account in slot ${slot}`, code: 'no-such-account' }
      : { ok: true, value: bySlot };
  }

  const needle = raw.toLowerCase();
  const byAlias = accounts.find((a) => a.alias !== undefined && a.alias.toLowerCase() === needle);
  if (byAlias !== undefined) return { ok: true, value: byAlias };

  const byEmail = accounts.find((a) => a.email.toLowerCase() === needle);
  if (byEmail !== undefined) return { ok: true, value: byEmail };

  const prefixed = accounts.filter((a) => {
    const email = a.email.toLowerCase();
    return email.startsWith(needle) || localPart(email).startsWith(needle);
  });
  const first = prefixed[0];
  if (first === undefined) {
    return { ok: false, error: `no account matches "${raw}"`, code: 'no-such-account' };
  }
  if (prefixed.length > 1) {
    const slots = prefixed.map((a) => a.slot).join(', ');
    return { ok: false, error: `"${raw}" matches slots ${slots}`, code: 'ambiguous-target' };
  }
  return { ok: true, value: first };
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

/** Headroom from the freshest snapshot we trust, or null when unknown. */
export function accountHeadroom(account: Account, models: string[] = []): Headroom | null {
  return headroom(account.usage ?? account.lastGoodUsage, models);
}

/**
 * Comparable headroom for ranking. An unpolled account scores a neutral 50: it
 * must not outrank a known-fresh account, and it must not be buried under a
 * known-exhausted one either.
 */
export function headroomScore(account: Account, models: string[] = []): number {
  // API-key accounts carry no subscription quota, so no window can ever gate
  // them; they rank as wide open rather than unknown.
  if (account.kind === 'api-key') return 100;
  return accountHeadroom(account, models)?.remaining ?? UNKNOWN_HEADROOM;
}

/** Is this account unusable right now — rate limited, spent, or quarantined? */
export function isExhausted(account: Account, models: string[] = []): boolean {
  if (account.quarantinedAt !== undefined) return true;
  if (account.usageStatus === 'rate-limited' || account.usageStatus === 'quarantined') return true;
  if (account.kind === 'api-key') return false;
  const room = accountHeadroom(account, models);
  return room !== null && room.remaining <= 0;
}

/**
 * Epoch ms at which this account's weekly quota rolls over, or null.
 *
 * The 7-day window first, then the soonest per-model weekly window — this is
 * the perishability clock `consume-first` spends against.
 */
export function weeklyResetAt(account: Account): number | null {
  const usage = account.usage ?? account.lastGoodUsage;
  if (usage === undefined) return null;
  const candidates: number[] = [];
  const push = (iso: string | undefined): void => {
    if (iso === undefined) return;
    const at = Date.parse(iso);
    if (!Number.isNaN(at)) candidates.push(at);
  };
  push(usage.sevenDay?.resetsAt);
  if (candidates.length > 0) return candidates[0] ?? null;
  for (const window of usage.scoped) push(window.resetsAt);
  if (candidates.length === 0) return null;
  return Math.min(...candidates);
}

export interface RotationOptions {
  strategy: SwitchStrategy;
  activeSlot: number | null;
  includeApiKeyAccounts: boolean;
  /** Per-model weekly windows folded into the ranking, by display name. */
  models?: string[];
}

/**
 * Every account this strategy is willing to rotate onto, best first.
 *
 * The shared floor is the same for all four strategies: never the incumbent,
 * never a disabled account, never a quarantined one, and never an API-key
 * account unless the config opts in — those have no quota, so rotating onto one
 * silently changes billing.
 */
export function rotationCandidates(accounts: Account[], opts: RotationOptions): Account[] {
  const models = opts.models ?? [];
  const eligible = accounts.filter(
    (a) =>
      a.slot !== opts.activeSlot &&
      !a.disabled &&
      a.quarantinedAt === undefined &&
      (a.kind !== 'api-key' || opts.includeApiKeyAccounts),
  );

  switch (opts.strategy) {
    case 'next':
      // Deliberately does not filter on usage: `next` is "give me the account
      // after this one", and a user asking for that means it literally.
      return rotationOrder(eligible, opts.activeSlot);

    case 'next-available':
      return rotationOrder(
        eligible.filter((a) => !isExhausted(a, models)),
        opts.activeSlot,
      );

    case 'best':
      return eligible
        .filter((a) => !isExhausted(a, models))
        .sort(
          (a, b) => headroomScore(b, models) - headroomScore(a, models) || a.slot - b.slot,
        );

    case 'consume-first':
      // Quota that expires soonest is the quota most likely to be wasted, so
      // spend it first. Accounts with no known weekly reset sort last rather
      // than being excluded — unknown is not the same as "no deadline".
      return eligible
        .filter((a) => !isExhausted(a, models))
        .sort((a, b) => {
          const ra = weeklyResetAt(a);
          const rb = weeklyResetAt(b);
          if (ra !== rb) {
            if (ra === null) return 1;
            if (rb === null) return -1;
            return ra - rb;
          }
          return headroomScore(b, models) - headroomScore(a, models) || a.slot - b.slot;
        });
  }
}

/** Slots after the incumbent, then the ones before it: a stable rotation. */
function rotationOrder(accounts: Account[], activeSlot: number | null): Account[] {
  const sorted = [...accounts].sort((a, b) => a.slot - b.slot);
  if (activeSlot === null) return sorted;
  const after = sorted.filter((a) => a.slot > activeSlot);
  const before = sorted.filter((a) => a.slot < activeSlot);
  return [...after, ...before];
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

/**
 * Resolve `req` against `ctx` and report what a real run would do.
 *
 * Pure: it reads no clock, opens no file, and is safe to call on every
 * keystroke behind the preview panel. `switched` is always false here — nothing
 * has happened yet — so a caller checks `error` to know whether the plan is
 * viable, and reads `to` plus `plannedWrites` to describe it.
 */
export function planSwitch(ctx: SwitchContext, req: SwitchRequest): SwitchResult {
  const resolved = resolvePlan(ctx, req);
  if (!resolved.ok) return { ...resolved.result, dryRun: true };
  const plan = resolved.value;
  const result: SwitchResult = {
    switched: false,
    dryRun: true,
    reason: plan.reason,
    to: plan.to,
  };
  if (plan.from !== undefined) result.from = plan.from;
  if (!plan.noop) result.plannedWrites = plan.plannedWrites;
  return result;
}

type PlanOutcome = { ok: true; value: SwitchPlan } | { ok: false; result: SwitchResult };

function resolvePlan(ctx: SwitchContext, req: SwitchRequest): PlanOutcome {
  const strategy = req.strategy ?? ctx.settings.autoswitch.strategy ?? 'next';
  const from = activeAccount(ctx);
  const fromRef = from === undefined ? undefined : { slot: from.slot, email: from.email };

  let target: Account;
  let how: string;

  if (req.target !== undefined && req.target !== '') {
    const found = resolveTarget(ctx.accounts, req.target);
    if (!found.ok) {
      return { ok: false, result: failure(found.error, fromRef, 'target not resolved') };
    }
    target = found.value;
    how = `explicit target ${describeAccount(target)}`;
    // Explicit intent overrides the auto-rotation guards, but the preview says
    // so plainly — an explicit switch onto a dead refresh token will fail at
    // the refresh step, and the user deserves to know before they click.
    if (target.quarantinedAt !== undefined) how += ' (quarantined — refresh may fail)';
    else if (target.disabled) how += ' (disabled — excluded from auto-rotation)';
  } else {
    const candidates = rotationCandidates(ctx.accounts, {
      strategy,
      activeSlot: ctx.activeSlot,
      includeApiKeyAccounts: ctx.settings.autoswitch.includeApiKeyAccounts,
      models: ctx.settings.autoswitch.models,
    });
    const chosen = candidates[0];
    if (chosen === undefined) {
      return {
        ok: false,
        result: failure(
          `strategy "${strategy}" found no account to rotate onto — ${explainEmpty(ctx)}`,
          fromRef,
          'no candidate',
        ),
      };
    }
    target = chosen;
    how = `strategy "${strategy}" chose ${describeAccount(target)}`;
  }

  const toRef = { slot: target.slot, email: target.email };
  const alreadyActive = from !== undefined && from.slot === target.slot;
  const plan: SwitchPlan = {
    to: toRef,
    target,
    noop: alreadyActive && req.force !== true,
    reason: alreadyActive && req.force !== true ? `${describeAccount(target)} is already active` : how,
    plannedWrites: plannedWrites(ctx, target, from),
  };
  if (fromRef !== undefined) plan.from = fromRef;
  return { ok: true, value: plan };
}

/** The literal writes a real run performs, in the order it performs them. */
function plannedWrites(ctx: SwitchContext, target: Account, from: Account | undefined): string[] {
  const writes: string[] = [];
  const store = ctx.storePath ?? joinPath(ctx.paths.deckHome, DEFAULT_STORE_FILENAME);

  writes.push(`${lockPathFor(ctx.paths)} (advisory lock, created then removed)`);
  if (from !== undefined) {
    writes.push(`${store} (capture slot ${from.slot}'s live credential before overwriting it)`);
  }
  writes.push(
    ctx.platform === 'macos'
      ? `macOS Keychain "${MACOS_KEYCHAIN_SERVICE}" (slot ${target.slot}'s OAuth blob)`
      : `${ctx.paths.credentials} (slot ${target.slot}'s OAuth blob)`,
  );
  const identity = identityFor(target);
  if (identity !== null) {
    writes.push(`${ctx.paths.globalConfig} (oauthAccount → ${target.email})`);
  }
  writes.push(`${store} (active slot → ${target.slot})`);
  return writes;
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * Perform the switch.
 *
 * Refused outright in safe mode. A switch onto the already-active account is a
 * no-op unless `force`. Everything from the capture of the outgoing credential
 * to the store update happens under one lock, so a Claude Code token refresh
 * racing us either waits or is waited for.
 */
export async function applySwitch(
  ctx: SwitchContext,
  req: SwitchRequest,
  deps: SwitchDeps,
): Promise<SwitchResult> {
  const resolved = resolvePlan(ctx, req);
  if (!resolved.ok) return { ...resolved.result, dryRun: req.dryRun === true };
  const plan = resolved.value;

  if (req.dryRun === true) return planSwitch(ctx, req);

  if (ctx.settings.safeMode) {
    return {
      ...failure(
        'safe mode is enabled: refusing to write credentials. Turn it off in Settings to switch.',
        plan.from,
        'refused',
        'safe-mode',
      ),
      to: plan.to,
      dryRun: false,
    };
  }

  if (plan.noop) {
    const noop: SwitchResult = {
      switched: false,
      dryRun: false,
      reason: `${plan.reason} — nothing to do`,
      to: plan.to,
    };
    if (plan.from !== undefined) noop.from = plan.from;
    return noop;
  }

  const held = await withLock(
    deps.lockPath ?? lockPathFor(ctx.paths),
    {
      timeoutMs: deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
      staleMs: deps.lockStaleMs ?? CREDENTIALS_STALE_MS,
      owner: `switch:slot-${plan.to.slot}`,
    },
    deps.lock,
    (handle) => runSwitch(plan, deps, handle.renew),
  );

  if (held.ok) return held.value;
  const blocked: SwitchResult = {
    switched: false,
    dryRun: false,
    reason: 'could not take the credential lock',
    error: held.error,
    to: plan.to,
  };
  if (plan.from !== undefined) blocked.from = plan.from;
  return blocked;
}

async function runSwitch(
  plan: SwitchPlan,
  deps: SwitchDeps,
  renewLock: () => Promise<Result<void>>,
): Promise<SwitchResult> {
  const base: SwitchResult = {
    switched: false,
    dryRun: false,
    reason: plan.reason,
    to: plan.to,
    plannedWrites: plan.plannedWrites,
  };
  if (plan.from !== undefined) base.from = plan.from;

  const stored = await deps.loadStoredCredentials(plan.target.slot);
  if (!stored.ok) {
    return { ...base, error: `no stored credential for slot ${plan.target.slot}: ${stored.error}` };
  }

  // Capture first: whatever Claude Code is holding may be newer than our copy
  // (it refreshes on its own schedule and rotates the refresh token when it
  // does), and once we overwrite the file that newer copy is gone for good.
  const toPersist: Array<{ slot: number; credentials: ClaudeCredentialFile }> = [];
  if (plan.from !== undefined) {
    const live = await deps.readLiveCredentials();
    if (live.ok && live.value !== null) {
      toPersist.push({ slot: plan.from.slot, credentials: live.value });
    }
  }

  let file = stored.value;
  const oauth = file.claudeAiOauth;
  // No `claudeAiOauth` block means there is no refresh grant to run — an
  // API-key credential authenticates by the key itself and never expires.
  if (oauth !== undefined && isExpired(oauth, deps.now(), TOKEN_REFRESH_MARGIN_MS)) {
    const refreshed = await refreshToken(oauth, deps.fetch, deps.now());
    if (!refreshed.ok) {
      if (refreshed.permanent) {
        const at = deps.now();
        const why = `refresh rejected (${refreshed.error})`;
        await deps.quarantine(plan.target.slot, why, at);
        deps.emit?.({
          kind: 'account-quarantined',
          ts: at,
          slot: plan.target.slot,
          message: `slot ${plan.target.slot} (${plan.to.email}) needs re-authentication: ${why}`,
        });
        return {
          ...base,
          error: `slot ${plan.target.slot}'s refresh token is no longer valid — sign in again`,
        };
      }
      return { ...base, error: `could not refresh slot ${plan.target.slot}: ${refreshed.error}` };
    }
    file = { ...file, claudeAiOauth: refreshed.oauth };
    toPersist.push({ slot: plan.target.slot, credentials: file });
    // The round trip may have eaten most of the staleness budget; tell waiters
    // we are still alive before starting the writes.
    await renewLock();
  }

  const written = await deps.writeLiveCredentials(file);
  if (!written.ok) return { ...base, error: `could not write credentials: ${written.error}` };

  // Past this point the swap has taken effect: Claude Code is authenticating as
  // the new account. Later failures are reported alongside `switched: true`
  // rather than pretending nothing happened.
  const done: SwitchResult = { ...base, switched: true };

  const identity = identityFor(plan.target);
  if (identity !== null) {
    const idWritten = await deps.writeIdentity(identity);
    if (!idWritten.ok) {
      return {
        ...done,
        error: `credentials switched, but the global config still names the old account: ${idWritten.error}`,
      };
    }
  }

  const update: SwitchPersist = { activeSlot: plan.target.slot, switchedAt: deps.now() };
  if (plan.from !== undefined) update.previousSlot = plan.from.slot;
  if (toPersist.length > 0) update.credentials = toPersist;
  const persisted = await deps.persist(update);
  if (!persisted.ok) {
    return { ...done, error: `switched, but the account store was not updated: ${persisted.error}` };
  }

  deps.emit?.({
    kind: 'switch',
    ts: update.switchedAt,
    slot: plan.target.slot,
    message: `switched to ${describeAccount(plan.target)}`,
    detail: { from: plan.from?.slot ?? null, reason: plan.reason },
  });
  return done;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function lockPathFor(paths: ClaudePaths): string {
  return `${paths.credentials}${LOCK_SUFFIX}`;
}

function activeAccount(ctx: SwitchContext): Account | undefined {
  if (ctx.activeSlot !== null) {
    const bySlot = ctx.accounts.find((a) => a.slot === ctx.activeSlot);
    if (bySlot !== undefined) return bySlot;
  }
  return ctx.accounts.find((a) => a.active);
}

/**
 * The `oauthAccount` block to write, or null when we know nothing worth
 * writing. A stored identity wins; otherwise the email alone still binds Claude
 * Code's config to the right account.
 */
function identityFor(account: Account): ClaudeAccountIdentity | null {
  if (account.identity !== undefined) {
    return account.identity.emailAddress === undefined && account.email !== ''
      ? { ...account.identity, emailAddress: account.email }
      : account.identity;
  }
  return account.email === '' ? null : { emailAddress: account.email };
}

function describeAccount(account: Account): string {
  const alias = account.alias === undefined ? '' : ` "${account.alias}"`;
  return `slot ${account.slot}${alias} (${account.email})`;
}

/** Why a rotation came up empty, in terms the user can act on. */
function explainEmpty(ctx: SwitchContext): string {
  const others = ctx.accounts.filter((a) => a.slot !== ctx.activeSlot);
  if (others.length === 0) return 'no other account is managed';
  const models = ctx.settings.autoswitch.models;
  const counts = {
    disabled: others.filter((a) => a.disabled).length,
    quarantined: others.filter((a) => a.quarantinedAt !== undefined).length,
    exhausted: others.filter((a) => a.quarantinedAt === undefined && isExhausted(a, models)).length,
    apiKey: others.filter((a) => a.kind === 'api-key').length,
  };
  const parts: string[] = [];
  if (counts.disabled > 0) parts.push(`${counts.disabled} disabled`);
  if (counts.quarantined > 0) parts.push(`${counts.quarantined} quarantined`);
  if (counts.exhausted > 0) parts.push(`${counts.exhausted} out of quota`);
  if (counts.apiKey > 0 && !ctx.settings.autoswitch.includeApiKeyAccounts) {
    parts.push(`${counts.apiKey} api-key (excluded)`);
  }
  return parts.length === 0 ? 'every other account was filtered out' : parts.join(', ');
}

function failure(
  error: string,
  from: { slot: number; email: string } | undefined,
  reason: string,
  code?: string,
): SwitchResult {
  const result: SwitchResult = { switched: false, dryRun: false, reason, error };
  if (from !== undefined) result.from = from;
  if (code !== undefined) result.reason = `${reason} (${code})`;
  return result;
}

function localPart(email: string): string {
  const at = email.indexOf('@');
  return at === -1 ? email : email.slice(0, at);
}

/** Join without `node:path`, so this module stays pure and platform-agnostic. */
function joinPath(base: string, child: string): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return base.endsWith(sep) ? `${base}${child}` : `${base}${sep}${child}`;
}
