/** A focused raw-input recorder for one semantic keybinding. */

import { isKeyRelease, isKeyRepeat, matchesKey, parseKey, truncateToWidth, type Component } from '@xmoon76/pi-tui'
import { canonicalizeKeyId, isRuntimeBindableKeyId, isTextProducingKeyId, isValidKeyId } from '../keybindings/key-identity.ts'
import { isEditorSubmitPreSubmitKey, isTerminalAmbiguousKeyId } from '../keybindings/config.ts'
import type { KeyId } from '@xmoon76/pi-tui'
import type { AppKeybindingId } from '../keybindings/types.ts'
import { color } from '../theme.ts'

export type KeyRecorderPurpose = 'direct' | 'leader-completion' | 'leader-key'

export interface KeyRecorderOptions {
  readonly purpose: KeyRecorderPurpose
  readonly action?: AppKeybindingId
  readonly label: string
  readonly onCapture: (key: KeyId) => void
  readonly onCancel: () => void
  readonly requestRender?: () => void
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
  private error: string | undefined

  constructor(options: KeyRecorderOptions) {
    this.purpose = options.purpose
    this.action = options.action
    this.label = options.label
    this.onCapture = options.onCapture
    this.onCancel = options.onCancel
    this.requestRender = options.requestRender ?? (() => {})
  }

  render(width: number): string[] {
    const safeWidth = Math.max(1, width)
    const lines = [
      color.textStrong('Record shortcut'),
      '',
      color.text(`Press a key for ${this.label}.`),
      color.textDim(this.purpose === 'leader-key'
        ? 'This key becomes the global leader prefix.'
        : this.purpose === 'leader-completion'
          ? 'This key completes the leader sequence.'
          : 'The key is parsed from the terminal and stored canonically.'),
      '',
      this.error === undefined
        ? color.accent('Waiting for one key…')
        : color.error(this.error),
      '',
      color.textDim(this.purpose === 'direct' ? 'Esc: cancel · e: use Escape' : 'Esc: cancel'),
    ]
    return lines.map(line => truncateToWidth(line, safeWidth))
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (data === '') return
    // Release/repeat reports are not a second binding. They are consumed by
    // the active editor overlay and must never reach the host editor.
    if (isKeyRelease(data) || isKeyRepeat(data)) return
    // Raw Escape is the recorder's cancel gesture. Offer an explicit
    // disambiguated command so a direct action can still express the legal
    // unmodified Escape KeyId without making the cancel path unreachable.
    if (this.purpose === 'direct' && data.length === 1 && data.toLowerCase() === 'e') {
      try {
        this.onCapture('escape')
      } catch {
        this.error = 'The shortcut could not be recorded. Try again.'
        this.requestRender()
      }
      return
    }
    if (matchesKey(data, 'escape')) {
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
    try {
      this.onCapture(validation.key)
    } catch {
      this.error = 'The shortcut could not be recorded. Try again.'
      this.requestRender()
    }
  }
}
