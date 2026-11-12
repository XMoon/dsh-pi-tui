/**
 * M6-1 F8: exact Session approval policy in the REAL Split Host/Clients.
 *
 * ONE real Host (the installed candidate package plus the qualification
 * fixture row) and TWO real authenticated TUI Clients prove:
 *
 *   1. the Host fixture seeds two live Sessions with INDEPENDENT official
 *      policy facts (A: deployment defaults; B: approval `never` + a
 *      `workspace-write` sandbox override) through the official services, and
 *      the private `piTuiSessionPolicy` service is Ready alongside F7A/F7B;
 *   2. two real TUI Clients open the SAME Session A; A's Settings → Agent
 *      paints the PROVEN effective policy and `Session override: none` —
 *      never a guessed value before the read answers;
 *   3. Client A writes the standalone `approval: never` through the one exact
 *      Session: pending → verified; the OFFICIAL durable `approval/policy`
 *      event fires; NO `sandbox/mode` event follows (the sandbox knob is
 *      untouched);
 *   4. Client B re-reads (r) the same Session policy and sees `never`, then
 *      writes `ask`; A re-reads and sees `ask` — the official durable event
 *      is the authority behind both, never a local optimistic value;
 *   5. the Host fixture's independent Session B fact (approval never +
 *      workspace-write sandbox) never leaks into Session A's reads and vice
 *      versa (the wire read is keyed by the exact session id);
 *   6. after both Clients exit and the Host durably flushes, a FRESH Host on
 *      the SAME isolated home resumes Session A and the OFFICIAL projections
 *      replay `approval/policy` (`ask`) — not a Client RAM value.
 *
 * ACK-fault evidence: an ACK-dropped write is proven where its REAL seam
 * exists — the real Gateway with a one-shot carrier fault (L5) and the
 * application-level Settings `indeterminate` path (L4). This product path
 * never injects production faults, so L6_ACK_FAULT stays NOT_VERIFIED here
 * unless an Owner decision says otherwise.
 *
 * @module split-process/session-policy-f8
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const SESSION_A = 'f8-policy-session-a'
const SESSION_B = 'f8-policy-session-b'

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /settings|policy|effective|override|approval|sandbox/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

/** Submit one slash command / line from a proven-empty editor seat. */
async function submitLine(client, line, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `f8-ready-${String(attempt + 1)}`
    client.send(marker)
    try {
      await client.waitForComposerDraft(marker, 8_000)
    } catch {
      client.send('\x15')
      await sleep(300)
      continue
    }
    client.send('\x15')
    for (let poll = 0; poll < 60; poll += 1) {
      const composer = await client.composerText()
      const empty = composer === undefined
        || composer.split('\n').every(text => text.replace(/[│┌┐└┘─]/gu, ' ').replace(/❯/gu, ' ').trim() === '')
      if (empty) {
        client.send(`${line}\r`)
        return
      }
      await sleep(100)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the editor seat never accepted the submitted line`)
}

/** Read the Host work-event log (one JSON object per line). */
function readEvents(root) {
  const path = join(root, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function waitForEvent(root, predicate, label, timeoutMs = 60_000) {
  let found
  try {
    await waitForCondition(() => {
      found = readEvents(root).find(predicate)
      return found !== undefined
    }, label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify(readEvents(root).slice(-24))}`, { cause: error })
  }
  return found
}

/** Open `/settings` and walk the rail to the Agent category. */
async function openAgentCategory(client, label) {
  await submitLine(client, '/settings', `${label} /settings`)
  await waitForScreenText(client, 'Settings', `${label} settings workspace`)
  for (let step = 0; step < 12; step += 1) {
    const frame = (await client.viewport()).join('\n')
    if (/^\s*> Agent\b/mu.test(frame)) break
    client.send('\x1b[B')
    await sleep(200)
  }
  const frame = (await client.viewport()).join('\n')
  assert(/^\s*> Agent\b/mu.test(frame), `${label}: the Agent category was never selected: ${JSON.stringify(frame)}`)
  client.send('\r') // L0 -> L1 rows
  await waitForScreenText(client, 'Approval policy (this session)', `${label} approval row`)
}

/** Enter the approval Detail (the inline choice), waiting for the read. */
async function openApprovalDetail(client, label) {
  client.send('\r')
  await waitForScreenText(client, 'Choose value', `${label} approval choices`)
}

/** Move the inline choice cursor onto `value` and confirm it. The panel starts
 *  the choice on the CURRENT value and clamps at the list ends (no wrap), so
 *  the direction comes from the frozen candidate order [ask, never] and the
 *  painted `[current]` chip (the candidate column shares physical lines with
 *  the rows column, so the chip is located anywhere in the line). */
/** Leave the Settings workspace and prove the MAIN editor seat is live again
 *  (the `/exit` line must reach the composer, not a Settings choice). */
async function exitSettingsWorkspace(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `f8-exit-${String(attempt)}`
    client.send(probe)
    try {
      await client.waitForComposerDraft(probe, 1_200)
      client.send('\x15')
      return
    } catch {
      client.send('\x15')
      client.send('\x1b')
      await sleep(300)
    }
  }
  throw new SplitSmokeAssertionError(`${label}: the main editor never regained the seat`)
}

async function chooseApproval(client, value, label) {
  const order = ['ask', 'never']
  for (let step = 0; step < 4; step += 1) {
    const frame = (await client.viewport()).join('\n')
    const current = frame.match(/\b(ask|never)\b[^\n]*\[current\]/u)?.[1]
    if (current === value) break
    if (current === undefined) {
      client.send('\x1b[B')
    } else {
      client.send(order.indexOf(value) > order.indexOf(current) ? '\x1b[B' : '\x1b[A')
    }
    await sleep(250)
  }
  client.send('\r')
  await waitForScreenText(client, 'Verified', `${label} verified readback`)
}

/** The Host fixture's observed approval/sandbox event sequence for one
 *  exact Session (the fixture writes its event log under the work root). */
function sessionKnobEvents(root, sessionId) {
  return readEvents(root).filter(event => event.kind === 'f8-knob-event' && event.sessionId === sessionId)
}

/**
 * One case: `session-policy.f8`.
 */
export async function runF8SessionPolicy(context) {
  const { trace, dshHome } = context
  const scene = createC1Scene(context)
  const root = scene.c1WorkRoot('f8-session-policy')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let clientA
  let clientB
  let host

  try {
    const started = await scene.startC1Host('session-policy-f8', 'F8 session policy Host', {
      C1_F8_SESSION_A: SESSION_A,
      C1_F8_SESSION_B: SESSION_B,
      C1_F8_CWD: root,
    }, root)
    host = started.host
    const seeded = await waitForEvent(root, event => event.kind === 'f8-seeded', 'F8 policy seeds')
    const factsA = seeded.sessions.find(entry => entry.sessionId === SESSION_A)
    const factsB = seeded.sessions.find(entry => entry.sessionId === SESSION_B)
    assert(factsA !== undefined && factsB !== undefined, `F8: both seeded Sessions must be recorded: ${JSON.stringify(seeded)}`)
    // The REAL Host composition seeds both Sessions from the composed preset
    // (A: approval ask, sandbox workspace-write); Session B additionally
    // carries its OWN explicit approval never + workspace-write override.
    assert(factsA.approvalEffective === 'ask',
      `F8: Session A must read the composed approval ask: ${JSON.stringify(factsA)}`)
    assert(factsB.approvalEffective === 'never' && factsB.approvalOverride === 'never',
      `F8: Session B must carry its own approval never: ${JSON.stringify(factsB)}`)
    assert(factsB.sandboxEffective === 'workspace-write' && factsB.sandboxOverride === 'workspace-write',
      `F8: Session B must carry its own workspace-write sandbox override: ${JSON.stringify(factsB)}`)
    assert(factsA.approvalEffective !== factsB.approvalEffective,
      'F8: the two Sessions must expose independent approval facts')

    const hostFacts = await hostStatus(host)
    assert(hostFacts.services?.piTuiSessionPolicy === true, 'F8: the piTuiSessionPolicy service must be Ready on this Host')
    assert(hostFacts.services?.piTuiAuthorization === true, 'F8: the F7A service must stay Ready on this Host')
    assert(hostFacts.services?.piTuiCredentialRecords === true, 'F8: the F7B service must stay Ready on this Host')
    trace('f8.seeded', {
      a: { approval: factsA.approvalEffective, sandbox: factsA.sandboxEffective },
      b: { approval: factsB.approvalEffective, sandbox: factsB.sandboxEffective },
    })

    // ── Two real Clients on the SAME Session A. ─────────────────────────────
    const a = await scene.startC1Client('F8 Client A', { SPLIT_PROCESS_CLIENT_SESSION: SESSION_A })
    const b = await scene.startC1Client('F8 Client B', { SPLIT_PROCESS_CLIENT_SESSION: SESSION_A })
    clientA = a.client
    clientB = b.client
    for (const [label, client] of [['A', clientA], ['B', clientB]]) {
      const status = await waitForCondition(async () => {
        const record = client.records.filter(entry => entry.m4b2s === 'surface-status').at(-1)
        return record?.sessionOpen === true && record.openSessionId === SESSION_A
      }, `F8 Client ${label} retains the exact Session A`, 120_000)
      assert(status !== undefined, `F8 Client ${label} did not open Session A`)
    }

    // ── Client A reads the proven effective policy and override none. ──────
    await openAgentCategory(clientA, 'F8 A')
    await openApprovalDetail(clientA, 'F8 A')
    await waitForScreenText(clientA, 'Effective: ask', 'F8 A effective ask')
    // The composed preset seeds an explicit ask override on Session A; the row
    // states whatever the Host actually proves (never a guessed none).
    await waitForScreenText(clientA, 'Session override: ask', 'F8 A proven override')
    // The sandbox fact is projected from the SAME observation in the footer.
    trace('f8.read-a', { effective: 'ask' })

    // ── Client A writes the standalone approval never. ─────────────────────
    await chooseApproval(clientA, 'never', 'F8 A never write')
    await waitForHostSessionEvent(dshHome, SESSION_A,
      event => event.type === 'approval/policy' && event.data?.policy === 'never',
      'F8 official durable approval/policy event (never)')
    const knobA = sessionKnobEvents(root, SESSION_A)
    assert(knobA.some(event => event.type === 'approval/policy' && event.value === 'never'),
      `F8: the Host observed the official approval/policy event: ${JSON.stringify(knobA)}`)
    assert(!knobA.some(event => event.type === 'sandbox/mode'),
      `F8: the approval write mutated no sandbox knob: ${JSON.stringify(knobA)}`)
    trace('f8.a-wrote', { policy: 'never', sandboxTouched: false })

    // ── Client B reads the SAME Session after A's write and sees never. ────
    // (B's FIRST authoritative read already reflects A's committed durable
    // event: no poll, no optimistic patch.)
    await openAgentCategory(clientB, 'F8 B')
    await openApprovalDetail(clientB, 'F8 B')
    await waitForScreenText(clientB, 'Effective: never', 'F8 B reads the cross-client never')
    await waitForScreenText(clientB, 'Session override: never', 'F8 B sees the explicit override')

    // ── Client B writes ask; A re-reads and sees ask. ──────────────────────
    await chooseApproval(clientB, 'ask', 'F8 B ask write')
    await waitForHostSessionEvent(dshHome, SESSION_A,
      event => event.type === 'approval/policy' && event.data?.policy === 'ask'
        && sessionKnobEvents(root, SESSION_A).filter(entry => entry.type === 'approval/policy' && entry.value === 'ask').length >= 1,
      'F8 official durable approval/policy event (ask)')
    assert(!sessionKnobEvents(root, SESSION_A).some(event => event.type === 'sandbox/mode'),
      'F8: neither write touched the sandbox knob')
    clientA.send('r')
    await waitForScreenText(clientA, 'Effective: ask', 'F8 A refresh sees ask')
    await waitForScreenText(clientA, 'Session override: ask', 'F8 A sees the explicit ask override')
    trace('f8.b-wrote', { policy: 'ask', aObserved: true })

    // ── Session B facts are never blended into Session A. ──────────────────
    // The Host fixture already proved the two official facts independent; the
    // real Client read of A above never showed B's workspace-write override.
    const frameA = (await clientA.viewport()).join('\n')
    assert(!/Session override: workspace-write/u.test(frameA),
      'F8: Session B\'s sandbox override must not appear in Session A\'s policy row')

    // ── Both Clients exit; the Host durably flushes and stops. ─────────────
    for (const [label, client] of [['A', clientA], ['B', clientB]]) {
      await exitSettingsWorkspace(client, `F8 Client ${label}`)
      client.send('/exit\r')
      await client.waitForExit(60_000)
      await client.dispose()
    }
    await scene.stopC1Host(host)
    clientA = undefined
    clientB = undefined
    host = undefined

    // ── A FRESH Host on the SAME home replays the durable Session A facts. ─
    const replay = await scene.startC1Host('session-policy-f8-replay', 'F8 replay Host', {
      C1_F8_SESSION_A: SESSION_A,
      C1_F8_SESSION_B: SESSION_B,
      C1_F8_CWD: root,
    }, root)
    const replayed = await waitForEvent(root, event => event.kind === 'f8-replayed', 'F8 durable replay facts')
    assert(replayed.sessionId === SESSION_A, 'F8: the replayed fact belongs to the exact Session A')
    assert(replayed.approvalOverride === 'ask' && replayed.approvalEffective === 'ask',
      `F8: the durable approval/policy replay must read ask: ${JSON.stringify(replayed)}`)
    assert(replayed.sandboxEffective === factsA.sandboxEffective,
      `F8: the durable replay keeps the untouched sandbox fact: ${JSON.stringify(replayed)}`)
    const replayHostFacts = await hostStatus(replay.host)
    assert(replayHostFacts.services?.piTuiSessionPolicy === true,
      'F8: the private session-policy service must be Ready on the replayed Host too')
    await scene.stopC1Host(replay.host)
    trace('f8.replayed', {
      approval: replayed.approvalEffective,
      sandbox: replayed.sandboxEffective,
      durable: true,
    })

    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
