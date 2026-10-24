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
import type {
  EmbeddedPluginPage,
  PluginContentViewport,
  PluginWorkspaceView,
} from '../../src/tui/plugin-manager/workspace.ts'

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
  /** Every body grant the root handed the page, in order. */
  readonly bodyHeights: number[] = []
  /** Every content-cell press/click the root forwarded, in column coords. */
  readonly pressed: Array<readonly [number, number]> = []
  readonly clicked: Array<readonly [number, number]> = []
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
  setBodyHeight(rows: number): void {
    this.bodyHeights.push(rows)
  }
  handleInput(data: string): 'handled' | 'exit' | 'open-account' {
    this.inputs.push(data)
    if (this.exitOn !== undefined && data === this.exitOn) return 'exit'
    return 'handled'
  }
  onCellPress(x: number, y: number): void {
    this.pressed.push([x, y])
  }
  onCellClick(x: number, y: number): 'handled' | 'exit' | 'open-account' {
    this.clicked.push([x, y])
    return 'handled'
  }
  cancelPointer(): void {}
  pendingMutation(): boolean { return this.pending }
  canYieldFocusToNavigation(): boolean { return this.yieldAllowed }
  dispose(): void { this.disposed = true }
}

/** A fake embedded Plugin Manager page: it paints only inside its granted
 *  viewport and reports the navigation yield instead of closing. */
class FakePluginPage implements EmbeddedPluginPage {
  readonly inputs: string[] = []
  readonly viewports: PluginContentViewport[] = []
  disposed = false
  focused = false
  private view: PluginWorkspaceView = 'list'
  private readonly yieldNavigation: () => void
  constructor(yieldNavigation: () => void) {
    this.yieldNavigation = yieldNavigation
  }
  setViewport(viewport: PluginContentViewport): void {
    this.viewports.push({ ...viewport })
  }
  currentView(): PluginWorkspaceView {
    return this.view
  }
  canYieldFocusToNavigation(): boolean {
    return this.view === 'list'
  }
  pendingMutation(): boolean {
    return false
  }
  gestureRevision(): number {
    return 0
  }

  semanticGeneration(): number {
    return 0
  }
  liveIdentity(): string {
    return `${this.view}:${this.inputs.length}`
  }
  cancelPointer(): void {}
  contentLayout(): { readonly dual: boolean; readonly leftWidth: number; readonly rightWidth: number } {
    const viewport = this.viewports[this.viewports.length - 1] ?? { width: 1, rows: 1, allowDual: false }
    return { dual: false, leftWidth: viewport.width, rightWidth: viewport.width }
  }
  render(width: number): string[] {
    const rows = Math.max(1, this.viewports[this.viewports.length - 1]?.rows ?? 1)
    const blank = ' '.repeat(Math.max(1, width))
    const lines = Array.from({ length: rows }, (_, index) => index === 0 ? 'plugin page'.padEnd(Math.max(1, width)) : blank)
    lines[rows - 1] = 'plugin bar'.padEnd(Math.max(1, width))
    return lines
  }
  invalidate(): void {}
  handleInput(data: string): void {
    this.inputs.push(data)
    // The List root's Esc reports the yield; the ROOT commits the focus change.
    if (data === '\u001b' && this.canYieldFocusToNavigation()) this.yieldNavigation()
  }
  handleMouse(): undefined { return undefined }
  onCellPress(): void {}
  onCellClick(): void {}
  dispose(): void { this.disposed = true }
}

interface Harness {
  readonly panel: SettingsWorkspacePanel
  readonly built: FakePage[]
  readonly pluginPages: readonly FakePluginPage[]
  /** The live column budget the panel reads for its layout/input decisions. */
  readonly columns: () => number
  readonly rows: () => number
  /** Change the live geometry WITHOUT repainting (the resize-before-frame seam). */
  readonly resize: (columns: number, rows: number) => void
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
  /** Build an in-place Plugin Manager page the Plugins entry can open. */
  readonly pluginPage?: boolean
  /** C3: the About owner the panel renders/subscribes to. */
  readonly aboutStatusSource?: () => AboutStatusController
  /** C3: the clipboard sink (records what the copy gestures emit). */
  readonly onCopy?: (text: string) => void
} = {}): Harness {
  let columns = options.columns ?? 120
  let rows = options.rows ?? 40
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
      ? (onYieldNavigation) => {
          const page = new FakePluginPage(onYieldNavigation)
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
    columns: () => columns,
    rows: () => rows,
    resize: (nextColumns: number, nextRows: number) => {
      columns = nextColumns
      rows = nextRows
    },
    closes: () => closes,
    commits: () => commits,
    legacyOpens: () => legacyOpens,
    settlements,
  }
}

const plain = (harness: Harness, width = harness.columns()): string =>
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

test('the embedded Plugin Manager owns the content keys while the rail keeps the cross-region ones', () => {
  const h = setup({ columns: 120, pluginPage: true })
  plain(h)
  for (let index = 0; index < 6; index += 1) h.panel.handleInput('\u001b[B') // About -> Plugins
  // Selecting Plugins on the rail paints the live preview and keeps the keys on
  // the rail: it never builds a page twice.
  assert.equal(h.pluginPages.length, 1, 'the Plugins category mounted the page once')
  assert.deepEqual(h.pluginPages[0]!.inputs, [], 'the rail focus never forwards a key to the preview')
  // Tab only moves the keyboard into the plugin List (no page action). The
  // focus OWNER is installed by the frame that paints the new projection.
  h.panel.handleInput('\t')
  plain(h)
  assert.equal(h.pluginPages[0]!.focused, true, 'Tab focused the plugin content')
  h.panel.handleInput('\t')
  assert.deepEqual(h.pluginPages[0]!.inputs, ['\t'], 'the content focus forwards its own Tab to the page')
  // Shift+Tab from the untouched List root returns to the rail; it is never
  // forwarded to the page and never closes the workspace.
  h.panel.handleInput('\u001b[Z')
  assert.deepEqual(h.pluginPages[0]!.inputs, ['\t'], 'Shift+Tab is the root cross-region key, not a page key')
  assert.equal(h.pluginPages[0]!.focused, false, 'the yielded page stopped owning the input focus')
  assert.equal(h.closes(), 0, 'the workspace stayed open')
  const frame = plain(h)
  assert.match(frame, /Categories \(8\)/u, 'the rail is painted after the yield')
  assert.match(frame, /Esc close/u, 'the rail bar owns the last row after the yield')
  // Esc on the rail closes the Settings lease.
  h.panel.handleInput('\u001b')
  assert.equal(h.closes(), 1, 'the second Esc closes the workspace')
})

test('a real category change disposes the plugin page once; a focus yield never does', () => {
  const h = setup({ columns: 120, pluginPage: true })
  plain(h)
  for (let index = 0; index < 6; index += 1) h.panel.handleInput('\u001b[B') // About -> Plugins
  plain(h) // the visible preview mounts the ONE page
  assert.equal(h.pluginPages.length, 1)
  h.panel.handleInput('\t') // focus the plugin content
  plain(h)
  h.panel.handleInput('\u001b[Z') // Shift+Tab at the List root yields
  plain(h)
  assert.equal(h.pluginPages[0]!.disposed, false, 'a yield keeps the page instance alive')
  assert.equal(h.closes(), 0)
  // A REAL category change disposes it exactly once and never builds another.
  h.panel.handleInput('\u001b[B') // Plugins -> Other settings
  plain(h)
  assert.equal(h.pluginPages[0]!.disposed, true, 'the real category change disposes the page')
  assert.equal(h.pluginPages.length, 1, 'the category change builds no second page')
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
})

test('the region hints never crowd the About copy/refresh verbs out of a tight bar', () => {
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'ready', sessionId: 'sess-bar', title: 'bar proof', cwd: '/ws', context: 'fresh' },
    epoch: 9,
  }
  // 90 columns leave the content column too tight for every hint: the
  // lowest-priority region hint is the FIRST segment dropped and every
  // semantic About verb stays visible.
  const tight = setup({ columns: 90, rows: 30, aboutStatusSource: staticAboutSource(view) })
  plain(tight, 90) // paint the About content/rail
  tight.panel.handleInput('\r') // rail -> About content
  const tightBar = plain(tight, 90).split('\n').at(-1)!
  assert.match(tightBar, /c copy fact/u, 'the field copy stays visible at 90')
  assert.match(tightBar, /C copy all/u, 'the full-report copy stays visible at 90')
  assert.match(tightBar, /r refresh/u, 'the refresh stays visible at 90')
  assert.match(tightBar, /Esc back/u)
  assert.doesNotMatch(tightBar, /Tab focus/u, 'the region key is dropped before any semantic verb')
  assert.match(tightBar, /Shift\+Tab back/u, 'the remaining region hint only survives because the verbs fit')

  // 100 columns fit the complete row (76 cells): no semantic verb is lost.
  const roomy = setup({ columns: 100, rows: 30, aboutStatusSource: staticAboutSource(view) })
  plain(roomy, 100)
  roomy.panel.handleInput('\r')
  const roomyBar = plain(roomy, 100).split('\n').at(-1)!
  assert.match(roomyBar, /c copy fact · C copy all · r refresh · Tab focus · Shift\+Tab back · Esc back/u,
    `every hint fits at 100:\n${roomyBar}`)

  // There is room at 120 columns: the same verbs survive WITH the region keys.
  const wide = setup({ columns: 120, rows: 40, aboutStatusSource: staticAboutSource(view) })
  plain(wide, 120)
  wide.panel.handleInput('\r')
  const wideBar = plain(wide, 120).split('\n').at(-1)!
  assert.match(wideBar, /c copy fact · C copy all · r refresh · Tab focus · Shift\+Tab back · Esc back/u,
    `every hint fits at 120:\n${wideBar}`)
})

test('the legacy 90-column bars keep refresh when the region hints drop', () => {
  const h = setup({ columns: 90, rows: 24 })
  plain(h, 90)
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B')
  h.panel.handleInput('\u001b[B') // About -> Appearance
  h.panel.handleInput('\t') // categories -> rows
  const rowsBar = plain(h, 90).split('\n').at(-1)!
  assert.match(rowsBar, /Enter choose/u, 'the row action stays visible')
  assert.match(rowsBar, /r refresh/u, 'the refresh stays visible')
  assert.match(rowsBar, /Esc back/u)
  assert.doesNotMatch(rowsBar, /Tab panes|Shift\+Tab back/u, 'the region hints drop first')

  h.panel.handleInput('\t') // rows -> Detail browsing (no choice)
  assert.doesNotMatch(plain(h, 90), /Choose value/u, 'Tab never opens the detail choice')
  const detailBar = plain(h, 90).split('\n').at(-1)!
  assert.match(detailBar, /r refresh/u, 'the Detail refresh stays visible')
  assert.match(detailBar, /c copy value/u, 'the Detail copy hint stays visible')
  assert.match(detailBar, /Left back/u)
  assert.doesNotMatch(detailBar, /Tab panes/u, 'the region key is dropped before any semantic verb')
})

// ── The shared chrome budget at the panel seam ────────────────────────────

test('the pane header names the keyboard owner at 80 and 120 columns', () => {
  for (const columns of [120, 80] as const) {
    const h = setup({ columns, rows: 24 })
    h.panel.handleInput('\u001b[B') // About -> Models: the rail keeps the keys
    const preview = plain(h, columns).split('\n')
    const previewPane = preview.findIndex(line => line.includes('[Categories (8)]'))
    assert.ok(previewPane >= 0, `the direct pane header paints at ${columns}:\n${preview.join('\n')}`)
    assert.match(preview[previewPane]!, /\[Categories \(8\)\].*Models/u,
      `the rail owns the active device:\n${preview[previewPane]}`)
    assert.doesNotMatch(preview[previewPane]!, /Rows \(/u, 'the direct pane header fakes no Rows pane')

    h.panel.handleInput('\r') // the content takes the keyboard, the page is reused
    const content = plain(h, columns).split('\n')
    const contentPane = content.findIndex(line => line.includes('Categories (8)'))
    assert.ok(contentPane >= 0)
    assert.match(content[contentPane]!, /Categories \(8\).*\[Models\]/u,
      `the page owns the active device:\n${content[contentPane]}`)

    // The legacy projection keeps its own pane names on the same shared row.
    const legacy = setup({ columns, rows: 24 })
    legacy.panel.handleInput('\u001b[B')
    legacy.panel.handleInput('\u001b[B')
    legacy.panel.handleInput('\u001b[B') // Appearance
    const l0 = plain(legacy, columns).split('\n')
    const l0Pane = l0.findIndex(line => line.includes('[Categories (8)]'))
    assert.ok(l0Pane >= 0)
    assert.match(l0[l0Pane]!, /\[Categories \(8\)\].*Rows \(2\)/u)
    legacy.panel.handleInput('\t') // categories -> rows
    const l1 = plain(legacy, columns).split('\n')
    const l1Pane = l1.findIndex(line => line.includes('[Rows (2)]'))
    assert.ok(l1Pane >= 0, `the focused Rows header paints at ${columns}:\n${l1.join('\n')}`)
    assert.match(l1[l1Pane]!, /\[Rows \(2\)\].*Details/u)
  }
})

test('the pane header publishes no hit target and a focus key reuses the mounted page', () => {
  const h = setup({ columns: 120, rows: 24 })
  plain(h, 120)
  h.panel.handleInput('\u001b[B') // About -> Models
  const page = h.built[0]
  assert.ok(page !== undefined)
  plain(h, 120)
  h.panel.handleInput('\r') // focus transfer
  assert.deepEqual(page.inputs, [], 'the focus transfer runs no page action')
  assert.deepEqual(page.clicked, [], 'the focus transfer runs no page click')
  assert.equal(h.built.length, 1, 'the focus transfer built no second page')
  assert.equal(page.disposed, false)

  // The header row is display-only: a click there owns no target.
  const frame = plain(h, 120).split('\n')
  const paneRow = frame.findIndex(line => line.includes('Categories (8)'))
  assert.ok(paneRow >= 0)
  h.panel.onCellPress(2, paneRow)
  h.panel.onCellClick(2, paneRow)
  assert.deepEqual(page.pressed, [], 'the pane header is outside the content box')
  assert.deepEqual(page.clicked, [])
  assert.equal(h.built.length, 1)
  assert.match(plain(h, 120), /Settings · Models/u, 'the keyboard focus did not move')

  // The page's own Esc report returns the keyboard to the rail, keeping the
  // same page instance (the root never rebuilds it for a focus change).
  page.exitOn = '\u001b'
  h.panel.handleInput('\u001b')
  assert.match(plain(h, 120), /Settings · Categories/u)
  assert.equal(page.disposed, false, 'the page survives returning to the rail')
})

test('render and pre-repaint input hand the page the identical body grant', () => {
  const h = setup({ columns: 100, rows: 24 })
  plain(h, 100)
  h.panel.handleInput('\u001b[B') // About -> Models
  const page = h.built[0]
  assert.ok(page !== undefined)
  plain(h, 100)
  // 24 rows: header 1 + metadata 1 + rule 1 => body grant 20; the pane header
  // is reserved inside it, so the child is laid out for 19 content rows + its
  // own bar = 20.
  assert.equal(page.bodyHeights.at(-1), 20, 'the painted frame hands the child body+bar')

  // A press recorded against the tall frame is refused after a shrink that has
  // not repainted yet.
  h.panel.onCellPress(30, 5)
  h.resize(100, 8)
  h.panel.onCellClick(30, 5)
  assert.deepEqual(page.clicked, [], 'the old-frame click cannot reach the page')

  // 8 rows: header 1 + metadata 1 + rule 1 => body grant 4; the pane header is
  // reserved inside it, so the child gets 3 content rows + its bar = 4.
  plain(h, 100)
  assert.equal(page.bodyHeights.at(-1), 4, 'the next frame passes the identical grant')
  // The press path recomputes the SAME grant before forwarding input.
  h.panel.onCellPress(30, 5)
  assert.equal(page.bodyHeights.at(-1), 4, 'the pre-repaint input path uses the same planner')
  h.panel.onCellClick(30, 5)
  assert.equal(page.clicked.length, 1, 'a click inside the live frame still reaches the page')
})

test('one- and two-row frames paint only the truthful bar and publish no body target', () => {
  for (const rows of [1, 2] as const) {
    const h = setup({ columns: 100, rows })
    const before = plain(h, 100)
    const frame = before.split('\n')
    assert.equal(frame.length, rows, `the frame must paint exactly ${rows} rows`)
    assert.equal(frame.filter(line => /Esc close|Esc back/u.test(line)).length, 1,
      `exactly one Esc bar at ${rows} rows:\n${before}`)
    assert.doesNotMatch(before, /Categories \(|Rows \(|Details| page/u, 'no pane header or page body is painted below the body grant')
    h.panel.handleInput('\u001b[B')
    h.panel.handleInput('\r')
    assert.equal(h.built.length, 0, 'no direct page mounts below the body floor')
    h.panel.onCellPress(2, rows - 1)
    h.panel.onCellClick(2, rows - 1)
    assert.equal(plain(h, 100), before, 'the bar is not an interactive body target')
  }
})

test('below the body floor the content focus forwards only Esc, never a hidden page action', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h, 120)
  h.panel.handleInput('\u001b[B') // About -> Models
  h.panel.handleInput('\r') // the content takes the keyboard
  const page = h.built[0]
  assert.ok(page !== undefined)
  h.resize(120, 2)
  for (const data of ['r', 'R', 'c', 'C', '\r', '\t', '\u001b[B', '\u001b[6~', '\u001b[H', '\u001b[D']) {
    h.panel.handleInput(data)
  }
  assert.deepEqual(page.inputs, [], 'no hidden body action or cursor key reaches the page')
  page.exitOn = '\u001b'
  h.panel.handleInput('\u001b')
  assert.deepEqual(page.inputs, ['\u001b'], 'the real modal cancel still reaches the page')
  assert.match(plain(h, 120), /Settings · Categories/u, 'the page Esc returned the keyboard to the rail')

  // Backspace is NOT a portable back path: a page may bind it to a hidden
  // edit (the Models catalog filter), so it must not reach the page either.
  h.resize(120, 40)
  plain(h, 120)
  h.panel.handleInput('\r') // re-enter the same mounted page
  h.resize(120, 2)
  h.panel.handleInput('\u007f')
  assert.deepEqual(page.inputs, ['\u001b'], 'the hidden Backspace never reaches the page')
  assert.match(plain(h, 120), /Settings · Models/u, 'the page still owns the keyboard')

  // The narrow About content is the root-owned projection: a hidden refresh
  // never reaches its owner below the body floor.
  let refreshes = 0
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'ready', sessionId: 'sess-floor', title: 'floor proof', cwd: '/ws', context: 'fresh' },
    epoch: 4,
  }
  const about = setup({
    columns: 44,
    rows: 20,
    aboutStatusSource: staticAboutSource(view, () => { refreshes += 1 }),
  })
  about.panel.render(44) // the narrow About content owns the first frame
  about.resize(44, 2)
  about.panel.render(44)
  for (const data of ['r', 'R', 'c', 'C', '\r', '\t', '\u001b[B']) about.panel.handleInput(data)
  assert.equal(refreshes, 0, 'the hidden About refresh is gated below the body floor')
  assert.equal(about.closes(), 0, 'the workspace never closes from a hidden key')
  about.panel.handleInput('\u001b')
  assert.match(plain(about, 44), /Settings · Categories/u)
})
