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
| `src/domain/status/**` | transport/UI-neutral status model, derivations and store |
| `src/tui-app.ts` | current TUI root facade + remaining legacy presentation/interaction implementation |
| `src/tui/commands/**` | Client-local built-in slash command definitions (TS1 domain modules) |
| `src/commands.ts` | stable command facade + registration/catalog coordinator |
| `src/transcript.ts` | ONE transcript semantic authority; TS7 modularization target |
| `src/extension/**` | extension service/Client-local extension ownership |
| `src/domain/footer/**` | transport/UI-neutral footer layout/policy/command DTOs (TS5) |
| `src/domain/notification/**` | transport/UI-neutral notification policy + completion state machine (TS5) |
| `src/tui/interaction/**` | input/overlay/editor-seat interaction primitives and modal lifecycles (TS5) |
| `src/tui/keybindings/**` | keybinding definitions/dispatch machinery (TS5) |
| `src/tui/footer/**` | terminal footer composition/configuration/runtime (TS5) |
| `src/tui/notification/**` | terminal focus reports, notifier and notification presentation (TS5) |
| `src/tui/components/**` | generic TUI leaf components (frames, transcript leaves, media, marquee) |
| `src/tui/panels/**` | TUI panels (task browser, history, approval dialog, output viewer) |
| `src/tui/pickers/**` | TUI pickers, the picker adapters and the marquee/filter seam |
| `src/tui/plugin-manager/panel.ts` | the concrete Plugin Manager terminal panel (TS4) |
| remaining historical feature dirs (`image/`, `attachment/`, `file-completion/`, …) | keep domain ownership until their assigned stage |

`src/tui-app.ts` and `src/transcript.ts` are still the large owners of their
domains. That size is structural debt, not an invitation to move their semantics
into a new layer. `src/commands.ts` is already a facade/coordinator: the built-in
definitions live in `src/tui/commands/**`.

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
application owners never import the bootstrap composition zone (facade or helper)
application owners never import src/tui/** implementation
src/domain/** never imports src/app/**, src/tui/** or experimental Remote composition
Remote is reached through one sanctioned lazy boundary
Direct remains the production/default backend
```

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
keybinding, footer and notification owners from TS5; the transcript-view owner
in TS6). It is not an application or Host layer — application lifecycle/
orchestration stays in `src/app/**`.

## Source placement and the root ledger

`scripts/source-root-baseline.json` records the current ROOT production modules as
a **shrinking migration ledger**, not an allowlist:

```text
stable
  deliberate root entries/facades expected to remain during this train

legacy
  grandfathered historical root modules awaiting TS6–TS8 owner migration
```

The architecture gate fails when a current `src/*.ts|.tsx|.mts|.cts` module is
in neither list (a new unclassified root module), when a `legacy` entry no longer
exists (stale entry — remove it in the same PR that moved/deleted the file), when
a `stable` entry no longer exists, when an entry is duplicated, or when the schema
is unknown. The gate never auto-writes or auto-accepts a baseline entry. During
TS5–TS8 a move deletes the corresponding `legacy` entry in the same PR; an
ordinary new root module is never allowed. TS5 retired the nine frozen root
interaction modules (`119 -> 110`).

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
| `image/` | `client/media/image/` | TS8 |
| `attachment/` | `client/media/attachment/` | TS8 |
| `file-completion/` | `domain/` + `tui/` + `runtime/direct/` | TS8 |

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
app/surface/notification-runtime.ts      completion notification + terminal focus tracking
app/surface/extension-runtime.ts         extension surface host + attach/detach lifetime
app/surface/plugin-manager-runtime.ts    SurfaceRuntime <-> PluginManagerController glue
app/surface/task-runtime.ts              Task Center + Job viewer state machine
app/surface/interaction-runtime.ts       approval/question surface attachment
app/surface/event-routing.ts             application-level presentation event routing
```

Each is constructed exactly once from `createSurfaceRuntime()`; no bootstrap code
constructs them directly. Search/transcript VIEW ownership stays in the aggregate until
TS6; the leaf TUI components/panels/pickers now live in their canonical
`src/tui/**` owners (TS4 DONE).

## TUI

`TuiApp` is an implementation detail, not a semantic authority and not a public
extension API.

TS5 moved the interaction primitives, the question/save-location seat frames,
the approval lifecycle, the keybinding authority, the footer runtime and the
notification presentation out of `TuiApp` and behind their canonical owners
(`src/tui/interaction/**`, `src/tui/keybindings/**`, `src/tui/footer/**`,
`src/tui/notification/**`). `TuiApp` remains the terminal composition facade and
the high-level coordinator; TS6 will extract the transcript-view orchestration.
The remaining size is structural debt, not a reason to move business semantics
into the TUI.

Plugins consume host-owned extension APIs, registries and brokers, not raw
`TuiApp` or vendored `pi-tui` internals. See `docs/extension-api.md`,
`docs/extension-tiers.md` and `docs/plugin-authoring.md`.

## Transcript

**There is ONE transcript semantic authority.**

`src/transcript.ts` — and the future `src/domain/transcript/**` module split, with
`src/transcript.ts` kept as the facade — owns the
semantic fold/projection facts: durable chronology, turn/step identity,
assistant/thinking convergence, workflow/subcall projection, read grouping,
compaction fusion, search corpus identity/revision and `TranscriptItemId`
allocation.

TUI/Focus/Compact/Search presentation may consume those facts but may not own an
independent chronology or fold. The Post-M3 TS7 modularization of
`src/transcript.ts` into `src/domain/transcript/**` is an internal module split
only: no second mutable
`TranscriptFolder`/search/focus semantic store.

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
TS6–TS8  transcript / residual closure                          NOT STARTED

TS4      TuiApp leaf / component extraction
TS5      TuiApp interaction / overlay / editor convergence
TS6      TuiApp transcript-view extraction
TS7      transcript.ts -> domain/transcript/** internal modularization (ONE TranscriptFolder authority)
TS8      residual audit + architecture closure
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

Each PR that introduces a new architectural zone extends the architecture gate
for that zone; the gate deliberately enforces only the zones that exist today.
Detailed per-PR implementation instructions belong to the Post-M3 TS plans, not
to this authority document.
