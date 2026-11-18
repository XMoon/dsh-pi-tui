/**
 * FR8 `team.board-host-to-tui`: the OFFICIAL Agent Team task board in a real
 * Split Host/Client pair.
 *
 * ONE real installed candidate Host (the C1 qualification fixture row) and ONE
 * real authenticated PTY Client prove, on the SAME Host instance:
 *
 *   1. the Client creates its own Root Session and enables Team through the
 *      REAL `/model` Team gesture; the Host commits the official durable
 *      `team/mode`;
 *   2. the next authored prompt (`FR8_TEAM_CREATE`) makes the scripted Host
 *      model call the OFFICIAL conditional `team_task_create` tool — the task
 *      exists only because the official `agentTeam` authority admitted and
 *      executed it;
 *   3. a SECOND prompt (`FR8_TEAM_UPDATE`) makes the model call the OFFICIAL
 *      `team_task_update`, addressing the task id and expected revision it read
 *      from the previous OFFICIAL tool result — never a fixture-invented id;
 *   4. the CURRENT `/tasks` Team page renders that task from the official
 *      `agentTeam` projection (subject + status + owner), read-only;
 *   5. a SECOND, independent Session's Team page never shows the first
 *      Session's task.
 *
 * The fixture never writes a task or a `team/mode` event by hand and never
 * creates a second Team authority.
 *
 * @module split-process/team-board
 */

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import { waitForSurfaceStatus } from '../../lib/split-smoke-processes.mjs'
import {
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

const MARK_CREATE = 'FR8_TEAM_CREATE'
const MARK_UPDATE = 'FR8_TEAM_UPDATE'
const SUBJECT = 'FR8_BOARD_TASK'

/** The screen's painted text, or '' when the Client cannot read it yet. */
async function frameOf(client) {
  return (await client.viewport()).join('\n')
}

/** Wait for one painted needle in the real Client. */
async function waitForScreen(client, needle, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await frameOf(client)).includes(needle)) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const frame = await frameOf(client).catch(() => '')
  throw new SplitSmokeAssertionError(`${label}: ${JSON.stringify({ wanted: needle, frame: frame.split('\n').slice(-24) })}`)
}

/** Type one line into the proven-empty composer and press Enter. */
async function submitLine(client, line, label) {
  // A fresh Session may open with its seed draft still in the composer; clear
  // it through the real editor before probing the seat.
  client.send('\x15')
  const marker = `${label}-draft-probe`
  client.send(marker)
  try {
    await client.waitForComposerDraft(marker, 30_000)
  } catch (error) {
    const frame = await client.viewport().catch(() => [])
    throw new SplitSmokeAssertionError(`${label}: the composer never accepted a probe draft: ${JSON.stringify(frame.slice(-12))}`, { cause: error })
  }
  client.send('\x15') // clear the probe without submitting it
  // The composer always paints the mode hint (e.g. `Plan mode · describe the
  // task`), so an EMPTY-line heuristic is wrong: prove the probe text is gone
  // through the real editor, then type the line on that same live seat.
  client.send(line)
  try {
    await client.waitForComposerDraft(line, 30_000)
  } catch (error) {
    const frame = await client.viewport().catch(() => [])
    throw new SplitSmokeAssertionError(`${label}: the editor seat never held the submitted line: ${JSON.stringify(frame.slice(-12))}`, { cause: error })
  }
  client.send('\r')
}

/** The OFFICIAL `tool/result` of one exact call id. */
function resultOf(events, callId) {
  return events.find(event => event.type === 'tool/result' && event.data?.message?.toolCallId === callId)
}

/** Whether the Session log carries a durable enable/disable Team write. */
function teamModeEvents(events) {
  return events.filter(event => event.type === 'team/mode')
}

/**
 * The `team.board-host-to-tui` case.
 *
 * @param context the runner context (workDir/dshHome/installation/trace…).
 * @returns `{ status: 'PASS' }` after every assertion held.
 */
export async function runTeamBoard(context) {
  const { dshHome, trace } = context
  const scene = createC1Scene(context)
  try {
    const { host, ready: hostReady, workRoot } = await scene.startC1Host('team-board', 'FR8 team-board Host')
    const hostFacts = await scene.hostIdentityFacts(host)
    assert(hostFacts.hostPid === hostReady.pid, 'FR8 the Host ready record does not own the Host identity')

    const { client } = await scene.startC1Client('FR8 team-board Client')
    await scene.assertInteractionGate(client, 'FR8 Client')
    const session = await scene.openC1Session(client, 'fr8-team-board-seed', 'FR8 team-board Client')
    await waitForHostSessionEvent(dshHome, session, event => event.type === 'turn/end', 'FR8 team-board first turn end')
    assert(teamModeEvents(hostSessionEvents(dshHome, session)).length === 0,
      'FR8 no durable team/mode exists before the user enables Team')

    // ── Enable Team through the REAL `/model` Team row. ──────────────────
    await submitLine(client, '/model', 'FR8-team-model')
    await waitForScreen(client, 'Agent Team', 'FR8 the /model Team row')
    client.send('\t')
    await new Promise(resolve => setTimeout(resolve, 300))
    client.send('\r')
    const enabled = await waitForHostSessionEvent(dshHome, session,
      event => event.type === 'team/mode' && event.data?.enabled === true, 'FR8 official team/mode enable')
    assert(enabled !== undefined, 'FR8 the official Team enablement is durable')
    await waitForScreen(client, '[On]', 'FR8 the picker reads the ON projection back')
    // Leave the model picker: one Esc returns from the Team row to the model
    // list, the second closes it. Wait for the SECOND frame to prove the main
    // composer is the live seat again before issuing another command.
    client.send('\x1b')
    await waitForScreen(client, 'Tab Team', 'FR8 back to the model list')
    client.send('\x1b')
    for (let poll = 0; poll < 200; poll += 1) {
      if (!(await frameOf(client)).includes('Tab Team')) break
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert(!(await frameOf(client)).includes('Tab Team'), 'FR8 the /model picker closed')
    trace('team-board.enabled', { sessionId: session })

    // ── The official create tool builds the task. ─────────────────────────
    await submitLine(client, `Create the shared task ${MARK_CREATE}`, 'FR8-team-create-prompt')
    const createCall = (await waitForHostSessionEvent(dshHome, session,
      event => event.type === 'tool/call' && event.data?.name === 'team_task_create',
      'FR8 official team_task_create call')).data
    const createdEvent = await waitForHostSessionEvent(dshHome, session,
      event => event.type === 'tool/result' && event.data?.message?.toolCallId === createCall.callId,
      'FR8 official team_task_create result')
    assert(createdEvent.data.message.isError !== true, 'FR8 the official create succeeded')
    const created = JSON.parse((createdEvent.data.message.content ?? []).map(block => block.text ?? '').join(''))
    assert(created.subject === SUBJECT, `FR8 the created task carries the authored subject: ${JSON.stringify(created)}`)
    assert(created.status === 'pending' && created.revision === 1, 'FR8 a new task starts pending at revision 1')

    // ── The official update addresses the OFFICIAL result identity. ──────
    await submitLine(client, `Reassign the shared task ${MARK_UPDATE}`, 'FR8-team-update-prompt')
    const updateCall = (await waitForHostSessionEvent(dshHome, session,
      event => event.type === 'tool/call' && event.data?.name === 'team_task_update',
      'FR8 official team_task_update call')).data
    const updateArguments = JSON.parse(updateCall.arguments)
    assert(updateArguments.task_id === created.id, 'FR8 the update addresses the task the create result named')
    assert(updateArguments.expected_revision === created.revision, 'FR8 the update uses the official revision')
    const updatedEvent = await waitForHostSessionEvent(dshHome, session,
      event => event.type === 'tool/result' && event.data?.message?.toolCallId === updateCall.callId,
      'FR8 official team_task_update result')
    assert(updatedEvent.data.message.isError !== true, 'FR8 the official update succeeded')
    const updated = JSON.parse((updatedEvent.data.message.content ?? []).map(block => block.text ?? '').join(''))
    assert(updated.revision === created.revision + 1, 'FR8 the official revision advanced exactly once')
    assert(updated.status === 'in_progress', 'FR8 the reassigned task is in progress')
    assert(updated.owner === 'lead', 'FR8 the task names its owner by agent name')

    // ── The CURRENT Team page renders the official projection. ───────────
    // The OFFICIAL projection of this exact Session is the board authority; the
    // fixture observed it through the real `sessionProjections` registry after
    // every durable `team/task` write.
    const projected = await waitForC1WorkEvent(workRoot,
      event => event.kind === 'team-projection' && event.sessionId === session
        && event.tasks?.some(task => task.id === updated.id && task.revision === updated.revision),
      'FR8 official agentTeam projection carries the updated task')

    const projectedTask = projected.tasks.find(task => task.id === updated.id)
    assert(projectedTask.subject === SUBJECT, `FR8 the projection subject: ${JSON.stringify(projectedTask)}`)
    assert(projectedTask.status === 'in_progress', 'FR8 the projection status is in progress')
    assert(projectedTask.ownerName === 'lead', 'FR8 the projection owner is the Lead by name')

    await submitLine(client, '/tasks', 'FR8-team-tasks')
    await waitForScreen(client, 'Tasks · [Work]', 'FR8 the Tasks panel opens on Work')
    client.send('\t')
    await waitForScreen(client, 'Tasks · Work  [Team]', 'FR8 the Team page opens')
    await waitForScreen(client, 'Agent Team: On (read-only)', 'FR8 the read-only Team status')

    // The page sink is proven on the SAME PAINTED ROW: the status word, the
    // subject and the owner must belong to ONE Task-panel row, so a transcript
    // tool card carrying the same strings can never satisfy it.
    const taskRowOf = async () => {
      const frame = await frameOf(client)
      return frame.split('\n').find(row => row.includes('│')
        && row.includes('in_progress') && row.includes(SUBJECT) && row.includes('· lead'))
    }
    const deadline = Date.now() + 60_000
    let taskRow
    while (Date.now() < deadline && taskRow === undefined) {
      taskRow = await taskRowOf()
      if (taskRow === undefined) await new Promise(resolve => setTimeout(resolve, 100))
    }
    assert(taskRow !== undefined,
      `FR8 one Team panel row carries the official status, subject and owner: ${JSON.stringify((await frameOf(client)).split('\n').slice(-24))}`)

    const page = await frameOf(client)
    const panelRows = page.split('\n').filter(row => row.includes('│')).join('\n')
    assert(!/\brev\b/u.test(panelRows), 'FR8 the page never invents an internal revision column')
    assert(!/\b(claim|assign|complete)\b/iu.test(panelRows), 'FR8 the read-only page offers no write verb')
    // The page is the CURRENT Root Team page of this Session, not a stale frame.
    assert(page.includes('Agent Team: On (read-only)'), 'FR8 the painted page carries the current ON status')
    trace('team-board.rendered', { sessionId: session, taskId: created.id, revision: updated.revision })

    // The two pages keep their OWN selection state across a round trip.
    client.send('\x1b')
    try {
      await client.waitForScreenGone('Agent Team: On (read-only)', 'FR8 Esc closes the Team panel', 60_000)
    } catch (error) {
      const frame = await frameOf(client).catch(() => '')
      throw new SplitSmokeAssertionError(`FR8 the Tasks panel did not close: ${JSON.stringify(frame.split('\n').slice(-24))}`, { cause: error })
    }

    // ── A second Session never borrows this Session's board. ─────────────
    await submitLine(client, '/new', 'FR8-team-new-session')
    const secondStatus = await waitForSurfaceStatus(client,
      record => record.sessionOpen === true && typeof record.openSessionId === 'string'
        && record.openSessionId !== session,
      'FR8 the Client opens a SECOND Session')
    const second = secondStatus.openSessionId
    assert(second !== session, 'FR8 the second Session is independent')
    await submitLine(client, 'fr8-team-board-second', 'FR8-second-session-seed')
    await waitForHostSessionEvent(dshHome, second, event => event.type === 'turn/end', 'FR8 second Session first turn end')
    await submitLine(client, '/tasks', 'FR8-team-tasks-second')
    await waitForScreen(client, 'Tasks · [Work]', 'FR8 the second Session opens the Tasks panel')
    client.send('\t')
    // The second Session's OWN painted Team page is the authoritative readback:
    // wait for it, then assert the first Session's task is absent from it.
    await waitForScreen(client, 'Tasks · Work  [Team]', 'FR8 the second Session Team page paints')
    await waitForScreen(client, 'Team is Off · Enable it from /model', 'FR8 the second Session reports its own OFF board')
    const secondPage = await frameOf(client)
    assert(!secondPage.includes(SUBJECT), 'FR8 the first Session\'s shared task never leaks into another Session')
    assert(!secondPage.includes('in_progress'), 'FR8 the second Session paints no shared task status row')
    // HONEST LIMIT: the official projection observer records only on a Team
    // WRITE, and this Session writes none, so it carries no positive proof that
    // the second Session's projection is empty. The negative above is the
    // PAINTED page of that exact Session; the projection must not CONTRADICT it.
    const secondProjection = readC1WorkEvents(workRoot)
      .filter(event => event.kind === 'team-projection' && event.sessionId === second).at(-1)
    assert(secondProjection === undefined || secondProjection.tasks.length === 0,
      `FR8 the second Session's observed projection never carries a shared task: ${JSON.stringify(secondProjection)}`)
    const secondEvents = hostSessionEvents(dshHome, second)
    assert(hostUserTexts(secondEvents).some(text => text.includes('fr8-team-board-second')),
      'FR8 the second Session owns its own durable prompt')
    trace('team-board.isolated', { first: session, second })

    // The second Session's Tasks panel is still the live seat: close it
    // through the REAL Esc gesture so `/exit` reaches the main composer.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const frame = await frameOf(client)
      if (!/Tasks ·/u.test(frame)) break
      client.send('\x1b')
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    assert(!/Tasks ·/u.test(await frameOf(client)), 'FR8 the second Tasks panel closed before exit')
    await scene.exitC1Client(client, 'FR8 team-board Client')
    await scene.stopC1Host(host)
    return { status: 'PASS' }
  } finally {
    await scene.dispose()
  }
}
