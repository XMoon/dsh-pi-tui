/** A persisted main Session from the real Direct Reader reaches the production TSP Browser. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { connect } from '@stencil-hq/tern'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { createSessionBrowserReadOwner } from '../src/app/command/session-browser-read.ts'
import { DirectSessionReader } from '../src/runtime/direct/session-direct.ts'
import type { DurableModelSelectionReader } from '../src/runtime/direct/model-selection-direct.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import { pickerNode, pickerProps } from './support/tsp-picker-wire.ts'

const BROWSER = 'session-browser-'
const props = (pane: TspPane): Record<string, unknown> => pickerProps(pane, BROWSER)

test('REAL_DIRECT_HEADLESS: persisted main Session → DirectSessionReader → production TSP Presenter', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    persistedBlankSession: { id: 'blank-live-1' },
  })
  const diag = createDiag({ stderrLevel: 'off' })
  let pane: TspPane | undefined
  let renderer: ReturnType<typeof mountTspRenderer> | undefined
  let owner: ReturnType<typeof createSessionBrowserReadOwner> | undefined
  try {
    await waitFor('the Direct runner owns its TSP pane', () => fixture.pane.output.text().includes('dock.composer'))
    // The Browser is mounted without resuming the persisted row: this exercises
    // the cold, released main Session exactly as DirectSessionReader exposes it.
    const browserPane = installTspPane({ sessionBrowser: true })
    pane = browserPane
    const directReader = new DirectSessionReader(
      fixture.ctx,
      undefined,
      {
        durableProjectionForSession: (): ReturnType<DurableModelSelectionReader['durableProjectionForSession']> => ({
          lastUsed: null,
          next: null,
        }),
      },
    )
    const directRows = await directReader.list(undefined)
    assert.ok(directRows?.some((entry) => entry.id === 'blank-live-1'),
      'the official Direct semantic list contains the main Session materialized by persistence')

    const session = await connect({ timeout: 500, exitHooks: false })
    assert.ok(session)
    renderer = mountTspRenderer(session, { requestExit() {}, onFatal: (error) => assert.fail(String(error)) })
    renderer.bindInput({
      exit() {},
      cancel() {},
      submit: () => assert.fail('the read-only Browser must not submit'),
      steer() {},
      noteUserInput() {},
      listContinuedQuestions: () => [],
      reopenContinuedQuestion: () => false,
    })
    const browserPresentation = renderer.sessionBrowserPresentation
    assert.ok(browserPresentation)
    owner = createSessionBrowserReadOwner({
      reader: directReader,
      presentation: browserPresentation,
      captureSubject: () => ({
        currentSessionId: undefined,
        currentCwd: fixture.workRoot,
        isCurrent: () => true,
      }),
      diag,
      sessionId: () => 'blank-live-1',
    })
    owner.open()
    await waitFor('the persisted Direct row reaches the TSP picker', () =>
      (props(browserPane).items as Array<{ readonly id?: string }> | undefined)
        ?.some((item) => item.id === 'session:blank-live-1') === true)
    assert.equal(pickerNode(browserPane, BROWSER)?.p.selected, 'session:blank-live-1')
    assert.deepEqual(pickerNode(browserPane, BROWSER)?.p.current, [], 'the read-only sessionless Browser does not invent a Current marker')
    assert.equal(props(browserPane).layout, 'tree')
    assert.equal(props(browserPane).scope, 'workspace')
  } finally {
    owner?.dispose()
    diag.dispose()
    await renderer?.dispose()
    pane?.restore()
    await fixture.settle()
  }
})
