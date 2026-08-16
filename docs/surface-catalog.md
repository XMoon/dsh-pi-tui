# Surface catalog: commands + skills for the live surface

## The problem

The TUI's command registry is layered: global definitions are visible to
every agent, and definitions registered through an agent-scoped context are
visible only to that agent (they can shadow same-name globals). The skill
catalog is agent-scoped too — `agentPresets.serviceFor(agent, 'skills')` —
and only human-invocable skills may reach a human entry. A cold start with
no `--session` has NO agent, so the first completion list used to be the
global layer only: preset-scoped commands like `/plan` and `/compact`, and
per-skill commands like `/glab`, appeared only after the first real session
was created (and even then through a detached refresh the first input could
beat).

## Why there is no startup catalog probe

The original design ran a short-lived, zero-event **catalog probe** before
the TUI mounted so even the FIRST input saw the full effective catalog. The
M0 gate caught a hard deployment fact: `dsh-permission-presets` (host base,
every preset) listens on `session/created` and unconditionally writes three
durable knob events (`permission/preset`, `sandbox/mode`, `approval/policy`)
into every fresh session. There is no opt-out, no read-only composition
mode, and the 200ms write-behind materializes the probe session to disk
before the TUI can act (verified empirically). Any probe therefore both
fails the zero-event gate and leaves a durable artifact — the "open and
exit leaves nothing" promise cannot hold in this deployment.

**Decision: composition probes are DISABLED.** The probe module
(`catalog-probe.ts`) and the coordinator's composition target remain in the
codebase with their guards and tests, ready to enable when the Host gains an
explicit probe/read-only composition mode. All post-mount refreshes target
LIVE agents only.

## The design

```
--session start:
  loader.await()
    → resolveInitialCatalog()          ← prefetch the resumed agent's catalog
    → startProcessTui()
    → registerTuiCommands(runner, snapshot)   ← one synchronous commit
    → first input sees the full effective catalog

deferred start (no --session):
  loader.await()
    → startProcessTui()                ← global command view only
    → registerTuiCommands(runner)      ← no snapshot (no probe)
    → first input: global completion; the first real session's
      coordinator refresh swaps in the live catalog BEFORE the
      submission is dispatched (ensureSession awaits it)
```

After mount, one `CatalogRefreshCoordinator` owns every refresh: the first
real session, session switches (`/new`, `/fork`, `/sessions`), live
`/preset` (blank-session recompose), and live `/reload`. Each refresh is an
explicit request naming its target (the bumped chat session generation);
a new request aborts the active one and only the latest epoch may commit.

## Modules

| File | Responsibility |
|---|---|
| `src/surface-catalog.ts` | Frozen snapshot types; `readSurfaceCatalog(agent, signal, ctx)` — the ONE collector for prefetch, first session and switches; scoped-override derivation; `isUserInvocable` filter; detached issues |
| `src/catalog-probe.ts` | `probeSurfaceCatalog(...)` — **disabled at every call site** (no startup, `/preset` or `/reload` probe); kept with its zero-event gate and `CatalogProbeError` classification (`create` vs `post-create`) for a future Host probe mode |
| `src/catalog-refresh.ts` | `CatalogRefreshCoordinator`: epoch + abort + latest-only commit; target-change transitions; same-target partial-field retention. Composition targets exist in the type but are not issued by any caller |

## Invariants (never break)

1. **Chat owner invariant** — only resume, `ensureSession()`, `/new`,
   `/fork` and session switches may write `liveHandle`/`liveAgent`. The
   probe never does.
2. **Zero-event gate** — IF a probe ever runs again, its session must hold
   `events.length === 0` before dispose or it FAILS: persistence
   materializes on the first non-empty batch (200ms write-behind) and there
   is no safe TUI-side delete. Never delete artifacts, skip flushes or
   filter events to hide a violation.
3. **No durable side effects from opening the TUI** — the deferred start
   creates no agent and writes no session; the resumed path only READS the
   existing session. This is what makes the probe disablement a loss of
   first-input completeness rather than a correctness regression.
4. **Detached data only** — a snapshot carries command display fields and
   skill name/description, frozen. Never handlers, definitions, skill
   bodies, services, agents or providers. Execution always re-binds to the
   live agent (`commands.execute(realAgent, ...)`; `loadSkill` re-`get`s and
   re-checks `isUserInvocable`).
5. **Claims** — the completion list IS the advertised set. The dispatch
   captures `wasAdvertised` BEFORE any session creation; an advertised
   command missing from the real session is consumed with an explicit error
   and never sent to the model as a plain message (`shouldConsumeAdvertisedMiss`).
6. **Transitions** — on a target change, scoped previews clear and old
   skill wrappers become `[skill: revalidating]` transition commands whose
   handler re-fetches from the current agent. A submitted skill name can
   never fall through to a plain model message mid-switch; a failed read
   keeps the transitions.
7. **Latest wins** — a stale live session result can never overwrite a
   newer catalog (epoch check + lifecycle signal + target owner).
   Cancellation is debug-only.
8. **The first session installs the real catalog before its first
   submission** — `ensureSession()` awaits the coordinator refresh from the
   REAL agent: setup may register dynamic commands/skills, and nothing from
   the sessionless surface is execution authorization.

## Known limitations

- Without `--session`, the first completion list is the global view only;
  preset-scoped commands and skill wrappers arrive with the first real
  session (its coordinator refresh is awaited before the submission
  dispatches, so the first SUBMISSION is never mis-routed — only the first
  COMPLETION is thinner).
- `commands.list(undefined)` (the global layer) is an in-process behavior
  isolated in `listGlobalCommands()`; never forward the cast to a remote
  RPC path.

## Diagnostics

`surface catalog prefetched`, `catalog applied` (epoch, source, counts,
issues), `catalog unavailable`, `catalog refresh superseded` (debug), plus
the probe lifecycle lines when a probe ever runs. Never log skill content,
user input, credentials or provider secrets; session ids follow the normal
diag convention.
