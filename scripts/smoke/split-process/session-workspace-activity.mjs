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

  // ── The grouped list under the official folder (pre-drop baseline) ────────
  await submitPrompt(clientA, '/sessions', 'U-D open the Session Workspace')
  // The PR2 Session Workspace header is `Sessions · N`; the retired
  // `Workspace:` scope header is not part of the surface any more.
  await clientA.waitForScreen('Sessions ·', 'U-D Session Workspace frame', 60_000)
  const folderLine = lines => lines.find(line => /▾ .+ · 2 .*Current/u.test(line))
  const xLine = lines => lines.find(line => line.includes(shortSessionId(sessionX)))
  const yLine = lines => lines.find(line => line.includes(shortSessionId(sessionY)))
  // Only the real Workspace membership notice is the membership authority; the
  // skills invalidation text is NOT a Workspace fact.
  const revoked = lines => lines.some(line => line.includes('Workspace membership unavailable'))
  const proofDeadline = Date.now() + 60_000
  let frameLines = await clientA.viewport()
  while (!(folderLine(frameLines) !== undefined
    && xLine(frameLines) !== undefined
    && yLine(frameLines) !== undefined) && Date.now() < proofDeadline) {
    await sleep(100)
    frameLines = await clientA.viewport()
  }
  assert(folderLine(frameLines) !== undefined,
    `U-D the workspace never painted the official Workspace folder with both members:\n${frameLines.join('\n')}`)
  assert(xLine(frameLines) !== undefined,
    `U-D the official folder does not contain Session X:\n${frameLines.join('\n')}`)
  assert(yLine(frameLines) !== undefined,
    `U-D the official folder does not contain committed Session Y:\n${frameLines.join('\n')}`)
  assert(!frameLines.join('\n').includes('[1] Proceed'), 'U-D the workspace painted the answerable modal')
  // Select X BEFORE the drop and prove the real painted cursor; no selection
  // repair is allowed after the reconnect.
  await selectPaintedSessionRow(clientA, sessionX, 'U-D select the X row before the drop')
  const selectedLines = await clientA.viewport()
  assert(selectedLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)),
    `U-D the real painted cursor is not on X before the drop:\n${selectedLines.join('\n')}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A left committed Session Y before the carrier drop')
  assert(folderLine(selectedLines) !== undefined, 'U-D the folder proof vanished before the carrier drop')
  trace('ud-workspace-pre-drop', { sessionX, sessionY, folder: folderLine(selectedLines)?.trim(), frame: selectedLines })

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
  const generationAfterDrop = lastSurfaceStatus(clientA)?.generationId
  assert(typeof generationAfterDrop === 'number' && generationAfterDrop !== generationBeforeDrop,
    'U-D the reconnected Client published no distinct new generation')
  // Only AFTER the new generation is connected does a viewport become admissible
  // recovery evidence: a pre-drop frame can never satisfy this predicate.
  const recoveredDeadline = Date.now() + 60_000
  let recoveredLines = await clientA.viewport()
  while (!(folderLine(recoveredLines) !== undefined
    && xLine(recoveredLines) !== undefined
    && yLine(recoveredLines) !== undefined
    && !revoked(recoveredLines)
    && recoveredLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)))
    && Date.now() < recoveredDeadline) {
    await sleep(100)
    recoveredLines = await clientA.viewport()
  }
  assert(folderLine(recoveredLines) !== undefined,
    `U-D the panel never re-proved the official folder after the drop:\n${recoveredLines.join('\n')}`)
  assert(xLine(recoveredLines) !== undefined,
    `U-D the recovered folder lost Session X:\n${recoveredLines.join('\n')}`)
  assert(yLine(recoveredLines) !== undefined,
    `U-D the recovered folder lost committed Session Y:\n${recoveredLines.join('\n')}`)
  assert(!revoked(recoveredLines),
    `U-D the recovery frame still carries a membership revocation:\n${recoveredLines.join('\n')}`)
  assert(recoveredLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)),
    `U-D the carrier recovery lost the painted X cursor:\n${recoveredLines.join('\n')}`)
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A left committed Session Y during the carrier recovery')
  assert(lastSurfaceStatus(clientA)?.generationId === generationAfterDrop,
    'U-D the recovery frame is not on the connected new generation')
  trace('ud-workspace-carrier-recovery', {
    sessionX,
    sessionY,
    generationBeforeDrop,
    generationAfterDrop,
    folder: folderLine(recoveredLines)?.trim(),
    frame: recoveredLines,
  })

  // ── The ORIGINAL Question producer, now after the recovery ────────────────
  // A is still the committed owner of Y and does not own X; the real forwarded
  // Question must reach the still-open panel and repaint X's exact row.
  await submitPrompt(clientB, 'm5c-question-trigger', 'U-D question trigger')
  await waitForC1WorkEvent(workRoot,
    event => event.kind === 'question-request' && event.sessionId === sessionX,
    'U-D Host question request', 120_000)
  await clientB.waitForScreen('[1] Proceed', 'U-D B question modal', 120_000)
  const needsDeadline = Date.now() + 60_000
  let needsLines = await clientA.viewport()
  while (!(folderLine(needsLines) !== undefined
    && xLine(needsLines)?.includes('Needs attention')
    && yLine(needsLines) !== undefined
    && needsLines.find(line => line.startsWith('> '))?.includes(shortSessionId(sessionX)))
    && Date.now() < needsDeadline) {
    await sleep(100)
    needsLines = await clientA.viewport()
  }
  assert(folderLine(needsLines) !== undefined,
    `U-D the post-recovery Needs frame lost the official folder:\n${needsLines.join('\n')}`)
  assert(xLine(needsLines)?.includes('Needs attention'),
    `U-D the exact X row does not carry the Needs fact after the real Question:\n${needsLines.join('\n')}`)
  assert(yLine(needsLines) !== undefined,
    `U-D the post-recovery folder lost committed Session Y:\n${needsLines.join('\n')}`)
  assert(!needsLines.join('\n').includes('[1] Proceed'),
    "U-D A painted X's answerable modal while its committed Session was Y")
  assert(lastSurfaceStatus(clientA)?.openSessionId === sessionY,
    'U-D Client A left committed Session Y when the Question arrived')
  trace('ud-workspace-needs', { sessionX, sessionY, frame: needsLines })

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
