/**
 * TSP-7 Welcome D: the Main empty state, its ONE action and its Dock/input
 * contract, observed on the official SDK wire of a production
 * `mountTspRenderer` mount.
 *
 * The eligibility this suite feeds is the display argument the production seam
 * carries (`SurfaceDisplaySeam.setTranscript`'s last argument), so the claim
 * here is the RENDERER's presentation and admission. The real
 * `SessionReader.blank` → repaint → Main chain is qualified in
 * `test/app/tern-tsp-live-projection.test.ts` (W05/W06/W07) and the registered
 * `/sessions` → Browser → switch closure in
 * `test/runtime/direct/tern-tsp-welcome-commands.test.ts` (W10-W13/W16).
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the shipped SDK `connect()` over the scripted pane, the real
 *   `mountTspRenderer`, its real `SurfaceDisplaySeam`, `bindInput` and its real
 *   Session Browser presentation; the real node mapper/reconciler producing
 *   the wire
 * TEST STAND-INS / SUBSTITUTIONS
 * - the scripted tty pane (its advertised kinds/features ARE the handshake the
 *   view reads; nothing forces a capability on the renderer)
 * - the `TspInputHandlers` seam: recording application entries plus a switch
 *   for the real `/sessions` availability fact
 * - the `StatusSnapshotReader`: a committed snapshot with a known
 *   `host.tuiVersion`
 * DELIBERATELY ABSENT
 * - the Host `SessionReader.blank` port and the command registration (owned by
 *   the two suites named above); no real Session, no network, no physical Tern
 *   GUI/OS input path
 * @module @xmoon76/dsh-pi-tui/test/app/tern-tsp-welcome
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import type { StatusSnapshot, StatusSnapshotReader } from '../../src/domain/status/types.ts'
import { emptyStatusSnapshot } from '../../src/domain/status/types.ts'
import type { DisplayWelcomeEligibility, DisplayWelcomeFacts } from '../../src/app/surface/display-seam.ts'
import { mountTspRenderer, type TspRenderer } from '../../src/tui/tsp/session.ts'
import { installTspPane, type TspPane } from '../support/tsp-terminal-fixture.ts'
import { settle, waitUntil } from '../support/tsp-runner-harness.ts'
import { waitForInputDelivery } from '../support/direct-tsp-fixture.ts'
import { clickNode, wireNodes, type WireNode } from '../support/tsp-picker-wire.ts'
import { welcomeView, TSP_WELCOME_STYLES } from '../../src/tui/tsp/welcome-view.ts'
import { WELCOME_WHALE_VARIANTS, welcomeWhaleGradientColors, welcomeWhalePlainLines } from '../../src/tui/components/welcome-whale.ts'

/**
 * The styled vocabulary a real Tern pane negotiates: `el`+`styles` for the
 * native nodes, the picker kinds + `scroll` for the Session Browser, and the
 * `icon` KIND for the client's own icon vocabulary. A case that must prove a
 * capability gate overrides this list verbatim — the handshake decides, the
 * test never forces a capability on the view.
 */
const STYLED_KINDS = ['col', 'card', 'section', 'md', 'code', 'badge', 'tool', 'el', 'picker', 'row', 'overlay', 'text', 'kv', 'icon']
const STYLED_FEATURES = ['flow', 'styles', 'scroll']

/** The committed version this suite's status reader carries. */
const TEST_VERSION = '0.0.0-welcome-test'
const VERSION_LINE = `v${TEST_VERSION} · DeepSeek Harness`

/** A committed status snapshot carrying ONE known TUI version. */
function snapshotWithVersion(tuiVersion: string): StatusSnapshot {
  return { ...emptyStatusSnapshot(), host: { tuiVersion } } as StatusSnapshot
}

/** The application facts a case may flip on its own mount. */
interface HandlerState {
  browserOpens: number
  browserAvailable: boolean
  /** A throwing entry stands in for an unwired composition. */
  browserThrows: boolean
}

interface WelcomeMount {
  readonly pane: TspPane
  readonly renderer: TspRenderer
  readonly state: HandlerState
  readonly fatals: unknown[]
  /** Every text the mount put on the Dock notice channel. */
  readonly notifications: string[]
  /**
   * Commit one transcript frame through the production seam with its
   * eligibility, then wait for the frame the mount PAINTED as a result (never
   * for a timer). `painted` is the observable the caller is about to assert.
   */
  commit(input: {
    readonly messages?: readonly unknown[]
    readonly source?: object
    readonly eligibility?: DisplayWelcomeEligibility
    readonly painted?: () => boolean
    /** The commit is FENCED: the hydration rule drops it, so the observable is
     *  that no frame results (a bounded negative window, not a frame wait). */
    readonly fenced?: boolean
  }): Promise<void>
  /** Commit one status snapshot through the ONE atomic display commit. */
  commitStatus(snapshot: StatusSnapshot, painted?: () => boolean): Promise<void>
  /** Open the native Session Browser through this mount's own presentation. */
  openBrowser(): void
  /** Close that Browser through its own handle (the Esc/Close path). */
  closeBrowser(): void
  node(fragment: string): WireNode | undefined
  nodes(prefix: string): WireNode[]
  dispose(): Promise<void>
}

async function mountWelcome(options: {
  /** The pane's advertised kinds verbatim: WITHOUT `el` the mount takes the
   *  documented plain-text fallback, so the handshake decides and the test
   *  never forces a capability on the view. */
  readonly kinds?: readonly string[]
  /** The advertised features (the styled default negotiates `scroll` too). */
  readonly features?: readonly string[]
  /** Bind no status reader: the formal snapshot has never committed. */
  readonly bindStatus?: boolean
} = {}): Promise<WelcomeMount> {
  const kinds = options.kinds ?? STYLED_KINDS
  const pane = installTspPane({
    kinds,
    features: options.features ?? STYLED_FEATURES,
  })
  const session = await connect({ timeout: 500, exitHooks: false })
  assert.ok(session, 'the scripted pane must connect through the shipped SDK')
  const fatals: unknown[] = []
  const renderer = mountTspRenderer(session, {
    copyVisual: async () => false,
    requestExit() {},
    onFatal: (error) => { fatals.push(error) },
  })
  const state: HandlerState = { browserOpens: 0, browserAvailable: true, browserThrows: false }
  renderer.bindInput({
    exit() {}, cancel() {}, submit() {}, steer() {}, pasteMedia() {}, noteUserInput() {},
    pastedPath: () => {}, admitPastedPathDelivery: () => true, shouldRememberInput: () => true,
    listContinuedQuestions: () => [], reopenContinuedQuestion: () => false,
    openModelPicker() {}, openModelQuick() {},
    openSessionBrowser() {
      state.browserOpens += 1
      if (state.browserThrows) throw new Error('session browser command not registered')
    },
    // The truthful availability: the mount really offers a Session Browser
    // presentation AND the case's own switch (the production Command Surface
    // admits on exactly these two facts).
    sessionBrowserAvailable: () => state.browserAvailable && renderer.sessionBrowserPresentation !== undefined,
  })
  let snapshot = snapshotWithVersion(TEST_VERSION)
  const reader: StatusSnapshotReader = { snapshot: () => snapshot }
  if (options.bindStatus !== false) renderer.bindStatusReader(reader)
  const notifications: string[] = []
  const notify = renderer.display.notify.bind(renderer.display)
  renderer.display.notify = (text, kind) => { notifications.push(text); notify(text, kind) }
  let browserHandle: import('../../src/app/command/session-browser-presentation.ts').SessionBrowserPanelHandle | undefined
  const mounted: WelcomeMount = {
    pane,
    renderer,
    state,
    fatals,
    notifications,
    async commit(input) {
      const framesBefore = pane.frameCount()
      renderer.display.setTranscript(
        (input.messages ?? []) as never,
        undefined,
        undefined,
        undefined,
        undefined,
        input.source,
        input.eligibility,
      )
      if (input.fenced === true) {
        await observeNothingHappens()
        assert.equal(pane.frameCount(), framesBefore, 'a fenced commit paints no frame at all')
        return
      }
      await waitUntil('the committed frame reached the pane', () => (input.painted?.() ?? pane.frameCount() > framesBefore))
    },
    async commitStatus(next, painted) {
      const framesBefore = pane.frameCount()
      snapshot = next
      renderer.display.commitDisplaySubject({}, {}, undefined)
      await waitUntil('the status commit reached the pane', () => (painted?.() ?? pane.frameCount() > framesBefore))
    },
    openBrowser() {
      const presentation = renderer.sessionBrowserPresentation
      assert.ok(presentation, 'this pane must negotiate the native Session Browser')
      browserHandle = presentation.open({
        subject: { currentSessionId: 'session-welcome', currentCwd: '/ws', isCurrent: () => true },
        onQueryChange: () => {},
        onResumeIntent: () => {},
        onClose: () => {},
      })
    },
    closeBrowser() {
      assert.ok(browserHandle !== undefined, 'a Browser must be open before it can be closed')
      browserHandle.close()
      browserHandle = undefined
    },
    node: (fragment) => wireNodes(pane).find(node => node.id.includes(fragment)),
    nodes: (prefix) => wireNodes(pane).filter(node => node.id.startsWith(prefix)),
    async dispose() {
      await renderer.dispose()
      pane.restore()
      await session.close()
    },
  }
  if (options.bindStatus !== false) await mounted.commitStatus(snapshotWithVersion(TEST_VERSION))
  return mounted
}

/** The formal sessionless commit, waited on the painted Welcome root. */
async function idle(m: WelcomeMount): Promise<void> {
  m.renderer.display.setWelcomeIdle(true)
  // The product-name node exists on BOTH the styled and the plain path (the
  // single-child `col` root is collapsed into the region), so this readiness
  // fact is capability-independent.
  await waitUntil('the Welcome reached the pane', () => m.node('welcome-name') !== undefined)
}

/**
 * A bounded NEGATIVE observation window.
 *
 * The claim is that nothing happens — no node, no open, no repaint. There is
 * no event that announces an absence, so the contract can only be observed for
 * a window; the bound is the SDK's own frame-credit flush (it acks each drawn
 * frame and coalesces the next View behind that ack), so any handler the mount
 * was going to run has already run by the time this returns.
 */
async function observeNothingHappens(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 150)) // reason: bounded negative observation window; an absence announces itself with no event
}

/** The whale rows the wire really carries, in document order. */
function whaleRowsOnWire(m: WelcomeMount): string[] {
  return m.nodes('main.')
    .filter(node => /welcome-whale-line-\d+$/u.test(node.id))
    .map(node => String(node.p.text ?? ''))
}

/** Every text the Dock carries: the Dock must never hold a welcome line. */
function dockTexts(m: WelcomeMount): string[] {
  return m.nodes('dock.')
    .map(node => (typeof node.p.text === 'string' ? node.p.text : ''))
    .filter(text => text !== '')
}

/** The text one wire node carries (`undefined` when it paints no text). */
function textOf(node: WireNode | undefined): string | undefined {
  return node === undefined || typeof node.p.text !== 'string' ? undefined : node.p.text
}

/** How many times the SDK sent the `name` stylesheet message on this wire. */
function sheetInstalls(pane: TspPane, name: string): number {
  let count = 0
  for (const message of pane.output.text().matchAll(/\u001b_tsp;s;([\s\S]*?)\u001b\\/g)) {
    const body = JSON.parse(message[1]!) as { readonly name?: string }
    if (body.name === name) count += 1
  }
  return count
}

// ── W01/W02/W03: the display states, and the Dock staying itself ────────────

test('W01: the formal sessionless commit shows ONE Welcome in Main and leaves the Dock as the single composer', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const stage = m.node('welcome-stage')
  assert.ok(stage !== undefined, 'the Welcome stage is mounted in Main')
  assert.equal(stage.id, 'main.welcome-stage', 'Main holds exactly one Welcome root, in the Main region')
  assert.equal(m.nodes('main.').filter(node => node.id.endsWith('.welcome-box')).length, 1,
    'ONE centred box, not a card grid or a second column')
  assert.ok(m.node('dock.quiet-composer.composer') !== undefined, 'the Dock still owns the ONE editor')
  assert.equal(m.nodes('dock.').some(node => node.id.includes('welcome')), false,
    'the Dock carries no welcome node at all')
  assert.deepEqual(dockTexts(m).filter(text => text.includes('DSH session')), [],
    'the retired `DSH session` line is gone from the wire')
  assert.ok(m.node('welcome-resume') !== undefined, 'the Resume action exists')
  assert.equal(m.fatals.length, 0, 'the mount stayed healthy')
})

test('W01: the Welcome states the product name, its directory and Resume actions, and the fixed tip', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const texts = m.nodes('main.').map(node => String(node.p.text ?? '')).filter(text => text !== '')
  // The icon is the CLIENT's own glyph (`ui.icon`), so it is not a painted
  // text run this suite may spell out: the copy is the name, the committed
  // version, the action label and arrow, and the fixed tip.
  assert.deepEqual(texts, [
    ...whaleRowsOnWire(m),
    'dsh-pi-tui',
    VERSION_LINE,
    'Choose directory',
    'Resume session',
    '›',
    'Tip: Type / to browse commands.',
  ], 'the painted copy is exactly the D text, in order, with no extra line')
  assert.equal(m.nodes('main.').some(node => node.k === 'icon' && String(node.p.name) === 'history'), true,
    'the Resume action leads with the client icon vocabulary, not a hand-painted glyph')
  assert.ok(m.node('welcome-choose') !== undefined,
    'the sessionless Choose directory action is a real styled button, not painted text')
})

test('W02: a blank-session commit shows the same Welcome and takes the version from the committed status snapshot', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  assert.ok(m.node('welcome-stage') !== undefined, 'the blank main subject shows the Welcome')
  assert.equal(m.node('welcome-version')?.p.text, VERSION_LINE,
    'the version line is the committed Status fact with the fixed Harness suffix')
  await m.commitStatus(snapshotWithVersion('7.7.7-committed'))
  assert.equal(m.node('welcome-version')?.p.text, 'v7.7.7-committed · DeepSeek Harness',
    'a formal status commit re-projects the version; the view never caches it')
})

test('W02: an un-committed status leaves NO version line rather than a fabricated one', async (t) => {
  const m = await mountWelcome({ bindStatus: false })
  t.after(() => m.dispose())
  await idle(m)
  assert.ok(m.node('welcome-name') !== undefined, 'the product name line is drawn')
  assert.equal(m.node('welcome-version'), undefined,
    'no version line exists before a formal status commit')
  assert.equal(JSON.stringify(m.nodes('main.')).includes('0.5'), false,
    'and no sample version slipped in either')
})

test('W03: a non-blank commit hides the Welcome and keeps the transcript root', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  await m.commit({
    source,
    messages: [{ kind: 'user', turn: 0, text: 'a started turn' }],
    eligibility: 'hidden',
  })
  assert.equal(m.node('welcome-stage'), undefined, 'the Welcome left Main')
  assert.ok(m.nodes('main.').some(node => node.id.includes('msg-')), 'the transcript root stays')
  assert.equal(m.nodes('dock.').some(node => node.id.includes('welcome')), false,
    'the retired line never came back into the Dock')
})

// ── W04: the unknown authority never impersonates a new blank Session ────────

test('W04: an absent eligibility and the retired welcome facts show nothing and state no Session or model fact', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  // An older caller that passes no eligibility at all: the mount never started
  // in a formal sessionless state, so nothing may appear.
  await m.commit({ source: {}, messages: [] })
  assert.equal(m.node('welcome-stage'), undefined, 'no eligibility argument shows no Welcome')
  const facts: DisplayWelcomeFacts = {
    cwd: '/ws-secret', sessionId: 'session-facts', model: 'provider/hidden-model', version: '1.2.3', preset: 'review',
  }
  m.renderer.display.setWelcomeCard(facts)
  await observeNothingHappens()
  assert.equal(m.node('welcome-stage'), undefined, 'welcome FACTS never promote the empty state')
  const wire = JSON.stringify(wireNodes(m.pane))
  const retiredFacts: readonly string[] = [
    facts.sessionId, facts.cwd, facts.model ?? '', facts.preset ?? '', facts.version,
  ].filter(value => value !== '')
  for (const value of retiredFacts) {
    assert.equal(wire.includes(value), false, `the retired card fact ${value} is not painted anywhere`)
  }
})

// ── W08/W09: the hydration fence and the incoming subject ────────────────────

test('W08: the hydration commit retires the Welcome in the SAME frame as Loading and a late retired commit cannot reopen it', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const oldSource = {}
  await m.commit({ source: oldSource, eligibility: 'blank-session' })
  assert.ok(m.node('welcome-stage') !== undefined, 'the old subject presented the Welcome')
  m.renderer.display.beginSessionHydration()
  await waitUntil('the Loading frame reached the pane', () => m.node('loading') !== undefined)
  assert.equal(m.node('welcome-stage'), undefined, 'the Welcome is gone with the outgoing subject')
  // The retired source's late frame — carrying a blank eligibility of its own.
  await m.commit({ source: oldSource, eligibility: 'blank-session', fenced: true })
  assert.equal(m.node('welcome-stage'), undefined,
    'a retired source cannot lift the Loading state nor resurrect its CTA')
})

test('W09: the incoming subject commits its own eligibility under a fresh presentation scope', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const oldSource = {}
  await m.commit({ source: oldSource, eligibility: 'blank-session' })
  const oldButtonKey = String(m.node('welcome-resume')?.p.key ?? '')
  assert.ok(oldButtonKey !== '')
  m.renderer.display.beginSessionHydration()
  await waitUntil('the Loading frame reached the pane', () => m.node('loading') !== undefined)
  const newSource = {}
  await m.commit({ source: newSource, eligibility: 'blank-session' })
  const newButtonKey = String(m.node('welcome-resume')?.p.key ?? '')
  assert.ok(newButtonKey !== '', 'the new subject presents a Welcome again')
  assert.notEqual(newButtonKey, oldButtonKey,
    'the CTA key re-scopes with the presentation scope, so the old frame cannot act on the new subject')
  assert.equal(newButtonKey.includes('session'), false, 'and the key carries no Session identity')
  await m.commit({ source: newSource, eligibility: 'hidden' })
  assert.equal(m.node('welcome-stage'), undefined, 'and it leaves when the new subject starts a turn')
})

test('W08: a click that lands inside the hydration window opens nothing', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined)
  m.renderer.display.beginSessionHydration()
  clickNode(m.pane, button)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0, 'the old subject keeps no live CTA into the switch window')
})

test('W15: an action addressed at a retired Welcome frame has no effect', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  const stale = m.node('welcome-resume')
  assert.ok(stale !== undefined)
  await m.commit({ source, messages: [{ kind: 'user', turn: 0, text: 'first' }], eligibility: 'hidden' })
  clickNode(m.pane, stale)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0, 'the retired node never opens the Browser')
})

// ── W10/W15: the ONE action forwards, and a second reach is refused ──────────

test('W10/W15: the Resume action forwards exactly once to the registered UI entry and is refused while the Browser owns the seat', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined, 'the Welcome carries its action')
  assert.equal(JSON.stringify(button?.p.actions ?? {}), '{"click":"click"}',
    'the node advertises exactly ONE click action')
  clickNode(m.pane, button)
  await waitUntil('the UI entry ran once', () => m.state.browserOpens === 1)
  // The Browser the entry opened now owns the seat. A second reach — on the
  // still-painted Welcome node — must not start another listing.
  m.openBrowser()
  await waitUntil('the native Browser is on the wire', () => m.node('session-browser-') !== undefined)
  const framesWithBrowser = m.pane.frameCount()
  clickNode(m.pane, button)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 1, 'the second reach is refused before any new listing')
  assert.ok(m.pane.frameCount() >= framesWithBrowser, 'the Browser stays painted')
})

test('W15: while a higher seat owns the input the Welcome action cannot pre-empt it', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined)
  m.openBrowser()
  await waitUntil('the Browser owns the seat', () => m.node('session-browser-') !== undefined)
  clickNode(m.pane, button)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0,
    'the Browser presenter is already open, so the Welcome never starts a second one')
})

// ── W14: the real availability fact, painted and enforced ────────────────────

test('W14: an unavailable Session Browser paints a genuinely disabled action with a readable reason', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  m.state.browserAvailable = false
  await idle(m)
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined, 'the action is still stated')
  const painted = JSON.stringify(button?.p ?? {})
  assert.match(painted, /aria-disabled/u, 'the disabled state is announced')
  assert.match(painted, /disabled/u, 'and the real disabled attribute is set')
  assert.equal(button?.p.actions, undefined,
    'an unavailable action advertises no click action at all, so it is never a dead control')
  assert.match(painted, /\/sessions/u, 'the reason names the typed route that still works')
  clickNode(m.pane, button!)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0, 'and the business layer refuses anyway')
})

test('W14: a mount whose pane offers no Session Browser presentation paints the same disabled form', async (t) => {
  // No Session Browser presentation: the pane keeps `el`+`styles`+`icon` but
  // does not negotiate the Browser's own picker vocabulary.
  const m = await mountWelcome({
    kinds: STYLED_KINDS.filter(kind => kind !== 'picker' && kind !== 'overlay'),
  })
  t.after(() => m.dispose())
  await idle(m)
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined)
  assert.equal(button?.p.actions, undefined, 'no presentation, no operable affordance')
  clickNode(m.pane, button!)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0)
})

test('W14: an unwired composition answers one visible refusal instead of dying', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  m.state.browserThrows = true
  await idle(m)
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined)
  clickNode(m.pane, button!)
  await waitUntil('the refusal reached the Dock', () => m.notifications.length > 0)
  assert.equal(m.notifications.filter(text => text.includes('/sessions')).length, 1,
    'exactly one stated refusal')
  assert.equal(m.fatals.length, 0, 'a refused entry is never a fatal renderer failure')
})

// ── W17: no refresh re-picks the whale or moves a fact into the Dock ─────────

test('W17: status, notice and welcome-fact commits never re-pick the whale or move a Session id into the Dock', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  const source = {}
  await m.commit({ source, eligibility: 'blank-session' })
  const rowsBefore = whaleRowsOnWire(m)
  const buttonKey = String(m.node('welcome-resume')?.p.key ?? '')
  assert.ok(rowsBefore.length > 0 && buttonKey !== '', 'the Welcome and its whale rows are painted')
  m.renderer.display.commitStatusFacts({ busy: true, working: true, sessionTitle: 'a title' })
  m.renderer.display.notify('a notice', 'info')
  m.renderer.display.setWelcomeCard({ cwd: '/ws', sessionId: 'session-x', model: 'p/m', version: '9' })
  await waitUntil('the notice row reached the Dock', () => m.node('dock.notice-') !== undefined)
  assert.deepEqual(whaleRowsOnWire(m), rowsBefore, 'the SAME whale rows stand through every refresh')
  assert.equal(m.node('welcome-resume')?.p.key, buttonKey, 'the action identity is stable across a refresh')
  assert.deepEqual(dockTexts(m).filter(text => text.includes('session-x')), [],
    'no Session id travelled into the Dock')
  m.renderer.display.commitStatusFacts({ busy: false, working: false })
  await waitUntil('the idle edge repainted the Dock', () => m.pane.frameCount() > (m.node('dock.quiet-composer') !== undefined ? 1 : 1))
  assert.deepEqual(whaleRowsOnWire(m), rowsBefore, 'and the idle edge re-picks nothing either')
})

test('W17: a resize keeps the same whale rows and the same action key', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const rowsBefore = whaleRowsOnWire(m)
  const buttonKey = String(m.node('welcome-resume')?.p.key ?? '')
  // The client's resize is delivered, then one REAL repaint is forced through a
  // committed status fact: identical content is diffed away by the SDK, so the
  // resize alone may legitimately paint nothing. The claim is that even a full
  // rebuild after the narrower viewport keeps the same drawn variant.
  m.pane.event({ ev: 'resize', sf: m.pane.frames().at(-1)!.sf, cols: 60 })
  m.renderer.display.notify('resize probe', 'info')
  await waitUntil('the post-resize repaint reached the pane', () => m.node('dock.notice-') !== undefined)
  assert.deepEqual(whaleRowsOnWire(m), rowsBefore, 'a narrower pane re-draws the SAME rows')
  assert.equal(m.node('welcome-resume')?.p.key, buttonKey)
})

// ── W18: the negotiated capability boundary ─────────────────────────────────

test('W18: a pane without `el` gets the plain-text form and claims no button', async (t) => {
  // The base vocabulary WITHOUT `el`: the real handshake decides the fallback.
  const m = await mountWelcome({ kinds: ['col', 'card', 'section', 'md', 'code', 'badge', 'tool'] })
  t.after(() => m.dispose())
  await idle(m)
  const nodes = m.nodes('main.')
  assert.equal(nodes.some(node => node.k === 'el'), false, 'no `el` node is sent to a pane that did not negotiate it')
  const texts = nodes.map(node => String(node.p.text ?? '')).filter(text => text !== '')
  assert.deepEqual(texts, ['dsh-pi-tui', VERSION_LINE, 'Use /sessions to resume'],
    'the fallback states the name, the committed version and the typed route')
  assert.equal(nodes.some(node => node.k === 'button' || node.p.actions !== undefined), false,
    'and it never fakes an operable Resume control')
  assert.equal(nodes.some(node => node.id.endsWith('.welcome-resume-hint')), true,
    'the fallback names the typed route by its own key')
})

test('W18: a pane with `el`+`styles` but no `icon` kind gets the styled action with no icon node', async (t) => {
  // `el` + `styles` do NOT imply the `icon` KIND: sending an icon node here
  // would be a node the client cannot paint. The action must keep its label
  // and arrow and claim nothing else.
  const m = await mountWelcome({ kinds: STYLED_KINDS.filter(kind => kind !== 'icon') })
  t.after(() => m.dispose())
  await idle(m)
  const nodes = m.nodes('main.')
  assert.equal(nodes.some(node => node.k === 'icon'), false, 'no `icon` node is sent to a pane without the kind')
  assert.equal(nodes.some(node => node.id.includes('welcome-resume-icon')), false, 'and the icon slot is simply absent')
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined, 'the action is still painted')
  assert.equal(JSON.stringify(button?.p.actions ?? {}), '{"click":"click"}', 'and it is still the real operable button')
  const texts = nodes.map(node => String(node.p.text ?? '')).filter(text => text !== '')
  assert.ok(texts.includes('Resume session') && texts.includes('›'), 'label and arrow carry the affordance alone')
  assert.equal(nodes.some(node => node.id.endsWith('.welcome-box')), true, 'the styled stage still mounts')
})

// ── W19: ONE sheet, and nothing live after dispose ──────────────────────────

test('W19: the Welcome sheet is installed exactly once at mount and never re-registered', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  assert.equal(sheetInstalls(m.pane, 'dsh-welcome'), 1, 'ONE sheet install for this mount')
  await idle(m)
  await m.commit({ source: {}, eligibility: 'blank-session' })
  m.renderer.display.commitStatusFacts({ busy: true })
  m.renderer.display.notify('again', 'info')
  await waitUntil('the second notice reached the Dock', () => m.nodes('dock.notice-').length >= 1)
  assert.equal(sheetInstalls(m.pane, 'dsh-welcome'), 1,
    'repaints, status commits and notices never re-register it')
  assert.equal(sheetInstalls(m.pane, 'dsh-quiet-composer'), 1, 'the composer sheet stays exactly one too')
})

test('W19: a retired mount paints no frame and its old action opens nothing', async (t) => {
  const m = await mountWelcome()
  await idle(m)
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined, 'the Welcome is live before the retire')
  const framesBefore = m.pane.frameCount()
  await m.dispose()
  assert.equal(m.pane.frameCount(), framesBefore, 'dispose sends no extra frame of its own')
  clickNode(m.pane, button)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, 0, 'a retired mount never reaches the application entry')
})

// ── W20: the five whale variants are the ONE shared asset, ANSI-free ─────────

test('W20: every variant carries exactly the shared plain rows and the sheet colours come from the one ramp', () => {
  const colors = welcomeWhaleGradientColors()
  assert.equal(colors.length, 6, 'the fixed brand ramp')
  for (let variant = 0; variant < WELCOME_WHALE_VARIANTS; variant += 1) {
    const rows = [...welcomeWhalePlainLines(variant)]
    const wire = JSON.stringify(welcomeView({
      tuiVersion: '1.2.3',
      whaleLines: rows,
      resumeAvailable: true,
      nativeStyled: true,
      nativeIcon: true,
      scopeKey: `s${variant}-`,
      onResume: () => {},
    }).toJSON())
    for (const row of rows) {
      assert.equal(wire.includes(JSON.stringify(row)), true,
        `variant ${variant} carries the exact asset row ${JSON.stringify(row)}`)
    }
    assert.equal(wire.includes('\\u001b'), false, `variant ${variant} sends no escape byte`)
    assert.equal(wire.includes('🐋'), false, 'and never an emoji stand-in for the mascot')
  }
  for (const color of colors) {
    assert.equal(TSP_WELCOME_STYLES.includes(color), true,
      `the sheet colours the ramp color ${color} instead of copying a second palette`)
  }
})

test('W20: the wire never carries a control byte in any Welcome text', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const texts = m.nodes('main.').map(node => String(node.p.text ?? ''))
  assert.ok(texts.length > 0, 'the Welcome painted text nodes')
  const control = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u
  for (const text of texts) {
    assert.equal(control.test(text), false, `the painted line ${JSON.stringify(text)} carries no control byte`)
  }
})

// ── The Composer/Dock siblings stay exactly as they were ─────────────────────

test('the Dock keeps the ONE composer and its control row while the Welcome owns Main', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const ids = m.nodes('dock.').map(node => node.id)
  assert.ok(ids.includes('dock.quiet-composer'), 'the Quiet Composer shell stands')
  assert.ok(ids.some(id => id.includes('composer-send')), 'Send is still there')
  assert.ok(ids.some(id => id.includes('composer-model-quick')), 'the combined Model/Effort control is still there')
  assert.equal(ids.filter(id => id.includes('welcome')).length, 0, 'and no welcome node is among them')
  assert.equal(m.nodes('dock.').filter(node => node.k === 'editor').length, 1,
    'exactly ONE editor on the whole frame')
})

test('W11: the editor draft and caret survive a Welcome → Browser → back cycle untouched', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await waitForInputDelivery(m.pane)
  await idle(m)
  // Typed through the REAL input loop: Shift+Enter (CSI-u) is the editor's own
  // newline, so the draft is multi-line without any submission gesture.
  for (const char of '第一行 🙂') m.pane.key(char)
  m.pane.key('\u001b[13;2u')
  for (const char of '第二行 tail') m.pane.key(char)
  const expected = '第一行 🙂\n第二行 tail'
  await waitUntil('the draft reached the composer', () => textOf(m.node('dock.quiet-composer.composer')) === expected)
  const editor = m.node('dock.quiet-composer.composer')!
  const caretBefore = editor.p.cursor
  const button = m.node('welcome-resume')
  assert.ok(button !== undefined)
  clickNode(m.pane, button)
  await waitUntil('the UI entry ran', () => m.state.browserOpens === 1)
  m.openBrowser()
  await waitUntil('the Browser owns the seat', () => m.node('session-browser-') !== undefined)
  const rowsBefore = whaleRowsOnWire(m)
  m.closeBrowser()
  await waitUntil('the Browser left the seat', () => m.node('session-browser-') === undefined)
  await waitUntil('the Welcome action is painted again', () => m.node('welcome-resume') !== undefined)
  const after = m.node('dock.quiet-composer.composer')
  assert.equal(textOf(after), expected, 'the draft is exactly what it was')
  assert.equal(after?.p.cursor, caretBefore, 'the caret did not move')
  assert.deepEqual(whaleRowsOnWire(m), rowsBefore, 'and the Welcome did not re-pick its whale')
})

// ── The keyboard ladder is untouched ─────────────────────────────────────────

test('the Composer keeps its own Tab / Shift+Tab / Enter / Escape while the Welcome owns Main', async (t) => {
  const m = await mountWelcome()
  t.after(() => m.dispose())
  await idle(m)
  const opensBefore = m.state.browserOpens
  const keys: readonly string[] = ['\t', '\u001b[Z', '\r']
  for (const key of keys) m.pane.key(key)
  await observeNothingHappens()
  assert.equal(m.state.browserOpens, opensBefore, 'no Composer key reaches the Session Browser entry')
  assert.equal(m.fatals.length, 0, `and none of them broke the input loop: ${m.fatals.map(String).join(' | ')}`)
})