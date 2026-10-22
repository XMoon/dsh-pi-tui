# TSP foundation: ownership, runtime and interaction contract

This is the contract for the experimental `dsh-pi-tui` TSP renderer. It is not a
normative TSP specification and does not claim that all physical-GUI paths are
qualified. Recheck it when the SDK pin, Tern build or production entrypoints
change.

Related: [TSP overview](./overview.md),
[model selection](./model-selection.md),
[preset selection](./preset-selection.md),
[session browser](./session-browser.md),
[real-pane harness](../guides/tern-pane-testing.md),
[application architecture](../architecture/overview.md),
[concurrency](../architecture/concurrency.md),
[failure model](../architecture/failure-model.md).

## 1. Meaning and precedence

The application, official TypeScript SDK, terminal client and official-product
precedent answer different questions:

| Layer | Authority / responsibility | Not sufficient evidence for |
|---|---|---|
| Accepted project product/architecture contract | Desired behavior, business ownership, supported workflow | What a closed-source terminal actually renders |
| Released TSP specification, **version-qualified** | Protocol vocabulary and intended operation semantics | The installed SDK implementing the latest text |
| **Installed pinned** `@stencil-hq/tern` | Encoders, event decoding, reconciliation, SDK frame and session mechanics | Client layout, pixel visibility, browser-style focus |
| `dsh-pi-tui` production entrypoints | Business-admission path, lifecycle/semantic owners, concrete emitted nodes | Terminal client implementing implied behavior |
| Tern client, exact build + observation tier | Negotiated capabilities, real headless layout/events/visible content under tested conditions | All builds, physical keyboard/IME, true end-to-end Host semantics |
| **Official-product reference** `can1357/oh-my-pi` | Demonstrated TSP component designs and independent runtime techniques | Normative SDK API, mandatory implementation or compatibility requirement |

Rules:

- Record an exact SHA/version and an exact `source → decision → sink` for
  load-bearing claims.
- Never treat SDK `main`, OMP's independent wire/backend or an online document
  as installed SDK semantics.
- Never promote an inference, an unknown, a single headless observation or a
  historical evidence record to a universal protocol guarantee.
- A package version string does not identify code: the upstream SDK `main`
  retained one version label across multiple source-changing commits. Compare
  installed source/integrity and the pinned commit, never the version label
  alone.

## 2. Production runtime chain and one-owner map

`DSH_PI_TUI_RENDERER=tsp` is opt-in; the default is PiTui.

```text
bootstrap.ts renderer-selection
 → connectTspRenderer → pinned SDK connect (before PiTui takes stdin)
 → mountTspRenderer → session.open({ mode: 'inline' })
 → SurfaceRuntime.start (installs presentation/composer/interaction ports)
 → bindRendererInput (one-time held-key replay)
 → SurfaceRuntime.repaintTarget → canonical projection
 → tsp/session.ts setTranscript / transcript-view / render
 → one surface.render({ main?, dock, layer })
 → SDK View.from / ops / frame queue / TSP wire / Tern

Tern input → SDK session iterator → tsp/session.ts routeInput
  ├─ keyboard → dispatchKey → current local intent / editor
  └─ native event → current modal/picker seat → semantic admission
      → existing submission, model/preset, or Question/Approval owner

teardown → seat.dispose → retire presentational panels
 → surface.close({ keep: false }) → session.close → renderer release
```

| Fact / operation | Existing authority / owner | Forbidden substitute |
|---|---|---|
| Durable DSH events, model/preset business writes, submission | Existing DSH/Host/Client commands and application submission controller | TSP UI state, selected row, preview, cached catalog |
| Transcript grouping, fold/window/currentness | Existing `TranscriptFolder`, `TranscriptWindowController`, `SurfaceRuntime` projection | A second TSP transcript state machine |
| Tool-result image content and bytes | The result's own structured content blocks, plus the existing attachment read port under the existing immutable display-subject scope | The flat result text, the tool name, the args, a path, a URL, or a second attachment cache |
| TSP connection and terminal input lifecycle | Composition bootstrap + mounted renderer + pinned SDK | A second direct stdin reader or ad-hoc wire pump |
| Surface regions and emitted node projection | `src/tui/tsp/session.ts` (one `surface.render`) | Independently mounted competing renderers |
| Modal seat/keyboard precedence | `src/tui/tsp/session.ts` + `interaction.ts` and its application owner | `modal:true` as an automatic JavaScript keyboard handler |
| UI highlight, draft, pending, local page | The current presenter for that UI | Durable business authority |
| SDK frame/ACK/current sent View | Installed SDK `Surface`/`Session` | A second application-side reconciler without a demonstrated gap |
| Terminal rendering, pixel clipping and scroll view state | Tern client | Node-tree text, TypeScript props, guessed pixels |

State-representation rule: authority, disposable projection, SDK transport
state and component-local draft may contain similar values without being
competing authorities. Classify consumers and lifetime before considering a
reduction; a search hit or "two variables" is not proof of entropy.

## 3. Surface, frame and lifecycle invariants

1. The renderer opens one inline SDK surface; `main`, `dock` and `layer` are SDK
   region names. There is exactly one `surface.render` call. `layer` is always
   provided; `main` waits for its initial projection; `dock` is provided by the
   renderer. Do not create a second surface/owner for one panel.
2. Live `layer` producers return a `ui.col` region root; overlays/pickers are
   children of that root. This is a verified project shape, not an SDK type law
   mandating `col` everywhere. A bare overlay as a region root does not acquire
   OMP-specific hoisting semantics in this SDK.
3. The SDK builds node IDs from region/key/child identity, compares sent Views
   and queues `f` frames; only the terminal acknowledges sent frames. It already
   implements diff, frame credit/coalescing, session iteration and close
   handling. Do not duplicate it.
4. `picker.suspend()/resume` in our renderer means local presenter seat state
   (revision/targets), not SDK `surface.suspend()/resume()`. SDK surface
   adoption is a separate lifecycle.
5. Owned resources are released in the existing order; failed steps are still
   attempted and failures surfaced. Startup null (`connect() === null`) follows
   the PiTui fallback; connect/mount throw uses the existing startup/fatal
   handling. No silent fallback after an acquired or failed ownership
   transition unless the production contract authorizes it.
6. ACK credits constrain sends. ACK is not business completion, visual
   acceptance, keyboard admission or a per-blob receipt. For business
   currentness use application identity/admission, never frame ACK.
7. The SDK owns frame credit/coalescing and queued focus operations. A queued
   Focus op delivered against a node from an unsent intermediate View is an
   SDK-boundary class, not a renderer bug: do not add an extra focus queue,
   frame reconciler, ACK watchdog or deferred-focus latch. Report it upstream
   and keep the SDK boundary intact. Treat one observed protocol rejection as
   evidence for that build, never as a universal user-visible defect claim.
8. ACK loss or blocked frame delivery is an SDK-boundary unknown. A blocked
   frame pump does not establish a practical deadlock or authorize a
   retry/watchdog. SDK `close()` can force a final flush; it is teardown, not a
   runtime delivery cure.

## 4. Node identity, event admission and focus

### Node identity and currentness

- `key` is sibling/node identity. In the pinned SDK, changing a key changes
  child IDs and can produce `del` + `add`; a per-frame key can therefore
  remount a client and move its viewport. Preserve panel/reading identity where
  continuity matters, and measure the actual client behavior before
  generalizing beyond the tested shape.
- Presenter-specific identity contracts differ. The Model presenter keeps the
  Picker/layer key stable for one panel (`panel.serial`), gives each new Reader
  reading a separate epoch, and revision-tokens mutating/read-operation action
  IDs (`apply#<rev>`, `retry#<rev>`); `close` remains untokened for dismissal.
  Preset identity must be checked against its own source and is not silently
  changed by Model evidence. Stable identity is allowed only with explicit
  currentness/admission proof; never copy OMP as a substitute.
- UI `action` includes `act`; `select`/`activate` include `id`/`item`. They do
  not carry a normative frame revision. Frame `ack` carries `s`; `error` may
  carry `s`. Therefore a revision in an action token is insufficient to cover
  every event type. Any key-stability proposal must prove its actual
  `sf/id/item/act` admission, current session/panel/phase/revision, pointer and
  keyboard paths, plus delayed input where reachable.
- The SDK handler dispatch and the application event iterator/targets are
  distinct routes, not blanket "two stale-event checks". The region root ID
  `layer` may recur in both maps. Observed no-target-for-`layer` clicks do not
  prove globally unreachable old-frame UI events.
- Never convert `select`, `activate` or keyboard navigation into a business
  write without the panel's single business-admission path. Pointer action does
  not need keyboard focus first; `focusedAction` limits the keyboard activation
  path.

### Three focus concepts

| Concept | Owner | What it means |
|---|---|---|
| Application keyboard focus / modal owner | Application `routeInput` + seat and presenter | Which intent may receive keys |
| Picker `focus:'list'/'preview'/...` | Picker props + client | Semantic Picker region focus |
| `surface.focus(id)` | SDK frame op + client | Focus request on an actual node ID; an unknown ID is rejected with an observable error |

`tone` is visual colour, `selected` is item highlight, `action.on` is
toggle/pressed state; none is a universal keyboard focus token. The client's
caret/editing effect for a region-root focus was not established; do not
classify that as a confirmed bug or confirmed correct caret behavior.

### Modal scope

The application must route modal keys and guard semantic actions according to
the active seat; `ui.overlay({modal:true})` alone does not implement input
arbitration. A client may intercept pointer clicks with a modal backdrop, but
that is not permission to skip currentness/ownership checks on every UI event
or later build.

## 5. Layout, native components and capability policy

- A `picker` is a terminal-owned data-first sheet. A picker `item` and a generic
  `item` have different field types and capabilities: native `facts`, `columns`,
  `chips`, badges/mark/mono/tooltip are not universally available after
  replacing `picker` with generic `list/item`.
- Each selectable entity normally occupies one Picker Item, with identity in the
  label and structured attributes in fields; prose and complete reading use a
  suitable text (`wrap:'word'`), `md` or explicit Detail region. This is an OMP
  design precedent, not a protocol ban on long labels.
- `preview:'side'|'below'|'none'` is a layout hint, not a guaranteed visible
  place. Key information/action needs another reachable path when a supported
  layout hides Preview. Do not infer visibility from a DOM/tree string; qualify
  clipping with ancestor geometry and PNG.
- Distinguish native `list/picker.selected` (selected-item behavior), `scroll`
  (supported feature with a scroller owner) and `reveal` (addressed
  node/placement). They are not interchangeable. Generic `reveal` and physical
  wheel/trackpad remain unverified unless a specific run proves them.
- Features/kinds are negotiated at runtime, never inferred from package
  declarations, widths or version labels. SDK calls do not universally guard
  optional features. Read-only components may degrade to an explicitly verified
  simpler composition; write-critical controls may need fail-closed. OMP's
  component-initiated capability fallback is not an automatic unsupported-kind
  conversion in this SDK.
- A client build's advertised kinds/features/credits/cell size describe that
  run, not other sizes/fonts/builds.
- Do not assume native browser Tab/Enter behavior for `el` nodes. Design
  keyboard accessibility through the application's actual input path.
- Avoid fixed pane-pixel/typographic budgets as protocol truth. Prefer
  `caps.cols` for terminal columns and real client geometry for pixels. Preserve
  business authority across wide↔narrow adaptation; component fallback/overflow
  is a product decision, not a reason to invent a second writer.

### Tool-result image projection

A tool result that carries structured image content is projected inside its
existing tool card, in the result's own block order: the text blocks stay text,
and each image block becomes an identity line plus — when the pane negotiated
the `image` kind and the `blobs` feature — one native image node. The flat
result text is not drawn again beside the block-wise result, and the tool card's
own args, status, target and children are unchanged.

- The authority for WHICH attachment a row shows is the result's own content
  blocks. The tool name, the args, the flat result text and the rendered text
  never imply an image.
- The authority for reading the bytes is unchanged: the existing attachment
  read port, under the existing immutable display-subject scope. The projection
  adds no attachment cache, no read port, no permission check and no
  session-scoped state of its own.
- The renderer emits at most one blob per attachment through the official SDK
  session. The single-blob size limit is the SDK's own limit and is checked
  against the READY bytes, before anything is sent; the reference's own byte
  count is identity, never a send permit.
- The identity line is presentation, not authority. It names the attachment and
  states only the outcome the application actually knows (still loading, read
  failed, too large, unavailable for this subject). A decode failure inside the
  client is not an application fact and is never claimed as one.
- Sizing, zoom and click behaviour belong to the client. The projection sets no
  size props, adds no zoom control and no image page; the client's own layout —
  including any clipping or whitespace — is a client behaviour to be measured,
  not a promise.
- The image path is presentation-only: it adds no write, no new command and no
  new user action.

## 6. Evidence tiers and qualification

| Tier | May prove | Must NOT be promoted to |
|---|---|---|
| `TYPE_ONLY` | Types/contract shape | Emitted frames or client behavior |
| `SDK_SCRIPTED` / pin tests + production synthetic-tty tests | Current encoder/decoder, emitted frames, application semantic admission under scripted events | Real-client layout, font/caret/IME and physical mouse |
| `REAL_TERN_HEADLESS` (`tern serve` + `tern ctl`) | Versioned client nodes, actual layout boxes, PNG, control-input events, capability replies | Physical window focus, OS/IME, real hardware or GUI |
| `REAL_TERN_GUI` / owner attestation | Only the explicitly exercised physical behaviors and environment | Full cross-version/full-profile/Remote qualification |

`L1-L6` is a separate composition-depth axis (semantic port → Direct adapter →
Remote adapter → parity → official wire → application composition); it does not
map onto the observation tiers. A claim needs a baseline, source path/lines,
consumer path, positive and negative evidence, remaining unknowns and a precise
tier. Tests are evidence of a tested proposition; do not infer they ran because
they exist. A measured statement needs its run path/manifest and client build; a
probe without an assertions ledger says so instead of inventing counts. `check`
must be able to fail; `measure` cannot replace acceptance. A node's rect alone
does not prove visual non-clipping; use ancestor clipping plus an actual PNG.
`ctl` failures fail closed; irreversible key/click/run input is one-shot and
never retried.

A durable-image path carries TWO independent obligations: the composition-depth
proof that the bytes were read through the real read authority under the real
scope, and the observation-tier proof that the client painted them. A painted
bitmap does not prove the authorization, and a green read does not prove the
paint; neither one closes the other.

Never write PASS for `NOT_APPLICABLE`, `NOT_VERIFIED`, `GUI_BLOCKED` or an
Owner-accepted limitation. Do not promote a single headless observation to a
universal/version-independent claim; a tier qualifies a claim, not a repository.

## 7. Reusable protocol and interaction contracts

- **SDK wire/event model.** `SessionInput` has exactly two arms (`key`, `event`);
  pointer gestures arrive as `action`/`select`/`activate`/`change`/`focus`.
  `ack` is consumed by the SDK and never yielded; a node handler consumes its
  event, and an unhandled event falls through as `SessionInput{event}`. A node
  has no id until a surface reconciles it (`parentId + "." + (props.key ??
  childIndex)`). `focus` is write-only from the program's perspective; only
  inbound focus events inform it.
- **Rendered ≠ actionable.** A node with no `actions`/handler produces no
  `action`/`select`/`activate`/`change`. "Tern can draw it" is not "it is
  clickable". A real headless `overlay{modal:true}` masks pointer actions, not
  the keyboard; application-side modal-first routing remains the key authority.
  SDK props/`onClick` prove intent, not a painted button.
- **Business commit vs ACK.** `select` browses, `activate`/Enter opens the
  event's own row/page, and only the explicit focused enabled primary action
  writes — exactly once. A frame ACK is not business completion, visual
  acceptance, keyboard admission or a receipt. `agents.resume`/a lifecycle sink
  is a witness, not commit proof; the authoritative reread plus the current row
  establish the committed owner.
- **Interaction seat.** One FIFO of official Approval/Question requests, one
  modal overlay at a time, modal-first keys. `layer` is submitted on every
  frame; focus is re-issued whenever the desired seat changes, not latched.
  `focus`/`edit`/`undo`/`send` are consumed while a modal owns the seat. The
  official settled projection is authoritative (an empty batch is a real
  outcome); a malformed payload is refused with a visible notice and the flow's
  cancellation error, never a fabricated answer. Masked plaintext must be
  absent from the whole wire. Cold continued Questions stay parked. A
  tentative Session opening is not an owner replacement, but a published B must
  never leave A's modal owning presentation/input.
- **Narrow/Preview/reachability.** `preview` is a layout hint; key info and
  every action need another reachable path. Reachability, not a pixel promise.
  Measured constants are parameters of the verified environment; never lower a
  fixed count to paper over a layout problem. On a short pane, containment means
  the list region plus its first row, with the rest reachable by the list's own
  line keys; a clipped span is a measurement, not a contained node.
- **Real copy/buttons/Back.** Footer painted order is the client's pack rule
  (non-primary left in array order, `primary` right) — assert it against the
  client tree, not the wire. A disabled
  entry is `off` opacity plus a tooltip/title reason; the client paints no
  in-place reason text, so the reason also rides a detail fact. A stylesheet
  cannot paint border/background on an `el` button, and native button
  activation is not assumed. The way back is a native `ui.row({onClick})` navigation row at the top
  of the reading body, with an Esc twin; at the tail, Esc must stay bound to
  back. OSC52 emission into the Tern tty is not an OS-clipboard proof; the agent
  lane may not claim `CLIPBOARD_CHANGED`, and the OS half is Owner-attested.
- **Command admission/ownership.** Command provenance is enumerated from the
  ONE registration seam, never file names or a completion union. A genuine Host
  same-name command keeps its route; a refused TSP builtin restores the draft
  and creates no Session/process/history row; an argued line on an execute-kind
  Host descriptor is ordinary submission. Notification has one owner: the
  Direct command-result card carries the text, the card-less Client-registry
  branch publishes an error exactly once, and the owner is frozen at dispatch.
- **Upstream defects ≠ universal facts.** An upstream defect observed on one
  build is not a fact about the current pin's universal behavior. Do not patch the
  SDK boundary in the renderer, add a local focus queue/frame reconciler/ACK
  watchdog/deferred-focus latch or automatic retries. Re-open on upstream/client
  changes or a material real symptom.

## 8. Proof obligations and change gates

The following classes are not established by this durable contract. Each
requires the named evidence before a claim:

| Class | Evidence required before claiming |
|---|---|
| Caret/editor focus on a region-root ID | Valid node IDs plus physical/caret observation; a protocol ACK or a node rect is not enough |
| Delayed `select`/`activate`/`action` after the drawing frame is replaced | A deterministic currentness probe or negative integration test; targeted client proof if material |
| Key change → client scroll/view-state reset | A targeted probe for the exact component shape/build; do not generalize from another shape |
| Unsupported/unadvertised kind behavior | A client where the source vocabulary actually exceeds advertised kinds; avoid phantom PASS |
| Generic `reveal`, physical wheel or trackpad | A run that exercises that exact consumer geometry/build |
| Queued stale Focus after blocked frame coalescing | An upstream fix or a material regression reproduced through the real path; no local queue replacement |
| Client `error` diagnostics | Keep them diagnostic; prove any retry/fatal policy separately before adding it |
| Close keep semantics after an initial failure | A real-client effect or upstream lifecycle change; do not claim residue from protocol shape alone |
| Missing ACK forever | Material symptom/evidence; no speculative ACK watchdog |
| Durable image bytes reaching a client | A real authorized read under the real display-subject scope, plus a client observation of the painted node; the two obligations are separate |
| Client-side image zoom, click, keyboard and scroll-back | An observation on the exact client build; a class name or a rendered node is not an interaction proof |
| GUI/IME/fonts/wheel/Remote/full-profile | A feature-specific test or an explicit Owner limitation; never retroactive PASS |

Required review trigger: SDK pin/main changes, Tern build changes, a new surface
owner, key identity, async event admission, modal precedence, read/write
authority or capability fallback semantics. Re-check production sibling paths
and the business sink before changing a shared helper. Unrelated interesting OMP
techniques do not justify new primitives.

## 9. Placement and maintenance

- Update this file when the renderer's cross-feature ownership, runtime,
  identity/event or capability foundation contract changes.
- Update [overview.md](./overview.md) when the implementation entry points or
  product boundary change.
- Do not copy OMP internals into this contract. Reference deltas belong in the
  investigation/PR record, not here.
- Real-pane evidence belongs in the PR/CI record and the reusable procedure in
  [../guides/tern-pane-testing.md](../guides/tern-pane-testing.md); do not commit
  dated evidence ledgers under `docs/`.
- Do not check a separate TSP planning protocol into this repository: it governs
  planning technique; this file governs application architecture.
