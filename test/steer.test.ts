/**
 * Headless tests for the steer-all orchestration (Ctrl+S). The send core
 * is SYNCHRONOUS one-pass (snapshot → re-validate → deliver, no await in
 * between) since the divergence-guard removal, so the only reachable
 * stale triggers are the identity re-validation (modeled here with
 * deps whose second read returns a switched surface) and the transition
 * fence. The delivery gates (empty payload, onlyDraft, writer seam) and
 * the draft-restore merge semantics are pinned here too.
 * @module @xmoon76/dsh-pi-tui/steer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDraft, refuseByTransitionFence, sessionUnchanged, steerAll, steerHasPayload, type SteerAgentLike, type SteerDeps } from '../src/steer.ts'
import { TransitionInProgressError, type SessionOperationBarrier } from '../src/session-operation-barrier.ts'

interface FakeAgent extends SteerAgentLike {
  status: 'idle' | 'running'
  /** The live queue state (splices mutate this). */
  state: { nextTurn: { id: string }[]; nextStep: { id: string }[] }
  steered: { id: string; text: string }[]
  followed: { id: string; text: string }[]
}

/** A mutable fake agent whose queue can be mutated. */
function fakeAgent(ids: string[], sessionId = 'session-steer'): FakeAgent {
  const steered: { id: string; text: string }[] = []
  const followed: { id: string; text: string }[] = []
  const state = { nextTurn: ids.map(id => ({ id })), nextStep: [] as { id: string }[] }
  return {
    session: { id: sessionId },
    inbox: {
      get nextTurn() { return state.nextTurn },
      get nextStep() { return state.nextStep },
      remove(id: string) {
        state.nextTurn = state.nextTurn.filter(m => m.id !== id)
        state.nextStep = state.nextStep.filter(m => m.id !== id)
      },
    },
    status: 'idle',
    steer: (message) => { steered.push(message as { id: string; text: string }) },
    followup: (message) => { followed.push(message as { id: string; text: string }) },
    state,
    steered,
    followed,
  } as FakeAgent
}

/**
 * A dep whose identity getters return DIFFERENT values on the re-read:
 * the deterministic model of a session switch between the snapshot and
 * the re-validation (the TOCTOU surface the stale checks exist for).
 * Reads 1-2 (the wrapper's sessionId probe + the core's capture) return
 * `first`; reads 3+ (the re-validation) return `second`.
 */
function switchingIdentities(options: {
  first: FakeAgent
  second: FakeAgent
  firstGeneration?: number
  secondGeneration?: number
}): () => SteerDeps {
  let agentReads = 0
  let generation = options.firstGeneration ?? 1
  return () => ({
    currentAgent: () => {
      agentReads += 1
      return agentReads <= 2 ? options.first : options.second
    },
    currentGeneration: () => {
      const result = generation
      generation = options.secondGeneration ?? generation
      return result
    },
    notify: (message, kind) => { void message; void kind },
    restoreDraft: () => true,
    createDraft: (text) => ({ id: `draft:${text}`, text }),
    staleNotice: () => 'changed while sending',
    mergedNotice: () => 'draft merged',
  })
}

function makeDeps(options: {
  agent: () => SteerAgentLike | undefined
  generation?: () => number
  notices?: string[]
  restored?: string[]
}): SteerDeps {
  return {
    currentAgent: options.agent,
    currentGeneration: options.generation ?? (() => 1),
    notify: (message, kind) => options.notices?.push(`${kind}: ${message}`),
    restoreDraft: (text) => { options.restored?.push(text); return true },
    createDraft: (text) => ({ id: `draft:${text}`, text }),
    staleNotice: () => 'changed while sending',
    mergedNotice: () => 'draft merged',
  }
}

/** Runner-shaped deps: the EXACT restore wiring index.ts uses — mergeDraft
 * over the live editor string; verbatim only when the merged result IS the
 * draft. `restored` records every restore call, to prove each operation
 * restores exactly once. */
function editorRestoreDeps(options: {
  agent: () => SteerAgentLike | undefined
  generation?: () => number
  editor: () => string
  setEditor: (text: string) => void
  restored?: string[]
}): SteerDeps {
  const deps = makeDeps({ agent: options.agent, generation: options.generation, restored: options.restored })
  deps.restoreDraft = (draft) => {
    options.restored?.push(draft)
    const merged = mergeDraft(options.editor(), draft)
    options.setEditor(merged)
    return merged === draft
  }
  return deps
}

// ── re-validation mechanism (stale aborts) ─────────────────────────────────

test('a session switch between the snapshot and the delivery aborts stale and restores the draft', async () => {
  const oldAgent = fakeAgent(['a'])
  const newAgent = fakeAgent(['z'])
  const depsFactory = switchingIdentities({ first: oldAgent, second: newAgent })
  const restored: string[] = []
  const notices: string[] = []
  const deps = { ...depsFactory(), restoreDraft: (text: string) => { restored.push(text); return true }, notify: (message: string, kind: 'info' | 'error') => notices.push(`${kind}: ${message}`) }
  assert.equal(await steerAll(deps, 'x'), 'stale')
  assert.deepEqual(oldAgent.steered, [], 'the OLD session must not receive the payload')
  assert.deepEqual(newAgent.steered, [], 'the NEW session must not receive a stale payload')
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
  assert.ok(notices.some(note => note.includes('changed while sending')), notices.join(' | '))
})

test('a generation bump between the snapshot and the delivery aborts stale and restores the draft', async () => {
  const agent = fakeAgent(['a'])
  const depsFactory = switchingIdentities({ first: agent, second: agent, firstGeneration: 1, secondGeneration: 2 })
  const restored: string[] = []
  const deps = { ...depsFactory(), restoreDraft: (text: string) => { restored.push(text); return true } }
  assert.equal(await steerAll(deps, 'x'), 'stale')
  assert.deepEqual(agent.steered, [])
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
})

// ── delivery semantics ──────────────────────────────────────────────────────

test('an unchanged state steers exactly the confirmed messages and removes only them', async () => {
  const agent = fakeAgent(['a', 'b'])
  const notices: string[] = []
  const outcome = await steerAll(makeDeps({ agent: () => agent, notices }), 'draft')
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.state.nextTurn, [], 'confirmed messages are removed')
  assert.equal(agent.steered.length, 3, 'two queued messages + the draft')
  assert.deepEqual(agent.steered.map(m => m.id), ['a', 'b', 'draft:draft'])
  assert.ok(notices.some(note => note.includes('steering 3 messages')), notices.join(' | '))
})

test('an empty queue falls back to the classic single-draft steer', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const pending = steerAll(makeDeps({ agent: () => agent }), 'hello')
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.followed.map(m => m.id), ['draft:hello'], 'an idle agent takes a followup')
  agent.status = 'running'
  const pending2 = steerAll(makeDeps({ agent: () => agent }), 'hello')
  assert.equal(await pending2, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['draft:hello'], 'a running agent takes a steer')
})

test('onlyDraft steers the draft alone: explicitly queued messages stay queued', async () => {
  // Busy-Enter steer (web busyEnter parity): Enter steers the DRAFT only —
  // a message the user queued explicitly (Ctrl+Enter or a notice) must not
  // be swept into the turn, because already-steered input cannot be pulled
  // back.
  const agent = fakeAgent(['queued'])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), 'draft text', { onlyDraft: true })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.text), ['draft text'], 'the draft must be steered')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['queued'], 'the queued message must stay queued')
  assert.deepEqual(agent.followed, [], 'no followup')
})

test('onlyDraft while idle falls back to a followup', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), 'draft text', { onlyDraft: true })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.followed.map(m => m.text), ['draft text'], 'an idle agent takes a followup')
  assert.deepEqual(agent.steered, [], 'nothing steered')
})

// ── P0: empty-payload no-op (the empty-draft semantics, plan §6.3 Gate B) ──

test('P0: empty draft + empty queue is a NO-OP (draftHasPayload=false) — never an empty followup/steer', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const notices: string[] = []
  const outcome = await steerAll(
    makeDeps({ agent: () => agent, notices }),
    '',
    { draftHasPayload: false },
  )
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered, [], 'nothing steered')
  assert.deepEqual(agent.followed, [], 'nothing followed up — an empty draft must not produce an empty message')
  assert.deepEqual(notices, [], 'no notice at all (a no-op is silent)')
})

test('P0: empty draft + empty queue with onlyDraft is a NO-OP too (busy-Enter steer)', async () => {
  const agent = fakeAgent([])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), '', { onlyDraft: true, draftHasPayload: false })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered, [], 'onlyDraft + empty payload must never steer')
})

test('P0: empty QUEUE + non-empty draft still steers (the classic single-draft path)', async () => {
  const agent = fakeAgent([])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), 'hello', { draftHasPayload: true })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.text), ['hello'])
})

test('P0: empty draft + NON-empty queue steers the queue exactly as before (queue-only Ctrl+S)', async () => {
  for (const status of ['idle', 'running'] as const) {
    const agent = fakeAgent(['A', 'B'])
    agent.status = status
    const outcome = await steerAll(makeDeps({ agent: () => agent }), '', { draftHasPayload: false })
    assert.equal(outcome, 'ok')
    assert.deepEqual(agent.steered.map(m => m.id), ['A', 'B'], `${status}: both queued messages steered in order`)
    assert.deepEqual(agent.followed, [], `${status}: a queue batch never follows up`)
    assert.deepEqual(agent.state.nextTurn, [], `${status}: confirmed entries removed`)
  }
})

test('P0: empty draft + queue [A,B] + draft C keeps A,B,C order (queue + draft)', async () => {
  const agent = fakeAgent(['A', 'B'])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), 'C', { draftHasPayload: true })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['A', 'B', 'draft:C'])
})

// ── runner Gate A (steerHasPayload): the empty-Ctrl+S gate, headless-pinned ───────────────

test('Gate A: DEFERRED START + empty draft + empty queue MUST be a no-op (ensureSession never runs)', () => {
  // The original bug: fresh session (liveAgent === undefined), empty Ctrl+S
  // used to create the session inside ensureSession() before the emptiness
  // was noticed. steerHasPayload(false, { onlyDraft: false, queuedCount: 0,
  // liveAgent: false }) must return false BEFORE any session work.
  assert.equal(steerHasPayload(false, { onlyDraft: false, queuedCount: 0, liveAgent: false }), false,
    'no payload + no session + no queue = nothing to steer')
})

test('Gate A: deferred start + NON-empty draft is a real steer (still eligible)', () => {
  assert.equal(steerHasPayload(true, { onlyDraft: false, queuedCount: 0, liveAgent: false }), true)
})

test('Gate A: live agent + empty draft + NON-empty queue steers (queue-only Ctrl+S)', () => {
  assert.equal(steerHasPayload(false, { onlyDraft: false, queuedCount: 2, liveAgent: true }), true)
  assert.equal(steerHasPayload(false, { onlyDraft: false, queuedCount: 0, liveAgent: true }), false)
})

test('Gate A: onlyDraft (busy-Enter) is judged on the draft verdict ALONE', () => {
  assert.equal(steerHasPayload(false, { onlyDraft: true, queuedCount: 3, liveAgent: true }), false,
    'busy-Enter steer of an empty draft no-ops even with a queue')
  assert.equal(steerHasPayload(true, { onlyDraft: true, queuedCount: 0, liveAgent: true }), true)
})

test('Gate A: an undefined verdict is a VERBATIM pass-through (legacy callers keep historical behavior)', () => {
  assert.equal(steerHasPayload(undefined, { onlyDraft: false, queuedCount: 0, liveAgent: false }), true)
  assert.equal(steerHasPayload(undefined, { onlyDraft: true, queuedCount: 0, liveAgent: true }), true)
})

test('P0: the includeDraft verdict honors an EXPLICIT payload claim over text.trim()', async () => {
  // The new contract: draftHasPayload is the runner's authoritative verdict
  // (it owns shell/image semantics — a future out-of-band non-text payload
  // with text='' can claim payload=TRUE). The queue-non-empty branch must
  // include the draft when the verdict says so, NEVER fall back to
  // text.trim() — otherwise payload=true + text='' + queue=[A,B] would drop
  // the draft (inconsistent with queue=[] which creates it).
  const agent = fakeAgent(['A', 'B'])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), '', { draftHasPayload: true })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['A', 'B', 'draft:'],
    'payload=true + text="" must include the empty-text draft as a payload message')
})

test('P0: draftHasPayload=false + text non-empty + queue non-empty drops the draft (verdict wins)', async () => {
  // The inverse contract: verdict=false wins over non-empty text (which the
  // runner would only pass for a whitespace-draft with images consuming it
  // elsewhere). queue keeps steering.
  const agent = fakeAgent(['A', 'B'])
  agent.status = 'running'
  const outcome = await steerAll(makeDeps({ agent: () => agent }), '   ', { draftHasPayload: false })
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['A', 'B'],
    'verdict=false never rides the draft even when text is non-empty')
})

test('P0: draftHasPayload undefined keeps the historical semantics (the text IS a payload)', async () => {
  const agent = fakeAgent(['a'])
  agent.status = 'running'
  // No explicit payload verdict: the empty text used to steer the queue.
  const outcome = await steerAll(makeDeps({ agent: () => agent }), '')
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['a'], 'historical behavior preserved when the verdict is absent')
})

test('sessionUnchanged requires the same agent object and generation', () => {
  const a = { id: 'a' }
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, a, 1), true)
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, a, 2), false, 'generation bump')
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, { id: 'b' }, 1), false, 'agent switch')
  assert.equal(sessionUnchanged({ agent: a, generation: 1 }, undefined, 1), false, 'agent gone')
})

test('mergeDraft preserves BOTH texts when the editor changed mid-send', () => {
  // Editor strictly empty: the submitted (unsent) draft comes back.
  assert.equal(mergeDraft('', 'old submitted'), 'old submitted')
  // Editor already holds the same text: it is still APPENDED. Text equality
  // is never an identity — the identical string could be an independent
  // operation's restore or the user's re-typed input (the review's minimal
  // counterexample), so it must never short-circuit.
  assert.equal(mergeDraft('old submitted', 'old submitted'), 'old submitted\n\nold submitted')
  // The user typed something new while the send was in flight: the newer
  // text stays on top AND the unsent submission is preserved beneath it —
  // nothing may vanish silently.
  const merged = mergeDraft('new draft typed during the send', 'old submitted')
  assert.ok(merged.includes('new draft typed during the send'), merged)
  assert.ok(merged.includes('old submitted'), `the unsent submission must survive:\n${merged}`)
  assert.equal(merged.indexOf('new draft typed during the send'), 0, 'the newer text leads')
})

test('a MERGED draft gets the merged notice, never the verbatim-retry notice', async () => {
  const agentA = fakeAgent(['a'])
  const agentB = fakeAgent(['z'])
  const notices: string[] = []
  const depsFactory = switchingIdentities({ first: agentA, second: agentB })
  const deps = depsFactory()
  deps.notify = (message, kind) => notices.push(`${kind}: ${message}`)
  // The restore returns FALSE: the draft was merged with newer input, so a
  // verbatim retry is not what happens next.
  const original = deps.restoreDraft
  deps.restoreDraft = () => { original('x'); return false }
  assert.equal(await steerAll(deps, 'draft'), 'stale')
  assert.ok(notices.some(note => note.includes('draft merged')), notices.join(' | '))
  assert.ok(!notices.some(note => note.includes('changed while sending')), 'the verbatim-retry notice must not be shown for a merged draft')
})

test('mergeDraft handles empty submissions and whitespace input', () => {
  // Nothing was submitted (queue-only Ctrl+S with an empty draft): no change.
  assert.equal(mergeDraft('new draft', ''), 'new draft')
  assert.equal(mergeDraft('', ''), '')
  // Strict empty check: whitespace-only editor is real input, never swallowed.
  assert.ok(mergeDraft('   ', 'old unsent').includes('old unsent'), mergeDraft('   ', 'old unsent'))
  assert.ok(mergeDraft('   ', 'old unsent').startsWith('   '), 'whitespace input must lead')
})

test('two INDEPENDENT operations with the SAME text both survive (no text-level dedup)', () => {
  // The review's repro: operation A submits 'same' and fails; the editor
  // clears, the user submits 'same' AGAIN (independent operation B) which
  // also fails; meanwhile the user typed 'new draft'. Both unsent
  // submissions are real user input — text equality must NOT dedup them.
  const afterA = mergeDraft('new draft', 'same')
  const afterB = mergeDraft(afterA, 'same')
  assert.ok(afterB.includes('new draft'), afterB)
  assert.equal(afterB.match(/same/g)?.length, 2, `both submissions must survive:\n${afterB}`)
  // Different-text operations behave the same (already covered above).
  // The content-already-present case is the MINIMAL counterexample, not a
  // shortcut: the editor holding exactly the submitted text is appended,
  // because it may be an INDEPENDENT restore of the same text — text
  // equality never means "already restored".
  assert.equal(mergeDraft('same', 'same'), 'same\n\nsame')
})

test('mergeDraft on an EMPTY editor: sequential same-text restores keep BOTH copies', () => {
  // The review's minimal counterexample, pure-function level: A and B both
  // submit `same` on an EMPTY editor, both fail; A restores first, then B.
  // The equality shortcut used to collapse B into A (one copy lost).
  const afterA = mergeDraft('', 'same')
  assert.equal(afterA, 'same')
  const afterB = mergeDraft(afterA, 'same')
  assert.equal(afterB.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${afterB}`)
  // The restore order is symmetric (merge appends, so the reverse order
  // produces the same result).
  const reverse = mergeDraft(mergeDraft('', 'same'), 'same')
  assert.equal(reverse, afterB)
})

test('mergeDraft keeps the user\'s NEW third draft AND both same-text submissions', () => {
  // Two independent same-text operations fail while the user typed a THIRD,
  // different draft in the editor: all three contents must survive — the
  // user's newest text leads, both unsent submissions are preserved below.
  const afterFirst = mergeDraft('third draft', 'same')
  const afterSecond = mergeDraft(afterFirst, 'same')
  assert.ok(afterSecond.startsWith('third draft'), afterSecond)
  assert.equal(afterSecond.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${afterSecond}`)
})

test('two INDEPENDENT same-text operations aborted stale: both restores keep both copies', async () => {
  // The review's minimal counterexample at the orchestration level: A and B
  // both submit `same` via Ctrl+S (the editor was cleared before each
  // onSteer fired, tui-app.ts), both sends go stale, A restores first, B
  // second. Each operation hits exactly one terminal branch and restores
  // EXACTLY once — the second restore must append, never dedup.
  let editor = ''
  const restored: string[] = []
  const agentA = fakeAgent(['a'])
  const agentB = fakeAgent(['b'])
  let agentReadsA = 0
  // Op A: the surface switches away between A's snapshot and delivery.
  const depsA = editorRestoreDeps({ agent: () => (agentReadsA += 1) <= 2 ? agentA : agentB, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsA, 'same'), 'stale')
  // Op B runs against the settled surface; the generation bumps before
  // its delivery (the same switch completes).
  let generationReadsB = 0
  const depsB = editorRestoreDeps({
    agent: () => agentB,
    generation: () => (generationReadsB += 1) === 1 ? 7 : 8,
    editor: () => editor,
    setEditor: (text) => { editor = text },
    restored,
  })
  assert.equal(await steerAll(depsB, 'same'), 'stale')
  assert.deepEqual(restored, ['same', 'same'], 'each failed operation restores exactly once')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
})

test('two INDEPENDENT same-text operations plus a THIRD draft typed mid-flight: all three survive', async () => {
  // Two sends go stale and BOTH restores merge into a third, different
  // draft typed before them. All three contents survive — the user's
  // newest text leads, neither unsent submission is dropped.
  const agentA = fakeAgent(['a'])
  const agentZ = fakeAgent(['z'])
  let editor = 'third draft' // the user's own draft is what the user sees
  const restored: string[] = []
  let readsA = 0
  const depsA = editorRestoreDeps({ agent: () => (readsA += 1) <= 2 ? agentA : agentZ, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsA, 'same'), 'stale')
  let readsB = 0
  const depsB = editorRestoreDeps({ agent: () => (readsB += 1) <= 2 ? agentZ : agentA, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsB, 'same'), 'stale')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
  assert.ok(editor.startsWith('third draft'), `the user's newest text leads:\n${editor}`)
  assert.equal(restored.length, 2, 'each failed operation restores exactly once')
})

test('two INDEPENDENT different-text operations failing in sequence: both survive', async () => {
  const agentA = fakeAgent(['a'])
  const agentB = fakeAgent(['b'])
  const agentC = fakeAgent(['c'])
  let editor = ''
  const restored: string[] = []
  let readsA = 0
  const depsA = editorRestoreDeps({ agent: () => (readsA += 1) <= 2 ? agentA : agentB, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsA, 'alpha'), 'stale')
  let readsB = 0
  const depsB = editorRestoreDeps({ agent: () => (readsB += 1) <= 2 ? agentB : agentC, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsB, 'beta'), 'stale')
  assert.deepEqual(restored, ['alpha', 'beta'], 'each failed operation restores exactly once')
  assert.ok(editor.includes('alpha') && editor.includes('beta'), `both submissions must survive:\n${editor}`)
})

test('same-text operations across a SESSION SWITCH: the stale copy survives untouched', async () => {
  // A's send is captured against session S1, the user switches to B, and
  // A's delivery hits the re-validation. A restores its submission into
  // the editor; B's own submission was delivered normally before the
  // switch's stale restore merged in.
  const agentA = fakeAgent(['a'], 'session-a')
  const agentB = fakeAgent(['z'], 'session-b')
  let editor = ''
  const restored: string[] = []
  let reads = 0
  const depsA = editorRestoreDeps({ agent: () => (reads += 1) <= 2 ? agentA : agentB, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  assert.equal(await steerAll(depsA, 'same'), 'stale')
  // The NEW session (agentB) already received one queued message; the
  // stale restore merged A's editor draft back.
  assert.deepEqual(agentB.steered, [], 'the stale send must not deliver')
  assert.equal(editor, 'same', 'the stale restore lands verbatim on the empty editor')
})

// ── review round 4: the session-transition write fence ─────────────────────

test('the transition fence refuses the write, restores the draft and never calls steer/followup', async () => {
  const agent = fakeAgent([])
  const writes: string[] = []
  const writespied = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === 'steer' || prop === 'followup') {
        return (message: unknown): void => { writes.push(String(prop)) }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const notices: string[] = []
  const restored: string[] = []
  const deps = makeDeps({ agent: () => writespied as never, notices, restored })
  deps.fence = () => true
  deps.fenceNotice = () => 'a session transition is in progress — try again in a moment'
  const outcome = await steerAll(deps, 'draft')
  assert.equal(outcome, 'stale')
  assert.deepEqual(writes, [], 'the fence must never let steer/followup reach the agent')
  assert.deepEqual(restored, ['draft'], 'the draft comes back')
  assert.deepEqual(notices, ['info: a session transition is in progress — try again in a moment'])
})

test('a TransitionInProgressError from the barrier refuses with the fence notice', async () => {
  const agent = fakeAgent([])
  const notices: string[] = []
  const restored: string[] = []
  const deps = makeDeps({ agent: () => agent, notices, restored })
  deps.barrier = {
    runWriter: async () => { throw new TransitionInProgressError() },
  } as unknown as SessionOperationBarrier
  deps.fenceNotice = () => 'a session transition is in progress — try again in a moment'
  const outcome = await steerAll(deps, 'draft')
  assert.equal(outcome, 'stale')
  assert.deepEqual(agent.steered, [], 'no delivery during a transition')
  assert.deepEqual(restored, ['draft'], 'the draft comes back')
  assert.deepEqual(notices, ['info: a session transition is in progress — try again in a moment'])
})

test('the fence is a no-op when no transition is in flight', async () => {
  const agent = fakeAgent([])
  const writes: string[] = []
  const spied = new Proxy(agent, {
    get(target, prop, receiver) {
      if (prop === 'steer' || prop === 'followup') {
        return (message: unknown): void => { writes.push(String(prop)) }
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  const deps = makeDeps({ agent: () => spied as never })
  deps.fence = () => false
  const outcome = await steerAll(deps, 'draft')
  assert.equal(outcome, 'ok')
  assert.deepEqual(writes, ['followup'], 'an idle agent takes the draft as a followup')
})

test('refuseByTransitionFence restores the draft verbatim and notifies the retry hint', () => {
  let editor = ''
  const notices: string[] = []
  refuseByTransitionFence('hello', () => editor, (text) => { editor = text }, (m: string, k: 'info' | 'error') => notices.push(`${k}: ${m}`))
  assert.equal(editor, 'hello', 'the refused submission comes back verbatim on an empty editor')
  assert.deepEqual(notices, ['info: a session transition is in progress — try again in a moment'])
})

test('refuseByTransitionFence MERGES newer input below the unsent submission', () => {
  let editor = 'newer draft'
  const notices: string[] = []
  refuseByTransitionFence('older unsent', () => editor, (text) => { editor = text }, (m: string, k: 'info' | 'error') => notices.push(`${k}: ${m}`))
  assert.ok(editor.includes('newer draft') && editor.includes('older unsent'), 'nothing is lost')
  assert.deepEqual(notices, ['info: the draft changed while transitioning — review it before submitting again'])
})

test('P1: the empty-queue classic steer delivers through the SessionWriter, never a direct agent call', async () => {
  // The empty-queue path (queue == 0 + Ctrl+S + draft) previously called
  // now.steer/now.followup DIRECTLY, bypassing the semantic port. It must
  // go through the writer seam: writer.steer/writer.followup exactly once,
  // and the agent's own steer/followup NEVER called.
  for (const status of ['running', 'idle'] as const) {
    const agent = fakeAgent([])
    agent.status = status
    const writerCalls: string[] = []
    const deps = makeDeps({ agent: () => agent })
    deps.writer = {
      steer: (sessionId, messages) => { writerCalls.push(`steer:${sessionId}:${(messages[0] as { id: string }).id}`) },
      followup: (sessionId, message) => { writerCalls.push(`followup:${sessionId}:${(message as { id: string }).id}`) },
      dequeue: () => { writerCalls.push('dequeue') },
    }
    const outcome = await steerAll(deps, 'hello')
    assert.equal(outcome, 'ok')
    assert.equal(agent.steered.length, 0, `${status}: the agent's own steer is NEVER called directly`)
    assert.equal(agent.followed.length, 0, `${status}: the agent's own followup is NEVER called directly`)
    if (status === 'running') {
      assert.deepEqual(writerCalls, ['steer:session-steer:draft:hello'], 'running → writer.steer exactly once')
    } else {
      assert.deepEqual(writerCalls, ['followup:session-steer:draft:hello'], 'idle → writer.followup exactly once')
    }
  }
})