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
import { stripTerminalSequences, visibleWidth } from '@xmoon76/pi-tui'
import {
  SettingsWorkspacePanel,
  type SettingsAuthPage,
  type SettingsWorkspaceCommitOutcome,
  type SettingsWorkspaceCommitRequest,
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
      id: 'icon-style',
      category: 'appearance',
      label: 'Icon style',
      summary: 'symbols',
      value: 'symbols',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'glyph vocabulary',
      action: 'inspect',
      edit: {
        field: 'icon-style',
        primary: 'runtime',
        runtime: 'symbols',
        persisted: 'emoji',
        options: [
          { value: 'emoji', label: 'emoji', available: true, current: false },
          { value: 'symbols', label: 'symbols', available: true, current: true },
          { value: 'minimal', label: 'minimal', available: true, current: false },
        ],
      },
    },
    {
      id: 'footer-settings-legacy',
      category: 'appearance',
      label: 'Footer & status line…',
      summary: 'Existing settings editor',
      scope: 'Existing settings editor',
      freshness: 'ready',
      description: 'the existing editor owns the footer layout',
      action: 'open-legacy',
      legacyTargetId: 'footer',
    },
    {
      id: 'display-preset',
      category: 'conversation',
      label: 'Transcript display',
      summary: 'full',
      value: 'full',
      scope: 'Client runtime',
      freshness: 'runtime',
      description: 'display preset',
      action: 'inspect',
      edit: {
        field: 'display-preset',
        primary: 'runtime',
        runtime: 'full',
        persisted: 'full',
        options: [
          { value: 'full', label: 'full', available: true, current: true },
          { value: 'compact', label: 'compact', available: true, current: false },
        ],
      },
    },
    {
      id: 'expand',
      category: 'conversation',
      label: 'Transcript detail',
      summary: 'collapsed',
      value: 'collapsed',
      scope: 'Current TUI display state',
      freshness: 'runtime',
      description: 'bulk expansion for recent collapsible content',
      action: 'inspect',
      edit: {
        field: 'expand',
        primary: 'runtime',
        runtime: 'collapsed',
        persisted: 'not applicable — runtime-only',
        options: [
          { value: 'collapsed', label: 'collapsed', available: true, current: true },
          { value: 'expanded', label: 'expanded', available: true, current: false },
        ],
      },
    },
    {
      id: 'thinking',
      category: 'conversation',
      label: 'Thinking detail',
      summary: 'collapsed',
      value: 'collapsed',
      scope: 'Current TUI display state',
      freshness: 'runtime',
      description: 'reasoning blocks',
      action: 'inspect',
      edit: {
        field: 'thinking',
        primary: 'runtime',
        runtime: 'collapsed',
        persisted: 'not applicable — runtime-only',
        options: [
          { value: 'collapsed', label: 'collapsed', available: true, current: true },
          { value: 'expanded', label: 'expanded', available: true, current: false },
        ],
      },
    },
    {
      id: 'progress-updates',
      category: 'conversation',
      label: 'Progress updates',
      summary: 'milestones',
      value: 'milestones',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'mid-turn update cadence',
      action: 'inspect',
      edit: {
        field: 'progress-updates',
        primary: 'runtime',
        runtime: 'milestones',
        persisted: 'not set',
        options: [
          { value: 'off', label: 'off', available: true, current: false },
          { value: 'milestones', label: 'milestones', available: true, current: true },
          { value: 'frequent', label: 'frequent', available: true, current: false },
        ],
      },
    },
    {
      id: 'response-style',
      category: 'conversation',
      label: 'Response style',
      summary: 'default',
      value: 'default',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'visible-answer density',
      action: 'inspect',
      edit: {
        field: 'response-style',
        primary: 'runtime',
        runtime: 'default',
        persisted: 'default',
        options: [
          { value: 'default', label: 'default', available: true, current: true },
          { value: 'concise', label: 'concise', available: true, current: false },
          { value: 'explanatory', label: 'explanatory', available: true, current: false },
        ],
      },
    },
    {
      id: 'busy-enter',
      category: 'conversation',
      label: 'Submit while busy',
      summary: 'queue',
      value: 'queue',
      scope: 'TUI settings document · input preference',
      freshness: 'ready',
      description: 'what a plain Enter does while the agent is running',
      action: 'inspect',
      edit: {
        field: 'busy-enter',
        primary: 'persisted',
        runtime: 'Next busy Enter: queue',
        persisted: 'queue',
        options: [
          { value: 'queue', label: 'queue', available: true, current: true },
          { value: 'steer', label: 'steer', available: true, current: false },
        ],
      },
    },
    {
      id: 'git-attribution',
      category: 'conversation',
      label: 'Git attribution',
      summary: 'off',
      value: 'off',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'Git trailer prompt guidance',
      action: 'inspect',
      edit: {
        field: 'git-attribution',
        primary: 'runtime',
        runtime: 'off',
        persisted: 'off',
        options: [
          { value: 'off', label: 'off', available: true, current: true },
          { value: 'product', label: 'product', available: true, current: false },
          { value: 'product-model', label: 'product-model', available: true, current: false },
        ],
      },
    },
    {
      id: 'home-end-keys',
      category: 'input-terminal',
      label: 'Home/End keys',
      summary: 'input',
      value: 'input',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'Home/End navigation preset',
      action: 'inspect',
      edit: {
        field: 'home-end-keys',
        primary: 'runtime',
        runtime: 'input',
        persisted: 'input',
        options: [
          { value: 'input', label: 'input', available: true, current: true },
          { value: 'viewport', label: 'viewport', available: true, current: false },
        ],
      },
    },
    {
      id: 'fullscreen',
      category: 'input-terminal',
      label: 'Fullscreen',
      summary: 'off',
      value: 'off',
      scope: 'TUI settings document · Client screen mode',
      freshness: 'ready',
      description: 'Save preference, then leave Settings normally to switch the transcript screen.',
      action: 'inspect',
      edit: {
        field: 'fullscreen',
        primary: 'persisted',
        runtime: 'Current transcript mode: off (Settings lease is separate); applied after normal Settings close',
        persisted: 'off',
        options: [
          { value: 'off', label: 'off', available: true, current: true },
          { value: 'on', label: 'on', available: true, current: false },
        ],
      },
    },
    {
      id: 'wheel-scroll-lines',
      category: 'input-terminal',
      label: 'Mouse wheel lines',
      summary: '1 (next fullscreen entry)',
      value: '1 (next fullscreen entry)',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'wheel step for the next fullscreen entry',
      action: 'inspect',
      edit: {
        field: 'wheel-scroll-lines',
        primary: 'runtime',
        runtime: '1',
        persisted: '1',
        options: [
          { value: '1', label: '1', available: true, current: true },
          { value: '2', label: '2', available: true, current: false },
        ],
      },
    },
    {
      id: 'notification-mode',
      category: 'input-terminal',
      label: 'Notifications',
      summary: 'unfocused',
      value: 'unfocused',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'when a completion notifies',
      action: 'inspect',
      edit: {
        field: 'notification-mode',
        primary: 'runtime',
        runtime: 'unfocused',
        persisted: 'unfocused',
        options: [
          { value: 'unfocused', label: 'unfocused', available: true, current: true },
          { value: 'always', label: 'always', available: true, current: false },
          { value: 'off', label: 'off', available: true, current: false },
        ],
      },
    },
    {
      id: 'notification-method',
      category: 'input-terminal',
      label: 'Notification method',
      summary: 'auto',
      value: 'auto',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'how a completion notification is delivered',
      action: 'inspect',
      edit: {
        field: 'notification-method',
        primary: 'runtime',
        runtime: 'auto',
        persisted: 'auto',
        options: [
          { value: 'auto', label: 'auto', available: true, current: true },
          { value: 'bell', label: 'bell', available: true, current: false },
        ],
      },
    },
    {
      id: 'terminal-progress',
      category: 'input-terminal',
      label: 'Terminal progress',
      summary: '9;4+7501',
      value: '9;4+7501',
      scope: 'Client runtime · optional TUI preference persistence',
      freshness: 'runtime',
      description: 'terminal-native status protocols',
      action: 'inspect',
      edit: {
        field: 'terminal-progress',
        primary: 'runtime',
        runtime: '9;4+7501',
        persisted: '9;4+7501',
        options: [
          { value: '9;4+7501', label: '9;4+7501', available: true, current: true },
          { value: 'off', label: 'off', available: true, current: false },
        ],
      },
    },
    {
      id: 'agent-settings-legacy',
      category: 'agent',
      label: 'Agent settings…',
      summary: 'Existing settings editor',
      scope: 'Existing settings editor',
      freshness: 'ready',
      description: 'the existing editor owns the agent defaults',
      action: 'open-legacy',
      legacyTargetId: 'default-permission',
    },
    {
      id: 'input-terminal-settings-legacy',
      category: 'input-terminal',
      label: 'Input & terminal settings…',
      summary: 'Existing settings editor',
      scope: 'Existing settings editor',
      freshness: 'ready',
      description: 'the existing editor owns the input and terminal preferences',
      action: 'open-legacy',
      legacyTargetId: 'keyboard-shortcuts',
    },
    {
      id: 'visual-tools',
      category: 'tools',
      label: 'Visual tools',
      summary: 'On',
      scope: 'DSH Host profile · every agent on this Host',
      freshness: 'ready',
      description: 'profile-wide built-in tools switch',
      action: 'inspect',
    },
    {
      id: 'web-settings',
      category: 'tools',
      label: 'Web Search / Fetch',
      summary: 'Host',
      scope: 'Host Web provider settings',
      freshness: 'ready',
      description: 'Host-owned Web settings',
      action: 'open-legacy',
      legacyTargetId: 'web-search-provider',
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
  grantAwaitingPaint(): boolean {
    return false
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
  /** The exact legacy-editor target of every handoff, in order. */
  readonly legacyTargets: () => readonly (string | undefined)[]
  /** The settle callbacks of the dispatched writes, in order. */
  readonly settlements: readonly ((outcome: SettingsWorkspaceCommitOutcome) => void)[]
  /** Every commit request the panel really dispatched, in order. */
  readonly committed: readonly SettingsWorkspaceCommitRequest[]
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
  /** The snapshot seam (defaults to the static fixture). */
  readonly snapshot?: () => SettingsWorkspaceSnapshot
  /** The LIVE extension directory seam (`SettingsWorkspaceSource.extensionDirectory`). */
  readonly directory?: () => { readonly revision: number; readonly count: number }
} = {}): Harness {
  let columns = options.columns ?? 120
  let rows = options.rows ?? 40
  const built: FakePage[] = []
  const pluginPages: FakePluginPage[] = []
  const settlements: ((outcome: SettingsWorkspaceCommitOutcome) => void)[] = []
  let closes = 0
  let commits = 0
  const legacyTargets: (string | undefined)[] = []
  let legacyOpens = 0
  const committed: SettingsWorkspaceCommitRequest[] = []
  const intents: SettingsWorkspacePanelIntents = {
    aboutVersionFacts: { tui: '0.5.3', dsh: '0.2.1-rc.2' },
    rows: () => rows,
    columns: () => columns,
    requestRender: () => {},
    notice: () => undefined,
    onClose: () => { closes += 1 },
    onOpenLegacy: (targetId) => { legacyOpens += 1; legacyTargets.push(targetId) },
    ...(options.aboutStatusSource === undefined ? {} : { aboutStatusSource: options.aboutStatusSource }),
    onCopy: (text) => { options.onCopy?.(text) },
    onCommit: (request, settle) => {
      commits += 1
      committed.push(request)
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
  const readSnapshot = options.snapshot ?? ((): SettingsWorkspaceSnapshot => SNAPSHOT)
  const panel = new SettingsWorkspacePanel(
    options.directory === undefined
      ? { readSnapshot }
      : { readSnapshot, extensionDirectory: options.directory },
    intents,
  )
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
    legacyTargets: () => legacyTargets,
    committed,
    settlements,
  }
}

const plain = (harness: Harness, width = harness.columns()): string =>
  harness.panel.render(width).map(stripTerminalSequences).join('\n')

const header = (harness: Harness): string => plain(harness).split('\n')[0] ?? ''

/** The painted category order of the default fixture (no extension rows). */
const CATEGORY_ORDER = [
  'about', 'models', 'account', 'agent', 'appearance',
  'conversation', 'input-terminal', 'tools', 'plugins',
] as const

/**
 * Walk the rail from its About home to one category with the panel's REAL Down
 * key. The fixture has no extension rows, so the directory is always the nine
 * fixed categories.
 */
const walkTo = (h: Harness, category: (typeof CATEGORY_ORDER)[number]): void => {
  const target = CATEGORY_ORDER.indexOf(category)
  assert.ok(target >= 0, `the fixture must know ${JSON.stringify(category)}`)
  for (let index = 0; index < target; index += 1) h.panel.handleInput('\u001b[B')
}

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
    walkTo(h, 'appearance')
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
  walkTo(h, 'appearance')
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
  walkTo(legacy, 'appearance')
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
  walkTo(h, 'appearance')
  const frame = plain(h).split('\n')
  const y = frame.findIndex(line => line.includes('Icon style'))
  assert.ok(y >= 0, `the appearance row must be painted:\n${frame.join('\n')}`)
  const x = frame[y]!.indexOf('Icon style')
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
  walkTo(h, 'plugins')
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
  assert.match(frame, /Categories \(9\)/u, 'the rail is painted after the yield')
  assert.match(frame, /Esc close/u, 'the rail bar owns the last row after the yield')
  // Esc on the rail closes the Settings lease.
  h.panel.handleInput('\u001b')
  assert.equal(h.closes(), 1, 'the second Esc closes the workspace')
})

test('a real category change disposes the plugin page once; a focus yield never does', () => {
  const h = setup({ columns: 120, pluginPage: true })
  plain(h)
  walkTo(h, 'plugins')
  plain(h) // the visible preview mounts the ONE page
  assert.equal(h.pluginPages.length, 1)
  h.panel.handleInput('\t') // focus the plugin content
  plain(h)
  h.panel.handleInput('\u001b[Z') // Shift+Tab at the List root yields
  plain(h)
  assert.equal(h.pluginPages[0]!.disposed, false, 'a yield keeps the page instance alive')
  assert.equal(h.closes(), 0)
  // A REAL category change disposes it exactly once and never builds another.
  h.panel.handleInput('\u001b[A') // Plugins -> Tools
  plain(h)
  assert.equal(h.pluginPages[0]!.disposed, true, 'the real category change disposes the page')
  assert.equal(h.pluginPages.length, 1, 'the category change builds no second page')
})

test('a pending legacy write never advertises the direct rail Tab until it settles', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h)
  walkTo(h, 'appearance')
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

// ── PR3: the Legacy Copy verb is retired from every level/phase ────────────
//
// The Legacy configuration Detail no longer paints `Copy value [C]`, no longer
// advertises `c copy value`, and no `c`/`C` byte — raw, Kitty CSI-u or
// modifyOtherKeys — reaches the clipboard owner at ANY level or edit phase.
// The negative control is the CLIPBOARD SINK (not "no Host call") and every
// positive Legacy behavior (change/confirm/retry/legacy handoff) still runs.
test('PR3 Legacy rows never copy: no badge, no hint, no c/C clipboard at any level or phase', () => {
  const encodedCopyKeys = ['c', 'C', '\x1b[99u', '\x1b[99:67:99;2u', '\x1b[27;2;67~'] as const
  for (const columns of [72, 100, 120] as const) {
    const copied: string[] = []
    const h = setup({ columns, rows: 24, onCopy: text => { copied.push(text) } })
    // A narrow terminal opens on the About CONTENT: Esc returns to the rail.
    if (!/Settings · Categories/u.test(plain(h, columns).split('\n')[0] ?? '')) {
      h.panel.handleInput('\u001b')
      plain(h, columns)
    }
    assert.match(plain(h, columns).split('\n')[0] ?? '', /Settings · Categories/u, `the rail owns ${columns}`)
    walkTo(h, 'appearance')
    // L0 (rail), L1 (rows) and L2 (Detail) each refuse every copy byte.
    for (const data of encodedCopyKeys) h.panel.handleInput(data)
    assert.equal(copied.length, 0, `L0 copies nothing at ${columns}`)
    h.panel.handleInput('\r') // L0 -> L1
    for (const data of encodedCopyKeys) h.panel.handleInput(data)
    assert.equal(copied.length, 0, `L1 copies nothing at ${columns}`)
    // The browsing L2 (the level the retired `Copy value [C]` lived on) exists
    // only where Tab can re-focus the Detail pane WITHOUT opening the choice:
    // a narrow frame paints one region at a time. A narrow walk therefore goes
    // straight L1 -> choosing, which the case below covers at every width.
    if (columns >= 76) {
      h.panel.handleInput('\t')
      const browsing = plain(h, columns)
      assert.match(browsing.split('\n')[0] ?? '', /Appearance · Configured theme/u,
        `the Detail pane owns the keyboard at ${columns}:\n${browsing}`)
      assert.doesNotMatch(browsing, /Copy value \[C\]/u, `L2 paints no Copy value badge at ${columns}`)
      assert.doesNotMatch(browsing, /c copy value/u, `L2 advertises no copy verb at ${columns}`)
      // The retired verb is gone but the REAL Detail verbs are intact.
      const detailBar = browsing.split('\n').at(-1)!
      assert.match(detailBar, /r refresh/u, `the Detail refresh hint survives at ${columns}:\n${detailBar}`)
      assert.match(detailBar, /Left back/u, `the Detail back hint survives at ${columns}:\n${detailBar}`)
      // Every painted cell of the DETAIL pane (where the retired button lived)
      // is inert for a copy gesture. The sweep stays inside that pane so it
      // cannot navigate the rail.
      const detail = (h.panel as unknown as {
        paintedPanes: { detail?: { x: number; width: number; contentTop: number; contentRows: number } }
      }).paintedPanes.detail
      assert.ok(detail !== undefined, `the Detail pane is painted at ${columns}`)
      for (let row = detail.contentTop; row < detail.contentTop + Math.max(1, detail.contentRows); row += 1) {
        for (let col = detail.x; col < detail.x + detail.width; col += 4) {
          h.panel.onCellPress(col, row)
          h.panel.onCellClick(col, row)
          // Re-paint so a click that changed focus cannot leave the frame stale
          // for the next gesture in the sweep.
          plain(h, columns)
        }
      }
      for (const data of encodedCopyKeys) h.panel.handleInput(data)
      assert.equal(copied.length, 0, `no Detail cell or key copies at L2 ${columns}`)
    }

    // Choosing still needs the painted Confirm: the retry/confirm ladder and
    // the write path are untouched by the copy removal. This leg uses its own
    // harness so the cell sweep above cannot have moved the selection.
    const choosing = setup({ columns, rows: 24, onCopy: text => { copied.push(text) } })
    plain(choosing, columns)
    if (!/Settings · Categories/u.test(plain(choosing, columns).split('\n')[0] ?? '')) {
      choosing.panel.handleInput('\u001b')
      plain(choosing, columns)
    }
    walkTo(choosing, 'appearance')
    choosing.panel.handleInput('\r') // L0 -> L1
    choosing.panel.handleInput('\x1b[H') // Home: the first, writable Theme row
    const writes = choosing.commits()
    choosing.panel.handleInput('\r') // rows -> choosing (writable Theme row)
    assert.match(plain(choosing, columns), /Choose value/u, `Enter still opens the choice at ${columns}`)
    for (const data of encodedCopyKeys) choosing.panel.handleInput(data)
    assert.equal(copied.length, 0, `choosing copies nothing at ${columns}`)
    assert.match(plain(choosing, columns), /Choose value/u, 'the copy keys never dismiss the choice')
    choosing.panel.handleInput('\r') // explicit Confirm -> the ONE pending write
    assert.equal(choosing.commits(), writes + 1, `Confirm still dispatches exactly one write at ${columns}`)
  }
})

// ── PR3: About keeps keyboard c / C with the ONE body Copy All badge ──────
test('PR3 About: a visible selected fact copies with c, never from a per-fact badge; rail focus keeps only Shift+C', () => {
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: { kind: 'ready', sessionId: 'sess-pr3', title: 'pr3 proof', cwd: '/ws', context: 'fresh' },
    epoch: 5,
  }
  const copied: string[] = []
  const h = setup({
    columns: 120,
    rows: 40,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  const railFrame = plain(h, 120)
  assert.equal(railFrame.match(/Copy All \[C\]/gu)?.length, 1, 'the rail frame paints exactly one Copy All')
  assert.doesNotMatch(railFrame, /Copy \[C\]/u, 'no per-fact Copy badge on the rail frame')
  // A rail frame does not advertise the content key.
  assert.doesNotMatch(railFrame.split('\n').at(-1)!, /c copy fact/u, 'the rail never advertises c copy fact')
  // Lowercase c is inert on the rail; Shift+C copies the whole painted report.
  h.panel.handleInput('c')
  assert.equal(copied.length, 0, 'lowercase c is inert on the rail')
  h.panel.handleInput('C')
  assert.equal(copied.length, 1, 'Shift+C copies the whole report from the rail')
  assert.match(copied[0]!, /Session ID: sess-pr3/u)

  // Content focus: the bar advertises the fact key for a visible selection.
  h.panel.handleInput('\r')
  const contentBar = plain(h, 120).split('\n').at(-1)!
  assert.match(contentBar, /c copy fact/u, 'the content bar advertises c copy fact for a visible fact')
  assert.match(contentBar, /C copy all/u, 'the content bar advertises C copy all')
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), '0.5.3', 'c copies the selected visible fact raw value')

  // Selecting the Refresh action leaves no selected fact: c is inert, C stays.
  h.panel.handleInput('\x1b[F') // End: last fact
  h.panel.handleInput('\x1b[B') // ↓ past the last fact: the Refresh action
  const actionFrame = plain(h, 120)
  assert.match(actionFrame, /^ *> Refresh context \[R\]/mu, `the Refresh action is selected:\n${actionFrame}`)
  const before = copied.length
  h.panel.handleInput('c')
  assert.equal(copied.length, before, 'c is inert while the Refresh action is selected')
  assert.doesNotMatch(actionFrame.split('\n').at(-1)!, /c copy fact/u, 'the bar stops advertising c copy fact')
  h.panel.handleInput('C')
  assert.equal(copied.length, before + 1, 'C still copies the whole report')
})

test('PR3 About: a fact scrolled out of the viewport is not copyable until it is painted again', () => {
  const view: AboutStatusView = {
    runtime: { tui: '0.5.3', dsh: 'test', backend: 'direct' },
    session: {
      kind: 'ready',
      sessionId: 'sess-scroll',
      title: 'scroll proof',
      cwd: '/ws',
      context: 'fresh',
      stats: { lifetime: { turns: 3, steps: 4, llmMs: 5_000 } },
    },
    epoch: 6,
  }
  const copied: string[] = []
  const h = setup({
    columns: 100,
    rows: 20,
    aboutStatusSource: staticAboutSource(view),
    onCopy: text => { copied.push(text) },
  })
  plain(h, 100)
  h.panel.handleInput('\r') // rail -> About content
  h.panel.handleInput('\x1b[F') // End: the LAST fact
  plain(h, 100)
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'Fresh', 'the last fact copies while it is painted')
  // Wheel the projection up so the selected fact leaves the viewport.
  const box = (h.panel as unknown as { paintedContentBox?: { x: number; top: number; rows: number } }).paintedContentBox
  assert.ok(box !== undefined, 'the content box is recorded by the last frame')
  for (let step = 0; step < 2; step += 1) {
    h.panel.handleMouse({
      type: 'wheel',
      button: 'none',
      x: box.x + 2,
      y: box.top + 1,
      screenX: box.x + 2,
      screenY: box.top + 1,
      width: 100,
      height: 20,
      shift: false,
      alt: false,
      ctrl: false,
      wheelDelta: -5,
    })
  }
  const scrolled = plain(h, 100)
  assert.doesNotMatch(scrolled, /Observation/u, 'the selected fact really left the frame')
  const before = copied.length
  h.panel.handleInput('c')
  assert.equal(copied.length, before, 'c is inert while the selected fact is out of the viewport')
  assert.doesNotMatch(scrolled.split('\n').at(-1)!, /c copy fact/u, 'the bar stops advertising the fact key')
  // Scrolling back reveals it again and restores the grant.
  h.panel.handleInput('\x1b[F') // End reveals the last fact again
  plain(h, 100)
  h.panel.handleInput('c')
  assert.equal(copied.at(-1), 'Fresh', 'the revealed fact is copyable again')
})

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

// ── C3: no per-fact badge and no per-fact hit target ──────────────────────
test('C3 every fact paints without a Copy badge and has no hit target; keyboard c copies the selected value', () => {
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
    // The retired affix: no `Copy [C]` badge anywhere, not even a clipped one.
    // The single retained body affordance is `Copy All [C]`, which this short
    // viewport may scroll past (a long wrapped title pushes the action row out):
    // it is never duplicated and never replaced by per-fact badges.
    assert.equal(frame.some(line => line.includes('Copy [C]')), false, 'no per-fact Copy badge')
    assert.ok((frame.join('\n').match(/Copy All \[C\]/gu)?.length ?? 0) <= 1, 'at most one Copy All badge')
    // Neither the old last cell nor a sweep of the whole Title row copies.
    h.panel.onCellPress(43, titleRow)
    h.panel.onCellClick(43, titleRow)
    for (let col = 0; col < 44; col += 1) {
      h.panel.onCellPress(col, titleRow)
      h.panel.onCellClick(col, titleRow)
    }
    assert.equal(copied.length, 0, 'no fact cell is a copy target')
    // The keyboard `c` still copies the exact, complete source value.
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
  // Select Title (4 downs) for the single-field sink; the selection reveal is a
  // state change, so the frame that carries the copy grant is painted again.
  for (let step = 0; step < 4; step += 1) h.panel.handleInput('\x1b[B')
  plain(h, 44)
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

test('the legacy 90-column bars keep refresh when the region hints drop and never advertise a copy', () => {
  const h = setup({ columns: 90, rows: 24 })
  plain(h, 90)
  walkTo(h, 'appearance')
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
  assert.match(detailBar, /Left back/u)
  assert.doesNotMatch(detailBar, /copy/u, 'a Legacy Detail advertises no copy verb')
  // Retiring the copy segment frees whole-segment room: the region hints now
  // survive the same 90-column Detail bar they used to be dropped from.
  assert.match(detailBar, /Tab panes · Shift\+Tab back/u, 'the region hints keep the room the copy verb released')
})

// ── The shared chrome budget at the panel seam ────────────────────────────

test('the pane header names the keyboard owner at 80 and 120 columns', () => {
  for (const columns of [120, 80] as const) {
    const h = setup({ columns, rows: 24 })
    h.panel.handleInput('\u001b[B') // About -> Models: the rail keeps the keys
    const preview = plain(h, columns).split('\n')
    const previewPane = preview.findIndex(line => line.includes('[Categories (9)]'))
    assert.ok(previewPane >= 0, `the direct pane header paints at ${columns}:\n${preview.join('\n')}`)
    assert.match(preview[previewPane]!, /\[Categories \(9\)\].*Models/u,
      `the rail owns the active device:\n${preview[previewPane]}`)
    assert.doesNotMatch(preview[previewPane]!, /Rows \(/u, 'the direct pane header fakes no Rows pane')

    h.panel.handleInput('\r') // the content takes the keyboard, the page is reused
    const content = plain(h, columns).split('\n')
    const contentPane = content.findIndex(line => line.includes('Categories (9)'))
    assert.ok(contentPane >= 0)
    assert.match(content[contentPane]!, /Categories \(9\).*\[Models\]/u,
      `the page owns the active device:\n${content[contentPane]}`)

    // The legacy projection keeps its own pane names on the same shared row.
    const legacy = setup({ columns, rows: 24 })
    walkTo(legacy, 'appearance')
    const l0 = plain(legacy, columns).split('\n')
    const l0Pane = l0.findIndex(line => line.includes('[Categories (9)]'))
    assert.ok(l0Pane >= 0)
    assert.match(l0[l0Pane]!, /\[Categories \(9\)\].*Rows \(3\)/u)
    legacy.panel.handleInput('\t') // categories -> rows
    const l1 = plain(legacy, columns).split('\n')
    const l1Pane = l1.findIndex(line => line.includes('[Rows (3)]'))
    assert.ok(l1Pane >= 0, `the focused Rows header paints at ${columns}:\n${l1.join('\n')}`)
    assert.match(l1[l1Pane]!, /\[Rows \(3\)\].*Details/u)
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
  const paneRow = frame.findIndex(line => line.includes('Categories (9)'))
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

// ── C2-R0: the nine fixed categories + the conditional Extensions ─────────

/** One live extension-settings launcher, as the command layer builds it. */
const extensionRow = (target: string): SettingsWorkspaceSnapshot['rows'][number] => ({
  id: 'extension-settings-legacy',
  category: 'extensions',
  label: 'Configure extension settings…',
  summary: '1 setting · 1 contributor',
  scope: 'Existing settings editor',
  freshness: 'ready',
  description: 'extension registrations are edited by the existing settings editor',
  action: 'open-legacy',
  legacyTargetId: target,
})

/** The fixture at one registry directory state. */
const snapshotWithExtensions = (
  count: number,
  revision: number,
  target = 'ext-setting:demo',
): SettingsWorkspaceSnapshot => ({
  ...SNAPSHOT,
  extensionRevision: revision,
  extensionCount: count,
  rows: count > 0 ? [...SNAPSHOT.rows, extensionRow(target)] : SNAPSHOT.rows,
})

/** The labels the painted category RAIL really shows, in row order. */
const railLabels = (h: Harness): string[] => {
  const lines = plain(h).split('\n')
  const head = lines.findIndex(line => /Categories \(\d+\)/u.test(line))
  assert.ok(head >= 0, `the rail pane header must be painted:\n${plain(h)}`)
  const labels: string[] = []
  for (const line of lines.slice(head + 1)) {
    // Every rail cell starts with the cursor (`> `) or its 2-cell blank; the
    // physical last row is the root Action Bar and owns no rail cell.
    if (!/^(?:> | {2})/u.test(line)) continue
    const cell = line.slice(0, 22).trimEnd()
    if (cell === '') continue
    labels.push(cell.replace(/^(?:> | {2})/u, '').trim())
  }
  return labels
}

/** One native wheel event over a panel cell. */
const wheelAt = (h: Harness, x: number, y: number, delta = 1): void => {
  h.panel.handleMouse({
    type: 'wheel', button: 'none', x, y, screenX: x, screenY: y,
    width: h.columns(), height: h.rows(), shift: false, alt: false, ctrl: false, wheelDelta: delta,
  })
}

test('T01 the directory is the nine fixed categories with no Other settings and no Extensions', () => {
  const h = setup({ pluginPage: true })
  const frame = plain(h)
  assert.match(frame, /Categories \(9\)/u, 'the rail states the real category count')
  assert.deepEqual(railLabels(h), [
    'About', 'Models', 'Account', 'Agent', 'Appearance',
    'Conversation', 'Input & Terminal', 'Tools', 'Plugins',
  ], 'the fixed order is the frozen nine')
  assert.doesNotMatch(frame, /Other settings/u, 'no Other settings category exists')
  assert.doesNotMatch(frame, /Extensions/u, 'no Extensions category exists without live rows')
  // End reaches the LAST existing category, never a category the directory lacks.
  h.panel.handleInput('\u001b[F')
  assert.match(plain(h), /> Plugins/u, 'End selects the last real category')
  h.panel.handleInput('\r')
  assert.match(header(h), /Settings · Plugins/u, 'Enter opens the Plugins content, never Extensions')
  assert.equal(h.legacyOpens(), 0, 'reaching the rail end opens nothing')
})

test('T02 a live extension appends Extensions; browsing it never opens the editor or writes', () => {
  let count = 0
  let revision = 0
  const h = setup({
    directory: () => ({ revision, count }),
    snapshot: () => snapshotWithExtensions(count, revision),
  })
  plain(h)
  assert.match(plain(h), /Categories \(9\)/u, 'the empty directory paints nine categories')
  // A registration lands: the next frame appends Extensions without stealing
  // the selection, and the tenth category is reachable only after that paint.
  revision = 1
  count = 1
  const appended = plain(h)
  assert.match(appended, /Categories \(10\)/u, 'the frame that paints the registration states ten')
  assert.deepEqual(railLabels(h).at(-1), 'Extensions', 'Extensions is the appended last category')
  assert.match(appended, />\s*About/u, 'appending the category never steals the selection')
  h.panel.handleInput('\u001b[F')
  assert.match(plain(h), /> Extensions/u, 'End reaches the appended category')
  h.panel.handleInput('\r')
  const rows = plain(h)
  assert.match(header(h), /Settings · Extensions · Rows/u)
  assert.match(rows, /Configure extension settings…/u, 'the R0 transition row is painted')
  assert.match(rows, /Existing settings editor/u, 'the row states its transition scope')
  assert.equal(h.legacyOpens(), 0, 'reaching the row opens nothing')
  assert.equal(h.commits(), 0, 'reaching the row writes nothing')
  h.panel.handleInput('\t')
  plain(h)
  assert.equal(h.legacyOpens(), 0, 'a Tab focus change never opens the legacy editor')
  h.panel.handleInput('\u001b') // Detail -> Rows
  // Only the explicit activation of the painted row opens it, on the live first id.
  h.panel.handleInput('\r')
  assert.deepEqual(h.legacyTargets(), ['ext-setting:demo'], 'the launcher targets the registry first row')
  assert.equal(h.commits(), 0, 'the transition launcher is a navigation, never a write')
})

test('T03 display rows live in Conversation while Theme/Icon stay in Appearance', () => {
  const h = setup()
  plain(h)
  walkTo(h, 'conversation')
  const conversation = plain(h)
  assert.match(header(h), /Settings · Categories/u)
  assert.match(conversation, /Transcript display/u, 'display-preset moved to Conversation')
  assert.match(conversation, /Thinking detail/u, 'thinking moved to Conversation')
  assert.match(conversation, /Submit while busy/u, 'the busy-Enter policy is a Conversation row')
  assert.doesNotMatch(conversation, /More conversation settings…/u,
    'the migrated Conversation launcher is gone: no field remains behind it')
  assert.doesNotMatch(conversation, /Configured theme|Icon style/u, 'Theme/Icon never leak into Conversation')
  h.panel.handleInput('\u001b[H') // Home -> About
  walkTo(h, 'appearance')
  const appearance = plain(h)
  assert.match(appearance, /Configured theme/u)
  assert.match(appearance, /Icon style/u)
  assert.match(appearance, /Footer & status line…/u)
  assert.doesNotMatch(appearance, /Transcript display|Thinking detail/u, 'the retired display rows stay out')
  // The retired `display`/`other` ids are not categories any click can select:
  // the rail only ever publishes the CURRENT directory's ids.
  const ids = (h.panel as unknown as { paintedTargets: readonly { readonly kind: string; readonly id: string }[] }).paintedTargets
    .filter(target => target.kind === 'category')
    .map(target => target.id)
  assert.deepEqual(ids, [...CATEGORY_ORDER], 'the painted rail publishes exactly the current directory')
})

test('T04 Agent keeps its launcher while Input & Terminal ends on the Keyboard shortcuts handoff', () => {
  const h = setup()
  plain(h)
  walkTo(h, 'agent')
  assert.match(plain(h), /Agent settings…/u)
  h.panel.handleInput('\r')
  h.panel.handleInput('\r')
  assert.deepEqual(h.legacyTargets(), ['default-permission'], 'Agent opens the agent preset row')
  assert.equal(h.commits(), 0, 'a transition launcher never writes')

  const input = setup()
  plain(input)
  walkTo(input, 'input-terminal')
  const rows = plain(input)
  assert.match(rows, /Home\/End keys|Fullscreen|Mouse wheel lines/u,
    'the migrated Input & Terminal rows are painted')
  assert.match(rows, /Input & terminal settings…/u, 'the remaining Keyboard shortcuts handoff is last')
  // The launcher is the LAST row: walk the six writable rows before activating it.
  input.panel.handleInput('\r')
  for (let step = 0; step < 6; step += 1) input.panel.handleInput('\u001b[B')
  const detail = plain(input)
  assert.match(detail, /Existing settings editor/u, 'the handoff states its scope in a launcher row')
  input.panel.handleInput('\r')
  assert.deepEqual(input.legacyTargets(), ['keyboard-shortcuts'], 'Input & Terminal opens the shortcuts row')
  assert.equal(input.commits(), 0, 'the handoff itself writes nothing')
  assert.doesNotMatch(rows, /Choose value|\[Confirm\]/u, 'the launcher row paints no editor')
})

test('T05 a width cycle keeps the selected category/row/focus and refuses old coordinates', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h)
  walkTo(h, 'conversation')
  h.panel.handleInput('\r') // rail -> rows
  assert.match(header(h), /Settings · Conversation · Rows/u)
  h.panel.handleInput('\u001b[B') // the second Conversation row
  h.resize(44, 40)
  assert.match(header(h), /Settings · Conversation · Rows/u, 'the selected category/level survive 44 columns')
  h.resize(80, 24)
  assert.match(header(h), /Settings · Conversation · Rows/u, 'and survive the medium projection')
  h.resize(120, 40)
  const wide = plain(h)
  assert.match(header(h), /Settings · Conversation · Rows/u)
  // The long `Input & Terminal` label fits its 22-cell rail column whole and
  // never eats the neighbouring column.
  const railLine = wide.split('\n').find(line => line.includes('Input & Terminal'))
  assert.ok(railLine !== undefined, 'Input & Terminal is painted')
  assert.equal(railLine!.slice(0, 22).trimEnd().endsWith('…'), false, 'the label is not truncated')
  assert.equal(visibleWidth(railLine!.slice(0, 22)), 22, 'the rail keeps its exact 22 cells')
  // A press recorded against the WIDE frame cannot dispatch after a resize
  // whose repaint has not landed: the old coordinates are refused.
  const targetRow = plain(h).split('\n').findIndex(line => line.startsWith('  Agent'))
  assert.ok(targetRow >= 0)
  h.panel.onCellPress(3, targetRow)
  h.resize(44, 40)
  h.panel.onCellClick(3, targetRow)
  assert.match(header(h), /Settings · Conversation · Rows/u, 'the stale release activated nothing')
  assert.equal(h.commits(), 0)
  assert.equal(h.legacyOpens(), 0)
})

test('T06 losing the Extensions directory falls back to Plugins and refuses every stale gesture', () => {
  let count = 1
  let revision = 1
  const h = setup({
    columns: 120,
    rows: 40,
    pluginPage: true,
    directory: () => ({ revision, count }),
    snapshot: () => snapshotWithExtensions(count, revision),
  })
  plain(h)
  h.panel.handleInput('\u001b[F') // End -> Extensions
  assert.match(plain(h), /> Extensions/u)
  h.panel.handleInput('\r') // rows of Extensions
  assert.match(header(h), /Settings · Extensions · Rows/u)
  plain(h)
  // The registry empties AFTER the frame painted the launcher.
  revision = 2
  count = 0
  // Every gesture of the spent frame is refused BEFORE the repaint — Enter,
  // Tab, Right, Backspace and the wheel included.
  h.panel.handleInput('\r') // stale Enter
  h.panel.handleInput('\t') // stale Tab
  h.panel.handleInput('\u001b[C') // stale Right
  h.panel.handleInput('\u007f') // stale Backspace
  wheelAt(h, 3, 5)
  assert.equal(h.legacyOpens(), 0, 'no stale gesture opens the legacy editor')
  assert.equal(h.commits(), 0, 'no stale gesture writes')
  assert.match(header(h), /Settings · Categories/u, 'the recovery moved the keyboard to the rail')
  // The repaint shows the nine fixed categories with Plugins selected, never an
  // empty Extensions page.
  const recovered = plain(h)
  assert.match(recovered, /Categories \(9\)/u)
  assert.match(recovered, /> Plugins/u, 'Plugins is the stable fallback category')
  assert.doesNotMatch(recovered, /Extensions/u, 'the spent Extensions entry is gone')
  h.panel.handleInput('\u001b[F')
  assert.match(plain(h), /> Plugins/u, 'End cannot reach a category the directory lacks')
  // Registry 0 -> N again appends Extensions without stealing the selection.
  revision = 3
  count = 2
  const appended = plain(h)
  assert.match(appended, /Categories \(10\)/u)
  assert.match(appended, /> Plugins/u, 'the re-appended category never steals the selection')
  assert.doesNotMatch(appended, /Settings · Extensions/u, 'the keyboard stays on the rail')
})

test('T07 a same-count revision change refuses the old press until the new frame paints', () => {
  let target = 'ext-setting:first'
  let revision = 1
  const h = setup({
    columns: 120,
    rows: 40,
    directory: () => ({ revision, count: 1 }),
    snapshot: () => snapshotWithExtensions(1, revision, target),
  })
  plain(h)
  h.panel.handleInput('\u001b[F') // Extensions
  h.panel.handleInput('\r') // rows
  const frame = plain(h)
  const y = frame.split('\n').findIndex(line => line.includes('Configure extension settings…'))
  assert.ok(y >= 0, `the launcher row must be painted:\n${frame}`)
  const x = frame.split('\n')[y]!.indexOf('Configure extension settings…')
  // A press is recorded against the row the frame painted.
  h.panel.onCellPress(x + 1, y)
  // The owner is replaced by a DIFFERENT one under the same id: the count stays
  // 1 and only the registry revision moves.
  revision = 2
  target = 'ext-setting:second'
  // The release arrives before any repaint: same coordinates, same painted row,
  // but a registry generation that no longer exists.
  h.panel.onCellClick(x + 1, y)
  assert.equal(h.legacyOpens(), 0, 'the straddling release is refused')
  // The next frame publishes the NEW registry row, and a fresh gesture opens it.
  plain(h)
  const repainted = plain(h)
  const newY = repainted.split('\n').findIndex(line => line.includes('Configure extension settings…'))
  assert.ok(newY >= 0)
  const newX = repainted.split('\n')[newY]!.indexOf('Configure extension settings…')
  h.panel.onCellPress(newX + 1, newY)
  h.panel.onCellClick(newX + 1, newY)
  assert.deepEqual(h.legacyTargets(), ['ext-setting:second'], 'the repainted launcher opens the CURRENT row')
})

test('T08 a 44x8 frame scrolls and reveals the rail and never activates an off-screen row', () => {
  const h = setup({ columns: 44, rows: 8 })
  const first = plain(h, 44)
  assert.equal(first.split('\n').length, 8, 'the frame keeps its physical budget')
  // The narrow first frame is the About content: Esc returns to the rail.
  h.panel.handleInput('\u001b')
  const rail = plain(h, 44)
  assert.match(rail, /Settings · Categories/u)
  assert.ok(!rail.includes('Extensions'), 'no Extensions category is painted')
  // End reveals the last category; the earlier rows scroll out.
  h.panel.handleInput('\u001b[F')
  const end = plain(h, 44)
  assert.match(end, /> Plugins/u, 'End reveals the last category')
  assert.ok(!end.includes('  About'), 'the scrolled-out category is not painted')
  // The wheel cannot leave the directory, and no off-screen category is hittable.
  wheelAt(h, 3, 3, 5)
  h.panel.handleInput('\u001b[A')
  assert.match(plain(h, 44), /> Tools/u, 'Up moves from the revealed Plugins')
  // Two rows: only the truthful Esc fallback is painted, and nothing dispatches.
  h.resize(44, 2)
  const tiny = plain(h, 44)
  assert.equal(tiny.split('\n').length, 2)
  assert.match(tiny.split('\n').at(-1)!, /Esc/u, 'the shortest frame keeps the Esc fallback')
  h.panel.handleInput('\r')
  h.panel.handleInput('\t')
  h.panel.handleInput('\u001b[C')
  wheelAt(h, 3, 1)
  h.panel.onCellPress(3, 0)
  h.panel.onCellClick(3, 0)
  assert.equal(h.legacyOpens(), 0, 'no invisible row may open the legacy editor')
  assert.equal(h.commits(), 0, 'no invisible row may write')
})

// ── C2-R1: the five new writable rows ─────────────────────────────────────

/** Walk to one Conversation row by its painted label: the fixture's row list is
 *  the frozen order, so the walk presses the real Down key exactly as often as
 *  the label sits below the first row. */
const CONVERSATION_LABELS = [
  'Transcript display', 'Transcript detail', 'Thinking detail',
  'Progress updates', 'Response style', 'Submit while busy', 'Git attribution',
] as const

/** Walk to one Input & Terminal row by its painted label (the fixture order). */
const INPUT_TERMINAL_LABELS = [
  'Home/End keys', 'Fullscreen', 'Mouse wheel lines',
  'Notifications', 'Notification method', 'Terminal progress',
] as const

const walkToInputTerminalRow = (h: Harness, label: (typeof INPUT_TERMINAL_LABELS)[number]): void => {
  const target = INPUT_TERMINAL_LABELS.indexOf(label)
  assert.ok(target >= 0, `the fixture must know ${JSON.stringify(label)}`)
  walkTo(h, 'input-terminal')
  h.panel.handleInput('\r') // Categories -> Rows
  for (let step = 0; step < target; step += 1) h.panel.handleInput('\u001b[B')
  assert.match(plain(h), new RegExp(`> ${label}`, 'u'), `the ${label} row owns the selection`)
}

const walkToConversationRow = (h: Harness, label: (typeof CONVERSATION_LABELS)[number]): void => {
  const target = CONVERSATION_LABELS.indexOf(label)
  assert.ok(target >= 0, `the fixture must know ${JSON.stringify(label)}`)
  walkTo(h, 'conversation')
  h.panel.handleInput('\r') // Categories -> Rows
  for (let step = 0; step < target; step += 1) h.panel.handleInput('\u001b[B')
  assert.match(plain(h), new RegExp(`> ${label}`, 'u'), `the ${label} row owns the selection`)
}

test('Appearance holds Theme, Icon style and the Footer launcher only', () => {
  const h = setup()
  plain(h)
  walkTo(h, 'appearance')
  h.panel.handleInput('\r')
  const rows = plain(h)
  assert.match(rows, /Configured theme/u)
  assert.match(rows, /Icon style/u)
  assert.match(rows, /Footer & status line…/u)
  assert.doesNotMatch(rows, /Transcript display|Thinking detail|Progress updates|Response style/u,
    'the Conversation rows never leak into Appearance')
  assert.match(rows, /Rows \(3\)/u, 'the Appearance rows count is the real three')
})

test('Conversation keeps the frozen seven-row order', () => {
  const h = setup()
  plain(h)
  walkTo(h, 'conversation')
  h.panel.handleInput('\r')
  const frames: string[] = []
  for (let step = 0; step < CONVERSATION_LABELS.length; step += 1) {
    frames.push(plain(h))
    if (step < CONVERSATION_LABELS.length - 1) h.panel.handleInput('\u001b[B')
  }
  const labels = [...CONVERSATION_LABELS]
  // The rows pane paints the list itself, so the ORDER is read from the frame
  // that shows every row at once (120 columns keeps all of them inside the grant).
  const all = frames[0]!
  let previous = -1
  for (const label of labels) {
    const at = all.indexOf(label)
    assert.ok(at > previous, `${label} sits in its frozen position:\n${all}`)
    previous = at
  }
  assert.match(all, /Rows \(7\)/u, 'the Conversation rows count is the real seven')
})

test('browsing a writable row writes nothing; only an explicit Confirm dispatches', () => {
  for (const [label, field, category] of [
    ['Icon style', 'icon-style', 'appearance'],
    ['Transcript detail', 'expand', 'conversation'],
    ['Thinking detail', 'thinking', 'conversation'],
    ['Progress updates', 'progress-updates', 'conversation'],
    ['Response style', 'response-style', 'conversation'],
    // C2-R2: the two persist-first rows and the six apply-first rows share the
    // SAME choice/Confirm machinery, so browsing them must write nothing too.
    ['Submit while busy', 'busy-enter', 'conversation'],
    ['Git attribution', 'git-attribution', 'conversation'],
    ['Home/End keys', 'home-end-keys', 'input-terminal'],
    ['Fullscreen', 'fullscreen', 'input-terminal'],
    ['Mouse wheel lines', 'wheel-scroll-lines', 'input-terminal'],
    ['Notifications', 'notification-mode', 'input-terminal'],
    ['Notification method', 'notification-method', 'input-terminal'],
    ['Terminal progress', 'terminal-progress', 'input-terminal'],
  ] as const) {
    const h = setup({ columns: 120, rows: 40 })
    plain(h)
    if (field === 'icon-style') {
      walkTo(h, 'appearance')
      h.panel.handleInput('\r')
      h.panel.handleInput('\u001b[B') // Configured theme -> Icon style
    } else if (category === 'conversation') {
      walkToConversationRow(h, label as (typeof CONVERSATION_LABELS)[number])
    } else {
      walkToInputTerminalRow(h, label as (typeof INPUT_TERMINAL_LABELS)[number])
    }
    const atRows = plain(h)
    assert.match(atRows, new RegExp(label, 'u'), `the row is selected at ${label}`)
    assert.equal(h.commits(), 0, `selecting ${label} writes nothing`)
    // Enter opens the choice, further Downs move the candidate, Tab and Esc are
    // inert business-wise: none of them may write.
    h.panel.handleInput('\r')
    assert.match(plain(h), /Choose value/u, `${label} opens its explicit choice`)
    assert.equal(h.commits(), 0, `opening the ${label} choice writes nothing`)
    h.panel.handleInput('\u001b[B')
    plain(h) // every grant belongs to the frame that painted it
    h.panel.handleInput('\t')
    wheelAt(h, 3, 6, 1)
    assert.equal(h.commits(), 0, `moving/scrolling ${label} writes nothing`)
    h.panel.handleInput('\u001b') // cancel
    assert.doesNotMatch(plain(h), /Choose value/u, 'Esc cancels the choice without writing')
    assert.equal(h.commits(), 0, `cancelling ${label} writes nothing`)
    // The explicit Confirm is the ONE write.
    h.panel.handleInput('\r') // re-open the choice
    plain(h) // the confirm grant is published by the frame that painted it
    h.panel.handleInput('\r') // confirm
    assert.equal(h.commits(), 1, `the explicit Confirm dispatches ${field} exactly once`)
    assert.deepEqual(h.committed.map(request => request.field), [field], 'the request names the row own field')
  }
})

test('the confirm request carries the chosen candidate identity', () => {
  const h = setup({ columns: 120, rows: 40 })
  plain(h)
  walkToConversationRow(h, 'Progress updates')
  h.panel.handleInput('\r') // open the choice on the current candidate
  plain(h) // the candidate-navigation grant belongs to the frame that painted it
  h.panel.handleInput('\u001b[B') // milestones -> frequent
  plain(h) // the confirm grant belongs to the frame that painted the candidate
  h.panel.handleInput('\r')
  assert.equal(h.commits(), 1)
  assert.deepEqual(h.committed, [{ field: 'progress-updates', value: 'frequent' }],
    'the exact raw candidate identity is sent, with no revision fence on a document-shaped row')
  // A refusal is reported, and the row keeps the explicit retry affordance.
  h.settlements[0]!({ outcome: 'not-saved', reason: 'the document write was refused' })
  const refused = plain(h)
  assert.match(refused, /Not saved · the document write was/u, 'the real refusal reason is painted')
  assert.match(refused, /refused/u)
  assert.match(refused, /Retry save/u, 'the refused row offers the explicit retry')
  assert.equal(h.commits(), 1, 'painting the settlement dispatches nothing')
})

test('the runtime-only rows state that no document holds them', () => {
  for (const label of ['Transcript detail', 'Thinking detail'] as const) {
    const h = setup({ columns: 120, rows: 40 })
    plain(h)
    walkToConversationRow(h, label)
    assert.match(plain(h), /Persisted\s+not applicable — runtime-only/u,
      `${label} names its non-persistence instead of implying a save`)
  }
  const persisted = setup({ columns: 120, rows: 40 })
  plain(persisted)
  walkToConversationRow(persisted, 'Progress updates')
  assert.match(plain(persisted), /Persisted\s+not set/u, 'a persisted document row names its stored fact')
  // The primary fact of a document-shaped row IS its live runtime value.
  assert.match(plain(persisted), /Value\s+milestones/u, 'the row value stays the live runtime fact')
})

test('the five new rows expose no copy verb', () => {
  const copied: string[] = []
  for (const label of ['Transcript detail', 'Thinking detail', 'Progress updates', 'Response style'] as const) {
    const h = setup({ columns: 120, rows: 40, onCopy: text => { copied.push(text) } })
    plain(h)
    walkToConversationRow(h, label)
    h.panel.handleInput('\r') // Detail / choice
    for (const data of ['c', 'C']) h.panel.handleInput(data)
    assert.doesNotMatch(plain(h), /copy (?:value|fact)/u, `${label} advertises no copy verb`)
    assert.equal(h.commits(), 0, `the copy keys never write on ${label}`)
    h.panel.handleInput('\u001b')
    for (const data of ['c', 'C']) h.panel.handleInput(data)
    assert.equal(h.commits(), 0, `the copy keys never write the settled ${label} Detail`)
  }
  assert.deepEqual(copied, [], 'no configuration row copies anything')
})

test('T06b an app-driven fact reread that discovers an empty directory recovers before it paints', () => {
  let count = 1
  let revision = 1
  let snapshot = snapshotWithExtensions(count, revision)
  const h = setup({
    columns: 120,
    rows: 40,
    pluginPage: true,
    directory: () => ({ revision, count }),
    snapshot: () => snapshot,
  })
  plain(h)
  h.panel.handleInput('\u001b[F') // Extensions
  h.panel.handleInput('\r') // its rows
  assert.match(header(h), /Settings · Extensions · Rows/u)
  plain(h)
  // The registry empties and an unrelated app-driven reread (a write settle)
  // observes the new snapshot BEFORE any user key arrives.
  revision = 2
  count = 0
  snapshot = snapshotWithExtensions(count, revision)
  h.panel.rereadFacts()
  // The recovery is already committed: no empty Extensions page is planned and
  // the next frame paints the fixed nine with Plugins selected.
  assert.match(header(h), /Settings · Categories/u, 'the reread already moved the recovery')
  const frame = plain(h)
  assert.match(frame, /Categories \(9\)/u)
  assert.match(frame, /> Plugins/u, 'Plugins is the stable fallback')
  assert.doesNotMatch(frame, /Extensions/u, 'the spent category is gone')
  assert.equal(h.legacyOpens(), 0, 'the reread opened nothing')
})

// ── C2-R0 review fix: an unrelated registry change never cancels an edit ──

/** A writable row fixture whose candidate source can be re-read after a
 *  directory change (the live registry is what moves in production). */
const withDirectory = (revision: number, count: number): SettingsWorkspaceSnapshot => ({
  ...SNAPSHOT,
  extensionRevision: revision,
  extensionCount: count,
})

test('an unrelated registry change keeps an open candidate choice and its scroll, and only revokes the frame', () => {
  // The production source reads the live registry ONCE per snapshot, so the
  // fixture does the same: `extensionRevision`/`extensionCount` always describe
  // the current directory and the row list it was assembled with.
  let revision = 1
  let count = 0
  let extraRows: SettingsWorkspaceSnapshot['rows'] = []
  const snapshot = (): SettingsWorkspaceSnapshot => ({
    ...SNAPSHOT,
    extensionRevision: revision,
    extensionCount: count,
    rows: [...SNAPSHOT.rows, ...extraRows],
  })
  const h = setup({
    columns: 120,
    rows: 40,
    directory: () => ({ revision, count }),
    snapshot,
  })
  plain(h)
  walkTo(h, 'appearance')
  h.panel.handleInput('\r') // L0 -> L1
  h.panel.handleInput('\r') // L1 -> the Theme choice
  assert.match(plain(h), /Choose value/u, 'the Theme choice is open')
  h.panel.handleInput('\u001b[B') // move to the second candidate (`dark`)
  assert.match(plain(h), /> dark\s+\[current\]/u, 'the second candidate is highlighted')
  // An UNRELATED registry change: a plugin registers a settings row.
  revision = 2
  count = 1
  extraRows = [extensionRow('ext-setting:other')]
  const afterRegister = plain(h)
  // The frame is re-proved against the new directory, but the user's business
  // state is intact: same level, same candidate, same scroll.
  assert.match(afterRegister, /Settings · Appearance · Configured theme/u, 'the choice level survives')
  assert.match(afterRegister, /Choose value/u, 'the open Theme choice is NOT cancelled')
  assert.match(afterRegister, /> dark\s+\[current\]/u, 'the highlighted candidate is unchanged')
  assert.equal(h.commits(), 0, 'no write happened')
  // A `setValue()` on the unrelated row: count stays 1 and only the revision moves.
  revision = 3
  const afterSetValue = plain(h)
  assert.match(afterSetValue, /Choose value/u, 'a same-count revision change also keeps the choice')
  assert.match(afterSetValue, /> dark\s+\[current\]/u, 'the candidate stays selected')
  // The preserved choice still confirms through the one write channel.
  h.panel.handleInput('\r')
  assert.equal(h.commits(), 1, 'the preserved choice still dispatches exactly one write')
  assert.equal(h.legacyOpens(), 0, 'no registry change opened the legacy editor')
})

test('a registry change that drops the chosen candidate identity drops the choice', () => {
  let revision = 1
  let options = [
    { value: 'auto', label: 'auto', available: true, current: false },
    { value: 'dark', label: 'dark', available: true, current: true },
  ]
  const snapshotOf = (): SettingsWorkspaceSnapshot => ({
    ...withDirectory(revision, 1),
    rows: [
      {
        ...SNAPSHOT.rows[0]!,
        edit: {
          field: 'theme',
          primary: 'runtime',
          runtime: 'dark',
          persisted: 'dark',
          options,
        },
      },
      extensionRow('ext-setting:other'),
    ],
  })
  let snapshot = snapshotOf()
  const h = setup({
    columns: 120,
    rows: 40,
    directory: () => ({ revision, count: 1 }),
    snapshot: () => snapshot,
  })
  plain(h)
  walkTo(h, 'appearance')
  h.panel.handleInput('\r')
  h.panel.handleInput('\r') // the choice, on `dark` (the current candidate)
  assert.match(plain(h), /> dark\s+\[current\]/u)
  // The chosen candidate's SOURCE disappears under the open choice.
  revision = 2
  options = [
    { value: 'auto', label: 'auto', available: true, current: true },
    { value: 'plugin:gone/theme', label: 'Gone theme', available: false, current: false },
  ]
  snapshot = snapshotOf()
  const after = plain(h)
  assert.doesNotMatch(after, /Choose value/u, 'a vanished candidate cannot keep painting a confirm')
  assert.match(after, /Settings · Appearance · Configured theme/u, 'the row stays selected')
  h.panel.handleInput('\r')
  assert.equal(h.commits(), 0, 'the dropped choice cannot dispatch a write')
})

test('losing the Extensions category still repairs the selection and its offsets', () => {
  let revision = 1
  let count = 1
  let snapshot: SettingsWorkspaceSnapshot = {
    ...withDirectory(revision, count),
    rows: [...SNAPSHOT.rows, extensionRow('ext-setting:demo')],
  }
  const h = setup({
    columns: 120,
    rows: 40,
    pluginPage: true,
    directory: () => ({ revision, count }),
    snapshot: () => snapshot,
  })
  plain(h)
  h.panel.handleInput('\u001b[F') // Extensions
  h.panel.handleInput('\r') // its Rows level
  assert.match(header(h), /Settings · Extensions · Rows/u)
  plain(h)
  revision = 2
  count = 0
  snapshot = withDirectory(revision, count)
  const recovered = plain(h)
  assert.match(header(h), /Settings · Categories/u, 'the recovery moved the keyboard to the rail')
  assert.match(recovered, /^> Plugins/mu, 'Plugins is the stable fallback category')
  assert.match(recovered, /Categories \(9\)/u)
  assert.doesNotMatch(recovered, /Extensions/u)
  // The repaired selection really owns the next key: Down from Plugins is
  // clamped, Up moves the CATEGORY, proving the rail — not a stale row — owns it.
  h.panel.handleInput('\u001b[A')
  assert.match(plain(h), /^> Tools/mu, 'the rail owns the keyboard after the repair')
  assert.equal(h.legacyOpens(), 0)
})
