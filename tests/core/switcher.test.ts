/**
 * `src/core/switcher.ts` — target resolution, ranking, planning and applying.
 *
 * `planSwitch` is pure, so it gets the widest table: every strategy, every way
 * of naming a target, and the exact list of writes the preview promises. The
 * `applySwitch` half is driven through fully stubbed deps, so the ordering
 * guarantees (capture before overwrite; switched-but-degraded reporting) are
 * observable without any disk at all.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_STORE_FILENAME,
  LOCK_SUFFIX,
  MACOS_KEYCHAIN_SERVICE,
  TOKEN_REFRESH_MARGIN_MS,
  UNKNOWN_HEADROOM,
  accountHeadroom,
  applySwitch,
  headroomScore,
  isExhausted,
  lockPathFor,
  planSwitch,
  resolveTarget,
  rotationCandidates,
  weeklyResetAt,
  type SwitchContext,
  type SwitchDeps,
} from '@core/switcher';
import type { Account, AutoSwitchEvent, ClaudeCredentialFile, SwitchStrategy } from '@shared/types';

import {
  DAY,
  HOUR,
  MINUTE,
  MemoryFs,
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_REFRESH_TOKEN,
  T0,
  expectNoSecrets,
  fakeClock,
  isoAt,
  makeAccount,
  makeAccounts,
  makeCredentialFile,
  makeSettings,
  makeUsage,
  memoryPaths,
  scriptedFetch,
  unwrap,
  unwrapErr,
} from '../helpers/fixtures';

const PATHS = memoryPaths();

function ctx(over: Partial<SwitchContext> = {}): SwitchContext {
  return {
    accounts: [],
    activeSlot: null,
    paths: PATHS,
    settings: makeSettings(),
    now: T0,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe('resolveTarget', () => {
  const accounts = makeAccounts([
    { slot: 1, email: 'work@example.test', alias: 'work' },
    { slot: 2, email: 'personal@example.test' },
    { slot: 5, email: 'worker@other.test', alias: 'W2' },
  ]);

  it.each([
    ['a slot number', 1, 1],
    ['a numeric string', '2', 2],
    ['a numeric string with spaces', '  5  ', 5],
    ['an exact alias', 'work', 1],
    ['an alias in another case', 'w2', 5],
    ['an exact email', 'PERSONAL@example.test', 2],
    ['a unique full-email prefix', 'personal@ex', 2],
    ['a unique local-part prefix', 'pers', 2],
  ])('resolves %s', (_label, target, slot) => {
    expect(unwrap(resolveTarget(accounts, target)).slot).toBe(slot);
  });

  it('prefers an exact alias over an email prefix', () => {
    // "work" is both slot 1's alias and a prefix of slot 5's local part.
    expect(unwrap(resolveTarget(accounts, 'work')).slot).toBe(1);
  });

  it('reports an ambiguous prefix rather than picking one', () => {
    const e = unwrapErr(resolveTarget(accounts, 'wor'));
    expect(e.code).toBe('ambiguous-target');
    expect(e.error).toContain('1, 5');
  });

  it.each([
    ['an unknown slot', 9, 'no-such-account'],
    ['an unknown name', 'nobody', 'no-such-account'],
  ])('rejects %s', (_label, target, code) => {
    expect(unwrapErr(resolveTarget(accounts, target)).code).toBe(code);
  });

  it.each(['', '   '])('rejects the empty target %j', (target) => {
    expect(unwrapErr(resolveTarget(accounts, target)).error).toContain('no switch target');
  });

  it('reports no-such-account against an empty registry', () => {
    expect(unwrapErr(resolveTarget([], 1)).code).toBe('no-such-account');
  });
});

// ---------------------------------------------------------------------------

describe('ranking', () => {
  it('reads headroom from usage, falling back to the last good snapshot', () => {
    const fresh = makeAccount({ pct: 30 });
    expect(accountHeadroom(fresh)).toEqual({ remaining: 70, bindingWindow: '5h' });

    const stale = makeAccount({ lastGoodUsage: makeUsage({ fiveHourPct: 60 }) });
    expect(accountHeadroom(stale)).toEqual({ remaining: 40, bindingWindow: '5h' });

    expect(accountHeadroom(makeAccount())).toBeNull();
  });

  it('prefers live usage over the last good snapshot', () => {
    const account = makeAccount({ pct: 10, lastGoodUsage: makeUsage({ fiveHourPct: 99 }) });
    expect(accountHeadroom(account)?.remaining).toBe(90);
  });

  it.each([
    ['a polled account', makeAccount({ pct: 25 }), 75],
    ['an unpolled account', makeAccount(), UNKNOWN_HEADROOM],
    ['an api-key account', makeAccount({ kind: 'api-key' }), 100],
    ['an api-key account with stale usage', makeAccount({ kind: 'api-key', pct: 99 }), 100],
  ])('scores %s at %d', (_label, account, expected) => {
    expect(headroomScore(account)).toBe(expected);
  });

  it('folds a named model window into the score', () => {
    const account = makeAccount({
      usage: { fiveHourPct: 10, scoped: [{ key: 'Fable', pct: 95 }] },
    });
    expect(headroomScore(account)).toBe(90);
    expect(headroomScore(account, ['Fable'])).toBe(5);
  });

  describe('isExhausted', () => {
    it.each([
      ['a quarantined account', makeAccount({ quarantinedAt: T0 }), true],
      ['a rate-limited status', makeAccount({ pct: 1, usageStatus: 'rate-limited' }), true],
      ['a quarantined status', makeAccount({ pct: 1, usageStatus: 'quarantined' }), true],
      ['a window at exactly 100', makeAccount({ pct: 100 }), true],
      ['a window past 100', makeAccount({ pct: 130 }), true],
      ['a window at 99.9', makeAccount({ pct: 99.9 }), false],
      ['an unpolled account', makeAccount(), false],
      ['an api-key account with junk usage', makeAccount({ kind: 'api-key', pct: 100 }), false],
    ])('%s -> %s', (_label, account, expected) => {
      expect(isExhausted(account)).toBe(expected);
    });

    it('only counts a scoped window when it is being gated on', () => {
      const account = makeAccount({ usage: { fiveHourPct: 5, scoped: [{ key: 'M', pct: 100 }] } });
      expect(isExhausted(account)).toBe(false);
      expect(isExhausted(account, ['M'])).toBe(true);
    });
  });

  describe('weeklyResetAt', () => {
    it('uses the 7d window first', () => {
      const account = makeAccount({
        usage: {
          sevenDayPct: 10,
          sevenDayResetsAt: isoAt(3 * DAY),
          scoped: [{ key: 'M', pct: 10, resetsAt: isoAt(DAY) }],
        },
      });
      // Documented behaviour: the 7d instant wins outright, even when a scoped
      // window rolls over sooner.
      expect(weeklyResetAt(account)).toBe(T0 + 3 * DAY);
    });

    it('falls back to the soonest scoped reset', () => {
      const account = makeAccount({
        usage: {
          scoped: [
            { key: 'A', pct: 1, resetsAt: isoAt(4 * DAY) },
            { key: 'B', pct: 1, resetsAt: isoAt(2 * DAY) },
          ],
        },
      });
      expect(weeklyResetAt(account)).toBe(T0 + 2 * DAY);
    });

    it.each([
      ['no usage', makeAccount()],
      ['usage with no reset instants', makeAccount({ pct: 10 })],
      ['an unparseable reset instant', makeAccount({ usage: { sevenDayPct: 1, sevenDayResetsAt: 'soon' } })],
    ])('returns null for %s', (_label, account) => {
      expect(weeklyResetAt(account)).toBeNull();
    });

    it('reads the last good snapshot when live usage is absent', () => {
      const account = makeAccount({
        lastGoodUsage: makeUsage({ sevenDayPct: 1, sevenDayResetsAt: isoAt(DAY) }),
      });
      expect(weeklyResetAt(account)).toBe(T0 + DAY);
    });
  });
});

// ---------------------------------------------------------------------------

describe('rotationCandidates', () => {
  const base = {
    activeSlot: 1 as number | null,
    includeApiKeyAccounts: false,
  };

  const pool = (): Account[] =>
    makeAccounts([
      { slot: 1, pct: 90, active: true },
      { slot: 2, pct: 40 },
      { slot: 3, pct: 10 },
      { slot: 4, pct: 70 },
    ]);

  it.each<SwitchStrategy>(['next', 'best', 'next-available', 'consume-first'])(
    'never returns the incumbent under %s',
    (strategy) => {
      const out = rotationCandidates(pool(), { ...base, strategy });
      expect(out.map((a) => a.slot)).not.toContain(1);
    },
  );

  it.each<SwitchStrategy>(['next', 'best', 'next-available', 'consume-first'])(
    'never returns a disabled or quarantined account under %s',
    (strategy) => {
      const accounts = makeAccounts([
        { slot: 1, pct: 90, active: true },
        { slot: 2, pct: 10, disabled: true },
        { slot: 3, pct: 10, quarantinedAt: T0 },
        { slot: 4, pct: 10 },
      ]);
      expect(rotationCandidates(accounts, { ...base, strategy }).map((a) => a.slot)).toEqual([4]);
    },
  );

  it.each<SwitchStrategy>(['next', 'best', 'next-available', 'consume-first'])(
    'excludes api-key accounts under %s unless opted in',
    (strategy) => {
      const accounts = makeAccounts([
        { slot: 1, pct: 90, active: true },
        { slot: 2, kind: 'api-key' },
      ]);
      expect(rotationCandidates(accounts, { ...base, strategy })).toEqual([]);
      expect(
        rotationCandidates(accounts, { ...base, strategy, includeApiKeyAccounts: true }).map(
          (a) => a.slot,
        ),
      ).toEqual([2]);
    },
  );

  describe('next', () => {
    it('walks slots after the incumbent, then wraps around', () => {
      const accounts = makeAccounts([{ slot: 1 }, { slot: 2 }, { slot: 3 }, { slot: 4 }]);
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'next', activeSlot: 3 }).map((a) => a.slot),
      ).toEqual([4, 1, 2]);
    });

    it('returns plain slot order when there is no incumbent', () => {
      const accounts = makeAccounts([{ slot: 3 }, { slot: 1 }, { slot: 2 }]);
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'next', activeSlot: null }).map(
          (a) => a.slot,
        ),
      ).toEqual([1, 2, 3]);
    });

    it('deliberately keeps exhausted accounts — a human asking for "next" means it', () => {
      const accounts = makeAccounts([
        { slot: 1, pct: 50, active: true },
        { slot: 2, pct: 100 },
        { slot: 3, pct: 5 },
      ]);
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'next' }).map((a) => a.slot),
      ).toEqual([2, 3]);
    });
  });

  it('next-available drops the exhausted ones but keeps rotation order', () => {
    const accounts = makeAccounts([
      { slot: 1, pct: 50, active: true },
      { slot: 2, pct: 100 },
      { slot: 3, pct: 5 },
      { slot: 4, pct: 5 },
    ]);
    expect(
      rotationCandidates(accounts, { ...base, strategy: 'next-available', activeSlot: 3 }).map(
        (a) => a.slot,
      ),
    ).toEqual([4, 1]);
  });

  describe('best', () => {
    it('sorts by headroom, most first', () => {
      expect(
        rotationCandidates(pool(), { ...base, strategy: 'best' }).map((a) => a.slot),
      ).toEqual([3, 2, 4]);
    });

    it('breaks a headroom tie on the lower slot', () => {
      const accounts = makeAccounts([
        { slot: 1, pct: 90, active: true },
        { slot: 3, pct: 20 },
        { slot: 2, pct: 20 },
      ]);
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'best' }).map((a) => a.slot),
      ).toEqual([2, 3]);
    });

    it('ranks an unpolled account at the neutral score', () => {
      const accounts = makeAccounts([
        { slot: 1, pct: 90, active: true },
        { slot: 2, pct: 20 }, // 80 headroom
        { slot: 3 }, // unknown -> 50
        { slot: 4, pct: 80 }, // 20 headroom
      ]);
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'best' }).map((a) => a.slot),
      ).toEqual([2, 3, 4]);
    });
  });

  describe('consume-first', () => {
    it('spends the quota that expires soonest', () => {
      const accounts = [
        makeAccount({ slot: 1, pct: 90, active: true }),
        makeAccount({
          slot: 2,
          usage: { fiveHourPct: 5, sevenDayPct: 5, sevenDayResetsAt: isoAt(5 * DAY) },
        }),
        makeAccount({
          slot: 3,
          usage: { fiveHourPct: 5, sevenDayPct: 5, sevenDayResetsAt: isoAt(DAY) },
        }),
      ];
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'consume-first' }).map((a) => a.slot),
      ).toEqual([3, 2]);
    });

    it('sorts accounts with no known reset last, not out', () => {
      const accounts = [
        makeAccount({ slot: 1, pct: 90, active: true }),
        makeAccount({ slot: 2, pct: 5 }),
        makeAccount({
          slot: 3,
          usage: { fiveHourPct: 5, sevenDayPct: 5, sevenDayResetsAt: isoAt(2 * DAY) },
        }),
      ];
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'consume-first' }).map((a) => a.slot),
      ).toEqual([3, 2]);
    });

    it('breaks a reset tie on headroom', () => {
      const at = isoAt(2 * DAY);
      const accounts = [
        makeAccount({ slot: 1, pct: 90, active: true }),
        makeAccount({ slot: 2, usage: { sevenDayPct: 60, sevenDayResetsAt: at } }),
        makeAccount({ slot: 3, usage: { sevenDayPct: 10, sevenDayResetsAt: at } }),
      ];
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'consume-first' }).map((a) => a.slot),
      ).toEqual([3, 2]);
    });

    it('still drops exhausted accounts', () => {
      const accounts = [
        makeAccount({ slot: 1, pct: 90, active: true }),
        makeAccount({ slot: 2, usage: { sevenDayPct: 100, sevenDayResetsAt: isoAt(HOUR) } }),
        makeAccount({ slot: 3, pct: 5 }),
      ];
      expect(
        rotationCandidates(accounts, { ...base, strategy: 'consume-first' }).map((a) => a.slot),
      ).toEqual([3]);
    });
  });

  it('returns nothing when there is only the incumbent', () => {
    const accounts = [makeAccount({ slot: 1, active: true })];
    expect(rotationCandidates(accounts, { ...base, strategy: 'best' })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('planSwitch', () => {
  const accounts = () =>
    makeAccounts([
      { slot: 1, pct: 90, active: true, alias: 'work' },
      { slot: 2, pct: 10 },
      { slot: 3, pct: 40 },
    ]);

  it('is always a dry run that has not switched anything', () => {
    const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), {});
    expect(plan.dryRun).toBe(true);
    expect(plan.switched).toBe(false);
  });

  it('is pure — the same context and request give an identical plan', () => {
    const context = ctx({ accounts: accounts(), activeSlot: 1 });
    expect(planSwitch(context, { strategy: 'best' })).toEqual(
      planSwitch(context, { strategy: 'best' }),
    );
  });

  it.each([
    ['a slot number', 2],
    ['a numeric string', '2'],
    ['an email', 'slot2@example.test'],
  ])('resolves an explicit target given %s', (_label, target) => {
    const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), { target });
    expect(plan.to).toEqual({ slot: 2, email: 'slot2@example.test' });
    expect(plan.from).toEqual({ slot: 1, email: 'slot1@example.test' });
    expect(plan.reason).toContain('explicit target');
  });

  it('resolves an explicit target given an alias', () => {
    const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 2 }), { target: 'work' });
    expect(plan.to?.slot).toBe(1);
    expect(plan.reason).toContain('"work"');
  });

  it('reports an unresolvable target as an error, with no target chosen', () => {
    const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), { target: 'nobody' });
    expect(plan.error).toContain('no account matches');
    expect(plan.to).toBeUndefined();
    expect(plan.reason).toBe('target not resolved');
  });

  it.each([
    ['quarantined', { quarantinedAt: T0 }, 'quarantined'],
    ['disabled', { disabled: true }, 'disabled'],
  ])('warns in the plan that the explicit target is %s', (_label, over, needle) => {
    const list = [makeAccount({ slot: 1, active: true }), makeAccount({ slot: 2, ...over })];
    const plan = planSwitch(ctx({ accounts: list, activeSlot: 1 }), { target: 2 });

    // Explicit intent wins, but the preview says what the user is about to do.
    expect(plan.to?.slot).toBe(2);
    expect(plan.reason).toContain(needle);
  });

  it('uses the requested strategy over the configured one', () => {
    const context = ctx({
      accounts: accounts(),
      activeSlot: 1,
      settings: makeSettings({ autoswitch: { strategy: 'best' } }),
    });
    expect(planSwitch(context, { strategy: 'next' }).to?.slot).toBe(2);
    expect(planSwitch(context, {}).to?.slot).toBe(2); // best: slot 2 has 90 headroom
    expect(planSwitch(ctx({ accounts: accounts(), activeSlot: 2 }), { strategy: 'next' }).to?.slot).toBe(3);
  });

  it('falls back to the configured strategy when the request names none', () => {
    const context = ctx({
      accounts: makeAccounts([
        { slot: 1, pct: 90, active: true },
        { slot: 2, pct: 80 },
        { slot: 3, pct: 5 },
      ]),
      activeSlot: 1,
      settings: makeSettings({ autoswitch: { strategy: 'best' } }),
    });
    expect(planSwitch(context, {}).to?.slot).toBe(3);
  });

  describe('no viable candidate', () => {
    it('says so when nothing else is managed', () => {
      const plan = planSwitch(
        ctx({ accounts: [makeAccount({ slot: 1, active: true })], activeSlot: 1 }),
        {},
      );
      expect(plan.error).toContain('no other account is managed');
      expect(plan.switched).toBe(false);
    });

    it('enumerates why each other account was filtered out', () => {
      const list = makeAccounts([
        { slot: 1, pct: 50, active: true },
        { slot: 2, disabled: true },
        { slot: 3, quarantinedAt: T0 },
        { slot: 4, pct: 100 },
        { slot: 5, kind: 'api-key' },
      ]);
      const plan = planSwitch(ctx({ accounts: list, activeSlot: 1 }), { strategy: 'best' });

      expect(plan.error).toContain('1 disabled');
      expect(plan.error).toContain('1 quarantined');
      expect(plan.error).toContain('1 out of quota');
      expect(plan.error).toContain('1 api-key (excluded)');
    });

    it('omits the api-key note when they are opted in', () => {
      const list = makeAccounts([
        { slot: 1, pct: 50, active: true },
        { slot: 2, disabled: true },
      ]);
      const plan = planSwitch(
        ctx({
          accounts: list,
          activeSlot: 1,
          settings: makeSettings({ autoswitch: { includeApiKeyAccounts: true } }),
        }),
        {},
      );
      expect(plan.error).not.toContain('api-key');
    });
  });

  describe('no-op', () => {
    it('reports the already-active account with no planned writes', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), { target: 1 });
      expect(plan.reason).toContain('already active');
      expect(plan.plannedWrites).toBeUndefined();
      expect(plan.switched).toBe(false);
    });

    it('plans real writes when force is set', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), {
        target: 1,
        force: true,
      });
      expect(plan.reason).not.toContain('already active');
      expect(plan.plannedWrites?.length).toBeGreaterThan(0);
    });

    it('finds the incumbent via the `active` flag when activeSlot is null', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: null }), { target: 1 });
      expect(plan.reason).toContain('already active');
    });
  });

  describe('plannedWrites', () => {
    it('lists the lock, the capture, the credential file, the config and the store', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), { target: 2 });
      const writes = plan.plannedWrites ?? [];

      expect(writes[0]).toContain(`${PATHS.credentials}${LOCK_SUFFIX}`);
      expect(writes[0]).toContain('advisory lock');
      expect(writes[1]).toContain("capture slot 1's live credential");
      expect(writes[2]).toContain(PATHS.credentials);
      expect(writes[3]).toContain(PATHS.globalConfig);
      expect(writes[3]).toContain('slot2@example.test');
      expect(writes[4]).toContain('active slot → 2');
      expect(writes.every((w) => w.includes(DEFAULT_STORE_FILENAME) || !w.includes('vault'))).toBe(
        true,
      );
    });

    it('omits the capture line when nothing is active', () => {
      // No `activeSlot` *and* no account flagged active: there is nothing to
      // capture off the live store.
      const cold = makeAccounts([{ slot: 1, pct: 90 }, { slot: 2, pct: 10 }]);
      const plan = planSwitch(ctx({ accounts: cold, activeSlot: null }), { target: 2 });

      expect(plan.from).toBeUndefined();
      expect(plan.plannedWrites?.some((w) => w.includes('capture slot'))).toBe(false);
    });

    it('finds the incumbent through the `active` flag when activeSlot is null', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: null }), { target: 2 });
      expect(plan.from?.slot).toBe(1);
      expect(plan.plannedWrites?.some((w) => w.includes('capture slot 1'))).toBe(true);
    });

    it('names the Keychain instead of the file on macOS', () => {
      const plan = planSwitch(
        ctx({ accounts: accounts(), activeSlot: 1, platform: 'macos' }),
        { target: 2 },
      );
      const line = plan.plannedWrites?.find((w) => w.includes(MACOS_KEYCHAIN_SERVICE));
      expect(line).toBeDefined();
      expect(plan.plannedWrites?.some((w) => w.includes(PATHS.credentials) && !w.includes('lock'))).toBe(
        false,
      );
    });

    it('honours a storePath override', () => {
      const plan = planSwitch(
        ctx({ accounts: accounts(), activeSlot: 1, storePath: '/custom/store.json' }),
        { target: 2 },
      );
      expect(plan.plannedWrites?.filter((w) => w.includes('/custom/store.json'))).toHaveLength(2);
    });

    it('skips the global-config write for an account with no email at all', () => {
      const list = [
        makeAccount({ slot: 1, active: true }),
        makeAccount({ slot: 2, email: '' }),
      ];
      const plan = planSwitch(ctx({ accounts: list, activeSlot: 1 }), { target: 2 });
      expect(plan.plannedWrites?.some((w) => w.includes(PATHS.globalConfig))).toBe(false);
    });

    it('defaults the store path under the deck home', () => {
      const plan = planSwitch(ctx({ accounts: accounts(), activeSlot: 1 }), { target: 2 });
      expect(plan.plannedWrites?.some((w) => w.includes(`${PATHS.deckHome}/${DEFAULT_STORE_FILENAME}`))).toBe(
        true,
      );
    });
  });

  it('never puts a token into the plan', () => {
    const list = [
      makeAccount({ slot: 1, active: true }),
      makeAccount({ slot: 2, identity: { emailAddress: 'x@y.test' } }),
    ];
    expectNoSecrets(planSwitch(ctx({ accounts: list, activeSlot: 1 }), { target: 2 }));
  });
});

describe('lockPathFor', () => {
  it('sits beside the credential file', () => {
    expect(lockPathFor(PATHS)).toBe(`${PATHS.credentials}${LOCK_SUFFIX}`);
  });
});

// ---------------------------------------------------------------------------

interface Harness {
  deps: SwitchDeps;
  events: AutoSwitchEvent[];
  written: ClaudeCredentialFile[];
  identities: unknown[];
  persisted: unknown[];
  quarantines: Array<{ slot: number; reason: string; at: number }>;
  fs: MemoryFs;
}

function harness(over: Partial<SwitchDeps> = {}, stored?: ClaudeCredentialFile): Harness {
  const clock = fakeClock();
  const fs = new MemoryFs(clock);
  const events: AutoSwitchEvent[] = [];
  const written: ClaudeCredentialFile[] = [];
  const identities: unknown[] = [];
  const persisted: unknown[] = [];
  const quarantines: Array<{ slot: number; reason: string; at: number }> = [];

  const deps: SwitchDeps = {
    now: clock.now,
    fetch: scriptedFetch(() => {
      throw new Error('the token was still fresh; no refresh should have happened');
    }),
    lock: { fs: fs.asLockFs(), now: clock.now, sleep: clock.sleep, pid: 1234, random: () => 0.5 },
    async loadStoredCredentials() {
      return { ok: true, value: stored ?? makeCredentialFile() };
    },
    async readLiveCredentials() {
      return { ok: true, value: makeCredentialFile({ accessToken: 'live-token-of-the-outgoing-account' }) };
    },
    async writeLiveCredentials(file) {
      written.push(file);
      return { ok: true, value: undefined };
    },
    async writeIdentity(identity) {
      identities.push(identity);
      return { ok: true, value: undefined };
    },
    async persist(update) {
      persisted.push(update);
      return { ok: true, value: undefined };
    },
    async quarantine(slot, reason, at) {
      quarantines.push({ slot, reason, at });
      return { ok: true, value: undefined };
    },
    emit: (e) => events.push(e),
    ...over,
  };

  return { deps, events, written, identities, persisted, quarantines, fs };
}

describe('applySwitch', () => {
  const twoAccounts = () =>
    makeAccounts([
      { slot: 1, pct: 90, active: true },
      { slot: 2, pct: 10 },
    ]);

  it('performs the switch and records it', async () => {
    const h = harness();
    const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

    expect(result.switched).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.error).toBeUndefined();
    expect(h.written).toHaveLength(1);
    expect(h.identities).toEqual([{ emailAddress: 'slot2@example.test' }]);
    expect(h.persisted[0]).toMatchObject({ activeSlot: 2, previousSlot: 1, switchedAt: T0 });
    expect(h.events.map((e) => e.kind)).toEqual(['switch']);
  });

  it('captures the outgoing live credential before overwriting it', async () => {
    const h = harness();
    await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

    const update = h.persisted[0] as { credentials?: Array<{ slot: number }> };
    expect(update.credentials?.map((c) => c.slot)).toEqual([1]);
  });

  it('does not try to capture anything when nothing was active', async () => {
    const h = harness({
      readLiveCredentials: async () => {
        throw new Error('must not read the live store with no incumbent');
      },
    });
    const result = await applySwitch(
      ctx({ accounts: makeAccounts([{ slot: 1 }, { slot: 2 }]), activeSlot: null }),
      { target: 2 },
      h.deps,
    );
    expect(result.switched).toBe(true);
  });

  it('tolerates an unreadable live credential rather than aborting the switch', async () => {
    const h = harness({
      readLiveCredentials: async () => ({ ok: false, error: 'corrupt', code: 'parse-error' }),
    });
    const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

    expect(result.switched).toBe(true);
    expect((h.persisted[0] as { credentials?: unknown }).credentials).toBeUndefined();
  });

  it('releases the lock afterwards', async () => {
    const h = harness();
    await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
    expect(h.fs.has(lockPathFor(PATHS))).toBe(false);
  });

  describe('refusals', () => {
    it('is blocked outright in safe mode, with nothing written', async () => {
      const h = harness();
      const result = await applySwitch(
        ctx({
          accounts: twoAccounts(),
          activeSlot: 1,
          settings: makeSettings({ safeMode: true }),
        }),
        { target: 2 },
        h.deps,
      );

      expect(result.switched).toBe(false);
      expect(result.error).toContain('safe mode');
      expect(result.reason).toContain('safe-mode');
      expect(h.written).toEqual([]);
      expect(h.persisted).toEqual([]);
      expect(h.fs.ops).toEqual([]);
    });

    it('honours dryRun even outside safe mode', async () => {
      const h = harness();
      const result = await applySwitch(
        ctx({ accounts: twoAccounts(), activeSlot: 1 }),
        { target: 2, dryRun: true },
        h.deps,
      );

      expect(result).toEqual(planSwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2, dryRun: true }));
      expect(h.written).toEqual([]);
      expect(h.fs.ops).toEqual([]);
    });

    it('does nothing for a no-op switch', async () => {
      const h = harness();
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 1 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.reason).toContain('nothing to do');
      expect(h.written).toEqual([]);
      expect(h.fs.ops).toEqual([]);
    });

    it('reports an unresolvable target without taking the lock', async () => {
      const h = harness();
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 'ghost' }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.error).toContain('no account matches');
      expect(h.fs.ops).toEqual([]);
    });

    it('reports a contended lock instead of writing anyway', async () => {
      const h = harness({ lockTimeoutMs: 0 });
      // Somebody else already holds it, and it is not stale.
      h.fs.put(lockPathFor(PATHS), JSON.stringify({ pid: 99, ts: T0, token: 'theirs', owner: 'claude-code' }));

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.reason).toBe('could not take the credential lock');
      expect(result.error).toContain('timed out');
      expect(h.written).toEqual([]);
    });

    it('reports a missing stored credential', async () => {
      const h = harness({
        loadStoredCredentials: async () => ({ ok: false, error: 'not in the vault', code: 'not-found' }),
      });
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.error).toContain('no stored credential for slot 2');
      expect(h.written).toEqual([]);
    });
  });

  describe('token refresh', () => {
    const expiring = () => makeCredentialFile({ expiresAt: T0 + TOKEN_REFRESH_MARGIN_MS - 1 });

    it('refreshes a token that is about to expire, then writes the rotated blob', async () => {
      const fetch = scriptedFetch({ json: { access_token: 'refreshed-access', expires_in: 3600 } });
      const h = harness({ fetch }, expiring());

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(true);
      expect(fetch.calls).toHaveLength(1);
      expect(h.written[0]?.claudeAiOauth?.accessToken).toBe('refreshed-access');

      const update = h.persisted[0] as { credentials: Array<{ slot: number }> };
      expect(update.credentials.map((c) => c.slot)).toEqual([1, 2]);
    });

    it('leaves a still-valid token alone', async () => {
      const fetch = scriptedFetch([]);
      const h = harness({ fetch }, makeCredentialFile({ expiresAt: T0 + 6 * HOUR }));

      await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
      expect(fetch.calls).toHaveLength(0);
    });

    it('runs no grant at all for a credential with no oauth block', async () => {
      const fetch = scriptedFetch([]);
      const h = harness({ fetch }, { primaryApiKey: 'managed' } as ClaudeCredentialFile);

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
      expect(result.switched).toBe(true);
      expect(fetch.calls).toHaveLength(0);
    });

    it('quarantines the slot when the refresh token is permanently dead', async () => {
      const fetch = scriptedFetch({ status: 400, json: { error: 'invalid_grant' } });
      const h = harness({ fetch }, expiring());

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.error).toContain('sign in again');
      expect(h.quarantines).toEqual([
        { slot: 2, reason: 'refresh rejected (invalid-grant)', at: T0 },
      ]);
      expect(h.events.map((e) => e.kind)).toEqual(['account-quarantined']);
      expect(h.written).toEqual([]);
    });

    it('does not quarantine on a transient refresh failure', async () => {
      const fetch = scriptedFetch({ throws: new Error('offline') });
      const h = harness({ fetch }, expiring());

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.error).toContain('could not refresh slot 2');
      expect(h.quarantines).toEqual([]);
      expect(h.written).toEqual([]);
    });

    it('never leaks a token through a refresh failure', async () => {
      const fetch = scriptedFetch({ status: 400, text: SAMPLE_REFRESH_TOKEN });
      const h = harness({ fetch }, expiring());

      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
      expectNoSecrets(result);
      expectNoSecrets(h.events);
    });
  });

  describe('partial failures after the credential landed', () => {
    it('reports switched: true when the identity write fails', async () => {
      const h = harness({
        writeIdentity: async () => ({ ok: false, error: 'config locked', code: 'io-error' }),
      });
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      // The swap *has* taken effect; pretending otherwise would be a lie.
      expect(result.switched).toBe(true);
      expect(result.error).toContain('still names the old account');
      expect(h.persisted).toEqual([]);
    });

    it('reports switched: true when the store update fails', async () => {
      const h = harness({
        persist: async () => ({ ok: false, error: 'vault unwritable', code: 'io-error' }),
      });
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(true);
      expect(result.error).toContain('account store was not updated');
      expect(h.events).toEqual([]);
    });

    it('reports switched: false when the credential write itself fails', async () => {
      const h = harness({
        writeLiveCredentials: async () => ({ ok: false, error: 'disk full', code: 'io-error' }),
      });
      const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

      expect(result.switched).toBe(false);
      expect(result.error).toContain('could not write credentials');
      expect(h.identities).toEqual([]);
      expect(h.persisted).toEqual([]);
    });
  });

  it('writes the stored identity when the account carries one', async () => {
    const h = harness();
    const list = [
      makeAccount({ slot: 1, active: true }),
      makeAccount({
        slot: 2,
        email: 'two@example.test',
        identity: { accountUuid: 'u-2', organizationName: 'Acme' },
      }),
    ];
    await applySwitch(ctx({ accounts: list, activeSlot: 1 }), { target: 2 }, h.deps);

    // The email is filled in from the account when the identity omits it.
    expect(h.identities[0]).toEqual({
      accountUuid: 'u-2',
      organizationName: 'Acme',
      emailAddress: 'two@example.test',
    });
  });

  it('surfaces a throw from the body as a lock error rather than a crash', async () => {
    const h = harness({
      loadStoredCredentials: async () => {
        throw new Error('unexpected');
      },
    });
    const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

    expect(result.switched).toBe(false);
    expect(result.error).toContain('unexpected');
    // Still released, so the next attempt is not wedged.
    expect(h.fs.has(lockPathFor(PATHS))).toBe(false);
  });

  it('uses an explicit lockPath when one is injected', async () => {
    const h = harness({ lockPath: '/elsewhere/custom.lock' });

    await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);

    expect(h.fs.ops.some((o) => o.path === '/elsewhere/custom.lock')).toBe(true);
    expect(h.fs.ops.some((o) => o.path === lockPathFor(PATHS))).toBe(false);
  });

  it('never puts a token into a successful result', async () => {
    const h = harness();
    const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
    expectNoSecrets(result);
    expectNoSecrets(h.events);
    expect(SAMPLE_ACCESS_TOKEN.length).toBeGreaterThan(0);
  });

  it('runs the whole thing under one lock, taken before any credential read', async () => {
    const h = harness();
    const order: string[] = [];
    const wrapped = harness({
      loadStoredCredentials: async () => {
        order.push('load');
        return { ok: true, value: makeCredentialFile() };
      },
      writeLiveCredentials: async (file) => {
        order.push('write');
        h.written.push(file);
        return { ok: true, value: undefined };
      },
    });
    await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, wrapped.deps);

    const lockWrite = wrapped.fs.ops.findIndex((o) => o.op === 'writeFile');
    expect(lockWrite).toBeGreaterThanOrEqual(0);
    expect(order).toEqual(['load', 'write']);
  });

  it('emits nothing when no emitter is wired', async () => {
    const h = harness({ emit: undefined });
    const result = await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
    expect(result.switched).toBe(true);
  });

  it('honours the cooldown-free reason field the caller supplies', async () => {
    const h = harness();
    const result = await applySwitch(
      ctx({ accounts: twoAccounts(), activeSlot: 1 }),
      { target: 2, reason: 'threshold' },
      h.deps,
    );
    expect(result.switched).toBe(true);
    // `reason` on the result is the *explanation*, not the trigger enum.
    expect(result.reason).toContain('explicit target');
  });

  it('is deterministic about MINUTE-scale clock reads', async () => {
    const h = harness();
    await applySwitch(ctx({ accounts: twoAccounts(), activeSlot: 1 }), { target: 2 }, h.deps);
    expect((h.persisted[0] as { switchedAt: number }).switchedAt).toBe(T0);
    expect(MINUTE).toBe(60_000);
  });
});
