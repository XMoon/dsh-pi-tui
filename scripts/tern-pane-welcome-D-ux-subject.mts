/**
 * TSP-7 Welcome D: the production renderer inside a REAL Tern window/pane.
 *
 * It mounts the PRODUCTION `mountTspRenderer` over the shipped SDK `connect()`
 * inside a live Tern pane, and commits every fact through the real application
 * display seam (`SurfaceDisplaySeam`): the formal idle invitation, the blank
 * main subject's `setTranscript(..., 'blank-session')` commit, the started-turn
 * commit, the atomic status commit that carries `host.tuiVersion`, and the ONE
 * Session Browser presentation the mount itself publishes.
 *
 * Cases (the flow writes `${TERN_PANE_DIR}/case`):
 * - `idle`          — sessionless start: the application's formal idle invitation
 * - `blank`         — a blank MAIN subject committed by the display seam
 * - `turn`          — the first formal message: the transcript owns Main
 * - `draft`         — the idle invitation with a staged multi-line non-BMP draft
 * - `unavailable`   — the `/sessions` business entry does not exist (disabled form)
 *
 * Stand-ins (declared, never silently widened):
 * - the `TspInputHandlers` application entries (submit/steer/cancel/…): this
 *   subject is a PRESENTER lane, not the submission lane; the writer owns that
 * - the Session Browser READ: `openSessionBrowser` opens the mount's REAL
 *   `sessionBrowserPresentation` with a fixed snapshot instead of the Host
 *   reader, so the flow observes the production presenter, not a fake one
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { emptyStatusSnapshot } from '../src/domain/status/types.ts'
import type { StatusSnapshot } from '../src/domain/status/types.ts'
import type { SessionBrowserPanelHandle, SessionBrowserReadSnapshot } from '../src/app/command/session-browser-presentation.ts'
import { WELCOME_WHALE_VARIANTS, welcomeWhaleGradientColors, welcomeWhalePlainLines } from '../src/tui/components/welcome-whale.ts'
import { welcomeView, TSP_WELCOME_SHEET, TSP_WELCOME_STYLES } from '../src/tui/tsp/welcome-view.ts'

const dir = process.env.TERN_PANE_DIR
if (dir === undefined) throw new Error('TERN_PANE_DIR is required by the real Tern subject')
mkdirSync(dir, { recursive: true })
const note = (value: unknown): void => { appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(value)}\n`) }
const testCase = ((existsSync(join(dir, 'case')) ? readFileSync(join(dir, 'case'), 'utf8').trim() : '')
  || process.env.TERN_TSP7_WELCD_CASE || 'idle')

const session = await connect({ app: `welcome-D-${testCase}`, timeout: 3000 })
if (session === null) throw new Error('this subject must run inside a real Tern pane')
note({ kind: 'caps', case: testCase, kinds: session.caps.kinds, features: session.caps.features, cols: session.caps.cols })

// The attribution the flow needs to identify the painted mascot WITHOUT a
// second copy of the asset: the production module's own rows and ramp.
writeFileSync(join(dir, 'whale-assets.json'), JSON.stringify({
  variants: Array.from({ length: WELCOME_WHALE_VARIANTS }, (_, variant) => [...welcomeWhalePlainLines(variant)]),
  ramp: [...welcomeWhaleGradientColors()],
}))

const VERSION = '9.7.6-welcome-D'
let current = {
  ...emptyStatusSnapshot(),
  host: { tuiVersion: VERSION },
  workspace: { cwd: '/workspaces/welcome-D', branch: 'feat/tern-tsp7-welcome-d' },
} as StatusSnapshot

const calls = { browserOpens: 0, submits: [] as string[] }
const renderer = mountTspRenderer(session, {
  copyVisual: async () => false,
  requestExit: () => { note({ kind: 'requestExit' }); void shutdown('requestExit') },
  onFatal: (error) => { note({ kind: 'fatal', error: String(error) }) },
})

const browserRows = [{
  id: 'welcome-D-target',
  updatedAt: Date.now(),
  createdAt: Date.now() - 60_000,
  cwd: '/workspaces/welcome-D',
  live: false,
  title: 'Welcome D resume target',
}]

/** The fixed read snapshot the production presenter paints. */
const browserSnapshot: SessionBrowserReadSnapshot = {
  listState: 'ready',
  rows: browserRows,
  query: '',
  resumePending: false,
  searchState: 'idle',
  searchResults: [],
  hasMore: false,
}

let browserHandle: SessionBrowserPanelHandle | undefined

renderer.bindInput({
  exit: () => { void shutdown('exit') },
  cancel: () => { note({ kind: 'cancel' }) },
  submit: (text, request) => { calls.submits.push(text); note({ kind: 'submit', text, gesture: String(request) }) },
  steer: (text) => { note({ kind: 'steer', text }) },
  pasteMedia: () => { note({ kind: 'pasteMedia' }) },
  noteUserInput: () => {},
  listContinuedQuestions: () => [],
  reopenContinuedQuestion: () => false,
  openModelPicker: () => { note({ kind: 'modelPicker' }) },
  openModelQuick: () => { note({ kind: 'modelQuick' }) },
  sessionBrowserAvailable: () => testCase !== 'unavailable',
  openSessionBrowser: () => {
    calls.browserOpens += 1
    const presentation = renderer.sessionBrowserPresentation
    note({ kind: 'openSessionBrowser', reach: calls.browserOpens, presenter: presentation !== undefined })
    if (presentation === undefined) return
    // The PRODUCTION presenter, the production panel handle and the production
    // snapshot shape — only the Host read is replaced by the fixed snapshot.
    if (browserHandle !== undefined && !browserHandle.isDisposed()) {
      note({ kind: 'browserAlreadyOpen', reach: calls.browserOpens })
      return
    }
    browserHandle = presentation.open({
      subject: { currentSessionId: 'welcome-D-current', currentCwd: '/workspaces/welcome-D', isCurrent: () => true },
      onQueryChange: () => {},
      onResumeIntent: (intent) => { note({ kind: 'resumeIntent', sessionId: intent.sessionId, source: intent.source }) },
      onClose: () => { note({ kind: 'browserClose' }); browserHandle = undefined },
    })
    browserHandle.setSnapshot(browserSnapshot)
  },
})

const draftText = testCase === 'draft' ? '第一行 🙂 emoji\n第二行 carrying a non-BMP caret\nand a tail' : ''

renderer.bindStatusReader({ snapshot: () => current })
renderer.display.commitDisplaySubject({}, {}, undefined)
if (draftText !== '') renderer.composer.setDraft(draftText)

/**
 * The `variants` case is a MEASUREMENT surface, not the product mount: the
 * mascot is picked ONCE per real mount, so the only way to lay out all five
 * variants in the real client is to paint the PRODUCTION view module for each of
 * them through the PRODUCTION sheet on a second inline surface. It calls no
 * application seam and owns no business state; the claim it carries is exactly
 * "the production Welcome view, every variant, this client's layout".
 */
if (testCase === 'variants') {
  const measure = session.open({ mode: 'inline', title: 'dsh-welcome-measure' })
  measure.stylesheet(TSP_WELCOME_SHEET, TSP_WELCOME_STYLES)
  // A per-variant handshake: the sweep may only advance when the flow has
  // captured the frame it is looking at, so no variant is ever raced past.
  const ackPath = join(dir, 'ack.txt')
  const readAck = () => {
    try {
      return readFileSync(ackPath, 'utf8').trim()
    } catch {
      return ''
    }
  }
  for (let variant = 0; variant < WELCOME_WHALE_VARIANTS; variant += 1) {
    writeFileSync(join(dir, 'variant.txt'), String(variant))
    measure.render({
      main: welcomeView({
        tuiVersion: VERSION,
        whaleLines: welcomeWhalePlainLines(variant),
        resumeAvailable: true,
        nativeStyled: true,
        scopeKey: `m${variant}-`,
        onResume: () => {},
      }),
    })
    note({ kind: 'variant', variant, rows: [...welcomeWhalePlainLines(variant)] })
    const deadline = Date.now() + 120_000
    while (readAck() !== String(variant)) {
      if (Date.now() >= deadline) throw new Error(`the Welcome variant sweep never acknowledged variant ${variant}`)
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  writeFileSync(join(dir, 'variant.txt'), 'done')
  await exitKeepingSurface()
}

async function exitKeepingSurface(): Promise<void> {
  await new Promise<void>(resolve => {
    process.once('SIGTERM', () => resolve())
    process.once('SIGINT', () => resolve())
  })
  await renderer.dispose()
  await session.close()
  process.exit(0)
}

if (testCase === 'turn') {
  // The started subject: the transcript owns Main, the invitation is gone.
  renderer.display.setTranscript(
    [
      { kind: 'user', turn: 1, text: 'Run the focused tests.' },
      { kind: 'assistant', turn: 1, text: 'Running them now.' },
    ] as never,
    undefined,
    { mode: 'latest' } as never,
    [],
    undefined,
    {},
    'hidden',
  )
} else if (testCase === 'blank') {
  // The blank MAIN subject, committed exactly the way SurfaceRuntime repaints it.
  renderer.display.setTranscript([] as never, undefined, { mode: 'latest' } as never, [], undefined, {}, 'blank-session')
} else {
  // `idle`, `draft` and `unavailable`: the application's formal idle commit.
  renderer.display.setWelcomeIdle(true)
}

note({ kind: 'ready', case: testCase, browserOpens: calls.browserOpens })

async function shutdown(reason: string): Promise<void> {
  note({ kind: 'shutdown', reason })
  await renderer.dispose()
  await session.close()
  process.exit(0)
}

await new Promise<void>((resolve) => {
  process.once('SIGTERM', () => { void shutdown('SIGTERM').then(resolve) })
  process.once('SIGINT', () => { void shutdown('SIGINT').then(resolve) })
})
