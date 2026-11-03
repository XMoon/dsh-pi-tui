/**
 * TSP-7 Welcome D on the REAL Direct composition: the Host blank authority, the
 * registered `/sessions` command and the guarded switch, closed end to end.
 *
 * This is the L6 lane for the Welcome: the real Host service composition and
 * live Agents, the REAL TUI runner in its Direct branch, the REAL command
 * registry, the REAL `DirectSessionReader`, the REAL Session Browser read owner
 * and the shipped SDK over a scripted pane. The Welcome's Resume action is a
 * pointer event on the wire; everything after it is production code.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - real Host services + live Agents, the real runner, `SubmissionController`,
 *   Direct `SessionWriter`/`SessionReader`, command registration, the real TSP
 *   renderer and its native Session Browser
 * - the official turn-boundary projection behind `SessionReader.blank`
 * - the official persistence seam behind the pre-boot blank Sessions
 * TEST STAND-INS / SUBSTITUTIONS
 * - the scripted streaming LLM adapter (the model endpoint only)
 * - the scripted tty pane (its advertised kinds ARE the handshake)
 * - prototype recorders on `DirectSessionReader.list`/`.blank` (read-only
 *   observers: the UNBOUND original is saved and re-called verbatim)
 * DELIBERATELY ABSENT
 * - a user profile and external providers; a physical Tern GUI / OS input path
 *   (this lane is `CONTROL_INJECTED_WIRE`, never `OS_INPUT_VERIFIED`)
 * @module @xmoon76/dsh-pi-tui/test/runtime/direct/tern-tsp-welcome-commands
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectSessionReader } from '../../../src/runtime/direct/session-direct.ts'
import type { SessionSummary } from '../../../src/runtime/session-reader-port.ts'
import { createDirectTspFixture, directSettle, waitFor, waitForInputDelivery, type DirectTspFixture } from '../../support/direct-tsp-fixture.ts'
import { clickNode, pickerNode, pickerProps, wireNodes, type WireNode } from '../../support/tsp-picker-wire.ts'
import { sendActivate, sendPickerAction, sendSelect } from '../../support/tsp-picker-wire.ts'

const BROWSER = 'session-browser-'
const WELCOME = 'welcome-'

/** The live D Welcome nodes on this pane's wire. */
function welcomeNodes(fixture: DirectTspFixture): WireNode[] {
  return wireNodes(fixture.pane).filter(node => node.id.includes(WELCOME))
}

/** Whether Main currently shows the D Welcome. */
function welcomeShown(fixture: DirectTspFixture): boolean {
  return welcomeNodes(fixture).some(node => node.id.includes('welcome-box'))
}

/** The Resume node, if the Welcome paints one. */
function resumeNode(fixture: DirectTspFixture): WireNode | undefined {
  return welcomeNodes(fixture).find(node => node.id.includes('welcome-resume') && node.p.tag === 'button')
}

/** Every text the Dock carries right now (it must never hold a welcome line). */
function dockTexts(fixture: DirectTspFixture): string[] {
  return wireNodes(fixture.pane)
    .filter(node => node.id.startsWith('dock.'))
    .map(node => (typeof node.p.text === 'string' ? node.p.text : ''))
    .filter(text => text !== '')
}

/** Wait for the pane's composer to hold exactly this text. */
async function composerHolds(fixture: DirectTspFixture, text: string): Promise<void> {
  await waitFor(`the composer holds ${JSON.stringify(text)}`, () => {
    const editor = wireNodes(fixture.pane).find(node => node.k === 'editor')
    return editor !== undefined && editor.p.text === text
  })
}

/** Type one line into the composer and submit it (the production input ladder). */
async function submitInput(fixture: DirectTspFixture, command: string): Promise<void> {
  fixture.pane.input.type(command)
  await composerHolds(fixture, command)
  await directSettle(300)
  fixture.pane.input.type('\r')
}

/**
 * Read-only recorders over the PRODUCTION Direct reader. The patch is installed
 * BEFORE any fixture boots (a repaint during startup is evidence too) and
 * follows the repo's producer-fact rules: the UNBOUND prototype originals are
 * saved, every call goes through `original.call(this, …)`, the recorder returns
 * the ORIGINAL outcome unchanged, and the reader instance is recorded rather
 * than filtered (a Cordis `ctx.get` answer is a proxy, so `===` on it proves
 * nothing).
 */
function recordReaderCalls(): {
  readonly lists: Array<{ readonly reader: DirectSessionReader; readonly currentSessionId: string | undefined; readonly rows: readonly string[] }>
  readonly blanks: Array<{ readonly reader: DirectSessionReader; readonly sessionId: string; readonly outcome: boolean | undefined }>
  detach(): void
} {
  const lists: Array<{ reader: DirectSessionReader; currentSessionId: string | undefined; rows: readonly string[] }> = []
  const blanks: Array<{ reader: DirectSessionReader; sessionId: string; outcome: boolean | undefined }> = []
  const originalList = DirectSessionReader.prototype.list
  const originalBlank = DirectSessionReader.prototype.blank
  DirectSessionReader.prototype.list = async function (currentSessionId, signal) {
    const rows = await originalList.call(this, currentSessionId, signal)
    lists.push({ reader: this, currentSessionId, rows: (rows ?? []).map(row => row.id) })
    return rows
  }
  DirectSessionReader.prototype.blank = function (sessionId) {
    const outcome = originalBlank.call(this, sessionId)
    blanks.push({ reader: this, sessionId, outcome })
    return outcome
  }
  return {
    lists,
    blanks,
    detach(): void {
      DirectSessionReader.prototype.list = originalList
      DirectSessionReader.prototype.blank = originalBlank
    },
  }
}

test('the real turn-boundary blank authority presents the D Welcome in Main and keeps the Dock composer-only', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-welcome-blank-')
  const reads = recordReaderCalls()
  life.defer(() => reads.detach())
  const fixture = await createDirectTspFixture(life, {
    workRoot,
    sessionBrowser: true,
    composerActions: true,
    persistedBlankSession: { id: 'welcome-blank-session' },
    startup: { sessionId: 'welcome-blank-session' },
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await directSettle(4_000)
    await waitFor('the blank main subject presents the Welcome', () => welcomeShown(fixture))
    const ids = welcomeNodes(fixture).map(node => node.id)
    assert.ok(ids.some(id => id.includes('welcome-name')), 'the product name line is painted')
    assert.ok(ids.some(id => id.endsWith('welcome-version')), 'the committed version line is painted')
    assert.ok(ids.some(id => id.includes('welcome-resume')), 'the single Resume action is painted')
    assert.equal(dockTexts(fixture).filter(text => text.includes('DSH session')).length, 0,
      'the retired Dock welcome line is gone from the wire')
    assert.equal(JSON.stringify(welcomeNodes(fixture)).includes('welcome-blank-session'), false,
      'the Welcome states no Session id, never even indirectly')
    // The authority this presentation came from is the official semantic read.
    const blankReads = reads.blanks.filter(read => read.sessionId === 'welcome-blank-session')
    assert.ok(blankReads.some(read => read.outcome === true),
      'SessionReader.blank() answered true for the resumed blank Session')
    assert.ok(blankReads.every(read => read.reader !== undefined),
      'every read came through the production Direct reader instance')
  } finally {
    await fixture.settle()
  }
})

test('the first real request retires the Welcome through the same repaint chain, on the authority edge and not on a row count', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-welcome-turn-')
  const reads = recordReaderCalls()
  life.defer(() => reads.detach())
  const fixture = await createDirectTspFixture(life, {
    workRoot,
    sessionBrowser: true,
    composerActions: true,
    deltas: ['first answer'],
  })
  const prompts = fixture.recordPrompts(() => {})
  life.defer(() => prompts.detach())
  try {
    await waitForInputDelivery(fixture.pane)
    await directSettle(4_000)
    // The sessionless boot: the application's own formal idle commit is the
    // ONLY source of this invitation, so it must be on the wire before any
    // Session exists — and with no subject, no blank read is allowed.
    await waitFor('the sessionless Welcome to own Main', () => welcomeShown(fixture), 25_000)
    assert.equal(reads.blanks.length, 0, 'a sessionless surface performs no blank read')
    await submitInput(fixture, 'start the first turn')
    await waitFor('the first real model request to run', () => fixture.modelCalls() === 1, 25_000)
    await waitFor('the first projected row to reach the wire', () => {
      const wire = wireNodes(fixture.pane).map(node => node.id).join(' ')
      return /main\.s\d+-msg-/u.test(wire)
    })
    assert.equal(prompts.calls(), 1, 'exactly one real prompt was written')
    await directSettle(1_200)
    assert.equal(welcomeShown(fixture), false,
      'the started turn took the invitation away and it never comes back')
    assert.ok(reads.blanks.length > 0, 'the repaint consulted the official blank authority')
    assert.ok(reads.blanks.every(read => read.outcome !== undefined),
      'the Direct turn-boundary projection answers with a real bit, never unknown')
    assert.ok(reads.blanks.some(read => read.outcome === false),
      'the live Session is authoritatively NOT blank once its turn ran')
  } finally {
    await fixture.settle()
  }
})

test('W10: the Welcome Resume action opens the registered /sessions Browser with exactly one authoritative list', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-welcome-resume-')
  const seed = await createDirectTspFixture(life, { workRoot, deltas: ['seed answer'] })
  try {
    await waitForInputDelivery(seed.pane)
    await submitInput(seed, 'seed a persisted session')
    await waitFor('the seed turn to complete', () => seed.modelCalls() === 1, 25_000)
    await directSettle(800)
  } finally {
    await seed.settle()
  }
  const reads = recordReaderCalls()
  life.defer(() => reads.detach())
  const fixture = await createDirectTspFixture(life, { workRoot, sessionBrowser: true, composerActions: true })
  try {
    await waitForInputDelivery(fixture.pane)
    await directSettle(4_000)
    const idle = reads.lists.length
    await waitFor('the sessionless Welcome to own Main', () => welcomeShown(fixture), 25_000)
    const button = resumeNode(fixture)
    assert.ok(button !== undefined, 'the Resume button is painted as operable')
    assert.ok((button?.p.actions as Record<string, unknown> | undefined)?.click !== undefined,
      'the node advertises its click action to the client')
    clickNode(fixture.pane, button!)
    await waitFor('the registered /sessions Browser opens', () => pickerNode(fixture.pane, BROWSER) !== undefined, 25_000)
    await waitFor('the Browser lists the seeded session', () => reads.lists.length > idle, 25_000)
    assert.equal(reads.lists.length, idle + 1, 'ONE authoritative list read for one Resume action')
    const itemIds = (pickerProps(fixture.pane, BROWSER).items as Array<Record<string, unknown>> | undefined)?.map(item => String(item.id)) ?? []
    assert.ok(itemIds.some(id => id.startsWith('session:')), `the Browser shows real rows: ${JSON.stringify(itemIds)}`)
    assert.equal(welcomeNodes(fixture).some(node => node.id.includes('session:')), false,
      'the Welcome never lists Sessions itself')
  } finally {
    await fixture.settle()
  }
})

test('W14: a Host-owned /sessions leaves a disabled Welcome action and starts no listing', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-welcome-hostname-')
  const hostInvocations: string[] = []
  const reads = recordReaderCalls()
  life.defer(() => reads.detach())
  const fixture = await createDirectTspFixture(life, {
    workRoot,
    sessionBrowser: true,
    composerActions: true,
    hostCommands: [{
      name: 'sessions',
      description: 'Host-owned sessions command',
      handler: (invocation) => { hostInvocations.push(invocation.rawInput) },
    }],
  })
  try {
    await waitForInputDelivery(fixture.pane)
    await waitFor('the sessionless Welcome to own Main', () => welcomeShown(fixture), 25_000)
    const button = resumeNode(fixture)
    assert.ok(button !== undefined, 'the action is still stated')
    assert.equal(button?.p.actions, undefined,
      'a degraded registration paints no operable affordance at all')
    const attrs = button?.p.attrs as Record<string, unknown> | undefined
    assert.equal(attrs?.['aria-disabled'], 'true', 'and it says so accessibly')
    assert.equal(attrs?.disabled, 'disabled', 'with the real disabled attribute')
    clickNode(fixture.pane, button!)
    await directSettle(600)
    assert.equal(pickerNode(fixture.pane, BROWSER), undefined, 'nothing opened')
    assert.equal(reads.lists.length, 0, 'and no Session listing was read')
    assert.equal(hostInvocations.length, 0, 'the Host-owned command was not invoked either')
  } finally {
    await fixture.settle()
  }
})

test('W12: resuming another Session from the Welcome Browser follows the real switch and re-projects the new subject', async (t) => {
  const { testLifecycle } = await import('../../support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const workRoot = life.tempDir('dsh-welcome-switch-')
  const reads = recordReaderCalls()
  life.defer(() => reads.detach())
  const fixture = await createDirectTspFixture(life, {
    workRoot,
    sessionBrowser: true,
    composerActions: true,
    persistedBlankSessions: [{ id: 'welcome-target-a' }, { id: 'welcome-target-b' }],
    startup: { sessionId: 'welcome-target-a' },
  })
  // The production Direct open seam, patched the same way the sibling Browser
  // command suite patches it: the UNBOUND original, called through `this`.
  const agents = fixture.ctx.get('agents') as unknown as { resume(options: unknown): Promise<unknown> }
  const originalResume = agents.resume
  const lifecycleTrace: Array<{ readonly kind: 'open'; readonly sessionId: string }> = []
  agents.resume = async function (this: typeof agents, options: unknown): Promise<unknown> {
    lifecycleTrace.push({ kind: 'open', sessionId: String((options as { resumeSessionId?: unknown }).resumeSessionId) })
    return originalResume.call(this, options)
  }
  life.defer(() => { agents.resume = originalResume })
  try {
    await waitForInputDelivery(fixture.pane)
    await directSettle(4_000)
    await waitFor('the resumed blank subject A presents the Welcome', () => welcomeShown(fixture), 25_000)
    clickNode(fixture.pane, resumeNode(fixture)!)
    await waitFor('the Browser opens from the Welcome', () => pickerNode(fixture.pane, BROWSER) !== undefined, 25_000)
    const picker = pickerNode(fixture.pane, BROWSER)!.id
    sendSelect(fixture.pane, 'session:welcome-target-b', picker)
    await waitFor('the Browser selects B', () => pickerProps(fixture.pane, BROWSER).selected === 'session:welcome-target-b', 25_000)
    const opensBefore = lifecycleTrace.length
    sendActivate(fixture.pane, 'session:welcome-target-b', picker)
    await waitFor('the real switch opens B', () => lifecycleTrace.slice(opensBefore)
      .some(event => event.kind === 'open' && event.sessionId === 'welcome-target-b'), 25_000)
    assert.equal(lifecycleTrace.slice(opensBefore).filter(event => event.kind === 'open'
      && event.sessionId === 'welcome-target-b').length, 1,
    'one activation is exactly one Direct open')
    await waitFor('B becomes the presented blank subject', () => {
      const ids = welcomeNodes(fixture).map(node => node.id)
      return welcomeShown(fixture) && ids.some(id => id.includes('welcome-resume'))
    }, 25_000)
    assert.equal(JSON.stringify(welcomeNodes(fixture)).includes('welcome-target-b'), false,
      'the new subject is presented without leaking its id into the Welcome')
  } finally {
    await fixture.settle()
  }
})
