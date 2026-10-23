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
  type SettingsWorkspaceCommitOutcome,
  type SettingsWorkspacePanelIntents,
  type SettingsWorkspaceSnapshot,
} from '../../src/tui/panels/settings-workspace-panel.ts'
import type { AboutStatusController } from '../../src/app/command/about-status.ts'
import type { AboutStatusView } from '../../src/domain/status/about.ts'

const SNAPSHOT: SettingsWorkspaceSnapshot = {
  configReadiness: 'ready',
  capturedAt: 0,
  rows: [
    {
      id: 'theme',
      category: 'appearance',
      label: 'Configured theme',
      summary: 'dark',
      value: 'dark',
      scope: 'TUI settings document',
      freshness: 'ready',
      description: 'palette',
      action: 'inspect',
      edit: {
        field: 'theme',
        primary: 'runtime',
        runtime: 'dark',
        persisted: 'dark',
        options: [
          { value: 'auto', label: 'auto', available: true, current: false },
          { value: 'dark', label: 'dark', available: true, current: true },
        ],
      },
    },
    {
      id: 'web-settings',
      category: 'appearance',
      label: 'Web settings',
      summary: 'Host',
      scope: 'Host settings document',
      freshness: 'ready',
      description: 'Host-owned Web settings',
      action: 'open-legacy',
    },
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
  /** Whether a bare Left may yield the page root (an Account confirmation
   *  keeps it even while no mutation is in flight). */
  yieldAllowed = true

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
  canYieldFocusToNavigation(): boolean { return this.yieldAllowed }
  dispose(): void { this.disposed = true }
}

/** The in-place Plugin Manager page: it owns its own Tab. */
class FakePluginPage {
  readonly inputs: string[] = []
  disposed = false
  focused = false
  render(width: number): string[] {
    return ['plugin page'.padEnd(Math.max(1, width))]
  }
  invalidate(): void {}
  handleInput(data: string): void {
    this.inputs.push(data)
  }
  dispose(): void { this.disposed = true }
}

interface Harness {
  readonly panel: SettingsWorkspacePanel
  readonly built: FakePage[]
  readonly pluginPages: readonly FakePluginPage[]
  /** The live column budget the panel reads for its layout/input decisions. */
  readonly columns: number
  /** How many times the workspace asked to close. */
  readonly closes: () => number
  /** How many times a configuration write was dispatched. */
  readonly commits: () => number
  /** How many times the legacy editor handoff was requested. */
  readonly legacyOpens: () => number
  /** The settle callbacks of the dispatched writes, in order. */
  readonly settlements: readonly ((outcome: SettingsWorkspaceCommitOutcome) => void)[]
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
  /** Build an in-place Plugin Manager page the Plugins entry can open. */
  readonly pluginPage?: boolean
} = {}): Harness {
  const columns = options.columns ?? 120
  const rows = options.rows ?? 40
  const built: FakePage[] = []
  const pluginPages: FakePluginPage[] = []
  const settlements: ((outcome: SettingsWorkspaceCommitOutcome) => void)[] = []
  let closes = 0
  let commits = 0
  let legacyOpens = 0
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: { tui: '0.5.3', dsh: '0.2.1-rc.2' },
    rows: () => rows,
    columns: () => columns,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => { closes += 1 },
    onOpenLegacy: () => { legacyOpens += 1 },
    ...(options.aboutStatusSource === undefined ? {} : { aboutStatusSource: options.aboutStatusSource }),
    onCopy: (text) => { options.onCopy?.(text) },
    onCommit: (_request, settle) => {
      commits += 1
      settlements.push(settle)
    },
    onOpenPlugins: options.pluginPage === true
      ? () => {
          const page = new FakePluginPage()
          pluginPages.push(page)
          return page
        }
      : undefined,
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
  return {
    panel,
    built,
    pluginPages,
    columns,
    closes: () => closes,
    commits: () => commits,
    legacyOpens: () => legacyOpens,
    settlements,
  }
}

const plain = (harness: Harness, width = harness.columns): string =>
  harness.panel.render(width).map(stripTerminalSequences).join('\n')

const header = (harness: Harness): string => plain(harness).split('\n')[0] ?? ''

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

test('C3 invalid ESC/C1 CSI bytes keep the ordinary character in paint and copy', () => {
  for (const title of ['pre\u001b[鲸-post', 'pre\u009b鲸-post']) {
    const copied: string[] = []
    const view: AboutStatusView = {
      runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
      session: { kind: 'ready', sessionId: 'sess-csi', title, cwd: '/ws', context: 'fresh' },
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
      frame.split('\n').some(line => line.includes('Title') && line.includes('pre鲸-post')),
      `the painted Title keeps the ordinary character:\n${frame}`,
    )
    h.panel.handleInput('c')
    assert.equal(copied.at(-1), 'pre鲸-post', 'the single-field copy keeps the ordinary character')
    h.panel.handleInput('C')
    assert.ok(copied.at(-1)!.includes('Title: pre鲸-post'), 'Copy All keeps the ordinary character')
  }

// ── Tab / Shift+Tab region navigation (settings-tab-section-navigation) ────

test('Tab enters each direct content page and returns About/Account content to the rail', () => {
  for (const columns of [120, 90] as const) {
    const h = setup({ columns })
    plain(h)
    // About: rail -> content, then both directions return to the rail.
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · About/u, `Tab focuses the About content at ${columns}`)
    assert.equal(h.commits(), 0, 'focusing About never writes')
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Categories/u, `Tab returns from the About content at ${columns}`)
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · About/u, `Tab focuses the About content again at ${columns}`)
    h.panel.handleInput('\u001b[Z')
    assert.match(header(h), /Settings · Categories/u, `Shift+Tab returns from the About content at ${columns}`)

    // Models: the rail Tab hands the keyboard over; inside the page both
    // region keys are forwarded unchanged.
    h.panel.handleInput('\u001b[B') // About -> Models
    plain(h)
    assert.equal(h.built.length, 1, 'the rail mounted the Models page once')
    h.panel.handleInput('\t')
    const models = h.built[0]!
    assert.match(header(h), /Settings · Models/u, 'Tab focuses the Models content')
    assert.deepEqual(models.inputs, [], 'the rail Tab is not forwarded to the page')
    h.panel.handleInput('\t')
    h.panel.handleInput('\u001b[Z')
    assert.deepEqual(models.inputs, ['\t', '\u001b[Z'], 'the Models page owns both region keys')
    assert.match(header(h), /Settings · Models/u, 'the page keeps the keyboard while it owns Tab')
    // The existing Left (yieldable page root) and Esc paths stay intact.
    h.panel.handleInput('\u001b[D')
    assert.match(header(h), /Settings · Categories/u, 'Left still returns from the Models page')
    h.panel.handleInput('\t')
    models.exitOn = '\u001b'
    h.panel.handleInput('\u001b')
    assert.match(header(h), /Settings · Categories/u, 'Esc still returns through the page exit')
    assert.equal(models.disposed, false, 'returning keeps the page instance')

    // Account: the rail Tab enters, and the content Tab/Shift+Tab return
    // without ever calling a page key (the Account page has no local Tab).
    h.panel.handleInput('\u001b[B') // Models -> Account
    plain(h)
    const account = h.built[1]!
    assert.equal(account.id, 'account:page')
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Account/u, 'Tab focuses the Account content')
    assert.deepEqual(account.inputs, [], 'entering Account ran no page action')
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Categories/u, 'Tab returns from the safe Account content')
    h.panel.handleInput('\t')
    h.panel.handleInput('\u001b[Z')
    assert.match(header(h), /Settings · Categories/u, 'Shift+Tab returns from the safe Account content')
    assert.deepEqual(account.inputs, [], 'the root never forwarded the region key to Account')

    // Re-entering reuses the mounted page: no second Host watch.
    assert.equal(h.built.length, 2, 'no page was rebuilt by the focus jumps')
    assert.equal(h.commits(), 0, 'region jumps never write')
    assert.equal(h.legacyOpens(), 0, 'region jumps never open the legacy editor')
  }
})

test('Tab cycles the legacy panes without opening the Detail choice, and Shift+Tab reverses', () => {
  for (const columns of [120, 90] as const) {
    const h = setup({ columns })
    plain(h)
    h.panel.handleInput('\u001b[B')
    h.panel.handleInput('\u001b[B')
    h.panel.handleInput('\u001b[B') // About -> Appearance
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Appearance · Rows/u, `Tab focuses Rows at ${columns}`)
    assert.ok(plain(h).includes('[Rows'), 'the focused pane header names the owner')
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Appearance · Configured theme/u, `Tab focuses Detail at ${columns}`)
    assert.doesNotMatch(plain(h), /Choose value/u, 'Tab focusing Detail never begins a choice')
    assert.equal(h.commits(), 0, 'focusing Detail never writes')
    assert.equal(h.legacyOpens(), 0, 'focusing Detail never opens the legacy editor')
    h.panel.handleInput('\t')
    assert.match(header(h), /Settings · Categories/u, `Tab wraps back to the rail at ${columns}`)
    // Reverse: the same three panes in the opposite direction.
    h.panel.handleInput('\u001b[Z')
    assert.match(header(h), /Settings · Appearance · Configured theme/u, 'Shift+Tab wraps to Detail')
    assert.doesNotMatch(plain(h), /Choose value/u, 'the reverse jump never begins a choice')
    h.panel.handleInput('\u001b[Z')
    assert.match(header(h), /Settings · Appearance · Rows/u, 'Shift+Tab returns to Rows')
    h.panel.handleInput('\u001b[Z')
    assert.match(header(h), /Settings · Categories/u, 'Shift+Tab returns to the rail')
  }
})

test('Tab is inert while a choice or a pending write owns the Detail', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h)
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // About -> Appearance
  h.panel.handleInput('\r') // categories -> rows
  h.panel.handleInput('\r') // rows -> Detail choice
  assert.match(plain(h), /Choose value/u)
  const choosing = plain(h)
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.equal(plain(h), choosing, 'Tab/Shift+Tab never cancel or bypass a choice')

  // The explicit Enter confirm dispatches the ONE write into its pending
  // phase; the region keys must not become a way out of it either.
  h.panel.handleInput('\r')
  assert.equal(h.commits(), 1, 'the explicit confirm dispatched the write')
  const pending = plain(h)
  assert.match(pending, /Saving…/u, 'the pending phase is painted')
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.equal(plain(h), pending, 'Tab never bypasses an in-flight write')
  assert.match(header(h), /Configured theme/u, 'the pending Detail keeps the keyboard')
})

test('a narrow frame keeps the root Tab inert and its existing drill-down path', () => {
  const h = setup({ columns: 72, rows: 24 })
  // A narrow terminal opens on the About content: root Tab changes nothing.
  assert.match(header(h), /Settings · About/u)
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.match(header(h), /Settings · About/u, 'the narrow root Tab is inert in the content')
  h.panel.handleInput('\u001b')
  assert.match(header(h), /Settings · Categories/u, 'Esc still returns to the narrow rail')

  // Models: browsing the rail mounts nothing; Tab grants no hidden page key.
  h.panel.handleInput('\u001b[B')
  assert.equal(h.built.length, 0, 'the narrow rail selected Models without mounting it')
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.match(header(h), /Settings · Categories/u, 'the narrow root Tab is inert on the rail')
  assert.equal(h.built.length, 0, 'the narrow Tab never mounts the hidden page')
  // Right still enters the content and mounts the page once.
  h.panel.handleInput('\u001b[C')
  plain(h)
  assert.match(header(h), /Settings · Models/u, 'Right still enters the narrow content')
  assert.equal(h.built.length, 1, 'Right mounted the page once')
  h.panel.handleInput('\u001b[D')
  assert.match(header(h), /Settings · Categories/u, 'Left still returns from a safe narrow page')
  h.panel.handleInput('\u001b')
  assert.equal(h.closes(), 1, 'the second Esc still closes the workspace')

  // Legacy narrow: Tab cannot change the single visible level.
  const legacy = setup({ columns: 72, rows: 24 })
  plain(legacy)
  legacy.panel.handleInput('\u001b') // About content -> rail
  legacy.panel.handleInput('\u001b[B')
  legacy.panel.handleInput('\u001b[B')
  legacy.panel.handleInput('\u001b[B') // Appearance
  legacy.panel.handleInput('\t')
  assert.match(header(legacy), /Settings · Categories/u, 'the narrow legacy Tab is inert on L0')
  legacy.panel.handleInput('\u001b[C')
  assert.match(header(legacy), /Settings · Appearance · Rows/u, 'Right still enters L1')
  legacy.panel.handleInput('\t')
  assert.match(header(legacy), /· Rows/u, 'the narrow legacy Tab is inert on L1')
})

test('Account content keeps the keyboard while a confirmation or an operation is live', () => {
  const h = setup({ columns: 120 })
  plain(h)
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // About -> Account (via Models)
  h.panel.handleInput('\t') // rail -> content
  const account = h.built[1]!
  assert.equal(account.id, 'account:page')

  // The sign-out confirmation may not yield, even though no Host mutation is
  // in flight: Tab must not move the keyboard to the rail.
  account.yieldAllowed = false
  const confirming = plain(h)
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.equal(plain(h), confirming, 'Tab cannot leave a confirmation')
  assert.match(header(h), /Settings · Account/u)
  assert.deepEqual(account.inputs, [], 'the Account page never receives the root Tab')
  assert.equal(h.closes(), 0, 'Tab never closes the workspace')
  assert.equal(account.disposed, false, 'the mounted page is kept')

  // A pending Host operation keeps the keyboard after the confirmation is
  // gone (the root's pending guard, not the page's local one).
  account.yieldAllowed = true
  account.pending = true
  const pending = plain(h)
  h.panel.handleInput('\t')
  assert.equal(plain(h), pending, 'Tab cannot leave a pending Account operation')
  assert.match(header(h), /Settings · Account/u)
  h.panel.handleInput('\u001b[D')
  assert.match(header(h), /Settings · Account/u, 'Left cannot leave it either')

  // Once it settles, the normal Tab/Esc path is available again.
  account.pending = false
  h.panel.handleInput('\t')
  assert.match(header(h), /Settings · Categories/u, 'the settled page yields to the rail')
  h.panel.handleInput('\u001b')
  assert.equal(h.closes(), 1, 'the workspace closes normally after the settle')
})

test('a Tab focus change revokes a pointer press recorded on the previous pane', () => {
  const h = setup({ columns: 120 })
  plain(h)
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // Appearance
  const frame = plain(h).split('\n')
  const y = frame.findIndex(line => line.includes('Web settings'))
  assert.ok(y >= 0, `the legacy row must be painted:\n${frame.join('\n')}`)
  const x = frame[y]!.indexOf('Web settings')
  // Press on the row while the RAIL owns the keyboard, Tab the focus into the
  // Rows pane, then release on the same painted cells: the old target must not
  // activate under the new focus.
  h.panel.onCellPress(x, y)
  h.panel.handleInput('\t')
  h.panel.onCellClick(x, y)
  assert.equal(h.legacyOpens(), 0, 'the straddling release must not open the legacy editor')
  assert.match(header(h), /Settings · Appearance · Rows/u, 'the Tab focus is not overwritten by the old press')
})

test('the in-place Plugin Manager keeps its own Tab and is never intercepted', () => {
  const h = setup({ columns: 120, pluginPage: true })
  plain(h)
  for (let index = 0; index < 5; index += 1) h.panel.handleInput('\u001b[B') // About -> Plugins
  h.panel.handleInput('\r')
  assert.equal(h.pluginPages.length, 1, 'the Plugins entry opened the page once')
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[Z')
  assert.deepEqual(h.pluginPages[0]!.inputs, ['\t', '\u001b[Z'], 'the Plugin Manager owned both Tab presses')
  assert.equal(h.closes(), 0, 'the workspace stayed open')
})

test('a pending legacy write never advertises the direct rail Tab until it settles', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h)
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // About -> Appearance
  h.panel.handleInput('\r') // categories -> rows
  h.panel.handleInput('\r') // rows -> Detail choice
  plain(h)
  h.panel.handleInput('\r') // explicit confirm -> pending
  assert.equal(h.commits(), 1, 'the explicit confirm dispatched the write')
  assert.match(plain(h), /Saving…/u)

  // The workspace allows browsing during a pending write: return to the rail
  // and select a DIRECT category (About) while the write is still in flight.
  h.panel.handleInput('\u001b') // detail -> rows
  h.panel.handleInput('\u001b') // rows -> categories
  h.panel.handleInput('\u001b[H') // Home -> About
  const pendingRail = plain(h)
  assert.match(header(h), /Settings · Categories/u)
  assert.match(pendingRail, /> About/u)
  assert.doesNotMatch(pendingRail, /Tab focus/u, 'a pending write never advertises a no-op region key')
  h.panel.handleInput('\t')
  assert.match(header(h), /Settings · Categories/u, 'Tab is a no-op while the write is pending')

  // Once it settles, the same rail advertises the key again and Tab works.
  h.settlements[0]!({ outcome: 'verified' })
  assert.match(plain(h), /Tab focus/u, 'the settled rail advertises the region key again')
  h.panel.handleInput('\t')
  assert.match(header(h), /Settings · About/u, 'the settled Tab enters the About content')
})
