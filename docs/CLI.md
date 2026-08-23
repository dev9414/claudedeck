# `claudedeck` — CLI reference

Everything the GUI can do to accounts is reachable from a terminal, over the
same service layer the IPC handlers call. This documents exactly what
`src/cli/index.ts` implements in 0.1.0.

```
claudedeck <command> [options]
```

---

## Running it in this build

The CLI is built as a second entry of the main bundle, so it lands at
`out/main/cli/index.js`:

```bash
npm run build
node out/main/cli/index.js list
```

`package.json` maps the `claudedeck` bin to that path, so `npm link` (or a
global install from a checkout) gives you the bare `claudedeck` command. There
is no registry package yet — see [Known gaps](#known-gaps-in-01).

**How it reaches an encrypted vault.** ClaudeDeck encrypts the account vault with
Electron's `safeStorage`, which is backed by DPAPI, Keychain or libsecret and
exists only inside the Electron runtime. A plain-Node invocation therefore could
not decrypt anything the GUI wrote.

Rather than fall back to plaintext — which would defeat the point of the vault —
any command that opens the vault **re-executes itself under the Electron runtime**
and proxies the exit code and stdio back. You do not have to do anything; it is
transparent. Two consequences worth knowing:

- Electron must be present on disk (it is, in a source checkout). If it is not,
  the CLI continues in-process and the vault reports honestly that it cannot
  decrypt, rather than pretending.
- `CLAUDEDECK_DEMO=1` and `CLAUDEDECK_NO_REEXEC=1` both skip the escalation,
  since neither needs secure storage.

---

## Conventions

### Output discipline

`--json` puts **exactly one** machine-readable object on stdout. Every human
notice, warning and error goes to stderr. So this is always safe:

```bash
claudedeck list --json | jq -r '.accounts[] | select(.active) | .email'
```

The one exception is `claudedeck auto` without `--once`, which is a *stream*:
one JSON object per line (JSONL), so `| jq -c` works live.

Every JSON document carries `schemaVersion` (currently `1`) and `command`. The
contract is additive — new fields and new event kinds may appear, so consumers
should ignore what they do not recognise.

`claudedeck list | head -1` closing the pipe is not an error: `EPIPE` exits `0`.

### Targets

Wherever a command takes a target, it accepts:

- a **slot number** — `2`
- an **email address** — `you@example.com`
- an **alias** — `dev`, once set with `claudedeck alias 2 dev`

Emails and aliases are matched case-insensitively. If a string matches more than
one account the command fails with `"dev" matches slots 2, 4 — use the slot
number` and exit code `1`.

### Flag parsing

Written by hand, because the project ships no runtime dependencies. The rules:

- `--flag value` and `--flag=value` are equivalent for flags that take a value
  (`--slot`, `--alias`, `--strategy`, `--threshold`, `--since`, `--until`,
  `--token`, `--email`, `--reason`).
- Every other flag is boolean. `--flag=false` and `--flag=0` set it to false.
- `--` stops flag parsing; everything after it is a positional.
- An unknown flag **for that command** is an error, not a silent no-op:
  `unknown option --thresold for this command`.
- `--json` and `--help` are accepted by every command.

Short flags:

| Short | Long |
|---|---|
| `-h` | `--help` |
| `-v` | `--version` |
| `-j` | `--json` |
| `-n` | `--dry-run` |
| `-f` | `--force` |
| `-s` | `--slot` (takes a value) |
| `-a` | `--alias` (takes a value) |

### Command aliases

`ls` → `list`, `rm` → `remove`, `use` → `switch`, `st` → `status`. A bare
`--help` or `--version` as the first token works as the command.

With no arguments at all, `claudedeck` prints the general help and exits `0`.

### Colour and glyphs

Colour is on only when stdout is a TTY. `NO_COLOR` (any non-empty value) turns
it off, `FORCE_COLOR` turns it on for CI logs that do render, and `TERM=dumb`
turns it off. Block-drawing bars degrade to ASCII (`#`/`.`) on Windows unless
Windows Terminal, VS Code or ConEmu is detected.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Error — bad usage, a failed operation, an unreachable service |
| `2` | Nothing to do — already on that account, or below the threshold |
| `3` | Blocked — no viable target to rotate onto |

Codes `2` and `3` are produced by `switch` and by `auto --once`. Every other
command uses `0` or `1`.

For a switch specifically: `0` it moved, `1` it failed, `2` the target was
already active or the rule declined, `3` there was no destination at all.

---

## Commands

### `list` (alias `ls`)

```
claudedeck list [--no-refresh] [--json]
```

Every managed account with its 5-hour and 7-day windows.

| Flag | Effect |
|---|---|
| `--no-refresh` | Skip the live usage poll and show the cached numbers |

Refreshes usage first by default; if the refresh fails the command still prints
the cached numbers and reports the problem as a `warning:` on stderr. A snapshot
older than **10 minutes** is shown but marked `ok (stale)`, with a warning.

Human output is a table: active marker, `SLOT`, `ACCOUNT`, `ALIAS` (only when at
least one account has one), `KIND`, the 5h bar / percent / reset countdown, the
same three for 7d, and `STATUS`. With no accounts it prints a hint to stderr and
exits `0`.

```json
{
  "schemaVersion": 1,
  "command": "list",
  "ok": true,
  "activeSlot": 2,
  "demoMode": false,
  "warnings": [],
  "accounts": [ { "…": "see Account object below" } ]
}
```

---

### `status` (alias `st`)

```
claudedeck status [--no-refresh] [--json]
```

The active account in detail: every window with a bar, percentage and reset
countdown; extra-usage spend if the account has it; token expiry; quarantine
reason; when it was last polled; the auto-switch configuration; the resolved
config path; and safe-mode / demo-mode markers.

With no active account it prints a hint to stderr and exits `0`.

```json
{
  "schemaVersion": 1,
  "command": "status",
  "ok": true,
  "active": { "…": "Account object, or null" },
  "activeSlot": 2,
  "accountCount": 4,
  "autoSwitchRunning": false,
  "autoswitch": { "enabled": true, "threshold": 90, "pollIntervalSec": 300,
                  "cooldownSec": 300, "hysteresisMargin": 10, "strategy": "best",
                  "models": [], "includeApiKeyAccounts": false, "dryRun": false },
  "onboarded": true,
  "demoMode": false,
  "safeMode": false,
  "platform": "windows",
  "paths": { "configHome": "…", "globalConfig": "…", "credentials": "…", "deckHome": "…" },
  "version": "0.1.0",
  "warnings": []
}
```

---

### `switch` (alias `use`)

```
claudedeck switch [target] [--strategy best|next|next-available|consume-first]
                  [--dry-run] [--force] [--reason R] [--slot N] [--json]
```

| Flag | Effect |
|---|---|
| `--strategy` | Rotation strategy when no target is given |
| `--dry-run`, `-n` | Compute the plan and report the writes; touch nothing |
| `--force`, `-f` | Re-activate even when the target is already active |
| `--reason` | `manual` (default), `threshold`, `pace`, `quarantine`, `startup` — recorded on the event |
| `--slot`, `-s` | Alternative to the positional target |

With a target, activates it. Without one, rotates using `--strategy`. Passing
neither is an error, on purpose: `nothing to switch to — pass a target or
--strategy …`.

The target is resolved by the CLI before the call, so slot/email/alias lookup
and its error messages are identical to every other command.

Human output is one line — `switched slot 1 (ada@example.com) -> slot 2
(grace@example.com)`, or `would switch …` for a dry run — followed on stderr by
one `would write <path>` line per planned write.

```json
{
  "schemaVersion": 1,
  "command": "switch",
  "ok": true,
  "switched": true,
  "dryRun": false,
  "from": { "slot": 1, "email": "ada@example.com" },
  "to":   { "slot": 2, "email": "grace@example.com" },
  "reason": "strategy \"best\" chose slot 2 (grace@example.com)",
  "plannedWrites": [],
  "error": null,
  "exitCode": 0
}
```

`plannedWrites` is populated for a dry run and lists the literal paths, in
order, including the advisory lock file and — on macOS — the Keychain item
rather than a credentials file.

---

### `add`

```
claudedeck add [--slot N] [--alias A] [--force] [--token sk-ant-…] [--email E] [--json]
```

| Flag | Effect |
|---|---|
| `--slot`, `-s` | Target slot; the next free slot when omitted |
| `--alias`, `-a` | Short handle, usable anywhere a slot number is |
| `--force`, `-f` | Overwrite an occupied slot |
| `--token` | Register a raw token instead of capturing the current login |
| `--email` | Label override, needed for API keys |

Without `--token`, captures whatever Claude Code is **currently logged in as**,
reading both the credential store and the email address from the global config.
Log in with the next account and run it again to add another.

With `--token`:

- `sk-ant-oat…` is an OAuth setup token (as produced by `claude setup-token`).
  ClaudeDeck looks the email up from the profile endpoint, so `--email` is
  optional.
- `sk-ant-api…` is a managed API key. **No network call is made**, so pass
  `--email` if you want a meaningful label. API-key accounts have no
  subscription quota: they report no usage and are never treated as rate
  limited.

The token value is never echoed — not in the human output, not in the JSON.

> `add` ignores positional arguments. `claudedeck add 3` does **not** mean slot
> 3; use `--slot 3`.

```json
{ "schemaVersion": 1, "command": "add", "ok": true,
  "account": { "slot": 3, "email": "linus@example.com", "alias": null,
               "kind": "oauth", "active": false, "disabled": false } }
```

---

### `remove` (alias `rm`)

```
claudedeck remove <target> [--json]
```

Stops managing an account and deletes its stored credential from the vault. The
slot is left empty rather than renumbered — slot numbers are stable identities.

If the removed account was the active one, a warning notes that Claude Code
still holds its credentials.

```json
{ "schemaVersion": 1, "command": "remove", "ok": true,
  "removed": { "slot": 3, "email": "linus@example.com", "alias": null,
               "kind": "oauth", "active": false, "disabled": false } }
```

---

### `alias`

```
claudedeck alias <target> <name>
claudedeck alias <target> --unset
```

Names a slot. The alias then works anywhere a slot number does. Passing both a
name and `--unset` is an error.

```json
{ "schemaVersion": 1, "command": "alias", "ok": true, "account": { "…": "account reference" } }
```

---

### `enable` / `disable`

```
claudedeck disable <target> [--json]
claudedeck enable  <target> [--json]
```

`disable` holds an account out of auto-rotation while keeping it fully managed —
it stays a valid explicit `switch` target and keeps polling. `enable` puts it
back.

The JSON `command` field is `"enable"` or `"disable"` accordingly, with an
`account` reference.

---

### `auto`

```
claudedeck auto [--once] [--threshold N] [--strategy S] [--dry-run]
                [--interval SEC] [--json]
```

| Flag | Effect |
|---|---|
| `--once` | Evaluate the rule a single time, report, and exit `0`/`1`/`2`/`3` |
| `--threshold` | Utilization percent that triggers a switch (0–100). Defaults to the stored setting |
| `--strategy` | Override the stored strategy for this run |
| `--dry-run`, `-n` | Decide and log, never switch |
| `--interval` | Seconds between polls in the fallback loop |

**`--once`** refreshes usage, looks at the binding window of the active account,
and switches only when it is at or past the threshold. It decides *whether*, not
*where* — candidate ranking stays in the shared engine. Special cases: an
API-key or `no-quota` account exits `2` ("no subscription quota to track"); no
usage data at all exits `2` and holds; no managed accounts exits `1`.

This is the form for cron and systemd timers:

```bash
*/5 * * * * claudedeck auto --once --json >> ~/.claudedeck-auto.log 2>&1
```

```json
{
  "schemaVersion": 1, "command": "auto", "ok": true, "once": true,
  "action": "switch",
  "message": "slot 2 at 91% on 5h; switched slot 2 (…) -> slot 1 (…)",
  "threshold": 90,
  "dryRun": false,
  "active": { "slot": 2, "email": "grace@example.com", "pct": 91.2, "window": "5h" },
  "switch": { "…": "the switch object above, or null" },
  "warnings": [],
  "exitCode": 0
}
```

`action` is the event kind: `poll`, `switch`, `no-switch`, `blocked`,
`account-quarantined`, `all-exhausted`, or `error`.

**Without `--once`** it runs until `Ctrl+C`, emitting one event per line. Two
modes, chosen automatically:

- *Engine mode* (the default): starts the main-process auto-switcher, which owns
  the adaptive cadence, the cooldown and the hysteresis margin, and streams its
  events. Requires at least two accounts; safe mode requires the stored config
  to be in dry-run.
- *Fallback loop*: used when any of `--threshold`, `--strategy`, `--dry-run` or
  `--interval` is given, so a CLI-only override never mutates your stored
  settings. Same rule as `--once`, on a timer.

Streaming lines look like:

```json
{"schemaVersion":1,"command":"auto","kind":"switch","ts":1774000000000,"message":"…","slot":1,"detail":{"trigger":"…","threshold":90,"strategy":"best","dryRun":false}}
```

---

### `history`

```
claudedeck history [--slot N] [--since 24h] [--until 1h] [--json]
```

| Flag | Effect |
|---|---|
| `--slot` | Restrict to one slot. **Numeric only** here — email and alias are not accepted |
| `--since` | Lower bound, inclusive. Default `24h` |
| `--until` | Upper bound, inclusive |

`--since` and `--until` accept a relative duration (`30m`, `12h`, `7d`, `2w`,
also `s`), an ISO-8601 date, or epoch milliseconds (10+ digits).

Human output is a table of `TIME`, `SLOT` and up to six window columns (`5H` and
`7D` lead; per-model windows follow in a stable order), capped at the most
recent 50 rows with a note pointing at `--json` for everything.

```json
{ "schemaVersion": 1, "command": "history", "ok": true,
  "slot": 2, "since": 1773900000000, "until": null, "count": 72,
  "points": [ { "t": 1773900000000, "slot": 2, "windows": { "5h": 34.2, "7d": 61.5 } } ] }
```

A range wider than the store's point cap is downsampled before it is returned.

---

### `forecast`

```
claudedeck forecast [slot|--slot N] [--json]
```

Burn rate, pace and projected exhaustion for each of an account's windows. With
no slot it uses the active account, and errors if there is none.

Human output columns: `WINDOW`, `BURN/H` (utilization points per hour),
`SAMPLES`, `CONFIDENCE`, `PACE` (`on pace` / `ahead (expected N%)`) and
`EXHAUSTS`. Any fit below 40% confidence triggers a warning that low-confidence
fits are guesses, not predictions.

```json
{ "schemaVersion": 1, "command": "forecast", "ok": true, "slot": 2,
  "forecasts": [
    { "windowKey": "5h",
      "burn": { "pctPerHour": 11.9, "samples": 14, "confidence": 0.72 },
      "exhaustionAt": "2026-08-24T18:02:11.000Z",
      "lastsToReset": false,
      "expectedPct": 48.0,
      "aheadOfPace": true }
  ] }
```

`exhaustionAt` is `null` whenever the numbers do not support naming an instant.
Treat it as an estimate; `confidence` travels with it for that reason.

---

### `export`

```
claudedeck export [--slot N] [--full] [--force] [--json]
```

| Flag | Effect |
|---|---|
| `--slot` | Export one account instead of all |
| `--full` | Include the complete credential object, not just the account's own login |
| `--force` | Allow `--full` output to a terminal |

Writes a transfer payload to stdout. **It is plaintext JSON containing live
credentials** and carries a `warning` field saying so.

`--full` refuses to print to a TTY without `--force`; redirect it to a file
instead. This is the one place the CLI second-guesses the operator.

```bash
claudedeck export > accounts.json
claudedeck export --full > backup.json      # same-machine backup
claudedeck export --full --force | gpg -c > backup.gpg
```

With `--json` the payload is returned as a **string** inside the document:

```json
{ "schemaVersion": 1, "command": "export", "ok": true,
  "full": false, "slot": null, "payload": "{\n  \"format\": \"claudedeck.accounts\", … }" }
```

---

### `import`

```
claudedeck import <file|-> [--force] [--json]
```

Reads a payload produced by `export`; `-` reads stdin. Existing slots are kept
unless `--force`. One bad entry does not discard the ones that imported — the
command only fails when nothing could be imported.

```json
{ "schemaVersion": 1, "command": "import", "ok": true, "count": 2,
  "accounts": [ { "…": "account reference" } ] }
```

---

### `gui`

```
claudedeck gui [--json]
```

Starts the desktop window as a detached child process and returns immediately.
Any positional arguments are forwarded to the app. Fails with `the Electron
runtime is not installed alongside this CLI` when it cannot find one.

```json
{ "schemaVersion": 1, "command": "gui", "ok": true, "pid": 12345, "appRoot": "…" }
```

---

### `help` / `version`

```
claudedeck help [command]
claudedeck version        # also: claudedeck --version, claudedeck -v
```

`claudedeck <command> --help` prints that command's usage and exits `0`. Both
commands run without starting the service layer.

```json
{ "schemaVersion": 1, "command": "version", "ok": true, "version": "0.1.0" }
```

---

## JSON object reference

### Account object (`list`, `status`)

```json
{
  "slot": 2,
  "email": "grace@example.com",
  "alias": "grace",
  "kind": "oauth",
  "active": true,
  "disabled": false,
  "usageStatus": "ok",
  "usage": {
    "fiveHour": { "key": "5h", "label": "5-hour", "pct": 78.4,
                  "resetsAt": "2026-08-24T23:29:59Z", "resetsInSec": 32399 },
    "sevenDay": { "…": "same shape, or null" },
    "scoped":   [ { "…": "same shape, per-model weekly windows" } ],
    "spend": { "used": 12.34, "limit": 50, "pct": 24.7,
               "currency": "USD", "resetsAt": "…" },
    "fetchedAt": 1774000000000,
    "stale": false
  },
  "headroom": { "remaining": 21.6, "bindingWindow": "5h" },
  "tokenExpiresAt": 1774003600000,
  "quarantinedAt": null,
  "quarantineReason": null,
  "identity": { "emailAddress": "…", "accountUuid": "…",
                "organizationUuid": "…", "organizationName": "…" },
  "addedAt": 1770000000000
}
```

Notes:

- `usage` falls back to the last snapshot good enough to display, with
  `stale: true` once it is older than 10 minutes. It is `null` only when the
  account has never been polled successfully.
- `resetsInSec` is derived at print time and is never negative.
- `spend` amounts are already converted from the API's cents.
- `headroom` is `100 - max(pct)` over the windows that actually gate the
  account, which includes per-model windows only when they are listed in
  `autoswitch.models`.
- `usageStatus` is one of `ok`, `unavailable`, `token-expired`, `rate-limited`,
  `quarantined`, `no-quota`.
- `kind` is `oauth`, `setup-token` or `api-key`.

### Account reference (`add`, `remove`, `alias`, `enable`, `disable`, `import`)

```json
{ "slot": 2, "email": "grace@example.com", "alias": "grace",
  "kind": "oauth", "active": true, "disabled": false }
```

### Error document

Emitted on stdout only when `--json` (or `-j`) appears in the argument list. The
human message always goes to stderr regardless.

```json
{ "schemaVersion": 1, "command": "switch", "ok": false,
  "error": "no account matches \"dev\" (have 1:ada, 2:grace)",
  "code": "not-found", "exitCode": 1 }
```

`code` is `null` when the failure carries no machine-readable code. Codes you
may see include `not-found`, `ambiguous`, `unsafe-output`,
`services-unavailable`, `contract-drift`, `safe-mode`, `not-signed-in`,
`no-identity`, `bad-token`, `bad-payload`, `no-credentials`, `import-failed`,
`too-few-accounts` and `lock-timeout`. Treat the list as open.

---

## Environment variables

| Variable | Effect |
|---|---|
| `CLAUDE_CONFIG_DIR` | Overrides Claude Code's config home. Read by the path resolver, so the CLI operates on exactly the install Claude Code does |
| `CLAUDEDECK_HOME` | Overrides ClaudeDeck's own data root (vault, settings, history) |
| `CLAUDEDECK_DEBUG=1` | Print the stack trace for an unexpected throw. Expected failures stay one readable line either way |
| `CLAUDEDECK_DEMO=1` | Serve deterministic synthetic accounts and refuse every disk write |
| `CLAUDEDECK_NO_REEXEC=1` | Do not escalate into the Electron runtime. An encrypted vault will then fail to open, by design |
| `NO_COLOR` | Any non-empty value disables ANSI colour |
| `FORCE_COLOR` | Any value other than empty or `0` forces colour on |
| `TERM=dumb` | Disables colour |
| `WT_SESSION`, `TERM_PROGRAM=vscode`, `ConEmuANSI` | Enable Unicode bars on Windows |

`CLAUDEDECK_DEMO=1` works for the CLI as well as the GUI: it swaps in the
synthetic fixture backend and refuses every disk write, which makes
`claudedeck list --json` a safe way to exercise the output format on a machine
with a real login.

---

## Recipes

```bash
# Which account is active, for a shell prompt
claudedeck status --json | jq -r '.active.email // "none"'

# Every account with less than 20% headroom left
claudedeck list --json |
  jq -r '.accounts[] | select(.headroom.remaining < 20) | "\(.slot) \(.email)"'

# Rotate only if it is actually needed, quietly, from a timer
claudedeck auto --once --threshold 85 --json >> ~/.claudedeck-auto.log 2>&1

# What would a switch touch?
claudedeck switch --strategy best --dry-run

# Follow the engine's decisions live
claudedeck auto --json | jq -c 'select(.kind != "poll")'

# A week of one account's 5h utilization as CSV
claudedeck history --slot 2 --since 7d --json |
  jq -r '.points[] | [.t, .windows["5h"]] | @csv'
```

---

## Known gaps in 0.1.0

- The `bin` path and the build output do not match, and the bundle needs the
  Electron runtime — see [Running it in this build](#running-it-in-this-build).
- **No `move` command.** Reordering slots exists in `DeckApi` and in the
  Accounts view, but the CLI does not expose it.
- **No `config` command.** Settings are edited in the GUI or by hand in
  `<deckHome>/settings.json`; `claudedeck status --json` prints the effective
  `autoswitch` block and the resolved paths.
- **No `map` / `unmap`.** Directory mappings are GUI-only, and nothing at
  runtime acts on them yet.
- **No session mode**, no `tui`, no `purge`, no `upgrade`.
