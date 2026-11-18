/**
 * The `Settings → Tools → Computer Use` specialist page (PR-5 / MAC-09 v2).
 *
 * ONE embedded page inside the existing Settings workspace lease: it paints
 * the official bundle state, the two independent macOS privileges, the helper
 * identity, the PTC facts and the persisted application decisions. Every
 * action forwards to the per-open {@link CuaAccessSettingsController}; the page
 * owns only transient presentation state (cursor, scroll, confirmation, help)
 * and dies with the page instance.
 *
 * The Host/provider is the only authority. A Request/Open action is painted as
 * an action receipt, never as an Allowed permission; only a fresh read may
 * paint Allowed. No TCC access, no local permission store, no second provider.
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
import type {
  CuaAccessSettingsController,
  CuaAccessSettingsSnapshot,
  CuaReadState,
} from '../../app/command/cua-access-settings.ts'
import type { CuaApplicationFact, CuaPermission, CuaSystemStatus } from '../../runtime/cua-access-port.ts'
import { layoutActionBarRow, type ActionBarSegment } from '../presentation/action-bar.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import { paintActionSpan } from '../presentation/action-ink.ts'
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

interface PageAction {
  readonly id: string
  readonly kind: PageActionKind
  readonly label: string
  readonly enabled: boolean
  readonly reason?: string
  readonly permission?: CuaPermission
  readonly applicationId?: string
}

interface PageLine {
  readonly text: string
  readonly action?: PageAction
}

interface Confirmation {
  readonly id: string
  readonly title: string
  readonly body: string
  readonly confirm: string
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

function bundleText(snapshot: CuaAccessSettingsSnapshot): string {
  const bundle = snapshot.bundle
  switch (bundle.phase) {
    case 'idle': return 'Not read'
    case 'loading': return 'Reading…'
    case 'disabled': return 'Disabled'
    case 'unknown': return `Unknown${bundle.reason === undefined ? '' : ` (${bundle.reason})`}`
    case 'ready': return bundle.enabled ? 'Enabled (official provider selected)' : 'Disabled'
  }
}

function systemOf(snapshot: CuaAccessSettingsSnapshot): CuaSystemStatus | undefined {
  return snapshot.system.phase === 'ready' ? snapshot.system.value : undefined
}

function platformName(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  return status.platform === 'darwin' ? 'macOS' : 'Unsupported platform (win32)'
}

function helperName(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  if (status.platform === 'win32') return status.helper.name ?? 'Unknown'
  return status.launchApplication?.name ?? status.helper.name ?? 'Unknown'
}

function helperPath(status: CuaSystemStatus | undefined): string {
  if (status === undefined) return 'Unknown'
  if (status.platform === 'win32') return status.helper.path ?? 'Unknown'
  return status.launchApplication?.path ?? status.helper.path ?? 'Unknown'
}

/** ONE embedded page; constructed only when the Settings lease opens it. */
export class ComputerUseSettingsPage implements EmbeddedSpecialistPage {
  private readonly controller: CuaAccessSettingsController
  private readonly requestRender: () => void
  private readonly done: () => void
  private readonly unsubscribe: () => void

  readonly title = COMPUTER_USE_PAGE_TITLE
  focused = false

  private rowGrant = 1
  private grantAwaitingPaintValue = true
  private cursor = 0
  private offset = 0
  private confirmation: Confirmation | undefined
  private help = false
  private notice: { readonly kind: 'info' | 'error'; readonly text: string } | undefined
  private revision = 0
  private disposed = false
  private paint: Paint | undefined
  private paintedActions: readonly PageAction[] = []
  private pressed: { readonly identity: string; readonly action: PageAction } | undefined
  private paintedEscapeSpanValue: { readonly startCol: number; readonly endCol: number } | undefined
  private paintedBarSpansValue: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[] = []

  constructor(intents: {
    readonly controller: CuaAccessSettingsController
    readonly requestRender: () => void
    readonly done: () => void
  }) {
    this.controller = intents.controller
    this.requestRender = intents.requestRender
    this.done = intents.done
    this.unsubscribe = this.controller.subscribe(() => {
      this.revision += 1
      this.requestRender()
    })
    void this.controller.refresh()
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
    if (this.paint === undefined || this.paint.identity !== this.gestureIdentity()) return
    const span = this.paint.barSpans.find(candidate => candidate.id === id)
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
      this.confirmation?.id ?? 'no-confirm',
      this.notice?.text ?? 'no-notice',
    ].join('|')
  }

  handleInput(data: string): void {
    if (this.disposed) return
    if (this.notice !== undefined) {
      this.notice = undefined
      this.bump()
      if (matchesKey(data, 'escape')) return
    }
    if (this.confirmation !== undefined) {
      if (matchesKey(data, 'escape') || data === 'n' || data === 'N') {
        this.cancelConfirmation()
        return
      }
      if (data === 'y' || data === 'Y' || matchesKey(data, 'enter')) {
        this.confirmCurrent()
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
      if (action !== undefined) this.runAction(action)
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
      this.move(event.wheelDelta < 0 ? -1 : 1)
      this.revokePress()
      return { handled: true }
    }
    if (event.height !== bodyRows && event.height !== paint.rows) return undefined
    const current = paint.identity === this.gestureIdentity()
    if (!current) return undefined
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

  /** The page's own pane header (single-column page). */
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
    this.paintedBarSpansValue = []
    this.paintedEscapeSpanValue = undefined
  }

  render(width: number): string[] {
    const snapshot = this.controller.getSnapshot()
    this.grantAwaitingPaintValue = false
    const bodyRows = Math.max(0, this.rowGrant - 1)
    const targets: PaintedTarget[] = []
    const lines: PageLine[] = []
    const actionLines: PageLine[] = []
    const push = (text: string, action?: PageAction): void => {
      const line: PageLine = { text, action }
      lines.push(line)
      if (action !== undefined) actionLines.push(line)
    }

    push(color.textStrong('Computer Use bundle'), undefined)
    push(`  ${bundleText(snapshot)}`, undefined)
    if (snapshot.bundle.error !== undefined) push(`  Provider error: ${sanitizedPhysicalLine(snapshot.bundle.error)}`, undefined)
    if (snapshot.bundle.phase === 'disabled') push(`  Enable it in Settings → Plugins; this page starts no CUA query while disabled.`, undefined)
    push('', undefined)
    push(color.textStrong('Host and helper'), undefined)
    const system = systemOf(snapshot)
    push(`  Host platform: ${platformName(system)}`, undefined)
    push(`  Authorize this Mac: ${sanitizedPhysicalLine(helperName(system))}`, undefined)
    const path = helperPath(system)
    if (path !== 'Unknown') push(`  Helper path: ${sanitizedPhysicalLine(path)}`, undefined)
    if (system !== undefined && system.platform === 'darwin') {
      const launch = system.launchApplication
      push(`  Responsible app: ${launch === undefined ? 'Unknown (macOS did not report it)' : sanitizedPhysicalLine(launch.name)}`, undefined)
      push(`  Helper parent: ${sanitizedPhysicalLine(system.parent.path ?? system.parent.name ?? 'Unknown')}`, undefined)
    }
    push(`  Complete permission prompts on the HOST Mac. A Request/Open action does not grant permission.`, undefined)
    push('', undefined)

    push(color.textStrong('Authorize computer use'), undefined)
    push(`  New Sessions: ${snapshot.preset.phase === 'ready' ? (snapshot.preset.value ?? 'unknown') : 'read failed'} (PTC required for Computer Use)`, undefined)
    const setPreset: PageAction = {
      id: 'preset',
      kind: 'preset',
      label: 'Set new Sessions to PTC',
      enabled: snapshot.preset.phase === 'ready' && snapshot.preset.available && snapshot.preset.value !== 'ptc',
      ...(snapshot.preset.phase !== 'ready' ? { reason: 'The saved default preset is not readable right now.' } : {}),
      ...(snapshot.preset.phase === 'ready' && snapshot.preset.value === 'ptc' ? { reason: 'PTC is already the saved default preset.' } : {}),
    }
    push(`  ${setPreset.enabled ? '[Set to PTC]' : '[PTC is already the default]'}`, setPreset)
    if (snapshot.preset.phase === 'ready' && snapshot.preset.value !== 'ptc' && setPreset.enabled) {
      push('  This changes NEW Sessions only; the current Session keeps its preset.', undefined)
    }

    const ptc = snapshot.ptc.phase === 'ready' ? snapshot.ptc.value : undefined
    push(`  PTC execution: ${ptc === undefined ? readPhaseText(snapshot.ptc) : (ptc.persistent ? 'Persistent' : 'Non-persistent')}${ptc?.writable === false ? ' (read-only)' : ''}`, undefined)
    const persistent: PageAction = {
      id: 'persistent-ptc',
      kind: 'persistent-ptc',
      label: 'Use persistent PTC mode…',
      enabled: ptc !== undefined && !ptc.persistent && ptc.writable,
      ...(ptc !== undefined && !ptc.writable ? { reason: 'The Host reports the PTC execution setting is read-only.' } : {}),
      ...(ptc === undefined ? { reason: 'The Host PTC execution state is not readable right now.' } : {}),
    }
    push(`  ${persistent.enabled ? '[Use persistent mode…]' : '[Persistent mode unavailable]'}`, persistent)

    const accessibility = system?.platform === 'darwin' ? system.accessibility : undefined
    const accessibilityText = accessibility === undefined ? readPhaseText(snapshot.system) : permissionText(accessibility)
    push(`  Accessibility: ${accessibilityText}`, undefined)
    if (system?.platform === 'darwin') {
      push(`    Reads and operates UI controls. ${system.accessibility ? 'Allowed.' : 'Not allowed yet.'}`, undefined)
      push(`  ${system.accessibility ? '[Request permission again]' : '[Request permission]'}`, {
        id: 'request-accessibility', kind: 'request-accessibility', label: 'Request Accessibility permission', enabled: true, permission: 'accessibility',
      })
      push('  [Open Accessibility settings]', {
        id: 'open-accessibility', kind: 'open-accessibility', label: 'Open Accessibility settings', enabled: true, permission: 'accessibility',
      })
    }

    const screenRecording = system?.platform === 'darwin' ? system.screenRecording : undefined
    const screenText = screenRecording === undefined ? readPhaseText(snapshot.system) : permissionText(screenRecording)
    push(`  Screen Recording: ${screenText}`, undefined)
    if (system?.platform === 'darwin') {
      push(`    Captures the selected application window. ${system.screenRecording ? 'Allowed.' : 'Not allowed yet.'}`, undefined)
      push(`  ${system.screenRecording ? '[Request permission again]' : '[Request permission]'}`, {
        id: 'request-screen-recording', kind: 'request-screen-recording', label: 'Request Screen Recording permission', enabled: true, permission: 'screenRecording',
      })
      push('  [Open Screen Recording settings]', {
        id: 'open-screen-recording', kind: 'open-screen-recording', label: 'Open Screen Recording settings', enabled: true, permission: 'screenRecording',
      })
    }
    if (snapshot.system.phase === 'loading' || snapshot.system.phase === 'idle') {
      push('  Reading the official permission state…', undefined)
    }
    push('', undefined)

    push(color.textStrong('Application access'), undefined)
    push('  Persisted decisions only; this Session\'s temporary grants are not listed here.', undefined)
    const applications = snapshot.applications.phase === 'ready' ? snapshot.applications.value : undefined
    if (snapshot.applications.phase === 'loading' || snapshot.applications.phase === 'idle') {
      push('  Reading persisted application decisions…', undefined)
    } else if (applications === undefined) {
      push(`  ${readPhaseText(snapshot.applications)}${snapshot.applications.reason === undefined ? '' : `: ${sanitizedPhysicalLine(snapshot.applications.reason)}`}`, undefined)
    } else {
      if (applications.allowedApps.length === 0) push('  Always allowed: none.', undefined)
      for (const application of applications.allowedApps) {
        push(`    ${applicationLine(application)}`, undefined)
        push(`    [Revoke access…]`, {
          id: `revoke:${application.id}`,
          kind: 'revoke',
          label: `Revoke ${application.name}`,
          enabled: true,
          applicationId: application.id,
        })
      }
      if (applications.blockedApps.length === 0) push('  Refused: none.', undefined)
      for (const application of applications.blockedApps) {
        push(`    ${applicationLine(application)} (refused)`, undefined)
        push(`    [Allow asking again…]`, {
          id: `retry:${application.id}`,
          kind: 'retry',
          label: `Allow asking again for ${application.name}`,
          enabled: true,
          applicationId: application.id,
        })
      }
      if (!applications.persistentAvailable) push('  The Host reports durable application storage is unavailable.', undefined)
    }
    push('', undefined)
    if (this.help) {
      push(color.textStrong('Help and recovery'), undefined)
      for (const line of HELP_LINES) push(`  ${line}`, undefined)
      push('', undefined)
    }
    if (snapshot.action !== undefined) {
      push(`${snapshot.action.state === 'ok' ? 'Action' : 'Action failed'}: ${sanitizedPhysicalLine(snapshot.action.text)}`, undefined)
    }
    if (this.notice !== undefined) push(`${this.notice.kind === 'error' ? 'Error' : 'Notice'}: ${this.notice.text}`, undefined)

    // The confirmation is rendered AT THE TOP of the page body so the target and
    // the consequence are always reviewable before y/confirm.
    const confirmationLines: PageLine[] = []
    if (this.confirmation !== undefined) {
      confirmationLines.push({ text: color.warning(this.confirmation.title) })
      confirmationLines.push({ text: `  ${this.confirmation.body}` })
      confirmationLines.push({ text: '  y/Enter confirm · n/Esc cancel (no change yet)' })
      confirmationLines.push({ text: '' })
    }

    const all = [...confirmationLines, ...lines]
    const actionLinesAll = actionLines.map(line => ({
      line,
      index: all.indexOf(line),
      action: line.action as PageAction,
    })).filter(candidate => candidate.index >= 0)
    this.paintedActions = actionLinesAll.map(candidate => candidate.action)
    this.cursor = Math.max(0, Math.min(this.cursor, Math.max(0, actionLinesAll.length - 1)))
    const selectedAction = actionLinesAll[this.cursor]?.action
    if (selectedAction !== undefined) {
      // Keep the selected action visible in the granted body.
      const selectedRow = actionLinesAll[this.cursor]!.index
      if (selectedRow < this.offset) this.offset = selectedRow
      if (selectedRow >= this.offset + Math.max(1, bodyRows)) this.offset = selectedRow - Math.max(1, bodyRows) + 1
    }
    this.offset = Math.max(0, Math.min(this.offset, Math.max(0, all.length - Math.max(1, bodyRows))))
    const visible = all.slice(this.offset, this.offset + Math.max(0, bodyRows))
    while (visible.length < Math.max(0, bodyRows)) visible.push({ text: '' })

    const out: string[] = []
    // The ONE active signal of the action list is the `>` marker; a disabled
    // action is still selectable so its exact reason can be read.
    for (const line of visible) {
      const text = line.action !== undefined && line.action === selectedAction
        ? `> ${line.text.trimStart()}`
        : line.text
      out.push(fit(text, width))
    }
    // Record the action rows in PAGE coordinates (the root translates a pointer
    // cell into this page's own rows).
    for (let index = 0; index < visible.length; index += 1) {
      const action = visible[index]?.action
      if (action === undefined) continue
      const text = sanitizedPhysicalLine(out[index] ?? '')
      const label = text.lastIndexOf('[')
      if (label < 0) continue
      targets.push({ row: index, startCol: label, endCol: Math.min(width, label + visibleWidth(text.slice(label))), action })
    }
    // The ONE physical last row is the page's action bar. Esc is the root's
    // target; Refresh/Help are delegated non-Esc spans.
    const bar = this.renderBar(width, snapshot)
    this.paintedEscapeSpanValue = bar.escapeSpan
    this.paintedBarSpansValue = bar.spans
    out.push(fit(bar.text, width))
    const identity = this.gestureIdentity()
    this.paint = {
      width,
      rows: this.rowGrant,
      identity,
      targets,
      barSpans: bar.spans,
      ...(bar.escapeSpan === undefined ? {} : { escapeSpan: bar.escapeSpan }),
    }
    return out.slice(0, this.rowGrant)
  }

  private renderBar(width: number, snapshot: CuaAccessSettingsSnapshot): {
    readonly text: string
    readonly spans: readonly { readonly id: string; readonly startCol: number; readonly endCol: number }[]
    readonly escapeSpan?: { readonly startCol: number; readonly endCol: number }
  } {
    if (this.confirmation !== undefined) {
      return this.layoutBar(width, [
        { id: 'bar:confirm', text: `[y ${this.confirmation.confirm}]`, short: '[y Confirm]', priority: 100 },
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
    const busy = snapshot.busy
    return this.layoutBar(width, [
      { id: 'bar:refresh', text: busy ? '[r Refresh (busy)]' : '[r Refresh]', short: '[r]', priority: 10 },
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

  private move(delta: number): void {
    const count = this.paintedActions.length
    if (count === 0) return
    this.cursor = Math.max(0, Math.min(count - 1, this.cursor + delta))
    this.bump()
  }

  private runAction(action: PageAction): void {
    if (!action.enabled) {
      this.notice = { kind: 'info', text: action.reason ?? `${action.label} is not available right now.` }
      this.bump()
      return
    }
    switch (action.kind) {
      case 'refresh':
        void this.controller.refresh()
        return
      case 'help':
        this.help = !this.help
        this.bump()
        return
      case 'preset':
        void this.controller.setPtcDefault()
        return
      case 'request-accessibility':
        void this.controller.requestPermission('accessibility')
        return
      case 'open-accessibility':
        void this.controller.openSettings('accessibility')
        return
      case 'request-screen-recording':
        void this.controller.requestPermission('screenRecording')
        return
      case 'open-screen-recording':
        void this.controller.openSettings('screenRecording')
        return
      case 'persistent-ptc':
        this.confirmation = {
          id: 'persistent-ptc',
          title: 'Enable persistent PTC mode?',
          body: 'The official runtime may reload and interrupt in-flight Computer Use calls. The Host setting is re-read after the action; it is not assumed saved.',
          confirm: 'Use persistent mode',
        }
        this.bump()
        return
      case 'revoke':
        this.confirmation = {
          id: `revoke:${action.applicationId ?? ''}`,
          title: 'Revoke this application decision?',
          body: 'Affected Computer Use work may stop immediately; input already dispatched cannot be undone. The exact application id is passed to the Host; no other application is changed.',
          confirm: 'Revoke',
        }
        this.bump()
        return
      case 'retry':
        this.confirmation = {
          id: `retry:${action.applicationId ?? ''}`,
          title: 'Allow this application to ask again?',
          body: 'This clears the persisted refusal only. The next selection will ask again and nothing is approved automatically.',
          confirm: 'Allow asking again',
        }
        this.bump()
        return
    }
  }

  private confirmCurrent(): void {
    const confirmation = this.confirmation
    if (confirmation === undefined) return
    const action = this.paintedActions.find(candidate => candidate.id === confirmation.id)
    this.confirmation = undefined
    this.bump()
    if (action === undefined) return
    if (action.kind === 'persistent-ptc') void this.controller.enablePersistentPtc()
    else if (action.kind === 'revoke' && action.applicationId !== undefined) void this.controller.revoke(action.applicationId)
    else if (action.kind === 'retry' && action.applicationId !== undefined) void this.controller.retryApproval(action.applicationId)
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

function applicationLine(application: CuaApplicationFact): string {
  return application.executablePath === undefined
    ? sanitizedPhysicalLine(application.name)
    : `${sanitizedPhysicalLine(application.name)} · ${sanitizedPhysicalLine(application.executablePath)}`
}

export type { PageActionKind }
