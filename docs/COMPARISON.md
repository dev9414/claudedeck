# ClaudeDeck and claude-swap

[claude-swap](https://github.com/realiti4/claude-swap) is the Python project
that mapped this problem first: multi-account switching for Claude Code, quota
tracking, and automatic rotation before a rate limit lands. ClaudeDeck is a
fresh implementation informed by it — not a port, and not a fork. No code was
copied; the protocol facts (file locations, credential shapes, the OAuth and
usage endpoints, the failure modes) are the same because reality is the same.

This page exists so you can pick the right tool, including when that is not this
one. Both projects are MIT-licensed.

*Compared here: claude-swap 0.26.0b1 against ClaudeDeck 0.1.0. claude-swap moves
quickly, so check its README if something below looks out of date.*

---

## At a glance

| | claude-swap | ClaudeDeck |
|---|---|---|
| Language / runtime | Python 3.12+ | TypeScript on Electron (Node 20+ to build) |
| Install | `uv tool install claude-swap`, `pipx install claude-swap` | Build from source, or an unsigned release installer |
| Install footprint | a Python CLI | an Electron desktop app — substantially larger |
| Runtime dependencies | `textual`, `truststore`, `keyring` (Windows, migration only), optional `rumps` | none |
| Primary interface | CLI plus a full-screen terminal TUI (`cswap tui`, `cswap watch`) | Desktop GUI, plus a CLI |
| Works over SSH / headless | Yes | Not the GUI. The CLI does run headless and reads the encrypted vault (it re-execs itself under the Electron runtime to reach OS secure storage), but it is not published to a registry, so there is no one-line install (see [CLI.md](CLI.md)) |
| Tray / menu bar | macOS menu bar, as an optional extra | System tray on Windows, macOS and Linux |
| Usage display | current percentages, with an age marker on cached numbers | current percentages **plus** recorded history and charts |
| Recorded history | not persisted as a time series | NDJSON time series, one file per UTC day, with a retention setting |
| Forecasting | pace and projection fields in `--json`, deliberately kept out of the human views | least-squares burn rate, projection cone and pace, charted and labelled as an estimate |
| Credentials at rest, Windows | file-based, inside the backup directory | encrypted with DPAPI via Electron `safeStorage` |
| Credentials at rest, Linux/WSL | file-based, mode `0600` | encrypted via the desktop secret service, or plaintext with an explicit marker when there is none |
| Credentials at rest, macOS | Keychain | Keychain, through `safeStorage` |
| Before a switch | switches | computes the plan and shows the exact writes; `--dry-run` in the CLI, a confirm step in the GUI |
| Global read-only mode | — | safe mode: every disk write refused |
| Demo / fixture mode | — | `CLAUDEDECK_DEMO=1`, a backend that cannot reach a credential |
| Auto-switch engine | mature: cooldown, hysteresis, adaptive polling, quarantine, per-model windows, four strategies | same rule set, reimplemented; same four strategy names |
| Run accounts in parallel | **`cswap run`, session mode** | not implemented |
| Per-directory account | `cswap map` binds a directory; `cswap run` there uses it | mappings can be recorded, but nothing acts on them yet |
| Settings from the CLI | `cswap config get/set/unset`, validated | GUI, or hand-edit `settings.json` |
| Slot reordering | `cswap move` | GUI only |
| Stashed-credential recovery | `cswap unclaimed`, `--purge` | — |
| Uninstall helper | `cswap purge`, `cswap upgrade` | — |
| Machine-readable output | `--json` on `list`/`status`/`switch`, JSONL from `auto` | `--json` on every command, JSONL from `auto` |
| Exit codes for automation | `0/1/2/3` on `auto --once` | `0/1/2/3` on `auto --once` and on `switch` |
| Update check | checks PyPI | none; no network call other than Anthropic's endpoints |
| Tests | ~1,960 test functions across 37 files | new and much smaller |
| Maturity | in use, long-tested | 0.1.0 |

---

## Where claude-swap is ahead

Read this part before the next one.

**Maturity, by a wide margin.** claude-swap has been through many releases
against real accounts, real Keychains, real 429s and a Windows keyring migration
that had to be got right. Its test suite is roughly 1,960 test functions across
37 files. ClaudeDeck's engine implements the same rules, but it has not been run
against as many real installs, and rules that look identical on paper are not
the same thing as rules that have survived a year of edge cases.

**Session mode.** `cswap run 2` launches Claude Code as a specific account **in
one terminal only**, leaving every other terminal and the VS Code extension on
your default account. Two accounts genuinely work in parallel, each with its own
chat history (or a shared one with `--share-history`), and user-scope MCP servers
mirrored from your default profile. Combined with `cswap map`, a bare `cswap run`
in a mapped repository picks the right account automatically. **ClaudeDeck does
not implement any of this** — it switches the one active login, and its
directory mappings are recorded but currently inert. If parallel accounts are
your workflow, this alone should decide it.

**A mature, complete CLI.** `cswap` covers configuration (`config get/set/unset`
with validation and documented ranges), slot management (`move`), recovery
(`unclaimed`, `--purge`), lifecycle (`upgrade`, `purge`) and a full-screen TUI.
ClaudeDeck's CLI covers the account and switching surface but has no `config`,
no `move`, no `map`, and — in 0.1.0 — a packaging gap that means the `claudedeck`
bin is not yet wired to a runnable file.

**It runs where there is no desktop.** A Python CLI plus a Textual TUI works
over SSH, in a container, on a headless build box. An Electron app does not.
ClaudeDeck's CLI does run headless once the project is built, and it honours
`CLAUDEDECK_DEMO=1` — but it still needs the Electron runtime on disk to open an
encrypted vault, and there is no `pipx install` equivalent, so you clone and
build. For a remote box, claude-swap is still the easier answer.

**Smaller and simpler to install.** `uv tool install claude-swap` versus
downloading an Electron application.

---

## Where ClaudeDeck adds something

Precisely, and only what the code does.

**A real cross-platform GUI, and a tray on all three platforms.** claude-swap's
graphical surface is a macOS-only menu bar extra; its cross-platform interface is
a terminal TUI. ClaudeDeck is a desktop application on Windows, macOS and Linux,
with a system tray on all three. The tray icon is drawn at runtime as a ring
whose fill tracks the active account's remaining headroom, and the tooltip states
the same number in words.

**Recorded usage history, not just the current number.** Every successful poll is
appended to a local NDJSON time series (one file per UTC day, pruned on a
retention setting). That makes questions like "how fast am I actually burning
this week" answerable, and it is what the charts draw. claude-swap shows you
where you are now; ClaudeDeck also shows how you got there.

**Burn-rate forecasting, presented rather than hidden.** claude-swap computes
pace and projection fields and deliberately keeps them in `--json`, on the
grounds that a linear projection is too rough to present as fact. That is a
defensible call, and ClaudeDeck made a different one: it fits a least-squares
burn rate over the current window segment (segmented at reset cliffs, so a
rollover is never averaged into the slope), carries a `confidence` value with
every fit, and renders the projection as a dashed line with a shaded cone that is
labelled an estimate in the legend, the tooltip and the table view. Low-confidence
fits are drawn and described as low confidence. The disagreement is about
presentation, not correctness.

**Encrypted at rest on Windows and Linux.** claude-swap uses the macOS Keychain
on macOS and protected files (`0600`) elsewhere. ClaudeDeck puts every stored
credential through Electron's `safeStorage`: DPAPI on Windows, Keychain on
macOS, the desktop secret service on Linux. Where no secret service exists it
falls back to plaintext and **says so** — in the file (`"plaintext": true`) and
in the Settings UI. It never claims encryption it does not have, and it ships no
home-grown cipher, because a key file next to its own ciphertext is not
protection. See [SECURITY.md](SECURITY.md).

**Switch previews.** Switching means writing to the files Claude Code
authenticates with. `planSwitch()` is a pure function that resolves the target
and returns the literal list of writes a real run would perform, in order,
including the lock file and — on macOS — the Keychain item. The GUI shows that
manifest and asks; the CLI prints it under `--dry-run`. Because the preview and
the real switch share one resolver, they cannot disagree.

**A global safe mode and a structurally safe demo mode.** Safe mode refuses
every disk write in the app, wired once into the dependency graph rather than
remembered at each call site. Demo mode serves deterministic synthetic accounts
from a module that imports nothing from `node:fs`, `electron` or the core
modules, so "it cannot touch your credentials" is a property of the import graph.

**Zero runtime dependencies.** For something that handles authentication tokens,
every dependency is attack surface. The charts are hand-rolled SVG, the CLI has
its own argument parser, and validation is written by hand.

**`--json` everywhere.** claude-swap offers it on `list`, `status` and `switch`;
ClaudeDeck emits a `schemaVersion`-tagged document from every command, and
`switch` carries a scriptable exit code as well as `auto --once`.

---

## Where they agree

Neither project invented these; both arrived at them because the problem
demands them.

- Slots as stable 1-based identities, with aliases usable anywhere a number is.
- Adding an account by capturing whatever Claude Code is currently logged in as,
  and the warning that `/logout` first can revoke the refresh token you were
  about to save.
- Writing through Claude Code's own credential locks so a swap never interleaves
  with a background token refresh.
- Refreshing a target's token before activating it, and quarantining an account
  whose refresh token is permanently dead instead of retrying forever.
- Adaptive polling, so API traffic stays flat however many accounts you manage,
  and backing off after a 429.
- Cooldown plus a hysteresis margin to stop two accounts either side of the
  threshold trading places.
- Never treating an API-key account as rate limited, since it has no
  subscription quota to exhaust.
- The same four strategy names (`best`, `next`, `next-available`,
  `consume-first`) meaning the same things.
- Per-model weekly windows folded into the decision only when you opt in, by the
  API's own `display_name`.
- Plaintext JSON export as the transfer format, with the advice to encrypt it
  yourself if it leaves the machine.
- `0/1/2/3` exit codes for `auto --once`, and JSONL from a streaming `auto`.

---

## Which one

- **You want parallel accounts in different terminals** → claude-swap. Nothing
  in ClaudeDeck does this.
- **You work on a headless box, over SSH, or you live in a terminal** →
  claude-swap.
- **You want the most road-tested switching engine** → claude-swap.
- **You want a graphical dashboard, a tray, and usage history you can look at
  over time** → ClaudeDeck.
- **You are on Windows or Linux and want your stored tokens encrypted at rest**
  → ClaudeDeck.
- **You want to see exactly which files a switch will write before it writes
  them** → ClaudeDeck.
- **You want both** → they read and write the same Claude Code files and neither
  requires a resident daemon, so running both is possible; but they keep separate
  registries, so an account added in one is not visible to the other, and running
  both auto-switchers at once means two engines competing for one active login.
  Pick one to hold the automation.

---

## On the relationship

ClaudeDeck exists because claude-swap showed the problem was solvable and worked
out where the traps are. Reading it saved this project from rediscovering the
Keychain item name, the `oauthAccount` merge behaviour, the `invalid_grant`
death condition, and the fact that credentials must be merged rather than
replaced. That is real prior art and it is credited here, in the README, and in
the commit history.

The implementation is independent. Where the two projects agree it is because
the constraints are shared, not because code moved between them.
