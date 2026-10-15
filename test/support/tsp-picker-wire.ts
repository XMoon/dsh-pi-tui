/**
 * The wire observation helpers for the native TSP `/model` layer.
 *
 * A renderer test must read what the SDK ACTUALLY sent: the folded node tree of
 * the pane's frames. The node ids are path-derived from the layer keys, so a
 * caller can address the picker, a radio Row, or any visible text without
 * reaching into renderer-local state.
 * @module @xmoon76/dsh-pi-tui/test/support/tsp-picker-wire
 */
import assert from 'node:assert/strict'
import type { TspPane } from './tsp-terminal-fixture.ts'

export interface WireNode {
  readonly id: string
  readonly k: string
  readonly p: Record<string, unknown>
  readonly c?: WireNode[]
}

/** Fold the pane's frame ops into the live node set (a retired receiver is
 *  gone, so it can never satisfy an assertion). */
export function wireNodes(pane: TspPane): WireNode[] {
  const live = new Map<string, WireNode>()
  const parents = new Map<string, string>()
  const remove = (id: string): void => {
    parents.delete(id)
    for (const [child, parent] of parents) if (parent === id) remove(child)
    live.delete(id)
    parents.delete(id)
  }
  const add = (node: WireNode, parent: string): void => {
    live.set(node.id, { ...node, p: { ...node.p } })
    parents.set(node.id, parent)
    for (const child of node.c ?? []) add(child, node.id)
  }
  for (const frame of pane.frames())
    for (const op of frame.ops) {
      if (op[0] === 'add') add(op[4] as unknown as WireNode, String(op[2]))
      if (op[0] === 'del') remove(String(op[1]))
      if (op[0] === 'set') {
        const node = live.get(String(op[1]))
        if (node !== undefined) Object.assign(node.p, op[2])
      }
      // The SDK streams text-bearing nodes (`editor`, `md`, …) through its own
      // `text` op: `replace` sets the value, `append` extends it. Folding it is
      // what makes a STABLE node id (the composer) readable across frames.
      if (op[0] === 'text') {
        const node = live.get(String(op[1]))
        const mode = op[2]
        const value = op[3]
        if (node !== undefined && typeof value === 'string') {
          if (mode === 'replace') node.p.text = value
          if (mode === 'append') node.p.text = String(node.p.text ?? '') + value
        }
      }
    }
  return [...live.values()]
}

/** The `/model` layer's key prefix (the default of every helper below). */
export const MODEL_LAYER_PREFIX = 'model-'
/** The `/preset` layer's key prefix. */
export const PRESET_LAYER_PREFIX = 'preset-'

/** Every mounted node of ONE picker layer: the layer key prefixes its whole
 *  subtree, so one filter addresses that layer and nothing else on the surface. */
export function layerNodes(pane: TspPane, prefix = MODEL_LAYER_PREFIX): WireNode[] {
  return wireNodes(pane).filter((node) => node.id.split(/[.:]/).some((part) => part.startsWith(prefix)))
}

/** The mounted picker of one layer, or `undefined` while no frame is committed. */
export function pickerNode(pane: TspPane, prefix = MODEL_LAYER_PREFIX): WireNode | undefined {
  return layerNodes(pane, prefix).find((node) => node.k === 'picker')
}

/** The picker's props, or `{}` while absent: a `waitUntil` predicate must never
 *  throw (a thrown predicate skips the wait and leaves a credit-gated frame
 *  unflushed). */
export function pickerProps(pane: TspPane, prefix = MODEL_LAYER_PREFIX): Record<string, unknown> {
  return pickerNode(pane, prefix)?.p ?? {}
}

/** A picker the caller has ALREADY waited for (a hard assertion, not a poll). */
export function requiredProps(pane: TspPane): Record<string, unknown> {
  assert.ok(pickerNode(pane), 'the native model picker must be mounted')
  return pickerProps(pane)
}

/** Every visible text of the committed layer, plain and span text alike. */
export function sheetText(pane: TspPane, prefix = MODEL_LAYER_PREFIX): string {
  const out: string[] = []
  for (const node of layerNodes(pane, prefix)) {
    if (typeof node.p.text === 'string') out.push(node.p.text)
    const spans = node.p.spans
    if (!Array.isArray(spans)) continue
    for (const entry of spans) {
      if (typeof entry === 'string') out.push(entry)
      else if (entry !== null && typeof entry === 'object') {
        // A span is serialized as `{ t: text, s: tone }`.
        const span = entry as { t?: unknown; text?: unknown }
        const text = span.t ?? span.text
        if (typeof text === 'string') out.push(text)
      }
    }
  }
  return out.join(' | ')
}

/** Whether the mounted layer renders the inline Reasoning Effort card (the card's
 *  head is a PROP, so it never appears in the visible text). */
export function hasEffortCard(pane: TspPane): boolean {
  return layerNodes(pane).some((node) => node.k === 'card' && node.p.head === 'Reasoning Effort')
}

/** One named action of the picker's action bar. */
export function pickerAction(pane: TspPane, id: string, prefix = MODEL_LAYER_PREFIX): Record<string, unknown> | undefined {
  return ((pickerProps(pane, prefix).actions ?? []) as Array<Record<string, unknown>>)
    .find((entry) => entry.id === id)
}

/** One action entry by the BASE id it really does: a footer's ids carry the frame token
 *  of the revision that rendered them, so an exact-id lookup cannot find them. */
export function pickerActionByBase(
  pane: TspPane,
  base: string,
  prefix = MODEL_LAYER_PREFIX,
): Record<string, unknown> | undefined {
  return ((pickerProps(pane, prefix).actions ?? []) as Array<Record<string, unknown>>)
    .find((entry) => String(entry.id) === base || String(entry.id).startsWith(`${base}#`))
}

/** Send one footer action by its BASE id, addressing the id the picker REALLY rendered
 *  (a test that invented the token would prove nothing about the wire). */
export function sendPickerAction(pane: TspPane, base: string, prefix = MODEL_LAYER_PREFIX): void {
  const entry = pickerActionByBase(pane, base, prefix)
  assert.ok(entry, `no ${base} action in ${JSON.stringify(pickerProps(pane, prefix).actions)}`)
  sendAction(pane, String(entry.id), undefined, pickerNode(pane, prefix)!.id)
}

/** Click one layer node by a fragment of its key: the SDK dispatches the node's own
 *  `onClick` for it, exactly as the pane does for a real pointer click. */
export function clickLayerNode(pane: TspPane, fragment: string, prefix = MODEL_LAYER_PREFIX): void {
  const node = layerNodes(pane, prefix).find((entry) => entry.id.includes(fragment))
  assert.ok(node, `no node matching ${fragment} in ${layerNodes(pane, prefix).map((n) => n.id).join(', ')}`)
  clickNodeById(pane, node.id)
}

/** A Row the SDK dispatches `onClick` on (an effort radio row). */
export function rowNode(pane: TspPane, fragment: string, prefix = MODEL_LAYER_PREFIX): WireNode {
  const node = layerNodes(pane, prefix).find((entry) => entry.k === 'row' && entry.id.includes(fragment))
  assert.ok(node, `no row matching ${fragment} in ${layerNodes(pane, prefix).map((n) => n.id).join(', ')}`)
  return node
}

/** A Card the SDK dispatches its own `onClick` on (the wide details card). The
 *  card is found by a fragment of its key; its `head` is a PROP, so a test can
 *  assert the affordance text without reaching into renderer state. */
export function cardNode(pane: TspPane, fragment: string, prefix = MODEL_LAYER_PREFIX): WireNode {
  const node = layerNodes(pane, prefix).find((entry) => entry.k === 'card' && entry.id.includes(fragment))
  assert.ok(node, `no card matching ${fragment} in ${layerNodes(pane, prefix).map((n) => n.id).join(', ')}`)
  return node
}

/** Wait until the model picker is mounted and in one exact state. */
export async function waitForPicker(
  label: string,
  pane: TspPane,
  state: 'ready' | 'loading' | 'error' = 'ready',
  timeoutMs = 10_000,
  prefix = MODEL_LAYER_PREFIX,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pickerProps(pane, prefix).state === state) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

/* ----------------------------------------------------------- reader page wire */

/**
 * The read-only Reader's mounted `overlay` (the `details` page), or `undefined`
 * while the page is a picker. The page REPLACES the picker, so a mounted picker
 * and a mounted Reader can never both describe the same layer. It is found by the
 * key it was built from (the overlay's own head is the MODEL NAME, so the page is
 * never identified by a caption it may not carry).
 */
export function readerNode(pane: TspPane, prefix = MODEL_LAYER_PREFIX): WireNode | undefined {
  return layerNodes(pane, prefix).find((node) => node.k === 'overlay' && node.id.includes('model-details-reader'))
}

/** The Reader's scrollable body: the node the presenter addresses with the SDK's
 *  `scroll` op, found by the key it was built from (never a guessed path). */
export function readerBodyNode(pane: TspPane, prefix = MODEL_LAYER_PREFIX): WireNode | undefined {
  return layerNodes(pane, prefix).find((node) => node.k === 'col' && node.id.includes('model-details-body'))
}

/** The Reader's ONE interactive node: its visible `Back` row. */
export function readerBackNode(pane: TspPane, prefix = MODEL_LAYER_PREFIX): WireNode {
  const node = layerNodes(pane, prefix).find((entry) => entry.k === 'row' && entry.id.includes('model-details-back'))
  assert.ok(node, `no reader Back row in ${layerNodes(pane, prefix).map((n) => n.id).join(', ')}`)
  return node
}

/** One Reader value node's COMPLETE text, by the key it was built from. */
export function readerValue(pane: TspPane, key: string, prefix = MODEL_LAYER_PREFIX): string | undefined {
  const node = layerNodes(pane, prefix).find((entry) => entry.k === 'text' && entry.id.endsWith(`.${key}`))
  return typeof node?.p.text === 'string' ? node.p.text : undefined
}

/** Every `scroll` op the SDK really sent, in order: the wire is the observation
 *  point (a renderer-local call is not the client's viewport). */
export function scrollOps(pane: TspPane): Array<{ readonly id: string; readonly to: string }> {
  const out: Array<{ id: string; to: string }> = []
  for (const frame of pane.frames())
    for (const op of frame.ops) {
      if (op[0] === 'scroll') out.push({ id: String(op[1]), to: String(op[2]) })
    }
  return out
}

const sf = (pane: TspPane): string => pane.frames().at(-1)!.sf

/** Send one picker action-bar action (the pane does this when its action bar is used). */
export function sendAction(pane: TspPane, act: string, value?: string, id = pickerNode(pane)?.id): void {
  // The caller may address ANY layer's picker by passing its node id; the
  // default is the `/model` one, the only layer the original callers open.
  assert.ok(id, 'the picker must be mounted to send an action')
  pane.event({
    ev: 'action',
    sf: sf(pane),
    id,
    act,
    ...(value === undefined ? {} : { value }),
  })
}

/**
 * Send one ROW selection (a model row or an effort candidate row). This is
 * deliberately NOT how a provider scope is chosen: the SDK delivers the scope
 * column's click on the `action` channel as `act:'scope', value:<scope id>`
 * (see {@link sendAction}), so a `select` carrying a scope-shaped id is a
 * protocol shape that must never filter.
 */
export function sendSelect(pane: TspPane, item: string, id = pickerNode(pane)?.id): void {
  // See `sendAction`: the default receiver is the `/model` layer's picker.
  assert.ok(id, 'the picker must be mounted to send a selection')
  pane.event({ ev: 'select', sf: sf(pane), id, item })
}

/**
 * Send one ROW ACTIVATION. The SDK uses this shape for a click on the row that is
 * already selected (and for a double click), so a test can drive it separately
 * from {@link sendSelect} and prove the two shapes resolve the same intent.
 */
export function sendActivate(pane: TspPane, item: string, id = pickerNode(pane)?.id): void {
  assert.ok(id, 'the picker must be mounted to send an activation')
  pane.event({ ev: 'activate', sf: sf(pane), id, item })
}

/** Click a node the way the pane does: an action whose `act` is the node's own
 *  `actions.click` mapping (auto-set by the SDK for `onClick`). */
export function clickNodeById(pane: TspPane, id: string, act = 'click'): void {
  // The EXACT id, so a caller can deliver an event from a RETIRED frame and prove
  // the current one never routes it.
  pane.event({ ev: 'action', sf: sf(pane), id, act })
}
export function clickNode(pane: TspPane, node: WireNode): void {
  pane.event({ ev: 'action', sf: sf(pane), id: node.id, act: 'click' })
}

/** Send a terminal resize for the renderer's surface. */
export function sendResize(pane: TspPane, cols: number): void {
  pane.event({ ev: 'resize', sf: sf(pane), cols })
}
