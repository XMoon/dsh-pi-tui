/**
 * M6: the REAL Host / REAL Split Client sessionless default-model save.
 *
 * ONE packed candidate, a real Profile-backed Host and real PTY Clients prove
 * the sessionless `/model → Save default` end to end — no Session is created,
 * the write is the OFFICIAL Host `agentDefaultModel.saveSelection` (surfaced as
 * the private `piTuiDefaultModel/saveSelection` bridge), the new default is read
 * back from the Host's OWN `session.modelCatalog()` on a reopened panel, it
 * survives an independent Host restart on the SAME isolated profile, and the
 * next real Session is created on that persisted default.
 *
 * The offline C1 qualification LLM advertises the fixture catalogue; this case
 * turns on a SECOND fixture route (`C1_EXTRA_MODEL`) so a REAL default CHANGE
 * is observable. That fixture route is the plan's declared TEST STAND-IN (an
 * offline provider), never a mocked save: the save still crosses the official
 * `agentDefaultModel.saveSelection` business service.
 *
 * A REAL post-dispatch ACK loss is injected through the qualified transport hook
 * (`SPLIT_PROCESS_CLIENT_DROP_MODEL_ACK`): the request reaches the Host (which
 * performs the official save) and the response is discarded, so the Client can
 * only report `indeterminate`; a Host-authoritative reread then reconciles that
 * the write DID commit, with no automatic retry.
 *
 * @module split-process/sessionless-default-model
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostStatus, waitForCondition, waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { waitForHostSessionEvent } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/** The fixture's saved target route (the second offline catalogue entry). */
const TARGET_MODEL = 'c1-pro'
/** The fixture's pre-existing default route. */
const BASE_MODEL = 'c1'

async function waitForScreenText(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => (await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    const frame = await client.viewport()
    const lines = frame.filter(line => /model|c1|current|loading|select/iu.test(line))
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: text, diagnosticLines: lines.slice(-16) })}`, { cause: error })
  }
}

async function waitForScreenGone(client, text, label, timeoutMs = 60_000) {
  try {
    await waitForCondition(async () => !(await client.viewport()).join('\n').includes(text), label, timeoutMs)
  } catch (error) {
    throw new SplitSmokeAssertionError(`${label}: the ${JSON.stringify(text)} surface never closed`, { cause: error })
  }
}

/** Open the `/model` panel from a proven-empty sessionless editor seat and
 *  wait for its hydrated model directory. */
async function openModelPanel(client, label) {
  // Clear any pending editor content so `/model` is treated as a command.
  client.send('\x15')
  await sleep(150)
  client.send('/model\r')
  await waitForScreenText(client, 'Models', `${label} model panel opened`, 120_000)
  // The panel paints `Loading models…` until the Host directory read settles.
  await waitForCondition(async () => {
    const frame = (await client.viewport()).join('\n')
    return frame.includes('Models') && !frame.includes('Loading models')
  }, `${label} model directory hydrated`, 120_000)
}

/** Filter the open panel to one model id and assert its row is visible. */
async function filterModel(client, modelId, label) {
  client.send(modelId)
  await waitForScreenText(client, modelId, `${label} filtered ${modelId}`, 60_000)
}

/** The sessionless save/default flow: open, filter, commit, wait for close. */
async function saveDefault(client, modelId, label) {
  await openModelPanel(client, label)
  await filterModel(client, modelId, label)
  // Enter commits a no-effort model directly; the picker dismisses ONLY on a
  // committed/indeterminate settlement and stays usable on a refusal.
  client.send('\r')
  await waitForScreenGone(client, 'Models', `${label} picker closed on save`, 120_000)
  // A non-committed settlement surfaces an error notice; surface it loudly so a
  // real save failure is never mistaken for a persisted default.
  await sleep(600)
  const view = (await client.viewport()).join('\n')
  const notice = view.match(/model default save:[^\n]*/u)
  if (notice !== null) throw new SplitSmokeAssertionError(`${label}: ${notice[0].trim()}`)
}

/** A save whose ACK was dropped AFTER the Host committed: the picker dismisses
 *  on the indeterminate settlement and surfaces the failure notice; the write is
 *  NOT retried. */
async function saveDefaultExpectingIndeterminate(client, modelId, label) {
  await openModelPanel(client, label)
  await filterModel(client, modelId, label)
  client.send('\r')
  await waitForScreenGone(client, 'Models', `${label} picker closed on indeterminate`, 120_000)
  await sleep(800)
  // The notice may WRAP across transcript rows, so match the whole flattened
  // frame: a committed save never emits this notice, and an indeterminate ACK
  // loss always carries "may still land" (a definite refusal would not).
  const flat = (await client.viewport()).join(' ').replace(/\s+/gu, ' ')
  assert(/model default save:/u.test(flat), `${label}: no post-dispatch failure notice surfaced`)
  assert(/may still land|indeterminate/iu.test(flat),
    `${label}: expected an indeterminate ACK-loss notice, got ${JSON.stringify(flat.slice(-400))}`)
}

/** Reopen the panel and prove the HOST-authoritative default is `modelId` by
 *  the `[current]` state chip on that model's row (a real `session.modelCatalog`
 *  read over the wire), then close the panel. */
async function assertHostDefaultCurrent(client, modelId, label) {
  await openModelPanel(client, label)
  await filterModel(client, modelId, label)
  // A SESSIONLESS panel marks the directory default with the `[default]` state
  // chip (a live Session would show `[current]`); both are the Host-authoritative
  // modelCatalog projection, not a Client-local value.
  await waitForCondition(async () => {
    const frame = (await client.viewport()).join('\n')
    return frame.includes(modelId) && (frame.includes('[default]') || frame.includes('[current]'))
  }, `${label} Host default marks ${modelId} default`, 60_000).catch(async (error) => {
    const frame = await client.viewport()
    throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: modelId, frame: frame.slice(-16) })}`, { cause: error })
  })
  client.send('\x1b') // Esc closes the panel
  await waitForScreenGone(client, 'Models', `${label} picker closed after read`, 60_000)
}

export async function runSessionlessDefaultModel(context) {
  const { workDir, dshHome } = context
  // Do NOT override the base `agent-default-model` row: the official ConfigEditor
  // refuses to write a row shadowed by a home/extra patch, and this case must
  // exercise the real writable profile entry.
  const scene = createC1Scene(context, { keepBaseDefaultModel: true })
  const { startC1Host, startC1Client, exitC1Client, stopC1Host, dispose } = scene
  const unique = `${String(process.pid)}-${Date.now().toString(36)}`
  const homeA = join(workDir, `m6-def-home-a-${unique}`)
  const homeB = join(workDir, `m6-def-home-b-${unique}`)
  const homeC = join(workDir, `m6-def-home-c-${unique}`)
  const homeD = join(workDir, `m6-def-home-d-${unique}`)
  for (const home of [homeA, homeB, homeC, homeD]) mkdirSync(home, { recursive: true, mode: 0o700 })

  // The second offline catalogue entry this case saves as the new default.
  const hostEnv = { C1_EXTRA_MODEL: TARGET_MODEL }

  try {
    const { host, ready } = await startC1Host('unowned-job', 'M6-DEF', hostEnv)
    assert(ready.localHost?.hostPid > 0, `M6-DEF the Host Ready record carries no identity: ${JSON.stringify(ready.localHost)}`)

    // ── M-01/M-02: sessionless save of a REAL default change ────────────────
    const { client: a, ready: aReady } = await startC1Client('M6-DEF client A', { HOME: homeA }, { cwd: workDir })
    assert(aReady.sessionOpen === false && aReady.surfaceMounted === true,
      `M6-DEF client A is not a mounted sessionless surface: ${JSON.stringify(aReady)}`)

    await saveDefault(a, TARGET_MODEL, 'M6-DEF A save')
    // No Session was created by the sessionless default write.
    const aStatus = await waitForSurfaceStatus(a,
      record => record.sessionOpen === false, 'M6-DEF A stays sessionless', 60_000)
    assert(aStatus.sessionOpen === false, 'M6-DEF the sessionless default save created a Session')
    // The HOST-authoritative default changed (a real modelCatalog read).
    await assertHostDefaultCurrent(a, TARGET_MODEL, 'M6-DEF A reread after save')

    // ── M-05: two independent Clients save in real receive order ────────────
    const { client: b, ready: bReady } = await startC1Client('M6-DEF client B', { HOME: homeB }, { cwd: workDir })
    assert(bReady.sessionOpen === false, 'M6-DEF client B is not sessionless')
    await saveDefault(b, BASE_MODEL, 'M6-DEF B save')
    await assertHostDefaultCurrent(b, BASE_MODEL, 'M6-DEF B reread (B is last)')
    // A re-reads the SAME Host authority and agrees with B's later save.
    await assertHostDefaultCurrent(a, BASE_MODEL, 'M6-DEF A reread agrees with B last write')
    // ── M-04: a REAL post-dispatch ACK loss is indeterminate; the Host still committed ──
    // (D saves TARGET_MODEL, which is NOT the current default, so the reread proves the write landed.)
    // The env-gated transport hook drops the ACK AFTER the Host applied the
    // official save, so the Client can only report `indeterminate`; a
    // Host-authoritative reread (a DIFFERENT, un-dropped method) reconciles that
    // the write DID commit, with no automatic retry.
    const { client: d, ready: dReady } = await startC1Client('M6-DEF client D (ACK drop)', {
      HOME: homeD,
      SPLIT_PROCESS_CLIENT_DROP_MODEL_ACK: '1',
    }, { cwd: workDir })
    assert(dReady.sessionOpen === false, 'M6-DEF client D is not sessionless')
    // D saves a model DIFFERENT from the current default (BASE_MODEL) so the
    // authoritative reread is discriminating: only a real Host commit of the
    // ACK-dropped write can move the default to TARGET_MODEL.
    await saveDefaultExpectingIndeterminate(d, TARGET_MODEL, 'M6-DEF D ACK-dropped save')
    await assertHostDefaultCurrent(d, TARGET_MODEL, 'M6-DEF D authoritative reread after ACK loss')
    await exitC1Client(d, 'M6-DEF client D')

    // Leave the persisted default on the target model for the restart proof.
    await saveDefault(a, TARGET_MODEL, 'M6-DEF A restore target')
    await assertHostDefaultCurrent(a, TARGET_MODEL, 'M6-DEF A reread restored target')

    // ── M-02: the default survives an INDEPENDENT Host restart ──────────────
    await exitC1Client(a, 'M6-DEF client A')
    await exitC1Client(b, 'M6-DEF client B')
    await stopC1Host(host)
    const { host: host2, ready: ready2 } = await startC1Host('unowned-job', 'M6-DEF-2', hostEnv)
    assert(ready2.localHost?.hostPid > 0, 'M6-DEF the restarted Host did not become ready')
    const { client: c, ready: cReady } = await startC1Client('M6-DEF client C', { HOME: homeC }, { cwd: workDir })
    assert(cReady.sessionOpen === false, 'M6-DEF client C is not sessionless')
    await assertHostDefaultCurrent(c, TARGET_MODEL, 'M6-DEF C reread after Host restart')

    // ── M-02: the next real Session falls back to the persisted default ─────
    c.send('hello from the persistence probe\r')
    const cSession = await waitForSurfaceStatus(c,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string',
      'M6-DEF C first Session', 120_000)
    // The Session's request header records the model the Agent actually ran on;
    // it must be the persisted default, never a Client-local pending value.
    const requestEvent = await waitForHostSessionEvent(dshHome, cSession.openSessionId,
      event => JSON.stringify(event).includes(TARGET_MODEL),
      'M6-DEF next Session request used the persisted default', 120_000)
    assert(requestEvent !== undefined, 'M6-DEF no Session event recorded the persisted default model')

    const hostAfter = await hostStatus(host2)
    assert(hostAfter.pid === ready2.pid, 'M6-DEF the restarted Host identity is unstable')

    context.trace?.('m6-sessionless-default-model', {
      candidate: context.candidateSha256,
      savedModel: TARGET_MODEL,
      baseModel: BASE_MODEL,
      hostPid: ready.localHost?.hostPid,
      restartedHostPid: ready2.localHost?.hostPid,
      sessionlessNoSession: true,
      hostAuthoritativeReread: true,
      twoClientOrdering: true,
      hostRestartPersisted: true,
      nextSessionFallback: TARGET_MODEL,
      ackFaultInjected: 'SPLIT_PROCESS_CLIENT_DROP_MODEL_ACK',
      ackLossOutcome: 'indeterminate',
      ackLossHostCommitted: true,
      ackLossRetried: false,
    })
    return { status: 'PASS' }
  } finally {
    await dispose()
  }
}
