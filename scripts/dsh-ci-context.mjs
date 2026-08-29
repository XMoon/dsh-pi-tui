#!/usr/bin/env node
/**
 * Resolve the one DSH distribution mode used by a GitHub Actions run.
 *
 * Tags are always npm mode. A push to next and a pull request targeting next
 * use the pinned source pack. All other branches/PR bases use npm mode.
 *
 * @module dsh-ci-context
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_SOURCE_CONFIG, loadDshSourceConfig } from './lib/dsh-distribution.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const ROOT = join(SCRIPT_DIR, '..')
const PI2DSH_MANIFEST = join(ROOT, 'test', 'compat', 'pi2dsh.json')

function fail(message) {
  throw new Error(message)
}

/**
 * Resolve source/npm mode from GitHub event context.
 * @param {{eventName?: string, ref?: string, baseRef?: string, forcedMode?: string}} context
 * @returns {'source'|'npm'}
 */
export function resolveDshMode({ eventName = '', ref = '', baseRef = '', forcedMode } = {}) {
  const tag = ref.startsWith('refs/tags/')
  const computed = tag
    ? 'npm'
    : eventName === 'pull_request' && baseRef === 'next'
      ? 'source'
      : ref === 'refs/heads/next'
        ? 'source'
        : 'npm'
  if (tag && forcedMode === 'source') fail('release tag events must never use DSH source mode')
  if (forcedMode !== undefined && forcedMode !== computed) {
    fail(`forced DSH mode ${forcedMode} disagrees with resolved mode ${computed}`)
  }
  return computed
}

function readTargetVersion() {
  try {
    const manifest = JSON.parse(readFileSync(PI2DSH_MANIFEST, 'utf8'))
    if (typeof manifest.dshVersion === 'string' && manifest.dshVersion !== '') return manifest.dshVersion
  } catch {
    // The source pin remains the fallback if the optional consumer manifest is
    // unavailable in a reduced checkout.
  }
  return undefined
}

/** Resolve and validate all context outputs. */
export function resolveDshContext({ eventName, ref, baseRef, configPath = DEFAULT_SOURCE_CONFIG, forcedMode } = {}) {
  const config = loadDshSourceConfig(configPath)
  const mode = resolveDshMode({ eventName, ref, baseRef, forcedMode })
  return {
    mode,
    version: readTargetVersion() ?? config.expectedVersion,
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
