# Architecture: application ownership and dependency direction

> Status: CURRENT — Post-M3 architecture authority
>
> Audited baseline: `next @ c09e8ab0733425a3a50ce3941dc9bfca0367e413`
> (`M3 DONE / M4 NOT STARTED`, package `@xmoon76/dsh-pi-tui@0.5.1`).
>
> Later commits may move or split modules and rename internal owners; the
> ownership zones and the dependency direction below are the long-lived
> contract. Semantics beyond this document stay with their owning contract doc.

Host business coupling and the Direct → Remote migration are tracked separately:

- `docs/client-server-coupling.md` — Host business coupling / composition
  ownership inventory (the Host-boundary authority).
- `docs/client-server-migration.md` — the migration roadmap, stage history and
  per-stage qualification evidence.

## Ownership map

| Zone | Owner role |
|---|---|
| `src/index.ts` | public/package facade; delegates application startup |
| `src/app/bootstrap.ts` | application composition root; connects owners, lifecycle, services |
| `src/app/session/**` | Session application ownership/currentness/orchestration |
| `src/app/submission/**` | prompt/user-shell application orchestration |
| `src/app/command/**` | command authority/catalog/application facade |
| `src/app/surface/**` | mounted surface/application presentation ownership |
| `src/app/direct/**` | Direct-only application composition/owners |
| `src/app/remote/**` | experimental Remote composition/Client application ownership |
| `src/runtime/**` | transport-neutral semantic ports/contracts |
| `src/runtime/direct/**` | Direct semantic adapters |
| `src/runtime/remote/**` | Remote semantic adapters |
| `src/tui-app.ts` | current TUI root facade + remaining legacy presentation/interaction implementation |
| `src/commands.ts` | current built-in command definition monolith; TS1 convergence target |
| `src/transcript.ts` | ONE transcript semantic authority; TS7 modularization target |
| `src/extension/**` | extension service/Client-local extension ownership |
| `src/keybindings/**` | keybinding definitions/dispatch machinery |
| `src/footer/**` | footer composition/configuration |
| focused domain dirs (`image/`, `attachment/`, `plugin-manager/`, `status/`, `notification/`, …) | keep domain ownership |

`src/tui-app.ts`, `src/commands.ts` and `src/transcript.ts` are still the large
owners of their domains. That size is structural debt, not an invitation to move
their semantics into a new layer.

## Dependency direction

```text
src/index.ts
  ↓
src/app/bootstrap.ts
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
application owners never import bootstrap
Remote is reached through one sanctioned lazy boundary
Direct remains the production/default backend
```

## Composition root

`src/app/bootstrap.ts` may resolve, construct and connect owners, and wires the
lifecycle, Host services and the mounted surface.

It must not become a business reducer or a durable domain-state owner: business
decisions and durable state belong to the application owners (`app/session`,
`app/submission`, `app/command`, `app/surface`, `app/direct`, `app/remote`) and
the semantic runtime ports they consume. Resolving a Host service in order to
construct an owner is composition; owning that service's semantics is not.

## TUI

`TuiApp` is an implementation detail, not a semantic authority and not a public
extension API.

It still owns too many presentation/interaction responsibilities; TS4–TS6 will
converge those owners. This debt is structural, not a reason to move business
semantics into the TUI.

Plugins consume host-owned extension APIs, registries and brokers, not raw
`TuiApp` or vendored `pi-tui` internals. See `docs/extension-api.md`,
`docs/extension-tiers.md` and `docs/plugin-authoring.md`.

## Transcript

**There is ONE transcript semantic authority.**

`src/transcript.ts` — and the future `src/transcript/**` module split — owns the
semantic fold/projection facts: durable chronology, turn/step identity,
assistant/thinking convergence, workflow/subcall projection, read grouping,
compaction fusion, search corpus identity/revision and `TranscriptItemId`
allocation.

TUI/Focus/Compact/Search presentation may consume those facts but may not own an
independent chronology or fold. The Post-M3 TS7 modularization of
`src/transcript.ts` is an internal module split only: no second mutable
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

The gate is the mechanical enforcement of the dependency direction above. It
parses the TypeScript AST and rejects:

```text
src/runtime/**                    -> src/app/**
non-composition modules           -> src/app/direct/** or src/runtime/direct/**
owners / presentation / TUI       -> src/app/bootstrap.ts
the src/startup.ts static graph   -> experimental Remote composition
app/remote/** dynamic imports     -> any owner/target other than the ONE sanctioned edge
src/app/surface/**                -> new Direct<...>(...) semantic adapters
```

Its rule unit tests live in `test/application-architecture-gate.test.mjs`.

Do not merge this gate with the Host-coupling gate:

```text
gate:architecture
  = application/module dependency direction

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
TS1  commands.ts domain decomposition
TS2  app/bootstrap.ts composition-root decomposition
TS3  app/surface/runtime.ts surface-owner decomposition
TS4–TS6  TuiApp leaf / interaction / transcript-view extraction
TS7  transcript.ts internal modularization (ONE TranscriptFolder authority)
TS8  residual audit + architecture closure
```

Each PR that introduces a new architectural zone extends the architecture gate
for that zone; the gate deliberately enforces only the zones that exist today.
Detailed per-PR implementation instructions belong to the Post-M3 TS plans, not
to this authority document.
