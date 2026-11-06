#!/usr/bin/env node
/**
 * Issue #26 Gate B: test the candidate dsh-pi-tui tarball as a real pi2dsh
 * consumer against the CURRENT published pi2dsh latest release and the highest
 * published DSH version both sides actually declare.
 *
 * Every run resolves `pi2dsh@latest` from the public npm registry, freezes that
 * exact version, reads the published @deepseek-ai/dsh version list, and selects
 * the highest published DSH covered by the bridge's actual DSH peers, the
 * candidate TUI's DSH peers and engines.dsh. It installs those exact versions
 * into an isolated profile, adds an unmodified Pi-shaped fixture, and drives
 * the TUI through real tmux. A lagging TUI peer is a METADATA_DRIFT warning;
 * the real install and PTY decide. There is no fixed pairing table.
 *
 * Official DSH preset assembly is covered by `official-presets-smoke.mjs`,
 * which owns that matrix; this consumer gate neither imports nor hides it. The
 * isolated installation, real-terminal and diagnostic primitives live in
 * `lib/dsh-smoke-harness.mjs`; the pure version selection lives in
 * `lib/pi2dsh-compat-selection.mjs`. The fixture is intentionally not allowed
 * to import this repository or any pi2dsh private module.
 *
 * Usage: node scripts/pi2dsh-compat-smoke.mjs [path-to-candidate-tgz]
 *        pnpm smoke:pi2dsh -- [path-to-candidate-tgz]
 *
 * `--force-peers` is an explicit INVESTIGATIVE run that ignores the published
 * bridge's DSH peers; it is never used by CI and never produces a published
 * compatibility claim. `--distribution` is refused: this probe validates only
 * the published npm ecosystem, and Source Mode has its own lanes.
 *
 * Set PI2DSH_COMPAT_DEBUG_DIR to preserve pane.txt, tui.log, evidence.json,
 * header-evidence.json, and versions.json when the gate fails. Set
 * PI2DSH_COMPAT_KEEP=1 to retain the complete temporary test environment.
 * @module pi2dsh-compat-smoke
 */

import { builtinModules } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, relative, sep as pathSeparator } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import semver from 'semver'
import {
  candidateArgument,
  compatibilityFailureLine,
  CompatFailure,
  delay,
  distributionArgument,
  dshInvocation,
  EXPECTED_PACKAGE_NAME,
  fail,
  installPlugin,
  isolatedEnvironment,
  packageMetadata,
  PNPM_COMMAND,
  readJson,
  readOptionalJson,
  readText,
  redact,
  redactedJson,
  requireExactVersion,
  resolveTarball,
  resultText,
  run,
  runDsh,
  runPnpmInstall,
  setSmokeDeadline,
  sha256,
  shellQuote,
  SUBPROCESS_TIMEOUTS,
  tail,
  TIMEOUTS,
  tmuxRunner,
  validateCandidatePackageData,
  validateCandidateTarball,
  waitUntil,
  writeHeaderProbePackage,
  writeLauncher,
} from './lib/dsh-smoke-harness.mjs'
import { DSH_CLI_PACKAGE, loadDshDistribution, PACKAGE_ROOT } from './lib/dsh-distribution.mjs'
import { selectPublishedPi2dshPairing } from './lib/pi2dsh-compat-selection.mjs'

const CONSUMER_PACKAGE_NAME = 'pi2dsh'
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'pi2dsh-compat')
const CI_ECOSYSTEM_TIMEOUT_MS = 15 * 60_000
const CLEANUP_BUDGET_MS = 30_000
// Keep the whole smoke below the CI job ceiling, with room for diagnostics and cleanup.
const GATE_BUDGET_MS = CI_ECOSYSTEM_TIMEOUT_MS - 3 * 60_000
const RESIZE_FAILURE_PHASE = 'COMPAT_SURFACE_FAILURE'

/**
 * Consumer-specific diagnostics the published pi2dsh surface must never emit.
 * The shared detector is consumer-neutral; these lines are this entry's
 * business, not the harness's.
 */
const PI2DSH_DEGRADATION_PATTERNS = [
  /\bpi2dsh\b[^\n]*(?:fatal|unsupported|cannot|could not|failed)/iu,
  /\bpi2dsh\b[^\n]*\b(?:degrad(?:ed|es|ing)|headless|inert)\b/iu,
  /\b(?:headless|inert)\b[^\n]*\bpi2dsh\b/iu,
]

/** The first line that is a generic or pi2dsh-specific surface failure. */
function pi2dshCompatibilityFailureLine(text) {
  return String(text).split(/\r?\n/u).find(line =>
    compatibilityFailureLine(line) !== undefined
    || PI2DSH_DEGRADATION_PATTERNS.some(pattern => pattern.test(line)))
}

function assertNoPi2dshSurfaceFailures(tuiLog, tmux) {
  const text = `${readText(tuiLog)}\n${tmux.capturePane()}`
  const failedLine = pi2dshCompatibilityFailureLine(text)
  if (failedLine !== undefined) {
    fail('COMPAT_BOOT_FAILURE', `published pi2dsh reported an incompatible surface: ${failedLine.trim()}`)
  }
}

/**
 * The explicit INVESTIGATIVE selector mode. `--force-peers` skips ONLY the
 * published pi2dsh DSH peer constraints when choosing the DSH version; the
 * candidate TUI's DSH peers and engines.dsh still apply, and the real install
 * and PTY smoke still run. It never runs in CI and its result is never a
 * published compatibility claim.
 */
function forcePeersArgument(args) {
  return args.includes('--force-peers') || process.env.PI2DSH_COMPAT_FORCE_PEERS === '1'
}

function relevantDshPeerEntries(packageJson) {
  return Object.entries(packageJson?.peerDependencies ?? {})
    .filter(([name, range]) => (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
      && typeof range === 'string' && range.trim() !== '')
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

function packageVersion(profileDir, packageName) {
  return packageMetadata(profileDir, packageName)?.version
}

function npmView(label, args, env, runCommand) {
  const result = runCommand('npm', [...args, '--json', '--registry=https://registry.npmjs.org'], {
    cwd: PACKAGE_ROOT,
    env,
    timeout: SUBPROCESS_TIMEOUTS.install,
  })
  if (result.status !== 0) {
    fail('INFRA_INSTALL_FAILURE', `published ${label} metadata could not be read:\n${resultText(result)}`)
  }
  try {
    return JSON.parse(result.stdout)
  } catch (error) {
    fail('INFRA_INSTALL_FAILURE', `published ${label} metadata is invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Read the CURRENT npm `pi2dsh@latest` package object. The registry transport
 * is an external boundary, so a malformed package object is an
 * INFRA_INSTALL_FAILURE here; the pure selector still re-validates the
 * semantic peer contract.
 */
function publishedConsumerMetadata(env, runCommand = run) {
  const metadata = npmView('pi2dsh@latest', ['view', 'pi2dsh@latest'], env, runCommand)
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    fail('INFRA_INSTALL_FAILURE', 'published pi2dsh@latest metadata did not contain a package object')
  }
  if (metadata.name !== CONSUMER_PACKAGE_NAME) {
    fail('INFRA_INSTALL_FAILURE', `published pi2dsh@latest metadata names ${JSON.stringify(metadata.name)}, not 'pi2dsh'`)
  }
  if (semver.valid(metadata.version) !== metadata.version) {
    fail('INFRA_INSTALL_FAILURE', `published pi2dsh@latest version ${JSON.stringify(metadata.version)} is not an exact semver version`)
  }
  if (metadata.peerDependencies !== undefined
    && (metadata.peerDependencies === null || typeof metadata.peerDependencies !== 'object' || Array.isArray(metadata.peerDependencies))) {
    fail('INFRA_INSTALL_FAILURE', 'published pi2dsh@latest peerDependencies is not an object')
  }
  return metadata
}

/** Read the published @deepseek-ai/dsh version list from the public registry. */
function publishedDshVersionList(env, runCommand = run) {
  const versions = npmView('@deepseek-ai/dsh versions', ['view', '@deepseek-ai/dsh', 'versions'], env, runCommand)
  if (!Array.isArray(versions) || versions.length === 0) {
    fail('INFRA_INSTALL_FAILURE', 'published @deepseek-ai/dsh versions metadata is empty or not an array')
  }
  for (const version of versions) {
    if (semver.valid(version) !== version) {
      fail('INFRA_INSTALL_FAILURE', `published @deepseek-ai/dsh version list contains an invalid version: ${JSON.stringify(version)}`)
    }
  }
  return versions
}

/**
 * Resolve the exact published pair for this run. The npm fetch and the pure
 * selection are ONE narrow function so a test can drive the real parse →
 * selection → install-spec path through an injected `run` implementation
 * without installing anything.
 */
export function resolvePublishedPairing({ candidatePackage, env, investigativeForcePeers = false, runCommand = run }) {
  const consumerPackage = publishedConsumerMetadata(env, runCommand)
  const publishedDshVersions = publishedDshVersionList(env, runCommand)
  let selection
  try {
    selection = selectPublishedPi2dshPairing({
      consumerPackage,
      candidatePackage,
      publishedDshVersions,
      investigativeForcePeers,
    })
  } catch (error) {
    fail('ECOSYSTEM_CONTRACT_BLOCKER', error instanceof Error ? error.message : String(error))
  }
  return {
    consumerPackage,
    pi2dshVersion: selection.pi2dshVersion,
    dshVersion: selection.dshVersion,
    tuiPeerDrift: selection.tuiPeerDrift,
    investigative: investigativeForcePeers,
    bridgeSpec: `${CONSUMER_PACKAGE_NAME}@${selection.pi2dshVersion}`,
    dshFamilySpec: `${DSH_CLI_PACKAGE}@${selection.dshVersion}`,
  }
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

function diagnosticsContext(context) {
  const pairing = context.pairing
  const profileDir = context.dshHome === undefined ? undefined : join(context.dshHome, 'profiles', 'pi-tui')
  return {
    candidate: context.tarball === undefined ? undefined : {
      basename: basename(context.tarball),
      sha256: sha256(context.tarball),
      package: context.candidatePackage === undefined ? undefined : {
        name: context.candidatePackage.name,
        version: context.candidatePackage.version,
      },
    },
    pairing: pairing === undefined ? undefined : {
      pi2dshVersion: pairing.pi2dshVersion,
      dshVersion: pairing.dshVersion,
      tuiPeerDrift: pairing.tuiPeerDrift,
      investigative: pairing.investigative,
      bridgeSpec: pairing.bridgeSpec,
      dshFamilySpec: pairing.dshFamilySpec,
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
  console.error(`resolved pi2dsh: ${redact(versions.pairing?.pi2dshVersion ?? '(unresolved)')}`)
  console.error(`resolved DSH: ${redact(versions.pairing?.dshVersion ?? '(unresolved)')}`)
  console.error(`tui peer drift: ${String(versions.pairing?.tuiPeerDrift ?? '(unresolved)')}`)
  console.error(`investigative: ${String(versions.pairing?.investigative ?? '(unresolved)')}`)
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
    pairing: undefined,
    consumerPackage: undefined,
    distribution: undefined,
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
  setSmokeDeadline(Date.now() + GATE_BUDGET_MS)
  try {
    const smokeArgs = process.argv.slice(2)
    if (distributionArgument(smokeArgs) !== undefined) {
      fail('COMPAT_BOOT_FAILURE', 'this probe validates only the published npm ecosystem; --distribution (Source Mode) is not supported — the official-presets and source lanes own that qualification')
    }
    const investigativeForcePeers = forcePeersArgument(smokeArgs)
    context.tarball = resolveTarball(candidateArgument(smokeArgs))
    context.candidatePackage = validateCandidateTarball(context.tarball)
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
    context.pairing = resolvePublishedPairing({
      candidatePackage: context.candidatePackage,
      env,
      investigativeForcePeers,
    })
    context.consumerPackage = context.pairing.consumerPackage
    if (context.pairing.investigative) {
      console.log('INVESTIGATIVE (--force-peers): the published pi2dsh DSH peers are ignored for selection; this run is a manual investigation and never a published compatibility claim')
    }
    if (context.pairing.tuiPeerDrift) {
      console.log(`METADATA_DRIFT: pi2dsh@${context.pairing.pi2dshVersion} still declares ${EXPECTED_PACKAGE_NAME} ${context.pairing.consumerPackage.peerDependencies?.[EXPECTED_PACKAGE_NAME]}, which does not cover the candidate ${context.candidatePackage.version}; the real install and PTY smoke decide`)
    }
    console.log(`RESOLVED_EXTERNAL_PAIRING: ${context.pairing.bridgeSpec} × DSH ${context.pairing.dshVersion}${context.pairing.investigative ? ' (INVESTIGATIVE)' : ''}`)

    context.distribution = loadDshDistribution({ mode: 'npm', version: context.pairing.dshVersion })
    if (context.distribution.version !== context.pairing.dshVersion) {
      fail('COMPAT_BOOT_FAILURE', `DSH distribution version mismatch: expected ${context.pairing.dshVersion}, got ${context.distribution.version}`)
    }

    writeFileSync(join(harnessDir, 'package.json'), JSON.stringify({
      name: 'dsh-pi2dsh-compat-harness',
      private: true,
      type: 'module',
      dependencies: {
        '@deepseek-ai/dsh': context.pairing.dshVersion,
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
    requireExactVersion('DSH', context.dshVersion, context.pairing.dshVersion)

    installPlugin(dsh, context.tarball, harnessDir, env, false)
    const profileDir = join(dshHome, 'profiles', 'pi-tui')
    validateCandidatePackageData(packageMetadata(profileDir, context.candidatePackage.name), context.candidatePackage)
    installPlugin(dsh, context.pairing.bridgeSpec, harnessDir, env, true)
    requireExactVersion(CONSUMER_PACKAGE_NAME, packageVersion(profileDir, CONSUMER_PACKAGE_NAME), context.pairing.pi2dshVersion)
    if (packageMetadata(profileDir, CONSUMER_PACKAGE_NAME) === undefined) {
      fail('INFRA_INSTALL_FAILURE', `installed ${CONSUMER_PACKAGE_NAME} package metadata is missing from the isolated profile`)
    }
    installPlugin(dsh, writeHeaderProbePackage(workDir), harnessDir, env, false)
    installPlugin(dsh, fixtureDir, harnessDir, env, false)

    const socket = `dsh-pi2dsh-compat-${process.pid}`
    const session = `compat-${process.pid}`
    const tmux = tmuxRunner(socket, session, env, { resizeFailurePhase: RESIZE_FAILURE_PHASE })
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
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

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
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

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
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

    tmux.sendKey('r')
    await waitUntil('Pi raw input marker', TIMEOUTS.input, () => {
      const evidence = readEvidence(evidencePath)
      return evidence.inputs?.at(-1) === 'r' && tmux.capturePane().includes('PI2DSH_COMPAT_INPUT=r')
    }, 'COMPAT_INPUT_FAILURE')
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

    const widthsBeforeResize = readEvidence(evidencePath).renderWidths ?? []
    tmux.resize(100, 30)
    await waitUntil('Pi resize evidence', TIMEOUTS.input, () => {
      const widths = readEvidence(evidencePath).renderWidths ?? []
      return hasFreshResizeWidth(widths, widthsBeforeResize)
    }, RESIZE_FAILURE_PHASE)
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

    tmux.sendKey('q')
    await waitUntil('Pi component dispose', TIMEOUTS.dispose, () => readEvidence(evidencePath).disposeCount === 1, 'COMPAT_DISPOSE_FAILURE')
    await delay(250)
    tmux.resize(99, 30)
    await delay(250)
    const disposedEvidence = readEvidence(evidencePath)
    if (disposedEvidence.doneCount !== 1) fail('COMPAT_DISPOSE_FAILURE', `Pi custom component must invoke done exactly once before close: ${disposedEvidence.doneCount}`)
    if (disposedEvidence.disposeCount !== 1) fail('COMPAT_DISPOSE_FAILURE', `component dispose count changed after close: ${disposedEvidence.disposeCount}`)
    if (tmux.capturePane().includes('PI2DSH_COMPAT_READY')) fail('COMPAT_DISPOSE_FAILURE', 'closed Pi component remained visible after dispose')
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

    tmux.sendLiteral('host-ok')
    await delay(350)
    await waitUntil('host editor after component close', TIMEOUTS.dispose, () => tmux.capturePane().includes('host-ok'), 'COMPAT_DISPOSE_FAILURE')
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)

    tmux.sendKey('C-c')
    await delay(250)
    tmux.sendLiteral('/exit')
    await delay(350)
    tmux.sendKey('Enter')
    await waitUntil('TUI shutdown', TIMEOUTS.dispose, () => !tmux.hasSession(), 'COMPAT_DISPOSE_FAILURE')
    assertNoPi2dshSurfaceFailures(tuiLog, tmux)
    console.log(`pi2dsh compatibility smoke passed — ${basename(context.tarball)} × ${context.pairing.bridgeSpec} × DSH ${context.pairing.dshVersion}`)
    console.log(`candidate: ${context.candidatePackage.name}@${context.candidatePackage.version} sha256=${sha256(context.tarball)}`)
    console.log(`bridge: ${context.pairing.bridgeSpec}`)
    console.log(`dsh: ${context.pairing.dshVersion}`)
    console.log(`tui peer drift: ${context.pairing.tuiPeerDrift}`)
    console.log(`PI2DSH_COMPAT_RESULT=${context.pairing.investigative ? 'INVESTIGATIVE_PASS' : 'PASS'}`)
  } catch (error) {
    context.error = error
    preserveDiagnostics(context)
    throw error
  } finally {
    context.tmux?.stop?.()
    if (context.workDir !== undefined && process.env.PI2DSH_COMPAT_KEEP !== '1') {
      rmSync(context.workDir, { recursive: true, force: true })
    }
    setSmokeDeadline(undefined)
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.exitCode = 1
  })
}

export {
  assertNoPi2dshSurfaceFailures,
  CI_ECOSYSTEM_TIMEOUT_MS,
  CLEANUP_BUDGET_MS,
  fixtureImportViolations,
  forcePeersArgument,
  GATE_BUDGET_MS,
  hasFreshResizeWidth,
  pi2dshCompatibilityFailureLine,
  RESIZE_FAILURE_PHASE,
  validateFixturePackageData,
}
