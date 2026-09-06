/**
 * Active-screen regressions for the file-completion marquee. The host editor
 * must render selected overflowing `@`, `/attach`, and `/image` paths through
 * the routed TUI, so a timer repaint reaches fullscreen's visible screen rather
 * than the stopped screen captured at editor construction time.
 * @module @xmoon76/dsh-pi-tui/autocomplete-marquee-active-screen.test
 */

import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startImageApp } from './support/app-harness.ts'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'
import type { TuiApp } from '../src/tui-app.ts'
import type { VirtualTerminal } from './virtual-terminal.ts'

const startedApps = new Set<TuiApp>()
afterEach(() => {
  for (const app of [...startedApps]) {
    startedApps.delete(app)
    if (app.isDisposed()) continue
    try { app.dispose() } catch {}
  }
})

/** Two long candidates make explicit Tab open the list instead of applying a
 * single result, while their full display paths overflow the editor row. */
function marqueeFixture(life: TestLifecycle): string {
  const root = life.tempDir('dsh-ac-marquee-')
  mkdirSync(join(root, 'src', 'file-completion'), { recursive: true })
  const stem = 'very-long-file-completion-path-'.repeat(4)
  writeFileSync(join(root, 'src', 'file-completion', `${stem}alpha.ts`), 'x')
  writeFileSync(join(root, 'src', 'file-completion', `${stem}beta.ts`), 'x')
  return root
}

function isAutocompleteActive(app: TuiApp): boolean {
  return app.seatEditorForTest().isShowingAutocomplete?.() === true
}

/** Clear the current cycle before the synchronous render probe below. The
 * production path resets this through render lifecycle; the test only uses the
 * private instance to avoid waiting for the provider's already-rendered frame. */
function resetFileMarqueeForTest(app: TuiApp): void {
  const host = app as unknown as { editor: { fileCompletionMarquee: { reset(): void } } }
  host.editor.fileCompletionMarquee.reset()
}

async function flushTerminal(vt: VirtualTerminal): Promise<void> {
  await new Promise<void>(resolve => process.nextTick(resolve))
  await vt.flush()
}

async function pollImmediate(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) assert.fail(`${label}: condition never became true`)
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

function selectedAutocompleteRow(view: string, label: string): string {
  const row = view.split('\n').find(line => line.includes('→ '))
  if (row === undefined) assert.fail(`${label}: selected autocomplete row missing:\n${view}`)
  return row
}

type CapturedTimer = {
  readonly delay: number
  cancelled: boolean
  fire(): void
  unref(): void
}

/** Capture only the marquee's phase timers for one synchronous render pass.
 * The real scheduler remains in place for every other timer, so this fake is
 * local to the render call and cannot interfere with parallel test files. */
function captureMarqueeTimers(run: () => void): CapturedTimer[] {
  const timers: CapturedTimer[] = []
  const captured = new Set<CapturedTimer>()
  const realSetTimeout = globalThis.setTimeout
  const realClearTimeout = globalThis.clearTimeout
  const replacementSetTimeout = ((handler: unknown, delay?: number, ...args: unknown[]) => {
    if ((delay === 800 || delay === 250) && typeof handler === 'function') {
      const timer: CapturedTimer = {
        delay,
        cancelled: false,
        fire: () => {
          if (timer.cancelled) return
          timer.cancelled = true
          Reflect.apply(handler as (...callbackArgs: unknown[]) => void, undefined, args)
        },
        unref: () => {},
      }
      timers.push(timer)
      captured.add(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    }
    return Reflect.apply(realSetTimeout, globalThis, [handler, delay, ...args]) as ReturnType<typeof setTimeout>
  }) as unknown as typeof setTimeout
  const replacementClearTimeout = ((handle: unknown) => {
    const timer = handle as CapturedTimer
    if (captured.has(timer)) {
      timer.cancelled = true
      return
    }
    Reflect.apply(realClearTimeout, globalThis, [handle])
  }) as unknown as typeof clearTimeout

  globalThis.setTimeout = replacementSetTimeout
  globalThis.clearTimeout = replacementClearTimeout
  try {
    run()
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
  return timers
}

interface TestScreen {
  readonly fullRedraws: number
  renderNow(force?: boolean): void
}

function activeScreenForTest(app: TuiApp): TestScreen {
  const host = app as unknown as { fullscreen?: TestScreen; tui: TestScreen }
  return host.fullscreen ?? host.tui
}

async function assertMarqueeShift(
  vt: VirtualTerminal,
  app: TuiApp,
  screen: TestScreen,
  draft: string,
  marqueeNow: { value: number },
  label: string,
): Promise<void> {
  app.setEditorText(draft)
  vt.sendInput('\t')
  await pollImmediate(() => isAutocompleteActive(app), `${label}: dropdown must open`)
  resetFileMarqueeForTest(app)

  const initialTimers = captureMarqueeTimers(() => screen.renderNow(true))
  const initialTimer = initialTimers.find(timer => timer.delay === 800)
  await flushTerminal(vt)
  assert.ok(initialTimer !== undefined, `${label}: initial marquee timer must be armed`)
  const initial = selectedAutocompleteRow(vt.getViewport().join('\n'), `${label} initial`)
  assert.ok(initial.includes('src/file-completion'), `${label}: the full path must be the primary row`)
  assert.ok(!initial.includes('…'), `${label}: selected overflow must use the marquee window, not ellipsis`)

  // Move the injected marquee clock past the initial pause and invoke the
  // captured phase timer. The timer callback alone requests a repaint; the
  // active screen's normal render cycle must produce the shifted row.
  marqueeNow.value += 1_050
  initialTimer.fire()
  await vt.waitForRender()
  const shifted = selectedAutocompleteRow(vt.getViewport().join('\n'), `${label} shifted`)
  assert.notEqual(shifted, initial, `${label}: the selected row must move after the first step`)
}

type MarqueeSurface = {
  vt: VirtualTerminal
  app: TuiApp
  screen: TestScreen
}

async function startFullscreen(
  life: TestLifecycle,
  root: string,
  commandName: 'image' | 'attach',
  marqueeNow: { value: number },
): Promise<MarqueeSurface> {
  // SelectedMarquee captures Date.now during editor construction. Keep that
  // captured clock independently controllable while the rest of the app uses
  // the real clock; the fake scheduler below invokes the captured callbacks.
  const realDateNow = Date.now
  Date.now = () => marqueeNow.value
  let surface: ReturnType<typeof startImageApp>
  try {
    surface = startImageApp(root, commandName)
  } finally {
    Date.now = realDateNow
  }
  const { vt, app } = surface
  startedApps.add(app)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  return { vt, app, screen: activeScreenForTest(app) }
}

function marqueeDeadline(app: TuiApp): number {
  const host = app as unknown as { editor: { fileCompletionMarquee: { pendingTimerDeadlineForTest(): number } } }
  return host.editor.fileCompletionMarquee.pendingTimerDeadlineForTest()
}

test('fullscreen: selected @ file rows marquee on the active alt screen', async (t) => {
  const life = testLifecycle(t)
  const root = marqueeFixture(life)
  const marqueeNow = { value: 0 }
  const { vt, app, screen } = await startFullscreen(life, root, 'image', marqueeNow)
  const mainScreen = (app as unknown as { tui: TestScreen }).tui
  const mainRedrawsBefore = mainScreen.fullRedraws

  await assertMarqueeShift(
    vt,
    app,
    screen,
    '@src/file-completion/very-long-file-completion-path-',
    marqueeNow,
    '@ mention',
  )
  vt.sendInput('\x1b')
  await pollImmediate(() => !isAutocompleteActive(app), '@ mention: dropdown must close')
  await vt.waitForRender()
  assert.equal(marqueeDeadline(app), -1, 'closing the dropdown must reset the file marquee')
  assert.equal(mainScreen.fullRedraws, mainRedrawsBefore, 'the stopped main screen must not receive the timer repaint')
})

test('fullscreen: selected /attach rows marquee on the active alt screen', async (t) => {
  const life = testLifecycle(t)
  const root = marqueeFixture(life)
  const marqueeNow = { value: 0 }
  const { vt, app, screen } = await startFullscreen(life, root, 'attach', marqueeNow)

  await assertMarqueeShift(
    vt,
    app,
    screen,
    '/attach src/file-completion/very-long-file-completion-path-',
    marqueeNow,
    '/attach path argument',
  )
  vt.sendInput('\x1b')
  await pollImmediate(() => !isAutocompleteActive(app), '/attach: dropdown must close')
  await vt.waitForRender()
  assert.equal(marqueeDeadline(app), -1, '/attach close must reset the file marquee')
})

test('fullscreen: selected /image rows marquee on the active alt screen', async (t) => {
  const life = testLifecycle(t)
  const root = marqueeFixture(life)
  const marqueeNow = { value: 0 }
  const { vt, app, screen } = await startFullscreen(life, root, 'image', marqueeNow)

  await assertMarqueeShift(
    vt,
    app,
    screen,
    '/image src/file-completion/very-long-file-completion-path-',
    marqueeNow,
    '/image path argument',
  )
  vt.sendInput('\x1b')
  await pollImmediate(() => !isAutocompleteActive(app), '/image: dropdown must close')
  await vt.waitForRender()
  assert.equal(marqueeDeadline(app), -1, '/image close must reset the file marquee')
})
