/**
 * Static audit for the Source Mode verification rules: AGENTS.md keeps only
 * minimal worktree/verification invariants while docs/local-development.md is
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8')
const localDev = readFileSync(join(ROOT, 'docs', 'local-development.md'), 'utf8')

test('Rule 1: next local development follows the tracked npm/source policy', () => {
  assert.match(agents, /`next` is the\s+forward-integration line and may use its tracked Source Mode/u)
  assert.match(localDev, /next: forward DSH baseline, tracked npm\/source mode/u)
  assert.match(localDev, /When Source Mode is selected, the next worktree reads/u)
})

test('Rule 2: dev:bootstrap reuses the existing per-SHA source pack', () => {
  assert.match(localDev, /reuses a valid per-SHA source pack/u)
  assert.match(localDev, /source-packs\/<exact-sha>/u)
})

test('Rule 3: bootstrap repairs only non-ready environments', () => {
  assert.match(agents, /Use `pnpm dev:bootstrap` only when the environment is not ready\./u)
  assert.match(localDev, /`READY` → reuse the current environment/u)
  assert.match(localDev, /`STALE` \/ `MISSING` \/ `BROKEN` → run `pnpm dev:bootstrap`/u)
})

test('Rule 4: the full source verifier is not routine validation', () => {
  assert.match(agents, /`compat:dsh:source` is a full distribution-boundary verification, not a\s+routine test after ordinary TUI changes\./u)
  assert.match(localDev, /This is the CI-equivalent full Source compatibility proof/u)
  assert.match(localDev, /It is NOT part of the routine daily loop/u)
})
