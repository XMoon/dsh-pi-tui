import assert from 'node:assert/strict'
import test from 'node:test'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHostShellPathCompletionBridge } from '../../src/runtime/remote/pi-tui-host-user-shell-host-bridge.ts'
import { DirectHostDiscoveryDriver } from '../../src/runtime/direct/file-completion/host-discovery.ts'
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

test('Host shell paths keep a leading whitespace filename byte in the Host query', async t => {
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-leading-space-')
  writeFileSync(join(hostWorkspace, ' spacey.txt'), '')
  writeFileSync(join(hostWorkspace, 'spacey.txt'), '')
  const bridge = createHostShellPathCompletionBridge()
  assert.deepEqual(await bridge.complete(hostWorkspace, ' spa', new AbortController().signal), {
    kind: 'ok', candidates: [' spacey.txt'],
  }, 'the semantic prefix queries the filename beginning with a space, not its trimmed name')
})

test('Host shell paths keep a leading double-quote filename byte in the Host query', async t => {
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-leading-quote-')
  writeFileSync(join(hostWorkspace, '"quoted.txt'), '')
  writeFileSync(join(hostWorkspace, 'quoted.txt'), '')
  const bridge = createHostShellPathCompletionBridge()
  assert.deepEqual(await bridge.complete(hostWorkspace, '"q', new AbortController().signal), {
    kind: 'ok', candidates: ['"quoted.txt'],
  }, 'the semantic prefix queries the filename beginning with a double quote, not its unquoted name')
})

test('Remote Host Bash path completion fails closed for Windows Host facts in this version', async () => {
  let calls = 0
  const bridge = createHostShellPathCompletionBridge({
    environment: { homeDir: 'C:\\Users\\host', windowsHost: true },
    driver: {
      async listDirectory() { calls += 1; return [] },
      async find() { calls += 1; return [] },
    },
  })
  assert.deepEqual(await bridge.complete('C:\\workspace', '.\\src', new AbortController().signal), {
    kind: 'unavailable',
    reason: 'Host Bash path completion is unsupported on Windows in this version',
  })
  assert.equal(calls, 0, 'an unsupported Windows path shell never enters the POSIX discovery driver')
})

test('Host Bash path completion keeps its 50-candidate bound over a larger Host match set', async t => {
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-limit-')
  // 80 Host-computed matches, all scoring on the same basename-prefix tier.
  const driver: LocalDiscoveryDriver = {
    async listDirectory() { return [] },
    async find() {
      return Array.from({ length: 80 }, (_value, index) => ({
        path: `host-${String(index).padStart(3, '0')}.ts`,
        kind: 'file' as const,
      }))
    },
  }
  const bridge = createHostShellPathCompletionBridge({ driver })
  const outcome = await bridge.complete(hostWorkspace, 'host', new AbortController().signal)
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') {
    assert.equal(outcome.candidates.length, 50, 'the Host Bash presentation stays bounded at 50')
    assert.equal(outcome.candidates[0], 'host-000.ts', 'the shared ranking order still leads the list')
  }
})

test('the Host Bash bridge keeps a strong match emitted after 100 finder records', async t => {
  // F2-T11 evidence through the REAL Host finder: an actually-spawned fake fd
  // streams 120 weak matches and the exact-basename match LAST. The retired
  // `--max-results 100` behavior (which the scripted finder would honour)
  // would drop the late record, so the first candidate identifies the failure.
  const life = testLifecycle(t)
  const hostWorkspace = life.tempDir('f1-host-shell-late-')
  const dir = life.tempDir('f1-host-shell-late-fd-')
  const recordFile = join(dir, 'records.bin')
  const records = Array.from({ length: 120 }, (_value, index) =>
    `nested/dsh-filler-${String(index).padStart(3, '0')}.txt`)
  records.push('nested/dsh')
  writeFileSync(recordFile, records.map(record => `${record}\0`).join(''))
  const argsFile = join(dir, 'args.txt')
  const fd = join(dir, 'fd')
  writeFileSync(fd, `#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(argsFile)}, args.join('\\n'))
const maxIndex = args.indexOf('--max-results')
const max = maxIndex === -1 ? Infinity : Number(args[maxIndex + 1])
const records = fs.readFileSync(${JSON.stringify(recordFile)}, 'utf8').split('\\u0000')
if (records.at(-1) === '') records.pop()
process.stdout.write(records.slice(0, max).map(record => record + '\\u0000').join(''))
`)
  chmodSync(fd, 0o755)
  const bridge = createHostShellPathCompletionBridge({
    driver: new DirectHostDiscoveryDriver(fd),
  })
  const outcome = await bridge.complete(hostWorkspace, 'dsh', new AbortController().signal)
  const args = readFileSync(argsFile, 'utf8').split(/\r?\n/)
  assert.ok(!args.includes('--max-results'),
    `the Host Bash finder must not truncate before ranking: ${JSON.stringify(args)}`)
  assert.equal(outcome.kind, 'ok')
  if (outcome.kind === 'ok') {
    assert.equal(outcome.candidates.length, 50, 'the Host Bash presentation stays bounded at 50')
    assert.equal(outcome.candidates[0], 'nested/dsh',
      `the late exact-basename match must lead the Host Bash suggestions: ${JSON.stringify(outcome.candidates.slice(0, 3))}`)
  }
})
