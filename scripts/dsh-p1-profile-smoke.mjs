#!/usr/bin/env node
/**
 * RC2 P1 isolated-profile smoke: the candidate bundle composes the official
 * job-controller row in a REAL DSH 0.1.7-rc.2 profile, and the TUI's
 * non-consuming observation contract holds against the real `LocalJobRegistry`.
 *
 * A probe bundle installed beside the candidate asserts, inside the running
 * profile:
 *   - `ctx.jobController` exists (proving the pi-tui `cordis.patch.yml`
 *     job-controller row actually composed);
 *   - `JobController.follow()` opens for a real registered Job;
 *   - reading through `follow()` did NOT advance the model-facing
 *     `ctx.jobs.read()` cursor (observation is non-consuming).
 *
 * Usage: node scripts/dsh-p1-profile-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:p1-profile -- [path-to-candidate.tgz]
 *
 * Set DSH_P1_PROFILE_KEEP=1 to preserve the isolated profile on failure.
 * @module dsh-p1-profile-smoke
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

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
const EVIDENCE_ENV = 'PI2DSH_P1_PROFILE_EVIDENCE'
const BOOT_TIMEOUT_MS = 120_000

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

function fail(phase, message) {
  throw Object.assign(new Error(message), { phase })
}

function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function waitUntil(label, timeoutMs, probe, phase) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await probe()
    if (last) return last
    await new Promise(resolveDelay => setTimeout(resolveDelay, 250))
  }
  fail(phase, `${label} timed out after ${timeoutMs}ms`)
}

/** The probe bundle: no production row, installed only into the isolated profile. */
function writeJobProbePackage(workDir) {
  const packageName = 'dsh-pi-tui-p1-job-probe'
  const probeDir = join(workDir, 'job-probe')
  mkdirSync(probeDir, { recursive: true })
  writeFileSync(join(probeDir, 'package.json'), JSON.stringify({
    name: packageName,
    version: '0.0.0',
    type: 'module',
    main: 'index.mjs',
    exports: { '.': './index.mjs' },
    files: ['index.mjs', 'cordis.patch.yml'],
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2) + '\n', 'utf8')
  writeFileSync(join(probeDir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: dsh-pi-tui-p1-job-probe',
    `      name: '${packageName}'`,
    "      inject: ['jobs', 'jobController']",
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(probeDir, 'index.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    '',
    `const evidencePath = process.env.${EVIDENCE_ENV}`,
    'function writeEvidence(value) {',
    "  if (typeof evidencePath !== 'string' || evidencePath.length === 0) return",
    "  writeFileSync(evidencePath, JSON.stringify(value, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 })",
    '}',
    '',
    `export const name = '${packageName}'`,
    "export const inject = ['jobs', 'jobController']",
    '',
    'export function apply(ctx) {',
    '  void (async () => {',
    '    try {',
    "      const jobs = ctx.get('jobs')",
    "      const controller = ctx.get('jobController')",
    "      if (jobs === undefined || controller === undefined) {",
    "        writeEvidence({ error: 'jobs or jobController service unavailable' })",
    '        return',
    '      }',
    '      // The registry requires a controller for the calling scope (the',
    '      // official tool-jobs row normally attaches one); the probe owns its',
    '      // own scratch controller so it can register a real Job.',
    "      jobs.attachController('p1-profile-smoke')",
    '      let handle',
    '      let settle',
    '      const jobId = jobs.start({',
    "        kind: 'bash',",
    "        label: 'p1 profile job smoke',",
    '        run: (job) => {',
    '          handle = job',
    '          return {',
    '            cancel: () => { settle?.({ status: \'killed\' }) },',
    '            done: new Promise(resolveDone => { settle = resolveDone }),',
    '          }',
    '        },',
    '      })',
    "      handle.append('probe line one\\n')",
    "      handle.append('probe line two\\n')",
    '      const frames = []',
    "      let observed = ''",
    '      let settled = false',
    '      const abort = new AbortController()',
    '      const iterator = controller.follow({ jobId: String(jobId) }, abort.signal)[Symbol.asyncIterator]()',
    '      let guard = 0',
    '      while (guard++ < 40) {',
    '        const step = await iterator.next()',
    '        if (step.done) break',
    '        const frame = step.value',
    '        frames.push(frame.type)',
    "        if (frame.type === 'output') {",
    '          for (const chunk of frame.chunks ?? []) observed += chunk.text',
    "          if (!settled) { settled = true; settle?.({ status: 'completed', result: 'ok' }) }",
    '        }',
    "        if (frame.type === 'status' && ['completed', 'killed', 'failed'].includes(frame.job?.status)) break",
    '      }',
    '      abort.abort()',
    '      try { await iterator.next() } catch { /* stream closed */ }',
    '      const read = jobs.read(jobId)',
    '      const readText = (read.chunks ?? []).map(chunk => chunk.text).join(\'\')',
    '      writeEvidence({',
    '        jobController: true,',
    '        followFrames: frames,',
    "        followSawProbe: observed.includes('probe line two'),",
    "        modelReadSawProbe: readText.includes('probe line two'),",
    '        modelReadText: readText,',
    '        nonConsuming: readText.includes(\'probe line two\'),',
    '      })',
    '    } catch (error) {',
    "      writeEvidence({ error: error instanceof Error ? error.message : String(error) })",
    '    }',
    '  })()',
    '}',
    '',
  ].join('\n'), 'utf8')
  return probeDir
}

function writeP1Launcher(path, invocation, env) {
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `export HOME=${shellQuote(env.HOME)}`,
    `export DSH_HOME=${shellQuote(env.DSH_HOME)}`,
    `export ${EVIDENCE_ENV}=${shellQuote(env[EVIDENCE_ENV])}`,
    `export npm_config_registry=${shellQuote(env.npm_config_registry)}`,
    `export NPM_CONFIG_REGISTRY=${shellQuote(env.NPM_CONFIG_REGISTRY)}`,
    `export npm_config_minimum_release_age=${shellQuote(env.npm_config_minimum_release_age)}`,
    `export pnpm_config_minimum_release_age=${shellQuote(env.pnpm_config_minimum_release_age)}`,
    `export npm_config_userconfig=${shellQuote(env.npm_config_userconfig)}`,
    `export NPM_CONFIG_USERCONFIG=${shellQuote(env.NPM_CONFIG_USERCONFIG)}`,
    'export TERM="${TERM:-xterm-256color}"',
    `exec ${invocation.map(shellQuote).join(' ')} --profile pi-tui`,
    '',
  ]
  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o700 })
}

async function main() {
  const args = process.argv.slice(2)
  const tarball = resolveTarball(candidateArgument(args))
  validateCandidateTarball(tarball)
  const targetDshVersion = npmDshVersion()
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-p1-profile-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  for (const dir of [home, dshHome, harnessDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')
  const evidencePath = join(workDir, 'job-evidence.json')
  const env = {
    ...isolatedEnvironment(workDir, home, dshHome, join(workDir, 'compat-evidence.json')),
    [EVIDENCE_ENV]: evidencePath,
  }

  const socket = `dsh-p1-profile-${process.pid}`
  const session = `p1-profile-${process.pid}`
  let tmux
  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-p1-profile-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': targetDshVersion },
    }, null, 2) + '\n', 'utf8')
    const pnpm = run(PNPM_COMMAND, ['--version'], { cwd: harnessDir, env })
    if (pnpm.status !== 0) fail('INFRA_INSTALL_FAILURE', `pnpm is unavailable:\n${commandOutput(pnpm)}`)
    runPnpmInstall(harnessDir, env, loadDshDistribution({ mode: 'npm', version: targetDshVersion }))

    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0) fail('INFRA_INSTALL_FAILURE', `installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion(
      'DSH',
      commandOutput(version).split(/\r?\n/u).find(line => line.trim() !== '')?.trim(),
      targetDshVersion,
    )

    installPlugin(dsh, tarball, harnessDir, env, false)
    installPlugin(dsh, writeJobProbePackage(workDir), harnessDir, env, false)

    const launcher = join(workDir, 'run-p1-profile.sh')
    writeP1Launcher(launcher, dsh, env)
    const tuiLog = join(workDir, 'p1-profile.tui.log')
    const started = run('tmux', [
      'new-session', '-d', '-s', session, '-x', '100', '-y', '30',
      `script -qefc ${shellQuote(launcher)} ${shellQuote(tuiLog)}`,
    ], { cwd: workDir, env })
    if (started.status !== 0) fail('P1_PROFILE_BOOT_FAILURE', `TUI could not start:\n${commandOutput(started)}`)
    tmux = {
      capture: () => commandOutput(run('tmux', ['capture-pane', '-p', '-t', session], { env })),
      has: () => run('tmux', ['has-session', '-t', session], { env }).status === 0,
      send: (text) => { run('tmux', ['send-keys', '-t', session, text], { env }) },
      stop: () => { run('tmux', ['kill-session', '-t', session], { env }) },
    }

    await waitUntil('P1 profile boot', BOOT_TIMEOUT_MS, () => tmux.has() && tmux.capture().includes('❯'), 'P1_PROFILE_BOOT_FAILURE')
    const evidence = await waitUntil('job-controller probe evidence', BOOT_TIMEOUT_MS, () => {
      const value = readOptionalJson(evidencePath)
      if (value?.error !== undefined) fail('P1_PROFILE_PROBE_FAILURE', `job probe failed: ${String(value.error)}`)
      return value
    }, 'P1_PROFILE_PROBE_FAILURE')

    if (evidence.jobController !== true) fail('P1_PROFILE_PROBE_FAILURE', 'ctx.jobController was not composed')
    if (!evidence.followSawProbe) fail('P1_PROFILE_PROBE_FAILURE', `follow() did not observe the job output: ${JSON.stringify(evidence)}`)
    if (!evidence.nonConsuming || !evidence.modelReadSawProbe) {
      fail('P1_PROFILE_PROBE_FAILURE', `observation was consuming: ${JSON.stringify(evidence)}`)
    }
    if (!evidence.followFrames.includes('opened')) fail('P1_PROFILE_PROBE_FAILURE', 'follow() never opened a frame')

    tmux.send('/exit')
    await new Promise(resolveDelay => setTimeout(resolveDelay, 600))
    tmux.send('Enter')
    await waitUntil('P1 profile exit', 30_000, () => !tmux.has(), 'P1_PROFILE_DISPOSE_FAILURE')
    console.log(`P1 isolated-profile smoke passed — ${basename(tarball)} × DSH ${targetDshVersion} (job-controller composed, follow non-consuming)`)
  } finally {
    tmux?.stop()
    if (process.env.DSH_P1_PROFILE_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved P1 profile environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch(error => {
    console.error(`DSH_P1_PROFILE_FAILURE[${error?.phase ?? 'UNKNOWN'}]: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
