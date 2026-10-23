/**
 * Phase 3C / C2-A — the Settings workspace ROOT: the category rail, the
 * content focus and the page mount.
 *
 * The root owns the navigation state, the category rail, the direct content
 * column and the pointer map. These cases drive the REAL panel with a
 * controllable page factory, so a case can observe what the root mounts,
 * disposes and refuses — including the reentrancy the root must survive.
 *
 * @module @xmoon76/dsh-pi-tui/settings-workspace-panel.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { stripTerminalSequences } from '@xmoon76/pi-tui'
import {
  SettingsWorkspacePanel,
  type SettingsAuthPage,
  type SettingsWorkspacePanelIntents,
  type SettingsWorkspaceSnapshot,
} from '../../src/tui/panels/settings-workspace-panel.ts'
import type { AboutStatusController } from '../../src/app/command/about-status.ts'
import type { AboutStatusView } from '../../src/domain/status/about.ts'

const SNAPSHOT: SettingsWorkspaceSnapshot = {
  configReadiness: 'ready',
  capturedAt: 0,
  rows: [
    { id: 'theme', category: 'appearance', label: 'Configured theme', summary: 'auto', value: 'auto', scope: 'TUI settings document', freshness: 'ready', description: 'palette', action: 'inspect' },
  ],
}

/** A page that records the root interactions it receives. */
class FakePage implements SettingsAuthPage {
  readonly id: string
  readonly inputs: string[] = []
  disposed = false
  exitOn: string | undefined
  /** Whether the page owns an in-flight Host operation. */
  pending = false

  constructor(id: string) {
    this.id = id
  }

  render(width: number): string[] {
    return [`${this.id} page`.padEnd(Math.max(1, width))]
  }

  invalidate(): void {}
  setBodyHeight(rows: number): void {}
  handleInput(data: string): 'handled' | 'exit' | 'open-account' {
    this.inputs.push(data)
    if (this.exitOn !== undefined && data === this.exitOn) return 'exit'
    return 'handled'
  }
  onCellPress(x: number, y: number): void {}
  onCellClick(): 'handled' | 'exit' | 'open-account' { return 'handled' }
  cancelPointer(): void {}
  pendingMutation(): boolean { return this.pending }
  canYieldFocusToNavigation(): boolean { return true }
  dispose(): void { this.disposed = true }
}

interface Harness {
  readonly panel: SettingsWorkspacePanel
  readonly built: FakePage[]
  /** How many times the workspace asked to close. */
  readonly closes: () => number
}

function setup(options: {
  readonly columns?: number
  readonly rows?: number
  /** Runs while the page factory builds the page (the reentrancy seam). */
  readonly duringBuild?: (harness: { readonly panel: SettingsWorkspacePanel; readonly built: FakePage[] }) => void
  /** C3: the About owner the panel renders/subscribes to. */
  readonly aboutStatusSource?: () => AboutStatusController
  /** C3: the clipboard sink (records what the copy gestures emit). */
  readonly onCopy?: (text: string) => void
} = {}): Harness {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const built: FakePage[] = []
  let closes = 0
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: { tui: '0.5.3', dsh: '0.2.1-rc.2' },
    rows: () => rows,
    columns: () => columns,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => { closes += 1 },
    onOpenLegacy: () => {},
    ...(options.aboutStatusSource === undefined ? {} : { aboutStatusSource: options.aboutStatusSource }),
    onCopy: (text) => { options.onCopy?.(text) },
    createModelsPage: (initial, openAccount) => {
      const page = new FakePage(`models:${initial.view}`)
      built.push(page)
      options.duringBuild?.({ panel: panel!, built })
      // The Models page's account row asks the root to switch.
      ;(page as { openAccount?: () => void }).openAccount = openAccount
      return page
    },
    createAccountPage: (initial) => {
      const page = new FakePage(`account:${initial.view}`)
      built.push(page)
      options.duringBuild?.({ panel: panel!, built })
      return page
    },
  }
  const panel = new SettingsWorkspacePanel({ readSnapshot: () => SNAPSHOT }, intents)
  return { panel, built, closes: () => closes }
}

const plain = (harness: Harness, width = 120): string =>
  harness.panel.render(width).map(stripTerminalSequences).join('\n')

test('the wide rail mounts the selected direct page exactly once', () => {
  const h = setup()
  h.panel.handleInput('\u001b[B') // About -> Models
  assert.equal(h.built.length, 1, 'the rail mounted the Models page once')
  assert.equal(h.built[0]?.id, 'models:list', 'the rail mounted the Models list')
  h.panel.handleInput('\u001b[B') // Models -> Account
  assert.equal(h.built.length, 2, 'the rail mounted the Account page once')
  assert.equal(h.built[1]?.id, 'account:page', 'the rail mounted the Account page')
  assert.equal(h.built[0]?.disposed, true, 'the previous page was disposed on the category change')
})

test('a narrow rail mounts nothing until the content takes the focus', () => {
  const h = setup({ columns: 44, rows: 20 })
  // The narrow first frame is the About CONTENT: Esc returns to the list.
  h.panel.handleInput('\u001b')
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B')
  assert.equal(h.built.length, 0, 'browsing an invisible category mounted no page')
  h.panel.handleInput('\r')
  assert.equal(h.built.length, 1, 'Enter created the page once')
  assert.equal(h.built[0]?.id, 'account:page', 'Enter created the Account page')
})

test('a page built for a superseded selection is disposed instead of mounted', () => {
  // The factory reenters the root and changes the selection BEFORE it
  // returns: the page it built belongs to a category nobody selected.
  let panel: SettingsWorkspacePanel | undefined
  let reentered = false
  const h = setup({
    duringBuild: ({ panel: root }) => {
      panel = root
      if (reentered) return
      reentered = true
      // Reenter the root ONCE: a different category is selected while the
      // factory is still running.
      root.handleInput('\u001b[B')
    },
  })
  h.panel.handleInput('\u001b[B') // About -> Models (the factory reenters here)
  assert.equal(h.built.length, 2, 'the reentrant selection built its own page')
  assert.equal(h.built[0]?.disposed, true, 'the superseded page was disposed')
  assert.equal(h.built[1]?.disposed, false, 'the current page stays mounted')
  assert.ok(panel !== undefined)
})

test('the content focus hands the keyboard to the page, and Esc returns it to the rail', () => {
  const h = setup()
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // Account
  h.panel.handleInput('\r')
  const page = h.built[1]
  assert.ok(page !== undefined)
  assert.deepEqual(page.inputs, [], 'the focus transfer ran no page action')
  h.panel.handleInput('x')
  assert.deepEqual(page.inputs, ['x'], 'the content focus routes the key to the page')
  // The page reports the exit: the root then returns the keyboard to the rail.
  page.exitOn = '\u001b'
  h.panel.handleInput('\u001b')
  assert.deepEqual(page.inputs, ['x', '\u001b'], 'the page owns the Esc first')
  assert.equal(h.built[1]?.disposed, false, 'returning to the rail keeps the page instance')
  assert.match(plain(h), /Settings · Categories/u, 'the rail owns the keyboard again')
})

test('a page that owns a pending Host mutation keeps the keyboard and the lease', () => {
  const h = setup()
  h.panel.handleInput('\u001b[B') // About -> Models
  h.panel.handleInput('\u001b[B') // Models -> Account
  h.panel.handleInput('\r') // the content takes the focus
  const page = h.built[1]
  assert.ok(page !== undefined)
  page.pending = true

  // A rail click on the ALREADY selected category must not take the keyboard
  // away from the page that owns the pending operation. The rail's third entry
  // (Account) is the painted cell the click resolves to; the frame must be
  // painted before the gesture, exactly like a real click.
  plain(h)
  h.panel.onCellPress(2, 5)
  h.panel.onCellClick(2, 5)
  assert.match(plain(h), /Settings · Account/u, 'the focus stayed with the pending page')

  // The page's own exit report (its Back action) must not take the keyboard
  // away either: the page keeps the keyboard until the operation settles.
  page.exitOn = '\u001b'
  h.panel.handleInput('\u001b')
  assert.match(plain(h), /Settings · Account/u, 'the page keeps the keyboard while its operation is in flight')

  // The workspace must not close under the pending operation either.
  h.panel.handleInput('\u001b')
  assert.match(plain(h), /Settings ·/u, 'the workspace is still open')

  // Once the operation settles, the normal navigation works again: the page's
  // own Esc reports the exit and the rail takes the keyboard back.
  page.pending = false
  page.exitOn = '\u001b'
  h.panel.handleInput('\u001b')
  assert.match(plain(h), /Settings · Categories/u, 'the rail owns the keyboard again')
})

test('a pending Host mutation keeps the workspace open even when the rail owns the keyboard', () => {
  const h = setup()
  h.panel.handleInput('\u001b[B') // About -> Models: the rail keeps the focus
  assert.equal(h.closes(), 0, 'the workspace is open')
  // The page now owns an in-flight Host operation (the page's own owner
  // started it); the close must be refused whatever the focus is.
  const page = h.built[0]
  assert.ok(page !== undefined)
  page.pending = true
  h.panel.handleInput('\u001b')
  assert.equal(h.closes(), 0, 'the workspace did not close under a pending Host operation')
  assert.match(plain(h), /Settings ·/u, 'the workspace is still painted')
})

test('a narrow rail selection is mounted when the terminal grows and the content column appears', async () => {
  const h = setup({ columns: 44, rows: 20 })
  // The narrow first frame is the About content: Esc returns to the list.
  h.panel.handleInput('\u001b')
  h.panel.handleInput('\u001b[B') // About -> Models
  h.panel.handleInput('\u001b[B') // Models -> Account
  assert.equal(h.built.length, 0, 'the narrow rail browsed an invisible category: no page was created')

  // The terminal grows: the content column appears and the SELECTED page must
  // be there — created once, with its own Host watch.
  h.panel.render(120)
  assert.equal(h.built.length, 1, 'the widened frame created the selected page once')
  assert.equal(h.built[0]?.id, 'account:page', 'the selected page is the Account page')
  assert.match(plain(h, 120), /account:page page/u, 'the right column shows the real page')
  h.panel.render(120)
  assert.equal(h.built.length, 1, 'the page is not rebuilt on the next frame')
})

// ── C3: copy reads only the LAST PAINTED About view ───────────────────────
//
// One scoped read publishes Loading and then Ready under the SAME epoch. The
// panel paints Loading, the Ready publication lands as a new immutable view,
// and no frame has painted it yet: a copy gesture must be REFUSED (the panel's
// own last-painted rule), never retargeted to the newer, unpainted snapshot.
// The epoch alone cannot distinguish the two publications — object identity
// can — so this case fails if the guard compares `view.epoch` again.
test('C3 a same-epoch publication is not copyable until the frame paints it', () => {
  const copied: string[] = []
  const loading: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'loading', sessionId: 'sess-repaint' },
    epoch: 7,
  }
  const ready: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-repaint',
      cwd: '/ws/repaint',
      title: 'repaint proof',
      stats: { lifetime: { turns: 1, steps: 1, llmMs: 1_000 } },
      context: 'fresh',
      contextUsed: 64_000,
      contextWindow: 128_000,
    },
    epoch: 7,
  }
  let current: AboutStatusView = loading
  const controller = {
    snapshotView: () => current,
    subscribe: () => () => {},
    enter: () => {},
    leave: () => {},
    refresh: () => {},
    dispose: () => {},
  } as unknown as AboutStatusController
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: () => controller,
    onCopy: (text) => { copied.push(text) },
  })
  // The narrow entry focuses the About content and paints its Loading frame.
  assert.match(plain(h, 44), /Loading…/u, 'the Loading frame is painted')
  // The read settles: Ready is published under the SAME epoch, and the
  // terminal has not painted it yet.
  current = ready
  h.panel.handleInput('c') // single fact
  h.panel.handleInput('C') // Copy All
  assert.equal(copied.length, 0, 'both copy gestures refuse an unpainted publication')
  // The repaint binds the same gestures to the Ready view.
  const frame = plain(h, 44)
  assert.match(frame, /sess-repaint/u, 'the Ready frame paints its own session')
  h.panel.handleInput('c')
  h.panel.handleInput('C')
  assert.equal(copied.length, 2, 'the painted Ready view copies through both gestures')
  assert.match(copied[1]!, /Session ID: sess-repaint/u, 'Copy All serializes the PAINTED Ready view')
})

/** A static About owner for the panel-level contract cases below. */
function staticAboutSource(view: AboutStatusView, onRefresh: () => void = () => {}): () => AboutStatusController {
  const controller = {
    snapshotView: () => view,
    subscribe: () => () => {},
    enter: () => {},
    leave: () => {},
    refresh: onRefresh,
    dispose: () => {},
  } as unknown as AboutStatusController
  return () => controller
}

// ── C3: the Refresh action is SELECTED before Enter can fire it ───────────
test('C3 Enter refreshes only the selected Refresh action, never an ordinary fact', () => {
  let refreshes = 0
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'ready', sessionId: 'sess-action', title: 'action proof', cwd: '/ws', context: 'fresh' },
    epoch: 3,
  }
  const h = setup({
    columns: 120,
    rows: 40,
    aboutStatusSource: staticAboutSource(view, () => { refreshes += 1 }),
  })
  plain(h, 120) // paint the About content and its action row
  h.panel.handleInput('\r') // rail -> About content focus
  plain(h, 120)
  h.panel.handleInput('\r') // ordinary fact: inert
  assert.equal(refreshes, 0, 'Enter on a selected fact never refreshes')
  h.panel.handleInput('\x1b[F') // End: last fact
  h.panel.handleInput('\x1b[B') // ↓ past the last fact: select the painted Refresh action
  const frame = plain(h, 120)
  assert.match(frame, /^ *> Refresh context \[R\]/mu, `the action is visibly selected:\n${frame}`)
  h.panel.handleInput('\r')
  assert.equal(refreshes, 1, 'Enter on the selected, visible Refresh action refreshes once')
  h.panel.handleInput('\x1b[A') // ↑: back to the last fact
  plain(h, 120)
  h.panel.handleInput('\r')
  assert.equal(refreshes, 1, 'Enter is inert again after leaving the action')
  h.panel.handleInput('r')
  assert.equal(refreshes, 2, 'r remains the About refresh shortcut')
})

// ── C3: a clipped Copy button never leaves a hit target ───────────────────
test('C3 a truncated per-field Copy affordance paints no target; keyboard copy still works', () => {
  for (const title of ['x'.repeat(31), '路径'.repeat(16)]) {
    const copied: string[] = []
    const view: AboutStatusView = {
      runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
      session: { kind: 'ready', sessionId: 'sess-long', title, cwd: '/ws', context: 'fresh' },
      epoch: 2,
    }
    const h = setup({
      columns: 44,
      rows: 20,
      aboutStatusSource: staticAboutSource(view),
      onCopy: text => { copied.push(text) },
    })
    const frame = plain(h, 44).split('\n')
    const titleRow = frame.findIndex(line => line.includes('Title'))
    assert.ok(titleRow >= 0, `the Title row paints:\n${frame.join('\n')}`)
    // The whole `Copy [C]` cannot fit this row: neither the clipped affordance
    // nor its target may survive. The keyboard `c` remains the copy path.
    assert.equal(frame[titleRow]!.includes('Co…'), false, 'no clipped Copy affordance')
    h.panel.onCellPress(43, titleRow)
    h.panel.onCellClick(43, titleRow)
    assert.equal(copied.length, 0, 'a click on the elided last cell never copies')
    for (let step = 0; step < 4; step += 1) h.panel.handleInput('\x1b[B')
    plain(h, 44)
    h.panel.handleInput('c')
    assert.equal(copied.at(-1), title, 'keyboard c copies the full long value')
  }
})

// ── C3: the final Status row has its own unique fact identity ─────────────
test('C3 End copies the final Status row of a degraded view, not the Projection row', () => {
  const copied: string[] = []
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'unavailable',
      sessionId: 'sess-degraded',
      projectionUnavailable: true,
      projectionFailed: true,
      context: 'unavailable',
    },
    epoch: 4,
  }
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 44)
  h.panel.handleInput('\x1b[F') // End: the last fact is the final Status row
  plain(h, 44)
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'Unavailable', 'End targets the final Status row, not the Projection')
})

// ── C3: every About branch applies the per-field copy guard ───────────────
test('C3 a loading hostile Session ID copies through the same control guard', () => {
  const copied: string[] = []
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'loading', sessionId: 'sess\u001b]52;c;pw\u0007-id' },
    epoch: 1,
  }
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 44)
  // Facts: runtime trio, Session ID, Status. Select the Session ID (3 downs).
  for (let step = 0; step < 3; step += 1) h.panel.handleInput('\x1b[B')
  plain(h, 44)
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'sess-id', 'the loading Session ID single-field copy is control-safe')
})

test('C3 C1 controls in a title never reach either About copy path', () => {
  const copied: string[] = []
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-c1',
      title: 'title\u0084\u0085\u0088\u008d-tail',
      cwd: '/ws',
      context: 'fresh',
    },
    epoch: 1,
  }
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 44)
  // Facts: runtime trio, Session ID, Title. Select Title (4 downs).
  for (let step = 0; step < 4; step += 1) h.panel.handleInput('\x1b[B')
  plain(h, 44)
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'title-tail', 'the single-field copy drops the C1 controls')
  h.panel.handleInput('C')
  const report = copied.at(-1)!
  assert.ok(!/[\u0080-\u009f]/u.test(report), 'Copy All carries no C1 control')
  assert.ok(report.includes('Title: title-tail'), 'Copy All keeps the ordinary suffix')
})

test('C3 a newline/tab title cannot forge a Copy All report line', () => {
  const copied: string[] = []
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-lines',
      title: 'normal\nBackend: Remote\t- tail',
      cwd: '/ws',
      context: 'fresh',
    },
    epoch: 1,
  }
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 44)
  // Select Title (4 downs) for the single-field sink.
  for (let step = 0; step < 4; step += 1) h.panel.handleInput('\x1b[B')
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'normal\\nBackend: Remote\\t- tail', 'the single-field copy escapes the controls')
  h.panel.handleInput('C')
  const report = copied.at(-1)!
  assert.ok(!report.includes('\r'), 'Copy All has no raw CR')
  assert.equal(
    report.split('\n').filter(line => line.startsWith('Backend:')).length,
    1,
    'the title cannot inject a Backend line',
  )
  assert.ok(report.includes('Title: normal\\nBackend: Remote\\t- tail'), 'the title stays one escaped line')
})

test('C3 a generic ESC intermediate/final sequence is dropped whole in both copy paths', () => {
  const copied: string[] = []
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-esc',
      title: 'pre\u001b(B-post',
      cwd: '/ws',
      context: 'fresh',
    },
    epoch: 1,
  }
  const h = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 44)
  for (let step = 0; step < 4; step += 1) h.panel.handleInput('\x1b[B')
  const frame = plain(h, 44)
  assert.ok(
    frame.split('\n').some(line => line.includes('Title') && line.includes('pre-post')),
    `the painted Title is sanitized like the copy:\n${frame}`,
  )
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'pre-post', 'the single-field copy drops the whole ESC sequence')
  h.panel.handleInput('C')
  assert.ok(copied.at(-1)!.includes('Title: pre-post'), 'Copy All drops the whole ESC sequence')
})
