/**
 * PR1 TSP transcript spike tests.
 *
 * These exercise the REAL code under test: a deterministic replay of genuine
 * `SessionEvent`/live-stream inputs through the production `TranscriptFolder`,
 * the canonical `projectTranscriptStructure()` projection, the PR1 mapper and
 * the actual SDK `View.from`/`View.ops` reconciliation. Nothing here compares a
 * hand-authored node tree against another hand-authored node tree.
 *
 * Evidence classification: the scripted-terminal cases below compose with a
 * SCRIPTED tty (`@stencil-hq/tern`'s documented test shape), not a real Tern
 * binary; real native rendering is the manual smoke recorded in
 * `docs/tern-tsp/evidence/pr1.md`. Neither is repository L5 DSH wire coverage.
 * @module @xmoon76/dsh-pi-tui/tern-tsp-transcript-spike.test
 */

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  KeyDecoder,
  View,
  ViewError,
  connect,
  concatBytes,
  ui,
  type JsonObject,
  type Key,
  type Op,
  type Renderable,
  type SessionInput,
  type TermInput,
  type TermOutput,
  type Tree,
} from '@stencil-hq/tern'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../src/domain/transcript/types.ts'
import { projectTranscriptStructure, type TranscriptStructureBlock } from '../src/tui/transcript/structure.ts'
import { TranscriptNodeKeys, transcriptView } from '../scripts/support/tern-tsp-transcript-view.ts'
import {
  applyReplayStep,
  buildReplaySteps,
  runTernTranscriptSpike,
  type SpikeSession,
  type SpikeSurface,
} from '../scripts/tern-tsp-transcript-spike.mts'

const STEPS = buildReplaySteps()
const T0 = 1_700_000_000_000
const encoder = new TextEncoder()
const decoder = new TextDecoder()

// ── Fixture helpers ────────────────────────────────────────────────────────

/** The repository's ordinary loose event envelope for fixtures. */
function ev(type: string, data: Record<string, unknown>, seq: number): SessionEvent {
  return { type, seq: SessionSeq(seq), time: T0 + seq, data } as SessionEvent
}

function userMessage(seq: number, id: string, text: string, source: Record<string, unknown> = { kind: 'user' }): SessionEvent {
  return ev('user/message', { id: MessageId(id), role: 'user', content: [{ type: 'text', text }], source }, seq)
}

function toolCall(seq: number, id: string, name: string, args: Record<string, unknown>): SessionEvent {
  return ev('tool/call', { turn: 1, step: 0, callId: ToolCallId(id), name, arguments: JSON.stringify(args) }, seq)
}

function toolResult(seq: number, id: string, text: string): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${id}`),
      role: 'tool',
      toolCallId: ToolCallId(id),
      content: [{ type: 'text', text }],
      source: { kind: 'tool', callId: ToolCallId(id) },
    },
  }, seq)
}

/** A folder with replay steps `0..lastStep` applied, in order. */
function folderThrough(lastStep: number): TranscriptFolder {
  const folder = new TranscriptFolder()
  for (let index = 0; index <= lastStep; index += 1) applyReplayStep(folder, STEPS[index]!)
  return folder
}

function rowOf(folder: TranscriptFolder, predicate: (message: TranscriptMessage) => boolean): TranscriptMessage {
  const row = folder.messages().find(predicate)
  assert.ok(row !== undefined, 'fixture row exists')
  return row
}

interface FlatNode {
  readonly id: string
  readonly kind: string
  readonly props: JsonObject
  readonly parent: string | undefined
}

/** Every node of the `main` region, parents first. */
function flatten(view: View): FlatNode[] {
  const out: FlatNode[] = []
  const visit = (tree: Tree, parent: string | undefined): void => {
    out.push({ id: tree.id, kind: tree.kind, props: tree.props, parent })
    for (const child of tree.children) visit(child, tree.id)
  }
  const root = view.regions[0]
  if (root) visit(root, undefined)
  return out
}

function nodeOf(view: View, id: string): FlatNode {
  const node = flatten(view).find(candidate => candidate.id === id)
  assert.ok(node !== undefined, `node ${id} exists`)
  return node
}

/** The view of one folder through the mapper, with a caller-owned key scope. */
function viewOf(folder: TranscriptFolder, keys: TranscriptNodeKeys): View {
  return View.from({ main: transcriptView(projectTranscriptStructure(folder.messages()), keys) })
}

/** The primary target id of an op (`suspend`/`resume` carry none). */
function opTarget(op: Op): string | undefined {
  switch (op[0]) {
    case 'suspend':
    case 'resume':
      return undefined
    default:
      return op[1] ?? undefined
  }
}

function opIds(ops: readonly Op[], verb: Op[0]): Set<string | undefined> {
  return new Set(ops.filter(op => op[0] === verb).map(op => opTarget(op)))
}

function keyInput(name: string, ctrl = false): SessionInput {
  const key: Key = { name, ctrl, alt: false, shift: false, meta: false }
  return { type: 'key', key }
}

function structureKinds(blocks: readonly TranscriptStructureBlock[]): string[] {
  return blocks.map(block => block.kind === 'message' ? `message:${block.message.kind}` : block.kind)
}

// ── T3: real fold -> canonical projection -> native view ───────────────────

test('T3: the replay fold projects the canonical Work/Context/standalone structure', () => {
  const folder = folderThrough(STEPS.length - 1)
  assert.deepEqual(structureKinds(projectTranscriptStructure(folder.messages())), [
    'message:user',
    'work',
    'message:assistant',
    'context-cluster',
    'work',
    'message:tool',
    'message:command',
    'message:tool',
  ])
})

test('T3: the mapper renders the projected blocks as native TSP nodes with real content', () => {
  const folder = folderThrough(STEPS.length - 1)
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const nodes = flatten(view)

  const user = rowOf(folder, message => message.kind === 'user')
  const assistant = rowOf(folder, message => message.kind === 'assistant')
  const userNode = nodeOf(view, `main.${keys.keyFor(user)}`)
  assert.equal(userNode.kind, 'card')
  assert.equal(nodeOf(view, `${userNode.id}.body`).props['text'], 'Inspect the transcript projector boundary.')

  const assistantNode = nodeOf(view, `main.${keys.keyFor(assistant)}`)
  assert.equal(assistantNode.kind, 'card')
  assert.equal(assistantNode.props['head'], 'Assistant')
  assert.equal(
    nodeOf(view, `${assistantNode.id}.body`).props['text'],
    'The canonical structure is the only segmentation authority.',
  )

  // Two native Work containers, each keyed by its canonical span owner, and
  // each holding its own members.
  const workContainers = nodes.filter(node => node.kind === 'section')
  assert.equal(workContainers.length, 2)
  for (const container of workContainers) {
    assert.match(container.id, /^main\.work-msg-\d+$/)
    assert.ok(nodes.some(node => node.parent === container.id), `${container.id} has members`)
  }

  // One Context cluster whose head is the canonical structured summary.
  const clusterOwner = rowOf(folder, message => message.kind === 'system' && message.label === 'AGENTS.md')
  const clusterNode = nodeOf(view, `main.ctx-${keys.keyFor(clusterOwner)}`)
  assert.equal(clusterNode.kind, 'card')
  assert.equal(clusterNode.props['head'], 'AGENTS.md · skill-catalog')
})

// ── T5: incremental ops ────────────────────────────────────────────────────

test('T5: a text/status update sends a small delta and preserves unaffected node ids', () => {
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  applyReplayStep(folder, STEPS[0]!)
  applyReplayStep(folder, STEPS[1]!)
  const before = viewOf(folder, keys)
  const retained = new Set(flatten(before).map(node => node.id))

  const user = rowOf(folder, message => message.kind === 'user')
  const thinking = rowOf(folder, message => message.kind === 'thinking')
  const tool = rowOf(folder, message => message.kind === 'tool')
  const userNodeId = `main.${keys.keyFor(user)}`
  const workId = `main.work-${keys.keyFor(thinking)}`
  const thinkingId = `${workId}.${keys.keyFor(thinking)}`
  const toolId = `${workId}.${keys.keyFor(tool)}`
  assert.ok(retained.has(userNodeId), 'the user node is in the first view')
  assert.equal(nodeOf(before, `${thinkingId}.body`).props['text'], 'checking the projector')
  assert.equal(nodeOf(before, toolId).props['status'], 'running')

  applyReplayStep(folder, STEPS[2]!)
  const after = viewOf(folder, keys)
  const ops: Op[] = before.ops(after, 's1')

  assert.equal(ops.filter(op => op[0] === 'del').length, 0, 'no deletions')
  assert.equal(ops.filter(op => op[0] === 'move').length, 0, 'no moves')
  for (const id of opIds(ops, 'add')) assert.ok(!retained.has(id!), `added node ${id} is genuinely new`)
  const touched = new Set([...opIds(ops, 'add'), ...opIds(ops, 'del'), ...opIds(ops, 'set'), ...opIds(ops, 'text')])
  assert.ok(!touched.has(userNodeId), 'the untouched user card is never rewritten')
  assert.ok(!touched.has(workId), 'the Work container itself is never rewritten')

  // Growing reasoning text is an SDK append on the retained text node.
  const textOps = ops.filter(op => op[0] === 'text')
  assert.equal(textOps.length, 1)
  const textOp = textOps[0]!
  assert.equal(textOp[0], 'text')
  assert.equal(textOp[1], `${thinkingId}.body`)
  assert.equal(textOp[2], 'append')
  assert.equal(textOp[3], ' boundaries and the ambient clusters')

  // The settled tool status is a single `set` on the retained tool node.
  const toolSet = ops.find(op => op[0] === 'set' && op[1] === toolId)
  assert.ok(toolSet !== undefined && toolSet[0] === 'set')
  assert.deepEqual(toolSet[2], { status: 'done' })
})

test('T5: re-rendering the same fold emits no ops at all', () => {
  const folder = folderThrough(2)
  const keys = new TranscriptNodeKeys()
  assert.deepEqual(viewOf(folder, keys).ops(viewOf(folder, keys), 's1'), [])
})

// ── T4 / T8: classification, boundaries and special families ───────────────

test('T4: a non-ambient Work boundary flushes the ambient cluster instead of joining it', () => {
  const folder = folderThrough(STEPS.length - 1)
  const blocks = projectTranscriptStructure(folder.messages())
  const cluster = blocks.find(block => block.kind === 'context-cluster')
  assert.ok(cluster !== undefined && cluster.kind === 'context-cluster')
  assert.equal(cluster.cluster.members.length, 2)
  assert.deepEqual(cluster.cluster.members.map(member => member.kind), ['system', 'system'])

  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const clusterNode = nodeOf(view, `main.ctx-${keys.keyFor(cluster.cluster.owner)}`)
  const members = flatten(view).filter(node => node.parent === clusterNode.id)
  assert.equal(members.length, 2, 'the cluster contains exactly its two raw members')
})

test('T8: a settled interaction and a slash command stay outside every Work span', () => {
  const folder = folderThrough(STEPS.length - 1)
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const interaction = rowOf(folder, message => message.kind === 'tool' && message.name === 'ask_user_question')
  const command = rowOf(folder, message => message.kind === 'command')

  const workIds = new Set(flatten(view).filter(node => node.kind === 'section').map(node => node.id))
  for (const row of [interaction, command]) {
    const node = nodeOf(view, `main.${keys.keyFor(row)}`)
    assert.equal(node.parent, 'main', `${row.kind} row is a standalone root child`)
    assert.ok(!workIds.has(node.parent ?? ''))
  }

  const commandNode = nodeOf(view, `main.${keys.keyFor(command)}`)
  assert.equal(commandNode.kind, 'card')
  assert.equal(commandNode.props['head'], '/status')
  assert.equal(commandNode.props['status'], 'done')
  assert.equal(nodeOf(view, `${commandNode.id}.body`).props['text'], 'session healthy')
})

test('T8: a post-turn replay result is honest diagnostic evidence, never a fabricated success', () => {
  const folder = folderThrough(STEPS.length - 1)
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const orphan = rowOf(folder, message => message.kind === 'tool' && message.result === 'late replay evidence')
  assert.equal(orphan.kind === 'tool' ? orphan.callCount : undefined, 0, 'orphan result carries zero genuine calls')

  const node = nodeOf(view, `main.${keys.keyFor(orphan)}`)
  assert.equal(node.kind, 'card', 'not a `tool` node claiming a completed execution')
  assert.equal(node.props['status'], undefined)
  assert.equal(nodeOf(view, `${node.id}.provenance`).props['text'], 'unmatched result')

  const block = projectTranscriptStructure(folder.messages()).find(
    candidate => candidate.kind === 'message' && candidate.message === orphan,
  )
  assert.ok(block !== undefined, 'the orphan row is a standalone message block, not Work membership')
})

test('T8: a Context row renders the helper-stripped body and its source kind, never raw envelope XML', () => {
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  folder.apply([ev('turn/start', { turn: 1 }, 0)])
  folder.apply([ev('user/message', {
    id: MessageId('ctx-reminder'),
    role: 'user',
    content: [{ type: 'text', text: '<system-reminder>\nkeep the spike standalone\n</system-reminder>' }],
    source: { kind: 'plugin', form: 'instructions', plugin: 'spike-plugin' },
  }, 1)])

  const row = rowOf(folder, message => message.kind === 'system')
  const view = viewOf(folder, keys)
  const node = nodeOf(view, `main.${keys.keyFor(row)}`)
  assert.equal(nodeOf(view, `${node.id}.body`).props['text'], 'keep the spike standalone')
  assert.equal(nodeOf(view, `${node.id}.kind`).props['text'], 'ambient')
})

// ── T6 / T7: identity limits and sibling uniqueness ────────────────────────

test('T6: a merged read-group replacement changes that card\'s key while neighbours keep theirs', () => {
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  folder.apply([ev('turn/start', { turn: 1 }, 0)])
  folder.apply([userMessage(1, 'u1', 'read two files')])
  folder.apply([toolCall(2, 'call-r1', 'read', { file_path: 'a.ts' })])
  folder.apply([toolResult(3, 'call-r1', '<path>a.ts</path><type>file</type><content>1\tA</content>')])

  const before = viewOf(folder, keys)
  const user = rowOf(folder, message => message.kind === 'user')
  const firstCard = rowOf(folder, message => message.kind === 'tool')
  const userNodeId = `main.${keys.keyFor(user)}`
  // The lone read row is a Work member, so its container id follows the owner key.
  const firstWorkId = `main.work-${keys.keyFor(firstCard)}`

  folder.apply([toolCall(4, 'call-r2', 'read', { file_path: 'b.ts' })])
  folder.apply([toolResult(5, 'call-r2', '<path>b.ts</path><type>file</type><content>1\tB</content>')])

  const merged = rowOf(folder, message => message.kind === 'tool')
  assert.notEqual(merged, firstCard, 'the folder replaces the carrier object with a merged group card')
  assert.equal(merged.kind === 'tool' ? merged.callCount : undefined, 2)
  const ops = before.ops(viewOf(folder, keys), 's1')

  const deleted = opIds(ops, 'del')
  const added = opIds(ops, 'add')
  assert.ok(deleted.has(firstWorkId), 'the replaced carrier\'s Work container is legitimately removed')
  assert.ok(added.has(`main.work-${keys.keyFor(merged)}`), 'and re-added under its new key')
  assert.ok(!deleted.has(userNodeId) && !added.has(userNodeId), 'the untouched user card keeps its identity')
})

test('T6: dynamic Context clustering also rebuilds a retained row\'s node id', () => {
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  folder.apply([ev('turn/start', { turn: 1 }, 0)])
  folder.apply([ev('user/message', {
    id: MessageId('ctx-a'),
    role: 'user',
    content: [{ type: 'text', text: 'AGENTS instructions body' }],
    source: { kind: 'agent-instructions', form: 'instructions', changes: [{ path: 'AGENTS.md' }] },
  }, 1)])

  const before = viewOf(folder, keys)
  const first = rowOf(folder, message => message.kind === 'system')
  const firstKey = keys.keyFor(first)
  assert.equal(nodeOf(before, `main.${firstKey}`).kind, 'card', 'a lone ambient row is standalone')

  // The second raw-adjacent same-turn ambient row makes the projector coalesce
  // BOTH into one cluster: the retained carrier keeps its allocation key but
  // moves under a new parent, so its FULL node id legitimately changes.
  folder.apply([ev('user/message', {
    id: MessageId('ctx-b'),
    role: 'user',
    content: [{ type: 'text', text: 'Skill catalog body' }],
    source: { kind: 'plugin', form: 'catalog', plugin: 'skill-catalog' },
  }, 2)])

  const after = viewOf(folder, keys)
  const cluster = projectTranscriptStructure(folder.messages()).find(block => block.kind === 'context-cluster')
  assert.ok(cluster !== undefined && cluster.kind === 'context-cluster')
  assert.equal(cluster.cluster.owner, first, 'the carrier object is retained')
  assert.equal(keys.keyFor(first), firstKey, 'its allocation key is unchanged')

  const ops = before.ops(after, 's1')
  assert.ok(opIds(ops, 'del').has(`main.${firstKey}`), 'the standalone node is legitimately removed')
  assert.equal(nodeOf(after, `main.ctx-${firstKey}.${firstKey}`).kind, 'card', 'and re-added under the cluster')
})

test('T7: sibling Work spans sharing a turn, and repeated text, never collide', () => {
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  const notice = (seq: number, id: string, text: string): SessionEvent =>
    ev('user/message', {
      id: MessageId(id),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'plugin', form: 'notice', plugin: 'p' },
    }, seq)
  folder.apply([ev('turn/start', { turn: 1 }, 0)])
  folder.apply([notice(1, 'n1', 'same text'), toolCall(2, 'b1', 'bash', { command: 'echo one' })])
  folder.apply([notice(3, 'n2', 'same text'), toolCall(4, 'b2', 'bash', { command: 'echo one' })])

  const spans = projectTranscriptStructure(folder.messages()).filter(block => block.kind === 'work')
  assert.equal(spans.length, 2, 'two Work spans share turn 1')
  const view = viewOf(folder, keys)
  const ids = flatten(view).map(node => node.id)
  assert.equal(new Set(ids).size, ids.length, 'View.from accepted the view and every id is unique')

  const containers = flatten(view).filter(node => node.kind === 'section')
  assert.equal(containers.length, 2)
  assert.notEqual(containers[0]!.id, containers[1]!.id)

  // Negative control: the uniqueness claim is discriminating — duplicate
  // sibling keys really are rejected by the SDK.
  assert.throws(
    () => View.from({ main: ui.col({ key: 'root' }, ui.md({ key: 'same', text: 'a' }), ui.md({ key: 'same', text: 'b' })) }),
    ViewError,
  )
})

// ── T1 / T9: SDK boundary, runner composition and lifecycle ────────────────

class FakeInput extends EventEmitter implements TermInput {
  readonly isTTY: boolean
  isRaw = false
  readonly raw: boolean[] = []

  constructor(isTTY = true) {
    super()
    this.isTTY = isTTY
  }

  setRawMode(mode: boolean): void {
    this.isRaw = mode
    this.raw.push(mode)
  }

  type(text: string): void {
    this.emit('data', encoder.encode(text))
  }
}

class FakeOutput implements TermOutput {
  readonly isTTY = true
  readonly columns = 100
  readonly chunks: Uint8Array[] = []
  onWrite: ((text: string) => void) | undefined

  write(data: Uint8Array | string): boolean {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    this.chunks.push(bytes)
    this.onWrite?.(decoder.decode(bytes))
    return true
  }

  text(): string {
    return decoder.decode(concatBytes(this.chunks))
  }
}

const HELLO = {
  r: 'hello',
  v: 1,
  term: 'tern',
  ver: '0.4.3',
  kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'],
  features: ['flow', 'styles'],
  apc: 65536,
  credits: 2,
  cols: 120,
  cell: { w: 8, h: 17 },
  dark: true,
  reduceMotion: false,
  hour12: false,
}

function tspReply(verb: 'r' | 'e', body: unknown): string {
  return `\x1b_tsp;${verb};${JSON.stringify(body)}\x1b\\`
}

/** A scripted pty: answers the handshake as Tern (or not) and records bytes. */
class ScriptedTerminal {
  readonly input = new FakeInput()
  readonly output = new FakeOutput()
  #frames = 0

  constructor(script: 'tern' | 'da1' | 'silent') {
    this.output.onWrite = text => {
      if (text.includes('\x1b[c')) {
        setTimeout(() => {
          if (script === 'tern') this.input.type(tspReply('r', HELLO) + '\x1b[?62;52;c')
          else if (script === 'da1') this.input.type('\x1b[?62;c')
        }, 1)
        return
      }
      if (!text.includes('\x1b_tsp;f;')) return
      this.#frames += 1
      const frames = this.#frames
      // Step the manual replay once, then quit.
      setTimeout(() => this.input.type(frames === 1 ? 'n' : 'q'), 0)
    }
  }
}

test('T1: the runner reports an unsupported environment and opens no surface', async () => {
  const writes: string[] = []
  let connects = 0
  const result = await runTernTranscriptSpike({
    connect: async () => {
      connects += 1
      return null
    },
    io: { write: text => void writes.push(text) },
  })
  assert.deepEqual(result, { kind: 'unsupported' })
  assert.equal(connects, 1)
  assert.match(writes.join(''), /Tern Surface Protocol unavailable/)
  assert.doesNotMatch(writes.join(''), /closed/)
})

test('T1: the real SDK connect declines every non-Tern environment', async () => {
  const cases: Record<string, string>[] = [
    { TERN_TSP: '0' },
    { TMUX: '/tmp/tmux-1000/default,1,0' },
    { STY: '1234.pts-0.host' },
    { ZELLIJ: '0' },
  ]
  for (const env of cases) {
    const input = new FakeInput()
    const session = await connect({ env, input, output: new FakeOutput(), exitHooks: false, timeout: 20 })
    assert.equal(session, null, `connect declines ${JSON.stringify(env)}`)
    assert.deepEqual(input.raw, [], `${JSON.stringify(env)} never takes the tty`)
  }

  const nonTty = new FakeInput(false)
  assert.equal(await connect({ env: {}, input: nonTty, output: new FakeOutput(), exitHooks: false, timeout: 20 }), null)
  assert.deepEqual(nonTty.raw, [])
})

test('T1/T9: a tty that never answers the handshake fails closed and restores raw mode', async () => {
  const terminal = new ScriptedTerminal('silent')
  const session = await connect({
    env: {},
    input: terminal.input,
    output: terminal.output,
    exitHooks: false,
    timeout: 20,
  })
  assert.equal(session, null, 'no hello reply means unsupported, not a live session')
  assert.deepEqual(terminal.input.raw, [true, false], 'raw mode is entered and restored')
  assert.equal(terminal.input.isRaw, false)
})

test('T9: the real SDK, a scripted Tern tty and the spike compose end to end', async () => {
  const sigintBefore = process.listenerCount('SIGINT')
  const exitBefore = process.listenerCount('exit')
  const terminal = new ScriptedTerminal('tern')
  const writes: string[] = []
  const result = await runTernTranscriptSpike({
    connect: options => connect({
      ...options,
      env: {},
      input: terminal.input,
      output: terminal.output,
      exitHooks: true,
      timeout: 500,
    }),
    io: { write: text => void writes.push(text) },
  })

  assert.deepEqual(result, { kind: 'closed', rendered: 2, steps: STEPS.length })
  const text = terminal.output.text()
  assert.ok(text.includes('\x1b_tsp;f;'), 'the SDK sent view frames')
  assert.ok(text.includes('"k":"card"'), 'the wire frame carries native cards')
  assert.ok(text.includes('"k":"section"'), 'the wire frame carries the native Work section')
  assert.ok(text.includes('"k":"tool"'), 'the wire frame carries the native tool node')
  assert.ok(text.includes('\x1b_tsp;x;'), 'the surface closed with `x`')
  assert.deepEqual(terminal.input.raw, [true, false], 'the tty is restored')
  assert.equal(process.listenerCount('SIGINT'), sigintBefore, 'SDK signal hooks released')
  assert.equal(process.listenerCount('exit'), exitBefore, 'SDK exit hook released')
  assert.match(writes.join(''), /rendered 2 of 7 replay step/)
})

interface StubSessionHandle {
  readonly session: SpikeSession
  readonly renders: Renderable[]
  readonly keepOptions: (boolean | undefined)[]
  readonly closeCalls: () => number
}

function stubSession(inputs: readonly SessionInput[], failRender = false, failSurfaceClose = false): StubSessionHandle {
  const renders: Renderable[] = []
  const keepOptions: (boolean | undefined)[] = []
  let closed = 0
  const surface: SpikeSurface = {
    render(view) {
      if (failRender) throw new Error('render failed')
      renders.push(view)
    },
    async close(options) {
      keepOptions.push(options?.keep)
      if (failSurfaceClose) throw new Error('surface close failed')
    },
  }
  const session: SpikeSession = {
    open: () => surface,
    async close() {
      closed += 1
    },
    async *[Symbol.asyncIterator](): AsyncIterator<SessionInput> {
      for (const input of inputs) yield input
    },
  }
  return { session, renders, keepOptions, closeCalls: () => closed }
}

test('T9: the runner releases the surface with keep:false and the session on quit', async () => {
  const handle = stubSession([keyInput('n'), keyInput('q')])
  const result = await runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } })
  assert.deepEqual(result, { kind: 'closed', rendered: 2, steps: STEPS.length })
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1)
})

test('T9: the real SDK decodes a raw Ctrl+C byte into the key the runner quits on', () => {
  // A real terminal sends 0x03 for Ctrl+C while the tty is in raw mode. This
  // pins that the SHIPPED SDK decode lands on exactly the key shape the runner
  // test above feeds in (`{name:'c', ctrl:true}`) — so the Ctrl+C key path is a
  // real-SDK fact, not only a stubbed one.
  const keys = new KeyDecoder().feed(new Uint8Array([0x03]))
  assert.equal(keys.length, 1)
  const key = keys[0]!
  assert.deepEqual({ name: key.name, ctrl: key.ctrl }, { name: 'c', ctrl: true })
})

test('T9: Ctrl+C closes cleanly, and a session that ends by itself still closes the surface', async () => {
  const interrupted = stubSession([keyInput('c', true)])
  await runTernTranscriptSpike({ connect: async () => interrupted.session, io: { write: () => {} } })
  assert.deepEqual(interrupted.keepOptions, [false])
  assert.equal(interrupted.closeCalls(), 1)

  const ended = stubSession([])
  await runTernTranscriptSpike({ connect: async () => ended.session, io: { write: () => {} } })
  assert.deepEqual(ended.keepOptions, [false])
  assert.equal(ended.closeCalls(), 1)
})

test('T9: a render failure is surfaced truthfully after cleanup, not converted to unsupported', async () => {
  const handle = stubSession([], true)
  await assert.rejects(
    () => runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } }),
    /render failed/,
  )
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1)
})

test('T9: a session-open failure still closes the session', async () => {
  let closed = 0
  const session: SpikeSession = {
    open() {
      throw new Error('open failed')
    },
    async close() {
      closed += 1
    },
    // Never reached: `open` throws before the runner starts reading input.
    async *[Symbol.asyncIterator](): AsyncIterator<SessionInput> {},
  }
  await assert.rejects(
    () => runTernTranscriptSpike({ connect: async () => session, io: { write: () => {} } }),
    /open failed/,
  )
  assert.equal(closed, 1, 'the session (and its raw-mode ownership) is released')
})

test('T9: a surface-close failure still releases the session and stays visible', async () => {
  const handle = stubSession([keyInput('q')], false, true)
  await assert.rejects(
    () => runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } }),
    /surface close failed/,
  )
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1, 'the session is still closed, so the tty is released')
})

test('T9: `n` beyond the last replay step is a no-op, never a crash', async () => {
  const presses = Array.from({ length: STEPS.length + 3 }, () => keyInput('n')).concat([keyInput('q')])
  const handle = stubSession(presses)
  const result = await runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } })
  assert.deepEqual(result, { kind: 'closed', rendered: STEPS.length, steps: STEPS.length })
})

// ── T10: isolation ─────────────────────────────────────────────────────────

test('T10: the spike imports no PiTui owner and no application/client module', async () => {
  const { readFileSync } = await import('node:fs')
  const allowed = [
    /^node:/,
    /^@stencil-hq\/tern$/,
    /^@deepseek-ai\//,
    /^\.\/support\/tern-tsp-transcript-view\.ts$/,
    /^(?:\.\.\/)+src\/domain\//,
    /^(?:\.\.\/)+src\/tui\/transcript\//,
    /^(?:\.\.\/)+src\/runtime\/assistant-stream-port\.ts$/,
  ]
  for (const path of ['scripts/tern-tsp-transcript-spike.mts', 'scripts/support/tern-tsp-transcript-view.ts']) {
    const source = readFileSync(path, 'utf8')
    const specifiers = [...source.matchAll(/from\s+'([^']+)'/g)].map(match => match[1]!)
    assert.ok(specifiers.length > 0, `${path} has imports`)
    for (const specifier of specifiers) {
      assert.ok(allowed.some(pattern => pattern.test(specifier)), `${path} may not import ${specifier}`)
    }
  }
})
