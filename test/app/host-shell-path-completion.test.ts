import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHostShellPathCompletionBridge } from '../../src/runtime/remote/pi-tui-host-user-shell-host-bridge.ts'
import type { LocalDiscoveryDriver } from '../../src/domain/file-completion/discovery-policy.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

test('Host shell paths query the Host cwd/filesystem and return Host-relative candidates', async t => {
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-path-host-')
  mkdirSync(join(hostWorkspace, 'src'))
  writeFileSync(join(hostWorkspace, 'src', 'host-only.ts'), '')
  const bases: string[] = []
  const driver: LocalDiscoveryDriver = {
    async listDirectory(baseDir) {
      bases.push(baseDir)
      return [{ name: 'host-only.ts', kind: 'file', descendable: false }]
    },
    async find(baseDir) {
      bases.push(baseDir)
      return null
    },
  }
  const bridge = createHostShellPathCompletionBridge({ driver })
  assert.deepEqual(await bridge.complete(hostWorkspace, 'src/host', new AbortController().signal), {
    kind: 'ok', candidates: ['src/host-only.ts'],
  })
  assert.ok(bases.length > 0)
  assert.ok(bases.every(baseDir => baseDir === join(hostWorkspace, 'src')),
    'the discovery driver receives only the Host path query, never a Client cwd or filesystem')
})

test('Host absolute and home paths stay on the Host discovery driver', async t => {
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-absolute-')
  const bases: string[] = []
  const driver: LocalDiscoveryDriver = {
    async listDirectory(baseDir) {
      bases.push(baseDir)
      return []
    },
    async find(baseDir) {
      bases.push(baseDir)
      return []
    },
  }
  const bridge = createHostShellPathCompletionBridge({ driver })
  await bridge.complete(hostWorkspace, `${hostWorkspace}/`, new AbortController().signal)
  assert.ok(bases.every(baseDir => baseDir.startsWith(hostWorkspace)),
    'absolute shell path lookup is still Host-owned, not a Client filesystem read')
})
