import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveDshContext,
  resolveDshMode,
} from '../scripts/dsh-ci-context.mjs'

const nextSha = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'

test('DSH mode resolver selects source only for next branch compatibility', () => {
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/next' }), 'source')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/1/merge', baseRef: 'next' }), 'source')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'pull_request', ref: 'refs/pull/2/merge', baseRef: 'main' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'push', ref: 'refs/heads/feature/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'workflow_dispatch', ref: 'refs/heads/next' }), 'npm')
  assert.equal(resolveDshMode({ eventName: 'schedule', ref: 'refs/heads/next' }), 'npm')
})

test('all release tags force npm mode, including next-v tags', () => {
  for (const ref of ['refs/tags/next-v0.4.0-alpha.1', 'refs/tags/v0.4.0']) {
    assert.equal(resolveDshMode({ eventName: 'push', ref }), 'npm')
    assert.throws(() => resolveDshMode({ eventName: 'push', ref, forcedMode: 'source' }), /release tag/u)
  }
})

test('context exposes the tracked source pin only in source mode', () => {
  const source = resolveDshContext({ eventName: 'push', ref: 'refs/heads/next' })
  assert.equal(source.mode, 'source')
  assert.equal(source.sourceRef, nextSha)
  assert.equal(source.sourceExpectedVersion, '0.1.2-alpha.1')

  const npm = resolveDshContext({ eventName: 'push', ref: 'refs/heads/main' })
  assert.equal(npm.mode, 'npm')
  assert.equal(npm.sourceRef, '')
  assert.equal(npm.sourceExpectedVersion, '')
})
