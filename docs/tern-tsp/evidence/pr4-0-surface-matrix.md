# PR4-0 evidence — panel / keybinding / interaction surface ledger

Part of the [PR4-0 capability audit](./pr4-0.md). Records which application
surfaces exist, **who actually consumes them**, and what a TSP user can reach.
The command-side ledger is [pr4-0-command-matrix.md](./pr4-0-command-matrix.md);
SDK event facts are [pr4-0-sdk-events.md](./pr4-0-sdk-events.md).

Source references are `path:line` against the baseline commit recorded in
[pr4-0.md § Baseline](./pr4-0.md#baseline--qualification-topology); the
load-bearing claims also carry an immutable permalink.

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

Measured by grepping `TuiApp` across `src/app/surface/**` and classifying every
hit; the claim is deliberately narrow:

| Bucket | Modules | Evidence |
|---|---|---|
| **Declares a `TuiApp`-typed dependency** (a field/prop typed `TuiApp` or `() => TuiApp`) | `application-events.ts:99`, `extension-runtime.ts:94`, `plugin-manager-runtime.ts:64`, `runtime.ts:437`, `settings-runtime.ts:65`, `task-runtime.ts:175` | 6 modules |
| **PiTui adapters by design** (structural narrowing of `TuiApp`) | `display-seam-pitui.ts:23`, `interaction-presenter.ts:113` | 2 modules |
| **Transitive via `SurfaceRuntime`** | `viewer-runtime.ts:170-171`, `session-presentation.ts:113-114` | 2 modules |
| **Comments/type-only mention, no `TuiApp` dependency** | `display-seam.ts`, `status-runtime.ts`, `input-history.ts`, `interaction-runtime.ts`, `client-actions.ts`, `compaction-presentation.ts` | comment/import only |
| **Renderer-neutral seams** | `event-routing.ts:220`, `notification-runtime.ts:45-69`, `question-controller.ts:175,216`, `pending-presentation.ts`, `task-presentation.ts`, `search-overlay.ts`, … | no `TuiApp` |

So the PR4B seam work is bounded by **6 modules with a real `TuiApp`
dependency** plus 2 PiTui adapters. Only the `runtime.ts` aggregate itself
already has a neutral path (`SurfaceRendererMount`, used by the TSP mount,
`runtime.ts:1841-1873`).

The TSP renderer imports **none** of these classes: it consumes
`SurfaceDisplaySeam`, `SubmissionComposerPort`, `SurfaceInteractionPresenter`,
the pending-input DTOs and `TspInputHandlers`
(`src/tui/tsp/session.ts:49-62`, `92-137`). It owns only renderer-local state.

Permalinks: [the TSP mount branch](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/app/surface/runtime.ts#L1841-L1873) ·
[the TSP capability flags](https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/tui/tsp/session.ts#L603-L609)

## 3. Panel / surface inventory

### 3.1 Table A — owner, entry seam, sink and locality

| ID | Surface | Producer / owner (source:line) | Application entry | Action / presenter seam | Observable sink | Locality |
|---|---|---|---|---|---|---|
| PANEL-001 | Settings panel | `settings-runtime.ts:133` | `/settings` handler (`settings.ts:243`) | `SettingsSurface.app: TuiApp` (`settings-runtime.ts:65`) | panel rows; writes through `runner.tuiSettings` | Client UI over Host settings |
| PANEL-002 | Footer/statusline configurator | `settings-runtime.ts` (footer part) | `/footer` (`settings.ts:1086`) | the same `TuiApp` surface | persisted footer layout + notify | Client UI |
| PANEL-003 | Display preset (full/focus/compact/status) | command adapter `settings.ts:175-183` (`displayPresetOf`/`applyDisplayPreset`) over the runner's display state; `settings-runtime.ts:133` boot display | `/display` (`settings.ts:1206`) | `applyDisplayPreset` + `app.notify` | the runner's display preset + the dock projection | Client UI |
| PANEL-004 | Focus display toggle | same adapter (`settings.ts:175-183`) | `/focus` (`settings.ts:1229`) | same | the runner's focus flag | Client UI |
| PANEL-005 | Session browser (`/sessions`,`/resume`,`/search`) | `session-presentation.ts:312` | `openSessionPicker` (`sessions.ts:778,889`) | the picker overlay owner | Host session list read + switch intent | Client UI over Host sessions |
| PANEL-006 | Task Center (`/tasks`,`/subagents`) | `task-runtime.ts:360` | `runner.openTasksBrowser()` (`tasks.ts:33`) | `mounted: () => TuiApp` (`task-runtime.ts:175`), gated by `supportsTaskCenter` (`:521,535`) | task rows from the Job/subagent registries | Client UI over Host registries |
| PANEL-007 | Job viewer | `task-runtime.ts` (same owner) | same browser | same | job detail rows | Client UI |
| PANEL-008 | Subagent Viewer (continuable/one-shot) | `viewer-runtime.ts:258` | viewer open from a task/agent row | declines on `supportsViewer=false` (`viewer-runtime.ts:409`) | child transcript projection | Client UI over Host child agent |
| PANEL-009 | Plugin Manager (`/plugins`, `/settings→Plugins`) | `plugin-manager-runtime.ts:80` | `runner.openPluginManager()` (`tasks.ts:53`) | `mounted: () => TuiApp` (`plugin-manager-runtime.ts:64`) | plugin list/install panel | Client UI over profile plugins |
| PANEL-010 | History / Rewind picker | `rewind-presentation.ts:24`, `input-history.ts:80` | `/rewind`, `Ctrl+R` | rewind picker owner | outline rows → fork intent | Client UI over Host session log |
| PANEL-011 | Model picker | `models.ts:169` + settings/Agent model owner | `/model` | picker overlay | the session model write + reread | Client UI over Host model |
| PANEL-012 | Preset picker | preset registry (`models.ts:448`) | `/preset` | picker/roster read | preset switch | Client UI over Host preset |
| PANEL-013 | Transcript search overlay | `search-overlay.ts:42,96` | `Ctrl+F` | TuiApp search overlay | reveal/hit navigation | Client UI |
| PANEL-014 | Question/Approval modal | `question-controller.ts:175,216` via `interaction-runtime.ts:140` | official `InteractionPort` → `presenter` | `SurfaceInteractionPresenter` (`interaction-presenter.ts:129`; TSP `tsp/interaction.ts:1250-1279`) | the official answer/settlement | Host-owned request, Client presentation |
| PANEL-015 | Continued-question list (`Alt+Q`) | same controller | `Alt+Q` in TSP (`tsp/session.ts:656-660`) | seat list callbacks | `reopen` through the original controller | Host authority, Client UI |
| PANEL-016 | Live transcript | `transcript-view.ts:23-266` | always rendered | display seam `setTranscript` | native nodes | Client presentation of a Host fold |
| PANEL-017 | Dock: status line, notices, queue/pending | `pending-presentation.ts:136`, `status-runtime.ts:302` | always rendered | `SurfaceDisplaySeam` | dock rows | Client UI |
| PANEL-018 | Composer (controlled `ui.editor`) | `tui/tsp/editor.ts:124` | always rendered + focused | `SubmissionComposerPort` | draft state → submit intent | Client-local |
| PANEL-019 | Extension UI chrome / overlay / Advanced editor | `extension-runtime.ts:118` | plugin registration | `attachSurfaceSeams` (`:249`), `bindPluginKeybinds` (`:112`) | plugin chrome | Client UI |

### 3.2 Table B — TSP reachability, status and evidence

| ID | TSP entry | TSP status | `evidence_state` | Positive | Negative | `reachability_class` | Tier | Gap → PR |
|---|---|---|---|---|---|---|---|---|
| PANEL-001…004 | none (`/settings`,`/footer`,`/display`,`/focus` are refused by the TUI-builtin gate) | `NOT_REACHABLE` | `VERIFIED` | the refusal path is proven (`test/tern-tsp-runner-interactive.test.ts:52`) | no session created; draft restored | n/a (no TSP entry) | `L6` | 4A |
| PANEL-005 | none (`/sessions`,`/resume`,`/search` refused) | `NOT_REACHABLE` | `VERIFIED` | same refusal lock | same | n/a | `L6` | 4B |
| PANEL-006,007 | none; `supportsTaskCenter=false` gates every read (`task-runtime.ts:521,535`) | `NOT_REACHABLE` | `VERIFIED` | `bootstrap` capability flag (`tsp/session.ts:603`) | a fabricated Task status is never produced | n/a | `TYPE_ONLY` + `L6` flag | 4B |
| PANEL-008 | none; `supportsViewer=false` declines at the real admission (`viewer-runtime.ts:409`) | `NOT_REACHABLE` | `VERIFIED` | the decline is the production path | no viewer state is invented | n/a | `L6` flag | 4B |
| PANEL-009 | none (`/plugins` refused) | `NOT_REACHABLE` | `VERIFIED` | refusal lock | — | n/a | `L6` | 4B |
| PANEL-010 | none (`/rewind` refused; `Ctrl+R` not in the TSP key contract) | `NOT_REACHABLE` | `VERIFIED` | refusal lock + TSP `dispatchKey` (`tsp/session.ts:640-691`) has no such chord | — | n/a | `L6` + `TYPE_ONLY` | 4B |
| PANEL-011,012 | none (`/model`,`/preset` refused) | `NOT_REACHABLE` | `VERIFIED` | refusal lock | — | n/a | `L6` | 4A |
| PANEL-013 | none | `NOT_REACHABLE` | `VERIFIED` | no TSP search entry exists | — | n/a | `TYPE_ONLY` | PR5B |
| PANEL-014 | the ONE TSP layer seat | `SUPPORTED` | `VERIFIED` (B3/B4; this audit did not re-obtain GUI) | B4 real-pane C3/C7 approval + C6 question chain; `test/tern-tsp-interaction.test.ts` | fail-closed when no presenter is wired (`interaction-runtime.ts:351`); no auto-approve; modal cancellation settles `cancelled` | `SURFACE_REACHABLE` | `REAL_TERN_GUI` (B4, owner-attested) + `SDK_SCRIPTED` | 4B (parked entry) |
| PANEL-015 | `Alt+Q` seat list | `SUPPORTED` | `VERIFIED` | B4 C6 chain; `test/tern-tsp-interaction.test.ts:559` | list closes on Esc; a stale id answers `false` | `SURFACE_REACHABLE` | `REAL_TERN_GUI` (B4) + `SDK_SCRIPTED` | — |
| PANEL-016 | always rendered | `RENDERED_READ_ONLY` | `VERIFIED` | PR1/PR2/PR3-A evidence; B4 real pane | no action node exists; `grep` finds no handler/`actions` in `src/tui/tsp/**` | `PROJECTION_ONLY` for actions, `SURFACE_REACHABLE` for display | `REAL_TERN_HEADLESS` + `REAL_TERN_GUI` (B4) | PR5 |
| PANEL-017 | always rendered | `PROJECTION_ONLY` | `VERIFIED` | PR3-B dock records | the queue/pending rows are a projection, not a queue control | `PROJECTION_ONLY` | `REAL_TERN_HEADLESS` | — |
| PANEL-018 | always rendered + focused | `SUPPORTED` (keyboard) | `VERIFIED` | B4 C1/C2 (typed + pasted prompt answered); `test/tern-tsp-editor-input.test.ts` | a refused command restores the draft; a hydration window accepts no key (`test/tern-tsp-submission.test.ts:221`) | `SURFACE_REACHABLE` | `REAL_TERN_GUI` (B4, owner-attested) + `L6` | 4C |
| PANEL-019 | seams skipped on TSP (`bootstrap.ts:2663-2664`) | `NOT_REACHABLE` | `VERIFIED` | the skip is in the production branch | a plugin's own UI is silently absent — recorded as the PR6E0 governance gap, **not** as an evidenced refusal | n/a | `TYPE_ONLY` | PR6 |

No TSP panel row is `SUPPORTED` merely because a semantic port or registry
exists: every `NOT_REACHABLE` row has a real owner and **no** TSP entry.

Note on tier honesty: PANEL-014/015/018 are `SUPPORTED` because the **B4
record** — a real-pane, owner-QA-confirmed qualification — is their evidence.
This audit re-obtained only `REAL_TERN_HEADLESS`; it does not re-certify the GUI
tier.

## 4. Keybinding ledger

PiTui's keymap is `APP_KEYBINDINGS` (`src/tui/keybindings/definitions.ts:26-520`),
resolved by `HostKeybindingManager` (`src/tui/keybindings/manager.ts`) and
dispatched by `AppActionDispatcher`
(`src/tui/keybindings/action-dispatcher.ts:70-172`) through the `InputRouter`
ladder (`src/tui/interaction/input-router.ts:178-263`). The TSP renderer has
**none** of that: it has a fixed key contract in `dispatchKey`
(`src/tui/tsp/session.ts:640-691`).

### 4.1 Global host actions

| Keys | Action | Dispatcher/handler (source:line) | TSP |
|---|---|---|---|
| `enter` | `app.input.submit` | `action-dispatcher.ts:83` | `SUPPORTED` — composer reducer → `handlers.submit` (`session.ts:675-687`) |
| `ctrl+enter` | `app.input.submitAccelerated` | `:85` | `SUPPORTED` (accelerated gesture) |
| `ctrl+s` | `app.input.steer` | `:91` | `NOT_REACHABLE` — no Ctrl+S in the TSP reducer |
| `alt+up` | `app.input.dequeue` | `:93` | `NOT_REACHABLE` |
| `escape` | `app.agent.interrupt` | `:95` | `SUPPORTED` — `handlers.cancel()` (`session.ts:669-672`) |
| `ctrl+c` | `app.exit.request` | `:97` | **deliberate difference**: cancel/interrupt, never exit (`session.ts:665-668`) |
| `ctrl+d` | `app.exit.request` | `:97` | `SUPPORTED` — empty-draft exit (`session.ts:689`) |
| `ctrl+f`, `ctrl+shift+f` | `app.transcript.search` | `:102` | `NOT_REACHABLE` |
| `ctrl+end` | `app.transcript.jumpLatest` | `:104` | `NOT_REACHABLE` |
| `enter`/`shift+enter` (search scope) | `app.transcript.search.next`/`previous` | `:106-107` | `NOT_REACHABLE` |
| `escape`,`ctrl+c` (search scope) | `app.transcript.search.close` | `:110` | `NOT_REACHABLE` |
| `ctrl+o` | `app.transcript.toggleExpand` | `:112` | `NOT_REACHABLE` |
| `alt+t` | `app.transcript.toggleThinking` | `:114` | `NOT_REACHABLE` |
| `ctrl+g` | `app.editor.external` | `:122` | `NOT_REACHABLE` |
| `ctrl+v` | `app.clipboard.pasteMedia` | `:124` | `NOT_REACHABLE` (the TSP reducer ignores ctrl-modified keys, `tsp/editor.ts:273-278`) |
| `shift+tab` | `app.permission.cycle` | `:120` | `NOT_REACHABLE` |
| `ctrl+t` | `app.todo.toggle` | `:118` | `NOT_REACHABLE` |
| `down`+empty editor | `app.tasks.open` | `:126` | `NOT_REACHABLE` |
| `ctrl+r` | `app.history.search` | `:128` | `NOT_REACHABLE` |
| `alt+k` | `app.shell.dismissSettled` | `:130` | `NOT_REACHABLE` |
| *(no default; deprecated)* | `app.input.queue` | `:87` | `NOT_REACHABLE` — the deprecated queue action; TSP queueing is the busy-`Enter` policy, not a chord |
| *(bindable, no default)* | `app.transcript.toggleFullscreen` | `:116` | `NOT_REACHABLE` |
| *(no default; reserved)* | `app.session.open`, `app.session.new`, `app.session.resume`, `app.model.open` | `:135-139` | `NOT_REACHABLE` — the dispatcher returns `true` without a host call |

That completes all **26** `app.*` action ids declared in `APP_KEYBINDINGS`
(`src/tui/keybindings/definitions.ts:26-520`; the six no-default rows above are
enumerated rather than folded into a "reserved" summary).

### 4.2 Focused-component actions — Question (`question.*`)

| Keys | Action id (source:line) | TSP |
|---|---|---|
| `enter` | `question.confirm` (`definitions.ts:287`) | `SUPPORTED` via the seat (`tsp/interaction.ts:982-1020`, `1044-1054`) |
| `escape` | `question.cancel` (`:295`) | `SUPPORTED` |
| `left` / `right` | `question.previous` (`:303`) / `question.next` (`:311`) | `SUPPORTED` (paging — the seat pages with left/right, `tsp/interaction.ts:998-1006`) |
| `up` / `down` | `question.cursorUp` (`:319`) / `question.cursorDown` (`:327`) | `SUPPORTED` (option list, `tsp/interaction.ts:988-996`) |
| `pageUp` / `pageDown` | `question.pageUp` (`:335`) / `question.pageDown` (`:343`) | `NOT_REACHABLE` — the TSP seat has **no** page-key route (verified: the seat handles only up/down/left/right/enter/space/escape) |
| `e` | `question.toggleExpand` (`:351`) | `NOT_REACHABLE` — the seat has no expand toggle |
| `space` | `question.toggleSelection` (`:359`) | `SUPPORTED` (multi-select, `tsp/interaction.ts:1013`) |

The TSP seat's own key contract for the same seat (its authority is the seat,
not `APP_KEYBINDINGS`): approval `y`/`n`/`escape`/`ctrl+c`
(`tsp/interaction.ts:890-906`); question review `enter`/`left`/`escape`
(`:908-927`); free-text edit keys (`:928-981`); option list (`:982-1020`);
continued list `up`/`down`/`enter`/`escape` (`:860-886`).

### 4.3 Focused-component actions — Tasks (`tasks.*`)

`src/tui/keybindings/definitions.ts:373-484` defines the live Task Center map
(`:488-519` holds four deprecated, default-less aliases). **Every one of them is
`NOT_REACHABLE` on TSP**: the Task Center has no TSP entry
(`supportsTaskCenter=false`, PANEL-006).

| Keys | Action id (source:line) | TSP |
|---|---|---|
| `enter` | `tasks.open` (`:373`) | `NOT_REACHABLE` |
| `/` | `tasks.search.enter` (`:381`) | `NOT_REACHABLE` |
| `escape` | `tasks.search.exit` (`:389`) | `NOT_REACHABLE` |
| `a` | `tasks.scope.toggle` (`:397`) | `NOT_REACHABLE` |
| `tab` / `shift+tab` | `tasks.type.next` (`:405`) / `tasks.type.previous` (`:413`) | `NOT_REACHABLE` |
| `right` / `left` | `tasks.tree.expand` (`:421`) / `tasks.tree.collapse` (`:429`) | `NOT_REACHABLE` |
| `s`,`shift+s` | `tasks.stop` (`:437`) | `NOT_REACHABLE` |
| `r` | `tasks.refresh` (`:445`) | `NOT_REACHABLE` |
| `up` / `down` | `tasks.cursorUp` (`:453`) / `tasks.cursorDown` (`:461`) | `NOT_REACHABLE` |
| `pageUp` / `pageDown` | `tasks.pageUp` (`:469`) / `tasks.pageDown` (`:477`) | `NOT_REACHABLE` |

The remaining focused-component and panel-local key maps — which are **not** all
in `APP_KEYBINDINGS` — are enumerated key by key in §4.5; every one of them is
PiTui-only and `NOT_REACHABLE` on TSP (`grep` for any of them in
`src/tui/tsp/**` finds none).

### 4.4 TSP fixed chords (not in `APP_KEYBINDINGS`)

| Keys | Behaviour | Status |
|---|---|---|
| `alt+q` | continued-question list, outside the hydration fence (`session.ts:656-660`) | `SUPPORTED` (B4) |
| printable / bracketed paste | text; one atomic edit (`tsp/editor.ts:195-205`) | `SUPPORTED` |
| `ctrl+c` / `escape` | the existing cancel/interrupt intent | `SUPPORTED` |
| `ctrl+d` (empty draft) | exit | `SUPPORTED` |
| any other control chord | the reducer returns `none` (`tsp/editor.ts:271-278`) | `NOT_REACHABLE` (silently ignored — **not** `EXPLICIT_UNAVAILABLE`, see §6) |

### 4.5 Component-local and panel-local key maps (PiTui-only)

These are handled inside the component's own `handleInput` (or its
`onSubmit`/`onEscape` field callbacks), not by `APP_KEYBINDINGS`. All are
`NOT_REACHABLE` on TSP because the panel itself has no TSP entry; the caller
column names the panel that owns the key. Completeness was established by
reading each panel's input handler that the audit could reach from the real
`src/tui/**` surfaces (`footer/configurator.ts`, `plugin-manager/panel.ts`,
`interaction/save-location.ts`, `panels/history-panel.ts`,
`panels/task-panel.ts`, `interaction/approval-runtime.ts`,
`pickers/model-picker.ts`, `keybindings/ui/{list,recorder,action-editor}.ts`,
`keybindings/leader.ts`) — 11 callers.

| Panel / caller (source:line) | Keys | Effect | TSP |
|---|---|---|---|
| Footer configurator (`src/tui/footer/configurator.ts:200-286`) | `backspace`, `escape`, `enter` | edit / back / confirm the row | `NOT_REACHABLE` |
| ″ | printable text | row text input | `NOT_REACHABLE` |
| ″ | `s` (rows mode) | save through the ONE save path | `NOT_REACHABLE` |
| ″ | `a` / `m` / `f` / `space` (row mode) | add / move / cycle format / remove | `NOT_REACHABLE` |
| ″ | `shift+up` / `shift+down` | reorder (legacy compat) | `NOT_REACHABLE` |
| ″ | `up` / `down` / `left` / `right` | navigate / move zone | `NOT_REACHABLE` |
| Plugin Manager (`src/tui/plugin-manager/panel.ts:91-124`) | `escape`, `ctrl+c` | back | `NOT_REACHABLE` |
| ″ | `up` / `ctrl+p`, `down` / `ctrl+n` | move | `NOT_REACHABLE` |
| ″ | `enter` | open/activate | `NOT_REACHABLE` |
| ″ | `r` / `R` | refresh the registry | `NOT_REACHABLE` |
| ″ | `i` / `I` | start install | `NOT_REACHABLE` |
| ″ install mode (`:126-190`) | `tab` | switch spec/registry focus | `NOT_REACHABLE` |
| ″ install mode | `enter`, `up`, `down` | inspect / choose a registry entry | `NOT_REACHABLE` |
| ″ install mode (`:173-175`) | `c` / `C` | cancel the install | `NOT_REACHABLE` |
| Save-location prompt (`src/tui/interaction/save-location.ts:328-352`) | `y` or `question.confirm` | overwrite/accept | `NOT_REACHABLE` |
| ″ path field (`:137-140`, hint `:418`) | `enter` / `escape` | submit the typed path / cancel (the shared `Input` callbacks) | `NOT_REACHABLE` |
| ″ | `n` or `question.cancel` | return | `NOT_REACHABLE` |
| ″ | `tab` | ACCEPT the highlighted path suggestion (`:341-344`) | `NOT_REACHABLE` |
| ″ | `question.cursorUp`, `question.cursorDown` | move the SUGGESTION selection (`:345-354`), not between fields | `NOT_REACHABLE` |
| Keybinding list (`src/tui/keybindings/ui/list.ts:271-306`) | `escape`, `up`, `down`, `pageUp`, `pageDown`, `enter` | navigate / open the action editor | `NOT_REACHABLE` |
| ″ leader editor (`:530-547`) | `escape` cancel, `r` reset the leader, `enter` start the recorder | edit the leader key | `NOT_REACHABLE` |
| Key recorder (`src/tui/keybindings/ui/recorder.ts:176-223`) | any recognizable, valid key press | **capture it as the new binding** (the mode's central action; `parseKey`+`validateRecordedKey`, `:206-223`) | `NOT_REACHABLE` |
| ″ | `escape` | cancel the recording (`:176`) | `NOT_REACHABLE` |
| ″ | text/unparseable input | refused with an inline error (`:210-213`) | `NOT_REACHABLE` |
| Keybinding action editor (`src/tui/keybindings/ui/action-editor.ts:288-492`) | `escape`, `up`/`k`, `down`/`j`, `delete`/`backspace`, `enter` | navigate / edit / bind / accept | `NOT_REACHABLE` |
| ″ row mode (`:326-345`) | `a` add a binding, `r` reset the action, `d` disable the action | mutate the action | `NOT_REACHABLE` |
| ″ choose-binding mode (`:488-492`) | `d` / `l` (or enter) | pick the binding in the list | `NOT_REACHABLE` |
| History search panel (`src/tui/panels/history-panel.ts:267-283`) | `tab` | cycle scope | `NOT_REACHABLE` |
| ″ | `up`, `down`, `pageUp`, `pageDown` | move | `NOT_REACHABLE` |
| ″ | `enter` / `ctrl+j` | accept | `NOT_REACHABLE` |
| ″ | `escape` / `ctrl+c` | cancel | `NOT_REACHABLE` |
| Task Center stop confirmation (`src/tui/panels/task-panel.ts:602-616`) | `escape` cancel; `y`/`Y` confirm the stop | confirm dialog | `NOT_REACHABLE` (Task Center itself is PANEL-006) |
| ″ while confirming (`:611-616`) | `tasks.cursorUp`/`cursorDown`/`pageUp`/`pageDown` | move and thereby INVALIDATE the pending stop confirmation | `NOT_REACHABLE` |
| Approval input (`src/tui/interaction/approval-runtime.ts:111-128`) | `y` allow-once; `n` reject; `escape`/`ctrl+c` cancel; every other key consumed | PiTui approval seat | TSP has its **own** seat for the same authority (PANEL-014), so the PiTui keys are `NOT_REACHABLE` while the TSP equivalents are `SUPPORTED` |
| Model picker — effort mode (`src/tui/pickers/model-picker.ts:528-544`) | `enter` confirm, `right`/`left` effort, `escape` leave effort mode | choose the reasoning effort | `NOT_REACHABLE` |
| Model picker — model mode (`:546-554`) | `enter` activate the selected model | commit the model | `NOT_REACHABLE` |
| ″ model mode | `up`/`down`/`pageUp`/`pageDown`/`escape` and plain `left`/`right` plus printable typing | delegated to the picker's **list** (`:554`) and **SearchInput** (the source comment at `:545-547` names both) | `NOT_REACHABLE` |
| Leader sequences (`src/tui/keybindings/leader.ts:98-117`) | `leaderKey` + binding, `escape` | user-configured chords | `NOT_REACHABLE` |

The one authority overlap worth naming: the PiTui approval dialog and the TSP
seat implement the **same** `InteractionPort`/`QuestionSurfaceController`
authority (PANEL-014); the TSP seat's own keys are listed in §4.2 and are
`SUPPORTED`.

## 5. Session / Task / Viewer — currentness and locality

| Concern | Authority | TSP |
|---|---|---|
| Session switch/fork/resume/new | `app/session/**`, session transition gate, exact generation/binding | no entry; presentation only |
| Cold hydration → Loading fence | `session-presentation.ts`; TSP `setTranscript` drops a retired-source frame and lifts the fence only when a **new source identity** commits (`tsp/session.ts:458-476`) | implemented, read-only |
| Presentation key scope | TSP epoch prefix `s<n>-…` per source identity (`tsp/session.ts:468-476`) | prevents cross-subject SDK node-id reuse (SDK ids are not generation-fenced — see sdk-events §6.4) |
| Subagent viewer (continuable child) | `viewer-runtime.ts`, viewer tokens/policy (`viewer-policy.ts:67`) | `supportsViewer=false` → refused at the real admission (`viewer-runtime.ts:409`) |
| Task/Jobs | `task-runtime.ts` + the Job observation registry | `supportsTaskCenter=false` gates reads (`task-runtime.ts:521,535`); no fabricated status |
| Client/Host locality | Client-local UI state vs Host session; Remote semantics are PR7 | unchanged |

`PROJECTION_ONLY` ≠ navigable Session state. The TSP dock shows a session title
and status facts (`statusFacts`, `tsp/session.ts:486-500`) — a projection,
**not** `/title` or `/status` support; both commands remain
`EXPLICIT_UNAVAILABLE`.

### 5.1 A→B stale-subject decision chain

A switch commits a new projection source → `scopeEpoch += 1`, fresh
`TranscriptNodeKeys`, and `hydrating` clears only on the new-source commit
(`tsp/session.ts:468-476`); a late frame from the **retired** source returns
early (`458-462`). Submission-side, the switch-dropping contract
(`retainsStaleDraftRestore=false`, `tsp/session.ts:552-557`) means a late stale
restore is suppressed rather than reseeding B's composer. Evidence:
`test/tern-tsp-controller-stale.test.ts:216` (replaced owner never reseeds),
`:229` (same-owner invalidation still restores), and
`test/tern-tsp-submission.test.ts:340` (a real switch clears A's draft).

## 6. Editor / media / clipboard

| ID | Capability | Client/Host owner (source:line) | TSP status | `evidence_state` | Positive | Negative | Tier |
|---|---|---|---|---|---|---|---|
| EDIT-001 | Controlled UTF-16/grapheme editor, caret, CJK/emoji | TSP composer (`tsp/editor.ts:124`) + the grapheme policy | `SUPPORTED` (keyboard) | `VERIFIED` (B4 record) | B4 C1/C2 real pane; `test/tern-tsp-editor-input.test.ts` | a refused command restores the draft | `REAL_TERN_GUI` (B4, owner-attested) + `SDK_SCRIPTED` |
| EDIT-002 | Atomic bracketed paste (newlines/`/name` stay content) | TSP composer reducer (`tsp/editor.ts:195-205`) | `SUPPORTED` (scripted + B4 physical paste, owner-attested) | `VERIFIED` (B4 record) | B4 C2 physical paste; scripted decoder tests | an embedded `/name` is never dispatched as a command | `REAL_TERN_GUI` (B4) + `SDK_SCRIPTED` |
| EDIT-003 | Native editor chords (`Ctrl+A`, `Ctrl+V`, undo, selection) | none — deliberately not wired | `NOT_REACHABLE` | `VERIFIED` | `grep` finds no chord route in `src/tui/tsp/**`; the reducer returns `none` for ctrl-modified keys (`tsp/editor.ts:271-278`) | **silently ignored**, therefore NOT `EXPLICIT_UNAVAILABLE` (plan §5.1) | `TYPE_ONLY` |
| EDIT-004 | Native `edit`/`undo`/`send` TSP events | SDK feature gate (`PROGRAM_FEATURES`) | `UNCLASSIFIED` | `BLOCKED` | probe 5 shows a real pane delivering raw `key` inputs, not `edit`/`send` (sdk-events §6.1) | the feature may exist only on the GUI/IME path | `GUI_BLOCKED` |
| EDIT-005 | Input history recall (`Ctrl+R`, `up`) | `input-history.ts:80` | `NOT_REACHABLE` | `VERIFIED` | no TSP chord route | — | `TYPE_ONLY` |
| EDIT-006 | Slash completion / `@` mention | PiTui editor seat + `domain/file-completion` | `NOT_REACHABLE` | `VERIFIED` | no TSP trigger exists | — | `TYPE_ONLY` |
| MEDIA-001 | Clipboard text/image read | `client-actions.ts:69` + `client/clipboard/{read,copy}.ts` | `NOT_REACHABLE` | `VERIFIED` | the PiTui `ctrl+v` action has no TSP chord | — | `TYPE_ONLY` |
| MEDIA-002 | `/attach` `/image` draft attachment | `client/media/draft-attachments.ts` + Host attachment admission | `EXPLICIT_UNAVAILABLE` | `VERIFIED` | the TUI-builtin refusal (command matrix CMD-018) | no draft mutation, no laundering path | `L6` |
| MEDIA-003 | OSC 52 copy | `client/clipboard/copy.ts` via `client-actions.ts` | `NOT_REACHABLE` | `VERIFIED` | `/copy` is refused; no other TSP entry | — | `TYPE_ONLY` |
| MEDIA-004 | External editor (`$EDITOR`) | `client-actions.ts` external-editor action | `NOT_REACHABLE` | `VERIFIED` | `ctrl+g` has no TSP route | — | `TYPE_ONLY` |

### 6.1 Attachment-laundering decision chain

There is no TSP path that turns an image into text today: `Ctrl+V` never reaches
`ApplicationEvents.onPasteMedia`, and `/attach` is refused before any draft
mutation (the same shared refusal that restores the draft). The **future** 4C
risk is explicit: an attachment must travel `Client-local clipboard/media policy
→ draft image store → submit attachment admission → original Host attachment`,
never as an `[image #]` string. This is a 4C prerequisite, not a current defect:
no laundering path exists because no path exists.

## 7. Non-key native events — the core UX gap

Anchored in the real-Tern probe
([pr4-0-sdk-events.md § 5-6](./pr4-0-sdk-events.md)).

Chain: real pane gesture → SDK yields `SessionInput{type:'event'}` (no node
handler exists to consume it) → `routeInput` event branch
(`tsp/session.ts:713-721`) → `seat.handleEvent`
(`tsp/interaction.ts:1264-1271`) → returns `false` unless a modal is open and
`ev ∈ {focus, edit, undo, send}` → `routeInput` returns `false`, **nothing
happens**.

- ID `SDK-EVT-NONMODAL`: `NOT_REACHABLE` — no business sink exists. The *input*
  is reachable; the *action* is not. Positive: `REAL_TERN_HEADLESS` probe 2
  yields `action`/`select`/`activate`/`change`/`focus`; scripted lock
  `test/tern-tsp-live-mount.test.ts` "PR4-0: non-key SDK events reach no
  business action…". Negative: zero submit/steer/cancel/exit.
- **Precise hit-target statement.** The renderer builds only
  `col`/`text`/`md`/`code`/`card`/`badge`/`tool`/`section`/`overlay`/`editor`/
  `input` nodes and declares **no** `actions`, **no** `collapsible` and **no**
  SDK handler prop (`grep` across `src/tui/tsp/**` for the 12 handler props and
  for `collapsible` finds only the composer's own local `onChanged` sink, which
  is not an SDK handler). Therefore the **only** pointer targets are the two
  focusable fields — the composer `ui.editor` (`tsp/session.ts:437-444`) and the
  modal free-text `ui.input` (`tsp/interaction.ts:1070`) — whose click yields a
  `focus` event that `routeInput` drops outside a modal; `action` / `select` /
  `activate` / `change` **cannot be produced by the current view at all**. Say
  "focus-only composer hit target; no actionable business nodes", not "no
  pointer hit target".
- The one live modal seat IS protected: while a modal is up, `focus`/`edit`/
  `undo`/`send` are claimed and the composer focus is re-asserted
  (`tsp/session.ts:719`), and the real pane's `overlay{modal:true}` intercepts
  background **pointer** actions (probe 6) — but the SDK masks the picture, not
  the keyboard, so the app-side modal-first key route stays the authority.
- Whether Tern's **own** native affordances (e.g. an auto-fold on a page it
  renders itself) can emit `toggle` for a node the app did not mark
  `collapsible` is `UNKNOWN` in this audit: the probe produced `toggle` only for
  an explicitly `collapsible` card. This is a PR5 question, not a PR4 blocker.

## 8. Question / Approval

| ID | Capability | TSP status | Positive | Negative |
|---|---|---|---|---|
| Q-001 | Approval modal (y/n/esc/Ctrl+C) | `SUPPORTED` (keyboard) | B4 C3/C7 real pane; `test/tern-tsp-interaction.test.ts` | every other key is consumed and never reaches the composer (`tsp/interaction.ts:890-906`) |
| Q-002 | Question form (options, free text, multi-select, review, paging) | `SUPPORTED` (keyboard) | B3/B4 C6 | an unrepresentable payload is refused with a notice and the flow's cancellation error (`tsp/interaction.ts:1176-1182`) |
| Q-003 | Timed → continued → `Alt+Q` → late answer | `SUPPORTED` | B4 C6 chain; interaction tests | a stale lookup is never re-installed after retirement (`tsp/interaction.ts:1218-…`) |
| Q-004 | Fail-closed when no presenter wired | `SUPPORTED` | `interaction-runtime.ts:351`; `test/tern-tsp-live-mount.test.ts` A-08/A-08b | approvals resolve `unavailable`, questions delegate to `next()`; no implicit allow |
| Q-005 | Physical IME/paste inside the masked question | `UNCLASSIFIED` | — | **`DEFERRED_WITH_OWNER`** → proposed 4C; must not be called done |
| Q-006 | Modal node click actions | `NOT_REACHABLE` | overlays are `ui.text` rows only (`tsp/interaction.ts:1028-1117`) | keyboard is the contract |

Q-005 is the PR3-B B4 masked-physical item: the owner deferred it to PR4 rather
than record an unproven pass (`docs/tern-tsp/evidence/pr3-b.md`, "Owner QA
confirmation"). It stays `DEFERRED_WITH_OWNER` here.

## 9. Extension surface

| ID | Capability | TSP status | `evidence_state` | Rationale |
|---|---|---|---|---|
| EXT-001 | Plugin registration / registry / Fiber lifetime | `SUPPORTED` (service-lifetime, renderer-independent) | `VERIFIED` | **Provider:** `src/extensions.ts:140-143` (`apply` constructs the `piTuiExtensions` service on `ctx` and unregisters it when the provider fiber unloads). **Positive:** `test/extension-cordis-lifecycle.test.ts:692-763` asserts the command/theme/setting registrations become LIVE and observable (`:737` command local, theme named, settings rows present, autocomplete/keybindings non-empty). **Distinct boundary negative:** the SAME test then unloads the owner fiber and asserts every registration is GONE (`:748` command not local, theme list empty, rows 0) — so the positive is not merely that the object exists. **Locality:** service-lifetime and renderer-independent; the TSP branch does not skip registration, only the UI seams (`bootstrap.ts:2663-2664`). |
| EXT-002 | Plugin UI chrome / overlay / input seams | `NOT_REACHABLE` | `VERIFIED` | `bootstrap.ts:2663-2664` skips `bindPluginKeybinds`+`attachSurfaceSeams` on TSP; there is no TSP entry and no refusal gate |
| EXT-003 | Advanced editor/UI (`advanced.ui`) | `NOT_REACHABLE` | `VERIFIED` | same skip; no Advanced TSP adapter exists |
| EXT-004 | Unstable raw input / raw-line mount | `NOT_REACHABLE` | `VERIFIED` for the skip; `UNKNOWN` for what a plugin observes | the roadmap's "TSP-unsupported" is a **policy recommendation**, not an evidenced runtime refusal; no TSP input route exists at all, so the accurate state is "no entry", not "explicitly refused" |
| EXT-005 | `api().capabilities.has(...)` service-level advertisement | unchanged — still a **service** advertisement, not a renderer claim | `VERIFIED` | `docs/tern-tsp.md`; PR6E0 owns the distinction |

The audit does **not** modify `api().capabilities` and does not implement PR6E0.
The gap (service-advertised vs renderer-attached) is PR6 input; the
renderer-capability distinction already exists in the display seam.

## 10. Gaps → recommended PR

| Gap | PR |
|---|---|
| No TSP command/picker UI | 4A — **two routes with different prerequisites:** a keyboard-only closure needs only a presentation seam over the existing seat/key routing (NO 4A0); any pointer-actionable UI additionally needs a verified scoped non-key event admission (candidate 4A0). See the 4A0 decision in [pr4-0.md](./pr4-0.md#4a0-decision). |
| No non-key event → scoped intent admission | only for the POINTER route of 4A/4B — not a prerequisite of the keyboard-first 4A closure |
| No TSP menu/picker/selection UI | 4A |
| No session/task/viewer/plugin panel entries | 4B |
| No clipboard/image/file/external-editor path | 4C |
| Physical masked-question qualification | 4C (owner-deferred) |
| Native editor feature events (GUI/IME tier) | 4C (blocked) |
| Transcript Focus/Compact/search + the auto-fold ownership question | PR5 |
| Renderer-aware plugin capability / raw-input policy | PR6 |
