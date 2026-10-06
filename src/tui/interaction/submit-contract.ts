/**
 * The small submit-gesture contract shared by the TUI interaction owners
 * (TS5 plan §11.3): the root `tui-app.ts` facade and the
 * `tui/keybindings/action-dispatcher.ts` routing layer both consume these
 * types from here, so the dispatcher does not import the facade (which would
 * be a TUI-internal value cycle).
 * @module @xmoon76/dsh-pi-tui/tui/interaction/submit-contract
 */

/**
 * The WEB composer submit gestures (DSH `ComposerSubmitGesture`): plain
 * Enter, or the Cmd/Ctrl-accelerated chord. The busy-Enter policy resolves
 * each to a delivery mode — plain Enter to the preferred mode, the
 * accelerated chord to its OPPOSITE — so the chord is never a fixed mode.
 */
export type ComposerSubmitGesture = 'enter' | 'accelerated'

/**
 * One submission request raised at the editor seat. The two gestures are
 * resolved by the busy-Enter policy; `explicit-queue` is the public
 * `queue-draft` action — an explicit delivery command, NOT a gesture: it
 * queues regardless of the preference (and of the agent's liveness).
 */
export type ComposerSubmitRequest = ComposerSubmitGesture | 'explicit-queue'
