import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('bench:smoke exercises the maintained benchmark families', { timeout: 120_000 }, () => {
  const result = spawnSync('pnpm', ['bench:smoke'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 110_000,
    env: { ...process.env, BENCH_SMOKE: '1' },
  })
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  assert.equal(result.status, 0, output)
  for (const label of [
    'bounded 20-turn projection',
    'real live stream 1 token/flush',
    'fullscreen bounded projection',
    'Focus collapsed streaming',
    'Focus expanded streaming',
    'append visible message commits',
    'turn finalization / shape transition',
    'window move (older) commits',
    'search 5 turns',
    'window nav ×50 older / ×50 newer',
  ]) {
    assert.match(output, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')))
  }
  assert.match(output, /append visible message commits\s+structural\/content\/no-op 1 \/ 0 \/ 0/)
  assert.match(output, /turn finalization \/ shape transition\s+structural\/content\/no-op 1 \/ 0 \/ 0/)
  assert.match(output, /window move \(older\) commits\s+structural\/content\/no-op 1 \/ 0 \/ 0/)
  const lifecycle = output.match(/benchmark app lifecycle\s+created=(\d+) disposed=(\d+)/)
  assert.ok(lifecycle, `missing benchmark lifecycle counters:\n${output}`)
  assert.equal(lifecycle[1], lifecycle[2], `benchmark app leak:\n${output}`)
  assert.notEqual(lifecycle[1], '0', `benchmark did not create an app:\n${output}`)
})
