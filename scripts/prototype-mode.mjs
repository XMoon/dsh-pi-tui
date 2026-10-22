#!/usr/bin/env node
/**
 * Resolve the dependency mode THIS PROTOTYPE RUN uses, and say where the
 * answer came from.
 *
 * The prototype exercises the repository's own resolver, so the resolver
 * stays the default answer. Source Mode, however, cannot be RESOLVED into a
 * workflow that does not live on `next`'s line: `dsh-ci-context.mjs` derives
 * `source` only for a push to `next` (or a PR targeting it) while the tracked
 * policy selects source, and it REFUSES a forced mode that disagrees with
 * that derivation.
 *
 * A Source Mode run therefore needs an entry that is not the resolver, and
 * the Owner approved exactly one (decision B): a committed,
 * prototype-branch-only test entry that selects Source Mode EXPLICITLY and
 * records that it did. Four properties keep it honest:
 *
 *   - it is COMMITTED, so a run cannot differ from the tree it claims;
 *   - it is bound to `refs/heads/ci/pr-pipeline-prototype-*`, so it cannot
 *     turn any other push or pull request into a Source Mode run;
 *   - it reads the pin from `test/compat/dsh-source.json` — the same file the
 *     production resolver reads — so it cannot invent a ref or a version. A
 *     mode-only override would leave `source_ref` empty and the source-pack
 *     job would then build nothing;
 *   - it REFUSES to override a decision the resolver already made. The entry
 *     exists because source is unreachable here, not to mask the resolver.
 *
 * The run states BOTH answers, so an overridden run can never be read as
 * evidence about the production routing.
 *
 * Usage:
 *   node scripts/prototype-mode.mjs --token scripts/prototype-source-mode.txt \
 *     --resolved-mode npm [--ref <refs/heads/...>] [--config <dsh-source.json>]
 *
 * @module @xmoon76/dsh-pi-tui/scripts/prototype-mode
 */

import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

import { DEFAULT_SOURCE_CONFIG, loadDshSourceConfig } from './lib/dsh-distribution.mjs'

/**
 * The two states of the committed switch.
 *
 * The list is CLOSED. An unknown token is a configuration error, not a silent
 * "resolved": a typo would otherwise run the ordinary resolver while the tree
 * says the run is the Source Mode experiment.
 */
export const MODE_TOKENS = ['resolved', 'source']

/** The only branches the test entry may act on. */
export const TEST_ENTRY_REF_PREFIX = 'refs/heads/ci/pr-pipeline-prototype-'

/**
 * Read the committed switch.
 *
 * @param {string} path - the token file.
 * @returns {'resolved'|'source'} the token.
 */
export function readModeToken(path) {
  const token = readFileSync(path, 'utf8').trim()
  if (!MODE_TOKENS.includes(token)) {
    throw new Error(`the committed mode token '${token}' is not one of ${MODE_TOKENS.join('/')}`)
  }
  return token
}

/**
 * Resolve the mode this run uses.
 *
 * `resolved` passes the resolver's own answer through untouched. `source`
 * takes the pin from the tracked Source Mode configuration, and only on a
 * prototype branch.
 *
 * @param {{token: string, resolvedMode: string, resolvedSourceRef?: string, resolvedSourceExpectedVersion?: string, ref: string, configPath?: string}} options
 * @returns {{mode: string, modeOrigin: 'resolver'|'prototype-override', sourceRef: string, sourceExpectedVersion: string}} the mode and its provenance.
 */
export function resolvePrototypeMode({
  token,
  resolvedMode,
  resolvedSourceRef = '',
  resolvedSourceExpectedVersion = '',
  ref,
  configPath = DEFAULT_SOURCE_CONFIG,
}) {
  if (token === 'resolved') {
    return {
      mode: resolvedMode,
      modeOrigin: 'resolver',
      sourceRef: resolvedSourceRef,
      sourceExpectedVersion: resolvedSourceExpectedVersion,
    }
  }
  if (!ref.startsWith(TEST_ENTRY_REF_PREFIX)) {
    throw new Error(`the Source Mode test entry is bound to ${TEST_ENTRY_REF_PREFIX}* branches, but this run is '${ref}'`)
  }
  if (resolvedMode === 'source') {
    throw new Error('the repository resolver already selected source mode: the test entry must not override a decision the production routing made')
  }
  const config = loadDshSourceConfig(configPath)
  return {
    mode: 'source',
    modeOrigin: 'prototype-override',
    sourceRef: config.ref,
    sourceExpectedVersion: config.expectedVersion,
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--') args.shift()
  const { values } = parseArgs({
    args,
    options: {
      token: { type: 'string' },
      'resolved-mode': { type: 'string' },
      'resolved-source-ref': { type: 'string' },
      'resolved-source-expected-version': { type: 'string' },
      ref: { type: 'string' },
      config: { type: 'string' },
    },
    allowPositionals: false,
  })
  if (values.token === undefined) throw new Error('--token is required: the switch is a committed file, never a default')
  if (values['resolved-mode'] === undefined) {
    throw new Error("--resolved-mode is required: the resolver's own answer is part of this run's record")
  }
  const ref = values.ref ?? process.env.GITHUB_REF ?? ''
  const resolvedMode = values['resolved-mode']
  const resolved = resolvePrototypeMode({
    token: readModeToken(values.token),
    resolvedMode,
    resolvedSourceRef: values['resolved-source-ref'] ?? '',
    resolvedSourceExpectedVersion: values['resolved-source-expected-version'] ?? '',
    ref,
    configPath: values.config ?? DEFAULT_SOURCE_CONFIG,
  })
  // The outputs are the machine contract the workflow consumes; the banner
  // below is for the human reading the log.
  const outputPath = process.env.GITHUB_OUTPUT
  if (typeof outputPath !== 'string' || outputPath === '') {
    throw new Error('GITHUB_OUTPUT is not set: this script exists to prepare a JOB, not a shell')
  }
  appendFileSync(outputPath, [
    `mode=${resolved.mode}`,
    `mode_origin=${resolved.modeOrigin}`,
    `source_ref=${resolved.sourceRef}`,
    `source_expected_version=${resolved.sourceExpectedVersion}`,
  ].join('\n') + '\n')

  if (resolved.modeOrigin === 'prototype-override') {
    // Loud on purpose: this run is an EXPERIMENT. Its result says nothing
    // about whether production routing selects Source Mode, and a reader of
    // the log must not have to infer that from a commit diff.
    console.log('PROTOTYPE SOURCE MODE TEST ENTRY')
    console.log(`  production routing : ${resolvedMode} (what the repository resolver decides for ${ref})`)
    console.log('  this run           : source (OVERRIDDEN for this prototype branch)')
    console.log(`  pinned DSH         : ${resolved.sourceRef} (${resolved.sourceExpectedVersion})`)
    console.log('  this run is NOT evidence about the production mode routing')
  }
  console.log(`mode=${resolved.mode}`)
  console.log(`mode_origin=${resolved.modeOrigin}`)
  console.log(`source_ref=${resolved.sourceRef}`)
  console.log(`source_expected_version=${resolved.sourceExpectedVersion}`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`PROTOTYPE_MODE_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
