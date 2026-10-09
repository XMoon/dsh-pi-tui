/**
 * PR3-B B2 interactive runner tests.
 *
 * Everything here runs the REAL composition root (`mountRunner` → `applyRunner`
 * → `startRunner`) with the TSP opt-in over the scripted pane installed as the
 * process tty: the shipped SDK connect, `productionTspConnector`,
 * `selectRendererMount`, `SurfaceRuntime`, the real `SubmissionController` and
 * the Direct Host services all execute for real. Only the tty boundary and the
 * Host stand-in services (the harness's in-memory registry, the recorder shell
 * executor) are simulated — no hand-built business state.
 *
 * The chain under test for a submission is:
 *
 *     SDK key bytes → the ONE TSP input loop → the composer (clear BEFORE the
 *     callback) → handlers.submit → ApplicationEvents.onSubmit → the existing
 *     SubmissionController → the semantic writer/refusals
 *
 * @module @xmoon76/dsh-pi-tui/tern-tsp-runner-interactive.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { installTspPane, type TspPane } from './support/tsp-terminal-fixture.ts'

async function waitUntil(label: string, predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function settle(millis = 600): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, millis))
}

interface Owned {
  readonly pane: TspPane
  readonly settle: () => Promise<void>
}

/** Mount the REAL runner with the TSP opt-in over the scripted pane. */
async function ownTspBoot(options: {
  readonly life: import('./support/temp-lifecycle.ts').TestLifecycle
  readonly home: string
  readonly logFile: string
  readonly session?: { readonly id: string }
  readonly provide?: (ctx: { provide(name: string, value: unknown): void }) => unknown
  readonly shell?: unknown
  readonly appExit?: () => void
}): Promise<Owned> {
  const life = options.life
  const { makeHarness, mountRunner, disposeContext } = await import('./support/runner-harness.ts')
  const pane = installTspPane()
  const { Context } = await import('@deepseek-ai/cordis')
  const ctx = new Context()
  options.provide?.(ctx)
  process.env.DSH_PI_TUI_RENDERER = 'tsp'
  process.env.DSH_PI_TUI_LOG = options.logFile
  const harness = makeHarness(options.home, options.session as never)
  if (options.shell !== undefined) (harness as { shell?: unknown }).shell = options.shell
  let fiber: { dispose(): Promise<void> } | undefined
  let settlement: Promise<void> | undefined
  const settleAll = (): Promise<void> => {
    settlement ??= (async () => {
      pane.releaseHandshake()
      try {
        await disposeContext(ctx)
        await fiber?.dispose()
      } finally {
        pane.restore()
      }
    })()
    return settlement
  }
  life.defer(() => settleAll())
  fiber = await mountRunner(
    ctx, options.home, harness,
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.session === undefined ? {} : { sessionId: options.session.id },
    options.appExit ?? (() => {}),
  )
  return { pane, settle: settleAll }
}

// ── The TUI-builtin admission on the TSP renderer ────────────────────────────

test('B2: a TUI builtin with PiTui UI is refused on TSP with the draft restored', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  const owned = await ownTspBoot({ life, home, logFile })
  try {
    // `/settings` is a TUI-owned builtin whose implementation is a PiTui panel.
    owned.pane.input.type('/settings')
    await settle()
    owned.pane.input.type('\r')
    await waitUntil('the refusal notice', () => owned.pane.output.text().includes('not available in TSP'))
    const wire = owned.pane.output.text()
    assert.ok(wire.includes('/settings'), 'the refused line is restored into the composer (visible draft)')
  } finally {
    await owned.settle()
  }
})

test('B2: `/exit` is allowed through (the exit pair is the only supported TUI builtin)', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  let exited = false
  const owned = await ownTspBoot({ life, home, logFile, appExit: () => { exited = true } })
  try {
    owned.pane.input.type('/exit')
    await settle()
    owned.pane.input.type('\r')
    await waitUntil('the exit orchestration', () => exited)
    assert.equal(exited, true, '/exit routed the existing exit orchestration')
  } finally {
    await owned.settle()
  }
})

// ── The local user-shell refusal (no Host process, no session, no history) ──

test('B2: `!` is refused before any Host shell run, with the draft restored', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  // A recorder shell executor: the refusal must reach it ZERO times. An
  // absent executor would also "not run", but then a regression that DID call
  // it could crash instead of failing the assertion.
  const shellRuns: string[] = []
  const shell = {
    execute: async (request: { command: string }) => {
      shellRuns.push(request.command)
      return { kind: 'unavailable', reason: new Error('the recorder shell never executes') }
    },
  }
  const owned = await ownTspBoot({ life, home, logFile, shell })
  try {
    owned.pane.input.type('!echo hi')
    await settle()
    owned.pane.input.type('\r')
    await waitUntil('the shell refusal', () => owned.pane.output.text().includes('User-shell UI is not available in TSP'))
    assert.deepEqual(shellRuns, [], 'the Host shell executor was never reached')
    assert.ok(owned.pane.output.text().includes('!echo hi'), 'the refused line is restored into the composer')
  } finally {
    await owned.settle()
  }
})

// ── A plain prompt rides the ONE existing submission path ───────────────────

test('B2: a plain Enter takes the real application submit path and clears the composer', async (t) => {
  const { testLifecycle } = await import('./support/temp-lifecycle.ts')
  const life = testLifecycle(t)
  const home = life.tempDir('pr3b-tsp-interactive-')
  const logFile = join(home, 'diag.log')
  const owned = await ownTspBoot({ life, home, logFile })
  try {
    owned.pane.input.type('hello from the TSP pane')
    await settle()
    assert.ok(owned.pane.output.text().includes('hello from the TSP pane'), 'the typed draft is on the wire')
    owned.pane.input.type('\r')
    await settle(1_200)
    // The renderer cleared the draft BEFORE the callback: whatever the
    // application then does (create a session, admit an image, refuse), the
    // pane must NOT still show the submitted text as live draft content.
    const frames = [...owned.pane.output.text().matchAll(/"id":"dock\.composer"[\s\S]{0,120}?"text":"([^"]*)"/g)]
      .map(match => match[1]!)
    const lastDraft = frames.at(-1)
    assert.equal(lastDraft, '', `the composer was cleared by the submit (last draft ${JSON.stringify(lastDraft)})`)
  } finally {
    await owned.settle()
  }
})
