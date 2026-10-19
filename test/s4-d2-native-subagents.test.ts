/**
 * S4-D2 B13/B14 — on-demand Claude Code / Codex provider boundaries over the
 * real rc.2 Optional packages (implementation plan §5 D2-6).
 *
 * The default path is OFFLINE and truthfully EXTERNAL_UNVERIFIED: the real
 * published package is installed into the profile, the official one-shot tool
 * row mounts, and the real native start either produces a genuine failure
 * (missing auth / unsupported platform) or a genuine success. A scripted or
 * mocked native success is never accepted.
 * @module @xmoon76/dsh-pi-tui/s4-d2-native-subagents.test
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import {
  skippedInstallationReason,
  startS4D2Host,
  type S4D2BundleId,
} from './support/s4-d2-optional-bundle-fixture.ts'

const B13 = '@deepseek-ai/dsh-subagent-claude-code' satisfies S4D2BundleId
const B14 = '@deepseek-ai/dsh-subagent-codex' satisfies S4D2BundleId
const skip = skippedInstallationReason([B13, B14])
/** Native process starts are opt-in: the default suite NEVER launches a native
 *  provider (so `pnpm test` cannot read a real credential tree or run a paid
 *  external task). The fixture still isolates HOME/DSH_HOME/XDG when admitted. */
const NATIVE_ADMITTED = process.env.DSH_PI_TUI_S4_D2_NATIVE === '1'

const nativeEvidence: Array<{ provider: string; status: string }> = []

/** Observe the parent's real settle/failure notice for one external child. */
async function observeSettle(agent: { session: { snapshotEvents(): readonly unknown[] } }, childId: string, timeoutMs: number): Promise<{ kind: 'success' | 'failure' } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const events = agent.session.snapshotEvents() as readonly { type: string; data?: Record<string, unknown> }[]
    const settle = events.find(event => event.type === 'agent/inbox/spliced'
      && JSON.stringify(event.data).includes('subagent-settled')
      && JSON.stringify(event.data).includes(childId))
    if (settle !== undefined) {
      const text = JSON.stringify(settle.data)
      return { kind: /PONG|closing message|completed|finished/u.test(text) && !/failed|error|unavailable/u.test(text) ? 'success' : 'failure' }
    }
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  }
  return undefined
}

const NATIVE_TASKS = [
  { bundle: B13, packageName: B13, tool: 'subagent_claude_code', provider: 'claude-code' },
  { bundle: B14, packageName: B14, tool: 'subagent_codex', provider: 'codex' },
] as const

test('B13/B14: official missing catalog, exact installTarget and local profile install', { skip }, async t => {
  // Catalog truth before any install: both on-demand packages are discoverable
  // as missing official entries with an exact rc.2 install target.
  const catalogHost = await startS4D2Host(t, { bundles: [] })
  const pluginManager = catalogHost.ctx.get('pluginManager') as {
    listBundles(): Promise<readonly {
      name: string
      official: boolean
      availability: string
      installTarget?: { spec: string; version: string }
    }[]>
  }
  const catalog = await pluginManager.listBundles()
  for (const task of NATIVE_TASKS) {
    const entry = catalog.find(candidate => candidate.name === task.packageName)
    assert.ok(entry !== undefined, `${task.packageName} must be discoverable`)
    assert.equal(entry.official, true)
    assert.equal(entry.availability, 'missing')
    assert.equal(entry.installTarget?.version, '0.2.1-rc.2')
    assert.equal(entry.installTarget?.spec, `${task.packageName}@0.2.1-rc.2`)
  }
  await catalogHost.dispose()

  for (const task of NATIVE_TASKS) {
    const host = await startS4D2Host(t, {
      bundles: [task.bundle],
      profileDependencies: { [task.packageName]: `file:${join(catalogHost.installation.nodeModules, task.packageName)}` },
    })
    try {
      // The fixture really isolates the credential/agent roots for this Host.
      assert.equal(process.env.HOME, join(host.root, 'home'))
      assert.equal(process.env.DSH_HOME, join(host.root, 'home'))
      assert.equal(process.env.DSH_AGENTS_HOME, join(host.root, 'home', '.agents'))
      const tool = host.ctx.tools.get(task.tool) as { description?: string; parameters?: Record<string, unknown> } | undefined
      assert.ok(tool !== undefined, `${task.packageName} must install the official ${task.tool} one-shot tool`)
      assert.match(tool.description ?? '', /does not accept follow-up messages/i,
        `${task.tool} is a one-shot provider with no Continue/Resume affordance`)
      const parameters = tool.parameters ?? {}
      assert.equal(Object.hasOwn(parameters, 'resume'), false)
      assert.equal(Object.hasOwn(parameters, 'session_id'), false)
      assert.equal(Object.hasOwn(parameters, 'followup'), false)

      const agent = await host.createAgent(SessionId(`s4-d2-native-${task.provider}`), { cwd: join(host.root, 'work') })
      if (!NATIVE_ADMITTED) {
        // The default run records the truthful gate state without launching the
        // external process at all. No catalog child and no fake success exist.
        assert.deepEqual(host.ctx.agents.list().map(candidate => String(candidate.id)), [String(agent.session.id)])
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
        continue
      }

      // REAL Host start under the isolated HOME. A synchronous provider failure
      // is recorded as a truthful failure; a start that returns an external
      // child is observed to its settle/failure, never assumed successful.
      const started = await host.ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`s4-d2-${task.provider}-start`),
        name: task.tool,
        arguments: { description: 'read-only ping', prompt: 'Reply with exactly PONG and nothing else.' },
        agent,
      }) as { isError?: boolean; content?: readonly { type?: string; text?: string }[] }
      const startedText = (started.content ?? []).map(block => block.type === 'text' ? block.text ?? '' : '').join('')
      if (started.isError === true) {
        assert.equal(startedText.includes('PONG'), false, 'a failed native start never fabricates the answer')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
        continue
      }
      const childId = /started subagent (\S+)/u.exec(startedText)?.[1]
      assert.ok(childId !== undefined, startedText)
      const catalogEvent = (agent.session.snapshotEvents() as readonly {
        type: string
        data?: { mode?: string; childId?: string }
      }[]).find(event => event.type === 'subagent/catalog' && event.data?.childId === childId)
      assert.equal(catalogEvent?.data?.mode, 'external', 'the native child is an external one-shot')

      const settled = await observeSettle(agent, childId, 12_000)
      const events = agent.session.snapshotEvents() as readonly { type: string; data?: Record<string, unknown> }[]
      const settleText = JSON.stringify(events.filter(event => event.type === 'agent/inbox/spliced'
        && JSON.stringify(event.data).includes('subagent-settled')
        && JSON.stringify(event.data).includes(childId)))
      if (settled === undefined) {
        // There is no settle event yet; the only assertable negative is that
        // no fabricated PONG settlement exists in the parent log.
        assert.equal(settleText.includes('PONG'), false, 'no fabricated native success may appear in the parent log')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
      } else if (settled.kind === 'success') {
        assert.match(settleText, /PONG/, 'a real native success must carry the genuine native answer')
        nativeEvidence.push({ provider: task.provider, status: 'PASS' })
      } else {
        assert.equal(settleText.includes('PONG'), false, 'a failed native start never fabricates the answer')
        nativeEvidence.push({ provider: task.provider, status: 'EXTERNAL_UNVERIFIED' })
      }
      const subagents = host.ctx.subagents as {
        interrupt(id: string, authority: { kind: 'ancestor'; agent: unknown }): void
        drainDescendants(parents: readonly unknown[]): Promise<void>
      }
      try {
        subagents.interrupt(childId, { kind: 'ancestor', agent })
        await Promise.race([
          subagents.drainDescendants([agent]),
          new Promise<void>(resolve => setTimeout(resolve, 15_000)),
        ])
      } catch {
        // The provider already settled or has nothing to drain; the parent Host
        // still disposes below.
      }
      // Teardown/cleanup: an external child never turns into an in-process
      // orphan Agent in this Host composition.
      const remaining = host.ctx.agents.list().map(candidate => String(candidate.id)).filter(id => id !== String(agent.session.id))
      assert.deepEqual(remaining, [], 'no orphan in-process child remains after the native start settles')
    } finally {
      await host.dispose()
    }
  }
  assert.deepEqual(nativeEvidence.map(entry => entry.provider), ['claude-code', 'codex'])
  if (!NATIVE_ADMITTED) {
    assert.deepEqual(nativeEvidence.map(entry => entry.status), ['EXTERNAL_UNVERIFIED', 'EXTERNAL_UNVERIFIED'],
      'the default suite records the native gate as unverified without starting a provider')
  }
})

test('fixture restores the process environment after multiple concurrent hosts', { skip }, async t => {
  const originalHome = process.env.HOME
  const originalDsh = process.env.DSH_HOME
  const originalAgents = process.env.DSH_AGENTS_HOME
  const first = await startS4D2Host(t, { bundles: [] })
  const firstHome = process.env.HOME
  const second = await startS4D2Host(t, { bundles: [] })
  assert.notEqual(process.env.HOME, firstHome, 'the second host points the process at its own root')
  await first.dispose()
  assert.notEqual(process.env.HOME, originalHome, 'the remaining host keeps the isolated environment')
  await second.dispose()
  assert.equal(process.env.HOME, originalHome, 'the last release restores the original HOME')
  assert.equal(process.env.DSH_HOME, originalDsh, 'the last release restores the original DSH_HOME')
  assert.equal(process.env.DSH_AGENTS_HOME, originalAgents, 'the last release restores the original agents root')
})

test('fixture re-applies its own environment on restart while another host is live', { skip }, async t => {
  const originalHome = process.env.HOME
  const first = await startS4D2Host(t, { bundles: [] })
  const second = await startS4D2Host(t, { bundles: [] })
  const restarted = await first.restart()
  assert.equal(process.env.HOME, join(restarted.root, 'home'),
    'the restarted host re-applies its OWN disposable HOME')
  assert.equal(process.env.DSH_HOME, join(restarted.root, 'home'))
  await second.dispose()
  assert.equal(process.env.HOME, join(restarted.root, 'home'),
    'the live restarted host keeps its isolated environment')
  await restarted.dispose()
  assert.equal(process.env.HOME, originalHome, 'the last release restores the original HOME')
})

test('fixture rejects restart after dispose', { skip }, async t => {
  const host = await startS4D2Host(t, { bundles: [] })
  await host.dispose()
  await assert.rejects(() => host.restart(), /cannot restart a disposed host/u)
})
