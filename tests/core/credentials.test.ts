/**
 * `src/core/credentials.ts` — Claude Code's own credential store, plus the
 * shared atomic-write / JSON-read helpers the rest of core is built on.
 *
 * Three invariants get the most attention here, because they are the ones that
 * lose a user's login when they regress:
 *   1. `safeMode` (the injected `writeGuard`) blocks every write path.
 *   2. Writes are atomic — temp file, then rename — and a failure leaves the
 *      original file byte-for-byte intact.
 *   3. A merge never drops top-level keys we do not model.
 */

import { describe, expect, it } from 'vitest';

import {
  atomicWriteText,
  credentialKindFromFile,
  defaultDeps,
  detectCredentialKind,
  isRecord,
  keychainAccountName,
  parseJsonObject,
  readAccountIdentity,
  readClaudeCredentials,
  readJsonObject,
  writeAccountIdentity,
  writeClaudeCredentials,
  type CoreDeps,
} from '@core/credentials';
import type { ClaudeCredentialFile, CredentialKind } from '@shared/types';

import {
  MemoryFs,
  SAMPLE_ACCESS_TOKEN,
  SAMPLE_API_KEY,
  SAMPLE_REFRESH_TOKEN,
  SAMPLE_SETUP_TOKEN,
  denyingWriteGuard,
  expectNoSecrets,
  fakeClock,
  makeCredentialFile,
  memoryPaths,
  scriptedRun,
  unwrap,
  unwrapErr,
} from '../helpers/fixtures';

function setup(over: Partial<CoreDeps> = {}): { fs: MemoryFs; deps: CoreDeps } {
  const clock = fakeClock();
  const fs = new MemoryFs(clock);
  const deps: CoreDeps = { fs: fs.asFsDeps(), now: clock.now, platform: 'linux', env: {}, ...over };
  return { fs, deps };
}

// ---------------------------------------------------------------------------

describe('isRecord', () => {
  it.each([
    [{}, true],
    [{ a: 1 }, true],
    [[], false],
    [null, false],
    ['str', false],
    [42, false],
    [undefined, false],
  ])('%o -> %s', (value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('parseJsonObject', () => {
  it('accepts an object', () => {
    expect(unwrap(parseJsonObject('{"a":1}', 'label'))).toEqual({ a: 1 });
  });

  it.each([
    ['an array', '[]'],
    ['a scalar', '7'],
    ['a string', '"hello"'],
    ['null', 'null'],
  ])('rejects %s with parse-error', (_label, text) => {
    expect(unwrapErr(parseJsonObject(text, 'label')).code).toBe('parse-error');
  });

  it('rejects invalid JSON and names the label, not the body', () => {
    const e = unwrapErr(parseJsonObject(`{"accessToken": "${SAMPLE_ACCESS_TOKEN}"`, 'creds.json'));
    expect(e.code).toBe('parse-error');
    expect(e.error).toContain('creds.json');
    expectNoSecrets(e.error);
  });
});

describe('readJsonObject', () => {
  it('reads an object off the fake fs', async () => {
    const { fs, deps } = setup();
    fs.putJson('/a/b.json', { hello: 'world' });
    expect(unwrap(await readJsonObject('/a/b.json', deps))).toEqual({ hello: 'world' });
  });

  it('distinguishes a missing file from an unreadable one', async () => {
    const { fs, deps } = setup();
    expect(unwrapErr(await readJsonObject('/nope.json', deps)).code).toBe('not-found');

    fs.put('/broken.json', '{ oops');
    expect(unwrapErr(await readJsonObject('/broken.json', deps)).code).toBe('parse-error');

    fs.put('/eio.json', '{}');
    fs.fail('readFile', { match: '/eio.json', code: 'EIO' });
    expect(unwrapErr(await readJsonObject('/eio.json', deps)).code).toBe('io-error');
  });
});

// ---------------------------------------------------------------------------

describe('atomicWriteText', () => {
  it('writes to a temp file in the same directory, then renames', async () => {
    const { fs, deps } = setup();
    expect(unwrap(await atomicWriteText('/dir/file.json', 'body', deps))).toBeUndefined();

    expect(fs.read('/dir/file.json')).toBe('body');
    expect(fs.tempFiles()).toEqual([]);

    const write = fs.ops.find((o) => o.op === 'writeFile');
    const rename = fs.ops.find((o) => o.op === 'rename');
    expect(write?.path).toMatch(/^\/dir\/file\.json\..*\.tmp$/);
    expect(rename?.path).toBe(write?.path);
    expect(rename?.detail).toBe('/dir/file.json');
    // Order matters: the rename must be the last thing that happens.
    expect(fs.opNames().indexOf('writeFile')).toBeLessThan(fs.opNames().indexOf('rename'));
  });

  it('creates the parent directory first', async () => {
    const { fs, deps } = setup();
    await atomicWriteText('/deep/nested/dir/f.json', '{}', deps);
    expect(fs.opNames()[0]).toBe('mkdir');
    expect(fs.read('/deep/nested/dir/f.json')).toBe('{}');
  });

  it('refuses every write when the guard says safe mode is on', async () => {
    const guard = denyingWriteGuard();
    const { fs, deps } = setup({ writeGuard: guard });
    fs.put('/dir/file.json', 'original');
    fs.clearOps();

    const result = await atomicWriteText('/dir/file.json', 'replacement', deps);

    expect(result.ok).toBe(false);
    expect(guard.targets).toEqual(['/dir/file.json']);
    expect(fs.read('/dir/file.json')).toBe('original');
    // Not one syscall: the guard is checked before anything is attempted.
    expect(fs.ops).toEqual([]);
  });

  it('leaves the original intact and cleans up when the temp write fails', async () => {
    const { fs, deps } = setup();
    fs.put('/dir/file.json', 'original');
    const before = fs.snapshot();
    fs.fail('writeFile', { code: 'ENOSPC', message: 'no space left' });

    const e = unwrapErr(await atomicWriteText('/dir/file.json', 'replacement', deps));

    expect(e.code).toBe('io-error');
    expect(e.error).toContain('/dir/file.json');
    expect(fs.snapshot()).toEqual(before);
    expect(fs.tempFiles()).toEqual([]);
  });

  it('leaves the original intact and removes the temp when the rename fails', async () => {
    const { fs, deps } = setup();
    fs.put('/dir/file.json', 'original');
    const before = fs.snapshot();
    // Not one of the transient codes, so there is no retry to muddy the result.
    fs.fail('rename', { code: 'EXDEV', times: 5 });

    expect(unwrapErr(await atomicWriteText('/dir/file.json', 'new', deps)).code).toBe('io-error');
    expect(fs.snapshot()).toEqual(before);
    expect(fs.tempFiles()).toEqual([]);
  });

  it.each(['EPERM', 'EACCES', 'EBUSY'])('retries a transient %s rename', async (code) => {
    const { fs, deps } = setup();
    fs.fail('rename', { code, times: 2 });

    expect((await atomicWriteText('/dir/file.json', 'body', deps)).ok).toBe(true);
    expect(fs.read('/dir/file.json')).toBe('body');
    expect(fs.ops.filter((o) => o.op === 'rename')).toHaveLength(3);
  });

  it('gives up after three transient renames', async () => {
    const { fs, deps } = setup();
    fs.put('/dir/file.json', 'original');
    fs.fail('rename', { code: 'EBUSY', times: 99 });

    expect(unwrapErr(await atomicWriteText('/dir/file.json', 'new', deps)).code).toBe('io-error');
    expect(fs.read('/dir/file.json')).toBe('original');
    expect(fs.ops.filter((o) => o.op === 'rename')).toHaveLength(3);
  });

  it('uses distinct temp names for concurrent writes to the same target', async () => {
    const { fs, deps } = setup();
    await Promise.all([
      atomicWriteText('/dir/a.json', '1', deps),
      atomicWriteText('/dir/a.json', '2', deps),
    ]);
    const temps = fs.ops.filter((o) => o.op === 'writeFile').map((o) => o.path);
    expect(new Set(temps).size).toBe(temps.length);
  });

  it('never puts the payload into the error message', async () => {
    const { fs, deps } = setup();
    fs.fail('writeFile', { code: 'EIO' });
    const e = unwrapErr(
      await atomicWriteText('/dir/creds.json', JSON.stringify(makeCredentialFile()), deps),
    );
    expectNoSecrets(e.error);
  });
});

// ---------------------------------------------------------------------------

describe('detectCredentialKind', () => {
  const cases: Array<[string, CredentialKind]> = [
    [SAMPLE_API_KEY, 'api-key'],
    ['sk-ant-api03-anything', 'api-key'],
    ['  SK-ANT-API03-UPPER  ', 'api-key'],
    [SAMPLE_SETUP_TOKEN, 'setup-token'],
    ['sk-ant-oat01-x', 'setup-token'],
    ['SK-ANT-OAT01-X', 'setup-token'],
    ['sk-ant-ort01-refresh', 'oauth'],
    ['', 'oauth'],
    ['not-a-key', 'oauth'],
  ];

  it.each(cases)('%s -> %s', (token, expected) => {
    expect(detectCredentialKind(token)).toBe(expected);
  });
});

describe('credentialKindFromFile', () => {
  it('treats a blob with a refresh token as an interactive oauth login', () => {
    expect(credentialKindFromFile(makeCredentialFile())).toBe('oauth');
  });

  it('treats a bare setup token as setup-token', () => {
    const file = makeCredentialFile({ accessToken: SAMPLE_SETUP_TOKEN, refreshToken: null });
    expect(credentialKindFromFile(file)).toBe('setup-token');
  });

  it('treats a bare managed key as api-key', () => {
    const file = makeCredentialFile({ accessToken: SAMPLE_API_KEY, refreshToken: null });
    expect(credentialKindFromFile(file)).toBe('api-key');
  });

  it('ignores an empty refresh token when classifying', () => {
    const file = makeCredentialFile({ accessToken: SAMPLE_API_KEY, refreshToken: '' });
    expect(credentialKindFromFile(file)).toBe('api-key');
  });

  it.each([
    ['no oauth block', {}],
    ['a non-string access token', { claudeAiOauth: { accessToken: 42 } }],
  ])('defaults to oauth for %s', (_label, file) => {
    expect(credentialKindFromFile(file as ClaudeCredentialFile)).toBe('oauth');
  });
});

describe('keychainAccountName', () => {
  it.each([
    [{ USER: 'alice', LOGNAME: 'bob', USERNAME: 'carol' }, 'alice'],
    [{ LOGNAME: 'bob', USERNAME: 'carol' }, 'bob'],
    [{ USERNAME: 'carol' }, 'carol'],
    [{}, 'claude-code-user'],
    [{ USER: '' }, 'claude-code-user'],
  ])('%o -> %s', (env, expected) => {
    const { deps } = setup({ env });
    expect(keychainAccountName(deps)).toBe(expected);
  });

  it('falls back when no env view is injected at all', () => {
    const deps = { fs: new MemoryFs().asFsDeps(), now: () => 0 } as CoreDeps;
    expect(keychainAccountName(deps)).toBe('claude-code-user');
  });
});

// ---------------------------------------------------------------------------

describe('readClaudeCredentials', () => {
  const paths = memoryPaths();

  it('reads the file on a non-macOS host', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.credentials, makeCredentialFile());

    const file = unwrap(await readClaudeCredentials(paths, deps));
    expect(file.claudeAiOauth?.accessToken).toBe(SAMPLE_ACCESS_TOKEN);
  });

  it('returns an empty object for an empty credentials file', async () => {
    const { fs, deps } = setup();
    fs.put(paths.credentials, '{}');
    expect(unwrap(await readClaudeCredentials(paths, deps))).toEqual({});
  });

  it('propagates not-found for a missing file', async () => {
    const { deps } = setup();
    expect(unwrapErr(await readClaudeCredentials(paths, deps)).code).toBe('not-found');
  });

  it('propagates parse-error for a corrupt file without echoing it', async () => {
    const { fs, deps } = setup();
    fs.put(paths.credentials, `{"claudeAiOauth":{"accessToken":"${SAMPLE_ACCESS_TOKEN}"`);

    const e = unwrapErr(await readClaudeCredentials(paths, deps));
    expect(e.code).toBe('parse-error');
    expectNoSecrets(e.error);
  });

  it('prefers the Keychain on macOS and strips the single trailing newline', async () => {
    const run = scriptedRun(({ args }) =>
      args[0] === 'find-generic-password'
        ? { code: 0, stdout: `${JSON.stringify(makeCredentialFile())}\n` }
        : { code: 0 },
    );
    const { fs, deps } = setup({ platform: 'macos', run, env: { USER: 'tester' } });
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'from-the-file' } });

    const file = unwrap(await readClaudeCredentials(paths, deps));
    expect(file.claudeAiOauth?.accessToken).toBe(SAMPLE_ACCESS_TOKEN);
    expect(run.calls[0]?.args).toEqual([
      'find-generic-password',
      '-a',
      'tester',
      '-w',
      '-s',
      'Claude Code-credentials',
    ]);
  });

  it('falls back to the file when the Keychain item is absent (code 44)', async () => {
    const run = scriptedRun(() => ({ code: 44 }));
    const { fs, deps } = setup({ platform: 'macos', run });
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'from-the-file' } });

    expect(unwrap(await readClaudeCredentials(paths, deps)).claudeAiOauth?.accessToken).toBe(
      'from-the-file',
    );
  });

  it('falls back to the file when the Keychain item is not JSON', async () => {
    const run = scriptedRun(() => ({ code: 0, stdout: 'not json at all\n' }));
    const { fs, deps } = setup({ platform: 'macos', run });
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'from-the-file' } });

    expect(unwrap(await readClaudeCredentials(paths, deps)).claudeAiOauth?.accessToken).toBe(
      'from-the-file',
    );
  });

  it.each([
    ['a non-zero, non-44 exit', scriptedRun(() => ({ code: 1, stderr: 'keychain is locked' }))],
    [
      'a runner that throws',
      scriptedRun(() => {
        throw new Error('security binary missing');
      }),
    ],
  ])('falls back to the file when the Keychain read fails with %s', async (_label, run) => {
    const { fs, deps } = setup({ platform: 'macos', run });
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'from-the-file' } });

    expect(unwrap(await readClaudeCredentials(paths, deps)).claudeAiOauth?.accessToken).toBe(
      'from-the-file',
    );
  });

  it('does not shell out on macOS when no runner is injected', async () => {
    const { fs, deps } = setup({ platform: 'macos', run: undefined });
    fs.putJson(paths.credentials, makeCredentialFile());
    expect((await readClaudeCredentials(paths, deps)).ok).toBe(true);
  });
});

describe('writeClaudeCredentials', () => {
  const paths = memoryPaths();

  it('merges rather than replaces, keeping keys we do not model', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.credentials, {
      claudeAiOauth: { accessToken: 'old' },
      mcpOAuth: { server: 'kept' },
      deviceId: 'kept-too',
    });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);

    const written = JSON.parse(fs.read(paths.credentials) ?? '{}') as Record<string, unknown>;
    expect(written['mcpOAuth']).toEqual({ server: 'kept' });
    expect(written['deviceId']).toBe('kept-too');
    expect((written['claudeAiOauth'] as { accessToken: string }).accessToken).toBe(
      SAMPLE_ACCESS_TOKEN,
    );
  });

  it('replaces a corrupt store rather than refusing (the blob *is* the login)', async () => {
    const { fs, deps } = setup();
    fs.put(paths.credentials, 'not json');

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    const written = JSON.parse(fs.read(paths.credentials) ?? '{}') as ClaudeCredentialFile;
    expect(written.claudeAiOauth?.accessToken).toBe(SAMPLE_ACCESS_TOKEN);
  });

  it('creates the file when there is nothing there yet', async () => {
    const { fs, deps } = setup();
    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    expect(fs.has(paths.credentials)).toBe(true);
  });

  it('is refused in safe mode, before any read or write', async () => {
    const guard = denyingWriteGuard();
    const { fs, deps } = setup({ writeGuard: guard });
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'original' } });
    fs.clearOps();

    const result = await writeClaudeCredentials(paths, makeCredentialFile(), deps);

    expect(result.ok).toBe(false);
    expect(guard.targets).toEqual([paths.credentials]);
    expect(fs.ops).toEqual([]);
    expect(JSON.parse(fs.read(paths.credentials) ?? '{}')).toEqual({
      claudeAiOauth: { accessToken: 'original' },
    });
  });

  it('writes atomically', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.credentials, {});
    fs.clearOps();

    await writeClaudeCredentials(paths, makeCredentialFile(), deps);
    const writes = fs.ops.filter((o) => o.op === 'writeFile');
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path.endsWith('.tmp')).toBe(true);
    expect(fs.ops.some((o) => o.op === 'rename')).toBe(true);
  });

  it('leaves the previous credentials intact when the write fails', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.credentials, { claudeAiOauth: { accessToken: 'original' } });
    const before = fs.snapshot();
    fs.fail('writeFile', { code: 'EACCES', times: 5 });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(false);
    expect(fs.snapshot()).toEqual(before);
  });

  it('writes the Keychain item and skips the file on macOS', async () => {
    const run = scriptedRun(({ args }) => (args[0] === 'find-generic-password' ? { code: 44 } : { code: 0 }));
    const { fs, deps } = setup({ platform: 'macos', run, env: { USER: 'tester' } });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    expect(fs.has(paths.credentials)).toBe(false);

    const add = run.calls.find((c) => c.args[0] === 'add-generic-password');
    expect(add?.args).toContain('-X');
    // The blob rides in as hex, so a plaintext scan of the process table finds
    // nothing.
    expectNoSecrets(add?.args.join(' ') ?? '');
  });

  it('falls back to the file when the Keychain runner throws outright', async () => {
    const run = scriptedRun(({ args }) => {
      if (args[0] === 'add-generic-password') throw new Error('security binary missing');
      return { code: 44 };
    });
    const { fs, deps } = setup({ platform: 'macos', run });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    expect(fs.has(paths.credentials)).toBe(true);
  });

  it('reports the failure when both the Keychain and the file are unwritable', async () => {
    const run = scriptedRun(({ args }) =>
      args[0] === 'find-generic-password' ? { code: 44 } : { code: 1, stderr: 'locked' },
    );
    const { fs, deps } = setup({ platform: 'macos', run });
    fs.fail('writeFile', { code: 'EROFS', times: 5 });

    const e = unwrapErr(await writeClaudeCredentials(paths, makeCredentialFile(), deps));
    expect(e.code).toBe('io-error');
    expectNoSecrets(e.error);
  });

  it('tolerates a Keychain delete that throws after the file write succeeded', async () => {
    const run = scriptedRun(({ args }) => {
      if (args[0] === 'find-generic-password') return { code: 44 };
      if (args[0] === 'add-generic-password') return { code: 1, stderr: 'locked' };
      throw new Error('delete blew up');
    });
    const { fs, deps } = setup({ platform: 'macos', run });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    expect(fs.has(paths.credentials)).toBe(true);
  });

  it('falls back to the file and clears the stale Keychain item when the Keychain write fails', async () => {
    const run = scriptedRun(({ args }) => {
      if (args[0] === 'find-generic-password') return { code: 44 };
      if (args[0] === 'add-generic-password') return { code: 1, stderr: 'keychain locked' };
      return { code: 0 };
    });
    const { fs, deps } = setup({ platform: 'macos', run });

    expect((await writeClaudeCredentials(paths, makeCredentialFile(), deps)).ok).toBe(true);
    expect(fs.has(paths.credentials)).toBe(true);
    expect(run.calls.some((c) => c.args[0] === 'delete-generic-password')).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('readAccountIdentity', () => {
  const paths = memoryPaths();

  it('picks only the identity fields, and only non-empty strings', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.globalConfig, {
      projects: { '/x': {} },
      oauthAccount: {
        emailAddress: 'a@example.test',
        accountUuid: 'u-1',
        organizationUuid: '',
        organizationName: 'Acme',
        displayName: 'A',
        somethingElse: 'ignored',
      },
    });

    expect(unwrap(await readAccountIdentity(paths, deps))).toEqual({
      emailAddress: 'a@example.test',
      accountUuid: 'u-1',
      organizationName: 'Acme',
      displayName: 'A',
    });
  });

  it('reports no-identity when oauthAccount is absent or not an object', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.globalConfig, { projects: {} });
    expect(unwrapErr(await readAccountIdentity(paths, deps)).code).toBe('no-identity');

    fs.putJson(paths.globalConfig, { oauthAccount: ['nope'] });
    expect(unwrapErr(await readAccountIdentity(paths, deps)).code).toBe('no-identity');
  });

  it('propagates not-found', async () => {
    const { deps } = setup();
    expect(unwrapErr(await readAccountIdentity(paths, deps)).code).toBe('not-found');
  });
});

describe('writeAccountIdentity', () => {
  const paths = memoryPaths();

  it('merges into the existing config without disturbing anything else', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.globalConfig, {
      projects: { '/work': { allowed: true } },
      numStartups: 12,
      oauthAccount: { accountUuid: 'u-1', organizationName: 'Acme' },
    });

    expect((await writeAccountIdentity(paths, { emailAddress: 'b@example.test' }, deps)).ok).toBe(
      true,
    );

    const after = JSON.parse(fs.read(paths.globalConfig) ?? '{}') as Record<string, unknown>;
    expect(after['projects']).toEqual({ '/work': { allowed: true } });
    expect(after['numStartups']).toBe(12);
    expect(after['oauthAccount']).toEqual({
      accountUuid: 'u-1',
      organizationName: 'Acme',
      emailAddress: 'b@example.test',
    });
  });

  it('never deletes a known field by passing undefined', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.globalConfig, { oauthAccount: { emailAddress: 'keep@example.test' } });

    await writeAccountIdentity(paths, { accountUuid: 'u-9' }, deps);

    const after = JSON.parse(fs.read(paths.globalConfig) ?? '{}') as {
      oauthAccount: Record<string, unknown>;
    };
    expect(after.oauthAccount['emailAddress']).toBe('keep@example.test');
    expect(after.oauthAccount['accountUuid']).toBe('u-9');
  });

  it('creates the config when it does not exist', async () => {
    const { fs, deps } = setup();
    expect((await writeAccountIdentity(paths, { emailAddress: 'a@b.test' }, deps)).ok).toBe(true);
    expect(JSON.parse(fs.read(paths.globalConfig) ?? '{}')).toEqual({
      oauthAccount: { emailAddress: 'a@b.test' },
    });
  });

  it('refuses to overwrite a config it cannot parse, and leaves it byte-identical', async () => {
    const { fs, deps } = setup();
    const torn = '{"projects":{"/work":{"allowed":true}},"oauthAcc';
    fs.put(paths.globalConfig, torn);

    const e = unwrapErr(await writeAccountIdentity(paths, { emailAddress: 'a@b.test' }, deps));
    expect(e.code).toBe('unreadable');
    expect(e.error).toContain('refusing to overwrite');
    expect(fs.read(paths.globalConfig)).toBe(torn);
  });

  it('is refused in safe mode', async () => {
    const guard = denyingWriteGuard();
    const { fs, deps } = setup({ writeGuard: guard });
    fs.putJson(paths.globalConfig, { oauthAccount: { emailAddress: 'original@example.test' } });
    fs.clearOps();

    expect((await writeAccountIdentity(paths, { emailAddress: 'new@example.test' }, deps)).ok).toBe(
      false,
    );
    expect(guard.targets).toEqual([paths.globalConfig]);
    expect(fs.ops).toEqual([]);
  });

  it('leaves the original config intact when the write fails', async () => {
    const { fs, deps } = setup();
    fs.putJson(paths.globalConfig, { oauthAccount: { emailAddress: 'original@example.test' } });
    const before = fs.snapshot();
    fs.fail('rename', { code: 'EXDEV', times: 5 });

    expect((await writeAccountIdentity(paths, { emailAddress: 'new@example.test' }, deps)).ok).toBe(
      false,
    );
    expect(fs.snapshot()).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe('defaultDeps', () => {
  it('supplies a clock and a platform, and lets overrides win', () => {
    const deps = defaultDeps({ platform: 'macos', env: { USER: 'x' } });
    expect(deps.platform).toBe('macos');
    expect(deps.now()).toBeGreaterThan(1_700_000_000_000);
    expect(typeof deps.run).toBe('function');
    expect(typeof deps.fs.readFile).toBe('function');
  });

  it('takes its env from the override, not the process, when one is given', () => {
    expect(keychainAccountName(defaultDeps({ env: { USER: 'injected' } }))).toBe('injected');
  });

  it('has no write guard by default — safe mode is wired in by the caller', () => {
    expect(defaultDeps().writeGuard).toBeUndefined();
  });
});
