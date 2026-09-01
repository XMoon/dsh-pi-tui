/**
 * Autocomplete active-screen repaint regressions (the 2026-08 fix plan):
 * an ASYNC autocomplete commit must repaint the CURRENTLY ACTIVE screen —
 * never the screen the editor happened to be constructed with. In
 * fullscreen the main screen is STOPPED, so a commit routed there leaves a
 * hidden-but-active dropdown (state open, surface stale): Tab then accepts
 * an item the user can not see. These tests read the ACTUAL rendered
 * surface (VirtualTerminal viewport), never `isShowingAutocomplete()` as a
 * visibility proof, and never guess provider timing with sleeps — every
 * wait polls a rendered condition.
 *
 * Layer discipline (plan §8.4): the provider's recursive fuzzy matches put
 * child paths into FIRST-level dropdowns too, so a bare substring check
 * can pass on a stale pre-accept frame. Every post-accept assertion is
 * therefore anchored on the RENDERED draft (`❯ @src/` — the trailing slash
 * only exists on a frame painted after the accept), which makes a stale
 * first-layer frame unable to satisfy the predicate.
 * @module @xmoon76/dsh-pi-tui/autocomplete-active-screen-repaint.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { testLifecycle, type TestLifecycle } from './support/temp-lifecycle.ts'

/** Poll until the predicate is true (asserts after a 3s deadline). */
async function pollUntil(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) assert.fail(`${label}: condition never became true`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** The LIVE autocomplete state of the app's host editor (the seat's
 * capability seam — paired with viewport reads, never a substitute). */
function isAutocompleteActive(app: import('../src/tui-app.ts').TuiApp): boolean {
  return (app.seatEditorForTest() as { isShowingAutocomplete?: () => boolean }).isShowingAutocomplete?.() === true
}

/** A root whose `src/` has THREE children (never single-result auto-apply)
 * and a DISTINCT sibling subtree, so first-layer content is recognizable. */
function dirFixture(life: TestLifecycle): string {
  const root = life.tempDir('dsh-ac-repaint-')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'alpha.ts'), 'x')
  writeFileSync(join(root, 'src', 'beta.ts'), 'x')
  writeFileSync(join(root, 'src', 'gamma.ts'), 'x')
  mkdirSync(join(root, 'other-root'))
  writeFileSync(join(root, 'other-root', 'zeta.ts'), 'x')
  return root
}

function activeScreenForTest(app: import('../src/tui-app.ts').TuiApp): { fullRedraws: number } {
  const host = app as unknown as { fullscreen?: { fullRedraws: number } | undefined; tui: { fullRedraws: number } }
  return (host.fullscreen ?? host.tui)
}

/** The rendered-viewport view of the editor draft: present, with the draft
 * exactly as given, on a frame painted at draft-edit time. */
function draftVisible(view: string, draft: string): boolean {
  return view.includes(`❯ ${draft}`)
}

function childrenVisible(view: string): boolean {
  return view.includes('alpha.ts') && view.includes('beta.ts') && view.includes('gamma.ts')
}

// ── @ mention: directory accept must repaint the children dropdown ──────────

test('fullscreen: accepting an @ directory repaints the children dropdown on the alt screen', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('@src')
  // The '@src'-query frame: full draft rendered AND the directory item
  // visible (an intermediate '@s'/'@sr' frame fails the draft anchor).
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src') && view.includes('src/')
  }, 'the first-level dropdown must be visible in fullscreen')
  assert.equal(isAutocompleteActive(app), true, '@src must open the dropdown')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '@src/', 'Tab must accept the directory')
  assert.equal(app.seatTextForTest(), '@src/', 'Tab must accept the directory')
  // NO further keystrokes: the async children commit must repaint the
  // fullscreen BY ITSELF. The draft anchor (❯ @src/) excludes the stale
  // pre-accept frame, whose recursive matches also contain the children.
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the children dropdown must be VISIBLE on the fullscreen surface after accepting a directory')
  assert.equal(isAutocompleteActive(app), true, 'the children dropdown stays active')
})

test('regular: accepting an @ directory repaints the children dropdown', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('@src')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src') && view.includes('src/')
  }, 'the first-level dropdown must be visible')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '@src/', 'Tab must accept the directory')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the children dropdown must be visible on the regular surface')
})

test('fullscreen: Tab on the visible children dropdown accepts the highlighted child', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('@src')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src') && view.includes('src/')
  }, 'the first-level dropdown must be visible')
  vt.sendInput('\t')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the children dropdown must be visible before Tab')
  // The dropdown is VISIBLE: Tab accepts the highlighted item — never an
  // invisible state's default. The accepted draft must itself paint.
  vt.sendInput('\t')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/alpha.ts')
  }, 'Tab must accept the visible highlighted child and paint it')
  assert.ok(app.seatTextForTest().startsWith('@src/alpha.ts'), `accepted draft: ${app.seatTextForTest()}`)
})

test('fullscreen: a filter keystroke updates the visible dropdown without forced full redraws', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('@src/')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the children dropdown must be visible')
  const fullRedrawsBefore = activeScreenForTest(app).fullRedraws
  vt.sendInput('b')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/b') && view.includes('beta.ts') && !view.includes('alpha.ts')
  }, 'the filter keystroke must narrow the visible dropdown to beta.ts')
  // The commit already repaints through the active-screen routing: the old
  // per-keystroke forced-full-redraw bridge must stay gone (render churn
  // must not regress).
  assert.equal(activeScreenForTest(app).fullRedraws, fullRedrawsBefore, 'a dropdown update must not force a full redraw')
})

// ── /image path argument: same lifecycle through the other trigger ──────────

test('fullscreen: accepting a /image directory repaints the children dropdown on the alt screen', async (t) => {
  const life = testLifecycle(t)
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startImageApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('/image src')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/image src') && view.includes('src/')
  }, 'the src argument candidate must be visible')
  assert.equal(isAutocompleteActive(app), true, '/image src must open the dropdown')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '/image src/', 'Tab must accept the directory')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/image src/') && childrenVisible(view)
  }, 'the children dropdown must be VISIBLE on the fullscreen surface after accepting a directory')
})

test('regular: accepting a /image directory repaints the children dropdown', async (t) => {
  const life = testLifecycle(t)
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startImageApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('/image src')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/image src') && view.includes('src/')
  }, 'the src argument candidate must be visible')
  vt.sendInput('\t')
  await pollUntil(() => app.seatTextForTest() === '/image src/', 'Tab must accept the directory')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/image src/') && childrenVisible(view)
  }, 'the children dropdown must be visible on the regular surface')
})

// ── screen switches with a completion in flight ─────────────────────────────

test('regular -> fullscreen while a completion is in flight: children repaint on the NEW active screen', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  // The request enters its 20ms debounce + async discovery HERE; the switch
  // happens synchronously in the same tick, long before the commit.
  vt.sendInput('@src/')
  app.setFullscreen(true)
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the in-flight commit must repaint the fullscreen it lands under')
})

test('fullscreen -> regular while a completion is in flight: children repaint on the NEW active screen', async (t) => {
  const life = testLifecycle(t)
  const { startApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  vt.sendInput('@src/')
  app.setFullscreen(false)
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '@src/') && childrenVisible(view)
  }, 'the in-flight commit must repaint the regular screen it lands under')
})

// ── the fast slash-command path must survive without the old microtask bridge

test('fullscreen: async slash-command suggestions paint the fresh list', async (t) => {
  const life = testLifecycle(t)
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startImageApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  app.setFullscreen(true)
  await vt.waitForRender()
  // The suggestion resolution lands AFTER the keystroke's own frame: the
  // commit itself must trigger the repaint (the removed double-microtask
  // bridge used to be the only thing painting this).
  vt.sendInput('/im')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/im') && view.includes('Attach an image file')
  }, 'the fresh command dropdown must be visible in fullscreen')
  assert.equal(isAutocompleteActive(app), true, 'the command dropdown stays active')
})

test('regular: async slash-command suggestions paint the fresh list', async (t) => {
  const life = testLifecycle(t)
  const { startImageApp } = await import('./support/app-harness.ts')
  const root = dirFixture(life)
  const { vt, app } = startImageApp(root)
  life.defer(() => app.stop())
  await vt.waitForRender()
  vt.sendInput('/im')
  await pollUntil(() => {
    const view = vt.getViewport().join('\n')
    return draftVisible(view, '/im') && view.includes('Attach an image file')
  }, 'the fresh command dropdown must be visible')
})
