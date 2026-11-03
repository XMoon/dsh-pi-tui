/**
 * Static audit for the Source Mode verification rules: AGENTS.md keeps only
 * minimal worktree/verification invariants while docs/guides/development.md is
 * the canonical detailed policy. The next worktree follows its tracked
 * npm/source policy, materializes the pinned Source environment when Source
 * Mode is selected, a READY environment is reused, and ordinary TUI changes
 * must not routinely trigger the full `compat:dsh:source` verifier. The CI
 * mode contract (next follows its tracked policy, release tags = npm Mode) is
 * NOT re-tested here — it is authoritatively covered at function level by
 * dsh-ci-context.test.mjs.
 * @module @xmoon76/dsh-pi-tui/source-mode-rules.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
const localDev = readFileSync(join(ROOT, 'docs', 'guides', 'development.md'), 'utf8')

test('Rule 1: next local development follows the tracked npm/source policy', () => {
  assert.match(agents, /`next` is the\s+forward-integration line and may use its tracked Source Mode/u)
  assert.match(localDev, /forward-integration line, tracked npm\/source mode/u)
  assert.match(localDev, /Source mode reads the repository and exact\s+40-character commit/u)
})

test('Rule 2: dev:bootstrap reuses the existing per-SHA source pack', () => {
  assert.match(localDev, /Bootstrap reuses a valid pack for the exact SHA/u)
  assert.match(localDev, /source-packs\/<exact-sha>/u)
})

test('Rule 3: bootstrap repairs only non-ready environments', () => {
  assert.match(agents, /must not run `mise run setup`/u)
  assert.match(agents, /mise run source:doctor[\s\S]*?mise run source:bootstrap/u)
  assert.match(localDev, /read-only diagnostic \(`READY`, `STALE`, `MISSING`\s+or `BROKEN`\)/u)
  assert.match(localDev, /For\s+every non-ready source result[\s\S]*?mise run source:bootstrap/u)
})

test('Rule 4: the full source verifier is not routine validation', () => {
  assert.match(agents, /`compat:dsh:source` is a full distribution-boundary verification, not a\s+routine test after ordinary TUI changes\./u)
  assert.match(localDev, /This is the CI-equivalent full Source compatibility proof/u)
  assert.match(localDev, /It is NOT part of the routine loop/u)
})
