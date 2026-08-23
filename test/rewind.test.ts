/**
 * Tests for the conversation rewind model and workflow (fork_rewind plan):
 * - R01–R09: the pure event-log model in src/rewind.ts (candidates, seeds,
 *   previews, multimodal flags, malformed spans);
 * - the shared fork creation (src/session-fork.ts): metadata inheritance
 *   and the stale-selection gates of the commit workflow (I01/I03/I05/I06
 *   shapes);
 * - C01–C05: the `/rewind` command surface (registered through
 *   registerTuiCommands with a stub runner).
 * @module @xmoon76/dsh-pi-tui/rewind.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import {
  collectRewindCandidates,
  isHumanTurnMessage,
  rewindPickerItem,
  rewindSeed,
  type RewindCandidate,
} from '../src/rewind.ts'
import { commitRewind, createForkedAgent, isRewindIdentityCurrent, SWAP_STALE_MESSAGE, type RewindCommitHost, type RewindLiveIdentity } from '../src/session-fork.ts'
import { SessionTransitionGate } from '../src/transition-gate.ts'
import { forkSeed, registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'

// ── event fixtures ─────────────────────────────────────────────────────────

/** Build a minimal event envelope for tests. */
function event<K extends SessionEvent['type']>(type: K, data: SessionEvent<K>['data'], seq: number): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function turnStart(seq: number, turn: number): SessionEvent {
  return event('turn/start', { turn }, seq)
}

function turnEnd(seq: number, turn: number): SessionEvent {
  return event('turn/end', { turn, reason: { kind: 'completed' } }, seq)
}

function userMessage(seq: number, text: string, source: Record<string, unknown> = { kind: 'user' }): SessionEvent<'user/message'> {
  return event('user/message', {
    id: MessageId(`msg-${seq}`),
    role: 'user',
    content: [{ type: 'text', text }],
    source: source as never,
  }, seq) as SessionEvent<'user/message'>
}

function imageBlock(seq: number): ContentBlock {
  return {
    type: 'image',
    attachment: { attachmentId: `att-${seq}`, mediaType: 'image/png', bytes: 10, width: 10, height: 10 },
  } as ContentBlock
}

function multimodalMessage(seq: number, text: string): SessionEvent<'user/message'> {
  return event('user/message', {
    id: MessageId(`msg-${seq}`),
    role: 'user',
    content: [{ type: 'text', text }, imageBlock(seq)],
    source: { kind: 'user' },
  }, seq) as SessionEvent<'user/message'>
}

/** One completed turn: start → user prompt → assistant → end. */
function turn(seq: number, turnNo: number, prompt: string): SessionEvent[] {
  return [
    turnStart(seq, turnNo),
    userMessage(seq + 1, prompt),
    event('assistant/message', {
      turn: turnNo,
      step: 0,
      message: {
        id: MessageId(`msg-a-${seq}`),
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
    }, seq + 2),
    turnEnd(seq + 3, turnNo),
  ]
}

function typesOf(events: readonly SessionEvent[]): string[] {
  return events.map(e => e.type)
}

// ── R01–R09: the event model ───────────────────────────────────────────────

test('R01: a single completed turn yields one candidate with an EMPTY seed', () => {
  const events = turn(0, 1, 'first prompt')
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]!
  assert.equal(candidate.turn, 1)
  assert.equal(candidate.editorText, 'first prompt')
  assert.deepEqual(rewindSeed(events, candidate), [])
})

test('R02: multi-turn — the seed is everything before the selected turn/start', () => {
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B'), ...turn(8, 3, 'C')]
  const candidates = collectRewindCandidates(events)
  assert.deepEqual(candidates.map(c => c.turn), [3, 2, 1], 'newest first')
  const seed = rewindSeed(events, candidates[1]!) // turn 2
  assert.deepEqual(typesOf(seed), ['turn/start', 'user/message', 'assistant/message', 'turn/end'])
  assert.ok(!seed.some(e => e.seq >= 4), 'nothing from turn 2 onwards may enter the seed')
})

test('R03: log-only state events between turns stay in the seed', () => {
  const events = [
    ...turn(0, 1, 'A'),
    event('todo/write', { todos: [] }, 4),
    { type: 'permission/preset', seq: 5, time: 1_700_000_000_005, data: { agentPreset: 'standard' } } as SessionEvent,
    ...turn(6, 2, 'B'),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 2)
  const seed = rewindSeed(events, candidates[0]!) // turn 2
  assert.deepEqual(typesOf(seed), [
    'turn/start', 'user/message', 'assistant/message', 'turn/end',
    'todo/write', 'permission/preset',
  ], 'the state events between turn 1 and turn 2 must survive')
})

test('R04: the open (unfinished) turn is never a candidate', () => {
  const events = [...turn(0, 1, 'A'), turnStart(4, 2), userMessage(5, 'B in flight')]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.turn, 1)
})

test('R05: injected user/message sources never form extra rows', () => {
  const events = [
    turnStart(0, 1),
    userMessage(1, 'human prompt'),
    userMessage(2, 'AGENTS.md instructions', { kind: 'plugin', plugin: 'dsh-system-prompt', form: 'instructions' }),
    userMessage(3, 'skill body', { kind: 'plugin', plugin: 'skill-catalog', form: 'instructions' }),
    turnEnd(4, 1),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1, 'injected context must not add rows')
  assert.equal(candidates[0]!.editorText, 'human prompt', 'the primary prompt is the human message')
})

test('R06: steers inside one turn do not create new rewind points', () => {
  const events = [
    turnStart(0, 1),
    userMessage(1, 'primary prompt'),
    userMessage(2, 'steer follow-up'),
    userMessage(3, 'another steer'),
    turnEnd(4, 1),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1, 'one turn = one row, steers included')
  assert.equal(candidates[0]!.editorText, 'primary prompt')
  assert.equal(candidates[0]!.messageSeq, 1)
})

test('R07: compaction-shadowed history still yields candidates from the raw log', () => {
  // The raw append-only log keeps the ORIGINAL user events even after a
  // compaction replacement — the source of truth is session.events, never
  // the folded surface projection. Compaction events are structural
  // (dsh-compaction augments the map; the transcript treats them the same).
  const compaction = (type: string, data: Record<string, unknown>, seq: number): SessionEvent =>
    ({ type, seq, time: 1_700_000_000_000 + seq, data }) as SessionEvent
  const events = [
    ...turn(0, 1, 'old prompt'),
    compaction('compaction/start', { id: 'c1' }, 4),
    compaction('compaction/summary', { id: 'c1', summary: [], shadowedSeqs: [0, 1, 2, 3], shadowedTokenCount: 10 }, 5),
    compaction('compaction/end', { id: 'c1' }, 6),
    ...turn(7, 2, 'recent prompt'),
  ]
  const candidates = collectRewindCandidates(events)
  assert.deepEqual(candidates.map(c => c.turn), [2, 1], 'the shadowed turn 1 is still rewindable')
  assert.deepEqual(rewindSeed(events, candidates[1]!), [], 'rewinding to turn 1 gives the pre-history prefix')
})

test('R08: a multimodal prompt sets hasNonTextContent and restores text only', () => {
  const events = [turnStart(0, 1), multimodalMessage(1, 'analyse this screenshot'), turnEnd(2, 1)]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1)
  const candidate = candidates[0]!
  assert.equal(candidate.hasNonTextContent, true)
  assert.equal(candidate.editorText, 'analyse this screenshot', 'text blocks only')
  const item = rewindPickerItem(candidate)
  assert.ok(item.label.startsWith('turn 1 · [image] '), `image marker missing: ${item.label}`)
})

test('R08: an image-only prompt is still a candidate with an explicit marker', () => {
  const events = [
    turnStart(0, 1),
    event('user/message', {
      id: MessageId('msg-1'),
      role: 'user',
      content: [imageBlock(1)],
      source: { kind: 'user' },
    }, 1),
    turnEnd(2, 1),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]!.hasNonTextContent, true)
  assert.equal(candidates[0]!.editorText, '')
  assert.ok(rewindPickerItem(candidates[0]!).label.includes('(image only)'))
})

test('R09: malformed spans are skipped, never thrown to the UI', () => {
  const events = [
    // turn 1 never ends: a second turn/start opens over it.
    turnStart(0, 1),
    userMessage(1, 'orphan prompt'),
    turnStart(2, 2),
    userMessage(3, 'B'),
    turnEnd(4, 2),
    // A stray turn/end with no open turn.
    turnEnd(5, 99),
  ]
  const candidates = collectRewindCandidates(events)
  assert.equal(candidates.length, 1, 'only the balanced span survives')
  assert.equal(candidates[0]!.turn, 2)
})

test('previews are single-line and bounded', () => {
  const long = `line one\n\nline two with  ${'very '.repeat(8)}text ${'x'.repeat(200)}`
  const events = [turnStart(0, 1), userMessage(1, long), turnEnd(2, 1)]
  const candidate = collectRewindCandidates(events)[0]!
  assert.ok(!candidate.preview.includes('\n'), 'no newlines in the preview')
  assert.ok(candidate.preview.length <= 121, 'the preview is bounded')
})

test('isHumanTurnMessage centralizes the source-kind rule', () => {
  assert.equal(isHumanTurnMessage(userMessage(0, 'hi', { kind: 'user' })), true)
  assert.equal(isHumanTurnMessage(userMessage(0, 'hi', { kind: 'plugin', plugin: 'x', form: 'instructions' })), false)
})

test('rewindSeed refuses a vanished point and an open-turn boundary', () => {
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B')]
  const stale: RewindCandidate = { turnStartSeq: 999, turn: 9, messageSeq: 1, editorText: 'x', preview: 'x', hasNonTextContent: false }
  assert.throws(() => rewindSeed(events, stale), /no longer exists/)
  // A seed whose last turn boundary is an OPEN turn/start (the previous
  // span never closed — malformed log) is refused.
  const openEvents = [
    turnStart(0, 1),
    userMessage(1, 'A'),
    // turn 1 never ends; turn 2 starts over it.
    turnStart(2, 2),
    userMessage(3, 'B'),
    turnEnd(4, 2),
  ]
  const forged: RewindCandidate = { turnStartSeq: 2, turn: 2, messageSeq: 3, editorText: '', preview: '', hasNonTextContent: false }
  assert.throws(() => rewindSeed(openEvents, forged), /open turn/)
})

// ── createForkedAgent: C04 metadata (preset/cwd/parent/seed/provider) ─────

interface CreatedCall {
  sessionId: string
  meta: Record<string, unknown>
  agentOptions: { provider?: string; model?: string }
  seed?: readonly SessionEvent[]
}

interface ForkRig {
  host: RewindCommitHost
  created: CreatedCall[]
  resolved: string[]
  swapped: string[]
  disposed: string[]
  drafts: string[]
  state: { sessionId: string; generation: number }
}

/** A fully scriptable rewind-commit rig: the identity reads live state, and
 * tests may flip `rig.state` between the gates. */
function makeRig(options: {
  sessionCwd?: string
  composePreset?: string
  createError?: string
  swapError?: string
  /** Full swapTo override (wins over swapError); receives the expected identity. */
  swapTo?: (next: AgentHandle, expected?: RewindLiveIdentity) => Promise<string | undefined>
  createHook?: (call: CreatedCall) => void
} = {}): ForkRig {
  const created: CreatedCall[] = []
  const resolved: string[] = []
  const swapped: string[] = []
  const disposed: string[] = []
  const drafts: string[] = []
  const state = { sessionId: 'session-source', generation: 1 }
  const host: RewindCommitHost = {
    sessionCwd: () => options.sessionCwd ?? '/live-ws',
    compose: async (presetId?: string) => {
      resolved.push(presetId ?? '(default)')
      return options.composePreset === undefined
        ? { setup: () => {} }
        : { agentPreset: options.composePreset, setup: () => {} }
    },
    agents: {
      create: async (call) => {
        if (options.createError !== undefined) throw new Error(options.createError)
        const record: CreatedCall = {
          sessionId: String(call.sessionId),
          meta: call.meta,
          agentOptions: call.agentOptions,
          seed: call.seed,
        }
        created.push(record)
        options.createHook?.(record)
        return { agent: { session: { id: record.sessionId } } } as unknown as AgentHandle
      },
    },
    liveIdentity: () => ({ sessionId: state.sessionId, generation: state.generation }),
    swapTo: async (next, expected) => {
      swapped.push(next.agent.session.id)
      if (options.swapTo !== undefined) return options.swapTo(next, expected)
      return options.swapError
    },
    disposeAgent: async (handle) => { disposed.push(handle.agent.session.id) },
    replaceDraft: (text) => { drafts.push(text) },
  }
  return { host, created, resolved, swapped, disposed, drafts, state }
}

function sourceAgent(sessionId = 'session-source', events: readonly SessionEvent[] = [], agentPreset?: string, cwd = '/ws'): Agent {
  return {
    session: {
      id: sessionId,
      header: { version: 0, id: sessionId, createdAt: 1, cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
      events,
    },
    options: { provider: 'deepseek', model: 'deepseek-chat' },
  } as unknown as Agent
}

test('C04: createForkedAgent records preset, source cwd, parent, seedLength, provider/model', async () => {
  const rig = makeRig({ sessionCwd: '/other-cwd', composePreset: 'minimal' })
  const seed = turn(0, 1, 'A')
  // The source's recorded preset (header) resolves to 'minimal'; its header
  // cwd is '/ws' — the child's cwd is the SOURCE's workspace (the live
  // surface cwd '/other-cwd' only matters for a header without one).
  const next = await createForkedAgent(rig.host, sourceAgent('session-parent', [], 'minimal'), seed)
  assert.deepEqual(rig.resolved, ['minimal'])
  assert.equal(rig.created.length, 1)
  const call = rig.created[0]!
  assert.equal(call.meta.cwd, '/ws', 'the SOURCE workspace wins, never a live-surface value')
  assert.equal(call.meta.agentPreset, 'minimal')
  assert.equal(call.meta.parentSession, 'session-parent')
  assert.equal(call.meta.seedLength, 4)
  assert.deepEqual(call.agentOptions, { provider: 'deepseek', model: 'deepseek-chat' })
  assert.equal(call.seed, seed)
  assert.equal(next.agent.session.id, call.sessionId)
  assert.ok(call.sessionId.startsWith('session-'))
})

test('review P2: the cwd is captured BEFORE the compose await (no parent=A cwd=B mix)', async () => {
  let liveCwd = '/ws-a'
  const created: CreatedCall[] = []
  const rig = makeRig({ sessionCwd: '/ws-a' })
  // The compose await is where a concurrent switch could land; the helper
  // must have already captured the cwd.
  const host: RewindCommitHost = {
    ...rig.host,
    sessionCwd: () => liveCwd,
    compose: async () => {
      liveCwd = '/ws-b' // a switch lands DURING the compose await
      return { setup: () => {} }
    },
    agents: {
      create: async (call) => {
        created.push({ sessionId: String(call.sessionId), meta: call.meta, agentOptions: call.agentOptions, seed: call.seed })
        return { agent: { session: { id: String(call.sessionId) } } } as unknown as AgentHandle
      },
    },
  }
  // The source header has NO cwd: the fallback is the live cwd captured at
  // entry — '/ws-a', never the post-switch '/ws-b'.
  const source = sourceAgent('session-parent', [], undefined, '')
  await createForkedAgent(host, source, [])
  assert.equal(created[0]!.meta.cwd, '/ws-a', 'the cwd is the pre-await capture, never the post-switch value')
})

test('review P2: a source header WITHOUT a cwd falls back to the live surface cwd', async () => {
  const rig = makeRig({ sessionCwd: '/live-fallback' })
  const source = sourceAgent('session-parent', [], undefined, '')
  await createForkedAgent(rig.host, source, [])
  assert.equal(rig.created[0]!.meta.cwd, '/live-fallback')
})

test('createForkedAgent without a preset omits agentPreset from the meta', async () => {
  const rig = makeRig()
  await createForkedAgent(rig.host, sourceAgent(), [])
  assert.equal('agentPreset' in rig.created[0]!.meta, false)
})

// ── commitRewind: the selection workflow ───────────────────────────────────

test('I01: commitRewind creates, swaps and restores the selected prompt', async () => {
  const rig = makeRig()
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B')]
  const candidates = collectRewindCandidates(events)
  // Newest first: candidates[0] is turn 2 (the "rewind to B" case).
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'rewound')
  if (outcome.kind !== 'rewound') return
  assert.equal(outcome.turn, 2)
  assert.equal(rig.created.length, 1)
  assert.equal(rig.created[0]!.meta.parentSession, 'session-source')
  assert.equal(rig.created[0]!.meta.seedLength, 4, 'seed = everything before turn 2/start')
  assert.deepEqual(rig.swapped, [rig.created[0]!.sessionId])
  assert.deepEqual(rig.drafts, ['B'], 'the selected prompt restores into the editor')
})

test('I03: rewinding to the FIRST turn seeds an empty child', async () => {
  const rig = makeRig()
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'rewound')
  assert.equal(rig.created[0]!.meta.seedLength, 0)
})

test('I05 gate 1: a stale generation cancels BEFORE any create', async () => {
  const rig = makeRig()
  rig.state.generation = 2
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'stale')
  assert.equal(rig.created.length, 0, 'no child may be created for a stale picker')
  assert.equal(rig.swapped.length, 0)
})

test('I05 gate 2: a surface switch DURING create disposes the ghost child', async () => {
  const rig = makeRig({
    // The session switches while the create is in flight: gate 1 passes,
    // gate 2 sees the new owner.
    createHook: () => { rig.state.sessionId = 'session-other'; rig.state.generation = 3 },
  })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'stale')
  assert.equal(rig.created.length, 1, 'the child was created before the switch')
  assert.equal(rig.swapped.length, 0, 'the swap must not commit into a stale surface')
  assert.equal(rig.disposed.length, 1, 'the ghost child must be disposed, never left behind')
  assert.deepEqual(rig.drafts, [], 'no prompt restore for a stale commit')
})

test('review P1-2: a rewind commit holds the gate across create→swap; a concurrent switch queues behind it', async () => {
  const gate = new SessionTransitionGate()
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const source = sourceAgent('session-source', events)
  const order: string[] = []
  let releaseSwap!: () => void
  const swapHanging = new Promise<void>(resolve => { releaseSwap = resolve })
  const rig = makeRig({ swapTo: async () => { await swapHanging; return undefined } })
  // The commit runs inside the gate (the runner wraps commitRewind in
  // withSessionTransition) and the swap yields — the exact window where the
  // old TOCTOU let a concurrent switch land.
  const commit = gate.run(async () => {
    order.push('rewind-commit')
    return commitRewind(rig.host, source, candidates[0]!, { sessionId: 'session-source', generation: 1 })
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const switched = gate.run(async () => { order.push('switch') })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(order, ['rewind-commit'], 'the switch must queue while the rewind swap is in flight')
  releaseSwap()
  const outcome = await commit
  assert.equal(outcome.kind, 'rewound')
  await switched
  assert.deepEqual(order, ['rewind-commit', 'switch'], 'the switch runs only after the rewind released the gate')
  assert.equal(rig.disposed.length, 0, 'nothing was stale — no ghost, no disposal')
})

test('a vanished rewind point fails cleanly without creating a child', async () => {
  const rig = makeRig()
  const events = turn(0, 1, 'A')
  const stale: RewindCandidate = { turnStartSeq: 999, turn: 9, messageSeq: 1, editorText: 'x', preview: 'x', hasNonTextContent: false }
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), stale, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.ok(outcome.message.includes('no longer exists'))
  assert.equal(rig.created.length, 0)
  assert.deepEqual(rig.drafts, [], 'the editor is never touched on failure')
})

test('a failed swap keeps the source and never touches the editor', async () => {
  const rig = makeRig({ swapError: 'swap failed: lock' })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.message, 'swap failed: lock')
  assert.deepEqual(rig.drafts, [], 'a failed swap must never overwrite the editor')
  // The surface still shows the source (the swap never assigned the child):
  // the ghost child is disposed through the official path (plan §12).
  assert.equal(rig.disposed.length, 1, 'the never-live child must be disposed')
})

test('review repro: the swap gate runs even when the surface became sessionless mid-flush', () => {
  // The gate is unconditional for expected-bearing swaps: a surface that
  // became sessionless (`sessionId: undefined`) during the flush can never
  // match the captured source and must refuse the swap — the runner uses
  // this exact predicate inside its commit boundary.
  const expected: RewindLiveIdentity = { sessionId: 'session-source', generation: 1 }
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-source', generation: 1 }, expected), true)
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-other', generation: 1 }, expected), false, 'a switched session refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-source', generation: 2 }, expected), false, 'a bumped generation refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: undefined, generation: 1 }, expected), false, 'a sessionless surface refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: undefined, generation: 3 }, expected), false, 'sessionless + bumped refuses')
})

test('review repro: a swap refused at the identity gate is stale and disposes the child', async () => {
  // The runner's swapTo refuses INSIDE its commit boundary (after the flush,
  // before any assignment) when the captured surface identity changed — the
  // swap returns the shared sentinel and mutates nothing.
  const rig = makeRig({
    swapTo: async (next, expected) => {
      assert.equal(expected?.sessionId, 'session-source', 'the expected identity must ride the swap')
      assert.equal(expected?.generation, 1)
      return SWAP_STALE_MESSAGE
    },
  })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'stale')
  assert.equal(rig.disposed.length, 1, 'the ghost child is disposed')
  assert.deepEqual(rig.drafts, [], 'no prompt restore for a refused swap')
})

test('review: a swap failing BEFORE assignment disposes the child (never a ghost)', async () => {
  // Flush/dispose-style failure: the swap returns an error WITHOUT making
  // the child live — the identity still shows the expected source.
  const rig = makeRig({ swapError: 'swap failed: flush' })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.message, 'swap failed: flush')
  assert.equal(rig.disposed.length, 1, 'a child that never went live is disposed')
  assert.deepEqual(rig.drafts, [])
})

test('review: a swap PARTIALLY committed (child live) is never disposed', async () => {
  // whenIdle-style failure: the swap assigned the child and then failed —
  // the surface identity moved to the child. Disposing would kill the live
  // agent; the shared swap failure cleanup owns that path.
  const rig = makeRig({
    swapTo: async (next) => {
      rig.state.sessionId = next.agent.session.id
      rig.state.generation = 2
      return 'swap failed: whenIdle'
    },
  })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.message, 'swap failed: whenIdle')
  assert.equal(rig.disposed.length, 0, 'a live child must never be disposed')
  assert.deepEqual(rig.drafts, [], 'no prompt restore for a partial commit')
})

test('a failed create rejects (the owned task surfaces it) and changes nothing', async () => {
  const rig = makeRig({ createError: 'roster unavailable' })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  await assert.rejects(
    commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, { sessionId: 'session-source', generation: 1 }),
    /roster unavailable/,
  )
  assert.equal(rig.swapped.length, 0)
  assert.deepEqual(rig.drafts, [])
})

// ── C01–C05: the /rewind command surface ───────────────────────────────────

function fakeCommandsService() {
  const defs: { name: string; description?: string; handler?: (inv: CommandInvocation) => unknown }[] = []
  return {
    defs,
    service: {
      register: (def: { name: string; description?: string; handler?: (inv: CommandInvocation) => unknown }): (() => void) => {
        defs.push(def)
        return () => {}
      },
      list: () => [],
      find: () => undefined,
      execute: async () => undefined,
    },
  }
}

function stubRunner(options: { ctx: Context; app: TuiApp; agent?: Agent; rewinds: number[]; ensureCalls: string[] }): TuiCommandRunner {
  return {
    ctx: options.ctx,
    app: options.app,
    diag: createDiag({ filePath: undefined, stderrLevel: 'off' }),
    get liveAgent() { return options.agent },
    ensureSession: async () => { options.ensureCalls.push('ensureSession') },
    get selected() { return { current: undefined, assembled: undefined, saveSelection: async () => {} } },
    tuiSettings: undefined,
    agents: {} as never,
    sessions: { flush: async () => {} },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    compose: async () => ({ setup: () => {} }),
    switchSession: async () => undefined,
    swapTo: async () => undefined,
    currentPreset: () => undefined,
    pendingPreset: undefined,
    effectivePresetId: undefined,
    refreshCatalog: async () => ({ kind: 'failed', error: 'not wired in tests' }),
    recomposeBlank: async () => ({ kind: 'locked' }),
    refreshStatus: () => {},
    updateWelcomeCard: () => {},
    openJobView: () => {},
    openTasksBrowser: () => {},
    openRewindPicker: () => { options.rewinds.push(1) },
    withSessionTransition: async (task) => task(),
    enterView: async () => {},
    requestExit: () => {},
    extensions: undefined,
    exit: () => {},
  }
}

function invoke(rawInput: string): CommandInvocation {
  return { commandId: CommandId('cmd-test'), agent: undefined as never, rawInput, attachments: [], signal: new AbortController().signal }
}

function setupCommands(options: { agent?: Agent } = {}): {
  vt: VirtualTerminal
  rewinds: number[]
  ensureCalls: string[]
  defs: { name: string; description?: string; handler?: (inv: CommandInvocation) => unknown }[]
  handler: (inv: CommandInvocation) => unknown
} {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  const rewinds: number[] = []
  const ensureCalls: string[] = []
  const commands = fakeCommandsService()
  const ctx = new Context()
  ctx.provide('commands', commands.service as never)
  registerTuiCommands(stubRunner({ ctx, app, agent: options.agent, rewinds, ensureCalls }))
  const rewind = commands.defs.find(def => def.name === 'rewind')
  assert.ok(rewind !== undefined, '/rewind must be registered')
  return { vt, rewinds, ensureCalls, defs: commands.defs, handler: rewind.handler! }
}

test('C01: /rewind is registered with the rewind description', async () => {
  const { defs } = setupCommands()
  const rewind = defs.find(def => def.name === 'rewind')!
  assert.ok(rewind.description !== undefined && rewind.description.includes('earlier user turn'), rewind.description)
})

test('C02: /rewind without a session opens the runner surface and NEVER creates one', async () => {
  const { vt, rewinds, ensureCalls, handler } = setupCommands()
  await vt.waitForRender()
  const outcome = await handler(invoke(''))
  assert.deepEqual(outcome, { kind: 'success' })
  assert.equal(rewinds.length, 1, 'the runner surface opens')
  assert.deepEqual(ensureCalls, [], 'a sessionless /rewind must never create a session')
})

test('C03: /rewind with a live session routes through the same surface', async () => {
  const { vt, rewinds, ensureCalls, handler } = setupCommands({ agent: sourceAgent() })
  await vt.waitForRender()
  await handler(invoke(''))
  assert.equal(rewinds.length, 1)
  assert.deepEqual(ensureCalls, [], 'no forced session creation for a UI command')
})

test('C05: /rewind returns success even when the runner surface decides no-op', async () => {
  const { vt, handler } = setupCommands()
  await vt.waitForRender()
  const outcome = await handler(invoke(''))
  assert.deepEqual(outcome, { kind: 'success' })
})

test('forkSeed stays the /fork seed rule (last completed turn, inclusive)', () => {
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B')]
  const seed = forkSeed(events)
  assert.equal(seed?.length, 8, 'fork = up to and including the last turn/end')
  assert.equal(seed?.at(-1)?.type, 'turn/end')
  assert.equal(forkSeed([userMessage(0, 'no turn')]), undefined)
  assert.equal(forkSeed([]), undefined)
})
