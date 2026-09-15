#!/usr/bin/env node
/**
 * Verify the TUI-owned startup strictness handshake on DSH 0.1.6.
 *
 * 0.1.6 app-boot fails fast only for the launcher's OWN required entry ids;
 * every other inactive or failed entry is an OPTIONAL warning and healthy
 * siblings continue. Because `--profile pi-tui` explicitly asks for the TUI
 * surface, the bundle must exit nonzero when the `tui-app` row never mounts.
 *
 * This smoke installs the candidate into an isolated profile, disables the
 * `tui-app` row through the profile's own user patch layer, runs the REAL CLI
 * with stdin at EOF, and requires a nonzero exit that names the missing
 * surface — never a silent success, a warning-only success, or a lingering
 * process. It fails against a bundle that does not own this strictness.
 *
 * Usage: node scripts/startup-strictness-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:startup-strictness -- [path-to-candidate.tgz]
 *
 * Set STARTUP_STRICTNESS_KEEP=1 to preserve the isolated profile on failure.
 * @module startup-strictness-smoke
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  candidateArgument,
  dshInvocation,
  installPlugin,
  isolatedEnvironment,
  requireExactVersion,
  resolveTarball,
  run,
  runDsh,
  runPnpmInstall,
  validateCandidateTarball,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution, npmDshVersion } from './lib/dsh-distribution.mjs'
import { pnpmExecutable } from './lib/process.mjs'

const PNPM_COMMAND = pnpmExecutable()
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')

/** The exact error the startup handshake prints for a missing surface. */
const MISSING_SURFACE_MARKER = 'required TUI surface did not mount'

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

/** Append the `tui-app` disable row to the profile's own user patch layer. */
function disableTuiAppRow(profileDir) {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const existing = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  // The installed profile template is a comment header followed by an EXPLICIT
  // empty array (`[]`); a top-level sequence item cannot follow it, so drop
  // that placeholder before appending the disable row.
  const body = existing.split('\n').filter(line => line.trim() !== '[]').join('\n')
  const separator = body === '' || body.endsWith('\n') ? '' : '\n'
  writeFileSync(patchPath, `${body}${separator}- id: tui-app\n  disabled: true\n`, 'utf8')
}

/** Run the real CLI with stdin at EOF so a mounted surface would exit on its own. */
function runCliToCompletion(dsh, cwd, env, timeoutMs) {
  return spawnSync(dsh[0], [...dsh.slice(1), '--profile', 'pi-tui'], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  })
}

async function main() {
  const tarball = resolveTarball(candidateArgument(process.argv.slice(2)))
  validateCandidateTarball(tarball)
  const targetDshVersion = npmDshVersion()
  const distribution = loadDshDistribution({ mode: 'npm', version: targetDshVersion })
  if (distribution.version !== targetDshVersion) {
    throw new Error(`DSH distribution version mismatch: expected ${targetDshVersion}, got ${distribution.version}`)
  }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-startup-strictness-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  mkdirSync(home, { recursive: true })
  mkdirSync(dshHome, { recursive: true })
  mkdirSync(harnessDir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'evidence.json'))

  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-startup-strictness-harness',
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
    disableTuiAppRow(join(dshHome, 'profiles', 'pi-tui'))

    // The CLI must exit BY ITSELF with a nonzero code: a lingering process is
    // as much a failure as a silent success.
    const result = runCliToCompletion(dsh, harnessDir, env, 120_000)
    const output = commandOutput(result)
    if (result.error !== undefined) {
      throw new Error(`the CLI did not exit on its own (${result.error.message}):\n${output}`)
    }
    if (result.status === 0) {
      throw new Error(`expected a nonzero exit for a missing tui-app surface, got 0:\n${output}`)
    }
    if (!output.includes(MISSING_SURFACE_MARKER)) {
      throw new Error(`the missing-surface error was not printed:\n${output}`)
    }
    console.log(`startup strictness smoke passed — ${basename(tarball)} × DSH ${targetDshVersion} (exit ${result.status})`)
  } finally {
    if (process.env.STARTUP_STRICTNESS_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved startup strictness environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`STARTUP_STRICTNESS_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
