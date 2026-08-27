# AGENTS.md

dsh-pi-tui — a third-party TUI mode for DeepSeek Harness (`dsh`), built on a vendored fork of [pi-tui](https://github.com/MoonshotAI/kimi-code/tree/main/packages/pi-tui). Read this file before editing.

## Naming (hard rules)

Collision-avoidance is a deliberate choice: the official dsh project will plausibly ship its own `dsh-tui` / `@deepseek-ai/dsh-tui`, so nothing here may use that family.

| Thing | Name | Notes |
|---|---|---|
| Repository | `dsh-pi-tui` | repo root (this directory) |
| Profile (`dsh --profile`) | `pi-tui` | **Never `tui`** — that is reserved territory |
| Vendored fork package | `@xmoon76/pi-tui` | rescopped from `@moonshot-ai/pi-tui`; `private: true`, **never published** — bundled into the release package at build time |
| Bundle package | `@xmoon76/dsh-pi-tui` | the `dsh.bundle` patch layer; the **only** published package |
| Plugin row ids | `tui-startup`, `tui-app` | internal Loader ids, fine as-is |
| Startup service | `tuiStartup` (`TUI_STARTUP_SERVICE`) | |

## Working rules (user-enforced)

- **Never push to a remote (and never force-push) without the user's explicit
  confirmation** — commit locally only unless told otherwise.
- **English only** for every user-facing string, comment, commit message and
  doc — including preset description YAML and the context-injection label
  (both crept in as Chinese once); scan `src/` and `config/` for CJK before
  committing. i18n is deferred.
- **README bilingual sync (hard rule).** `README.md` (简体中文, the npm
  landing page) and `README.en.md` (English) must stay in sync: every change
  to one README must be mirrored in the other in the same commit — including
  wording, structure and links. Each README carries a language switcher at
  the top linking to the other. This rule is one of two exceptions to
  "English only" (README.md is intentionally Chinese; the changelog pair
  below is the other).
- **No near-synonym command names.** `/session` was renamed to `/status`
  after colliding with `/sessions`; before adding a command, check the
  existing set and the official dsh command set for confusion risk.
  Approved exception (2026-08): `/statusline` is an EXPLICIT alias of
  `/footer` — kept for other-agent muscle memory, unambiguous because it
  resolves to the same configurator, `/status` keeps priority matching,
  and the completion catalog marks it "(alias of /footer)". The rule
  still applies to NEW independent commands; the rationale lives in the
  `/footer` registration comment (src/commands.ts).
- **Changelog must be updated on every release (hard rule).** Any release
  (a `chore: release vX.Y.Z` bump + `v*` tag) MUST update `CHANGELOG.md`
  in the same commit, following
  [Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/): an
  `[Unreleased]` section on top, versioned sections below ordered newest
  first, each dated with the release day, grouped into the
  `Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`
  categories, and link references at the bottom. Entries must be written
  for humans (what changed and why it matters), not a dump of commit
  subjects — merge the review rounds and repeated fixes into their
  user-facing outcome. Before tagging, move the accumulated `[Unreleased]`
  entries into the new version section; afterwards, start a fresh
  `[Unreleased]` for the next cycle. Semantic-versioning rules apply: any
  breaking change is a major bump.
- **Changelog bilingual sync (hard rule).** `CHANGELOG.md` (简体中文) and
  `CHANGELOG.en.md` (English) must stay in sync, exactly like the
  README pair: every release update to the Chinese changelog must be
  mirrored in the English one in the same commit (same sections, same
  entries, same dates and links), and vice versa. This is the second
  sanctioned exception to "English only" (CHANGELOG.md is intentionally
  Chinese). The root READMEs carry changelog links listing both
  changelogs — keep those in sync too.
- **Reference, don't copy.** pi/kimi-code are appearance references; behavior
  is implemented in dsh-pi-tui itself.

## Repository layout

```
packages/pi-tui/    Vendored @moonshot-ai/pi-tui fork. The vendored version
                    and upstream commit live in ONE place —
                    packages/pi-tui/package.json `repository.note` (see
                    that field, never a copy in this file or README). Its
                    own AGENTS.md (kept from the fork) is the source of
                    record for the local divergence fixes and their
                    guarding tests; re-verify every entry on each
                    re-vendor. native/ prebuilds are NOT vendored; loading
                    degrades gracefully without them.
.                   The repository root IS the @xmoon76/dsh-pi-tui bundle
                    (the only published package). cordis.patch.yml
                    inserts the startup row (parses `dsh --profile pi-tui` flags)
                    and the runner row (starts the TUI). src/tui-app.ts is the
                    testable surface core (terminal injected); src/theme.ts the
                    palette; demo.ts a standalone interactive demo. Builds with
                    tsdown into dist/, bundling @xmoon76/pi-tui (deps.onlyBundle)
                    so the tarball is self-contained; dist/ is gitignored —
                    build before install. The tarball is verified by
                    scripts/tarball-smoke.mjs (prepack builds + runs the
                    suite, postpack smokes the exact packed bytes; root
                    `pnpm pack:release`).
```

## Key decisions (do not silently reverse)

1. **Direct today, DSH-native client incrementally.** The production
   `dsh --profile pi-tui` path currently runs in-process and consumes Host
   services directly through the Direct backend. That remains the default and
   rollback path while the TUI is migrated, capability by capability, toward
   a DSH-native Client over the official API/Remote/event contracts. The
   migration is explicitly dual-stack: first isolate semantic ports without
   behavior change, then add opt-in wire backends, then prove local
   in-process/IPC transport parity, and only in a dedicated later milestone
   consider flipping the default. Remote attach is a planned capability, but
   it must not bypass DSH's security model or make ordinary local use depend on
   a TCP listener.
2. **Vendored fork, not npm dependency.** `@moonshot-ai/pi-tui` is not published (npm 404). Vendored from the kimi-code fork (not upstream pi-mono) to keep its local fixes; the earlier "five" (CJK wrap recursion guard, container width clamp, overwide-line truncation instead of throw, negative-width guards, per-frame processed-line reuse) are no longer divergences — the vendored snapshot (kimi-code `44a6c70e`) already contains the first four, and the last never existed in this fork. `packages/pi-tui/AGENTS.md` is the source of record for every divergence and its guarding tests — re-verify each entry on every re-vendor.
3. **`TuiMainScreen`, not `TUI`.** In this fork the constructible entry is `TuiMainScreen` (main screen + scrollback, `mode: "regular"`); the README's `new TUI(...)` is stale upstream docs. `TuiAltScreen` is the alternative.
4. **Source exports, built artifacts.** The root bundle and the fork both build with tsdown (`dist/`); the root package bundles the vendored pi-tui fork (`deps.onlyBundle: ['@xmoon76/pi-tui']`, the kimi-code pattern) so the published tarball is self-contained. `exports` point at built files; neither `dist/` is committed — build before installing into a profile. Node 26 refuses type-stripping inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts`-exporting package cannot load from a profile's node_modules.
5. **No native prebuilds.** darwin/win32 modifier-key addons are optional; the loader returns `undefined` on other platforms without attempting a load. Revisit only if modifier detection matters on macOS/Windows.
6. **`chalk` is a runtime dependency** of the root bundle (theme.ts lives in `src`, unlike pi-tui's tests-only chalk).
7. **Single-package release model.** `@xmoon76/pi-tui` is `private: true` and never published (same as `@moonshot-ai/pi-tui` in kimi-code); `@xmoon76/dsh-pi-tui` is the only registry package and carries the fork inside its dist. Its `dependencies` therefore list pi-tui's runtime deps (`marked`, `get-east-asian-width`) directly, and `@xmoon76/pi-tui` lives in `devDependencies` (build-time only). **Every `@deepseek-ai/*` import is a `peerDependency`, never a `dependency`**: in-box packages resolve from the dsh installation itself, and a duplicate copy in the profile's `node_modules` crashes on the FIRST tool call (`Cannot read properties of undefined (reading prepare)`). After (re)installing the bundle into a profile, verify `node_modules` contains NO `@deepseek-ai` entry. Same rule for dsh context services: type them structurally (`ctx.sessionQuery`), do not add package dependencies for them.
8. **Fix in the root dsh-pi-tui bundle first; keep the fork pristine.** Anything achievable on the consumer side must be implemented in the root package — every fork change is a divergence that must be re-verified on every upstream sync (the fork's AGENTS.md lists them with guarding tests). Only touch `packages/pi-tui` when the fix is impossible from the consumer. Example: the slash-command autocomplete lag (the fresh list never painted in fullscreen because the editor's render requests target the stopped main screen) is fixed by `TuiApp.routeInput` forcing a repaint of the ACTIVE screen — no fork change needed.
9. **Busy-Enter preference mirrors the web's `busyEnter`** (`ui-conversation` submission policy): while the agent is running, plain Enter uses the configured mode (`queue` default | `steer`) and Ctrl+Enter ALWAYS forces queue mode (the anti-steer chord — it only differs from Enter when the configured mode is `steer`). Enter-steer sends the DRAFT ONLY (`steerAll` `onlyDraft`) — explicitly queued messages are never swept along, because already-steered input cannot be pulled back. **Local commands** (the TUI-owned set, `LOCAL_COMMANDS` in index.ts: /status, /settings, ...) always execute directly and are never steered; everything else — plain prompts AND per-skill slash commands — steers as its raw `/name` line, which the host's pre-step listener (dsh-tool-skill) resolves into the injected skill body: web parity, where a skill invocation is a plain `session.prompt` with no command-execution wire. **Skill invocations never drop the user's arguments**: a per-skill wrapper forwards `invocation.rawInput` VERBATIM as a plain user message (the user's own words stay on the original `/name args` line), and the loaded body follows as injected instructions context — rendered by the host's dsh-tool-skill pre-step listener when its `skill` tool is visible to the agent, else injected by the TUI itself as a fallback (official `<skill_content>` rendering + `skill-invocation` source), never both (double injection would duplicate the body). The queue-pane hint and Ctrl+S are unchanged (the steer verb is always advertised).
10. **Question dialogs live in the editor SEAT, never a centered overlay.** `ask_user_question` renders inside `editorSeat` (kimi's `mountEditorReplacement` pattern): full width, above the footer, capped at 60% of the terminal height when COLLAPSED (8..24 content rows, re-derived on EVERY render by `QuestionFrame` — resize- and queue-safe). The flow is a logical capturing modal: `presentQuestion` suspends visible overlays, `settleQuestions` restores them, and overlays created during a question join the suspension graph (`closeOverlayHandle`) so reverse modal order survives. `QuestionFlow`'s budget math (required-first question row, pinned free-text input, hint) is proven against actual chrome — do not reintroduce a fixed `budget - N` body formula. **The whole page — question, detail, EVERY option with its description, the free-text row — is ONE unified scrollport** (PageUp/PageDown page it; the `↓ N more lines`/`↑ M up` marker reports the remainder), so on any screen size the question starts at the top and every description is reachable by scrolling; cursor moves (↑↓/digits/click) follow the pointer into view. An explicit expand (`e` or a fullscreen click on the marker) grows the frame toward 80% (budget up to 38) — the 60% cap is the DEFAULT, not a hard ceiling — and is a no-op when everything fits; it KEEPS the scroll position (reveals more where the user is looking), and scroll + expand reset on every tab change. The hint fit loop RESERVES `esc cancel` (it always survives; other verbs drop from the end), and empty free-text rows show a dim placeholder instead of a bare cursor block. Fullscreen clicks inside the frame route through the seat's bottom-derived geometry (`QuestionFrame.rows` + footer height) to `QuestionFlow.clickRow`. **↑↓ scroll at the scrollport EDGES** (the less/scrolloff pattern): ↑ on the FIRST row scrolls the body up until the question overview returns, ↓ on the LAST row scrolls it down when the page overflows — without edge scrolling, walking the cursor into the options made the question unreachable (the old cursor wrap stole the ↑). The wrap-around survives when the page fits. Full rationale: `temp/question-dialog.md` (gitignored; on the implementing machine).
11. **Surface catalog: prefetch + coordinator + STANDING-SCOPE cold skills, no probe code.** The first input must eventually see the effective agent-scoped command + human-skill catalog, but opening the TUI must not create a chat session: `--session` PREFETCHES the resumed agent's catalog before mount (synchronous install during command registration); the deferred start reads the cold HUMAN SKILL catalog through the effective preset's STANDING SCOPE (`agentPresets.standingKeyFor(id)` → `skills.snapshot({cwd, scope})` — no Agent, no session, no turn). **Composition probes are REMOVED** (module + tests deleted): host-level `session/created` observers (dsh-permission-presets) write durable knob events into every fresh session, so any probe fails the zero-event gate and materializes a session artifact (200ms write-behind) — verified empirically; never reintroduce `agents.create()` for catalog discovery. Post-mount refreshes go through ONE `CatalogRefreshCoordinator` (epoch + abort + latest-only commit; agent targets install the live surface, preset targets install standing skills only; target changes turn old skill wrappers into revalidating transitions; a standing degradation rides the applied outcome as a one-shot notice; `skills/change` bursts are coalesced by `CoalescingRefreshGate` and always re-read the CURRENT ownership). All upstream service access is isolated in `src/skill-catalog.ts` (structural types; `standingKeyFor`/`snapshot` are capability-detected — an upstream change degrades to missing commands, never a crash). Full contract: `docs/surface-catalog.md`.
12. **Extension API is a compatibility boundary.** `@xmoon76/dsh-pi-tui/extensions` is a public plugin SDK; Host changes must preserve existing public extension semantics and third-party lifecycle behavior. See `docs/extension-api.md` and the **Extension compatibility (hard rules)** section below; never fix a STABLE extension limitation by exposing private TUI/terminal internals — lower-level access, when genuinely required, belongs to the Advanced/Unstable entries via their supported package boundary (never repository-private imports).
13. **Advanced captures sit AFTER host flows, BEFORE the editor (Phase 2 contract).** The advanced normalized input capture stage runs in `TuiApp.handleInput` after the host's own capturing flows (questions, approvals, overlays) and reserved lifecycle keys, and before the editor and the Stable keybindings — an advanced plugin can preempt ordinary editor/panel input, but never a Host question/approval/overlay or a fatal-recovery shortcut (session safety stays Host-owned). The plan's ladder sketch places captures before host flows; the "Host 保底" section explicitly leaves the contract to the phase, and session safety wins. Do not move the stage without re-reviewing that tradeoff. The interactive overlay's focused component receives input through pi-tui's focused-component dispatch (the app listener returns undefined while an overlay is up) — that is the "focused advanced component" stage, and it DOES see Esc and other keys the global captures never see.
14. **Advanced exclusive = sole capture consumer, explicit conflict.** A second live exclusive capture registration is an explicit error (never a load-order winner); observers still run under exclusive (they never consume); a throwing exclusive handler fails open to the Host. The registry's ordering is priority ASC then id ASC — the ledger's rule, load order never decides.
15. **Unstable raw stage sits BEFORE everything; the fail-safe is triple-Esc (Phase 3 contract).** The unstable raw interception runs at the TOP of `TuiApp.handleInput` (before protocol filtering, questions, reserved keys — a raw capture can see/consume/rewrite ANY chunk, including Esc/Ctrl+C/CSI-u). The Host emergency fail-safe is detected FIRST (before the captures): three Esc presses within 1.5s release every raw capture and close every unstable mount, restoring Host input. The first two Esc presses pass through (a plugin surface may use Esc); the third is consumed by the Host. The fail-safe is armed only while captures are live, so ordinary Esc behavior is unchanged otherwise. A rewrite re-runs the host's own processing with the replacement AND propagates it to the focused component via the fork's listener-result `data` field — each chunk passes the interception chain at most once (the rewrite never re-enters the raw stage). The low-level surface seam never exposes TuiApp/screens/terminal.
16. **Phase 4 broker reuses the Host's own modal infrastructure; prompts are fiber-cancelled (Phase 4 contract).** The imperative UI broker (`advanced.ui.select/confirm/input/notify/custom`) is built on the Host's OWN picker/question/notify infrastructure — never a second modal manager. Every prompt is caller-fiber-owned: the service creates an AbortController per call, registers a fiber effect that aborts it (combined with the caller's signal via `AbortSignal.any`), and the app's implementations settle the promise on abort; the surface's final dispose settles every still-open broker promise (`pendingBrokerSettles`). `ui.custom`'s factory receives ONLY the public `AdvancedCustomHost` facade (never a private TUI object) and resolves via `done(result)`/`close()`. The host-state facade (`advanced.host`) is a LIVE override surface — theme persistence stays with the user's `/settings` picker; `setTheme` for a non-built-in name resolves the palette through the theme registry in the runner (unknown names are a no-op).
17. **Phase 5 examples prove the tiers; the vim editor uses the GETTER pattern (Phase 5 contract).** The real-plugin validation lives in `examples/plugins/` (vim — Advanced editor SDK; questionnaire — Advanced imperative UI broker; interactive-shell — Unstable raw seam), gated by `scripts/examples-plugin-smoke.mjs` against the packed tarball. The vim example's live repaint uses `get component()` on the ExtensionEditor (the seat recompiles `editor.component` on every `host.invalidate()` — the getter returns the CURRENT buffer view; `ExtensionEditor.component` is readonly, so the getter is the clean live-repaint path, never a mutation of a readonly-typed object). The API gap process and the Stable promotion review are recorded in `examples/README.md`; the authoring decision tree lives in `docs/plugin-authoring.md`. Do not expand Stable to make a Phase-5 example work — the tier selection is the point.
18. **User input = brand-blue bubble; the editor carries a matching `❯ ` prompt (dsh-web parity, consumer-side).** The user's own words render as a floating BLOCK — `UserBubbleComponent` paints the whole row with the `roleUserBg` bubble background (dsh-web `--dsw-specific-bubble` parity: `#2C2C2F` dark / `#E4EDFD` light, DeepSeek brand-blue family) and leads it with a `roleUser`-coloured `❯` (`#679EFE` dark / `#4177E6` light) — NOT kimi's amber text colour, so the user role never collides with kimi or with the assistant's brand-blue whale. The queue pane's `❯` and the editor prompt use the same `roleUser` marker: one brand-blue ❯ for the user's own input everywhere. The host editor is constructed with `paddingX: 2` and `TuiEditor.render` paints the prompt over the first content row's leading padding (kimi's injectPromptSymbol pattern — no fork change; the fork stays pristine per decision 8); the prompt is skipped while the draft is scrolled (the `↑ N more` indicator makes the first visible row a continuation). `roleUserBg` is an OPTIONAL palette token: absent (custom themes) → the bubble collapses to plain rows, and the component is REFERENCE-STABLE like BulletedComponent — same child instance + same width → identical rendered strings, so the differential renderer paints a zero-change frame (no per-frame line cache exists in the fork; do not rely on one). Theme switches stay correct because the per-message component rebuilds on `themeRevision` (the baked ANSI is not frozen). `scripts/preview-role-styles.mts` (scheme comparison) and `scripts/preview-prompt.mts` (live surface) show the effect in a real TTY. Guarded by the bubble and role-colour tests in `test/rendering.test.ts` and the editor-prompt tests in `test/tui-app.test.ts`.
 19. **Injected context rows render their envelopes parsed, never the raw XML (consumer-side, dsh-web row-model parity).** Loading a skill — the TUI fallback OR the host's dsh-tool-skill listener — injects the model-facing `<skill_content>` body as a context row; the skill catalog and workspace instructions similarly bake complete `<system-reminder>` frames into their content (harness caller-owned framing). The expanded labeled system row used to dump those envelopes verbatim (`message.text` — the one leak 56d017c's tool-card fix did not cover, since system rows render `text`, not `result`). `systemContextBody` in present.ts derives the presentation body: a well-formed skill envelope renders its instructions body; a `<system-reminder>`-wrapped producer renders its content with the wrapper tag lines (and the `<available_skills>` markers, only when the pair is present) stripped; a malformed skill envelope renders NO body (never the raw tags); any other text is unchanged (plain context rows keep their raw-body behavior). The model-facing bytes are untouched — presentation only, and the header already names the producer, so the divergence from the web's deliberate framing-verbatim instruction rows is documented here. Folded skill rows gain the tool-card `— N lines of instructions` suffix (reusing `skillFoldedPreview`) so the fold still says what the model received. Subagent viewers and search jumps share the same component path, so the fix covers them transitively. Guarded by the `systemContextBody` and injected-row tests in `test/rendering.test.ts`.

## Server/client migration guardrails (hard rules)

The production TUI is currently an in-process DSH surface. We are migrating it
incrementally toward a DSH-native client architecture, but the migration must
not disrupt ordinary `dsh --profile pi-tui` usage or ongoing feature work. The
migration source of truth is `docs/client-server-migration.md` (phase status,
backend default, rollback state) and the coupling allowlist lives in
`docs/client-server-coupling.md` — read both before touching Host-coupled code
and update them in the same PR.

- **Direct remains the production default until an explicit migration
  milestone changes it.** Experimental client/wire backends are opt-in. Do not
  silently change the execution model of `dsh --profile pi-tui`, `--session`,
  or `--preset` while implementing migration groundwork.

- **No new Host coupling outside an approved boundary.** New feature code must
  not directly add reads/writes through `ctx.agents`, `ctx.sessions`,
  `ctx.subagents`, `ctx.jobs`, `ctx.credentials`, `ctx.userQuestions`,
  persistence services, or concrete `Agent` / `AgentHandle` / `Session`
  objects in UI, command, controller, or presentation modules. Use an existing
  semantic port/adapter. If none exists, add the smallest domain-specific seam
  first. Existing coupling may remain on the migration allowlist until its
  owning phase moves it. Enforced by `scripts/client-boundary-gate.mjs`
  (baseline allowlist + no-new-debt; see M0 in the migration doc).

- **Do not replace Context with another god object.** There is no universal
  `TuiBackend` carrying every capability. Keep interfaces narrow and
  domain-owned (session read/write, subagent, interactions, catalog/config,
  Host files, etc.). Consumers depend only on the capability they use.

- **Every new feature declares locality.** Classify it as client-local,
  Host-owned, or explicitly split. Terminal rendering, key handling,
  clipboard, draft state and local UI history are client-local. Agent,
  Session, subagent, jobs, persistence, model/provider state, skills,
  credentials and Host workspace files are Host-owned. Ambiguous features
  such as shell execution, external editing, file references and export must
  define which machine owns each operation.

- **Never assume Client cwd/filesystem == Host cwd/filesystem.** A path valid
  in a local Direct run may refer to a different machine under remote attach.
  Host workspace paths and `@file` discovery must have a Host-side capability
  path. A remote-mode feature must fail closed rather than silently operate on
  the Client filesystem with Host semantics.

- **Host-owned behavior needs a wire story.** Prefer the official DSH
  `IApiClient`, Client Runtime, generated Remote namespace, mux/host stream or
  another upstream contract. Do not create a TUI-specific RPC/event/DTO when
  DSH already owns the concept. When upstream has no suitable Remote yet,
  capability-gate the feature and record the gap instead of baking an
  in-process assumption into new UI code.

- **Direct and wire implementations share semantic contracts.** The current
  Direct path becomes an adapter behind the same domain interface the future
  wire path implements. A migrated capability gets contract tests that can run
  against both implementations. Do not maintain two independent feature
  semantics.

- **Transport correctness does not belong in TUI rendering code.** Reconnect
  generations, history/live races, event gaps, queue baselines, pending
  approval/question replay and Host stream reconciliation belong to the DSH
  Client Runtime/connection layer (or a narrow transport adapter), not
  `TuiApp` or card renderers.

- **Remote async work must be stale-safe.** Any result that can settle after a
  session/view/backend transition must re-check the relevant generation or
  identity before mutating visible state. Preserve the repository's existing
  stale-result discipline; a process boundary increases, not reduces, this
  requirement.

- **Do not move callbacks across the process boundary.** Client extension
  callbacks, renderers, key handlers and editor objects stay in the Client/TUI
  runtime. Cross-boundary integration uses serializable data, stable
  identities, Remote calls and events. Never invent callback serialization.

- **Stable extension compatibility survives the migration.**
  `@xmoon76/dsh-pi-tui/extensions` remains an additive-first compatibility
  boundary. Do not make Stable plugins import DSH Host internals or rewrite
  against a new transport merely to enable server/client migration.
  Advanced/Unstable keep their documented compatibility policies.

- **Session ownership safety is not migration cleanup.** The Direct backend's
  owner lock, lease/cooling state machine, PINNED quarantine, divergence guard,
  transition gate and operation barrier remain authoritative until a dedicated
  later milestone proves that every TUI session write is Host-owned and
  cross-client concurrency is safe. Do not remove or weaken them as
  preparatory refactoring.

- **Startup stays a zero-dependency compatibility island.** Experimental
  client/runtime imports must not enter `src/startup.ts`'s static dependency
  graph and break the friendly Harness compatibility gate. Load optional
  backend code only after startup selection.

- **Keep the existing DeepSeek package ownership rule.** New
  `@deepseek-ai/*` imports remain peer dependencies and resolve from the
  installed Harness. Prefer capability detection/structural typing where a
  feature can degrade; raise the global minimum Harness version only when a
  production-default path truly requires it.

- **Migration work is off by default until its phase acceptance gates pass.**
  Every migration PR must leave the current Direct path green. A later default
  flip is its own milestone and must retain an explicit Direct rollback path
  for at least one release cycle.

Before adding a feature that touches Host state, answer these four questions in
the implementation/review:

1. Is this state Client-local, Host-owned, or split?
2. Which semantic port owns it?
3. What official DSH wire capability maps to it, or what documented gap blocks
   remote mode?
4. Which Direct + wire contract test prevents the two backends from drifting?

### Extension API tiers

The extension platform has three tiers:

- `extensions`: Stable, semantic, compatibility-oriented.
- `extensions/advanced`: Experimental higher-level interactive APIs; minor releases may break.
- `extensions/unstable`: Low-level escape hatches with no compatibility guarantee.

Do not expand the Stable API solely to support a plugin that inherently
requires low-level input, custom component, or Host-policy bypass behavior.
Place such capabilities in Advanced or Unstable instead.

All tiers must reuse the shared Cordis ownership and surface lifecycle model.

All extension plugins remain standard DeepSeek Harness / Cordis plugins using
`name`, `inject`, and `apply(ctx)`. API tiers are capability facades over the
single `piTuiExtensions` service, not separate plugin systems or runtimes.

### Extension API tier boundaries

- Stable extension APIs must remain semantic and Host-controlled. They must
  not expose raw terminal input, private Host objects, private screen/layout
  objects, or repository-internal imports.
- Advanced extension APIs may expose experimental interactive abstractions,
  normalized input ownership, custom editor/component contracts, and other
  higher-freedom capabilities.
- Unstable extension APIs may deliberately expose low-level input,
  Host-policy bypass, exclusive ownership, or selected implementation-coupled
  primitives when required by the feature.
- Advanced and Unstable do not permit arbitrary repository-private imports.
  Low-level access must still be exposed through the supported package entry.
- Do not expand Stable only to make a plugin work when the capability
  naturally belongs in Advanced or Unstable.

## Extension compatibility (hard rules)

`@xmoon76/dsh-pi-tui/extensions` is a public plugin SDK. Changes to the
host must preserve existing extension behavior unless the change is an
explicitly planned breaking API change.

- **Treat extension compatibility as part of every TUI change.** Before
  changing editor input, commands, themes, settings, autocomplete,
  keybindings, transcript/tool rendering, overlays, chrome slots, surface
  state, focus/lifecycle handling, or root composition, check whether the
  behavior is exposed through the extension SDK or consumed by first-party
  builtins / the acceptance plugin.
- **Do not bypass the public extension path for new extensible features.**
  If a feature belongs to an existing extension point, extend/reuse that
  extension point instead of adding a parallel host-only implementation.
  First-party extensible behavior should use the same public composition
  path as third-party plugins where practical.
- **Never expose host internals to fix a plugin limitation (Stable tier).**
  Stable public APIs must not expose `@xmoon76/pi-tui`, `TuiApp`,
  `TuiMainScreen`, `TuiAltScreen`, raw screen/terminal objects, private
  components, or repository-internal paths. Do not add
  `unsafeGetTuiApp()`, `unsafeGetTerminal()`, raw-component escape
  hatches, or equivalent APIs to the Stable surface. Add a semantic
  capability instead; lower-level access, when genuinely required,
  belongs to the Advanced/Unstable entries (via their supported package
  boundary — never repository-private imports).
- **Preserve caller-owned registration lifetime.** Plugin registrations
  and subscriptions belong to the calling Cordis fiber. Recreating,
  stopping, restarting, or replacing a TUI surface must not silently
  remove registrations owned by a still-live plugin fiber. Surface-owned
  resources such as physical overlay mounts and editor-host capabilities
  must become inert when that surface dies.
- **Plugin unload/HMR must leave no residue.** Every plugin-owned
  registration, subscription, overlay lease, editor contribution,
  renderer, keybinding, command metadata, setting, theme and autocomplete
  provider must be cleaned up when its owner fiber unloads. Explicit
  disposal and owner disposal must be idempotent.
- **Host input policy stays Host-owned (Stable tier).** Terminal protocol
  decoding (including Kitty CSI-u / modifyOtherKeys), reserved lifecycle
  shortcuts, question/approval capture, submission policy and session
  safety must not be delegated to third-party plugins on the Stable
  surface. Stable public input APIs expose normalized semantic events, not
  terminal escape sequences. (A future Unstable tier may deliberately
  provide input interception/ownership through its own supported entry —
  never as a Stable addition, and never through repository-private
  imports.)
- **Do not create parallel execution paths.** Extension bridges should add
  metadata/composition around the host's canonical services rather than
  reimplementing them. In particular, commands must continue through the
  canonical commands service and submission/session safety must continue
  through Host-owned paths.
- **Public API changes require compatibility review.** Before changing any
  exported type, method, capability id, slot semantics, snapshot field, or
  lifecycle behavior under `@xmoon76/dsh-pi-tui/extensions`, determine
  whether the change is:
  1. backward-compatible additive;
  2. deprecation with a migration path; or
  3. breaking.
  Never silently change existing semantics.
- **Prefer additive evolution.** New optional behavior should normally be
  introduced through a new semantic field, action, slot, registry, or
  capability while preserving existing behavior. Do not repurpose an
  existing field or capability to mean something different.
- **Deprecate before removal.** Follow `docs/extension-api.md`: deprecated
  API remains functional for the current API version and carries a
  migration note. Removal requires the next breaking API version.
- **Keep capability detection truthful.** When adding or removing optional
  extension behavior, update the capability contract, public types,
  documentation and tests together. A capability must not be advertised
  before the corresponding behavior actually works.
- **First-party success is not sufficient.** Any change touching an
  extension point must include or update a third-party-style regression
  test using only public package exports. Do not rely solely on direct
  tests of internal registries/classes.
- **Test dynamic lifecycle, not only startup.** Relevant extension changes
  must cover, as applicable:
  register-before-surface, register-after-surface, owner unload/HMR,
  surface dispose/recreate while the owner survives, stale-handle safety,
  fallback restoration, and dynamic invalidation without unrelated user
  input.
- **Protect the packed SDK.** Changes to the extension surface must keep
  the packed declaration leak gate and external fixture tests green.
  Fixtures must consume the packed tarball through public exports only,
  never repository-relative source paths.
- **Keep the contract synchronized.** Changes affecting the extension SDK
  must update `docs/extension-api.md`, public types/capabilities, relevant
  fixtures/tests, and the changelog together. README updates follow the
  repository's bilingual-sync rule.

When unsure whether a Host change affects extensions, assume it does and
trace the corresponding public capability/slot/registry before editing.

## Development

```sh
pnpm install
pnpm build          # pi-tui tsdown (packages/pi-tui/dist/) + root tsdown (dist/, bundles pi-tui)
pnpm test           # pi-tui's own suite (node --test) + dsh-pi-tui headless tests
pnpm typecheck
node --import tsx/esm demo.ts   # standalone demo in a real TTY
```

### Installing into the local dsh profile (dev loop)

Two profiles exist. **Never touch `pi-tui`** — it is the real-use profile and
installs the published upstream package from the npm registry:

```sh
dsh plugin --profile pi-tui -- add "@xmoon76/dsh-pi-tui"   # registry install (0.1.x)
dsh --profile pi-tui [--session <id>]                      # real use
```

Development runs in the **`pi-tui-dev`** profile, whose `package.json`
declares a `link:` dependency to this repo (a live symlink, so a `pnpm build`
is picked up immediately — no re-install, no store copies):

```sh
# one-time setup (idempotent): create/repoint the dev profile at the repo
mkdir -p ~/.dsh/profiles/pi-tui-dev
cat > ~/.dsh/profiles/pi-tui-dev/package.json <<'EOF'
{
  "name": "dsh-profile-pi-tui-dev",
  "private": true,
  "dependencies": { "@xmoon76/dsh-pi-tui": "link:/home/xmoon/project/me/dsh-pi-tui" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@xmoon76/dsh-pi-tui"] } }
}
EOF
cd ~/.dsh/profiles/pi-tui-dev && pnpm install
# dev loop: rebuild the bundle, then run the dev profile
pnpm build
dsh --profile pi-tui-dev [--session <id>]
```

Restoring a messed-up `pi-tui` profile: reinstall the registry package from
the lockfile (`cd ~/.dsh/profiles/pi-tui && pnpm install --frozen-lockfile`).
The profile's `pnpm-workspace.yaml` excludes `@xmoon76/dsh-pi-tui@0.1.x` from
the minimum-release-age policy. Note: `minimumReleaseAgeExclude` only affects
pnpm's RESOLUTION path — the frozen-lockfile verification path ignores it, so
if the supply-chain check still rejects the version pass
`--config.minimum-release-age=0` (or cleanly remove + `dsh plugin` re-add)
instead of debugging the exclude list.

Headless UI tests drive `@xterm/headless` through `test/virtual-terminal.ts`
(copied from the fork's `test/virtual-terminal.ts`, import path changed) — rendering
and input routing are verified without a TTY or a model connection.

### Releasing (npm publish runs on GitHub CI)

A release is: bump `version` in the root `package.json`, move the
accumulated `[Unreleased]` entries into a dated `[X.Y.Z]` section in BOTH
changelogs (bilingual sync), commit `chore: release vX.Y.Z`, tag `vX.Y.Z`,
and push. **npm publishing is done by GitHub CI from the pushed tag**
(`.github/workflows/ci.yml`, npm Trusted Publishing with `id-token: write`)
— never run `npm publish` from a dev machine; the local npm token is not
the publishing credential. On a changelog/version-only range the push runs
`verify:prepush:nofork`; a range touching `packages/pi-tui/` runs the full
`verify:prepush`.

### Pre-push verification gate (husky)

`git push` runs a local gate (husky, `.husky/pre-push`; installed by the
`prepare` script on `pnpm install`; runtime shims in `.husky/_` are
gitignored):

- **`main` and `v*` release tags** → `pnpm run verify:prepush`, the
  CI-equivalent full chain: fork typecheck + fork tests + docs tests +
  naming gate + `pnpm audit --prod --audit-level high` + `pnpm pack:release`
  (prepack build/typecheck/tests + every postpack smoke, including the
  declaration-leak gate). Measured ≈2 min. Some failures are ONLY visible
  in the packed artifact (the settleCompactionSurface declaration leak was
  exactly this class) — do not skip this for a CI round-trip. When the
  pushed range does NOT touch `packages/pi-tui/`, the fork's own
  typecheck/tests are skipped (`verify:prepush:nofork`, ≈1:45; the fork
  suite only guards fork changes and CI runs it regardless).
- **any other branch** → `pnpm typecheck` only (≈15 s), so WIP pushes stay
  cheap; fork untouched → `pnpm typecheck:bundle` (≈10 s).
- Output never goes silent: every stage prints a timestamped progress
  line (`start` / `ok` + elapsed / `FAIL` + elapsed) as it runs, so a long
  push always shows WHICH stage is live (the ≈2 min full chain, the
  ≈1:45 nofork chain, or the ≈10–15 s typecheck). The stage list is NOT
  hard-coded: the hook derives it from the selected package.json script
  via `scripts/pre-push-stages.mjs` (top-level `&&` split, quote- and
  escape-aware; rejects unterminated quotes and dangling `&&`), so
  `verify:prepush` / `verify:prepush:nofork` remain the single source of
  truth — adding, removing or reordering a stage in those scripts is
  picked up automatically. Stages run via `sh -c` so their own quoting
  survives; the fork-change check aggregates across ALL pushed refs (any
  ref touching `packages/pi-tui/` or with an unknown base forces the full
  chain — a later clean ref never downgrades it, and a fully clean push
  still selects the fast chain). `PUSH_GATE_QUIET=1` restores a single
  summary line for scripted pushes. Success prints one summary line with
  the elapsed time (logs discarded); failure prints the failed stage,
  the last 60 log lines and retains the full log path.
  `PUSH_GATE_STAGES` (test/dry-run only) is ignored unless
  `PUSH_GATE_TEST_MODE=1` is set — and a whitespace-only override is
  refused — so a stray env var can never shrink a real push's gate.
  The derivation and hook behavior are guarded by
  `test/pre-push-stages.test.mjs` and `test/pre-push-hook.test.mjs`.
  Run `pnpm run verify:prepush` manually for the unabridged reference
  run.
- Escape hatch: `git push --no-verify` (then rely on CI).

## Reusable flow (worth repeating for the next capability)

1. **Read both sides before designing**: the dsh bundle shape (`packages/bundle/web-app`: startup.ts commander row + index.ts glue + `cordis.patch.yml` with `dsh.bundle.patch`), and the library's real API (check `src/index.ts` exports, not the README).
2. **Vendor**: `rsync -a --exclude native --exclude CHANGELOG.md --exclude node_modules` from the fork; rescope the package name; keep LICENSE + the fork's AGENTS.md; record the upstream commit in `repository.note` (the single source of truth — do not copy the version/commit into root docs); run the fork's own test suite unchanged as the sync gate.
3. **Bundle skeleton**: package with `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`; patch inserts a `*-startup` row (commander via `@deepseek-ai/dsh-cmdline`'s `parseCmdline`, provides a service) and a runner row injecting that service; exports `./startup` and `./cordis.patch.yml`.
4. **Testable core**: inject the terminal (`Terminal` interface) so tests drive a `VirtualTerminal`; keep the process entry (`ProcessTerminal`) as a thin wrapper.
5. **Verification matrix** (all passed in the P0 spike): fork's own tests; headless render/input/exit; the full import chain under the tsx ESM hook (dsh source-launch contract, incl. `@deepseek-ai/dsh-cmdline` + commander); non-TTY stdin guard (`setRawMode` existence check); native graceful fallback.
6. **Install path**: `dsh plugin --profile pi-tui -- add <package>` — `dsh plugin` reconciles `dsh.profile.bundles` from installed state, so any dependency declaring `dsh.bundle` joins the layer stack automatically; no dsh installation edits needed.

## Traps hit (do not reintroduce)

- **`TUI` is not constructible** — use `TuiMainScreen` (see decisions).
- **`constructor(private readonly x: T)` parameter properties** fail Node's strip-only mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) — write them as explicit fields.
- **Returning a mutable counter by value** in test helpers: `return { exits }` copies the number; closures update the local, assertions read the stale copy. Expose a getter or an object.
- **`TuiInputListener` must return `TuiInputListenerResult`** (or `undefined`) — a bare `void` arrow fails typecheck; return `{ consume: true }` for handled keys like Ctrl+C.
- **Editor needs a theme** (`EditorTheme`) — pi-tui ships no default; `src/theme.ts` is the palette.
- **`imports` `#/*` alias** in the fork's package.json: fine for its internal `src` imports under tsx/Node 24+, but any future `dist` build must bundle (tsdown) rather than tsc-emit, or the alias must go.
- **tmux `send-keys` looks like a paste to the editor**: `send-keys 'text' Enter` delivers the whole batch in a few ms; the editor's `PasteBurst` heuristic (≥8 plain chars within 8ms, Enter suppressed for 120ms) then turns Enter into a newline, so submissions silently "don't work". This is upstream design (protects against non-bracketed-paste terminals), NOT a regression — real keyboards type slower than 8ms/char. When driving the TUI from tmux, type with a pause: `send-keys 'text'`, sleep ≥0.3s, then `send-keys Enter` (full recipe: `docs/tmux-testing.md`).
- **`setFullscreen` must refocus the editor**: a fresh `TuiAltScreen` starts with no focused component — after Ctrl+F the app-level listener still handles shortcuts but text and Enter are dropped, making the transcript look frozen. `TuiApp.setFullscreen` sets focus on the alt screen when entering and restores it on the way back; keep that when touching fullscreen (guarded by the "editor input routes to the alt screen" headless test).
- **Cordis service access: property read without `inject` throws.** In a Cordis context, `ctx.tools` property access throws `cannot get property "tools" without inject` at runtime when the service is not in the component's `inject` list. For services that are optional or not injected, read them with `ctx.get('name')` (e.g. `ctx.get('tools')`, `ctx.get('agentPresets')`), never bare property access.
- **dsh services are scoped by the live agent OBJECT, not `ctx`.** The tool registry and the skill catalog are keyed by the agent object: `ctx.get('tools')?.get(name, liveAgent)` and `skills.list({ cwd, scope: liveAgent })`. Passing `ctx` as scope (or omitting scope and passing only `cwd`) silently returns `undefined`/empty — the `/skill` list and edit-diff cards both broke exactly this way once.
- **pi-tui render quirks to respect from the consumer side**: (1) an emptied pane does NOT clear its previously painted rows — `setQueueItems([])`/`setText('')` leaves old content on screen, so rebuild or hide the component instead of just repainting text; (2) the fork schedules its immediate render via `process.nextTick`, which runs BEFORE promise microtasks, so an asynchronously-resolved list paints one frame late.
- **Terminal queries (OSC 11 theme) must go through the ACTIVE screen**: in
  fullscreen, an OSC 11 background-color query written to the stopped main
  screen is swallowed by the alt screen and times out (800ms), so theme
  autodetect never lands. Same class as the routeInput fix: route queries
  through the active screen and keep the reply listener registered on both.
- **Esc after a submenu/panel return gets consumed**: entering a read-only
  viewer (e.g. a subagent transcript) from a SettingsList row and pressing
  Esc once can leave the viewer "sticky" — the panel's submenu machinery eats
  the first Esc before the app's `onSingleEscape` fires. Give read-only
  viewers a dedicated exit path and a headless test for the
  Esc-after-panel sequence; do not rely on the app-level single-Esc handler.
- **Fullscreen toggling can leave a stale dialog frame**: after Ctrl+F (or
  a settings toggle) exits fullscreen, the main viewport may keep showing a
  dialog frame even though the overlay stack is empty — toggling fullscreen
  must stop the alt screen and re-start the main TUI (clean repaint), not
  just migrate overlay handles.
- **Headless test timing: never assert on a fixed `setTimeout`.** In
  async/race tests, flush the microtask/event queue with an explicit
  `settle()`/deferred helper instead of
  `await new Promise(r => setTimeout(r, 30))` — the fixed delay makes the
  test timing-sensitive and flakes across runs.
- **Validate serializers against the real consumer's layout rules, not a self round-trip.** A `compressLog` test that asserted "round-trips as one frame" passed while every real dsh reader rejected the output. The round-trip only proves self-consistency; the layout gate is the consumer's own checks.
- **Never type a public entry export with an internal class (`TuiApp`, registries, …).** The compaction-settle seam was exported as `settleCompactionSurface(app: TuiApp, …)`, and tsdown then inlined the ENTIRE `TuiApp` declaration — plus every module its signature touches (renderer/editor registries, present/transcript/task-panel internals, image modules, and the vendored fork's `Terminal`/`Component`/`Text`/… types) — into the public `dist/index.d.mts` and its shared chunks, tripping the tarball declaration-leak gate (bare `TuiApp` identifiers, non-allowlisted `src/…` regions, `packages/pi-tui` regions). The fix types such seams with a minimal STRUCTURAL interface (three setters) so the declaration bundle stays limited to the public runner surface; the leak gate in `scripts/tarball-smoke.mjs` is the enforcement.
- **Never flatten a message's Markdown/Text into a static `Text` at build time.** The 5a76526 bullet-alignment change rendered assistant/user messages once at the then-current width and froze the result — a terminal resize then only re-wrapped the frozen lines: markdown tables could never reflow (border lines wrapped as plain text on narrow windows). Keep the child LIVE through a width-aware wrapper that applies the bullet/indent at `render()` time and returns a REFERENCE-STABLE array (same child instance + same width → same prefixed array), so a steady-state frame produces identical rendered strings (the differential renderer then paints nothing — the fork has no per-frame line cache to "hit"). `BulletedComponent` in tui-app.ts is the pattern.
- **The busy-Enter opposite chord is Ctrl+Enter, and it needs a terminal that reports modifiers.** Plain Enter + Ctrl+Enter are the same `\r` on legacy terminals; only Kitty CSI u (`\x1b[13;5u`) or xterm modifyOtherKeys distinguishes them. The chord is a convenience (queue mode while busyEnter=steer) — the chord silently falling through to the editor as a plain Enter (i.e. it steers) on legacy terminals is accepted: queue delivery stays one `/settings` flip away (`busyEnter: queue`), documented in /help.
- **Never compare raw key sequences in dsh-pi-tui components — always `matchesKey`.** `ProcessTerminal` answers the Kitty keyboard-protocol query (`\x1b[>7u\x1b[?u\x1b[c`), and zellij/WezTerm/Windows Terminal/kitty then report arrows, Esc and Tab as CSI-u (`\x1b[1;1B`, `\x1b[27;1u`, `\x1b[9;1u`) instead of legacy (`\x1b[B`, `\x1b`, `\t`). Components that hard-compared raw sequences (`data === '\x1b[A'`) silently dropped every such key: the question card and the task browser both froze for arrows/Esc/Tab while letters and Enter kept working (letters stay raw bytes via the StdinBuffer printable-dedup; Enter matched only the legacy `\r`). `matchesKey(data, 'up'|'down'|'left'|'right'|'escape'|'tab'|'enter'|'pageUp'|'pageDown')` covers legacy + CSI-u + modifyOtherKeys — including modifier bit 128 (super) that zellij reports (`\x1b[1;129B`). The fork's `SelectList`/`SettingsList`/`Editor` all use `kb.matches`/`matchesKey`; QuestionFlow and TaskBrowserPanel were the two raw-compare stragglers (fixed; guarded by the CSI-u tests in `question-flow.test.ts` and `task-panel.test.ts`).
- **An app-CONSUMED key that mutates UI must request its own frame.** When `handleInput` returns `{ consume: true }`, the fork's `handleTerminalInput` returns early — the focused component never dispatches, so `requestImmediateRender` never fires. The pi-parity Ctrl+C first-press clear called `setText('')` without any render: the draft emptied in memory but the old text stayed on screen until the next keypress (memory empty, screen lying — in tmux the "clear" looked dead, and a hasty second Ctrl+C then exited via the clear-then-exit chord). Every app-consumed key that mutates the editor must end with `this.requestRender()` — the pattern `setDraft`/`submitDraft` already used. Guarded by "Ctrl+C clearing the editor REPAINTS the frame" in `test/cancel.test.ts`; the Ctrl+S and Ctrl+Enter draft clears got the same explicit repaint.
- **After editing deeply nested call/arrow blocks, verify BRACKET BALANCE over the WHOLE function — never line-by-line.** A single misplaced close (e.g. `}), {` where `}, {` was meant — the extra `)` closes the `runOwned(...)` call early) derails the parser and cascades into a dozen confusing errors at LATER lines; the FIRST reported error is the root, but line-by-line reading of the tail shows only the wreckage. When tsc reports cascading syntax errors after a multi-line edit: read the ENTIRE function/block in one `read` (a few hundred lines is fine), then walk the nesting by indentation and count `( { [ ` vs `) } ]` per line; a stray `)` next to a `{` on the same line is the classic culprit. Also verify release paths (try/finally, catch) are syntactically inside the block they belong to. Proven when the nested `runOwned('image submit', ...)` fallback edit produced 8 cascading errors from one extra `)`; the whole-paragraph read exposed it in one pass.
- **Startup-eager callbacks captured by `startProcessTui` must only read runner slots declared BEFORE the call.** `onTerminalResize` fires on the FIRST surface-geometry sync (`lastCommandWidth` starts at 0), and a first render is reachable during startup — a keybinding rebuild's invalidate → requestRender lands there — so a callback referencing a runner-scope `let` declared later (the footer slots were ~940 lines down at the footer settings block) reads the temporal dead zone. The `ReferenceError` then escapes through whatever fail-soft catch wraps the triggering path: the keybinding apply's catch misreported it as a keybinding configuration failure while the new keymap was already effective (rebuild is keymap-first, invalidate-last — the "keeping the last-known-good configuration" claim in that diagnostic was wrong for post-rebuild failures and has been removed). Input-time callbacks (onSubmit, onDequeue, onClipboardPaste, …) legitimately capture later-declared bindings (draftImages, openTasksBrowser, …) — lazy capture is fine; only the startup-eager set and eagerly-evaluated option values are audited. Guarded by the startup-eager-callback audit in `test/rules.test.ts` (next to the cleanup TDZ guard; add a property to its `STARTUP_EAGER` set only with the same proof — TuiApp can fire it before the runner body finished).

## Correctness contracts (full detail in docs/)

The rules below must never be broken; the full contracts live in `docs/`.

- **One surface per session.** dsh has no cross-process session coordination: two processes (TUI + web, or two TUIs) holding one session can mint the same `seq` and corrupt the log. The TUI refuses to OPEN a session already held by another live dsh process (`src/session-lock.ts` + `src/session-lock-proc.ts`: an `owner.lock` next to the log, pid + `/proc` starttime probe, stale locks from crashes are taken over, `wx`-exclusive create — never a plain `w` overwrite); it also detects the external writer at write time (`src/guard.ts`) and blocks the send; the identical operation again forces through with a ONE-TIME token (session + observed revision + action + draft fingerprint). Full contract: `docs/concurrency.md`.
- **Never a bare `void somePromise()`.** Fire-and-forget work goes through `src/detached.ts` (`runDetached` / `runOwned`, task factory invoked synchronously); the TASK / result-consumer / terminal-handler phases classify failures differently, and error observation is sync-total. The only bare-`void` exceptions are the sinks inside detached.ts (exempt by filename) and the two lifecycle roots, which carry an `allowlist` comment; `test/rules.test.ts` enforces the common forms. Full contract: `docs/failure-model.md`.
- **Never repair a log as one whole zstd frame** — dsh readers reject it (`corrupt Zstandard session log: first frame is not exactly one header line`). `scripts/repair-session.mjs` (`--scan` read-only; `--yes` applies with backup + verify) preserves the frame layout, refuses ambiguous duplicate-`seq` references, and writes 0600. Full contract: `docs/repair-session.md`.
- **Zero-event catalog probes — REMOVED, do not reintroduce.** Composition probes were deleted along with their tests: `session/created` observers in this deployment write durable knob events, so any probe both fails a zero-event gate and materializes an artifact. Cold catalog discovery goes through the standing scope only (`standingKeyFor` + `snapshot`); never call `agents.create()` for a catalog. Full contract: `docs/surface-catalog.md`.

## Docs

- README.md — 简体中文 install and run instructions for humans (the npm
  landing page), with README.en.md kept in sync (see Working rules).
- CHANGELOG.md — 简体中文 release history (Keep a Changelog 1.1.0; see
  Working rules), with CHANGELOG.en.md kept in sync.
- docs/README.md — index of the docs and how they evolve.
- docs/client-server-migration.md — the server/client migration source of truth (phase status, backend default, rollback state).
- docs/client-server-coupling.md — the migration coupling allowlist (baseline + no-new-debt).
- packages/pi-tui/AGENTS.md — the fork's divergence ledger (guarding tests per fix).
- When you change behavior, record the decision or trap in its owning doc at the same time — a fix without a recorded reason is a trap waiting to be re-introduced.
