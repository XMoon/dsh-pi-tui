/**
 * Continuity T44-T56: an accepted Turn, foreground Tool, background Job,
 * continuable Child and Host-pending Question/Approval survive the Client
 * that started them.
 *
 * Every scenario owns its REAL Host (one `C1_SCENARIO` per process) and REAL
 * `script(1)` surface Clients over the official authenticated transport. The
 * Host work fixture records the actual Tool/Job/Child/interaction facts, and
 * every terminal claim is read from the official durable Session log — a
 * surviving Host PID alone is never the proof.
 *
 * @module split-process/detached-turn-interactions
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { parse as parseYaml } from 'yaml'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'
import { readC1WorkEvents, waitForC1WorkEvent } from '../../lib/split-smoke-fixtures.mjs'
import {
  alive,
  assertIdentityFields,
  hostStatus,
  waitForSurfaceStatus,
  waitGone,
} from '../../lib/split-smoke-processes.mjs'
import {
  hostAssistantHasText,
  hostSessionEvents,
  hostUserTexts,
  waitForHostSessionEvent,
} from '../../lib/split-smoke-sessions.mjs'
import { createC1Scene } from './c1-scene.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

/**
 * Drive every T44-T56 continuity scene on this run's ONE installation.
 *
 * The case owns its Hosts and every surface Client through ONE C1 scene; its
 * `finally` disposes them, and each scenario stops its own Host before the
 * next one boots. The Host work fixture is the actual business actor; the
 * official durable Session log is the settlement authority.
 */
export async function runDetachedTurnInteractions(context) {
  const { EntryProcess, entries, base, workDir, dshHome, trace, failpoint } = context
  const scene = createC1Scene(context)
  const {
    c1Work,
    c1JobWorkRoot,
    startC1Host,
    stopC1Host,
    startC1Client,
    exitC1Client,
    openC1Session,
    hostIdentityFacts,
    assertHostIdentityKept,
    assertInteractionGate,
  } = scene
  try {
    // T44: a real accepted Turn survives a Client SIGKILL. The LLM stream is
    // held by the Host fixture; the Client disappears while the Host Agent is
    // running, then the SAME Host writes the final assistant message.
    {
      const releaseBarrier = join(workDir, 't44-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't44', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      // The lane's own fail-after control: this case's first real Host is
      // alive here, so the case-owned finally must dispose it and release its
      // seat.
      failpoint('recovery.detached-turn-interactions.after-host-spawn')
      const { client: c1 } = await startC1Client('T44 C1')
      const sessionId = await openC1Session(c1, 't44 prompt', 'T44')
      const held = await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T44 long-turn held')
      assert(held.agentStatus === 'running', `T44 the Host Agent was ${JSON.stringify(held.agentStatus)} while the Turn was held`)
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T44 turn/start')
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      assert(!alive(c1Pid), 'T44 the surface Client survived SIGKILL')
      await c1.dispose()
      assert(alive(ready.pid), 'T44 the Host died on the Client SIGKILL')
      await assertHostIdentityKept(host, hostBefore, 'T44 Host after Client SIGKILL')
      const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
      assert(!beforeRelease.some(event => event.type === 'turn/end'),
        'T44 the Turn had already ended before the barrier was released — the case is not a running-Turn proof')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T44 turn/end without a Client')
      const events = hostSessionEvents(dshHome, sessionId) ?? []
      assert(hostUserTexts(events).filter(text => text === 't44 prompt').length === 1,
        'T44 the prompt was replayed or lost')
      assert(hostAssistantHasText(events, 'long-turn answer'), 'T44 the Host did not write the final assistant message without a Client')
      const { client: c2 } = await startC1Client('T44 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('long-turn answer', 'T44 C2 readback')
      await waitForSurfaceStatus(c2, record => record.openSessionId === sessionId, 'T44 C2 exact Session')
      await exitC1Client(c2, 'T44 C2')
      await stopC1Host(host)
      trace('t44', {
        hostPid: ready.pid,
        c1Pid,
        sessionId,
        hostAliveDuringDetach: true,
        turnEndedWithZeroClients: true,
        promptReplays: 1,
        c2Readback: true,
      })
    }

    // T45: the same running Turn survives a CLEAN Client exit (`/exit`).
    {
      const releaseBarrier = join(workDir, 't45-long-turn.release')
      const { host, ready, workRoot } = await startC1Host('long-turn', 't45', {
        C1_HOLD_LONG_TURN: releaseBarrier,
      })
      const { client: c1 } = await startC1Client('T45 C1')
      const sessionId = await openC1Session(c1, 't45 prompt', 'T45')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T45 long-turn held')
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/start', 'T45 turn/start')
      const hostBefore = await hostIdentityFacts(host)
      await exitC1Client(c1, 'T45 C1 clean exit')
      assert(alive(ready.pid), 'T45 the Host died on the Client clean exit')
      await assertHostIdentityKept(host, hostBefore, 'T45 Host after clean Client exit')
      const beforeRelease = hostSessionEvents(dshHome, sessionId) ?? []
      assert(!beforeRelease.some(event => event.type === 'turn/end'),
        'T45 the Client clean exit cancelled or settled the Host Turn')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T45 turn/end without a Client')
      const events = hostSessionEvents(dshHome, sessionId) ?? []
      assert(hostUserTexts(events).filter(text => text === 't45 prompt').length === 1, 'T45 the prompt was replayed')
      const { client: c2 } = await startC1Client('T45 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('long-turn answer', 'T45 C2 readback')
      await exitC1Client(c2, 'T45 C2')
      await stopC1Host(host)
      trace('t45', { hostPid: ready.pid, sessionId, cleanExitDidNotCancel: true, c2Readback: true })
    }

    // T46: a real foreground Host Tool call survives the Client exit and its
    // result is written exactly once by the Host Tool authority.
    {
      const releaseBarrier = join(workDir, 't46-tool.release')
      const { host, ready, workRoot } = await startC1Host('foreground-tool', 't46', {
        C1_HOLD_TOOL: releaseBarrier,
      })
      const { client: c1 } = await startC1Client('T46 C1')
      const sessionId = await openC1Session(c1, 't46 prompt', 'T46')
      const toolStarted = await waitForC1WorkEvent(workRoot, event => event.kind === 'tool-started' && event.token?.includes(sessionId), 'T46 real Host tool call')
      const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'c1_foreground_tool', 'T46 tool/call')
      assert(String(call.data.callId) === toolStarted.callId, 'T46 fixture proof and durable tool/call disagree on the call id')
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      await c1.dispose()
      assert(alive(ready.pid), 'T46 the Host died on the Client SIGKILL')
      await assertHostIdentityKept(host, hostBefore, 'T46 Host after Client detach')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId, 'T46 Host tool/result')
      assert(result.data?.message?.isError !== true, 'T46 the held Host Tool failed')
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T46 turn/end')
      const results = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === toolStarted.callId)
      assert(results.length === 1, `T46 the Host Tool executed ${String(results.length)} times`)
      const { client: c2 } = await startC1Client('T46 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('foreground answer', 'T46 C2 readback')
      await exitC1Client(c2, 'T46 C2')
      await stopC1Host(host)
      trace('t46', { hostPid: ready.pid, sessionId, callId: toolStarted.callId, toolResults: 1, hostAlive: true })
    }

    // T47: a real background Job (official ctx.jobs registry + OS process)
    // keeps running after the Client exits and settles without one.
    {
      const releaseBarrier = join(workDir, 't47-job.release')
      const { host, ready, workRoot } = await startC1Host('job', 't47', {}, c1JobWorkRoot('t47'))
      const jobRelease = join(workRoot, 'job.release')
      rmSync(jobRelease, { force: true })
      const { client: c1 } = await startC1Client('T47 C1')
      const sessionId = await openC1Session(c1, 't47 prompt', 'T47')
      const registered = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'registered', 'T47 job registered')
      assert(typeof registered.jobId === 'string' && registered.status === 'running', 'T47 no real running Host Job')
      assert(registered.owner === sessionId, 'T47 the Job owner is not the exact Session')
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      await c1.dispose()
      assert(alive(ready.pid), 'T47 the Host died on the Client SIGKILL')
      await assertHostIdentityKept(host, hostBefore, 'T47 Host after Client detach')
      await sleep(500)
      const eventsWhileDetached = readC1WorkEvents(workRoot).filter(event => event.kind === 'job-event' && event.jobId === registered.jobId)
      assert(eventsWhileDetached.every(event => event.event !== 'settled'), 'T47 the Job settled while no Client existed and the barrier was held')
      const jobLiveness = (await hostStatus(host)).liveness
      assert(jobLiveness?.verdict === 'BLOCKED', `T47 the Host status did not report BLOCKED while an owned Job ran: ${JSON.stringify(jobLiveness)}`)
      assert(jobLiveness.reasons?.includes('job-running'), 'T47 the owned Job did not contribute job-running')
      assert(jobLiveness.sourceStates?.jobs === 'ACTIVE', 'T47 the jobs source is not ACTIVE')
      writeFileSync(jobRelease, 'release\n', { mode: 0o600 })
      const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.jobId === registered.jobId && event.event === 'settled', 'T47 job settled without a Client', 120_000)
      assert(settled.status === 'completed', `T47 the Job settled as ${JSON.stringify(settled.status)}`)
      assert(typeof settled.output === 'string' && settled.output.includes('c1-job-done'),
        `T47 the Job output ring did not carry the real process output: ${JSON.stringify(settled.output)}`)
      const settledLiveness = (await hostStatus(host)).liveness
      assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
        `T47 a settled Job left a ghost Job reason: ${JSON.stringify(settledLiveness)}`)
      const { client: c2 } = await startC1Client('T47 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('job accepted', 'T47 C2 job result')
      await exitC1Client(c2, 'T47 C2')
      await stopC1Host(host)
      trace('t47', { hostPid: ready.pid, sessionId, jobId: registered.jobId, jobStatus: settled.status, hostAlive: true, processOutput: true })
    }

    // Host liveness: one real DSH JobRegistry unowned Job. No Client and no
    // Agent is involved; the observer must see the registry's unowned list
    // and event lifecycle directly.
    {
      const { host, ready, workRoot } = await startC1Host('unowned-job', 'unowned-job-arm', {
        C1_UNOWNED_JOB_ARM: join(workDir, 'unowned-job-arm.arm'),
      })
      writeFileSync(join(workDir, 'unowned-job-arm.arm'), 'arm\n', { mode: 0o600 })
      const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-created', 'unowned job created', 120_000)
      const runningLiveness = (await hostStatus(host)).liveness
      assert(runningLiveness?.verdict === 'BLOCKED', `the unowned Job did not block: ${JSON.stringify(runningLiveness)}`)
      assert(runningLiveness.reasons?.includes('job-running'), 'the unowned Job did not contribute job-running')
      assert(runningLiveness.sourceStates?.jobs === 'ACTIVE', 'the unowned Job did not make the jobs source ACTIVE')
      writeFileSync(join(workRoot, 'unowned-job.release'), 'release\n', { mode: 0o600 })
      await waitForC1WorkEvent(workRoot, event => event.kind === 'unowned-job-released' && event.jobId === created.jobId, 'unowned job released', 120_000)
      await waitForC1WorkEvent(workRoot, event => event.kind === 'job-event' && event.event === 'settled' && event.jobId === created.jobId, 'unowned job settled', 120_000)
      const settledLiveness = (await hostStatus(host)).liveness
      assert(!settledLiveness.reasons?.includes('job-running') && !settledLiveness.reasons?.includes('job-stopping'),
        `a settled unowned Job left a ghost reason: ${JSON.stringify(settledLiveness)}`)
      assert(settledLiveness.sourceStates?.jobs === 'IDLE', `the unowned Job source did not return to IDLE: ${JSON.stringify(settledLiveness.sourceStates)}`)
      await stopC1Host(host)
      trace('unowned-job-arm', { hostPid: ready.pid, jobId: created.jobId, runningVerdict: runningLiveness.verdict, settledJobsState: settledLiveness.sourceStates.jobs })
    }

    // Host liveness: ONE real armed Goal is the only thing that keeps this
    // Host from claiming quiescence. The automatic `goal-round-driver` row is
    // disabled on this Host on purpose: it reserves a round the moment the
    // Goal is armed, and with the fixture's instant scripted answer that
    // round ends and the driver then blocks the Goal at `round-limit`. The
    // armed state would then be a transient window whose Host status depends
    // on when the read lands, so the driver's own reservation is qualified
    // separately by the goal-round case below.
    {
      const armedPatch = join(workDir, 'goal-armed.patch.yml')
      const operations = parseYaml(readFileSync(c1Work.patchPath, 'utf8'))
      operations.push({ id: 'goal-round-driver', disabled: true })
      writeFileSync(armedPatch, JSON.stringify(operations, null, 2), { mode: 0o600 })
      const { host, ready, workRoot } = await startC1Host('goal-armed', 'goal-armed', {
        SPLIT_PROCESS_EXTRA_PATCH: armedPatch,
      })
      // The readiness record's Loader rows are the authority that the
      // automatic driver really is OFF here: a disabled row stays listed with
      // the `absent` state (a failed or transitional row would report a
      // `state-N` fiber value), exactly one row may carry the id, and its
      // name must be the official driver package.
      const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
      assert(driverRows.length === 1
          && driverRows[0].state === 'absent'
          && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
        `the armed-Goal Host did not carry exactly one never-mounted goal-round-driver row: ${JSON.stringify(driverRows)}`)
      // Only the driver is isolated: the Goal service row stays ACTIVE, so
      // this Host still reads a real official Goal source.
      assert(ready.entries.some(entry => entry.id === 'goal'
          && entry.name === '@deepseek-ai/dsh-goal'
          && entry.state === 'active'),
        'the armed-Goal Host lost the real Goal service row instead of only its round driver')
      const { client } = await startC1Client('goal-armed C1')
      const sessionId = await openC1Session(client, 'goal-armed prompt', 'goal-armed')
      const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-armed goal created', 120_000)
      assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-armed goal was not armed: ${JSON.stringify(created)}`)
      const goalLiveness = (await hostStatus(host)).liveness
      assert(goalLiveness?.verdict === 'BLOCKED', `the armed Goal did not block: ${JSON.stringify(goalLiveness)}`)
      assert(goalLiveness.reasons?.includes('goal-armed'), 'the armed Goal did not contribute goal-armed')
      assert(goalLiveness.sourceStates?.goal === 'ACTIVE', 'the goal source is not ACTIVE')
      // The Goal is the sole blocking source: the Agent itself is idle with
      // an empty inbox, so neither of its live-work reasons may appear.
      assert(goalLiveness.sourceStates?.agent !== 'ACTIVE', `the Agent was ACTIVE beside the armed Goal: ${JSON.stringify(goalLiveness.sourceStates)}`)
      assert(!goalLiveness.reasons?.includes('agent-running') && !goalLiveness.reasons?.includes('agent-inbox'),
        `the Agent contributed a blocking reason beside the armed Goal: ${JSON.stringify(goalLiveness.reasons)}`)
      // The C1 Host mounts one active test-only file-URL Loader row through
      // `c1Work.patchPath`. Reading the REAL `context.loader` must surface it
      // as an unqualified Host source; the reflect-store probe this replaced
      // silently missed every active Loader row on the real Host path.
      assert(goalLiveness.sourceStates?.other === 'UNKNOWN', 'the active test-only Loader row was not observed through the real Loader')
      assert(goalLiveness.reasons?.includes('unqualified-host-source'), 'the unqualified Host source reason is missing')
      // The create is the only Goal transition this Host could have made: no
      // automatic round, so no pause/block/disarm inside the observation.
      const armedMutations = readC1WorkEvents(workRoot).filter(event => event.kind === 'goal-changed')
      assert(armedMutations.length === 1 && armedMutations[0].goalId === created.goalId && armedMutations[0].operation === 'create',
        `the isolated armed Goal moved out of the created state: ${JSON.stringify(armedMutations)}`)
      await exitC1Client(client, 'goal-armed C1')
      await stopC1Host(host)
      trace('goal-armed', {
        hostPid: ready.pid,
        sessionId,
        goalId: created.goalId,
        verdict: goalLiveness.verdict,
        goalState: goalLiveness.sourceStates.goal,
        agentState: goalLiveness.sourceStates.agent,
      })
    }

    // The REAL `goal-round-driver` owns the automatic reservation: the
    // fixture only creates the governing Goal through the official service
    // and never queues the round itself. This case proves the reservation is
    // a real Agent inbox round and that the one-round budget then ends the
    // armed state. It reads no Host liveness, because with this driver
    // mounted the armed Goal is transient by design; the stable armed-Goal
    // liveness proof is the goal-armed case above.
    {
      const { host, ready, workRoot } = await startC1Host('goal-round', 'goal-round')
      // Positive control for the armed case's row vocabulary: the same id,
      // name and `active` state are what the real driver mounts when the
      // overlay does not disable it.
      const driverRows = ready.entries.filter(entry => entry.id === 'goal-round-driver')
      assert(driverRows.length === 1
          && driverRows[0].state === 'active'
          && driverRows[0].name === '@deepseek-ai/dsh-goal-round-driver',
        `the goal-round Host did not mount exactly one active goal-round-driver row: ${JSON.stringify(driverRows)}`)
      const { client } = await startC1Client('goal-round C1')
      const sessionId = await openC1Session(client, 'goal-round prompt', 'goal-round')
      const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-created', 'goal-round goal created', 120_000)
      assert(created.goalPhase === 'active' && created.activation === 'armed', `goal-round goal was not armed: ${JSON.stringify(created)}`)
      const round = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-round-observed', 'goal round reserved', 120_000)
      assert(round.goalId === created.goalId, 'the reserved goal round names a different Goal')
      assert(round.revision === created.revision, `the reserved goal round names revision ${JSON.stringify(round.revision)}`)
      assert(round.round === 1, `the first automatic goal round was ${JSON.stringify(round.round)}`)
      assert(round.agentStatus === 'idle', `the goal round was reserved while the Agent was ${JSON.stringify(round.agentStatus)}`)
      // The reservation is durable: the official loop admitted this exact
      // round as a Session `user/message`, which is what consumes the budget.
      const admitted = await waitForHostSessionEvent(dshHome, sessionId,
        event => event.type === 'user/message' && event.data?.source?.kind === 'goal', 'goal round admitted', 120_000)
      assert(String(admitted.data.source.goalId) === created.goalId
          && admitted.data.source.revision === created.revision
          && admitted.data.source.round === round.round,
        `the durable goal round disagrees with the reservation: ${JSON.stringify(admitted.data.source)}`)
      // Then the driver ends the armed state at the round limit instead of
      // reserving another round: the recorded transition names the reason.
      const blocked = await waitForC1WorkEvent(workRoot, event => event.kind === 'goal-changed' && event.operation === 'block', 'goal round-limit block', 120_000)
      assert(String(blocked.goalId) === created.goalId && blocked.blockCode === 'round-limit' && blocked.goalPhase === 'blocked' && blocked.activation === 'disarmed',
        `the Goal did not leave the armed state at its round limit: ${JSON.stringify(blocked)}`)
      await exitC1Client(client, 'goal-round C1')
      await stopC1Host(host)
      trace('goal-round', {
        hostPid: ready.pid,
        sessionId,
        goalId: created.goalId,
        round: round.round,
        agentStatus: round.agentStatus,
        blockCode: blocked.blockCode,
      })
    }

    // Host liveness: Agent.runMaintenance() is really executing while the
    // public Agent status stays idle. The observer must not claim quiescence;
    // rc.4 has no synchronous maintenance getter, so UNKNOWN is correct.
    {
      const { host, ready, workRoot } = await startC1Host('maintenance', 'maintenance-sweep')
      const { client } = await startC1Client('maintenance C1')
      const sessionId = await openC1Session(client, 'maintenance prompt', 'maintenance')
      const maintenance = await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'running', 'maintenance running', 120_000)
      assert(maintenance.agentStatus === 'idle', `maintenance ran while the Agent was ${JSON.stringify(maintenance.agentStatus)}`)
      const maintenanceLiveness = (await hostStatus(host)).liveness
      assert(maintenanceLiveness?.verdict === 'UNKNOWN', `maintenance did not leave the Host UNKNOWN: ${JSON.stringify(maintenanceLiveness)}`)
      assert(maintenanceLiveness.verdict !== 'OBSERVED_QUIESCENT', 'maintenance was reported as quiescent')
      assert(maintenanceLiveness.reasons?.includes('agent-maintenance-unproven'), 'the maintenance gap is not reported')
      writeFileSync(join(workRoot, 'maintenance.release'), 'release\n', { mode: 0o600 })
      await waitForC1WorkEvent(workRoot, event => event.kind === 'maintenance' && event.phase === 'settled', 'maintenance settled', 120_000)
      await exitC1Client(client, 'maintenance C1')
      await stopC1Host(host)
      trace('maintenance-sweep', { hostPid: ready.pid, sessionId, agentStatus: maintenance.agentStatus, verdict: maintenanceLiveness.verdict })
    }

    // Host liveness: the Host-only profile mounts the ONE official Schedule row
    // (S5-PR4), so this scenario uses the DEFAULT composition — a test-only
    // second insert would be the duplicate owner the plan forbids. An active
    // task must block with zero Clients; deleting it must clear the
    // schedule-active contribution.
    {
      const { host, ready, workRoot } = await startC1Host('schedule', 'host-schedule')
      const scheduleRows = (ready.entries ?? []).filter(entry => entry.id === 'pi-tui-schedule')
      assert(scheduleRows.length === 1, `expected exactly one Schedule row, found ${scheduleRows.length}`)
      assert(scheduleRows[0].state === 'active', `the default Schedule row is not active: ${JSON.stringify(scheduleRows[0])}`)
      const { client } = await startC1Client('schedule C1')
      const sessionId = await openC1Session(client, 'schedule prompt', 'schedule')
      const created = await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-created' && event.status === 'active', 'schedule created', 120_000)
      await exitC1Client(client, 'schedule C1')
      const activeLiveness = (await hostStatus(host)).liveness
      assert(activeLiveness?.verdict === 'BLOCKED', `the active Schedule task did not block: ${JSON.stringify(activeLiveness)}`)
      assert(activeLiveness.reasons?.includes('schedule-active'), 'the active Schedule task did not contribute schedule-active')
      assert(activeLiveness.sourceStates?.schedule === 'ACTIVE', 'the schedule source is not ACTIVE')
      writeFileSync(join(workRoot, 'schedule.delete'), 'delete\n', { mode: 0o600 })
      await waitForC1WorkEvent(workRoot, event => event.kind === 'schedule-deleted' && event.deleted === true, 'schedule deleted', 120_000)
      const deletedLiveness = (await hostStatus(host)).liveness
      assert(!deletedLiveness.reasons?.includes('schedule-active'), `a deleted Schedule task left an active reason: ${JSON.stringify(deletedLiveness)}`)
      assert(deletedLiveness.sourceStates?.schedule === 'IDLE', `the schedule source did not return to IDLE: ${JSON.stringify(deletedLiveness.sourceStates)}`)
      await stopC1Host(host)
      trace('host-schedule', { hostPid: ready.pid, sessionId, scheduleId: created.scheduleId, activeVerdict: activeLiveness.verdict, deletedScheduleState: deletedLiveness.sourceStates.schedule })
    }

    // T48: a real continuable Child survives the Client exit; the Child
    // Session's own durable log carries its final assistant message.
    {
      const releaseBarrier = join(workDir, 't48-child.release')
      const { host, ready, workRoot } = await startC1Host('child', 't48', {
        C1_HOLD_CHILD: releaseBarrier,
      })
      const { client: c1 } = await startC1Client('T48 C1')
      const sessionId = await openC1Session(c1, 't48 prompt', 'T48')
      const started = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-start', 'T48 real subagent/start', 120_000)
      assert(typeof started.childId === 'string' && started.childId !== sessionId, 'T48 no distinct Child Agent identity')
      await waitForC1WorkEvent(workRoot, event => event.kind === 'child-stream-held' && event.sessionId === started.childId, 'T48 Child LLM stream held')
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      await c1.dispose()
      assert(alive(ready.pid), 'T48 the Host died on the Client SIGKILL')
      await assertHostIdentityKept(host, hostBefore, 'T48 Host after Client detach')
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      const ended = await waitForC1WorkEvent(workRoot, event => event.kind === 'subagent-end' && event.childId === started.childId, 'T48 real subagent/end', 120_000)
      assert(ended.runId === started.runId, 'T48 the subagent end does not pair the start run id')
      const childEvents = await (async () => {
        const deadline = Date.now() + 60_000
        while (Date.now() < deadline) {
          const events = hostSessionEvents(dshHome, started.childId)
          if (events !== undefined && hostAssistantHasText(events, 'child answer')) return events
          await sleep(50)
        }
        return undefined
      })()
      assert(childEvents !== undefined, 'T48 the Child Session durable log has no final assistant message')
      const { client: c2 } = await startC1Client('T48 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('child delegated', 'T48 C2 parent readback')
      await exitC1Client(c2, 'T48 C2')
      await stopC1Host(host)
      trace('t48', { hostPid: ready.pid, parentSessionId: sessionId, childId: started.childId, runId: started.runId, childDurable: true })
    }

    // rc.4 exposes no pending inventory: after a Client detaches, the Host
    // status must keep the pending source fail-closed as UNKNOWN with the
    // stable gap reason. This asserts only the absence of an inventory; it
    // never names a request id or claims an expiry outcome.
    const assertPendingUnobservable = async (host, before, label) => {
      const status = await hostStatus(host)
      assertIdentityFields(status.localHost, before, `${label} Host status identity`)
      const liveness = status.liveness
      assert(liveness?.sourceStates?.pending === 'UNKNOWN',
        `${label} the pending source is not UNKNOWN: ${JSON.stringify(liveness?.sourceStates)}`)
      assert(liveness.reasons?.includes('pending-interaction-unobservable'),
        `${label} the pending-interaction gap is not reported: ${JSON.stringify(liveness?.reasons)}`)
      assert(liveness.verdict !== 'OBSERVED_QUIESCENT',
        `${label} the Host claimed quiescence around an unobservable pending interaction`)
      return liveness
    }
    const startPeer = async (label, extraEnv = {}) => {
      const peer = new EntryProcess('peer', entries.client, {
        ...base,
        env: { ...base.env, SPLIT_PROCESS_CLIENT_MODE: 'peer', ...extraEnv },
      })
      const ready = await peer.waitFor(record => record.m4a0 === 'ready', `${label} peer ready`, 180_000)
      return { peer, ready }
    }

    // T49/T50: an official pending Question survives C1 SIGKILL and a clean
    // Client exit. C2 receives the ORIGINAL callId through the Host Gateway
    // and its answer settles the same Host flow exactly once.
    for (const [mode, label] of [['kill', 't49'], ['exit', 't50']]) {
      // B-03 eligibility control: the kill case drives the full real Gateway
      // owner-event-stream lifecycle (none -> C1 -> none -> C2 -> none) and
      // one non-answering Peer negative control. The clean-exit case keeps
      // the same question recovery without duplicating the eligibility trace.
      const eligibilityProbe = mode === 'kill'
      const nonAnsweringBarrier = join(workDir, 't49-non-answering-peer.probe')
      rmSync(nonAnsweringBarrier, { force: true })
      const { host, ready, workRoot } = await startC1Host('question', label, eligibilityProbe
        ? { C1_HAS_LIVE_CLIENT_PROBE: '1', C1_NON_ANSWERING_PEER_PROBE: nonAnsweringBarrier }
        : {})
      const waitLiveClient = (value, afterSequence, probeLabel) => waitForC1WorkEvent(
        workRoot,
        event => event.kind === 'has-live-client' && event.value === value && event.sequence > afterSequence,
        probeLabel,
      )
      let liveSequence = 0
      if (eligibilityProbe) {
        const initial = await waitLiveClient(false, liveSequence, 'T49 initial Gateway eligibility')
        liveSequence = initial.sequence
        writeFileSync(nonAnsweringBarrier, 'probe\n', { mode: 0o600 })
        const negative = await waitForC1WorkEvent(workRoot, event => event.kind === 'non-answering-peer', 'T49 non-answering Peer negative control')
        assert(negative.opened === false, 'T49 a non-answering Peer opened the forwarded-event stream')
        assert(negative.code === 'gateway/interactions-forbidden', `T49 unexpected non-answering Peer refusal: ${JSON.stringify(negative)}`)
        assert(negative.liveClient === false, 'T49 the non-answering Peer made hasLiveClient() true')
      }
      const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
      if (eligibilityProbe) {
        const attached = await waitLiveClient(true, liveSequence, 'T49 C1 Gateway eligibility')
        liveSequence = attached.sequence
      }
      const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
      const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', `${label} ask_user_question tool/call`)
      const callId = String(call.data.callId)
      const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, `${label} Host question request`)
      assert(request.questions?.[0]?.question === 'Continue the C1 test?', `${label} the Host question payload is wrong`)
      // The Host ask is pending AND the real C1 modal is painted before the
      // detach: otherwise the kill would race the first forwarded delivery
      // and could legitimately observe "no answerer" instead of a held question.
      await c1.waitForScreen('[1] Proceed', `${label} C1 question modal`, 120_000)
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      if (mode === 'kill') {
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
      } else {
        // SIGTERM is the clean detach path while a modal owns the editor
        // seat; typing /exit into a modal would be modal input, not exit.
        c1.signalBusiness('SIGTERM')
        const cleanExit = await c1.waitForExit(60_000)
        assert(cleanExit.code === 0 && cleanExit.signal === null, `${label} C1 clean exit was ${JSON.stringify(cleanExit)}`)
        await c1.dispose()
      }
      assert(alive(ready.pid), `${label} the Host died on the Client exit`)
      await assertHostIdentityKept(host, hostBefore, `${label} Host after Client exit`)
      if (eligibilityProbe) {
        const detached = await waitLiveClient(false, liveSequence, 'T49 detached Gateway eligibility')
        liveSequence = detached.sequence
      }
      await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
      // A clean Client teardown must not settle the Host question as
      // cancelled: no question-failed proof may appear before C2 answers.
      await sleep(300)
      assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'question-failed' && event.callId === callId)),
        `${label} the Client teardown sent a cancellation that settled the Host pending question`)
      const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      assertInteractionGate(c2, `${label} C2`)
      if (eligibilityProbe) {
        const recovered = await waitLiveClient(true, liveSequence, 'T49 C2 Gateway eligibility')
        liveSequence = recovered.sequence
      }
      await c2.waitForScreen('Continue the C1 test?', `${label} C2 redelivered question`, 120_000)
      c2.send('1')
      await c2.waitForScreen('Review your answer before submit', `${label} C2 review page`, 30_000)
      c2.send('\r')
      const settled = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, `${label} Host question settled`, 120_000)
      assert(settled.answers?.[0]?.selected?.[0] === 'Proceed', `${label} the Host received the wrong answer: ${JSON.stringify(settled.answers)}`)
      const result = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, `${label} question tool result`)
      assert(result.data?.message?.isError !== true, `${label} the question tool failed after a legal answer`)
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end after answer`)
      const requests = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-request' && event.sessionId === sessionId)
      const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
      assert(requests.length === 1 && settlements.length === 1, `${label} duplicate question request/settlement (${String(requests.length)}/${String(settlements.length)})`)
      await exitC1Client(c2, `${label} C2`)
      if (eligibilityProbe) {
        const final = await waitLiveClient(false, liveSequence, 'T49 final Gateway eligibility')
        liveSequence = final.sequence
      }
      await stopC1Host(host)
      trace(label, {
        hostPid: ready.pid,
        sessionId,
        callId,
        mode,
        c2Answer: 'Proceed',
        hostSettlements: settlements.length,
        ...(eligibilityProbe ? { gatewayEligibility: 'none>c1>none>c2>none', nonAnsweringPeer: 'refused' } : {}),
      })
    }

    // T51: after the original Client is gone, a legal new TUI answers the
    // SAME pending Question once; a reattached Client cannot resurrect it.
    // A separate test-only non-TUI answering Peer holds the OLD legal
    // delivery and submits its stale frame AFTER C2 settled. The Host must
    // ignore it: no second request, settlement or tool result.
    {
      let peer
      try {
        const { host, ready, workRoot } = await startC1Host('question', 't51')
        const { client: c1 } = await startC1Client('T51 C1')
        const sessionId = await openC1Session(c1, 't51 prompt', 'T51')
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T51 question tool/call')
        const callId = String(call.data.callId)
        await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T51 question pending')
        await c1.waitForScreen('[1] Proceed', 'T51 C1 question modal', 120_000)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        assert(alive(ready.pid), 'T51 the Host died on the Client SIGKILL')

        const startedPeer = await startPeer('T51 old peer')
        peer = startedPeer.peer
        await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'question', 'T51 old peer held the stale question delivery', 120_000)
        const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'user-questions/request', 'T51 old peer captured the official question frame', 120_000)
        assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
          'T51 the old question frame has no eventId')
        assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
          'T51 the old question frame has no clientId')

        const { client: c2 } = await startC1Client('T51 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, 'T51 C2')
        await c2.waitForScreen('Continue the C1 test?', 'T51 C2 question', 120_000)
        c2.send('1')
        await c2.waitForScreen('Review your answer before submit', 'T51 C2 review')
        c2.send('\r')
        await waitForC1WorkEvent(workRoot, event => event.kind === 'question-settled' && event.sessionId === sessionId, 'T51 answered')
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T51 turn/end')
        await exitC1Client(c2, 'T51 C2')

        // The old Peer's frame was issued BEFORE the Host settled the new
        // answer. Its `$events/result` must be ignored by the Host stale
        // delivery fence, never delegated into a second settlement.
        // The old legal frame is submitted through the official
        // `$events/result` RPC AFTER C2 settled. The Host must receive the
        // frame (RPC ok) and ignore it through the stale-delivery fence.
        peer.send({
          op: 'peer-send-stale-result',
          eventId: peerFrame.eventId,
          clientId: peerFrame.clientId,
          value: { kind: 'result', value: { answers: [{ id: 'c1-question', selected: ['Cancel'] }] } },
        })
        const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T51 stale peer frame sent to Host', 30_000)
        assert(staleSent.ok === true, 'T51 the Host did not receive the old question result frame')

        const { client: c3 } = await startC1Client('T51 C3', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        await c3.waitForScreen('question answered', 'T51 C3 settled transcript')
        await sleep(500)
        const viewport = (await c3.viewport()).join('\n')
        assert(!viewport.includes('Submit'), 'T51 a settled question card was resurrected as an answerable flow')
        const settlements = readC1WorkEvents(workRoot).filter(event => event.kind === 'question-settled' && event.sessionId === sessionId)
        const toolResults = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId)
        assert(settlements.length === 1 && toolResults.length === 1, 'T51 the settled question produced a second answer/result')
        await exitC1Client(c3, 'T51 C3')
        await stopC1Host(host)
        trace('t51', { hostPid: ready.pid, sessionId, callId, noResurrection: true, staleLegalFrameReplay: 'protocol-peer-negative', eventId: peerFrame.eventId, clientId: peerFrame.clientId })
      } finally {
        if (peer !== undefined) {
          await peer.shutdown().catch(() => {})
        }
      }
    }

    // T52: the official TIMED question becomes a durable `continued` entry.
    // C2 reopens it from the Task Quick projection, submits a late answer,
    // and the Host queues exactly one `user-question-reply` message. This is
    // the official askTimed()/continued lifetime, NOT a 30-minute orphan
    // expiry test.
    {
      const afterTimedBarrier = join(workDir, 't52-after-timed.release')
      const duplicateProbeBarrier = join(workDir, 't52-duplicate-probe.release')
      const expiredProbeBarrier = join(workDir, 't52-expired-probe.release')
      for (const barrier of [afterTimedBarrier, duplicateProbeBarrier, expiredProbeBarrier]) rmSync(barrier, { force: true })
      const { host, ready, workRoot } = await startC1Host('question', 't52', {
        C1_TIMED_QUESTION: '1',
        SPLIT_PROCESS_EXTRA_PATCH: c1Work.timedPatchPath,
        C1_HOLD_AFTER_TIMED: afterTimedBarrier,
        C1_ANSWER_PROBE_DUPLICATE: duplicateProbeBarrier,
        C1_ANSWER_PROBE_EXPIRED: expiredProbeBarrier,
      })
      const { client: c1 } = await startC1Client('T52 C1')
      const sessionId = await openC1Session(c1, 't52 prompt', 'T52')
      const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T52 timed question tool/call')
      const callId = String(call.data.callId)
      const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-request' && event.sessionId === sessionId, 'T52 timed question request')
      assert(request.timed === true, 'T52 the Host question was not the official timed form')
      // The C1 question UI owns the 1s foreground countdown; its official
      // ASK_TIMED_OUT rejection is what writes the pending tool result and
      // moves the durable projection to `continued`.
      await waitForC1WorkEvent(workRoot, event => event.kind === 'question-failed' && event.sessionId === sessionId, 'T52 timed foreground ended', 120_000)
      const projection = await waitForC1WorkEvent(workRoot, event => event.kind === 'question-projection' && event.callId === callId
        && Array.isArray(event.active) && event.active.some(item => item?.callId === callId && item?.state === 'continued'), 'T52 official continued projection', 120_000)
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === callId, 'T52 pending tool result', 120_000)
      await waitForC1WorkEvent(workRoot, event => event.kind === 'after-timed-held' && event.sessionId === sessionId, 'T52 Agent held after the timed question', 120_000)
      c1.signalBusiness('SIGTERM')
      const cleanExit = await c1.waitForExit(60_000)
      assert(cleanExit.code === 0 && cleanExit.signal === null, `T52 C1 clean exit was ${JSON.stringify(cleanExit)}`)
      await c1.dispose()

      const { client: c2 } = await startC1Client('T52 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      assertInteractionGate(c2, 'T52 C2')
      await c2.waitForScreen('t52 prompt', 'T52 C2 history')
      c2.send('\x1b[B')
      await c2.waitForScreen('Task Quick', 'T52 Task Quick opened', 60_000)
      await c2.waitForScreen('Continue the C1 test?', 'T52 continued row')
      c2.send('\r')
      c2.send('1')
      await c2.waitForScreen('Review your answer before submit', 'T52 continued form review', 60_000)
      // ONE final Enter from the painted review frame: the official
      // `answerContinued` result and the duplicate probe below prove the
      // queued classification, so a second Enter would only risk an
      // unrelated reply.
      c2.send('\r')
      // The C2 UI's `answerContinued` return is observable through the
      // controller's queued notice; the Host-side probe then calls the
      // official `ctx.userQuestions.answer` service while the Agent is
      // still held, proving the duplicate REPLY_QUEUED classification.
      await c2.waitFor(record => record.m4b2s === 'qualification' && record.op === 'question-answer-continued'
        && record.result === 'queued', 'T52 queued answer classification', 60_000)
      writeFileSync(duplicateProbeBarrier, 'release\n', { mode: 0o600 })
      const duplicate = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'duplicate', 'T52 duplicate continued answer probe', 60_000)
      assert(duplicate.code === 'REPLY_QUEUED', `T52 duplicate continued answer classification was ${JSON.stringify(duplicate)}`)

      writeFileSync(afterTimedBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T52 queued reply turn/end', 120_000)
      const replyDeadline = Date.now() + 60_000
      let queuedMessages = []
      while (Date.now() < replyDeadline) {
        queuedMessages = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'user/message'
          && JSON.stringify(event).includes('answer_to_pending_question')
          && JSON.stringify(event).includes(callId))
        if (queuedMessages.length > 0) break
        await sleep(50)
      }
      assert(queuedMessages.length === 1, `T52 expected exactly one durable queued reply, got ${String(queuedMessages.length)}`)
      const queuedSource = queuedMessages[0].data?.source
      assert(queuedSource?.kind === 'user-question-reply' && queuedSource?.callId === callId,
        `T52 the durable inbox source does not name the continued call: ${JSON.stringify(queuedSource)}`)

      writeFileSync(expiredProbeBarrier, 'release\n', { mode: 0o600 })
      const expired = await waitForC1WorkEvent(workRoot, event => event.kind === 'answer-probe' && event.phase === 'expired', 'T52 expired continued answer probe', 60_000)
      assert(expired.value === false, `T52 expired continued answer classification was ${JSON.stringify(expired)}`)
      await exitC1Client(c2, 'T52 C2')
      await stopC1Host(host)
      trace('t52', {
        hostPid: ready.pid,
        sessionId,
        callId,
        projectedState: projection.active.find(item => item?.callId === callId)?.state,
        continuedAnswer: 'queued',
        durableReplies: queuedMessages.length,
        duplicateAnswer: 'REPLY_QUEUED',
        expiredAnswer: 'not-continued',
      })
    }

    // T53/T54: an official Approval request survives the Client exit and a
    // fresh Client settles the SAME Host request exactly once. `allowed-once`
    // executes the harmless command; `rejected` never executes it.
    for (const [scenario, decision, expected, markerName] of [
      ['approval-allow', 'y', 'allowed-once', 'approval-allow.marker'],
      ['approval-reject', 'n', 'rejected', 'approval-reject.marker'],
    ]) {
      const label = scenario === 'approval-allow' ? 't53' : 't54'
      const { host, ready, workRoot } = await startC1Host(scenario, label)
      const { client: c1 } = await startC1Client(`${label.toUpperCase()} C1`)
      const sessionId = await openC1Session(c1, `${label} prompt`, label.toUpperCase())
      const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', `${label} approval/asked`, 120_000)
      const requestId = String(asked.data.id)
      const request = await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-request', `${label} Host approval request`)
      assert(request.toolName === 'bash', `${label} the approval is not for the official bash tool`)
      await c1.waitForScreen('[y] Allow once', `${label} C1 approval sheet`, 120_000)
      const hostBefore = await hostIdentityFacts(host)
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      await c1.dispose()
      assert(alive(ready.pid), `${label} the Host died on the Client SIGKILL`)
      await assertHostIdentityKept(host, hostBefore, `${label} Host after Client detach`)
      await assertPendingUnobservable(host, hostBefore, `${label} detached pending`)
      await sleep(300)
      assert(readC1WorkEvents(workRoot).every(event => !(event.kind === 'approval-settled')), `${label} the Client teardown settled the Host approval`)
      const { client: c2 } = await startC1Client(`${label.toUpperCase()} C2`, { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      assertInteractionGate(c2, `${label} C2`)
      await c2.waitForScreen(scenario === 'approval-allow' ? 'Allow once' : 'Reject', `${label} C2 approval sheet`, 120_000)
      c2.send(decision)
      const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, `${label} approval/decided`, 120_000)
      assert(decided.data.outcome === expected, `${label} approval outcome ${JSON.stringify(decided.data.outcome)} != ${expected}`)
      const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
      assert(decisions.length === 1, `${label} duplicated approval/decided`)
      const marker = join(workRoot, markerName)
      if (scenario === 'approval-allow') {
        await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'allowed-once', `${label} allowed-once`)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === String(request.callId), `${label} bash tool result`, 120_000)
        assert(existsSync(marker), `${label} the allowed harmless command did not execute`)
      } else {
        await waitForC1WorkEvent(workRoot, event => event.kind === 'approval-settled' && event.outcome === 'rejected', `${label} rejected`)
        assert(!existsSync(marker), `${label} the rejected harmless command executed`)
      }
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', `${label} turn/end`)
      await exitC1Client(c2, `${label} C2`)
      await stopC1Host(host)
      trace(label, { hostPid: ready.pid, sessionId, requestId, decision: expected, decisions: 1, marker: existsSync(marker) })
    }

    // T55a: an old, still-authenticated non-TUI Peer holds the original
    // approval delivery while the legal C2 rejects it. The old peer's late
    // `allowed-once` frame must not execute the tool or add a decision.
    {
      let peer
      try {
        const { host, ready, workRoot } = await startC1Host('approval-allow', 't55a')
        const { client: c1 } = await startC1Client('T55A C1')
        const sessionId = await openC1Session(c1, 't55a prompt', 'T55A')
        const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55a approval/asked', 120_000)
        const requestId = String(asked.data.id)
        await c1.waitForScreen('[y] Allow once', 'T55a C1 approval sheet', 120_000)
        const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
        c1.signalBusiness('SIGKILL')
        await waitGone(c1Pid, 15_000)
        await c1.dispose()
        const startedPeer = await startPeer('T55a old peer')
        peer = startedPeer.peer
        await peer.waitFor(record => record.m4a0 === 'peer-interaction' && record.kind === 'approval', 'T55a old peer held approval delivery', 120_000)
        const peerFrame = await peer.waitFor(record => record.m4a0 === 'peer-frame' && record.event === 'approval/request', 'T55a old peer captured the official approval frame', 120_000)
        assert(typeof peerFrame.eventId === 'string' && peerFrame.eventId.length > 0,
          'T55a the old approval frame has no eventId')
        assert(typeof peerFrame.clientId === 'string' && peerFrame.clientId.length > 0,
          'T55a the old approval frame has no clientId')
        const { client: c2 } = await startC1Client('T55A C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
        assertInteractionGate(c2, 'T55A C2')
        await c2.waitForScreen('Reject', 'T55a C2 approval sheet', 120_000)
        c2.send('n')
        const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55a approval/decided', 120_000)
        assert(decided.data.outcome === 'rejected', 'T55a the legal Client did not reject the approval')
        peer.send({
          op: 'peer-send-stale-result',
          eventId: peerFrame.eventId,
          clientId: peerFrame.clientId,
          value: { kind: 'result', value: 'allowed-once' },
        })
        const staleSent = await peer.waitFor(record => record.m4a0 === 'peer-stale-result-sent' && record.eventId === peerFrame.eventId, 'T55a stale approval frame sent to Host', 30_000)
        assert(staleSent.ok === true, 'T55a the Host did not receive the old approval result frame')
        const decisions = (hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId)
        assert(decisions.length === 1 && decisions[0].data.outcome === 'rejected', 'T55a the stale old-peer allow produced a second decision')
        assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55a the stale old-peer allow executed the tool')
        await exitC1Client(c2, 'T55A C2')
        await stopC1Host(host)
        trace('t55a', { hostPid: ready.pid, sessionId, requestId, oldPeerHeld: true, staleAllow: 'ignored', decisions: 1, marker: false, eventId: peerFrame.eventId, clientId: peerFrame.clientId })
      } finally {
        if (peer !== undefined) {
          await peer.shutdown().catch(() => {})
        }
      }
    }

    // T55b: a formal Host Agent cancel while the approval is pending must
    // settle the request as the official cancellation taxonomy; a late `y`
    // must not execute the marker.
    {
      const cancelBarrier = join(workDir, 't55b-cancel.release')
      const { host, ready, workRoot } = await startC1Host('approval-allow', 't55b', { C1_CANCEL_AGENT: cancelBarrier })
      const { client } = await startC1Client('T55B C1')
      const sessionId = await openC1Session(client, 't55b prompt', 'T55B')
      const asked = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55b approval/asked', 120_000)
      const requestId = String(asked.data.id)
      await client.waitForScreen('[y] Allow once', 'T55b approval sheet', 120_000)
      writeFileSync(cancelBarrier, 'cancel\n', { mode: 0o600 })
      await waitForC1WorkEvent(workRoot, event => event.kind === 'agent-cancel-requested', 'T55b Host Agent cancel', 60_000)
      const decided = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided' && String(event.data?.id) === requestId, 'T55b approval/decided', 120_000)
      assert(decided.data.outcome !== 'allowed-once', `T55b Host abort settled as allowed-once: ${JSON.stringify(decided.data)}`)
      assert(decided.data.outcome === 'cancelled', `T55b unexpected Host abort taxonomy: ${JSON.stringify(decided.data.outcome)}`)
      client.send('y')
      await sleep(500)
      assert(!existsSync(join(workRoot, 'approval-allow.marker')), 'T55b a late y executed the command after Host abort')
      assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided' && String(event.data?.id) === requestId).length === 1,
        'T55b the Host abort produced a duplicate approval/decided')
      // The late `y` landed in the editor after the approval sheet was
      // withdrawn; clear it so the normal `/exit` is still a command.
      client.send('\x15')
      await exitC1Client(client, 'T55B C1')
      await stopC1Host(host)
      trace('t55b', { hostPid: ready.pid, sessionId, requestId, hostAbortTaxonomy: decided.data.outcome, lateAllowExecuted: false })
    }

    // T55c: same-PID HMR while a pending Question/Approval owns the modal.
    // The root delivery survives the revision swap; the new surface shows
    // the SAME Host pending and only the new surface's answer settles it.
    for (const [kind, scenario, label, confirmText, answer, expectedCount] of [
      ['question', 'question', 't55c-question', 'Continue the C1 test?', '1', 1],
      ['approval', 'approval-allow', 't55c-approval', '[y] Allow once', 'y', 1],
    ]) {
      const { host, ready, workRoot } = await startC1Host(scenario, label)
      const { client } = await startC1Client(`${label} Client`, { SPLIT_PROCESS_CLIENT_HMR_PROBE: '1' })
      const sessionId = await openC1Session(client, `${label} prompt`, label.toUpperCase())
      // The Host `tool/call` is the official callId authority; the question
      // witnesses below must all name THIS one invocation.
      let questionCallId
      if (kind === 'question') {
        const call = await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'tool/call' && event.data?.name === 'ask_user_question', 'T55c question tool/call')
        questionCallId = String(call.data.callId)
        await client.waitForScreen(confirmText, 'T55c C1 question modal', 120_000)
      } else {
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/asked', 'T55c approval/asked', 120_000)
        await client.waitForScreen(confirmText, 'T55c C1 approval sheet', 120_000)
      }
      const before = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.sessionOpen === true, 'T55c initial surface')
      client.signalBusiness('SIGUSR2')
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-start', 'T55c HMR start', 60_000)
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-retired', 'T55c HMR retired', 120_000)
      await client.waitFor(record => record.m4b2s === 'qualification' && record.op === 'hmr-revision-ready', 'T55c HMR ready', 180_000)
      const after = await waitForSurfaceStatus(client, record => record.surfaceMounted === true && record.surfaceRevision !== before.surfaceRevision, 'T55c new surface')
      assert(after.pid === before.pid && after.generationId === before.generationId, 'T55c HMR changed the Client PID or Connection generation')
      assert(client.records.filter(record => record.m4b2s === 'qualification' && record.op === 'interaction-startup-gate').length === 1,
        'T55c HMR duplicated the root interaction startup gate')
      await client.waitForScreen(confirmText, 'T55c new surface shows the same Host pending', 120_000)
      if (kind === 'question') {
        client.send(answer)
        await client.waitForScreen('Review your answer before submit', 'T55c question review', 30_000)
        client.send('\r')
        // The official non-timed `ask()` attaches no `wait`, so its waterfall
        // request — and therefore the fixture's request/settlement records —
        // carries no callId; only a timed ask does (T52). The durable
        // `tool/call` -> `tool/result` pair below is the callId-exact
        // authority, while the settlement must carry the new surface's answer
        // exactly once with no failed alternative.
        const settled = await waitForC1WorkEvent(workRoot,
          event => event.kind === 'question-settled' && event.sessionId === sessionId,
          'T55c question settled', 120_000)
        assert(settled.answers?.[0]?.selected?.[0] === 'Proceed',
          `T55c the new surface submitted the wrong answer: ${JSON.stringify(settled.answers)}`)
        const questionEvents = readC1WorkEvents(workRoot).filter(event => event.sessionId === sessionId)
        assert(questionEvents.filter(event => event.kind === 'question-request').length === 1,
          'T55c HMR replayed the Host question request')
        assert(questionEvents.filter(event => event.kind === 'question-settled').length === 1
          && questionEvents.every(event => event.kind !== 'question-failed'),
          'T55c the Host pending was not settled exactly once for this session')
        const result = await waitForHostSessionEvent(dshHome, sessionId,
          event => event.type === 'tool/result' && String(event.data?.message?.toolCallId) === questionCallId,
          'T55c question tool result', 120_000)
        assert(result.data?.message?.isError !== true, 'T55c the answered question failed at the Host')
      } else {
        client.send(answer)
        await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'approval/decided', 'T55c approval/decided', 120_000)
        assert(existsSync(join(workRoot, 'approval-allow.marker')), 'T55c the new surface allow did not execute once')
        assert((hostSessionEvents(dshHome, sessionId) ?? []).filter(event => event.type === 'approval/decided').length === expectedCount,
          'T55c HMR duplicated the approval decision')
      }
      await exitC1Client(client, `${label} Client`)
      await stopC1Host(host)
      trace(label, { hostPid: ready.pid, sessionId, samePid: true, sameGeneration: true, pendingReattached: true })
    }

    // T56: a new Client is a fresh Peer/binding; it reads the exact history
    // once and a new prompt appends live without duplication.
    {
      const releaseBarrier = join(workDir, 't56-long-turn.release')
      const rebuilt = await startC1Host('long-turn', 't56', { C1_HOLD_LONG_TURN: releaseBarrier })
      const { client: c1 } = await startC1Client('T56 C1b')
      const sessionId = await openC1Session(c1, 't56 first', 'T56')
      await waitForC1WorkEvent(rebuilt.workRoot, event => event.kind === 'long-turn-held' && event.sessionId === sessionId, 'T56 first held')
      const c1Pid = c1.records.find(record => record.m4a0 === 'ready')?.pid
      c1.signalBusiness('SIGKILL')
      await waitGone(c1Pid, 15_000)
      await c1.dispose()
      writeFileSync(releaseBarrier, 'release\n', { mode: 0o600 })
      await waitForHostSessionEvent(dshHome, sessionId, event => event.type === 'turn/end', 'T56 first turn end')
      const { client: c2 } = await startC1Client('T56 C2', { SPLIT_PROCESS_CLIENT_SESSION: sessionId })
      await c2.waitForScreen('t56 first', 'T56 C2 history')
      c2.send('t56 second\r')
      await c2.waitForScreen('long-turn answer 2', 'T56 C2 live append', 120_000)
      const users = hostUserTexts(hostSessionEvents(dshHome, sessionId) ?? [])
      assert(users.filter(text => text.startsWith('t56 first')).length === 1
        && users.filter(text => text.includes('t56 second')).length === 1,
      `T56 history duplication: ${JSON.stringify(users.map(text => text.slice(0, 80)))}`)
      await exitC1Client(c2, 'T56 C2')
      await stopC1Host(rebuilt.host)
      trace('t56', { hostPid: rebuilt.ready.pid, sessionId, historyOnce: true, liveAppend: true })
    }
  } finally {
    await scene.dispose()
  }
}
