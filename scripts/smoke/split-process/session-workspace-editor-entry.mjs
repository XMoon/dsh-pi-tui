/**
 * M5-U-E gate: the REAL PiTUI Host Editor `←←` entry into the ONE Session
 * Workspace, with the frozen All-workspaces initial scope.
 *
 * ONE real Host + two genuine PiTUI Clients on independent `script(1)` PTYs:
 *   A is committed on Session Y with an EMPTY main Editor; B owns Session X
 *   and triggers the real forwarded Question. Without typing `/sessions` (or
 *   calling any API) A presses Left twice inside the 600ms window through the
 *   real terminal, and through the existing registered command must
 *   - open the ONE fullscreen Session Workspace with `All workspaces`,
 *   - paint X as a `Needs attention` row while A stays committed on Y,
 *   - keep the answerable modal OFF A's frame,
 *   - return to the SAME Y/empty editor on Esc without a switch or a Host
 *     stop,
 *   - never turn a plain `x` draft plus two Lefts into the entry.
 *
 * @module split-process/session-workspace-editor-entry
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { alive, lastSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** One raw terminal Left press (the legacy arrow sequence). */
const LEFT = '\x1b[D'

/** The panel's identity-first short id (the row label next to the title). */
const shortSessionId = id => id.replace(/^session[-_]/i, '').slice(0, 8)

/**
 * Whether the painter composer box carries NO document text: only its border
 * glyphs, padding and the `❯` prompt chrome remain. The box text is the WHOLE
 * composer region (`composerText`), not the editor's own draft string, so an
 * empty draft is whitespace/chrome-only.
 */
const composerDraftEmpty = composer => composer !== undefined
  && composer.split('\n').every(line => line
    .replace(/[│┌┐└┘─]/gu, ' ')
    .replace(/❯/gu, ' ')
    .trim() === '')

/** Run the Host Editor `←←` Workspace-entry qualification. */
export async function runSessionWorkspaceEditorEntry(context) {
  const { dshHome, trace } = context
  const tools = createDualSurfaceSceneTools(context)
  const { submitPrompt, startDualSurfaceScene, exitC1Client, hostIdentityFacts } = tools
  const viewportText = async client => (await client.viewport()).join('\n')

  const { host, hostBefore, workRoot, clientA, clientB, sessionX, sessionY } =
    await startDualSurfaceScene('question', 'ue-editor-entry')
  const hostPid = hostBefore.hostPid
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-E Client A did not start committed on Session Y')

  // A's MAIN editor is empty: `startDualSurfaceScene` just submitted `/new`
  // through the real editor (its readiness marker was cleared), and the
  // gesture's own strict-empty admission below is the product proof that the
  // draft really is empty — a non-empty draft cannot open the workspace.
  assert(composerDraftEmpty(await clientA.composerText()),
    `U-E Client A's composer was not empty after /new: ${JSON.stringify(await clientA.composerText())}`)

  // B owns X and triggers the ONE real forwarded Question.
  await submitPrompt(clientB, 'm5c-question-trigger', 'U-E question trigger')
  await waitForC1WorkEvent(workRoot,
    event => event.kind === 'question-request' && event.sessionId === sessionX,
    'U-E Host question request', 120_000)
  await clientB.waitForScreen('[1] Proceed', 'U-E B question modal', 120_000)
  await sleep(1_000)
  assert(!(await viewportText(clientA)).includes('[1] Proceed'),
    "U-E A painted X's question modal while its committed Session was Y")

  // ── TWO independent PTY Left presses on A's real main Editor ─────────────
  // No `/sessions` command and no API call: the gesture itself must open the
  // ONE registered entry. The gap stays under the frozen 600ms window.
  clientA.send(LEFT)
  await sleep(120)
  clientA.send(LEFT)
  await clientA.waitForScreen('Workspace: All workspaces', 'U-E All-scope workspace from two Lefts', 60_000)

  const deadline = Date.now() + 60_000
  let frame = await viewportText(clientA)
  while (!(frame.includes('Needs attention') && frame.includes(shortSessionId(sessionX)))
    && Date.now() < deadline) {
    await sleep(100)
    frame = await viewportText(clientA)
  }
  assert(frame.includes('Workspace: All workspaces'), `U-E the gesture did not ask for All workspaces:\n${frame}`)
  assert(frame.includes('Needs attention'), `U-E the workspace never proved a Needs row:\n${frame}`)
  assert(frame.includes(shortSessionId(sessionX)), `U-E the Needs row does not name Session X:\n${frame}`)
  assert(!frame.includes('[1] Proceed'), `U-E the workspace painted the answerable modal:\n${frame}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-E opening the workspace switched A away from its committed Session')
  trace('ue-editor-entry-open', {
    sessionX,
    sessionY,
    hostPid,
    frame: frame.split('\n'),
  })

  // ── Space Peek stays read-only; the root Esc restores the SAME editor ────
  const eventsBeforePeek = (hostSessionEvents(dshHome, sessionX) ?? []).length
  clientA.send(' ')
  await clientA.waitForScreen('Peek ·', 'U-E read-only Peek', 30_000)
  const peek = await viewportText(clientA)
  assert(peek.includes('Pending: Question'),
    `U-E the Peek does not state the proved pending kind:\n${peek}`)
  assert(!/Allow|Deny|Proceed/.test(peek), `U-E the Peek carries an answer affordance:\n${peek}`)
  clientA.send('\x1b')
  await clientA.waitForScreenGone('Peek ·', 'U-E Peek back to the list', 30_000)
  assert((hostSessionEvents(dshHome, sessionX) ?? []).length === eventsBeforePeek,
    'U-E Peek wrote a Host session event')

  clientA.send('\x1b')
  await clientA.waitForScreenGone('Workspace: ', 'U-E workspace closed back to the main screen', 60_000)
  const afterClose = await viewportText(clientA)
  assert(!afterClose.includes('Workspace: '), `U-E the workspace did not close:\n${afterClose}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-E closing the workspace changed A\'s committed Session')
  assert(composerDraftEmpty(await clientA.composerText()),
    'U-E closing the workspace left a changed/dirty main draft')
  trace('ue-editor-entry-closed', { sessionX, sessionY, hostPid })

  // B's live Turn/Question survived A's open/close untouched.
  assert((await viewportText(clientB)).includes('[1] Proceed'),
    'U-E A\'s workspace open/close dismissed B\'s live Question')
  assert(alive(hostPid), 'U-E the Host died across A\'s workspace open/close')

  // ── The adjacent negative: a plain draft plus two Lefts never opens ──────
  clientA.send('x')
  await clientA.waitForComposerDraft('x', 8_000)
  clientA.send(LEFT)
  await sleep(120)
  clientA.send(LEFT)
  await sleep(500)
  const withDraft = await viewportText(clientA)
  assert(!withDraft.includes('Workspace: '),
    `U-E a non-empty draft plus two Lefts opened the workspace:\n${withDraft}`)
  assert(!composerDraftEmpty(await clientA.composerText()), 'U-E the negative path changed the draft')
  // Clear the fixture draft through the REAL editor and WAIT for the empty
  // frame before typing anything else: an unobserved `/exit` would be appended
  // to the leftover draft and submitted as a prompt instead of the command.
  // The two Lefts parked the cursor at column 0, so End first (a Backspace at
  // column 0 would delete nothing).
  clientA.send('\x1b[F')
  await sleep(150)
  await clientA.clearComposerDraft('x')
  assert(composerDraftEmpty(await clientA.composerText()),
    'U-E the negative fixture draft did not clear before exit')
  trace('ue-editor-entry-negative', { sessionX, sessionY, hostPid })

  // ── B answers the ORIGINAL pending exactly once; A never answered it ─────
  clientB.send('1')
  await clientB.waitForScreen('Review your answer before submit', 'U-E B answer review', 30_000)
  clientB.send('\r')
  const settled = await waitForC1WorkEvent(workRoot,
    event => event.kind === 'question-settled' && event.sessionId === sessionX,
    'U-E Host question settled', 120_000)
  assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
    `U-E the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
  assert(!(await viewportText(clientB)).includes('[1] Proceed'),
    'U-E Client B kept an answerable modal after the first settlement')

  // A exits; the Host and B stay alive (no hidden stop/cleanup owner).
  await exitC1Client(clientA, 'U-E Client A')
  assert(alive(hostPid), 'U-E the Host died after A exited')
  const hostAfter = await hostIdentityFacts(host)
  assert(hostAfter.hostPid === hostPid, 'U-E the Host identity changed after A exited')
  trace('ue-editor-entry-answered', { sessionX, sessionY, hostPid })
  await tools.scene.dispose()
}
