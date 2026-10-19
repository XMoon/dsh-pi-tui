# Architecture: ownership and dependency direction

This document owns the long-lived module-ownership zones, the canonical layers,
the dependency direction and the source-placement policy. It does not track
stage progress, per-PR inventories or migration history; the source tree, the
gates and the tests are the authority for implementation state.

Host business coupling, locality and Direct/Remote semantics are owned by
[host-client.md](./host-client.md). Session lifecycle and writer safety are
owned by [concurrency.md](./concurrency.md) and the async failure model by
[failure-model.md](./failure-model.md).

## Ownership map

Every production module belongs to exactly one owner layer:

| Zone | Owner role |
|---|---|
| `src/index.ts` | Public package facade; delegates application startup |
| `src/app/bootstrap.ts` + `src/app/bootstrap/**` | Application composition facade and cohesive wiring-only helpers |
| `src/app/session/**` | Session application ownership, currentness and orchestration |
| `src/app/submission/**` | Prompt / user-shell application orchestration |
| `src/app/command/**` | Application command authority, catalog and execution |
| `src/app/surface/**` | Mounted surface and application-presentation ownership |
| `src/app/plugin-manager/**` | Plugin Manager application state, policy, controller and model |
| `src/app/direct/**`, `src/app/remote/**` | Direct-only and experimental Remote composition/owners |
| `src/runtime/**` | Transport-neutral semantic ports/contracts and Direct/Remote adapters |
| `src/runtime/process/**` | Process-lifetime primitives: detached/owned tasks, diagnostics, synchronous disposal, total error observation |
| `src/domain/**` | Transport/UI-neutral semantic models, policies, folds and derived state |
| `src/client/**` | Client-local non-TUI platform capabilities (media, clipboard, artifact IO, local completion, history IO, themes, launcher/git reads) |
| `src/tui/**` | Terminal rendering, pickers, panels, commands and interaction |
| `src/extension/**` | Public extension compatibility boundary and internal registries |
| `src/commands.ts`, `src/transcript.ts`, `src/tui-app.ts` | Documented root facades/transitional entries; not a template for new modules |

`src/tui-app.ts` is still a large owner of terminal composition and mutable
renderer state. Its size is structural debt, not an invitation to move business
semantics into the TUI. `src/commands.ts` is the stable command facade plus
registration/catalog coordinator; `src/transcript.ts` is a pure semantic
re-export facade over `src/domain/transcript/**`.

## Canonical layers

| Layer | Owns |
|---|---|
| `src/app/**` | Application lifecycle, orchestration, currentness and owner composition |
| `src/runtime/**` | Semantic ports/contracts plus Direct/Remote backend adapters |
| `src/domain/**` | Transport/UI-neutral semantic models, policies, folds and derived state |
| `src/client/**` | Client-local non-TUI platform capability |
| `src/tui/**` | Terminal rendering, pickers, panels, commands and interaction |
| `src/extension/**` | Public extension compatibility boundary |

Root modules are limited to the documented entries/facades/compatibility islands
(`src/index.ts`, `src/startup.ts`, `src/commands.ts`, `src/tui-app.ts`,
`src/transcript.ts`, `src/extensions.ts`, `src/builtins.ts`); an ordinary new
root feature/helper (`src/*.ts`, `*.tsx`, `*.mts`, `*.cts`) is forbidden and
mechanically rejected.

A feature may span several layers when the responsibilities differ — for
example file completion owns neutral ranking/discovery policy in
`domain/file-completion/**`, the Client-local filesystem capability in
`client/file-completion/**`, terminal trigger/presentation in
`tui/file-completion/**` and Direct Host WORKSPACE IO in
`runtime/direct/file-completion/**`. Choose placement by the owning layer, not
by the feature noun. Do not recreate a parallel root feature tree, move code
only for visual symmetry, or hide cross-layer dependencies behind a generic
Context/Services bag.

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

Load-bearing rules:

```text
src/runtime/** never imports src/app/**
src/runtime/** never imports src/tui/**
src/runtime/** never imports src/client/**
src/runtime/process/** never imports src/app/**, src/tui/**, src/client/** or
  the Direct/Remote adapters, and never loads a DSH business/service
  implementation package (a fully erased type face and Node built-ins only)
application owners never import the bootstrap composition zone
application owners never import src/tui/** implementation
src/domain/** never imports src/app/**, src/tui/**, src/client/** or
  experimental Remote composition
src/client/** never imports experimental Remote composition
src/tui/transcript/** never imports PiTui, Tern, TuiApp, theme/icons, the
  renderer registry or another concrete TUI mechanics module
Remote is reached through one sanctioned lazy boundary
Direct remains the production/default backend
```

`src/client/**` is the Client-local platform capability and an INNER layer,
exactly like `src/app/**` and `src/tui/**`: the neutral domain and the Host
semantic/adapter layers never depend on it, and Client-local state never reaches
the Host transport. The architecture gate enforces `runtime/** !-> client/**`
for value, type-only and statically knowable dynamic imports with no allowlist;
`domain-imports-client` and `client-imports-remote-composition` are static
value/type-only rules.

The application/TUI direction is one-way at the implementation level:

```text
src/app/** owners            !-> src/tui/**
src/app/bootstrap.ts + helpers  may wire src/tui/** (composition)
src/tui/**                   may import application-facing contracts
```

Only the bootstrap composition zone selects a concrete TUI implementation and
injects it into an application owner through a narrow structural seam (the
Plugin Manager panel factory is the first such seam).

## Composition zone

`src/app/bootstrap.ts` is the composition FACADE; `src/app/bootstrap/**` holds
its cohesive wiring-only helpers. Together they may resolve, construct and
connect owners, and wire lifecycle, Host services and the mounted surface.

The facade keeps `applyRunner` / `applyRunnerWithRuntime`, the Cordis/process
prerequisites, Host service resolution, owner construction and connection, mount
and start ordering, and the top-level lifecycle (including the terminal-total
fatal catch). Helpers may select adapters (including Direct ones — the whole zone
is inside the Direct composition allowance) but never read Host services of their
own.

It must not become a business reducer or durable domain-state owner: business
decisions and durable state belong to the application owners and the semantic
runtime ports they consume. Resolving a Host service in order to construct an
owner is composition; owning that service's semantics is not.

Internal direction:

```text
src/index.ts           may import app/bootstrap.ts (the facade) only — never app/bootstrap/**
src/app/bootstrap.ts   may import app/bootstrap/** (and names itself)
src/app/bootstrap/**   may import SIBLING helpers; never app/bootstrap.ts
every other module     may import neither the facade nor the zone
```

## Mounted surface ownership

`src/app/surface/runtime.ts` is the ONE aggregate `createSurfaceRuntime()`
constructor: it builds the mounted `TuiApp` slot, wires the sub-owners together
and owns cross-sub-owner disposal ordering. Independent surface lifetimes live
in application-level owners next to it (notification, extension, Plugin Manager,
task, interaction and event-routing runtimes). Each is constructed exactly once
from `createSurfaceRuntime()`; no bootstrap code constructs them directly.

The notification split keeps the application status/current-agent authority in
`app/surface/notification-runtime.ts` and the terminal implementation in
`tui/notification/**`, connected by the injected structural
`TerminalNotificationPresentation` port.

The reusable transcript presentation core is `src/tui/transcript/**` and the
PiTui transcript mechanics are `src/tui/components/transcript/**`; `TuiApp`
keeps the mutable composition/renderer state (expansion sets, component caches,
viewport, hit maps).

## TUI and transcript authority

`TuiApp` is an implementation detail, not a semantic authority and not a public
extension API. Plugins consume host-owned extension APIs, registries and brokers,
never raw `TuiApp` or vendored `pi-tui` internals (see
[`extensions/stable.md`](../extensions/stable.md)).

There is ONE transcript semantic authority: `src/domain/transcript/**` owns the
durable chronology, turn/step identity, assistant/thinking convergence,
workflow/subcall projection, read grouping, compaction fusion, search corpus
identity/revision and `TranscriptItemId` allocation. `src/transcript.ts` only
re-exports those owners. TUI/Focus/Compact/Search presentation may consume those
facts but may not own an independent chronology or fold.

The presentation side is split one-way:

```text
PiTui transcript mechanics (tui/components/transcript/**)
  -> backend-neutral transcript presentation core (tui/transcript/**)
  -> semantic transcript facts (src/domain/transcript/**)
```

A TSP renderer consumes the SAME `tui/transcript/**` core; it never replaces or
duplicates it (see [`../tsp/overview.md`](../tsp/overview.md)).

## Direct and Remote

Direct is the current production/default provider. Remote is the experimental
in-process official wire. Both implement the same transport-neutral semantic
contracts defined by `src/runtime/**`; the contract is never derived from the
Direct implementation shape. The experimental Remote composition is reached only
through the one sanctioned dynamic boundary (`src/runtime/backend-loader.ts` →
`src/app/remote/runtime.ts`).

Locality, semantic-port ownership, currentness/generation fences and the
Direct/Remote test contract are owned by [host-client.md](./host-client.md).

## Extension locality

```text
Client imperative UI:
  callbacks/components/renderers/editors stay Client-local

Host business/domain state:
  remains Host-owned
  crosses Remote only as supported serialized facts/actions

no executable callback/component/renderer/editor crossing
```

Detailed locality rows, composition owners and wire stories live in
[host-client.md](./host-client.md); the extension-facing contract lives in
[`extensions/tiers.md`](../extensions/tiers.md).

## Source placement and the root ledger

`scripts/source-root-baseline.json` records the production root modules. The
ledger is CLOSED at exactly the seven stable entries/facades:

```text
builtins.ts, commands.ts, extensions.ts, index.ts, startup.ts, transcript.ts, tui-app.ts
```

There is no legacy root left. The architecture gate rejects a new unclassified
root module, a stale `stable` entry, a duplicate entry, an unknown schema, and
any recreated retired root path (including a forwarding shim or a production
import that names a retired path). Growing the root set is a deliberate contract
change (documentation and ledger together), never an ordinary refactor.

The architecture gate also enforces the dependency direction and the zones that
exist today. Its rule unit tests live in
`test/application-architecture-gate.test.mjs`.

```text
pnpm gate:architecture
  -> scripts/application-architecture-gate.mjs

gate:boundary
  -> scripts/client-boundary-gate.mjs  (Host coupling allowlist authority)
```

Do not merge those gates: `gate:architecture` owns application/module dependency
direction and source placement; `gate:boundary` owns which module may touch which
Host service/type. The Host allowlist is a JSON/gate authority, not prose in this
document.
