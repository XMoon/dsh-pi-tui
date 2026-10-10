# PR4-0 evidence — pinned SDK 0.1.0 vs real Tern 0.7.0: type → wire → GUI

Part of the [PR4-0 capability audit](./pr4-0.md). This document records what the
**pinned, installed** `@stencil-hq/tern@0.1.0` can express, what a **real Tern
0.7.0** pane actually produces, and which layer a claim belongs to. It is a
snapshot measurement, not a product capability statement.

Evidence tiers used here (hard boundaries — never merge them):

| Tier | Meaning in this document |
|---|---|
| `TYPE_ONLY` | read from the installed package's shipped `.d.ts` / source; no execution |
| `SDK_SCRIPTED` | the shipped SDK driven over a scripted tty (the repository's test fixture family) |
| `REAL_TERN_HEADLESS` | the shipped SDK inside a real `tern serve` pane (real Tern binary, software-rendered, no display), driven by `tern ctl` |
| `REAL_TERN_GUI` | a user-visible Tern window with a physical pointer/IME/clipboard — **not obtained here** |

`L1–L6` are a **different axis** (application composition depth) and do not map
onto these tiers. A `REAL_TERN_HEADLESS` result is *not* a GUI result.

Pinned source references are `path:line` against the baseline commit; the
decisive sinks also carry an immutable permalink
(`https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/…`).

---

## 1. The pinned package

| Fact | Value |
|---|---|
| Package | `@stencil-hq/tern@0.1.0` (runtime `dependencies` of the bundle) |
| Types entry | `node_modules/@stencil-hq/tern/dist/index.d.ts` (`exports["."].types`) |
| Real pane used | `tern 0.7.0 (9ca00e4)` — `tern serve` headless session |
| Handshake seen | `term: "tern"`, `ver: "0.7.0"`, `cols: 160`, `credits: 2` |
| Terminal features advertised by the pane | `blobs, settle, adopt, dock, program-palette, reduce-motion, aside, scroll, styles, flow` |

`TYPE_ONLY`: the package ships both `dist/*.js` + `dist/*.d.ts` and the
TypeScript `src/*.ts`; the type declarations and the implementation agree.

## 2. `SessionInput` — exactly two variants

`SessionInput` (types: `dist/session.d.ts:60-67`) has **two** arms:

| Variant | Fields |
|---|---|
| `key` | `{ type: 'key'; key: Key }` |
| `event` | `{ type: 'event'; event: TspEvent }` |

There is **no** `pointer` / `focus` / `action` / `select` / `change` / `edit` /
`resize` / `ack` SessionInput variant. Those are `TspEvent` variants **carried
inside the single `event` arm**. Any statement of the form "the TSP renderer
must handle the `<x>` SessionInput" is a category error; the real question is
which `TspEvent` variants a real pane produces and how the program routes them.

`Key` (`dist/keys.d.ts:4-14`): `{ name: KeyName; text?: string; ctrl; alt;
shift; meta }`.

## 3. `TspEvent` — the 17 wire event variants

`TspEvent` is `dist/wire.d.ts:342`; every member is decoded by `decodeEvent`
(`src/wire.ts:667-775`).

| `ev` | Payload fields (besides `raw`) | Kind |
|---|---|---|
| `ack` | `sf`, `s` | frame credit — consumed by the SDK, **never yielded** |
| `resize` | `sf?`, `cols`, `cell?`, `visible?` | environment |
| `theme` | `dark` | environment |
| `motion` | `reduce` | environment |
| `visible` | `sf?`, `visible` | environment |
| `toggle` | `sf`, `id`, `collapsed`, `key?` | **user** (fold/unfold) |
| `select` | `sf`, `id`, `item`, `values?` | **user** |
| `activate` | `sf`, `id`, `item`, `values?` | **user** |
| `action` | `sf`, `id`, `act`, `value?`, `mods?`, `values?` | **user** (this is where a pointer click lands) |
| `change` | `sf`, `id`, `value?`, `checked?`, `name?`, `item?`, `values?` | **user** |
| `focus` | `sf`, `id` | **user** (caret claim — fires even without a handler) |
| `edit` | `sf`, `id`, `from`, `to`, `text`, `cursor`, `len` | native edit — **feature-gated** (`PROGRAM_FEATURES`) |
| `undo` | `sf`, `id` | native edit — feature-gated |
| `send` | `sf`, `id`, `text` | native send — feature-gated |
| `error` | `sf?`, `s?`, `op?`, `sheet?`, `id?`, `msg` | terminal rejection |
| `gone` | `sf?`, `ids` | surface dropped |
| `unknown` | `sf?` | SDK fallback for an unknown/malformed body |

There is **no** `pointer` event: pointer gestures arrive as `action` (with
`act` / `mods` / `value`) or as `select` / `activate` / `change` / `focus`.

`PROGRAM_FEATURES = ['edit','undo','send']` (`dist/wire.d.ts:20`) are announced
by the program in its `hello`; the current renderer announces none
(`src/tui/tsp/session.ts:203-206`, permalink below §5).

## 4. Node handlers and id derivation

`Handlers` (`dist/nodes.d.ts:10-27`) declares **12** handler props and is mixed
into **every** kind's props, so interaction is not per-kind — it is per
**reconciled node id + event `ev`**:

`onClick` (`:12`) · `onDblClick` (`:14`) · `onMenu` (`:16`) · `onAction` (`:18`) ·
`onToggle` (`:19`) · `onSelect` (`:20`) · `onActivate` (`:21`) · `onChange`
(`:22`) · `onFocus` (`:23`) · `onEdit` (`:24`) · `onUndo` (`:25`) · `onSend`
(`:26`). There is no `onInput`, no `onSubmit`, no `onKey`, no `onPointer`, no
`onResize` and no DOM event object.

- A node has **no id until a surface reconciles it**; the id derives from
  `parentId + "." + (props.key ?? childIndex)` (`src/reconcile.ts:44-51`).
- `onClick` sets `actions.click = 'click'` unless named; `onAction` maps
  `action.act` names; a handler is looked up as
  `latest.find(event.id)?.node.handlers` (`src/surface.ts:226-229`).
- Delivery gating (`src/session.ts:527-561`): `ack` is consumed; an event whose
  node has a handler is **consumed** by that handler (except an `action` listed
  in `surface.forwardActions`); an event with **no** handler falls through to
  the async iterator as `SessionInput{type:'event'}`.
- **Focus is write-only.** `surface.focus(id|null)` exists; there is no
  focus-read API on `Session`/`Surface`. A program learns focus only from
  inbound `focus` events.

Vocabulary: 44 kinds (`KINDS`, `dist/wire.d.ts:10`); 43 have a `ui.<kind>`
builder / JSX intrinsic — the vocabulary kind `block` has none.

## 5. Real-Tern 0.7.0 headless probe — positive results

**Method (fully reproducible from this document):** the six probe programs are
retained verbatim in [Appendix A](#appendix-a--probe-sources), and the exact run
commands, exit statuses and fixture manifest are in
[Appendix B](#appendix-b--run-record-fixture-manifest-and-digests). They are
`import`-only consumers of the shipped SDK and render synthetic content.

**Positive (`REAL_TERN_HEADLESS`)** — a real Tern 0.7.0 pane produces these for
real pointer/native gestures:

| Node kind built | Gesture | Event produced | Routed to |
|---|---|---|---|
| `html.button` + `onClick` | click | `action{act:'click'}` | the node handler |
| `ui.card` + `onClick` | click on the card head | `action{act:'click'}` (resolved to the ancestor that declares the action) | the node handler |
| `ui.card{collapsible}` (no handler) | click the chevron | `toggle{collapsed:true, key}` | **yielded** as `SessionInput{type:'event'}` |
| `ui.list`/`ui.item` | click / double click | `select{item}` then `activate{item}` | the list handler (yielded when none) |
| `ui.editor` / `ui.input` | click | `focus{id}` | the node handler (yielded when none) |
| `html.input{type:'checkbox'}` | click | `change{name,value:'on',checked:true}` | the node handler (yielded when none) |
| `ui.card` / `ui.tool` / `ui.badge` / `html.button` with `actions.click` and **no** handler | click | `action{act:<name>}` | **yielded** |
| plain `ui.text` (no `actions`, no handler) | click | *(nothing — no hit target)* | — |

Probe 2 (no handlers anywhere, `actions` only) yielded exactly:
`select`, `activate`, `focus`, `change`, `action` as
`SessionInput{type:'event'}` — the delivery shape the `dsh-pi-tui` renderer
receives, because it declares no node handler.

**Hit targets in the CURRENT `dsh-pi-tui` view (precise statement).** The
renderer builds only `col`/`text`/`md`/`code`/`card`/`badge`/`tool`/`section`/
`overlay`/`editor`/`input` nodes and declares **no** `actions`, **no**
`collapsible` and **no** SDK handler prop anywhere (`grep` for the 12 handler
props and for `collapsible` across `src/tui/tsp/**` finds only the composer's
own local `onChanged` sink, which is not an SDK handler). Therefore:

- the **only** elements Tern treats as pointer targets are the two focusable
  fields it renders — the composer `ui.editor` (`src/tui/tsp/session.ts:437-444`)
  and the modal free-text `ui.input` (`src/tui/tsp/interaction.ts:1070`) — and a
  click on them yields a `focus` event, which `routeInput` drops outside a modal
  (`src/tui/tsp/session.ts:713-721`) or turns into a focus re-assertion inside
  one;
- `action` / `select` / `activate` / `change` **cannot be produced by the
  current view at all**, because no node declares the action they address.

So the precise claim is "focus-only composer hit target; no actionable business
nodes", not "no pointer hit target".

## 6. Real-Tern headless probe — decisive negatives

1. **Native editor `edit`/`undo`/`send` were NOT produced.** Probe 5 announced
   `features:['edit','undo','send']` and rendered a `ui.editor{sendable:true}`;
   clicking it produced `focus`, and typed characters/Backspace/Enter arrived as
   raw `key` inputs (`h,e,l,l,o,backspace,enter`) — **no `edit`, `undo` or
   `send` event**. This is `REAL_TERN_HEADLESS` only: native editing may still
   require the GUI/IME path, so this is recorded as `GUI_BLOCKED`, not as
   "unsupported". It does mean the current app-controlled composer is the
   approach that is *proven* to work at this tier.
2. **A real `overlay{modal:true}` DOES intercept background pointer actions.**
   Probe 6 placed a clickable button behind a `modal:true` overlay: clicking the
   background coordinate produced **no** `action`; only the overlay's own button
   fired. The app-side modal-first key route remains the authority for keys (the
   SDK's `modal` masks the picture, not the keyboard).
3. **A node with no `actions` and no handler produces no `action`/`select`/
   `activate`/`change`** (a plain `ui.text` click produced nothing) — "Tern can
   draw it" is not "it is clickable". The exception is `focus`: clicking a
   focusable field emits `focus` regardless of handlers.
4. **Node ids are not generation-fenced by the SDK.** `dispatch` looks the id up
   in the *latest* rendered view; an id reused by a different logical node in a
   later frame would dispatch to the new node's handler. The renderer's existing
   epoch-prefixed transcript keys (`s<n>-…`, `src/tui/tsp/session.ts:468-476`)
   are what prevent cross-subject id reuse — a foundation PR4 must keep.

**Observation with no confirmed cause (recorded, not promoted to a finding):**
in probe 2 the *first* click after the surface replaced a previous program's
surface produced no `action` for a card that had `actions.click`; the identical
shape (`{click, menu}`) reproduced correctly in probe 4, so it is attributed to
surface-adoption/settle timing rather than to the prop combination. No product
behaviour is inferred from it.

## 7. node-kind × event-kind × tier

| node kind | constructible | wire-encodable action | real pane emits (headless) | GUI |
|---|---|---|---|---|
| `text`/`md`/`code`/`badge`/`card`/`section`/`tool`/… | yes | only with `actions`/handler | `action` with `actions`; `toggle` when collapsible; `focus` when focusable | `GUI_BLOCKED` for physical pointer/IME |
| `list`/`item` | yes | `onSelect`/`onActivate` | yes | `GUI_BLOCKED` |
| `el`/`html.*` controls (button/input/checkbox) | yes | `onClick`/`onChange`/`onFocus` | yes | `GUI_BLOCKED` |
| `editor`/`input` | yes | `onFocus`/`onEdit`/`onUndo`/`onSend` | `focus` yes; `edit`/`undo`/`send` **not observed** | `GUI_BLOCKED` |
| `overlay{modal}` | yes | own children only | intercepts background pointer; background events suppressed | `GUI_BLOCKED` |
| `picker`/`prefs`/`tabs`/`table`/`tree`/`image`/`chart`/… | yes | `Handlers` apply | not exercised in this audit | `GUI_BLOCKED` |

## 8. What this means for PR4 (facts, not a plan)

- A non-key `SessionInput{type:'event'}` **is reachable today** and is currently
  dropped: `routeInput` forwards it only to the modal seat, which returns `false`
  unless a modal is open (`src/tui/tsp/session.ts:713-721`,
  `src/tui/tsp/interaction.ts:1264-1271`). The audit matrix marks every
  non-modal native action `NOT_REACHABLE` with that exact drop sink.
- Building a clickable node requires **declaring an action/handler and owning
  the id→intent mapping**; the renderer declares none today, so the current view
  has no actionable node. `rendered` ≠ `actionable`.
- The pinned SDK offers no focus-read; any future click/focus UX must track
  inbound `focus` itself, or re-issue `surface.focus(...)` from its own state
  (which the renderer already does for the composer seat).
- Native editing at the GUI/IME tier is unproven; PR4C must not claim it from a
  headless or `tern ctl type` observation.

## Appendix A — probe sources

These are the exact programs that produced Appendix B's logs. They are
**disposable evidence**, not product code: nothing in `src/**` imports them, and
they must not be committed as a permanent service. `probe2`'s header comment was
corrected after review (it matches "no handler", not the renderer's real node
tree).

### A.1 `pr4-0-sdk-event-probe.mjs` (with handlers)

```js
/**
 * PR4-0 disposable probe (NOT part of the product): does the PINNED
 * `@stencil-hq/tern@0.1.0` + real Tern produce interactive SessionInput
 * events, and how are they routed?
 *
 * Run inside a real (headless) Tern pane. Writes a JSONL log; every line is
 * sanitized (no transcript, no credentials — synthetic strings only).
 */
import { appendFileSync } from 'node:fs'
import { connect, html, ui } from '@stencil-hq/tern'

const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe.jsonl'
const log = (record) => appendFileSync(LOG, JSON.stringify(record) + '\n')

/** A sanitized view of one TSP event (never the raw payload). */
const shape = (event) => {
  const out = { ev: event.ev }
  for (const field of ['sf', 'id', 'act', 'item', 'name', 'value', 'checked', 'collapsed', 'key', 'from', 'to', 'cursor', 'len', 'visible', 'dark', 'reduce', 'cols', 's', 'msg']) {
    if (event[field] !== undefined) out[field] = event[field]
  }
  if (typeof event.text === 'string') out.textLen = event.text.length
  if (event.mods !== undefined) out.mods = event.mods
  return out
}

const session = await connect({ app: 'pr40-probe' })
if (session === null) {
  log({ phase: 'connect', result: 'null' })
  process.exit(2)
}
log({ phase: 'hello', term: session.caps.term, ver: session.caps.ver, cols: session.caps.cols, credits: session.caps.credits, features: session.caps.features })

const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe', listen: true })

const handler = (label) => (event) => { log({ phase: 'handler', handler: label, event: shape(event) }) }

const view = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'PR4-0 probe' }),
  html.button({ key: 'btn', onClick: handler('button.onClick') }, 'Button A'),
  ui.card({ key: 'card-click', head: 'Clickable card', onClick: handler('card.onClick') },
    ui.text({ key: 'card-body', text: 'card body' })),
  ui.card({ key: 'card-fold', head: 'Folding card', collapsible: true },
    ui.text({ key: 'fold-body', text: 'fold body' })),
  ui.list({ key: 'thelist', onSelect: handler('list.onSelect'), onActivate: handler('list.onActivate') },
    ui.item({ key: 'i1', label: 'Item one' }),
    ui.item({ key: 'i2', label: 'Item two' })),
  ui.editor({ key: 'ed', text: 'editor text', cursor: 5, onFocus: handler('editor.onFocus'), onEdit: handler('editor.onEdit'), onSend: handler('editor.onSend') }),
  ui.input({ key: 'inp', text: 'input text', cursor: 3, onFocus: handler('input.onFocus'), onEdit: handler('input.onEdit') }),
  html.input({ key: 'chk', type: 'checkbox', name: 'chk1', onChange: handler('checkbox.onChange') }),
  ui.text({ key: 'plain', text: 'plain non-interactive row' }),
)

surface.render({ main: view })
log({ phase: 'rendered', seq: surface.seq })

const seen = new Map()
let total = 0
for await (const input of session) {
  if (input.type === 'key') {
    log({ phase: 'yield-key', key: { name: input.key.name, ctrl: input.key.ctrl === true, alt: input.key.alt === true, shift: input.key.shift === true, textLen: typeof input.key.text === 'string' ? input.key.text.length : 0 } })
  } else {
    const s = shape(input.event)
    const bucket = `${s.ev}:${s.id ?? ''}`
    seen.set(bucket, (seen.get(bucket) ?? 0) + 1)
    log({ phase: 'yield-event', event: s, count: seen.get(bucket) })
    if (input.event.ev === 'gone') break
  }
  total += 1
  if (total > 500) break
}
log({ phase: 'summary', seen: [...seen.entries()] })
await surface.close({ keep: false })
await session.close()
log({ phase: 'closed' })
process.exit(0)
```

### A.2 `pr4-0-sdk-event-probe2.mjs` (NO handler — the delivery shape)

```js
/**
 * PR4-0 disposable probe variant 2 (NOT part of the product): the
 * NO-HANDLER case — nodes declare `actions` (so Tern still makes them hit
 * targets) but carry no handler, so the SDK must yield the event to the async
 * loop. This is the DELIVERY shape the dsh-pi-tui TSP renderer would receive;
 * it is NOT the renderer's real node/action tree, which declares no `actions`
 * at all.
 */
import { appendFileSync } from 'node:fs'
import { connect, html, ui } from '@stencil-hq/tern'

const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe2.jsonl'
const log = (record) => appendFileSync(LOG, JSON.stringify(record) + '\n')

const shape = (event) => {
  const out = { ev: event.ev }
  for (const field of ['sf', 'id', 'act', 'item', 'name', 'value', 'checked', 'collapsed', 'key', 'from', 'to', 'cursor', 'len', 'visible', 'dark', 'reduce', 'cols', 's', 'msg']) {
    if (event[field] !== undefined) out[field] = event[field]
  }
  if (typeof event.text === 'string') out.textLen = event.text.length
  if (event.mods !== undefined) out.mods = event.mods
  return out
}

const session = await connect({ app: 'pr40-probe2' })
if (session === null) { log({ phase: 'connect', result: 'null' }); process.exit(2) }
log({ phase: 'hello', term: session.caps.term, ver: session.caps.ver, cols: session.caps.cols, credits: session.caps.credits, features: session.caps.features })

const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe2', listen: true })

const view = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'PR4-0 probe2 (no handlers)' }),
  ui.card({ key: 'card-act', head: 'Action card', actions: { click: 'open', menu: ['menu-a'] } },
    ui.text({ key: 'card-body', text: 'card body' })),
  ui.list({ key: 'thelist', actions: { click: 'row-click' } },
    ui.item({ key: 'i1', label: 'Item one' }),
    ui.item({ key: 'i2', label: 'Item two' })),
  ui.editor({ key: 'ed', text: 'editor text', cursor: 5 }),
  ui.input({ key: 'inp', text: 'input text', cursor: 3 }),
  html.input({ key: 'chk', type: 'checkbox', name: 'chk1' }),
  html.button({ key: 'btn', actions: { click: 'press' } }, 'Button A'),
)
surface.render({ main: view })
log({ phase: 'rendered', seq: surface.seq })

const seen = new Map()
let total = 0
for await (const input of session) {
  if (input.type === 'key') {
    log({ phase: 'yield-key', key: { name: input.key.name, ctrl: input.key.ctrl === true, alt: input.key.alt === true, shift: input.key.shift === true, textLen: typeof input.key.text === 'string' ? input.key.text.length : 0 } })
  } else {
    const s = shape(input.event)
    const bucket = `${s.ev}:${s.id ?? ''}`
    seen.set(bucket, (seen.get(bucket) ?? 0) + 1)
    log({ phase: 'yield-event', event: s, count: seen.get(bucket) })
    if (input.event.ev === 'gone') break
  }
  total += 1
  if (total > 500) break
}
log({ phase: 'summary', seen: [...seen.entries()] })
await surface.close({ keep: false })
await session.close()
log({ phase: 'closed' })
process.exit(0)
```

### A.3 `pr4-0-sdk-event-probe3.mjs` (per-kind action arming)

```js
/** PR4-0 probe 3: per-node-kind action/emit characterization (disposable). */
import { appendFileSync } from 'node:fs'
import { connect, html, ui } from '@stencil-hq/tern'
const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe3.jsonl'
const log = (r) => appendFileSync(LOG, JSON.stringify(r) + '\n')
const shape = (e) => { const o = { ev: e.ev }; for (const f of ['sf','id','act','item','name','value','checked','collapsed','key']) if (e[f] !== undefined) o[f] = e[f]; return o }
const session = await connect({ app: 'pr40-probe3' })
if (session === null) { log({ phase: 'connect', result: 'null' }); process.exit(2) }
const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe3', listen: true })
const view = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'probe3' }),
  ui.card({ key: 'c-plain', head: 'Card plain actions', actions: { click: 'c1' } }, ui.text({ key: 'b1', text: 'x' })),
  ui.card({ key: 'c-menu', head: 'Card menu only', actions: { menu: ['m1'] } }, ui.text({ key: 'b2', text: 'x' })),
  ui.card({ key: 'c-click-name', head: 'Card act click', actions: { click: 'click' } }, ui.text({ key: 'b3', text: 'x' })),
  ui.tool({ key: 't1', name: 'bash', title: 'Tool', actions: { click: 't1c' } }, ui.text({ key: 'b4', text: 'x' })),
  html.button({ key: 'btn', actions: { click: 'press' } }, 'Button'),
  ui.badge({ key: 'bdg', text: 'Badge', actions: { click: 'b1c' } }),
)
surface.render({ main: view })
log({ phase: 'rendered', seq: surface.seq })
let n = 0
for await (const input of session) {
  if (input.type === 'event') { log({ phase: 'yield-event', event: shape(input.event) }); if (input.event.ev === 'gone') break }
  if (++n > 300) break
}
await surface.close({ keep: false }); await session.close(); log({ phase: 'closed' }); process.exit(0)
```

### A.4 `pr4-0-sdk-event-probe4.mjs` (click + menu combination)

```js
/** PR4-0 probe 4: does a `menu` entry suppress a card's click action? (disposable) */
import { appendFileSync } from 'node:fs'
import { connect, html, ui } from '@stencil-hq/tern'
const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe4.jsonl'
const log = (r) => appendFileSync(LOG, JSON.stringify(r) + '\n')
const shape = (e) => { const o = { ev: e.ev }; for (const f of ['id','act','item']) if (e[f] !== undefined) o[f] = e[f]; return o }
const session = await connect({ app: 'pr40-probe4' })
if (session === null) { log({ phase: 'connect', result: 'null' }); process.exit(2) }
const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe4', listen: true })
const view = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'probe4' }),
  ui.card({ key: 'a-click', head: 'A click', actions: { click: 'a' } }, ui.text({ key: 'a1', text: 'x' })),
  ui.card({ key: 'b-click-menu', head: 'B click menu', actions: { click: 'b', menu: ['m'] } }, ui.text({ key: 'b1', text: 'x' })),
  ui.card({ key: 'c-menu-click', head: 'C menu click', actions: { menu: ['m'], click: 'c' } }, ui.text({ key: 'c1', text: 'x' })),
  html.button({ key: 'd-click-menu', actions: { click: 'd', menu: ['m'] } }, 'D click menu'),
)
surface.render({ main: view })
log({ phase: 'rendered', seq: surface.seq })
let n = 0
for await (const input of session) {
  if (input.type === 'event') { log({ phase: 'yield-event', event: shape(input.event) }); if (input.event.ev === 'gone') break }
  if (++n > 200) break
}
await surface.close({ keep: false }); await session.close(); log({ phase: 'closed' }); process.exit(0)
```

### A.5 `pr4-0-sdk-event-probe5.mjs` (native editor features)

```js
/** PR4-0 probe 5: native editor features (edit/undo/send) — advertised vs not (disposable). */
import { appendFileSync } from 'node:fs'
import { connect, ui } from '@stencil-hq/tern'
const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe5.jsonl'
const log = (r) => appendFileSync(LOG, JSON.stringify(r) + '\n')
const shape = (e) => { const o = { ev: e.ev }; for (const f of ['id','from','to','cursor','len','act']) if (e[f] !== undefined) o[f] = e[f]; if (typeof e.text === 'string') o.textLen = e.text.length; return o }
const session = await connect({ app: 'pr40-probe5', features: ['edit', 'undo', 'send'] })
if (session === null) { log({ phase: 'connect', result: 'null' }); process.exit(2) }
log({ phase: 'hello', ver: session.caps.ver, features: session.caps.features })
const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe5', listen: true })
const view = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'probe5 native editor' }),
  ui.editor({ key: 'ed', text: 'seed', cursor: 4, sendable: true, placeholder: 'type here' }),
)
surface.render({ main: view })
log({ phase: 'rendered', seq: surface.seq })
let n = 0
for await (const input of session) {
  if (input.type === 'key') log({ phase: 'yield-key', key: { name: input.key.name, ctrl: input.key.ctrl === true } })
  else { log({ phase: 'yield-event', event: shape(input.event) }); if (input.event.ev === 'gone') break }
  if (++n > 200) break
}
await surface.close({ keep: false }); await session.close(); log({ phase: 'closed' }); process.exit(0)
```

### A.6 `pr4-0-sdk-event-probe6.mjs` (modal overlay vs background pointer)

```js
/** PR4-0 probe 6: does a native `overlay {modal:true}` intercept pointer actions on the background? (disposable) */
import { appendFileSync } from 'node:fs'
import { connect, html, ui } from '@stencil-hq/tern'
const LOG = process.env.PR40_LOG ?? '/tmp/pr40-probe6.jsonl'
const log = (r) => appendFileSync(LOG, JSON.stringify(r) + '\n')
const shape = (e) => { const o = { ev: e.ev }; for (const f of ['id','act','item']) if (e[f] !== undefined) o[f] = e[f]; return o }
const session = await connect({ app: 'pr40-probe6' })
if (session === null) { log({ phase: 'connect', result: 'null' }); process.exit(2) }
const surface = session.open({ id: 's1', mode: 'inline', title: 'pr40-probe6', listen: true })
const main = ui.col({ key: 'root' },
  ui.text({ key: 'hdr', text: 'probe6 modal' }),
  html.button({ key: 'bg', actions: { click: 'bg-click' } }, 'BACKGROUND BUTTON'),
)
surface.render({ main })
log({ phase: 'rendered-no-modal', seq: surface.seq })
// Show the modal overlay in the layer region.
surface.render({
  main,
  layer: ui.col({ key: 'layer' }, ui.overlay({ key: 'ov', modal: true, anchor: 'center', size: 'md' },
    ui.text({ key: 'ov-text', text: 'MODAL OVERLAY' }),
    html.button({ key: 'ovbtn', actions: { click: 'ov-click' } }, 'OVERLAY BUTTON'),
  )),
})
log({ phase: 'rendered-modal', seq: surface.seq })
let n = 0
for await (const input of session) {
  if (input.type === 'key') log({ phase: 'yield-key', key: { name: input.key.name } })
  else { log({ phase: 'yield-event', event: shape(input.event) }); if (input.event.ev === 'gone') break }
  if (++n > 200) break
}
await surface.close({ keep: false }); await session.close(); log({ phase: 'closed' }); process.exit(0)
```

## Appendix B — run record, fixture manifest and digests

### B.1 Fixture manifest

| Item | Value |
|---|---|
| Program | the six scripts in Appendix A, run with `node` (v24.20.0) from the worktree root so `@stencil-hq/tern` resolves |
| Content | synthetic strings only (`PR4-0 probe`, `Button A`, `Item one`, `x`, `seed`, `BACKGROUND BUTTON`, …) |
| Session/credentials | none: no DSH session, no Agent, no Host, no transcript, no credential read |
| Log | sanitized JSONL (`shape()` whitelists fields; `text` is recorded as a length only) |
| Pane | a throwaway `tern serve` control socket on `/tmp`; no user profile touched |

### B.2 Run record

| Step | Command | Result |
|---|---|---|
| start the real pane | `tern serve --control /tmp/pr40.sock --out /tmp/pr40-shots` (background) | pane up; control socket created |
| readiness | `tern ctl --control /tmp/pr40.sock ready` | `ok` |
| run a probe | `tern ctl --control /tmp/pr40.sock --file /tmp/pr40-scnN.txt` where the scenario line is `run "PR40_LOG=… node temp/tern/pr4-0-sdk-event-probeN.mjs"` | `{"ok":true}` (the pane accepted the command; the probe's own exit status is not carried by `tern ctl`) |
| locate nodes | `tern ctl --control /tmp/pr40.sock tree` | the real laid-out element rects used for the click coordinates |
| drive gestures | `tern ctl --control /tmp/pr40.sock --file /tmp/pr40-clicksN.txt` (`click <x> <y>`, `dblclick`, `type "…"`, `key Backspace`, `key Enter`) | `{"ok":true}` per command |
| stop | `tern ctl --control /tmp/pr40.sock quit` | pane closed; probes 1–5 had already been terminated during iteration, probe 6 then wrote its final `closed` line and exited 0 |

Probe process exit status: **not observable** through `tern ctl`. The logs show
it indirectly — probes 1–5 end without a `closed` line (the process was killed
mid-iteration), probe 6 ends with `{"phase":"closed"}` (a clean exit 0).
The logs are **append-only**, so a digest is only final once the probe process
is gone; the values below were taken after all six probes had stopped.

### B.3 Digests of the sanitized logs

| Probe | Log | sha256 |
|---|---|---|
| 1 (handlers) | `/tmp/pr40-probe.jsonl` | `abd7e350a3c0c4c75372fb739facb7a7e9d304423b7cd97aafaa507b5efb1ae9` |
| 2 (no handlers) | `/tmp/pr40-probe2.jsonl` | `7401ce43930ad946eb7733a54744b9df50f987d1c49c7c01db9cce2a814b321d` |
| 3 (per-kind arming) | `/tmp/pr40-probe3.jsonl` | `6ebcd5a91033fe8a8ececdb73afd3a6338b56f43eda2e590c7a3092d5e2f52e6` |
| 4 (click + menu) | `/tmp/pr40-probe4.jsonl` | `6f2841639b793d37dc35688bd385e9e249ea73fc41d9968bf2340d8d87d1d7cb` |
| 5 (native editor) | `/tmp/pr40-probe5.jsonl` | `d72f19b1b6696de097b8897e77f4a7fa6845458676b4255549077e8ff7340272` |
| 6 (modal) | `/tmp/pr40-probe6.jsonl` | `bdbeed2198ba1fc532f9a963204264e148da560ebe3b0fc1209297ea73eab135` |

The `/tmp` logs are ephemeral and not committed; Appendix A plus B.2 regenerate
them. (Probe 6's digest was corrected after an independent review: the earlier
value was taken before the pane quit, and the append-only log then gained its
final `closed` line.)

## Appendix C — pinned permalinks for the decisive claims

| Claim | Permalink |
|---|---|
| the TSP renderer's `routeInput` event branch | https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/tui/tsp/session.ts#L713-L721 |
| the composer `ui.editor` node | https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/tui/tsp/session.ts#L437-L444 |
| the modal seat's `handleEvent` | https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/tui/tsp/interaction.ts#L1264-L1271 |
| `connect` announces no program feature | https://github.com/XMoon/dsh-pi-tui/blob/6a6c0b915527ced2a21d33ba3772c156247efe2f/src/tui/tsp/session.ts#L203-L206 |

SDK claims are deliberately **not** given a repo permalink: `node_modules` is not
tracked, so such a URL would 404. The authority for the SDK types is the
installed package (`node_modules/@stencil-hq/tern/dist/*.d.ts`, version `0.1.0`
as declared and lock-resolved) plus the upstream SDK repository; the exact
declarations are quoted by file:line in §2–§4 above.
