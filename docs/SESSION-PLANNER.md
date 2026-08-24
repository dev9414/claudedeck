# Session window planning

Your 5-hour quota window does not start on the hour. It starts when you send
your **first message**. Message at 09:00 and your resets land at 14:00, 19:00,
…; message at 11:00 and they land at 16:00, 21:00, …

That single fact is the whole feature. If a heavy stretch of work would drain a
window mid-flight, an anchor placed *earlier* makes the reset arrive **during**
that stretch instead of after it — so instead of staring at a rate-limit message
until 16:00, the window rolls over at 13:10 and you keep working.

ClaudeDeck learns which hours you actually burn quota in, simulates the day
against that curve, and reports the anchor that costs the fewest blocked
minutes, weighting your peak hours heavier.

> [!IMPORTANT]
> **This schedules *when* you start using your own quota. It does not raise,
> bypass or circumvent any limit.** No limit is increased, no counter is reset,
> nothing is spoofed. The plan is arithmetic over your own recorded usage, and
> the anchor is placed by running the **official `claude` CLI** once with a
> two-character prompt — not by a hand-rolled API call. The window it opens is
> the window you already had; the only thing that changes is what time it
> starts. The anchoring message itself spends a small amount of your own quota,
> which is why it is never automatic unless you switch it on.

---

## Contents

- [The mechanic](#the-mechanic)
- [The worked example](#the-worked-example)
- [Learning your hourly profile](#learning-your-hourly-profile)
- [Simulating the day](#simulating-the-day)
- [Choosing the anchor](#choosing-the-anchor)
- [Several accounts: staggering](#several-accounts-staggering)
- [What the numbers mean](#what-the-numbers-mean)
- [How wrong they can be](#how-wrong-they-can-be)
- [Your hours are an input, not a guess](#your-hours-are-an-input-not-a-guess)
- [Placing an anchor](#placing-an-anchor)
- [Where to find it](#where-to-find-it)
- [Known gaps](#known-gaps)

---

## The mechanic

The 5-hour window is exactly five hours long — `FIVE_HOUR_MS` in
[`src/shared/types.ts`](../src/shared/types.ts), a constant, not a tunable. It
tiles forward from its anchor: anchor, anchor + 5h, anchor + 10h, and so on
while you keep working.

**The assumption, stated plainly:** the window is anchored by first use. That is
the observed behaviour this feature is built on, and it is not documented by
Anthropic as a contract, so treat it as an empirical claim rather than a promise.

**ClaudeDeck does not have to take it on faith, though.** The usage API reports
the 5-hour window's reset instant, so the anchor is *derivable*:

```
anchorAt = resetsAt - 5h
```

That is what `getAnchors()` returns for every account that has a 5-hour window
(`AnchorObservation`), what the Planner view draws as the account's real window,
and what `anchorNow()` reads back after it runs so it reports the boundary the
API actually gave you rather than the moment ClaudeDeck happened to return.
Accounts with no 5-hour window are **omitted** rather than guessed at: an
invented anchor would be indistinguishable from an observed one downstream.

If you ever see a reset that is not five hours after the first message of a
session, the observation wins — the derived anchor is the truth, and the plan is
the thing that was wrong.

---

## The worked example

Suppose you declare **working hours 09:00–18:00** with a **peak of 11:00–14:00**
(mornings are meetings; the real work is that three-hour block), and your
recorded history says you burn roughly:

| Local hour | Utilization gained |
|---|---|
| 09:00–11:00 | ~0 %/h |
| 11:00–14:00 | ~45 %/h |
| 14:00–18:00 | ~12 %/h |

Three ways the day can go:

| First message | Window resets | Runs dry | Blocked minutes | Of those, in peak |
|---|---|---|---|---|
| 11:00 — you start when the crunch starts | 16:00 | 13:13 | **167** | 47 |
| 09:00 — one message at the start of your day | 14:00 | 13:13 | **47** | 47 |
| 08:10 — what the optimiser picks | 13:10 | never | **0** | 0 |

Read the rows against each other:

- **11:00 → resets 16:00.** You hit 100 % at 13:13 and the window will not roll
  over for another 2 h 47 m. Your afternoon is gone.
- **09:00 → resets 14:00.** You hit 100 % at exactly the same instant — nothing
  about your usage changed — but the reset now arrives 47 minutes later instead
  of 167, and the fresh window covers the whole afternoon.
- **08:10 → resets 13:10.** The reset lands *inside* the peak, three minutes
  before the window would have run dry, so the second window absorbs the rest of
  the peak (37.5 points) and the afternoon (48 points) without ever filling.
  Nothing is blocked at all.

Nothing was added to your quota in any row. The same 100 points bought the same
work; only the timing of the boundary moved.

> These figures are arithmetic over an illustrative curve, computed the way
> `simulateFleet` computes them — not a measurement of anyone's account. Your
> plan runs on your own history, and the shape of the answer depends entirely on
> that curve.

---

## Learning your hourly profile

[`src/core/profile.ts`](../src/core/profile.ts) turns recorded history into
`UsageProfile.hourly` — 24 numbers, "utilization points gained during each local
hour on a day that had any activity at all".

The inputs are the history points ClaudeDeck already appends on every successful
poll (`HistoryPoint`), over a **21-day** lookback (`DEFAULT_LOOKBACK_DAYS`),
restricted to the weekdays the day's schedule covers — a Tuesday's routine is
not a Sunday's.

**Only the `5h` window is profiled** (`PLANNER_WINDOW_KEY`). It is the only
window whose anchor you control, so it is the only one worth planning.

### Finding the window boundaries

A delta between two consecutive points is only meaningful *inside* one window;
across a boundary the drop is a reset, not a refund. `boundarySignal()` decides,
in order of how much each signal deserves to be trusted:

| Signal | Test |
|---|---|
| `reset` | Both points report the window's reset instant and they disagree. The reset instant *is* the window's identity, so this is never second-guessed — and an **unchanged** reset instant likewise outranks every heuristic below, even across a long silence. |
| `anchor` | Only one point knows its reset instant. Since the anchor is `resetsAt - 5h`, the other point can still be placed inside or outside that span with certainty. |
| `drop` | Utilization fell by more than 1 point. Monotonic inside a window, so a fall is a rollover; the 1-point slack absorbs API rounding. |
| `gap` | A silence longer than the window itself must contain a boundary. |
| `slot` | Two accounts never share a window. The safety net for a caller that interleaves them. |

`HistoryPoint.resets` is **additive**: points recorded before this feature
existed have no `resets` map at all, so `drop` and `gap` are not fallbacks for
exotic cases — they are how every pre-existing point in your history gets
segmented. Nothing in the planner assumes `resets` is present.

### Attributing a gain to an hour

An interval that straddles 10:50–11:10 says as much about hour 10 as about hour
11, so gains are split pro-rata across the local hours they span. That is what
makes a 5-minute poll cadence and a 30-minute one produce the same curve.

An hour counts only once at least **40 %** of it was observed
(`MIN_HOUR_COVERAGE`), and its gain is then normalized to a full hour — so a
half-watched busy hour is not read as half as busy. Hours no day ever watched
are left out of the mean entirely rather than counted as zero, because "no
evidence" is not "idle".

**Idle days are excluded from the mean deliberately.** Averaging in weekends you
never worked would flatten the curve until every anchor looked equally good,
which is precisely the useless advice this feature exists to avoid.

### Confidence

`UsageProfile.confidence` is one number in 0–1, and it is deliberately
unforgiving:

```
confidence = hoursTerm × (daysTerm + spanTerm) ÷ 2
  hoursTerm = hours-of-day observed / 8      (capped at 1)
  daysTerm  = distinct active days / 5       (capped at 1)
  spanTerm  = observation span / 7 days      (capped at 1)
```

Hours-of-day coverage **multiplies**, because a curve that has never seen your
afternoon cannot plan it. Days and span are averaged instead of multiplied
because they measure nearly the same thing. One busy day lands near **0.15** —
real, but well under the `0.35` (`MIN_ACTIONABLE_CONFIDENCE`) that
`SessionPlan.lowConfidence` is derived from. `samples[]` travels with the curve
so thin data can be *shown* as thin.

### Day one

With no history at all, the plan runs on `flatProfile()` — a flat burn across
your working day, set by `FLAT_PCT_PER_WORKING_HOUR = 25` (one window every four
working hours). It reports `confidence: 0` and all-zero `samples`, so every
surface can see it for the placeholder it is, and the plan says so in words.

It is deliberately heavy enough that anchor placement changes the outcome: a
placeholder so light that nothing is ever blocked would make the planner answer
"it makes no difference" on day one, which is the day it most needs to be
interesting. A *thin* real curve is never thrown away in favour of it — only an
entirely empty one.

---

## Simulating the day

[`src/core/planner.ts`](../src/core/planner.ts) walks the working day in
**5-minute steps** (`STEP_MIN`) and charges each step against whichever account
is in use:

- Windows roll at `anchor + k × 5h`. Crossing a boundary is what a reset *is*:
  accumulated utilization goes back to zero.
- An account is usable only **once anchored** and only while its current window
  has headroom. Using an account before its recommended anchor would *move* that
  anchor, so the simulation is not allowed to cheat by spending capacity the plan
  has not asked for yet.
- Only **working** minutes are simulated. An anchor placed before work starts
  therefore consumes nothing until work starts — the anchoring message itself is
  a sliver far below the resolution of anything predictable, so it is modelled as
  free.
- Exhaustion is interpolated *inside* the step it happens in, so the reported
  instant is `12:58` rather than `13:00`.
- The last step of an odd-length working day is charged short, so no minute
  outside your own hours is ever invented.

Everything is pure. `now` never appears; the day arrives as `dayStartMs` plus a
`tzOffsetMin`, and nothing is random — the same input always produces the same
plan, so the UI can render it without it shifting under you.

A peak that falls partly outside working hours is **clamped** to the overlap. A
peak that does not overlap at all (a night shift, a peak someone typed the wrong
way round) is **dropped** rather than relocated, and the plan says so: inventing
a peak inside working hours would be presenting a guess as the user's own
setting. Scoring then falls back to plain blocked working minutes.

---

## Choosing the anchor

**The score.** Lower is better:

```
cost = blockedWorkMin + peakWeight × blockedPeakMin
```

`peakWeight` defaults to **3** — a blocked peak minute hurts three times as much
as a blocked working minute. It is clamped to a sane range, because a missing or
absurd value must not silently disable the peak protection you configured.

**The candidates.** Every anchor 5 minutes apart, from **6 hours** before work
starts (`ANCHOR_LOOKBACK_MIN`, more than a whole window, so every phase of the
window relative to your day is reachable) to the end of your peak, clamped to the
planned day. Later anchors than that are strictly worse — they withhold an
account through the very hours the plan is protecting. That is roughly 150–250
candidates, so the search is exhaustive rather than clever.

**The search.** With one account, trying every candidate *is* the exhaustive
answer. With several, `optimizeAnchors()` runs coordinate descent: start every
account at the baseline, then re-optimise one account exhaustively with the
others held fixed, repeating until a pass stops improving or **8 passes**
(`DEFAULT_MAX_PASSES`) are spent. Candidates ascend, ties resolve one way, and
`Math.random` appears nowhere, so the result is deterministic.

**Ties resolve toward the later anchor.** A plan that asks you to start earlier
than the numbers require is a worse plan, however equal its score.

**The plan has to beat "just start working".** The baseline — every account
anchored at the start of your working day — is simulated too, and when nothing
beats it *the recommendation is the baseline* and the rationale says so. This
matters more than it sounds: with a flat or empty curve nothing is ever blocked,
every anchor ties, and a planner that resolved that tie into advice would be
telling you to get up early for nothing.

---

## Several accounts: staggering

The simulation models the rotation the app already performs: one account in use
at a time, sticky, and when its window is spent the next account with headroom
takes over.

**You are blocked only when every account is spent.** That is the right model
because it is what actually happens — ClaudeDeck's auto-switch moves you to an
account with room, so a single exhausted window is an inconvenience, not a stop.
Scoring per-account exhaustion instead would report you as blocked while you were
still working.

It is also what makes staggering worth anything. With every anchor identical,
every account resets at the same instant and the fleet has one shape instead of
several; spread the anchors and the resets interleave, so a fresh window arrives
during the stretch where the previous one ran out.

Two consequences worth knowing:

- Accounts are charged against the **same fleet-wide demand curve**, not
  per-account curves. Whichever account is active absorbs the whole day's demand,
  so a per-account curve would model a split that never happens.
- Because being blocked is a fleet property, **every `AccountPlan.outcome`
  reports the same `blockedWorkMin`, `blockedPeakMin` and `cost`**. Per-account
  detail lives in `outcome.windows[]`, where each `WindowSpan` carries its own
  `endPct`, `exhaustedAt` and the blocked minutes that fell inside it. The CLI's
  `STALL` column sums that, not the fleet total.

Only accounts that can actually be planned are included: API keys (no
subscription window), disabled slots and quarantined slots are left out.

---

## What the numbers mean

| Field | Meaning |
|---|---|
| `UsageProfile.hourly[h]` | Mean utilization **points** gained during local hour `h`, on days with any activity. 100 points is one full 5-hour window. |
| `UsageProfile.samples[h]` | How many observations back that hour. Zero means the hour was never watched. |
| `UsageProfile.confidence` | 0–1, as derived above. Below 0.35 the plan is flagged `lowConfidence`. |
| `WindowSpan.endPct` | Simulated utilization when that window closed. May exceed 100 — demand does not stop arriving because a window filled. |
| `WindowSpan.exhaustedAt` | Interpolated instant the window hit 100 %, or `null` if it never did. |
| `WindowSpan.blockedMin` | Minutes of the stall that this window was live for. |
| `PlanOutcome.blockedWorkMin` | Fleet-wide blocked minutes inside working hours. |
| `PlanOutcome.blockedPeakMin` | The subset of those inside your (clamped) peak. |
| `PlanOutcome.cost` | `blockedWorkMin + peakWeight × blockedPeakMin`. |
| `SessionPlan.peakMinutesSaved` | Blocked peak minutes the plan avoids versus the baseline. Legitimately **0** — sometimes the win is in working minutes, and the rationale reports that instead. |
| `SessionPlan.lowConfidence` | The history is too thin to act on. |
| `SessionPlan.usingDefaultSchedule` | The hours are ClaudeDeck's guess, not yours. |

The last two are **separate flags on purpose**. Your history can be excellent
and your hours still be invented, and collapsing both into one "roughly" would
hide which one you can fix.

---

## How wrong they can be

Every number above is a projection of your own past onto a day that has not
happened. Specifically:

- **The curve is a mean.** A day twice as heavy as your average blows straight
  through the plan; a quiet day makes it moot.
- **Thin history is thin.** One observed afternoon scores about 0.15 confidence
  and is labelled as a guess. It is still better than a generic assumption, but
  it is not a measurement.
- **Utilization is not a clock.** Points accrue from what you actually send —
  long contexts, big tool outputs, a different model — so an hour that averaged
  12 %/h can cost 40 % today.
- **The plan cannot see your calendar.** It knows the hours you declared and the
  quota you burned, not the meeting that just moved.
- **Poll cadence bounds resolution.** Gains are attributed pro-rata across hours,
  but an hour nobody watched for at least 40 % of its length is not modelled at
  all.
- **Only the 5-hour window is modelled.** The 7-day window and per-model weekly
  windows are not simulated, and neither is extra-usage spend. A plan can look
  perfect while a weekly cap is the thing that actually stops you — watch the
  Dashboard for that.
- **The simulation assumes rotation happens.** It models the sticky handover the
  auto-switcher performs. If auto-switch is off and you do not switch by hand,
  the real day has fewer accounts in it than the plan did.
- **One day at a time.** `planDay` plans exactly the local day you asked for.
  Windows that spill past midnight are simulated, but tomorrow is not.
- **DST and travel move the grid.** A day is planned in one local offset; the
  local hour is derived from that offset, not from wherever you land next week.

Where the plan cannot be trusted, it says so rather than rounding up to
confidence: `lowConfidence`, `usingDefaultSchedule`, `samples[]`, and prose in
`rationale` that names the specific reason.

---

## Your hours are an input, not a guess

The one thing ClaudeDeck will not infer is when your day matters. A burst of 3 am
commits does not mean 3 am is when you *want* capacity — it might be the one
night you were firefighting. So the schedule is declared, in
[`src/core/schedule.ts`](../src/core/schedule.ts) terms:

```ts
{
  label: 'Weekdays',
  days: [1, 2, 3, 4, 5],        // 0 = Sunday, matching Date#getDay
  work: { start: 540, end: 1080 },  // minutes from local midnight: 09:00-18:00
  peak: { start: 600, end: 780 },   // 10:00-13:00
}
```

Several schedules can coexist (weekdays plus a different Saturday) and the
**first** one matching the day wins, so a specific day can sit in front of a
general one. A span whose `end` is at or before its `start` runs past midnight,
which is how a night shift is expressed. `validateSchedule()` reports problems in
the words of the person who typed them, and the editor is shared between the
Planner view and the onboarding wizard so both agree.

Until you save your own hours, `PlannerConfig.configured` stays `false`, the plan
carries `usingDefaultSchedule: true`, and every surface says the hours are
ClaudeDeck's invention. The default is deliberately ordinary — weekdays
09:00–18:00, peak 10:00–13:00 — because a default that looks like a guess is
better than one that looks like a finding. A day no schedule covers is still
planned, against your first schedule, and reported as not your hours.

### The settings block

`Settings.planner` (defaults from `DEFAULT_PLANNER`):

| Field | Default | What it does |
|---|---|---|
| `enabled` | `false` | Computes and shows advice. Nothing is sent. |
| `schedules` | one default | Your declared hours. |
| `configured` | `false` | True once you save your own. |
| `peakWeight` | `3` | How many times heavier a blocked peak minute counts. |
| `remind` | `true` | Notify when a recommended anchor time arrives. |
| `remindLeadMin` | `10` | Minutes of warning first. |
| `autoAnchor` | `false` | Place the anchor automatically. |
| `anchorPrompt` | `'hi'` | The throwaway prompt. Two characters: enough to open the window, too little to be worth billing. Capped at 200 characters. |

`enabled` and `autoAnchor` are two switches rather than one because they cost
different things: the first only computes advice, the second sends a real message
that spends a slice of your own quota. Nobody should discover the second by
turning on the first.

**What is configuration and what is behaviour, as of 0.1.0.** `remind` /
`remindLeadMin` are implemented by `notifications.anchorDue()` — it fires
`remindLeadMin` ahead of a recommended anchor, at most once per (slot, anchor)
pair, and gives up 30 minutes after the anchor has passed. `autoAnchor` is
stored, range-checked and shown, but **no code path places an anchor for you**:
every anchor in this version is placed by you, from the Planner view or
`claudedeck anchor`. If you switch `autoAnchor` on and nothing happens, that is
why.

---

## Placing an anchor

An anchor is placed by **running the real client**:

```
claude -p "<anchorPrompt>"
```

That is `defaultAnchorRunner()` in [`src/main/services.ts`](../src/main/services.ts),
and it is the only place in ClaudeDeck that starts a child process. Why the
official CLI rather than an HTTP call: a hand-rolled request would need a token
in the app's own process and would anchor the window of whatever credential it
happened to send. The official client already holds the login, already refreshes
it, and already is what your quota is measured against.

What `anchorNow(slot)` does, in order:

1. **Refuses in safe mode** — the global read-only guard covers this too.
2. **Refuses an API key** (no 5-hour window to anchor) or a quarantined slot
   (it could not send the message anyway).
3. **Activates the target account first** if it is not already active. The CLI
   reads Claude Code's own credential file, so anchoring *this* account means
   making it the active one — nothing else can aim the CLI at a particular login.
4. **Sanitizes the prompt.** On Windows the `claude` on `PATH` is normally a
   `.cmd` shim, which only `cmd.exe` can execute, so a prompt carrying `"` or `&`
   could otherwise become a second command. Characters a shell might reinterpret
   are dropped rather than escaped across three platforms — the prompt is a
   throwaway greeting and nothing else.
5. **Looks `claude` up on `PATH` explicitly**, so "not installed" is an
   actionable answer instead of a bare errno (and so `claude.cmd` is found on
   Windows at all).
6. **Runs it with a 90-second ceiling.** A one-word prompt answers in seconds;
   the ceiling only stops a wedged child from pinning the main process. A timeout
   is reported as "the window may still have been anchored — check the reset
   time", because it may well have been.
7. **Re-polls and reads the boundary back**, reporting
   `anchoredAt = resetsAt - 5h` rather than the moment the call happened to
   return.

`AnchorResult.command` is the command as run, for the log. It never contains a
token: the prompt is scrubbed on the way out, and no credential is ever part of
the argv.

---

## Where to find it

**In the app.** The **Planner** view: the mechanic explained, the schedule
editor, your learned hourly curve, the simulated day next to the same day with no
plan at all, and an *Anchor now* button per account behind a confirm step. Both
doubts — `lowConfidence` and `usingDefaultSchedule` — are surfaced separately.

**On the command line** (full reference in [docs/CLI.md](CLI.md)):

```bash
claudedeck plan                      # today: anchors, cost, and the reasoning
claudedeck plan --day 2026-08-24 --json
claudedeck anchor 2 --dry-run        # what it would run, without running it
claudedeck anchor 2                  # 0 anchored, 1 failed, 2 nothing to do
```

`claudedeck anchor` exits `2` when there is nothing to do — the account already
has a window open (`resetsAt - 5h` is in the past and the reset is in the future,
so the anchor is already placed and a second message cannot move it), or it has
no 5-hour window at all.

**Over IPC** ([`src/shared/ipc.ts`](../src/shared/ipc.ts)):

| Method | Returns |
|---|---|
| `getSessionPlan(day?)` | `Result<SessionPlan>` for a local day; today when omitted. `bad-day` for anything that is not a calendar day. |
| `getUsageProfile(slot?)` | `Result<UsageProfile>` — what was *learned*, never the flat placeholder, because drawing an invented curve as "your usage" would be a chart that lies. |
| `getAnchors()` | `AnchorObservation[]`, derived from `resetsAt - 5h`. |
| `anchorNow(slot)` | `AnchorResult`. Sends a real message. |

**The code.** [`src/core/profile.ts`](../src/core/profile.ts) learns the curve,
[`src/core/planner.ts`](../src/core/planner.ts) simulates and optimises,
[`src/core/schedule.ts`](../src/core/schedule.ts) owns the hours. All three are
pure: I/O, the clock and the timezone arrive as parameters, which is why the same
engine runs behind the GUI and the CLI and why it is testable at an arbitrary
instant in an arbitrary zone.

---

## Known gaps

- **Only the 5-hour window is planned.** The 7-day and per-model weekly windows,
  and extra-usage spend, are not simulated at all.
- **One day at a time.** There is no week view, and no plan that reasons about
  what today's anchor does to tomorrow.
- **`claudedeck plan` has no per-account filter.** It plans the fleet; `--slot`
  is not accepted.
- **Re-anchoring is not possible, by design.** While a window is open its anchor
  is already placed, so `anchor` declines with exit code `2` instead of spending
  quota to no effect.
- **No verification pass.** After anchoring, ClaudeDeck reads the boundary back
  once. It does not later check that the window you were told about is the window
  you got, beyond the anchor being re-derived on every poll.
- **`autoAnchor` is not implemented.** The setting exists and is validated;
  nothing acts on it. Anchors are placed only when you ask, and there is no CLI
  surface for `remind` / `remindLeadMin` either.
