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

/** Resolve and validate all context outputs. */
export function resolveDshContext({ eventName, ref, baseRef, configPath = DEFAULT_SOURCE_CONFIG, forcedMode, modeConfigPath = MODE_CONFIG } = {}) {
  const config = loadDshSourceConfig(configPath)
  const mode = resolveDshMode({ eventName, ref, baseRef, forcedMode, modeConfigPath })
  return {
    mode,
    version: mode === 'source' ? config.expectedVersion : npmDshVersion(),
    sourceRef: mode === 'source' ? config.ref : '',
    sourceExpectedVersion: mode === 'source' ? config.expectedVersion : '',
    sourceConfig: config.path,
  }
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
  })
  for (const [key, value] of Object.entries({
    mode: context.mode,
    dsh_mode: context.mode,
    version: context.version,
    source_ref: context.sourceRef,
    source_expected_version: context.sourceExpectedVersion,
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
