#!/usr/bin/env node
/**
 * Issue #26 Gate B: test the candidate dsh-pi-tui tarball as a real
 * pi2dsh consumer against the target DSH version recorded in
 * test/compat/pi2dsh.json.
 *
 * The gate first reads the published pi2dsh metadata and blocks an unsupported
 * DSH/TUI peer contract before attempting runtime installation. If that passes,
 * it installs the exact published DSH and pi2dsh versions into an isolated
 * temporary profile, adds an unmodified Pi-shaped fixture, and drives the
 * resulting TUI through tmux. Official DSH preset assembly is covered by the
 * independent `official-presets-smoke.mjs` gate; this consumer gate does not
 * hide that matrix behind the pi2dsh metadata preflight. The fixture is
 * intentionally not allowed to import this repository or any pi2dsh private
 * module.
 *
 * Usage: node scripts/pi2dsh-compat-smoke.mjs [path-to-candidate-tgz]
 *        pnpm smoke:pi2dsh -- [path-to-candidate-tgz]
 *
 * Set PI2DSH_COMPAT_DEBUG_DIR to preserve pane.txt, tui.log, evidence.json,
 * header-evidence.json, and versions.json when the gate fails. Set
 * PI2DSH_COMPAT_KEEP=1 to retain
 * the complete temporary test environment as well.
 * @module pi2dsh-compat-smoke
 */

import { createHash } from 'node:crypto'
import { builtinModules } from 'node:module'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep as pathSeparator } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import semver from 'semver'
import {
  assertSourceResolution,
  DSH_CLI_PACKAGE,
  loadDshDistribution,
  prepareDshInstall,
  restoreDshInstall,
  sourceInstallPackages,
} from './lib/dsh-distribution.mjs'
import { cleanupTimedOutProcessTree, pnpmExecutable } from './lib/process.mjs'

const PNPM_COMMAND = pnpmExecutable()
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const EXPECTED_PACKAGE_NAME = '@xmoon76/dsh-pi-tui'
const CONSUMER_PACKAGE_NAME = 'pi2dsh'
const OFFICIAL_PRESET_IDS = ['standard', 'ptc', 'minimal', 'cordis']
const MANIFEST_PATH = join(PACKAGE_ROOT, 'test', 'compat', 'pi2dsh.json')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'pi2dsh-compat')
const REQUIRED_CONTRACTS = [
  'root.LOCAL_COMMANDS',
  'extensions/unstable.UNSTABLE_API_LEVEL=1',
  'apiVersion=1',
  'capability:unstable.surface.handle',
  'chrome.footer.status',
  'surface.mountComponent',
  'component.render',
  'component.input',
  'component.done',
  'component.dispose',
]
const TIMEOUTS = {
  boot: 30_000,
  command: 15_000,
  input: 10_000,
  dispose: 10_000,
}
const SAFE_ENV_KEYS = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'TMP', 'TEMP', 'CI', 'PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN', 'PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS', 'TARBALL_SMOKE_SKIP_INSTALL']
const SUBPROCESS_TIMEOUTS = {
  default: 15_000,
  install: 180_000,
  dsh: 30_000,
  tmux: 5_000,
}
const CI_ECOSYSTEM_TIMEOUT_MS = 15 * 60_000
const CLEANUP_BUDGET_MS = 30_000
// Keep the whole smoke below the CI job ceiling, with room for diagnostics and cleanup.
const GATE_BUDGET_MS = CI_ECOSYSTEM_TIMEOUT_MS - 3 * 60_000
const RESIZE_FAILURE_PHASE = 'COMPAT_SURFACE_FAILURE'
let activeGateDeadline

class CompatFailure extends Error {
  constructor(phase, message) {
    super(message)
    this.name = 'CompatFailure'
    this.phase = phase
  }
}

function fail(phase, message) {
  throw new CompatFailure(phase, message)
}

function run(command, args, options = {}) {
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

function resultText(result) {
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

function isRetryableRegistryFailure(result) {
  const errorCode = result.error?.code
  if (typeof errorCode === 'string' && RETRYABLE_ERROR_CODES.has(errorCode)) return true
  const text = resultText(result)
  const status = Number(text.match(/\b(?:HTTP\/\d(?:\.\d)?\s+|status(?:\s+code)?[=: ]+|ERR_PNPM_[A-Z_]+[ :]*)?([45]\d{2})\b/iu)?.[1])
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return false
  if (status >= 500 || status === 408 || status === 429) return true
  return /\b(?:ECONNRESET|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ENETDOWN|ENOTFOUND|ETIMEDOUT|socket\s+hang\s+up|network\s+(?:request|error)|request\s+timed\s+out|fetch\s+failed)\b/iu.test(text)
    || /\bERR_PNPM_META_FETCH_FAIL\b/iu.test(text)
}

function retryDiagnostic(spec) {
  return `retrying registry install for ${redact(spec)}\n`
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail('INFRA_INSTALL_FAILURE', `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

function compatibilityFailureLine(text) {
  return String(text).split(/\r?\n/u).find(line => {
    const duplicateCommand = /(?:duplicate[ -]command|command registration failed|command ["'][^"']+["'] is already registered)/iu.test(line)
    const capabilityFailure = /(?:\bcapability mismatch\b|\bpi2dsh\b[^\n]*(?:fatal|unsupported|cannot|could not|failed))/iu.test(line)
    const explicitFallback = /\b(?:fallback|falling\s+back)\b\s*(?:[:=-]\s*|\b(?:to|into|as|using)\b[^\n]*?)\b(?:headless|inert|legacy|dsh[- ]?tui|compat(?:ibility)?|surface|component)\b/iu.test(line)
      || /\b(?:headless|inert|legacy)\b[^\n]*\b(?:fallback|falling\s+back)\b/iu.test(line)
      || /\bheadless\s+(?:mode|surface|component|fallback|path)\b/iu.test(line)
    const explicitDegradation = /\bpi2dsh\b[^\n]*\b(?:degrad(?:ed|es|ing)|headless|inert)\b/iu.test(line)
      || /\b(?:surface|component|tui|compat|legacy)\b[^\n]*\b(?:headless|inert)\b/iu.test(line)
      || /\b(?:headless|inert)\b[^\n]*\b(?:pi2dsh|surface|component|tui|compat|legacy)\b/iu.test(line)
    return duplicateCommand || capabilityFailure || explicitFallback || explicitDegradation
  })
}

function assertNoCompatibilityFailures(tuiLog, tmux) {
  const text = `${readText(tuiLog)}\n${tmux.capturePane()}`
  const failedLine = compatibilityFailureLine(text)
  if (failedLine !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `published pi2dsh reported an incompatible surface: ${failedLine.trim()}`)
  }
}

const ANSI_OSC = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/gu
const ANSI_CSI = /\u001b\[[0-?]*[ -/]*[@-~]/gu
const CURSOR_MARKER = /\u001b_pi:c\u0007/gu

function stripTerminalControl(text) {
  return String(text).replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(CURSOR_MARKER, '')
}

function roundedFrameBody(pane) {
  const lines = stripTerminalControl(pane).split(/\r?\n/u)
  const start = lines.findLastIndex(line => line.includes('╭'))
  if (start < 0) return []
  const end = lines.findIndex((line, index) => index > start && line.includes('╰'))
  return end < 0 ? [] : lines.slice(start + 1, end)
}

function settingsSearchSnapshot(pane) {
  const body = roundedFrameBody(pane)
  const searchVisible = body.some(line => line.includes('Type to search'))
  const query = body[0]
    ?.replace(/^\s*│?\s*>\s*/u, '')
    .replace(/\s*│\s*$/u, '')
    .trim() ?? ''
  const commandRows = body.flatMap(line => {
    const match = line.match(/(?:^|│)\s*(?:❯|>)?\s*(\/[A-Za-z][A-Za-z0-9_-]*)(?=\s|│|$)/u)
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

function presetDegradationLine(text) {
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

function assertOfficialPresetHeader(presetId, evidencePath) {
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
function officialPresetStatusCommand() {
  return '/preset status'
}

function officialPresetStatusVisible(presetId, pane) {
  return pane.includes(`preset: ${presetId} ·`)
}

function candidateArgument(args) {
  return args[0] === '--' ? args[1] : args[0]
}

function distributionArgument(args) {
  const index = args.indexOf('--distribution')
  if (index < 0) return undefined
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) {
    fail('COMPAT_BOOT_FAILURE', '--distribution requires a source distribution directory or manifest')
  }
  return value
}

function resolveDshDistribution(args, targetVersion) {
  const distributionPath = distributionArgument(args)
  if (distributionPath === undefined) return loadDshDistribution({ mode: 'npm', version: targetVersion })
  return loadDshDistribution({
    mode: 'source',
    manifest: resolve(distributionPath),
    packageJson: join(PACKAGE_ROOT, 'package.json'),
  })
}

function resolveTarball(explicit) {
  if (explicit !== undefined) {
    const absolute = resolve(explicit)
    if (!existsSync(absolute) || !statSync(absolute).isFile()) fail('INFRA_INSTALL_FAILURE', `candidate tarball not found: ${explicit}`)
    return absolute
  }
  const candidates = readdirSync(PACKAGE_ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(PACKAGE_ROOT, name))
    .filter(path => statSync(path).isFile())
  if (candidates.length === 0) {
    fail('INFRA_INSTALL_FAILURE', `no candidate tarball in ${PACKAGE_ROOT}; run pnpm pack:release first`)
  }
  if (candidates.length > 1) {
    fail('INFRA_INSTALL_FAILURE', `expected one candidate tarball in ${PACKAGE_ROOT}, found ${candidates.map(basename).join(', ')}`)
  }
  return candidates[0]
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function validateCandidatePackageData(candidate, expected) {
  if (candidate?.name !== expected.name || candidate?.version !== expected.version) {
    fail('INFRA_INSTALL_FAILURE', `candidate package mismatch: expected ${expected.name}@${expected.version}, got ${candidate?.name ?? '(missing)'}@${candidate?.version ?? '(missing)'}`)
  }
}

function readCandidatePackageData(tarball) {
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

function validateCandidateTarball(tarball) {
  const sourcePackage = readJson(join(PACKAGE_ROOT, 'package.json'), 'source package.json')
  if (sourcePackage.name !== EXPECTED_PACKAGE_NAME || typeof sourcePackage.version !== 'string' || sourcePackage.version.length === 0) {
    fail('INFRA_INSTALL_FAILURE', 'source package.json does not identify the expected candidate package')
  }
  const candidatePackage = readCandidatePackageData(tarball)
  validateCandidatePackageData(candidatePackage, { name: sourcePackage.name, version: sourcePackage.version })
  return candidatePackage
}

const EXACT_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u

function validateTargetDshManifest(manifest) {
  if (!EXACT_VERSION.test(manifest?.dshVersion ?? '')) {
    fail('COMPAT_BOOT_FAILURE', 'compatibility manifest must pin an exact target DSH version')
  }
  return manifest.dshVersion
}

function validateManifest(manifest) {
  if (manifest?.issue !== 26 || manifest.consumer !== 'pi2dsh') {
    fail('COMPAT_BOOT_FAILURE', 'test/compat/pi2dsh.json is not the Issue #26 pi2dsh manifest')
  }
  if (!EXACT_VERSION.test(manifest.pi2dshVersion ?? '')) {
    fail('COMPAT_BOOT_FAILURE', 'pi2dsh compatibility manifest must pin an exact pi2dsh version')
  }
  validateTargetDshManifest(manifest)
  if (!Array.isArray(manifest.contracts) || REQUIRED_CONTRACTS.some(contract => !manifest.contracts.includes(contract))) {
    fail('COMPAT_BOOT_FAILURE', 'pi2dsh compatibility manifest is missing a required contract')
  }
}

function relevantDshPeerEntries(packageJson) {
  return Object.entries(packageJson?.peerDependencies ?? {})
    .filter(([name, range]) => (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      && typeof range === 'string' && range.trim() !== '')
}

function rangeIncludesVersion(range, version) {
  if (typeof range !== 'string' || semver.valid(version) === null) return false
  try {
    return semver.validRange(range) !== null && semver.satisfies(version, range)
  } catch {
    return false
  }
}

function validateConsumerMetadata(consumerPackage, manifest, candidatePackage) {
  const consumerName = typeof consumerPackage?.name === 'string' ? consumerPackage.name : 'pi2dsh'
  const consumerVersion = typeof consumerPackage?.version === 'string' ? consumerPackage.version : '(unknown version)'
  const peerDependencies = consumerPackage?.peerDependencies
  const tuiRange = peerDependencies?.[EXPECTED_PACKAGE_NAME]
  const dshPeers = relevantDshPeerEntries(consumerPackage)
  const unsupportedDshPeers = dshPeers.filter(([, range]) => !rangeIncludesVersion(range, manifest.dshVersion))
  const problems = []

  if (!rangeIncludesVersion(tuiRange, candidatePackage.version)) {
    problems.push(`  ${EXPECTED_PACKAGE_NAME}: ${typeof tuiRange === 'string' ? tuiRange : '(missing)'}`)
  }
  if (dshPeers.length === 0) {
    problems.push('  @deepseek-ai/dsh-* peers: (none declared)')
  } else {
    for (const [name, range] of unsupportedDshPeers) problems.push(`  ${name}: ${range}`)
  }
  if (problems.length > 0) {
    fail('ECOSYSTEM_CONTRACT_BLOCKER', [
      `${consumerName}@${consumerVersion} does not declare support for:`,
      `  DSH ${manifest.dshVersion}`,
      `  ${EXPECTED_PACKAGE_NAME} ${candidatePackage.version}`,
      'Declared ranges that do not cover the candidate:',
      ...problems,
    ].join('\n'))
  }
}

const FORBIDDEN_FIXTURE_IMPORTS = [
  /^@xmoon76\/dsh-pi-tui(?:\/|$)/u,
  /^@xmoon76\/pi-tui(?:\/|$)/u,
  /(?:^|\/)dsh-pi-tui\/src(?:\/|$)/u,
  /^@deepseek-ai\/dsh(?:\/|$)/u,
  /^pi2dsh\/(?:src|dist|lib|internal)(?:\/|$)/u,
]
const FORBIDDEN_FIXTURE_BUILTINS = new Set([
  'module',
  'node:module',
  'vm',
  'node:vm',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
])
const DANGEROUS_FIXTURE_IDENTIFIERS = new Set(['createRequire', 'require', 'eval', 'Function'])
const DANGEROUS_FIXTURE_PROPERTIES = new Set([
  'createRequire',
  'getBuiltinModule',
  'dlopen',
  'mainModule',
  'binding',
  '_load',
  'runInThisContext',
  'eval',
  'Function',
  'require',
])
const BUILTIN_MODULES = new Set(builtinModules)



function staticModuleSpecifier(node) {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined
}

function collectImportSpecifiers(source) {
  const imports = []
  const dangerous = []
  const seen = new Set()
  const add = (specifier, dynamic = false) => {
    const key = `${dynamic ? 'dynamic' : 'literal'}:${specifier}`
    if (seen.has(key)) return
    seen.add(key)
    imports.push({ specifier, dynamic })
  }
  const addDangerous = (reason) => {
    if (!dangerous.includes(reason)) dangerous.push(reason)
  }
  const sourceFile = ts.createSourceFile('pi2dsh-compat-fixture.mjs', String(source), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier)
      if (specifier === undefined) addDangerous('non-literal import declaration')
      else add(specifier)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = staticModuleSpecifier(node.moduleSpecifier)
      if (specifier === undefined) addDangerous('non-literal export declaration')
      else add(specifier)
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = staticModuleSpecifier(node.moduleReference.expression)
        if (specifier !== undefined) add(specifier)
        else addDangerous('non-literal import-equals declaration')
      } else {
        addDangerous('import-equals loader')
      }
    } else if (ts.isCallExpression(node)) {
      const expression = node.expression
      if (expression.kind === ts.SyntaxKind.ImportKeyword) {
        const specifier = staticModuleSpecifier(node.arguments[0])
        if (specifier !== undefined) add(specifier)
        else addDangerous('non-literal dynamic import')
      } else if (ts.isIdentifier(expression) && expression.text === 'require') {
        addDangerous('require loader')
        const specifier = staticModuleSpecifier(node.arguments[0])
        if (specifier !== undefined) add(specifier)
      } else if (ts.isPropertyAccessExpression(expression) && expression.name.text === 'require') {
        addDangerous('property require loader')
        const specifier = staticModuleSpecifier(node.arguments[0])
        if (specifier !== undefined) add(specifier)
      }
    }
    if (ts.isIdentifier(node) && DANGEROUS_FIXTURE_IDENTIFIERS.has(node.text)) {
      addDangerous(`forbidden loader identifier ${node.text}`)
    }
    if (ts.isPropertyAccessExpression(node) && DANGEROUS_FIXTURE_PROPERTIES.has(node.name.text)) {
      addDangerous(`forbidden loader property ${node.name.text}`)
    }
    if (ts.isElementAccessExpression(node)) {
      const property = staticModuleSpecifier(node.argumentExpression)
      if (property === undefined || DANGEROUS_FIXTURE_PROPERTIES.has(property)) {
        addDangerous(`computed loader property ${property ?? '(computed)'}`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { imports, dangerous, parseErrors: sourceFile.parseDiagnostics?.length ?? 0 }
}

function isBuiltinSpecifier(specifier) {
  return BUILTIN_MODULES.has(specifier) || (specifier.startsWith('node:') && BUILTIN_MODULES.has(specifier.slice('node:'.length)))
}

function fixtureImportViolations(filePath, source) {
  const violations = []
  const collected = collectImportSpecifiers(source)
  if (collected.parseErrors > 0) violations.push(`fixture source parse errors: ${collected.parseErrors}`)
  violations.push(...collected.dangerous.map(reason => `dynamic loader/evaluation syntax ${reason}`))
  for (const { specifier, dynamic } of collected.imports) {
    if (dynamic) {
      violations.push(`non-literal module import ${specifier}`)
      continue
    }
    if (FORBIDDEN_FIXTURE_IMPORTS.some(pattern => pattern.test(specifier))) {
      violations.push(`host/private module ${specifier}`)
      continue
    }
    if (FORBIDDEN_FIXTURE_BUILTINS.has(specifier)) {
      violations.push(`dangerous builtin module ${specifier}`)
      continue
    }
    if (isAbsolute(specifier)) {
      violations.push(`absolute module path ${specifier}`)
      continue
    }
    if (specifier.startsWith('.')) {
      const resolvedPath = resolve(dirname(filePath), specifier)
      const relativePath = relative(FIXTURE_ROOT, resolvedPath)
      if (relativePath === '..' || relativePath.startsWith(`..${pathSeparator}`)) {
        violations.push(`relative import outside fixture ${specifier}`)
      }
      continue
    }
    if (!isBuiltinSpecifier(specifier)) {
      violations.push(`non-public external module ${specifier}`)
    }
  }
  return violations
}

const EXPECTED_FIXTURE_PACKAGE_KEYS = new Set(['name', 'version', 'private', 'type', 'pi'])
const EXPECTED_FIXTURE_NAME = 'dsh-pi2dsh-compat-fixture'

function validateFixturePackageData(packageJson) {
  if (packageJson === null || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    fail('COMPAT_BOOT_FAILURE', 'Pi compatibility fixture package.json must contain an object')
  }
  const unexpectedKeys = Object.keys(packageJson).filter(key => !EXPECTED_FIXTURE_PACKAGE_KEYS.has(key))
  if (unexpectedKeys.length > 0) {
    fail('COMPAT_BOOT_FAILURE', `Pi compatibility fixture package.json contains unsupported metadata: ${unexpectedKeys.join(', ')}`)
  }
  if (packageJson.name !== EXPECTED_FIXTURE_NAME || packageJson.version !== '0.0.0' || packageJson.private !== true || packageJson.type !== 'module') {
    fail('COMPAT_BOOT_FAILURE', 'Pi compatibility fixture package.json has an unexpected identity or module shape')
  }
  if (packageJson.pi === null || typeof packageJson.pi !== 'object' || Array.isArray(packageJson.pi)
    || Object.keys(packageJson.pi).length !== 1
    || !Array.isArray(packageJson.pi.extensions)
    || packageJson.pi.extensions.length !== 1
    || packageJson.pi.extensions[0] !== 'index.mjs') {
    fail('COMPAT_BOOT_FAILURE', 'Pi compatibility fixture package.json must expose only index.mjs through the Pi extension manifest')
  }
}

function validateFixturePackage() {
  const packageJson = readJson(join(FIXTURE_ROOT, 'package.json'), 'Pi compatibility fixture package.json')
  validateFixturePackageData(packageJson)
}

function fixtureSourceFiles(directory) {
  const files = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) fail('COMPAT_BOOT_FAILURE', `fixture contains an unsupported symbolic link: ${path}`)
    if (entry.isDirectory()) {
      files.push(...fixtureSourceFiles(path))
    } else if (/\.(?:c|m)?js$/u.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function scanFixture() {
  if (!existsSync(FIXTURE_ROOT)) fail('COMPAT_BOOT_FAILURE', `Pi compatibility fixture is missing: ${FIXTURE_ROOT}`)
  for (const path of fixtureSourceFiles(FIXTURE_ROOT)) {
    const source = readFileSync(path, 'utf8')
    for (const violation of fixtureImportViolations(path, source)) {
      fail('COMPAT_BOOT_FAILURE', `fixture imports host/private compatibility implementation: ${basename(path)} -> ${violation}`)
    }
  }
}

function isolatedEnvironment(workDir, home, dshHome, evidencePath) {
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
    PI2DSH_COMPAT_EVIDENCE: evidencePath,
    PI2DSH_COMPAT_HEADER_EVIDENCE: join(workDir, 'header-evidence.json'),
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    npm_config_userconfig: join(workDir, 'npmrc'),
    NPM_CONFIG_USERCONFIG: join(workDir, 'npmrc'),
  }
}

function runPnpmInstall(harnessDir, env, distribution) {
  const prepared = distribution === undefined
    ? undefined
    : prepareDshInstall(distribution, harnessDir, {
      addCliDependency: true,
      materializeSourceDependencies: distribution.kind === 'source-pack',
       stripPackageManager: true,
    })
  const installArgs = distribution?.kind === 'source-pack'
    ? [...prepared.installArgs, '--ignore-scripts', '--config.minimum-release-age=0', '--reporter=append-only']
    : ['install', '--ignore-scripts', '--no-frozen-lockfile', '--config.minimum-release-age=0', '--reporter=append-only']
  let result
  try {
    result = run(PNPM_COMMAND, installArgs, {
      cwd: harnessDir,
      env,
      timeout: distribution?.kind === 'source-pack' ? 20 * 60_000 : SUBPROCESS_TIMEOUTS.install,
    })
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
  return prepared
}

function dshInvocation(harnessDir) {
  const entry = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  if (!existsSync(entry)) fail('INFRA_INSTALL_FAILURE', `installed DSH binary entry is missing: ${entry}`)
  return [process.execPath, entry]
}

function runDsh(invocation, args, cwd, env, timeout = SUBPROCESS_TIMEOUTS.dsh) {
  return run(invocation[0], [...invocation.slice(1), ...args], { cwd, env, timeout })
}

function installPlugin(invocation, spec, cwd, env, retry) {
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

function packageMetadata(profileDir, packageName) {
  const path = join(profileDir, 'node_modules', packageName, 'package.json')
  return readOptionalJson(path)
}

function publishedPackageMetadata(packageName, version, env) {
  const spec = `${packageName}@${version}`
  const result = run('npm', [
    'view', spec, '--json', '--registry=https://registry.npmjs.org',
  ], { cwd: PACKAGE_ROOT, env, timeout: SUBPROCESS_TIMEOUTS.install })
  if (result.status !== 0) {
    fail('INFRA_INSTALL_FAILURE', `published ${spec} metadata could not be read:\n${resultText(result)}`)
  }
  let metadata
  try {
    metadata = JSON.parse(result.stdout)
  } catch (error) {
    fail('INFRA_INSTALL_FAILURE', `published ${spec} metadata is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  // npm view may return a one-element array when the registry client treats
  // the request as a multi-field projection. Accept that transport shape but
  // keep the contract validator's input a single package object.
  if (Array.isArray(metadata)) metadata = metadata[0]
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('INFRA_INSTALL_FAILURE', `published ${spec} metadata did not contain a package object`)
  }
  return metadata
}

function packageVersion(profileDir, packageName) {
  return packageMetadata(profileDir, packageName)?.version
}

function requireExactVersion(label, actual, expected) {
  if (actual !== expected) {
    fail('INFRA_INSTALL_FAILURE', `${label} version mismatch: expected ${expected}, got ${actual ?? '(missing)'}`)
  }
}

function writeHeaderProbePackage(workDir) {
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
    '      inject: [sessionPersistence]',
    '',
  ].join('\n'), 'utf8')
  writeFileSync(join(probeDir, 'index.mjs'), [
    "import { writeFileSync } from 'node:fs'",
    '',
    'const evidencePath = process.env.PI2DSH_COMPAT_HEADER_EVIDENCE',
    'function writeEvidence(value) {',
    "  if (typeof evidencePath !== 'string' || evidencePath.length === 0) return",
    "  writeFileSync(evidencePath, JSON.stringify(value, null, 2) + '\\n', { encoding: 'utf8', mode: 0o600 })",
    '}',
    '',
    `export const name = '${packageName}'`,
    "export const inject = ['sessionPersistence']",
    '',
    'export function apply(ctx) {',
    "  const persistence = ctx.get('sessionPersistence')",
    "  if (persistence === undefined) {",
    "    writeEvidence({ error: 'session persistence service unavailable' })",
    '    return',
    '  }',
    "  ctx.on('agent/created', ({ agent }) => {",
    '    const session = agent?.session',
    "    if (session === undefined || session.header?.origin === 'subagent') return",
    '    void (async () => {',
    '      try {',
    "        if (typeof persistence.ensureMaterialized === 'function') await persistence.ensureMaterialized(session)",
    '        const inspection = await persistence.inspect(session.id)',
    '        writeEvidence({',
    '          sessionId: String(inspection.meta.id),',
    '          agentPreset: inspection.meta.agentPreset,',
    '        })',
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

function writeLauncher(path, invocation, env, presetId) {
  const preset = presetId === undefined ? '' : ` --preset ${shellQuote(presetId)}`
  const lines = [
    '#!/bin/sh',
    'set -eu',
    `export HOME=${shellQuote(env.HOME)}`,
    `export DSH_HOME=${shellQuote(env.DSH_HOME)}`,
    `export PI2DSH_COMPAT_EVIDENCE=${shellQuote(env.PI2DSH_COMPAT_EVIDENCE)}`,
    `export PI2DSH_COMPAT_HEADER_EVIDENCE=${shellQuote(env.PI2DSH_COMPAT_HEADER_EVIDENCE)}`,
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

function tmuxRunner(socket, session, env) {
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
    if (result.status !== 0) fail(RESIZE_FAILURE_PHASE, `tmux resize failed: ${resultText(result)}`)
  }
  const stop = () => {
    tmux(['kill-session', '-t', session], { ignoreGateDeadline: true })
    tmux(['kill-server'], { ignoreGateDeadline: true })
  }
  return { tmux, capturePane, hasSession, sendLiteral, sendKey, resize, stop }
}

/**
 * Exercise every DSH-shipped preset in two stages. Stage 1 boots the requested
 * `--preset` sessionless surface. Stage 2 creates a real session without a
 * model request, verifies the live projection reports the requested preset,
 * and checks the scoped command catalog. A standing fallback or mount error is
 * always a failure rather than a successful degraded boot.
 */
async function smokeOfficialPresetMounts(invocation, workDir, env) {
  for (const presetId of OFFICIAL_PRESET_IDS) {
    const socket = `dsh-preset-health-${process.pid}-${presetId}`
    const session = `preset-health-${process.pid}-${presetId}`
    const tmux = tmuxRunner(socket, session, env)
    const launcher = join(workDir, `run-preset-${presetId}.sh`)
    const tuiLog = join(workDir, `preset-${presetId}.tui.log`)
    writeLauncher(launcher, invocation, env, presetId)
    try {
      rmSync(env.PI2DSH_COMPAT_HEADER_EVIDENCE, { force: true })
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
      assertNoCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)

      // No pending /preset override is installed here: /new must carry the
      // launch-time --preset through the effective-preset path. This makes the
      // matrix prove the actual launch contract instead of retesting a manual
      // sessionless override.
      tmux.sendLiteral('/new')
      await delay(350)
      tmux.sendKey('Enter')
      await waitUntil(`official preset ${presetId} session`, TIMEOUTS.command, () => {
        if (!tmux.hasSession()) return false
        return tmux.capturePane().includes('started a fresh session')
      }, 'COMPAT_BOOT_FAILURE')
      await waitUntil(`official preset ${presetId} durable header`, TIMEOUTS.command, () => {
        const evidence = readOptionalJson(env.PI2DSH_COMPAT_HEADER_EVIDENCE)
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
      assertOfficialPresetHeader(presetId, env.PI2DSH_COMPAT_HEADER_EVIDENCE)
      tmux.sendLiteral(officialPresetStatusCommand())
      await delay(350)
      tmux.sendKey('Enter')
      await waitUntil(`official preset ${presetId} projection`, TIMEOUTS.command, () => {
        if (!tmux.hasSession()) return false
        return officialPresetStatusVisible(presetId, tmux.capturePane())
      }, 'COMPAT_BOOT_FAILURE')
      assertNoCompatibilityFailures(tuiLog, tmux)
      assertOfficialPresetMounted(presetId, tuiLog, tmux)

      tmux.sendLiteral('/help')
      await delay(350)
      tmux.sendKey('Enter')
      await waitUntil(`official preset ${presetId} command catalog`, TIMEOUTS.command, () => {
        if (!tmux.hasSession()) return false
        const snapshot = settingsSearchSnapshot(tmux.capturePane())
        return snapshot.searchVisible && snapshot.query === ''
      }, 'COMPAT_BOOT_FAILURE')
      tmux.sendLiteral('goal')
      const shouldHaveGoal = presetId !== 'minimal'
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

async function waitUntil(label, timeoutMs, probe, phase) {
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

function readEvidence(path) {
  return readOptionalJson(path) ?? {
    commandInvoked: false,
    renderWidths: [],
    inputs: [],
    disposeCount: 0,
    doneCount: 0,
  }
}

function hasFreshResizeWidth(renderWidths, priorWidths) {
  const prior = new Set((priorWidths ?? []).filter(width => Number.isFinite(width) && width > 0))
  return (renderWidths ?? []).some(width => Number.isFinite(width) && width > 0 && !prior.has(width))
}

function tail(text, count) {
  return text.split(/\r?\n/u).slice(-count).join('\n')
}

const SENSITIVE_KEY = '(?:api[_-]?key|access[_-]?token|auth(?:orization)?|token|secret(?:[_-][a-z0-9]+)*|password|passphrase|credential(?:s)?|private[_-]?key|client[_-]?secret|npm[_-]?(?:token|auth)|node[_-]?auth[_-]?token)'
const SENSITIVE_ASSIGNMENT = new RegExp(`((?:"?${SENSITIVE_KEY}"?)\\s*[:=]\\s*)(?:"[^"]*"|'[^']*'|[^\\s,;}&]+)`, 'giu')
const SENSITIVE_QUERY = new RegExp(`([?&]${SENSITIVE_KEY}[=:])[^&#\\s]+`, 'giu')

function redact(text) {
  return String(text)
    .replace(/(\b(?:authorization\s*[:=]\s*)?(?:bearer|basic)\s+)[^\s,;]+/giu, '$1[REDACTED]')
    .replace(/(https?:\/\/)[^/\s:@]+(?::[^/@\s]*)?@/giu, '$1[REDACTED]@')
    .replace(SENSITIVE_ASSIGNMENT, '$1[REDACTED]')
    .replace(SENSITIVE_QUERY, '$1[REDACTED]')
}

function redactedJson(value) {
  try {
    return redact(JSON.stringify(value, null, 2)) + '\n'
  } catch {
    return '[unserializable diagnostic]\n'
  }
}

function diagnosticsContext(context) {
  const manifest = context.manifest
  const profileDir = context.dshHome === undefined ? undefined : join(context.dshHome, 'profiles', 'pi-tui')
  const versions = {
    candidate: context.tarball === undefined ? undefined : {
      basename: basename(context.tarball),
      sha256: sha256(context.tarball),
      package: context.candidatePackage === undefined ? undefined : {
        name: context.candidatePackage.name,
        version: context.candidatePackage.version,
      },
    },
    manifest: manifest === undefined ? undefined : {
      dshVersion: manifest.dshVersion,
      pi2dshVersion: manifest.pi2dshVersion,
    },
    consumer: context.consumerPackage === undefined ? undefined : {
      name: context.consumerPackage.name,
      version: context.consumerPackage.version,
      peers: Object.fromEntries(relevantDshPeerEntries(context.consumerPackage)),
      tuiPeer: context.consumerPackage.peerDependencies?.[EXPECTED_PACKAGE_NAME],
    },
    node: process.version,
    pnpm: context.pnpmVersion,
    dsh: context.dshVersion,
    pi2dsh: profileDir === undefined ? undefined : packageVersion(profileDir, CONSUMER_PACKAGE_NAME),
  }
  return versions
}

function preserveDiagnostics(context) {
  const pane = context.tmux?.capturePane?.({ ignoreGateDeadline: true }) ?? ''
  const tuiLog = context.tuiLog === undefined ? '' : (() => {
    try {
      return readFileSync(context.tuiLog, 'utf8')
    } catch {
      return ''
    }
  })()
  const evidence = context.evidencePath === undefined ? undefined : readOptionalJson(context.evidencePath)
  const headerEvidence = context.headerEvidencePath === undefined ? undefined : readOptionalJson(context.headerEvidencePath)
  const versions = diagnosticsContext(context)
  const debugDir = process.env.PI2DSH_COMPAT_DEBUG_DIR === undefined
    ? undefined
    : resolve(process.cwd(), process.env.PI2DSH_COMPAT_DEBUG_DIR)
  if (debugDir !== undefined) {
    mkdirSync(debugDir, { recursive: true })
    writeFileSync(join(debugDir, 'pane.txt'), redact(pane), 'utf8')
    writeFileSync(join(debugDir, 'tui.log'), redact(tuiLog), 'utf8')
    writeFileSync(join(debugDir, 'evidence.json'), redactedJson(evidence ?? {}), 'utf8')
    writeFileSync(join(debugDir, 'header-evidence.json'), redactedJson(headerEvidence ?? {}), 'utf8')
    writeFileSync(join(debugDir, 'versions.json'), redactedJson(versions), 'utf8')
  }
  const failure = context.error
  const phase = failure instanceof CompatFailure ? failure.phase : 'COMPAT_BOOT_FAILURE'
  const message = failure instanceof Error ? failure.message : String(failure)
  console.error(`${phase}: ${redact(message)}`)
  console.error(`candidate tarball: ${redact(versions.candidate?.basename ?? '(unresolved)')}`)
  console.error(`candidate sha256: ${redact(versions.candidate?.sha256 ?? '(unresolved)')}`)
  console.error(`manifest dshVersion: ${redact(versions.manifest?.dshVersion ?? '(unresolved)')}`)
  console.error(`manifest pi2dshVersion: ${redact(versions.manifest?.pi2dshVersion ?? '(unresolved)')}`)
  console.error(`node: ${redact(versions.node)}`)
  console.error(`pnpm: ${redact(versions.pnpm ?? '(unresolved)')}`)
  console.error(`dsh: ${redact(versions.dsh ?? '(unresolved)')}`)
  console.error(`pi2dsh: ${redact(versions.pi2dsh ?? '(unresolved)')}`)
  console.error('last captured pane:')
  console.error(redact(pane))
  console.error('last 100 lines tui.log:')
  console.error(redact(tail(tuiLog, 100)))
  console.error('evidence.json:')
  console.error(redactedJson(evidence ?? {}).trimEnd())
  if (debugDir !== undefined) console.error(`debug artifacts: ${redact(debugDir)}`)
  if (context.workDir !== undefined && process.env.PI2DSH_COMPAT_KEEP === '1') console.error(`temporary environment: ${redact(context.workDir)}`)
}

async function main() {
  const context = {
    tarball: undefined,
    candidatePackage: undefined,
    manifest: undefined,
    distribution: undefined,
    consumerPackage: undefined,
    workDir: undefined,
    dshHome: undefined,
    evidencePath: undefined,
    headerEvidencePath: undefined,
    tuiLog: undefined,
    tmux: undefined,
    error: undefined,
    pnpmVersion: undefined,
    dshVersion: undefined,
  }
  activeGateDeadline = Date.now() + GATE_BUDGET_MS
  try {
    const smokeArgs = process.argv.slice(2)
    context.tarball = resolveTarball(candidateArgument(smokeArgs))
    context.manifest = readJson(MANIFEST_PATH, 'pi2dsh compatibility manifest')
    context.candidatePackage = validateCandidateTarball(context.tarball)
    validateManifest(context.manifest)
    context.distribution = resolveDshDistribution(smokeArgs, context.manifest.dshVersion)
    if (context.distribution.version !== context.manifest.dshVersion) {
      fail('COMPAT_BOOT_FAILURE', `DSH distribution version mismatch: expected ${context.manifest.dshVersion}, got ${context.distribution.version}`)
    }
    if (context.distribution.kind === 'source-pack') {
      console.log('SKIPPED: requires published compatible DSH/pi2dsh combination (source mode)')
      return
    }
    validateFixturePackage()
    scanFixture()

    const workDir = mkdtempSync(join(tmpdir(), 'dsh-pi2dsh-compat-'))
    context.workDir = workDir
    const home = join(workDir, 'home')
    const dshHome = join(workDir, 'dsh-home')
    const harnessDir = join(workDir, 'harness')
    const fixtureDir = join(workDir, 'fixture')
    mkdirSync(home, { recursive: true })
    mkdirSync(dshHome, { recursive: true })
    mkdirSync(harnessDir, { recursive: true })
    cpSync(FIXTURE_ROOT, fixtureDir, { recursive: true })
    const evidencePath = join(workDir, 'evidence.json')
    const headerEvidencePath = join(workDir, 'header-evidence.json')
    const tuiLog = join(workDir, 'tui.log')
    context.dshHome = dshHome
    context.evidencePath = evidencePath
    context.headerEvidencePath = headerEvidencePath
    context.tuiLog = tuiLog
    writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n', 'utf8')

    const env = isolatedEnvironment(workDir, home, dshHome, evidencePath)
    context.consumerPackage = publishedPackageMetadata(CONSUMER_PACKAGE_NAME, context.manifest.pi2dshVersion, env)
    validateConsumerMetadata(context.consumerPackage, context.manifest, context.candidatePackage)
    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-pi2dsh-compat-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': context.manifest.dshVersion,
      },
    }, null, 2) + '\n', 'utf8')

    const pnpm = run(PNPM_COMMAND, ['--version'], { cwd: harnessDir, env })
    if (pnpm.status !== 0) fail('INFRA_INSTALL_FAILURE', `pnpm is unavailable:\n${resultText(pnpm)}`)
    context.pnpmVersion = (pnpm.stdout ?? '').trim()
    runPnpmInstall(harnessDir, env, context.distribution)

    const dsh = dshInvocation(harnessDir)
    const dshVersion = runDsh(dsh, ['--version'], harnessDir, env)
    if (dshVersion.status !== 0) fail('INFRA_INSTALL_FAILURE', `installed DSH --version failed:\n${resultText(dshVersion)}`)
    context.dshVersion = resultText(dshVersion).split(/\r?\n/u).find(line => line.trim() !== '')?.trim()
    requireExactVersion('DSH', context.dshVersion, context.manifest.dshVersion)

    installPlugin(dsh, context.tarball, harnessDir, env, false)
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    validateCandidatePackageData(packageMetadata(profileDir, context.candidatePackage.name), context.candidatePackage)
    installPlugin(dsh, `${CONSUMER_PACKAGE_NAME}@${context.manifest.pi2dshVersion}`, harnessDir, env, true)
    requireExactVersion(CONSUMER_PACKAGE_NAME, packageVersion(profileDir, CONSUMER_PACKAGE_NAME), context.manifest.pi2dshVersion)
    if (packageMetadata(profileDir, CONSUMER_PACKAGE_NAME) === undefined) {
      fail('INFRA_INSTALL_FAILURE', `installed ${CONSUMER_PACKAGE_NAME} package metadata is missing from the isolated profile`)
    }
    installPlugin(dsh, writeHeaderProbePackage(workDir), harnessDir, env, false)
    installPlugin(dsh, fixtureDir, harnessDir, env, false)

    const socket = `dsh-pi2dsh-compat-${process.pid}`
    const session = `compat-${process.pid}`
    const tmux = tmuxRunner(socket, session, env)
    context.tmux = tmux
    const launcher = join(workDir, 'run-tui.sh')
    writeLauncher(launcher, dsh, env)
    const started = tmux.tmux([
      'new-session', '-d', '-s', session, '-x', '80', '-y', '24',
      `script -qefc ${shellQuote(launcher)} ${shellQuote(tuiLog)}`,
    ])
    if (started.status !== 0) fail('COMPAT_BOOT_FAILURE', `could not start tmux TUI session:\n${resultText(started)}`)

    await waitUntil('real TUI boot', TIMEOUTS.boot, () => {
      if (!tmux.hasSession()) return false
      return tmux.capturePane().includes('❯')
    }, 'COMPAT_BOOT_FAILURE')
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendLiteral('/new')
    await delay(350)
    tmux.sendKey('Enter')
    await delay(500)
    tmux.sendLiteral('/help')
    await delay(350)
    tmux.sendKey('Enter')
    await waitUntil('native /help command', TIMEOUTS.command, () => {
      if (!tmux.hasSession()) return false
      const pane = tmux.capturePane()
      return pane.includes('Type to search') && pane.includes('Enter/Space to change')
    }, 'COMPAT_BOOT_FAILURE')
    tmux.sendKey('Escape')
    await waitUntil('native /help close', TIMEOUTS.input, () => {
      if (!tmux.hasSession()) return false
      return !tmux.capturePane().includes('Type to search')
    }, 'COMPAT_BOOT_FAILURE')
    const nativeHelpEvidence = readEvidence(evidencePath)
    if (nativeHelpEvidence.commandInvoked !== false) {
      fail('COMPAT_BOOT_FAILURE', 'native /help unexpectedly invoked the Pi collision fixture')
    }
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendLiteral('/pi-help')
    await delay(350)
    tmux.sendKey('Enter')
    await waitUntil('Pi /pi-help custom component marker', TIMEOUTS.command, () => {
      if (!tmux.hasSession()) return false
      return tmux.capturePane().includes('PI2DSH_COMPAT_READY')
    }, 'COMPAT_SURFACE_FAILURE')
    await waitUntil('Pi status footer', TIMEOUTS.input, () => tmux.capturePane().includes('pi2dsh-compat'), 'COMPAT_SURFACE_FAILURE')
    await waitUntil('Pi command invocation evidence', TIMEOUTS.command, () => readEvidence(evidencePath).commandInvoked === true, 'COMPAT_SURFACE_FAILURE')
    const openedEvidence = readEvidence(evidencePath)
    if (!openedEvidence.renderWidths.some(width => Number.isFinite(width) && width > 0)) {
      fail('COMPAT_SURFACE_FAILURE', 'Pi custom component did not render with a positive width')
    }
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendKey('r')
    await waitUntil('Pi raw input marker', TIMEOUTS.input, () => {
      const evidence = readEvidence(evidencePath)
      return evidence.inputs?.at(-1) === 'r' && tmux.capturePane().includes('PI2DSH_COMPAT_INPUT=r')
    }, 'COMPAT_INPUT_FAILURE')
    assertNoCompatibilityFailures(tuiLog, tmux)

    const widthsBeforeResize = readEvidence(evidencePath).renderWidths ?? []
    tmux.resize(100, 30)
    await waitUntil('Pi resize evidence', TIMEOUTS.input, () => {
      const widths = readEvidence(evidencePath).renderWidths ?? []
      return hasFreshResizeWidth(widths, widthsBeforeResize)
    }, RESIZE_FAILURE_PHASE)
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendKey('q')
    await waitUntil('Pi component dispose', TIMEOUTS.dispose, () => readEvidence(evidencePath).disposeCount === 1, 'COMPAT_DISPOSE_FAILURE')
    await delay(250)
    tmux.resize(99, 30)
    await delay(250)
    const disposedEvidence = readEvidence(evidencePath)
    if (disposedEvidence.doneCount !== 1) fail('COMPAT_DISPOSE_FAILURE', `Pi custom component must invoke done exactly once before close: ${disposedEvidence.doneCount}`)
    if (disposedEvidence.disposeCount !== 1) fail('COMPAT_DISPOSE_FAILURE', `component dispose count changed after close: ${disposedEvidence.disposeCount}`)
    if (tmux.capturePane().includes('PI2DSH_COMPAT_READY')) fail('COMPAT_DISPOSE_FAILURE', 'closed Pi component remained visible after dispose')
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendLiteral('host-ok')
    await delay(350)
    await waitUntil('host editor after component close', TIMEOUTS.dispose, () => tmux.capturePane().includes('host-ok'), 'COMPAT_DISPOSE_FAILURE')
    assertNoCompatibilityFailures(tuiLog, tmux)

    tmux.sendKey('C-c')
    await delay(250)
    tmux.sendLiteral('/exit')
    await delay(350)
    tmux.sendKey('Enter')
    await waitUntil('TUI shutdown', TIMEOUTS.dispose, () => !tmux.hasSession(), 'COMPAT_DISPOSE_FAILURE')
    assertNoCompatibilityFailures(tuiLog, tmux)
    console.log(`pi2dsh compatibility smoke passed — ${basename(context.tarball)} × pi2dsh@${context.manifest.pi2dshVersion}`)
  } catch (error) {
    context.error = error
    preserveDiagnostics(context)
    throw error
  } finally {
    context.tmux?.stop?.()
    if (context.workDir !== undefined && process.env.PI2DSH_COMPAT_KEEP !== '1') {
      rmSync(context.workDir, { recursive: true, force: true })
    }
    activeGateDeadline = undefined
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1
  })
}

export {
  assertNoCompatibilityFailures,
  candidateArgument,
  distributionArgument,
  readJson,
  resolveTarball,
  validateCandidateTarball,
  validateTargetDshManifest,
  runPnpmInstall,
  dshInvocation,
  runDsh,
  installPlugin,
  writeHeaderProbePackage,
  writeLauncher,
  tmuxRunner,
  smokeOfficialPresetMounts,
  assertOfficialPresetHeader,
  officialPresetStatusCommand,
  officialPresetStatusVisible,
  compatibilityFailureLine,
  presetDegradationLine,
  fixtureImportViolations,
  settingsSearchSnapshot,
  validateCandidatePackageData,
  validateConsumerMetadata,
  hasFreshResizeWidth,
  isolatedEnvironment,
  isRetryableRegistryFailure,
  redact,
  validateFixturePackageData,
  validateManifest,
  requireExactVersion,
  retryDiagnostic,
  RESIZE_FAILURE_PHASE,
  CI_ECOSYSTEM_TIMEOUT_MS,
  CLEANUP_BUDGET_MS,
  GATE_BUDGET_MS,
  run,
}
