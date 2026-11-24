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
import { lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
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

  // ── The grouped list proves X as a Needs row under the official folder ────
  await submitPrompt(clientA, '/sessions', 'U-D open the Session Workspace')
  // The PR2 Session Workspace header is `Sessions · N`; the retired
  // `Workspace:` scope header is not part of the surface any more.
  await clientA.waitForScreen('Sessions ·', 'U-D Session Workspace frame', 60_000)
  const folderLine = lines => lines.find(line => /▾ .+ · 2 .*Current/u.test(line))
  const xLine = lines => lines.find(line => line.includes(shortSessionId(sessionX)))
  const yLine = lines => lines.find(line => line.includes(shortSessionId(sessionY)))
  const revoked = lines => lines.some(line => line.includes('Workspace membership unavailable')
    || line.includes('Skills invalidation stream'))
  const proofDeadline = Date.now() + 60_000
  let frameLines = await clientA.viewport()
  while (!(folderLine(frameLines) !== undefined
    && xLine(frameLines)?.includes('Needs attention')
    && yLine(frameLines) !== undefined) && Date.now() < proofDeadline) {
    await sleep(100)
    frameLines = await clientA.viewport()
  }
  assert(folderLine(frameLines) !== undefined,
    `U-D the workspace never painted the official Workspace folder with both members:\n${frameLines.join('\n')}`)
  assert(xLine(frameLines)?.includes('Needs attention'),
    `U-D the exact X row does not carry the Needs fact:\n${frameLines.join('\n')}`)
  assert(yLine(frameLines) !== undefined,
    `U-D the official folder does not contain committed Session Y:\n${frameLines.join('\n')}`)
  assert(!frameLines.join('\n').includes('[1] Proceed'), 'U-D the workspace painted the answerable modal')
  // The tree's initial cursor is the current Session; the Needs row is its
  // sibling, so select it through the REAL arrow keys BEFORE the drop and
  // prove the exact painted cursor rather than repairing it after recovery.
  await selectPaintedSessionRow(clientA, sessionX, 'U-D select the Needs row before the drop')
  const selectedLines = await clientA.viewport()
  assert(selectedLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)),
    `U-D the real painted cursor is not on X before the drop:\n${selectedLines.join('\n')}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A left committed Session Y before the carrier drop')
  assert(folderLine(selectedLines) !== undefined, 'U-D the folder proof vanished before the carrier drop')
  trace('ud-workspace-needs', { sessionX, sessionY, folder: folderLine(selectedLines)?.trim(), frame: selectedLines })

  // ── Real carrier drop while the Workspace stays OPEN ──────────────────────
  const generationBeforeDrop = lastSurfaceStatus(clientA)?.generationId
  assert(typeof generationBeforeDrop === 'number', 'U-D Client A had no connected generation before the carrier drop')
  clientA.signalBusiness('SIGUSR1')
  await waitForSurfaceStatus(clientA,
    record => record.transport === 'connected'
      && typeof record.generationId === 'number'
      && record.generationId !== generationBeforeDrop,
    'U-D Client A reconnected on a new generation while the Workspace stayed open',
    120_000)

  // The real revocation interval: the panel keeps its header/rows but the
  // OFFICIAL FOLDER PROOF is withdrawn (flat fallback). A folder line must be
  // absent here — the old predicate (header + Needs substring) also held in
  // this flat state, which is exactly the false positive being fixed.
  const fallbackDeadline = Date.now() + 60_000
  let fallbackLines = await clientA.viewport()
  while (!(revoked(fallbackLines)
    && folderLine(fallbackLines) === undefined
    && fallbackLines.some(line => line.includes('Sessions ·'))) && Date.now() < fallbackDeadline) {
    await sleep(50)
    fallbackLines = await clientA.viewport()
  }
  assert(revoked(fallbackLines),
    `U-D no real membership revocation was observed after the carrier drop:\n${fallbackLines.join('\n')}`)
  assert(folderLine(fallbackLines) === undefined,
    `U-D the flat fallback still painted an official folder proof:\n${fallbackLines.join('\n')}`)
  trace('ud-workspace-flat-fallback', { sessionX, sessionY, frame: fallbackLines })

  // The fresh official membership must be a POSITIVE folder paint with the same
  // X and Y, no revocation notice, X still selected and Y still committed.
  const recoveredDeadline = Date.now() + 120_000
  let recoveredLines = await clientA.viewport()
  while (!(folderLine(recoveredLines) !== undefined
    && xLine(recoveredLines)?.includes('Needs attention')
    && yLine(recoveredLines) !== undefined
    && !revoked(recoveredLines)
    && recoveredLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)))
    && Date.now() < recoveredDeadline) {
    await sleep(100)
    recoveredLines = await clientA.viewport()
  }
  assert(folderLine(recoveredLines) !== undefined,
    `U-D the panel never re-proved the official folder after the drop:\n${recoveredLines.join('\n')}`)
  assert(xLine(recoveredLines)?.includes('Needs attention'),
    `U-D the recovered folder lost X's Needs fact:\n${recoveredLines.join('\n')}`)
  assert(yLine(recoveredLines) !== undefined,
    `U-D the recovered folder lost committed Session Y:\n${recoveredLines.join('\n')}`)
  assert(!revoked(recoveredLines),
    `U-D the recovery frame still carries a revocation notice:\n${recoveredLines.join('\n')}`)
  assert(recoveredLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)),
    `U-D the carrier recovery lost the painted X cursor:\n${recoveredLines.join('\n')}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A left committed Session Y during the carrier recovery')
  trace('ud-workspace-carrier-recovery', {
    sessionX,
    sessionY,
    generationBeforeDrop,
    folder: folderLine(recoveredLines)?.trim(),
    frame: recoveredLines,
  })

  // ── Space Peek: read-only, no answer affordance, no Host write ────────────
  const eventsBeforePeek = (hostSessionEvents(dshHome, sessionX) ?? []).length
  clientA.send(' ')
  // The committed read-only Reader's current header. The pending kind was
  // proven on the row frame before Space; this step proves the Peek is
  // read-only (its provenance line), carries no answer affordance and writes
  // no Host event.
  await clientA.waitForScreen('Transcript ·', 'U-D read-only Peek', 30_000)
  const peek = await viewportText(clientA)
  assert(peek.includes('Read-only'),
    `U-D the Peek does not state its read-only provenance:\n${peek}`)
  assert(!/Allow|Deny|Proceed/.test(peek), `U-D the Peek carries an answer affordance:\n${peek}`)
  trace('ud-workspace-peek', { sessionX, frame: peek.split('\n') })
  clientA.send('\x1b')
  // The Peek body must really be GONE before the next key: `Sessions ·` is the
  // persistent header and would pass a vacuous wait, and an Enter delivered
  // while the Esc is still in the same chunk parses as Alt+Enter.
  await clientA.waitForScreenGone('Transcript ·', 'U-D Peek back to the list', 30_000)
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
  await clientB.waitForScreenGone('[1] Proceed', 'U-D the loser Client B withdrew the answerable modal', 30_000)
  trace('ud-workspace-answered', { sessionX, sessionY })
  await tools.scene.dispose()
}
