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
 * `docs/tsp/overview.md`. Neither is repository L5 DSH wire coverage.
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
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, TOOL_NOT_STARTED, type SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptFolder } from '../../src/domain/transcript/folder.ts'
import type { TranscriptMessage } from '../../src/domain/transcript/types.ts'
import { projectTranscriptStructure, type TranscriptStructureBlock } from '../../src/tui/transcript/structure.ts'
import { toolPresenterFrom, toolSummaryKeys } from '../../src/tui/transcript/tool-presentation.ts'
import {
  streamingToolPreviewSnapshot,
  upsertStreamingToolPreview,
  type StreamingToolPreview,
} from '../../src/app/surface/streaming-tool-preparing.ts'
import { TranscriptNodeKeys, transcriptView, type TranscriptViewOptions } from '../../scripts/support/tern-tsp-transcript-view.ts'
import { sanitizedPhysicalLine } from '../../src/tui/presentation/lines.ts'
import {
  applyReplayStep,
  buildReplaySteps,
  runTernTranscriptSpike,
  type SpikeSession,
  type SpikeSurface,
} from '../../scripts/tern-tsp-transcript-spike.mts'

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

// ── untrusted terminal output hardening: native View props stay clean ──────

/** One hostile payload: every control family the projection must drop. */
const HOSTILE_TSP =
  'safe-start'
  + '\u001b]52;c;YXR0YWNr\u0007'
  + '\u001b]0;hijacked-title\u001b\\'
  + '\u001b[2J'
  + '\u001bPbad\u001b\\'
  + '\u009b2J'
  + '\u001b[38;2;999;1;1m'
  + 'needle-text'

test('T-hardening: hostile transcript text never reaches a native View prop', () => {
  const user: TranscriptMessage = { kind: 'user', turn: 0, text: HOSTILE_TSP }
  const assistant: TranscriptMessage = { kind: 'assistant', turn: 0, text: HOSTILE_TSP }
  const thinking: TranscriptMessage = { kind: 'thinking', turn: 0, text: HOSTILE_TSP }
  const system: Extract<TranscriptMessage, { kind: 'system' }> = {
    kind: 'system', turn: 0, text: HOSTILE_TSP, label: HOSTILE_TSP, context: true,
  }
  const tool: Extract<TranscriptMessage, { kind: 'tool' }> = {
    kind: 'tool', turn: 0, name: 'bash',
    // A RAW argument payload (not JSON-escaped): the projection must remove
    // the control bytes themselves, not merely rely on JSON escaping.
    args: `{"command":"${HOSTILE_TSP}"}`, result: HOSTILE_TSP, status: 'ok',
  }
  const command = {
    kind: 'command', commandId: CommandId('cmd-hostile'), seq: SessionSeq(1), time: 1,
    name: HOSTILE_TSP, args: HOSTILE_TSP, outcome: { kind: 'success', text: HOSTILE_TSP },
  } as unknown as TranscriptMessage
  const summary: Extract<TranscriptMessage, { kind: 'summary' }> = { kind: 'summary', text: HOSTILE_TSP }

  const messages = [user, assistant, thinking, system, tool, command, summary]
  const view = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys()) })
  const props = JSON.stringify(flatten(view).map(node => node.props))
  assert.ok(!props.includes('\u001b'), `no raw ESC may reach a node prop:\n${props}`)
  assert.ok(!props.includes('YXR0YWNr'), 'no OSC 52 clipboard payload passes through')
  assert.ok(!props.includes('hijacked-title'), 'no OSC 0 title payload passes through')
  assert.ok(!props.includes('\u009b'), 'no raw C1 byte passes through')
  assert.ok(props.includes('needle-text'), 'the readable payload text survives for every row')
  // The source objects stay authoritative and byte-exact.
  assert.equal(user.text, HOSTILE_TSP)
  assert.equal(tool.result, HOSTILE_TSP)
  assert.equal(system.label, HOSTILE_TSP)
})

// ── T3: real fold -> canonical projection -> native view ───────────────────

test('the replay fold projects the canonical Work/Context/standalone structure', () => {
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

test('the mapper renders the projected blocks as native TSP nodes with real content', () => {
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

test('a text/status update sends a small delta and preserves unaffected node ids', () => {
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

test('re-rendering the same fold emits no ops at all', () => {
  const folder = folderThrough(2)
  const keys = new TranscriptNodeKeys()
  assert.deepEqual(viewOf(folder, keys).ops(viewOf(folder, keys), 's1'), [])
})

// ── T4 / T8: classification, boundaries and special families ───────────────

test('a non-ambient Work boundary flushes the ambient cluster instead of joining it', () => {
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

test('a settled interaction and a slash command stay outside every Work span', () => {
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

test('a post-turn replay result is honest diagnostic evidence, never a fabricated success', () => {
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

test('a Context row renders the helper-stripped body and its source kind, never raw envelope XML', () => {
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

test('a merged read-group replacement changes that card\'s key while neighbours keep theirs', () => {
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

test('dynamic Context clustering also rebuilds a retained row\'s node id', () => {
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

test('sibling Work spans sharing a turn, and repeated text, never collide', () => {
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

test('the runner reports an unsupported environment and opens no surface', async () => {
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

test('the real SDK connect declines every non-Tern environment', async () => {
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

test('a tty that never answers the handshake fails closed and restores raw mode', async () => {
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

test('the real SDK, a scripted Tern tty and the spike compose end to end', async () => {
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

test('the runner releases the surface with keep:false and the session on quit', async () => {
  const handle = stubSession([keyInput('n'), keyInput('q')])
  const result = await runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } })
  assert.deepEqual(result, { kind: 'closed', rendered: 2, steps: STEPS.length })
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1)
})

test('the real SDK decodes a raw Ctrl+C byte into the key the runner quits on', () => {
  // A real terminal sends 0x03 for Ctrl+C while the tty is in raw mode. This
  // pins that the SHIPPED SDK decode lands on exactly the key shape the runner
  // test above feeds in (`{name:'c', ctrl:true}`) — so the Ctrl+C key path is a
  // real-SDK fact, not only a stubbed one.
  const keys = new KeyDecoder().feed(new Uint8Array([0x03]))
  assert.equal(keys.length, 1)
  const key = keys[0]!
  assert.deepEqual({ name: key.name, ctrl: key.ctrl }, { name: 'c', ctrl: true })
})

test('Ctrl+C closes cleanly, and a session that ends by itself still closes the surface', async () => {
  const interrupted = stubSession([keyInput('c', true)])
  await runTernTranscriptSpike({ connect: async () => interrupted.session, io: { write: () => {} } })
  assert.deepEqual(interrupted.keepOptions, [false])
  assert.equal(interrupted.closeCalls(), 1)

  const ended = stubSession([])
  await runTernTranscriptSpike({ connect: async () => ended.session, io: { write: () => {} } })
  assert.deepEqual(ended.keepOptions, [false])
  assert.equal(ended.closeCalls(), 1)
})

test('a render failure is surfaced truthfully after cleanup, not converted to unsupported', async () => {
  const handle = stubSession([], true)
  await assert.rejects(
    () => runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } }),
    /render failed/,
  )
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1)
})

test('a session-open failure still closes the session', async () => {
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

test('a surface-close failure still releases the session and stays visible', async () => {
  const handle = stubSession([keyInput('q')], false, true)
  await assert.rejects(
    () => runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } }),
    /surface close failed/,
  )
  assert.deepEqual(handle.keepOptions, [false])
  assert.equal(handle.closeCalls(), 1, 'the session is still closed, so the tty is released')
})

test('`n` beyond the last replay step is a no-op, never a crash', async () => {
  const presses = Array.from({ length: STEPS.length + 3 }, () => keyInput('n')).concat([keyInput('q')])
  const handle = stubSession(presses)
  const result = await runTernTranscriptSpike({ connect: async () => handle.session, io: { write: () => {} } })
  assert.deepEqual(result, { kind: 'closed', rendered: STEPS.length, steps: STEPS.length })
})

// ── T10: isolation ─────────────────────────────────────────────────────────

test('the spike imports no PiTui owner and no application/client module', async () => {
  const { readFileSync } = await import('node:fs')
  const allowed = [
    /^node:/,
    /^@stencil-hq\/tern$/,
    /^@deepseek-ai\//,
    /^\.\/support\/tern-tsp-transcript-view\.ts$/,
    /^(?:\.\.\/)+src\/domain\//,
    /^(?:\.\.\/)+src\/tui\/transcript\//,
    /^(?:\.\.\/)+src\/tui\/tsp\/transcript-view\.ts$/,
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

test('T-hardening: a real tool/call keeps its raw name but projects every displayed tool field', () => {
  const hostileName = 'Evil\nTool\r\nName\tTabbed\u001b]52;c;YXR0YWNr\u0007tail'
  const collapsedName = sanitizedPhysicalLine(hostileName)
  const folder = new TranscriptFolder()
  folder.apply([ev('turn/start', { turn: 1 }, 0)])
  const call = toolCall(1, 'call-hostile', hostileName, { command: 'echo hi' })
  folder.apply([call])

  // The canonical transcript/card name stays the model-facing identity.
  const row = rowOf(folder, message => message.kind === 'tool')
  assert.equal(row.kind, 'tool')
  assert.equal(row.kind === 'tool' ? row.name : undefined, hostileName, 'the canonical tool name is untouched')
  assert.equal((call.data as { name?: string }).name, hostileName, 'the session event name is untouched')

  const view = viewOf(folder, new TranscriptNodeKeys())
  const tool = flatten(view).find(node => node.kind === 'tool')
  assert.ok(tool !== undefined, 'the native tool node exists')
  const nameProp = tool.props['name']
  assert.equal(nameProp, collapsedName, 'ui.tool.name carries the one-row display projection')
  const titleProp = String(tool.props['title'] ?? '')
  const targetProp = String(tool.props['target'] ?? '')
  assert.ok(targetProp.includes(collapsedName), `the title/summary target carries the readable name:\n${targetProp}`)
  for (const [field, value] of [['name', String(nameProp)], ['title', titleProp], ['target', targetProp]] as const) {
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(value),
      `ui.tool.${field} carries a raw control character: ${JSON.stringify(value)}`)
  }
  assert.ok(!JSON.stringify(tool.props).includes('YXR0YWNr'), 'no OSC payload reaches a tool prop')
})

// ── Snapshot Context nested inside native Work (2026-10-19) ───────────────

test('T-snapshot: a snapshot-only cluster renders as a native card inside the Work section', () => {
  const snapshotEvent = (seq: number, id: string, text: string): SessionEvent =>
    userMessage(seq, id, text, { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', body: text }] })
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'snap-u1', 'go'),
    toolCall(2, 'snap-c1', 'read', { path: 'a.ts' }),
    toolResult(3, 'snap-c1', 'ok'),
  ])
  const keys = new TranscriptNodeKeys()
  const before = flatten(viewOf(folder, keys))
  const beforeWork = before.find(node => node.kind === 'section')
  const beforeUser = before.find(node => node.kind === 'card' && node.props['head'] === 'You')
  assert.ok(beforeWork !== undefined && beforeUser !== undefined, 'fixture: Work section and user card exist')

  folder.apply([
    snapshotEvent(4, 'snap-a', 'SNAPSHOT_TSP_A'),
    snapshotEvent(5, 'snap-b', 'SNAPSHOT_TSP_B'),
  ])
  const structure = projectTranscriptStructure(folder.messages())
  assert.deepEqual(structureKinds(structure), ['message:user', 'work'])
  const span = structure[1]
  assert.ok(span !== undefined && span.kind === 'work')
  assert.deepEqual(span.span.parts.map(part => part.kind), ['message', 'context-cluster'],
    'the snapshot-only raw run is ONE nested structural part')
  const view = viewOf(folder, keys)
  const nodes = flatten(view)
  const work = nodes.find(node => node.kind === 'section')
  assert.ok(work !== undefined)
  assert.equal(work.id, beforeWork.id, 'the Work section keeps its stable native id')
  assert.equal(nodes.find(node => node.kind === 'card' && node.props['head'] === 'You')?.id, beforeUser.id,
    'an unrelated user card keeps its native id')
  const clusterCard = nodes.find(node => node.parent === work.id && node.kind === 'card')
  assert.ok(clusterCard !== undefined, `the nested cluster renders as a card inside the section:\n${JSON.stringify(nodes)}`)
  const first = rowOf(folder, message => message.kind === 'system' && message.text === 'SNAPSHOT_TSP_A')
  const second = rowOf(folder, message => message.kind === 'system' && message.text === 'SNAPSHOT_TSP_B')
  const firstNode = nodes.find(node => node.id.endsWith(`.${keys.keyFor(first)}`))
  const secondNode = nodes.find(node => node.id.endsWith(`.${keys.keyFor(second)}`))
  assert.equal(firstNode?.parent, clusterCard.id, 'the first snapshot is a child of the nested Context card')
  assert.equal(secondNode?.parent, clusterCard.id, 'the second snapshot is a child of the nested Context card')
  const contextText = nodes
    .filter(node => node.id.startsWith(`${clusterCard.id}.`))
    .map(node => JSON.stringify(node.props))
    .join('\n')
  assert.ok(contextText.includes('SNAPSHOT_TSP_A') && contextText.includes('SNAPSHOT_TSP_B'),
    `both Snapshot bodies stay reachable through the native tree:\n${contextText}`)
})

test('T-snapshot ops: a standalone Snapshot cluster reparents into Work with local ops only', () => {
  const snapshotEvent = (seq: number, id: string, text: string): SessionEvent =>
    userMessage(seq, id, text, { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', body: text }] })
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    userMessage(1, 'snap-ops-u1', 'go'),
    snapshotEvent(2, 'snap-ops-a', 'SNAPSHOT_OPS_A'),
    snapshotEvent(3, 'snap-ops-b', 'SNAPSHOT_OPS_B'),
  ])
  const keys = new TranscriptNodeKeys()
  const before = viewOf(folder, keys)
  const user = rowOf(folder, message => message.kind === 'user')
  const first = rowOf(folder, message => message.kind === 'system' && message.text === 'SNAPSHOT_OPS_A')
  const second = rowOf(folder, message => message.kind === 'system' && message.text === 'SNAPSHOT_OPS_B')
  const userNodeId = `main.${keys.keyFor(user)}`
  const standaloneClusterId = `main.ctx-${keys.keyFor(first)}`
  assert.equal(nodeOf(before, standaloneClusterId).kind, 'card', 'fixture: the snapshot-only cluster is a standalone card')
  assert.equal(nodeOf(before, standaloneClusterId).parent, 'main')

  // The first durable Process arrives: the SAME retained carrier objects move
  // under a new Work section (a legitimate parent migration).
  folder.apply([toolCall(4, 'snap-ops-c1', 'read', { path: 'a.ts' })])
  const after = viewOf(folder, keys)
  const ops = before.ops(after, 's1')
  const deleted = opIds(ops, 'del')
  const added = opIds(ops, 'add')
  const workId = `main.work-${keys.keyFor(first)}`
  const nestedClusterId = `${workId}.ctx-${keys.keyFor(first)}`
  assert.ok(deleted.has(standaloneClusterId), 'the standalone Context card is legitimately removed')
  assert.ok(added.has(workId), 'the Work section is added')
  // The SDK carries the moved subtree inside the single `add` payload; its
  // nested ids are therefore asserted on that payload, not as separate ops.
  const workAdd = ops.find(op => op[0] === 'add' && op[1] === workId)
  assert.ok(workAdd !== undefined)
  const workAddPayload = JSON.stringify(workAdd)
  assert.ok(workAddPayload.includes(nestedClusterId), 'the Context card is re-added under the Work')
  assert.ok(workAddPayload.includes(`${nestedClusterId}.${keys.keyFor(first)}`),
    'the first migrated snapshot member is re-added under the nested card')
  assert.ok(workAddPayload.includes(`${nestedClusterId}.${keys.keyFor(second)}`),
    'the second migrated snapshot member is re-added under the nested card')
  // Only the migrated snapshot subtree changes: the unrelated user identity is
  // never remounted/rewritten.
  const touched = new Set([...opIds(ops, 'add'), ...opIds(ops, 'del'), ...opIds(ops, 'set'), ...opIds(ops, 'text')])
  assert.ok(!touched.has(userNodeId), 'the untouched user card is never rewritten')
  for (const id of deleted) {
    assert.ok(id !== undefined, 'a del op always carries a target id')
    assert.ok(id === standaloneClusterId || id.startsWith(`${standaloneClusterId}.`),
      `unexpected deletion outside the migrated Context subtree: ${id}`)
  }
  for (const id of added) {
    assert.ok(id !== undefined, 'an add op always carries a target id')
    assert.ok(id === workId || id.startsWith(`${workId}.`),
      `unexpected addition outside the new Work subtree: ${id}`)
  }
  assert.equal(nodeOf(after, userNodeId).kind, 'card', 'the user identity survives the migration')

  // A later final assistant is added standalone and never disturbs the Work.
  folder.apply([
    ev('assistant/message', {
      turn: 1, step: 1,
      message: { id: MessageId('snap-ops-final'), role: 'assistant', content: [{ type: 'text', text: 'done' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    }, 5),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  ])
  const final = viewOf(folder, keys)
  const finalOps = after.ops(final, 's2')
  const assistant = rowOf(folder, message => message.kind === 'assistant')
  assert.ok(opIds(finalOps, 'add').has(`main.${keys.keyFor(assistant)}`), 'the new final assistant is added')
  const touchedFinal = new Set([...opIds(finalOps, 'add'), ...opIds(finalOps, 'del'), ...opIds(finalOps, 'set'), ...opIds(finalOps, 'text')])
  assert.ok(!touchedFinal.has(workId), 'the Work section is not rewritten')
  assert.ok(!touchedFinal.has(nestedClusterId), 'the nested Context card is not rewritten')
  assert.equal(opIds(finalOps, 'del').size, 0, 'nothing is deleted')
})

test('T-working: a proven Working tool-jobs notice renders inside the Work section', () => {
  const noticeMessage = {
    id: MessageId('working-tsp-notice'), role: 'user',
    content: [{ type: 'text', text: 'WORKING_TSP_NOTICE body' }],
    source: { kind: 'tool-jobs', form: 'notice', summary: 'job completed' },
  }
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'working-tsp-c1', 'read', { path: 'a.ts' }),
    toolResult(2, 'working-tsp-c1', 'ok'),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, inserted: [noticeMessage] }, 3),
    ev('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] }, 4),
    ev('user/message', noticeMessage, 5),
    toolCall(6, 'working-tsp-c2', 'bash', { command: 'ls' }),
    toolResult(7, 'working-tsp-c2', 'ok'),
  ])
  const notice = rowOf(folder, message => message.kind === 'system' && message.text === 'WORKING_TSP_NOTICE body')
  assert.equal(notice.kind === 'system' ? notice.contextPresentation?.sameTurnNextStep : undefined, true)
  const structure = projectTranscriptStructure(folder.messages())
  assert.deepEqual(structureKinds(structure), ['work'])
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const nodes = flatten(view)
  const work = nodes.find(node => node.kind === 'section')
  assert.ok(work !== undefined)
  const noticeNode = nodes.find(node => node.id === `${work.id}.${keys.keyFor(notice)}`)
  assert.ok(noticeNode !== undefined, `the notice renders as a direct Work child:\n${JSON.stringify(nodes)}`)
  assert.equal(noticeNode.kind, 'card')
  assert.equal(noticeNode.parent, work.id)
  assert.ok(JSON.stringify(noticeNode.props).includes('tool-jobs'),
    'the producer identity remains the visible card header')
})

// ── Markdown fence fidelity through the PRODUCTION projection ───────────────
//
// The assistant body reaches the client as ONE `md` node whose `text` is the
// model's own answer. The Tern client reads a ```mermaid / ```svg fence out
// of that text and draws it as a vector graphic, so the fence bytes must
// arrive intact. These cases pin that chain: the real folder, the real
// projection and the real mapper, with the sanitizer as the ONLY transform.

/** One settled assistant answer, as the durable `assistant/message` event. */
function assistantAnswer(seq: number, id: string, text: string): SessionEvent {
  return ev('assistant/message', {
    turn: 1, step: 0,
    message: {
      id: MessageId(id), role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    },
  }, seq)
}

/** The `md` body node of the assistant row in a projected view. */
function assistantBodyText(view: View, folder: TranscriptFolder, keys: TranscriptNodeKeys): string {
  const assistant = rowOf(folder, message => message.kind === 'assistant')
  const card = nodeOf(view, `main.${keys.keyFor(assistant)}`)
  const body = nodeOf(view, `${card.id}.body`)
  assert.equal(body.kind, 'md', 'the assistant body is an `md` node')
  return String(body.props['text'])
}

const FENCE_ANSWERS: readonly (readonly [string, string])[] = [
  ['a mermaid fence', '```mermaid\ngraph TD\n  A[App] --> B[Surface]\n```'],
  ['an svg fence', '```svg\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#eee"/></svg>\n```'],
  ['an unclosed mermaid fence', '```mermaid\ngraph TD\n  A[App] --> B[Surface]\n'],
  ['a nested fence', '````markdown\n```mermaid\ngraph TD\n```\n````'],
  ['a fence with CJK labels', '```mermaid\ngraph TD\n  A[中文] --> B[图]\n```'],
  ['a fence inside prose', 'before\n\n```mermaid\ngraph TD\n  A --> B\n```\n\nafter'],
]

test('T-fence: a fence in an assistant answer reaches the md node byte for byte', () => {
  for (const [name, answer] of FENCE_ANSWERS) {
    const folder = new TranscriptFolder()
    folder.apply([assistantAnswer(1, `fence-${name}`, answer)])
    const keys = new TranscriptNodeKeys()
    const view = viewOf(folder, keys)

    // The canonical message is the authority and stays byte-exact.
    const message = rowOf(folder, row => row.kind === 'assistant')
    assert.equal(message.kind === 'assistant' ? message.text : undefined, answer,
      `${name}: the fold keeps the answer verbatim`)

    // The md node carries exactly that answer: no truncation, no rewriting.
    assert.equal(assistantBodyText(view, folder, keys), answer,
      `${name}: the md node carries the answer verbatim`)
  }
})

test('T-fence: the md body is the sanitizer output, never a re-projection of the answer', () => {
  const folder = new TranscriptFolder()
  // A control byte inside the fence: the sanitizer removes it, and the fence
  // structure around it must survive.
  const answer = '```mermaid\ngraph TD\n  A["\u001b[31mred\u001b[0m"] --> B\n```'
  folder.apply([assistantAnswer(1, 'fence-hostile', answer)])
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)

  const message = rowOf(folder, row => row.kind === 'assistant')
  assert.equal(message.kind === 'assistant' ? message.text : undefined, answer,
    'the canonical message keeps the raw bytes')
  const body = assistantBodyText(view, folder, keys)
  assert.ok(!body.includes('\u001b'), 'no ESC reaches the md node')
  assert.ok(body.startsWith('```mermaid\n'), 'the fence opener survives')
  assert.ok(body.endsWith('\n```'), 'the fence closer survives')
  assert.ok(body.includes('A["red"]'), 'the payload keeps its text')
})

test('T-fence: a user answer carries its fence verbatim too', () => {
  const answer = '```mermaid\ngraph TD\n  A --> B\n```'
  const folder = new TranscriptFolder()
  folder.apply([userMessage(1, 'fence-user', answer)])
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)

  const user = rowOf(folder, row => row.kind === 'user')
  const card = nodeOf(view, `main.${keys.keyFor(user)}`)
  const body = nodeOf(view, `${card.id}.body`)
  assert.equal(body.kind, 'md')
  assert.equal(body.props['text'], answer, 'the user body carries the fence verbatim')
})

// ── PR-B2: PTC nested native tool children ────────────────────────────────
//
// The production mapper renders the Folder's PTC `subCalls` tree as native
// `ui.tool({frame:'inline'})` descendants of their OWN parent card. Every case
// below runs the real fold, the canonical structure projector, the production
// mapper and the real SDK `View.from`/`ops` reconciliation — never a
// hand-authored node tree.

const CODE_ARGS = { code: 'print(1)', description: 'Inspect project and run tests' }

function runCodeCall(seq: number, id: string, args: Record<string, unknown> = CODE_ARGS): SessionEvent {
  return toolCall(seq, id, 'run_code', args)
}

function ptcStart(
  seq: number,
  root: string,
  parent: string,
  sub: string,
  name: string,
  args: Record<string, unknown>,
): SessionEvent {
  return ev('tool/ptc-dispatch-start', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(parent),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
  }, seq)
}

function ptcSettle(
  seq: number,
  root: string,
  parent: string,
  sub: string,
  name: string,
  args: Record<string, unknown>,
  text: string,
): SessionEvent {
  return ev('tool/ptc-dispatch', {
    rootCallId: ToolCallId(root),
    parentCallId: ToolCallId(parent),
    subCallId: ToolCallId(sub),
    name,
    arguments: args,
    isError: false,
    content: [{ type: 'text', text }],
  }, seq)
}

/** One settled ROOT `tool/result` carrying the curated parent output. */
function parentSettle(seq: number, id: string, text: string): SessionEvent {
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

/** The official crash-recovery diagnostic result (no durable `tool/call`). */
function notStartedResult(seq: number, id: string, text: string): SessionEvent {
  return ev('tool/result', {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`result-${id}`),
      role: 'tool',
      toolCallId: ToolCallId(id),
      content: [{ type: 'text', text }],
      isError: true,
      source: { kind: 'tool', callId: ToolCallId(id) },
    },
    error: { name: 'ToolNotStartedError', code: TOOL_NOT_STARTED },
  }, seq)
}

function workSection(view: View): FlatNode {
  const work = flatten(view).find(node => node.kind === 'section')
  assert.ok(work !== undefined, 'the fixture projects one Work section')
  return work
}

function workChildNodeId(view: View, keys: TranscriptNodeKeys, message: TranscriptMessage): string {
  return `${workSection(view).id}.${keys.keyFor(message)}`
}

/** The one node carrying this message's stable presentation key. */
function nodeByMessage(view: View, keys: TranscriptNodeKeys, message: TranscriptMessage): FlatNode {
  const suffix = `.${keys.keyFor(message)}`
  const node = flatten(view).find(candidate => candidate.id.endsWith(suffix))
  assert.ok(node !== undefined, `a node ends with ${suffix}`)
  return node
}

function toolRows(folder: TranscriptFolder): Extract<TranscriptMessage, { kind: 'tool' }>[] {
  return folder.messages().filter(
    (message): message is Extract<TranscriptMessage, { kind: 'tool' }> => message.kind === 'tool',
  )
}

test('B2-T01: a real PTC dispatch nests under its own root and never joins the Work top level', () => {
  const readArgs = { file_path: 'src/a.ts' }
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    runCodeCall(1, 'code-1'),
    ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs),
    ptcSettle(3, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs, 'a.ts body'),
    parentSettle(4, 'code-1', 'program output'),
  ])
  assert.deepEqual(toolRows(folder).map(row => row.name), ['run_code'], 'the fold keeps ONE top-level tool')
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const root = toolRows(folder)[0]!
  const rootId = workChildNodeId(view, keys, root)
  const work = workSection(view)
  assert.equal(flatten(view).filter(node => node.parent === work.id && node.kind === 'tool').length, 1,
    'the Work holds the root card only')

  const childId = `${rootId}.sub-code-1:code:1`
  const child = nodeOf(view, childId)
  assert.equal(child.kind, 'tool', 'the sub-call is a native tool node')
  assert.equal(child.parent, rootId, 'it is a child of its OWN root card')
  assert.equal(child.props['frame'], 'inline')
  assert.equal(child.props['title'], 'Read')
  assert.equal(child.props['target'], 'src/a.ts')
  assert.equal(child.props['targetKind'], 'text')
  assert.equal(child.props['status'], 'done')
  assert.equal(nodeOf(view, `${rootId}.child-head`).props['text'], 'Child calls · 1')
  assert.equal(nodeOf(view, `${childId}.result`).props['text'], 'a.ts body')
  // No ghost: the flattened tree carries exactly the root and its one child.
  assert.equal(flatten(view).filter(node => node.kind === 'tool').length, 2)
})

test('B2-T02: ordered child calls carry per-child status; a child failure never fails the parent', () => {
  const readArgs = { file_path: 'src/a.ts' }
  const bashArgs = { command: 'pnpm test', description: 'Run tests' }
  const writeArgs = { file_path: 'src/b.ts', content: 'hello' }
  const folder = new TranscriptFolder()
  const keys = new TranscriptNodeKeys()
  folder.apply([ev('turn/start', { turn: 1 }, 0), runCodeCall(1, 'code-1')])
  folder.apply([ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs)])

  const running = viewOf(folder, keys)
  const root = toolRows(folder)[0]!
  const rootId = workChildNodeId(running, keys, root)
  assert.equal(nodeOf(running, rootId).props['status'], 'running', 'the parent keeps its own running status')
  assert.equal(nodeOf(running, `${rootId}.sub-code-1:code:1`).props['status'], 'running')
  assert.equal(nodeOf(running, `${rootId}.child-head`).props['text'], 'Child calls · 1')

  folder.apply([
    ptcSettle(3, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs, 'a.ts body'),
    ptcStart(4, 'code-1', 'code-1', 'code-1:code:2', 'bash', bashArgs),
    ptcSettle(5, 'code-1', 'code-1', 'code-1:code:2', 'bash', bashArgs, 'boom\n[exit code: 7]'),
    ptcStart(6, 'code-1', 'code-1', 'code-1:code:3', 'write', writeArgs),
    ptcSettle(7, 'code-1', 'code-1', 'code-1:code:3', 'write', writeArgs, 'wrote b'),
  ])
  const view = viewOf(folder, keys)
  assert.equal(nodeOf(view, `${rootId}.child-head`).props['text'], 'Child calls · 3')
  const readId = `${rootId}.sub-code-1:code:1`
  const bashId = `${rootId}.sub-code-1:code:2`
  const writeId = `${rootId}.sub-code-1:code:3`
  assert.deepEqual(
    flatten(view).filter(node => node.kind === 'tool').map(node => String(node.props['name'])),
    ['run_code', 'read', 'bash', 'write'],
    'the durable dispatch order is preserved',
  )
  assert.equal(nodeOf(view, readId).props['status'], 'done')
  assert.equal(nodeOf(view, bashId).props['status'], 'error', 'the native status parses the [exit code: N] marker')
  assert.equal(nodeOf(view, writeId).props['status'], 'done')
  assert.equal(nodeOf(view, bashId).props['title'], 'Bash')
  assert.equal(nodeOf(view, bashId).props['target'], 'Run tests')
  assert.equal(nodeOf(view, `${bashId}.result`).props['text'], 'boom\n[exit code: 7]',
    'the full child result keeps the exit marker, never stripped')
  assert.equal(nodeOf(view, rootId).props['status'], 'running',
    'the child error is display-only and does not change the parent status')

  // §4: a child that STARTED before the parent settled may still SETTLE after
  // it. The live Fold keeps the mounted card object, and the mapper must read
  // its latest in-place `subCalls` (never a cached array reference) while the
  // parent and every existing child keep their own state.
  const lateArgs = { file_path: 'src/late.ts' }
  folder.apply([ptcStart(8, 'code-1', 'code-1', 'code-1:code:4', 'read', lateArgs)])
  const childRunning = viewOf(folder, keys)
  assert.equal(nodeOf(childRunning, `${rootId}.child-head`).props['text'], 'Child calls · 4')
  assert.equal(nodeOf(childRunning, `${rootId}.sub-code-1:code:4`).props['status'], 'running')

  folder.apply([parentSettle(9, 'code-1', 'program output')])
  const settled = viewOf(folder, keys)
  assert.equal(nodeOf(settled, rootId).props['status'], 'done')
  assert.equal(nodeOf(settled, bashId).props['status'], 'error', 'the later parent settle leaves the child row as-is')
  assert.equal(nodeOf(settled, `${rootId}.result`).props['text'], 'program output')
  assert.equal(nodeOf(settled, `${rootId}.sub-code-1:code:4`).props['status'], 'running',
    'a child started before the parent settles stays visible while it runs')

  folder.apply([ptcSettle(10, 'code-1', 'code-1', 'code-1:code:4', 'read', lateArgs, 'late body')])
  const late = viewOf(folder, keys)
  assert.equal(nodeOf(late, `${rootId}.child-head`).props['text'], 'Child calls · 4')
  assert.equal(nodeOf(late, `${rootId}.sub-code-1:code:4`).props['status'], 'done',
    'the child settles AFTER the parent without a TSP replay')
  assert.equal(nodeOf(late, `${rootId}.sub-code-1:code:4.result`).props['text'], 'late body')
  assert.equal(nodeOf(late, rootId).props['status'], 'done', 'the parent keeps its settled status')
  for (const id of [readId, bashId, writeId]) {
    assert.equal(nodeOf(late, id).props['status'], nodeOf(settled, id).props['status'],
      `${id} keeps its own status through the late child settle`)
  }
})

test('B2-T03: two run_code roots in one Work keep separate subtrees and stable SDK ids', () => {
  const readArgs = { file_path: 'src/a.ts' }
  const writeArgs = { file_path: 'src/b.ts', content: 'hello' }
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    runCodeCall(1, 'code-A'),
    ptcStart(2, 'code-A', 'code-A', 'code-A:code:1', 'read', readArgs),
    ptcSettle(3, 'code-A', 'code-A', 'code-A:code:1', 'read', readArgs, 'a.ts body'),
    runCodeCall(4, 'code-B'),
    ptcStart(5, 'code-B', 'code-B', 'code-B:code:1', 'write', writeArgs),
    parentSettle(6, 'code-A', 'A curated result'),
  ])
  const roots = toolRows(folder)
  assert.deepEqual(roots.map(row => row.name), ['run_code', 'run_code'])
  assert.equal(projectTranscriptStructure(folder.messages()).filter(block => block.kind === 'work').length, 1,
    'both roots are members of the SAME Work span')

  const keys = new TranscriptNodeKeys()
  const before = viewOf(folder, keys)
  const work = workSection(before)
  const idA = `${work.id}.${keys.keyFor(roots[0]!)}`
  const idB = `${work.id}.${keys.keyFor(roots[1]!)}`
  const readId = `${idA}.sub-code-A:code:1`
  const writeId = `${idB}.sub-code-B:code:1`
  assert.equal(flatten(before).filter(node => node.kind === 'tool').length, 4, 'exactly four native tool nodes')
  assert.equal(nodeOf(before, readId).parent, idA, 'A\'s child stays under A')
  assert.equal(nodeOf(before, writeId).parent, idB, 'B\'s child stays under B')
  assert.equal(nodeOf(before, readId).props['status'], 'done')
  assert.equal(nodeOf(before, writeId).props['status'], 'running')
  assert.equal(nodeOf(before, `${idA}.child-head`).props['text'], 'Child calls · 1')
  assert.equal(nodeOf(before, `${idB}.child-head`).props['text'], 'Child calls · 1')
  const idsBefore = flatten(before).map(node => node.id)

  folder.apply([
    ptcSettle(7, 'code-B', 'code-B', 'code-B:code:1', 'write', writeArgs, 'wrote b'),
    parentSettle(8, 'code-B', 'B curated result'),
  ])
  const after = viewOf(folder, keys)
  const idsAfter = flatten(after).map(node => node.id)
  for (const id of [idA, idB, readId, writeId]) {
    assert.ok(idsBefore.includes(id), `${id} is in the pre-settle wire tree`)
    assert.ok(idsAfter.includes(id), `${id} keeps its SDK id after B settles`)
  }
  assert.equal(new Set(idsAfter).size, idsAfter.length, 'every SDK node id stays unique')
  assert.equal(flatten(after).filter(node => node.kind === 'tool').length, 4, 'settling B adds no fifth tool node')
  assert.equal(nodeOf(after, writeId).props['status'], 'done')
  assert.equal(nodeOf(after, `${writeId}.result`).props['text'], 'wrote b')
  assert.equal(nodeOf(after, idB).props['status'], 'done')

  const ops = before.ops(after, 's1')
  assert.equal(ops.filter(op => op[0] === 'del').length, 0, 'the child settle deletes nothing')
  assert.equal(ops.filter(op => op[0] === 'move').length, 0, 'the child settle moves nothing')
  const touched = new Set([
    ...opIds(ops, 'add'),
    ...opIds(ops, 'del'),
    ...opIds(ops, 'set'),
    ...opIds(ops, 'text'),
  ])
  for (const id of [idA, readId]) assert.ok(!touched.has(id), `root A/read is never touched by B's settle: ${id}`)
  for (const id of touched) {
    assert.ok(id === idB || id?.startsWith(`${idB}.`) || id === writeId || id?.startsWith(`${writeId}.`),
      `B's settle only touches B's own subtree: ${id}`)
  }
})

test('B2-T04: a three-level tree attaches every direct child to the correct parent node id', () => {
  const childArgs = { command: 'make', description: 'Build project' }
  const grandchildArgs = { file_path: 'nested.ts' }
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    runCodeCall(1, 'code-1'),
    ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'bash', childArgs),
    ptcStart(3, 'code-1', 'code-1:code:1', 'code-1:code:1:code:1', 'read', grandchildArgs),
    ptcSettle(4, 'code-1', 'code-1:code:1', 'code-1:code:1:code:1', 'read', grandchildArgs, 'nested content'),
    ptcSettle(5, 'code-1', 'code-1', 'code-1:code:1', 'bash', childArgs, 'built'),
    parentSettle(6, 'code-1', 'program output'),
  ])
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const root = toolRows(folder)[0]!
  const rootId = workChildNodeId(view, keys, root)
  const childId = `${rootId}.sub-code-1:code:1`
  const grandchildId = `${childId}.sub-code-1:code:1:code:1`
  assert.equal(nodeOf(view, childId).parent, rootId)
  assert.equal(nodeOf(view, grandchildId).parent, childId, 'the grandchild hangs from child A, not the root')
  assert.equal(nodeOf(view, `${rootId}.child-head`).props['text'], 'Child calls · 1')
  assert.equal(nodeOf(view, `${childId}.child-head`).props['text'], 'Child calls · 1',
    'the nested count is the child\'s own DIRECT children')
  assert.equal(nodeOf(view, childId).props['title'], 'Bash')
  assert.equal(nodeOf(view, childId).props['target'], 'Build project')
  assert.equal(nodeOf(view, grandchildId).props['title'], 'Read')
  assert.equal(nodeOf(view, grandchildId).props['target'], 'nested.ts')
  assert.equal(nodeOf(view, `${grandchildId}.result`).props['text'], 'nested content')
  assert.equal(flatten(view).some(node => node.id === `${grandchildId}.child-head`), false,
    'a leaf child has no nested block')
  assert.equal(flatten(view).filter(node => node.kind === 'tool').length, 3)
})

test('B2-T05: merged Read, ordinary, orphan and tool-not-started rows keep their pre-B2 view', () => {
  const bashArgs = { command: 'pnpm test', description: 'Run tests' }
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    toolCall(1, 'read-1', 'read', { file_path: 'src/a.ts' }),
    toolResult(2, 'read-1', 'a body'),
    toolCall(3, 'read-2', 'read', { file_path: 'src/b.ts' }),
    toolResult(4, 'read-2', 'b body'),
    toolCall(5, 'bash-1', 'bash', bashArgs),
    toolResult(6, 'bash-1', 'ok'),
    toolResult(7, 'orphan-1', 'late replay evidence'),
    notStartedResult(8, 'never-1', 'tool was never started'),
  ])
  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const nodes = flatten(view)
  assert.equal(nodes.some(node => node.id.endsWith('.child-head')), false, 'no subtree head appears')
  assert.equal(nodes.filter(node => node.kind === 'tool' && node.props['frame'] === 'inline').length, 0)
  assert.equal(nodes.filter(node => node.kind === 'code' && node.props['wrap'] === true).length, 0,
    'no row is wrapped without a PTC subtree')
  assert.equal(nodes.filter(node => node.kind === 'tool').length, 2, 'the read group and the bash card')

  const mergedRead = rowOf(folder, message => message.kind === 'tool' && message.name === 'read')
  assert.equal(mergedRead.kind === 'tool' ? mergedRead.args : undefined, '2 files')
  const readNode = nodeByMessage(view, keys, mergedRead)
  assert.equal(readNode.kind, 'tool')
  assert.deepEqual(nodeOf(view, `${readNode.id}.args`).props, { key: 'args', text: '2 files' })

  const bash = rowOf(folder, message => message.kind === 'tool' && message.name === 'bash')
  const bashNode = nodeByMessage(view, keys, bash)
  assert.equal(bashNode.kind, 'tool')
  assert.deepEqual(nodeOf(view, `${bashNode.id}.args`).props,
    { key: 'args', text: JSON.stringify(bashArgs) }, 'the plain args node keeps the exact pre-B2 props')
  assert.deepEqual(nodeOf(view, `${bashNode.id}.result`).props, { key: 'result', text: 'ok' })

  const orphan = rowOf(folder, message => message.kind === 'tool' && message.result === 'late replay evidence')
  const orphanNode = nodeByMessage(view, keys, orphan)
  assert.equal(orphanNode.kind, 'card', 'an orphan result stays a diagnostic card')
  assert.equal(nodeOf(view, `${orphanNode.id}.provenance`).props['text'], 'unmatched result')

  const never = rowOf(folder, message => message.kind === 'tool' && message.origin === 'tool-not-started')
  const neverNode = nodeByMessage(view, keys, never)
  assert.equal(neverNode.kind, 'card', 'a tool-not-started row stays a diagnostic card')
  assert.equal(nodeOf(view, `${neverNode.id}.provenance`).props['text'], 'not started')
})

test('B2-T06: an orphan PTC start/settle shows nothing until the parent arrives, then exactly once', () => {
  const bashArgs = { command: 'ls', description: 'List files' }
  const orphanStart = ptcStart(0, 'code-1', 'code-1', 'code-1:code:1', 'bash', bashArgs)
  const orphanSettle = ptcSettle(1, 'code-1', 'code-1', 'code-1:code:1', 'bash', bashArgs, 'file.txt')
  const parentCall = runCodeCall(2, 'code-1')
  const settledParent = parentSettle(3, 'code-1', 'program output')

  const folder = new TranscriptFolder()
  folder.apply([orphanStart, orphanSettle])
  assert.equal(folder.messages().length, 0, 'an unmatched PTC fragment fabricates no surface row')
  const keys = new TranscriptNodeKeys()
  const before = viewOf(folder, keys)
  assert.equal(flatten(before).filter(node => node.kind === 'tool').length, 0)
  assert.equal(flatten(before).some(node => node.id.endsWith('.child-head')), false)

  folder.apply([parentCall, settledParent])
  const view = viewOf(folder, keys)
  const root = toolRows(folder)[0]!
  const rootId = workChildNodeId(view, keys, root)
  const childId = `${rootId}.sub-code-1:code:1`
  assert.equal(nodeOf(view, `${rootId}.child-head`).props['text'], 'Child calls · 1')
  assert.equal(flatten(view).filter(node => node.id.endsWith('.child-head')).length, 1, 'one child block, no duplicate')
  assert.equal(nodeOf(view, childId).props['status'], 'done', 'the parked settle applies to the attached child')
  assert.equal(nodeOf(view, `${childId}.result`).props['text'], 'file.txt')

  // A cold replay of the same event stream reproduces exactly the same tree.
  const replay = new TranscriptFolder()
  replay.apply([orphanStart, orphanSettle, parentCall, settledParent])
  assert.deepEqual(flatten(viewOf(replay, new TranscriptNodeKeys())), flatten(view),
    'replaying the same durable events adds no duplicate child')
})

test('B2-T07: a new projection source gets a fresh scope, never the old source ids', () => {
  const readArgs = { file_path: 'src/a.ts' }
  const build = (): TranscriptFolder => {
    const folder = new TranscriptFolder()
    folder.apply([
      ev('turn/start', { turn: 1 }, 0),
      runCodeCall(1, 'code-1'),
      ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs),
      ptcSettle(3, 'code-1', 'code-1', 'code-1:code:1', 'read', readArgs, 'a.ts body'),
      parentSettle(4, 'code-1', 'program output'),
    ])
    return folder
  }
  const scoped = (scopePrefix: string): View => View.from({
    main: transcriptView(projectTranscriptStructure(build().messages()), new TranscriptNodeKeys(), { scopePrefix }),
  })
  const oldView = scoped('s1-')
  const newView = scoped('s2-')
  const oldIds = flatten(oldView).map(node => node.id)
  const newIds = flatten(newView).map(node => node.id)
  assert.ok(oldIds.every(id => id === 'main' || id.startsWith('main.s1-')), 'the old source is fully scoped')
  assert.ok(newIds.every(id => id === 'main' || id.startsWith('main.s2-')), 'the new source is fully scoped')
  assert.deepEqual(oldIds.filter(id => newIds.includes(id)), ['main'],
    'the two sources share no presentation identity')
  // Same shape and same displayed bytes: only the presentation key is scoped.
  const shapeOf = (node: FlatNode): unknown => [
    node.kind,
    Object.fromEntries(Object.entries(node.props).filter(([name]) => name !== 'key')),
  ]
  assert.deepEqual(flatten(oldView).map(shapeOf), flatten(newView).map(shapeOf),
    'the new scope renders the same content, never a cached stale tree')
})

test('B2-T08: hostile child name/args/result are sanitized; the Folder values stay raw', () => {
  const hostileName = 'Read\nEvil\u001b]0;pwn\u0007'
  const hostileArgs = { q: 'safe-args\u009b2J\u007fneedle-args' }
  const hostileResult = 'safe-start\u001b]52;c;YXR0YWNr\u0007needle-text\u009b2J\u007fend'
  const folder = new TranscriptFolder()
  folder.apply([
    ev('turn/start', { turn: 1 }, 0),
    runCodeCall(1, 'code-1'),
    ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'get_goal', hostileArgs),
    ptcStart(3, 'code-1', 'code-1', 'code-1:code:2', hostileName, {}),
    ptcSettle(4, 'code-1', 'code-1', 'code-1:code:2', hostileName, {}, hostileResult),
    parentSettle(5, 'code-1', 'program output'),
  ])
  const children = toolRows(folder)[0]!.subCalls ?? []
  const argsChild = children[0]!
  const textChild = children[1]!
  assert.equal(argsChild.args, JSON.stringify(hostileArgs), 'the Folder keeps the raw args value')
  assert.equal(textChild.name, hostileName, 'the Folder keeps the raw child name')
  assert.equal(textChild.result, hostileResult, 'the Folder keeps the raw child result')

  const keys = new TranscriptNodeKeys()
  const view = viewOf(folder, keys)
  const rootId = workChildNodeId(view, keys, toolRows(folder)[0]!)
  const props = JSON.stringify(flatten(view).map(node => node.props))
  assert.ok(!props.includes('\u001b'), `no raw ESC may reach a child prop:\n${props}`)
  assert.ok(!props.includes('YXR0YWNr'), 'no OSC 52 payload passes through')
  assert.ok(!props.includes('\u009b'), 'no raw C1 byte passes through')
  assert.ok(!props.includes('\u007f'), 'no raw DEL byte passes through')
  assert.ok(props.includes('needle-args'), 'the readable args payload survives')
  assert.ok(props.includes('needle-text'), 'the readable result payload survives')
  assert.ok(props.includes('Read Evil'), 'the hostile name collapses to one safe physical line')
  const argsText = String(nodeOf(view, `${rootId}.sub-code-1:code:1.args`).props['text'])
  assert.ok(argsText.includes('needle-args'))
  const resultText = String(nodeOf(view, `${rootId}.sub-code-1:code:2.result`).props['text'])
  assert.ok(resultText.includes('safe-start') && resultText.includes('needle-text'))
})

test('B2-T09: a parent with children keeps its arguments/result bytes, status and target kind', () => {
  const targetPresenter = toolPresenterFrom(name => name === 'run_code' || name === 'read'
    ? {
        presentCall: () => ({
          card: 'generic' as const,
          title: 'Read',
          kind: 'read' as const,
          locations: [{ path: 'src/a.ts' }],
        }),
      }
    : undefined)
  const parentArgs = { code: 'print(1)', description: 'src/a.ts' }
  const outcome = 'curated result\nline two'
  const build = (withChild: boolean): TranscriptFolder => {
    const events: SessionEvent[] = [
      ev('turn/start', { turn: 1 }, 0),
      toolCall(1, 'code-1', 'run_code', parentArgs),
    ]
    if (withChild) {
      const childArgs = { file_path: 'src/a.ts' }
      events.push(
        ptcStart(2, 'code-1', 'code-1', 'code-1:code:1', 'read', childArgs),
        ptcSettle(3, 'code-1', 'code-1', 'code-1:code:1', 'read', childArgs, 'a.ts body'),
      )
    }
    events.push(parentSettle(4, 'code-1', outcome))
    const folder = new TranscriptFolder()
    folder.apply(events)
    return folder
  }
  const options: TranscriptViewOptions = { toolPresenter: targetPresenter }
  const withFolder = build(true)
  const withoutFolder = build(false)
  const keysWith = new TranscriptNodeKeys()
  const keysWithout = new TranscriptNodeKeys()
  const withView = View.from({ main: transcriptView(projectTranscriptStructure(withFolder.messages()), keysWith, options) })
  const withoutView = View.from({ main: transcriptView(projectTranscriptStructure(withoutFolder.messages()), keysWithout, options) })
  const withRootId = workChildNodeId(withView, keysWith, toolRows(withFolder)[0]!)
  const withoutRootId = workChildNodeId(withoutView, keysWithout, toolRows(withoutFolder)[0]!)
  const argsText = JSON.stringify(parentArgs)

  assert.equal(nodeOf(withView, withRootId).props['target'], 'src/a.ts')
  assert.equal(nodeOf(withView, withRootId).props['targetKind'], 'path',
    'the B1-proven parent target kind survives the subtree')
  assert.equal(nodeOf(withView, withRootId).props['status'], 'done')
  assert.deepEqual(nodeOf(withView, `${withRootId}.args`).props, { key: 'args', text: argsText, wrap: true })
  assert.deepEqual(nodeOf(withView, `${withRootId}.result`).props, { key: 'result', text: outcome, wrap: true })
  const childId = `${withRootId}.sub-code-1:code:1`
  assert.equal(nodeOf(withView, childId).props['target'], 'src/a.ts')
  assert.equal(nodeOf(withView, childId).props['targetKind'], 'text',
    'a child target is never re-classified from the parent presenter')

  assert.deepEqual(nodeOf(withoutView, withoutRootId).props, nodeOf(withView, withRootId).props,
    'the parent tool props are unchanged by the subtree')
  assert.deepEqual(nodeOf(withoutView, `${withoutRootId}.args`).props, { key: 'args', text: argsText },
    'without a subtree the args node keeps its exact pre-B2 props')
  assert.deepEqual(nodeOf(withoutView, `${withoutRootId}.result`).props, { key: 'result', text: outcome })
  assert.equal(flatten(withoutView).some(node => node.id.endsWith('.child-head')), false)
  assert.equal(flatten(withoutView).some(node => node.kind === 'code' && node.props['wrap'] === true), false,
    'no childless row is wrapped')
})

test('B2-T10: 64 direct children plus a four-level chain render in order without truncation', (t) => {
  const events: SessionEvent[] = [ev('turn/start', { turn: 1 }, 0), runCodeCall(1, 'code-1')]
  let seq = 2
  for (let index = 1; index <= 64; index += 1) {
    const sub = `code-1:code:${index}`
    const args = { command: `run-${index}`, description: `Child ${index}` }
    events.push(
      ptcStart(seq++, 'code-1', 'code-1', sub, 'bash', args),
      ptcSettle(seq++, 'code-1', 'code-1', sub, 'bash', args, `out-${index}`),
    )
  }
  // Four recursive descendants under the LAST direct child.
  let parent = 'code-1:code:64'
  const chain: string[] = []
  for (let level = 1; level <= 4; level += 1) {
    const sub = `${parent}:code:1`
    const args = { file_path: `nested-${level}.ts` }
    events.push(
      ptcStart(seq++, 'code-1', parent, sub, 'read', args),
      ptcSettle(seq++, 'code-1', parent, sub, 'read', args, `nested-${level}`),
    )
    chain.push(sub)
    parent = sub
  }
  events.push(parentSettle(seq, 'code-1', 'program output'))
  const folder = new TranscriptFolder()
  folder.apply(events)
  const keys = new TranscriptNodeKeys()
  const started = performance.now()
  const view = viewOf(folder, keys)
  const elapsed = performance.now() - started
  t.diagnostic(`production mapper rendered 69 native tool nodes in ${elapsed.toFixed(1)}ms`)
  assert.ok(elapsed < 2000, `the production mapper finished a 64-child/4-level tree in ${elapsed.toFixed(1)}ms`)

  const rootId = workChildNodeId(view, keys, toolRows(folder)[0]!)
  assert.equal(nodeOf(view, `${rootId}.child-head`).props['text'], 'Child calls · 64')
  const ids = flatten(view).map(node => node.id)
  const childId = (index: number): string => `${rootId}.sub-code-1:code:${index}`
  const positions = new Map(ids.map((id, index) => [id, index]))
  for (let index = 1; index <= 64; index += 1) {
    assert.ok(positions.has(childId(index)), `direct child ${index} is present, not truncated`)
    if (index > 1) {
      assert.ok(positions.get(childId(index - 1))! < positions.get(childId(index))!,
        'direct children keep their durable dispatch order')
    }
  }
  let parentId = childId(64)
  for (const sub of chain) {
    const id = `${parentId}.sub-${sub}`
    const node = nodeOf(view, id)
    assert.equal(node.parent, parentId)
    assert.equal(node.props['status'], 'done')
    parentId = id
  }
  assert.equal(flatten(view).filter(node => node.kind === 'tool').length, 69,
    '1 root + 64 direct children + 4 recursive descendants')
  assert.equal(nodeOf(view, childId(64)).props['title'], 'Bash')
  assert.equal(nodeOf(view, `${childId(64)}.result`).props['text'], 'out-64')
  assert.equal(nodeOf(view, `${parentId}.result`).props['text'], 'nested-4')
  assert.equal(nodeOf(view, `${rootId}.result`).props['text'], 'program output')
})

// ── PR-B3: the native Preparing rows ─────────────────────────────────────────
//
// The Preparing row is a PRESENTATION of the application owner's live
// tool-call projection. These cases exercise the production mapper over the
// real `View.from` encoding: the placement rule (only the trailing open Work
// adopts its own turn's rows), the identity rule (the call's own id, the
// durable turn/step/index before it) and the content rule (the owner's name,
// summary and exact byte count — never a re-parsed partial argument payload).

/** One live Preparing preview: the application owner's projection of a tool
 * call whose arguments are still streaming. */
function preview(overrides: Partial<StreamingToolPreview> & { readonly turn: number }): StreamingToolPreview {
  return {
    callId: '',
    step: 0,
    index: 0,
    argumentBytes: 7,
    ...overrides,
  }
}

/** One durable tool row (a Work member) of one turn. */
function workTool(turn: number, callId: string, name = 'read'): Extract<TranscriptMessage, { kind: 'tool' }> {
  return { kind: 'tool', turn, callId, name, args: '{}', result: '', status: 'running' }
}

/** One standalone Context row (a non-Work boundary between two Work runs). */
function contextRow(turn: number, text = 'injected context'): Extract<TranscriptMessage, { kind: 'system' }> {
  return { kind: 'system', turn, text, label: 'Context', context: true }
}

/** The mapper's view of one message set with the given Preparing snapshot. */
function viewWithPreviews(
  messages: readonly TranscriptMessage[],
  previews: readonly StreamingToolPreview[],
  keys: TranscriptNodeKeys = new TranscriptNodeKeys(),
  options: TranscriptViewOptions = {},
): View {
  return View.from({
    main: transcriptView(projectTranscriptStructure(messages), keys, { ...options, preparingPreviews: previews }),
  })
}

/** The native Preparing rows of a view, in tree order. */
function preparingRows(view: View): FlatNode[] {
  return flatten(view).filter(node => node.kind === 'row')
}

/** The visible text of one node's subtree (its `text` props, in order). */
function subtreeText(view: View, id: string): string {
  const root = view.regions[0]
  assert.ok(root !== undefined, 'the view carries a main region')
  const find = (tree: Tree): Tree | undefined => {
    if (tree.id === id) return tree
    for (const child of tree.children) {
      const hit = find(child)
      if (hit !== undefined) return hit
    }
    return undefined
  }
  const collect = (tree: Tree): string => {
    const own = typeof tree.props['text'] === 'string' ? tree.props['text'] : ''
    return own + tree.children.map(collect).join('')
  }
  const target = find(root)
  assert.ok(target !== undefined, `node ${id} exists`)
  return collect(target)
}

/** The `View.from` encoding of a view (the exact wire tree). */
function encoding(view: View): string {
  return JSON.stringify(view.regions)
}

test('B3-T01: an absent or empty Preparing snapshot renders the baseline byte for byte', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1'), { kind: 'user', turn: 0, text: 'go' }]
  const baseline = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys()) })
  const absent = View.from({ main: transcriptView(projectTranscriptStructure(messages), new TranscriptNodeKeys(), {}) })
  const empty = viewWithPreviews(messages, [])
  assert.equal(encoding(absent), encoding(baseline), 'the absent option changes nothing in the tree')
  assert.equal(encoding(empty), encoding(baseline), 'the empty snapshot changes nothing in the tree')
  assert.equal(preparingRows(empty).length, 0, 'no Preparing row exists')
})

test('B3-T02: an anonymous delta renders ONE plain text row and no status at all', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const baseline = viewWithPreviews(messages, [])
  const view = viewWithPreviews(messages, [preview({ turn: 1, argumentBytes: 7 })])
  const rows = preparingRows(view)
  assert.equal(rows.length, 1, 'exactly one Preparing row')
  assert.equal(subtreeText(view, rows[0]!.id), 'Preparing tool… · 7 B', 'the honest first frame')
  const nodes = flatten(view)
  assert.equal(nodes.filter(node => node.kind === 'badge').length, 0, 'no badge')
  assert.equal(nodes.filter(node => node.kind === 'card').length, 0, 'no card')
  assert.equal(
    nodes.filter(node => node.kind === 'tool').length,
    flatten(baseline).filter(node => node.kind === 'tool').length,
    'the Preparing row adds no tool node — the durable Work tool is untouched',
  )
  assert.equal(rows[0]!.kind, 'row', 'the Preparing row is a plain native row')
  const props = JSON.stringify(nodes.map(node => node.props))
  assert.ok(!props.includes('pending'), 'no pending status')
  assert.ok(!props.includes('ago'), 'no elapsed timer')
  assert.ok(!props.includes('elapsed'), 'no elapsed timer')
})

test('B3-T03: a known name, the owner summary and the exact byte count are shown as they are', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const view = viewWithPreviews(messages, [preview({
    turn: 1,
    callId: 'call-bash',
    name: 'bash',
    summary: 'Run focused tests',
    argumentBytes: 23,
    scanPrefix: '{"command":"pnpm test --filter transcript"',
  })])
  const rows = preparingRows(view)
  assert.equal(rows.length, 1)
  assert.equal(subtreeText(view, rows[0]!.id), 'Preparing Bash… · Run focused tests · 23 B')
  const props = JSON.stringify(flatten(view).map(node => node.props))
  assert.ok(!props.includes('pnpm test --filter transcript'),
    'the partial argument prefix never reaches the view')
  // The owner keeps its own raw values; the mapper only reads them.
  const source = preview({ turn: 1, callId: 'call-bash', name: 'bash', summary: 'Run focused tests', argumentBytes: 23 })
  assert.equal(source.summary, 'Run focused tests')
  assert.equal(source.argumentBytes, 23)
})

test('B3-T04: more streamed bytes update the row in place — the node id never changes', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const keys = new TranscriptNodeKeys()
  const before = viewWithPreviews(messages, [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })], keys)
  const beforeRow = preparingRows(before)[0]!
  const after = viewWithPreviews(messages, [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 69 })], keys)
  const afterRow = preparingRows(after)[0]!
  assert.equal(afterRow.id, beforeRow.id, 'the row keeps its SDK node id across a byte update')
  assert.equal(subtreeText(after, afterRow.id), 'Preparing Bash… · 69 B')

  const ops = before.ops(after, 's1')
  assert.equal(ops.filter(op => op[0] === 'del').length, 0, 'nothing is deleted')
  assert.equal(ops.filter(op => op[0] === 'add').length, 0, 'nothing is re-added')
  assert.equal(ops.filter(op => op[0] === 'move').length, 0, 'nothing moves')
  const textOps = ops.filter(op => op[0] === 'text')
  assert.equal(textOps.length, 1, 'only the byte text changed')
  assert.equal(textOps[0]![1], `${afterRow.id}.bytes`, 'the byte text node carries the update')
})

test('B3-T05: a late call id replaces the anonymous row — one row, new id, stable durable ids', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const keys = new TranscriptNodeKeys()
  const before = viewWithPreviews(messages, [preview({ turn: 1, step: 2, index: 0, argumentBytes: 23 })], keys)
  const beforeRow = preparingRows(before)[0]!
  assert.ok(beforeRow.id.endsWith('.preparing-idx-1-2-0'), `the anonymous row is keyed by its position: ${beforeRow.id}`)
  const durableId = flatten(before).find(node => node.kind === 'tool')!.id

  const after = viewWithPreviews(messages, [preview({ turn: 1, step: 2, index: 0, callId: 'call-bash', argumentBytes: 23 })], keys)
  const afterRow = preparingRows(after)[0]!
  assert.equal(preparingRows(after).length, 1, 'exactly one row remains')
  assert.ok(afterRow.id.endsWith('.preparing-call-bash'), `the late id names the row: ${afterRow.id}`)
  assert.notEqual(afterRow.id, beforeRow.id, 'the anonymous id is gone')
  assert.ok(!flatten(after).some(node => node.id.includes('preparing-idx-')), 'the old id is fully gone')
  assert.equal(flatten(after).find(node => node.kind === 'tool')!.id, durableId, 'the durable tool id is untouched')
  assert.equal(flatten(after).find(node => node.kind === 'section')!.id, flatten(before).find(node => node.kind === 'section')!.id,
    'the Work section id is untouched')
})

test('B3-T06: parallel previews render one row each, in index order, with no aggregation', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const view = viewWithPreviews(messages, [
    preview({ turn: 1, callId: 'call-b', name: 'bash', summary: 'second', argumentBytes: 43, index: 1 }),
    preview({ turn: 1, callId: 'call-a', name: 'read', summary: 'first', argumentBytes: 28, index: 0 }),
  ])
  const rows = preparingRows(view)
  assert.equal(rows.length, 2, 'one row per preview')
  assert.deepEqual(rows.map(row => subtreeText(view, row.id)), [
    'Preparing Read… · first · 28 B',
    'Preparing Bash… · second · 43 B',
  ], 'the rows keep the index order, whatever order they arrived in')
  const props = JSON.stringify(flatten(view).map(node => node.props))
  assert.ok(!props.includes('+2'), 'no aggregate count')
})

test('B3-T07: only the LAST open Work adopts the rows — an older Work is never reopened', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-a'), contextRow(1), workTool(1, 'call-b')]
  const blocks = projectTranscriptStructure(messages)
  assert.deepEqual(blocks.map(block => block.kind), ['work', 'message', 'work'], 'the fixture is Work, Context, Work')
  const view = viewWithPreviews(messages, [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })])
  const sections = flatten(view).filter(node => node.kind === 'section')
  assert.equal(sections.length, 2, 'both Work runs are rendered')
  const rows = preparingRows(view)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.parent, sections[1]!.id, 'the row is a child of the LAST Work section')
  assert.notEqual(rows[0]!.parent, sections[0]!.id, 'the older Work gained no child')
})

test('B3-T08: without an open Work the rows stand alone after the transcript', () => {
  const withTail: TranscriptMessage[] = [workTool(1, 'call-a'), { kind: 'user', turn: 0, text: 'and now?' }]
  const tailView = viewWithPreviews(withTail, [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })])
  const tailRows = preparingRows(tailView)
  assert.equal(tailRows.length, 1)
  assert.equal(tailRows[0]!.parent, 'main', 'the row stands alone at the transcript top level')
  const section = flatten(tailView).find(node => node.kind === 'section')!
  assert.equal(flatten(tailView).filter(node => node.parent === section.id).length, 1,
    'the old Work gained no child')

  const withoutWork: TranscriptMessage[] = [{ kind: 'user', turn: 0, text: 'no work yet' }]
  const noWorkView = viewWithPreviews(withoutWork, [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })])
  assert.equal(preparingRows(noWorkView).length, 1)
  assert.equal(preparingRows(noWorkView)[0]!.parent, 'main', 'the row stands alone')
})

test('B3-T09: previews of several turns keep their own groups — never the first turn for all', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-a'), workTool(2, 'call-b')]
  const view = viewWithPreviews(messages, [
    preview({ turn: 2, callId: 'call-bash', name: 'bash', argumentBytes: 23, index: 0 }),
    preview({ turn: 1, callId: 'call-read', name: 'read', argumentBytes: 28, index: 0 }),
  ])
  const rows = preparingRows(view)
  assert.equal(rows.length, 2)
  const sections = flatten(view).filter(node => node.kind === 'section')
  const adopted = rows.find(row => row.parent === sections[1]!.id)
  const standalone = rows.find(row => row.parent === 'main')
  assert.ok(adopted !== undefined, 'the open turn is adopted by its own Work')
  assert.ok(standalone !== undefined, 'the older turn stands alone')
  assert.equal(subtreeText(view, adopted.id), 'Preparing Bash… · 23 B')
  assert.equal(subtreeText(view, standalone.id), 'Preparing Read… · 28 B')
  assert.equal(standalone.id, 'main.preparing-call-read', 'the standalone row is scope-keyed at the top level')
})

test('B3-T10: a hostile or workspace path summary is displayed safely and relatively', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const hostile = 'safe\u001b]52;c;LEAK\u0007\u001b[2Jline\u000bsecond'
  const view = viewWithPreviews(messages, [
    preview({ turn: 1, callId: 'call-read', name: 'read', summary: '/workspace/src/index.ts', argumentBytes: 28 }),
    preview({ turn: 1, callId: 'call-cjk', name: 'bash', summary: hostile, argumentBytes: 12, index: 1 }),
  ], new TranscriptNodeKeys(), { cwd: '/workspace' })
  const rows = preparingRows(view)
  assert.equal(rows.length, 2)
  assert.equal(subtreeText(view, rows[0]!.id), 'Preparing Read… · src/index.ts · 28 B',
    'a workspace path is relativized for display only')
  assert.equal(subtreeText(view, rows[1]!.id), 'Preparing Bash… · safelinesecond · 12 B',
    'the control bytes never reach the view and the line break became one space')
  const props = JSON.stringify(flatten(view).map(node => node.props))
  assert.ok(!props.includes('\u001b'), 'no raw ESC reaches a node prop')
  assert.ok(!props.includes('\u0007'), 'no raw BEL reaches a node prop')
  assert.ok(!props.includes('LEAK'), 'the OSC payload is dropped')
  assert.ok(props.includes('28 B'), 'the byte count survives')
})

test('B3-T11: the formal tool call replaces the Preparing row in the same frame', () => {
  const keys = new TranscriptNodeKeys()
  const existing = workTool(1, 'call-1')
  const preparing = viewWithPreviews([existing], [preview({ turn: 1, callId: 'call-bash', name: 'bash', argumentBytes: 23 })], keys)
  const durableId = flatten(preparing).find(node => node.kind === 'tool')!.id
  const formal: TranscriptMessage[] = [
    existing,
    { kind: 'tool', turn: 1, callId: 'call-bash', name: 'bash', args: '{"command":"pnpm test"}', result: '', status: 'running' },
  ]
  const settled = viewWithPreviews(formal, [], keys)
  assert.equal(preparingRows(settled).length, 0, 'the Preparing row is gone')
  assert.equal(flatten(settled).filter(node => node.kind === 'tool').length, 2, 'both durable tools are present')
  assert.ok(flatten(settled).some(node => node.id === durableId), 'the existing durable id is stable')
  assert.ok(!JSON.stringify(flatten(settled).map(node => node.props)).includes('Preparing'),
    'no Preparing text remains')
})

test('B3-T12: the owner\'s anonymous-to-named update is ONE row, never a double draw', () => {
  const messages: TranscriptMessage[] = [workTool(1, 'call-1')]
  const previews = new Map<string, StreamingToolPreview>()
  upsertStreamingToolPreview(previews, { callId: '', turn: 1, step: 0, index: 0, argumentsDelta: '{"comm' }, toolSummaryKeys)
  assert.equal(previews.size, 1, 'the anonymous preview is one entry')
  upsertStreamingToolPreview(previews, { callId: 'call-bash', turn: 1, step: 0, index: 0, name: 'bash', argumentsDelta: 'and":"pnpm test"}' }, toolSummaryKeys)
  assert.equal(previews.size, 1, 'the named call replaces the anonymous entry')
  const snapshot = streamingToolPreviewSnapshot(previews)
  assert.equal(snapshot.length, 1)
  const view = viewWithPreviews(messages, snapshot)
  const rows = preparingRows(view)
  assert.equal(rows.length, 1, 'exactly one row')
  assert.equal(subtreeText(view, rows[0]!.id), 'Preparing Bash… · pnpm test · 23 B')
  assert.ok(!subtreeText(view, rows[0]!.id).includes('{"comm'), 'no partial JSON is displayed')
})
