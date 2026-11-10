#!/usr/bin/env node
/**
 * The ONE quality-gate registry and executor for this repository.
 *
 * `pnpm check:gates` runs every `local-preflight` gate. `mise run check`,
 * the CI Source-checks job and `pnpm verify:release` all invoke that same
 * entry, so a gate cannot be added to one orchestration and silently missed
 * by the other. Every registered gate carries exactly one classification:
 *
 *   - `local-preflight` — routine static/architecture gate. Runs in
 *     `pnpm check:gates`; CI and `verify:release` must not invoke it
 *     directly, or the two lists drift apart again.
 *   - `ci-only` — needs the packed candidate or a CI-runner facility. CI
 *     keeps an independent step for it.
 *   - `on-demand` — targeted diagnostic, not part of the routine preflight
 *     or the CI graph (often already exercised by the tooling suite).
 *
 * Keep the registry as the single list. The rule is documented in AGENTS.md
 * and docs/guides/development.md: add a new gate here, run local-preflight
 * gates only through `pnpm check:gates`, and keep CI's exact packed-candidate
 * source-leak step as the only direct gate step.
 *
 * The executor only spawns the existing atomic commands; no gate logic is
 * reimplemented here.
 * @module run-quality-gates
 */

import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { pnpmExecutable } from './lib/process.mjs'
import { buildSpawnPlan } from './run-with-temp-root.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The single gate registry.
 *
 * The local-preflight order is the pre-push execution order. `runner` picks
 * the existing entry point; `script` is either a `package.json` script name
 * (pnpm) or a repository-relative path (node).
 */
export const QUALITY_GATES = Object.freeze([
  { id: 'gate:boundary', classification: 'local-preflight', runner: 'pnpm', script: 'gate:boundary' },
  { id: 'gate:architecture', classification: 'local-preflight', runner: 'pnpm', script: 'gate:architecture' },
  { id: 'gate:production-reads', classification: 'local-preflight', runner: 'pnpm', script: 'gate:production-reads' },
  { id: 'gate:keybindings', classification: 'local-preflight', runner: 'pnpm', script: 'gate:keybindings' },
  { id: 'gate:installation-doc', classification: 'local-preflight', runner: 'pnpm', script: 'gate:installation-doc' },
  { id: 'gate:pi-surface-compat', classification: 'local-preflight', runner: 'pnpm', script: 'gate:pi-surface-compat' },
  { id: 'scripts/naming-gate.mjs', classification: 'local-preflight', runner: 'node', script: 'scripts/naming-gate.mjs' },
  { id: 'scripts/check-no-session-events.mjs', classification: 'local-preflight', runner: 'node', script: 'scripts/check-no-session-events.mjs' },
  { id: 'gate:pi-divergence-ledger', classification: 'local-preflight', runner: 'pnpm', script: 'gate:pi-divergence-ledger' },
  { id: 'gate:pi-vendor-diff', classification: 'local-preflight', runner: 'pnpm', script: 'gate:pi-vendor-diff', args: ['--strict'] },
  // Needs the packed candidate produced by the CI graph, so it keeps its own
  // Qualify step instead of running in the routine preflight.
  { id: 'gate:source-leak', classification: 'ci-only', runner: 'pnpm', script: 'gate:source-leak' },
  // Targeted diagnostics: NOT part of the routine preflight. The temp-hygiene
  // contract is already enforced by the tooling lane; raw-persistence and
  // preset parity are run when their subsystem is touched.
  { id: 'gate:temp-hygiene', classification: 'on-demand', runner: 'pnpm', script: 'gate:temp-hygiene' },
  { id: 'gate:raw-persistence', classification: 'on-demand', runner: 'pnpm', script: 'gate:raw-persistence' },
  { id: 'gate:dsh-preset-parity', classification: 'on-demand', runner: 'pnpm', script: 'gate:dsh-preset-parity' },
])

/** The gates the shared preflight entry runs, in execution order. */
export function localPreflightGates() {
  return QUALITY_GATES.filter(gate => gate.classification === 'local-preflight')
}

/**
 * The ONLY gate the release path may skip: its exact test file is rerun by
 * `pack:release`'s product suite. No other gate is release-skippable.
 */
const RELEASE_SKIPPABLE_GATE_IDS = new Set(['gate:pi-surface-compat'])

function assertReleaseSkippable(id) {
  if (!RELEASE_SKIPPABLE_GATE_IDS.has(id)) throw new Error(`gate ${id} is not release-skippable`)
  const gate = QUALITY_GATES.find(candidate => candidate.id === id)
  if (gate === undefined || gate.classification !== 'local-preflight') {
    throw new Error(`release-skippable gate ${id} is not a registered local-preflight gate`)
  }
}

/** The argv a gate's existing entry point needs. */
function gateArgv(gate) {
  const executable = gate.runner === 'pnpm' ? pnpmExecutable() : process.execPath
  return [executable, gate.script, ...(gate.args ?? [])]
}

/**
 * Run gates serially, stop at the first failure, and name the failing gate.
 * Returns the process exit code; the CLI entry point assigns it.
 *
 * `spawn` and `log` are injectable so the fail-fast contract is unit-tested
 * without executing real gates.
 */
export function runQualityGates({ gates = localPreflightGates(), skip = new Set(), spawn = spawnSync, log = console.log } = {}) {
  for (const id of skip) assertReleaseSkippable(id)
  const selected = gates.filter(gate => !skip.has(gate.id))
  for (const gate of gates) {
    if (skip.has(gate.id)) log(`quality-gates: skipped ${gate.id}`)
  }
  for (const [index, gate] of selected.entries()) {
    const stage = `${index + 1}/${selected.length} ${gate.id}`
    log(`quality-gates [${stage}]: starting`)
    const plan = buildSpawnPlan(gateArgv(gate))
    const result = spawn(plan.command, plan.args, {
      cwd: ROOT,
      env: process.env,
      shell: plan.shell,
      stdio: 'inherit',
    })
    if (result.error !== undefined) {
      log(`quality-gates [${stage}]: FAIL — ${result.error.message}; remaining gates were not run`)
      return 1
    }
    if (result.status !== 0) {
      const detail = result.status === null ? `signal ${result.signal}` : `exit ${result.status}`
      log(`quality-gates [${stage}]: FAIL (${detail}); remaining gates were not run`)
      return 1
    }
    log(`quality-gates [${stage}]: passed`)
  }
  log(`quality-gates: all ${selected.length} local-preflight gate(s) passed`)
  return 0
}

/** Parse the explicit `--skip <gate-id>` release-path exclusions. */
function parseSkip(rawArgs) {
  // pnpm 12 forwards the `--` separator to the script; strip it.
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs
  const skip = new Set()
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--skip') throw new Error(`unknown argument ${args[index]}`)
    const id = args[index + 1]
    if (id === undefined) throw new Error('--skip requires a gate id')
    assertReleaseSkippable(id)
    skip.add(id)
    index += 1
  }
  return skip
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runQualityGates({ skip: parseSkip(process.argv.slice(2)) })
  } catch (error) {
    console.error(`quality-gates: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
