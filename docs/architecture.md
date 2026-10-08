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
| `src/runtime/process/**` | low-level process-lifetime primitives: detached/owned task ownership, process diagnostics, synchronous disposal and total error observation (TS8-F) |
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
| `src/client/launcher/**` | Client-local launcher reads: the `--profile` argv scrape + resume hint (`profile.ts`) and the installed-dsh/bundle version reads (`version.ts`) (TS8-F2) |
| `src/client/git/**` | Client-local workspace git read: the nearest `.git/HEAD` branch probe (`branch.ts`) (TS8-F2) |
| `src/app/config/schema.ts` | the TUI plugin Cordis Config schema (the public `Config` re-export) (TS8-F2) |
| `src/app/bootstrap/profile.ts` | the authoritative running-profile read (Host `profileContext.name` first, argv fallback) (TS8-F2) |
| `src/app/bootstrap/exit.ts` | the interactive exit controller (latch → cleanup → retirement preparation → hint → `appExit`) (TS8-F2) |
| `src/app/bootstrap/legacy-settings-migration.ts` | the one-shot legacy settings.yaml migration (bootstrap composition; Direct settings types legal in the zone) (TS8-F2) |
| `src/app/command/authorization.ts` | the /login authorization bridge: target merge, notice rendering and prompt mapping over the config port's detached events (TS8-F2) |
| `src/app/surface/version-display.ts` | the welcome-card combined version line, composed from the Client-local launcher reads (TS8-F2) |
| `src/tui/startup/status.ts` | the pre-mount TTY-only startup status line (pure terminal presentation) (TS8-F2) |
| `src/domain/command/policy.ts` | transport/UI-neutral command-line policy: the local/sessionless name sets, the ONE line classification, attachment-line classification, skill-invocation normalization, advertised-miss consumption and the plain `exit` prompt rule (TS8-F3) |
| `src/domain/shell/danger.ts` | the neutral destructive-shell predicate the approval dialog uses (TS8-F3) |
| `src/app/submission/command-policy.ts` | application submission-facing policy: the image-rejection gate and the busy delivery resolver (they consume Client draft/composer facts) (TS8-F3) |
| `src/domain/catalog/provider.ts` | the neutral /login provider-catalog merge and credential-ref resolution (TS8-F3) |
| `src/domain/communication/**` | neutral communication policy: progress-updates / response-style / git-attribution / Focus section identity, parsers and the pure prompt text (TS8-F3) |
| `src/app/direct/system-prompt.ts` | the ONLY Direct systemPrompt composition + TUI section registration (progress updates, response style, git attribution, Focus) (TS8-F3) |
| `src/tui/pickers/sessions.ts` | terminal session-picker row assembly/presentation for `/sessions` (TS8-F4) |
| `src/domain/task/browser.ts` | transport/UI-neutral task-browser row model: job/subagent inputs, rows, ordering, runtime-activity projection, viewer-access semantics, interrupt parent and workflow-member target (TS8-F4) |
| `src/app/surface/task-presentation.ts` | Task Center/Quick presentation: panel items, scope/type/search projection, disclosure tree, row labels/descriptions and the Job-view fallback text (TS8-F4) |
| `src/app/surface/task-attention.ts` | Question attention → Task Center row mapping; `app/surface/question-controller.ts` owns `QuestionAttentionRow` (TS8-F4) |
| `src/app/surface/task-browser-runtime.ts` | Task Center refresh/currentness runtime and summary (TS8-F4) |
| `src/app/surface/viewer-policy.ts` | viewer open-token/currentness policy, session-swap teardown, viewer action capability and pending subagent-call matching (TS8-F4) |
| `src/app/surface/viewer-submission.ts` | viewer settle disposition / stale-settle target policy and the Host-file send scope (TS8-F4) |
| `src/runtime/subagent-outcome.ts` | backend-neutral subagent prompt refusal/indeterminate classification (TS8-F4; the detached DTOs live in `runtime/subagent-port.ts`) |
| `src/tui/transcript/workflow-presentation.ts` | Workflow card adaptive presentation, importing the canonical `domain/transcript/**` projection directly (TS8-F4) |
| `src/tui/interaction/transcript-search.ts` | PiTui transcript search input/focus/mouse/N-of-M interaction rendering (TS8-F5) |
| `src/app/surface/search-overlay.ts` | search open-overlay state, revision, current occurrence and refresh-step currentness (TS8-F5) |
| `src/app/surface/search-profile.ts` | observational search transaction-stage profiler (TS8-F5) |
| `src/app/surface/compaction-presentation.ts` | compaction phase/log presentation and the canonical `CompactionPhase` union (TS8-F5) |
| `src/tui/transcript/focus-timing.ts` | the per-surface Focus timing store (the process-global singleton was removed) (TS8-F5) |
| `src/tui/transcript/long-message-disclosure.ts` | visual-row long-message disclosure geometry (TS8-F5) |
| `src/tui/components/transcript/compact-text-preview.ts`, `thinking-preview.ts` | compact preview + visible-column thinking tail components (TS8-F5; they consume PiTui width mechanics, so they live under `tui/components/**`) |
| `src/tui/presentation/lines.ts` | terminal physical-row sanitation/presentation helpers (TS8-F5) |
| `src/tui/diagnostics/scroll-profile.ts`, `transcript-render-profile.ts` | render-cost profilers, grouped as TUI diagnostics (TS8-F5) |
| `src/domain/display/wheel-scroll.ts` | the persisted wheel-lines -> accepted wheel-step semantic (TS8-F5) |
| `src/client/shell/output-capture.ts` | Client retention of authoritative Host shell output: the byte/line-capped tail and the disk-capped full-output capture (TS8-F6; the truncation report is a private settle helper of `app/submission/user-shell.ts` and the duplicate `formatBytes` is deleted in favour of `domain/media/format.ts`) |
| `src/tui/process-slot.ts` | the process-local single-live-TUI slot guarding the fork's process-global keybindings (TS8-F6) |
| `src/tui/transcript/diff-projection.ts` | backend-neutral bounded diff derivation (structurally typed input, so it no longer depends on `@deepseek-ai/dsh-tools FileDiff`) (TS8-F6) |
| `src/tui/components/transcript/diff.ts` | concrete diff rendering: colors, optional absolute gutter and the folded-body cap (TS8-F6) |
| `src/tui/components/transcript/local-shell-card.ts` | local `!`/`!!` shell card display policy; it reads `TranscriptMessage` from the canonical `domain/transcript/types.ts` (TS8-F6) |
| `src/tui/components/indeterminate-progress.ts` | the ping-pong frame derivation for the working row's animated suffix (TS8-F6; it stays an independent animation source, not merged into `WorkingIndicator`) |
| `src/tui/interaction/autocomplete/skill-reference.ts` | the pure inline `/skill-name` token grammar and apply replacement (TS8-F6) |
| `src/app/surface/streaming-tool-preparing.ts` | the Preparing projection and the canonical `StreamingToolPreview`; the summary policy arrives as a REQUIRED injected `ToolSummaryKeys` (TS8-F6) |
| `src/tui/terminal/title.ts` | the OSC 0 terminal-title policy (sanitize, visible-cell cap, write) (TS8-F6) |
| `src/tui/transcript/client-tool-presenter.ts` | the Client-derived tool presenter for the Remote branch (TS8-F6) |
| `src/tui/components/working-indicator.ts` | the animated working row shown above the editor (TS8-F6) |
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
| `src/client/**` | Client-local non-TUI platform capability (local media, clipboard, artifact IO, launcher profile/version reads, workspace git branch) |
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
src/runtime/process/** never imports src/app/**, src/tui/**, src/client/** or the
  Direct/Remote adapters (`runtime/direct|remote/**`), and never loads a DSH
  business/service implementation package (only a FULLY ERASED `import type` /
  `export type` face and the Node standard library stay allowed)
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
source root). TS8-F continues from that ledger: F1 retires the four
process-lifetime roots (`detached.ts`, `diag.ts`, `disposal.ts`,
`error-boundary.ts`) into `src/runtime/process/**`, reaching
`stable = 6 / legacy = 45`; F2 then retires the eight
bootstrap/config/launcher roots (`authorization.ts`,
`legacy-settings-migration.ts`, `tui-config.ts`, `dsh-profile.ts`,
`dsh-version.ts`, `startup-status.ts`, `exit.ts`, `git-branch.ts`), reaching
`stable = 6 / legacy = 37`; F3 then retires the five
command/communication/provider policy roots (`command-policy.ts`,
`communication-policy.ts`, `focus.ts`, `git-attribution.ts`,
`provider-catalog.ts`), reaching `stable = 6 / legacy = 32`; F4 then retires
the nine session/viewer/task roots (`sessions.ts`,
`session-artifact-filename.ts`, `subagent-viewer.ts`,
`subagent-viewer-submit.ts`, `task-browser-runtime.ts`,
`task-center-attention.ts`, `task-presentation.ts`, `tasks-browser.ts`,
`workflow-presentation.ts`), reaching `stable = 6 / legacy = 23`; F5 then
retires the twelve transcript/search/disclosure roots
(`compact-text-preview.ts`, `compaction-presentation.ts`, `focus-timing.ts`,
`long-message-disclosure.ts`, `presentation-lines.ts`,
`scroll-render-profile.ts`, `search-overlay.ts`, `search-profile.ts`,
`search.ts`, `thinking-preview.ts`, `transcript-render-profile.ts`,
`wheel-scroll.ts`), reaching `stable = 6 / legacy = 11`; F6 then retires the
ten remaining tool/shell/terminal/completion roots (`bounded-output.ts`,
`diff.ts`, `local-shell-card.ts`, `process-tui-slot.ts`, `progress.ts`,
`skill-reference-completion.ts`, `streaming-tool-preparing.ts`,
`terminal-title.ts`, `tool-presentation-client.ts`, `working.ts`), reaching
`stable = 6 / legacy = 1` — `builtins.ts` is the ONLY remaining legacy root
until F7 reclassifies it.

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
TS8  residual source-tree / placement closure                   IN PROGRESS

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
`src/domain/transcript/semantics.ts`. TS8-F5 split the search surface into
`domain/transcript/search.ts` semantics, `app/surface/search-overlay.ts` state
and `tui/interaction/transcript-search.ts` interaction; `src/display-preset.ts`
was split by TS8-D into
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

TS8-F (PR F1) creates the constrained `src/runtime/process/**` layer for
low-level process-lifetime primitives and retires the four roots in the same
change (legacy `49 -> 45`, no forwarding shim):

```text
src/detached.ts        -> src/runtime/process/tasks.ts
src/diag.ts            -> src/runtime/process/diagnostics.ts
src/disposal.ts        -> src/runtime/process/disposal.ts
src/error-boundary.ts  -> src/runtime/process/errors.ts
```

The `runtime-process-imports-inner-layers` gate rule forbids `app/**`, `tui/**`,
`client/**` and `runtime/direct|remote/**` from the subtree, and
`runtime-process-imports-dsh-implementation` forbids loading a DSH
business/service implementation package (`@deepseek-ai/dsh-*`): only a FULLY
ERASED type face (`import type` / `export type`, which emits no runtime edge)
is allowed — an inline `import { type X }` still emits a module load under
`verbatimModuleSyntax: true` and is rejected — while Node standard library
imports stay allowed. The generic `runtime-imports-app|tui|client` rules carve
the subtree out, so the runtime-layer direction has one owning rule id here;
independent contracts (the bootstrap-composition rule, the Remote lazy-boundary
rule) can still report the same file under their own id.

TS8-F (PR F2) retires the bootstrap/config/launcher roots (legacy `45 -> 37`, no
forwarding shim) and removes the last architecture allowlist exception:

```text
src/authorization.ts             -> split: runtime/config-port.ts (AuthorizationFlowTarget)
                                    + runtime/direct/config-direct.ts (AuthorizationServiceLike,
                                      LLM_PI_AI_SCOPE, authorizationTargets)
                                    + app/command/authorization.ts (login merge/notice/prompt bridge)
src/legacy-settings-migration.ts -> app/bootstrap/legacy-settings-migration.ts
src/tui-config.ts                -> app/config/schema.ts
src/dsh-profile.ts               -> split: client/launcher/profile.ts + app/bootstrap/profile.ts
src/dsh-version.ts               -> split: client/launcher/version.ts + app/surface/version-display.ts
src/startup-status.ts            -> tui/startup/status.ts
src/exit.ts                      -> app/bootstrap/exit.ts
src/git-branch.ts                -> client/git/branch.ts
```

The retired root `versionAtLeast` implementation is not moved: the zero-dependency
`startup.ts` island keeps its own private comparator. `src/builtins.ts` consumes
the canonical `bundleVersion`/`dshVersion` instead of its private package reader.
The legacy-settings Direct type import is now legal inside the `app/bootstrap/**`
composition zone, so the historical gate allowlist is emptied
(`ARCHITECTURE_ALLOWLIST = []`) rather than re-pointed.

TS8-F (PR F3) retires the five command/communication/provider policy roots
(legacy `37 -> 32`, no forwarding shim):

```text
src/command-policy.ts        -> split: domain/command/policy.ts (pure line policy + classification)
                                       + domain/shell/danger.ts (destructive-shell predicate)
                                       + app/submission/command-policy.ts (image gate + delivery resolver)
src/communication-policy.ts  -> domain/communication/policy.ts (names/orders/parsers + pure text)
src/focus.ts                 -> domain/communication/focus.ts   (section identity + pure text)
src/git-attribution.ts       -> domain/communication/git-attribution.ts
src/provider-catalog.ts      -> domain/catalog/provider.ts
```

`app/direct/system-prompt.ts` is the ONLY owner of Direct `ctx.get('systemPrompt')`
composition and of the TUI section registration (progress updates 80, response
style 81, git attribution 82, Focus 90 — orders frozen); the neutral domain owns
the section identity, the parsers and the pure prompt text. The public package
entry keeps every command-policy name (re-exported from the three new owners).
`domain/command/policy.ts` takes the authoritative Host claim as a structural
`CommandLineHostClaim` input, so the neutral domain never imports the root
`commands.ts` facade.

TS8-F (PR F4) retires the nine session/viewer/task roots (legacy `32 -> 23`, no
forwarding shim):

```text
src/sessions.ts               -> tui/pickers/sessions.ts (dead helpers retired)
src/session-artifact-filename.ts -> inlined into app/command/artifacts.ts
src/subagent-viewer.ts        -> app/surface/viewer-policy.ts
src/subagent-viewer-submit.ts -> split: runtime/subagent-port.ts (DTOs)
                                       + runtime/subagent-outcome.ts (classification)
                                       + runtime/direct/subagent-direct.ts (Direct deliver helper)
                                       + app/surface/viewer-submission.ts (settle/stale policy)
src/tasks-browser.ts          -> split: domain/task/browser.ts (neutral row model)
                                       + app/surface/task-presentation.ts (row presentation)
src/task-presentation.ts      -> app/surface/task-presentation.ts (projection; zero-consumer projectedTaskIds retired)
src/task-center-attention.ts  -> app/surface/task-attention.ts; QuestionAttentionRow moves to app/surface/question-controller.ts
src/task-browser-runtime.ts   -> app/surface/task-browser-runtime.ts
src/workflow-presentation.ts  -> tui/transcript/workflow-presentation.ts
```

The retired `sessions.ts` `dsh-session` type edge disappears with its dead mapper,
so the client-boundary baseline drops that entry (31 coupled files). `tui-app.ts`
and the panels consume the application-owned task DTOs as types.

TS8-F (PR F5) retires the twelve transcript/search/disclosure roots
(legacy `23 -> 11`, no forwarding shim):

```text
src/search.ts                 -> tui/interaction/transcript-search.ts
src/search-overlay.ts         -> app/surface/search-overlay.ts
src/search-profile.ts         -> app/surface/search-profile.ts
src/compaction-presentation.ts-> app/surface/compaction-presentation.ts (owns the canonical CompactionPhase; tui-app.ts type-re-exports it)
src/focus-timing.ts           -> tui/transcript/focus-timing.ts (process-global focusTiming singleton removed; focusDurationText/the Focus component take the timing store explicitly)
src/long-message-disclosure.ts-> tui/transcript/long-message-disclosure.ts
src/presentation-lines.ts     -> tui/presentation/lines.ts
src/scroll-render-profile.ts  -> tui/diagnostics/scroll-profile.ts
src/transcript-render-profile.ts -> tui/diagnostics/transcript-render-profile.ts
src/thinking-preview.ts       -> tui/components/transcript/thinking-preview.ts (NOT tui/transcript/**: it consumes PiTui width mechanics, which the tui/transcript core rule forbids)
src/compact-text-preview.ts   -> tui/components/transcript/compact-text-preview.ts (zero-consumer compactTextPreviewLines retired)
src/wheel-scroll.ts           -> domain/display/wheel-scroll.ts
```

The search three-layer contract stays: `domain/transcript/search.ts` semantics,
`app/surface/search-overlay.ts` state/currentness, `tui/interaction/transcript-search.ts`
interaction. `tui/transcript/focus-timing.ts` reads `TurnActivity` from the
canonical `domain/transcript/types.ts`, never the root facade.

TS8-F (PR F6) retires the ten remaining tool/shell/terminal/completion roots
(legacy `11 -> 1`, no forwarding shim):

```text
src/bounded-output.ts        -> client/shell/output-capture.ts (formatTruncation became a private settle helper in app/submission/user-shell.ts; the duplicate formatBytes is deleted in favour of domain/media/format.ts)
src/process-tui-slot.ts      -> tui/process-slot.ts
src/diff.ts                  -> tui/transcript/diff-projection.ts (derivation) + tui/components/transcript/diff.ts (rendering)
src/local-shell-card.ts      -> tui/components/transcript/local-shell-card.ts
src/progress.ts              -> tui/components/indeterminate-progress.ts
src/skill-reference-completion.ts -> tui/interaction/autocomplete/skill-reference.ts
src/streaming-tool-preparing.ts -> app/surface/streaming-tool-preparing.ts (owns the canonical StreamingToolPreview; the summary policy is injected as ToolSummaryKeys, so app/** never imports tui/transcript/tool-presentation.ts)
src/terminal-title.ts        -> tui/terminal/title.ts (status-runtime takes a required updateTerminalTitle seam; bootstrap applies terminalTitleOf -> setTerminalTitle)
src/tool-presentation-client.ts -> tui/transcript/client-tool-presenter.ts
src/working.ts               -> tui/components/working-indicator.ts
```

The two F6 composition seams are deliberate, and they run in OPPOSITE
directions:

```text
tui/transcript/tool-presentation.toolSummaryKeys (the canonical candidate-field policy)
  -> bootstrap injection -> app/surface/streaming-tool-preparing fold -> DTO -> TuiApp

app/surface/status-runtime (semantic identity facts: session title, official session workspace cwd)
  -> injected composition policy (terminalTitleOf -> setTerminalTitle) -> OSC 0 sink
```

So `app/**` keeps its "no concrete `tui/**` import" direction: the canonical
TUI summary policy is injected INTO the application fold, while the terminal
write mechanics are injected OUT of the status owner. `builtins.ts` stays the
only legacy root.

The OSC 0 window title and the OSC 7 terminal-LOCAL cwd are DISTINCT
authorities, and the F6 plan-owner ruling (2026-10-08) settled the contract:

```text
OSC 0 (window title, Session identity)   OSC 7 (terminal-local cwd, OSC 7 pane)
1. session title non-empty        -> dsh · <sanitized session title>
2. else official Session cwd known -> dsh · <shortCwd(official session cwd)>   (Direct and Remote alike)
3. else (Remote projection absent) -> dsh        (never the Client launch cwd)
4. else (sessionless Direct)       -> dsh · <shortCwd(Client launch cwd)>
5. a Remote Host cwd may be shown as OSC 0 identity, but is never published as the OSC 7 terminal-local cwd
```

The frozen F6 plan §10.12 proof line "Remote Host cwd never becomes Client
terminal title cwd" conflated those two authorities; the line is CORRECTED by
this ruling and is not implemented as a title behavior change. The seam stays
`updateTerminalTitle({ sessionTitle, cwd: sessionCwdFact() })` — the cwd
source is never re-chosen in the terminal adapter. Pinned by
`test/tern-terminal.test.ts` (the fact/observable matrix, including the
`dsh · host/alpha` projected-Host-cwd case) and by the connected OSC 0 proof
in `test/terminal-title.test.ts`.

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
