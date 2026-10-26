/** A focused raw-input recorder for one semantic keybinding. */

import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, truncateToWidth, visibleWidth, type Component } from '@xmoon76/pi-tui'
import { canonicalizeKeyId, isRuntimeBindableKeyId, isTextProducingKeyId, isValidKeyId } from '../key-identity.ts'
import { isEditorSubmitPreSubmitKey, isPhysicalEscapeAction, isTerminalAmbiguousKeyId } from '../config.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import type { AppKeybindingId } from '../types.ts'
import { color } from '../../theme/runtime.ts'

export type KeyRecorderPurpose = 'direct' | 'leader-completion' | 'leader-key'

/** The short disambiguation window for assigning physical Escape. */
export const DOUBLE_ESCAPE_MS = 300

/** Injectable timer operations keep recorder lifecycle tests deterministic. */
export interface KeyRecorderTimer {
  readonly set: (callback: () => void, delayMs: number) => unknown
  readonly clear: (handle: unknown) => void
}

const DEFAULT_TIMER: KeyRecorderTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface KeyRecorderOptions {
  readonly purpose: KeyRecorderPurpose
  readonly action?: AppKeybindingId
  readonly label: string
  readonly onCapture: (key: KeyId) => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
  readonly timer?: KeyRecorderTimer
  /** The parent's live row grant; the recorder keeps its Esc line as the LAST
   *  row and degrades its optional description instead of being tail-sliced. */
  readonly maxRows?: () => number
}

export interface KeyRecorderValidation {
  readonly key: KeyId | undefined
  readonly message: string | undefined
}

/** Validate the canonical key policy shared by the config parser and the
 * plugin registry before a recorded value reaches the mutation controller. */
export function validateRecordedKey(
  rawKey: string,
  options: { readonly purpose: KeyRecorderPurpose; readonly action?: AppKeybindingId },
): KeyRecorderValidation {
  if (!isValidKeyId(rawKey)) return { key: undefined, message: 'This key combination is not recognized.' }
  const key = canonicalizeKeyId(rawKey as KeyId)
  if (!isRuntimeBindableKeyId(key)) {
    return { key: undefined, message: 'This key cannot be matched reliably by the current terminal.' }
  }
  // A completion is read only after the leader prefix has armed the
  // state-machine, so printable letters are safe there. Direct bindings and
  // the prefix itself must still never swallow ordinary typing.
  if (options.purpose !== 'leader-completion' && isTextProducingKeyId(key)) {
    return { key: undefined, message: 'Printable keys are reserved for typing.' }
  }
  if (isTerminalAmbiguousKeyId(key)) {
    return { key: undefined, message: 'This key is indistinguishable from a fixed terminal key on legacy terminals.' }
  }
  if (options.purpose === 'leader-completion' && key === 'escape') {
    return { key: undefined, message: 'Escape cancels a leader sequence and cannot be a completion.' }
  }
  if (key === 'escape' && (options.action === undefined || !isPhysicalEscapeAction(options.action))) {
    return { key: undefined, message: 'Physical Escape is reserved for the Host lifecycle path.' }
  }
  if (options.action === 'app.input.submit' && options.purpose !== 'leader-completion') {
    if (key === 'shift+enter') {
      return { key: undefined, message: 'Shift+Enter is reserved for inserting a newline.' }
    }
    if (isEditorSubmitPreSubmitKey(key)) {
      return { key: undefined, message: 'The editor consumes this key before submit can see it.' }
    }
  }
  return { key, message: undefined }
}

export class KeyRecorder implements Component {
  private readonly purpose: KeyRecorderPurpose
  private readonly action: AppKeybindingId | undefined
  private readonly label: string
  private readonly onCapture: (key: KeyId) => void
  private readonly onCancel: () => void
  private readonly requestRender: () => void
  private readonly timer: KeyRecorderTimer
  private readonly maxRows: () => number
  /** The body rows the LAST frame really painted (0 = bar-only: only Esc). */
  private hasPainted = false
  private paintedBodyRows = 0
  private error: string | undefined
  private escapePending = false
  private escapeTimer: unknown
  private disposed = false

  constructor(options: KeyRecorderOptions) {
    this.purpose = options.purpose
    this.action = options.action
    this.label = options.label
    this.onCapture = options.onCapture
    this.onCancel = options.onCancel
    this.requestRender = options.requestRender ?? (() => {})
    this.timer = options.timer ?? DEFAULT_TIMER
    this.maxRows = options.maxRows ?? (() => 8)
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const interruptDirect = this.purpose === 'direct' && this.action === 'app.agent.interrupt'
    const barText = interruptDirect
      ? ['Esc: cancel · double-Esc: assign Escape', 'Esc: cancel · double-Esc', 'Esc: cancel']
        .find(text => visibleWidth(text) <= safeWidth) ?? 'Esc: cancel'
      : 'Esc: cancel'
    const bar = truncateToWidth(color.textDim(barText), safeWidth)
    const budget = Math.max(1, this.maxRows())
    this.hasPainted = true
    if (budget <= 1) {
      this.paintedBodyRows = 0
      return [bar]
    }
    // The way back is the mandatory LAST row; everything else is optional
    // context that yields in priority order on a short grant.
    const status = this.error === undefined
      ? interruptDirect && this.escapePending
        ? color.accent('Esc again to assign Escape…')
        : color.accent('Waiting for one key…')
      : color.error(this.error)
    const rows: Array<{ readonly text: string; readonly drop?: number }> = [
      { text: color.textStrong('Record shortcut'), drop: 40 },
      { text: '', drop: 10 },
      { text: color.text(`Press a key for ${this.label}.`), drop: 35 },
      {
        text: color.textDim(this.purpose === 'leader-key'
          ? 'This key becomes the global leader prefix.'
          : this.purpose === 'leader-completion'
            ? 'This key completes the leader sequence.'
            : 'The key is parsed from the terminal and stored canonically.'),
        drop: 20,
      },
      { text: '', drop: 5 },
      { text: truncateToWidth(status, safeWidth) },
    ]
    const bodyBudget = budget - 1
    while (rows.length > bodyBudget) {
      let index = -1
      let priority = Number.POSITIVE_INFINITY
      for (let at = 0; at < rows.length; at += 1) {
        const drop = rows[at]!.drop
        if (drop !== undefined && drop < priority) {
          priority = drop
          index = at
        }
      }
      if (index === -1) break
      rows.splice(index, 1)
    }
    const body = rows.length > bodyBudget ? rows.slice(rows.length - bodyBudget) : rows
    this.paintedBodyRows = body.length
    return [...body.map(row => truncateToWidth(row.text, safeWidth)), bar]
  }

  invalidate(): void {}

  /** Stop the pending Escape disambiguation callback before the parent panel
   * is torn down. Timer callbacks also check this flag for late safety. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.clearEscapeTimer()
    this.escapePending = false
  }

  private isInterruptDirect(): boolean {
    return this.purpose === 'direct' && this.action === 'app.agent.interrupt'
  }

  private clearEscapeTimer(): void {
    if (this.escapeTimer !== undefined) this.timer.clear(this.escapeTimer)
    this.escapeTimer = undefined
  }

  private expirePendingEscape(): void {
    this.escapeTimer = undefined
    if (this.disposed || !this.escapePending) return
    this.escapePending = false
    this.onCancel()
  }

  private capture(key: KeyId): void {
    try {
      this.onCapture(key)
    } catch {
      this.error = 'The shortcut could not be recorded. Try again.'
      this.requestRender()
    }
  }

  private beginEscapeDisambiguation(): void {
    this.error = undefined
    this.escapePending = true
    this.escapeTimer = this.timer.set(() => this.expirePendingEscape(), DOUBLE_ESCAPE_MS)
    this.requestRender()
  }

  handleInput(data: string): void {
    if (this.disposed || data === '') return
    // A bar-only recorder paints no "Record shortcut" body: only the real Esc
    // (its cancel/assign affordance) may act until a real body row paints.
    if (this.hasPainted && this.paintedBodyRows === 0 && !matchesKey(data, 'escape')) return
    // Release/repeat reports are not a second binding. They are consumed by
    // the active editor overlay and must never reach the host editor.
    if (isKeyRelease(data) || isKeyRepeat(data)) return

    if (matchesKey(data, 'escape')) {
      if (!this.isInterruptDirect()) {
        this.onCancel()
        return
      }
      if (this.escapePending) {
        this.clearEscapeTimer()
        this.escapePending = false
        const validation = validateRecordedKey('escape', { purpose: this.purpose, action: this.action })
        if (validation.key === undefined) {
          this.error = validation.message
          this.requestRender()
          return
        }
        this.capture(validation.key)
      } else {
        this.beginEscapeDisambiguation()
      }
      return
    }

    // The first Escape expresses cancel intent. Any other key during its
    // short pending window cancels the recorder and is not captured.
    if (this.escapePending) {
      this.clearEscapeTimer()
      this.escapePending = false
      this.onCancel()
      return
    }

    let parsed: string | undefined
    try {
      parsed = parseKey(data)
    } catch {
      parsed = undefined
    }
    if (parsed === undefined) {
      this.error = 'Press one recognizable shortcut, not text or a pasted sequence.'
      this.requestRender()
      return
    }
    const validation = validateRecordedKey(parsed, { purpose: this.purpose, action: this.action })
    if (validation.key === undefined) {
      this.error = validation.message
      this.requestRender()
      return
    }
    this.capture(validation.key)
  }
}
