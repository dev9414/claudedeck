/**
 * The account registry: which accounts ClaudeDeck manages, in which slot, under
 * which alias, and whether each is disabled or quarantined.
 *
 * The registry is the app's durable identity for an account, so slot numbers
 * are 1-based and *stable* — removing slot 2 leaves a hole rather than
 * renumbering 3 into it, because a user's muscle memory, their directory
 * mappings and their shell aliases all point at the number. Persistence goes
 * through the vault, so the credential blobs stored alongside the metadata are
 * encrypted at rest.
 *
 * Every mutation writes before it commits in memory: if the save fails, the
 * in-memory registry is left exactly as it was, so disk and memory can never
 * disagree about what the user asked for.
 */

import type {
  Account,
  ClaudeAccountIdentity,
  ClaudeCredentialFile,
  CredentialKind,
  Result,
  UsageSnapshot,
  UsageStatus,
} from '@shared/types';
import { err, ok } from '@shared/types';

import { type CoreDeps, isRecord } from './credentials';
import { type Encryptor, type Vault, createVault } from './vault';

/** Bump only alongside a new case in `migrate()`. */
export const STORE_SCHEMA_VERSION = 1;

/**
 * One managed account as persisted. A superset of the metadata in `Account`:
 * the runtime-only fields (`active`, live `usage`) are derived, not stored.
 *
 * Written as a type alias rather than an interface so the whole file is
 * structurally a `VaultData`.
 */
export type AccountRecord = {
  slot: number;
  email: string;
  alias?: string;
  kind: CredentialKind;
  disabled: boolean;
  identity?: ClaudeAccountIdentity;
  /** The account's own copy of Claude Code's credential blob. Encrypted at
   * rest by the vault; this is the reason the vault exists. */
  credentials?: ClaudeCredentialFile;
  /** Epoch ms; mirrors `claudeAiOauth.expiresAt` so the UI can warn without
   * decrypting and parsing every blob. */
  tokenExpiresAt?: number;
  quarantinedAt?: number;
  quarantineReason?: string;
  /** Survives restarts so the dashboard has something to draw before the
   * first poll comes back. */
  lastGoodUsage?: UsageSnapshot;
  addedAt: number;
};

export type StoreFile = {
  schemaVersion: number;
  accounts: AccountRecord[];
  /** Hint only: the slot ClaudeDeck last wrote into Claude Code's store. The
   * authority is always Claude Code's live credential, not this field. */
  activeSlot: number | null;
  updatedAt: number;
};

/** A slot number, an alias, or an email — the CLI accepts all three. */
export type AccountSelector = number | string;

export interface UpsertAccountInput {
  email: string;
  /** Next free slot when omitted. */
  slot?: number;
  /** `null` clears an existing alias. */
  alias?: string | null;
  kind?: CredentialKind;
  identity?: ClaudeAccountIdentity;
  credentials?: ClaudeCredentialFile;
  tokenExpiresAt?: number;
  disabled?: boolean;
  addedAt?: number;
  /** Displace whoever already holds the requested slot. */
  force?: boolean;
}

/** Aliases share a namespace with slot selectors, so a bare number is out. */
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

const CREDENTIAL_KINDS = new Set<string>(['oauth', 'setup-token', 'api-key']);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function emptyStore(now: number): StoreFile {
  return { schemaVersion: STORE_SCHEMA_VERSION, accounts: [], activeSlot: null, updatedAt: now };
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function firstFreeSlot(taken: Set<number>): number {
  let slot = 1;
  while (taken.has(slot)) slot++;
  return slot;
}

function readString(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readRecord(raw: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = raw[key];
  return isRecord(value) ? value : undefined;
}

function readAccount(raw: Record<string, unknown>, now: number): AccountRecord | null {
  const email = typeof raw['email'] === 'string' ? raw['email'].trim() : '';
  // An account with no email cannot be selected, displayed, or matched against
  // a live login. There is nothing useful to keep.
  if (!email) return null;

  const kindRaw = raw['kind'];
  const kind: CredentialKind =
    typeof kindRaw === 'string' && CREDENTIAL_KINDS.has(kindRaw)
      ? (kindRaw as CredentialKind)
      : 'oauth';

  const record: AccountRecord = {
    slot: isPositiveInt(raw['slot']) ? raw['slot'] : 0, // 0 = "assign me one"
    email,
    kind,
    disabled: raw['disabled'] === true,
    addedAt: typeof raw['addedAt'] === 'number' ? raw['addedAt'] : now,
  };

  const alias = readString(raw, 'alias');
  if (alias && ALIAS_PATTERN.test(alias) && !/^\d+$/.test(alias)) record.alias = alias;

  const identity = readRecord(raw, 'identity');
  if (identity) record.identity = identity as ClaudeAccountIdentity;

  const credentials = readRecord(raw, 'credentials');
  if (credentials) record.credentials = credentials as ClaudeCredentialFile;

  if (typeof raw['tokenExpiresAt'] === 'number') record.tokenExpiresAt = raw['tokenExpiresAt'];
  if (typeof raw['quarantinedAt'] === 'number') record.quarantinedAt = raw['quarantinedAt'];

  const reason = readString(raw, 'quarantineReason');
  if (reason) record.quarantineReason = reason;

  const lastGoodUsage = readRecord(raw, 'lastGoodUsage');
  if (lastGoodUsage) record.lastGoodUsage = lastGoodUsage as unknown as UsageSnapshot;

  return record;
}

/**
 * Bring any persisted payload up to the current schema.
 *
 * Deliberately forgiving in one direction and strict in the other: unknown or
 * malformed *entries* are repaired or dropped (a hand-edited vault should not
 * brick the app), but a payload from a *newer* schema is refused outright,
 * because rewriting it would silently discard fields this build cannot model.
 */
export function migrate(raw: unknown, now: number): Result<StoreFile> {
  if (raw === undefined || raw === null) return ok(emptyStore(now));
  if (!isRecord(raw)) return err('account store payload is not an object', 'schema-invalid');

  const rawVersion = raw['schemaVersion'];
  // v0 is the unversioned shape: anything written before `schemaVersion`
  // existed. Its account entries are already field-compatible, so the upgrade
  // is the normalization below plus stamping the version.
  const version = typeof rawVersion === 'number' ? rawVersion : 0;
  if (version > STORE_SCHEMA_VERSION) {
    return err(
      `account store is schema v${version}; this build understands v${STORE_SCHEMA_VERSION}`,
      'schema-too-new',
    );
  }

  const entries = Array.isArray(raw['accounts']) ? raw['accounts'] : [];
  const taken = new Set<number>();
  const seenEmails = new Set<string>();
  const seenAliases = new Set<string>();
  const placed: AccountRecord[] = [];
  const needsSlot: AccountRecord[] = [];

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const record = readAccount(entry, now);
    if (!record) continue;

    // Email is the account's identity; a duplicate is a corrupted write, and
    // keeping both would make `get(email)` ambiguous forever.
    const key = normalizeEmail(record.email);
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);

    if (record.alias) {
      const aliasKey = record.alias.toLowerCase();
      if (seenAliases.has(aliasKey)) delete record.alias;
      else seenAliases.add(aliasKey);
    }

    if (record.slot > 0 && !taken.has(record.slot)) {
      taken.add(record.slot);
      placed.push(record);
    } else {
      needsSlot.push(record);
    }
  }

  for (const record of needsSlot) {
    record.slot = firstFreeSlot(taken);
    taken.add(record.slot);
    placed.push(record);
  }
  placed.sort((a, b) => a.slot - b.slot);

  const activeRaw = raw['activeSlot'];
  const activeSlot = isPositiveInt(activeRaw) && taken.has(activeRaw) ? activeRaw : null;

  return ok({
    schemaVersion: STORE_SCHEMA_VERSION,
    accounts: placed,
    activeSlot,
    updatedAt: typeof raw['updatedAt'] === 'number' ? raw['updatedAt'] : now,
  });
}

/**
 * Project a stored record onto the renderer-facing `Account`.
 *
 * `active` and `usageStatus` are runtime facts the registry does not own, so
 * they are supplied by the caller; the default status is the honest one —
 * quarantine and "API keys have no quota" are knowable from the record alone,
 * everything else is unknown until a poll says otherwise.
 */
export function toAccount(
  record: AccountRecord,
  opts: { active: boolean; usage?: UsageSnapshot; usageStatus?: UsageStatus },
): Account {
  const status: UsageStatus =
    opts.usageStatus ??
    (record.quarantinedAt ? 'quarantined' : record.kind === 'api-key' ? 'no-quota' : 'unavailable');

  return {
    slot: record.slot,
    email: record.email,
    alias: record.alias,
    kind: record.kind,
    active: opts.active,
    disabled: record.disabled,
    identity: record.identity,
    usage: opts.usage,
    usageStatus: status,
    lastGoodUsage: record.lastGoodUsage,
    tokenExpiresAt: record.tokenExpiresAt,
    quarantinedAt: record.quarantinedAt,
    quarantineReason: record.quarantineReason,
    addedAt: record.addedAt,
  };
}

export class AccountStore {
  readonly #vault: Vault<StoreFile>;
  readonly #deps: CoreDeps;
  #data: StoreFile | null = null;

  constructor(vault: Vault<StoreFile>, deps: CoreDeps) {
    this.#vault = vault;
    this.#deps = deps;
  }

  /** True once `load()` has succeeded; every mutator loads on demand anyway. */
  get loaded(): boolean {
    return this.#data !== null;
  }

  get activeSlot(): number | null {
    return this.#data?.activeSlot ?? null;
  }

  /**
   * Hydrate from the vault. A vault that does not exist yet is an empty
   * registry, not an error — that is a first run.
   *
   * A migration performed here is *not* written back immediately: the app must
   * be usable read-only (safe mode, an unwritable disk), so the upgraded shape
   * lands with the next real mutation.
   */
  async load(): Promise<Result<StoreFile>> {
    const now = this.#deps.now();
    const loaded = await this.#vault.load();
    if (!loaded.ok) {
      if (loaded.code === 'not-found') {
        this.#data = emptyStore(now);
        return ok(clone(this.#data));
      }
      return loaded;
    }
    const migrated = migrate(loaded.value, now);
    if (!migrated.ok) return migrated;
    this.#data = migrated.value;
    return ok(clone(migrated.value));
  }

  /** A detached copy of the whole registry. */
  snapshot(): StoreFile {
    return clone(this.#data ?? emptyStore(this.#deps.now()));
  }

  /** Slot order, so the UI and the CLI agree on what "the first one" is. */
  list(): AccountRecord[] {
    const accounts = this.#data?.accounts ?? [];
    return accounts.map((record) => clone(record)).sort((a, b) => a.slot - b.slot);
  }

  /** Resolve a slot number, an alias, or an email (both case-insensitive). */
  get(selector: AccountSelector): AccountRecord | undefined {
    const found = this.#find(this.#data?.accounts ?? [], selector);
    return found ? clone(found) : undefined;
  }

  /** The slot a new account would land in. */
  nextFreeSlot(): number {
    const taken = new Set((this.#data?.accounts ?? []).map((a) => a.slot));
    return firstFreeSlot(taken);
  }

  async upsert(input: UpsertAccountInput): Promise<Result<AccountRecord>> {
    return this.#mutate((draft) => {
      const email = input.email.trim();
      if (!email) return err('an account needs an email address', 'invalid-input');

      if (input.alias !== undefined && input.alias !== null) {
        const valid = this.#validateAlias(draft, input.alias, email);
        if (!valid.ok) return valid;
      }

      const key = normalizeEmail(email);
      const existing = draft.accounts.find((a) => normalizeEmail(a.email) === key);
      const now = this.#deps.now();

      let record: AccountRecord;
      if (existing) {
        record = existing;
        if (input.slot !== undefined && input.slot !== existing.slot) {
          const claimed = this.#claimSlot(draft, input.slot, existing, input.force === true);
          if (!claimed.ok) return claimed;
          existing.slot = input.slot;
        }
      } else {
        const slot = input.slot ?? this.#freeSlotIn(draft);
        if (!isPositiveInt(slot)) return err(`slot ${slot} is not a valid slot number`, 'invalid-input');
        const claimed = this.#claimSlot(draft, slot, null, input.force === true);
        if (!claimed.ok) return claimed;
        record = {
          slot,
          email,
          kind: input.kind ?? 'oauth',
          disabled: false,
          addedAt: input.addedAt ?? now,
        };
        draft.accounts.push(record);
      }

      // Only the fields actually supplied change; a re-capture that carries no
      // identity must not erase the identity already on file.
      record.email = email;
      if (input.kind !== undefined) record.kind = input.kind;
      if (input.disabled !== undefined) record.disabled = input.disabled;
      if (input.identity !== undefined) record.identity = input.identity;
      if (input.credentials !== undefined) record.credentials = input.credentials;
      if (input.tokenExpiresAt !== undefined) record.tokenExpiresAt = input.tokenExpiresAt;
      if (input.alias === null) delete record.alias;
      else if (input.alias !== undefined) record.alias = input.alias;

      draft.accounts.sort((a, b) => a.slot - b.slot);
      return ok(record);
    });
  }

  /** Removing leaves a hole: slot numbers are stable identifiers. */
  async remove(selector: AccountSelector): Promise<Result<void>> {
    return this.#mutate((draft) => {
      const record = this.#find(draft.accounts, selector);
      if (!record) return this.#missing(selector);
      draft.accounts = draft.accounts.filter((a) => a !== record);
      if (draft.activeSlot === record.slot) draft.activeSlot = null;
      return ok(undefined);
    });
  }

  /** Relocate to an empty slot; swap with the occupant when there is one. */
  async move(from: number, to: number): Promise<Result<AccountRecord[]>> {
    return this.#mutate((draft) => {
      if (!isPositiveInt(to)) return err(`slot ${to} is not a valid slot number`, 'invalid-input');
      const source = draft.accounts.find((a) => a.slot === from);
      if (!source) return this.#missing(from);
      if (from === to) return ok(draft.accounts.map((a) => a));

      const occupant = draft.accounts.find((a) => a.slot === to);
      const wasActive = draft.activeSlot;
      source.slot = to;
      if (occupant) occupant.slot = from;

      // The active account moved with its record, so the pointer follows it
      // rather than whatever now sits in the old slot.
      if (wasActive === from) draft.activeSlot = to;
      else if (wasActive === to && occupant) draft.activeSlot = from;

      draft.accounts.sort((a, b) => a.slot - b.slot);
      return ok(draft.accounts.map((a) => a));
    });
  }

  async setAlias(selector: AccountSelector, alias: string | null): Promise<Result<AccountRecord>> {
    return this.#mutate((draft) => {
      const record = this.#find(draft.accounts, selector);
      if (!record) return this.#missing(selector);
      if (alias === null) {
        delete record.alias;
        return ok(record);
      }
      const valid = this.#validateAlias(draft, alias, record.email);
      if (!valid.ok) return valid;
      record.alias = alias;
      return ok(record);
    });
  }

  async setDisabled(selector: AccountSelector, disabled: boolean): Promise<Result<AccountRecord>> {
    return this.#patch(selector, (record) => {
      record.disabled = disabled;
    });
  }

  /**
   * Hold an account out of every rotation. Used when the refresh token is
   * known dead: retrying it just burns a network round trip per poll, and the
   * user has to re-login before it can come back.
   */
  async quarantine(selector: AccountSelector, reason: string): Promise<Result<AccountRecord>> {
    const at = this.#deps.now();
    return this.#patch(selector, (record) => {
      record.quarantinedAt = at;
      record.quarantineReason = reason;
    });
  }

  async clearQuarantine(selector: AccountSelector): Promise<Result<AccountRecord>> {
    return this.#patch(selector, (record) => {
      delete record.quarantinedAt;
      delete record.quarantineReason;
    });
  }

  async setCredentials(
    selector: AccountSelector,
    credentials: ClaudeCredentialFile,
  ): Promise<Result<AccountRecord>> {
    return this.#patch(selector, (record) => {
      record.credentials = credentials;
      const expiresAt = credentials.claudeAiOauth?.expiresAt;
      if (typeof expiresAt === 'number') record.tokenExpiresAt = expiresAt;
    });
  }

  async setIdentity(
    selector: AccountSelector,
    identity: ClaudeAccountIdentity,
  ): Promise<Result<AccountRecord>> {
    return this.#patch(selector, (record) => {
      record.identity = { ...record.identity, ...identity };
    });
  }

  async setLastGoodUsage(
    selector: AccountSelector,
    usage: UsageSnapshot,
  ): Promise<Result<AccountRecord>> {
    return this.#patch(selector, (record) => {
      record.lastGoodUsage = usage;
    });
  }

  async setActiveSlot(slot: number | null): Promise<Result<void>> {
    return this.#mutate((draft) => {
      if (slot !== null && !draft.accounts.some((a) => a.slot === slot)) {
        return this.#missing(slot);
      }
      draft.activeSlot = slot;
      return ok(undefined);
    });
  }

  // --- internals ---------------------------------------------------------

  #missing(selector: AccountSelector): Result<never> {
    return err(`no account matches "${selector}"`, 'no-such-account');
  }

  #find(accounts: AccountRecord[], selector: AccountSelector): AccountRecord | undefined {
    if (typeof selector === 'number') return accounts.find((a) => a.slot === selector);
    const needle = selector.trim();
    if (/^\d+$/.test(needle)) {
      const slot = Number(needle);
      return accounts.find((a) => a.slot === slot);
    }
    const lower = needle.toLowerCase();
    // Alias before email: an alias is what the user typed on purpose.
    return (
      accounts.find((a) => a.alias?.toLowerCase() === lower) ??
      accounts.find((a) => normalizeEmail(a.email) === lower)
    );
  }

  #freeSlotIn(draft: StoreFile): number {
    return firstFreeSlot(new Set(draft.accounts.map((a) => a.slot)));
  }

  #validateAlias(draft: StoreFile, alias: string, ownerEmail: string): Result<void> {
    const trimmed = alias.trim();
    if (!ALIAS_PATTERN.test(trimmed)) {
      return err(
        'an alias must be 1-32 characters of letters, digits, dot, dash or underscore',
        'invalid-alias',
      );
    }
    if (/^\d+$/.test(trimmed)) {
      // Selectors accept a bare number as a slot, so a numeric alias would be
      // permanently unreachable — and might shadow a real slot.
      return err('an alias cannot be all digits; that is how slots are addressed', 'invalid-alias');
    }
    const lower = trimmed.toLowerCase();
    const ownerKey = normalizeEmail(ownerEmail);
    const clash = draft.accounts.some(
      (a) => a.alias?.toLowerCase() === lower && normalizeEmail(a.email) !== ownerKey,
    );
    if (clash) return err(`alias "${trimmed}" is already in use`, 'alias-taken');
    return ok(undefined);
  }

  /** Make `slot` available for `mover` (null when adding a new account). */
  #claimSlot(
    draft: StoreFile,
    slot: number,
    mover: AccountRecord | null,
    force: boolean,
  ): Result<void> {
    const occupant = draft.accounts.find((a) => a.slot === slot && a !== mover);
    if (!occupant) return ok(undefined);
    if (mover) {
      // A relocation swaps rather than displaces: no account silently vanishes
      // because another one wanted its number.
      occupant.slot = mover.slot;
      return ok(undefined);
    }
    if (!force) {
      return err(
        `slot ${slot} already holds ${occupant.email}; pass force to replace it`,
        'slot-taken',
      );
    }
    draft.accounts = draft.accounts.filter((a) => a !== occupant);
    if (draft.activeSlot === occupant.slot) draft.activeSlot = null;
    return ok(undefined);
  }

  async #patch(
    selector: AccountSelector,
    apply: (record: AccountRecord) => void,
  ): Promise<Result<AccountRecord>> {
    return this.#mutate((draft) => {
      const record = this.#find(draft.accounts, selector);
      if (!record) return this.#missing(selector);
      apply(record);
      return ok(record);
    });
  }

  /**
   * Apply `change` to a copy, persist it, and only then swap it in. A failed
   * save therefore leaves the caller with an error *and* an unchanged store,
   * instead of an in-memory edit that silently disappears on restart.
   */
  async #mutate<T>(change: (draft: StoreFile) => Result<T>): Promise<Result<T>> {
    if (!this.#data) {
      const loaded = await this.load();
      if (!loaded.ok) return loaded;
    }
    const draft = clone(this.#data ?? emptyStore(this.#deps.now()));
    const outcome = change(draft);
    if (!outcome.ok) return outcome;

    draft.schemaVersion = STORE_SCHEMA_VERSION;
    draft.updatedAt = this.#deps.now();
    const saved = await this.#vault.save(draft);
    if (!saved.ok) return saved;

    this.#data = draft;
    return ok(clone(outcome.value));
  }
}

/** Convenience wiring for callers that do not already hold a vault. */
export function createAccountStore(dir: string, enc: Encryptor, deps: CoreDeps): AccountStore {
  return new AccountStore(createVault<StoreFile>(dir, enc, deps), deps);
}
