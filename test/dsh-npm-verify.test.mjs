import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { npmVerificationEnvironment } from '../scripts/dsh-npm-verify.mjs'

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
  assert.equal((workflow.match(/pnpm install --frozen-lockfile/gu) ?? []).length, 5)
  assert.equal((workflow.match(/NPM_CONFIG_REGISTRY=https:\/\/registry\.npmjs\.org\//gu) ?? []).length, 5)
  assert.equal((workflow.match(/NPM_CONFIG_USERCONFIG="\$RUNNER_TEMP\/dsh-npmrc"/gu) ?? []).length, 5)
  assert.equal((workflow.match(/npm_config_userconfig="\$RUNNER_TEMP\/dsh-npmrc"/gu) ?? []).length, 5)
})
