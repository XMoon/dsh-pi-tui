/**
 * M5-U-D gate: the Session Workspace's real Needs-attention row, its read-only
 * Peek and the committed row open.
 *
 * ONE real Host + two genuine PiTUI Clients on independent `script(1)` PTYs:
 *   A is committed on Session Y; B owns Session X and triggers the real
 *   forwarded Question. Through the real workspace A must
 *     - paint X as a `Needs attention` row while its committed Session is Y,
 *     - keep the answerable modal OFF that frame,
 *     - open a read-only Peek (no answer affordance, no Host write),
 *     - and only after the row is opened (a real committed switch) receive the
 *       SAME official request, answered exactly once.
 *
 * @module split-process/session-workspace-activity
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { lastSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { createDualSurfaceSceneTools } from './dual-surface-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The panel's identity-first short id (the row label next to the title). */
const shortSessionId = id => id.replace(/^session[-_]/i, '').slice(0, 8)

/** Run the Session Workspace activity qualification. */
export async function runSessionWorkspaceActivity(context) {
  const { dshHome, trace } = context
  const tools = createDualSurfaceSceneTools(context)
  const { submitPrompt, startDualSurfaceScene, selectPaintedSessionRow } = tools
  const viewportText = async client => (await client.viewport()).join('\n')

  const { workRoot, clientA, clientB, sessionX, sessionY } =
    await startDualSurfaceScene('question', 'ud-workspace-activity')
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A did not start committed on Session Y')

  // B owns X and triggers the ONE real forwarded Question.
  await submitPrompt(clientB, 'm5c-question-trigger', 'U-D question trigger')
  await waitForC1WorkEvent(workRoot,
    event => event.kind === 'question-request' && event.sessionId === sessionX,
    'U-D Host question request', 120_000)
  await clientB.waitForScreen('[1] Proceed', 'U-D B question modal', 120_000)
  await sleep(1_000)
  assert(!(await viewportText(clientA)).includes('[1] Proceed'),
    "U-D A painted X's question modal while its committed Session was Y")

  // ── The grouped list proves X as a Needs row, from the real sources ────────
  await submitPrompt(clientA, '/sessions', 'U-D open the Session Workspace')
  // The PR2 Session Workspace header is `Sessions · N`; the retired
  // `Workspace:` scope header is not part of the surface any more.
  await clientA.waitForScreen('Sessions ·', 'U-D Session Workspace frame', 60_000)
  const deadline = Date.now() + 60_000
  let frame = await viewportText(clientA)
  while (!frame.includes('Needs attention') && Date.now() < deadline) {
    await sleep(100)
    frame = await viewportText(clientA)
  }
  assert(frame.includes('Needs attention'), `U-D the workspace never proved a Needs row:\n${frame}`)
  assert(frame.includes(shortSessionId(sessionX)), `U-D the Needs row does not name Session X:\n${frame}`)
  assert(!frame.includes('[1] Proceed'), `U-D the workspace painted the answerable modal:\n${frame}`)
  // The tree's initial cursor is the current Session; the Needs row is its
  // sibling, so select it through the REAL arrow keys before the read-only
  // Peek (the PR2 tree is Workspace-grouped, not a flat Needs section).
  await selectPaintedSessionRow(clientA, sessionX, 'U-D select the Needs row')
  trace('ud-workspace-needs', { sessionX, sessionY, frame: frame.split('\n') })

  // ── Space Peek: read-only, no answer affordance, no Host write ────────────
  const eventsBeforePeek = (hostSessionEvents(dshHome, sessionX) ?? []).length
  clientA.send(' ')
  await clientA.waitForScreen('Peek ·', 'U-D read-only Peek', 30_000)
  const peek = await viewportText(clientA)
  assert(peek.includes('Pending: Question'),
    `U-D the Peek does not state the proved pending kind:\n${peek}`)
  assert(!/Allow|Deny|Proceed/.test(peek), `U-D the Peek carries an answer affordance:\n${peek}`)
  trace('ud-workspace-peek', { sessionX, frame: peek.split('\n') })
  clientA.send('\x1b')
  // The Peek body must really be GONE before the next key: `Sessions ·` is the
  // persistent header and would pass a vacuous wait, and an Enter delivered
  // while the Esc is still in the same chunk parses as Alt+Enter.
  await clientA.waitForScreenGone('Peek ·', 'U-D Peek back to the list', 30_000)
  assert((hostSessionEvents(dshHome, sessionX) ?? []).length === eventsBeforePeek,
    'U-D Peek wrote a Host session event')

  // ── The row open is a real committed switch; only then the modal ──────────
  const openIndex = (hostSessionEvents(dshHome, sessionX) ?? []).length
  clientA.send('\r')
  await clientA.waitForScreen('[1] Proceed', 'U-D X modal after the committed row open', 120_000)
  assert((hostSessionEvents(dshHome, sessionX) ?? []).slice(openIndex)
    .every(event => event.type !== 'tool/result' && event.type !== 'turn/end'),
  'U-D opening the workspace row settled the Host question')
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionX,
    'U-D Client A did not commit Session X from the workspace row')

  clientA.send('1')
  await clientA.waitForScreen('Review your answer before submit', 'U-D answer review', 30_000)
  clientA.send('\r')
  const settled = await waitForC1WorkEvent(workRoot,
    event => event.kind === 'question-settled' && event.sessionId === sessionX,
    'U-D Host question settled', 120_000)
  assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
    `U-D the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
  assert(!(await viewportText(clientB)).includes('[1] Proceed'),
    'U-D the loser Client B kept an answerable modal after the first settlement')
  trace('ud-workspace-answered', { sessionX, sessionY })
  await tools.scene.dispose()
}
