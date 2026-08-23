/**
 * `src/core/store.ts` — the account registry and its schema migration.
 *
 * Two properties get the most attention. First, `migrate` must be able to
 * swallow a hand-edited or half-written vault without bricking the app, while
 * still refusing a payload from a newer build. Second, every mutation must be
 * write-then-commit: a failed save has to leave the in-memory registry exactly
 * as it was, or disk and memory disagree about what the user asked for.
 */
import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  STORE_SCHEMA_VERSION,
  createAccountStore,
  migrate,
  toAccount,
  type StoreFile,
} from '@core/store';
import { type CoreDeps } from '@core/credentials';
import { NO_ENCRYPTION, VAULT_FILENAME, createVault } from '@core/vault';
import type { UsageSnapshot } from '@shared/types';
import {
  MemoryFs,
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_REFRESH_TOKEN,
  T0,
  denyingWriteGuard,
  expectNoSecrets,
  fakeClock,
  fakeEncryptor,
  fakeVault,
  makeCredentialFile,
  makeUsage,
  unwrap,
  unwrapErr,
} from '../helpers/fixtures';

const DECK = '/deck';

function coreDeps(fs: MemoryFs, over: Partial<CoreDeps> = {}): CoreDeps {
  return { fs: fs.asFsDeps(), now: () => T0, platform: 'linux', env: {}, ...over };
}

/** A raw persisted entry. Deliberately loose: these tests feed junk to `migrate`. */
function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { slot: 1, email: 'a@example.test', kind: 'oauth', disabled: false, addedAt: T0, ...over };
}

function storeFile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: STORE_SCHEMA_VERSION,
    accounts: [],
    activeSlot: null,
    updatedAt: T0,
    ...over,
  };
}

// ===========================================================================
// migrate
// ===========================================================================
describe('migrate', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
  ])('treats %s as a fresh, empty registry', (_label, raw) => {
    expect(unwrap(migrate(raw, T0))).toEqual({
      schemaVersion: STORE_SCHEMA_VERSION,
      accounts: [],
      activeSlot: null,
      updatedAt: T0,
    });
  });

  it.each([
    ['an array', []],
    ['a string', 'nope'],
    ['a number', 7],
  ])('refuses %s outright', (_label, raw) => {
    expect(unwrapErr(migrate(raw, T0)).code).toBe('schema-invalid');
  });

  it('refuses a payload from a newer build rather than truncating it', () => {
    const e = unwrapErr(migrate(storeFile({ schemaVersion: STORE_SCHEMA_VERSION + 1 }), T0));
    expect(e.code).toBe('schema-too-new');
    expect(e.error).toContain(`v${STORE_SCHEMA_VERSION}`);
  });

  it('upgrades the unversioned v0 shape by stamping the version', () => {
    const out = unwrap(migrate({ accounts: [record()] }, T0));
    expect(out.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(out.accounts).toHaveLength(1);
  });

  it.each([
    ['a missing accounts key', {}],
    ['a non-array accounts key', { accounts: { a: 1 } }],
    ['a null accounts key', { accounts: null }],
  ])('yields no accounts for %s', (_label, raw) => {
    expect(unwrap(migrate(raw, T0)).accounts).toEqual([]);
  });

  describe('per-entry repair', () => {
    it.each([
      ['a non-object entry', 'nope'],
      ['a null entry', null],
      ['an entry with no email', { slot: 1 }],
      ['an entry with a blank email', { slot: 1, email: '   ' }],
      ['an entry with a non-string email', { slot: 1, email: 42 }],
    ])('drops %s', (_label, entry) => {
      expect(unwrap(migrate({ accounts: [entry] }, T0)).accounts).toEqual([]);
    });

    it('keeps the good entries alongside the junk ones', () => {
      const out = unwrap(
        migrate({ accounts: [null, record({ email: 'good@example.test' }), 'junk'] }, T0),
      );
      expect(out.accounts.map((a) => a.email)).toEqual(['good@example.test']);
    });

    it('drops a duplicate email, case-insensitively', () => {
      const out = unwrap(
        migrate(
          {
            accounts: [
              record({ slot: 1, email: 'Dup@Example.test' }),
              record({ slot: 2, email: 'dup@example.test', alias: 'second' }),
            ],
          },
          T0,
        ),
      );
      expect(out.accounts).toHaveLength(1);
      expect(out.accounts[0]?.email).toBe('Dup@Example.test');
    });

    it('strips a duplicate alias but keeps the account', () => {
      const out = unwrap(
        migrate(
          {
            accounts: [
              record({ slot: 1, email: 'a@x.test', alias: 'shared' }),
              record({ slot: 2, email: 'b@x.test', alias: 'SHARED' }),
            ],
          },
          T0,
        ),
      );
      expect(out.accounts).toHaveLength(2);
      expect(out.accounts[0]?.alias).toBe('shared');
      expect(out.accounts[1]?.alias).toBeUndefined();
    });

    it.each([
      ['an all-digit alias', '42'],
      ['an alias starting with a dot', '.hidden'],
      ['an alias with a space', 'my alias'],
      ['an alias that is too long', 'x'.repeat(33)],
      ['an empty alias', ''],
    ])('drops %s', (_label, alias) => {
      const out = unwrap(migrate({ accounts: [record({ alias })] }, T0));
      expect(out.accounts[0]?.alias).toBeUndefined();
    });

    it('keeps a valid alias', () => {
      const out = unwrap(migrate({ accounts: [record({ alias: 'work-2.old_x' })] }, T0));
      expect(out.accounts[0]?.alias).toBe('work-2.old_x');
    });

    it.each([
      ['an unknown kind', 'quantum'],
      ['a non-string kind', 3],
      ['a missing kind', undefined],
    ])('falls back to oauth for %s', (_label, kind) => {
      const entry = record();
      if (kind === undefined) delete entry['kind'];
      else entry['kind'] = kind;
      expect(unwrap(migrate({ accounts: [entry] }, T0)).accounts[0]?.kind).toBe('oauth');
    });

    it.each(['oauth', 'setup-token', 'api-key'])('preserves the %s kind', (kind) => {
      expect(unwrap(migrate({ accounts: [record({ kind })] }, T0)).accounts[0]?.kind).toBe(kind);
    });

    it('stamps addedAt when it is missing or the wrong type', () => {
      const entry = record();
      delete entry['addedAt'];
      expect(unwrap(migrate({ accounts: [entry] }, T0)).accounts[0]?.addedAt).toBe(T0);
      expect(
        unwrap(migrate({ accounts: [record({ addedAt: 'yesterday' })] }, T0)).accounts[0]?.addedAt,
      ).toBe(T0);
    });

    it('keeps nested credential, identity and usage blobs', () => {
      const out = unwrap(
        migrate(
          {
            accounts: [
              record({
                credentials: makeCredentialFile(),
                identity: { emailAddress: 'a@example.test' },
                lastGoodUsage: makeUsage({ fiveHourPct: 5 }),
                tokenExpiresAt: T0 + 1000,
                quarantinedAt: T0,
                quarantineReason: 'dead refresh token',
              }),
            ],
          },
          T0,
        ),
      );

      const account = out.accounts[0]!;
      expect(account.credentials?.claudeAiOauth?.accessToken).toBe(SAMPLE_ACCESS_TOKEN);
      expect(account.tokenExpiresAt).toBe(T0 + 1000);
      expect(account.quarantineReason).toBe('dead refresh token');
    });

    it('drops non-object nested blobs rather than trusting them', () => {
      const out = unwrap(
        migrate(
          { accounts: [record({ credentials: 'nope', identity: [], lastGoodUsage: 7 })] },
          T0,
        ),
      );
      expect(out.accounts[0]?.credentials).toBeUndefined();
      expect(out.accounts[0]?.identity).toBeUndefined();
      expect(out.accounts[0]?.lastGoodUsage).toBeUndefined();
    });
  });

  describe('slot repair', () => {
    it.each([
      ['a zero slot', 0],
      ['a negative slot', -3],
      ['a fractional slot', 1.5],
      ['a string slot', '2'],
      ['a missing slot', undefined],
    ])('assigns the first free slot for %s', (_label, slot) => {
      const entry = record({ email: 'needs@slot.test' });
      if (slot === undefined) delete entry['slot'];
      else entry['slot'] = slot;

      const out = unwrap(migrate({ accounts: [record({ slot: 1 }), entry] }, T0));
      expect(out.accounts.map((a) => a.slot)).toEqual([1, 2]);
    });

    it('relocates the loser of a slot collision rather than dropping it', () => {
      const out = unwrap(
        migrate(
          {
            accounts: [
              record({ slot: 3, email: 'first@x.test' }),
              record({ slot: 3, email: 'second@x.test' }),
            ],
          },
          T0,
        ),
      );
      expect(out.accounts.map((a) => [a.slot, a.email])).toEqual([
        [1, 'second@x.test'],
        [3, 'first@x.test'],
      ]);
    });

    it('preserves holes — slot numbers are stable identifiers', () => {
      const out = unwrap(
        migrate(
          { accounts: [record({ slot: 1, email: 'a@x.test' }), record({ slot: 7, email: 'b@x.test' })] },
          T0,
        ),
      );
      expect(out.accounts.map((a) => a.slot)).toEqual([1, 7]);
    });

    it('sorts by slot', () => {
      const out = unwrap(
        migrate(
          {
            accounts: [
              record({ slot: 5, email: 'e@x.test' }),
              record({ slot: 2, email: 'b@x.test' }),
              record({ slot: 9, email: 'i@x.test' }),
            ],
          },
          T0,
        ),
      );
      expect(out.accounts.map((a) => a.slot)).toEqual([2, 5, 9]);
    });
  });

  describe('activeSlot', () => {
    it('keeps a pointer to an occupied slot', () => {
      const out = unwrap(migrate({ accounts: [record({ slot: 4 })], activeSlot: 4 }, T0));
      expect(out.activeSlot).toBe(4);
    });

    it.each([
      ['an empty slot', 9],
      ['zero', 0],
      ['a string', '1'],
      ['null', null],
      ['a missing key', undefined],
    ])('clears a pointer at %s', (_label, activeSlot) => {
      const raw: Record<string, unknown> = { accounts: [record({ slot: 1 })] };
      if (activeSlot !== undefined) raw['activeSlot'] = activeSlot;
      expect(unwrap(migrate(raw, T0)).activeSlot).toBeNull();
    });
  });

  it('keeps a recorded updatedAt and stamps a missing one', () => {
    expect(unwrap(migrate(storeFile({ updatedAt: 123 }), T0)).updatedAt).toBe(123);
    expect(unwrap(migrate({ accounts: [] }, T0)).updatedAt).toBe(T0);
  });
});

// ===========================================================================
// toAccount
// ===========================================================================
describe('toAccount', () => {
  it('projects the stored fields onto the renderer type', () => {
    const usage: UsageSnapshot = makeUsage({ fiveHourPct: 12 });

    const out = toAccount(
      {
        slot: 2,
        email: 'a@example.test',
        alias: 'work',
        kind: 'oauth',
        disabled: true,
        identity: { accountUuid: 'u-1' },
        tokenExpiresAt: T0,
        addedAt: T0 - 1000,
      },
      { active: true, usage, usageStatus: 'ok' },
    );
    expect(out).toMatchObject({
      slot: 2,
      email: 'a@example.test',
      alias: 'work',
      active: true,
      disabled: true,
      usage,
      usageStatus: 'ok',
      addedAt: T0 - 1000,
    });
  });

  it.each([
    ['quarantined', { quarantinedAt: T0 }, 'quarantined'],
    ['an api-key account', { kind: 'api-key' as const }, 'no-quota'],
    ['an unpolled oauth account', {}, 'unavailable'],
  ])('defaults the status of %s to %s', (_label, over, expected) => {
    const out = toAccount(
      { slot: 1, email: 'a@x.test', kind: 'oauth', disabled: false, addedAt: T0, ...over },
      { active: false },
    );
    expect(out.usageStatus).toBe(expected);
  });

  it('lets an explicit status win over every default', () => {
    const out = toAccount(
      { slot: 1, email: 'a@x.test', kind: 'api-key', disabled: false, addedAt: T0, quarantinedAt: T0 },
      { active: false, usageStatus: 'rate-limited' },
    );
    expect(out.usageStatus).toBe('rate-limited');
  });

  it('never carries the stored credential blob into the renderer type', () => {
    const out = toAccount(
      {
        slot: 1,
        email: 'a@x.test',
        kind: 'oauth',
        disabled: false,
        addedAt: T0,
        credentials: makeCredentialFile(),
      },
      { active: true },
    );
    expectNoSecrets(out);
  });
});

// ===========================================================================
// AccountStore
// ===========================================================================
function newStore(over: Parameters<typeof fakeVault>[0] = {}): {
  store: AccountStore;
  vault: ReturnType<typeof fakeVault<StoreFile>>;
} {
  const vault = fakeVault<StoreFile>(over);

  const fs = new MemoryFs(fakeClock());
  return { store: new AccountStore(vault, coreDeps(fs)), vault };
}

describe('AccountStore.load', () => {
  it('treats a missing vault as a first run', async () => {
    const { store } = newStore();

    const out = unwrap(await store.load());
    expect(out.accounts).toEqual([]);
    expect(store.loaded).toBe(true);
    expect(store.activeSlot).toBeNull();
  });

  it('propagates a vault error that is not "not found"', async () => {
    const { store } = newStore({ loadError: { error: 'could not decrypt', code: 'decrypt-failed' } });
    expect(unwrapErr(await store.load()).code).toBe('decrypt-failed');
    expect(store.loaded).toBe(false);
  });

  it('propagates a migration refusal', async () => {
    const { store } = newStore({ initial: storeFile({ schemaVersion: 99 }) });
    expect(unwrapErr(await store.load()).code).toBe('schema-too-new');
  });

  it('does not write the migrated shape back — the app must work read-only', async () => {
    const { store, vault } = newStore({ initial: { accounts: [record()] } });
    await store.load();
    expect(vault.saves).toEqual([]);
  });

  it('returns a detached copy', async () => {
    const { store } = newStore({ initial: storeFile({ accounts: [record()] }) });

    const first = unwrap(await store.load());
    first.accounts.length = 0;
    expect(store.list()).toHaveLength(1);
  });
});

describe('AccountStore accessors', () => {
  async function seeded(): Promise<AccountStore> {
    const { store } = newStore({
      initial: storeFile({
        accounts: [
          record({ slot: 1, email: 'Work@Example.test', alias: 'work' }),
          record({ slot: 3, email: 'home@example.test' }),
        ],
        activeSlot: 3,
      }),
    });
    await store.load();
    return store;
  }

  it('lists in slot order', async () => {
    expect((await seeded()).list().map((a) => a.slot)).toEqual([1, 3]);
  });

  it.each([
    ['a slot number', 1, 1],
    ['a numeric string', '3', 3],
    ['an alias', 'WORK', 1],
    ['an email', 'work@example.TEST', 1],
    ['an email with spaces', '  home@example.test  ', 3],
  ])('resolves %s', async (_label, selector, slot) => {
    expect((await seeded()).get(selector)?.slot).toBe(slot);
  });

  it('returns undefined for an unknown selector', async () => {
    const store = await seeded();
    expect(store.get(9)).toBeUndefined();
    expect(store.get('nobody')).toBeUndefined();
  });

  it('fills the first hole when asked for a free slot', async () => {
    expect((await seeded()).nextFreeSlot()).toBe(2);
  });

  it('hands out detached copies', async () => {
    const store = await seeded();

    const got = store.get(1)!;
    got.email = 'mutated@example.test';
    expect(store.get(1)?.email).toBe('Work@Example.test');

    const snapshot = store.snapshot();
    snapshot.accounts.length = 0;
    expect(store.list()).toHaveLength(2);
  });

  it('reports the active slot from the loaded file', async () => {
    expect((await seeded()).activeSlot).toBe(3);
  });
});

describe('AccountStore.upsert', () => {
  it('adds a new account into the first free slot and persists it', async () => {
    const { store, vault } = newStore();

    const out = unwrap(await store.upsert({ email: 'a@example.test' }));
    expect(out).toMatchObject({ slot: 1, email: 'a@example.test', kind: 'oauth', disabled: false });
    expect(vault.saves).toHaveLength(1);
    expect(vault.saves[0]?.accounts).toHaveLength(1);
  });

  it('rejects an empty email', async () => {
    const { store, vault } = newStore();
    expect(unwrapErr(await store.upsert({ email: '   ' })).code).toBe('invalid-input');
    expect(vault.saves).toEqual([]);
  });

  it('updates the existing record when the email matches, case-insensitively', async () => {
    const { store } = newStore();
    await store.upsert({ email: 'A@Example.test', identity: { accountUuid: 'u-1' } });

    const out = unwrap(await store.upsert({ email: 'a@example.TEST', kind: 'api-key' }));
    expect(store.list()).toHaveLength(1);
    expect(out.kind).toBe('api-key');
    // A re-capture that carried no identity must not erase the one on file.
    expect(out.identity).toEqual({ accountUuid: 'u-1' });
  });

  it('only touches the fields it was handed', async () => {
    const { store } = newStore();
    await store.upsert({
      email: 'a@x.test',
      alias: 'work',
      credentials: makeCredentialFile(),
      tokenExpiresAt: 111,
      disabled: true,
    });

    const out = unwrap(await store.upsert({ email: 'a@x.test' }));
    expect(out).toMatchObject({ alias: 'work', tokenExpiresAt: 111, disabled: true });
    expect(out.credentials).toBeDefined();
  });

  it('clears an alias when handed null', async () => {
    const { store } = newStore();
    await store.upsert({ email: 'a@x.test', alias: 'work' });
    expect(unwrap(await store.upsert({ email: 'a@x.test', alias: null })).alias).toBeUndefined();
  });

  describe('slot claims', () => {
    it('refuses an occupied slot without force', async () => {
      const { store } = newStore();
      await store.upsert({ email: 'first@x.test', slot: 2 });

      const e = unwrapErr(await store.upsert({ email: 'second@x.test', slot: 2 }));
      expect(e.code).toBe('slot-taken');
      expect(e.error).toContain('first@x.test');
      expect(store.list()).toHaveLength(1);
    });

    it('displaces the occupant with force, and clears a stale active pointer', async () => {
      const { store } = newStore();
      await store.upsert({ email: 'first@x.test', slot: 2 });
      await store.setActiveSlot(2);
      unwrap(await store.upsert({ email: 'second@x.test', slot: 2, force: true }));
      expect(store.list().map((a) => a.email)).toEqual(['second@x.test']);
      expect(store.activeSlot).toBeNull();
    });

    it('swaps rather than displaces when an existing account moves', async () => {
      const { store } = newStore();
      await store.upsert({ email: 'a@x.test', slot: 1 });
      await store.upsert({ email: 'b@x.test', slot: 2 });
      unwrap(await store.upsert({ email: 'a@x.test', slot: 2 }));
      expect(store.list().map((a) => [a.slot, a.email])).toEqual([
        [1, 'b@x.test'],
        [2, 'a@x.test'],
      ]);
    });

    it.each([0, -1, 1.5])('rejects the invalid slot %s', async (slot) => {
      const { store } = newStore();
      expect(unwrapErr(await store.upsert({ email: 'a@x.test', slot })).code).toBe('invalid-input');
    });
  });

  describe('alias validation', () => {
    it.each([
      ['an all-digit alias', '7', 'invalid-alias'],
      ['an alias with a space', 'my alias', 'invalid-alias'],
      ['an over-long alias', 'x'.repeat(33), 'invalid-alias'],
      ['an empty alias', '', 'invalid-alias'],
    ])('rejects %s', async (_label, alias, code) => {
      const { store, vault } = newStore();
      expect(unwrapErr(await store.upsert({ email: 'a@x.test', alias })).code).toBe(code);
      expect(vault.saves).toEqual([]);
    });

    it('rejects an alias another account already uses', async () => {
      const { store } = newStore();
      await store.upsert({ email: 'a@x.test', alias: 'work' });

      const e = unwrapErr(await store.upsert({ email: 'b@x.test', alias: 'WORK' }));
      expect(e.code).toBe('alias-taken');
    });

    it('lets an account keep its own alias', async () => {
      const { store } = newStore();
      await store.upsert({ email: 'a@x.test', alias: 'work' });
      expect((await store.upsert({ email: 'a@x.test', alias: 'work' })).ok).toBe(true);
    });
  });
});

describe('AccountStore mutations', () => {
  async function withTwo(): Promise<{
    store: AccountStore;
    vault: ReturnType<typeof fakeVault<StoreFile>>;
  }> {
    const { store, vault } = newStore();
    await store.upsert({ email: 'a@x.test', slot: 1 });
    await store.upsert({ email: 'b@x.test', slot: 2 });
    return { store, vault };
  }

  it('remove leaves a hole and clears the active pointer', async () => {
    const { store } = await withTwo();
    await store.setActiveSlot(1);
    expect((await store.remove(1)).ok).toBe(true);
    expect(store.list().map((a) => a.slot)).toEqual([2]);
    expect(store.activeSlot).toBeNull();
    expect(store.nextFreeSlot()).toBe(1);
  });

  it('remove reports an unknown selector', async () => {
    const { store } = await withTwo();
    expect(unwrapErr(await store.remove(9)).code).toBe('no-such-account');
  });

  describe('move', () => {
    it('relocates into an empty slot', async () => {
      const { store } = await withTwo();
      unwrap(await store.move(2, 5));
      expect(store.list().map((a) => a.slot)).toEqual([1, 5]);
    });

    it('swaps with the occupant', async () => {
      const { store } = await withTwo();
      unwrap(await store.move(1, 2));
      expect(store.list().map((a) => [a.slot, a.email])).toEqual([
        [1, 'b@x.test'],
        [2, 'a@x.test'],
      ]);
    });

    it('carries the active pointer with the record that moved', async () => {
      const { store } = await withTwo();
      await store.setActiveSlot(1);
      await store.move(1, 2);
      expect(store.activeSlot).toBe(2);
    });

    it('carries the active pointer with the displaced occupant too', async () => {
      const { store } = await withTwo();
      await store.setActiveSlot(2);
      await store.move(1, 2);
      expect(store.activeSlot).toBe(1);
    });

    it('is a no-op when from equals to', async () => {
      const { store } = await withTwo();
      expect((await store.move(1, 1)).ok).toBe(true);
      expect(store.list().map((a) => a.slot)).toEqual([1, 2]);
    });

    it.each([
      ['an unknown source', 9, 3, 'no-such-account'],
      ['an invalid destination', 1, 0, 'invalid-input'],
    ])('rejects %s', async (_label, from, to, code) => {
      const { store } = await withTwo();
      expect(unwrapErr(await store.move(from, to)).code).toBe(code);
    });
  });

  it('setAlias sets and clears', async () => {
    const { store } = await withTwo();
    expect(unwrap(await store.setAlias(1, 'work')).alias).toBe('work');
    expect(unwrap(await store.setAlias(1, null)).alias).toBeUndefined();
  });

  it('setAlias validates and reports a clash', async () => {
    const { store } = await withTwo();
    await store.setAlias(1, 'work');
    expect(unwrapErr(await store.setAlias(2, 'work')).code).toBe('alias-taken');
    expect(unwrapErr(await store.setAlias(2, '12')).code).toBe('invalid-alias');
  });

  it('setDisabled toggles', async () => {
    const { store } = await withTwo();
    expect(unwrap(await store.setDisabled(1, true)).disabled).toBe(true);
    expect(unwrap(await store.setDisabled(1, false)).disabled).toBe(false);
  });

  it('quarantine stamps the injected clock and clearQuarantine undoes it', async () => {
    const { store } = await withTwo();

    const q = unwrap(await store.quarantine(1, 'refresh rejected'));
    expect(q).toMatchObject({ quarantinedAt: T0, quarantineReason: 'refresh rejected' });

    const cleared = unwrap(await store.clearQuarantine(1));
    expect(cleared.quarantinedAt).toBeUndefined();
    expect(cleared.quarantineReason).toBeUndefined();
  });

  it('setCredentials mirrors the expiry so the UI need not decrypt', async () => {
    const { store } = await withTwo();

    const out = unwrap(await store.setCredentials(1, makeCredentialFile({ expiresAt: 999 })));
    expect(out.tokenExpiresAt).toBe(999);
  });

  it('setCredentials leaves the expiry alone when the blob has none', async () => {
    const { store } = await withTwo();
    await store.setCredentials(1, makeCredentialFile({ expiresAt: 999 }));

    const out = unwrap(await store.setCredentials(1, { primaryApiKey: 'x' }));
    expect(out.tokenExpiresAt).toBe(999);
  });

  it('setIdentity merges rather than replaces', async () => {
    const { store } = await withTwo();
    await store.setIdentity(1, { accountUuid: 'u-1', organizationName: 'Acme' });

    const out = unwrap(await store.setIdentity(1, { emailAddress: 'a@x.test' }));
    expect(out.identity).toEqual({
      accountUuid: 'u-1',
      organizationName: 'Acme',
      emailAddress: 'a@x.test',
    });
  });

  it('setLastGoodUsage stores the snapshot', async () => {
    const { store } = await withTwo();

    const usage = makeUsage({ fiveHourPct: 33 });
    expect(unwrap(await store.setLastGoodUsage(1, usage)).lastGoodUsage).toEqual(usage);
  });

  it('setActiveSlot accepts null and rejects an empty slot', async () => {
    const { store } = await withTwo();
    expect((await store.setActiveSlot(2)).ok).toBe(true);
    expect(store.activeSlot).toBe(2);
    expect((await store.setActiveSlot(null)).ok).toBe(true);
    expect(store.activeSlot).toBeNull();
    expect(unwrapErr(await store.setActiveSlot(9)).code).toBe('no-such-account');
  });

  it.each([
    ['setAlias', (s: AccountStore) => s.setAlias(9, 'x')],
    ['setDisabled', (s: AccountStore) => s.setDisabled(9, true)],
    ['quarantine', (s: AccountStore) => s.quarantine(9, 'x')],
    ['clearQuarantine', (s: AccountStore) => s.clearQuarantine(9)],
    ['setCredentials', (s: AccountStore) => s.setCredentials(9, {})],
    ['setIdentity', (s: AccountStore) => s.setIdentity(9, {})],
    ['setLastGoodUsage', (s: AccountStore) => s.setLastGoodUsage(9, makeUsage())],
  ])('%s reports an unknown selector', async (_label, run) => {
    const { store } = await withTwo();
    expect(unwrapErr(await run(store)).code).toBe('no-such-account');
  });

  it('loads on demand when a mutator is called first', async () => {
    const { store } = newStore({ initial: storeFile({ accounts: [record()] }) });
    expect(store.loaded).toBe(false);
    unwrap(await store.setDisabled(1, true));
    expect(store.loaded).toBe(true);
  });

  it('stamps updatedAt and the current schema version on every save', async () => {
    const { store, vault } = await withTwo();
    expect(vault.saves.at(-1)).toMatchObject({
      schemaVersion: STORE_SCHEMA_VERSION,
      updatedAt: T0,
    });
  });
});

describe('write-then-commit', () => {
  it('leaves the in-memory registry untouched when the save fails', async () => {
    const { store, vault } = newStore();
    await store.upsert({ email: 'a@x.test' });

    const before = store.snapshot();
    vault.saveError = { ok: false, error: 'disk full', code: 'io-error' };

    const failed = await store.upsert({ email: 'b@x.test' });
    expect(unwrapErr(failed).code).toBe('io-error');
    expect(store.snapshot()).toEqual(before);
    expect(store.list().map((a) => a.email)).toEqual(['a@x.test']);
  });

  it.each([
    ['remove', (s: AccountStore) => s.remove(1)],
    ['setDisabled', (s: AccountStore) => s.setDisabled(1, true)],
    ['move', (s: AccountStore) => s.move(1, 4)],
    ['setActiveSlot', (s: AccountStore) => s.setActiveSlot(1)],
  ])('rolls %s back on a failed save', async (_label, run) => {
    const { store, vault } = newStore();
    await store.upsert({ email: 'a@x.test', slot: 1 });

    const before = store.snapshot();
    vault.saveError = { ok: false, error: 'disk full', code: 'io-error' };
    expect((await run(store)).ok).toBe(false);
    expect(store.snapshot()).toEqual(before);
  });

  it('does not save at all when the change itself is rejected', async () => {
    const { store, vault } = newStore();
    await store.upsert({ email: 'a@x.test' });

    const saves = vault.saves.length;
    await store.upsert({ email: '' });
    await store.setAlias(9, 'x');
    await store.move(9, 1);
    expect(vault.saves).toHaveLength(saves);
  });
});

// ===========================================================================
// Wired to a real vault
// ===========================================================================
describe('createAccountStore against a real vault', () => {
  it('round-trips through an encrypted vault, and the token is not readable on disk', async () => {
    const fs = new MemoryFs(fakeClock());

    const enc = fakeEncryptor();

    const store = createAccountStore(DECK, enc, coreDeps(fs));
    await store.upsert({ email: 'a@example.test', credentials: makeCredentialFile() });

    const onDisk = fs.read(`${DECK}/${VAULT_FILENAME}`) ?? '';
    expect(onDisk).toContain('"plaintext": false');
    expectNoSecrets(onDisk, [SAMPLE_ACCESS_TOKEN, SAMPLE_REFRESH_TOKEN]);
    // A fresh store reading the same vault sees the same account.
    const reloaded = createAccountStore(DECK, enc, coreDeps(fs));
    unwrap(await reloaded.load());
    expect(reloaded.get('a@example.test')?.credentials?.claudeAiOauth?.accessToken).toBe(
      SAMPLE_ACCESS_TOKEN,
    );
  });

  it('marks the fallback plaintext honestly when there is no secret service', async () => {
    const fs = new MemoryFs(fakeClock());

    const store = createAccountStore(DECK, NO_ENCRYPTION, coreDeps(fs));
    await store.upsert({ email: 'a@example.test', credentials: makeCredentialFile() });

    const onDisk = fs.read(`${DECK}/${VAULT_FILENAME}`) ?? '';
    expect(onDisk).toContain('"plaintext": true');
    // The file *is* readable — that is exactly what the marker warns about.
    expect(onDisk).toContain(SAMPLE_ACCESS_TOKEN);
  });

  it('refuses every save in safe mode and leaves the vault untouched', async () => {
    const fs = new MemoryFs(fakeClock());

    const enc = fakeEncryptor();

    const seed = createAccountStore(DECK, enc, coreDeps(fs));
    await seed.upsert({ email: 'a@example.test' });

    const before = fs.snapshot();

    const guard = denyingWriteGuard();

    const guarded = createAccountStore(DECK, enc, coreDeps(fs, { writeGuard: guard }));
    unwrap(await guarded.load());

    const result = await guarded.upsert({ email: 'b@example.test' });
    expect(result.ok).toBe(false);
    // `createVault` joins with `node:path`, so the separator is host-shaped.
    expect(guard.targets.map((t) => t.replace(/\\/g, '/'))).toEqual([
      `${DECK}/${VAULT_FILENAME}`,
    ]);
    expect(fs.snapshot()).toEqual(before);
    // Refused on disk *and* refused in memory.
    expect(guarded.list().map((a) => a.email)).toEqual(['a@example.test']);
  });

  it('reports an undecryptable vault instead of clearing it', async () => {
    const fs = new MemoryFs(fakeClock());
    await createAccountStore(DECK, fakeEncryptor(), coreDeps(fs)).upsert({ email: 'a@x.test' });

    const before = fs.snapshot();

    const broken = createAccountStore(DECK, fakeEncryptor({ failDecrypt: true }), coreDeps(fs));
    expect(unwrapErr(await broken.load()).code).toBe('decrypt-failed');
    expect(fs.snapshot()).toEqual(before);
  });

  it('reports a corrupt vault file as a parse error', async () => {
    const fs = new MemoryFs(fakeClock());
    fs.put(`${DECK}/${VAULT_FILENAME}`, '{ not json');

    const store = createAccountStore(DECK, fakeEncryptor(), coreDeps(fs));
    expect(unwrapErr(await store.load()).code).toBe('parse-error');
  });

  it('writes the vault atomically', async () => {
    const fs = new MemoryFs(fakeClock());

    const store = createAccountStore(DECK, fakeEncryptor(), coreDeps(fs));
    await store.upsert({ email: 'a@x.test' });

    const write = fs.ops.find((o) => o.op === 'writeFile');
    expect(write?.path.endsWith('.tmp')).toBe(true);
    expect(fs.ops.some((o) => o.op === 'rename')).toBe(true);
    expect(fs.tempFiles()).toEqual([]);
  });

  it('leaves the previous vault intact when the write fails', async () => {
    const fs = new MemoryFs(fakeClock());

    const store = createAccountStore(DECK, fakeEncryptor(), coreDeps(fs));
    await store.upsert({ email: 'a@x.test' });

    const before = fs.snapshot();
    fs.fail('rename', { code: 'EXDEV', times: 5 });
    expect((await store.upsert({ email: 'b@x.test' })).ok).toBe(false);
    expect(fs.snapshot()).toEqual(before);
    expect(store.list().map((a) => a.email)).toEqual(['a@x.test']);
  });
});
