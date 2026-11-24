/**
 * G-ACP2-PR3A L6: the real ACP command surface on one packed Host.
 *
 * One real installed Host owns the local ACP front door and the shared Session
 * View. A real official ACP SDK client consumes the live command catalog, runs
 * the official `/feedback` handler, triggers the exact retained manual
 * compaction service, and submits one native project Skill through the ordinary
 * prompt path. Every asserted result comes from the real candidate processes,
 * real official services and the durable Session log; no fake Host, second
 * command executor or synthetic compaction is started.
 *
 * @module split-process/acp-command-invocation
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import { hostSessionEvents, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { openSdkClient } from './acp-protocol-projection.mjs'
import { CliProcess } from './acp-stdio-a1.mjs'

const CASE_ID = 'acp.command-invocation'
process.on('unhandledRejection', reason => {
  // The SDK's WebStream adapter can surface a premature-close AbortError after
  // the peer socket is torn down; it is transport cleanup, never the verdict.
  const code = reason?.code ?? reason?.cause?.code
  if (code === 'ABORT_ERR' || code === 'ERR_STREAM_PREMATURE_CLOSE') return
  throw reason
})
const HISTORY_PROMPT = 'acp-command history first'
const FEEDBACK_TEXT = 'acp command smoke feedback'
const SKILL_NAME = 'acp-command-smoke'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(predicate, label, timeoutMs = 120_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    const value = predicate()
    if (value !== undefined && value !== false) return value
    await sleep(25)
  }
  throw new SplitSmokeAssertionError(`${CASE_ID}: ${label} timed out after ${String(timeoutMs)}ms`)
}

function promptText(text) {
  return [{ type: 'text', text }]
}

function messageText(message) {
  return (message?.content ?? [])
    .filter(part => part?.type === 'text')
    .map(part => part.text)
    .join('')
}

function openTurn(events) {
  const started = new Set(events.filter(event => event.type === 'turn/start').map(event => event.data?.turn))
  const ended = new Set(events.filter(event => event.type === 'turn/end').map(event => event.data?.turn))
  for (const turn of started) {
    if (!ended.has(turn)) return turn
  }
  return undefined
}

async function waitForFile(path, label, timeoutMs = 120_000) {
  await waitFor(() => existsSync(path) ? true : undefined, label, timeoutMs)
}

function resetHold(root) {
  rmSync(`${root}.entered`, { force: true })
  rmSync(`${root}.release`, { force: true })
}

function clearTurnHold(root, sessions) {
  rmSync(`${root}.entered`, { force: true })
  rmSync(`${root}.release`, { force: true })
  for (const sessionId of sessions) {
    rmSync(`${root}.entered.${sessionId}`, { force: true })
    rmSync(`${root}.release.${sessionId}`, { force: true })
  }
  rmSync(root, { force: true })
}

function commandEvents(events, name) {
  return events.filter(event => event.type === 'command/run' && event.data?.name === name)
}

function updatesFor(updates, sessionId) {
  return updates
    .filter(params => params?.sessionId === sessionId)
    .map(params => params.update)
}

function catalogNames(params) {
  return (params?.update?.availableCommands ?? []).map(command => command.name)
}

/**
 * Run one real command/Skill/manual-compaction qualification.
 * @param {object} context - the split smoke run context.
 * @returns {Promise<object>} the observed facts.
 */
export async function runAcpCommandInvocation(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context, { scopedMcpB1: true })
  const hostCwd = realpathSync(workDir)
  const holdRoot = join(workDir, 'acp-command-compaction-hold')
  const turnHold = join(workDir, 'acp-command-turn-hold')
  resetHold(holdRoot)
  const lifecycleControl = join(workDir, 'acp-command-lifecycle')
  mkdirSync(lifecycleControl, { recursive: true, mode: 0o700 })
  let lifecycleSequence = 0
  const clients = []
  let peer
  let host

  try {
    // A real project Skill: the standard `.agents/skills/<name>/SKILL.md` source
    // the official filesystem provider reads. `disable-model-invocation`
    // proves the human-only path is the one advertised.
    const skillDir = join(hostCwd, '.agents', 'skills', SKILL_NAME)
    mkdirSync(skillDir, { recursive: true, mode: 0o700 })
    execFileSync('git', ['init', '--quiet'], { cwd: hostCwd, stdio: 'ignore' })
    writeFileSync(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${SKILL_NAME}`,
      'description: A real project Skill for ACP command qualification.',
      'disable-model-invocation: true',
      'user-invocable: true',
      '---',
      '',
      '# ACP command smoke Skill',
      '',
    ].join('\n'), { mode: 0o600 })

    const started = await scene.startC1Host('acp-command', 'command A host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_COMPACT_HOLD: holdRoot,
      C1_LIFECYCLE_CONTROL: lifecycleControl,
      C1_TURN_HOLD: join(workDir, 'acp-command-turn-hold'),
    })
    host = started.host
    const hostWorkRoot = started.workRoot
    const lifecycleSignal = (action, targetSession, fields = {}) => {
      const name = `action-${String(++lifecycleSequence)}-${action}.json`
      writeFileSync(join(lifecycleControl, name), JSON.stringify({ action, sessionId: targetSession, ...fields }), { mode: 0o600 })
    }
    const lifecycleAction = async (action, targetSession, kind, label, fields = {}) => {
      lifecycleSignal(action, targetSession, fields)
      return await waitForC1WorkEvent(hostWorkRoot,
        event => event.kind === kind && event.sessionId === targetSession, label, 120_000)
    }
    const settle = promise => promise.then(value => ({ value }), error => ({ error }))
    const captureError = async (label, promise) => {
      const outcome = await promise
      if (outcome.error !== undefined) return outcome.error
      assert(false, `${label}: the request unexpectedly succeeded`)
    }
    const ready = started.ready
    const scopeId = ready.localHost?.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'CMD-01: the Host Ready must publish a full scope id')
    const hostIdentity = await scene.hostIdentityFacts(host)
    trace('acp-command/evidence-start', {
      candidateSha256: context.candidateSha256 ?? null,
      nodeVersion: process.version,
      dshVersion: context.targetDshVersion ?? null,
      bundleVersion: installation.manifest.version,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
    })

    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'command B peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'CMD-02 peer ready', 180_000)
    const accessRequest = `command-access-${String(Date.now())}-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId: accessRequest, acpEnabled: true })
    const access = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === accessRequest,
      'CMD-02 ACP access', 120_000)
    assert(access.ok === true && access.status?.state === 'enabled',
      `CMD-02: the ACP front door must enable (${JSON.stringify(access)})`)
    const endpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock` }
      : { path: join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock'), dir: join(dshHome, 'run', 'dsh-pi-tui', scopeId) }
    assert(existsSync(endpoint.path), `CMD-02: the enabled front door must publish ${endpoint.path}`)

    const updates = []
    const client = await openSdkClient(endpoint, params => { updates.push(params) })
    clients.push(client)
    const init = await client.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: { session: { compaction: {} } },
    })
    assert(init?.protocolVersion === 1, 'CMD-03: initialize must answer protocolVersion 1')
    const created = await client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    const sessionId = created.sessionId
    assert(typeof sessionId === 'string' && sessionId !== '', 'CMD-03: session/new must create a real Session')

    // CAT-01: the real live registry + native Skill snapshot is a complete,
    // stable catalog. The initial frame is allowed to arrive after the attach.
    const catalog = await waitFor(() => {
      const rows = updatesFor(updates, sessionId)
        .filter(update => update?.sessionUpdate === 'available_commands_update')
      const latest = rows.at(-1)
      // The official filesystem provider may announce its initial project
      // Skill after the first complete command-only catalog. Wait for the
      // complete replacement that contains the real project Skill.
      return latest !== undefined && catalogNames({ update: latest }).includes(SKILL_NAME)
        ? latest
        : undefined
    }, 'CMD-04 the complete catalog with the real project Skill', 60_000)
    const initialNames = catalogNames({ update: catalog })
    assert(initialNames.includes('feedback'), `CMD-04: the real /feedback command must be advertised (${JSON.stringify(initialNames)})`)
    assert(initialNames.includes('compact'), `CMD-04: the real /compact command must be advertised (${JSON.stringify(initialNames)})`)
    assert(initialNames.includes(SKILL_NAME), `CMD-04: the real human Skill must be advertised (${JSON.stringify(initialNames)})`)
    assert(initialNames.every(name => typeof name === 'string' && !name.startsWith('/')), 'CMD-04: catalog names carry no slash')
    assert([...initialNames].sort().join('\u0000') === initialNames.join('\u0000'), 'CMD-04: catalog names are stably sorted')
    trace('acp-command/catalog', { names: initialNames })

    // Build a real compactable history through the official prompt lifecycle.
    let first
    try {
      first = await client.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: promptText(HISTORY_PROMPT),
      })
    } catch (error) {
      const events = hostSessionEvents(dshHome, sessionId) ?? []
      const turns = events.filter(event => event.type === 'turn/end').slice(-3)
      throw new SplitSmokeAssertionError(`${CASE_ID}: history request failed: ${String(error?.message)} code=${String(error?.data?.code)} turns=${JSON.stringify(turns)}; host stderr: ${String(host.stderr).slice(-6_000)}`)
    }
    assert(first?.stopReason === 'end_turn', `CMD-05: the history prompt must end_turn (${JSON.stringify(first)})`)
    trace('acp-command/after-history', { stopReason: first.stopReason })

    // CMD-04: a real standalone command. The official feedback handler writes
    // its own durable `feedback/record`; the command lifecycle is paired.
    const beforeFeedback = hostSessionEvents(dshHome, sessionId).length
    let feedback
    try {
      feedback = await client.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: promptText(`/feedback ${FEEDBACK_TEXT}`),
      })
    } catch (error) {
      throw new SplitSmokeAssertionError(`${CASE_ID}: /feedback request failed: ${String(error?.message)}; host stderr: ${String(host.stderr).slice(-6_000)}`)
    }
    assert(feedback?.stopReason === 'end_turn', `CMD-06: /feedback must end_turn (${JSON.stringify(feedback)})`)
    trace('acp-command/after-feedback', { stopReason: feedback.stopReason })
    const feedbackEvents = await waitFor(() => {
      const events = hostSessionEvents(dshHome, sessionId)
      const record = events.find(event => event.type === 'feedback/record' && event.data?.text === FEEDBACK_TEXT)
      return record === undefined ? undefined : events
    }, 'CMD-06 the durable feedback/record')
    assert(commandEvents(feedbackEvents, 'feedback').length === 1, 'CMD-06: exactly one official command/run for feedback')
    const feedbackDone = feedbackEvents.find(event => event.type === 'command/done'
      && event.data?.kind === 'success'
      && event.data?.commandId === commandEvents(feedbackEvents, 'feedback')[0]?.data?.commandId)
    assert(feedbackDone !== undefined, 'CMD-06: feedback must have one successful paired command/done')
    assert(feedbackEvents.length > beforeFeedback, 'CMD-06: the command produced durable events')
    const feedbackText = updatesFor(updates, sessionId)
      .filter(update => update?.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '')
      .join('')
    assert(feedbackText.includes('Feedback'), `CMD-06: the official feedback result text must reach the client (${JSON.stringify(feedbackText)})`)

    // TUI-01: a REAL Shared TUI is attached to the same Host Session while
    // ACP executes the command. The TUI transcript paints the official
    // compaction row; ACP never injects a fake turn/message for it.
    const tui = await scene.startC1Client('command A TUI', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
    await waitForSurfaceStatus(tui.client, record => record.sessionOpen === true
      && record.openSessionId === sessionId && record.surfaceMounted === true && record.transport === 'connected',
      'TUI-01 the Shared TUI opened the ACP Session')

    // CMP-01: the exact retained official engine commits a real manual
    // compaction. ACP must NOT fabricate command/run or sourceCommandId.
    // A real subagent can deliver its result after the parent's first
    // `turn/end` and start a new turn. Wait for every observed root turn to
    // close before asking for maintenance; the official busy refusal is a
    // truthful contract, not a reason for the qualification to race it.
    await waitFor(() => {
      const events = hostSessionEvents(dshHome, sessionId) ?? []
      return openTurn(events) === undefined ? true : undefined
    }, 'CMD-07 no open root turn before manual compaction')
    // CMP-03: a real standard `session/cancel` is delivered while the official
    // summarizer is held. The deferred decision aborts the exact captured
    // controller; the official failed bracket closes without a summary.
    // During the hold, a normal Shared-TUI prompt on the same Session must be
    // accepted by the official inbox and must NOT be claimed until maintenance
    // ends. A second real Session keeps its own provider turn open, so the
    // cancel is scoped to the exact compact operation rather than a global
    // Agent/Host cancellation.
    const bSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    assert(typeof bSession === 'string' && bSession !== '' && bSession !== sessionId,
      'CMP-03: B must be a distinct real Host Session')
    const bBefore = (hostSessionEvents(dshHome, bSession) ?? []).length
    const cmp03 = `cmp03-${String(Date.now())}-${String(process.pid)}`
    const queuedText = `CMP-03 queued foreign TUI prompt ${cmp03}`
    const bText = `CMP-03 held B prompt ${cmp03}`
    clearTurnHold(turnHold, [sessionId, bSession])
    writeFileSync(turnHold, `${sessionId}\n${bSession}\n`, { mode: 0o600 })
    let bRequest
    try {
      bRequest = settle(client.request(acp.methods.agent.session.prompt, {
        sessionId: bSession,
        prompt: promptText(bText),
      }))
      await waitForHostSessionEventAfter(dshHome, bSession, bBefore,
        event => event.type === 'user/message' && messageText(event.data).includes(bText),
        'CMP-03 the held B prompt enters its real turn')
      await waitForFile(`${turnHold}.entered.${bSession}`, 'CMP-03 the B provider turn is held')

      resetHold(holdRoot)
      const beforeCancel = hostSessionEvents(dshHome, sessionId).length
      const cmp03FrameOffset = updates.length
      const cancelledRequest = settle(client.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: promptText('/compact'),
      }))
      await waitForFile(`${holdRoot}.entered`, 'CMP-03 the held summarizer before ACP cancel')

      tui.client.send(`${queuedText}\r`)
      const accepted = await waitForHostSessionEventAfter(dshHome, sessionId, beforeCancel,
        event => event.type === 'agent/inbox/spliced'
          && event.data?.target === 'next-turn'
          && (event.data?.inserted ?? []).some(message => messageText(message).includes(queuedText)),
        'CMP-03 the official inbox acceptance of the foreign TUI prompt')
      const queuedMessage = accepted.data.inserted.find(message => messageText(message).includes(queuedText))
      assert(typeof queuedMessage?.id === 'string' && queuedMessage.id !== '',
        `CMP-03: the accepted queued message must carry a real id (${JSON.stringify(accepted.data)})`)
      assert((accepted.data.removedCount ?? 0) === 0,
        'CMP-03: acceptance is an insertion, never a claim')
      await sleep(250)
      const whileHeld = hostSessionEvents(dshHome, sessionId) ?? []
      assert(!whileHeld.some(event => event.seq > accepted.seq
        && event.type === 'user/message' && event.data?.id === queuedMessage.id),
      'CMP-03: the queued foreign prompt must not be claimed while maintenance is held')
      assert(!whileHeld.some(event => event.seq > accepted.seq && event.type === 'turn/start'),
        'CMP-03: no A turn may start while the compact maintenance is held')
      assert(!whileHeld.some(event => event.seq > accepted.seq
        && event.type === 'agent/inbox/spliced'
        && event.data?.target === 'next-turn'
        && (event.data?.removedCount ?? 0) > 0
        && (event.data?.inserted ?? []).length === 0),
      'CMP-03: no inbox removal/claim may run while maintenance is held')
      assert(!existsSync(`${turnHold}.entered.${sessionId}`),
        'CMP-03: the exact-session turn hold must not enter before maintenance ends')

      await client.notify(acp.methods.agent.session.cancel, { sessionId })
      writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
      const cancelledOutcome = await cancelledRequest
      const cmp03ReplyUpdates = updates.slice(cmp03FrameOffset)
      const cancelled = cancelledOutcome.value
      assert(cancelledOutcome.error === undefined && cancelled?.stopReason === 'cancelled',
        `CMP-03: the precommit ACP cancel must stopReason cancelled (${JSON.stringify(cancelledOutcome.error?.data ?? cancelled)})`)
      const cancelEvents = (hostSessionEvents(dshHome, sessionId) ?? []).slice(beforeCancel)
      const cancelStarts = cancelEvents.filter(event => event.type === 'compaction/start')
      assert(cancelStarts.length === 1,
        `CMP-03: the cancelled attempt owns exactly one start (${JSON.stringify(cancelStarts.map(event => event.data))})`)
      const cancelStart = cancelStarts[0]
      assert(cancelStart?.data?.turn === null, 'CMP-03: the cancelled attempt has a real turn:null start')
      assert(cancelStart?.data?.sourceCommandId === undefined, 'CMP-03: ACP never fabricates a sourceCommandId')
      const cancelId = cancelStart?.data?.compactionId
      assert(typeof cancelId === 'string' && cancelId.length > 0, 'CMP-03: the cancelled attempt has a real compactionId')
      const cancelEnd = cancelEvents.find(event => event.type === 'compaction/end'
        && event.data?.compactionId === cancelId)
      assert(cancelEnd !== undefined && typeof cancelEnd.data?.error === 'string',
        'CMP-03: the cancelled attempt has its matching failed end')
      assert(!cancelEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === cancelId),
        'CMP-03: a precommit cancel never commits a summary')
      const cancelFrames = cmp03ReplyUpdates
        .filter(params => params?.sessionId === sessionId
          && params.update?.sessionUpdate === 'compaction_update')
        .map(params => params.update)
      assert(cancelFrames.length === 2,
        `CMP-03: the cancelled operation must deliver exactly start+failed frames (${JSON.stringify(cancelFrames)})`)
      assert(cancelFrames[0]?.compactionId === cancelId && cancelFrames[0]?.status === 'in_progress'
        && cancelFrames[0]?.summary === undefined,
      `CMP-03: the first frame must be the same-id start without a summary (${JSON.stringify(cancelFrames)})`)
      assert(cancelFrames[1]?.compactionId === cancelId && cancelFrames[1]?.status === 'failed'
        && typeof cancelFrames[1]?.error === 'string',
      `CMP-03: the second frame must be the same-id failed end (${JSON.stringify(cancelFrames)})`)
      assert(!cancelFrames.some(frame => frame.summary !== undefined),
        'CMP-03: a cancelled operation must never deliver a summary frame')
      assert(!cmp03ReplyUpdates.some(params => params?.sessionId === sessionId
        && params.update?.sessionUpdate === 'agent_message_chunk'
        && /Compacted \d+ history items/.test(params.update.content?.text ?? '')),
      'CMP-03: a cancelled operation must not deliver the success result text')

      const claimed = await waitForHostSessionEventAfter(dshHome, sessionId, accepted.seq,
        event => event.type === 'user/message' && event.data?.id === queuedMessage.id,
        'CMP-03 the queued foreign prompt is claimed after maintenance')
      assert(claimed.seq > cancelEnd.seq,
        `CMP-03: the claim must follow the failed bracket (${String(claimed.seq)} <= ${String(cancelEnd.seq)})`)
      await waitForFile(`${turnHold}.entered.${sessionId}`,
        'CMP-03 the claimed A prompt reaches the held provider turn')
      assert(openTurn(hostSessionEvents(dshHome, sessionId) ?? []) !== undefined,
        'CMP-03: the claimed A turn must still be open after the compact reply')
      assert(openTurn(hostSessionEvents(dshHome, bSession) ?? []) !== undefined,
        'CMP-03: B must still own its active turn when A settles')
      assert(!(hostSessionEvents(dshHome, bSession) ?? []).some(event => event.type === 'turn/end'),
        'CMP-03: the A cancellation must not close B')

      writeFileSync(`${turnHold}.release.${sessionId}`, '1', { mode: 0o600 })
      const aEnd = await waitForHostSessionEventAfter(dshHome, sessionId, claimed.seq,
        event => event.type === 'turn/end',
        'CMP-03 the foreign A turn completes after release')
      assert(aEnd.data?.reason?.kind === 'completed',
        `CMP-03: the foreign A turn must complete normally (${JSON.stringify(aEnd.data?.reason)})`)
      assert(!(hostSessionEvents(dshHome, bSession) ?? []).some(event => event.type === 'turn/end'),
        'CMP-03: B remains active after A completes')

      writeFileSync(`${turnHold}.release.${bSession}`, '1', { mode: 0o600 })
      const bOutcome = await bRequest
      assert(bOutcome.error === undefined && bOutcome.value?.stopReason === 'end_turn',
        `CMP-03: B must complete normally (${JSON.stringify(bOutcome.error?.data ?? bOutcome.value)})`)
      const bEnd = await waitForHostSessionEventAfter(dshHome, bSession, bBefore,
        event => event.type === 'turn/end',
        'CMP-03 the B turn completes')
      assert(bEnd.data?.reason?.kind === 'completed',
        `CMP-03: the B turn must complete normally (${JSON.stringify(bEnd.data?.reason)})`)
      trace('acp-command/cancel', {
        compactionId: cancelId,
        stopReason: cancelled.stopReason,
        queuedMessageId: queuedMessage.id,
        acceptedSeq: accepted.seq,
        claimedSeq: claimed.seq,
        failedEndSeq: cancelEnd.seq,
        bSession,
      })
    } finally {
      writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
      writeFileSync(`${turnHold}.release.${sessionId}`, '1', { mode: 0o600 })
      writeFileSync(`${turnHold}.release.${bSession}`, '1', { mode: 0o600 })
    }
    clearTurnHold(turnHold, [sessionId, bSession])

    // CMP-01: the same Session then runs one real successful manual compaction
    // through the exact retained engine. ACP must NOT fabricate command/run or
    // sourceCommandId.
    resetHold(holdRoot)
    const beforeCompact = hostSessionEvents(dshHome, sessionId).length
    const compactFrameOffset = updates.length
    const compactRequest = client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/compact'),
    })
    await waitForFile(`${holdRoot}.entered`, 'CMD-08 the held summarizer before successful commit')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const compact = await compactRequest
    const compactReplyUpdates = updates.slice(compactFrameOffset)
    assert(compact?.stopReason === 'end_turn', `CMD-08: /compact must end_turn (${JSON.stringify(compact)})`)
    trace('acp-command/after-compact', { stopReason: compact.stopReason })
    const compactEvents = await waitFor(() => {
      const events = hostSessionEvents(dshHome, sessionId).slice(beforeCompact)
      return events.some(event => event.type === 'compaction/start') && events.some(event => event.type === 'compaction/end')
        ? events
        : undefined
    }, 'CMD-08 the durable compaction bracket')
    const start = compactEvents.find(event => event.type === 'compaction/start')
    assert(start?.data?.turn === null, 'CMD-08: ACP manual compaction is a turn:null maintenance transaction')
    assert(start?.data?.sourceCommandId === undefined, 'CMD-08: ACP never fabricates a sourceCommandId')
    const id = start?.data?.compactionId
    assert(typeof id === 'string' && id.length > 0, 'CMD-08: the official compactionId must be real')
    assert(compactEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === id),
      'CMD-08: the same compactionId must have its summary')
    assert(compactEvents.some(event => event.type === 'compaction/end' && event.data?.compactionId === id && event.data?.error === undefined),
      'CMD-08: the same compactionId must close cleanly')
    assert(commandEvents(compactEvents, 'compact').length === 0, 'CMD-08: /compact is not the command-wrapper lifecycle')
    const successFrames = compactReplyUpdates
      .filter(params => params?.sessionId === sessionId
        && params.update?.sessionUpdate === 'compaction_update')
      .map(params => params.update)
    assert(successFrames.length === 3,
      `CMD-08: the success must deliver exactly start+summary+completed frames (${JSON.stringify(successFrames)})`)
    assert(successFrames[0]?.compactionId === id && successFrames[0]?.status === 'in_progress'
      && successFrames[0]?.summary === undefined,
    `CMD-08: the first frame must be the same-id start without a summary (${JSON.stringify(successFrames)})`)
    assert(successFrames[1]?.compactionId === id && successFrames[1]?.status === 'in_progress'
      && Array.isArray(successFrames[1]?.summary) && successFrames[1].summary.length > 0,
    `CMD-08: the second frame must be the same-id summary (${JSON.stringify(successFrames)})`)
    assert(successFrames[2]?.compactionId === id && successFrames[2]?.status === 'completed'
      && successFrames[2]?.error === undefined,
    `CMD-08: the third frame must be the same-id clean completed end (${JSON.stringify(successFrames)})`)
    const successReply = compactReplyUpdates
      .filter(params => params?.sessionId === sessionId)
      .map(params => params.update)
    const lastFrameIndex = successReply.map(update => update?.sessionUpdate).lastIndexOf('compaction_update')
    const resultIndex = successReply.findIndex((update, index) => index > lastFrameIndex
      && update?.sessionUpdate === 'agent_message_chunk'
      && /Compacted \d+ history items/.test(update.content?.text ?? ''))
    assert(resultIndex > lastFrameIndex,
      `CMD-08: the result text must follow the completed frame (${JSON.stringify(successReply)})`)
    const compactText = updatesFor(updates, sessionId)
      .filter(update => update?.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '')
      .join('')
    assert(/Compacted \d+ history items/.test(compactText), `CMD-08: the real result text must reach the client (${JSON.stringify(compactText)})`)
    await tui.client.waitForScreen('Compacted', 'TUI-01 the official compaction row')
    const tuiFrame = (await tui.client.viewport()).join('\n')
    assert(/Compacted \d+ history item/.test(tuiFrame), `TUI-01: the Shared TUI transcript must show the official compaction (${JSON.stringify(tuiFrame.slice(-2000))})`)
    assert((tuiFrame.match(/Compacted \d+ history item/g) ?? []).length === 1,
      'TUI-01: the Shared TUI must paint ONE compaction card, not a duplicate')
    trace('acp-command/shared-tui', { sessionId })

    // CMP-02 consecutive: the first successful operation's history is not
    // reclaimed. The second operation enters its own summarizer and is
    // cancelled through the standard ACP channel; it must not commit.
    resetHold(holdRoot)
    const secondBefore = hostSessionEvents(dshHome, sessionId).length
    const secondRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMP-02 the consecutive summarizer')
    await client.notify(acp.methods.agent.session.cancel, { sessionId })
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const secondOutcome = await secondRequest
    assert(secondOutcome.value?.stopReason === 'cancelled',
      `CMP-02: the consecutive cancel must settle cancelled (${JSON.stringify(secondOutcome.error?.data ?? secondOutcome.value)})`)
    const secondEvents = (hostSessionEvents(dshHome, sessionId) ?? []).slice(secondBefore)
    const secondStart = secondEvents.find(event => event.type === 'compaction/start')
    const secondId = secondStart?.data?.compactionId
    assert(typeof secondId === 'string' && secondId !== id, 'CMP-02: the consecutive operation has a NEW real id')
    assert(!secondEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === secondId),
      'CMP-02: the cancelled consecutive operation never commits its own summary')
    trace('acp-command/consecutive-cancel', { firstId: id, secondId })

    // CMP-02 busy: a REAL foreign Shared-TUI turn keeps the same Agent in a
    // turn. ACP /compact must receive the official maintenance BUSY refusal,
    // create no bracket and leave the foreign turn untouched.
    clearTurnHold(turnHold, [sessionId])
    writeFileSync(turnHold, `${sessionId}\n`, { mode: 0o600 })
    const busyBefore = hostSessionEvents(dshHome, sessionId).length
    tui.client.send('hold the foreign turn\r')
    await waitForHostSessionEventAfter(dshHome, sessionId, busyBefore,
      event => event.type === 'user/message'
        && String(event.data?.content?.[0]?.text ?? '').includes('hold the foreign turn'),
      'CMP-02 the foreign TUI turn entered the Host')
    await waitForFile(`${turnHold}.entered`, 'CMP-02 the foreign turn is held')
    const busy = await captureError('CMP-02 busy', settle(client.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: promptText('/compact'),
    })))
    assert(busy?.data?.code === 'LOCAL_ACP_COMMAND_BUSY',
      `CMP-02: a real foreign turn must produce official BUSY (${JSON.stringify(busy?.data)})`)
    const busyEvents = (hostSessionEvents(dshHome, sessionId) ?? []).slice(busyBefore)
    assert(!busyEvents.some(event => event.type === 'compaction/start'),
      'CMP-02: a busy refusal creates no compaction bracket')
    writeFileSync(`${turnHold}.release`, '1', { mode: 0o600 })
    await waitForHostSessionEventAfter(dshHome, sessionId, busyBefore,
      event => event.type === 'turn/end',
      'CMP-02: the foreign turn completes after the busy refusal')
    clearTurnHold(turnHold, [sessionId])
    trace('acp-command/busy', { code: busy.data.code })

    // TUI-01 follow-up: after the exact ACP terminal, the Shared TUI submits
    // an ordinary prompt and then its OWN native /compact wrapper. Both must be
    // real turns/commands; the ACP command must not leave a permanent Working.
    const tuiBefore = hostSessionEvents(dshHome, sessionId).length
    tui.client.send('follow the ACP compaction with one ordinary TUI prompt\r')
    const tuiUser = await waitForHostSessionEventAfter(dshHome, sessionId, tuiBefore,
      event => event.type === 'user/message'
        && String(event.data?.content?.[0]?.text ?? '').includes('follow the ACP compaction'),
      'TUI-01 the follow-up ordinary TUI prompt entered the Host')
    await waitForHostSessionEventAfter(dshHome, sessionId, tuiBefore,
      event => event.type === 'turn/end',
      'TUI-01 the follow-up ordinary TUI prompt completed')
    resetHold(holdRoot)
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const nativeBefore = hostSessionEvents(dshHome, sessionId).length
    tui.client.send('/compact\r')
    const nativeRun = await waitForHostSessionEventAfter(dshHome, sessionId, nativeBefore,
      event => event.type === 'command/run' && event.data?.name === 'compact',
      'TUI-01 the native TUI /compact command wrapper')
    const nativeCommandId = nativeRun.data?.commandId
    assert(typeof nativeCommandId === 'string', 'TUI-01: the native wrapper has a real commandId')
    await waitForHostSessionEventAfter(dshHome, sessionId, nativeBefore,
      event => event.type === 'compaction/start'
        && event.data?.sourceCommandId === nativeCommandId,
      'TUI-01 the native /compact sourceCommandId association')
    await waitForHostSessionEventAfter(dshHome, sessionId, nativeBefore,
      event => event.type === 'command/done' && event.data?.commandId === nativeCommandId,
      'TUI-01 the native /compact command/done')
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const frame = (await tui.client.viewport()).join('\n')
      if ((frame.match(/Compacted \d+ history item/g) ?? []).length >= 2) break
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    const nativeFrame = (await tui.client.viewport()).join('\n')
    assert((nativeFrame.match(/Compacted \d+ history item/g) ?? []).length >= 2,
      'TUI-01: the native TUI /compact painted its real card')
    assert(!/Working/.test(nativeFrame), 'TUI-01: no permanent Working state after the native command')
    trace('acp-command/tui-followup', { sessionId, nativeCommandId })

    // LIFE-02: Close during a held official command closes delivery but waits
    // for the original Promise. A second close is idempotent and a later
    // resume on the SAME connection proves the View was released only after
    // that terminal.
    const closeSessionId = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const closeSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: closeSessionId,
      prompt: promptText(HISTORY_PROMPT),
    })
    assert(closeSeed?.stopReason === 'end_turn', 'CMD-12: the close Session seed must end_turn')
    resetHold(holdRoot)
    const beforeClose = hostSessionEvents(dshHome, closeSessionId).length
    const closePrompt = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: closeSessionId,
      prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMD-12 the held summarizer before close')
    let promptSettled = false
    closePrompt.then(() => { promptSettled = true })
    const closeResult = await client.request(acp.methods.agent.session.close, { sessionId: closeSessionId })
    assert(promptSettled === true, 'CMD-12: close answers only after the command Promise terminal')
    assert(Object.keys(closeResult).length === 0, 'CMD-12: close returns the standard empty result')
    const closePromptOutcome = await closePrompt
    const closePromptResult = closePromptOutcome.value
    assert(closePromptOutcome.error === undefined && closePromptResult?.stopReason === 'cancelled',
      `CMD-12: the held precommit command settles cancelled (${JSON.stringify(closePromptResult)})`)
    const closeEvents = (hostSessionEvents(dshHome, closeSessionId) ?? []).slice(beforeClose)
    const closeStart = closeEvents.find(event => event.type === 'compaction/start')
    const closeId = closeStart?.data?.compactionId
    assert(typeof closeId === 'string' && closeId.length > 0, 'CMD-12: close captured the real compaction start')
    assert(!closeEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === closeId),
      'CMD-12: close during the precommit hold never commits a summary')
    assert(Object.keys(await client.request(acp.methods.agent.session.close, { sessionId: closeSessionId })).length === 0,
      'CMD-12: a repeated close stays idempotent')
    const resumedAfterClose = await client.request(acp.methods.agent.session.resume, { sessionId: closeSessionId, cwd: hostCwd })
    assert(typeof resumedAfterClose === 'object' && resumedAfterClose !== null,
      'CMD-12: the same connection can attach again only after the real terminal')
    await client.request(acp.methods.agent.session.close, { sessionId: closeSessionId })
    trace('acp-command/close', { stopReason: closePromptResult.stopReason })

    // LIFE-02: a real scoped MCP lease is fenced by the SAME command operation.
    // Close during the precommit hold must cancel the command, settle the
    // original Promise, and only then retire the exact MCP lease.
    if (typeof scene.c1Work.scopedMcpServerPath !== 'string') {
      throw new SplitSmokeAssertionError(`${CASE_ID}: the scoped MCP server fixture was not installed`)
    }
    const mcpRoot = join(workDir, 'acp-command-mcp')
    mkdirSync(mcpRoot, { recursive: true, mode: 0o700 })
    const mcpProof = join(mcpRoot, 'server-proof.jsonl')
    rmSync(mcpProof, { force: true })
    const mcpSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd,
      mcpServers: [{
        name: 'command-scope',
        command: process.execPath,
        args: [scene.c1Work.scopedMcpServerPath],
        env: [
          { name: 'B0_FIXTURE_PROOF', value: mcpProof },
          { name: 'B0_SERVER_TAG', value: 'command-scope' },
          { name: 'B0_HOLD_ARM', value: join(mcpRoot, 'hold-arm') },
          { name: 'B0_HOLD_RELEASE', value: join(mcpRoot, 'hold-release') },
          { name: 'B0_RUN_NONCE', value: `command-${String(process.pid)}` },
        ],
      }],
    })).sessionId
    const mcpEvents = () => existsSync(mcpProof)
      ? readFileSync(mcpProof, 'utf8').split('\n').filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)] } catch { return [] }
      })
      : []
    await waitFor(() => mcpEvents().some(event => event.kind === 'server-start') ? true : undefined,
      'LIFE-02 the real scoped MCP server start')
    const mcpSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: mcpSession,
      prompt: promptText(HISTORY_PROMPT),
    })
    assert(mcpSeed?.stopReason === 'end_turn', 'LIFE-02: the MCP Session seed must end_turn')
    resetHold(holdRoot)
    const mcpPrompt = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: mcpSession,
      prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'LIFE-02 the held summarizer before MCP close')
    let mcpPromptSettled = false
    mcpPrompt.then(() => { mcpPromptSettled = true })
    const mcpCloseAt = Date.now()
    const mcpClose = await client.request(acp.methods.agent.session.close, { sessionId: mcpSession })
    assert(mcpPromptSettled === true, 'LIFE-02: MCP close waits for the original command Promise')
    assert(Object.keys(mcpClose).length === 0, 'LIFE-02: MCP close returns the empty close result')
    const mcpPromptOutcome = await mcpPrompt
    assert(mcpPromptOutcome.error === undefined && mcpPromptOutcome.value?.stopReason === 'cancelled',
      `LIFE-02: the held MCP command settles cancelled (${JSON.stringify(mcpPromptOutcome.value)})`)
    const mcpActiveStart = mcpEvents().filter(event => event.kind === 'server-start').at(-1)
    assert(mcpActiveStart !== undefined, 'LIFE-02: the active MCP server start is observable')
    await waitFor(() => mcpEvents().some(event => (event.kind === 'server-sigterm' || event.kind === 'server-stdin-closed')
      && event.time >= mcpActiveStart.time) ? true : undefined, 'LIFE-02 the active MCP lease retirement')
    const mcpExit = mcpEvents().find(event => (event.kind === 'server-sigterm' || event.kind === 'server-stdin-closed')
      && event.time >= mcpActiveStart.time)
    assert(typeof mcpExit?.time === 'number' && mcpExit.time >= mcpCloseAt,
      `LIFE-02: the MCP lease retired only after the command terminal/close (${JSON.stringify({
        closeAt: mcpCloseAt,
        exit: mcpExit,
        events: mcpEvents().map(event => ({ kind: event.kind, time: event.time })),
      })})`)
    trace('acp-command/mcp-lease', { sessionId: mcpSession, retirements: mcpEvents().filter(event => String(event.kind).startsWith('server-')).length })

    // CMP-06: an OFFICIAL independent Host cancellation
    // (Agent.cancel with its
    // own cause) while the summarizer is held must be a Host failure, never
    // the ACP client's `cancelled`, and must not fabricate a summary.
    resetHold(holdRoot)
    const beforeIndependent = hostSessionEvents(dshHome, sessionId).length
    const independentRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMP-06 the held summarizer before independent cancellation')
    await lifecycleAction('cancel', sessionId, 'lifecycle-agent-cancelled', 'CMP-06 the official Agent cancel')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const independentError = await captureError('CMP-06', independentRequest)
    assert(independentError?.data?.code === 'LOCAL_ACP_COMMAND_FAILED',
      `CMP-06: an independent Host cancellation must be COMMAND_FAILED (${JSON.stringify(independentError?.data)})`)
    const independentEvents = (hostSessionEvents(dshHome, sessionId) ?? []).slice(beforeIndependent)
    const independentStart = independentEvents.find(event => event.type === 'compaction/start')
    const independentId = independentStart?.data?.compactionId
    assert(typeof independentId === 'string' && independentId.length > 0,
      'CMP-06: the independent cancellation has a real start/compactionId')
    assert(!independentEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === independentId),
      'CMP-06: an independently cancelled compaction never commits a summary')
    assert(independentEvents.some(event => event.type === 'compaction/end'
      && event.data?.compactionId === independentId && typeof event.data?.error === 'string'),
    'CMP-06: the independent cancellation closes the official failed bracket')
    trace('acp-command/independent-cancel', { compactionId: independentId, code: independentError.data.code })

    // CMP-05: the official Session flush fails after the summary/end committed.
    // The ACP answer must be COMMITTED_WITH_ERROR, never success or cancelled.
    const flushSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const flushSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: flushSession,
      prompt: promptText(HISTORY_PROMPT),
    })
    assert(flushSeed?.stopReason === 'end_turn', 'CMP-05: the fresh Session seed must end_turn')
    resetHold(holdRoot)
    const beforeFlush = hostSessionEvents(dshHome, flushSession).length
    const flushRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: flushSession,
      prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMP-05 the held summarizer before flush failure')
    await lifecycleAction('arm-flush-failure', flushSession, 'lifecycle-flush-failure-armed', 'CMP-05 arm the official flush failure')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const flushError = await captureError('CMP-05', flushRequest)
    const flushEvents = (hostSessionEvents(dshHome, flushSession) ?? []).slice(beforeFlush)
    assert(flushError?.data?.code === 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR',
      `CMP-05: a post-commit flush failure must be COMMITTED_WITH_ERROR (${JSON.stringify({
        data: flushError?.data,
        message: flushError?.message,
        eventTypes: flushEvents.map(event => event.type),
        proof: readC1WorkEvents(hostWorkRoot).filter(event => String(event.kind).includes('lifecycle-flush')),
      })})`)
    const flushStart = flushEvents.find(event => event.type === 'compaction/start')
    const flushId = flushStart?.data?.compactionId
    assert(typeof flushId === 'string', 'CMP-05: the failed flush has a real compactionId')
    // The live operation committed the summary/end before the official flush
    // rejected. A failed flush must never be rewritten as a clean success, and
    // the durable log may legitimately stop at `start` (partial persistence).
    const flushSummary = flushEvents.find(event => event.type === 'compaction/summary'
      && event.data?.compactionId === flushId)
    const flushEnd = flushEvents.find(event => event.type === 'compaction/end'
      && event.data?.compactionId === flushId)
    assert(!(flushSummary !== undefined && flushEnd !== undefined && flushEnd.data?.error === undefined),
      'CMP-05: a failed flush never leaves a clean summary+end in the durable log')
    trace('acp-command/flush-failure', {
      compactionId: flushId,
      code: flushError.data.code,
      durableTypes: flushEvents.map(event => event.type),
    })

    // CMP-06: a real partial replacement. The test-only fixture wraps the
    // exact official Session.append and fails the clean `compaction/end` after
    // the real summary was appended. The ACP result must be indeterminate, and
    // the durable log must show summary-without-end.
    const endFailSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const endFailSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: endFailSession, prompt: promptText(HISTORY_PROMPT),
    })
    assert(endFailSeed?.stopReason === 'end_turn', 'CMP-06: the end-failure seed must end_turn')
    await lifecycleAction('arm-end-failure', endFailSession, 'lifecycle-end-failure-armed', 'CMP-06 arm the official end failure')
    resetHold(holdRoot)
    const beforeEndFail = hostSessionEvents(dshHome, endFailSession).length
    const endFailRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: endFailSession, prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMP-06 the held summarizer before end failure')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const endFailError = await captureError('CMP-06 end failure', endFailRequest)
    await lifecycleAction('flush-now', endFailSession, 'lifecycle-flush-complete', 'CMP-06 persist the real partial summary')
    assert(endFailError?.data?.code === 'LOCAL_ACP_COMMAND_INDETERMINATE',
      `CMP-06: summary without a clean end must be INDETERMINATE (${JSON.stringify(endFailError?.data)})`)
    const endFailEvents = (hostSessionEvents(dshHome, endFailSession) ?? []).slice(beforeEndFail)
    const endFailStart = endFailEvents.find(event => event.type === 'compaction/start')
    const endFailId = endFailStart?.data?.compactionId
    assert(typeof endFailId === 'string', 'CMP-06: the partial replacement has a real start id')
    assert(endFailEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === endFailId),
      'CMP-06: the real summary is present')
    assert(!endFailEvents.some(event => event.type === 'compaction/end' && event.data?.compactionId === endFailId),
      'CMP-06: the replacement has no clean end')
    trace('acp-command/partial-replacement', { compactionId: endFailId })
    // Official Session load with negotiated compaction is the canonical read.
    // First a COMPLETE control proves the replay channel emits compaction
    // updates; then the partial Session proves no complete terminal for its id
    // (zero optional frames would otherwise be vacuous).
    const controlSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const controlSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: controlSession, prompt: promptText(HISTORY_PROMPT),
    })
    assert(controlSeed?.stopReason === 'end_turn', 'CMP-06: control seed must end_turn')
    resetHold(holdRoot)
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const controlCompact = await client.request(acp.methods.agent.session.prompt, {
      sessionId: controlSession, prompt: promptText('/compact'),
    })
    assert(controlCompact?.stopReason === 'end_turn', 'CMP-06: control compact must end_turn')
    await client.request(acp.methods.agent.session.close, { sessionId: controlSession })
    await client.request(acp.methods.agent.session.close, { sessionId: endFailSession })
    const loadedUpdates = []
    const loadClient = await openSdkClient(endpoint, params => { loadedUpdates.push(params) })
    clients.push(loadClient)
    await loadClient.request(acp.methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { session: { compaction: {} } },
    })
    const loadedControl = await loadClient.request(acp.methods.agent.session.load, {
      sessionId: controlSession, cwd: hostCwd, mcpServers: [],
    })
    assert(typeof loadedControl === 'object' && loadedControl !== null, 'CMP-06: control session/load must answer')
    const controlCompaction = loadedUpdates
      .filter(params => params?.sessionId === controlSession && params.update?.sessionUpdate === 'compaction_update')
      .map(params => params.update)
    assert(controlCompaction.length > 0,
      'CMP-06: negotiated load must emit the complete control compaction (positive control)')
    const loaded = await loadClient.request(acp.methods.agent.session.load, {
      sessionId: endFailSession, cwd: hostCwd, mcpServers: [],
    })
    assert(typeof loaded === 'object' && loaded !== null, 'CMP-06: official session/load must answer')
    const loadedCompaction = loadedUpdates
      .filter(params => params?.sessionId === endFailSession && params.update?.sessionUpdate === 'compaction_update')
      .map(params => params.update)
    assert(loadedCompaction.some(update => update.compactionId === endFailId
      && update.summary !== undefined && update.status === 'in_progress'),
    `CMP-06: official load must expose the partial summary as in_progress (${JSON.stringify(loadedCompaction)})`)
    assert(!loadedCompaction.some(update => update.compactionId === endFailId && update.status !== 'in_progress'),
      `CMP-06: official load must not invent a complete terminal for the partial replacement (${JSON.stringify(loadedCompaction)})`)
    await loadClient.request(acp.methods.agent.session.close, { sessionId: endFailSession })

    // CMP-05: hold the real official post-summary flush, send a late ACP
    // cancel while it is held, then release. Commit wins; cancellation is not
    // fabricated and the clean bracket survives.
    const holdFlushSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const holdFlushSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: holdFlushSession, prompt: promptText(HISTORY_PROMPT),
    })
    assert(holdFlushSeed?.stopReason === 'end_turn', 'CMP-05: the held-flush seed must end_turn')
    const flushRelease = join(workDir, 'acp-command-flush-release')
    rmSync(flushRelease, { force: true })
    resetHold(holdRoot)
    const beforeHeldFlush = hostSessionEvents(dshHome, holdFlushSession).length
    const heldFlushRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: holdFlushSession, prompt: promptText('/compact'),
    }))
    let heldFlushSettled = false
    void heldFlushRequest.then(() => { heldFlushSettled = true })
    await waitForFile(`${holdRoot}.entered`, 'CMP-05 the held summarizer before the held flush')
    await lifecycleAction('arm-hold-flush', holdFlushSession, 'lifecycle-flush-hold-armed', 'CMP-05 arm the held flush', { release: flushRelease })
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'lifecycle-flush-held' && event.sessionId === holdFlushSession,
      'CMP-05 the real flush is held', 120_000)
    await client.notify(acp.methods.agent.session.cancel, { sessionId: holdFlushSession })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    assert(heldFlushSettled === false, 'CMP-05: the command cannot answer while the official flush is held')
    writeFileSync(flushRelease, '1', { mode: 0o600 })
    const heldFlushOutcome = await heldFlushRequest
    assert(heldFlushOutcome.value?.stopReason === 'end_turn',
      `CMP-05: commit wins and the held flush ends normally (${JSON.stringify(heldFlushOutcome.error?.data ?? heldFlushOutcome.value)})`)
    const heldFlushEvents = (hostSessionEvents(dshHome, holdFlushSession) ?? []).slice(beforeHeldFlush)
    const heldFlushStart = heldFlushEvents.find(event => event.type === 'compaction/start')
    const heldFlushId = heldFlushStart?.data?.compactionId
    assert(typeof heldFlushId === 'string', 'CMP-05: the held flush has a real id')
    assert(heldFlushEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === heldFlushId),
      'CMP-05: the summary survived the late cancel')
    assert(heldFlushEvents.some(event => event.type === 'compaction/end'
      && event.data?.compactionId === heldFlushId && event.data?.error === undefined),
    'CMP-05: the clean end survived the late cancel')
    trace('acp-command/held-flush', { compactionId: heldFlushId })

    // CMP-05 rejection leg: hold the official flush AND arm its post-release
    // failure on a fresh exact Session. A late cancel while held must not
    // settle, must refuse overlap, and after release must classify
    // COMMITTED_WITH_ERROR from the real failed flush.
    const flushRejectSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const flushRejectSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: flushRejectSession, prompt: promptText(HISTORY_PROMPT),
    })
    assert(flushRejectSeed?.stopReason === 'end_turn', 'CMP-05 rejection: seed must end_turn')
    const flushRejectRelease = join(workDir, 'acp-command-flush-reject-release')
    rmSync(flushRejectRelease, { force: true })
    resetHold(holdRoot)
    const beforeFlushReject = hostSessionEvents(dshHome, flushRejectSession).length
    const flushRejectFrameOffset = updates.length
    const flushRejectRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: flushRejectSession, prompt: promptText('/compact'),
    }))
    let flushRejectSettled = false
    void flushRejectRequest.then(() => { flushRejectSettled = true })
    await waitForFile(`${holdRoot}.entered`, 'CMP-05 rejection: summarizer entered')
    await lifecycleAction('arm-flush-failure', flushRejectSession, 'lifecycle-flush-failure-armed', 'CMP-05 rejection: arm flush failure')
    await lifecycleAction('arm-hold-flush', flushRejectSession, 'lifecycle-flush-hold-armed', 'CMP-05 rejection: arm held flush', { release: flushRejectRelease })
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'lifecycle-flush-held' && event.sessionId === flushRejectSession,
      'CMP-05 rejection: real flush held', 120_000)
    await client.notify(acp.methods.agent.session.cancel, { sessionId: flushRejectSession })
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
    assert(flushRejectSettled === false, 'CMP-05 rejection: no answer while flush held')
    const overlap = await captureError('CMP-05 rejection overlap', settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: flushRejectSession, prompt: promptText('/compact'),
    })))
    assert(overlap?.data?.code === 'LOCAL_ACP_PROMPT_IN_FLIGHT',
      `CMP-05 rejection: overlap must be refused without a new operation (${JSON.stringify(overlap?.data)})`)
    const liveUpdates = updates.slice(flushRejectFrameOffset)
      .filter(params => params?.sessionId === flushRejectSession && params.update?.sessionUpdate === 'compaction_update')
      .map(params => params.update)
    const liveStart = liveUpdates.find(update => update.status === 'in_progress' && update.summary === undefined)
    const liveId = liveStart?.compactionId
    assert(typeof liveId === 'string', 'CMP-05 rejection: real own start update observed while held')
    assert(liveUpdates.some(update => update.compactionId === liveId && update.summary !== undefined),
      'CMP-05 rejection: the own live summary was delivered before the failed flush')
    assert(liveUpdates.some(update => update.compactionId === liveId && update.summary === undefined
      && update.status !== 'in_progress'),
    'CMP-05 rejection: the own live clean end was delivered before the failed flush')
    writeFileSync(flushRejectRelease, '1', { mode: 0o600 })
    await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'lifecycle-flush-failure-hit' && event.sessionId === flushRejectSession,
      'CMP-05 rejection: injected flush failure hit', 120_000)
    const flushRejectError = await captureError('CMP-05 rejection', flushRejectRequest)
    assert(flushRejectError?.data?.code === 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR',
      `CMP-05 rejection: failed flush after summary/end is COMMITTED_WITH_ERROR, not cancelled (${JSON.stringify(flushRejectError?.data)})`)
    const flushRejectAfter = (hostSessionEvents(dshHome, flushRejectSession) ?? []).slice(beforeFlushReject)
    assert(flushRejectAfter.filter(event => event.type === 'compaction/start').length === 1,
      'CMP-05 rejection: no duplicate commit/retry bracket')
    const afterReject = await client.request(acp.methods.agent.session.prompt, {
      sessionId: flushRejectSession, prompt: promptText(HISTORY_PROMPT),
    })
    assert(afterReject?.stopReason === 'end_turn', 'CMP-05 rejection: a next ordinary operation succeeds')
    trace('acp-command/held-flush-rejection', { compactionId: liveId })

    // Invalid arguments are refused before the official engine is called.
    const beforeInvalid = hostSessionEvents(dshHome, sessionId).length
    let invalidError
    try {
      await client.request(acp.methods.agent.session.prompt, {
        sessionId,
        prompt: promptText('/compact extra'),
      })
      assert(false, 'CMD-09: invalid /compact arguments must be refused')
    } catch (error) {
      invalidError = error
    }
    assert(invalidError?.data?.code === 'LOCAL_ACP_COMMAND_INVALID_INPUT',
      `CMD-09: invalid /compact must carry its stable code (${JSON.stringify(invalidError?.data)})`)
    assert(hostSessionEvents(dshHome, sessionId).length === beforeInvalid,
      'CMD-09: invalid /compact arguments cause no Host write')

    // SKL-01: the ordinary prompt path is the native loader path; the durable
    // injection is the official `skill-invocation` source, never a fabricated
    // ACP body and never a second loader.
    const skill = await client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText(`/${SKILL_NAME}`),
    })
    assert(skill?.stopReason === 'end_turn', `CMD-10: the Skill prompt must end_turn (${JSON.stringify(skill)})`)
    const skillEvents = hostSessionEvents(dshHome, sessionId)
    const injection = skillEvents.find(event => event.type === 'user/message'
      && event.data?.source?.kind === 'skill-invocation'
      && event.data?.source?.name === SKILL_NAME)
    assert(injection !== undefined, `CMD-10: the official pre-step must inject ${SKILL_NAME} (${JSON.stringify(skillEvents.slice(-8))})`)

    // ROUTE-01: an unknown slash remains ordinary prose, never a command.
    const beforeUnknown = commandEvents(hostSessionEvents(dshHome, sessionId), 'unknown').length
    const unknown = await client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/unknown-command is prose'),
    })
    assert(unknown?.stopReason === 'end_turn', 'CMD-11: an unknown slash remains a normal prompt')
    assert(commandEvents(hostSessionEvents(dshHome, sessionId), 'unknown').length === beforeUnknown,
      'CMD-11: an unknown slash creates no Host command lifecycle')

    // The public `dsh --profile pi-tui acp stdio` bridge must carry the same
    // real command wire, not just the direct UDS SDK probe.
    const stdio = new CliProcess(context, ['--profile', 'pi-tui', 'acp', 'stdio'])
    try {
      const stdioInit = await stdio.initialize()
      assert(stdioInit?.protocolVersion === acp.PROTOCOL_VERSION,
        `STDIO-01: the public bridge must initialize (${JSON.stringify(stdioInit)})`)
      const stdioCreated = await stdio.connection.agent.request(acp.methods.agent.session.new, {
        cwd: hostCwd, mcpServers: [],
      })
      const stdioSession = stdioCreated.sessionId
      assert(typeof stdioSession === 'string' && stdioSession.length > 0, 'STDIO-01: the public bridge must create a Session')
      const stdioSeed = await stdio.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: stdioSession, prompt: promptText(HISTORY_PROMPT),
      })
      assert(stdioSeed?.stopReason === 'end_turn', 'STDIO-01: the stdio Session seed must end_turn')
      const stdioFeedback = await stdio.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: stdioSession, prompt: promptText('/feedback stdio real wire'),
      })
      assert(stdioFeedback?.stopReason === 'end_turn', 'STDIO-01: public stdio /feedback must end_turn')
      await waitForHostSessionEventAfter(dshHome, stdioSession, 0,
        event => event.type === 'feedback/record',
        'STDIO-01: public stdio /feedback must reach the official Host sink')
      const stdioCompact = await stdio.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: stdioSession, prompt: promptText('/compact'),
      })
      assert(stdioCompact?.stopReason === 'end_turn', 'STDIO-01: public stdio /compact must end_turn')
      await waitForHostSessionEventAfter(dshHome, stdioSession, 0,
        event => event.type === 'compaction/summary',
        'STDIO-01: public stdio /compact must commit a real summary')
      const stdioCompactEvents = hostSessionEvents(dshHome, stdioSession) ?? []
      assert(stdioCompactEvents.some(event => event.type === 'compaction/start'),
        'STDIO-01: public stdio /compact must reach the official engine')
      trace('acp-command/public-stdio', { sessionId: stdioSession })
    } finally {
      await stdio.close().catch(() => {})
    }

    // LIFE-04: a REAL public stdio transport dies after the compaction
    // summary commits but before the client can consume the result. The Host
    // must not crash or retain a dead delivery fence; a fresh direct client
    // must resume the committed Session.
    const failingStdio = new CliProcess(context, ['--profile', 'pi-tui', 'acp', 'stdio'])
    let failingSession
    try {
      await failingStdio.initialize()
      const failingCreated = await failingStdio.connection.agent.request(acp.methods.agent.session.new, {
        cwd: hostCwd, mcpServers: [],
      })
      failingSession = failingCreated.sessionId
      const failingSeed = await failingStdio.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: failingSession, prompt: promptText(HISTORY_PROMPT),
      })
      assert(failingSeed?.stopReason === 'end_turn', 'LIFE-04: the failing stdio seed must end_turn')
      resetHold(holdRoot)
      const beforeFailing = hostSessionEvents(dshHome, failingSession).length
      const failingPrompt = settle(failingStdio.connection.agent.request(acp.methods.agent.session.prompt, {
        sessionId: failingSession, prompt: promptText('/compact'),
      }))
      await waitForFile(`${holdRoot}.entered`, 'LIFE-04 the held summarizer before transport death')
      writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
      await waitFor(() => hostSessionEvents(dshHome, failingSession)?.slice(beforeFailing)
        .some(event => event.type === 'compaction/summary') ? true : undefined,
      'LIFE-04 the committed summary before transport death')
      failingStdio.kill('SIGKILL')
      await failingStdio.waitExit()
      await failingPrompt
      const recovery = await openSdkClient(endpoint)
      try {
        await recovery.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
        const recoveryResume = await recovery.request(acp.methods.agent.session.resume, {
          sessionId: failingSession, cwd: hostCwd,
        })
        assert(typeof recoveryResume === 'object' && recoveryResume !== null,
          'LIFE-04: a fresh client must resume the committed Session after output transport death')
      } finally {
        await recovery.close().catch(() => {})
      }
      const failingEvents = (hostSessionEvents(dshHome, failingSession) ?? []).slice(beforeFailing)
      assert(failingEvents.some(event => event.type === 'compaction/summary'),
        'LIFE-04: the transport death never erases the committed compaction')
      trace('acp-command/output-transport-failure', {
        sessionId: failingSession,
        promptError: (await failingPrompt).error?.data?.code,
      })
    } finally {
      try { failingStdio.kill('SIGKILL') } catch { /* already dead */ }
      await failingStdio.close().catch(() => {})
    }

    // CMP-06/LIFE-03: dispose the LIVE Agent's own Cordis Fiber while the
    // summarizer is held. This is the official host-side disposal capability,
    // not a synthetic abort; the ACP request must observe a Host failure, not
    // the client's cancellation, and must never fabricate a summary.
    const disposeSession = (await client.request(acp.methods.agent.session.new, {
      cwd: hostCwd, mcpServers: [],
    })).sessionId
    const disposeSeed = await client.request(acp.methods.agent.session.prompt, {
      sessionId: disposeSession,
      prompt: promptText(HISTORY_PROMPT),
    })
    assert(disposeSeed?.stopReason === 'end_turn', 'CMP-06: the disposal Session seed must end_turn')
    resetHold(holdRoot)
    const beforeDispose = hostSessionEvents(dshHome, disposeSession).length
    const disposeRequest = settle(client.request(acp.methods.agent.session.prompt, {
      sessionId: disposeSession,
      prompt: promptText('/compact'),
    }))
    await waitForFile(`${holdRoot}.entered`, 'CMP-06 the held summarizer before Fiber disposal')
    lifecycleSignal('dispose', disposeSession)
    await waitForC1WorkEvent(hostWorkRoot,
      event => event.kind === 'lifecycle-agent-disposed' && event.sessionId === disposeSession,
      'CMP-06 the official Agent Fiber disposal', 120_000)
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const disposeError = await captureError('CMP-06 dispose', disposeRequest)
    assert(disposeError?.data?.code !== 'cancelled' && disposeError?.data?.code !== 'LOCAL_ACP_COMMAND_CANCELLED',
      `CMP-06: actual Fiber disposal is never the client cancellation (${JSON.stringify(disposeError?.data)})`)
    assert(['LOCAL_ACP_COMMAND_FAILED', 'LOCAL_ACP_COMMAND_INDETERMINATE', 'LOCAL_ACP_COMMAND_COMMITTED_WITH_ERROR']
      .includes(disposeError?.data?.code),
    `CMP-06: Fiber disposal must be a Host-side failure class (${JSON.stringify(disposeError?.data)})`)
    const disposeEvents = (hostSessionEvents(dshHome, disposeSession) ?? []).slice(beforeDispose)
    const disposeStart = disposeEvents.find(event => event.type === 'compaction/start')
    const disposeId = disposeStart?.data?.compactionId
    assert(typeof disposeId === 'string' && disposeId.length > 0,
      'CMP-06: the disposal path captured the real compaction start')
    assert(!disposeEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === disposeId),
      'CMP-06: Fiber disposal before commit never produces a summary')
    trace('acp-command/fiber-disposal', { compactionId: disposeId, code: disposeError.data.code })


    const facts = {
      caseId: CASE_ID,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      scopeId,
      sessionId,
      catalog: initialNames,
      feedbackCommandId: commandEvents(feedbackEvents, 'feedback')[0]?.data?.commandId ?? null,
      compactionId: id,
      skillInjected: true,
    }
    trace('acp-command/evidence', facts)
    return facts
  } finally {
    for (const client of clients) {
      try { await client.close() } catch { /* the peer already closed it */ }
    }
    if (peer !== undefined) {
      try { await peer.shutdown() } catch { /* the global backstop owns a stuck child */ }
    }
    if (host !== undefined) {
      try { await host.shutdown() } catch { /* the global backstop owns a stuck child */ }
    }
    try { await scene.dispose() } catch { /* the global backstop owns a stuck child */ }
  }
}
