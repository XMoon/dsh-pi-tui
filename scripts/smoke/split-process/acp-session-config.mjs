/**
 * G-ACP2-PR3B L6: the real session mode / config-option surface.
 *
 * ONE packed Split Host and one real authenticated TUI Client share a Session;
 * a real official ACP SDK connection reads and writes the SAME official
 * authorities: the retained PlanModeController (legacy `modes` and the `mode`
 * select row) and the root-only Agent Team boolean. A second SDK connection
 * that did not negotiate boolean config options neither sees nor writes the
 * Team row. A held official `sessions.flush` proves the policy terminal is the
 * raw setter call, not a request/close acknowledgement, and its rejection stays
 * an indeterminate write whose durable state is read back.
 *
 * The public `dsh --profile pi-tui acp stdio` bridge carries one standard
 * set_config_option write over pure JSON-RPC stdout. A normal Host restart then
 * re-reads the committed `plan/mode` and `team/mode` records through the
 * official resume fold.
 *
 * @module split-process/acp-session-config
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import * as acp from '@agentclientprotocol/sdk'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { hostSessionEvents, waitForHostSessionEvent, waitForHostSessionEventAfter } from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'
import { openSdkClient } from './acp-protocol-projection.mjs'
import { CliProcess } from './acp-stdio-a1.mjs'

const CASE_ID = 'acp.session-config'
const MODEL_PROVIDER = 'c1-qualification'
const EXTRA_MODEL = 'c1-model-b'
const PLAN_POLICY_MARKER = 'You are in plan mode. Stay in plan mode'

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

function updatesFor(updates, sessionId) {
  return updates.filter(params => params?.sessionId === sessionId).map(params => params.update)
}

/** The newest config_option_update for one row must carry the exact target value. */
function configRowValue(updates, sessionId, id) {
  const last = updatesFor(updates, sessionId)
    .filter(update => update?.sessionUpdate === 'config_option_update')
    .at(-1)
  return last === undefined ? undefined : configOption(last.configOptions, id)?.currentValue
}

function modeUpdateValue(updates, sessionId) {
  return updatesFor(updates, sessionId)
    .filter(update => update?.sessionUpdate === 'current_mode_update')
    .map(update => update.currentModeId)
    .filter(value => typeof value === 'string')
    .at(-1)
}

function configOption(options, id) {
  return (options ?? []).find(option => option?.id === id)
}

function modelValue(modelId) {
  return JSON.stringify([MODEL_PROVIDER, modelId])
}

function rootModelValue(options) {
  const option = configOption(options, 'model')
  return option?.currentValue
}

function optionValues(option) {
  return (option?.options ?? []).flatMap(entry => Array.isArray(entry.options) ? entry.options : [entry])
    .map(entry => entry.value)
}

function modelRouteValues(options) {
  const option = configOption(options, 'model')
  return (option?.options ?? []).flatMap(group => group.options ?? []).map(entry => entry.value)
}

async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

async function waitForScreen(client, needle, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await frameOf(client)).includes(needle)) return
    await sleep(100)
  }
  const frame = await frameOf(client).catch(() => '')
  throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: needle, frame: frame.split('\n').slice(-24) })}`)
}

async function submitLine(client, line, label) {
  client.send('\x15')
  const marker = `${label}-draft-probe`
  client.send(marker)
  await client.waitForComposerDraft(marker, 30_000)
  client.send('\x15')
  client.send(line)
  await client.waitForComposerDraft(line, 30_000)
  client.send('\r')
}

/**
 * Run the real session-mode/config qualification.
 * @param context the split smoke run context.
 * @returns the observed facts.
 */
export async function runAcpSessionConfig(context) {
  const { EntryProcess, entries, base, dshHome, workDir, installation, trace } = context
  const scene = createC1Scene(context)
  const hostCwd = realpathSync(workDir)
  const lifecycleControl = join(workDir, 'pr3b-lifecycle')
  mkdirSync(lifecycleControl, { recursive: true, mode: 0o700 })
  let lifecycleSequence = 0
  const clients = []
  let peer
  let host
  let tui

  try {
    const started = await scene.startC1Host('acp-session-config', 'PR3B host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_LIFECYCLE_CONTROL: lifecycleControl,
      C1_EXTRA_MODEL: EXTRA_MODEL,
      C1_MODEL_S1_ROUTE: EXTRA_MODEL,
    })
    host = started.host
    const ready = started.ready
    const hostWorkRoot = started.workRoot
    const scopeId = ready.localHost?.scopeId
    assert(typeof scopeId === 'string' && scopeId.length === 64, 'PR3B-01: Host Ready must publish the full scope id')
    const hostIdentity = await scene.hostIdentityFacts(host)
    const lifecycleSignal = (action, sessionId, fields = {}) => {
      const name = `action-${String(++lifecycleSequence)}-${action}.json`
      writeFileSync(join(lifecycleControl, name), JSON.stringify({ action, sessionId, ...fields }), { mode: 0o600 })
    }
    const lifecycleAction = async (action, sessionId, kind, label, fields = {}) => {
      const before = hostWorkRoot === undefined ? 0 : readC1WorkEvents(hostWorkRoot).length
      lifecycleSignal(action, sessionId, fields)
      return await waitForC1WorkEvent(hostWorkRoot,
        (event, index) => index >= before && event.kind === kind && event.sessionId === sessionId, label, 120_000)
    }
    const waitForWork = async (kind, sessionId, label, fields = {}) => {
      return await waitForC1WorkEvent(hostWorkRoot,
        event => event.kind === kind && event.sessionId === sessionId
          && Object.entries(fields).every(([key, value]) => event[key] === value), label, 120_000)
    }

    tui = await scene.startC1Client('PR3B TUI')
    await scene.assertInteractionGate(tui.client, 'PR3B TUI')
    const sessionId = await scene.openC1Session(tui.client, 'pr3b-session-config-seed', 'PR3B TUI')
    await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'PR3B seed turn end')
    const eventMark = () => (hostSessionEvents(dshHome, sessionId) ?? []).length

    peer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer.qualificationLabel = 'PR3B ACP peer'
    await peer.waitFor(record => record.m4a0 === 'ready', 'PR3B peer ready', 180_000)
    const accessRequest = `pr3b-access-${String(Date.now())}-${String(process.pid)}`
    peer.send({ op: 'qualification-acp-access', requestId: accessRequest, acpEnabled: true })
    const access = await peer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === accessRequest,
      'PR3B ACP access', 120_000)
    assert(access.ok === true && access.status?.state === 'enabled',
      `PR3B-01: the ACP front door must enable (${JSON.stringify(access)})`)
    const endpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${scopeId.slice(0, 40)}/acp.sock` }
      : { path: join(dshHome, 'run', 'dsh-pi-tui', scopeId, 'acp.sock'), dir: join(dshHome, 'run', 'dsh-pi-tui', scopeId) }
    assert(existsSync(endpoint.path), `PR3B-01: the enabled front door must publish ${endpoint.path}`)

    const updates = []
    const elicitations = []
    const client = await openSdkClient(endpoint, params => { updates.push(params) }, async params => {
      elicitations.push(params)
      return { action: 'accept', content: { q0: 'Approve' } }
    })
    clients.push(client)
    const init = await client.request(acp.methods.agent.initialize, {
      protocolVersion: 1,
      clientCapabilities: {
        session: { configOptions: { boolean: {} } },
        elicitation: { form: {} },
      },
    })
    assert(init?.protocolVersion === 1, 'PR3B-01: initialize must answer protocolVersion 1')

    const resumed = await client.request(acp.methods.agent.session.resume, { sessionId, cwd: hostCwd })
    assert(resumed?.modes?.currentModeId === 'default',
      `PR3B-01: a fresh root must read the committed default mode (${JSON.stringify(resumed?.modes)})`)
    assert((resumed?.modes?.availableModes ?? []).map(mode => mode.id).join(',') === 'default,plan',
      'PR3B-01: the fixed two-mode vocabulary must be advertised')
    const initialOptions = resumed?.configOptions ?? []
    assert(configOption(initialOptions, 'model') !== undefined, 'PR3B-01: the model row must be present')
    const initialTeam = configOption(initialOptions, 'agent_team')
    assert(initialTeam !== undefined && initialTeam.type === 'boolean' && initialTeam.currentValue === false,
      `PR3B-01: a negotiated fresh root must read Team=false (${JSON.stringify(initialTeam)})`)
    assert(configOption(initialOptions, 'mode')?.currentValue === 'default',
      'PR3B-01: the mode row must read the same committed mode')

    // L2: legacy set_mode -> durable plan/mode -> standard notifications and a
    // real TUI observation; the TUI's own /plan off writes the same authority.
    let mark = eventMark()
    const modeResult = await client.request(acp.methods.agent.session.setMode, { sessionId, modeId: 'plan' })
    assert(JSON.stringify(modeResult ?? {}) === '{}', `PR3B-02: set_mode must answer an empty object (${JSON.stringify(modeResult)})`)
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'plan/mode' && event.data?.active === true, 'PR3B official plan/mode true')
    await waitFor(() => modeUpdateValue(updates, sessionId) === 'plan'
      && configRowValue(updates, sessionId, 'mode') === 'plan' ? true : undefined,
    'PR3B-02 the standard current_mode_update and config row')
    await waitForScreen(tui.client, 'Plan mode', 'PR3B TUI observes the committed plan mode')

    mark = eventMark()
    await submitLine(tui.client, '/plan off', 'PR3B-plan-off')
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'plan/mode' && event.data?.active === false, 'PR3B TUI /plan off commits')
    await waitFor(() => modeUpdateValue(updates, sessionId) === 'default'
      && configRowValue(updates, sessionId, 'mode') === 'default' ? true : undefined,
    'PR3B-02 the TUI reverse write reaches the ACP connection with the exact mode')

    // The config-row form enters the SAME write seat and returns the complete
    // list (model/mode/agent_team), not a partial mode-only snapshot.
    mark = eventMark()
    const viaConfig = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'mode', value: 'plan',
    })
    assert(configOption(viaConfig?.configOptions, 'mode')?.currentValue === 'plan',
      'PR3B-02: the mode config write must return the complete new state')
    assert(configOption(viaConfig?.configOptions, 'model') !== undefined
      && configOption(viaConfig?.configOptions, 'agent_team') !== undefined,
    'PR3B-02: the mode reply must include the other rows')
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'plan/mode' && event.data?.active === true, 'PR3B config mode commits plan')
    await waitFor(() => modeUpdateValue(updates, sessionId) === 'plan'
      && configRowValue(updates, sessionId, 'mode') === 'plan' ? true : undefined,
    'PR3B-02 the config-mode notification carries the exact target')

    // The REAL official exit review: one ACP prompt makes the scripted Host
    // model call `exit_plan_mode`; the tool asks its question through the ACP
    // View's standard Form; the approval sets the pending selection that the
    // same accepted in-turn pre-step commits back to default.
    mark = eventMark()
    const exitPrompt = await client.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: promptText('PR3B_EXIT_PLAN'),
    })
    assert(exitPrompt?.stopReason === 'end_turn',
      `PR3B-02: the exit-plan turn must complete (${JSON.stringify(exitPrompt)})`)
    assert(elicitations.length === 1,
      `PR3B-02: the official exit review must reach exactly one standard Form (${JSON.stringify(elicitations)})`)
    assert(elicitations[0]?.requestedSchema?.properties?.q0 !== undefined,
      'PR3B-02: the Form must carry the official review choice')
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'tool/call' && event.data?.name === 'exit_plan_mode',
      'PR3B official exit_plan_mode call')
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'plan/mode' && event.data?.active === false,
      'PR3B accepted pre-step commits the approved exit')
    await waitFor(() => modeUpdateValue(updates, sessionId) === 'default'
      ? true : undefined,
    'PR3B-02 the approved exit notifies current_mode_update default')
    trace('acp-session-config/exit-review', { sessionId, formMessage: elicitations[0]?.message })
    // Re-enter plan for the remaining Team/model/cold assertions through the
    // SAME official setter.
    mark = eventMark()
    await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'mode', value: 'plan',
    })
    assert(await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'plan/mode' && event.data?.active === true,
      'PR3B plan re-entered') !== undefined, 'PR3B-02: the plan re-entry must commit')

    // An ORDINARY ACP prompt while plan is committed: the real provider request
    // must carry the official plan policy section, and the turn still ends as
    // an ordinary end_turn (not a MIXED/failed turn).
    const planPrompt = await client.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: promptText('PR3B_ORDINARY'),
    })
    assert(planPrompt?.stopReason === 'end_turn',
      `PR3B-02: the ordinary plan-mode prompt must complete (${JSON.stringify(planPrompt)})`)
    const promptEvidencePath = base.env?.SPLIT_PROCESS_PROMPT_EVIDENCE
    const promptEvidence = typeof promptEvidencePath === 'string' && promptEvidencePath !== ''
      ? readFileSync(promptEvidencePath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
      : []
    const planEvidence = promptEvidence.find(entry => typeof entry?.userText === 'string'
      && entry.userText.includes('PR3B_ORDINARY'))
    assert(planEvidence?.planPolicy === true,
      `PR3B-02: the real provider request must carry the official plan policy (${JSON.stringify(planEvidence)})`)

    // An independent B connection/Session stays fully usable while A's Team
    // policy terminal is held; it is not another View of A.
    const bClient = await openSdkClient(endpoint, () => {})
    clients.push(bClient)
    await bClient.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const bCreated = await bClient.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    const bSession = bCreated?.sessionId
    assert(typeof bSession === 'string' && bSession !== '', 'PR3B-03: the independent B root must attach')

    // L3: the official Team flush is held AFTER its committed team/mode append;
    // the reply and the close must both wait for the raw terminal. No second
    // policy write/prompt may start on this View while it is held.
    const teamHold = join(workDir, 'pr3b-team-flush-hold')
    await lifecycleAction('arm-team-flush-hold', sessionId, 'lifecycle-team-flush-hold-armed',
      'PR3B arm Team flush hold', { release: teamHold })
    // The SAME held flush must reject at release: hold first, then the official
    // terminal failure; the durable true selection is never rolled back.
    await lifecycleAction('arm-team-flush-failure', sessionId, 'lifecycle-team-flush-failure-armed',
      'PR3B arm Team flush failure')
    mark = eventMark()
    let teamSettled = false
    let teamError
    const teamRequest = client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'agent_team', type: 'boolean', value: true,
    }).then(value => { teamSettled = true; return value }, error => { teamSettled = true; teamError = error; throw error })
    teamRequest.catch(() => {})
    const held = await waitForWork('lifecycle-team-flush-held', sessionId,
      'PR3B the Team flush is held', { release: teamHold })
    assert(held?.release === teamHold, `PR3B-03: the held record must name the release path (${JSON.stringify(held)})`)
    const teamModeOn = await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'team/mode' && event.data?.enabled === true, 'PR3B official team/mode true')
    assert(teamModeOn !== undefined, 'PR3B-03: the Team write must commit its durable event before the held flush')
    assert(teamSettled === false, 'PR3B-03: the ACP reply cannot settle while the official flush is held')
    const concurrent = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'mode', value: 'default',
    }).then(value => ({ value }), error => ({ error }))
    assert(concurrent.error?.data?.code === 'LOCAL_ACP_CONFIG_VIEW_BUSY',
      `PR3B-03: a second policy write must be pre-write VIEW_BUSY with zero invocation (${JSON.stringify(concurrent)})`)
    const promptBusy = await client.request(acp.methods.agent.session.prompt, {
      sessionId, prompt: promptText('PR3B_PROMPT_WHILE_HELD'),
    }).then(value => ({ value }), error => ({ error }))
    assert(promptBusy.error?.data?.code === 'LOCAL_ACP_PROMPT_IN_FLIGHT',
      `PR3B-03: a prompt must be refused while the policy terminal is held (${JSON.stringify(promptBusy)})`)
    const bPrompt = await bClient.request(acp.methods.agent.session.prompt, {
      sessionId: bSession, prompt: promptText('PR3B_B_WHILE_HELD'),
    })
    assert(bPrompt?.stopReason === 'end_turn',
      `PR3B-03: the independent B Session must keep working while A is held (${JSON.stringify(bPrompt)})`)
    let closeSettled = false
    const closeRequest = client.request(acp.methods.agent.session.close, { sessionId })
      .then(value => { closeSettled = true; return value }, error => { closeSettled = true; throw error })
    closeRequest.catch(() => {})
    await sleep(150)
    assert(closeSettled === false, 'PR3B-03: close cannot fabricate a detach while the policy terminal is unproven')
    writeFileSync(teamHold, '1', { mode: 0o600 })
    const teamOutcome = await teamRequest.then(value => ({ value }), error => ({ error }))
    assert(teamOutcome.error?.data?.code === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
      `PR3B-03: the released rejecting flush must stay indeterminate (${JSON.stringify({ data: teamOutcome.error?.data, message: teamOutcome.error?.message })})`)
    assert((hostSessionEvents(dshHome, sessionId) ?? [])
      .some(event => event.type === 'team/mode' && event.data?.enabled === true),
    'PR3B-03: the durable Team=true must survive the rejected flush')
    await closeRequest
    await bClient.request(acp.methods.agent.session.close, { sessionId: bSession })

    // Reattach and prove a rejected flush stays an indeterminate write while
    // its already-appended selection is the real readback fact.
    const resumed2 = await client.request(acp.methods.agent.session.resume, { sessionId, cwd: hostCwd })
    assert(configOption(resumed2?.configOptions, 'agent_team')?.currentValue === true,
      'PR3B-04: the reattached View must read the committed Team=true')
    // The real TUI observes the SAME committed Team projection on its `/model`
    // Team row; this is a read, not a second authority.
    await submitLine(tui.client, '/model', 'PR3B-team-model')
    await waitForScreen(tui.client, 'Agent Team', 'PR3B TUI opens the Agent Team row')
    // The real picker may expose thought_level ahead of the Team row; tab until
    // the Team row itself is focused, never assume a fixed row offset.
    let teamFocused = false
    for (let tab = 0; tab < 6 && !teamFocused; tab++) {
      tui.client.send('\t')
      await sleep(120)
      teamFocused = (await frameOf(tui.client)).includes('[On]')
    }
    assert(teamFocused, 'PR3B TUI must focus the real Team row before toggling')
    mark = eventMark()
    tui.client.send('\r')
    await waitForScreen(tui.client, 'Team collaboration will be disabled',
      'PR3B TUI opens the official Team disable confirmation')
    tui.client.send('\t')
    tui.client.send('\r')
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'team/mode' && event.data?.enabled === false,
      'PR3B TUI confirmation commits the official Team off')
    await waitFor(() => configRowValue(updates, sessionId, 'agent_team') === false ? true : undefined,
      'PR3B TUI Team off reaches the ACP full list')
    await waitForScreen(tui.client, '[Off]', 'PR3B TUI reads the official Team OFF projection')
    tui.client.send('\x1b')
    await waitForScreen(tui.client, 'Tab Team', 'PR3B TUI returns to the model list after Team off')
    tui.client.send('\x1b')
    mark = eventMark()
    await lifecycleAction('arm-team-flush-failure', sessionId, 'lifecycle-team-flush-failure-armed',
      'PR3B arm Team flush failure')
    const failedTeam = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'agent_team', type: 'boolean', value: true,
    }).then(value => ({ value }), error => ({ error }))
    assert(failedTeam.error?.data?.code === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
      `PR3B-04: a rejected official flush must stay indeterminate (${JSON.stringify(failedTeam)})`)
    await waitForHostSessionEventAfter(dshHome, sessionId, mark,
      event => event.type === 'team/mode' && event.data?.enabled === true, 'PR3B official team/mode true')
    await waitFor(() => configRowValue(updates, sessionId, 'agent_team') === true ? true : undefined,
    'PR3B-04 the independent readback notification keeps the real committed true value')
    // One normal same-value official Team setter must also settle successfully
    // before the cold restart; this is a real successful flush, not another fault.
    const sameTeam = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'agent_team', type: 'boolean', value: true,
    })
    assert(configOption(sameTeam?.configOptions, 'agent_team')?.currentValue === true,
      'PR3B-04: a normal same-value Team write must return the complete true state')

    // A connection that did NOT negotiate boolean config options sees no Team
    // row and cannot write it; the same Session's model/mode rows stay intact.
    const plainUpdates = []
    const plain = await openSdkClient(endpoint, params => { plainUpdates.push(params) })
    clients.push(plain)
    await plain.request(acp.methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    // A second connection owns its OWN root Session: one Host Session carries
    // at most one ACP View, so the same-Session form would be an attach refusal,
    // not a capability negative.
    const plainCreated = await plain.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    const plainSession = plainCreated?.sessionId
    assert(configOption(plainCreated?.configOptions, 'agent_team') === undefined,
      'PR3B-05: an unnegotiated client must not be offered the Team row')
    const plainWrite = await plain.request(acp.methods.agent.session.setConfigOption, {
      sessionId: plainSession, configId: 'agent_team', type: 'boolean', value: true,
    }).then(value => ({ value }), error => ({ error }))
    assert(plainWrite.error?.code === -32602 && plainWrite.error?.data?.code === 'LOCAL_ACP_CONFIG_INVALID_OPTION',
      `PR3B-05: an unnegotiated Team write must be an invalid-option refusal (${JSON.stringify(plainWrite)})`)
    await plain.request(acp.methods.agent.session.close, { sessionId: plainSession })

    // L4: a real model/effort write keeps the Session-only model authority and
    // returns the same complete config list; a FRESH session proves the default
    // route was untouched by the ACP write.
    const modelOptions = resumed2?.configOptions
    const routes = modelRouteValues(modelOptions)
    assert(routes.includes(modelValue(EXTRA_MODEL)), `PR3B-06: the real extra model must be selectable (${JSON.stringify(routes)})`)
    const defaultRoute = rootModelValue(modelOptions)
    const modelReply = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'model', value: modelValue(EXTRA_MODEL),
    })
    assert(configOption(modelReply?.configOptions, 'model')?.currentValue === modelValue(EXTRA_MODEL),
      'PR3B-06: the model write must return the committed new value')
    assert(configOption(modelReply?.configOptions, 'mode')?.currentValue === 'plan'
      && configOption(modelReply?.configOptions, 'agent_team')?.currentValue === true,
    'PR3B-06: the model reply must include the mode/Team rows')
    await waitForHostSessionEvent(dshHome, sessionId,
      event => event.type === 'model/selection' && event.data?.model === EXTRA_MODEL,
    'PR3B-06 the official Session model/selection')
    // The real extra route declares reasoning metadata; one real effort write
    // must keep the model/mode/Team rows and land the official selection fact.
    const thought = configOption(modelReply.configOptions, 'thought_level')
    assert(thought !== undefined, 'PR3B-06: the extra route must expose its real effort row')
    const effortValues = optionValues(thought)
    const targetEffort = effortValues.find(value => value !== thought.currentValue)
    assert(typeof targetEffort === 'string' && targetEffort !== '',
      `PR3B-06: a second real effort value must be selectable (${JSON.stringify(effortValues)})`)
    trace('acp-session-config/model-effort', { current: thought.currentValue, values: effortValues, target: targetEffort })
    const effortReply = await client.request(acp.methods.agent.session.setConfigOption, {
      sessionId, configId: 'thought_level', value: targetEffort,
    })
    trace('acp-session-config/effort-replied', { current: configOption(effortReply?.configOptions, 'thought_level')?.currentValue })
    assert(configOption(effortReply?.configOptions, 'thought_level')?.currentValue === targetEffort,
      'PR3B-06: the effort write must return the committed value')
    assert(configOption(effortReply?.configOptions, 'model')?.currentValue === modelValue(EXTRA_MODEL)
      && configOption(effortReply?.configOptions, 'mode')?.currentValue === 'plan'
      && configOption(effortReply?.configOptions, 'agent_team')?.currentValue === true,
    'PR3B-06: the effort reply must keep model/mode/Team')
    const effortMark = eventMark()
    try {
      const effortEvent = await waitForHostSessionEventAfter(dshHome, sessionId, effortMark,
        event => event.type === 'model/selection' && event.data?.model === EXTRA_MODEL,
        'PR3B-06 the official reasoning effort selection', 5_000)
      if (effortEvent.data?.reasoningEffort !== undefined) {
        assert(effortEvent.data.reasoningEffort === targetEffort,
          `PR3B-06: the official effort selection must match the reply (${JSON.stringify(effortEvent.data)})`)
      }
    } catch {
      // The offline route emits no separate model/selection event for an
      // effort-only change; the complete fenced setter reply is the readback.
      trace('acp-session-config/effort-event-absent', { sessionId, targetEffort })
    }
    trace('acp-session-config/before-fresh', {})
    const fresh = await client.request(acp.methods.agent.session.new, { cwd: hostCwd, mcpServers: [] })
    trace('acp-session-config/after-fresh', { sessionId: fresh?.sessionId })
    const freshModel = rootModelValue(fresh?.configOptions)
    assert(freshModel === defaultRoute,
      `PR3B-06: an ACP Session model write must not change the profile default (${JSON.stringify({ defaultRoute, freshModel })})`)
    await client.request(acp.methods.agent.session.close, { sessionId: fresh.sessionId })

    // L6: the public stdio bridge carries the SAME standard method over a pure
    // JSON-RPC stdout stream.
    const stdio = new CliProcess(context, ['--profile', 'pi-tui', 'acp', 'stdio'])
    try {
      const stdioInit = await stdio.initialize({ session: { configOptions: { boolean: {} } } })
      assert(stdioInit?.protocolVersion === acp.PROTOCOL_VERSION, 'PR3B-07: the stdio bridge must initialize')
      // A new stdio Session: the main SDK connection already owns the shared
      // Session's single ACP View, so a same-Session resume would be the
      // correct attach refusal rather than a bridge capability proof.
      const stdioCreated = await stdio.connection.agent.request(acp.methods.agent.session.new, {
        cwd: hostCwd, mcpServers: [],
      })
      const stdioSession = stdioCreated?.sessionId
      assert(stdioCreated?.modes?.currentModeId === 'default', 'PR3B-07: stdio must serve the standard initial modes')
      assert(configOption(stdioCreated?.configOptions, 'agent_team')?.currentValue === false,
        'PR3B-07: the stdio bridge must project the negotiated Team row')
      const stdioWrite = await stdio.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: stdioSession, configId: 'mode', value: 'plan',
      })
      assert(configOption(stdioWrite?.configOptions, 'mode')?.currentValue === 'plan',
        'PR3B-07: the stdio standard config write must commit and read back plan')
      const stdioTeam = await stdio.connection.agent.request(acp.methods.agent.session.setConfigOption, {
        sessionId: stdioSession, configId: 'agent_team', type: 'boolean', value: true,
      })
      assert(configOption(stdioTeam?.configOptions, 'agent_team')?.currentValue === true,
        'PR3B-07: the stdio bridge must write the negotiated boolean option')
      await waitFor(() => stdio.updates.some(params => params?.sessionId === stdioSession
        && params.update?.sessionUpdate === 'config_option_update'
        && configOption(params.update.configOptions, 'agent_team')?.currentValue === true) ? true : undefined,
      'PR3B-07 the stdio boolean config update')
      for (const chunk of stdio.rawStdout().toString('utf8').split('\n').filter(Boolean)) {
        assert(JSON.parse(chunk) !== undefined, 'PR3B-07: every stdout line must be JSON-RPC')
      }
      await stdio.connection.agent.request(acp.methods.agent.session.close, { sessionId: stdioSession })
    } finally {
      await stdio.close()
    }
    trace('acp-session-config/stdio-done', {})
    await waitForHostSessionEvent(dshHome, sessionId,
      event => event.type === 'plan/mode' && event.data?.active === true, 'PR3B main session keeps its committed plan mode')

    // L1 load: with the main ACP View closed, the SAME Host replays the real
    // history and returns its initial mode/config state through session/load.
    await client.close()
    const loader = await openSdkClient(endpoint, () => {})
    clients.push(loader)
    await loader.request(acp.methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } },
    })
    const loaded = await loader.request(acp.methods.agent.session.load, {
      sessionId, cwd: hostCwd, mcpServers: [],
    })
    assert(loaded?.modes?.currentModeId === 'plan',
      `PR3B-01: session/load must return the committed legacy modes (${JSON.stringify(loaded?.modes)})`)
    assert(configOption(loaded?.configOptions, 'mode')?.currentValue === 'plan'
      && configOption(loaded?.configOptions, 'agent_team')?.currentValue === true,
    'PR3B-01: session/load must return the complete current config rows')
    trace('acp-session-config/load-done', {})
    await loader.request(acp.methods.agent.session.close, { sessionId })

    // Cold readback: stop the first Host, boot a genuine new Host identity in
    // the same private profile and read the committed mode/Team through the
    // official resume fold.
    for (const live of clients) {
      try { await live.close() } catch { /* the old transport is already closed */ }
    }
    clients.length = 0
    if (peer !== undefined) {
      try { await peer.shutdown() } catch { /* the global backstop owns a stuck child */ }
      peer = undefined
    }
    if (tui !== undefined && !tui.client.exited) await scene.exitC1Client(tui.client, 'PR3B TUI exit')
    const oldHostPid = hostIdentity.hostPid
    await scene.stopC1Host(host)
    host = undefined

    const restarted = await scene.startC1Host('acp-session-config', 'PR3B cold host', {
      DSH_PI_TUI_ACP_MAX_CONNECTIONS: '8',
      C1_LIFECYCLE_CONTROL: lifecycleControl,
      C1_EXTRA_MODEL: EXTRA_MODEL,
      C1_MODEL_S1_ROUTE: EXTRA_MODEL,
    }, hostWorkRoot)
    host = restarted.host
    const coldReady = restarted.ready
    const coldScope = coldReady.localHost?.scopeId
    const coldPeer = new EntryProcess('peer', entries.client, {
      ...base,
      env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer' },
    })
    peer = coldPeer
    await coldPeer.waitFor(record => record.m4a0 === 'ready', 'PR3B cold peer ready', 180_000)
    const coldAccessRequest = `pr3b-cold-access-${String(Date.now())}-${String(process.pid)}`
    coldPeer.send({ op: 'qualification-acp-access', requestId: coldAccessRequest, acpEnabled: true })
    const coldAccess = await coldPeer.waitFor(entry => entry.op === 'acp-access' && entry.requestId === coldAccessRequest,
      'PR3B cold ACP access', 120_000)
    assert(coldAccess.ok === true, 'PR3B-08: the restarted Host must enable ACP')
    const coldEndpoint = process.platform === 'darwin'
      ? { path: `/private/tmp/dpt-${String(process.getuid())}-${String(coldScope).slice(0, 40)}/acp.sock` }
      : { path: join(dshHome, 'run', 'dsh-pi-tui', String(coldScope), 'acp.sock'), dir: join(dshHome, 'run', 'dsh-pi-tui', String(coldScope)) }
    const coldClient = await openSdkClient(coldEndpoint, () => {})
    clients.push(coldClient)
    await coldClient.request(acp.methods.agent.initialize, {
      protocolVersion: 1, clientCapabilities: { session: { configOptions: { boolean: {} } } },
    })
    const coldResume = await coldClient.request(acp.methods.agent.session.resume, { sessionId, cwd: hostCwd })
    assert(coldResume?.modes?.currentModeId === 'plan',
      `PR3B-08: the cold official fold must read the committed plan mode (${JSON.stringify(coldResume?.modes)})`)
    assert(configOption(coldResume?.configOptions, 'agent_team')?.currentValue === true,
      'PR3B-08: the cold official fold must read the committed Team=true')
    const coldEvents = hostSessionEvents(dshHome, sessionId) ?? []
    assert(coldEvents.some(event => event.type === 'team/mode' && event.data?.enabled === true),
      'PR3B-08: the durable team/mode record must survive the restart')
    assert(coldEvents.filter(event => event.type === 'plan/mode').length >= 2,
      'PR3B-08: the durable plan/mode history must survive the restart')
    const coldIdentity = await scene.hostIdentityFacts(host)
    assert(coldIdentity.hostPid !== oldHostPid, 'PR3B-08: the cold read must belong to a genuine new Host')

    const facts = {
      caseId: CASE_ID,
      sessionId,
      hostPid: hostIdentity.hostPid,
      hostInstanceId: hostIdentity.instanceId,
      coldHostPid: coldIdentity.hostPid,
      scopeId,
      mode: 'plan',
      agentTeam: true,
      modelDefault: defaultRoute,
      modelSelection: modelValue(EXTRA_MODEL),
    }
    trace('acp-session-config/evidence', facts)
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
