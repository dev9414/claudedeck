# Architecture

How ClaudeDeck is put together, and why it is put together that way. This
describes the code as it exists in 0.1.0 — where something is intentionally not
implemented, it says so.

---

## The short version

ClaudeDeck is an Electron application with four execution contexts (main,
preload, renderer, CLI) and one shared contract that all four compile against.
All of the decision logic lives in `src/core`, which is pure: every module there
receives its filesystem, network, clock and crypto as parameters. `src/main` is
the only place that hands those modules the real thing.

The consequence worth caring about: the GUI and the CLI are not two
implementations of the same product. They are two front ends over one
`AppServices` object, so a bug in the switching engine is one bug, not two.

---

## Process model

```text
+---------------------------------------------------------------------------+
|  Electron main process (Node)                        out/main/index.js     |
|                                                                           |
|   index.ts -- lifecycle, single-instance lock, tray/notifier/window refs   |
|      |                                                                    |
|      +-- window.ts    BrowserWindow: sandbox, contextIsolation, geometry   |
|      +-- tray.ts      generated ring icon + menu (Win / macOS / Linux)     |
|      +-- notifications.ts   latched native toasts                          |
|      +-- ipc.ts       ipcMain.handle per INVOKE_CHANNELS, argument checks  |
|      +-- services.ts  <== THE COMPOSITION ROOT                             |
|             |  builds every core module with the real fs/fetch/clock       |
|             |  demo.ts substitutes a synthetic AppServices                 |
|             v                                                              |
|   +------------------ src/core (pure, injected I/O) -----------------+     |
|   | paths  platform  credentials  vault  store  locks                |     |
|   | oauth  usage  history  forecast  switcher  autoswitch  redact    |     |
|   +------------------------------------------------------------------+     |
+---------------------------+-----------------------------------------------+
                            | ipcMain.handle / webContents.send
                  +---------v----------+
                  |  preload (CJS)     |   out/preload/index.cjs
                  |  contextBridge ->  |   no ipcRenderer, no node, no process
                  |  window.claudedeck |   reaches the page
                  +---------+----------+
                            | DeckApi
+---------------------------v-----------------------------------------------+
|  Renderer (sandboxed Chromium, React 19)          out/renderer/...         |
|   App.tsx -> hash router -> views/ -> charts/ (hand-rolled SVG)            |
|   useDeckState() is the single subscription to DeckState                   |
+---------------------------------------------------------------------------+

+---------------------------------------------------------------------------+
|  CLI (same bundle, never opens a window)          out/main/cli/index.js    |
|   src/cli/index.ts -> createServices() -> the identical AppServices object |
+---------------------------------------------------------------------------+

   the contract, imported by all four and importing nothing itself:
     src/shared/types.ts  -- every domain type + the Result envelope
     src/shared/ipc.ts    -- DeckApi, INVOKE_CHANNELS, EVENT_CHANNELS
```

---

## Contract first

`src/shared/types.ts` and `src/shared/ipc.ts` are the single source of truth.
They import nothing — not `electron`, not `node:*`, not renderer code — so the
same files load in a Node process, a Chromium page and a preload sandbox.

Three mechanisms keep the contract from drifting into decoration:

1. **The preload bridge is generated, not written.** `src/preload/index.ts` maps
   over `INVOKE_CHANNELS` to build the invoker object, then asserts the result
   is a `DeckApi`. A channel name that is not a `DeckApi` method fails the
   `Pick<DeckApi, InvokeChannel>` cast; a `DeckApi` method missing from the
   array fails the final assignment.

2. **The main-side handler map is exhaustive by type.** `src/main/ipc.ts`
   declares `const handlers: Record<InvokeChannel, Handler>`. Declaring a method
   in the contract without implementing it is a compile error.

3. **The CLI checks structurally at runtime.** It does not import the concrete
   shape of `AppServices`; it verifies a list of `REQUIRED_METHODS` on whatever
   `createServices()` returned and fails with `the services factory is missing
   …` instead of a `TypeError` three frames deep.

If you need a type that does not exist, add it to `src/shared/types.ts` rather
than inventing a parallel definition locally.

### Error convention

Core functions return `Result<T>` (`{ ok: true, value }` / `{ ok: false, error,
code? }`) for expected failures and throw only for programmer error.
`src/main/ipc.ts` knows which channels are `Result`-shaped (`RESULT_CHANNELS`)
and converts a thrown error into an `Err` for those, so a renderer call never
rejects for a condition the UI is supposed to render.

---

## Why core is pure

Every module in `src/core` takes its side effects as parameters:

| Injected surface | Defined in | Carries |
|---|---|---|
| `CoreDeps` / `FsDeps` | `core/credentials.ts` | fs read/write/rename/stat/unlink, `now()`, `env`, `platform`, `run()` for the macOS `security` binary, and `writeGuard` |
| `Encryptor` | `core/vault.ts` | `available()` / `encrypt()` / `decrypt()` — `safeStorage` in production, a fake in tests |
| `FetchLike` | `core/oauth.ts` | `fetch`, passed explicitly to `refreshToken`, `fetchProfile`, `fetchUsage` |
| `HistoryDeps` | `core/history.ts` | a seven-method `HistoryFs` plus a `safeMode()` probe |
| `LockDeps` | `core/locks.ts` | fs, `now()`, `sleep()`, `pid`, `host` |
| `SwitchDeps` | `core/switcher.ts` | credential read/write, persistence, quarantine, lock, clock, fetch, optional `emit` |
| `AutoSwitchDeps` | `core/autoswitch.ts` | `snapshot()`, `pollUsage()`, `performSwitch()`, `emit()`, and an injectable `schedule()` so the loop runs without a real timer |

Three things fall out of this:

- **Tests never touch a real `~/.claude`.** There is no ambient `fs` to
  monkey-patch, because there is no ambient `fs`. A test points the path
  resolver at a temp directory and that is the whole isolation story.
- **The CLI and the GUI run the same engine.** Nothing in core knows which one
  is calling it.
- **The rules are testable as arithmetic.** `decide()`, `nextPollDelay()`,
  `planSwitch()`, `burnRate()`, `normalizeUsage()` and `headroom()` are pure
  functions of their inputs, including the clock.

`src/core` imports `electron` nowhere, and `src/main` imports `@core/*` in
exactly one file: `services.ts`.

---

## The composition root

`src/main/services.ts` is the only module that knows how the pieces fit
together. It resolves paths, builds the settings store, constructs the vault
encryptor, wires the account store, history store, locks and auto-switcher, and
returns an `AppServices` object satisfying `DeckApi` minus the three calls that
are pure Electron shell (`pickDirectory`, `openExternal` and `revealPath` live
in `ipc.ts`, because they have no business in a headless service object).

Two invariants are enforced here rather than scattered across call sites:

- **Safe mode is wired once.** A `writeGuard` closure goes into `CoreDeps` and a
  `safeMode()` probe into the history store. Every disk write in core funnels
  through those, so no individual call site has to remember the rule.
  `settings.json` is deliberately outside the guard — blocking it would make
  safe mode a one-way door with no way to turn it back off from the UI.
- **Live usage is runtime state, not registry state.** `AccountStore` persists
  what an account *is* (slot, email, alias, credentials, quarantine); the
  percentages it is sitting at right now live in an in-memory `Map` keyed by
  slot and are merged into the projection by `toAccount()`. A restart forgets
  the numbers, which is correct — they were only ever a measurement.

`src/main/demo.ts` is a second, complete implementation of `AppServices` built
from a seeded PRNG (mulberry32) and a frozen clock. It imports nothing from
`node:fs`, `electron` or `@core/*`, so "demo mode cannot touch a credential" is
a structural property rather than a promise. `index.ts` chooses between the two
on `CLAUDEDECK_DEMO=1`.

---

## Data flow: one poll to one chart

```text
   startup / refresh button / CLI command / auto-switch timer
                |
                v
  services.refreshUsage(slot?) --> refreshOne(record)
                |                      |
                |   credentialFor() ---+  the active slot reads Claude Code's
                |                      |  own file first: it rotates the access
                |                      |  token behind our back
                |   isExpired() -------+
                |   refreshToken() ----+  400 invalid_grant => store.quarantine()
                |                      |  a rotated refresh token is written to
                |                      |  the vault *and* back to Claude Code
                |   fetchUsage() ------+  GET /api/oauth/usage
                |   normalizeUsage() --+  drops unparseable fields, never throws
                |                      |
                |   markLive(slot, status, usage)        in memory
                |   store.setLastGoodUsage(slot, usage)  vault.json
                |   history.append({t, slot, windows})   history/YYYY-MM-DD.ndjson
                v
           publish() --> buildState(): DeckState
                |
                +--> ipc.ts broadcasts 'deck:state-changed'
                |       -> preload -> useDeckState() -> React re-render
                |          -> UsageMeter / StatTile / UsageTimeline / tray chip
                |
                +--> tray.refresh(state) and the notifier's threshold check
```

The forecast path is pulled, not pushed. A view calls `getForecasts(slot)`;
services reads the last 14 days of history for that slot, takes the windows the
account currently reports, and runs `forecastWindows()` — a least-squares fit
per window over a trailing lookback, segmented at reset cliffs so a rollover is
never averaged into the slope, with a `confidence` value the chart is required
to render as such.

`getHistory(query)` reads the NDJSON day files directly and downsamples to at
most `HISTORY_QUERY_POINT_CAP` (2000) points, because that array crosses the IPC
boundary on every range change.

---

## Where state lives

| What | Where | Format | Owned by |
|---|---|---|---|
| Account registry + credential blobs | `<deckHome>/vault.json` | JSON envelope; payload encrypted with `safeStorage`, or `plaintext: true` when no OS secret service exists | `core/store.ts` via `core/vault.ts` |
| Preferences | `<deckHome>/settings.json` | JSON, hand-editable, unknown keys preserved | `main/settings.ts` |
| Usage time series | `<deckHome>/history/YYYY-MM-DD.ndjson` | one JSON object per line, one file per UTC day | `core/history.ts` |
| Window geometry | `<deckHome>/window.json` | JSON | `main/window.ts` |
| Advisory locks | `<target>.claudedeck.lock` | JSON `{pid, host, takenAt}`, created with `wx` | `core/locks.ts` |
| Live usage, last switch time, recent events | main-process memory | — | `main/services.ts` |
| Theme, pre-hydration | renderer `localStorage` key `claudedeck:theme` | string | `renderer/theme/useTheme.ts` |
| Onboarding step | renderer `sessionStorage` | string | `renderer/views/Onboarding.tsx` |

`deckHome` resolves to `%APPDATA%\ClaudeDeck` on Windows,
`~/Library/Application Support/ClaudeDeck` on macOS, and
`${XDG_DATA_HOME:-~/.local/share}/claudedeck` on Linux and WSL.
`CLAUDEDECK_HOME` overrides all three.

ClaudeDeck also **writes into Claude Code's own store** when you switch:
`<configHome>/.credentials.json` (or the macOS Keychain item
`Claude Code-credentials`) and the `oauthAccount` object in the global config.
Those files belong to Claude Code, so every write merges into what is currently
there rather than replacing it, and lands atomically through a temp file plus a
rename in the same directory.

The renderer holds no durable state of its own. `useDeckState()` seeds from
`getState()` and then follows `onStateChanged`; views read the hook instead of
taking props, so the bridge *is* the store. When the bridge is missing entirely
(a plain browser tab during UI work) the hook falls back to a clearly-marked
in-memory stub with `stubbed: true` and `demoMode: true`.

---

## Switching

Two halves, deliberately separated, in `src/core/switcher.ts`:

- `planSwitch(ctx, req)` is **pure**. It resolves the target (slot, email or
  alias), applies the rotation strategy, and returns the literal list of writes
  a real run would perform, in the order it would perform them. It reads no
  clock and opens no file, so it is safe to call on every keystroke.
- `applySwitch(ctx, req, deps)` performs that plan for real, under the
  credential lock, refreshing the target's token first when it is spent.

The GUI's confirm step and the CLI's `--dry-run` both render `plannedWrites`
from the same resolver, so the preview and the switch cannot disagree.

Everything from capturing the outgoing credential to updating the registry
happens inside one advisory lock, because Claude Code refreshes its own token in
the background and ClaudeDeck itself can be running twice (window plus CLI). The
lock is an atomic exclusive create; one left behind by a killed process is
broken only once it is provably older than `staleMs`.

---

## The auto-switch engine

`src/core/autoswitch.ts` splits into pure policy and one small stateful loop:

- `decide(input): Decision` returns `switch`, `hold` or `blocked`. It applies the
  threshold, the pace trigger (only when forecast confidence clears
  `PACE_CONFIDENCE_FLOOR`), the cooldown (skipped for reactive switches, since
  the incumbent is already unusable), the hysteresis margin, and a staleness
  cutoff: usage older than `DEFAULT_MAX_USAGE_AGE_MS` cannot justify a proactive
  move.
- `nextPollDelay(state, config, now)` is the adaptive cadence. Busy accounts are
  watched closely, idle and exhausted ones far less, a 429 raises the floor, and
  an imminent reset pulls the next poll in.
- `createAutoSwitcher(deps)` owns a timer, a few counters and the last-known
  account list, and nothing else. `runOnce()` is exposed for tests and for a
  manual "check now".

The engine fails safe by construction: it decides only on data a poll just
confirmed. A failed fetch keeps the previous numbers, backs the cadence off, and
skips the decision entirely rather than rotating on a guess.

---

## The CLI

`src/cli/index.ts` is bundled into the main output (see
`electron.vite.config.ts`) and must never require a window — only `claudedeck
gui` touches Electron, through a lazy `import('electron')` and a detached spawn.

It has its own argument parser because the project ships zero runtime
dependencies. Output discipline is part of the contract: `--json` puts exactly
one machine-readable object on stdout and every human notice on stderr, so
`claudedeck list --json | jq` is always safe to pipe. See [CLI.md](CLI.md) for
the full reference, including the packaging gap in 0.1.0.

---

## The renderer

- **Routing is a hash string**, not a router dependency: five flat destinations,
  and zero runtime deps is a project rule. Views are lazily imported so the
  dashboard paints before the chart code is parsed.
- **Charts are hand-rolled SVG** (`src/renderer/charts/`). Every chart can
  produce a real `<table>` through `ChartFrame`, which is the documented relief
  for the light-mode series slots that sit below 3:1 contrast. Status is never
  carried by hue alone — a glyph and a word always ship with it.
  `scripts/validate-palette.mjs` parses the real values out of `tokens.css` and
  re-runs the colour gates, so editing a token is exactly what makes it fail.
- **State flows one way**: `useDeckState()` → view → `api.*` call → main mutates
  → `publish()` → `onStateChanged` → hook → view.

---

## Build and tooling

`electron-vite` produces three bundles from one config:

| Target | Entry | Output | Notes |
|---|---|---|---|
| main | `src/main/index.ts`, `src/cli/index.ts` | `out/main/index.js`, `out/main/cli/index.js` | ESM, dependencies externalized |
| preload | `src/preload/index.ts` | `out/preload/index.cjs` | CJS — a sandboxed preload cannot be an ES module |
| renderer | `src/renderer/index.html` | `out/renderer/**` | React plugin |

The path aliases `@shared`, `@core` and `@renderer` are declared three times —
in `tsconfig.json`, `electron.vite.config.ts` and `vitest.config.ts` — and all
three must agree. TypeScript is strict with `noUncheckedIndexedAccess`, so
indexed access yields `T | undefined` and has to be handled at every site.

---

## Not implemented in 0.1.0

Stated plainly so nobody goes looking for it:

- **No session mode.** There is no way to run two accounts in parallel in
  separate terminals. ClaudeDeck switches the one active login.
- **Directory mappings are recorded, not acted on.** `mapDirectory` and
  `unmapDirectory` persist `Settings.directoryMappings` and Settings renders
  them, but nothing at runtime reads a mapping to choose an account.
- **`moveAccount` has no CLI command.** It exists in `DeckApi` and in the
  Accounts view (by drag or by button); the CLI does not expose it.
- **No Content-Security-Policy is applied.** `src/renderer/index.html` carries a
  comment saying the main process sets the policy on session response headers.
  No code does that yet — see [SECURITY.md](SECURITY.md).
- **The `claudedeck` bin path does not match the build output** — see
  [CLI.md](CLI.md).
- **No auto-update, no crash reporting, no telemetry.** Not "off by default":
  absent.

---

## File layout

```text
src/
  shared/          the contract; imports nothing
    types.ts       domain types + the Result envelope
    ipc.ts         DeckApi, INVOKE_CHANNELS, EVENT_CHANNELS
  core/            pure, injected I/O, no electron import
    paths.ts        Claude Code + deck path resolution
    platform.ts     windows | macos | linux | wsl (WSL is its own kind)
    credentials.ts  Claude Code's own store, macOS Keychain, atomic writes, CoreDeps
    vault.ts        ClaudeDeck's encrypted-at-rest envelope
    store.ts        the account registry (slots, aliases, quarantine)
    locks.ts        cross-process advisory file locking
    oauth.ts        token refresh + profile lookup
    usage.ts        usage fetch, normalization, headroom
    history.ts      NDJSON time series: append, query, prune, compact
    forecast.ts     burn rate, pace, exhaustion projection
    switcher.ts     planSwitch (pure) + applySwitch
    autoswitch.ts   decide + nextPollDelay (pure) + the loop
    redact.ts       fingerprint / redact / redactObject
  main/
    index.ts         lifecycle and wiring only
    services.ts      the composition root
    ipc.ts           ipcMain handlers + argument narrowing
    settings.ts      settings.json, bounds, normalization
    window.ts        BrowserWindow hardening + remembered geometry
    tray.ts          generated ring icon and menu
    notifications.ts latched native toasts
    demo.ts          synthetic AppServices for demo mode
  preload/index.ts   the contextBridge surface, generated from the contract
  renderer/
    App.tsx  main.tsx  index.html
    components/  charts/  views/  hooks/  theme/
  cli/index.ts       the headless front end
tests/               vitest: tests/core (node) and tests/renderer (jsdom)
scripts/             demo.mjs, validate-palette.mjs
docs/                these documents
```
