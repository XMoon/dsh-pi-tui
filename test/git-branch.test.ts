/**
 * The display git-branch fact: the branch of the GIVEN directory's nearest
 * checkout — never the process's own. An empty cwd is "no known directory",
 * not "look under the process cwd".
 * @module @xmoon76/dsh-pi-tui/git-branch.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gitBranch } from '../src/client/git/branch.ts'
import { testLifecycle } from './support/temp-lifecycle.ts'

test('gitBranch: an empty cwd never reads the process cwd’s checkout', () => {
  // The regression: `join('', '.git', 'HEAD')` is relative, so a branch CI
  // checkout (a real `ref: refs/heads/<branch>`) used to leak in here as the
  // branch of a subject whose workspace is unknown.
  assert.equal(gitBranch(''), '')
})

test('gitBranch: the nearest checkout of the given directory decides', (t) => {
  const root = testLifecycle(t).tempDir('dsh-pi-tui-git-branch-')
  mkdirSync(join(root, '.git'), { recursive: true })
  writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/probe-branch\n')
  assert.equal(gitBranch(root), 'probe-branch')
  // The walk covers the descendants of the directory holding the checkout.
  assert.equal(gitBranch(join(root, 'nested', 'deeper')), 'probe-branch')
  // A detached HEAD carries a commit id: no branch name is known.
  writeFileSync(join(root, '.git', 'HEAD'), `${'0'.repeat(40)}\n`)
  assert.equal(gitBranch(root), '')
})
