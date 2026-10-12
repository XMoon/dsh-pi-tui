# Tern TSP PR4-A Preset evidence — the native `/preset` picker

Durable summary of the PR4-A **Preset** increment: what it adds, the frozen UX
contract it implements, the measured layout facts and their accepted limits, the
ownership/admission invariants, what each verification tier actually proves, and
which implementation pitfalls became rules or regressions.

This file records behavior and coverage, not volatile run results: counts and
commit identities live in the pull request body and comments, and the raw
real-pane artifacts live outside the repository with the review package.

Companion documents: [preset selection](../preset-selection.md) (behavior,
ownership, coverage and limits), [Model selection](../model-selection.md) (the
sibling PR4-A surface, whose presenter split and fact-row algorithm this
increment reuses) and [TSP integration](../../tern-tsp.md) (protocol boundary,
capability matrix, evidence ledger).

## 1. What PR4-A Preset adds

- **`/preset` becomes a native TSP surface.** The original `/preset` command
  family keeps every read and write owner; it now has PiTui and native TSP
  presentation adapters behind one narrow contract. The panel renders one
  compact native picker with a preset list and a read-only details page.
- **Session/default/next/draft facts become explicit.** Built-in versus Custom,
  the live Session's preset, the run-local pending preset and the effective
  new-session default are separate, independently derived display facts — never
  one `selected` boolean.
- **Explicit-action-only writes.** A row activation and Enter on the list only
  browse; only the explicitly focused enabled action commits, through the
  original writer functions.
- **Fail-closed admission.** The command family is available only when the
  mounted pane advertises the kind the picker actually renders.
- **No new authority.** No `PresetCatalog` method, Host wire operation, writer,
  Session gate, input owner or public extension API was added; PiTui behavior and
  the typed verbs keep their existing semantics.

## 2. The owner-frozen UX contract

- One native `ui.picker` at the fixed `md` size with `preview: 'none'`; no
  overlay, no second dialog, no injected stylesheet, no `ui.el` layout.
- Built-in rows first, then Custom, each group in roster order; the kind and a
  one-line description (or `No description.`) ride each row's second line, a
  broken row carries `Failed to load: <reason>` there, and the shipped four keep
  their fixed English copy while a user declaration reusing a shipped id stays
  Custom with its own name.
- `Current session` / `Next session` / `New-session default` / `Draft` are
  independent facts: a sessionless panel shows `Next session` and never a
  `Current`, a live panel never invents a `Next session`, and `Draft` appears
  only while the browse target is not one of the committed facts.
- Two K2 zones (list, action bar); the Details page is the same picker over
  inert facts. Enter never writes from the list or the details page; the focused
  enabled action is the only writer.
- The action order is `Details`/`Back`, `Use preset` (`Use for next session`
  without a Session, `Use in this session` for a blank live one),
  `Set new-session default`, `Close`, with `Retry` replacing the writes while
  the roster read has failed.
- `Set new-session default` states its scope (`changes new sessions only`) and
  never recomposes the current Session.

## 3. Measured layout contract, and the accepted limits

Measured on the real renderer for this increment (`tern serve` + `ctl tree` /
`ctl shot`), at the four required pane sizes with the production presenter:

| Pane | cols | picker sheet box |
|---|---|---|
| 1280x800 | 160 | 680x540 |
| 900x640 | 111 | 680x498 |
| 560x640 | 68 | 500x498 |
| 400x600 (minimum) | 47 | 340x458 |

- Each header/hint line renders as exactly ONE 15px row at every tested size,
  including the 400x600 minimum, and each is capped at 382px with an ellipsis
  when the value does not fit. A worst-case unbroken 180-character id therefore
  cannot turn the header into a wrapped block: the facts, the picker and its
  action bar all stay on screen at the minimum pane.
- The measured text advance of these lines is ~7.8px/char; the fact-row slot and
  its 11-column compact cap come from the shared Model measurement (286px at a
  400px pane) because the preset picker is the SAME `md` sheet without a preview.
- The complete reading path is the invariant, not a pixel promise: the
  worst-case unbroken 182-character id is reconstructed in full on the real
  renderer by walking the keyboard down its own wrapped Details rows.
- Accepted limits: a pane narrower/shorter than the measured minimum, a
  different UI font, an enlarged terminal font, a changed DPI or a UI zoom are
  outside what a fixed budget can track, and the SDK exposes only `cols`/`cell`
  for geometry, so the presenter neither detects nor claims to degrade there.
  Physical input, IME, themes, OS focus and screen readers are not certified.

## 4. Ownership, admission and lifecycle invariants

- **One command owner.** `src/tui/commands/models.ts` still captures the Session
  scope, owns the roster read and the operation token, and calls the original
  `applyPresetSelection` for `Use` and a single extracted `setPresetDefault` for
  both the typed `/preset default <id>` verb and the picker action. Neither
  presenter holds a catalog, a writer, a Session gate or a pending-preset store.
- **One read owner.** The first read and every Retry run the same `runOwned`
  task with the same captured scope, signal, presentation token and supersession
  semantics; a retry while a read is in flight is refused.
- **One admission point.** Every key and every SDK event passes through the
  presenter's `act`, which rechecks the live panel, the subject, the
  presentation revision, the phase and the interactability gate before any
  mutation. Row ids carry their own `preset:` namespace, so a real preset id can
  never be mistaken for an action id or a Details fact-row id.
- **One layer.** Opening the Model or the Preset presenter retires the other
  first; a Question/Approval modal seat still takes precedence over both, and a
  retired frame's node ids are never routed again.
- **Explicit supersession.** Every `/preset` invocation takes the presentation
  token, so a newer invocation retires the previous panel while an
  already-admitted Host write still settles through its own owner. Hydration and
  disposal retire the panel synchronously, and a late read cannot reopen it.
- **PiTui is unchanged.** Its overlay still opens only once the rows are known,
  with its original fields and wording, its one-step Enter and no new actions.

## 5. Verification tiers — what each one proves

| Tier | What it covers in this increment |
|---|---|
| `FACT_CODE` | The frozen UX and K2 contract in `preset-picker-state` / `-intents` / `-view`, the command-side read/write ownership, the capability predicate and the settings-write classification. |
| `SDK_SCRIPTED` | The production presenter over the shipped SDK (`connect` + `mountTspRenderer`) with a scripted tty: layout props, the K2 write admission (including a synthetic event naming a disabled action), the settlement matrix, the supersession/staleness fences (a moved subject, a late settlement against a replaced panel, a late read), stale receivers, Model/Preset mutual exclusion and fail-closed capability. |
| `REAL_TERN_HEADLESS` | The production `TspPresetPicker` inside a real Tern pane at 1280x800, 900x640, 560x640 and 400x600: the header/hint single-row bound, the full action bar, real keyboard K2 including the cue and the arrow cycle, a real pointer row selection that writes nothing, the read-only Details page, the empty roster, the failed read with its one `Retry`, special ids, the long CJK/emoji description and the worst-case unbroken id. |
| `L6` (command/Host) | The real classifier, capability admission, original handler and Direct Host sinks: the capability refusal keeping the draft and creating no Session, the real `agent-presets` registry roster, sessionless staging without a Session, both started-Session refusals, the typed verbs keeping their original routes and never opening a picker, a Host-owned `preset` keeping its route, the blank live-Session switch over a REAL persisted Session (one durable `agent-preset/selected`, the authority reread, the started-Session locked negative, a clean teardown), and the default write through the REAL configuration plane — the picker's action and the typed verb both write the same `selectedDefault` into the real profile document, and a fresh Context composes that document and reads the persisted default back through a live registry. |
| `NOT_VERIFIED` / `GUI_BLOCKED` | Physical mouse/wheel/IME/OS focus, dark themes, scaling and screen readers; Remote TSP preset success; the shipped full profile/HMR; catalogues and terminal sizes beyond the scripted ones. |

The real-pane tier is a HEADLESS real-renderer run (`tern serve` with the pane's
node tree and PNG captures); it is not a physical GUI/IME qualification, and the
sibling Model increment's `GUI_BLOCKED` items stay `GUI_BLOCKED`.

The blank live-Session durable switch is certified end-to-end. The TSP renderer
refuses `/new` (a PiTui-only builtin under the frozen PR3-B admission) and the
official registry handle's `dispose()` removes its session from the store, so the
test-infrastructure seam went through the OFFICIAL persistence seam instead:
`create(header)` takes write ownership, `flush()` materializes the artifact and
`close()` releases the handle WITHOUT deleting the stored log, after which the
runner's ordinary startup resumes that persisted, released, blank Session. The
test then drives the real picker and asserts the blank state through the Host
authority, exactly one `agent-preset/selected` in the live Session's own log with
no re-created Session, the official Session projection plus a reopened panel
rereading the new preset as Current, an untouched new-session default, the STARTED
Session's locked refusal afterwards, and a post-teardown registry with no live
Agent left. No durable commit is simulated and no projection is tampered with.

## 6. Pitfalls that became rules or regressions

| Pitfall | Rule / regression |
|---|---|
| A `▸` cue that promises Enter in a phase that refuses it (an admitted write, a running read) | The cue and the hint accent are gated on the same predicate that admits bar keys (`ready`/`error`); the presenter regression asserts a pending bar marks nothing. |
| A disabled action becoming the bar's fallback focus (an empty roster, a broken row, the row that IS the default) | Entering the bar focuses the first AVAILABLE write, then the page action, then `Close`; the arrow cycle skips disabled entries, and the presenter + real-pane runs assert no dead focus. |
| A fact value that is only readable through an ellipsis (a long description, an unbroken id) | Every Details value goes through the shared measured fact-row wrapper; the real-pane run reconstructs an unbroken 182-character id by walking its rows. |
| A header line wrapping into a variable-height block that pushes the action bar off a short pane | Each status/hint line is asked for exactly one truncated row, verified at the 400x600 minimum with a worst-case identity. |
| Row ids colliding with control ids in the SDK's single event channel | Rows carry their own `preset:` namespace; the presenter regression covers ids equal to an action id, a `fact:` id, a scope id and an effort id. |
| Treating the settings write as a classified `WriteOutcome` and reporting a raise as a proven rollback | The default write is reported as UNCONFIRMED, never retried automatically, and the panel dismisses so the next read is authoritative. |
| A notice admitted by the operation token alone, so a write that settles after its panel was replaced writes its line onto the new panel's dock | Every `/preset` notice goes through ONE predicate that consumes both markers (the operation token for the settlement, the presentation token for the display), including the standing-catalog notices; the regression holds a real Host write open, replaces the panel, settles it, and controls the same seam with an un-replaced panel. |
| A PiTui command settlement changed by the native path's immediate loading panel (an empty roster losing its success text, a read failure becoming a late background notice instead of a command failure) | The PiTui path awaits the roster read inside the handler again, so the frozen empty-roster text and the rethrown read failure (command notice, health, draft restore) are kept; only the native path reads in the background, and both share the same read owner. The command suite asserts the success text and the rejection. |
| A `disabled` action that is only rendered inert, so a pointer/synthetic SDK event naming it still writes (or silently dismisses the panel) | The ONE admission consumes the same enabled predicate the bar renders, so a disabled action can never write through any event channel; the regression dispatches exactly that event and asserts the panel keeps its frame and no write happens (mutation-checked: it fails without the gate). |
| A blank live Session that no fixture can build (`/new` is refused on TSP, and the official registry handle's `dispose()` deletes the stored session) | Materialize the Session through the OFFICIAL persistence seam (`create` → `flush` → `close`, which releases ownership without deleting the log) and let the runner's ordinary startup resume it; the blank-live test then proves the durable host commit, the authority reread, the locked negative and a clean teardown. |
| A directly registered preset under a profile composition failing the compatibility preflight for lack of a resolution base | Declare presets (and the registry itself) as REAL profile bundle rows, which is what gives the settings namespace the default write mutates; the reload test composes a fresh Context over the saved document. |
| `/preset` typed verbs dereferencing a `TuiApp` that the TSP renderer does not have | Every notification goes through the presentation contract; the typed verbs are exercised over the TSP path and the PiTui adapter keeps `app.notify`. |
| A failed read leaving the keyboard in an inert list | Both Tab directions stay in the error bar, whose `Retry` re-enters loading through the one read owner. |
| A newer `/preset` invocation leaving a stale panel reachable | Every invocation takes the presentation token; retired revisions and foreign surfaces are never routed. |
| Two native panels claiming one layer | Opening either presenter retires the other first; the presenter regression alternates Model and Preset and asserts exactly one picker node. |
| A node-id namespace that changes per revision but is read from a stale frame | The presenter rebuilds its target map every frame and rechecks the revision at admission; the wire-read helper folds the SDK's own `text` op so stable ids (the composer) read across frames. |

## 7. How to reproduce

```sh
# Build first: packages/pi-tui/dist is an input to the root bundle and the tests.
pnpm build

# The preset suites, plus the surfaces they touch.
node scripts/run-with-temp-root.mjs node --test \
  test/tern-tsp-preset-picker.test.ts \
  test/tern-tsp-preset-runner.test.ts \
  test/preset.test.ts \
  test/tern-tsp-model-picker.test.ts \
  test/tern-tsp-command-admission.test.ts
# (`tern-tsp-preset-runner.test.ts` includes the real profile-plane default write
#  and its fresh-Context reload; both preset suites run the disabled-action and
#  supersession/staleness fences.)

# Types, then the documentation/gate lanes that cover this area.
pnpm typecheck
pnpm test:docs
pnpm gate:architecture
pnpm gate:boundary
pnpm gate:keybindings
git diff --check
```

The real-pane evidence is produced by an out-of-repository driver
(`tern serve --control <sock>` + `ctl run/key/click/resize/tree/shot/quit` over a
probe that mounts the production `TspPresetPicker`), driven at 1280x800, 900x640,
560x640 and 400x600; its node trees, PNG captures, event log and assertion list
live with the review package. `tern serve` on this machine is software-rendered,
which is a performance note, not an input to any assertion.
