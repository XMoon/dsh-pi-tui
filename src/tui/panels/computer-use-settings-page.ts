/**
 * The `Settings → Tools → Computer Use` specialist page (PR-5 / MAC-09 v2).
 *
 * ONE embedded page inside the existing Settings workspace lease: it paints
 * the official bundle state, the two independent macOS privileges, the helper
 * identity, the PTC facts and the persisted application decisions. Every
 * action forwards to the per-open {@link CuaAccessSettingsController}; the page
 * owns only transient presentation state (cursor, free scroll, confirmation,
 * help) and dies with the page instance.
 *
 * Safety rules pinned here:
 *  - a dispatched action requires the CURRENT painted frame (controller
 *    revision/epoch identity) and a live re-read of the action's target;
 *  - the controller rejects a second action while one is in flight;
 *  - a confirmation is its OWN projection: the risk text must be fully visible
 *    before y/Enter/confirm is paintable or dispatchable;
 *  - the body scrolls freely (wheel/keys); the selected action is only revealed
 *    when the user moves it, never by an automatic jump on the first frame;
 *  - hit targets are the exact semantic label cells, never the fitted padding.
 *
 * @module @xmoon76/dsh-pi-tui/tui/panels/computer-use-settings-page
 */

import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@xmoon76/pi-tui'
import { runDetached } from '../../runtime/process/tasks.ts'
import type { Diag } from '../../runtime/process/diagnostics.ts'
import type {
  CuaAccessSettingsController,
  CuaAccessSettingsSnapshot,
  CuaReadState,
} from '../../app/command/cua-access-settings.ts'
import type { CuaApplicationFact, CuaPermission, CuaSystemStatus } from '../../runtime/cua-access-port.ts'
import { layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { color } from '../theme/runtime.ts'
import type { EmbeddedSpecialistPage } from './settings-workspace-panel.ts'

/** The page title (also the Tools row label and breadcrumb tail). */
export const COMPUTER_USE_PAGE_TITLE = 'Computer Use'

type PageActionKind =
  | 'refresh'
  | 'help'
  | 'preset'
  | 'request-accessibility'
  | 'open-accessibility'
  | 'request-screen-recording'
  | 'open-screen-recording'
  | 'persistent-ptc'
  | 'revoke'
  | 'retry'
  | 'plugins'

interface PageAction {
  readonly id: string
  readonly kind: PageActionKind
  readonly label: string
  readonly enabled: boolean
  readonly reason?: string
  readonly permission?: CuaPermission
  readonly applicationId?: string
  readonly applicationLabel?: string
}

interface PageLine {
  readonly text: string
  readonly action?: PageAction
}

interface Confirmation {
  readonly action: PageAction
  readonly title: string
  readonly body: string
  readonly confirm: string
  readonly epoch: number
  readonly offset: number
}

interface PaintedTarget {
  readonly row: number
  readonly startCol: number
  readonly endCol: number
  readonly action: PageAction
}

interface Paint {
  readonly width: number
  readonly rows: number
  readonly identity: string
  readonly targets: readonly PaintedTarget[]
  readonly barSpans: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[]
  readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
}

const HELP_LINES = [
  'Why two permissions? Accessibility reads and operates UI controls; Screen Recording captures the selected application window. They are separate and neither implies the other.',
  'Which .app should I authorize? The official helper named above (DSH Computer Use.app), not tmux, Terminal, an editor, or the Client machine\'s shell.',
  'I opened the TUI on another computer. The permission prompts belong to the Host Mac. The Client machine cannot grant them.',
  'Is the macOS automation list relevant? No. Automation/Apple Events permission is a different control path; it is not the official Computer Use helper permission.',
  'Request did not make it Allowed. The Request action only asks the Host provider to open its guidance. Complete the macOS prompt on the Host Mac, then Refresh and read the fresh observation.',
  'What is the difference between revoking an application and disabling the bundle? Revoke removes that persisted application decision; disabling the bundle removes the Computer Use provider from this profile and stops new CUA calls. Neither clears macOS TCC permissions.',
]

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const clamped = truncateToWidth(text, width, '…', false)
  const padding = width - visibleWidth(clamped)
  return padding > 0 ? clamped + ' '.repeat(padding) : clamped
}

/** Wrap one physical text line by display cells; long unbreakable tokens split. */
function wrapText(text: string, width: number): string[] {
  if (width <= 0) return ['']
  const clean = sanitizedPhysicalLine(text)
  if (clean === '') return ['']
  const lines: string[] = []
  let current = ''
  for (const char of clean) {
    if (visibleWidth(current + char) > width) {
      lines.push(current)
      current = char
    } else {
      current += char
    }
  }
  lines.push(current)
  return lines
}

function readPhaseText<T>(read: CuaReadState<T>, fallback = 'Unknown'): string {
  switch (read.phase) {
    case 'idle': return 'Not read'
    case 'loading': return 'Reading…'
    case 'disabled': return 'Not queried (bundle disabled)'
    case 'unavailable': return 'Unavailable'
    case 'failed': return 'Read failed'
    case 'unknown': return 'Unknown'
    case 'ready': return fallback
  }
}

function permissionText(allowed: boolean): string {
  return allowed ? 'Allowed' : 'Not allowed'
}

function bundleSummary(snapshot: CuaAccessSettingsSnapshot): string {
  const bundle = snapshot.bundle
  switch (bundle.phase) {
    case 'idle': return 'Not read'
    case 'loading': return 'Reading…'
    case 'disabled': return 'Disabled'
    case 'unknown': return `Unknown${bundle.reason === undefined ? '' : ` (${bundle.reason})`}`
    case 'ready':
      if (!bundle.enabled) return 'Disabled'
      return bundle.providerReady
        ? 'Enabled (selection saved; provider reads below)'
        : `Enabled (provider unavailable: ${bundle.error ?? bundle.reason ?? 'unknown'})`
  }
}

function systemOf(snapshot: CuaAccessSettingsSnapshot): CuaSystemStatus | undefined {
  return snapshot.system.phase === 'ready' ? snapshot.system.value : undefined
}

function platformName(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  return status.platform === 'darwin' ? 'macOS' : 'Unsupported platform (win32)'
}

/** The official launch/responsible application; never the helper executable. */
function responsibleApplication(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown (no observation yet)'
  if (status.platform === 'win32') return 'Unsupported platform'
  return status.launchApplication === undefined
    ? 'Not reported by macOS (responsibility unknown)'
    : `${status.launchApplication.name} · ${status.launchApplication.path}`
}

function helperIdentity(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  return status.platform === 'win32'
    ? `${status.helper.name ?? 'helper'} · pid ${String(status.helper.pid)}`
    : `${status.helper.name ?? 'DSH Computer Use'} · pid ${String(status.helper.pid)}`
}

function applicationLine(application: CuaApplicationFact): string {
  return application.executablePath === undefined
    ? sanitizedPhysicalLine(application.name)
    : `${sanitizedPhysicalLine(application.name)} · ${sanitizedPhysicalLine(application.executablePath)}`
}

/** ONE embedded page; constructed only when the Settings lease opens it. */
export class ComputerUseSettingsPage implements EmbeddedSpecialistPage {
  private readonly controller: CuaAccessSettingsController
  private readonly requestRender: () => void
  private readonly done: () => void
  private readonly openPlugins: (() => void) | undefined
  private readonly diag: Diag
  private readonly unsubscribe: () => void

  readonly title = COMPUTER_USE_PAGE_TITLE
  focused = false

  private rowGrant = 1
  private grantAwaitingPaintValue = true
  private cursor = 0
  private offset = 0
  private contentLength = 0
  private confirmation: Confirmation | undefined
  private confirmationVisible = false
  private help = false
  private notice: { readonly kind: 'info' | 'error'; readonly text: string } | undefined
  private revision = 0
  private disposed = false
  private paint: Paint | undefined
  private paintedActions: readonly PageAction[] = []
  private paintedActionRows: readonly number[] = []
  private visibleActions = new Set<PageAction>()
  private pressed: { readonly identity: string; readonly action: PageAction } | undefined
  private paintedEscapeSpanValue: { readonly startCol: number; readonly endCol: number } | undefined
  private paintedBarSpansValue: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] = []

  constructor(intents: {
    readonly controller: CuaAccessSettingsController
    readonly requestRender: () => void
    readonly done: () => void
    readonly openPlugins?: () => void
    readonly diag: Diag
  }) {
    this.controller = intents.controller
    this.requestRender = intents.requestRender
    this.done = intents.done
    this.openPlugins = intents.openPlugins
    this.diag = intents.diag
    this.unsubscribe = this.controller.subscribe(() => {
      this.revision += 1
      this.requestRender()
    })
    this.start('computer use settings refresh', () => this.controller.refresh())
  }

  /**
   * Start one controller intent from a synchronous input/paint handler.
   *
   * The handler cannot await, so the intent becomes a detached task with a real
   * owner: a failure reaches the runner diagnostics instead of becoming an
   * unhandled rejection, while the controller still publishes the action's own
   * outcome (ok / failed / unknown) into the snapshot.
   */
  private start(label: string, intent: () => Promise<void>): void {
    runDetached(label, intent, { diag: this.diag })
  }

  setMaxRows(rows: number): void {
    const next = Math.max(1, Math.floor(rows))
    if (next === this.rowGrant) return
    this.rowGrant = next
    this.grantAwaitingPaintValue = true
    this.paintedBarSpansValue = []
    this.paintedEscapeSpanValue = undefined
    this.pressed = undefined
  }

  grantAwaitingPaint(): boolean {
    return this.grantAwaitingPaintValue
  }

  pointerFrameCurrent(): boolean {
    return this.paint !== undefined && this.paint.identity === this.gestureIdentity()
  }

  paintedEscapeSpan(): { readonly startCol: number; readonly endCol: number } | undefined {
    return this.paintedEscapeSpanValue
  }

  paintedBarSpans(): readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] {
    return this.paintedBarSpansValue
  }

  activateBarSpan(id: string): void {
    if (!this.frameCurrent()) return
    const span = this.paintedBarSpansValue.find(candidate => candidate.id === id)
    if (span === undefined) return
    if (id === 'bar:refresh') this.runAction({ id: 'refresh', kind: 'refresh', label: 'Refresh', enabled: true })
    else if (id === 'bar:help') this.runAction({ id: 'help', kind: 'help', label: 'Help', enabled: true })
    else if (id === 'bar:confirm') this.confirmCurrent()
    else if (id === 'bar:cancel') this.cancelConfirmation()
  }

  gestureIdentity(): string {
    return [
      'computer-use',
      this.title,
      this.revision,
      this.cursor,
      this.offset,
      this.help ? 'help' : 'no-help',
      this.confirmation?.title ?? 'no-confirm',
      this.confirmation?.offset ?? 0,
      this.notice?.text ?? 'no-notice',
    ].join('|')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    const current = this.frameCurrent()
    if (this.notice !== undefined) {
      this.notice = undefined
      this.bump()
      if (matchesKey(data, 'escape')) return
      if (!current) return
    }
    if (this.confirmation !== undefined) {
      if (matchesKey(data, 'escape') || data === 'n' || data === 'N') {
        this.cancelConfirmation()
        return
      }
      if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
        if (!current) return
        if (!this.confirmationVisible) {
          this.notice = { kind: 'info', text: 'Resize so the full confirmation risk is visible before confirming.' }
          this.bump()
          return
        }
        this.confirmCurrent()
        return
      }
      if (matchesKey(data, 'up')) {
        this.scrollConfirmation(-1)
        return
      }
      if (matchesKey(data, 'down')) {
        this.scrollConfirmation(1)
        return
      }
      if (matchesKey(data, 'pageDown')) {
        this.scrollConfirmation(Math.max(1, this.rowGrant - 2))
        return
      }
      if (matchesKey(data, 'pageUp')) {
        this.scrollConfirmation(-Math.max(1, this.rowGrant - 2))
        return
      }
      return
    }
    if (matchesKey(data, 'escape')) {
      if (this.help) {
        this.help = false
        this.bump()
        return
      }
      this.done()
      return
    }
    if (!current) return
    // Keyboard access to the WHOLE scrollport (Help/receipts appended after the
    // last action); arrow keys still move only the action cursor.
    if (matchesKey(data, 'pageDown')) {
      this.scroll(Math.max(1, this.rowGrant - 2))
      return
    }
    if (matchesKey(data, 'pageUp')) {
      this.scroll(-Math.max(1, this.rowGrant - 2))
      return
    }
    if (matchesKey(data, 'home')) {
      this.offset = 0
      this.bump()
      return
    }
    if (matchesKey(data, 'end')) {
      this.offset = Math.max(0, this.contentLength)
      this.scroll(0)
      return
    }
    if (matchesKey(data, 'up')) {
      this.move(-1)
      return
    }
    if (matchesKey(data, 'down')) {
      this.move(1)
      return
    }
    if (matchesKey(data, 'enter') || matchesKey(data, 'right')) {
      const action = this.paintedActions[this.cursor]
      if (action === undefined || !this.visibleActions.has(action)) return
      this.runAction(action)
      return
    }
    if (data === 'r' || data === 'R') {
      this.runAction({ id: 'refresh', kind: 'refresh', label: 'Refresh', enabled: true })
      return
    }
    if (data === '?' || data === 'h' || data === 'H') {
      this.runAction({ id: 'help', kind: 'help', label: 'Help', enabled: true })
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return undefined
    const paint = this.paint
    if (paint === undefined || paint.width !== event.width) return undefined
    const bodyRows = Math.max(0, paint.rows - 1)
    if (event.type === 'wheel') {
      if (event.wheelDelta === undefined || event.wheelDelta === 0) return undefined
      if (event.y < 0 || event.y >= bodyRows) return undefined
      if (!this.frameCurrent()) return undefined
      this.scroll(event.wheelDelta < 0 ? -3 : 3)
      return { handled: true }
    }
    if (event.height !== bodyRows && event.height !== paint.rows) return undefined
    if (!this.frameCurrent()) return undefined
    const target = paint.targets.find(candidate => candidate.row === event.y
      && event.x >= candidate.startCol && event.x < candidate.endCol)
    if (event.type === 'press') {
      if (target === undefined) return undefined
      this.pressed = { identity: paint.identity, action: target.action }
      return { handled: true }
    }
    if (event.type === 'click') {
      const pressed = this.pressed
      this.revokePress()
      if (pressed === undefined || pressed.identity !== paint.identity) return undefined
      if (target === undefined || target.action.id !== pressed.action.id) return undefined
      this.runAction(target.action)
      return { handled: true }
    }
    return undefined
  }

  paneHeader(width: number): string {
    return fit(color.textStrong(`Computer Use ${color.textMuted('· official provider')}`), width)
  }

  invalidate(): void {
    this.bump()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe()
    this.controller.close()
    this.paint = undefined
    this.pressed = undefined
    this.paintedActions = []
    this.visibleActions.clear()
    this.paintedBarSpansValue = []
    this.paintedEscapeSpanValue = undefined
  }

  render(width: number): string[] {
    const snapshot = this.controller.getSnapshot()
    this.grantAwaitingPaintValue = false
    const bodyRows = Math.max(0, this.rowGrant - 1)
    let all: PageLine[]
    let confirmationVisible = false
    if (this.confirmation === undefined) {
      all = this.buildContent(snapshot, width)
    } else {
      // The long hint is the conservative probe; the short confirm hint is
      // only used when that SAME frame's full text (including the long hint)
      // fits. Body hint, confirm bar and painted rows therefore agree.
      const probe = this.buildConfirmation(width, 'long')
      confirmationVisible = probe.length <= bodyRows
      all = confirmationVisible ? this.buildConfirmation(width, 'short') : probe
    }
    this.confirmationVisible = confirmationVisible
    this.contentLength = all.length
    const actionLines = all
      .map((line, index) => line.action === undefined ? undefined : { line, index, action: line.action })
      .filter((candidate): candidate is { line: PageLine; index: number; action: PageAction } => candidate !== undefined)
    this.paintedActions = actionLines.map(candidate => candidate.action)
    this.paintedActionRows = actionLines.map(candidate => candidate.index)
    this.cursor = this.confirmation === undefined
      ? Math.max(0, Math.min(this.cursor, Math.max(0, this.paintedActions.length - 1)))
      : 0
    if (this.confirmation !== undefined) {
      const maxOffset = Math.max(0, all.length - bodyRows)
      this.confirmation = { ...this.confirmation, offset: Math.max(0, Math.min(this.confirmation.offset, maxOffset)) }
    }
    const activeOffset = this.confirmation?.offset ?? this.offset
    const maxOffset = Math.max(0, all.length - bodyRows)
    const offset = Math.max(0, Math.min(activeOffset, maxOffset))
    if (this.confirmation === undefined) this.offset = offset
    const visible = all.slice(offset, offset + Math.max(0, bodyRows))
    while (visible.length < Math.max(0, bodyRows)) visible.push({ text: '' })
    const selected = this.paintedActions[this.cursor]
    this.visibleActions = new Set(visible.flatMap(line => line.action === undefined ? [] : [line.action]))
    const targets: PaintedTarget[] = []
    const out: string[] = []
    for (let index = 0; index < visible.length; index += 1) {
      const line = visible[index]!
      const semantic = line.action !== undefined && line.action === selected
        ? `> ${line.text.trimStart()}`
        : line.text
      out.push(fit(semantic, width))
      if (line.action === undefined) continue
      // The semantic label, NOT the fit() right padding, is the pointer grant.
      const start = semantic.lastIndexOf('[')
      const close = start < 0 ? -1 : semantic.indexOf(']', start)
      if (start < 0 || close < 0) continue
      const startCol = visibleWidth(semantic.slice(0, start))
      const endCol = visibleWidth(semantic.slice(0, close + 1))
      // The closing bracket must itself be inside the granted width; a target
      // derived from the untruncated string would otherwise accept cells that
      // paint an ellipsis instead of the action label.
      if (endCol > width || startCol >= width) continue
      targets.push({ row: index, startCol, endCol, action: line.action })
    }
    const bar = this.renderBar(width, snapshot)
    this.paintedEscapeSpanValue = bar.escapeSpan
    this.paintedBarSpansValue = bar.spans
    out.push(fit(bar.text, width))
    this.paint = {
      width,
      rows: this.rowGrant,
      identity: this.gestureIdentity(),
      targets,
      barSpans: bar.spans,
      ...(bar.escapeSpan === undefined ? {} : { escapeSpan: bar.escapeSpan }),
    }
    return out.slice(0, this.rowGrant)
  }

  // ── content projections ──────────────────────────────────────────────────

  private buildContent(snapshot: CuaAccessSettingsSnapshot, width: number): PageLine[] {
    const lines: PageLine[] = []
    const push = (text: string): void => { lines.push({ text }) }
    const pushText = (text: string): void => {
      for (const part of wrapText(text, width)) lines.push({ text: part })
    }
    const pushAction = (text: string, action: PageAction): void => { lines.push({ text, action }) }
    const busy = snapshot.busy
    const bundle = snapshot.bundle
    const providerReady = bundle.phase === 'ready' && bundle.enabled && bundle.providerReady

    if (this.rowGrant <= 9) {
      // The short/narrow first screen: page identity, Host+bundle and the first
      // missing permission/action remain reachable; the bar is the last line.
      const shortBundle = bundle.phase === 'ready' && bundle.enabled
        ? (bundle.providerReady ? 'Enabled' : 'Enabled · provider unavailable')
        : bundleSummary(snapshot)
      pushText(`Computer Use · ${shortBundle}`)
      pushText(`Host: ${platformName(systemOf(snapshot))} · ${providerReady ? 'official provider' : (bundle.error ?? bundle.reason ?? 'provider unavailable')}`)
      if (!providerReady) {
        pushText('Open Settings → Plugins to enable the official bundle, then return here.')
        pushAction('  [Open Settings → Plugins]', { id: 'plugins', kind: 'plugins', label: 'Open Settings Plugins', enabled: !busy })
        return lines
      }
      const system = systemOf(snapshot)
      if (system?.platform === 'darwin') {
        // The compact grant fits ONE permission pair, so it must spend those rows
        // on the FIRST MISSING one: a granted permission with a `[Refresh
        // permission]` action would hide the permission that is still missing.
        const firstMissing = !system.accessibility
          ? 'accessibility' as const
          : !system.screenRecording
            ? 'screenRecording' as const
            : undefined
        const painted = firstMissing ?? 'accessibility'
        const allowed = painted === 'accessibility' ? system.accessibility : system.screenRecording
        push(`${painted === 'accessibility' ? 'Accessibility' : 'Screen Recording'}: ${permissionText(allowed)}`)
        pushAction(`  ${allowed ? '[Refresh permission]' : '[Request permission]'}`, allowed
          ? { id: 'refresh-permission', kind: 'refresh', label: 'Refresh permission', enabled: !busy }
          : painted === 'accessibility'
            ? { id: 'request-accessibility', kind: 'request-accessibility', label: 'Request Accessibility permission', enabled: !busy, permission: 'accessibility' }
            : { id: 'request-screen-recording', kind: 'request-screen-recording', label: 'Request Screen Recording permission', enabled: !busy, permission: 'screenRecording' })
      } else if (system?.platform === 'win32') {
        pushText('Host platform: Windows (unsupported by the macOS provider)')
        pushAction('  [Open Settings → Plugins]', { id: 'plugins', kind: 'plugins', label: 'Open Settings Plugins', enabled: !busy })
      } else {
        pushText(`Host platform: ${readPhaseText(snapshot.system)}`)
      }
      // No early return for a READY short grant: the same scrollable full facts
      // (PTC, applications, helper responsibility, receipts) follow below the
      // compact first screen instead of being permanently omitted.
    }

    push(color.textStrong('Computer Use bundle'))
    pushText(`  ${bundleSummary(snapshot)}`)
    if (bundle.phase === 'disabled' || !providerReady) {
      const reason = bundle.error ?? bundle.reason
      if (reason !== undefined) pushText(`  ${reason}`)
      pushText('  Enable the official bundle in Settings → Plugins; this page starts no CUA query while it is disabled or the provider is unavailable.')
      pushAction('  [Open Settings → Plugins]', { id: 'plugins', kind: 'plugins', label: 'Open Settings Plugins', enabled: !busy })
      return lines
    }

    push('')
    push(color.textStrong('Host and helper'))
    const system = systemOf(snapshot)
    pushText(`  Host platform: ${platformName(system)}`)
    pushText(`  Helper: ${helperIdentity(system)}`)
    pushText(`  Responsible app: ${responsibleApplication(system)}`)
    if (system?.platform === 'darwin') pushText(`  Helper parent: ${system.parent.path ?? system.parent.name ?? 'Unknown'}`)
    pushText('  Complete permission prompts on the HOST Mac. A Request/Open action does not grant permission.')
    if (system?.platform === 'win32') {
      pushText('  This page manages the official macOS Computer Use provider only; this Host cannot grant Accessibility or Screen Recording.')
      pushAction('  [Open Settings → Plugins]', { id: 'plugins', kind: 'plugins', label: 'Open Settings Plugins', enabled: !busy })
      return lines
    }
    if (system === undefined && ['unavailable', 'failed', 'unknown'].includes(snapshot.system.phase)) {
      pushText(`  Provider unavailable: ${snapshot.system.reason ?? 'the official CUA system status was not read'}`)
      pushAction('  [Open Settings → Plugins]', { id: 'plugins', kind: 'plugins', label: 'Open Settings Plugins', enabled: !busy })
    }
    if (system?.platform === 'darwin' && system !== undefined && (!system.accessibility || !system.screenRecording)) {
      pushText('  First use: grant the missing permissions above, then Refresh and read the fresh observation.')
    }
    push('')

    push(color.textStrong('Authorize computer use'))
    pushText(`  New Sessions: ${snapshot.preset.phase === 'ready' ? (snapshot.preset.value ?? 'unknown') : (snapshot.preset.reason ?? 'read failed')}${snapshot.preset.phase === 'ready' && snapshot.preset.value === 'ptc' ? ' (PTC is the saved default)' : ''}`)
    pushAction(`  ${snapshot.preset.phase === 'ready' && snapshot.preset.available && snapshot.preset.value !== 'ptc' ? '[Set new Sessions to PTC]' : '[PTC already the default]'}`, {
      id: 'preset', kind: 'preset', label: 'Set new Sessions to PTC',
      enabled: !busy && snapshot.preset.phase === 'ready' && snapshot.preset.available && snapshot.preset.value !== 'ptc',
      reason: snapshot.preset.phase !== 'ready'
        ? (snapshot.preset.reason ?? 'The saved default preset is not readable right now.')
        : snapshot.preset.value === 'ptc' ? 'PTC is already the saved default preset.' : 'The saved default preset is not available.',
    })
    const ptc = snapshot.ptc.phase === 'ready' ? snapshot.ptc.value : undefined
    pushText(`  PTC execution: ${ptc === undefined ? (snapshot.ptc.reason ?? readPhaseText(snapshot.ptc)) : (ptc.persistent ? 'Persistent' : 'Non-persistent')}${ptc?.writable === false ? ' (read-only)' : ''}`)
    pushAction(`  ${ptc !== undefined && !ptc.persistent && ptc.writable ? '[Use persistent mode…]' : '[Persistent mode unavailable]'}`, {
      id: 'persistent-ptc', kind: 'persistent-ptc', label: 'Use persistent PTC mode…',
      enabled: !busy && ptc !== undefined && !ptc.persistent && ptc.writable,
      reason: ptc === undefined ? (snapshot.ptc.reason ?? 'The Host PTC execution state is not readable right now.') : 'Persistent PTC is already active or read-only.',
    })

    const accessibility = system?.platform === 'darwin' ? system.accessibility : undefined
    pushText(`  Accessibility: ${accessibility === undefined ? (snapshot.system.reason ?? readPhaseText(snapshot.system)) : permissionText(accessibility)}`)
    if (system?.platform === 'darwin') {
      pushText(`    Reads and operates UI controls. ${system.accessibility ? 'Allowed.' : 'Not allowed yet.'}`)
      pushAction(`  ${system.accessibility ? '[Request permission again]' : '[Request permission]'}`, {
        id: 'request-accessibility', kind: 'request-accessibility', label: 'Request Accessibility permission',
        enabled: !busy, permission: 'accessibility',
      })
      pushAction('  [Open Accessibility settings]', {
        id: 'open-accessibility', kind: 'open-accessibility', label: 'Open Accessibility settings',
        enabled: !busy, permission: 'accessibility',
      })
    }
    const screenRecording = system?.platform === 'darwin' ? system.screenRecording : undefined
    pushText(`  Screen Recording: ${screenRecording === undefined ? (snapshot.system.reason ?? readPhaseText(snapshot.system)) : permissionText(screenRecording)}`)
    if (system?.platform === 'darwin') {
      pushText(`    Captures the selected application window. ${system.screenRecording ? 'Allowed.' : 'Not allowed yet.'}`)
      pushAction(`  ${system.screenRecording ? '[Request permission again]' : '[Request permission]'}`, {
        id: 'request-screen-recording', kind: 'request-screen-recording', label: 'Request Screen Recording permission',
        enabled: !busy, permission: 'screenRecording',
      })
      pushAction('  [Open Screen Recording settings]', {
        id: 'open-screen-recording', kind: 'open-screen-recording', label: 'Open Screen Recording settings',
        enabled: !busy, permission: 'screenRecording',
      })
    }
    push('')

    push(color.textStrong('Application access'))
    pushText("  Persisted decisions only; this Session's temporary grants are not listed here.")
    const applications = snapshot.applications.phase === 'ready' ? snapshot.applications.value : undefined
    if (applications === undefined) {
      pushText(`  ${snapshot.applications.reason ?? readPhaseText(snapshot.applications)}`)
    } else {
      if (applications.allowedApps.length === 0) pushText('  Always allowed: none.')
      for (const application of applications.allowedApps) {
        pushText(`    ${applicationLine(application)}`)
        pushAction('    [Revoke access…]', {
          id: `revoke:${application.id}`, kind: 'revoke', label: `Revoke ${application.name}`,
          enabled: !busy, applicationId: application.id, applicationLabel: applicationLine(application),
        })
      }
      if (applications.blockedApps.length === 0) pushText('  Refused: none.')
      for (const application of applications.blockedApps) {
        pushText(`    ${applicationLine(application)} (refused)`)
        pushAction('    [Allow asking again…]', {
          id: `retry:${application.id}`, kind: 'retry', label: `Allow asking again for ${application.name}`,
          enabled: !busy, applicationId: application.id, applicationLabel: applicationLine(application),
        })
      }
      if (!applications.persistentAvailable) pushText('  The Host reports durable application storage is unavailable.')
    }
    push('')
    if (this.help) {
      push(color.textStrong('Help and recovery'))
      for (const item of HELP_LINES) pushText(`  ${item}`)
      push('')
    }
    if (snapshot.action !== undefined) {
      const prefix = snapshot.action.state === 'ok' ? 'Action' : snapshot.action.state === 'unknown' ? 'Action outcome unconfirmed' : 'Action failed'
      pushText(`${prefix}: ${snapshot.action.text}`)
    }
    if (this.notice !== undefined) pushText(`${this.notice.kind === 'error' ? 'Error' : 'Notice'}: ${this.notice.text}`)
    return lines
  }

  private buildConfirmation(width: number, hintKind: 'short' | 'long'): PageLine[] {
    const confirmation = this.confirmation
    if (confirmation === undefined) return []
    // The two-space indent is part of the painted cells; wrap the content to
    // the REMAINING width or the frame loses the risk characters while still
    // counting the line as visible and leaving the confirm key exposed.
    const lines: PageLine[] = []
    for (const part of wrapText(`  ${confirmation.title}`, width)) {
      lines.push({ text: color.warning(part) })
    }
    lines.push({ text: '' })
    for (const part of wrapText(`  ${confirmation.body}`, width)) lines.push({ text: part })
    if (confirmation.action.applicationLabel !== undefined) {
      lines.push({ text: '' })
      for (const part of wrapText(`  Application: ${confirmation.action.applicationLabel}`, width)) {
        lines.push({ text: part })
      }
    }
    lines.push({ text: '' })
    const hint = hintKind === 'short'
      ? '  y/Enter confirm · n/Esc cancel; no change has been made yet.'
      : '  The full risk text must fit before confirm is available; n/Esc cancels.'
    for (const part of wrapText(hint, width)) {
      lines.push({ text: part })
    }
    return lines
  }

  private renderBar(width: number, snapshot: CuaAccessSettingsSnapshot): {
    readonly text: string
    readonly spans: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[]
    readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
  } {
    if (this.confirmation !== undefined) {
      return this.layoutBar(width, [
        ...(this.confirmationVisible
          ? [{ id: 'bar:confirm', text: `[y ${this.confirmation.confirm}]`, short: '[y Confirm]', priority: 100 }]
          : []),
        { id: 'bar:cancel', text: '[n Cancel]', short: '[n]', priority: 90 },
        { id: 'bar:escape', text: '[Esc Cancel]', short: '[Esc]', priority: 1000 },
      ])
    }
    if (this.help) {
      return this.layoutBar(width, [
        { id: 'bar:refresh', text: '[r Refresh]', short: '[r]', priority: 10 },
        { id: 'bar:help', text: '[? Close help]', short: '[?]', priority: 20 },
        { id: 'bar:escape', text: '[Esc Back]', short: '[Esc]', priority: 1000 },
      ])
    }
    return this.layoutBar(width, [
      { id: 'bar:refresh', text: snapshot.busy ? '[r Refresh (busy)]' : '[r Refresh]', short: '[r]', priority: 10 },
      { id: 'bar:help', text: '[? Help]', short: '[?]', priority: 20 },
      { id: 'bar:escape', text: '[Esc Back]', short: '[Esc]', priority: 1000 },
    ])
  }

  private layoutBar(width: number, segments: readonly { readonly id: string; readonly text: string; readonly short: string; readonly priority: number }[]): {
    readonly text: string
    readonly spans: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[]
    readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
  } {
    const layout = layoutActionBarRow(segments.map(({ text, short, priority }): ActionBarSegment => ({ text, short, priority })), width)
    const spans: { id: string; startCol: number; endCol: number }[] = []
    let escapeSpan: { startCol: number; endCol: number } | undefined
    for (const span of layout.spans) {
      const segment = segments[span.inputIndex]
      if (segment === undefined) continue
      if (segment.id === 'bar:escape') escapeSpan = { startCol: span.startCol, endCol: span.endCol }
      else spans.push({ id: segment.id, startCol: span.startCol, endCol: span.endCol })
    }
    return { text: layout.text, spans, ...(escapeSpan === undefined ? {} : { escapeSpan }) }
  }

  // ── admission and currentness ────────────────────────────────────────────

  private frameCurrent(): boolean {
    return this.paint !== undefined && this.paint.identity === this.gestureIdentity()
  }

  private move(delta: number): void {
    const count = this.paintedActions.length
    if (count === 0) return
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta))
    const row = this.paintedActionRows[this.cursor]
    const bodyRows = Math.max(0, this.rowGrant - 1)
    if (row !== undefined) {
      if (row < this.offset) this.offset = row
      else if (row >= this.offset + Math.max(1, bodyRows)) this.offset = row - Math.max(1, bodyRows) + 1
      this.offset = Math.max(0, Math.min(this.offset, Math.max(0, this.contentLength - Math.max(1, bodyRows))))
    }
    this.bump()
  }

  private scroll(delta: number): void {
    if (this.confirmation !== undefined) {
      this.scrollConfirmation(delta)
      return
    }
    const bodyRows = Math.max(1, this.rowGrant - 1)
    this.offset = Math.max(0, Math.min(this.offset + delta, Math.max(0, this.contentLength - bodyRows)))
    this.bump()
  }

  private scrollConfirmation(delta: number): void {
    if (this.confirmation === undefined) return
    const bodyRows = Math.max(1, this.rowGrant - 1)
    const maxOffset = Math.max(0, this.buildConfirmation(this.paint?.width ?? 80,
      this.confirmationVisible ? 'short' : 'long').length - bodyRows)
    this.confirmation = { ...this.confirmation, offset: Math.max(0, Math.min(this.confirmation.offset + delta, maxOffset)) }
    this.bump()
  }

  private liveAction(action: PageAction, snapshot: CuaAccessSettingsSnapshot): { ok: true } | { ok: false; reason: string } {
    if (action.kind === 'refresh' || action.kind === 'help' || action.kind === 'plugins') return { ok: true }
    if (snapshot.busy) return { ok: false, reason: 'An operation is already running; wait for it to settle.' }
    if (snapshot.bundle.phase !== 'ready' || !snapshot.bundle.enabled || !snapshot.bundle.providerReady) {
      return { ok: false, reason: snapshot.bundle.error ?? snapshot.bundle.reason ?? 'The official CUA provider is not ready.' }
    }
    switch (action.kind) {
      case 'preset':
        return snapshot.preset.phase === 'ready' && snapshot.preset.available && snapshot.preset.value !== 'ptc'
          ? { ok: true }
          : { ok: false, reason: snapshot.preset.reason ?? 'PTC is already the saved default preset.' }
      case 'persistent-ptc': {
        const ptc = snapshot.ptc.phase === 'ready' ? snapshot.ptc.value : undefined
        return ptc !== undefined && !ptc.persistent && ptc.writable
          ? { ok: true }
          : { ok: false, reason: snapshot.ptc.reason ?? 'Persistent PTC is already active or read-only.' }
      }
      case 'request-accessibility':
      case 'open-accessibility':
      case 'request-screen-recording':
      case 'open-screen-recording': {
        const system = snapshot.system.phase === 'ready' ? snapshot.system.value : undefined
        if (system?.platform !== 'darwin') {
          return { ok: false, reason: snapshot.system.reason ?? 'The official macOS permission observation is not current.' }
        }
        return { ok: true }
      }
      case 'revoke':
      case 'retry': {
        // The official application decisions are an independent Host policy
        // surface; a failed systemStatus() read must not freeze an existing
        // decision's revoke/retry.
        const applications = snapshot.applications.phase === 'ready' ? snapshot.applications.value : undefined
        if (applications === undefined) {
          return { ok: false, reason: snapshot.applications.reason ?? 'The official application list is not current.' }
        }
        const list = action.kind === 'revoke' ? applications.allowedApps : applications.blockedApps
        if (action.applicationId === undefined || !list.some(application => application.id === action.applicationId)) {
          return { ok: false, reason: 'That application decision is no longer in the official list; refresh before acting.' }
        }
        return { ok: true }
      }
    }
  }

  private runAction(action: PageAction): void {
    if (this.disposed) return
    if (!this.frameCurrent()) {
      this.notice = { kind: 'info', text: 'The Host facts changed; wait for the refreshed frame before acting.' }
      this.bump()
      return
    }
    const snapshot = this.controller.getSnapshot()
    if (!action.enabled) {
      this.notice = { kind: 'info', text: action.reason ?? `${action.label} is not available right now.` }
      this.bump()
      return
    }
    const live = this.liveAction(action, snapshot)
    if (!live.ok) {
      this.notice = { kind: 'info', text: live.reason }
      this.bump()
      return
    }
    switch (action.kind) {
      case 'refresh':
        this.start('computer use settings refresh', () => this.controller.refresh())
        return
      case 'plugins':
        if (this.openPlugins === undefined) {
          this.notice = { kind: 'info', text: 'The Plugin Manager is not available in this composition.' }
          this.bump()
          return
        }
        this.openPlugins()
        return
      case 'help':
        this.help = !this.help
        this.bump()
        return
      case 'preset':
        this.start('computer use settings PTC default', () => this.controller.setPtcDefault())
        return
      case 'request-accessibility':
        this.start('computer use accessibility request', () => this.controller.requestPermission('accessibility'))
        return
      case 'open-accessibility':
        this.start('computer use accessibility settings', () => this.controller.openSettings('accessibility'))
        return
      case 'request-screen-recording':
        this.start('computer use screen recording request', () => this.controller.requestPermission('screenRecording'))
        return
      case 'open-screen-recording':
        this.start('computer use screen recording settings', () => this.controller.openSettings('screenRecording'))
        return
      case 'persistent-ptc':
        this.confirmation = {
          action,
          title: 'Enable persistent PTC mode?',
          body: 'The official runtime may reload and interrupt in-flight Computer Use calls. The Host setting is re-read after the action; it is not assumed saved.',
          confirm: 'Use persistent mode',
          epoch: this.controller.getSnapshot().epoch,
          offset: 0,
        }
        this.bump()
        return
      case 'revoke':
        this.confirmation = {
          action,
          title: 'Revoke this application decision?',
          body: 'Affected Computer Use work may stop immediately; input already dispatched cannot be undone. The exact application shown below is passed to the Host; no other application is changed.',
          confirm: 'Revoke',
          epoch: this.controller.getSnapshot().epoch,
          offset: 0,
        }
        this.bump()
        return
      case 'retry':
        this.confirmation = {
          action,
          title: 'Allow this application to ask again?',
          body: 'This clears the persisted refusal only. The next selection will ask again and nothing is approved automatically.',
          confirm: 'Allow asking again',
          epoch: this.controller.getSnapshot().epoch,
          offset: 0,
        }
        this.bump()
        return
    }
  }

  private confirmCurrent(): void {
    const confirmation = this.confirmation
    if (confirmation === undefined) return
    if (!this.frameCurrent() || !this.confirmationVisible) return
    const snapshot = this.controller.getSnapshot()
    if (confirmation.epoch !== snapshot.epoch) {
      this.confirmation = undefined
      this.notice = { kind: 'info', text: 'The Host observation changed; the confirmation was discarded. Refresh before acting again.' }
      this.bump()
      return
    }
    const live = this.liveAction(confirmation.action, snapshot)
    if (!live.ok) {
      this.confirmation = undefined
      this.notice = { kind: 'info', text: live.reason }
      this.bump()
      return
    }
    const action = confirmation.action
    this.confirmation = undefined
    this.bump()
    const applicationId = action.applicationId
    if (action.kind === 'persistent-ptc') this.start('computer use persistent PTC', () => this.controller.enablePersistentPtc())
    else if (action.kind === 'revoke' && applicationId !== undefined) this.start('computer use revoke', () => this.controller.revoke(applicationId))
    else if (action.kind === 'retry' && applicationId !== undefined) this.start('computer use retry approval', () => this.controller.retryApproval(applicationId))
  }

  private cancelConfirmation(): void {
    if (this.confirmation === undefined) return
    this.confirmation = undefined
    this.bump()
  }

  private revokePress(): void {
    this.pressed = undefined
  }

  private bump(): void {
    this.revision += 1
    this.requestRender()
  }
}
