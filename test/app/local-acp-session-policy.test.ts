/**
 * Session policy facade contract: the official retained PlanModeController and
 * root Agent Team boolean are read from their real authority, every write goes
 * through ONE official maintenance admission, and no successful classification
 * is fabricated from a queue/cancel/throw.
 *
 * Evidence level: L1 (semantic owner contract) over a structural authority
 * fake. The real Host composition is proved by the Host access and packed
 * split-process tests.
 */

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  AcpSessionPolicyError,
  AcpSessionPolicyService,
  sessionModeStateOf,
  modeConfigOptionOf,
  agentTeamConfigOptionOf,
  type AcpAgentTeamService,
  type AcpPlanModeService,
  type AcpSessionPolicyAgent,
  type AcpSessionPolicyAuthority,
} from '../../src/app/remote-process/local-acp-session-policy.ts'

interface ModeState {
  active: boolean
  pending?: boolean
}

class FakeModeService implements AcpPlanModeService {
  state: ModeState
  readonly setCalls: boolean[] = []
  setImpl: (active: boolean) => 'committed' | 'queued' | 'cancelled' | 'noop' = active => {
    this.state = { active }
    return 'committed'
  }

  constructor(state: ModeState) {
    this.state = state
  }

  get(): ModeState {
    return { ...this.state }
  }

  set(_agent: object, active: boolean): 'committed' | 'queued' | 'cancelled' | 'noop' {
    this.setCalls.push(active)
    return this.setImpl(active)
  }
}

class FakeTeamService implements AcpAgentTeamService {
  readonly setCalls: Array<{ readonly enabled: boolean; readonly signal?: AbortSignal }> = []
  setImpl: (enabled: boolean, signal?: AbortSignal) => Promise<void> = async () => {}

  async setEnabled(_agent: object, enabled: boolean, signal?: AbortSignal): Promise<void> {
    this.setCalls.push({ enabled, ...(signal === undefined ? {} : { signal }) })
    await this.setImpl(enabled, signal)
  }
}

class FakeAgent implements AcpSessionPolicyAgent {
  readonly id = 'S-policy'
  readonly session = { id: 'S-policy' }
  readonly status: 'idle' | 'running' = 'idle'
  maintenanceBusy = false
  /** One synchronous side effect that races the maintenance admission. */
  beforeTask?: () => void
  readonly maintenanceSignals: AbortSignal[] = []

  async runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.maintenanceBusy) throw new Error('maintenance busy')
    const controller = new AbortController()
    this.maintenanceSignals.push(controller.signal)
    this.beforeTask?.()
    this.beforeTask = undefined
    return await task(controller.signal)
  }
}

interface FakeWorldOptions {
  readonly mode?: FakeModeService
  readonly team?: FakeTeamService
  readonly teamEnabled?: boolean | undefined
  readonly root?: boolean
  readonly openTurn?: boolean
  readonly projectionMalformed?: boolean
}

function makeWorld(options: FakeWorldOptions = {}): {
  readonly service: AcpSessionPolicyService
  readonly agent: FakeAgent
  readonly mode?: FakeModeService
  readonly team?: FakeTeamService
  readonly authority: AcpSessionPolicyAuthority
} {
  const agent = new FakeAgent()
  let enabled = options.teamEnabled
  const authority: AcpSessionPolicyAuthority = {
    currentAgent: sessionId => sessionId === agent.id ? agent : undefined,
    currentSession: sessionId => sessionId === agent.id ? agent.session : undefined,
    planMode: () => options.mode,
    team: () => options.team === undefined || options.root === false ? undefined : options.team,
    teamEnabled: () => {
      if (options.projectionMalformed === true) return 'yes' as never
      return enabled
    },
    noOpenTurn: () => options.openTurn !== true,
  }
  return {
    service: new AcpSessionPolicyService(authority),
    agent,
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.team === undefined ? {} : { team: options.team }),
    authority,
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof AcpSessionPolicyError ? error.code : undefined
}

describe('session policy read', () => {
  test('a committed plan mode reads from the retained official controller, pending never changes it', () => {
    const mode = new FakeModeService({ active: true, pending: false })
    const world = makeWorld({ mode })
    assert.deepEqual(world.service.read(world.agent), { mode: 'plan' })
    mode.state = { active: false, pending: true }
    assert.deepEqual(world.service.read(world.agent), { mode: 'default' })
  })

  test('an absent official mode/Team service is a capability absence, never a fabricated default', () => {
    const world = makeWorld()
    assert.deepEqual(world.service.read(world.agent), {})
  })

  test('root Agent Team reads the official projection boolean and a task failure does not negate it', () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: true })
    assert.deepEqual(world.service.read(world.agent), { agentTeam: true })
  })

  test('a child Session carries no Agent Team row and cannot write it', async () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: true, root: false })
    assert.deepEqual(world.service.read(world.agent), {})
    await assert.rejects(
      world.service.select(world.agent, { kind: 'agent-team', enabled: true }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_UNAVAILABLE',
    )
    assert.equal(team.setCalls.length, 0)
  })

  test('malformed official state is unavailable, never a default or absence', () => {
    const mode = new FakeModeService({ active: true })
    mode.get = () => ({ active: 'yes' } as never)
    const world = makeWorld({ mode })
    assert.throws(() => world.service.read(world.agent), error => codeOf(error) === 'LOCAL_ACP_CONFIG_UNAVAILABLE')
  })

  test('a malformed Agent Team projection is unavailable, never false', () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: true, projectionMalformed: true })
    assert.throws(() => world.service.read(world.agent), error => codeOf(error) === 'LOCAL_ACP_CONFIG_UNAVAILABLE')
  })
})

describe('session policy write admission', () => {
  test('a missing official mode authority is refused before any write', async () => {
    const world = makeWorld()
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_UNAVAILABLE',
    )
  })

  test('an official pending selection refuses the write without calling set', async () => {
    const mode = new FakeModeService({ active: false, pending: true })
    const world = makeWorld({ mode })
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_AGENT_BUSY',
    )
    assert.equal(mode.setCalls.length, 0)
  })

  test('a busy official maintenance admission refuses with zero setter calls', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode })
    world.agent.maintenanceBusy = true
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_AGENT_BUSY',
    )
    assert.equal(mode.setCalls.length, 0)
  })

  test('an open turn inside the maintenance callback refuses with zero setter calls', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode, openTurn: true })
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_AGENT_BUSY',
    )
    assert.equal(mode.setCalls.length, 0)
  })

  test('a stale View claim or replaced Agent refuses before the official call', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode })
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'stale'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_STALE',
    )
    assert.equal(mode.setCalls.length, 0)

    const replaced = new FakeAgent()
    const authority: AcpSessionPolicyAuthority = {
      currentAgent: sessionId => sessionId === replaced.id ? replaced : undefined,
      currentSession: () => replaced.session,
      planMode: () => mode,
      team: () => undefined,
      teamEnabled: () => undefined,
      noOpenTurn: () => true,
    }
    const service = new AcpSessionPolicyService(authority)
    await assert.rejects(
      service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_STALE',
    )
    assert.equal(mode.setCalls.length, 0)
  })

  test('a baseline change during admission is a conflict, not a second write', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode })
    world.agent.beforeTask = () => { mode.state = { active: true } }
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_CONFLICT',
    )
    assert.equal(mode.setCalls.length, 0)
  })
})

describe('session policy write settlement', () => {
  test('mode set is called once and the committed readback is returned', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode })
    const result = await world.service.select(
      world.agent,
      { kind: 'mode', mode: 'plan' },
      new AbortController().signal,
      () => 'current',
    )
    assert.deepEqual(mode.setCalls, [true])
    assert.deepEqual(result, { mode: 'plan' })
    assert.deepEqual(world.service.read(world.agent), { mode: 'plan' })
  })

  test('selecting the already committed mode still invokes the official setter', async () => {
    const mode = new FakeModeService({ active: true })
    mode.setImpl = () => 'noop'
    const world = makeWorld({ mode })
    await world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current')
    assert.deepEqual(mode.setCalls, [true])
  })

  test('a queued/cancelled official outcome is an indeterminate write, never a success', async () => {
    const mode = new FakeModeService({ active: false })
    mode.setImpl = active => {
      mode.state = { active: !active, pending: active }
      return 'queued'
    }
    const world = makeWorld({ mode })
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
    )
    assert.equal(mode.setCalls.length, 1)
  })

  test('a throw after the official append stays indeterminate and keeps the real committed state', async () => {
    const mode = new FakeModeService({ active: false })
    mode.setImpl = active => {
      mode.state = { active }
      throw new Error('inject failed after append')
    }
    const world = makeWorld({ mode })
    await assert.rejects(
      world.service.select(world.agent, { kind: 'mode', mode: 'plan' }, new AbortController().signal, () => 'current'),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
    )
    assert.equal(mode.setCalls.length, 1)
    assert.deepEqual(world.service.read(world.agent), { mode: 'plan' })
  })

  test('Agent Team is called even for the same value and a flush rejection stays indeterminate while the commit stands', async () => {
    const team = new FakeTeamService()
    let enabled = true
    const world = makeWorld({ team, teamEnabled: enabled })
    team.setImpl = async value => {
      enabled = value
      throw new Error('flush rejected after append')
    }
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'agent-team', enabled: true },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
    )
    assert.deepEqual(team.setCalls.map(call => call.enabled), [true])
    assert.equal(world.service.read(world.agent).agentTeam, true)
  })

  test('a committed mode whose post-write readback fails is READBACK_UNAVAILABLE, not indeterminate', async () => {
    const mode = new FakeModeService({ active: false })
    mode.setImpl = active => {
      mode.state = { active }
      return 'committed'
    }
    mode.get = () => {
      if (mode.setCalls.length > 0) throw new Error('official projection temporarily unavailable')
      return { ...mode.state }
    }
    const world = makeWorld({ mode })
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'mode', mode: 'plan' },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_READBACK_UNAVAILABLE',
    )
    assert.deepEqual(mode.setCalls, [true], 'the setter still ran exactly once')
  })

  test('an identity change after a committed mode write stays STALE, never readback-unavailable', async () => {
    const mode = new FakeModeService({ active: false })
    const world = makeWorld({ mode })
    const original = world.authority.currentAgent
    let changed = false
    world.authority.currentAgent = sessionId => changed ? undefined : original(sessionId)
    mode.setImpl = active => {
      mode.state = { active }
      changed = true
      return 'committed'
    }
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'mode', mode: 'plan' },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_STALE',
    )
  })

  test('an identity change after a completed Team write stays STALE, never readback-unavailable', async () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: true })
    const original = world.authority.currentAgent
    let changed = false
    world.authority.currentAgent = sessionId => changed ? undefined : original(sessionId)
    team.setImpl = async () => {
      changed = true
    }
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'agent-team', enabled: true },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_STALE',
    )
  })

  test('a completed Team write whose post-write readback fails is READBACK_UNAVAILABLE, not indeterminate', async () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: false })
    const original = world.authority.teamEnabled
    world.authority.teamEnabled = session => {
      if (team.setCalls.length > 0) throw new Error('official Agent Team projection temporarily unavailable')
      return original(session)
    }
    team.setImpl = async () => {}
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'agent-team', enabled: true },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_READBACK_UNAVAILABLE',
    )
    assert.deepEqual(team.setCalls.map(call => call.enabled), [true], 'the official setter still ran exactly once')
  })

  test('a Team readback different from the request is indeterminate', async () => {
    const team = new FakeTeamService()
    const world = makeWorld({ team, teamEnabled: false })
    team.setImpl = async () => {}
    await assert.rejects(
      world.service.select(
        world.agent,
        { kind: 'agent-team', enabled: true },
        new AbortController().signal,
        () => 'current',
      ),
      error => codeOf(error) === 'LOCAL_ACP_CONFIG_WRITE_INDETERMINATE',
    )
  })
})

describe('session policy wire projection', () => {
  test('the legacy mode state and the mode row come from the same fixed definition', () => {
    const state = sessionModeStateOf({ mode: 'plan' })
    assert.equal(state?.currentModeId, 'plan')
    assert.deepEqual(state?.availableModes.map(mode => mode.id), ['default', 'plan'])
    const row = modeConfigOptionOf({ mode: 'plan' })
    assert.equal(row?.id, 'mode')
    assert.equal(row?.category, 'mode')
    assert.equal((row as { currentValue?: string }).currentValue, 'plan')
    assert.deepEqual(((row as { options?: Array<{ value: string }> } | undefined)?.options ?? []).map(option => option.value), ['default', 'plan'])
  })

  test('the Agent Team row exists only for a readable boolean and a negotiated capability', () => {
    assert.equal(agentTeamConfigOptionOf({ agentTeam: true }, false), undefined)
    assert.equal(agentTeamConfigOptionOf({}, true), undefined)
    const row = agentTeamConfigOptionOf({ agentTeam: false }, true)
    assert.equal(row?.id, 'agent_team')
    assert.equal(row?.type, 'boolean')
    assert.equal((row as { currentValue?: boolean }).currentValue, false)
    assert.equal(row?.category, undefined, 'the row must not misuse a reserved category')
  })
})
