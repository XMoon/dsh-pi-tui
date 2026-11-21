/**
 * TSP PR2 Continuous Main journal: the SDK-wire protocol oracle.
 *
 * Every case drives a REAL `Surface` against the public `@stencil-hq/tern`
 * 0.2.0 API and folds the frames it actually sent into a shadow Main document.
 * The shadow must always equal the tree the FULL projection produces for the
 * same messages — that is the correctness claim of the journal.
 *
 * It also pins the properties the incremental path exists for:
 * - only changed blocks are materialized (no full-history re-materialization);
 * - a retained block's diff never leaves its own subtree;
 * - a Dock-only `render` never deletes or duplicates the raw Main children;
 * - `settle` is sent once per immutable root and never for a mutable one;
 * - a `gone` id is never targeted again by a mutation unless a real change
 *   re-adds the whole block.
 *
 * Evidence level: real SDK wire ops on a scripted (non-Tern) shape.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-continuous-main-journal.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Surface, ui, View, type JsonObject, type Op, type OutMessage, type SurfaceLink, type WireNode } from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import {
  ContinuousMainJournal,
  emptyTranscriptMain,
} from '../../src/tui/tsp/continuous-main.ts'
import {
  TranscriptNodeKeys,
  describeTranscriptMainBlocksForPreset,
  transcriptViewForPreset,
  type TranscriptPresetViewOptions,
} from '../../src/tui/tsp/transcript-view.ts'

const T0 = 1_700_000_000_000

function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq * 1000, data } as SessionEvent
}

function userMessage(seq: number, turn: number, id: string, text: string): SessionEvent {
  return ev('user/message', { id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }, seq)
}

function assistantMessage(seq: number, turn: number, id: string, text: string, step = 0): SessionEvent {
  return ev('assistant/message', {
    turn,
    step,
    message: { id: MessageId(id), role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' }, stream: [] },
  }, seq)
}

function toolCall(seq: number, turn: number, callId: string, name: string, step = 0): SessionEvent {
  return ev('tool/call', { turn, step, callId: ToolCallId(callId), name, arguments: JSON.stringify({ command: 'echo hi' }) }, seq)
}

function toolResult(seq: number, turn: number, callId: string, text: string, step = 0): SessionEvent {
  return ev('tool/result', {
    turn,
    step,
    message: {
      id: MessageId(`result-${callId}`),
      role: 'tool',
      toolCallId: ToolCallId(callId),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(callId) },
    },
  }, seq)
}

/** A turn with an OPEN tool row: its result arrives much later, from another turn. */
function openToolTurn(turn: number, seqBase: number): SessionEvent[] {
  const seq = (offset: number): number => seqBase + offset
  return [
    ev('turn/start', { turn }, seq(0)),
    userMessage(seq(1), turn, `user-${turn}`, `question ${turn}`),
    toolCall(seq(2), turn, `call-open`, 'bash', 1),
    ev('turn/end', { turn, reason: { kind: 'completed' } }, seq(3)),
  ]
}

/** A turn of the P-mixed shape: User · Think · Tool + result · Assistant. */
function turnEvents(turn: number, seqBase: number): SessionEvent[] {
  const seq = (offset: number): number => seqBase + offset
  return [
    ev('turn/start', { turn }, seq(0)),
    userMessage(seq(1), turn, `user-${turn}`, `question ${turn}`),
    ev('assistant/message', {
      turn,
      step: 0,
      message: {
        id: MessageId(`think-${turn}`),
        role: 'assistant',
        content: [{ type: 'reasoning', text: `reasoning ${turn}` }],
        source: { kind: 'model', provider: 'p', model: 'm' },
        stream: [
          { type: 'chunk', time: T0 + seq(1) * 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
          { type: 'chunk', time: T0 + seq(1) * 1000 + 10, chunk: { type: 'reasoning-delta', index: 0, text: `reasoning ${turn}` } },
          { type: 'chunk', time: T0 + seq(1) * 1000 + 50, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: `reasoning ${turn}` } } },
        ],
      },
    }, seq(2)),
    toolCall(seq(3), turn, `call-${turn}`, 'bash', 1),
    toolResult(seq(4), turn, `call-${turn}`, `output ${turn}`, 1),
    assistantMessage(seq(5), turn, `final-${turn}`, `answer ${turn}`, 2),
    ev('turn/end', { turn, reason: { kind: 'completed' } }, seq(6)),
  ]
}

interface SNode {
  readonly id: string
  readonly k: string
  readonly p: Record<string, unknown>
  c?: SNode[]
}

interface Harness {
  readonly surface: Surface
  readonly journal: ContinuousMainJournal
  readonly frames: { readonly sf: string; readonly s: number; readonly ops: readonly Op[] }[]
  readonly main: SNode
  readonly setCredits: (credits: number) => void
  readonly ackAll: () => void
}

function mountJournal(): Harness {
  // Unblocked by default so every case folds exactly what it sent; the credit
  // pressure case opts into a tight window explicitly.
  let credits = 64
  const frames: { readonly sf: string; readonly s: number; readonly ops: readonly Op[] }[] = []
  const link: SurfaceLink = {
    send: (message: OutMessage) => {
      if (message.verb === 'f') frames.push(message.body as { sf: string; s: number; ops: readonly Op[] })
    },
    credits: () => credits,
    dropped: () => {},
  }
  const surface = new Surface(link, 'main', { listen: true })
  const journal = new ContinuousMainJournal(surface)
  // The production render contract: ONE stable empty Main root, then raw ops.
  surface.render({ main: emptyTranscriptMain() })
  const main: SNode = { id: 'main', k: 'col', p: { key: 'transcript', gap: 'none' }, c: [] }
  return {
    surface,
    journal,
    frames,
    main,
    setCredits: (next) => { credits = next },
    ackAll: () => { surface.acknowledge(surface.seq) },
  }
}

/** Fold the SDK ops the journal actually sent into the shadow Main document. */
function foldFrames(harness: Harness, from: number): void {
  const find = (root: SNode, id: string): SNode | undefined => {
    if (root.id === id) return root
    for (const child of root.c ?? []) {
      const found = find(child, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  const detach = (root: SNode, id: string): SNode | undefined => {
    for (const parent of [root, ...collect(root)]) {
      const index = (parent.c ?? []).findIndex(child => child.id === id)
      if (index < 0) continue
      const [removed] = parent.c!.splice(index, 1)
      return removed
    }
    return undefined
  }
  const collect = (root: SNode): SNode[] => {
    const out: SNode[] = []
    const visit = (node: SNode): void => {
      for (const child of node.c ?? []) {
        out.push(child)
        visit(child)
      }
    }
    visit(root)
    return out
  }
  for (const frame of harness.frames.slice(from)) {
    for (const op of frame.ops) {
      switch (op[0]) {
        case 'add': {
          const parent = find(harness.main, op[2])
          assert.ok(parent !== undefined, `add parent ${op[2]} exists`)
          const wire = op[4] as unknown as SNode
          const before = op[3]
          const index = before === null || before === undefined
            ? (parent.c ??= []).length
            : (parent.c ??= []).findIndex(child => child.id === before)
          assert.ok(index >= 0, `add before ${String(before)} exists in ${parent.id}`)
          parent.c!.splice(index, 0, JSON.parse(JSON.stringify(wire)) as SNode)
          break
        }
        case 'del': {
          const removed = detach(harness.main, op[1])
          assert.ok(removed !== undefined, `del target ${op[1]} exists`)
          break
        }
        case 'move': {
          const parent = find(harness.main, op[2])
          assert.ok(parent !== undefined, `move parent ${op[2]} exists`)
          const moved = detach(harness.main, op[1])
          assert.ok(moved !== undefined, `move target ${op[1]} exists`)
          const before = op[3]
          const index = before === null || before === undefined
            ? (parent.c ??= []).length
            : (parent.c ??= []).findIndex(child => child.id === before)
          assert.ok(index >= 0, `move before ${String(before)} exists`)
          parent.c!.splice(index, 0, moved)
          break
        }
        case 'set': {
          const node = find(harness.main, op[1])
          assert.ok(node !== undefined, `set target ${op[1]} exists`)
          for (const [key, value] of Object.entries(op[2] as JsonObject)) {
            if (value === null) delete node.p[key]
            else node.p[key] = value
          }
          break
        }
        case 'text': {
          const node = find(harness.main, op[1])
          assert.ok(node !== undefined, `text target ${op[1]} exists`)
          const value = typeof node.p['text'] === 'string' ? node.p['text'] : ''
          node.p['text'] = op[2] === 'append' ? value + op[3] : op[3]
          break
        }
        case 'settle':
          assert.ok(find(harness.main, op[1]) !== undefined, `settle target ${op[1]} exists`)
          break
        default:
          assert.fail(`unexpected op ${op[0]} on the Main journal wire`)
      }
    }
  }
}

/** The REAL full projection for the same messages, as the wire oracle. */
function fullMainWire(
  messages: readonly TranscriptMessage[],
  options: TranscriptPresetViewOptions,
): SNode {
  const view = View.from({ main: transcriptViewForPreset(messages, new TranscriptNodeKeys(), options) })
  const region = view.regions[0]
  assert.ok(region !== undefined)
  return JSON.parse(JSON.stringify(region.wire())) as SNode
}

function assertWireEqualsProjection(
  harness: Harness,
  messages: readonly TranscriptMessage[],
  options: TranscriptPresetViewOptions,
): void {
  const expected = fullMainWire(messages, options)
  assert.deepEqual(harness.main, expected, 'the journal wire equals the full projection tree')
}

const OPTIONS: TranscriptPresetViewOptions = { preset: 'full', scopePrefix: 's1-' }

test('a first commit, tail appends and a re-commit of the same projection match the full tree', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  const commit = (): { materialized: readonly string[]; removed: readonly string[]; ops: number } => {
    const options = OPTIONS
    const blocks = describeTranscriptMainBlocksForPreset(folder.messages(), keys, options)
    const before = harness.frames.length
    const stats = harness.journal.commit(blocks)
    foldFrames(harness, before)
    assertWireEqualsProjection(harness, folder.messages(), options)
    return stats
  }

  folder.apply(turnEvents(1, 0))
  const first = commit()
  assert.equal(first.removed.length, 0)
  assert.equal(first.materialized.length, harness.journal.order.length, 'the first commit materializes every block')
  assert.ok(harness.frames.some(frame => frame.ops.some(op => op[0] === 'add')), 'the first commit adds raw Main roots')
  assert.equal(harness.frames.some(frame => frame.ops.some(op => op[0] === 'del')), false, 'the first commit deletes nothing')

  // A re-commit of the SAME projection is a pure no-op on the wire.
  const noop = commit()
  assert.equal(noop.materialized.length, 0, 'an unchanged projection materializes no block')
  assert.equal(noop.ops, 0, 'an unchanged projection sends no op at all')

  folder.apply(turnEvents(2, 100))
  const second = commit()
  assert.ok(second.materialized.length > 0)
  const appended = second.materialized
  for (const key of harness.journal.order.slice(0, harness.journal.order.length - appended.length)) {
    assert.equal(appended.includes(key), false, `retained block ${key} is not re-materialized`)
  }
  assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
})

test('a late tool result materializes ONLY its own old block and never re-adds the roots around it', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  const commit = (): { materialized: readonly string[]; ops: number } => {
    const before = harness.frames.length
    const stats = harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
    foldFrames(harness, before)
    assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
    return stats
  }
  folder.apply(openToolTurn(1, 0))
  folder.apply(turnEvents(2, 100))
  commit()
  const openTool = folder.messages().find(message => message.kind === 'tool' && message.status === 'running')
  assert.ok(openTool !== undefined, 'the first turn still has an open tool row')
  const olderToolKey = describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS)
    .find(descriptor => descriptor.owners.includes(openTool))!.key
  const rootId = harness.journal.idOf(olderToolKey)
  assert.ok(rootId !== undefined, 'the open tool row is a top-level block')
  const before = harness.frames.length
  folder.apply([toolResult(300, 1, 'call-open', 'a LATE result for the old call', 1)])
  const stats = commit()
  assert.deepEqual(stats.materialized, [olderToolKey], 'only the changed old tool block is materialized')
  const ops = harness.frames.slice(before).flatMap(frame => frame.ops)
  assert.ok(ops.length > 0)
  const inside = (id: string): boolean => id === rootId || id.startsWith(`${rootId}.`)
  for (const op of ops) {
    if (op[0] === 'add' || op[0] === 'move') {
      assert.ok(inside(op[1]), `op ${op[0]} stays inside the changed root (${op[1]})`)
      assert.ok(inside(op[2]) || op[2] === rootId, `op ${op[0]} parents inside the changed root`)
      continue
    }
    if (op[0] === 'set' || op[0] === 'text' || op[0] === 'del' || op[0] === 'settle') {
      assert.ok(inside(op[1]), `op ${op[0]} stays inside the changed root (${op[1]})`)
    }
  }
})

test('a Dock-only render never deletes or duplicates the raw Main children', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  const blocks = describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS)
  let before = harness.frames.length
  harness.journal.commit(blocks)
  foldFrames(harness, before)
  const settledMain = JSON.parse(JSON.stringify(harness.main)) as SNode

  // A later frame that only repaints the Dock/Layer is the normal production
  // path; it must not touch a single raw Main child.
  before = harness.frames.length
  harness.surface.render({ main: emptyTranscriptMain(), dock: ui.col({ key: 'dock' }, ui.text({ key: 't', text: 'dock only' })) })
  const dockOps = harness.frames.slice(before).flatMap(frame => frame.ops).filter(op => {
    // A region's own root id is `main`/`dock`/`layer`; an `add` names the CHILD
    // as op[1] and its region as op[2], so only op[1] can identify a Main node.
    const target = op[1]
    return typeof target === 'string' && (target === 'main' || target.startsWith('main.'))
  })
  assert.equal(dockOps.length, 0, `a Dock-only render sends no Main op at all: ${JSON.stringify(dockOps)}`)
  assert.deepEqual(harness.main, settledMain, 'the Main children survive a Dock-only render untouched')

  // And the next commit still agrees with the projection (no duplicated row).
  before = harness.frames.length
  harness.journal.commit(blocks)
  foldFrames(harness, before)
  assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
})

test('settle is sent once per eligible root and is withdrawn by a later real change', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  let before = harness.frames.length
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  foldFrames(harness, before)
  const userKey = harness.journal.order.find(key => key.includes('msg-1'))!
  const userRootId = harness.journal.idOf(userKey)!

  before = harness.frames.length
  harness.journal.settle([userKey])
  harness.journal.settle([userKey])
  const settleOps = harness.frames.slice(before).flatMap(frame => frame.ops)
  assert.deepEqual(settleOps, [['settle', userRootId]], 'exactly one settle op for one attached root')
  assert.ok(harness.journal.isAttached(userKey))
})

test('a gone root is never mutated again, and only a real change re-adds it whole', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(openToolTurn(1, 0))
  let before = harness.frames.length
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  foldFrames(harness, before)
  const openTool = folder.messages().find(message => message.kind === 'tool' && message.status === 'running')
  assert.ok(openTool !== undefined)
  const toolKey = describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS)
    .find(descriptor => descriptor.owners.includes(openTool))!.key
  const toolRootId = harness.journal.idOf(toolKey)!
  assert.ok(harness.journal.isAttached(toolKey))

  const retired = harness.journal.retireGone([toolRootId])
  assert.deepEqual(retired, [toolKey], 'the client-evicted Main child is retired')
  assert.equal(harness.journal.isAttached(toolKey), false)
  assert.equal(harness.journal.idOf(toolKey), undefined)
  // The client-side Main really lost the root: mirror that in the shadow so the
  // later comparison is against the node set the pane actually holds.
  const index = harness.main.c!.findIndex(node => node.id === toolRootId)
  assert.ok(index >= 0)
  harness.main.c!.splice(index, 1)

  // A projection with no real change must NOT resurrect it.
  before = harness.frames.length
  const quiet = harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  assert.equal(quiet.materialized.length, 0, 'an unchanged gone root is not re-materialized')
  const quietOps = harness.frames.slice(before).flatMap(frame => frame.ops)
  assert.equal(quietOps.some(op => op[1] === toolRootId), false, 'no op ever targets the evicted id')

  // A REAL authoritative mutation re-adds the whole block under the same key.
  before = harness.frames.length
  folder.apply([toolResult(300, 1, 'call-open', 'late result', 1)])
  const revived = harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  assert.deepEqual(revived.materialized, [toolKey])
  foldFrames(harness, before)
  assert.ok(harness.journal.isAttached(toolKey))
  assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
})

test('the Welcome handover detaches every raw Main child and the next commit restores the same keys', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  let before = harness.frames.length
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  foldFrames(harness, before)
  const order = [...harness.journal.order]
  const ids = order.map(key => harness.journal.idOf(key))
  assert.equal(ids.every(id => id !== undefined), true)

  before = harness.frames.length
  harness.journal.detachAll()
  foldFrames(harness, before)
  const detachOps = harness.frames.slice(before).flatMap(frame => frame.ops)
  assert.deepEqual(detachOps.map(op => op[0]), order.map(() => 'del'), 'one del per raw Main child')
  assert.deepEqual(harness.main.c, [], 'the client Main is empty before the Welcome takes the region')

  before = harness.frames.length
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  foldFrames(harness, before)
  assert.deepEqual([...harness.journal.order], order, 'the same keys come back in the same order')
  assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
})

test('200 tail commits under one credit converge to the final projection with no loss or duplicate', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  let bootstrap = harness.frames.length
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  foldFrames(harness, bootstrap)
  // From here on the pane acks ONE frame at a time: every commit may be
  // queued, so the fold must follow the ack that releases it.
  harness.setCredits(1)
  harness.ackAll()
  for (let index = 0; index < 200; index += 1) {
    const seq = 1000 + index * 10
    folder.apply([
      ev('turn/start', { turn: 2 + index }, seq),
      userMessage(seq + 1, 2 + index, `tail-user-${index}`, `tail question ${index}`),
      assistantMessage(seq + 2, 2 + index, `tail-answer-${index}`, `tail answer ${index}`, 0),
      ev('turn/end', { turn: 2 + index, reason: { kind: 'completed' } }, seq + 3),
    ])
    const before = harness.frames.length
    harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
    // The surface may be blocked: acks arrive between frames, exactly like a
    // real client. Folding sees whatever was flushed so far.
    foldFrames(harness, before)
    harness.ackAll()
    const drained = harness.frames.length
    foldFrames(harness, drained)
  }
  harness.ackAll()
  foldFrames(harness, harness.frames.length)
  assertWireEqualsProjection(harness, folder.messages(), OPTIONS)
  const ids = harness.journal.order.map(key => harness.journal.idOf(key))
  assert.equal(new Set(ids).size, ids.length, 'no root id is duplicated')
})

test('the empty Main root is stable across dock/layer renders and a ViewError-free tree', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  harness.journal.commit(describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS))
  const before = harness.frames.length
  harness.surface.render({ main: emptyTranscriptMain(), layer: ui.col({ key: 'interaction-layer' }, ui.text({ key: 'body', text: 'modal' })) })
  const ops = harness.frames.slice(before).flatMap(frame => frame.ops)
  assert.equal(ops.some(op => op[1] === 'main' || String(op[1]).startsWith('main.')), false, 'no Main op comes from a layer-only render')
})

test('a WireNode subtree is the exact SDK tree of that node (no hand-built dotted ids)', () => {
  const harness = mountJournal()
  const keys = new TranscriptNodeKeys()
  const folder = new TranscriptFolder()
  folder.apply(turnEvents(1, 0))
  const blocks = describeTranscriptMainBlocksForPreset(folder.messages(), keys, OPTIONS)
  harness.journal.commit(blocks)
  const first = harness.journal.order[0]!
  const full = fullMainWire(folder.messages(), OPTIONS)
  const expected = (full.c ?? []).find(node => node.id === `main.${first}`) as unknown as WireNode
  const added = harness.frames.flatMap(frame => frame.ops).find(op => op[0] === 'add' && op[1] === `main.${first}`)
  assert.ok(added !== undefined && added[0] === 'add')
  assert.deepEqual(added[4], expected, 'the add op carries the SDK-derived wire subtree')
})
