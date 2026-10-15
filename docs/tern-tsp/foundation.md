# TSP foundation: ownership, runtime and interaction contract

> **Status:** SOURCE-QUALIFIED FOUNDATION CONTRACT (2026-10-13). This is a contract for the **current experimental `dsh-pi-tui` TSP renderer**, not a normative TSP specification or a claim that all physical-GUI paths are qualified.
>
> **Baseline:** `dsh-pi-tui next@6bb11112dc91dc6e0ade66d4b16a3e83421030f9` (source/docs/scripts byte-identical to `df157261ad7119c1c93be33e542660c91ea7fbee` in audit scope); `@stencil-hq/tern@0.1.0` (installed source = `stencil-hq/tern-sdk@3c562a1de7a8501baad7338fc32aa85badf48cc4`); OMP reference `can1357/oh-my-pi@818dd42b73ab1caad17fa06d4edcc3a97086dc57`; headless Tern `0.8.3 (e2b8656)` observations. **Recheck on new versions.**
>
> **Companions:** [TSP integration and actual product status](../tern-tsp.md), [upstream reference](./upstream-reference.md), [dated source/evidence audit](./evidence/foundation-20261013.md), [real-pane harness](../tern-pane-harness.md), [application architecture](../architecture.md), [concurrency](../concurrency.md), [failure model](../failure-model.md).

## 1. Meaning and precedence

The application, official TypeScript SDK, terminal client and official-product precedent answer **different questions**:

| Layer | Authority / responsibility | Not sufficient evidence for |
|---|---|---|
| Accepted project product/architecture contract | Desired behavior, business ownership, supported workflow | What a closed-source terminal actually renders |
| Released TSP specification, **version-qualified** | Protocol vocabulary and intended operation semantics | Installed SDK implementing the latest text |
| **Installed pinned** `@stencil-hq/tern` | Encoders, event decoding, reconciliation, SDK frame and session mechanics | Client layout, pixel visibility, browser-style focus |
| `dsh-pi-tui` production entrypoints | Business-admission path, lifecycle/semantic owners, concrete emitted nodes | Terminal client implementing implied behavior |
| Tern client, exact build + observation tier | Negotiated capabilities, real headless layout/events/visible content under tested conditions | All builds, physical keyboard/IME, true end-to-end Host semantics |
| **Official-product reference** `can1357/oh-my-pi` | Demonstrated TSP component designs and independent runtime techniques | Normative SDK API, mandatory implementation or compatibility requirement |

**Rules:** record an exact SHA/version and exact `source → decision → sink` for load-bearing claims. Never treat SDK `main`, OMP's independent wire/backend or an online document as installed SDK semantics. Never promote `INFERENCE`, `UNKNOWN`, a single headless observation, or a historical PR evidence file to a universal protocol guarantee. A historical accepted UX decision is not a new SDK/terminal fact.

## 2. Production runtime chain and one-owner map

`DSH_PI_TUI_RENDERER=tsp` is opt-in. The default is PiTui; this document does not change either policy. At the audited baseline the production route is:

```text
bootstrap.ts:renderer-selection
 → connectTspRenderer → pinned SDK connect (before PiTui takes stdin)
 → mountTspRenderer → session.open({mode:'inline'})
 → SurfaceRuntime.start (installs presentation/composer/interaction ports)
 → bindRendererInput (one-time held-key replay)
 → SurfaceRuntime.repaintTarget → canonical projection
 → tsp/session.ts setTranscript / transcript-view / render
 → one surface.render({main?, dock, layer})
 → SDK View.from / ops / frame queue / TSP wire / Tern

Tern input → SDK session iterator → tsp/session.ts routeInput
  ├─ keyboard → dispatchKey → current local intent / editor
  └─ native event → current modal/picker seat → semantic admission
      → existing submission, model/preset, or Question/Approval owner

teardown → seat.dispose → retire presentational panels
 → surface.close({keep:false}) → session.close → renderer release
```

**Current code anchors** (at baseline): `src/app/bootstrap.ts:2404–2456,3213`; `src/app/bootstrap/renderer-selection.ts:20–22,51,104–106`; `src/app/surface/runtime.ts:1015–1105,1851–1943,1950–2009`; `src/tui/tsp/session.ts:212–286,405–445,505–538,703–846,878–926`; `src/tui/tsp/transcript-view.ts:257–279`. The complete stage-by-stage investigation is recorded in the unpublished local audit report `04-dsh-production-crosswalk.md` §A1 (A4-001–A4-016). The production source anchors above remain independently verifiable.

| Fact / operation | Existing authority / owner | Forbidden substitute |
|---|---|---|
| Durable DSH events, model/preset business writes, submission | Existing DSH/Host/Client commands and application submission controller | TSP UI state, selected row, preview, cached catalog |
| Transcript grouping, fold/window/currentness | Existing `TranscriptFolder`, `TranscriptWindowController`, `SurfaceRuntime` projection | A second TSP transcript state machine |
| TSP connection and terminal input lifecycle | Composition bootstrap + mounted renderer + **pinned SDK** | A second direct stdin reader or ad-hoc wire pump |
| Surface regions and emitted node projection | `src/tui/tsp/session.ts` (**one** `surface.render`) | Independently mounted competing renderers |
| Modal seat/keyboard precedence | `src/tui/tsp/session.ts` + `interaction.ts` and its application owner | `modal:true` as an automatic JavaScript keyboard handler |
| UI highlight, draft, pending, local page | Current presenter for that UI | Durable business authority |
| SDK frame/ACK/current sent View | Installed SDK `Surface`/`Session` | A second application-side reconciler without a demonstrated gap |
| Terminal rendering, pixel clipping and scroll view state | Tern client | Node-tree text, TypeScript props, guessed pixels |

**State-representation rule:** authority, disposable projection, SDK transport state, and component-local draft may contain similar values without being competing authorities. Classify consumers and lifetime before considering a reduction. A search hit or “two variables” is **not** proof of code entropy.

## 3. Surface, frame and lifecycle invariants

1. The current renderer opens one inline SDK surface; `main`, `dock`, and `layer` are SDK region names. At this baseline there is exactly one call to `surface.render`, in `src/tui/tsp/session.ts:427–445`. `layer` is always provided; `main` waits for its initial projection and `dock` is provided by the renderer. Do not create a second surface/owner as a convenience for one panel.
2. Our live `layer` producers return a `ui.col` **region root**; overlays/pickers are children of that root. This is a **verified project shape**, consistent with the official documentation example, **not** an SDK type law mandating `col` everywhere (`src/tui/tsp/interaction.ts:1119–1126`; `model-picker-view.ts:407–410`; `preset-picker-view.ts` (`presetPickerLayer`); pinned SDK `reconcile.ts:136–175`). A bare overlay as a region root does not acquire OMP-specific hoisting semantics in our SDK.
3. The SDK builds node IDs from region/key/child identity, compares sent Views and queues `f` frames; only the terminal acknowledges sent frames. It already implements diff, frame credit/coalescing, session iteration, and close handling. **Do not duplicate it** based on OMP's independent Backend (see upstream reference).
4. In our renderer `picker.suspend()/resume` means **local presenter seat state** (revision/targets); it is **not** a call to SDK `surface.suspend()/resume()`. SDK surface adoption is also a separate lifecycle.
5. Owned resources must be released in the existing order, with failed steps still attempted and failures surfaced. Startup null (`connect() === null`) follows the existing PiTui fallback; connect/mount throw uses existing startup/fatal handling. No silent fallback after an acquired or failed ownership transition unless the production contract authorizes it.
6. ACK credits constrain sends; ACK is **not** business completion, visual acceptance, keyboard admission, or a per-blob receipt. The observed headless 0.8.3 `error(s=9,op=0)` preceded `ack(s=9)`: **error-before-ACK is proven**, not that `action/select` universally precede ACK. For business currentness, use application identity/admission, not frame ACK as a transaction barrier.

### Credit-blocked queued Focus: SDK issue and ownership (2026-10-13)

A later runtime audit confirmed a **specific SDK queue defect**: under exhausted Frame Credits, `Surface.render()` retains only the newest pending View but `Surface.focus()` keeps earlier Focus ops in the independent `#queue`. On credit release, `#flush()` sends the latest View diff **followed by the unfiltered historical queue**. A Focus op can therefore name an input that was present only in a **never-sent** intermediate View. In a real **Tern 0.8.3 headless** pane the client rejected it with `error{sf:'s1',s:5,op:5,msg:'unknown id layer.modal-1.answer'}`; the next valid composer focus and key delivery still succeeded. **Protocol rejection proven; user-visible focus/input damage unproven.** See [dated Runtime Gap evidence](./evidence/runtime-gap-20261013.md) and [SDK issue #48](https://github.com/stencil-hq/tern-sdk/issues/48).

The application is still the **desired focus/seat owner**, the pinned SDK is the **Frame/Credit/queued-op owner**, and Tern owns actual rendered node/focus effects. **Do not** repair this boundary in the renderer with an extra Focus queue, Frame reconciler, ACK watchdog, or a `next render`-only deferred-focus latch: a forced `applyFocus(true)` can be event-driven without a guaranteed following render. The SDK's public raw `surface.send()` accepts structural `add/del` ops, so naïvely checking targets against the rendered View alone is **not** a universal SDK fix. The upstream report requests investigation; isolated SDK candidate experiments are not installed behavior.

ACK loss is a **separate unknown**: blocked normal frames rely on client ACK to resume; this does **not** by itself establish a practical deadlock or authorize a retry/watchdog. SDK `close()` can force a final flush despite blocked credit; it is a teardown operation, not a runtime delivery cure. **F3-002** (unobserved client `error`) was repaired independently by [PR #299](https://github.com/XMoon/dsh-pi-tui/pull/299), which logs recognized protocol error fields without changing routing, business writes or retry policy. **F3-003** (failed `keep:false` close followed by a possible SDK default-`keep:true` fallback) remains **`RISK_UNPROVEN`**, not a confirmed visible residue.

## 4. Node identity, event admission and focus

### Identity and stale events

- `key` is sibling/node identity. In the **pinned SDK**, changing a key changes child IDs and can produce `del` + `add`. **The original 2026-10-13 foundation audit established wire churn only.** The later PR #301 **model-specific** 42-row A/B/C/D probe on Tern 0.8.3 headless observed a per-revision Picker key causing a client remount and a 144px movement of visible rows after a click; preserving the Picker key left row coordinates unchanged. This closes that measured case, not all client/scroll/focus combinations.
- **Presenter-specific identity contracts differ.** The revised Model presenter keeps the Picker/layer key stable for one panel (`panel.serial`), gives each new Reader reading a separate epoch, and revision-tokens mutating/read-operation action IDs (`apply#<rev>`, `retry#<rev>`); `close` remains untokened for dismissal. Preset identity must be checked against its own source and is **not** silently changed by the Model evidence. Stable identity is allowed only with explicit currentness/admission proof; never copy OMP as a substitute.
- UI `action` includes `act`; `select/activate` include `id`/`item`. They **do not carry a normative frame revision**. Frame `ack` carries `s`; `error` may carry `s`. Therefore **revision in an action token is insufficient to cover every event type**. Any key-stability proposal must prove its actual `sf/id/item/act` admission, current session/panel/phase/revision, pointer and keyboard paths, plus delayed input where reachable.
- The SDK handler dispatch and the application event iterator/`targets` are **distinct routes**, not blanket “two stale-event checks.” The region root ID `layer` may recur in both maps. A single real-pane 0.8.3 run observed **no UI event targeting `layer`** when clicking its descendants; this does **not** prove globally unreachable old-frame UI events across all controls/renders.
- Never convert `select`, `activate` or a keyboard navigation gesture into a business write without the panel's actual single business-admission path. Pointer Action does **not** have to possess keyboard focus first; `focusedAction` limits the keyboard activation path.

### PR #301 Model evidence: stable visual identity with separate admission (2026-10-14)

This **supplements**, rather than retroactively rewrites, the source-qualified 2026-10-13 foundation baseline. The Owner-frozen `/model` UX moved from the historical wide/three-page layouts to a **two-page** catalogue + read-only Reader. The catalogue is one `ui.picker` (native `size:'md'`, `preview:'none'`) with one Effort `strip` and an explicit `Switch` / `Save default` footer. The Reader is a native overlay of client-wrapped text. Those choices are **product-specific**; they do not mandate the same layout for Preset, Settings or another TSP surface.

The 42-row real-client probe isolated `node key → SDK del/add → client remount → viewport movement`. The revised Model uses **per-panel key** for the Picker/layer, **per-reading epoch** for Reader body/Back, and **per-revision action IDs** for `retry`/`apply`; one broad "stable id" rule would be wrong. Picker Row events instead validate the current offered row and page; the Effort strip's composite item ID validates both the originating model and candidate, preventing a delayed chip click from drafting a different model. `close` is the one frame-free dismissal and keyboard Esc is state-dependent by the Model product contract. Each guarantee is limited by the concrete presenter/phase/target admission and its tested client.

Do not confuse this **application-side Reader scroll isolation** with a repair to the SDK's cross-surface Focus/Credit queue defect (F3-001, upstream issue #48), which remains open. PR #301's specific `scroll` negative no longer targets the next reading; it does not prove that stale Focus ops are impossible. All claims here are **Tern 0.8.3 headless**, not GUI/IME, dark mode, large fonts or physical wheel/trackpad qualification. See [Model selection](./model-selection.md) and [list-first evidence](./evidence/model-list-first-visual-20261013.md).

### Three different focus concepts

| Concept | Owner | What it means |
|---|---|---|
| Application keyboard focus / modal owner | Application `routeInput` + seat and presenter | Which intent may receive keys |
| Picker `focus:'list'/'preview'/...` | Picker props + client | Semantic Picker region focus; 0.8.3 visibly switched `f-list` ↔ `f-preview` in a headless run |
| `surface.focus(id)` | SDK frame op + client | Focus request on an actual node ID; client rejected an unknown ID with observable `error` |

At the baseline, model/preset presenter `desiredFocusId()` may request the region root `layer`. The client recognized that ID without error, **but its caret/editing effect was not established**; two attempted editor positive controls used incorrect IDs and cannot prove a successful editor focus. Do not classify this as a confirmed bug or confirmed correct caret behavior. `tone` is visual color, `selected` is item highlight, `action.on` is toggle/pressed state; none is a universal keyboard focus token.

### Modal scope

The application must route modal keys and guard semantic actions according to the active seat; `ui.overlay({modal:true})` alone does not implement our input arbitration. At Tern 0.8.3, a real headless modal backdrop **intercepted pointer clicks** using an open/closed same-coordinate control. This is evidence for that client and layout, not permission to skip all currentness/ownership checks for every UI event or later Tern build.

## 5. Layout, native components and capability policy

- A `picker` is a terminal-owned data-first **sheet**. A picker `item` and a generic `item` have **different field types and capabilities**: native `facts`, `columns`, `chips`, badges/mark/mono/tooltip are not universally available after replacing `picker` with generic `list/item`.
- **Default component design:** each selectable entity normally occupies one Picker Item, with identity in label and structured attributes in fields; prose and complete reading use a suitable text (`wrap:'word'`), `md`, or explicit Detail region. This is an OMP **design precedent**, not a protocol ban on long labels, nor a command to redesign existing accepted product UX.
- `preview:'side'|'below'|'none'` is a layout hint, not a guaranteed visible place. Key information/action must have another reachable path if a normal supported layout hides Preview. Do not assume that a DOM/tree string is visibly drawn: qualify clipping using ancestor geometry **and PNG**.
- For scroll: distinguish native `list/picker.selected` (selected-item behavior), `scroll` (supported feature with a scroller owner) and `reveal` (addressed node/placement). These operations are **not interchangeable**. At the **2026-10-13 foundation baseline** the renderer had no `scroll/reveal` consumer; **PR #301 added a Model Reader consumer** (`TspModelPicker` → `session.ts` `surface.scroll(id, to)`) and exercised the real client's body scroller, keyboard operations, re-entry epoch and a credit-stall negative case. This is not proof of generic Reader `reveal`, physical wheel/trackpad or other Tern releases.
- Features/kinds are negotiated at runtime, not inferred from package declarations, widths or version labels. SDK `Surface` API calls do not universally guard optional features for the caller. Read-only components may degrade to an explicitly verified simpler native composition; **write-critical** controls may need fail-closed. OMP's component-initiated capability fallback is **not** an automatic unsupported-kind-to-`rows` conversion in our SDK.
- The client build `0.8.3 (e2b8656)` advertised 45 kinds (= pinned 44 plus `media`), 10 terminal features (including `styles`, `scroll`, `flow`), 2 credits, and `cell=8×16` at the measured 400px-requested pane (`cols=47`). This describes that run, not other sizes/fonts/builds. `media` actually rendered with an observable missing-file negative control, though pinned SDK lacks its typed builder; no unrequested SDK upgrade follows.
- `Tab`+`Enter` on a real headless `html.button` returned those keys to the program and **did not produce** a button `action` in the tested scenario. Keyboard accessibility must be designed through the application's actual input path; don't assume native browser Tab behavior for all `el` nodes.
- Avoid fixed pane-pixel/typographic budgets as protocol truth. Prefer `caps.cols` for terminal columns and real client geometry for actual pixels. Preserve current business authority across normal wide↔narrow adaptations; component fallback and overflow are product decisions, not a reason to invent a second writer.

## 6. Evidence and qualification contract

| Tier | May prove | Must NOT be promoted to |
|---|---|---|
| SDK pin tests and production synthetic-tty tests | Current encoder/decoder, emitted frames, application semantic admission under scripted events | Real-client layout, font/caret/IME and physical mouse |
| OMP native `TspHarness` | **OMP's** emitted operations and its own reference-apply model | Pinned TypeScript SDK behavior or real Tern rendering |
| PiTui `@xterm/headless` tests | ANSI/PiTui behavior | TSP-native rendering |
| Real `tern serve` + `tern ctl` headless pane | Versioned client nodes, actual layout boxes, PNG, control-input events, capability replies | Physical window focus, OS/IME/real hardware interaction |
| Real physical GUI / owner attestation | Only the explicitly exercised physical behaviors and environment | Full cross-version/full-profile/Remote qualification |

A **claim** needs baseline, source/path/lines, consumer path, positive and negative evidence, remaining `UNKNOWN`, and a precise observation tier. Use test assertions as evidence of a tested proposition; do not infer tests were executed merely because they exist. A measured statement needs its run path (or manifest) and the client build; when that run kept an assertions ledger, record its `total/failed/informational`, and where no ledger exists for a probe, say so explicitly instead of inferring or inventing counts. `check` must be capable of failing; `measure` cannot replace acceptance. A node's rect alone cannot demonstrate visual nonclipping; look at ancestor clipping + actual PNG. `ctl` failures must fail closed; irreversible key/click/run input is **one-shot**, not retryable (see harness guide).

**Versioned client observations from 2026-10-13** are summarized under [Foundation evidence](./evidence/foundation-20261013.md); the later runtime-gap audit, PR #299 and upstream SDK issue #48 are recorded separately in [Runtime gap evidence](./evidence/runtime-gap-20261013.md). Raw run folders live under gitignored `temp/tern-pane-*` and worktrees, and **are not checked into this repository**. The evidence summary is a sourced record, not a guarantee that all raw artifacts will be independently available later. Do not claim physical GUI qualification from those artifacts.

## 7. Remaining unknowns and change gates

| Topic | Current state | Requirement before relying on it |
|---|---|---|
| `focus('layer')` actual caret/editor focus | UNKNOWN, headless positive controls invalid | Valid actual node IDs plus physical GUI/caret observation when this affects behavior |
| Old `select/activate/action` delivered after the drawing frame is replaced | UNKNOWN; no deterministic delayed-event probe | Currentness design/negative integration test for the proposed change; targeted client proof if material |
| Key change → client scroll/view-state reset | **MODEL CASE VERIFIED**: PR #301 42-row Tern 0.8.3 headless A/B/C/D probe measured remount/viewport movement from per-revision Picker key; stable per-panel key avoided it | Other component shapes/builds/fonts remain case-specific; repeat targeted real-client probe before generalizing |
| Unsupported / unadvertised kind behavior | Not applicable to 0.8.3 when source vocabulary ⊆ advertised kinds | Revisit only on a client where this condition is realizable; avoid phantom PASS |
| `scroll/reveal` Reader behavior | **MODEL `scroll` VERIFIED** for PR #301 Reader under Tern 0.8.3 headless, including per-reading epoch isolation; generic `reveal` and physical wheel remain **NOT_VERIFIED** | Carry over only to this exact Reader geometry/version; qualify other consumers independently |
| Queued stale Focus after blocked Frame coalescing (F3-001) | **CONFIRMED PROTOCOL DEFECT / OPEN / UPSTREAM_REPORTED**; Tern 0.8.3 headless returned `unknown id` | [SDK #48](https://github.com/stencil-hq/tern-sdk/issues/48); wait for a consumable upstream fix or material regression, then requalify; no local queue replacement |
| Client `error` diagnostic (F3-002) | **FIXED** by merged [PR #299](https://github.com/XMoon/dsh-pi-tui/pull/299) | Keep the protocol diagnostic; it is not a Focus retry or error-to-fatal policy |
| Close keep semantics after an initial failure (F3-003) | `RISK_UNPROVEN` — observed SDK `keep:false` / fallback `keep:true` divergence; residual screen effect not proven | Revisit if a real-client effect or upstream lifecycle delta appears |
| Missing ACK forever (U8; NOT a Finding ID) | **UNKNOWN** — normal Frame pump remains blocked without ACK | No speculative ACK watchdog; re-open only with material symptom/evidence |
| GUI/IME/fonts/wheel/Remote/full-profile | Outside headless run; historical per-PR evidence has its own version | Feature-specific test or explicit Owner limitation, not retroactive PASS |

**Required review trigger:** SDK pin/main changes, Tern build changes, a new surface owner, key identity, async event admission, modal precedence, read/write authority or capability fallback semantics. Re-check *production* sibling paths and business sink before changing a shared helper. Unrelated interesting OMP techniques do not justify new primitives.

## 8. Placement and maintenance

- Update **this file** when the renderer's cross-feature ownership, runtime, identity/event or capability foundation contract changes.
- Update [`../tern-tsp.md`](../tern-tsp.md) for actual implementation/status, only after code or qualification evidence changes.
- Update [`upstream-reference.md`](./upstream-reference.md) for reference version deltas and technique comparisons; do not copy OMP internals into this contract.
- Append versioned observations to [`evidence/`](./evidence/) without overwriting earlier PR records. Follow [`../tern-pane-harness.md`](../tern-pane-harness.md) for new client evidence.
- **Do not check the assistant's separate TSP Planning Protocol into this repository**: it governs planning technique; this file governs application architecture.
