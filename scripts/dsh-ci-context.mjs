#!/usr/bin/env node
/**
 * Resolve the one DSH distribution mode used by a GitHub Actions run.
 *
 * Tags are always npm mode. A push to next and a pull request targeting
 * next follow the TRACKED branch-level mode policy
 * (test/compat/dsh-mode.json) — one line flips the whole branch between
 * the pinned source pack and the registry-backed npm distribution. All
 * other branches/PR bases use npm mode. Source Mode reads its version from
 * test/compat/dsh-source.json; npm Mode reads the exact DSH version declared
 * in this checkout's package.json. The pi2dsh manifest is an external
 * consumer pairing and is not a CI target-version source.
 *
 * @module dsh-ci-context
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_SOURCE_CONFIG, loadDshSourceConfig, npmDshVersion } from './lib/dsh-distribution.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SCRIPT_DIR, '..')
const MODE_CONFIG = join(ROOT, 'test', 'compat', 'dsh-mode.json')

function fail(message) {
  throw new Error(message)
}

/**
 * Read the tracked branch-level DSH mode policy. The file is the SINGLE
 * source of truth for next's distribution; a missing or malformed file
 * is an explicit error (next always carries it).
 * @param {string} path - the mode-config path (injectable for tests).
 * @returns {'source'|'npm'}
 */
export function readTrackedMode(path = MODE_CONFIG) {
  if (!existsSync(path)) fail(`DSH mode config is missing: ${path}`)
  let value
  try {
    value = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`DSH mode config could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('DSH mode config must be an object')
  if (value.schemaVersion !== 1) fail(`unsupported DSH mode config schema ${JSON.stringify(value.schemaVersion)}`)
  const mode = value.mode
  if (mode !== 'source' && mode !== 'npm') {
    fail(`unsupported DSH mode ${JSON.stringify(mode)}; expected source or npm`)
  }
  return mode
}

/**
 * Resolve source/npm mode from GitHub event context.
 * @param {{eventName?: string, ref?: string, baseRef?: string, forcedMode?: string, modeConfigPath?: string}} context
 * @returns {'source'|'npm'}
 */
export function resolveDshMode({ eventName = '', ref = '', baseRef = '', forcedMode, modeConfigPath = MODE_CONFIG } = {}) {
  const tag = ref.startsWith('refs/tags/')
  const isNext = (eventName === 'pull_request' && baseRef === 'next')
    || (eventName === 'push' && ref === 'refs/heads/next')
  const computed = tag
    ? 'npm'
    : isNext
      ? readTrackedMode(modeConfigPath)
      : 'npm'
  if (tag && forcedMode === 'source') fail('release tag events must never use DSH source mode')
  if (forcedMode !== undefined && forcedMode !== computed) {
    fail(`forced DSH mode ${forcedMode} disagrees with resolved mode ${computed}`)
  }
  return computed
}

/**
 * The GitHub Actions variables that shape the accelerated DAG.
 *
 * Three DIMENSIONS, and they are not interchangeable:
 *
 *   - `CI_PRODUCT_SHARDS` — how many pieces the product lane is cut into;
 *   - `CI_PRODUCT_MAX_PARALLEL` — how many of those pieces may run at once
 *     (the matrix cap). A cap larger than the shard count is allowed and
 *     simply means "no extra throttling";
 *   - `CI_PRODUCT_TEST_CONCURRENCY` — Node's OWN `--test-concurrency` INSIDE
 *     one shard.
 *
 * The defaults are the measured configuration. An ABSENT variable is the
 * default; an EMPTY one is the default too (Actions renders an unset `vars`
 * entry as an empty string); a NONEMPTY INVALID one is a configuration error
 * that must fail BEFORE anything is built. A silently defaulted typo would
 * run a shape nobody chose and report it as the requested one.
 */
export const CI_CONFIG_DEFAULTS = { shards: 4, maxParallel: 4, testConcurrency: 'default' }

/** The accepted ranges, inclusive. */
export const CI_CONFIG_RANGES = { shards: [1, 4], maxParallel: [1, 4], testConcurrency: [1, 8] }

/**
 * Parse one bounded integer variable.
 *
 * @param {string} name - the variable name, for the message.
 * @param {string|undefined} raw - the raw value (absent and empty both mean "default").
 * @param {number} fallback - the default.
 * @param {[number, number]} range - the inclusive accepted range.
 * @returns {number} the level.
 */
function integerVariable(name, raw, fallback, [min, max]) {
  const text = (raw ?? '').trim()
  if (text === '') return fallback
  if (!/^\d+$/u.test(text)) fail(`${name} must be a whole number between ${min} and ${max}, got ${JSON.stringify(text)}`)
  const value = Number(text)
  if (value < min || value > max) fail(`${name} must be between ${min} and ${max}, got ${value}`)
  return value
}

/**
 * Resolve the accelerated DAG's shape.
 *
 * The shard INDEX LIST is derived here, once, so every consumer reads the
 * same partition: a matrix built from one value and an aggregate from another
 * would disagree about what "all shards" means.
 *
 * `default` concurrency is preserved as the STRING `default`, never translated
 * into a core count: the runner omits Node's flag and Node uses
 * `os.availableParallelism()`, which is what the measured configuration is.
 *
 * @param {{shards?: string, maxParallel?: string, testConcurrency?: string}} raw - the raw variables.
 * @returns {{shardTotal: number, shards: number[], maxParallel: number, testConcurrency: string}} the shape.
 */
export function resolveCiConfig({ shards, maxParallel, testConcurrency } = {}) {
  const shardTotal = integerVariable('CI_PRODUCT_SHARDS', shards, CI_CONFIG_DEFAULTS.shards, CI_CONFIG_RANGES.shards)
  const parallel = integerVariable('CI_PRODUCT_MAX_PARALLEL', maxParallel, CI_CONFIG_DEFAULTS.maxParallel, CI_CONFIG_RANGES.maxParallel)
  const level = (testConcurrency ?? '').trim()
  const testLevel = level === '' || level === 'default'
    ? CI_CONFIG_DEFAULTS.testConcurrency
    : String(integerVariable('CI_PRODUCT_TEST_CONCURRENCY', level, Number.NaN, CI_CONFIG_RANGES.testConcurrency))
  return {
    shardTotal,
    shards: Array.from({ length: shardTotal }, (_, index) => index + 1),
    maxParallel: parallel,
    testConcurrency: testLevel,
  }
}

/** Resolve and validate all context outputs. */
export function resolveDshContext({
  eventName,
  ref,
  baseRef,
  configPath = DEFAULT_SOURCE_CONFIG,
  forcedMode,
  modeConfigPath = MODE_CONFIG,
  ciConfig = {},
} = {}) {
  const config = loadDshSourceConfig(configPath)
  const mode = resolveDshMode({ eventName, ref, baseRef, forcedMode, modeConfigPath })
  const ci = resolveCiConfig(ciConfig)
  return {
    mode,
    version: mode === 'source' ? config.expectedVersion : npmDshVersion(),
    sourceRef: mode === 'source' ? config.ref : '',
    sourceExpectedVersion: mode === 'source' ? config.expectedVersion : '',
    sourceConfig: config.path,
    ci,
  }
}

/** The one-line record of the shape this run uses. */
function effectiveConfig(context) {
  return [
    `mode=${context.mode}`,
    `shards=${context.ci.shardTotal}`,
    `max_parallel=${context.ci.maxParallel}`,
    `test_concurrency=${context.ci.testConcurrency}`,
  ].join(' ')
}

function writeOutputs(context) {
  const outputPath = process.env.GITHUB_OUTPUT
  if (typeof outputPath !== 'string' || outputPath === '') return
  appendFileSync(outputPath, [
    `mode=${context.mode}`,
    `dsh_mode=${context.mode}`,
    `version=${context.version}`,
    `source_ref=${context.sourceRef}`,
    `source_expected_version=${context.sourceExpectedVersion}`,
    `shard_total=${context.ci.shardTotal}`,
    `shards=${JSON.stringify(context.ci.shards)}`,
    `max_parallel=${context.ci.maxParallel}`,
    `test_concurrency=${context.ci.testConcurrency}`,
    `effective_config=${effectiveConfig(context)}`,
  ].join('\n') + '\n')
}

function cli() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      event: { type: 'string' },
      ref: { type: 'string' },
      'base-ref': { type: 'string' },
      config: { type: 'string' },
      'force-mode': { type: 'string' },
    },
    allowPositionals: false,
  })
  const eventName = values.event ?? process.env.GITHUB_EVENT_NAME ?? ''
  const ref = values.ref ?? process.env.GITHUB_REF ?? ''
  const baseRef = values['base-ref'] ?? process.env.GITHUB_BASE_REF ?? ''
  if (eventName === '' || ref === '') fail('--event and --ref are required (or set GITHUB_EVENT_NAME/GITHUB_REF)')
  const context = resolveDshContext({
    eventName,
    ref,
    baseRef,
    configPath: values.config ?? DEFAULT_SOURCE_CONFIG,
    forcedMode: values['force-mode'],
    // The variables come from the environment the job passes them in, never
    // from `${{ }}` interpolation into shell source.
    ciConfig: {
      shards: process.env.CI_PRODUCT_SHARDS,
      maxParallel: process.env.CI_PRODUCT_MAX_PARALLEL,
      testConcurrency: process.env.CI_PRODUCT_TEST_CONCURRENCY,
    },
  })
  for (const [key, value] of Object.entries({
    mode: context.mode,
    dsh_mode: context.mode,
    version: context.version,
    source_ref: context.sourceRef,
    source_expected_version: context.sourceExpectedVersion,
    shard_total: context.ci.shardTotal,
    shards: JSON.stringify(context.ci.shards),
    max_parallel: context.ci.maxParallel,
    test_concurrency: context.ci.testConcurrency,
    effective_config: effectiveConfig(context),
  })) console.log(`${key}=${value}`)
  writeOutputs(context)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    cli()
  } catch (error) {
    console.error(`DSH_CONTEXT_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
