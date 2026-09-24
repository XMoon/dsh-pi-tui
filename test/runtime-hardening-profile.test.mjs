/**
 * Runtime-hardening profile contract: the shipped `cordis.patch.yml` must
 * mount DSH's official `@deepseek-ai/dsh-invariants` registry (with an exact
 * allowlist) plus the `@deepseek-ai/dsh-agent-preset-registry/invariant`
 * companion, and both module names must resolve where the patch is applied.
 *
 * This file pins the repo's dependency rule for a COMPOSITION ROW, which is not
 * the generic "every referenced package is a runtime peer" rule: a package the
 * patch names but `src/` never imports is resolved by the dsh Host from its own
 * installation and stays a devDependency here. `@deepseek-ai/dsh-invariants` is
 * exactly that case (see `@deepseek-ai/dsh-agent-preset` for the precedent), and
 * it is installed wherever its Host-side dependant is: the registry package —
 * itself a runtime peer of this bundle — declares it as its own peer. A peer
 * that `src/` DOES import is the other contract, enforced by
 * `scripts/naming-gate.mjs`.
 *
 * The allowlist assertion is deliberately exact: the bundle introduces ONE
 * production invariant, so a later layer adding another invariant companion
 * must not be enabled implicitly by this profile.
 * @module @xmoon76/dsh-pi-tui/runtime-hardening-profile.test
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

const REPO_ROOT = process.cwd()

/** The rows the bundle patch inserts, keyed by entry id. */
function bundleRows() {
  const document = parse(readFileSync(join(REPO_ROOT, 'cordis.patch.yml'), 'utf8'))
  const inserted = (document ?? []).flatMap(entry => entry?.insert ?? [])
  return new Map(inserted.filter(row => typeof row.id === 'string').map(row => [row.id, row]))
}

const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))

test('the profile mounts the invariants registry with the exact preset allowlist', () => {
  const registry = bundleRows().get('invariants')
  assert.ok(registry, 'cordis.patch.yml must insert the `invariants` row')
  assert.equal(registry.name, '@deepseek-ai/dsh-invariants', 'the row must name the official registry package')
  assert.equal(registry.disabled, undefined, 'the invariants registry must not be disabled')
  const config = registry.config ?? {}
  assert.equal(config.enabled, true, 'the invariants registry must be enabled in production')
  assert.deepEqual(config.package_allowlist, ['^@deepseek-ai/dsh-agent-preset-registry$'],
    'the allowlist must enable exactly the preset-registry invariant')
})

test('the profile mounts the agent-preset-registry invariant companion', () => {
  const companion = bundleRows().get('agent-preset-registry-invariant')
  assert.ok(companion, 'cordis.patch.yml must insert the preset invariant companion row')
  assert.equal(companion.name, '@deepseek-ai/dsh-agent-preset-registry/invariant',
    'the companion must name the registry package subpath')
  assert.equal(companion.disabled, undefined, 'the companion must not be disabled')
  assert.equal(companion.config, undefined, 'the companion takes no config; its inject declares the dependency')
})

test('the preset registry row stays the deployment default on the host plane', () => {
  const registry = bundleRows().get('agent-preset-registry')
  assert.ok(registry, 'the composition must keep the agent-preset-registry row')
  assert.equal(registry.name, '@deepseek-ai/dsh-agent-preset-registry')
  assert.equal((registry.config ?? {}).default, 'standard',
    'the deployment default must stay standard unless a deliberate change says otherwise')
})

test('dsh-invariants stays a composition row: exact dev pin, deliberately no runtime peer', () => {
  assert.equal(manifest.devDependencies?.['@deepseek-ai/dsh-invariants'], '0.1.7-rc.1',
    'the development target stays pinned to the exact rc.1 package for the real-mount tests')
  // `@deepseek-ai/dsh-invariants` is named only by cordis.patch.yml — a
  // composition row the dsh Host resolves from its own installation, exactly
  // like `@deepseek-ai/dsh-agent-preset`. `src/` never imports it, so a peer
  // entry would be a dead peer (scripts/naming-gate.mjs) and would invite a
  // duplicate in-box copy in the profile. This assertion pins the repo rule so
  // a later edit cannot silently "fix" it into a phantom runtime peer.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-invariants'], undefined,
    'a composition row is not a module-graph peer')
})

test('the registry still declares the peer that installs dsh-invariants beside it', () => {
  // What this test DOES prove: the package that is always installed in a
  // profile (the registry is a runtime peer of this bundle, so npm/pnpm
  // installs it with the bundle) declares `@deepseek-ai/dsh-invariants` as one
  // of its OWN peers, and both module subpaths resolve from this checkout.
  // What it does NOT prove: a clean-profile BOOT with the row activated — that
  // end-to-end check is the `pnpm pack:release` tarball / pluginization smokes
  // plus a fresh-profile install, not this structural assertion.
  const registryManifest = JSON.parse(readFileSync(
    new URL(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry/package.json')),
    'utf8',
  ))
  assert.equal(registryManifest.peerDependencies?.['@deepseek-ai/dsh-invariants'], '0.1.7-rc.1',
    'the registry must keep declaring dsh-invariants as its own peer (the Host install chain)')
})

test('every package the profile names resolves from this checkout', () => {
  // A patch row naming an unresolvable module is a boot-time row failure that
  // only appears once the bundle is actually mounted; resolving here catches a
  // typo, a missing subpath export, or a package that never made it into the
  // dependency graph.
  assert.match(import.meta.resolve('@deepseek-ai/dsh-invariants'), /dsh-invariants/,
    'the invariants registry package must resolve')
  assert.match(import.meta.resolve('@deepseek-ai/dsh-agent-preset-registry/invariant'), /invariant\.js$/,
    'the registry companion subpath export must resolve')
})
