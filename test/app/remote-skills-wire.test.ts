/**
 * The private `piTuiSkills` L5 real-wire suite (M6-1 F6): the PRODUCTION Host
 * service (`app/host/features/skills.ts`), the PRODUCTION Client contribution
 * and the real in-process Typert carrier — no test-local endpoint and no fake
 * Gateway.
 *
 * ```text
 * real Host Workspace registry + official Skills registry
 *   -> PiTuiSkillsHostService.standing()/watchInvalidations()
 *   -> gateway wire (unary + stream, ONE package contribution)
 *   -> generated Client remote.piTuiSkills
 * ```
 *
 * FIXTURE MANIFEST
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the real rc.2 Host Context of `createRemoteApplicationHostFixture` with the
 *   real Workspace registry, the real Skill registry and the built-in PiTui
 *   Host Runtime (ONE contribution + services)
 * - `createRemoteHostRuntime(host.ctx)` adds only the official additive Host
 *   rows; `createRemoteClientRuntime({ carrier })` mounts the production Client
 *
 * TEST STAND-INS / SUBSTITUTIONS
 * - the workspace is created through the REAL official registry in the fixture
 *   work root (a real canonical Host path)
 * - the skills are registered through the official `skills.register()` runtime
 *   contribution (a real registry entry, no filesystem provider); the
 *   invalidation event is emitted on the real Host Context exactly as the
 *   filesystem provider's `invalidate()` dispatches it. The real
 *   filesystem-provider add/edit/delete → `skills/change` chain is the
 *   split-process `skills` suite (L6).
 *
 * DELIBERATELY ABSENT
 * - a second Host, a second contribution, a fake Gateway or a Client scan
 *
 * @module @xmoon76/dsh-pi-tui/remote-skills-wire.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { createRemoteClientRuntime, type RemoteClientRuntime } from '../support/m3-inprocess/client-runtime.ts'
import { createRemoteHostRuntime, type RemoteHostRuntime } from '../support/m3-inprocess/host-runtime.ts'
import {
  PI_TUI_SKILLS_STANDING,
  PI_TUI_SKILLS_WATCH_INVALIDATIONS,
  parsePiTuiSkillsInvalidationFrame,
  parsePiTuiSkillsStandingResult,
} from '../../src/runtime/remote/pi-tui-skills-contract.ts'
import { createRemoteApplicationHostFixture, waitFor } from '../support/remote-application-fixture.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

interface SkillsWire {
  readonly host: Awaited<ReturnType<typeof createRemoteApplicationHostFixture>>
  readonly hostRuntime: RemoteHostRuntime
  readonly client: RemoteClientRuntime
  /** The raw production Host service (unwrapped from the Cordis proxy). */
  readonly hostService: {
    readonly activeWakes: Set<unknown>
  }
  readonly workspaceId: string
  readonly dispose: () => Promise<void>
}

/** A real registered runtime skill on the Host registry. */
const WIRE_SKILL = 'wire-standing-skill'

async function mountSkillsWire(life: TestLifecycle, presetId: string): Promise<SkillsWire> {
  const host = await createRemoteApplicationHostFixture(life, presetId)
  const hostRuntime = await createRemoteHostRuntime(host.ctx)
  const client = await createRemoteClientRuntime({ carrier: hostRuntime.carrier })
  const workspace = await host.ctx.workspaceRegistry.create(host.anchorDir)
  const workspaceId = String(workspace.id)
  const skills = (host.ctx as unknown as {
    skills: {
      register(skill: Record<string, unknown>): () => void
    }
  }).skills
  skills.register({
    name: WIRE_SKILL,
    description: 'A real Host registry skill',
    content: '# body that must never cross the wire',
    source: 'runtime',
    invocation: { userInvocable: true, modelInvocable: true },
  })
  const proxied = host.ctx.reflect.get('piTuiSkills') as { readonly [symbols.original]?: unknown }
  const hostService = (proxied[symbols.original] ?? proxied) as unknown as SkillsWire['hostService']
  let disposed = false
  return {
    host,
    hostRuntime,
    client,
    hostService,
    workspaceId,
    dispose: async () => {
      if (disposed) return
      disposed = true
      await client.dispose()
      await hostRuntime.dispose()
      await host.dispose()
    },
  }
}

test('the ONE contribution serves the strict private Skills endpoints over the real authenticated wire', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountSkillsWire(life, 'f6-wire-skills')
  try {
    const local = wire.host.ctx.typert.local
    assert.equal(local.get('piTuiSkills/standing')?.id, PI_TUI_SKILLS_STANDING.id)
    assert.equal(local.get('piTuiSkills/watchInvalidations')?.id, PI_TUI_SKILLS_WATCH_INVALIDATIONS.id)
    const proxied = wire.host.ctx.reflect.get('piTuiSkills') as {
      readonly [symbols.original]?: {
        readonly typertRemote?: { readonly serviceKey?: string; readonly namespace?: string }
      }
    }
    const binding = (proxied[symbols.original] ?? proxied as never).typertRemote
    assert.equal(binding?.serviceKey, 'piTuiSkills')
    assert.equal(binding?.namespace, 'piTuiSkills')
    // The generated Client mounted the SAME private namespace (identity, not a
    // spread copy).
    const mounted = wire.client.remote as unknown as { readonly piTuiSkills?: object }
    assert.notEqual(mounted.piTuiSkills, undefined)
  } finally {
    await wire.dispose()
  }
})

test('a real Host Workspace standing read returns only human skill metadata with a complete observation', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountSkillsWire(life, 'f6-wire-standing')
  try {
    const controller = new AbortController()
    const result = await wire.client.remote.piTuiSkills.standing(
      { workspaceId: wire.workspaceId, presetId: 'f6-wire-standing' },
      controller.signal,
    )
    assert.equal(result.ok, true, `the standing read must succeed: ${JSON.stringify(result)}`)
    if (!result.ok) return
    const value = parsePiTuiSkillsStandingResult(result.value)
    assert.equal(value.complete, true)
    const skill = value.skills.find(entry => entry.name === WIRE_SKILL)
    assert.deepEqual(skill, {
      name: WIRE_SKILL,
      description: 'A real Host registry skill',
      modelInvocable: true,
    }, 'only name/description/whenToUse/modelInvocable cross the wire')
    const serialized = JSON.stringify(value)
    assert.equal(serialized.includes('# body that must never cross the wire'), false)
    assert.equal(serialized.includes('anchorDir'), false)
    assert.equal(serialized.includes(wire.host.anchorDir), false, 'no Host path crosses the wire')
  } finally {
    await wire.dispose()
  }
})

test('an unknown Host WorkspaceId is refused over the wire instead of returning an empty catalog', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountSkillsWire(life, 'f6-wire-unknown')
  try {
    const result = await wire.client.remote.piTuiSkills.standing(
      { workspaceId: 'ws-does-not-exist' },
      new AbortController().signal,
    )
    assert.equal(result.ok, false)
    if (result.ok) return
    const error = result.error as { readonly code?: string; readonly message?: string }
    assert.equal(error.code, 'gateway/internal')
    assert.match(String(error.message), /workspace is unavailable/)
  } finally {
    await wire.dispose()
  }
})

test('the Host startup invalidation frame and a Host skills/change both reach the Client stream', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountSkillsWire(life, 'f6-wire-watch')
  try {
    const controller = new AbortController()
    const handle = wire.client.remote.piTuiSkills.watchInvalidations(controller.signal)
    const iterator = handle[Symbol.asyncIterator]()
    try {
      const opening = await iterator.next()
      assert.equal(opening.done, false)
      assert.deepEqual(parsePiTuiSkillsInvalidationFrame(opening.value), { kind: 'invalidated' })
      await waitFor('the Host stream subscription', () => wire.hostService.activeWakes.size === 1, 10_000)
      wire.host.ctx.emit('skills/change')
      const next = await iterator.next()
      assert.equal(next.done, false)
      assert.deepEqual(parsePiTuiSkillsInvalidationFrame(next.value), { kind: 'invalidated' })
      handle.dispose()
      await waitFor('the Host stream release', () => wire.hostService.activeWakes.size === 0, 10_000)
    } finally {
      handle.dispose()
    }
  } finally {
    await wire.dispose()
  }
})

test('a Client stream cancellation releases the Host listener instead of accumulating watchers', async (t) => {
  const life = testLifecycle(t)
  const wire = await mountSkillsWire(life, 'f6-wire-dispose')
  const handle = wire.client.remote.piTuiSkills.watchInvalidations(new AbortController().signal)
  const iterator = handle[Symbol.asyncIterator]()
  await iterator.next()
  await waitFor('the Host stream subscription', () => wire.hostService.activeWakes.size === 1, 10_000)
  handle.dispose()
  await waitFor('the Host stream release', () => wire.hostService.activeWakes.size === 0, 10_000)
  const ended = await iterator.next()
  assert.equal(ended.done, true)
  // A replacement subscription starts clean: one live Host listener, never two.
  const replacement = wire.client.remote.piTuiSkills.watchInvalidations(new AbortController().signal)
  const replacementIterator = replacement[Symbol.asyncIterator]()
  await replacementIterator.next()
  await waitFor('the replacement Host stream subscription', () => wire.hostService.activeWakes.size === 1, 10_000)
  replacement.dispose()
  await wire.dispose()
})
