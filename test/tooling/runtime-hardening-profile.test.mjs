/**
 * Profile-basics contract for the 0.2.1-rc.2 composition.
 *
 * The retired hardening layer is gone upstream: 0.2.1-rc.2 no longer publishes
 * `@deepseek-ai/dsh-invariants`, the `@deepseek-ai/dsh-agent-preset-registry/invariant`
 * companion subpath, or the base `tool-ralph` row. This file therefore pins
 * what actually owns each seam now, instead of asserting a local substitute:
 *
 * - the OFFICIAL `@deepseek-ai/dsh-base` layer owns `authorization`,
 *   `remote-access`, `working-directory` and `tool-working-directory`, exactly
 *   once each, and this bundle's overlay must NOT insert a second one;
 * - the overlay still owns the preset registry (deployment default `standard`)
 *   and must not resurrect the retired rows;
 * - the overlay keeps its explicit `authorization` inject on `tui-app`, so the
 *   lifecycle dependency survives even though the row itself is inherited.
 *
 * Reading the base patch from the installed official package keeps the
 * "who owns the seam" claim tied to the shipped 0.2.1-rc.2 artifact rather than to a
 * hand-copied expectation. It does NOT prove a clean-profile boot; that is the
 * real-profile smoke's job.
 * @module @xmoon76/dsh-pi-tui/runtime-hardening-profile.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const REPO_ROOT = process.cwd()
const BASE_PATCH_PATH = new URL(import.meta.resolve('@deepseek-ai/dsh-base/cordis.patch.yml'))

/** The rows a patch inserts, keyed by entry id (a bundle patch inserts one
 * flat list; later layers address those ids by id). */
function insertedRows(pathOrUrl) {
  const document = parse(readFileSync(pathOrUrl, 'utf8'))
  const inserted = (document ?? []).flatMap(entry => entry?.insert ?? [])
  return new Map(inserted.filter(row => typeof row.id === 'string').map(row => [row.id, row]))
}

const overlay = insertedRows(join(REPO_ROOT, 'cordis.patch.yml'))
const base = insertedRows(BASE_PATCH_PATH)
const overlayText = readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8')
const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

/** The official row one seam must have discovered exactly once in the layer
 * that owns it. */
const BASE_OWNED_SEAMS = [
  ['authorization', '@deepseek-ai/dsh-authorization'],
  ['remote-access', '@deepseek-ai/dsh-api-remote-access'],
  ['working-directory', '@deepseek-ai/dsh-working-directory'],
  ['tool-working-directory', '@deepseek-ai/dsh-tool-working-directory'],
  // 0.2.1-rc.2's new DeepSeek Search/Fetch API provider: a base row like the others
  // (NOT a fifteenth optional Bundle), so the overlay must inherit it too.
  ['web-deepseek-api', '@deepseek-ai/dsh-web-deepseek-api'],
]

test('the official base owns the authorization / working-directory / remote-access seams exactly once', () => {
  for (const [id, name] of BASE_OWNED_SEAMS) {
    const rows = [...base.entries()].filter(([, row]) => row.name === name)
    assert.deepEqual(rows.map(([rowId]) => rowId), [id],
      `the 0.2.1-rc.2 base must declare exactly one ${name} row (id ${id})`)
  }
})

test('the TUI overlay inherits those seams instead of inserting a second owner', () => {
  for (const [id, name] of BASE_OWNED_SEAMS) {
    assert.equal(overlay.has(id), false,
      `cordis.patch.yml must not insert a second \`${id}\` row; the 0.2.1-rc.2 base owns ${name}`)
  }
})

test('the overlay keeps its explicit authorization dependency on the surface row', () => {
  const app = overlay.get('tui-app')
  assert.ok(app, 'the overlay must insert the tui-app row')
  assert.ok(Array.isArray(app.inject) && app.inject.includes('authorization'),
    'tui-app must keep injecting `authorization`: the row is inherited, the lifecycle ordering is this bundle\'s')
})

test('the base keeps the shipped web defaults and the overlay adds no web provider row', () => {
  const web = base.get('web')
  assert.ok(web, 'the 0.2.1-rc.2 base must declare the web row')
  assert.equal(web.name, '@deepseek-ai/dsh-web')
  assert.deepEqual(web.config, { searchProvider: 'deepseek-official', fetchProvider: 'http' },
    'the base web row must keep the shipped Messages-search + HTTP-fetch defaults')
  // Every web provider row belongs to the base; a TUI copy would be a second
  // provider registry (and `web-deepseek-api` must never be re-mounted here).
  for (const id of ['web', 'web-search-deepseek', 'web-deepseek-api']) {
    assert.equal(overlay.has(id), false, `cordis.patch.yml must not insert a \`${id}\` row`)
  }
})

test('the preset registry row stays the deployment default on the host plane', () => {
  const registry = overlay.get('agent-preset-registry')
  assert.ok(registry, 'the composition must keep the agent-preset-registry row')
  assert.equal(registry.name, '@deepseek-ai/dsh-agent-preset-registry')
  assert.equal((registry.config ?? {}).default, 'standard',
    'the deployment default must stay standard unless a deliberate change says otherwise')
})

test('the retired invariant and Ralph rows are absent from the composition and the manifest', () => {
  // Both the positive (`insert`) and the negative (`disabled`) forms would
  // address a row the 0.2.1-rc.2 base no longer mounts.
  for (const retired of ['invariants', 'agent-preset-registry-invariant', 'tool-ralph']) {
    assert.equal(overlay.has(retired), false, `the overlay must not declare the retired \`${retired}\` row`)
    assert.doesNotMatch(overlayText, new RegExp(`^- id: ${retired}$`, 'mu'),
      `the overlay must not carry a \`${retired}\` negative override either`)
  }
  for (const section of ['dependencies', 'peerDependencies', 'devDependencies']) {
    assert.equal('@deepseek-ai/dsh-invariants' in (manifest[section] ?? {}), false, `${section} must not carry dsh-invariants`)
    assert.equal('@deepseek-ai/dsh-tool-ralph' in (manifest[section] ?? {}), false, `${section} must not carry the retired tool-ralph package`)
  }
})

test('every overlay row this checkout declares locally resolves from it', () => {
  // Rows the dsh Host resolves from its own installation (the base-owned seams
  // and `cordis-host-runner`) are deliberately NOT local dependencies, so they
  // are out of scope here. For every row this checkout DOES declare, the exact
  // name — including a subpath export — must resolve: a patch row naming an
  // unresolvable module is a boot-time row failure.
  const declared = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies }
  const checked = []
  for (const [id, row] of overlay) {
    if (typeof row.name !== 'string' || !row.name.startsWith('@deepseek-ai/dsh-')) continue
    const packageName = row.name.split('/').slice(0, 2).join('/')
    if (!(packageName in declared)) continue
    assert.doesNotThrow(() => import.meta.resolve(row.name), `the \`${id}\` row must resolve: ${row.name}`)
    checked.push(row.name)
  }
  assert.ok(checked.length > 0, 'the overlay must declare at least one locally installed row')
})
