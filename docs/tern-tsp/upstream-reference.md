# TSP upstream reference: specification, SDK and oh-my-pi

> **Status:** VERSIONED REFERENCE, **not** an independent normative contract.
>
> Snapshot date: 2026-10-13. Use with [Foundation contract](./foundation.md) and [dated evidence](./evidence/foundation-20261013.md). Changes to upstream `main`, package tarballs or Tern versions require a fresh comparison.

Audit IDs and report references in this document refer to unpublished local research materials (00-baseline.md through 07-spike-results.md). They are provenance identifiers, not repository paths or clickable links. For repository-accessible evidence, use the pinned source references and the dated evidence summary.

## 1. Four independent code/document sources

| Source | Fixed snapshot | Applies to |
|---|---|---|
| Official Tern protocol / elements docs | `https://docs.stencil.so/tern/`, retrieved 2026-10-13; ETag `"6ac553c9-1c7a"` / last modified 2026-10-06, audit has a 26-page checksum manifest | Intended protocol semantics, **not** a pinned implementation or terminal observation |
| Published installed TypeScript SDK | `@stencil-hq/tern@0.1.0` with package/lockfile integrity; source matches [`stencil-hq/tern-sdk@3c562a1`](https://github.com/stencil-hq/tern-sdk/tree/3c562a1de7a8501baad7338fc32aa85badf48cc4/typescript/src) byte-for-byte | This project's SDK behavior |
| SDK `main` (at audit) | [`stencil-hq/tern-sdk@13d3cca8`](https://github.com/stencil-hq/tern-sdk/tree/13d3cca8bbd8f055431f8eb3caa434a22e966f8f/typescript/src) | Upstream delta **only**; do not assume installed |
| Official product reference (independent implementation) | [`can1357/oh-my-pi@818dd42b73`](https://github.com/can1357/oh-my-pi/tree/818dd42b73ab1caad17fa06d4edcc3a97086dc57) | Real product patterns; OMP does **not** import `@stencil-hq/tern` |

**Do not infer equality from version strings.** SDK `main` retained package version `0.1.0` even after six commits changing six TypeScript source files. The SDK's published `dist/wire.js` was separately inspected and still sends blob `id` as in its pinned `src/`.

## 2. Vocabulary / API comparison (audited snapshot)

| Mechanism | Pinned SDK | SDK `main` | OMP wire/backend | 0.8.3 measured client |
|---|---|---|---|---|
| Kinds | **44**, `el`, `block`, no `media` | **45**, adds `media` | **43**, `media`, no `el`/`block` | Advertised **45** (`pin + media`) |
| Verbs | `q o f b t s x r e` | Same | `q o f b t x r e` (**no `s` stylesheet**) | Styles feature advertised; rendering/acceptance must be tested per use |
| Open mode | `inline/screen/flow`, `listen`, `adopt` available | Same | `inline/screen`, no `listen` | `flow` feature advertised (not a product test) |
| Blob framing | Emits `id`, optional `mime` | Omits `id` | Emits `id` | Both recognized by `q:blobs → r:blobs.have` in tested 0.8.3 |
| tmux probe | `connect()` rejects `TMUX` | `@tern-tsp` option/pane title guard support | Own `@tern-tsp`/`tmux.ts` path and title guard | No blanket tested tmux product qualification |
| `media` | No typed builder/props | Adds `ui.media`/`MediaProps` | Declares `media` | Advertised and rendered with successful-image and missing-path controls |
| Placeholder | `EditorProps.placeholder` string | `Spans` | `TspText` | Not asserted cross-client here |

Source anchors: pinned `typescript/src/{wire.ts,props.ts,session.ts,ui.ts,surface.ts}`, OMP `packages/wire/src/tsp.ts`, `packages/tui/src/{native/backend.ts,terminal.ts,tmux.ts}` and audit reports `01` §1–§9 / `02` §1–§3. Earlier erroneous claims that OMP had 41 kinds, lacked tmux title protection, or never used Picker Column `min` have been **retracted** (`06` §0–§2).

## 3. What OMP's native runtime actually owns

The OMP implementation has its **own** code paths and assumptions. The table is a learning index, not a transplant plan.

| OMP code | Verified behavior | Use in dsh-pi-tui analysis |
|---|---|---|
| `packages/tui/src/terminal.ts` / `tmux.ts` | TSP probe with DA1/tmux decision; option-based title protection; optimistic native startup when expected | Contrast with pinned SDK's own `connect`, not a requirement to implement a second handshake |
| `packages/tui/src/native/backend.ts` | Backend, inline and optional screen surfaces, frame credits/coalescing, ACK-stall recovery, optional mirror/record | First ask whether pinned SDK already handles needed flow control; an ACK-stall mechanism in OMP does **not** establish a project defect |
| `packages/tui/src/native/reconcile.ts` / `node.ts` | Component `describe`, per-component state, keyed node identity, hoisted portal mechanism, LCS/LIS move choices, explicit `reveal/scroll` | OMP-local reconciler and hoisting are **not** automatic behavior of `@stencil-hq/tern` |
| `packages/tui/src/native/memo.ts` | Memoization by dependencies/ref identity; deep-equality only for appropriate props | Performance choice with measured need, **not** a mandatory second caching layer |
| `packages/tui/src/native/apply.ts`, `test/native/tsp-harness.ts` | Reference application of emitted frames; synthetic TSP terminal with explicit errors/ACKs | Useful test-oracle design; does **not** qualify real Tern layout/physical input |
| `packages/tui/src/native/overlay.ts` / `picker.ts` | Application-managed pointer/keyboard intent, action buttons and native picker; explicit `list` click/dblclick mappings | Learn how intent paths converge; preserve the actual project's business admission owner |
| `packages/tui/src/native/settle.ts` / `transcript-container.ts` | Component-level settlement bookkeeping and native list reuse | Reference only when a real transcript problem is shown |

### Two different fallback mechanisms

1. **Component-initiated substitution**: a component checks `supports(kind)`/feature and describes a simpler set of supported nodes. A generic `item` has fewer fields than a Picker Item; fallback is **not feature-equivalent by default**.
2. **OMP `rows` fallback**: a component does not provide a usable native `describe()` (or intentionally paints text rows), so OMP's reconciler substitutes `rows`. This **does not** mean that asking a client to render an unadvertised kind automatically triggers `rows`, and it is not a pinned-SDK promise.

### Overlay and `layer`

OMP may hoist overlays/pickers into `layer` and **drops a nested sheet** within a hoisted overlay. That restriction belongs to OMP's reconciler. Our SDK's `View.from` and the current production `ui.col({…}, ui.overlay(...))` layout must be understood independently. The official docs show overlays **within** `layer`; they do not require every region root to be a `col` as a type-level law.

## 4. Component-pattern index (examples, not global prohibitions)

| Feature | OMP example | What it demonstrates |
|---|---|---|
| Model directory | `packages/tui/src/overlays/model-browser.ts:1973–2035` | One item per entity in sampled picker, identity in `label`, `mono`, numeric `facts/columns`, badges/chips, tooltip |
| Model preview | same file `:2133–2263` | `pickerPreview → modelPreview`; `text({wrap:'word'})` warning at `:2168`, `md(description)` at `:2261` |
| **Generic list detail** | same file `#describeDetail():1852–1907` | Word-wrapped facts/description at `:1883/:1885` belong to **generic List detail**, not Picker Preview |
| Picker sheet | `overlays/model-picker.ts:395–430` | Picker as its own native sheet; sample `layout:'rows', preview:'below'` |
| Item selection | `native/picker.ts:241–271`; `overlays/ask-dialog.ts:1020–1063` | `select` vs `activate` are component/business-context dependent; pointer/keyboard share semantic methods |
| Action buttons | `native/overlay.ts:98–120` | Ordinary node with `actions:{click:act}` invokes same intent as matching key path |
| Reader scroll | `native/reconcile.ts` reveal/scroll branches | There are several different mechanisms; not proof a particular existing Reader automatically scrolls |

**Don't canonize incidental optimizations.** In sampled OMP pickers, long identifiers are not split into multiple independent selectable continuation rows, but wire types do not prohibit long `label`/`detail` text. `text` with word wrap is a valid prose node alongside `md`, `code`, `ansi`, etc. Picker's `on` indicates toggle/pressed state; `tone` visual semantics are **not** focus authority. Numeric geometry/breakpoint values measured on a specific client are neither TSP spec nor cross-font limits.

## 5. Important observations and limits

All numbers in this paragraph refer to **Tern `0.8.3 (e2b8656)`, headless**, not all releases:

- Native `modal:true` backdrop prevented pointer actions reaching a covered background control, with same-coordinate open/closed controls.
- Picker `focus` prop switched DOM classes `f-list` ↔ `f-preview`; this proves client treatment of the prop, **not** caret navigation, Reader scroll or physical keyboard focus.
- `Tab` followed by `Enter` sent two key events to the program rather than a native `html.button` action in the probed layout; the application must supply intended keyboard actions.
- `focus("no-such-node")` emitted an `error` identifying the frame and operation; `focus("layer")` was recognized but its caret outcome remains unqualified.
- `error(s=9,op=0)` arrived ahead of `ack(s=9)`; this does **not** establish ordering for user `select/activate/action` events.
- A tested `col` region root did not receive UI events with id `layer` when its descendant was clicked. **No general proof** of non-arriving stale UI events was produced.

See [date-specific evidence and unknowns](./evidence/foundation-20261013.md).

## 6. Maintenance and adoption checklist

Before reusing an upstream pattern, inspect the pinned SDK's equivalent API; identify the current production caller and business sink; check supported caps from the actual pane; locate a genuine missing capability; select the smallest composition; and write one positive and one relevant negative test. Revalidate any conclusion based on OMP `main`, SDK `main`, or a closed-source Tern rendering run when versions drift. Keeping an OMP source reference is not authorization for a new dependency, Reconciler, Frame pump, cache, or broad refactor.
