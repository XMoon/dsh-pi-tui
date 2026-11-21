/**
 * The renderer-local Main journal: the ONE delta owner of the transcript
 * Surface's `main` children.
 *
 * The SDK's `Surface.render()` diffs the WHOLE view it is handed, so a
 * continuous 5,000-turn transcript re-materialized and re-diffed every row on
 * every token. This journal keeps the SAME single `Surface` and moves only the
 * Main children: `Surface.render()` keeps managing a stable, always EMPTY
 * `main` root plus `dock`/`layer`, while each top-level transcript block is
 * added, updated and removed through the SDK's public `Surface.send(ops)`
 * with the ids `View`/`Tree` derive for that same tree.
 *
 * It owns NO transcript semantics: the block keys, the semantic stamps and the
 * nodes themselves all come from `describeTranscriptMainBlocksForPreset()`.
 * This file only:
 *
 * - materializes a block when it is new or its stamp changed;
 * - diffs a retained block against its own previous ONE-block view (never the
 *   whole history) and re-sends only that block's ops;
 * - places added/moved roots with the SDK's own `rising()` minimal-move rule;
 * - remembers settle/gone state per root so no op ever targets an id the
 *   client evicted.
 *
 * @module @xmoon76/dsh-pi-tui-t2-pr2-offline-import-guard:tui/tsp/continuous-main
 */

import { rising, ui, View } from '@stencil-hq/tern'
import type { Node, Op, Surface, Tree, WireNode } from '@stencil-hq/tern'
import type { TranscriptMainBlockDescriptor, TranscriptMainStampPart } from './transcript-view.ts'

/** The ONE stable Main root of the Surface while the journal owns its children. */
export function emptyTranscriptMain(): Node {
  return ui.col({ key: 'transcript', gap: 'none' })
}

/** A journal invariant was violated: the projection cannot be trusted. */
export class MainJournalInvariantError extends Error {
  override readonly name = 'MainJournalInvariantError'

  constructor(detail: string) {
    super(`continuous main journal: ${detail}`)
  }
}

/** One block's committed state. `view` is dropped once the root is settled. */
interface RootRecord {
  readonly key: string
  readonly id: string
  stamp: readonly TranscriptMainStampPart[]
  view: View | undefined
  /** The root's wire subtree, retained only while it has never been attached. */
  wire: WireNode | undefined
  attached: boolean
  settled: boolean
  /** The client evicted this root; no op may target it until a real mutation. */
  gone: boolean
}

export interface MainJournalCommitStats {
  /** Blocks materialized (new or changed stamp) in this commit, in Main order. */
  readonly materialized: readonly string[]
  /** Blocks whose key left the projection in this commit. */
  readonly removed: readonly string[]
  /** Ops queued for this commit. */
  readonly ops: number
}

function stampEqual(
  left: readonly TranscriptMainStampPart[],
  right: readonly TranscriptMainStampPart[],
): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false
  return true
}

/**
 * The ONE renderer-local Main journal. Every mutation is a synchronous
 * `Surface.send()` of SDK ops; the SDK's own credit/ack queue stays the only
 * outbound queue.
 */
export class ContinuousMainJournal {
  readonly #surface: Surface
  readonly #roots = new Map<string, RootRecord>()
  /** The attached root keys in real Main order. */
  #order: string[] = []

  constructor(surface: Surface) {
    this.#surface = surface
  }

  /** The attached root keys, in the order the client currently shows them. */
  get order(): readonly string[] {
    return this.#order
  }

  /** The attached root id of one block key, if the client still has it. */
  idOf(key: string): string | undefined {
    const record = this.#roots.get(key)
    return record !== undefined && record.attached ? record.id : undefined
  }

  /**
   * Commit one full descriptor list: materialize only new/changed blocks, then
   * place every root with the SDK's own child-diff ordering (deletions first,
   * then last-to-first add/move/inner-diff).
   */
  commit(
    descriptors: readonly TranscriptMainBlockDescriptor[],
    onMaterialized?: (key: string, node: Node, tree: Tree) => void,
  ): MainJournalCommitStats {
    const nextOrder: string[] = []
    const seen = new Set<string>()
    const pending: Op[] = []
    const materialized: string[] = []
    for (const descriptor of descriptors) {
      if (seen.has(descriptor.key)) {
        throw new MainJournalInvariantError(`duplicate top-level block key ${JSON.stringify(descriptor.key)}`)
      }
      seen.add(descriptor.key)
      nextOrder.push(descriptor.key)
      const known = this.#roots.get(descriptor.key)
      if (known !== undefined && stampEqual(known.stamp, descriptor.stamp)) {
        // A gone root is NOT resurrected by a projection alone: only a real
        // content change (a different stamp) may re-add it.
        continue
      }
      const node = descriptor.materialize()
      materialized.push(descriptor.key)
      const view = View.from({ main: ui.col({ key: 'transcript', gap: 'none' }, node) })
      const tree = view.regions[0]?.children[0]
      if (tree === undefined) throw new MainJournalInvariantError(`block ${JSON.stringify(descriptor.key)} materialized no root`)
      onMaterialized?.(descriptor.key, node, tree)
      if (known === undefined) {
        this.#roots.set(descriptor.key, {
          key: descriptor.key,
          id: tree.id,
          stamp: descriptor.stamp,
          view,
          wire: tree.wire(),
          attached: false,
          settled: false,
          gone: false,
        })
        continue
      }
      if (known.id !== tree.id) {
        throw new MainJournalInvariantError(`block ${JSON.stringify(descriptor.key)} changed its derived id ${known.id} -> ${tree.id}`)
      }
      // Tern withdraws the settled hint of a node it is asked to change, so the
      // journal re-settles only after a later eligible commit.
      known.settled = false
      if (known.gone) {
        // An evicted root never receives `set`/`text`: it is re-added whole.
        known.stamp = descriptor.stamp
        known.view = view
        known.wire = tree.wire()
        known.gone = false
        continue
      }
      if (known.attached && known.view !== undefined) {
        const ops = known.view.ops(view, this.#surface.id)
        this.#validateRootOps(ops, known.id)
        pending.push(...ops)
      }
      known.stamp = descriptor.stamp
      known.view = view
    }

    // Deletions FIRST: a root no longer in the projection leaves the client.
    const removed: string[] = []
    for (const key of [...this.#roots.keys()]) {
      if (seen.has(key)) continue
      const record = this.#roots.get(key)!
      removed.push(key)
      if (record.attached) pending.push(['del', record.id])
      this.#roots.delete(key)
    }
    // Placement with the SDK's own rule: from the LAST child back, each new or
    // out-of-order root is placed before its next ATTACHED sibling.
    const previous = new Map<string, number>()
    this.#order.forEach((key, at) => previous.set(key, at))
    const kept = nextOrder.filter(key => previous.has(key) && this.#roots.get(key)?.attached === true)
    const stay = new Set<string>()
    {
      const positions = kept.map(key => previous.get(key)!)
      for (const index of rising(positions)) stay.add(kept[index]!)
    }
    const placement: Op[] = []
    // A contiguous run of NEW roots at the TAIL is appended in document order:
    // `before: null` means "append", so no sibling id has to exist yet and the
    // wire insertion order matches the reading order. Any other new root is
    // placed by the SDK's last-to-first rule below, which can always name an
    // existing next sibling.
    const tailStart = (() => {
      let index = nextOrder.length
      while (index > 0) {
        const record = this.#roots.get(nextOrder[index - 1]!)
        if (record === undefined || record.attached || record.gone) break
        index -= 1
      }
      return index
    })()
    let nextId: string | null = null
    for (let index = nextOrder.length - 1; index >= tailStart; index -= 1) {
      const key = nextOrder[index]!
      const record = this.#roots.get(key)
      if (record === undefined) throw new MainJournalInvariantError(`missing record for ${JSON.stringify(key)}`)
      if (record.wire === undefined) {
        const tree = record.view?.regions[0]?.children[0]
        if (tree === undefined) throw new MainJournalInvariantError(`block ${JSON.stringify(key)} has no wire subtree`)
        record.wire = tree.wire()
      }
      placement.push(['add', record.id, 'main', null, record.wire])
      record.attached = true
      record.wire = undefined
    }
    if (tailStart < nextOrder.length) {
      placement.reverse()
      const afterTail = nextOrder[tailStart]
      nextId = afterTail === undefined ? null : this.#roots.get(afterTail)?.id ?? null
    }
    for (let index = tailStart - 1; index >= 0; index -= 1) {
      const key = nextOrder[index]!
      const record = this.#roots.get(key)
      if (record === undefined) throw new MainJournalInvariantError(`missing record for ${JSON.stringify(key)}`)
      if (!record.gone && !record.attached) {
        if (record.wire === undefined) {
          const tree = record.view?.regions[0]?.children[0]
          if (tree === undefined) throw new MainJournalInvariantError(`block ${JSON.stringify(key)} has no wire subtree`)
          record.wire = tree.wire()
        }
        placement.push(['add', record.id, 'main', nextId, record.wire])
        record.attached = true
        record.wire = undefined
      } else if (record.attached && previous.has(key) && !stay.has(key)) {
        placement.push(['move', record.id, 'main', nextId])
      }
      if (record.attached) nextId = record.id
    }
    // ONE frame: the SDK's own child-diff order is deletions first, then each
    // root's last-to-first placement and inner diff. Sending them together keeps
    // a preset/source transition ATOMIC on the client (never an intermediate
    // frame with the old rows gone and the new rows not yet added).
    const ops = [...pending, ...placement]
    if (ops.length > 0) this.#surface.send(ops)
    this.#order = nextOrder
    return { materialized, removed, ops: ops.length }
  }

  /**
   * Settle the given root keys. Only an attached, still-current root that was
   * not already settled is sent; the caller owns the immutable proof.
   */
  settle(keys: Iterable<string>): void {
    const ops: Op[] = []
    for (const key of keys) {
      const record = this.#roots.get(key)
      if (record === undefined || !record.attached || record.gone || record.settled) continue
      ops.push(['settle', record.id])
      record.settled = true
    }
    if (ops.length > 0) this.#surface.send(ops)
  }

  /**
   * Retire the roots the client reported as gone. An evicted root is removed
   * from the operable set (and its retained view description), but its key and
   * order stay known so a FUTURE real mutation can re-add the whole subtree
   * under the same key. Nothing is re-fetched or re-projected from history.
   */
  retireGone(ids: Iterable<string>): readonly string[] {
    const retired: string[] = []
    const byId = new Map<string, RootRecord>()
    for (const record of this.#roots.values()) byId.set(record.id, record)
    for (const id of ids) {
      const record = byId.get(id)
      if (record === undefined) continue
      record.attached = false
      record.gone = true
      record.settled = false
      record.view = undefined
      record.wire = undefined
      retired.push(record.key)
    }
    if (retired.length > 0) {
      this.#order = this.#order.filter(key => {
        const record = this.#roots.get(key)
        return record === undefined || !retired.includes(key)
      })
    }
    return retired
  }

  /** Whether one block key is currently attached to the client. */
  isAttached(key: string): boolean {
    return this.#roots.get(key)?.attached === true
  }

  /**
   * Remove every Main child the journal owns, keeping the SDK view untouched.
   * Used when a DIFFERENT formal Main (the Welcome) takes the region: the
   * client must not keep both trees.
   */
  detachAll(): void {
    const ops: Op[] = []
    for (const key of this.#order) {
      const record = this.#roots.get(key)
      if (record === undefined || !record.attached) continue
      ops.push(['del', record.id])
      record.attached = false
    }
    if (ops.length > 0) this.#surface.send(ops)
    this.#roots.clear()
    this.#order = []
  }

  /** Forget every root without sending anything (the surface is closing). */
  reset(): void {
    this.#roots.clear()
    this.#order = []
  }

  /**
   * Every op of a retained-root diff must stay inside that root's own subtree:
   * a `main`-level op would silently re-parent or delete another root, so it is
   * rejected instead of painting a frame nobody can trust.
   */
  #validateRootOps(ops: readonly Op[], rootId: string): void {
    const inside = (id: string): boolean => id === rootId || id.startsWith(`${rootId}.`)
    for (const op of ops) {
      switch (op[0]) {
        case 'add':
        case 'move':
          if (!inside(op[1])) throw new MainJournalInvariantError(`op ${op[0]} targets foreign node ${op[1]}`)
          if (!inside(op[2]) && op[2] !== rootId) throw new MainJournalInvariantError(`op ${op[0]} parents under ${op[2]}`)
          break
        case 'set':
        case 'text':
        case 'del':
        case 'settle':
          if (!inside(op[1])) throw new MainJournalInvariantError(`op ${op[0]} targets foreign node ${op[1]}`)
          break
        default:
          throw new MainJournalInvariantError(`unexpected op ${op[0]} in a single-root diff`)
      }
    }
  }
}

/** The wire subtree of one node, for tests and external diff assertions. */
export function wireOfNode(node: Node): WireNode {
  const view = View.from({ main: ui.col({ key: 'transcript', gap: 'none' }, node) })
  const tree: Tree | undefined = view.regions[0]?.children[0]
  if (tree === undefined) throw new MainJournalInvariantError('node materialized no root')
  return tree.wire()
}
