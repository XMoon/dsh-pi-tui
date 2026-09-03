/**
 * Static audit for the Source Mode verification rules (AGENTS.md "DSH
 * development environment" + docs/local-development.md): the next worktree
 * follows its tracked npm/source policy, materializes the pinned Source
 * environment when Source Mode is selected, a READY environment is reused,
 * and ordinary TUI changes must not routinely trigger the full
 * `compat:dsh:source` verifier. The CI mode contract (next follows its
 * tracked policy, release tags = npm Mode) is NOT re-tested here — it is
 * authoritatively covered at function level by dsh-ci-context.test.mjs.
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

test('Rule 1: next local development follows the tracked npm/source policy', () => {
  assert.match(agents, /dsh-pi-tui-next.*forward DSH baseline in its tracked\s+npm or Source Mode/u)
  assert.match(localDev, /next: forward DSH baseline, tracked npm\/source mode/u)
  assert.match(localDev, /When Source Mode is selected, the next worktree reads/u)
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
