/**
 * Headless tests for the steer-all orchestration (Ctrl+S): the guard
 * TOCTOU races — queue splices and session switches while the async
 * divergence guard reads the file — must abort `stale` with nothing lost
 * and nothing written to a session the guard never checked.
 * @module @xmoon76/dsh-pi-tui/steer.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeDraft, refuseByTransitionFence, sessionUnchanged, steerAll, type SteerAgentLike, type SteerDeps, type SteerGuard } from '../src/steer.ts'

type GuardVerdict = { kind: 'ok' | 'forced' } | { kind: 'blocked'; reason: 'diverged' | 'tail-mismatch' | 'unreadable' | 'removed' }

/** A deferred guard the test resolves manually, to stage in-flight races. */
function deferredGuard(): {
  promise: Promise<GuardVerdict>
  resolve: (v: GuardVerdict) => void
} {
  let resolve!: (v: GuardVerdict) => void
  const promise = new Promise<GuardVerdict>(res => { resolve = res })
  return { promise, resolve }
}

interface FakeAgent extends SteerAgentLike {
  status: 'idle' | 'running'
  /** The live queue state (splices mutate this). */
  state: { nextTurn: { id: string }[]; nextStep: { id: string }[] }
  steered: { id: string; text: string }[]
  followed: { id: string; text: string }[]
}

/** A mutable fake agent whose queue can be spliced mid-flight. */
function fakeAgent(ids: string[]): FakeAgent {
  const steered: { id: string; text: string }[] = []
  const followed: { id: string; text: string }[] = []
  const state = { nextTurn: ids.map(id => ({ id })), nextStep: [] as { id: string }[] }
  return {
    session: { id: 'session-steer' },
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

function makeDeps(options: {
  agent: () => SteerAgentLike | undefined
  generation?: () => number
  guard: Promise<GuardVerdict>
  notices?: string[]
  restored?: string[]
}): SteerDeps {
  return {
    currentAgent: options.agent,
    currentGeneration: options.generation ?? (() => 1),
    guard: { run: async () => options.guard },
    notify: (message, kind) => options.notices?.push(`${kind}: ${message}`),
    restoreDraft: (text) => { options.restored?.push(text); return true },
    createDraft: (text) => ({ id: `draft:${text}`, text }),
    blockedNotice: (reason) => `blocked-${reason}`,
    forcedNotice: () => 'forced',
    staleNotice: () => 'changed while sending',
    mergedNotice: () => 'draft merged',
  }
}

/** Runner-shaped deps: the EXACT restore wiring index.ts uses — mergeDraft
 * over the live editor string; verbatim only when the merged result IS the
 * draft (that is what decides whether the notice may promise a force).
 * `restored` records every restore call, to prove each operation restores
 * exactly once. */
function editorRestoreDeps(options: {
  agent: () => SteerAgentLike | undefined
  generation?: () => number
  guard: Promise<GuardVerdict>
  editor: () => string
  setEditor: (text: string) => void
  restored?: string[]
}): SteerDeps {
  const deps = makeDeps({ agent: options.agent, generation: options.generation, guard: options.guard })
  deps.restoreDraft = (draft) => {
    options.restored?.push(draft)
    const merged = mergeDraft(options.editor(), draft)
    options.setEditor(merged)
    return merged === draft
  }
  return deps
}

test('a queue splice while the guard is in flight aborts stale, restores the draft, loses nothing', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices, restored }), 'draft')
  // While the guard reads the file, another surface splices B into the queue.
  agent.state.nextTurn = [...agent.state.nextTurn, { id: 'b' }]
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['a', 'b'], 'nothing may be removed while stale')
  assert.deepEqual(agent.steered, [], 'no message may be steered')
  assert.deepEqual(restored, ['draft'], 'the stale send must restore the editor draft (it was cleared before onSteer)')
  assert.ok(notices.some(note => note.includes('changed while sending')), notices.join(' | '))
})

test('a queue edit while the guard is in flight aborts stale and restores the draft', async () => {
  const agent = fakeAgent(['a', 'b'])
  const guard = deferredGuard()
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, restored }), 'draft')
  // The user edits A away (delete) while the guard runs.
  agent.state.nextTurn = [{ id: 'b' }]
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['b'], 'the edited queue survives untouched')
  assert.deepEqual(agent.steered, [], 'the stale snapshot must not be force-sent')
  assert.deepEqual(restored, ['draft'], 'the stale send must restore the editor draft')
})

test('a session switch while the guard is in flight aborts stale and restores the draft', async () => {
  let current: FakeAgent | undefined = fakeAgent(['a'])
  const guard = deferredGuard()
  const steeredFirst = current.steered
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => current, guard: guard.promise, restored }), 'x')
  current = fakeAgent(['z']) // session switch mid-guard
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(steeredFirst, [], 'the OLD session must not receive the payload')
  assert.deepEqual(current.steered, [], 'the NEW session must not receive an unguarded payload')
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
})

test('a generation bump while the guard is in flight aborts stale and restores the draft', async () => {
  let generation = 1
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, generation: () => generation, guard: guard.promise, restored }), 'x')
  generation = 2 // session switch (generation bump)
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'stale')
  assert.deepEqual(agent.steered, [])
  assert.deepEqual(restored, ['x'], 'the stale send must restore the editor draft')
})

test('a clean guard steers exactly the confirmed messages and removes only them', async () => {
  const agent = fakeAgent(['a', 'b'])
  const guard = deferredGuard()
  const notices: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices }), 'draft')
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.state.nextTurn, [], 'confirmed messages are removed')
  assert.equal(agent.steered.length, 3, 'two queued messages + the draft')
  assert.deepEqual(agent.steered.map(m => m.id), ['a', 'b', 'draft:draft'])
  assert.ok(notices.some(note => note.includes('steering 3 messages')), notices.join(' | '))
})

test('a blocked guard restores the draft and reports the divergence kind', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const restored: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices, restored }), 'draft')
  guard.resolve({ kind: 'blocked', reason: 'tail-mismatch' })
  assert.equal(await pending, 'blocked')
  assert.deepEqual(restored, ['draft'], 'the draft must be restored for a retry')
  assert.ok(notices.some(note => note.includes('blocked-tail-mismatch')), notices.join(' | '))
  assert.deepEqual(agent.steered, [])
})

test('a clean guard with an empty queue falls back to the classic single-draft steer', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const guard = deferredGuard()
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise }), 'hello')
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.followed.map(m => m.id), ['draft:hello'], 'an idle agent takes a followup')
  agent.status = 'running'
  const guard2 = deferredGuard()
  const pending2 = steerAll(makeDeps({ agent: () => agent, guard: guard2.promise }), 'hello')
  guard2.resolve({ kind: 'ok' })
  assert.equal(await pending2, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['draft:hello'], 'a running agent takes a steer')
})

test('a forced guard skips the info notice and still sends', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  const pending = steerAll(makeDeps({ agent: () => agent, guard: guard.promise, notices }), '')
  guard.resolve({ kind: 'forced' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.steered.map(m => m.id), ['a'])
  assert.ok(notices.some(note => note === 'error: forced'), notices.join(' | '))
  assert.ok(!notices.some(note => note.includes('steering')), 'no info notice when forced')
})

test('onlyDraft steers the draft alone: explicitly queued messages stay queued', async () => {
  // Busy-Enter steer (web busyEnter parity): Enter steers the DRAFT only —
  // a message the user queued explicitly (Ctrl+Enter or a notice) must not
  // be swept into the turn, because already-steered input cannot be pulled
  // back.
  const agent = fakeAgent(['queued'])
  agent.status = 'running'
  const outcome = await steerAll(
    makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'ok' }) }),
    'draft text',
    { onlyDraft: true },
  )
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.text), ['draft text'], 'the draft must be steered')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['queued'], 'the queued message must stay queued')
  assert.deepEqual(agent.followed, [], 'no followup')
})

test('onlyDraft while idle falls back to a followup', async () => {
  const agent = fakeAgent([])
  agent.status = 'idle'
  const outcome = await steerAll(
    makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'ok' }) }),
    'draft text',
    { onlyDraft: true },
  )
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.followed.map(m => m.text), ['draft text'], 'an idle agent takes a followup')
  assert.deepEqual(agent.steered, [], 'nothing steered')
})

test('onlyDraft survives queue splices during the guard (the queue is irrelevant)', async () => {
  const agent = fakeAgent(['a'])
  agent.status = 'running'
  const guard = deferredGuard()
  const pending = steerAll(
    makeDeps({ agent: () => agent, guard: guard.promise }),
    'draft',
    { onlyDraft: true },
  )
  // A queue splice while the guard reads the file: onlyDraft must NOT abort
  // stale — it never claimed the queue, so the queue changing is fine.
  agent.state.nextTurn = [...agent.state.nextTurn, { id: 'b' }]
  guard.resolve({ kind: 'ok' })
  assert.equal(await pending, 'ok')
  assert.deepEqual(agent.steered.map(m => m.text), ['draft'], 'the draft is steered')
  assert.deepEqual(agent.state.nextTurn.map(m => m.id), ['a', 'b'], 'the queue is untouched')
})

test('onlyDraft with a forced guard still reports the force', async () => {
  const agent = fakeAgent([])
  agent.status = 'running'
  const notices: string[] = []
  const outcome = await steerAll(
    makeDeps({ agent: () => agent, guard: Promise.resolve({ kind: 'forced' }), notices }),
    'draft',
    { onlyDraft: true },
  )
  assert.equal(outcome, 'ok')
  assert.deepEqual(agent.steered.map(m => m.text), ['draft'])
  assert.ok(notices.some(note => note === 'error: forced'), notices.join(' | '))
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
  // The user typed something new while the guard ran: the newer text
  // stays on top AND the unsent submission is preserved beneath it —
  // nothing may vanish silently.
  const merged = mergeDraft('new draft typed while guard runs', 'old submitted')
  assert.ok(merged.includes('new draft typed while guard runs'), merged)
  assert.ok(merged.includes('old submitted'), `the unsent submission must survive:\n${merged}`)
  assert.equal(merged.indexOf('new draft typed while guard runs'), 0, 'the newer text leads')
})

test('a MERGED draft gets the merged notice, never a force promise', async () => {
  const agent = fakeAgent(['a'])
  const guard = deferredGuard()
  const notices: string[] = []
  // The restore returns FALSE: the draft was merged with newer input, so
  // the token fingerprint no longer matches — the next press cannot force.
  const deps = makeDeps({ agent: () => agent, guard: guard.promise, notices })
  const original = deps.restoreDraft
  deps.restoreDraft = () => { original('x'); return false }
  const pending = steerAll(deps, 'draft')
  guard.resolve({ kind: 'blocked', reason: 'diverged' })
  assert.equal(await pending, 'blocked')
  assert.ok(notices.some(note => note.includes('draft merged')), notices.join(' | '))
  assert.ok(!notices.some(note => note.includes('blocked-diverged')), 'the force-promise notice must not be shown for a merged draft')
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

test('two INDEPENDENT same-text operations on an EMPTY editor: both BLOCKED restores keep both copies', async () => {
  // The review's minimal counterexample at the orchestration level: A and B
  // both submit `same` via Ctrl+S (the editor was cleared before each
  // onSteer fired, tui-app.ts), both guards block, A restores first, B
  // second. Each operation hits exactly one terminal branch and restores
  // EXACTLY once — the second restore must append, never dedup.
  const agent = fakeAgent(['a'])
  const guardA = deferredGuard()
  const guardB = deferredGuard()
  let editor = ''
  const restored: string[] = []
  const depsA = editorRestoreDeps({ agent: () => agent, guard: guardA.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  const depsB = editorRestoreDeps({ agent: () => agent, guard: guardB.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored })
  const pendingA = steerAll(depsA, 'same')
  const pendingB = steerAll(depsB, 'same')
  guardA.resolve({ kind: 'blocked', reason: 'diverged' })
  guardB.resolve({ kind: 'blocked', reason: 'tail-mismatch' })
  assert.equal(await pendingA, 'blocked')
  assert.equal(await pendingB, 'blocked')
  assert.deepEqual(restored, ['same', 'same'], 'each failed operation restores exactly once')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
})

test('two INDEPENDENT same-text operations plus a THIRD draft typed mid-flight: all three survive', async () => {
  // While both guards are in flight the user types a third, different draft.
  // The restores merge into it — nothing the user typed may be overwritten
  // and neither unsent submission may be dropped.
  const agent = fakeAgent(['a'])
  const guardA = deferredGuard()
  const guardB = deferredGuard()
  let editor = ''
  const restored: string[] = []
  const pendingA = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardA.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  const pendingB = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardB.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  editor = 'third draft' // the user keeps typing while both guards read the file
  guardA.resolve({ kind: 'blocked', reason: 'diverged' })
  guardB.resolve({ kind: 'blocked', reason: 'diverged' })
  assert.equal(await pendingA, 'blocked')
  assert.equal(await pendingB, 'blocked')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
  assert.ok(editor.startsWith('third draft'), `the user's newest text leads:\n${editor}`)
})

test('two INDEPENDENT same-text operations aborted STALE (queue spliced mid-flight): both copies survive', async () => {
  // Both guards pass but the queue changed while they read the file, so
  // BOTH sends abort stale — and BOTH restore their own submission.
  const agent = fakeAgent(['a'])
  const guardA = deferredGuard()
  const guardB = deferredGuard()
  let editor = ''
  const restored: string[] = []
  const pendingA = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardA.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  const pendingB = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardB.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  agent.state.nextTurn = [...agent.state.nextTurn, { id: 'b' }] // splice while both guards run
  guardA.resolve({ kind: 'ok' })
  guardB.resolve({ kind: 'ok' })
  assert.equal(await pendingA, 'stale')
  assert.equal(await pendingB, 'stale')
  assert.deepEqual(restored, ['same', 'same'], 'each stale send restores exactly once')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
})

test('same-text operations across a SESSION SWITCH (one stale, one blocked): both copies survive', async () => {
  // A's send is in flight when the user switches sessions (A aborts stale);
  // B is submitted against the NEW session and blocks. Both restores merge
  // into the same editor — text equality must not collapse them.
  let current: FakeAgent | undefined = fakeAgent(['a'])
  const guardA = deferredGuard()
  const guardB = deferredGuard()
  let editor = ''
  const restored: string[] = []
  const pendingA = steerAll(editorRestoreDeps({ agent: () => current as SteerAgentLike, guard: guardA.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  current = fakeAgent(['z']) // session switch while A's guard reads the file
  const pendingB = steerAll(editorRestoreDeps({ agent: () => current as SteerAgentLike, guard: guardB.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'same')
  guardA.resolve({ kind: 'ok' }) // re-validation fails → stale
  guardB.resolve({ kind: 'blocked', reason: 'removed' })
  assert.equal(await pendingA, 'stale')
  assert.equal(await pendingB, 'blocked')
  assert.deepEqual(restored, ['same', 'same'], 'each failed operation restores exactly once')
  assert.equal(editor.match(/same/g)?.length, 2, `both unsent submissions must survive:\n${editor}`)
})

test('two INDEPENDENT different-text operations failing in sequence: both survive', async () => {
  const agent = fakeAgent(['a'])
  const guardA = deferredGuard()
  const guardB = deferredGuard()
  let editor = ''
  const restored: string[] = []
  const pendingA = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardA.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'alpha')
  const pendingB = steerAll(editorRestoreDeps({ agent: () => agent, guard: guardB.promise, editor: () => editor, setEditor: (text) => { editor = text }, restored }), 'beta')
  guardA.resolve({ kind: 'blocked', reason: 'diverged' })
  guardB.resolve({ kind: 'blocked', reason: 'tail-mismatch' })
  assert.equal(await pendingA, 'blocked')
  assert.equal(await pendingB, 'blocked')
  assert.deepEqual(restored, ['alpha', 'beta'], 'each failed operation restores exactly once')
  assert.ok(editor.includes('alpha') && editor.includes('beta'), `both submissions must survive:\n${editor}`)
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
  const deps = makeDeps({ agent: () => writespied as never, guard: Promise.resolve({ kind: 'ok' }), notices, restored })
  deps.fence = () => true
  deps.fenceNotice = () => 'a session transition is in progress — try again in a moment'
  const outcome = await steerAll(deps, 'draft')
  assert.equal(outcome, 'stale')
  assert.deepEqual(writes, [], 'the fence must never let steer/followup reach the agent')
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
  const deps = makeDeps({ agent: () => spied as never, guard: Promise.resolve({ kind: 'ok' }) })
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
