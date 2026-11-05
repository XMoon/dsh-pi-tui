/**
 * The shared TSP composer-readiness probe for the Direct TSP test lanes.
 *
 * The renderer fences composer input for the whole session-hydration window and
 * DROPS a key typed inside it (it is not held for replay), so a single probe
 * byte typed after a session switch can be lost for good — no longer timeout
 * recovers it. The session store, the live Agent, the TTY listener and a
 * mounted projection are all earlier than that commit and none of them answers
 * this question.
 *
 * The ONE question this helper answers, against the wire the caller really
 * reads:
 *
 *   "does the CURRENT editor of the CURRENTLY MOUNTED scripted pane accept one
 *    printable byte through the official input path, paint it as the controlled
 *    `text`/`cursor`, and erase it through a real Backspace?"
 *
 * It is not a production readiness API. Only an `x` probe into a PROVEN empty
 * editor is ever repeated; a business line, an Enter or an arrow is never
 * re-sent by this helper.
 * @module @xmoon76/dsh-pi-tui/test/support/tsp-composer-readiness
 */
import type { TspPane } from './tsp-terminal-fixture.ts'

/** One editor observation: the controlled editor's wire `text`/`cursor`. */
export interface ComposerProbeState {
  readonly text: string
  readonly cursor: number
}

/** ONE absolute budget for the whole proof; no stage resets it. */
const DEADLINE_MS = 30_000
/** Observation cadence: a poll is a short state read, never a blind sleep. */
const POLL_MS = 25
/** How long one probe byte may take to land before it is treated as dropped. */
const PROBE_OBSERVATION_MS = 500
/** Bound for confirming the probe's own Backspace landed, per erase attempt. */
const ERASE_OBSERVATION_MS = 2_000
const PROBE = 'x'
const BACKSPACE = '\x7f'

const sleep = (millis: number): Promise<void> => new Promise<void>(resolve => {
  setTimeout(resolve, millis)
})

const isEmpty = (state: ComposerProbeState): boolean => state.text === '' && state.cursor === 0

/** Probe residue: only whole ASCII `x`s with the caret after ALL of them. */
const isProbeResidue = (state: ComposerProbeState): boolean =>
  state.cursor === state.text.length && /^x+$/u.test(state.text)

/**
 * Wait until the composer physically accepts a printable probe and then erases
 * it again, retrying ONLY dropped probe bytes.
 *
 * `read` must return one consistent observation of the live editor (the
 * caller folds the wire ONCE per call): two independent reads could compose a
 * `text`/`cursor` pair that never existed in one frame.
 */
export async function waitForEditableComposer(
  pane: TspPane,
  read: () => ComposerProbeState,
): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS
  let attempts = 0
  let phase = 'waiting for an observable empty editor'
  let last = read()

  const fail = (detail: string): never => {
    throw new Error(
      `the composer did not accept a real typed probe (phase=${phase}, ${detail}, attempts=${attempts}, `
      + `last=${JSON.stringify(last)}, frames=${pane.frameCount()}): the key was possibly dropped by the `
      + 'hydration fence, or it was delayed',
    )
  }

  /**
   * Erase the probe bytes with real Backspaces until the exact empty editor is
   * observed. Within one bounded attempt the TOTAL Backspaces issued never
   * exceed the largest residue count observed: an intermediate shrink is this
   * batch landing, not a new encounter, so no surplus delete is ever sent.
   *
   * A full attempt that left the residue in place is a probe byte the fence
   * DROPPED — it can swallow the erase exactly like it swallows the probe. The
   * plan's residue rule then applies again: erase the observed count and wait
   * another bounded window, still inside the ONE global budget. The helper
   * still has to observe the exact empty editor before it returns, and any
   * content that is not this probe's own all-`x` tail fails here instead of
   * being cleared.
   */
  const eraseResidue = async (count: number): Promise<void> => {
    let sent = 0
    let until = Math.min(Date.now() + ERASE_OBSERVATION_MS, deadline)
    const eraseUpTo = (observed: number): void => {
      for (let index = sent; index < observed; index += 1) pane.input.type(BACKSPACE)
      sent = Math.max(sent, observed)
    }
    eraseUpTo(count)
    for (;;) {
      last = read()
      if (isEmpty(last)) return
      if (last.cursor !== -1 && !isProbeResidue(last)) {
        fail('a non-empty editor that is not the probe\'s own residue cannot be cleared')
      }
      if (last.cursor !== -1) eraseUpTo(last.text.length)
      if (Date.now() >= until) {
        if (Date.now() >= deadline) fail('the probe bytes could not be erased to the empty editor')
        sent = 0
        until = Math.min(Date.now() + ERASE_OBSERVATION_MS, deadline)
        continue
      }
      await sleep(POLL_MS)
    }
  }

  /**
   * Poll until the wire shows the EXACT empty editor. A missing editor node
   * (`cursor` -1) is never ready — it is not an editor that has accepted
   * anything. Probe residue is erased first; any other content is a test-state
   * error.
   */
  const waitForEmptyEditor = async (waitCapMs: number): Promise<'empty' | 'timeout'> => {
    const waitUntil = Math.min(Date.now() + waitCapMs, deadline)
    for (;;) {
      last = read()
      if (isEmpty(last)) return 'empty'
      if (last.cursor !== -1 && !isProbeResidue(last)) {
        fail('a non-empty editor that is not the probe\'s own residue cannot be cleared')
      }
      if (last.cursor !== -1) {
        phase = 'erasing probe residue'
        await eraseResidue(last.text.length)
        return 'empty'
      }
      if (Date.now() >= waitUntil) return 'timeout'
      await sleep(POLL_MS)
    }
  }

  for (;;) {
    if (Date.now() >= deadline) fail('the absolute deadline was reached')
    phase = 'waiting for an observable empty editor'
    if (await waitForEmptyEditor(deadline - Date.now()) === 'timeout') {
      fail('the empty editor never became observable')
    }
    phase = 'observing one real typed probe'
    attempts += 1
    pane.input.type(PROBE)
    const sliceUntil = Math.min(Date.now() + PROBE_OBSERVATION_MS, deadline)
    let accepted = false
    for (;;) {
      last = read()
      if (last.text === PROBE && last.cursor === 1) {
        accepted = true
        break
      }
      if (isEmpty(last) || last.cursor === -1) {
        // Not landed yet (or the node is not observable): never read as ready.
      } else if (isProbeResidue(last)) {
        // A late probe byte landed (or the erase was dropped): clear it, retry.
        phase = 'erasing accumulated probe bytes'
        await eraseResidue(last.text.length)
        break
      } else {
        fail('a non-empty editor that is not the probe\'s own residue cannot be cleared')
      }
      if (Date.now() >= sliceUntil) break
      await sleep(POLL_MS)
    }
    if (!accepted) continue
    phase = 'erasing the accepted probe'
    await eraseResidue(1)
    return
  }
}
