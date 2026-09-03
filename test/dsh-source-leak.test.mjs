import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import test from 'node:test'

import { testLifecycle } from './support/temp-lifecycle.ts'
import { assertNoSourceLeak, DshDistributionError } from '../scripts/lib/dsh-distribution.mjs'

function tarCandidate(directory, name, metadata, files = {}) {
  const stage = join(directory, `stage-${name}`)
  const packageDir = join(stage, 'package')
  mkdirSync(packageDir, { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), `${JSON.stringify(metadata)}\n`)
  for (const [file, content] of Object.entries(files)) {
    const target = join(packageDir, file)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, content)
  }
  const tarball = join(directory, name)
  const result = spawnSync('tar', ['-czf', tarball, '-C', stage, 'package'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  rmSync(stage, { recursive: true, force: true })
  return tarball
}

test('source leak gate covers peer metadata and concrete CI/source roots', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-source-leak-')
  const base = { name: '@xmoon76/dsh-pi-tui', version: '0.4.0-alpha.1' }
  const clean = tarCandidate(directory, 'clean.tgz', base, { 'README.md': 'file: is ordinary prose here\n' })
  assert.doesNotThrow(() => assertNoSourceLeak(clean))

  const peer = tarCandidate(directory, 'peer.tgz', {
    ...base,
    peerDependencies: { '@deepseek-ai/dsh-agent': 'file:/tmp/dsh-agent.tgz' },
  })
  assert.throws(() => assertNoSourceLeak(peer), error => error instanceof DshDistributionError && /source leak/u.test(error.message))

  const roots = tarCandidate(directory, 'roots.tgz', base, {
    'dist/index.mjs': [
      'const a = "/tmp/dsh-source-pack"',
      'const b = "RUNNER_TEMP"',
      'const c = "C:\\runner\\deepseek-harness"',
    ].join('\n'),
  })
  assert.throws(() => assertNoSourceLeak(roots), /source leak/u)
})

test('source leak CLI gates dependency metadata without scanning archive payloads', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-source-leak-metadata-')
  const candidate = tarCandidate(directory, 'payload.tgz', {
    name: '@xmoon76/dsh-pi-tui',
    version: '0.4.0-alpha.1',
  }, {
    'dist/index.mjs': 'const generatedPath = "/home/runner/work/project/source"\n',
  })
  const script = fileURLToPath(new URL('../scripts/dsh-source-leak-gate.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, candidate], { encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`)
})

test('source leak CLI rejects a symlinked candidate tarball', (t) => {
  const life = testLifecycle(t)
  const directory = life.tempDir('dsh-source-leak-link-')
  const target = join(directory, 'external.tgz')
  const candidate = join(directory, 'candidate.tgz')
  writeFileSync(target, 'not a tarball')
  symlinkSync(target, candidate)
  const script = fileURLToPath(new URL('../scripts/dsh-source-leak-gate.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [script, candidate], { encoding: 'utf8' })
  assert.equal(result.status, 1, result.stdout)
  assert.match(`${result.stdout}${result.stderr}`, /regular file/u)
})
