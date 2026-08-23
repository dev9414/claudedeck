# Security

ClaudeDeck holds OAuth refresh tokens for Claude accounts. That is credential
material, so this document states the posture plainly, including the parts that
are weaker than you might hope.

> **ClaudeDeck is an unofficial community project.** It is not affiliated with,
> endorsed by, or supported by Anthropic. It manages accounts you already own
> and are already logged into; it does not create accounts, bypass rate limits,
> or circumvent any control. **You are responsible for using it in line with
> Anthropic's terms of service.** If your organisation's policy forbids storing
> tokens outside Claude Code itself, ClaudeDeck is not for you.

Everything below describes 0.1.0 and is checkable against the source; file
references are given so you do not have to take any of it on trust.

---

## What ClaudeDeck stores, and where

`<deckHome>` is `%APPDATA%\ClaudeDeck` on Windows,
`~/Library/Application Support/ClaudeDeck` on macOS, and
`${XDG_DATA_HOME:-~/.local/share}/claudedeck` on Linux and WSL.
`CLAUDEDECK_HOME` overrides it.

| File | Contents | At rest |
|---|---|---|
| `<deckHome>/vault.json` | The account registry: slot, email, alias, identity, quarantine state, **and each account's credential blob** (`accessToken`, `refreshToken`, `expiresAt`, scopes) | Encrypted with the OS secret service; falls back to plaintext **only** when there is none, and says so in the file |
| `<deckHome>/settings.json` | Preferences: theme, auto-switch config, notification config, retention, safe mode, directory-mapping paths | Plaintext. Contains no credential material |
| `<deckHome>/history/YYYY-MM-DD.ndjson` | Utilization observations: timestamp, slot number, window percentages | Plaintext. No tokens, no email addresses |
| `<deckHome>/window.json` | Window geometry | Plaintext |
| `<target>.claudedeck.lock` | `{pid, host, takenAt}` while a mutation is in flight | Plaintext, transient |

Everything ClaudeDeck writes goes through `atomicWriteText`, which creates the
file with mode `0600` and then renames it into place
(`src/core/credentials.ts`). File modes are advisory on Windows — there, the
protection that matters is DPAPI encryption of the vault payload, not the mode
bits.

ClaudeDeck also **writes into Claude Code's own store** when you switch
accounts. Those files are Claude Code's, in Claude Code's format, and their
protection is whatever Claude Code chose:

- `<configHome>/.credentials.json` on Windows, Linux and WSL — a plaintext file,
  as Claude Code writes it.
- The login Keychain item `Claude Code-credentials` on macOS.
- The `oauthAccount` object inside the global config (`.claude.json` or a legacy
  `.config.json`), which holds the email address, account UUID and organisation
  — no secret.

ClaudeDeck cannot make those safer without breaking Claude Code, which has to be
able to read them.

---

## Encryption at rest

`src/core/vault.ts` writes a versioned envelope:

```json
{
  "format": 1,
  "plaintext": false,
  "encryption": "safeStorage",
  "updatedAt": 1774000000000,
  "payload": "<base64 ciphertext>"
}
```

The cipher is Electron's `safeStorage`, which is:

| Platform | Backend | Key bound to |
|---|---|---|
| Windows | DPAPI | your Windows user account |
| macOS | Keychain | your login keychain |
| Linux | libsecret / kwallet, via the desktop's secret service | your desktop session's keyring |

### The plaintext fallback, stated honestly

If `safeStorage.isEncryptionAvailable()` returns false — a Linux box with no
running secret service, a headless session, some CI containers — ClaudeDeck
writes the payload **in the clear**, under `"plaintext": true` and
`"encryption": "none"`.

That is a deliberate design decision with three parts:

1. **There is no home-grown fallback cipher.** A key file sitting next to the
   ciphertext it protects is theatre. Reporting "not encrypted" is the honest
   answer (`createSafeStorageEncryptor`, `src/main/services.ts`).
2. **The marker is authoritative and never lies in the optimistic direction.**
   The vault reader treats `plaintext: true` as the truth regardless of what the
   `encryption` label says, so a cleartext payload can never be described as
   encrypted. If `safeStorage` claims to be available and then throws during
   encryption, the save **fails with an error** rather than silently downgrading
   to cleartext.
3. **The app surfaces it.** Settings → About probes the vault status and renders
   the actual value: an explicit warning with an icon and words when the vault
   is plaintext, never a colour alone (`src/renderer/views/Settings.tsx`).

Two related behaviours worth knowing:

- A vault that cannot be decrypted (most often one copied from another machine
  or another OS user — DPAPI and Keychain keys do not travel) reports
  `decrypt-failed` and is **never cleared or overwritten**.
- A vault whose `format` is newer than this build understands is refused rather
  than guessed at, so an older ClaudeDeck cannot destroy a newer one's fields.

### macOS caveat: the `security` binary

On macOS, reading and writing Claude Code's own Keychain item shells out to
`/usr/bin/security`. Two details:

- The path is **pinned absolutely**, so a `security` planted earlier on `PATH`
  cannot intercept the secret.
- The value is passed as an argv parameter (hex-encoded via `-X`). Hex defeats a
  casual plaintext scan of the process table and every quoting hazard, but
  **argv is visible to other processes running as the same user** for the
  lifetime of the call. This is inherent to driving `security` as a subprocess.

---

## Token hygiene

The hard rule in this codebase is that a token value never reaches a log line, a
crash report, an IPC event, the renderer, or a terminal.

- **Fingerprints, not values.** `fingerprint(secret)` in `src/core/redact.ts` is
  the first 12 hex characters of a SHA-256 digest — 48 bits. Enough to tell two
  sightings of the same credential apart in a session; useless as a credential
  and far too short to invert usefully.
- **`redact(value)`** renders a secret for human eyes as
  `sk-ant-oat01-…#a1b2c3d4e5f6`. The Anthropic key prefix is kept because it
  carries no entropy and tells the reader which *kind* of credential it is;
  everything else is the fingerprint.
- **`redactObject(o)`** deep-clones a structure, replacing every value under a
  key matching `/token|secret|credential|password/i`. Non-string values under a
  secret key are dropped wholesale rather than walked. Cycles terminate, so
  logging a live state object cannot hang the app.
- **`scrubSecrets(text)`** in `src/main/notifications.ts` is the belt-and-braces
  net: any `sk-ant-…` shape in an error string is replaced with `[redacted]`
  before it reaches a notification body or crosses IPC as an error message.
- **The CLI never echoes a token.** `claudedeck add --token …` passes the value
  straight to the service that stores it; it appears in no output, human or
  JSON. When a command fails, the JSON error document derives its `command`
  field from `argv[0]` only — scanning further could pick up a flag *value* and
  print a secret into the document.
- **`claudedeck export --full` refuses a terminal.** A full export carries
  credential material, so writing it to a TTY requires an explicit `--force`;
  redirecting to a file is the expected path. Either way it warns.

### Where tokens legitimately leave the vault

Exactly two places, both explicit user actions:

1. **A switch** writes the target account's OAuth blob into Claude Code's own
   credential store. That is the entire point of the app.
2. **An export** (`claudedeck export`, or the Accounts view) produces
   **plaintext JSON containing live credentials**. The payload carries a
   `warning` field saying so. Treat an export file exactly like a password:
   encrypt it yourself if it is going to leave the machine (for example
   `claudedeck export --full --force | gpg -c > backup.gpg`).

---

## Electron hardening

`src/main/window.ts`:

- `contextIsolation: true`
- `sandbox: true`
- `nodeIntegration: false`
- `webviewTag: false`
- `setWindowOpenHandler` denies every window the page tries to open; if the URL
  is `http:`, `https:` or `mailto:` it is handed to the system browser instead.
- `will-navigate` is prevented for anything other than the currently loaded URL,
  with the same external-link treatment.

`src/preload/index.ts` exposes **one** object, `window.claudedeck`, whose methods
are generated from `INVOKE_CHANNELS`. No `ipcRenderer`, no `process`, no
`require`, no node builtin crosses into the page. There is no generic "invoke
any channel" escape hatch — a channel that is not in the contract does not
exist.

`src/main/ipc.ts` treats renderer arguments as untrusted even though the
renderer is ours, because it is the one surface a compromised page could reach:

- Every payload is narrowed before it touches a service (`requireNumber`,
  `requireString`, `requireRecord`, …); a bad shape becomes a `bad-request`
  result, not a crash.
- `openExternal` **refuses any non-web URL** — `file:` would open a local
  document and a custom scheme can launch an arbitrary registered handler.
- `revealPath` refuses any path that is not inside `deckHome` or the Claude Code
  config home (or is not one of the two known config files), so the renderer
  cannot use it to browse the disk.
- Errors returned to the renderer pass through `scrubSecrets`.

Process level: `app.requestSingleInstanceLock()` means a second launch raises the
existing window rather than starting a rival process that fights over the same
credential file.

### Known gap: no Content-Security-Policy

`src/renderer/index.html` explains that no CSP meta tag is used and says the
main process sets the real policy on session response headers instead. **As of
0.1.0 nothing sets that header.** The renderer loads only bundled local assets
and makes no network requests of its own, and the sandbox plus context isolation
remain in force, but the defence-in-depth layer a CSP would add is currently
missing. Wiring `session.defaultSession.webRequest.onHeadersReceived` is a
well-scoped contribution.

---

## What ClaudeDeck sends over the network, and to whom

Three endpoints, all Anthropic's, all reached with the account's own credential:

| Call | Endpoint | Why |
|---|---|---|
| Token refresh | `POST https://platform.claude.com/v1/oauth/token` | Renew an expired access token, using the stored refresh token and Claude Code's public OAuth client ID |
| Profile | `GET https://api.anthropic.com/api/oauth/profile` | Resolve which account a setup token belongs to, so you do not have to type the email |
| Usage | `GET https://api.anthropic.com/api/oauth/usage` | The quota percentages the whole app is built on |

That is the complete list (`src/core/oauth.ts`, `src/core/usage.ts`). In
addition, the Onboarding view can open `https://docs.claude.com/…` **in your
system browser** if you click the docs button — that is a user-initiated
external link, not a request ClaudeDeck makes.

There is **no telemetry, no analytics, no crash reporting, no update check, and
no third-party service of any kind.** Not disabled by default — absent. The app
ships with zero runtime dependencies, so there is also no transitive package
that could add one without a visible change to `package.json`.

Requests are made with the platform `fetch`, injected into core as `FetchLike`,
so what the app can reach is auditable in one place.

---

## Integrity controls

Not confidentiality, but they protect you from losing an account:

- **Cross-process advisory locks** (`src/core/locks.ts`) serialise every
  mutation of the live credential store, so a switch cannot land in the middle
  of Claude Code's own background token refresh, and a GUI plus a CLI cannot
  lose each other's updates.
- **Atomic writes** everywhere: readers see either the whole old file or the
  whole new one.
- **Merge, never replace.** Writes into Claude Code's store preserve sibling
  keys such as MCP OAuth state instead of stamping an older snapshot over them.
- **Safe mode** (`Settings → Safe mode`) makes the entire app read-only: every
  disk write is refused with a clear error, wired once into `CoreDeps.writeGuard`
  rather than remembered per call site. Auto-switch will only run in safe mode
  if it is also in dry-run.
- **Demo mode** (`CLAUDEDECK_DEMO=1`, or `npm run demo`) swaps in a backend that
  imports nothing from `node:fs`, `electron` or `@core/*`. It physically cannot
  read or write a credential.
- **Quarantine.** An account whose refresh token is permanently dead
  (`400 invalid_grant`) is marked and skipped rather than retried forever.

---

## Threat model

### Defended against

| Threat | Mitigation |
|---|---|
| A token leaking into a log, a screenshot, an error dialog, a notification or a bug report | Fingerprints and `redact`/`redactObject`/`scrubSecrets`; nothing in the codebase prints a token |
| Another **local user** reading your stored credentials | `safeStorage` binds the vault to your OS account; `0600` file modes where they mean something |
| A compromised or buggy renderer reaching the filesystem | Sandbox, context isolation, a generated preload with no escape hatch, argument narrowing, path-restricted `revealPath`, web-only `openExternal` |
| A malicious `security` binary on `PATH` (macOS) | Absolute path to `/usr/bin/security` |
| Torn or interleaved credential writes corrupting your login | Atomic writes plus cross-process advisory locks |
| Accidentally switching or overwriting the wrong account | `planSwitch` preview of the exact writes, `--dry-run`, and global safe mode |
| A dependency in the supply chain reaching your tokens at runtime | Zero runtime dependencies |

### Explicitly **not** defended against

Be clear-eyed about these:

- **A compromised OS user account.** This is the big one. `safeStorage` is bound
  to your OS login: any process running as you can ask DPAPI, the Keychain or
  the secret service to decrypt the vault, exactly as ClaudeDeck does. Malware
  running as you has already won — and note it would not even need
  ClaudeDeck, since Claude Code's own credentials are readable the same way.
- **Root / Administrator, or physical access to an unlocked machine.**
- **Memory scraping.** Decrypted tokens exist in the main process's heap while
  in use. They are not locked, wiped, or kept out of a core dump.
- **The macOS process table during a Keychain call**, as described above.
- **Export files.** They are plaintext by design. Once you export, protecting
  the file is your job.
- **Anthropic-side controls.** ClaudeDeck cannot make an account do anything the
  account is not allowed to do; it just chooses which of your logins is active.
- **Malicious release binaries.** Release artifacts are **not code-signed**
  (`electron-builder.yml` configures no signing identity), so Windows SmartScreen
  and macOS Gatekeeper will warn. If that matters to you, build from source.
- **Development dependencies.** `npm install` pulls Electron, Vite, React and
  Vitest with their transitive trees. They never ship in the runtime bundle, but
  they do run on your machine when you build.

---

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security problem.**

Use GitHub's private vulnerability reporting:
**[Security → Report a vulnerability](https://github.com/dev9414/claudedeck/security/advisories/new)**.
It opens a private thread visible only to the maintainers, and it works even
before there is a published advisory.

Useful to include:

- the version (`claudedeck --version`, or Settings → About) and your OS;
- what an attacker gains, and what access they need to start;
- the smallest reproduction you can manage;
- any suggested fix, if you have one.

**Never include a real token in a report.** A fingerprint from
`fingerprint(secret)` is enough to correlate, and if you need to show a credential
shape, use an obviously fake one.

What to expect: this is a volunteer community project, not a vendor with a
response team. The maintainers aim to acknowledge a report within a few days and
to keep you updated on a fix. There is no bug bounty. You will be credited in
`CHANGELOG.md` for the release that carries the fix unless you would rather not
be. Please give a reasonable window for a fix before publishing.

If the issue is in **Claude Code itself** or in Anthropic's API rather than in
ClaudeDeck, report it to Anthropic — we will happily help you work out which it
is.

---

## Auditing this yourself

The claims above are small enough to check:

```bash
# Every network call the app can make:
grep -rn "https://" src/ --include=*.ts --include=*.tsx

# Every place a write can happen in core (all of them are guarded):
grep -rn "writeGuard\|atomicWriteText" src/core

# The whole preload surface:
cat src/preload/index.ts

# Runtime dependencies:
node -e "console.log(require('./package.json').dependencies ?? {})"
```
