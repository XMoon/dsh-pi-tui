#!/usr/bin/env node
/**
 * Verify the shipped DSH preset assembly independently of any published
 * consumer bridge. This gate installs only the exact target DSH version, the
 * candidate dsh-pi-tui package, and the durable-header probe, then exercises
 * standard/ptc/minimal/cordis through real Agent/Session creation in tmux.
 *
 * Usage: node scripts/official-presets-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:official-presets -- [path-to-candidate.tgz]
 *
 * Set OFFICIAL_PRESETS_KEEP=1 to preserve the isolated profile on failure.
 * @module official-presets-smoke
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  candidateArgument,
  distributionArgument,
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  readJson,
  requireExactVersion,
  resolveTarball,
  run,
  runDsh,
  runPnpmInstall,
  smokeOfficialPresetMounts,
  validateCandidateTarball,
  validateTargetDshManifest,
  writeHeaderProbePackage,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution } from './lib/dsh-distribution.mjs'
import { pnpmExecutable } from './lib/process.mjs'

const PNPM_COMMAND = pnpmExecutable()
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const MANIFEST_PATH = join(PACKAGE_ROOT, 'test', 'compat', 'pi2dsh.json')

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

async function main() {
  const smokeArgs = process.argv.slice(2)
  const tarball = resolveTarball(candidateArgument(smokeArgs))
  validateCandidateTarball(tarball)
  const manifest = readJson(MANIFEST_PATH, 'compatibility manifest')
  const targetDshVersion = validateTargetDshManifest(manifest)
  const distributionPath = distributionArgument(smokeArgs)
  const distribution = distributionPath === undefined
    ? loadDshDistribution({ mode: 'npm', version: targetDshVersion })
    : loadDshDistribution({ mode: 'source', manifest: resolve(distributionPath), packageJson: join(PACKAGE_ROOT, 'package.json') })
  if (distribution.version !== targetDshVersion) {
    throw new Error(`DSH distribution version mismatch: expected ${targetDshVersion}, got ${distribution.version}`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-official-presets-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const evidencePath = join(workDir, 'evidence.json')
  const env = isolatedEnvironment(workDir, home, dshHome, evidencePath)

  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-official-presets-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': targetDshVersion },
    }, null, 2) + '\n', 'utf8')
    const pnpm = run(PNPM_COMMAND, ['--version'], { cwd: harnessDir, env })
    if (pnpm.status !== 0) throw new Error(`pnpm is unavailable:\n${commandOutput(pnpm)}`)
    runPnpmInstall(harnessDir, env, distribution)

    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0) throw new Error(`installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion('DSH', commandOutput(version).split(/\r?\n/u).find(line => line.trim() !== '')?.trim(), targetDshVersion)

    installPlugin(dsh, tarball, harnessDir, env, false)
    installPlugin(dsh, writeHeaderProbePackage(workDir), harnessDir, env, false)
    await smokeOfficialPresetMounts(dsh, workDir, env)
    console.log(`official preset assembly smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } finally {
    if (process.env.OFFICIAL_PRESETS_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved official preset environment: ${workDir}`)
  }
}

main().catch(error => {
  console.error(`OFFICIAL_PRESETS_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
