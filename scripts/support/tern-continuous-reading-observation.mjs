/**
 * Pure, read-only observers shared by the Stage4 continuous-reading flows.
 *
 * Nothing here talks to a socket, spawns a process or holds state: each export
 * folds ONE artifact the run already produced (the SDK wire JSONL, the client's
 * node tree, the subject's event JSONL) into the exact facts a claim needs. The
 * canonical visibility oracle stays `scripts/tern-pane-geometry.mjs`; this module
 * never re-derives clipping.
 *
 * The fold semantics are the load-bearing part: an `add` REPLACES the id's whole
 * subtree, a `del` drops the subtree (so "unmounted" and "scrolled out of view"
 * stay different facts), `set` merges properties and `text` appends or replaces.
 * @module scripts/support/tern-continuous-reading-observation
 */
import { existsSync, readFileSync } from 'node:fs'

/** Read a JSONL artifact; a missing file is an empty ledger, not an error. */
export function readJsonl(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line)
      } catch {
        return undefined
      }
    })
    .filter(entry => entry !== undefined)
}

/** Read a JSON artifact, or `undefined` when it does not exist yet. */
export function readJson(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/** The records the subject appends to `events.jsonl`. */
export const eventRecords = root => readJsonl(`${root}/events.jsonl`)
/** The SDK's own outbound/inbound wire ledger. */
export const wireRecords = root => readJsonl(`${root}/sdk-wire.jsonl`)

/**
 * Fold one node's own text: `p.text` wins, then `p.head` (a card header).
 */
function ownText(node) {
  if (typeof node.p?.text === 'string') return node.p.text
  if (typeof node.p?.head === 'string') return node.p.head
  return ''
}

/**
 * Fold every `f` frame's ops into the live node set.
 *
 * The returned map is the SDK's authoritative live view: an id absent from it is
 * NOT mounted (deleted, or never added), which is what makes an "unknown id"
 * negative control meaningful. Order is insertion order of first add.
 */
export function foldLive(wire) {
  const nodes = new Map()
  const dropSubtree = id => {
    const doomed = new Set()
    const collect = current => {
      if (doomed.has(current)) return
      doomed.add(current)
      for (const child of nodes.get(current)?.childIds ?? []) collect(child)
    }
    collect(id)
    for (const doomedId of doomed) nodes.delete(doomedId)
  }
  const visit = (node, parentId) => {
    if (node === null || node === undefined || typeof node !== 'object' || typeof node.id !== 'string') return
    const childIds = (node.c ?? []).map(child => child.id).filter(id => typeof id === 'string')
    nodes.set(node.id, {
      id: node.id,
      k: node.k,
      p: { ...(node.p ?? {}) },
      childIds,
      parentId: parentId ?? null,
    })
    for (const child of node.c ?? []) visit(child, node.id)
  }
  for (const entry of wire) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) {
      switch (op[0]) {
        case 'add': {
          // Re-adding an id replaces its whole subtree, so the old children leave.
          dropSubtree(op[1])
          visit(op[4], op[2])
          const parent = nodes.get(op[2])
          if (parent !== undefined && !parent.childIds.includes(op[1])) {
            // `op[3]` is the sibling the node is placed BEFORE, or null to append.
            const at = op[3] === null || op[3] === undefined ? -1 : parent.childIds.indexOf(op[3])
            if (at < 0) parent.childIds.push(op[1])
            else parent.childIds.splice(at, 0, op[1])
          }
          break
        }
        case 'del':
          dropSubtree(op[1])
          break
        case 'set': {
          const node = nodes.get(op[1])
          if (node === undefined) break
          for (const [key, value] of Object.entries(op[2] ?? {})) {
            if (value === null) delete node.p[key]
            else node.p[key] = value
          }
          break
        }
        case 'text': {
          const node = nodes.get(op[1])
          if (node === undefined) break
          const before = typeof node.p.text === 'string' ? node.p.text : ''
          node.p.text = op[2] === 'append' ? before + String(op[3] ?? '') : String(op[3] ?? '')
          break
        }
        case 'move': {
          const node = nodes.get(op[1])
          const parentId = op[2]
          const before = op[3]
          if (node === undefined) break
          const oldParent = node.parentId === null ? undefined : nodes.get(node.parentId)
          if (oldParent !== undefined) oldParent.childIds = oldParent.childIds.filter(id => id !== op[1])
          node.parentId = parentId
          const parent = nodes.get(parentId)
          if (parent === undefined) break
          const at = before === null || before === undefined ? -1 : parent.childIds.indexOf(before)
          if (at < 0) parent.childIds.push(op[1])
          else parent.childIds.splice(at, 0, op[1])
          break
        }
        default:
          // `settle` and any future hint carry no node identity this observer needs.
          break
      }
    }
  }
  return nodes
}

/** The concatenated text of a node's own subtree, with cycle protection. */
export function subtreeText(live, id, seen = new Set()) {
  if (seen.has(id)) return ''
  seen.add(id)
  const node = live.get(id)
  if (node === undefined) return ''
  return [ownText(node), ...node.childIds.map(child => subtreeText(live, child, seen))]
    .filter(Boolean)
    .join(' ')
}

/** Whether `id` is mounted in the folded live set. */
export const isMounted = (live, id) => live.has(id)

/** The wire id of the ONE stable Main root. */
export const MAIN_ROOT = 'main'

/**
 * The Main ROOT's DIRECT card ids, in wire order.
 *
 * MEASURED against the real SDK wire: `main` is itself a wire node and every
 * top-level transcript card is one of its direct children. A prefix scan over
 * every live id would also return nested text nodes, which would make "one card
 * per turn" vacuous, so the parent map decides.
 */
export function mainIds(live) {
  const root = live.get(MAIN_ROOT)
  if (root === undefined) return []
  return root.childIds.filter(id => live.has(id))
}

/**
 * The Main card that MOUNTS `marker`, i.e. whose own subtree text contains it.
 * Returns every match so a caller can prove uniqueness instead of assuming it.
 */
export function cardsShowing(live, marker) {
  return mainIds(live).filter(id => subtreeText(live, id).includes(marker))
}

/** The single Main card showing `marker`, or `undefined` when none/many match. */
export function cardShowing(live, marker) {
  const matches = cardsShowing(live, marker)
  return matches.length === 1 ? matches[0] : undefined
}

/** Every User-role Main card, in wire order. */
export function userRows(live) {
  return mainIds(live).filter(id => {
    const node = live.get(id)
    return node.k === 'message' && node.p?.role === 'dsh.transcript.user'
  })
}

/** The Main cards retired by a `del`/replacement between two folds. */
export function retiredSince(before, after) {
  return mainIds(before).filter(id => !after.has(id))
}

/** Every `settle` op the SDK actually sent, in order. */
export function settleOps(wire) {
  const out = []
  for (const entry of wire) {
    if (entry.dir !== 'out' || entry.verb !== 'f') continue
    for (const op of entry.body?.ops ?? []) if (op[0] === 'settle') out.push({ id: op[1], frame: entry.body?.s ?? null })
  }
  return out
}

/** Every `gone` event the real client reported, with the ids it evicted. */
export function goneEvents(wire) {
  const out = []
  for (const entry of wire) {
    if (entry.dir !== 'in' || entry.verb !== 'e') continue
    if (entry.body?.ev !== 'gone') continue
    out.push({ frame: entry.body?.s ?? null, ids: Array.isArray(entry.body.ids) ? [...entry.body.ids] : [] })
  }
  return out
}

/** The inline Surfaces this run opened; more than one breaks the contract. */
export function openedSurfaces(wire) {
  return wire
    .filter(entry => entry.dir === 'out' && entry.verb === 'o')
    .map(entry => ({ id: entry.body?.id, mode: entry.body?.mode ?? 'inline' }))
}

/** The client `error` events the SDK reported on the wire. */
export function wireErrors(wire) {
  return wire
    .filter(entry => entry.dir === 'in' && entry.verb === 'e' && entry.body?.ev === 'error')
    .map(entry => entry.body)
}

/**
 * The writer/model/turn/hold chronology of the subject's own event ledger.
 * Each list keeps APPEND order, which is the order the facts really happened in.
 */
export function eventLedger(events) {
  const writes = events.filter(entry => entry.kind === 'writer.settled')
  const modelCalls = events.filter(entry => entry.kind === 'model.calls')
  const sessionEvents = events.filter(entry => entry.kind === 'session.event')
  return {
    writes,
    modelCalls,
    sessionEvents,
    turnEnds: sessionEvents.filter(entry => entry.eventType === 'turn/end'),
    holdStarted: events.filter(entry => entry.kind === 'model.hold.26.started'),
    holdReleased: events.filter(entry => entry.kind === 'model.hold.26.released'),
    holdRefused: events.filter(entry => entry.kind === 'model.hold.26.refused'),
    reveals: events.filter(entry => entry.kind === 'client.reveal.requested'),
    inlineOpened: events.filter(entry => entry.kind === 'surface.inline.opened'),
    lastModelCalls: modelCalls.at(-1)?.calls ?? 0,
  }
}

/** The Direct write that settled for one prompt marker, if exactly one did. */
export function settledWriteFor(writes, marker) {
  const matches = writes.filter(entry => entry.marker === marker)
  return matches.length === 1 ? matches[0] : undefined
}

/**
 * Whether official `turn/end` is present for one ordinal in one Session. The
 * Session id matters: the source-switch subscene has two Sessions whose turn
 * numbers restart, so an unqualified ordinal would match the wrong source.
 */
export function turnEnded(turnEnds, sessionId, ordinal) {
  return turnEnds.some(entry => entry.sessionId === sessionId && entry.turn === ordinal)
}

/**
 * The visible/clipped witness for every node in one client tree, keyed by its
 * own text fragment. `visible` is the canonical oracle's answer; a node that
 * exists in the tree but survives nothing is reported `clipped: true`, which is
 * why "in the tree" is never promoted to "readable".
 */
export function treeRows(tree, geometry) {
  const { index, rect, containedXY, visibleBox } = geometry
  const snapshot = index(tree?.tree ?? [])
  const rows = []
  for (const node of snapshot.nodes) {
    const text = String(node.text ?? '')
    if (text === '') continue
    const box = rect(node)
    if (box[2] === 0 && box[3] === 0) continue
    const visible = visibleBox(snapshot.chains, node)
    rows.push({
      text,
      class: String(node.class ?? ''),
      rect: box,
      containedXY: containedXY(snapshot.chains, node),
      visibleSpan: visible.span,
    })
  }
  return rows
}

/**
 * Rows of one region subtree, in document order, with their real boxes. The
 * Dock's composer repeats input bytes, so a Main claim must be scoped here.
 */
export function regionTextNodes(tree, geometry, name = 'sf-main') {
  const { index, rect } = geometry
  const snapshot = index(tree?.tree ?? [])
  const region = snapshot.nodes.find(node => String(node.class ?? '').split(/\s+/u).includes(name))
  if (region === undefined) return []
  const out = []
  const walk = node => {
    const box = rect(node)
    if (box[2] > 0 || box[3] > 0) out.push({ node, text: String(node.text ?? ''), rect: box })
    for (const child of node.children ?? []) walk(child)
  }
  walk(region)
  return out
}
