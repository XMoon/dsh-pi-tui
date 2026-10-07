# Architecture: application ownership and dependency direction

> Status: CURRENT — Post-M3 architecture authority
>
> Audited baseline: `next @ 460e968e76afdef6df5274c7acafe896f20eea78`
> (`M3 DONE / M4 NOT STARTED`, package `@xmoon76/dsh-pi-tui@0.5.1`, TS2+TS3 branch).
>
> Later commits may move or split modules and rename internal owners; the
> ownership zones, the canonical layers and the dependency direction below are
> the long-lived contract. Semantics beyond this document stay with their owning
> contract doc.

Host business coupling and the Direct → Remote migration are tracked separately:

- `docs/client-server-coupling.md` — Host business coupling / composition
  ownership inventory (the Host-boundary authority).
- `docs/client-server-migration.md` — the migration roadmap, stage history and
  per-stage qualification evidence.

## Ownership map

| Zone | Owner role |
|---|---|
| `src/index.ts` | public/package facade; delegates application startup |
| `src/app/bootstrap.ts` | application composition facade; connects owners, lifecycle, services |
| `src/app/bootstrap/**` | cohesive composition-only wiring helpers (one responsibility each) |
| `src/app/session/**` | Session application ownership/currentness/orchestration |
| `src/app/submission/**` | prompt/user-shell application orchestration |
| `src/app/command/**` | application command authority/catalog/execution |
| `src/app/surface/**` | mounted surface/application presentation ownership |
| `src/app/plugin-manager/**` | Plugin Manager application state/policy/controller/model ownership |
| `src/app/direct/**` | Direct-only application composition/owners |
| `src/app/remote/**` | experimental Remote composition/Client application ownership |
| `src/runtime/**` | transport-neutral semantic ports/contracts |
| `src/runtime/direct/**` | Direct semantic adapters |
| `src/runtime/remote/**` | Remote semantic adapters |
| `src/domain/status/**` | transport/UI-neutral status model, derivations, store AND the session stats fold/facts (`stats.ts`) (TS3, TS8-D) |
| `src/tui-app.ts` | current TUI root facade + remaining legacy presentation/interaction implementation |
| `src/tui/commands/**` | Client-local built-in slash command definitions (TS1 domain modules; TS8-D owns the `/status` stats-row formatter) |
| `src/commands.ts` | stable command facade + registration/catalog coordinator |
| `src/transcript.ts` | stable transcript semantic facade ONLY (TS7/TS8-D): pure re-exports of the canonical `src/domain/transcript/**` owners; no Markdown implementation and no client/tui import |
| `src/domain/transcript/**` | ONE transport/UI-neutral transcript semantic/lifecycle authority (TS7/TS8-D): fold, classification, Context form/provenance, Workflow projection, search corpus, grouping, window semantics, token usage accounting, content-block projection, safe failure mapping and text helpers |
| `src/domain/display/**` | transport/UI-neutral display vocabulary (TS8-D): preset state/resolution and the neutral icon semantics/style normalization |
| `src/extension/**` | extension service/Client-local extension ownership |
| `src/domain/footer/**` | transport/UI-neutral footer layout/policy/command DTOs (TS5) |
| `src/domain/notification/**` | transport/UI-neutral notification policy + completion state machine (TS5) |
| `src/tui/interaction/**` | input/overlay/editor-seat interaction primitives and modal lifecycles (TS5) |
| `src/tui/keybindings/**` | keybinding definitions/dispatch machinery (TS5) |
| `src/tui/footer/**` | terminal footer composition/configuration/runtime (TS5) |
| `src/tui/notification/**` | terminal focus reports, notifier and notification presentation (TS5) |
| `src/tui/components/**` | generic TUI leaf components (frames, transcript leaves, media, marquee) |
| `src/tui/transcript/**` | backend-neutral Client transcript presentation core (TS6/TS8-D: canonical structure, container vocabulary, Context clustering/summary, process/Work summary, Compact/Focus projections, reveal resolution, display disclosure policy and backend-neutral tool-card presentation) |
| `src/tui/components/transcript/**` | PiTui transcript mechanics (TS6: Focus/Activity cards, Context cluster/rows, rendered search highlight) |
| `src/tui/panels/**` | TUI panels (task browser, history, approval dialog, output viewer) |
| `src/tui/pickers/**` | TUI pickers, the picker adapters and the marquee/filter seam |
| `src/tui/plugin-manager/panel.ts` | the concrete Plugin Manager terminal panel (TS4) |
| `src/domain/file-completion/**` | transport/UI-neutral file-completion query/ranking/discovery policy (TS8-A) |
| `src/client/file-completion/**` | Client-local filesystem completion capability (`/attach`, `/image`, Save Location) (TS8-A) |
| `src/tui/file-completion/**` | terminal trigger grammar + completion presentation/local pipeline (TS8-A) |
| `src/runtime/direct/file-completion/**` | Direct Host scoped discovery: the sessionless WORKSPACE compatibility path AND the explicit Session `@` path-navigation route (TS8-A / TS8-HF1) |
| `src/domain/media/**` | transport/UI-neutral media vocabulary: media types, durable image/file refs, the deployment image policy, the media failure vocabulary, byte formatting AND the file-attachment textual summary (`file-summary.ts`) (TS8-C, TS8-D) |
| `src/client/media/**` | Client-local media capability: image draft/intake/cache/durable-byte loader, generic-file draft/intake/source streaming, and the ONE combined draft lifecycle (`draft-attachments.ts`) (TS8-C) |
| `src/client/clipboard/**` | Client-local clipboard capability: the read probes (`read.ts`) and the copy delivery policy (`copy.ts`) (TS8-C) |
| `src/client/url/**` | Client-local external URL opener (TS8-C) |
| `src/client/artifact/**` | Client-local artifact output capability: the safe file sink (`save.ts`) and the `/transcript` Markdown formatter (`transcript-markdown.ts`) (Pre-Stage-D, TS8-D) |
| `src/tui/icons.ts`, `src/tui/token-format.ts` | concrete terminal presentation: the structural icon glyph palette/composition and the compact token-count formatter (TS8-D) |
| `src/runtime/prepared-prompt.ts` | the transport-neutral `PreparedPrompt` contract (TS8-C) |
| `src/runtime/remote/pi-tui-file-reference-contract.ts` | the private `piTuiFileReferences` Typert contract: ONE handwritten invocation descriptor both the Host registration and the Client contribution derive from (TS8-HF1) |
| `src/runtime/remote/pi-tui-file-reference-host-bridge.ts` | the Remote Host-side bridge binding the private method to the Host-scoped `@` completion authority (TS8-HF1) |
| `src/app/remote/pi-tui-file-reference-host.ts` | the private `piTuiFileReferences` Cordis Host row: service key, explicit Typert registration and row lifetime (TS8-HF1) |
| remaining historical feature dirs (`…`) | keep domain ownership until their assigned stage |

`src/tui-app.ts` is still a large owner of its domain. That size is structural
debt, not an invitation to move its semantics into a new layer.
`src/commands.ts` and `src/transcript.ts` are already facades: the built-in
command definitions live in `src/tui/commands/**` and the transcript semantics
live in `src/domain/transcript/**`.

## Canonical layers

Every production module belongs to exactly one owner layer:

| Layer | Owns |
|---|---|
| `src/app/**` | application lifecycle, orchestration, currentness and owner composition |
| `src/runtime/**` | semantic ports/contracts plus Direct/Remote backend adapters |
| `src/domain/**` | transport/UI-neutral semantic models, policies, folds and derived state |
| `src/client/**` | Client-local non-TUI platform capability (local media, clipboard, artifact IO) |
| `src/tui/**` | terminal rendering, pickers, panels, commands and interaction |
| `src/extension/**` | the public extension compatibility boundary |

Root modules are limited to the documented facades/compatibility islands
(`src/index.ts`, `src/startup.ts`, `src/commands.ts`, `src/tui-app.ts`,
`src/transcript.ts`); an ordinary new root feature/helper
(`src/*.ts`/`*.tsx`/`*.mts`/`*.cts`) is forbidden and mechanically rejected (see
"Source placement and the root ledger").

A domain may appear in multiple layers when the responsibilities differ:

```text
src/app/command/**   application command authority / lifecycle / execution
src/tui/commands/**  terminal slash-command definition / presentation

src/app/plugin-manager/**       Plugin Manager application state/policy/controller
src/tui/plugin-manager/panel.ts concrete terminal panel (TS4), injected as a factory

src/app/surface/**    application surface owner coordinating the mounted surface
src/domain/status/**  the transport/UI-neutral status primitives it coordinates
```

`src/app/bootstrap.ts` and `src/app/bootstrap/**` form ONE composition zone, not
a presentation or domain layer: they may resolve/construct/connect owners, and
each helper must stay a cohesive composition responsibility. A helper that grows a
business reducer, a state machine or a presentation algorithm belongs in an owner
layer instead.

## Dependency direction

```text
src/index.ts
  ↓
src/app/bootstrap.ts + src/app/bootstrap/**
  ↓
src/app/** owners
  ↓
src/runtime/** semantic contracts
  ↓
selected Direct / Remote implementations

presentation/TUI
  ↓
application-facing callbacks / semantic read models
  ↓
never Direct/Remote implementation internals
```

The load-bearing rules:

```text
src/runtime/** never imports src/app/**
src/runtime/** never imports src/tui/**
src/runtime/** never imports src/client/**
application owners never import the bootstrap composition zone (facade or helper)
application owners never import src/tui/** implementation
src/domain/** never imports src/app/**, src/tui/**, src/client/** or experimental Remote composition
src/client/** never imports experimental Remote composition
src/tui/transcript/** never imports PiTui, Tern, TuiApp, theme/icons, the renderer
  registry or another concrete TUI mechanics module
Remote is reached through one sanctioned lazy boundary
Direct remains the production/default backend
```

`src/client/**` is the Client-local platform capability and the INNER layer,
exactly like `src/app/**` and `src/tui/**`: the neutral domain and the Host
semantic/adaptor (`src/runtime/**`) layers never depend on it, and Client-local
state never reaches the Host transport. `runtime-imports-client` (the
`src/runtime/** !-> src/client/**` rule) is enforced for value, type-only AND
literal value-dynamic imports with no allowlist; the `domain-imports-client`
and `client-imports-remote-composition` rules are static (value/type-only)
rules, matching the gate exactly.

The application/TUI direction (TS4) is one-way at the implementation level:

```text
src/app/** owners            !-> src/tui/**
src/app/bootstrap.ts + src/app/bootstrap/**  may wire src/tui/** (composition)
src/tui/**                   may import application-facing contracts
```

Only the bootstrap composition zone selects a concrete TUI implementation and
injects it into an application owner through a narrow structural seam (the Plugin
Manager panel factory is the first such seam). The direction is enforced by the
architecture gate for value AND type-only imports, with no allowlist.

The TUI layer follows the same direction:

```text
src/tui/**
  does not import Direct/Remote implementation/composition
  does not import the app/bootstrap composition zone
  consumes semantic/application-facing contracts
```

`src/commands.ts` stays in that scope as the TUI command layer's transitional
facade/coordinator (it owns the dynamic skill wrappers and the catalog
coordinator for the same definitions). `src/tui/**` is the Client terminal
presentation layer: `src/tui-app.ts` plus the extracted presentation owners
(`src/tui/commands/**` from TS1; `src/tui/components/**`, `src/tui/panels/**`,
`src/tui/pickers/**` and `src/tui/plugin-manager/**` from TS4; the interaction,
keybinding, footer and notification owners from TS5; the transcript presentation
core and the PiTui transcript mechanics from TS6). It is not an application or
Host layer — application lifecycle/orchestration stays in `src/app/**`.

## Session `@` completion routing (TS8-HF1)

The session `@` scope has ONE frozen Host-side router, used by BOTH backends:

```text
bare workspace fuzzy search        -> official ctx.fileReferences
  @foo @readme @src @.env              (workspace index, cache, exclusions,
                                       scoring, maxResults stay authoritative)

explicit path navigation           -> dsh-pi-tui Host scoped discovery
  @src/ @./ @../x @/abs @~/x           (the exact scope the user typed)
  Windows drive/UNC paths
```

The route is decided by the TOKEN's own shape (any separator, a root form, or a
Windows drive/UNC path), never by resolved workspace containment, by official
result count or by filesystem existence. The official provider is called ONLY on
the bare route; an authoritative official `[]` stays empty and never falls back to
the scanner. The scoped route never calls the official provider — so explicitly
named excluded directories, symlink scopes, parent and absolute paths all work, and
DSH path resolution never sees a literal `~/...` completion value (the accepted
candidate is materialized as an absolute Host path; ranking always scores the
SCOPE-RELATIVE candidate, so the home prefix itself can never fabricate matches).

POSIX BOUNDARY: on a POSIX Host a backslash is an ordinary filename character, but
the reused TS8-A path resolver selects its Windows dialect from the token alone and
normalizes the separators (a pinned Client-local cross-dialect contract). The
augmentation therefore does NOT CLAIM an ambiguous POSIX token containing a
backslash (`foo\bar`, `dir\name/foo`): it stays with the official provider instead
of being searched in a normalized (different) directory. That is a deliberate
fail-closed narrowing, deleted once the shared resolver distinguishes host dialect,
token dialect and literal backslashes.

PARENT-TRAVERSAL SPELLING: a relative scope is searched with the very spelling the
Host's filesystem backend gives the accepted value. On a POSIX Host `dsh-fs-local`
anchors a path containing a `..` segment with its PHYSICAL spelling — the raw
`<anchor>/<path>` concatenation, where the anchor is the Session cwd for a relative
value and the value itself for an absolute one, so the kernel resolves an
intermediate symlink BEFORE the parent step — and resolves every other path lexically
(Windows always lexically). Because the accepted completion value is
`displayBase + name`, the scoped search tests the WHOLE anchored spelling (a `..`
carried by the Session cwd itself counts exactly like one in the typed scope) and
keeps that raw concatenation when required; the Direct Host discovery driver joins its
base without re-normalizing it, so completion and the model's read can never land in
two different physical directories. Absolute scopes already spell their traversal
verbatim. A home shorthand emits an ABSOLUTE `path.join`-normalized value, so its
scope is normalized identically — the bare `~`/`~/` root form is the one form whose
search base is the raw `homedir()` spelling. This is one segment test plus one
concatenation (plus one lexical normalize for the home root form) — the consumer's own
rule applied to the value we hand it, not a second path parser.

Direct and Remote share this authority: the Direct adapter reaches it in-process,
the Remote Client reaches the SAME router through the private `piTuiFileReferences`
endpoint (the official `fileReferences` namespace stays mounted and authoritative
for bare queries). The custom endpoint AUGMENTS the official provider; it does not
replace it. Bare-query ranking, result bound, exclusion policy, implicit hidden
matching and cache/invalidation remain official behavior — TS8-HF1 does not restore
the historical local characteristics there.

## Source placement and the root ledger

`scripts/source-root-baseline.json` records the current ROOT production modules as
a **shrinking migration ledger**, not an allowlist:

```text
stable
  deliberate root entries/facades expected to remain during this train

legacy
  grandfathered historical root modules awaiting TS7–TS8 owner migration
```

The architecture gate fails when a current `src/*.ts|.tsx|.mts|.cts` module is
in neither list (a new unclassified root module), when a `legacy` entry no longer
exists (stale entry — remove it in the same PR that moved/deleted the file), when
a `stable` entry no longer exists, when an entry is duplicated, or when the schema
is unknown. The gate never auto-writes or auto-accepts a baseline entry. During
TS5–TS8 a move deletes the corresponding `legacy` entry in the same PR; an
ordinary new root module is never allowed. TS5 retired the nine frozen root
interaction modules (`119 -> 110`); TS6 retired the nine frozen root transcript
presentation modules (`110 -> 101`). TS8-E closed the extension/theme/stateful
residual owners and reclassified the published `src/extensions.ts` entry stable,
reaching `stable = 6 / legacy = 49` (the TS8-E root scope no longer exists at the
source root).

## Existing directory convergence

The historical feature directories are normalized stage by stage. Their intended
owners:

| Directory | Target owner | Stage |
|---|---|---|
| `components/` | `tui/components/` (DONE — `src/components/` is absent) | TS4 DONE |
| `keybinding-ui/` | `tui/keybindings/ui/` (DONE — `src/keybinding-ui/` is absent) | TS5 DONE |
| `keybindings/` | `tui/keybindings/` (DONE — `src/keybindings/` is absent) | TS5 DONE |
| `footer/` | `domain/footer/` + `tui/footer/` (DONE — `src/footer/` is absent) | TS5 DONE |
| `notification/` | `domain/notification/` + `tui/notification/` (DONE — `src/notification/` is absent) | TS5 DONE |
| `plugin-manager/` | `app/plugin-manager/` + `tui/plugin-manager/panel.ts` (DONE — `src/plugin-manager/` is absent) | TS3 + TS4 DONE |
| `status/` | `domain/status/` (DONE — `src/status/` is absent) | TS3 DONE |
| `image/` | `domain/media/` (neutral vocabulary/failures/formatting) + `client/media/image/` (Client draft/intake/cache/loader) + `client/clipboard/read.ts` (clipboard read) + `app/submission/direct-image-*.ts` (Direct Host admission/model preflight) (DONE — `src/image/` is absent) | TS8-C DONE |
| `attachment/` | `domain/media/` (neutral refs) + `client/media/attachment/` (Client draft/intake/source streaming) + `app/submission/direct-file-admission.ts` (the Direct Host `saveFileStream` sink) (DONE — `src/attachment/` is absent) | TS8-C DONE |
| `file-completion/` | `domain/file-completion/` (pure query/ranking/discovery policy) + `client/file-completion/` (Client-local filesystem implementation) + `tui/file-completion/` (editor trigger + `AutocompleteItem` presentation) + `runtime/direct/file-completion/` (Direct Host scoped discovery: the WORKSPACE compatibility path and the explicit Session `@` route) (DONE — `src/file-completion/` is absent) | TS8-A DONE |

The remaining directories stay where they are until their assigned stage; each row
records the intended owner. A row marked DONE has no compatibility forwarding
directory left behind.

## Composition zone

`src/app/bootstrap.ts` is the composition FACADE and `src/app/bootstrap/**` holds
its cohesive wiring-only helpers. Together they may resolve, construct and connect
owners, and wire the lifecycle, Host services and the mounted surface.

The facade keeps `applyRunner` / `applyRunnerWithRuntime`, the Cordis/process
prerequisites, Host service resolution, owner construction and connection, mount and
start ordering, and the top-level lifecycle (including the terminal-total fatal
catch). Helpers may select adapters (including Direct ones — the whole zone is inside
the Direct composition allowance) but never read Host services of their own.

It must not become a business reducer or a durable domain-state owner: business
decisions and durable state belong to the application owners (`app/session`,
`app/submission`, `app/command`, `app/surface`, `app/plugin-manager`, `app/direct`,
`app/remote`) and the semantic runtime ports they consume. Resolving a Host service in
order to construct an owner is composition; owning that service's semantics is not.

## Mounted surface ownership

`src/app/surface/runtime.ts` remains the ONE aggregate `createSurfaceRuntime()`
constructor: it builds the mounted `TuiApp` slot, wires the sub-owners together and owns
the cross-sub-owner disposal ordering. The independent surface lifetimes live in their
own application-level owners next to it:

```text
app/surface/notification-runtime.ts      completion notification lifecycle + completion-owner/
                                         status/focus-policy coordination (the terminal facts come
                                         from the injected structural presentation)
app/surface/extension-runtime.ts         extension surface host + attach/detach lifetime
app/surface/plugin-manager-runtime.ts    SurfaceRuntime <-> PluginManagerController glue
app/surface/task-runtime.ts              Task Center + Job viewer state machine
app/surface/interaction-runtime.ts       approval/question surface attachment
app/surface/event-routing.ts             application-level presentation event routing
```

The notification split (TS5 §14) keeps the application status/current-agent authority here and
the terminal implementation in the TUI layer:

```text
domain/notification/**    mode/method policy + the neutral completion state machine + focus state
app/surface/notification-runtime.ts
                          the authoritative agent/status lifecycle, the completion-owner fence
                          and the mode/method + focus-policy orchestration
        ↓ injected structural port (`TerminalNotificationPresentation`)
tui/notification/**       the focus tracker, the OSC/bell notifier, the focus-reporting
                          `CSI ? 1004` writes and the concrete terminal presentation; selected
                          by `app/bootstrap.ts` and handed to `createSurfaceRuntime()`
```

Each is constructed exactly once from `createSurfaceRuntime()`; no bootstrap code
constructs them directly. The leaf TUI components/panels/pickers live in their
canonical `src/tui/**` owners (TS4 DONE). Search/transcript VIEW ownership moved
out of the aggregate in TS6: the reusable transcript presentation core is
`src/tui/transcript/**` and the PiTui transcript mechanics are
`src/tui/components/transcript/**`, while `TuiApp` keeps the mutable
composition/renderer state (expansion sets, component caches, viewport, hit
maps).

## TUI

`TuiApp` is an implementation detail, not a semantic authority and not a public
extension API.

TS5 moved the interaction primitives, the question/save-location seat frames,
the approval lifecycle, the keybinding authority, the footer runtime and the
notification presentation out of `TuiApp` and behind their canonical owners
(`src/tui/interaction/**`, `src/tui/keybindings/**`, `src/tui/footer/**`,
`src/tui/notification/**`). `TuiApp` remains the terminal composition facade and
the high-level coordinator; TS6 moved the reusable transcript presentation
algorithms (canonical structure, Context clustering/summary, process/Work
summary, Compact/Focus projections, reveal resolution) into
`src/tui/transcript/**` and the PiTui transcript cards into
`src/tui/components/transcript/**`, leaving the mutable renderer state and the
Full materialization in the facade. The remaining size is structural debt, not a
reason to move business semantics into the TUI.

Plugins consume host-owned extension APIs, registries and brokers, not raw
`TuiApp` or vendored `pi-tui` internals. See `docs/extension-api.md`,
`docs/extension-tiers.md` and `docs/plugin-authoring.md`.

## Transcript

**There is ONE transcript semantic authority.**

`src/domain/transcript/**` owns the semantic fold/projection facts: durable
chronology, turn/step identity, assistant/thinking convergence, workflow/subcall
projection, read grouping, compaction fusion, search corpus identity/revision
and `TranscriptItemId` allocation. `src/transcript.ts` is the stable semantic
facade: it re-exports those owners (the SAME `TranscriptFolder` constructor) and
owns no implementation. TS8-D moved the `/transcript` Markdown exporter out of
the facade to the Client artifact formatter
`src/client/artifact/transcript-markdown.ts`.

TS7 split the former `src/transcript.ts` monolith into the ONE domain graph
`types` / `semantics` / `context-semantics` / `workflow-projection` / `search` /
`grouping` / `window` / `folder`; TS8-D added the residual semantic helpers
`usage` / `content-blocks` / `failure` / `text` and merged the retired
`src/context.ts` helpers into `context-semantics`. It is an internal
modularization only: no second mutable `TranscriptFolder`/search/focus semantic
store, and a `domain-transcript-imports-backend-mechanics` gate rule keeps
`domain/transcript/**` CLOSED-WORLD — only its own siblings and two TYPE-ONLY
edges (`domain/display/icons.ts`, `runtime/assistant-stream-port.ts`) are
admitted; every transitional root VALUE edge is gone.

TUI/Focus/Compact/Search presentation may consume those facts but may not own an
independent chronology or fold.

The renderer-neutral PRESENTATION side of the transcript is already split
(TS6): `src/tui/transcript/**` owns the canonical Work/Context structure, the
container-owner vocabulary, the Context clustering/summary, the process/Work
summary, the Compact/Focus projections and the reveal resolution, while
`src/tui/components/transcript/**` owns the PiTui cards and rendered search
mechanics. The direction is one-way and mechanically enforced:

```text
PiTui transcript mechanics (tui/components/transcript/**)
  -> backend-neutral transcript presentation core (tui/transcript/**)
  -> semantic transcript facts (src/domain/transcript/**)
```

A future TSP renderer consumes the SAME `tui/transcript/**` core; it never
replaces or duplicates it. TS6 shipped no TSP/Tern implementation.

## Direct and Remote

Direct is the current production/default provider. Remote is the experimental
in-process official wire. Both map the same semantic application contracts.

The contract is defined by the transport-neutral `src/runtime/**` ports; never
define it from the Direct implementation shape. The experimental Remote
composition is reached only through the one sanctioned dynamic boundary
(`src/runtime/backend-loader.ts` → `src/app/remote/runtime.ts`). DSH release and
distribution compatibility research lives in `docs/dsh-compatibility.md`, not
here.

## Extension locality

The M3 closure rule:

```text
Client imperative UI:
  callbacks/components/renderers/editors stay Client-local

Host business/domain state:
  remains Host-owned
  crosses Remote only as supported serialized facts/actions

no executable callback/component/renderer/editor crossing
```

Detailed locality rows, composition owners and wire stories live in
`docs/client-server-coupling.md`; the migration evidence is in
`docs/client-server-migration.md`.

## Architecture gate

```text
pnpm gate:architecture
  -> scripts/application-architecture-gate.mjs
```

The gate is the mechanical enforcement of the dependency direction and the source
placement policy above. It parses the TypeScript AST and rejects:

```text
src/runtime/**                    -> src/app/**
src/runtime/**                    -> src/tui/**
non-composition modules           -> src/app/direct/** or src/runtime/direct/**
owners / presentation / TUI       -> the src/app/bootstrap.ts + src/app/bootstrap/** zone
src/index.ts                      -> any src/app/bootstrap/** helper (facade only)
src/app/bootstrap/**              -> the src/app/bootstrap.ts facade (siblings are fine)
src/domain/**                     -> src/app/**, src/tui/** or experimental Remote composition
src/tui/** (and the commands.ts
  command-layer facade)           -> experimental Remote composition
the src/startup.ts static graph   -> experimental Remote composition
app/remote/** dynamic imports     -> any owner/target other than the ONE sanctioned edge
src/app/surface/**                -> new Direct<...>(...) semantic adapters
```

The bootstrap zone is `src/app/bootstrap.ts` plus every `src/app/bootstrap/**` file,
matched by DIRECTORY: a new extraction joins the zone (and its rules) automatically
instead of escaping them by choosing a new file name. Its internal direction is
three mechanical contracts:

```text
src/index.ts           may import app/bootstrap.ts (the facade) only — never app/bootstrap/**
src/app/bootstrap.ts   may import app/bootstrap/** (and names itself)
src/app/bootstrap/**   may import SIBLING helpers; never app/bootstrap.ts (no facade<->helper value cycle)
every other module     may import neither the facade nor the zone
```

The zone itself may import Direct wiring; the entry may not reach past the facade
into an implementation helper.

It also enforces the root ledger (`scripts/source-root-baseline.json`) over every
`src/*.ts|.tsx|.mts|.cts` module: a new unclassified root module, a stale `legacy`
entry, a missing `stable` facade, a duplicate entry or an unknown schema fails the
gate. `.tsx` is deliberately in scope, so the TUI-layer dependency rules cannot be
bypassed by the file extension either.

Its rule unit tests live in `test/application-architecture-gate.test.mjs`.

Do not merge this gate with the Host-coupling gate:

```text
gate:architecture
  = application/module dependency direction + source placement

gate:boundary
  = Host business coupling / allowed Host-service boundary
```

`gate:boundary` (`scripts/client-boundary-gate.mjs`) remains the authority for
which module may touch which Host service/type.

## Post-M3 convergence

The architecture above is current while several modules remain structurally
oversized and multi-owner. The Post-M3 TypeScript convergence train works
through them in ownership-first order:

```text
TS0  architecture authority + long-lived gate refresh          DONE
TS1  TUI command layer + source placement policy                DONE
TS2 + TS3  app/bootstrap + app/surface composition convergence  DONE
TS4  TUI leaf / component / panel / picker convergence          DONE
TS5  TuiApp interaction / overlay / editor convergence          DONE
TS6  transcript presentation core + PiTui transcript mechanics  DONE
TS7  transcript semantic domain + ONE TranscriptFolder authority DONE
TS8  residual source-tree / placement closure                   NOT STARTED

TS4      TuiApp leaf / component extraction
TS5      TuiApp interaction / overlay / editor convergence
TS6      backend-neutral transcript presentation core + PiTui transcript mechanics
TS7      transcript.ts -> domain/transcript/** internal modularization (ONE TranscriptFolder authority)
TS8      residual source-tree normalization / final placement closure
```

TS2 split the application composition root into the facade plus six wiring helpers
(`runtime-selection`, `presentation-bridge`, `task-source`, `event-wiring`,
`lifecycle`, `session-startup`); TS3 moved `src/status/**` to `src/domain/status/**`,
normalized the Plugin Manager application ownership to `src/app/plugin-manager/**`
and split `src/app/surface/runtime.ts` into explicit application-level surface
owners while `createSurfaceRuntime()` stays the one aggregate.

TS4 finished that Plugin Manager relocation in both directions — the concrete
terminal panel is now `src/tui/plugin-manager/panel.ts`, injected into the
application through the narrow `PluginManagerPanelFactory` seam — retired
`src/components/**` into `src/tui/components/**`, and moved the seven remaining
historical root TUI modules to their canonical layer paths:

```text
src/marquee.ts             -> src/tui/components/marquee.ts
src/searchable-picker.ts   -> src/tui/pickers/searchable-picker.ts
src/model-picker.ts        -> src/tui/pickers/model-picker.ts
src/subagent-model-menu.ts -> src/tui/pickers/subagent-model-menu.ts
src/theme-menu.ts          -> src/tui/pickers/theme-menu.ts
src/history-panel.ts       -> src/tui/panels/history-panel.ts
src/task-panel.ts          -> src/tui/panels/task-panel.ts
```

It also extracted the low-risk TuiApp leaves into `src/tui/components/frame.ts`,
`src/tui/components/welcome-card.ts`, `src/tui/components/transcript-leaves.ts`,
`src/tui/pickers/picker-adapters.ts`, `src/tui/panels/approval-dialog.ts` and
`src/tui/panels/output-viewer-panel.ts`. `TaskBrowserViewState` became an
application-owned type in `src/app/surface/task-runtime.ts` (the owner that stores
`quickTaskState`/`restoreState`), so the TUI panel consumes it as a type instead
of owning it.

TS6 split the backend-neutral transcript presentation core from the PiTui
mechanics and retired the nine frozen root modules in the same PR
(`110 -> 101` legacy entries). The new
`tui-transcript-imports-renderer-mechanics` gate rule enforces the direction for
static, type-only and literal value-dynamic imports, with no allowlist:

```text
src/transcript-projection.ts    -> src/tui/transcript/structure.ts
src/transcript-disclosure.ts    -> src/tui/transcript/container-owner.ts
src/compact-projection.ts       -> src/tui/transcript/compact-projection.ts
src/focus-activity.ts           -> src/tui/transcript/focus-projection.ts
                                 + src/tui/components/transcript/focus-activity.ts
src/compact-process-preview.ts  -> src/tui/transcript/process-summary.ts
                                 + src/tui/components/transcript/compact-process-preview.ts
src/compact-work.ts             -> src/tui/transcript/work-summary.ts
                                 + src/tui/components/transcript/compact-work.ts
src/context-cluster.ts          -> src/tui/transcript/context-summary.ts
                                 + src/tui/components/transcript/context-cluster.ts
src/context-row.ts              -> src/tui/components/transcript/context-row.ts
src/search-presentation.ts      -> src/tui/components/transcript/search-presentation.ts
```

`src/context-presentation.ts` and `src/transcript-semantics.ts` are retired
(TS7): the Context form/provenance/ambient authority now lives in
`src/domain/transcript/context-semantics.ts` and the classification in
`src/domain/transcript/semantics.ts`. `src/search-overlay.ts` stays deliberately
unmoved for a later TS8 stage; `src/display-preset.ts` was split by TS8-D into
the neutral `src/domain/display/preset.ts` and the terminal
`src/tui/transcript/display-policy.ts`. The Direct-vs-Remote presentation parity
comparator left `src/runtime/**` for
`scripts/support/presentation-read-shadow.ts` (qualification tooling, not
runtime product authority), so `runtime/**` still imports zero `tui/**`.

TS8-D closed the transcript/status residual semantic debt: the eight legacy roots
`context.ts`, `content-block-presentation.ts`, `failure-presentation.ts`,
`present.ts`, `token-usage.ts`, `icons.ts`, `stats.ts` and `display-preset.ts`
were retired with no forwarding shims (legacy ledger `94 -> 86`). Semantic
authority now lives in `domain/transcript/**` (usage / content-blocks / failure /
text / context), `domain/status/stats.ts`, `domain/display/**` and
`domain/media/file-summary.ts`; terminal presentation lives in
`tui/transcript/**` (display policy + tool-card presentation), `tui/icons.ts` and
`tui/token-format.ts`; the `/transcript` Markdown formatter lives in
`client/artifact/transcript-markdown.ts` and `src/transcript.ts` is a pure
semantic re-export facade. The dead `StatusData.statsLine` / `formatStats`
compatibility string path was removed, and the domain/transcript closed-world
gate admits only its own siblings and the two TYPE-ONLY edges.

TS8-E closed the extension / theme / stateful residual owners (legacy
`59 -> 49`, stable `5 -> 6`):

- the seven concrete extension registries live under `src/extension/internal/**`
  (unpublished implementation); `src/extensions.ts` is the deliberate stable
  public `./extensions` package entry, not a legacy feature root;
- the theme ownership split by layer: neutral palette vocabulary
  (`domain/display/theme.ts`), Client-local custom-theme files + environment
  (`client/theme/**`), the live terminal palette/ANSI themes
  (`tui/theme/runtime.ts`), the persisted identity grammar
  (`domain/display/theme-selection.ts`) and the cross-source composition
  (`app/surface/theme-selection.ts`); `app/surface/**` no longer value-imports
  `tui/theme/**` (the composition zone injects the image fallback colour);
- session/submission/currentness state lives under `app/**`, the neutral
  model-selection fold under `domain/session/**`, rewind's candidate fold /
  picker item / Direct outline fold under `domain/session/**`,
  `tui/pickers/**` and `runtime/direct/**`, and the pending-input row/presentation
  DTOs under `app/surface/pending-presentation.ts` (consumed by TuiApp);
- Client history IO lives under `client/history/**` (ordering policy stays in
  `app/submission/history-persist.ts`); neutral catalog DTOs under
  `domain/catalog/**`, Direct Host catalog reads under `runtime/direct/**` and
  refresh currentness under `app/command/catalog-refresh.ts`;
- the Client `compgen` capability lives under `client/shell/**`, the editor
  completion grammar under `tui/interaction/autocomplete/shell.ts` and shell
  submission orchestration under `app/submission/shell-context.ts`.

No forwarding shim was kept; the Direct catalog reads stay the single authority
and reach `app/command/**`/`commands.ts` only through composition-injected
neutral-DTO operations.

The Direct/Remote direction (`runtime/remote/**` must not depend on the Direct
implementation) governs Client-side Remote ADAPTERS. The pre-existing HF1
Host-side construction bridge
(`runtime/remote/pi-tui-file-reference-host-bridge.ts` → `runtime/direct/*`,
documented in `docs/client-server-coupling.md`) is an approved exception that
shares the existing Host authority; TS8-E adds no new Remote→Direct edge, so no
blanket Remote→Direct gate is added (it would flag that legitimate bridge).

Each PR that introduces a new architectural zone extends the architecture gate
for that zone; the gate deliberately enforces only the zones that exist today.
Detailed per-PR implementation instructions belong to the Post-M3 TS plans, not
to this authority document.
