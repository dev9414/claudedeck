## What this changes

<!-- One paragraph. What behaviour is different after this lands, and why. -->

Fixes #

## How it was verified

<!--
Say what you actually ran, not what you intended to run. If a change touches
switching, credentials, or the auto-switch engine, "the types compile" is not
verification - that code decides which account someone's next Claude Code
session bills to.
-->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] Exercised by hand in the app (say which view, and on which OS)

## Safety

ClaudeDeck holds live OAuth tokens for other people's accounts. Every box below
is a rule from the build brief, not a nicety.

- [ ] No token, refresh token, or API key is logged, printed, thrown in an
      error message, or written anywhere unencrypted. Secrets that must appear
      in output go through `fingerprint()` from `src/core/redact.ts`.
- [ ] The diff, its tests, and any screenshot attached below contain no real
      credential and no real account email.
- [ ] No test reads or writes the developer's own `~/.claude`. Tests point at a
      temp directory through the injected path resolver.
- [ ] Every new disk write goes through the helper that honours
      `settings.safeMode` and refuses when it is on.
- [ ] No new runtime dependency. (Dev and test dependencies are fine.)

## Scope

- [ ] Domain types that changed live in `src/shared/types.ts`; no parallel type
      was defined locally.
- [ ] New main/renderer surface area is declared in `src/shared/ipc.ts`.
- [ ] Documentation was updated if behaviour a user can see has changed.

## Screenshots

<!--
Required for anything visible. Both themes, please - the token set resolves
differently under `[data-theme]`, and light mode is where contrast bugs hide.
Regenerate the README set with `npm run screenshots`.
-->
