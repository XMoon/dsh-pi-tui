import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  candidateTarball as npmVerifyCandidateTarball,
  npmVerificationEnvironment,
} from '../scripts/dsh-npm-verify.mjs'

test('npm verification pins the public registry and isolated user config', () => {
  const environment = npmVerificationEnvironment('/tmp/dsh-npm-verify-test.npmrc', {
    npm_config_registry: 'https://registry.example.invalid/',
    NPM_CONFIG_REGISTRY: 'https://registry.example.invalid/',
    npm_config_userconfig: '/home/user/.npmrc',
    NPM_CONFIG_USERCONFIG: '/home/user/.npmrc',
    DSH_TEST_SENTINEL: 'preserved',
  })
  assert.equal(environment.npm_config_registry, 'https://registry.npmjs.org/')
  assert.equal(environment.NPM_CONFIG_REGISTRY, 'https://registry.npmjs.org/')
  assert.equal(environment.npm_config_userconfig, '/tmp/dsh-npm-verify-test.npmrc')
  assert.equal(environment.NPM_CONFIG_USERCONFIG, '/tmp/dsh-npm-verify-test.npmrc')
  assert.equal(environment.DSH_TEST_SENTINEL, 'preserved')
})

test('CI npm install branches pin the public registry and isolated config', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const npmInstallBlocks = workflow.match(/printf 'registry=https:\/\/registry\.npmjs\.org\/\\n' > "\$RUNNER_TEMP\/dsh-npmrc"[\s\S]*?pnpm install --frozen-lockfile/gu) ?? []
  assert.equal(npmInstallBlocks.length, 5)
  for (const block of npmInstallBlocks) {
    assert.match(block, /NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\/\s+\\/u)
    assert.match(block, /npm_config_registry=https:\/\/registry\.npmjs\.org\/\s+\\/u)
    assert.match(block, /NPM_CONFIG_USERCONFIG="\$RUNNER_TEMP\/dsh-npmrc"/u)
    assert.match(block, /npm_config_userconfig="\$RUNNER_TEMP\/dsh-npmrc"/u)
  }
  assert.equal((workflow.match(/echo 'NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\/'/gu) ?? []).length, 6)
  assert.equal((workflow.match(/echo 'npm_config_registry=https:\/\/registry\.npmjs\.org\/'/gu) ?? []).length, 6)
  assert.equal((workflow.match(/echo "NPM_CONFIG_USERCONFIG=\$RUNNER_TEMP\/dsh-npmrc"/gu) ?? []).length, 5)
  assert.equal((workflow.match(/echo "npm_config_userconfig=\$RUNNER_TEMP\/dsh-npmrc"/gu) ?? []).length, 5)
  assert.equal((workflow.match(/DSH_SOURCE_ARTIFACT=\$RUNNER_TEMP\/dsh-source-pack/gu) ?? []).length, 4)
  assert.doesNotMatch(workflow, /DSH_SOURCE_ARTIFACT: \$\{\{ runner\.temp \}\}\/dsh-source-pack/u)
})

test('CI source preparation and publication have explicit time and registry boundaries', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /prepare-dsh-source:[\s\S]*?timeout-minutes: 135/u)
  assert.match(workflow, /npm publish [^\n]*--registry=https:\/\/registry\.npmjs\.org\//u)
  assert.match(workflow, /echo "NPM_CONFIG_USERCONFIG=\$RUNNER_TEMP\/dsh-publish-npmrc"/u)
  assert.match(workflow, /echo "npm_config_userconfig=\$RUNNER_TEMP\/dsh-publish-npmrc"/u)
  assert.doesNotMatch(workflow, /NPM_CONFIG_(?:REGISTRY|USERCONFIG):/u)
  assert.ok(workflow.includes("printf 'registry=https://registry.npmjs.org/\\n' > \"$RUNNER_TEMP/dsh-publish-npmrc\""))
})

test('Source Mode matrix uses a clean distribution-aware fresh install; the pi2dsh gate runs in both modes', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const compatStart = workflow.indexOf('  compat-smoke:')
  const ecosystemStart = workflow.indexOf('  ecosystem-compat:', compatStart)
  assert.ok(compatStart >= 0 && ecosystemStart > compatStart, 'workflow job boundaries must exist')
  const compat = workflow.slice(compatStart, ecosystemStart)
  assert.match(compat, /Download DSH source pack/u)
  assert.match(compat, /--dsh-distribution "\$DSH_SOURCE_ARTIFACT"/u)
  assert.doesNotMatch(compat, /TARBALL_SMOKE_SKIP_INSTALL=1/u)
  assert.doesNotMatch(compat, /Prepare DSH dependency environment/u)

  const officialStart = workflow.indexOf('  official-preset-assembly:')
  const ecosystem = workflow.slice(ecosystemStart, officialStart)
  // The published pi2dsh ecosystem is evaluated in BOTH modes: the smoke
  // installs the published DSH and pi2dsh from the registry, so Source Mode
  // no longer skips the gate (pi2dsh@0.24.0 declares DSH 0.1.2-alpha.2).
  assert.doesNotMatch(ecosystem, /needs\.dsh-context\.outputs\.mode == 'npm'/u)
  assert.doesNotMatch(ecosystem, /Download DSH source pack/u)
  assert.doesNotMatch(ecosystem, /Source mode ecosystem status/u)
  assert.match(ecosystem, /Run pi2dsh compatibility smoke/u)
})

test('npm verification rejects a symlinked candidate tarball', () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-npm-candidate-test-'))
  try {
    const target = join(directory, 'external.tgz')
    const candidate = join(directory, 'xmoon76-dsh-pi-tui-0.4.0.tgz')
    writeFileSync(target, 'not a tarball')
    symlinkSync(target, candidate)
    assert.throws(() => npmVerifyCandidateTarball(directory), /expected one TUI candidate/u)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
