/**
 * M6-1 F7A: provider-native authorization in real Split Host/Clients.
 *
 * ONE real Host (the installed candidate package plus the qualification
 * fixture row) and TWO real authenticated TUI Clients prove:
 *
 *   1. `/login <route>` deep-links the ONE Models provider detail, the Host
 *      notice (message/URL/code) is painted, and the official flow's
 *      text/secret/select prompts are answered from the real page seats;
 *   2. the official commit settles `authorized`; the TUI paints the real
 *      attempt outcome and re-reads the Host roster;
 *   3. a SECOND Client trying the SAME key while the first attempt owns it
 *      receives the official ALREADY_IN_FLIGHT failure (never a second prompt
 *      owner), and a different key stays independent;
 *   4. a prompt withdrawn by the flow's own signal closes only that prompt and
 *      the attempt continues to the next one;
 *   5. killing the attempt-owning Client withdraws its non-committing official
 *      run (the key is released) and the OTHER Client starts the same key
 *      afterwards;
 *   6. a Client cancel request during the official commit does NOT forge
 *      `cancelled`: the UI reports the cancel request and the official
 *      `authorized` settlement wins.
 *
 * The provider flows are registered by the qualification Host fixture on the
 * REAL `ctx.authorization` service and commit through the official
 * `AuthorizationSession.commit()` write path. Nothing here is a fake Client
 * authorization service.
 *
 * @module split-process/provider-authorization-f7a
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { alive, hostStatus, waitForCondition } from '../../lib/split-smoke-processes.mjs'
import { waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const MAIN_KEY = 'llm-pi-ai/f7a-main'
const OTHER_KEY = 'llm-pi-ai/f7a-other'

/** One owned marker under this case's private Host work root. */
function markerPath(root, name) {
  return join(root, name)
}

function createMarker(root, name) {
  mkdirSync(root, { recursive: true, mode: 0o700 })
  writeFileSync(markerPath(root, name), `${name}\\n`, { mode: 0o600 })
}

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /F7A|Sign in|sign-in|provider|Prompt|account|secret|unavailable|failed|unknown/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

/** Submit one slash command / line from a proven-empty editor seat. */
async function submitLine(client, line, label) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const marker = `f7a-ready-${String(attempt + 1)}`
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

/**
 * Leave the Models workspace page and prove the MAIN editor seat is live
 * again. The page's provider detail does not paint the list title, so the
 * only reliable witness is that the real composer accepts a draft marker.
 */
async function exitModelsPage(client, label) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const probe = `f7a-exit-${String(attempt)}`
    client.send(probe)
    try {
      await client.waitForComposerDraft(probe, 1_500)
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

/**
 * Type one answer into the page's embedded QuestionFlow and submit it.
 * A free-text answer is TWO steps in the product's own flow: Enter confirms
 * the question and opens the review page, and the next Enter submits the
 * batch. The pause between them is the review render, not a timing guess.
 */
async function answerQuestion(client, answer, label) {
  client.send(answer)
  await sleep(200)
  client.send('\r')
  await sleep(400)
  client.send('\r')
  void label
}

/** Read the Host work-event log (one JSON object per line). */
function readEvents(root) {
  const path = join(root, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function countEvents(events, predicate) {
  return events.filter(predicate).length
}

async function waitForEvent(root, predicate, label, timeoutMs = 60_000) {
  let found
  try {
    await waitForCondition(() => {
      found = readEvents(root).find(predicate)
      return found !== undefined
    }, label, timeoutMs)
  } catch (error) {
    const events = readEvents(root).slice(-20)
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify(events)}`, { cause: error })
  }
  return found
}

async function waitForAttemptsReleased(host, label) {
  await waitForCondition(async () => {
    const status = await hostStatus(host)
    return status.authorizationAttempts === 0
  }, label, 60_000)
}

/**
 * One case: `provider-authorization.f7a`.
 */
export async function runF7AProviderAuthorization(context) {
  const { workDir, trace } = context
  const scene = createC1Scene(context)
  const root = scene.c1WorkRoot('f7a-authorization')
  const credentialsPath = join(context.dshHome, '.credentials.yaml')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  let disposed = false

  try {
    const { host } = await scene.startC1Host('f7a-authorization', 'F7A authorization Host', {}, root)
    const registered = await waitForEvent(root, event => event.kind === 'f7a-flows-registered', 'F7A qualification flows registered on the official authorization service')
    // A pre-existing fixture key would be RESTORED at teardown, contradicting
    // the must-disappear assertion below: rule that premise out at the start.
    assert(registered.baselineKeys.every(key => ![MAIN_KEY, OTHER_KEY].includes(key)),
      `F7A: a fixture record key already existed before the case: ${JSON.stringify(registered.baselineKeys)}`)

    // ── Client A opens the provider detail; Client B opens it BEFORE A starts,
    // so B's roster snapshot still says inFlight=false when it tries the same
    // key (the official service, not a stale row, must refuse it). ───────────
    const { client: clientA } = await scene.startC1Client('F7A authorization A')
    const { client: clientB } = await scene.startC1Client('F7A authorization B')
    await submitLine(clientA, '/login f7a-main', 'F7A A /login f7a-main')
    await waitForScreenText(clientA, '(provider)', 'F7A A provider detail')
    await submitLine(clientB, '/login f7a-main', 'F7A B /login f7a-main')
    await waitForScreenText(clientB, '(provider)', 'F7A B provider detail')

    // ── A starts the real attempt and is HELD before its first prompt. ─────
    createMarker(root, 'f7a-hold-before-prompt')
    clientA.send('\r')
    await waitForScreenText(clientA, 'F7A sign-in', 'F7A A Host notice')
    await waitForScreenText(clientA, 'https://provider.example/f7a', 'F7A A notice URL')
    await waitForScreenText(clientA, 'F7A-CODE-1', 'F7A A device code')
    await waitForEvent(root, event => event.kind === 'f7a-before-prompt-held', 'F7A official attempt in flight')

    // ── B tries the SAME key: the official service refuses ALREADY_IN_FLIGHT.
    clientB.send('\r')
    await waitForScreenText(clientB, 'sign-in already in progress', 'F7A B same-key official refusal')
    const afterRefusal = readEvents(root)
    assert(countEvents(afterRefusal, event => event.kind === 'f7a-run-start' && event.key === MAIN_KEY) === 1,
      'the same-key refusal must not start a second official F7A flow run')

    // ── Release A; answer the real text/secret/select prompts. ─────────────
    createMarker(root, 'f7a-release-before-prompt')
    await waitForScreenText(clientA, 'F7A secret code', 'F7A A secret prompt')
    await answerQuestion(clientA, 'f7a-secret-value-20261112', 'F7A A secret answer')
    await waitForScreenText(clientA, 'F7A account label', 'F7A A text prompt')
    await answerQuestion(clientA, 'f7a-account-label', 'F7A A text answer')
    await waitForScreenText(clientA, 'F7A choose account', 'F7A A select prompt')
    clientA.send('\r')
    await waitForScreenText(clientA, 'signed in to F7A main', 'F7A A authorized outcome')
    await waitForEvent(root, event => event.kind === 'f7a-committed' && event.key === MAIN_KEY, 'F7A official credential commit')
    await waitForEvent(root, event => event.kind === 'f7a-run-end' && event.key === MAIN_KEY, 'F7A official authorized settlement')
    await waitForAttemptsReleased(host, 'F7A Host attempt released after authorized')
    assert(existsSync(credentialsPath) && readFileSync(credentialsPath, 'utf8').includes(MAIN_KEY),
      'F7A the official authorization commit must write the exact credential record on the Host')
    const secretLeak = readEvents(root).some(event => JSON.stringify(event).includes('f7a-secret-value-20261112'))
    assert(!secretLeak, 'F7A the typed secret must never be recorded in the Host qualification proof')
    trace('f7a.authorized', { key: MAIN_KEY, hostPid: (await scene.hostIdentityFacts(host)).hostPid })

    // ── Prompt withdrawal: the flow retires its own losing prompt and asks
    // the next one; the attempt must continue (not cancel). ────────────────
    createMarker(root, 'f7a-withdraw')
    await exitModelsPage(clientA, 'F7A A leaves the Models page before the withdrawal case')
    // Re-open the provider detail through the command deep link.
    await submitLine(clientA, '/login f7a-main', 'F7A A second /login f7a-main')
    await waitForScreenText(clientA, '(provider)', 'F7A A provider detail after authorization')
    clientA.send('\r')
    await waitForScreenText(clientA, 'F7A winning prompt', 'F7A A winning prompt after withdrawal')
    await answerQuestion(clientA, 'f7a-winning-answer', 'F7A A winning answer')
    await waitForScreenText(clientA, 'F7A secret code', 'F7A A secret prompt after withdrawal')
    await answerQuestion(clientA, 'f7a-secret-value-20261112', 'F7A A secret answer (withdrawal case)')
    await waitForScreenText(clientA, 'F7A account label', 'F7A A text prompt after withdrawal')
    await answerQuestion(clientA, 'f7a-account-label', 'F7A A text answer (withdrawal case)')
    await waitForScreenText(clientA, 'F7A choose account', 'F7A A select prompt after withdrawal')
    clientA.send('\r')
    await waitForScreenText(clientA, 'signed in to F7A main', 'F7A A authorized after withdrawal')
    await waitForEvent(root, event => event.kind === 'f7a-withdrawn-prompt' && event.outcome === 'withdrawn', 'F7A prompt-level withdrawal')
    rmSync(markerPath(root, 'f7a-withdraw'), { force: true })
    const withdrawalRuns = readEvents(root).filter(event => event.kind === 'f7a-run-start' && event.key === MAIN_KEY && event.run === 2)
    assert(withdrawalRuns.length === 1, 'the withdrawal case must be one continuing flow run (run #2)')
    await waitForAttemptsReleased(host, 'F7A Host attempt released after withdrawal case')

    // ── Client B signs in to a DIFFERENT key independently. ────────────────
    await exitModelsPage(clientB, 'F7A B leaves the Models page before the other-key case')
    await submitLine(clientB, '/login f7a-other', 'F7A B /login f7a-other')
    await waitForScreenText(clientB, '(provider)', 'F7A B other provider detail')
    clientB.send('\r')
    await waitForScreenText(clientB, 'F7A other sign-in', 'F7A B other notice')
    await waitForScreenText(clientB, 'F7A other secret', 'F7A B other secret prompt')
    await answerQuestion(clientB, 'f7a-other-secret', 'F7A B other secret answer')
    await waitForScreenText(clientB, 'signed in to F7A other', 'F7A B other authorized')
    await waitForEvent(root, event => event.kind === 'f7a-committed' && event.key === OTHER_KEY, 'F7A other official commit')

    // ── A disconnect mid-attempt: the Host withdraws its non-committing
    // attempt, releases the key, and B can start the SAME key afterwards. ──
    await exitModelsPage(clientB, 'F7A B leaves the Models page before A disconnects')
    await exitModelsPage(clientA, 'F7A A leaves the Models page before the disconnect case')
    await submitLine(clientA, '/login f7a-main', 'F7A A third /login f7a-main')
    await waitForScreenText(clientA, '(provider)', 'F7A A provider detail before disconnect')
    clientA.send('\r')
    await waitForEvent(root, event => event.kind === 'f7a-before-prompt-held' && event.run === 3, 'F7A third attempt in flight before the disconnect', 60_000)
    clientA.signalBusiness('SIGKILL')
    await clientA.waitForExit(30_000)
    await waitForEvent(root, event => event.kind === 'f7a-run-failed' && event.aborted === true, 'F7A Host withdrew the disconnected attempt')
    await waitForAttemptsReleased(host, 'F7A Host attempt released after Client disconnect')
    const hostFacts = await scene.hostIdentityFacts(host)
    assert(alive(hostFacts.hostPid), 'F7A the Host must stay alive after one Client disconnects')

    await submitLine(clientB, '/login f7a-main', 'F7A B same key after A disconnect')
    await waitForScreenText(clientB, '(provider)', 'F7A B same-key provider detail after disconnect')
    clientB.send('\r')
    await waitForScreenText(clientB, 'F7A secret code', 'F7A B same-key prompt after disconnect')
    await answerQuestion(clientB, 'f7a-secret-after-disconnect', 'F7A B secret after disconnect')
    await waitForScreenText(clientB, 'F7A account label', 'F7A B text after disconnect')
    await answerQuestion(clientB, 'f7a-account-after-disconnect', 'F7A B text after disconnect')
    await waitForScreenText(clientB, 'F7A choose account', 'F7A B select after disconnect')
    clientB.send('\r')
    await waitForScreenText(clientB, 'signed in to F7A main', 'F7A B same-key authorized after disconnect')

    // ── Cancel during the official commit: the UI reports the request, the
    // official `authorized` settlement still wins (never a forged cancelled). ─
    createMarker(root, 'f7a-hold-after-commit')
    await exitModelsPage(clientB, 'F7A B leaves the Models page before the cancel race')
    await submitLine(clientB, '/login f7a-main', 'F7A B cancel-race /login f7a-main')
    await waitForScreenText(clientB, '(provider)', 'F7A B cancel-race provider detail')
    clientB.send('\r')
    await waitForScreenText(clientB, 'F7A secret code', 'F7A B cancel-race secret prompt')
    await answerQuestion(clientB, 'f7a-cancel-race-secret', 'F7A B cancel-race secret')
    await waitForScreenText(clientB, 'F7A account label', 'F7A B cancel-race text prompt')
    await answerQuestion(clientB, 'f7a-cancel-race-label', 'F7A B cancel-race text')
    await waitForScreenText(clientB, 'F7A choose account', 'F7A B cancel-race select prompt')
    clientB.send('\r')
    await waitForEvent(root, event => event.kind === 'f7a-committed' && event.key === MAIN_KEY && event.run === 5, 'F7A official commit before the cancel request', 60_000)
    await waitForEvent(root, event => event.kind === 'f7a-after-commit-held', 'F7A official attempt held after commit')
    // Reach the "Cancel current attempt" action and activate it. Its label
    // proves the page still owns the exact running attempt.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const frame = (await clientB.viewport()).join('\n')
      if (frame.includes('Cancel current attempt')) break
      await sleep(100)
    }
    clientB.send('\x1b[F') // End → last action (Back)
    await sleep(250)
    clientB.send('\x1b[A') // Up → Cancel current attempt
    await sleep(250)
    clientB.send('\r')
    await waitForScreenText(clientB, 'cancellation requested', 'F7A cancel request painted')
    createMarker(root, 'f7a-release-after-commit')
    await waitForScreenText(clientB, 'signed in to F7A main', 'F7A official authorized after the cancel request')
    await waitForEvent(root, event => event.kind === 'f7a-run-end' && event.key === MAIN_KEY && event.run === 5, 'F7A official settlement after the cancel request')
    await waitForAttemptsReleased(host, 'F7A Host attempt released after the cancel race')

    trace('f7a.cancel-race', { key: MAIN_KEY, officialAuthorizedWon: true })

    // ── Teardown restores the pre-case record state; prove the zero delta. ──
    // The fixture's disposal (a clean Host shutdown) undoes the committed flow
    // records through the official Credentials authority; a later case of the
    // shared lane must inherit exactly the pre-case record set.
    await scene.dispose()
    disposed = true
    const restored = await waitForEvent(root, event => event.kind === 'f7a-records-restored', 'F7A record restore')
    assert(![MAIN_KEY, OTHER_KEY].some(key => restored.keys.includes(key)),
      `F7A: fixture records survived teardown: ${JSON.stringify(restored)}`)
    assert(restored.baselineKeys.every(key => restored.keys.includes(key)),
      `F7A: teardown lost a pre-case record: ${JSON.stringify(restored)}`)
    assert(restored.keys.every(key => restored.baselineKeys.includes(key)),
      `F7A: teardown left new records behind: ${JSON.stringify(restored)}`)
    trace('f7a.records-restored', { zeroDelta: true, keys: restored.keys })
    return { status: 'PASS' }
  } finally {
    if (!disposed) await scene.dispose()
  }
}
