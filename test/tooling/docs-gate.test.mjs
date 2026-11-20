/**
 * The documentation gate prevents unindexed owners and broken local targets.
 * It does not claim to validate GitHub anchor slugs or product semantics.
 */

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { checkDocsTree } from '../../scripts/docs-gate.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

function fixture(t) {
  const root = testLifecycle(t).tempDir('docs-gate-')
  mkdirSync(join(root, 'docs/guides'), { recursive: true })
  const tick = String.fromCharCode(96)
  writeFileSync(join(root, 'docs/README.md'),
    '# Documentation\n\n| Path | Audience | Owner |\n|---|---|---|\n'
    + '| ' + tick + 'README.md' + tick + ' | everyone | map |\n'
    + '| ' + tick + 'guides/user.md' + tick + ' | users | guide |\n')
  writeFileSync(join(root, 'docs/guides/user.md'),
    '# User guide\n\nSee [index](../README.md).\n')
  return root
}

test('accepts one indexed owner for every document and valid relative links', (t) => {
  const root = fixture(t)
  assert.deepEqual(checkDocsTree(root), [])
})

test('finds missing index entries, duplicate owners and broken links', (t) => {
  const root = fixture(t)
  const tick = String.fromCharCode(96)
  writeFileSync(join(root, 'docs/README.md'),
    '| ' + tick + 'README.md' + tick + ' | everyone | map |\n'
    + '| ' + tick + 'README.md' + tick + ' | everyone | duplicate |\n')
  writeFileSync(join(root, 'docs/guides/user.md'),
    '# User guide\n\n[missing](./unknown.md)\n')
  const failures = checkDocsTree(root).join('\n')
  assert.match(failures, /duplicate document index row: README\.md/u)
  assert.match(failures, /missing document index row: guides\/user\.md/u)
  assert.match(failures, /missing local link: \.\/unknown\.md/u)
})

test('ignores inline-code link examples but checks adjacent real links', (t) => {
  const root = fixture(t)
  const tick = String.fromCharCode(96)
  writeFileSync(join(root, 'docs/guides/user.md'),
    '# User guide\n\nExample: ' + tick + '[demo](./not-installed.md)' + tick
    + ' is syntax; see [index](../README.md).\n'
    + 'Double: ' + tick.repeat(2) + '[demo](./also-not-installed.md)'
    + tick.repeat(2) + ' and [missing](./really-missing.md).\n')
  assert.deepEqual(checkDocsTree(root), [
    'docs/guides/user.md:4: missing local link: ./really-missing.md',
  ])
})

test('ignores Markdown examples in fenced blocks and external links', (t) => {
  const root = fixture(t)
  writeFileSync(join(root, 'docs/guides/user.md'),
    '# User guide\n\n[remote](https://example.invalid/missing.md)\n'
    + '\n~~~markdown\n[example](./not-installed.md)\n~~~\n'
    + '\n[local](../README.md)\n')
  assert.deepEqual(checkDocsTree(root), [])
})
