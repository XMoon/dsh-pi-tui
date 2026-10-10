# PR4-0 evidence — panel / keybinding / interaction surface ledger

Part of the [PR4-0 capability audit](./pr4-0.md). Records which application
surfaces exist, **who actually consumes them**, and what a TSP user can reach.
The command-side ledger is [pr4-0-command-matrix.md](./pr4-0-command-matrix.md);
SDK event facts are [pr4-0-sdk-events.md](./pr4-0-sdk-events.md).

Source references are `path:line` against the baseline in
[pr4-0.md § Baseline](./pr4-0.md#baseline--qualification-topology).

## 1. The renderer seam and its capability flags

One renderer is selected at startup (`DSH_PI_TUI_RENDERER=tsp`,
`src/app/bootstrap/renderer-selection.ts:20-22`); `connect() === null` mounts
PiTui unchanged, a throw is a startup failure (never a fake fallback).

| Flag | PiTui | TSP | Deciding source |
|---|---|---|---|
| `supportsTaskCenter` | `true` | `false` | `display-seam-pitui.ts:86` / `tsp/session.ts:603` |
| `supportsViewer` | `true` | `false` | `display-seam-pitui.ts:87` / `tsp/session.ts:604` |
| `supportsModals` | `true` | `get supportsModals() { return boundHandlers !== undefined }` | `display-seam-pitui.ts:88` / `tsp/session.ts:609` |
| `supportsTuiBuiltinUi` | `!tspRendererActive` | `false` | `bootstrap.ts:2184` |
| `supportsLocalShellCards` | `!tspRendererActive` | `false` | `bootstrap.ts:2180` |
| `retainsStaleDraftRestore` | `true` | `false` | `tsp/session.ts:552-557` |
| `bindPluginKeybinds()` | called | **skipped** | `bootstrap.ts:2663` (inside the `!tspRenderer` block) |
| `attachSurfaceSeams(...)` | called | **skipped** | `bootstrap.ts:2664` |

Ordering fact that makes B3 modals real: `surface.bindRendererInput()` runs at
`bootstrap.ts:3193` **before** `surface.attachInteraction(...)` at `3199`, and
the TSP `supportsModals` getter flips only once `bindInput` committed the
application handlers (`tsp/session.ts:788-804`). A reordering would silently
re-arm the PR3-A fail-closed answerers (`interaction-runtime.ts:351`).

## 2. Surface-runtime coupling — who needs `TuiApp`

Only these modules name `TuiApp`/`mounted()` directly; everything else consumes
a neutral seam. This is the PR4B seam question, answered from real call sites.

| Module | Owns | Coupling | Source |
|---|---|---|---|
| `app/surface/runtime.ts` | the aggregate; per-owner wiring + teardown | `TuiApp` **and** a neutral `SurfaceRendererMount` for TSP | `runtime.ts:437`, `794`; mount at `1841-1873` |
| `app/surface/application-events.ts` | submit/steer/dequeue/cancel, rewind, search, focus, task browser | `TuiApp` | `application-events.ts:99` |
| `app/surface/task-runtime.ts` | Task Center + Job viewer | `TuiApp`; gated by `supportsTaskCenter` | `task-runtime.ts:175`, `521`, `535` |
| `app/surface/viewer-runtime.ts` | subagent child-transcript lifetime | transitive `SurfaceRuntime`; declines on `supportsViewer=false` | `viewer-runtime.ts:409` |
| `app/surface/settings-runtime.ts` | footer/display settings, user keybindings, boot display+theme | `TuiApp` | `settings-runtime.ts:65` |
| `app/surface/plugin-manager-runtime.ts` | Plugin Manager controller + `/plugins` + `/settings→Plugins` | `TuiApp` | `plugin-manager-runtime.ts:64` |
| `app/surface/extension-runtime.ts` | extension host + surface seams + plugin keybindings | `TuiApp` | `extension-runtime.ts:94` |
| `app/surface/display-seam-pitui.ts` | PiTui display adapter | `TuiApp` (adapter by design) | `display-seam-pitui.ts:23` |
| `app/surface/interaction-presenter.ts` | presenter contract + PiTui adapter | `TuiApp` (adapter) | `interaction-presenter.ts:113-129` |
| `app/surface/interaction-runtime.ts` | approval/Question attachment + attention | **neutral**; fail-closed on `supportsModals===false` | `interaction-runtime.ts:351` |
| `app/surface/question-controller.ts` | the ONE `QuestionSurfaceController` | **neutral** port bundle | `question-controller.ts:175`, `216` |
| `app/surface/session-presentation.ts` | live-session presentation + cold hydration | transitive `SurfaceRuntime` | `session-presentation.ts:113-114` |
| `app/surface/event-routing.ts` | presentation event routing | **neutral** `SurfaceDisplaySeam` | `event-routing.ts:220` |
| `app/surface/status-runtime.ts` | status derivation | **neutral** | `status-runtime.ts:46` |
| `app/surface/notification-runtime.ts`, `input-history.ts`, `client-actions.ts` | notifications, recall/persistence, clipboard/editor policy | **neutral / none** | `notification-runtime.ts:45-69`; `input-history.ts:35`; `client-actions.ts:69` |

The TSP renderer imports **none** of these classes: it consumes
`SurfaceDisplaySeam`, `SubmissionComposerPort`, `SurfaceInteractionPresenter`,
the pending-input DTOs and `TspInputHandlers`
(`src/tui/tsp/session.ts:49-62`, `92-137`). It owns only renderer-local state.

## 3. Panel / surface reachability

| ID | Surface | Application owner (source) | TSP entry | TSP status | reachability_class | Gap |
|---|---|---|---|---|---|---|
| PANEL-001 | Settings panel | `settings-runtime.ts:65` | none (`/settings` refused) | `NOT_REACHABLE` | `SURFACE_REACHABLE` (command refused) | 4A |
| PANEL-002 | Footer/statusline configurator | `settings-runtime.ts` | none | `NOT_REACHABLE` | — | 4A |
| PANEL-003 | Display preset (full/focus/compact/status) | display policy | dock status line only | `PROJECTION_ONLY` | `PROJECTION_ONLY` | 4A/PR5C |
| PANEL-004 | Focus display toggle | Focus policy | none | `NOT_REACHABLE` | — | 4A/PR5C |
| PANEL-005 | Session browser (`/sessions`,`/resume`,`/search`) | `session-presentation.ts:312` | none | `NOT_REACHABLE` | — | 4B |
| PANEL-006 | Task Center (`/tasks`,`/subagents`) | `task-runtime.ts:360` | none; `supportsTaskCenter=false` | `NOT_REACHABLE` | — | 4B |
| PANEL-007 | Job viewer | `task-runtime.ts` (same owner) | none | `NOT_REACHABLE` | — | 4B |
| PANEL-008 | Subagent Viewer (continuable/one-shot) | `viewer-runtime.ts:258` | none; `supportsViewer=false` | `NOT_REACHABLE` | — | 4B |
| PANEL-009 | Plugin Manager (`/plugins`, `/settings→Plugins`) | `plugin-manager-runtime.ts:80` | none | `NOT_REACHABLE` | — | 4B |
| PANEL-010 | History / Rewind picker | `rewind-presentation.ts`, `input-history.ts` | none | `NOT_REACHABLE` | — | 4B |
| PANEL-011 | Model picker | `tui/commands/models.ts` + settings/Agent owner | none | `NOT_REACHABLE` | — | 4A |
| PANEL-012 | Preset picker | preset registry | none | `NOT_REACHABLE` | — | 4A |
| PANEL-013 | Transcript search overlay | `search-overlay.ts` | none | `NOT_REACHABLE` | — | PR5B |
| PANEL-014 | Question/Approval modal | `question-controller.ts:175` via `interaction-runtime.ts` | **ONE TSP layer seat** | `SUPPORTED` (keyboard) | `FORBIDDEN_CONCURRENT_STATE` for anything else | 4B (parked entry) |
| PANEL-015 | Continued-question inspection list (`Alt+Q`) | same controller | `Alt+Q` seat list | `SUPPORTED` (keyboard) | `SURFACE_REACHABLE` | — |
| PANEL-016 | Live transcript (native nodes) | `transcript-view.ts` | always rendered | `RENDERED_READ_ONLY` | `SURFACE_REACHABLE` | PR5 |
| PANEL-017 | Dock: status line, notices, queue/pending projection | `pending-presentation.ts`, `status-runtime.ts` | rendered | `PROJECTION_ONLY` | `PROJECTION_ONLY` | — |
| PANEL-018 | Composer (controlled `ui.editor`) | `tui/tsp/editor.ts` | always rendered + focused | `SUPPORTED` (keyboard) | `SURFACE_REACHABLE` | — |

No TSP panel row is `SUPPORTED` merely because a semantic port or registry
exists: every `NOT_REACHABLE` row has a real owner and **no** TSP entry.

## 4. Keybinding ledger

PiTui's keymap is `APP_KEYBINDINGS` (`src/tui/keybindings/definitions.ts:26`),
resolved by `HostKeybindingManager` and dispatched by `AppActionDispatcher`
(`action-dispatcher.ts:70-172`) through the `InputRouter` ladder
(`src/tui/interaction/input-router.ts:178-263`). The TSP renderer has **none** of
that: it has a fixed key contract in `dispatchKey`
(`src/tui/tsp/session.ts:640-691`).

| Keys | Action | Owner | TSP |
|---|---|---|---|
| `enter` | `app.input.submit` | dispatcher (`action-dispatcher.ts:83`) | `SUPPORTED` — composer reducer → `handlers.submit` (`session.ts:675-687`) |
| `ctrl+enter` | `app.input.submitAccelerated` | `:85` | `SUPPORTED` (accelerated gesture) |
| `ctrl+s` | `app.input.steer` | `:91` | `NOT_REACHABLE` — the TSP reducer has no Ctrl+S |
| `alt+up` | `app.input.dequeue` | `:93` | `NOT_REACHABLE` |
| `escape` | `app.agent.interrupt` | `:95` | `SUPPORTED` — `handlers.cancel()` (`session.ts:669-672`) |
| `ctrl+c` | `app.exit.request` | `:97` | **deliberate difference**: cancel/interrupt, never exit (`session.ts:665-668`) |
| `ctrl+d` | `app.exit.request` | `:97` | `SUPPORTED` — empty-draft exit (`session.ts:689`) |
| `ctrl+f` / `ctrl+shift+f` | `app.transcript.search` | `:102` | `NOT_REACHABLE` |
| `ctrl+end` | `app.transcript.jumpLatest` | `:104` | `NOT_REACHABLE` |
| `ctrl+o` | `app.transcript.toggleExpand` | `:112` | `NOT_REACHABLE` |
| `alt+t` | `app.transcript.toggleThinking` | `:114` | `NOT_REACHABLE` |
| `ctrl+g` | `app.editor.external` | `:181-188` | `NOT_REACHABLE` |
| `ctrl+v` | `app.clipboard.pasteMedia` | `:189-196` | `NOT_REACHABLE` (bracketed paste is text only) |
| `shift+tab` | `app.permission.cycle` | `:199` | `NOT_REACHABLE` |
| `ctrl+t` | `app.todo.toggle` | `:207` | `NOT_REACHABLE` |
| `ctrl+r` | `app.history.search` | `:226` | `NOT_REACHABLE` |
| `alt+k` | `app.shell.dismissSettled` | `:234` | `NOT_REACHABLE` |
| `alt+q` | (TSP contract, not in `APP_KEYBINDINGS`) | TSP seat | `SUPPORTED` — continued-question list (`session.ts:656-660`) |
| printable / bracketed paste | editor | TSP composer reducer | `SUPPORTED` (`editor.ts:195-205`) |
| Question/approval form keys | focused-component keymap | `tui/question.ts` | `SUPPORTED` in TSP via the seat (`tsp/interaction.ts:890-1020`) |
| mouse / wheel | per-panel hit maps | `tui-app.ts:4701-4704`, panels | `NOT_REACHABLE` — `routeInput` has no mouse route (see §7) |

`Ctrl+A`/`Ctrl+V`/undo/selection are editor-native chords that the TSP
controlled composer deliberately ignores (`docs/tern-tsp.md` key-contract table).

## 5. Session / Task / Viewer — currentness and locality

| Concern | Authority | TSP |
|---|---|---|
| Session switch/fork/resume/new | `app/session/**`, session transition gate, exact generation/binding | no entry; presentation only |
| Cold hydration → Loading fence | `session-presentation.ts`; TSP `setTranscript` drops a retired-source frame and lifts the fence only when a **new source identity** commits (`tsp/session.ts:458-476`) | implemented, read-only |
| Presentation key scope | TSP epoch prefix `s<n>-…` per source identity (`tsp/session.ts:468-476`) | prevents cross-subject SDK node-id reuse |
| Subagent viewer (continuable child) | `viewer-runtime.ts`, viewer tokens/policy (`viewer-policy.ts`) | `supportsViewer=false` → refused at the real admission (`viewer-runtime.ts:409`) |
| Task/Jobs | `task-runtime.ts` + Job observation registry | `supportsTaskCenter=false` gates reads (`task-runtime.ts:521,535`); no fabricated status |
| Client/Host locality | Client-local UI state vs Host session; Remote semantics are PR7 | unchanged |

`PROJECTION_ONLY` ≠ navigable Session state. The TSP dock shows a session title
and status facts (`statusFacts`, `tsp/session.ts:486-500`) — that is a
projection, **not** `/title` or `/status` support; both commands remain
`EXPLICIT_UNAVAILABLE`.

### 5.1 A→B stale-subject decision chain

A switch commits a new projection source → `scopeEpoch += 1`, fresh
`TranscriptNodeKeys`, `hydrating` clears only on the new-source commit
(`tsp/session.ts:468-476`); a late frame from the **retired** source returns
early (`458-462`). Submission-side, the switch-dropping contract
(`retainsStaleDraftRestore=false`, `tsp/session.ts:552-557`) means a late stale
restore is suppressed rather than reseeding B's composer. Evidence:
`test/tern-tsp-controller-stale.test.ts:216` (replaced owner never reseeds),
`229` (same-owner invalidation still restores), and
`test/tern-tsp-submission.test.ts:340` (a real switch clears A's draft).

## 6. Editor / media / clipboard

| ID | Capability | Client/Host owner | TSP status | Evidence |
|---|---|---|---|---|
| EDIT-001 | Controlled UTF-16/grapheme editor, caret, CJK/emoji | TSP composer + `client/media` grapheme policy | `SUPPORTED` (keyboard) | B4 C1/C2; `test/tern-tsp-editor-input.test.ts` |
| EDIT-002 | Atomic bracketed paste (newlines/`/name` stay content) | TSP composer reducer (`editor.ts:195-205`) | `SUPPORTED` (scripted); physical paste `GUI_BLOCKED` | B4; SDK events doc §6 |
| EDIT-003 | Native editor chords (undo/selection/`Ctrl+A`/`Ctrl+V`) | none (deliberately off) | `EXPLICIT_UNAVAILABLE` (ignored, not faked) | `docs/tern-tsp.md` key table |
| EDIT-004 | Native `edit`/`undo`/`send` TSP events | SDK feature gate | `GUI_BLOCKED` (not observed headless) | sdk-events doc §6 |
| EDIT-005 | Input history recall (Ctrl+R / `up`) | `input-history.ts` | `NOT_REACHABLE` | §4 |
| EDIT-006 | Slash completion / `@` mention | PiTui editor seat + file-completion domain | `NOT_REACHABLE` | §4 |
| MEDIA-001 | Clipboard text/image read | `client-actions.ts:69` + `client/clipboard/**` | `NOT_REACHABLE` (no TSP chord) | §4 |
| MEDIA-002 | `/attach` `/image` draft attachment | `client/media/draft-attachments.ts` + Host attachment admission | `EXPLICIT_UNAVAILABLE` (command refused) | command matrix CMD-018 |
| MEDIA-003 | OSC 52 copy | `client/clipboard/copy.ts` via `client-actions.ts` | `NOT_REACHABLE` (no `/copy` in TSP) | §4 |
| MEDIA-004 | External editor (`$EDITOR`) | `client-actions.ts` external-editor action | `NOT_REACHABLE` | §4 |

### 6.1 Attachment-laundering decision chain

There is no TSP path that turns an image into text today: `Ctrl+V` never reaches
`ApplicationEvents.onPasteMedia`, and `/attach` is refused before any draft
mutation. The **future** 4C risk is explicitly named in the frozen plan: an
attachment must travel `Client-local clipboard/media policy → draft image store →
submit attachment admission → original Host attachment`, never as a
`[image #]` string. The audit records this as a **4C prerequisite**, not as a
current defect: no laundering path exists because no path exists.

## 7. Non-key native events — the core UX gap

This is the decisive surface finding and it is anchored in the real-Tern probe
([pr4-0-sdk-events.md § 5-6](./pr4-0-sdk-events.md)).

Chain: real pane gesture → SDK yields `SessionInput{type:'event'}` (no node
handler exists to consume it) → `routeInput` event branch
(`tsp/session.ts:713-721`) → `seat.handleEvent`
(`tsp/interaction.ts:1264-1271`) → returns `false` unless a modal is open and
`ev ∈ {focus, edit, undo, send}` → `routeInput` returns `false`, **nothing
happens**.

- ID `SDK-EVT-NONMODAL`: `NOT_REACHABLE`, `reachability_class =
  SURFACE_REACHABLE` for the input, but no action sink. Positive:
  `REAL_TERN_HEADLESS` probe 2 yields `action`/`select`/`activate`/`change`/
  `focus`; scripted lock `test/tern-tsp-live-mount.test.ts` "PR4-0: non-key SDK
  events reach no business action…". Negative: zero submit/steer/cancel/exit.
- The renderer declares **no** `actions`/handler on any node
  (`grep -n 'collapsible\|actions\|onClick\|onToggle\|onChange\|onSelect\|onFocus'
  src/tui/tsp/*.ts` finds only the composer's local `onChanged` sink), so a
  pointer click is not even a hit target today. `RENDERED` ≠ `ACTIONABLE`.
- The one live modal seat IS protected: while a modal is up, `focus`/`edit`/
  `undo`/`send` are claimed and the composer focus is re-asserted
  (`tsp/session.ts:719`), and the real pane's `overlay{modal:true}` intercepts
  background **pointer** actions (probe 6) — but the SDK masks the picture, not
  the keyboard, so the app-side modal-first key route stays the authority.

## 8. Question / Approval

| ID | Capability | TSP status | Evidence |
|---|---|---|---|
| Q-001 | Approval modal (y/n/esc/Ctrl+C) | `SUPPORTED` (keyboard) | B4 C3/C7; `test/tern-tsp-interaction.test.ts` |
| Q-002 | Question form (options, free text, multi-select, review, paging) | `SUPPORTED` (keyboard) | B3/B4 C6 |
| Q-003 | Timed → continued → `Alt+Q` → late answer | `SUPPORTED` | B4 C6 chain; interaction tests |
| Q-004 | Fail-closed when no presenter wired | `SUPPORTED` | `interaction-runtime.ts:351`; `test/tern-tsp-live-mount.test.ts` A-08/A-08b |
| Q-005 | Physical IME/paste inside the masked question | `UNCLASSIFIED` (owner-deferred) | **DEFERRED_WITH_OWNER** → proposed 4C; must not be called done |
| Q-006 | Modal node click actions | `NOT_REACHABLE` (overlays are `ui.text` rows only; keyboard is the contract) | `tsp/interaction.ts:1028-1117` |

Q-005 is the PR3-B B4 masked-physical item: the owner deferred it to PR4 rather
than record an unproven pass (`docs/tern-tsp/evidence/pr3-b.md`, "Owner QA
confirmation"). It stays `DEFERRED_WITH_OWNER` here.

## 9. Extension surface

| ID | Capability | TSP status | Evidence |
|---|---|---|---|
| EXT-001 | Plugin registration / registry / Fiber lifetime | `SUPPORTED` (service-lifetime, renderer-independent) | `extension-runtime.ts`; service provided on both renderers |
| EXT-002 | Plugin UI chrome / overlay / input seams | `NOT_REACHABLE` | `bootstrap.ts:2663-2664` skips `bindPluginKeybinds`+`attachSurfaceSeams` on TSP |
| EXT-003 | Advanced editor/UI (`advanced.ui`) | `NOT_REACHABLE` | same |
| EXT-004 | Unstable raw input / raw-line mount | `EXPLICIT_UNAVAILABLE` by policy (not implemented, not faked) | frozen roadmap §5.4/6E3; not changed here |
| EXT-005 | `api().capabilities.has(...)` service-level advertisement | unchanged — still a **service** advertisement, not a renderer claim | `docs/tern-tsp.md`; PR6E0 owns the distinction |

The audit does **not** modify `api().capabilities` and does not implement PR6E0.
The gap (service-advertised vs renderer-attached) is recorded as PR6 input; the
renderer-capability distinction already exists in the display seam and is the
model PR6E0 should generalize.

## 10. Gaps → recommended PR

| Gap | PR |
|---|---|
| No non-key event → scoped intent admission (the common prerequisite) | 4A (see the 4A0 decision in [pr4-0.md](./pr4-0.md#4a0-decision)) |
| No TSP menu/picker/selection UI | 4A |
| No session/task/viewer/plugin panel entries | 4B |
| No clipboard/image/file/external-editor path | 4C |
| Physical masked-question qualification | 4C (owner-deferred) |
| Transcript Focus/Compact/search | PR5 |
| Renderer-aware plugin capability | PR6 |
