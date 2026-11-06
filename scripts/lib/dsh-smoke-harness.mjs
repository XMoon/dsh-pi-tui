/**
 * Bridge-neutral infrastructure shared by the real DSH smoke gates.
 *
 * This module owns the isolated candidate/DSH installation, real-terminal
 * driving and diagnostic primitives that more than one smoke entry consumes.
 * It deliberately carries no pi2dsh metadata rules and no official-preset
 * assertions: those stay with the entry that owns them.
 *
 * The module also owns the ONE process-local smoke deadline. Only the pi2dsh
 * entry sets/clears it; every other smoke keeps the per-command timeouts and
 * has no aggregate gate budget.
 *
 * @module dsh-smoke-harness
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

import {
  assertInstalledDshFamily,
  assertSourceResolution,
  PACKAGE_ROOT,
  prepareDshInstall,
  restoreDshInstall,
  sourceInstallPackages,
  withoutMinimumReleaseAge,
} from './dsh-distribution.mjs'
import { cleanupTimedOutProcessTree, pnpmExecutable } from './process.mjs'

export const PNPM_COMMAND = pnpmExecutable()
export const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
export const TIMEOUTS = {
  boot: 30_000,
  command: 15_000,
  input: 10_000,
  dispose: 10_000,
}
export const SUBPROCESS_TIMEOUTS = {
  default: 15_000,
  install: 180_000,
  dsh: 30_000,
  tmux: 5_000,
}
const SAFE_ENV_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS', 'TARBALL_SMOKE_SKIP_INSTALL']

let activeGateDeadline

export class CompatFailure extends Error {
  constructor(phase, message) {
    super(message)
    this.name = 'CompatFailure'
    this.phase = phase
  }
}

export function fail(phase, message) {
  throw new CompatFailure(phase, message)
}

/**
 * The ONE aggregate smoke deadline for this Node process. `undefined` disables
 * it. `run()` and `waitUntil()` read it; no other module may keep its own copy.
 */
export function setSmokeDeadline(deadline) {
  activeGateDeadline = deadline
}

export function run(command, args, options = {}) {
  const { ignoreGateDeadline = false, ...spawnOptions } = options
  const requestedTimeout = spawnOptions.timeout ?? SUBPROCESS_TIMEOUTS.default
  const remaining = activeGateDeadline === undefined ? undefined : activeGateDeadline - Date.now()
  if (!ignoreGateDeadline && remaining !== undefined && remaining <= 0) {
    const error = Object.assign(new Error('overall compatibility gate deadline exceeded'), { code: 'ETIMEDOUT' })
    return { status: null, signal: 'SIGTERM', output: [null, '', ''], pid: undefined, stdout: '', stderr: '', error }
  }
  const timeout = ignoreGateDeadline || remaining === undefined
    ? requestedTimeout
    : Math.min(requestedTimeout, Math.max(1, remaining))
  const detached = spawnOptions.detached ?? process.platform !== 'win32'
  const result = spawnSync(command, args, {
    ...spawnOptions,
    encoding: 'utf8',
    timeout,
    detached,
  })
  cleanupTimedOutProcessTree(result, { detached })
  return result
}

export function resultText(result) {
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  const error = result.error instanceof Error ? result.error.message : ''
  const timeout = result.error?.code === 'ETIMEDOUT' ? 'subprocess timed out' : ''
  return [timeout, stdout, stderr, error].filter(text => text !== '').join('\n').trim()
}

const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENETDOWN',
  'ENOTFOUND',
  'ETIMEDOUT',
])

export function isRetryableRegistryFailure(result) {
  const errorCode = result.error?.code
  if (typeof errorCode === 'string' && RETRYABLE_ERROR_CODES.has(errorCode)) return true
  const text = resultText(result)
  const status = Number(text.match(/\b(?:HTTP\/\d(?:\.\d)?\s+|status(?:\s+code)?[=: ]+|ERR_PNPM_[A-Z_]+[ :]*)?([45]\d{2})\b/iu)?.[1])
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  if (status >= 500 || status === 408 || status === 429) return true
  return /\b(?:ECONNRESET|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ENETDOWN|ENOTFOUND|ETIMEDOUT|socket\s+hang\s+up|network\s+(?:request|error)|request\s+timed\s+out|fetch\s+failed)\b/iu.test(text)
    || /\bERR_PNPM_META_FETCH_FAIL\b/iu.test(text)
}

export function retryDiagnostic(spec) {
  return `retrying registry install for ${redact(spec)}\n`
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

export function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

export function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('INFRA_INSTALL_FAILURE', `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/**
 * The consumer-neutral surface-failure detector. An entry that must also treat
 * a consumer-specific diagnostic as a failure adds that rule in its own module,
 * not here.
 */
export function compatibilityFailureLine(text) {
  return String(text).split(/\r?\n/u).find(line => {
    const duplicateCommand = /(?:duplicate[ -]command|command registration failed|command ["'][^"']+["'] is already registered)/iu.test(line)
    const capabilityFailure = /\bcapability mismatch\b/iu.test(line)
    const explicitFallback = /\b(?:fallback|falling\s+back)\b\s*(?:[:=-]\s*|\b(?:to|into|as|using)\b[^\n]*?)\b(?:headless|inert|legacy|dsh[- ]?tui|compat(?:ibility)?|surface|component)\b/iu.test(line)
      || /\b(?:headless|inert|legacy)\b[^\n]*\b(?:fallback|falling\s+back)\b/iu.test(line)
      || /\bheadless\s+(?:mode|surface|component|fallback|path)\b/iu.test(line)
    const explicitDegradation = /\b(?:surface|component|tui|compat|legacy)\b[^\n]*\b(?:headless|inert)\b/iu.test(line)
      || /\b(?:headless|inert)\b[^\n]*\b(?:surface|component|tui|compat|legacy)\b/iu.test(line)
    return duplicateCommand || capabilityFailure || explicitFallback || explicitDegradation
  })
}

/**
 * Fail when the captured log/pane contains a generic incompatible-surface
 * diagnostic. The detection mechanics are shared; the caller supplies the
 * diagnostic sentence so the harness carries no entry-specific wording.
 */
export function assertNoCompatibilityFailures(tuiLog, tmux, describeFailure = line => `the smoke run reported an incompatible surface: ${line}`) {
  const text = `${readText(tuiLog)}\n${tmux.capturePane()}`
  const failedLine = compatibilityFailureLine(text)
  if (failedLine !== undefined) {
    fail('COMPAT_BOOT_FAILURE', describeFailure(failedLine.trim()))
  }
}

export function candidateArgument(args) {
  return args[0] === '--' ? args[1] : args[0]
}

export function distributionArgument(args) {
  const index = args.indexOf('--distribution')
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    fail('COMPAT_BOOT_FAILURE', '--distribution requires a source distribution directory or manifest')
  }
  return value
}

export function resolveTarball(explicit) {
  if (explicit !== undefined) {
    const absolute = resolve(explicit)
    const info = existsSync(absolute) ? lstatSync(absolute) : undefined
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) fail('INFRA_INSTALL_FAILURE', `candidate tarball not found or is not a regular file with exactly one link: ${explicit}`)
    return absolute
  }
  const candidates = readdirSync(PACKAGE_ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(PACKAGE_ROOT, name))
    .filter(path => {
      const info = lstatSync(path)
      return info.isFile() && !info.isSymbolicLink() && info.nlink === 1
    })
  if (candidates.length === 0) {
    fail('INFRA_INSTALL_FAILURE', `no candidate tarball in ${PACKAGE_ROOT}; run pnpm pack:release first`)
  }
  if (candidates.length > 1) {
    fail('INFRA_INSTALL_FAILURE', `expected one candidate tarball in ${PACKAGE_ROOT}, found ${candidates.map(basename).join(', ')}`)
  }
  return candidates[0]
}

export function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

export function validateCandidatePackageData(candidate, expected) {
  if (candidate?.name !== expected.name || candidate?.version !== expected.version) {
    fail('INFRA_INSTALL_FAILURE', `candidate package mismatch: expected ${expected.name}@${expected.version}, got ${candidate?.name ?? '(missing)'}@${candidate?.version ?? '(missing)'}`)
  }
}

export function readCandidatePackageData(tarball) {
  const result = run('tar', ['-xOf', tarball, 'package/package.json'], { timeout: SUBPROCESS_TIMEOUTS.default })
  if (result.status !== 0) {
    fail('INFRA_INSTALL_FAILURE', `candidate tarball metadata could not be read:\n${resultText(result)}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail('INFRA_INSTALL_FAILURE', `candidate tarball package.json is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function validateCandidateTarball(tarball) {
  const sourcePackage = readJson(join(PACKAGE_ROOT, 'package.json'), 'source package.json')
  if (sourcePackage.name !== EXPECTED_PACKAGE_NAME || typeof sourcePackage.version !== 'string' || sourcePackage.version.length === 0) {
    fail('INFRA_INSTALL_FAILURE', 'source package.json does not identify the expected candidate package')
  }
  const candidatePackage = readCandidatePackageData(tarball)
  validateCandidatePackageData(candidatePackage, { name: sourcePackage.name, version: sourcePackage.version })
  return candidatePackage
}

export function isolatedEnvironment(workDir, home, dshHome, evidencePath) {
  const inherited = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
  }
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key]
    if (value !== undefined) inherited[key] = value
  }
  return {
    ...inherited,
    HOME: home,
    DSH_HOME: dshHome,
    DSH_SMOKE_EVIDENCE: evidencePath,
    DSH_SMOKE_HEADER_EVIDENCE: join(workDir, 'header-evidence.json'),
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
    npm_config_userconfig: join(workDir, 'npmrc'),
    NPM_CONFIG_USERCONFIG: join(workDir, 'npmrc'),
  }
}

export function runPnpmInstall(harnessDir, env, distribution) {
  const prepared = distribution === undefined
    ? undefined
    : prepareDshInstall(distribution, harnessDir, {
      addCliDependency: true,
      materializeSourceDependencies: distribution.kind === 'source-pack',
      stripPackageManager: true,
      // The isolated harness has no lockfile, so an npm install would otherwise
      // re-resolve the CLI's caret family edges to a newer, incompatible
      // sibling. `npmFamilyPin` makes THIS one install entry point pin the
      // whole `@deepseek-ai/dsh` family to the exact target version; every
      // isolated npm harness uses this function, so the pin lives in exactly
      // one place. A source pack already pins its packed closure.
      npmFamilyPin: distribution.kind === 'npm',
    })
  let result
  try {
    if (distribution?.kind === 'npm') {
      // An exact-family npm install is TWO steps. pnpm applies the family
      // `overrides` only while no minimum-release-age setting is present; with
      // one set, the CLI's caret family edges re-opened to a newer sibling in
      // an isolated harness. The resolution step therefore runs without the age
      // setting (the harness env is otherwise fully isolated), and the frozen
      // step realizes that exact lockfile — it resolves nothing, so it may keep
      // the policy. A one-step `--no-frozen-lockfile` install cannot express
      // this.
      const resolve = run(PNPM_COMMAND, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts', '--reporter=append-only'], {
        cwd: harnessDir,
        env: withoutMinimumReleaseAge(env),
        timeout: SUBPROCESS_TIMEOUTS.install,
      })
      if (resolve.status !== 0) {
        fail('INFRA_INSTALL_FAILURE', `isolated DSH family resolution failed:\n${resultText(resolve)}`)
      }
      result = run(PNPM_COMMAND, ['install', '--ignore-scripts', '--frozen-lockfile', '--config.minimum-release-age=0', '--reporter=append-only'], {
        cwd: harnessDir,
        env,
        timeout: SUBPROCESS_TIMEOUTS.install,
      })
    } else {
      const installArgs = distribution?.kind === 'source-pack'
        ? [...prepared.installArgs, '--ignore-scripts', '--config.minimum-release-age=0', '--reporter=append-only']
        : ['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.minimum-release-age=0', '--reporter=append-only']
      result = run(PNPM_COMMAND, installArgs, {
        cwd: harnessDir,
        env,
        timeout: distribution?.kind === 'source-pack' ? 20 * 60_000 : SUBPROCESS_TIMEOUTS.install,
      })
    }
  } finally {
    restoreDshInstall(prepared)
  }
  if (result.status !== 0) {
    fail('INFRA_INSTALL_FAILURE', `isolated DSH install failed:\n${resultText(result)}`)
  }
  if (distribution?.kind === 'source-pack') {
    try {
      const packageJson = JSON.parse(readFileSync(join(harnessDir, 'package.json'), 'utf8'))
      assertSourceResolution(harnessDir, distribution, sourceInstallPackages(distribution, packageJson))
    } catch (error) {
      fail('INFRA_INSTALL_FAILURE', error instanceof Error ? error.message : String(error))
    }
  }
  if (distribution?.kind === 'npm') {
    // Prove the ACTUAL resolution, not merely the generated override file: a
    // writer-only check keeps passing if pnpm changes how it reads overrides.
    try {
      assertInstalledDshFamily(harnessDir, distribution.version)
    } catch (error) {
      fail('INFRA_INSTALL_FAILURE', error instanceof Error ? error.message : String(error))
    }
  }
  // The isolated install runs with --ignore-scripts, and that is final: the
  // POSIX Session write lease comes from the official
  // @deepseek-ai/node-addon-system/flock prebuilt family (no consumer-side
  // native build). A distribution whose native payload is missing fails
  // loudly through the normal package load path.
  return prepared
}

export function dshInvocation(harnessDir) {
  const entry = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) fail('INFRA_INSTALL_FAILURE', `installed DSH binary entry is missing: ${entry}`)
  return [process.execPath, entry]
}

export function runDsh(invocation, args, cwd, env, timeout = SUBPROCESS_TIMEOUTS.dsh) {
  return run(invocation[0], [...invocation.slice(1), ...args], { cwd, env, timeout })
}

export function installPlugin(invocation, spec, cwd, env, retry) {
  const args = ['plugin', '--profile', 'pi-tui', 'add', spec]
  const attempts = retry ? 2 : 1
  let result
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    result = runDsh(invocation, args, cwd, env, SUBPROCESS_TIMEOUTS.install)
    if (result.status === 0) return
    if (attempt + 1 < attempts && isRetryableRegistryFailure(result)) {
      process.stderr.write(retryDiagnostic(spec))
      continue
    }
    break
  }
  fail('INFRA_INSTALL_FAILURE', `DSH plugin install failed for ${spec}:\n${resultText(result)}`)
}

export function packageMetadata(profileDir, packageName) {
  const path = join(profileDir, 'node_modules', packageName, 'package.json')
  return readOptionalJson(path)
}

export function requireExactVersion(label, actual, expected) {
  if (actual !== expected) {
    fail('INFRA_INSTALL_FAILURE', `${label} version mismatch: expected ${expected}, got ${actual ?? '(missing)'}`)
  }
}

export function writeHeaderProbePackage(workDir) {
  const packageName = 'dsh-pi-tui-compat-header-probe'
  const probeDir = join(workDir, 'header-probe')
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
    '    - id: dsh-pi-tui-compat-header-probe',
    `      name: '${packageName}'`,
    '      inject: [sessionQuery]',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(probeDir, 'index.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    '',
    'const evidencePath = process.env.DSH_SMOKE_HEADER_EVIDENCE',
    'function writeEvidence(value) {',
    "  if (typeof evidencePath !== 'string' || evidencePath.length === 0) return",
    "  writeFileSync(evidencePath, JSON.stringify(value, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 })",
    '}',
    '',
    `export const name = '${packageName}'`,
    "export const inject = ['sessionQuery']",
    '',
    'export function apply(ctx) {',
    "  const query = ctx.get('sessionQuery')",
    "  if (query === undefined) {",
    "    writeEvidence({ error: 'session query service unavailable' })",
    '    return',
    '  }',
    "  ctx.on('agent/created', ({ agent }) => {",
    '    const session = agent?.session',
    "    if (session === undefined || session.header?.origin === 'subagent') return",
    '    void (async () => {',
    '      try {',
    // The master baseline reads the durable header through the semantic
    // session-query seam (observeSession) — raw persistence.inspect is
    // removed legacy.
    "        const observation = await query.observeSession(session.id, { projectionMode: 'none' })",
    '        try {',
    '          writeEvidence({',
    '            sessionId: String(observation.header.id),',
    '            agentPreset: observation.header.agentPreset,',
    '          })',
    '        } finally {',
    "          observation[Symbol.dispose]?.()",
    '        }',
    '      } catch (error) {',
    '        writeEvidence({',
    '          sessionId: String(session.id),',
    "          error: error instanceof Error ? error.message : String(error),",
    '        })',
    '      }',
    '    })()',
    '  })',
    '}',
    '',
  ].join('\n'), 'utf8')
  return probeDir
}

export function writeLauncher(path, invocation, env, presetId) {
  const preset = presetId === undefined ? '' : ` --preset ${shellQuote(presetId)}`
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `export HOME=${shellQuote(env.HOME)}`,
    `export DSH_HOME=${shellQuote(env.DSH_HOME)}`,
    `export DSH_SMOKE_EVIDENCE=${shellQuote(env.DSH_SMOKE_EVIDENCE)}`,
    `export DSH_SMOKE_HEADER_EVIDENCE=${shellQuote(env.DSH_SMOKE_HEADER_EVIDENCE)}`,
    `export npm_config_registry=${shellQuote(env.npm_config_registry)}`,
    `export NPM_CONFIG_REGISTRY=${shellQuote(env.NPM_CONFIG_REGISTRY)}`,
    `export npm_config_minimum_release_age=${shellQuote(env.npm_config_minimum_release_age)}`,
    `export pnpm_config_minimum_release_age=${shellQuote(env.pnpm_config_minimum_release_age)}`,
    `export npm_config_userconfig=${shellQuote(env.npm_config_userconfig)}`,
    `export NPM_CONFIG_USERCONFIG=${shellQuote(env.NPM_CONFIG_USERCONFIG)}`,
    'export TERM="${TERM:-xterm-256color}"',
    `exec ${invocation.map(shellQuote).join(' ') } --profile pi-tui${preset}`,
    '',
  ]
  writeFileSync(path, lines.join('\n'), { encoding: 'utf8', mode: 0o700 })
}

export function tmuxRunner(socket, session, env, options = {}) {
  const { resizeFailurePhase = 'SMOKE_SURFACE_FAILURE' } = options
  // Start the tmux server with the same allowlisted environment as the
  // launcher. This is defense in depth: the launcher also exports only the
  // variables the isolated profile needs.
  const tmuxEnv = { ...env, TERM: 'xterm-256color' }
  const tmux = (args, options = {}) => run('tmux', ['-L', socket, ...args], {
    ...options,
    timeout: options.timeout ?? SUBPROCESS_TIMEOUTS.tmux,
    env: tmuxEnv,
  })
  const capturePane = (options = {}) => {
    const result = tmux(['capture-pane', '-p', '-t', session], options)
    return result.status === 0 && typeof result.stdout === 'string' ? result.stdout : ''
  }
  const hasSession = () => tmux(['has-session', '-t', session]).status === 0
  const sendLiteral = (text) => {
    const result = tmux(['send-keys', '-t', session, '-l', text])
    if (result.status !== 0) fail('COMPAT_INPUT_FAILURE', `tmux could not send input ${JSON.stringify(text)}: ${resultText(result)}`)
  }
  const sendKey = (key) => {
    const result = tmux(['send-keys', '-t', session, key])
    if (result.status !== 0) fail('COMPAT_INPUT_FAILURE', `tmux could not send key ${key}: ${resultText(result)}`)
  }
  const resize = (columns, rows) => {
    const result = tmux(['resize-window', '-t', session, '-x', String(columns), '-y', String(rows)])
    if (result.status !== 0) fail(resizeFailurePhase, `tmux resize failed: ${resultText(result)}`)
  }
  const stop = () => {
    tmux(['kill-session', '-t', session], { ignoreGateDeadline: true })
    tmux(['kill-server'], { ignoreGateDeadline: true })
  }
  return { tmux, capturePane, hasSession, sendLiteral, sendKey, resize, stop }
}

export async function waitUntil(label, timeoutMs, probe, phase) {
  const localDeadline = Date.now() + timeoutMs
  const deadline = activeGateDeadline === undefined ? localDeadline : Math.min(localDeadline, activeGateDeadline)
  let lastError
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      if (error instanceof CompatFailure) throw error
      lastError = error instanceof Error ? error.message : String(error)
    }
    await delay(100)
  }
  fail(phase, `${label} timed out after ${timeoutMs}ms${lastError === undefined ? '' : ` (${lastError})`}`)
}

export function tail(text, count) {
  return text.split(/\r?\n/u).slice(-count).join('\n')
}

const SENSITIVE_KEY = '(?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret(?:[_-][a-z0-9]+)*|password|passphrase|credential(?:s)?|private[_-]?key|client[_-]?secret|npm[_-]?(?:token|auth)|node[_-]?auth[_-]?token)'
const SENSITIVE_ASSIGNMENT = new RegExp(`((?:"?${SENSITIVE_KEY}"?)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}&]+)`, 'giu')
const SENSITIVE_QUERY = new RegExp(`([?&]${SENSITIVE_KEY}[=:])[^&#\\s]+`, 'giu')

export function redact(text) {
  return String(text)
    .replace(/(\b(?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+(?::[^/@\s]*)?@/giu, '$1[REDACTED]@')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
}

export function redactedJson(value) {
  try {
    return redact(JSON.stringify(value, null, 2)) + '\n'
  } catch {
    return '[unserializable diagnostic]\n'
  }
}
