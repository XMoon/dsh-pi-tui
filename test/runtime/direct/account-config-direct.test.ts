import assert from 'node:assert/strict'
import test from 'node:test'
import { DirectAccountConfig, type HostContextLike } from '../../../src/runtime/direct/config-direct.ts'

function directAccount(agents: { list(): readonly unknown[] } | undefined): DirectAccountConfig {
  const context: HostContextLike = {
    get: name => name === 'agents' ? agents : undefined,
  }
  return new DirectAccountConfig(context)
}

test('Direct running-account-task reads follow the live Host Agent predicate without caching', async () => {
  const request = { provider: 'deepseek-account' }
  const running = { status: 'running', session: { requestContext: () => request } }
  const idle = { status: 'idle', session: { requestContext: () => request } }
  const otherProvider = { status: 'running', session: { requestContext: () => ({ provider: 'other' }) } }
  const rows: unknown[] = [idle, otherProvider]
  const adapter = directAccount({ list: () => rows })

  const first = adapter.hasRunningAccountTasks()
  assert.ok(first instanceof Promise, 'the Direct semantic port is asynchronous')
  assert.equal(await first, false)
  rows.push(running)
  assert.equal(await adapter.hasRunningAccountTasks(), true)
  rows.splice(rows.indexOf(running), 1)
  assert.equal(await adapter.hasRunningAccountTasks(), false, 'each query reads the current Host list')
})

test('a missing Direct Host Agent authority rejects instead of claiming no running account tasks', async () => {
  const adapter = directAccount(undefined)
  await assert.rejects(adapter.hasRunningAccountTasks(), /Host Agent service unavailable/u)
})
