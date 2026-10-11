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
    }
  return [...live.values()]
}

/** Every mounted node of the model layer: the layer key prefixes its whole
 *  subtree, so one filter addresses the layer and nothing else on the surface. */
export function layerNodes(pane: TspPane): WireNode[] {
  return wireNodes(pane).filter((node) => node.id.split(/[.:]/).some((part) => part.startsWith('model-')))
}

/** The mounted model picker, or `undefined` while no frame is committed. */
export function pickerNode(pane: TspPane): WireNode | undefined {
  return layerNodes(pane).find((node) => node.k === 'picker')
}

/** The picker's props, or `{}` while absent: a `waitUntil` predicate must never
 *  throw (a thrown predicate skips the wait and leaves a credit-gated frame
 *  unflushed). */
export function pickerProps(pane: TspPane): Record<string, unknown> {
  return pickerNode(pane)?.p ?? {}
}

/** A picker the caller has ALREADY waited for (a hard assertion, not a poll). */
export function requiredProps(pane: TspPane): Record<string, unknown> {
  assert.ok(pickerNode(pane), 'the native model picker must be mounted')
  return pickerProps(pane)
}

/** Every visible text of the committed layer, plain and span text alike. */
export function sheetText(pane: TspPane): string {
  const out: string[] = []
  for (const node of layerNodes(pane)) {
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
export function pickerAction(pane: TspPane, id: string): Record<string, unknown> | undefined {
  return ((pickerProps(pane).actions ?? []) as Array<Record<string, unknown>>)
    .find((entry) => entry.id === id)
}

/** A Row the SDK dispatches `onClick` on (an effort radio row). */
export function rowNode(pane: TspPane, fragment: string): WireNode {
  const node = layerNodes(pane).find((entry) => entry.k === 'row' && entry.id.includes(fragment))
  assert.ok(node, `no row matching ${fragment} in ${layerNodes(pane).map((n) => n.id).join(', ')}`)
  return node
}

/** Wait until the model picker is mounted and in one exact state. */
export async function waitForPicker(
  label: string,
  pane: TspPane,
  state: 'ready' | 'loading' | 'error' = 'ready',
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pickerProps(pane).state === state) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

const sf = (pane: TspPane): string => pane.frames().at(-1)!.sf

/** Send one picker action-bar action (the pane does this when its action bar is used). */
export function sendAction(pane: TspPane, act: string, value?: string, id = pickerNode(pane)?.id): void {
  assert.ok(id, 'the picker must be mounted to send an action')
  pane.event({
    ev: 'action',
    sf: sf(pane),
    id,
    act,
    ...(value === undefined ? {} : { value }),
  })
}

/** Send one row/scope selection (the pane does this when a list row is used). */
export function sendSelect(pane: TspPane, item: string, id = pickerNode(pane)?.id): void {
  assert.ok(id, 'the picker must be mounted to send a selection')
  pane.event({ ev: 'select', sf: sf(pane), id, item })
}

/** Click a node the way the pane does: an action whose `act` is the node's own
 *  `actions.click` mapping (auto-set by the SDK for `onClick`). */
export function clickNode(pane: TspPane, node: WireNode): void {
  pane.event({ ev: 'action', sf: sf(pane), id: node.id, act: 'click' })
}

/** Send a terminal resize for the renderer's surface. */
export function sendResize(pane: TspPane, cols: number): void {
  pane.event({ ev: 'resize', sf: sf(pane), cols })
}
