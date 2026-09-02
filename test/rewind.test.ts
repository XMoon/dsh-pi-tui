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
import { afterEach, test } from 'node:test'
import { CommandId } from '@deepseek-ai/dsh-commands'
import type { CommandInvocation } from '@deepseek-ai/dsh-commands'
import { Context } from '@deepseek-ai/cordis'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { SessionHandle } from '../src/runtime/session-lifecycle-port.ts'
import {
  collectRewindCandidates,
  isHumanTurnMessage,
  rewindPickerItem,
  rewindSeed,
  type RewindCandidate,
} from '../src/rewind.ts'
import { commitRewind, createForkedAgent, isRewindIdentityCurrent, type RewindCommitHost, type RewindLiveIdentity } from '../src/session-fork.ts'
import { SessionTransitionGate } from '../src/transition-gate.ts'
import { forkSeed, registerTuiCommands, type TuiCommandRunner } from '../src/commands.ts'
import { TuiApp } from '../src/tui-app.ts'
import { VirtualTerminal } from './virtual-terminal.ts'
import { createDiag } from '../src/diag.ts'
import { DraftImageStore } from '../src/image/draft-store.ts'
import { DirectCatalogPort } from '../src/runtime/direct/catalog-direct.ts'
import { DirectConfigPort } from '../src/runtime/direct/config-direct.ts'
import { DirectHostFilePort } from '../src/runtime/direct/host-file-direct.ts'

/** Re-vendor lifecycle follow-up P3: every TuiApp started in this file is
 * stopped after each test — the process's single-live-TUI slot (the
 * vendored keybindings are process-global) is held only by LIVE surfaces
 * (see src/process-tui-slot.ts). */
const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.stop() } catch {}
  }
})


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
  // compaction replacement — the source of truth is the session log
  // (served through the alpha.4 snapshot reads), never the folded surface
  // projection. Compaction events are structural (dsh-compaction augments
  // the map; the transcript treats them the same).
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
  inheritedEventCount?: number
  provider?: string
  model?: string
  agentPreset?: string
  seed?: readonly unknown[]
}

interface ForkRig {
  host: RewindCommitHost
  created: CreatedCall[]
  resolved: string[]
  committed: SessionHandle[]
  drafts: string[]
  state: { sessionId: string; generation: number }
}

/** A fully scriptable rewind-commit rig: the identity reads live state, and
 * tests may flip `rig.state` between the gates. The rig's `transitionTo`
 * models the runner's unified transaction: `prepare` runs first, `create`
 * runs (a throw becomes a `{ ok: false }` outcome — the runner's
 * transitionTo never lets a create failure escape), and on success the
 * child is considered COMMITTED (`committed` records it — the transaction
 * never rolls a published child back). */
function makeRig(options: {
  sessionCwd?: string
  composePreset?: string
  createError?: string
  /** Full transitionTo override (wins over the default implementation). */
  transitionTo?: <T>(steps: { target?: { id: string; header?: { cwd?: string } }; fresh?: boolean; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => Promise<{ ok: true; next: T } | { ok: false; message: string }>
  createHook?: (call: CreatedCall) => void
} = {}): ForkRig {
  const created: CreatedCall[] = []
  const resolved: string[] = []
  const committed: SessionHandle[] = []
  const drafts: string[] = []
  const state = { sessionId: 'session-source', generation: 1 }
  const host: RewindCommitHost = {
    sessionCwd: () => options.sessionCwd ?? '/live-ws',
    sessionPreset: (session) => session.header.agentPreset,
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
          ...call.inheritedEventCount === undefined ? {} : { inheritedEventCount: call.inheritedEventCount },
          provider: call.provider,
          model: call.model,
          agentPreset: call.agentPreset,
          seed: call.seed,
        }
        created.push(record)
        options.createHook?.(record)
        return { session: { id: record.sessionId }, direct: { agent: { session: { id: record.sessionId } }, ownerHandle: { dispose: async () => {} } } }
      },
      resume: async (call) => ({ session: { id: String(call.resumeSessionId) }, directAgent: { session: { id: String(call.resumeSessionId) } } }),
    },
    liveIdentity: () => ({ sessionId: state.sessionId, generation: state.generation }),
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; fresh?: boolean; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      if (options.transitionTo !== undefined) return options.transitionTo(steps)
      await steps.prepare?.()
      try {
        const next = await steps.create()
        // The runner's transaction COMMITS synchronously after the create —
        // a published child is never rolled back.
        committed.push(next as SessionHandle)
        return { ok: true, next }
      } catch (error) {
        // The runner's transaction maps any create failure to an outcome —
        // it never lets a create error escape as a rejection.
        return { ok: false, message: options.createError ?? (error instanceof Error ? error.message : String(error)) }
      }
    },
    replaceDraft: (text) => { drafts.push(text) },
  }
  return { host, created, resolved, committed, drafts, state }
}

function sourceAgent(sessionId = 'session-source', events: readonly SessionEvent[] = [], agentPreset?: string, cwd = '/ws'): Agent {
  // The alpha.4 Session shape: the log is served through the snapshot
  // reads (the comment at the fold below still explains WHY the log is
  // the source of truth — the accessor, not the field).
  return {
    session: {
      id: sessionId,
      header: { version: 0, id: sessionId, createdAt: 1, isSeeded: false, cwd, ...(agentPreset === undefined ? {} : { agentPreset }) },
      get seq() { return events.length },
      eventAt: (seq: number) => events[seq],
      snapshotEvents: () => events,
    },
    options: { provider: 'deepseek', model: 'deepseek-chat' },
  } as unknown as Agent
}

test('C04: createForkedAgent records preset, source cwd, parent, seeded lineage, provider/model', async () => {
  const rig = makeRig({ sessionCwd: '/other-cwd' })
  const seed = turn(0, 1, 'A')
  // The concrete preset id rides the create (migration M1.11 — no
  // composition fallback inside the helper); the source's header cwd is
  // '/ws' — the child's cwd is the SOURCE's workspace (the live surface
  // cwd '/other-cwd' only matters for a header without one).
  const next = await createForkedAgent(rig.host, sourceAgent('session-parent', [], 'minimal'), seed, SessionId('session-child'), 'minimal')
  assert.deepEqual(rig.resolved, [], 'the helper no longer composes — the preset id is caller-resolved')
  assert.equal(rig.created.length, 1)
  const call = rig.created[0]!
  assert.equal(call.meta.cwd, '/ws', 'the SOURCE workspace wins, never a live-surface value')
  assert.equal(call.meta.agentPreset, 'minimal')
  assert.equal(call.meta.parentSession, 'session-parent')
  assert.equal(call.meta.isSeeded, true)
  assert.equal(call.inheritedEventCount, 4)
  assert.equal(call.provider, 'deepseek')
  assert.equal(call.model, 'deepseek-chat')
  assert.equal(call.seed, seed)
  assert.equal(next.session.id, call.sessionId)
  assert.ok(call.sessionId.startsWith('session-'))
})

test('review P2: the cwd is captured BEFORE the create await (no parent=A cwd=B mix)', async () => {
  let liveCwd = '/ws-a'
  const created: CreatedCall[] = []
  const rig = makeRig({ sessionCwd: '/ws-a' })
  // The create await is where a concurrent switch could land; the helper
  // must have already captured the cwd.
  const host: RewindCommitHost = {
    ...rig.host,
    sessionCwd: () => liveCwd,
    agents: {
      create: async (call) => {
        liveCwd = '/ws-b' // a switch lands DURING the create await
        created.push({ sessionId: String(call.sessionId), meta: call.meta, ...call.inheritedEventCount === undefined ? {} : { inheritedEventCount: call.inheritedEventCount }, provider: call.provider, model: call.model, agentPreset: call.agentPreset, seed: call.seed })
        return { session: { id: String(call.sessionId) }, direct: { agent: { session: { id: String(call.sessionId) } }, ownerHandle: { dispose: async () => {} } } }
      },
      resume: async (call) => ({ session: { id: String(call.resumeSessionId) }, directAgent: { session: { id: String(call.resumeSessionId) } } }),
    },
  }
  // The source header has NO cwd: the fallback is the live cwd captured at
  // entry — '/ws-a', never the post-switch '/ws-b'.
  const source = sourceAgent('session-parent', [], undefined, '')
  await createForkedAgent(host, source, [], SessionId('session-child'))
  assert.equal(created[0]!.meta.cwd, '/ws-a', 'the cwd is the pre-await capture, never the post-switch value')
})

test('review P2: a source header WITHOUT a cwd falls back to the live surface cwd', async () => {
  const rig = makeRig({ sessionCwd: '/live-fallback' })
  const source = sourceAgent('session-parent', [], undefined, '')
  await createForkedAgent(rig.host, source, [], SessionId('session-child'))
  assert.equal(rig.created[0]!.meta.cwd, '/live-fallback')
})

test('createForkedAgent without a preset omits agentPreset from the meta', async () => {
  const rig = makeRig()
  await createForkedAgent(rig.host, sourceAgent(), [], SessionId('session-child'))
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
  assert.equal(rig.created[0]!.inheritedEventCount, 4, 'seed = everything before turn 2/start')
  assert.equal(rig.committed.length, 1, 'the transaction commits the created child')
  assert.equal(rig.committed[0]!.session.id, rig.created[0]!.sessionId)
  assert.deepEqual(rig.drafts, ['B'], 'the selected prompt restores into the editor')
})

test('review: the preflight and the Direct lifecycle compose the SAME concrete id (no drift)', async () => {
  // The M1.5 lock-ordering preflight composes the source's recorded
  // preset BEFORE the target lock is acquired; the Direct lifecycle then
  // composes AGAIN from the id the semantic create carries. The second
  // resolution must receive AND resolve the PREFLIGHT's concrete id — a
  // roster that would change between the two awaits can never make the
  // create re-resolve the SOURCE's alias to a different id.
  const rig = makeRig()
  const preflightIds: Array<string | undefined> = []
  const lifecycleIds: Array<string | undefined> = []
  const lifecycleResults: Array<string | undefined> = []
  // Deterministic roster: the alias 'minimal' resolves ONCE to the
  // concrete id 'concrete-minimal'; a concrete id resolves to itself
  // (composeAgent/presets.resolve semantics).
  const runnerCompose = async (presetId?: string): Promise<{ agentPreset?: string; setup: () => void }> => ({
    agentPreset: presetId === 'minimal' ? 'concrete-minimal' : presetId,
    setup: () => {},
  })
  rig.host.compose = async (presetId?: string) => {
    preflightIds.push(presetId)
    return runnerCompose(presetId)
  }
  const baseCreate = rig.host.agents.create
  rig.host.agents.create = async (call) => {
    // The Direct lifecycle (migration M1.11): the adapter composes
    // internally from the request's preset id before creating.
    lifecycleIds.push(call.agentPreset)
    const composition = await runnerCompose(call.agentPreset)
    lifecycleResults.push(composition.agentPreset)
    return baseCreate(call)
  }
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B')]
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events, 'minimal'), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'rewound')
  assert.equal(preflightIds.length, 1, 'the preflight composes exactly once')
  assert.equal(lifecycleIds.length, 1)
  assert.equal(
    lifecycleIds[0],
    'concrete-minimal',
    'the lifecycle composes the PREFLIGHT-resolved id, never the source alias',
  )
  assert.equal(
    lifecycleResults[0],
    'concrete-minimal',
    'the lifecycle\'s own resolution of the concrete id is stable (resolves to itself)',
  )
  assert.equal(rig.created[0]!.meta.agentPreset, 'concrete-minimal', 'the semantic create carries the resolved id')
})

test('review: a HOSTILE second resolution cannot change the mounted preset (the create rides the preflight id)', async () => {
  // The drift repro, adversarial: the roster returns a DIFFERENT id on
  // every compose call. The runner captures the preflight result ONCE
  // and the semantic create carries THAT id — a hostile re-resolution
  // after the preflight can only ever see the preflight's own output,
  // never the source alias, so the mounted preset stays the first
  // resolution.
  const rig = makeRig()
  const lifecycleIds: Array<string | undefined> = []
  const lifecycleResults: Array<string | undefined> = []
  // Every call resolves to a NEW id (a roster that is actively drifting).
  let counter = 0
  const hostileCompose = async (presetId?: string): Promise<{ agentPreset?: string; setup: () => void }> => {
    counter += 1
    return { agentPreset: presetId === undefined ? `hostile-${counter}` : presetId, setup: () => {} }
  }
  rig.host.compose = hostileCompose
  const baseCreate = rig.host.agents.create
  rig.host.agents.create = async (call) => {
    lifecycleIds.push(call.agentPreset)
    const composition = await hostileCompose(call.agentPreset)
    lifecycleResults.push(composition.agentPreset)
    return baseCreate(call)
  }
  const events = [...turn(0, 1, 'A'), ...turn(4, 2, 'B')]
  const candidates = collectRewindCandidates(events)
  // No recorded preset on the source: the preflight resolves the DEFAULT.
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'rewound')
  const preflightResult = rig.created[0]!.meta.agentPreset
  assert.equal(preflightResult, 'hostile-1', 'the create carries the FIRST preflight resolution')
  assert.equal(lifecycleIds[0], 'hostile-1', 'the lifecycle composes the preflight id, never the source alias')
  assert.equal(lifecycleResults[0], 'hostile-1', 'the hostile roster still maps the concrete id to itself')
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
  assert.equal(rig.created[0]!.inheritedEventCount, 0)
})

test('I05: a stale generation cancels BEFORE any create', async () => {
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
  assert.equal(rig.committed.length, 0)
  assert.deepEqual(rig.drafts, [], 'no prompt restore for a stale picker')
})

test('review round-2: once the child is created the transaction only commits (no rollback)', async () => {
  // The durable-ghost blocker: there is NO failure path after the create
  // that may be interpreted as "the child never happened" (dispose cannot
  // delete a persisted session, and dsh has no rollback primitive). Even if
  // the surface identity moves while the create is in flight (theoretically
  // impossible inside the transition gate — this asserts the transaction
  // contract), the child is committed, never disposed, and the prompt is
  // restored.
  const rig = makeRig({
    createHook: () => { rig.state.sessionId = 'session-other'; rig.state.generation = 3 },
  })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'rewound', 'a published child is never rolled back')
  assert.equal(rig.created.length, 1)
  assert.equal(rig.committed.length, 1, 'the child is committed')
  assert.deepEqual(rig.drafts, ['A'], 'the prompt restore happens after the commit')
})

test('review P1-2: a rewind commit holds the gate across create→commit; a concurrent switch queues behind it', async () => {
  const gate = new SessionTransitionGate()
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const source = sourceAgent('session-source', events)
  const order: string[] = []
  let releaseCreate!: () => void
  const createHanging = new Promise<void>(resolve => { releaseCreate = resolve })
  const rig = makeRig({
    transitionTo: async (steps) => {
      await createHanging
      return steps.create().then(next => ({ ok: true, next }))
    },
  })
  // The commit runs inside the gate (the runner wraps commitRewind in the
  // transition gate) and the transaction yields inside its create — the
  // exact window where the old TOCTOU let a concurrent switch land.
  const commit = gate.run(async () => {
    order.push('rewind-commit')
    return commitRewind(rig.host, source, candidates[0]!, { sessionId: 'session-source', generation: 1 })
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  const switched = gate.run(async () => { order.push('switch') })
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.deepEqual(order, ['rewind-commit'], 'the switch must queue while the rewind transaction is in flight')
  releaseCreate()
  const outcome = await commit
  assert.equal(outcome.kind, 'rewound')
  await switched
  assert.deepEqual(order, ['rewind-commit', 'switch'], 'the switch runs only after the rewind released the gate')
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

test('a failed create keeps the source and never touches the editor (no ghost, no rollback)', async () => {
  // The durable-ghost contract: failures can only happen BEFORE the create.
  // A failed create leaves no child at all — there is nothing to dispose
  // and nothing persisted.
  const rig = makeRig({ createError: 'roster unavailable' })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.message, 'roster unavailable')
  assert.equal(rig.created.length, 0, 'a failed create publishes nothing')
  assert.equal(rig.committed.length, 0, 'nothing was committed')
  assert.deepEqual(rig.drafts, [], 'a failed create must never overwrite the editor')
})

test('review repro: the stale-identity predicate refuses switched/sessionless surfaces', () => {
  const expected: RewindLiveIdentity = { sessionId: 'session-source', generation: 1 }
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-source', generation: 1 }, expected), true)
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-other', generation: 1 }, expected), false, 'a switched session refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: 'session-source', generation: 2 }, expected), false, 'a bumped generation refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: undefined, generation: 1 }, expected), false, 'a sessionless surface refuses')
  assert.equal(isRewindIdentityCurrent({ sessionId: undefined, generation: 3 }, expected), false, 'sessionless + bumped refuses')
})

test('a failed create returns the failure outcome (the transaction never rejects)', async () => {
  // The runner's transitionTo maps any create failure to an outcome — the
  // commitRewind caller (runOwned) never sees a rejection for a create
  // failure, only for a genuinely unexpected host bug.
  const rig = makeRig({ createError: 'roster unavailable' })
  const events = turn(0, 1, 'A')
  const candidates = collectRewindCandidates(events)
  const outcome = await commitRewind(rig.host, sourceAgent('session-source', events), candidates[0]!, {
    sessionId: 'session-source',
    generation: 1,
  })
  assert.equal(outcome.kind, 'failed')
  if (outcome.kind !== 'failed') return
  assert.equal(outcome.message, 'roster unavailable')
  assert.equal(rig.committed.length, 0)
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
    defaultSelection: () => undefined,
    defaultIntent: undefined,
    setDefaultIntent: () => {},
    defaultIntentRecord: undefined,
    settleIntent: () => {},
    tuiSettings: undefined,
    applyFooterSettings: () => {},
    agents: {} as never,
    sessionReader: {
      list: async () => [],
      search: async () => [],
      projectionBatch: async () => new Map(),
      measureContext: () => undefined,
      readExportData: async () => ({ kind: 'none' }),
    },
    catalog: new DirectCatalogPort(options.ctx as never, () => undefined),
    config: new DirectConfigPort(options.ctx as never, undefined, () => undefined),
    commandRegistry: options.ctx.get('commands') as import('../src/commands.ts').CommandRegistryLike | undefined,
    hostFile: new DirectHostFilePort((sessionId) => options.agent?.session.id === sessionId ? options.agent : undefined),
    interaction: {
      registerQuestionProvider: () => true,
      onApprovalRequest: () => {},
      setApprovalPolicy: () => true,
    },
    sessionWriter: {
      followup: () => {},
      steer: () => {},
      dequeue: () => {},
      cancel: () => {},
      rename: () => true,
      refreshTitle: async () => ({ kind: 'ok' as const, title: undefined }),
    },
    cwd: '/ws',
    sessionCwd: () => '/ws',
    imageStore: new DraftImageStore(),
    copyToClipboard: async () => true,
    imageLimits: () => undefined,
    insertIntoEditor: () => {},
    prepareDraftMessage: async (text) => ({ role: 'user', id: `u:${text}`, content: [{ type: 'text', text }], source: { kind: 'user' } }) as never,
    signal: new AbortController().signal,
    get sessionGeneration() { return 0 },
    focusEnabled: () => false,
    setFocusMode: () => {},
    setNotificationMode: () => {},
    setNotificationMethod: () => {},
    switchSession: async () => undefined,
    transitionTo: async <T>(steps: { target?: { id: string; header?: { cwd?: string } }; prepare?: () => Promise<void> | void; create: () => Promise<T> }) => {
      await steps.prepare?.()
      return { ok: true, next: await steps.create() }
    },
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
    sessionTransitionPending: () => false,
    withSessionTransition: async <T>(task: () => T | Promise<T>) => task(),
    withSessionWriter: async <T>(_sessionId: string, task: () => T | Promise<T>) => task(),
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
  startedApps.add(app)
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

// ── review round 23 (post-recovery-removal): one composition, no retry ───

test('review round 23: /new resolves ONE compose and passes NO recovery step', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommandsService()
  const ctx = new Context()
  ctx.provide('commands', commands.service as never)
  const rewinds: number[] = []
  const ensureCalls: string[] = []
  const base = stubRunner({ ctx, app, rewinds, ensureCalls })
  let resolves = 0
  let createPreset: string | undefined
  let sawRecover = false
  const runner: TuiCommandRunner = {
    ...base,
    // The preset identity comes from the catalog port (migration M1.11):
    // the command surface resolves the concrete id, the Direct session
    // lifecycle composes the setup internally.
    catalog: {
      ...base.catalog!,
      presets: {
        ...base.catalog!.presets,
        resolve: async () => { resolves += 1; return { id: 'standard' } },
      },
    },
    agents: {
      create: async (opts: { agentPreset?: string }) => {
        createPreset = opts.agentPreset
        return { session: { id: 'session-new' } } as SessionHandle
      },
    } as never,
    transitionTo: async <T>(steps: { create: () => Promise<T> }) => {
      sawRecover = 'recover' in steps
      return { ok: true, next: await steps.create() }
    },
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'new')
  assert.ok(def?.handler !== undefined, '/new handler missing')
  await (def!.handler as () => Promise<unknown>)()
  assert.equal(resolves, 1, 'the preset id is resolved exactly once (for the create)')
  assert.equal(sawRecover, false, 'a rejected create is NEVER retried — no recovery step is passed')
  assert.equal(createPreset, 'standard', 'the semantic create request carries the resolved preset id')
  app.stop()
})

test('review round 23/24: /fork resolves ONE compose and passes NO recovery step', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommandsService()
  const ctx = new Context()
  ctx.provide('commands', commands.service as never)
  const rewinds: number[] = []
  const ensureCalls: string[] = []
  const base = stubRunner({ ctx, app, rewinds, ensureCalls })
  let resolves = 0
  let createPreset: string | undefined
  let sawRecover = false
  const runner: TuiCommandRunner = {
    ...base,
    liveAgent: sourceAgent('session-source', turn(0, 1, 'A')),
    currentPreset: () => { resolves += 1; return 'minimal' },
    agents: {
      create: async (opts: { agentPreset?: string }) => {
        createPreset = opts.agentPreset
        return { session: { id: 'session-fork' } } as SessionHandle
      },
    } as never,
    transitionTo: async <T>(steps: { create: () => Promise<T> }) => {
      sawRecover = 'recover' in steps
      return { ok: true, next: await steps.create() }
    },
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'fork')
  assert.ok(def?.handler !== undefined, '/fork handler missing')
  await (def!.handler as () => Promise<unknown>)()
  assert.equal(resolves, 1, 'the preset id is resolved exactly once (for the create)')
  assert.equal(sawRecover, false, 'a rejected create is NEVER retried — no recovery step is passed')
  assert.equal(createPreset, 'minimal', 'the semantic create request carries the resolved preset id')
  app.stop()
})

// ── review round 27: the live /preset swap runs inside the transition gate ─

test('review round 27: /preset live-swap runs inside the session-transition gate', async () => {
  const vt = new VirtualTerminal(100, 24)
  const app = new TuiApp(vt, { onSubmit: () => {}, onExit: () => {} })
  app.start()
  startedApps.add(app)
  const commands = fakeCommandsService()
  const ctx = new Context()
  ctx.provide('commands', commands.service as never)
  ctx.provide('agentPresets', {
    composedPreset: () => undefined,
    defaultId: 'standard',
  } as never)
  const rewinds: number[] = []
  const ensureCalls: string[] = []
  const base = stubRunner({ ctx, app, rewinds, ensureCalls })
  let gateRuns = 0
  const runner: TuiCommandRunner = {
    ...base,
    liveAgent: sourceAgent('session-source', [], 'standard'),
    recomposeBlank: async () => ({ kind: 'switched', preset: 'minimal' }),
    withSessionTransition: async <T>(task: () => T | Promise<T>) => {
      gateRuns += 1
      return task()
    },
    refreshCatalog: async () => ({ kind: 'applied', snapshot: {} as never }),
    updateWelcomeCard: () => {},
  }
  registerTuiCommands(runner)
  const def = commands.defs.find(entry => entry.name === 'preset')
  assert.ok(def?.handler !== undefined, '/preset handler missing')
  const outcome = await (def!.handler as (invocation: { rawInput: string }) => Promise<unknown>)({ rawInput: 'minimal' })
  assert.deepEqual(outcome, { kind: 'success', text: 'session preset switched to minimal' })
  assert.equal(gateRuns, 1, 'the live preset swap must run inside the transition gate (recompose + append atomic)')
  app.stop()
})
