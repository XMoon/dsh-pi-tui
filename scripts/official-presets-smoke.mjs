#!/usr/bin/env node
/**
 * Verify the shipped DSH preset assembly independently of any published
 * consumer bridge. Source Mode installs the supplied pinned source pack; npm
 * Mode installs the exact DSH version declared by this checkout's package.json.
 * The gate then installs the candidate dsh-pi-tui package and durable-header
 * probe, and exercises standard/ptc/minimal/cordis through real Agent/Session
 * creation in tmux.
 *
 * This entry also owns every official-preset assertion: the preset catalog and
 * status checks, degradation detection and the real PTY matrix live here, not
 * in a consumer smoke that merely happens to run them.
 *
 * Usage: node scripts/official-presets-smoke.mjs [path-to-candidate.tgz]
 *        pnpm smoke:official-presets -- [path-to-candidate.tgz]
 *
 * Set OFFICIAL_PRESETS_KEEP=1 to preserve the isolated profile on failure.
 * @module official-presets-smoke
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  assertNoCompatibilityFailures,
  candidateArgument,
  CompatFailure,
  delay,
  distributionArgument,
  dshInvocation,
  fail,
  installPlugin,
  isolatedEnvironment,
  PNPM_COMMAND,
  readOptionalJson,
  readText,
  redact,
  resultText,
  requireExactVersion,
  resolveTarball,
  run,
  runDsh,
  runPnpmInstall,
  shellQuote,
  tail,
  TIMEOUTS,
  tmuxRunner,
  validateCandidateTarball,
  waitUntil,
  writeHeaderProbePackage,
  writeLauncher,
  writePromptQualificationPackage,
} from './lib/dsh-smoke-harness.mjs'
import {
  DEFAULT_SOURCE_CONFIG,
  loadDshDistribution,
  loadDshSourceConfig,
  npmDshVersion,
  PACKAGE_ROOT,
  validateDshSourceConfig,
} from './lib/dsh-distribution.mjs'

const OFFICIAL_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis']

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function optionValue(args, option) {
  const index = args.indexOf(option)
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${option} requires a value`)
  return value
}

/** Return the single DSH version currently validated by this checkout. */
export function currentValidatedDshVersion(configPath = DEFAULT_SOURCE_CONFIG) {
  return loadDshSourceConfig(configPath).expectedVersion
}

export function sourceConfigForArgs(args, defaultConfig = DEFAULT_SOURCE_CONFIG) {
  const distributionPath = distributionArgument(args)
  const ref = optionValue(args, '--ref')
  const expectedVersion = optionValue(args, '--expected-version')
  const configPath = optionValue(args, '--config')
  if (distributionPath === undefined) {
    if (ref !== undefined || expectedVersion !== undefined || configPath !== undefined) {
      throw new Error('--ref, --expected-version, and --config require --distribution')
    }
    return undefined
  }
  const tracked = loadDshSourceConfig(configPath ?? defaultConfig)
  return validateDshSourceConfig({
    ...tracked,
    ref: ref ?? tracked.ref,
    expectedVersion: expectedVersion ?? tracked.expectedVersion,
  }, tracked.path)
}

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu
const CURSOR_MARKER = /\u001b_pi:c\u0007/gu

function stripTerminalControl(text) {
  return String(text).replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CURSOR_MARKER, '')
}

function roundedFrameBodies(pane) {
  const lines = stripTerminalControl(pane).split(/\r?\n/u)
  const bodies = []
  for (let start = 0; start < lines.length; start += 1) {
    const left = lines[start].indexOf('╭')
    if (left < 0) continue
    const right = lines[start].indexOf('╮', left + 1)
    if (right < 0) continue
    const width = right - left + 1
    const end = lines.findIndex((line, index) => index > start
      && line[left] === '╰'
      && line.slice(left, left + width).includes('╯'))
    if (end >= 0) {
      // Overlays are composited over the host frame. Keep only the columns
      // belonging to this box; otherwise stale host text such as `/help`
      // becomes indistinguishable from the filtered command rows.
      bodies.push(lines.slice(start + 1, end).map(line => line.slice(left, left + width)))
    }
  }
  return bodies
}

function roundedFrameBody(pane) {
  const text = stripTerminalControl(pane)
  const lines = text.split(/\r?\n/u)
  const bodies = roundedFrameBodies(text)
  // A later frame can be partially clipped while a settings frame remains
  // visible. Select the frame by its semantic hint instead of letting an
  // unrelated trailing border hide the command catalog.
  const semantic = bodies.findLast(body => body.some(line => line.includes('Type to search')))
  if (semantic !== undefined) return semantic

  // Some terminal captures clip a frame border at the viewport edge. The
  // settings hint is still an unambiguous anchor, so retain the visible frame
  // body up to that line, preserving the overlay's horizontal slice when its
  // top border is available.
  const hint = lines.findLastIndex(line => line.includes('Type to search'))
  if (hint >= 0) {
    const start = lines.findLastIndex((line, index) => index < hint && line.includes('╭'))
    if (start >= 0) {
      const left = lines[start].indexOf('╭')
      const right = lines[start].indexOf('╮', left + 1)
      if (left >= 0 && right >= 0) {
        return lines.slice(start + 1, hint + 1).map(line => line.slice(left, right - left + 1))
      }
    }
    return lines.slice(Math.max(0, hint - 20), hint + 1)
  }
  return bodies.at(-1) ?? []
}

export function settingsSearchSnapshot(pane) {
  const body = roundedFrameBody(pane)
  const searchVisible = body.some(line => line.includes('Type to search'))
  const queryLine = body.find(line => /(?:^|│)\s*>\s*/u.test(line))
  const query = queryLine
    ?.replace(/^\s*│?\s*>\s*/u, '')
    .replace(/\s*│\s*$/u, '')
    .trim() ?? ''
  const commandRows = body.flatMap(line => {
    const match = line.match(/(?:^|│)\s*(?:❯|›|>)?\s*(\/[A-Za-z][A-Za-z0-9_-]*)(?=\s|│|$)/u)
    return match === null ? [] : [match[1]]
  })
  return {
    searchVisible,
    query,
    commandRows,
    noMatches: body.some(line => line.includes('No matching settings')),
  }
}

const PRESET_DEGRADATION_PATTERNS = [
  /\blaunch preset unavailable\b/iu,
  /\bpreset resolution failed at startup\b/iu,
  /\bskill catalog unavailable for preset\b/iu,
  /\bpreset\b[^\n]*(?:did not mount|failed to mount|mount failed)\b/iu,
  /\b(?:fallback|falling back)\b[^\n]*\bdefault\b/iu,
  /\bstanding\b[^\n]*(?:mount|preset)[^\n]*(?:fail|unavailable|error)\b/iu,
]

export function presetDegradationLine(text) {
  return stripTerminalControl(text).split(/\r?\n/u).find(line =>
    PRESET_DEGRADATION_PATTERNS.some(pattern => pattern.test(line)))
}

function assertOfficialPresetMounted(presetId, tuiLog, tmux) {
  const text = `${readText(tuiLog)}\n${tmux.capturePane()}`
  const degradation = presetDegradationLine(text)
  if (degradation !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} degraded instead of mounting: ${degradation.trim()}`)
  }
}

function officialPresetCatalogDiagnostic(presetId, tuiLog, tmux) {
  const pane = stripTerminalControl(tmux.capturePane())
  return [
    `official preset ${presetId} settings snapshot: ${JSON.stringify(settingsSearchSnapshot(pane))}`,
    'tmux pane tail:',
    redact(tail(pane, 24)),
    'TUI log tail:',
    redact(tail(readText(tuiLog), 24)),
  ].join('\\n')
}

// The official preset gate owns its own diagnostic wording; the shared
// harness only detects a generic incompatible surface.
export function assertNoPresetCompatibilityFailures(tuiLog, tmux) {
  assertNoCompatibilityFailures(tuiLog, tmux, line => `official preset smoke reported an incompatible surface: ${line}`)
}

export function assertOfficialPresetHeader(presetId, evidencePath) {
  const evidence = readOptionalJson(evidencePath)
  if (evidence?.error !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe failed: ${String(evidence.error)}`)
  }
  if (evidence?.agentPreset !== presetId) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header mismatch: ${String(evidence?.agentPreset ?? '(missing)')}`)
  }
  if (typeof evidence?.sessionId !== 'string' || evidence.sessionId.length === 0) {
    fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe returned no session id`)
  }
}

/** Query the live preset without mutating it through the /preset picker. */
export function officialPresetStatusCommand() {
  return '/preset status'
}

export function officialPresetStatusVisible(presetId, pane) {
  return pane.includes(`preset: ${presetId} ·`)
}

/**
 * Exercise every DSH-shipped preset in two stages. Stage 1 boots the requested
 * `--preset` sessionless surface. Stage 2 creates a real session without a
 * model request, verifies the live projection reports the requested preset,
 * and checks the scoped command catalog. A standing fallback or mount error is
 * always a failure rather than a successful degraded boot.
 */
export async function smokeOfficialPresetMounts(invocation, workDir, env, promptEvidencePath) {
  for (const presetId of OFFICIAL_PRESET_IDS) {
    const socket = `dsh-preset-health-${process.pid}-${presetId}`
    const session = `preset-health-${process.pid}-${presetId}`
    const tmux = tmuxRunner(socket, session, env)
    const launcher = join(workDir, `run-preset-${presetId}.sh`)
    const tuiLog = join(workDir, `preset-${presetId}.tui.log`)
    writeLauncher(launcher, invocation, env, presetId)
    try {
      rmSync(env.DSH_SMOKE_HEADER_EVIDENCE, { force: true })
      const started = tmux.tmux([
        'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
        `script -qefc ${shellQuote(launcher)} ${shellQuote(tuiLog)}`,
      ])
      if (started.status !== 0) {
        fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} could not start:\n${resultText(started)}`)
      }
      await waitUntil(`official preset ${presetId} boot`, TIMEOUTS.boot, () => {
        if (!tmux.hasSession()) return false
        return tmux.capturePane().includes('❯')
      }, 'COMPAT_BOOT_FAILURE')
      assertNoPresetCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)

      // No pending /preset override is installed here: /new must carry the
      // launch-time --preset through the effective-preset path. This makes the
      // matrix prove the actual launch contract instead of retesting a manual
      // sessionless override.
      tmux.sendLiteral('/new')
      await delay(350)
      tmux.sendKey('Enter')
      // The command result is a transient UI line; the durable probe below is
      // the canonical evidence that /new created the requested session.
      await waitUntil(`official preset ${presetId} durable header`, TIMEOUTS.command, () => {
        const evidence = readOptionalJson(env.DSH_SMOKE_HEADER_EVIDENCE)
        if (evidence?.error !== undefined) {
          fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header probe failed: ${String(evidence.error)}`)
        }
        if (evidence?.agentPreset !== undefined && evidence.agentPreset !== presetId) {
          fail('COMPAT_BOOT_FAILURE', `official preset ${presetId} durable header mismatch: ${String(evidence.agentPreset)}`)
        }
        return evidence?.agentPreset === presetId
          && typeof evidence?.sessionId === 'string'
          && evidence.sessionId.length > 0
      }, 'COMPAT_BOOT_FAILURE')
      assertOfficialPresetHeader(presetId, env.DSH_SMOKE_HEADER_EVIDENCE)
      if (presetId === 'standard' && promptEvidencePath !== undefined) {
        tmux.sendLiteral('pr-e direct standard prompt')
        tmux.sendKey('Enter')
        await waitUntil('Direct standard prompt answer', TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          return tmux.capturePane().includes('direct qualification answer')
        }, 'COMPAT_BOOT_FAILURE')
        const evidence = readFileSync(promptEvidencePath, 'utf8').trim()
        const records = evidence === '' ? [] : evidence.split('\n').map(line => JSON.parse(line))
        const standard = records.filter(record => record.presentTool === true)
        if (standard.length !== 1 || standard[0].markerCount !== 1 || standard[0].presentInstruction !== true) {
          fail('COMPAT_BOOT_FAILURE', `Direct standard effective prompt qualification failed: ${JSON.stringify({ records: records.length, standard })}`)
        }
      }
      tmux.sendLiteral(officialPresetStatusCommand())
      await delay(350)
      tmux.sendKey('Enter')
      await waitUntil(`official preset ${presetId} projection`, TIMEOUTS.command, () => {
        if (!tmux.hasSession()) return false
        return officialPresetStatusVisible(presetId, tmux.capturePane())
      }, 'COMPAT_BOOT_FAILURE')
      assertNoPresetCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)

      tmux.sendLiteral('/help')
      await delay(350)
      tmux.sendKey('Enter')
      try {
        await waitUntil(`official preset ${presetId} command catalog`, TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          const snapshot = settingsSearchSnapshot(tmux.capturePane())
          return snapshot.searchVisible && snapshot.query === ''
        }, 'COMPAT_BOOT_FAILURE')
      } catch (error) {
        if (!(error instanceof CompatFailure)) throw error
        fail(error.phase, `${error.message}\n${officialPresetCatalogDiagnostic(presetId, tuiLog, tmux)}`)
      }
      tmux.sendLiteral('goal')
      const shouldHaveGoal = presetId !== 'minimal'
      try {
        await waitUntil(`official preset ${presetId} goal command isolation`, TIMEOUTS.command, () => {
          if (!tmux.hasSession()) return false
          const pane = tmux.capturePane()
          const snapshot = settingsSearchSnapshot(pane)
          const hasOnlyGoal = snapshot.commandRows.length === 1 && snapshot.commandRows[0] === '/goal'
          return snapshot.searchVisible
            && snapshot.query === 'goal'
            && hasOnlyGoal === shouldHaveGoal
            && snapshot.noMatches === !shouldHaveGoal
        }, 'COMPAT_BOOT_FAILURE')
      } catch (error) {
        if (!(error instanceof CompatFailure)) throw error
        fail(error.phase, `${error.message}\n${officialPresetCatalogDiagnostic(presetId, tuiLog, tmux)}`)
      }
      tmux.sendKey('Escape')
      await waitUntil(`official preset ${presetId} command catalog close`, TIMEOUTS.input, () => {
        if (!tmux.hasSession()) return false
        return !settingsSearchSnapshot(tmux.capturePane()).searchVisible
      }, 'COMPAT_BOOT_FAILURE')
      tmux.sendLiteral('/exit')
      await delay(350)
      tmux.sendKey('Enter')
      await waitUntil(`official preset ${presetId} shutdown`, TIMEOUTS.dispose, () => !tmux.hasSession(), 'COMPAT_DISPOSE_FAILURE')
    } finally {
      tmux.stop()
    }
  }
}

async function main() {
  const smokeArgs = process.argv.slice(2)
  const tarball = resolveTarball(candidateArgument(smokeArgs))
  validateCandidateTarball(tarball)
  const distributionPath = distributionArgument(smokeArgs)
  const configuredMode = process.env.DSH_MODE
  if (configuredMode !== undefined && configuredMode !== 'source' && configuredMode !== 'npm') {
    throw new Error(`unsupported DSH_MODE ${JSON.stringify(configuredMode)}; expected source or npm`)
  }
  if (configuredMode === 'source' && distributionPath === undefined) {
    throw new Error('DSH_MODE=source requires --distribution')
  }
  if (configuredMode === 'npm' && distributionPath !== undefined) {
    throw new Error('DSH_MODE=npm must not receive --distribution')
  }
  const sourceConfig = sourceConfigForArgs(smokeArgs)
  const targetDshVersion = sourceConfig?.expectedVersion ?? npmDshVersion()
  const distribution = distributionPath === undefined
    ? loadDshDistribution({ mode: 'npm', version: targetDshVersion })
    : loadDshDistribution({
      mode: 'source',
      manifest: resolve(distributionPath),
      packageJson: join(PACKAGE_ROOT, 'package.json'),
      sourceConfig,
    })
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
  const promptEvidencePath = join(workDir, 'prompt-evidence.jsonl')
  writeFileSync(promptEvidencePath, '', { mode: 0o600 })
  const env = {
    ...isolatedEnvironment(workDir, home, dshHome, evidencePath),
    DSH_SMOKE_PROMPT_EVIDENCE: promptEvidencePath,
  }

  try {
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-official-presets-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': targetDshVersion,
      },
    }, null, 2) + '\n', 'utf8')
    const pnpm = run(PNPM_COMMAND, ['--version'], { cwd: harnessDir, env })
    if (pnpm.status !== 0) throw new Error(`pnpm is unavailable:\n${commandOutput(pnpm)}`)
    runPnpmInstall(harnessDir, env, distribution)

    const dsh = dshInvocation(harnessDir)
    const version = runDsh(dsh, ['--version'], harnessDir, env)
    if (version.status !== 0) throw new Error(`installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion('DSH', commandOutput(version).split(/\r?\n/u).find(line => line.trim() !== '')?.trim(), targetDshVersion)

    const llmModulePath = createRequire(dsh[1]).resolve('@deepseek-ai/dsh-llm')
    const promptPackage = writePromptQualificationPackage(workDir, llmModulePath)
    installPlugin(dsh, tarball, harnessDir, env, false)
    installPlugin(dsh, promptPackage, harnessDir, env, false)
    installPlugin(dsh, writeHeaderProbePackage(workDir), harnessDir, env, false)
    await smokeOfficialPresetMounts(dsh, workDir, env, promptEvidencePath)
    console.log(`official preset assembly smoke passed — ${basename(tarball)} × DSH ${targetDshVersion}`)
  } finally {
    if (process.env.OFFICIAL_PRESETS_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
    else console.error(`preserved official preset environment: ${workDir}`)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`OFFICIAL_PRESETS_FAILURE: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
