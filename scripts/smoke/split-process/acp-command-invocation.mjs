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
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { hostSessionEvents } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { openSdkClient } from './acp-protocol-projection.mjs'

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
  const scene = createC1Scene(context)
  const hostCwd = realpathSync(workDir)
  const holdRoot = join(workDir, 'acp-command-compaction-hold')
  resetHold(holdRoot)
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
    })
    host = started.host
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
      return rows.length === 0 ? undefined : rows.at(-1)
    }, 'CMD-04 the initial available_commands_update')
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
    resetHold(holdRoot)
    const beforeCancel = hostSessionEvents(dshHome, sessionId).length
    const cancelledRequest = client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/compact'),
    })
    await waitForFile(`${holdRoot}.entered`, 'CMD-07 the held summarizer before ACP cancel')
    await client.notify(acp.methods.agent.session.cancel, { sessionId })
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const cancelled = await cancelledRequest
    assert(cancelled?.stopReason === 'cancelled',
      `CMD-07: the precommit ACP cancel must stopReason cancelled (${JSON.stringify(cancelled)})`)
    const cancelEvents = (hostSessionEvents(dshHome, sessionId) ?? []).slice(beforeCancel)
    const cancelStart = cancelEvents.find(event => event.type === 'compaction/start')
    assert(cancelStart?.data?.turn === null, 'CMD-07: the cancelled attempt has a real turn:null start')
    assert(cancelStart?.data?.sourceCommandId === undefined, 'CMD-07: ACP never fabricates a sourceCommandId')
    const cancelId = cancelStart?.data?.compactionId
    assert(typeof cancelId === 'string' && cancelId.length > 0, 'CMD-07: the cancelled attempt has a real compactionId')
    assert(cancelEvents.some(event => event.type === 'compaction/end'
      && event.data?.compactionId === cancelId && typeof event.data?.error === 'string'),
    'CMD-07: the cancelled attempt has its matching failed end')
    assert(!cancelEvents.some(event => event.type === 'compaction/summary' && event.data?.compactionId === cancelId),
      'CMD-07: a precommit cancel never commits a summary')
    trace('acp-command/cancel', { compactionId: cancelId, stopReason: cancelled.stopReason })

    // CMP-01: the same Session then runs one real successful manual compaction
    // through the exact retained engine. ACP must NOT fabricate command/run or
    // sourceCommandId.
    resetHold(holdRoot)
    const beforeCompact = hostSessionEvents(dshHome, sessionId).length
    const compactRequest = client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/compact'),
    })
    await waitForFile(`${holdRoot}.entered`, 'CMD-08 the held summarizer before successful commit')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    const compact = await compactRequest
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
    const compactText = updatesFor(updates, sessionId)
      .filter(update => update?.sessionUpdate === 'agent_message_chunk')
      .map(update => update.content?.text ?? '')
      .join('')
    assert(/Compacted \d+ history items/.test(compactText), `CMD-08: the real result text must reach the client (${JSON.stringify(compactText)})`)

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

    // LIFE-02: Close during a held official command closes delivery but waits
    // for the original Promise. A second close is idempotent and a later
    // resume on the SAME connection proves the View was released only after
    // that terminal.
    resetHold(holdRoot)
    const closePrompt = client.request(acp.methods.agent.session.prompt, {
      sessionId,
      prompt: promptText('/compact'),
    })
    await waitForFile(`${holdRoot}.entered`, 'CMD-12 the held summarizer before close')
    let closeSettled = false
    const closeRequest = client.request(acp.methods.agent.session.close, { sessionId }).then(value => {
      closeSettled = true
      return value
    })
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
    assert(closeSettled === false, 'CMD-12: close cannot detach while the official command Promise is held')
    writeFileSync(`${holdRoot}.release`, '1', { mode: 0o600 })
    assert(Object.keys(await closeRequest).length === 0, 'CMD-12: close answers only after the command terminal')
    const closePromptResult = await closePrompt
    assert(closePromptResult?.stopReason === 'cancelled',
      `CMD-12: the held precommit command settles cancelled (${JSON.stringify(closePromptResult)})`)
    assert(Object.keys(await client.request(acp.methods.agent.session.close, { sessionId })).length === 0,
      'CMD-12: a repeated close stays idempotent')
    const resumedAfterClose = await client.request(acp.methods.agent.session.resume, { sessionId, cwd: hostCwd })
    assert(typeof resumedAfterClose === 'object' && resumedAfterClose !== null,
      'CMD-12: the same connection can attach again only after the real terminal')
    await client.request(acp.methods.agent.session.close, { sessionId })
    trace('acp-command/close', { stopReason: closePromptResult.stopReason })

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
