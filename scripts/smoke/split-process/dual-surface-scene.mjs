/**
 * The shared REAL two-Client scene helpers used by the U-A read-authority case
 * and the PR-G567 navigation-first interaction case.
 *
 * One real Host + two genuine PiTUI Clients on independent `script(1)` PTYs,
 * with A admitted on its own Session Y and B on a different Session X (or a
 * caller-chosen subset). The helpers only drive the REAL product entries and
 * read the REAL surface status/Host events: no fake Peer, no second listing,
 * no private RPC.
 *
 * @module split-process/dual-surface-scene
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, lastSurfaceStatus, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Build the shared helpers over ONE isolated smoke installation. The caller
 * owns the returned scene's disposal.
 */
export function createDualSurfaceSceneTools(context) {
  const scene = createC1Scene(context)
  const { startC1Host, startC1Client, exitC1Client, stopC1Host, hostIdentityFacts } = scene

  /**
   * Submit one line from a PROVEN-ready editor seat. A keystroke the session
   * transition (or a closing modal) drops is lost for good, so readiness is
   * observed first with a harmless marker draft, and once the editor holds it
   * the real line and its Enter are sent as ONE write (a separately delivered
   * Enter can be consumed by an open command-completion list).
   */
  let submitMarkerSequence = 0
  const submitPrompt = async (client, text, label) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const marker = `ds-ready-${String(++submitMarkerSequence)}`
      client.send(marker)
      try {
        await client.waitForComposerDraft(marker, 8_000)
      } catch {
        client.send('\x15')
        await sleep(300)
        continue
      }
      client.send('\x15')
      let cleared = false
      for (let poll = 0; poll < 60; poll += 1) {
        const draft = await client.composerText()
        if (draft !== undefined && !draft.includes(marker)) {
          cleared = true
          break
        }
        await sleep(100)
      }
      if (!cleared) continue
      client.send(`${text}\r`)
      return
    }
    throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted line`)
  }

  /**
   * Enter a Session through the OLD `/resume <id>` path, idempotently: the
   * command is a real navigation that can be superseded by surrounding
   * interaction churn, so it is retried (a retry while X is already current is
   * the harmless `already on this session` no-op) and the committed visible
   * status is the ONLY success.
   */
  const resumeSession = async (client, sessionId, label) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (lastSurfaceStatus(client)?.openSessionId === sessionId) return
      await submitPrompt(client, `/resume ${sessionId}`, `${label} attempt ${String(attempt + 1)}`)
      try {
        await waitForSurfaceStatus(client,
          record => record.sessionOpen === true && record.openSessionId === sessionId,
          `${label} committed`,
          25_000)
        return
      } catch {
        client.send('\x15')
        await sleep(500)
      }
    }
    throw new SplitSmokeAssertionError(
      `${label}: /resume never committed (open=${JSON.stringify(lastSurfaceStatus(client)?.openSessionId)})`)
  }

  /**
   * Admit A on Session Y and (by default) B on a DIFFERENT Session X.
   *
   * `clientEnv` is applied to BOTH Clients; `aEnv`/`bEnv` add per-side values
   * (B wins on an overlapping key). `openB: false` admits B sessionless.
   */
  const startDualSurfaceScene = async (scenario, label, extraHostEnv = {}, options = {}) => {
    const {
      openB = true,
      bCwd,
      clientEnv = {},
      aEnv = {},
      bEnv = {},
    } = options
    const { host, ready: hostReady, workRoot } = await startC1Host(scenario, label, extraHostEnv)
    const hostBefore = await hostIdentityFacts(host)
    assert(hostBefore.hostPid === hostReady.pid, `${label} the Host ready record does not own the Host identity`)
    const { client: clientA, ready: aReady } = await startC1Client(`${label} A`, { ...clientEnv, ...aEnv })
    await submitPrompt(clientA, '/new', `${label} A /new`)
    const aOpen = await waitForSurfaceStatus(clientA,
      record => record.sessionOpen === true
        && typeof record.openSessionId === 'string'
        && record.transport === 'connected'
        && record.surfaceMounted === true,
      `${label} Client A opened Session Y`,
      120_000)
    const sessionY = aOpen.openSessionId
    const { client: clientB, ready: bReady } = await startC1Client(
      `${label} B`,
      { ...clientEnv, ...bEnv },
      bCwd === undefined ? {} : { cwd: bCwd },
    )
    let sessionX
    if (openB) {
      await submitPrompt(clientB, '/new', `${label} B /new`)
      const bOpen = await waitForSurfaceStatus(clientB,
        record => record.sessionOpen === true
          && typeof record.openSessionId === 'string'
          && record.transport === 'connected'
          && record.surfaceMounted === true,
        `${label} Client B opened Session X`,
        120_000)
      sessionX = bOpen.openSessionId
      assert(typeof sessionX === 'string' && sessionX !== '',
        `${label} Client B published no Session identity`)
      assert(sessionX !== sessionY, `${label} A and B opened the SAME Session; the scene needs two`)
    }
    assert(typeof sessionY === 'string' && sessionY !== '', `${label} Client A published no Session identity`)
    for (const [side, ready] of [['A', aReady], ['B', bReady]]) {
      assert(Number.isInteger(ready.pid) && ready.pid > 0 && ready.pid !== hostBefore.hostPid,
        `${label} Client ${side} published no live business PID distinct from the Host`)
      assert(alive(ready.pid), `${label} Client ${side} is not a live business process`)
    }
    assert(aReady.pid !== bReady.pid, `${label} the two Clients must be two different business PIDs`)
    assert(alive(hostBefore.hostPid), `${label} the Host died while both Clients were admitted`)
    return { host, hostBefore, workRoot, clientA, clientB, aReady, bReady, sessionX, sessionY }
  }

  /**
   * Move the REAL painted cursor onto the row naming one Session. The tree's
   * initial cursor is the current Session (or its Folder), so a case that
   * needs a sibling Needs row must select it through the real arrow keys —
   * never through a Wrapper/API shortcut.
   */
  const selectPaintedSessionRow = async (client, sessionId, label, timeoutMs = 60_000) => {
    const short = String(sessionId).replace(/^session[-_]/i, '').slice(0, 8)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const frame = await client.viewport()
      const cursorIndex = frame.findIndex(line => line.startsWith('> '))
      const targetIndex = frame.findIndex(line => line.includes(short))
      if (cursorIndex >= 0 && targetIndex >= 0 && cursorIndex === targetIndex) return
      if (targetIndex >= 0) client.send(targetIndex < cursorIndex ? '\x1b[A' : '\x1b[B')
      else client.send('\x1b[B')
      await sleep(120)
    }
    throw new SplitSmokeAssertionError(`${label}: the painted cursor never reached the ${short} row`)
  }

  return {
    scene,
    startC1Host,
    startC1Client,
    exitC1Client,
    stopC1Host,
    hostIdentityFacts,
    submitPrompt,
    resumeSession,
    startDualSurfaceScene,
    selectPaintedSessionRow,
  }
}
