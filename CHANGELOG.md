# Changelog

All notable changes to ClaudeDeck are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-24

Initial release. ClaudeDeck is a cross-platform Electron desktop app for
managing multiple Claude Code accounts: switching between them, watching quota,
recording usage history, and rotating automatically before a rate limit lands.
It is a fresh TypeScript implementation informed by the prior art of
[claude-swap](https://github.com/realiti4/claude-swap) — see
[docs/COMPARISON.md](docs/COMPARISON.md).

### Added

**Accounts**

- Capture whatever Claude Code is currently logged in as into a numbered slot,
  or register a raw `sk-ant-oat…` setup token or `sk-ant-api…` managed API key.
- Stable 1-based slots, optional aliases usable anywhere a slot number is, and
  per-account disable to hold an account out of auto-rotation while keeping it
  a valid explicit switch target.
- Automatic quarantine of an account whose refresh token is permanently dead,
  with the reason recorded and reported rather than retried forever.
- Plaintext JSON export and import for backup and machine transfer, with a slim
  default and a `--full` mode for same-machine backups.

**Switching**

- Manual switch by slot, email or alias, and rotation by strategy: `best`,
  `next`, `next-available`, `consume-first`.
- Switch previews: `planSwitch()` is a pure function that reports the exact
  files a real switch would write, in order. The GUI confirms against that
  manifest and the CLI prints it under `--dry-run`.
- Cross-process advisory locking, atomic writes, and merge-not-replace semantics
  when writing Claude Code's own credential and config files, including the
  macOS Keychain item.
- Target tokens are refreshed before activation when they are spent, and a
  rotated refresh token is written back to both the vault and Claude Code.

**Quota, history and forecasting**

- Live 5-hour, 7-day, per-model weekly and extra-usage spend windows, with reset
  countdowns and a staleness marker.
- Every successful poll is appended to a local NDJSON time series (one file per
  UTC day) and pruned on a retention setting.
- Least-squares burn rate per window, segmented at reset boundaries, with a
  confidence value and a projected exhaustion instant that is null whenever the
  data does not support naming one. Projections are always rendered as labelled
  estimates.

**Auto-switch**

- Threshold and pace triggers, cooldown, hysteresis margin, and a staleness
  cutoff so a proactive switch never fires on remembered numbers.
- Adaptive polling: busy accounts watched closely, idle and exhausted ones
  backed off, a 429 raising the floor, and an imminent reset pulling the next
  poll in.
- API-key accounts are never treated as rate limited and are never rotated onto
  unless explicitly included.

**Interface**

- Desktop GUI with Dashboard, Accounts, Timeline, Automation and Settings views,
  a three-step onboarding wizard, a Ctrl/Cmd+K command palette, light/dark/system
  themes and remembered window geometry.
- System tray on Windows, macOS and Linux, with a runtime-drawn ring icon
  tracking the active account's headroom and a tooltip stating the same number
  in words.
- Native notifications for threshold crossings, switches, quarantines and
  exhaustion, latched so a hovering percentage cannot fire repeatedly.
- Hand-rolled SVG charts with a validated categorical palette, a table view for
  every chart, and status that always carries a glyph and a word rather than
  colour alone.

**CLI**

- `list`, `status`, `switch`, `add`, `remove`, `alias`, `enable`, `disable`,
  `auto`, `history`, `forecast`, `export`, `import`, `gui`, `help`, `version`.
- `--json` on every command emits one `schemaVersion`-tagged object on stdout
  with all human notices on stderr; `auto` streams JSONL.
- Exit codes `0` switched, `1` error, `2` nothing to do, `3` no viable target,
  for `switch` and `auto --once`.
- Full reference in [docs/CLI.md](docs/CLI.md).

**Safety and operations**

- Safe mode: a global read-only guard that refuses every disk write, wired once
  into the dependency graph.
- Demo mode (`CLAUDEDECK_DEMO=1`, `npm run demo`): four deterministic synthetic
  accounts from a backend that imports nothing from `node:fs`, `electron` or the
  core modules, so it cannot reach a credential.
- Reproducible screenshot generation from the same fixtures
  (`npm run screenshots`).
- Zero runtime dependencies.

### Security

- Account credentials are encrypted at rest with Electron `safeStorage` — DPAPI
  on Windows, Keychain on macOS, the desktop secret service on Linux. Where no
  secret service exists, the vault falls back to plaintext and records
  `"plaintext": true`, which the Settings view surfaces in words. There is no
  home-grown fallback cipher, and an encryption failure is an error rather than
  a silent downgrade.
- Tokens are never logged, printed, exported unencrypted by accident, or sent
  anywhere but Anthropic. Diagnostics use a 12-hex-character SHA-256
  fingerprint; error strings crossing IPC are scrubbed of `sk-ant-…` shapes.
- The renderer runs with `contextIsolation: true`, `sandbox: true` and
  `nodeIntegration: false`, behind a preload generated from the IPC contract
  with no generic invoke escape hatch. `openExternal` accepts web URLs only and
  `revealPath` is restricted to paths ClaudeDeck owns.
- Network traffic goes to Anthropic's OAuth token, profile and usage endpoints
  and nowhere else. No telemetry, no analytics, no crash reporting, no update
  check.
- Full posture and threat model in [docs/SECURITY.md](docs/SECURITY.md).

### Known limitations

- No session mode: ClaudeDeck switches the one active login and cannot run two
  accounts in parallel in separate terminals.
- Directory mappings can be recorded but nothing acts on them yet.
- No Content-Security-Policy header is applied to the renderer session.
- The `claudedeck` bin path in `package.json` does not match the emitted
  `out/main/cli/index.js`, and the CLI bundle links against Electron, so the
  headless command is not yet runnable standalone.
- Release installers are not code-signed.

[Unreleased]: https://github.com/dev9414/claudedeck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dev9414/claudedeck/releases/tag/v0.1.0
