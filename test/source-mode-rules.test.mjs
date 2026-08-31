/**
 * Static audit for the Source Mode verification rules (AGENTS.md "DSH
 * development environment" + docs/local-development.md): the next worktree
 * stays on the pinned Source development environment, a READY environment is
 * reused, ordinary TUI changes must not routinely trigger the full
 * `compat:dsh:source` verifier, and the CI lanes (PR/push to next = Source
 * Mode, release tags = npm Mode) stay intact. The mode resolver itself is
 * unit-tested in dsh-ci-context.test.mjs; this file guards the documented
 * rules and the workflow lanes against regression.
 * @module @xmoon76/dsh-pi-tui/source-mode-rules.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
const localDev = readFileSync(join(ROOT, 'docs', 'local-development.md'), 'utf8')
const ciWorkflow = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

test('Rule 1: next local development stays on the pinned Source development environment', () => {
  assert.match(agents, /dsh-pi-tui-next.*exact source distribution pinned by/u)
  assert.match(localDev, /next: pinned DSH source distribution \(source mode\)/u)
})

test('Rule 2: dev:bootstrap reuses the existing per-SHA source pack', () => {
  assert.match(localDev, /reuses a valid per-SHA source pack/u)
  assert.match(localDev, /source-packs\/<exact-sha>/u)
  assert.match(agents, /reuses a\s+valid per-SHA source pack/u)
})

test('Rule 3: AGENTS.md requires reusing a READY source development environment', () => {
  assert.match(agents, /If `pnpm dev:doctor` reports READY, reuse that environment\./u)
})

test('Rule 4: AGENTS.md forbids routine compat:dsh:source after ordinary TUI changes', () => {
  assert.match(agents, /Do NOT run `pnpm compat:dsh:source` as a routine validation step after\s+ordinary TUI changes\./u)
  assert.match(agents, /Full `compat:dsh:source` is a CI-equivalent compatibility proof/u)
})

test('Rule 5: PR/push to next CI keeps the full Source Mode lane', () => {
  assert.match(ciWorkflow, /prepare-dsh-source/u)
  assert.match(ciWorkflow, /mode == 'source'/u)
  assert.match(ciWorkflow, /- next/u)
})

test('Rule 6: release tags keep npm Mode', () => {
  assert.match(ciWorkflow, /next-v\*/u)
  assert.match(ciWorkflow, /npm_tag/u)
  assert.match(ciWorkflow, /refs\/tags\//u)
})
