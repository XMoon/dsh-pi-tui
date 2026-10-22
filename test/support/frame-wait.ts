/**
 * A deterministic wait for a painted frame.
 *
 * The Settings **Models** page reads its provider catalog AFTER its first
 * frame: the read must not run in the input path that mounts the page (a
 * provider-directory read there would freeze the whole TUI). A test that
 * asserts the page's CONTENT therefore waits for the read to settle instead
 * of assuming that the next frame already carries it — the wait is on the
 * painted result, not on a timer.
 *
 * @module @xmoon76/dsh-pi-tui/frame-wait
 */

/** How many frames the helper waits before it gives up. */
const MAX_ATTEMPTS = 100

/**
 * Wait until the painted frame satisfies the predicate.
 *
 * @param view - the current painted frame (the harness's own view).
 * @param predicate - what the frame must contain.
 * @param wait - the harness's frame wait (one rendered frame).
 * @param message - the failure message.
 * @throws when the frame never satisfies the predicate.
 */
export async function waitForFrame(
  view: () => string,
  predicate: (frame: string) => boolean,
  wait: () => Promise<void>,
  message = 'the expected frame never appeared',
): Promise<void> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    if (predicate(view())) return
    await wait()
  }
  throw new Error(`${message}:\n${view()}`)
}
