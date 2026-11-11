# Surface catalog: commands, skills and credentials

This document owns command/skill catalog discovery, the standing-scope cold
path, catalog refresh currentness, command-line precedence and the credential
target resolution used by `/login`/`/logout`.

The TUI command registry is layered: global definitions are visible to every
agent, and definitions registered through an agent-scoped context are visible
only to that agent (they can shadow same-name globals). The skill catalog is
agent-scoped too (`agentPresets.serviceFor(agent, 'skills')`), and only
human-invocable skills may reach a human entry. A cold start with no `--session`
has no agent, so the first completion list must still see preset-scoped commands
and human skills without creating an Agent, a session or a turn.

## Cold discovery: the standing scope

There is no catalog probe. A probe session would be created through
`agents.create()` and the base permission preset writes three durable knob
events on `session/created`, so a probe both fails the zero-event gate and
leaves a durable artifact. The cold surface is read through the preset's standing scope. There is no probe
Agent: `agentPresets.acquireScope(id)` returns the preset's retained revision
lease (`{key}`) and the caller releases it after the scoped read completes, so
the composition being read cannot drift mid-read. The location whose skills are
read is explicit: Direct reads its own co-located Host directory
(`co-located-directory`), while the Remote Client sends the confirmed
Host-issued WorkspaceId (`host-workspace`) to the private Host-standing endpoint
and never its own process cwd. A Remote Client without a confirmed Workspace
performs no Host RPC: the read is a local unavailable/incomplete projection
with one explicit selection notice, never a fabricated complete empty catalog.
If an upstream capability disappears, the affected commands are merely absent;
the TUI never fails to start.

```text
--session start:
  loader.await()
    -> resolveInitialCatalog()          (prefetch the resumed agent's catalog)
    -> startProcessTui()
    -> registerTuiCommands(runner, snapshot)   (one synchronous commit)
    -> first input sees the full effective catalog

deferred start (no --session), Direct:
  loader.await()
    -> resolveInitialCatalog()          (cold HUMAN SKILL catalog through the
    -> startProcessTui()                 effective preset's STANDING SCOPE/key)
    -> registerTuiCommands(runner, skills)
    -> first input: global commands + standing skill wrappers
    -> the first real session's coordinator refresh swaps in the LIVE
       surface BEFORE the submission is dispatched (ensureSession awaits it)

deferred start (no --session), Remote:
  mount (no Session)
    -> Host Workspace preflight confirms the launch directory
    -> CatalogRefreshCoordinator preset refresh (Host standing read)
    -> Use directory / Add directory commits a new WorkspaceId
    -> the coordinator refresh is re-issued for that NEW target
```

## Refresh ownership

After mount, one `CatalogRefreshCoordinator` owns every refresh:

- **Agent targets** (the bumped chat session generation): the first real
  session, session switches (`/new`, `/fork`, `/sessions`), live `/preset`
  (blank-session recompose) and live `/reload` read the LIVE agent's surface
  (commands + scoped commands + skills via `readSurfaceCatalog`).
- **Preset targets** (sessionless): `/preset <id>`, an unmasked
  `/preset default <id>`, sessionless `/reload`, the Host Skills invalidation
  notification and the Host Workspace selection/add gestures read the STANDING
  skill catalog of the effective preset. The target identity is
  `(presetId, workspaceId)`: a Remote Client supplies the confirmed
  Host-issued WorkspaceId captured at refresh admission, a Direct Client omits
  it (the backend adapter uses its co-located directory). Changing only the
  Workspace is therefore a TARGET CHANGE: the old wrappers and inline lexicon
  enter the revalidating transition before the new Workspace is read, so a
  same-preset switch never serves the previous Workspace's skills.
- **Remote connection generation**: a new defined generation after reconnect
  triggers one same-Session/same-target refresh (`'invalidation'` source)
  against the session id read at callback time. Capture-before-subscribe makes
  a synchronous subscription-time notification a no-op. While the generation is
  undefined, no catalog RPC is issued and nothing is cleared. A failed
  reconnect reread keeps the last-good provider field and reserved claims; a
  successful reread replaces them. Reconnect is not a Session transition. The
  private Skills invalidation stream re-arms on the same generation change and
  its Host startup frame re-reads the CURRENT target (Live or Sessionless), so
  a Sessionless reconnect also refreshes.

Each refresh is an explicit request naming its target; a new request aborts the
active one and only the latest epoch may commit, so a stale standing result can
never replace a live-Agent result. `skills/change` bursts are coalesced by
`CoalescingRefreshGate` (at most two reads per burst; the follow-up read
observes the current ownership).

## Host-owned standing skills and hot invalidation

Remote Sessionless skill metadata is Host-owned; the Client never scans its own
filesystem for it.

- The private `piTuiSkills/standing` endpoint takes `{presetId?, workspaceId}`.
  The Host resolves `workspaceId` through the official Workspace registry and
  reads the Host canonical path; the Client cwd, a profile directory or an
  implicit "default workspace" is never a substitute, and an unknown/revoked id
  is a Host error rather than an empty success. A missing `workspaceId` is
  refused at the strict wire codec.
- The Host reads `ctx.skills.snapshot({cwd: workspace.path, scope: lease.key,
  signal})` while holding the official `agentPresets.acquireScope(presetId)`
  revision lease, releases it in `finally`, and projects only human-invocable
  metadata (`name`, `description`, `whenToUse`, `modelInvocable`) under the
  official policy, sorted by name. Skill bodies, paths, locators, scope keys,
  provider instances and Host service objects never cross the wire, and
  `complete` is passed through unchanged.
- A Live Session keeps using the official Session-addressed
  `remote.skills.list({sessionId})`; the standing endpoint never guesses a live
  scope, and the Host never sends a Skill body for injection.
- The private `piTuiSkills/watchInvalidations` stream carries only
  `{kind:'invalidated'}`. Every attach starts with one startup frame (the
  subscribe-then-reread barrier); the Host `skills/change` event only sets a
  pending bit that wakes the generator, so bursts coalesce and no sequence,
  timestamp, diff or replay is promised. Abort, Client disposal and Host plugin
  disposal end the stream and release the Host listener.
- The Client maps every frame into the SAME `CoalescingRefreshGate` +
  `CatalogRefreshCoordinator` path as Direct's `skills/change` event. A stream
  failure is reported through the owner's error sink (never silently lost): the
  current catalog stays last-good, the failed stream is never retried on its
  own, and only an explicit owner refresh (`/reload`, a live owner switch or a
  surface rebuild) re-arms the subscription. The subscription disposer runs
  BEFORE the coordinator disposal.
- Owner admission: a Sessionless standing refresh is admitted only while the
  surface owns no Session. `Add directory` remains reachable from a live
  Session Workspace, and a startup preflight can race the first Session
  commit, so both paths re-check the live owner and a standing target can
  never replace the official live `skills.list` catalog.

## Modules

| File | Responsibility |
|---|---|
| `src/domain/catalog/surface.ts` | Neutral frozen snapshot DTOs and the `commandSummaryOf` descriptor→summary projection (shared by the Direct Host read and the Client registry) |
| `src/domain/catalog/skill.ts` | Neutral human-skill vocabulary and the official `isUserInvocableSkill` policy guard |
| `src/runtime/direct/surface-catalog.ts` | Direct effective read: `readSurfaceCatalog(agent, signal, ctx)`, scoped-override derivation, `listGlobalCommands`, structural command-service faces |
| `src/runtime/direct/skill-catalog.ts` | The single narrow seam to DSH services: structural `SkillRegistryLike`/`AgentPresetsLike`, `readHumanSkillCatalog()`, `resolveColdSkillTarget()`, `resolveLiveSkillTarget()` |
| `src/app/direct/initial-catalog.ts` | Pre-mount resolution: resume prefetch or the cold standing-scope skill read, with one-shot degradation notices |
| `src/runtime/catalog-port.ts` | Semantic catalog port + `StandingSkillRead` beside `SkillCatalogCapability` |
| `src/app/command/catalog-refresh.ts` | `CatalogRefreshCoordinator` (epoch + abort + latest-only commit; target transitions; same-target retention; standing degradation notices; dispose cancellation) and `CoalescingRefreshGate` |
| `src/app/host/features/skills.ts` | Host-owned standing read (official Workspace registry + preset lease + `ctx.skills.snapshot`, metadata-only projection) and the private invalidation stream |
| `src/runtime/remote/pi-tui-skills-contract.ts` | Strict private wire contract for `piTuiSkills/standing` and `piTuiSkills/watchInvalidations` (single shared descriptor truth) |
| `src/tui/interaction/autocomplete/skill-reference.ts` | Pure Client-local inline skill-reference grammar (`extractInlineSkillPrefix`, `applyInlineSkillReference`): no Context/Agent/Session/registry/Remote access |
| `src/tui/interaction/autocomplete/provider.ts` | `MentionProvider` inline skill source: prompt-mode routing, fuzzy candidates from the detached `HumanSkillSummary[]`, strict snapshot fence, catalog-guarded apply |

## Skill catalog consumers

The human skill catalog feeds two independent consumers:

1. **Per-skill command wrappers** (`replaceSkillCommands` in `src/commands.ts`):
   each human-invocable skill is a leading slash command with its own
   completion rows, claims and transition behavior. A wrapper never registers
   over a name a genuine Host command owns. The authority is the effective
   winner per name with this surface's own Direct compatibility mirrors
   subtracted by exact `definitionId` provenance (`hostOriginDescriptors`) —
   never the raw Host catalog, which on Direct also carries the mirror this
   surface just registered. A mirror is execution compatibility, never Host
   origin.
2. **Inline skill-reference lexicon** (`currentSkillReferences` in
   `src/commands.ts`, fed into `MentionProvider`): Client-local
   completion/presentation for plain-text `/name` tokens at whitespace
   boundaries in the draft body. It consumes the SAME detached
   `HumanSkillSummary[]`; it never loads a skill body, never authorizes an
   invocation, and is NOT part of command claims. Submission stays an ordinary
   user prompt; the Host `agent/pre-step` gesture is the invocation authority.
   Two FIXED Client-local attachment actions (`image`, `attach`) share this
   inline `/name` seat as their own rows, identified by a structural marker
   rather than by name: a same-named catalog skill stays a DISTINCT row, and
   only the marked action opens the attachment path argument (the skill row
   only inserts text). The action rows bind no catalog authority at all — they
   are a fixed two-entry list owned by the attachment plane, which is why the
   catalog's transition/refresh semantics above apply to the skill rows only.

Transition semantics (mirrors the wrapper rules):

```text
target-changing transition:
  inline skill lexicon clears (no old-owner suggestions for the new owner)

same-target refresh:
  last-good inline lexicon may be retained until a successful replacement
  (a failed/incomplete skills observation never replaces it)
```

`/skill <name>` and per-skill wrappers are agent-facing prompts: they follow the
resolved `queue|steer` mode, build the normalized `/<name> <args>` line, and
inject the body only when the Host loader does not (without a loader, keep the
order-preserving steer even under queue mode). Mode is resolved once at the
submitting gesture boundary; a picker selection is its own boundary; a TUI-owned
skill command with no submission delivers queued. Never re-read busyEnter/agent
status during asynchronous preparation, and never merge wrapper/skill/Host
command precedence.

## Command-line precedence and attachment declaration

The Host catalog is merged with live client contributions by name. A collision
fails loud and removes the whole source group (never shadows, no stale row); the
Host claims are refreshed before merge; a name collision is surfaced once per
identity/generation. Line ownership is line-level (`matchEnter`): the Host
claims the bare token and a `leadingInput` argued line; an argued execute-kind
line is an ordinary submission; a contribution claims only the bare token;
unknown names are ordinary prompts. TUI local commands and skill wrappers keep
their own routes. A final-catalog re-ask follows a deferred `ensureSession()`;
submit-time non-invocation and client-local eligibility are sticky; a deferred
captured contribution is generation-fenced.

A claimed command accepts attachments only when that claiming descriptor
declares `input.attachments: true`:

- declared HOST commands receive images as `CommandSubmitAttachment`s and the
  Host admits them;
- a declared command still refuses FILE attachments (no upload-receipt seam) —
  fail closed;
- command attachments are consumed only on handler success;
- TUI/core local commands and `!`/`!!` refuse attachments;
- `/skill` and plain prompts deliver attachments to the model;
- the policy is re-applied against the FINAL authority after `ensureSession()`.

Authority: `src/domain/command/policy.ts`
(`classifyCommandLine`, `shouldConsumeAdvertisedMiss`,
`commandIsLocalForAttachments`), `src/commands.ts` (`wasAdvertised`,
`hostOriginDescriptors`), `src/app/submission/controller.ts`,
`src/app/command/surface.ts`.

Must-not: execute a same-named contribution when the Host resolves the name;
consume an advertised miss as a plain model message; let a stale displayed row
execute a different command; hand the Host a placeholder with no payload; or
re-derive the declaration from the advertised union.

## Aliases and local ownership

The Settings registrar is the ONLY registration site for both names: it
registers `settings` plus the `status` alias with the SAME handler, input shape
and initial About focus. `/status` is not a second command or a duplicate
handler, and both names are in `LOCAL_COMMANDS` and `SESSIONLESS_COMMANDS`;
`/statusline` remains the independent `/footer` alias. Completion shows the
alias with its `(alias of /settings)` description, while the Host-origin claim
and line-level `classifyCommandLine` precedence still decide argued/Host lines
before the Client route — ownership is never inferred from a name-only union.
The alias registers through the shared `registerTuiCommand` seam, so its Host
compatibility mirror, busy gate and disposal ride the primary's lifecycle.

Authority: `src/tui/commands/settings.ts` (`registerSettings`),
`src/commands.ts` (`registerTuiCommand`), `src/domain/command/policy.ts`
(`LOCAL_COMMANDS`, `SESSIONLESS_COMMANDS`, `classifyCommandLine`).

Must-not: register a second `/status` handler, branch on the command name, drop
`status` from either ownership set, or let the alias steal a genuine Host claim
or argued line.

## Credential targets (`/login` / `/logout`)

`/login` and `/logout` are **navigation** into the Settings `Models` page (or
the `Account` page for `deepseek-account`). They resolve the typed argument
through the ONE shared Auth target resolver and open the workspace at the
resulting destination; they never run a credential operation themselves.

`/login`:

- no argument → the Models list, no automatic login;
- known route (canonical route, label or first word) → that provider's detail
  page; the `deepseek-official` builtin goes to its dedicated API-key reference
  page instead;
- known reference or env-var-looking novel reference → the API-key reference
  page with the exact target ref; an empty answer never writes;
- new valid route pattern → the Add Provider form prefilled with the route;
- `deepseek-account` → the Account page;
- anything else → the unknown-target error listing the valid targets, with no
  workspace opened.

`/logout`:

- no argument → the Models Stored credentials list;
- known reference/route/flow → one explicit clear confirmation for the exact
  reference or stored record (a keyless route with a flow clears its RECORD,
  never the derived reference);
- `deepseek-account` → the Account Sign out confirmation;
- anything else → the unknown-target error.

The final write/clear happens only inside the workspace after an explicit
confirm. The DeepSeek Account authorization flow (`deepseek-account-platform/
default`) is excluded from the generic provider flows and is never cleared
through `credentials.deleteRecord`; the Account page owns its sign-in and
sign-out. Remote cannot enumerate records: state the limitation instead of
reporting an empty store.

Authority: `src/domain/catalog/provider.ts` (`providerOptionsFor`,
`credentialOptionsFor`, `classifyCredentialArg`, `deriveKeyRef`,
`ROUTE_PATTERN`), `src/app/command/credential-workflow.ts`
(`resolveLoginDestination`, `resolveLogoutDestination`,
`genericAuthorizationTargets`), consumed by `src/tui/commands/auth.ts` and the
Settings pages. Host business authority remains in
[host-client.md](./host-client.md).

Must-not: re-derive a typed env name, keep a command-level picker/question/
output-viewer branch, claim stored records were cleaned, present a
provider-native sign-in as available, or offer the Account flow as a generic
provider credential.

## Invariants (never break)

1. **Chat owner invariant** — only resume, `ensureSession()`, `/new`, `/fork`
   and session switches may write `liveHandle`/`liveAgent`. Catalog discovery
   NEVER does.
2. **No discovery Agent or session** — cold paths only take the official
   `agentPresets.acquireScope()` lease and read `snapshot()`/`list()`; nothing
   calls `agents.create()` for a catalog. If those capabilities disappear,
   degrade (missing commands), never probe.
3. **No durable side effects from opening the TUI** — the deferred start
   creates no agent and writes no session; the resumed path only READS.
4. **Detached data only** — a snapshot carries command display fields and skill
   name/description, frozen. Never handlers, definitions, skill bodies,
   services, agents, providers, scope keys or locators. Execution always re-binds
   to the live agent (`commands.execute(realAgent, ...)`; `loadSkill` re-`get`s
   and re-checks `isUserInvocable`).
5. **Standing-scope authority** — a cold preset catalog uses the exact
   `ScopeKey` returned by the official `agentPresets.acquireScope()` lease,
   released after the read, and the exact location identity the backend owns
   (Direct: co-located directory; Remote: the confirmed Host WorkspaceId
   resolved by the Host). The live surface uses the agent object. A real
   Agent's view always replaces the cold snapshot.
6. **Claims** — the completion list IS the advertised set. The dispatch
   captures `wasAdvertised` BEFORE any session creation; an advertised command
   missing from the real session is consumed with an explicit error and never
   sent to the model as a plain message (`shouldConsumeAdvertisedMiss`); that
   determined non-execution returns the COMPLETE submitted line (staged
   attachments included) to the editor.
7. **Transitions** — on a target change, scoped previews clear and old skill
   wrappers become `[skill: revalidating]` transition commands whose handler
   re-fetches from the current agent. A submitted skill name can never fall
   through to a plain model message mid-switch; a failed read keeps the
   transitions.
8. **Latest wins** — a stale live session or stale standing result can never
   overwrite a newer catalog (epoch + lifecycle signal + target owner).
   Cancellation is debug-only.
9. **The first session installs the real catalog before its first submission**
   — `ensureSession()` awaits the coordinator refresh from the REAL agent.
10. **Failure totality** — no refresh escapes as an unhandled rejection;
    `/preset`/`/reload` await their attempt and report outcomes; the
    `skills/change` handler routes through `runOwned`.

## Known limitations

- Without `--session`, the first completion list adds preset-scoped commands and
  skills from the STANDING scope only. Effective COMMAND discovery (including
  `/plan` and `/compact`) stays out of scope, and a custom preset that replaces
  the host `skills` service with a realm-private registry is not addressable
  cold; the authoritative view arrives with the first real session.
- `commands.list(undefined)` (the global layer) is an in-process behavior
  isolated in `listGlobalCommands()`; never forward that cast to a remote RPC.

## Diagnostics

`surface catalog prefetched`, `skill catalog standing ready` (cold startup),
`catalog applied` (epoch, source, counts, issues), `catalog unavailable`,
`catalog refresh superseded` (debug), `skills/change subscription unavailable`.
Never log skill content, user input, credentials or provider secrets; session
ids follow the normal diag convention.
