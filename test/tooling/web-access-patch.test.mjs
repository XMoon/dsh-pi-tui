/**
 * The generated bundle-layer Web roster must stay in sync with its ONE
 * production authority and stay reachable from the installed package.
 *
 * The roster is generated from `src/app/host/features/web-roster.ts` because
 * every official Web row must be a profile-owned Loader entry: a command-line
 * overlay declaration is what made the official ConfigEditor refuse the user
 * writes this PR fixes. A hand-edited, stale or unlisted generated patch would
 * either resurrect that bug or silently drop rows from the Browser graph.
 *
 * @module @xmoon76/dsh-pi-tui/web-access-patch.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const REPO_ROOT = join(import.meta.dirname, '..', '..')
const GENERATED_PATH = join(REPO_ROOT, 'generated', 'web-access', 'cordis.patch.yml')

function manifest() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
}

test('the generated Web patch is byte-identical to the production roster', () => {
  const result = spawnSync(process.execPath, [
    '--import', 'tsx/esm', 'scripts/generate-web-access-patch.mjs', '--check',
  ], { cwd: REPO_ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, `the generated Web patch drifted:\n${result.stdout}\n${result.stderr}`)
})

test('the generated Web patch is a declared bundle layer ordered before the preset mirrors', () => {
  const patches = manifest().dsh?.bundle?.patch
  assert.ok(Array.isArray(patches), 'package.json must declare dsh.bundle.patch')
  const generated = patches.indexOf('./generated/web-access/cordis.patch.yml')
  assert.ok(generated >= 0, 'the generated Web patch must be installed as a bundle layer')
  assert.equal(patches[generated - 1], './cordis.patch.yml',
    'the Web roster layer must follow the main bundle patch')
  for (const [index, entry] of patches.entries()) {
    if (entry.startsWith('./generated/dsh-presets/')) {
      assert.ok(index > generated, 'the preset mirrors must follow the Web roster layer')
    }
  }
  assert.ok(manifest().files.includes('generated'),
    'the packaged files must carry generated/, or the installed bundle layer is missing')
})

test('every generated row is an official default-off browser row with a unique id', () => {
  const entries = parse(readFileSync(GENERATED_PATH, 'utf8'), {
    customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value) => value }],
  })
  assert.equal(entries.length, 1, 'the generated patch must hold ONE insert group')
  const rows = entries[0].insert
  assert.ok(Array.isArray(rows) && rows.length > 0, 'the generated insert group must declare rows')
  const ids = rows.map(row => row.id)
  assert.equal(new Set(ids).size, ids.length, 'a duplicated Web row would mount one package twice')
  for (const row of rows) {
    assert.equal(typeof row.name, 'string', `the "${row.id}" row must name its official package`)
    assert.match(row.name, /^@deepseek-ai\//u, `the "${row.id}" row must load an official package`)
    assert.equal(row.disabled, true, `the "${row.id}" row must arrive disabled for the runtime toggle`)
  }
  assert.equal(rows.filter(row => row.id === 'web-runtime').length, 1,
    'the SPA owner must appear exactly once')
  assert.deepEqual(rows.find(row => row.id === 'web-runtime').config,
    { openBrowser: false, printUrl: false, surfaceContext: false },
    'the SPA owner must stay silent at the default layer')
})
