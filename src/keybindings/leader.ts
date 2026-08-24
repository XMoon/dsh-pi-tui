/**
 * The leader / multi-key sequence state machine (plan §6 M6).
 *
 * When a leader key is configured (e.g. `ctrl+x`), pressing it arms a
 * PENDING prefix state; the next single key completes a `<leader>X`
 * binding and fires its action. The machine implements the plan's
 * requirements:
 *
 * - pending prefix state (idle → pending on the leader key);
 * - timeout (the pending state expires after {@link LeaderConfig.timeoutMs});
 * - ambiguous prefix (two actions bound to the same completing key are a
 *   diagnostic — neither fires);
 * - cancel (Esc cancels the pending state and is consumed; any other
 *   non-matching key cancels and is PASSED through for normal processing);
 * - paste/typing isolation (a multi-char chunk / paste burst cancels the
 *   pending state and passes through — a fast typist never loses text);
 * - focus transition cancellation (the app calls {@link cancel} when a
 *   question/approval/overlay/viewer opens or fullscreen toggles).
 *
 * The machine is pure state + timing: it never touches the terminal or
 * the app. The app feeds raw input, reads {@link pending} for the
 * which-key footer hint, and dispatches activated actions.
 * @module @xmoon76/dsh-pi-tui/keybindings/leader
 */

import { isKeyRelease, isKeyRepeat, matchesKey, parseKey } from '@xmoon76/pi-tui'
import type { LeaderBinding, LeaderConfig } from './types.ts'

/** The outcome of feeding one raw input event. */
export type LeaderFeedResult =
  /** The leader key or a completing key was consumed. */
  | { kind: 'consumed' }
  /** Not leader-related; process the event normally. */
  | { kind: 'passed' }
  /** The pending state was cancelled by a non-matching key; the event is
   * passed through for normal processing. */
  | { kind: 'cancelled-pass' }
  /** The pending state was cancelled by Esc; the event is consumed. */
  | { kind: 'cancelled-consume' }
  /** A leader sequence completed; the app must dispatch this action. */
  | { kind: 'activated'; action: string }

export interface LeaderMachineCallbacks {
  /** A leader sequence completed (the app dispatches the action). */
  readonly onActivate: (action: string) => void
  /** The pending state changed (the app repaints the which-key hint). */
  readonly onStateChange: () => void
}

/** The leader state machine. One instance per keymap. */
export class LeaderStateMachine {
  private state: 'idle' | 'pending' = 'idle'
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly config: LeaderConfig
  private readonly bindings: readonly LeaderBinding[]
  private readonly callbacks: LeaderMachineCallbacks
  private disposed = false

  constructor(config: LeaderConfig, bindings: readonly LeaderBinding[], callbacks: LeaderMachineCallbacks) {
    this.config = config
    this.bindings = bindings
    this.callbacks = callbacks
  }

  /** Whether a leader sequence is currently pending (which-key hint). */
  get pending(): boolean {
    return this.state === 'pending'
  }

  /** The configured leader key (undefined when the leader is disabled). */
  get leaderKey(): LeaderConfig['key'] {
    return this.config.key
  }

  /** The active leader bindings (which-key hint). */
  get leaderBindings(): readonly LeaderBinding[] {
    return this.bindings
  }

  /** Feed one raw input event. */
  feed(data: string): LeaderFeedResult {
    if (this.disposed) return { kind: 'passed' }
    const leaderKey = this.config.key
    if (leaderKey === undefined) return { kind: 'passed' }
    if (this.state === 'idle') {
      if (matchesKey(data, leaderKey)) {
        this.enterPending()
        return { kind: 'consumed' }
      }
      return { kind: 'passed' }
    }
    // Pending: protocol artifacts are ignored (a release of the leader key
    // must not cancel the sequence it just armed).
    if (isKeyRelease(data) || isKeyRepeat(data)) return { kind: 'consumed' }
    // Paste/typing isolation: a multi-char chunk is not a single key —
    // cancel the pending state and pass the text through untouched.
    if (parseKey(data) === undefined) {
      this.cancel()
      return { kind: 'cancelled-pass' }
    }
    // Esc cancels the pending state (consumed — it must not also trigger
    // the host's Esc handling).
    if (matchesKey(data, 'escape')) {
      this.cancel()
      return { kind: 'cancelled-consume' }
    }
    for (const binding of this.bindings) {
      if (matchesKey(data, binding.key)) {
        this.cancel()
        this.callbacks.onActivate(binding.action)
        return { kind: 'activated', action: binding.action }
      }
    }
    // A non-matching key cancels the pending state and is processed
    // normally (vim/OpenCode behavior — the user's keystroke is never
    // swallowed by a stale prefix).
    this.cancel()
    return { kind: 'cancelled-pass' }
  }

  /** Cancel any pending state (focus transitions, teardown). */
  cancel(): void {
    if (this.state === 'idle') return
    this.state = 'idle'
    this.clearTimer()
    this.callbacks.onStateChange()
  }

  /** Dispose the machine (clears the timeout; no state-change callback —
   * the app is tearing down). */
  dispose(): void {
    this.disposed = true
    this.state = 'idle'
    this.clearTimer()
  }

  private enterPending(): void {
    this.state = 'pending'
    this.clearTimer()
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (this.state === 'pending') {
        this.state = 'idle'
        this.callbacks.onStateChange()
      }
    }, this.config.timeoutMs)
    this.callbacks.onStateChange()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }
}
