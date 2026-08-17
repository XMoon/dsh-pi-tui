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

## Why there is no catalog probe — and no probe code

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

**Decision: composition probes are REMOVED** (the module and its tests were
deleted). The cold surface is instead read through a **standing scope**:
`agentPresets.standingKeyFor(id)` resolves the preset's standing composition
and returns its `ScopeKey` without creating an Agent, a session or a turn —
so the sessionless catalog read is zero-event by construction. If an
upstream change ever removes `standingKeyFor()`/`snapshot()`, the adapter
degrades (see `src/skill-catalog.ts` and `docs/README.md`): the affected
commands are merely absent, the TUI never fails to start.

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
    → resolveInitialCatalog()          ← cold HUMAN SKILL catalog through the
    → startProcessTui()                  effective preset's STANDING SCOPE
    → registerTuiCommands(runner, skills) ← skills install synchronously
    → first input: global commands + standing skill wrappers
    → the first real session's coordinator refresh swaps in the LIVE
      surface BEFORE the submission is dispatched (ensureSession awaits it)
```

After mount, one `CatalogRefreshCoordinator` owns every refresh:

- **Agent targets** (the bumped chat session generation): the first real
  session, session switches (`/new`, `/fork`, `/sessions`), live `/preset`
  (blank-session recompose) and live `/reload` read the LIVE agent's surface
  (commands + scoped commands + skills, via `readSurfaceCatalog`).
- **Preset targets** (sessionless): `/preset <id>`, an unmasked
  `/preset default <id>`, sessionless `/reload`, and `skills/change`
  notifications read the STANDING skill catalog of the effective preset
  (skills only, via `resolveColdSkillTarget` + `readHumanSkillCatalog`).

Each refresh is an explicit request naming its target; a new request aborts
the active one and only the latest epoch may commit, so a stale standing
result can never replace a live-Agent result. `skills/change` bursts are
coalesced by `CoalescingRefreshGate` — at most two reads per burst, and the
follow-up read always observes the current ownership.

## Modules

| File | Responsibility |
|---|---|
| `src/surface-catalog.ts` | Frozen snapshot types; `readSurfaceCatalog(agent, signal, ctx)` — the LIVE collector (prefetch, first session, switches); scoped-override derivation; `isUserInvocable` filter; detached issues |
| `src/skill-catalog.ts` | The single narrow seam to dsh services (plan appendix B): structural `SkillRegistryLike`/`AgentPresetsLike`, `readHumanSkillCatalog()` (snapshot-first, `list()` fallback, policy filter, freeze), `resolveColdSkillTarget()` (standing → rosterless global → degraded global + notice), `resolveLiveSkillTarget()` |
| `src/skill-catalog-refresh.ts` | `CatalogRefreshCoordinator` (epoch + abort + latest-only commit; target-change transitions; same-target retention; standing degradation notices; dispose cancellation) and `CoalescingRefreshGate` |

## Invariants (never break)

1. **Chat owner invariant** — only resume, `ensureSession()`, `/new`,
   `/fork` and session switches may write `liveHandle`/`liveAgent`. Catalog
   discovery NEVER does.
2. **No discovery Agent or session** — the cold paths only call
   `standingKeyFor()` + `snapshot()`/`list()`; nothing ever calls
   `agents.create()` for a catalog. If a future upstream change removes
   those capabilities, degrade (missing commands), never probe.
3. **No durable side effects from opening the TUI** — the deferred start
   creates no agent and writes no session; the resumed path only READS the
   existing session.
4. **Detached data only** — a snapshot carries command display fields and
   skill name/description, frozen. Never handlers, definitions, skill
   bodies, services, agents, providers, scope keys or locators. Execution
   always re-binds to the live agent (`commands.execute(realAgent, ...)`;
   `loadSkill` re-`get`s and re-checks `isUserInvocable`).
5. **Standing-scope authority** — a cold preset catalog uses the exact
   `ScopeKey` returned by `standingKeyFor()`; the live surface uses the
   agent object. A real Agent's view always replaces the cold snapshot.
6. **Claims** — the completion list IS the advertised set. The dispatch
   captures `wasAdvertised` BEFORE any session creation; an advertised
   command missing from the real session is consumed with an explicit error
   and never sent to the model as a plain message (`shouldConsumeAdvertisedMiss`).
7. **Transitions** — on a target change, scoped previews clear and old
   skill wrappers become `[skill: revalidating]` transition commands whose
   handler re-fetches from the current agent. A submitted skill name can
   never fall through to a plain model message mid-switch; a failed read
   keeps the transitions.
8. **Latest wins** — a stale live session or stale standing result can
   never overwrite a newer catalog (epoch check + lifecycle signal + target
   owner). Cancellation is debug-only.
9. **The first session installs the real catalog before its first
   submission** — `ensureSession()` awaits the coordinator refresh from the
   REAL agent: setup may register dynamic commands/skills, and nothing from
   the standing surface is execution authorization.
10. **Failure totality** — no refresh escapes as an unhandled rejection;
    `/preset`/`/reload` await their attempt and report outcomes; the
    `skills/change` handler routes through `runOwned`.

## Known limitations

- Without `--session`, the first completion list adds preset-scoped
  commands and skills from the STANDING scope only: effective COMMAND
  discovery (including `/plan` and `/compact`) stays out of scope, and a
  custom preset that replaces the host `skills` service with a
  realm-private registry is not addressable cold — the authoritative view
  arrives with the first real session (`serviceFor(agent, 'skills')`).
- `commands.list(undefined)` (the global layer) is an in-process behavior
  isolated in `listGlobalCommands()`; never forward the cast to a remote
  RPC path.

## Diagnostics

`surface catalog prefetched`, `skill catalog standing ready` (cold startup),
`catalog applied` (epoch, source, counts, issues), `catalog unavailable`,
`catalog refresh superseded` (debug), `skills/change subscription
unavailable`. Never log skill content, user input, credentials or provider
secrets; session ids follow the normal diag convention.