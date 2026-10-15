/** A persisted main Session from the real Direct Reader reaches the production TSP Browser. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import test from 'node:test'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { connect } from '@stencil-hq/tern'
import { join } from 'node:path'
import { mountTspRenderer } from '../src/tui/tsp/session.ts'
import { createSessionBrowserReadOwner } from '../src/app/command/session-browser-read.ts'
import { DirectSessionReader } from '../src/runtime/direct/session-direct.ts'
import type { DurableModelSelectionReader } from '../src/runtime/direct/model-selection-direct.ts'
import { createDiag } from '../src/runtime/process/diagnostics.ts'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'
import { createDirectTspFixture, waitFor } from './support/direct-tsp-fixture.ts'
import { pickerNode, pickerProps, sendAction } from './support/tsp-picker-wire.ts'

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

test('REAL_DIRECT_HEADLESS: cross-workspace persisted Fork lineage reaches the production Tree in parent order', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const fixture = await createDirectTspFixture(life, {
    persistedBlankSession: { id: 'blank-live-1' },
  })
  const otherWorkspace = join(fixture.workRoot, 'other-workspace')
  mkdirSync(otherWorkspace, { recursive: true })
  const persistence = fixture.ctx.get('sessionPersistence') as unknown as {
    create(header: unknown, options?: unknown): Promise<{
      flush(options?: unknown): Promise<void>
      close(): Promise<void>
    }>
  }
  const now = Date.now()
  // Persist isolated parentSession/isSeeded headers through the authoritative
  // storage service. The CWD split models imported/legacy cross-workspace lineage,
  // not a live user session or a call to SessionStore.fork().
  for (const header of [
    {
      id: 'lineage-cross-child',
      cwd: otherWorkspace,
      parentSession: 'blank-live-1',
      createdAt: now - 2_000,
      version: SESSION_FORMAT_VERSION,
      isSeeded: true,
    },
    {
      id: 'lineage-return-child',
      cwd: fixture.workRoot,
      parentSession: 'lineage-cross-child',
      createdAt: now - 1_000,
      version: SESSION_FORMAT_VERSION,
      isSeeded: true,
    },
  ]) {
    const handle = await persistence.create(header, { inheritedEventCount: 0 })
    await handle.flush()
    await handle.close()
  }

  const diag = createDiag({ stderrLevel: 'off' })
  let pane: TspPane | undefined
  let renderer: ReturnType<typeof mountTspRenderer> | undefined
  let owner: ReturnType<typeof createSessionBrowserReadOwner> | undefined
  try {
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
    assert.ok(directRows)
    const directById = new Map(directRows.map((entry) => [entry.id, entry]))
    assert.equal(directById.get('blank-live-1')?.cwd, fixture.workRoot)
    assert.equal(directById.get('lineage-cross-child')?.parentSession, 'blank-live-1')
    assert.equal(directById.get('lineage-cross-child')?.cwd, otherWorkspace)
    assert.equal(directById.get('lineage-return-child')?.parentSession, 'lineage-cross-child')
    assert.equal(directById.get('lineage-return-child')?.cwd, fixture.workRoot)

    const browserPane = installTspPane({ sessionBrowser: true })
    pane = browserPane
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
        currentSessionId: 'blank-live-1',
        currentCwd: fixture.workRoot,
        isCurrent: () => true,
      }),
      diag,
      sessionId: () => 'blank-live-1',
    })
    owner.open()
    await waitFor('the Direct parent reaches the TSP Picker', () =>
      (props(browserPane).items as Array<{ readonly id?: string }> | undefined)
        ?.some((item) => item.id === 'session:blank-live-1') === true)
    sendAction(browserPane, 'scope', 'all', pickerNode(browserPane, BROWSER)!.id)
    await waitFor('All workspaces includes the cross-workspace Fork child', () =>
      props(browserPane).scope === 'all'
      && (props(browserPane).items as Array<{ readonly id?: string }> | undefined)
        ?.some((item) => item.id === 'session:lineage-return-child') === true)

    const items = props(browserPane).items as Array<Record<string, unknown>>
    const ids = items.map((item) => item.id)
    const lineageIds = ['session:blank-live-1', 'session:lineage-cross-child', 'session:lineage-return-child']
    const positions = lineageIds.map((id) => ids.indexOf(id))
    assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!, 'the production Picker preserves parent-before-child order')
    assert.deepEqual(positions.map((index) => items[index]?.depth), [0, 1, 2])
    assert.deepEqual(props(browserPane).order, ids, 'the current production order does not regroup workspace rows')
  } finally {
    owner?.dispose()
    diag.dispose()
    await renderer?.dispose()
    pane?.restore()
    await fixture.settle()
  }
})
