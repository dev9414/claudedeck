# Contributing to ClaudeDeck

Thanks for looking. ClaudeDeck manages live OAuth credentials for other people's
Claude accounts, so this guide spends more time on rules than most — a bug here
can log somebody out of an account they cannot get back into.

- Found a security problem? **Do not open an issue.** See [SECURITY.md](docs/SECURITY.md).
- Everything else: an issue first for anything larger than a fix, so we can
  agree on the shape before you spend an evening on it.
- By contributing you agree your work is licensed under the [MIT License](LICENSE).
- Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

---

## The five rules

These are not style preferences. A PR that breaks one will be asked to change.

### 1. Never let a token reach a sink

No token, refresh token or API key may be logged, printed, thrown inside an
error message, serialized to disk unencrypted, or sent anywhere. When you need
to *talk about* a credential, use `src/core/redact.ts`:

```ts
import { fingerprint, redact, redactObject } from '@core/redact';

log(`slot ${slot} token ${fingerprint(token)} rejected`); // 12 hex chars
log(redact(token));                                        // sk-ant-oat01-…#a1b2c3d4e5f6
log(JSON.stringify(redactObject(state)));                  // deep-scrubbed clone
```

### 2. Tests never touch a real `~/.claude`

Every test points at a temp directory through the injected path resolver. There
is no exception, including "just a read". Because all I/O in `src/core` is
injected, this is easy:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'claudedeck-test-'));
const paths = resolvePaths({ CLAUDE_CONFIG_DIR: join(home, '.claude') }, home);
```

Never use your own account's email address or a real token shape in a fixture.

### 3. All disk writes go through the safe-mode guard

`settings.safeMode` must refuse **every** write the app would make. It is wired
once, in `src/main/services.ts`, into `CoreDeps.writeGuard` and the history
store's `safeMode()` probe. Write through `atomicWriteText` or the store that
owns the file; do not call `fs.writeFile` from a new place in core.

### 4. No new runtime dependencies

`package.json` has no `dependencies`, only `devDependencies`, and that is a
feature. Charts are hand-rolled SVG, the CLI has its own argument parser,
validation is written by hand. Dev and test dependencies are fine; a runtime one
needs a very good argument.

### 5. Contract first

`src/shared/types.ts` and `src/shared/ipc.ts` are the single source of truth for
the main process, the preload bridge, the renderer and the CLI. If you need a
domain type that does not exist, **add it there**, in a clearly-marked section —
do not define a parallel type in your own file. New main↔renderer surface is
declared in `ipc.ts` before it is implemented anywhere.

---

## Setup

You need **Node 20 or newer** and npm. That is all — no Python, no native
toolchain.

```bash
git clone https://github.com/dev9414/claudedeck.git
cd claudedeck
npm install          # pulls Electron (~100 MB) on first run
npm run dev          # hot-reloading main + preload + renderer
```

Other useful entry points:

```bash
npm run demo         # the app against synthetic accounts, all writes blocked
npm run demo -- --dev  # the same, with hot reload
npm run build        # typecheck, then bundle main / preload / renderer into out/
npm start            # run the built app
npm run pack         # electron-builder --dir, an unpacked app directory
```

`npm run demo` sets `CLAUDEDECK_DEMO=1`, which swaps in `src/main/demo.ts`: four
deterministic fake accounts, a frozen clock, and a backend that imports nothing
from `node:fs`, `electron` or `@core/*`. **Use it for any UI work.** It cannot
read or write a credential, so it is also the right way to evaluate a change on
a machine with real accounts on it.

### Layout

```
src/shared/    the contract — types.ts and ipc.ts, importing nothing
src/core/      pure logic, all I/O injected, no electron import
src/main/      Electron main: services.ts is the composition root
src/preload/   the contextBridge surface, generated from the contract
src/renderer/  React 19: components/ charts/ views/ hooks/ theme/
src/cli/       the headless front end over the same services
tests/         vitest — tests/core (node) and tests/renderer (jsdom)
scripts/       demo.mjs, capture-screenshots.mjs, validate-palette.mjs
docs/          ARCHITECTURE, SECURITY, COMPARISON, CLI
```

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) before a first change of any
size. The short version: `src/core` is pure and dependency-injected,
`src/main/services.ts` is the only place that hands it real I/O, and the GUI and
CLI are two front ends over one `AppServices` object.

---

## Running the checks

```bash
npm test                       # vitest, one pass
npm run test:watch             # vitest, watching
npm run coverage               # v8 coverage over src/core and src/shared
npm run typecheck              # tsc --noEmit (this is also `npm run lint`)
npm run validate:palette       # colour gates, parsed out of tokens.css
```

A single file or a single test:

```bash
npx vitest run tests/core/forecast.test.ts
npx vitest run -t "quarantines a dead refresh token"
```

Tests live in `tests/`, mirroring `src/`, named `*.test.ts` (or `.test.tsx`).
`tests/core/**` runs in the node environment; `tests/renderer/**` runs in jsdom.
Coverage is collected for `src/core/**` and `src/shared/**` — that is where the
decisions are, and it is the code that must be testable without mocking globals.

**What deserves a test:** anything in `src/core`, always. Pure functions like
`decide()`, `nextPollDelay()`, `planSwitch()`, `burnRate()`, `normalizeUsage()`
and `headroom()` are testable as arithmetic, including the clock, because `now`
is a parameter. Reach for a fake `fetch`, a fake `Encryptor` and a temp
directory rather than a mocking framework.

CI runs `npm run typecheck`, `npm test` and `npm run build` on Ubuntu, Windows
and macOS across Node 20 and 22. Path handling differs per OS, so a green run on
one platform proves less than you would like. Run
`npm run typecheck && npm test && npm run build` locally before you push, and
`npm run validate:palette` too if you touched `tokens.css` or a chart.

---

## Code style

`.editorconfig` covers whitespace (LF, 2 spaces, final newline). Beyond that:

- **Strict TypeScript**, with `noUncheckedIndexedAccess` on — indexed access
  yields `T | undefined` and you must handle it. No `any`; use `unknown` and
  narrow.
- **ESM only.** Node builtins get the `node:` prefix.
- **Named exports**, no default exports — except React components and pages,
  which are default-exported so they can be lazily imported.
- **Small pure functions in `src/core`; side effects at the edges.**
- **Errors:** core functions return `Result<T>` from `types.ts` for expected
  failures, and throw only for programmer error.
- **Every module gets a short header comment** saying what it owns. Match the
  density of `src/shared/types.ts`.
- **Comments explain *why*, not *what*.** A comment restating the line below it
  is noise; a comment explaining why the retry loop exists is the reason the
  next person does not delete it.
- Use the path aliases `@shared/*`, `@core/*`, `@renderer/*`. They are declared
  in `tsconfig.json`, `electron.vite.config.ts` and `vitest.config.ts`, and all
  three must agree.

---

## Recipe: adding an IPC method

The order matters, and the compiler enforces most of it.

1. **Declare it in `src/shared/ipc.ts`** — add the method to `DeckApi` and its
   name to `INVOKE_CHANNELS`. If it needs new domain types, they go in
   `src/shared/types.ts`.
2. **Implement it in `src/main/services.ts`**, on the `AppServices` object.
   `Record<InvokeChannel, Handler>` in `src/main/ipc.ts` will not compile until
   the handler exists.
3. **Add the handler in `src/main/ipc.ts`**, narrowing every argument
   (`requireNumber`, `requireString`, `requireRecord`, …). Renderer input is
   untrusted. If the method returns `Result<T>`, add the channel to
   `RESULT_CHANNELS` so a throw becomes an `Err` rather than a rejection.
4. **Implement it in `src/main/demo.ts`** too, or demo mode stops compiling.
5. **The preload needs no change** — it is generated from `INVOKE_CHANNELS`.
6. **Expose it in `src/renderer/hooks/useDeckState.ts`** if a view needs it,
   including in the no-bridge stub.
7. **Consider the CLI.** If it is useful headlessly, add a command; if it is
   required, add it to `REQUIRED_METHODS` in `src/cli/index.ts`.

Adding a setting is the same shape: extend `Settings` in `types.ts`, add a
default and (for numbers) a range in `SETTING_BOUNDS` in `src/main/settings.ts`,
normalize it defensively when reading, then build the control from the same
bounds table so the UI and validator cannot drift.

---

## Screenshots

The README set is generated, never hand-captured, so it stays reproducible:

```bash
npm run build         # required first; the script never builds for you
npm run screenshots   # -> assets/screenshots/*.png
```

On a headless Linux box there is no compositor to capture from, so wrap it:

```bash
xvfb-run -a npm run screenshots
```

Useful flags: `--only dashboard-dark,settings` to redo one shot, `--out <dir>`,
`--scale <n>` (default 2), `--dry-run` to generate and syntax-check the driver
without capturing. Current shot ids: `dashboard-light`, `dashboard-dark`,
`accounts`, `timeline`, `automation`, `settings`, `onboarding`, `tray`.

The script hosts the built renderer itself and injects a bridge serving the same
synthetic accounts as demo mode — ada, grace, linus, ops-bot, frozen at
2026-08-24T14:30Z with a seeded PRNG — so two runs a month apart produce the
same pixels. It refuses every mutating call and has no Node access.

**Never attach a screenshot containing a real account email, a real
organisation name, or a real path with your username in it.** Demo mode exists
precisely so you do not have to.

Anything visually visible in a PR wants a screenshot in **both themes** — the
token set resolves differently under `[data-theme]`, and light mode is where
contrast bugs hide.

---

## Commits and pull requests

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(cli): add --until to the history command
fix(switcher): keep sibling keys when merging the credential file
docs(security): document the plaintext vault fallback
test(forecast): cover the reset-segmentation branch
refactor(store): fold the migration into one pass
chore(deps): bump vitest to 2.1.8
```

Types in use: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`,
`ci`, `chore`. The scope is usually the module (`core`, `cli`, `renderer`,
`main`, `switcher`, `vault`, …) and is optional.

- Subject in the imperative, under ~72 characters, no trailing period.
- Put the *why* in the body. The diff already shows the what.
- One logical change per commit; keep refactors out of behaviour changes.
- Reference issues with `Fixes #123`.
- Never commit a real credential, a real email address, or anything from your
  own `~/.claude`. If you do, treat the token as compromised and rotate it —
  rewriting history is not enough.

For the PR itself, fill in the template honestly: it asks what you actually ran,
not what you intended to run. Anything touching switching, credentials, or the
auto-switch engine needs more than "the types compile" — that code decides which
account somebody's next Claude Code session bills to.

Update the docs in the same PR when user-visible behaviour changes, and add a
line to `CHANGELOG.md` under an `Unreleased` heading.

---

## Good first contributions

- Wire the Content-Security-Policy header the renderer's `index.html` says the
  main process should be setting (see [docs/SECURITY.md](docs/SECURITY.md)).
- Fix the `bin` path and packaging of the CLI so `claudedeck` runs standalone
  (see [docs/CLI.md](docs/CLI.md)).
- Make directory mappings actually do something, or remove the setting.
- Widen test coverage in `src/core` — `switcher.ts`, `autoswitch.ts`,
  `history.ts`, `store.ts`, `locks.ts` and `vault.ts` all reward it.
- Accept an email or alias for `claudedeck history --slot`, which today takes a
  slot number only.
- Anything on the issue tracker labelled `good first issue`.
