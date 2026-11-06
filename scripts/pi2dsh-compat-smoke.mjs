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
 * independent `official-presets-smoke.mjs` gate, which owns that matrix; this
 * consumer gate neither imports nor hides it. The fixture is intentionally not
 * allowed to import this repository or any pi2dsh private module.
 *
 * The isolated installation, real-terminal and diagnostic primitives this gate
 * shares with the other smoke entries live in `lib/dsh-smoke-harness.mjs`.
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

import { builtinModules } from 'node:module'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, relative, sep as pathSeparator } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import semver from 'semver'
import { API_VERSION } from '../src/extension/public-types.ts'
import { UNSTABLE_API_LEVEL } from '../src/extension/unstable-types.ts'
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
import {
  DEFAULT_SOURCE_CONFIG,
  loadDshDistribution,
  loadDshSourceConfig,
  PACKAGE_ROOT,
} from './lib/dsh-distribution.mjs'

const CONSUMER_PACKAGE_NAME = 'pi2dsh'
const MANIFEST_PATH = join(PACKAGE_ROOT, 'test', 'compat', 'pi2dsh.json')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'pi2dsh-compat')

/**
 * The ONLY dispositions this gate may transmit. `passed` means the complete
 * real PTY smoke ran; `skipped-unsupported-dsh-peer` is the Owner-approved,
 * PR-only typed skip for a published consumer whose DSH peers provably do not
 * cover the target DSH. Nothing else may be written, and neither value ever
 * means "release qualified" by itself.
 */
const DISPOSITION_PASSED = 'passed'
const DISPOSITION_SKIPPED_UNSUPPORTED_DSH_PEER = 'skipped-unsupported-dsh-peer'
const PI2DSH_COMPAT_DISPOSITIONS = new Set([DISPOSITION_PASSED, DISPOSITION_SKIPPED_UNSUPPORTED_DSH_PEER])

/** The CI-only ref shape on which the typed unsupported-peer skip may run. */
const PULL_REQUEST_REF = /^refs\/pull\/[0-9]+\/merge$/u
// The required contracts are DERIVED from the production extension surface,
// never hand-written here: the published pi2dsh bridge hosts Pi components
// only when the host reports the CURRENT apiVersion and advertises the
// unstable raw-surface capability (it otherwise degrades to a warning and
// mounts no component), so a contract list frozen at an older api version
// would certify a pairing the bridge cannot actually use. Deriving it keeps
// the gate honest when the extension surface moves.
const REQUIRED_CONTRACTS = [
  'root.LOCAL_COMMANDS',
  `extensions/unstable.UNSTABLE_API_LEVEL=${UNSTABLE_API_LEVEL}`,
  `apiVersion=${API_VERSION}`,
  'capability:unstable.surface.handle',
  'chrome.footer.status',
  'surface.mountComponent',
  'component.render',
  'component.input',
  'component.done',
  'component.dispose',
]
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
 * Whether the metadata preflight is bypassed. `--force-peers` runs the REAL
 * runtime smoke even when the published pi2dsh peer declaration does not
 * cover the candidate: a stale peer range can under-declare genuine runtime
 * compatibility, and the forced run answers that question with evidence.
 * The result is INVESTIGATIVE — it never replaces the blocking preflight in
 * the release gate, and the console explicitly marks the bypass.
 */
function forcePeersArgument(args) {
  return args.includes('--force-peers') || process.env.PI2DSH_COMPAT_FORCE_PEERS === '1'
}

/**
 * The NARROW stale-peer allowance: `--allow-stale-tui-peer` permits ONLY the
 * `@xmoon76/dsh-pi-tui` peer range mismatch (classified as stale-tui-peer)
 * to proceed to the targeted real runtime smoke, whose result decides.
 * Every other preflight problem — a `@deepseek-ai/dsh-*` peer mismatch,
 * missing dsh peers, package/version or API contract problems — stays
 * blocking. Unlike the wide `--force-peers` (investigative only), this is
 * the flag the release CI uses.
 */
function allowStaleTuiPeerArgument(args) {
  return args.includes('--allow-stale-tui-peer') || process.env.PI2DSH_COMPAT_ALLOW_STALE_TUI_PEER === '1'
}

/** Whether the Owner-approved, PR-only typed skip is requested on the CLI. */
function skipUnsupportedDshPeerOnPrArgument(args) {
  return args.includes('--skip-unsupported-dsh-peer-on-pr')
}

/**
 * The disposition transport path. The explicit `--disposition-file` option
 * wins; CI may alternatively export `PI2DSH_COMPAT_DISPOSITION_FILE`. The path
 * must be ABSOLUTE: the script is often launched from a pnpm `--` argv and a
 * relative path would land somewhere nobody reads.
 */
function dispositionFileArgument(args) {
  const index = args.indexOf('--disposition-file')
  const fromEnvironment = process.env.PI2DSH_COMPAT_DISPOSITION_FILE
  let value
  if (index >= 0) {
    value = args[index + 1]
    if (value === undefined || value === '' || value.startsWith('--')) {
      fail('COMPAT_BOOT_FAILURE', '--disposition-file requires an absolute temp file path')
    }
  } else if (fromEnvironment !== undefined && fromEnvironment !== '') {
    value = fromEnvironment
  }
  if (value === undefined) return undefined
  if (!isAbsolute(value)) fail('COMPAT_BOOT_FAILURE', `the pi2dsh disposition file path must be absolute: ${value}`)
  return value
}

/** Whether the actual CI ref is a pull-request merge ref. */
function isPullRequestRef(ref) {
  return typeof ref === 'string' && PULL_REQUEST_REF.test(ref)
}

/**
 * Write exactly one disposition ATOMICALLY (a same-directory temporary path
 * followed by a rename). A crash can therefore never leave a half-written
 * success file behind for CI to read.
 */
function writeDispositionFile(path, disposition) {
  if (path === undefined) return
  if (!PI2DSH_COMPAT_DISPOSITIONS.has(disposition)) {
    fail('COMPAT_BOOT_FAILURE', `refusing to write an unknown pi2dsh compatibility disposition: ${String(disposition)}`)
  }
  const temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${disposition}\n`, 'utf8')
  renameSync(temporary, path)
}

function unsupportedDshPeerProblems(peers) {
  return peers.map(([name, range]) => `  ${name}: ${range}`)
}

/**
 * The ONE condition under which the typed skip may replace the real smoke:
 * the classification is exactly `unsupported-dsh-peer`, the explicit PR-only
 * CLI flag was given, the actual GitHub ref is a PR merge ref, and a usable
 * disposition path exists. Anything else fails closed into the normal
 * blocking preflight — a tag/branch/missing ref can never skip.
 */
function unsupportedDshPeerSkipAllowed({ classification, skipRequested, ref, dispositionFile }) {
  return classification?.kind === 'unsupported-dsh-peer'
    && skipRequested === true
    && isPullRequestRef(ref)
    && typeof dispositionFile === 'string'
    && dispositionFile !== ''
}

function resolveDshDistribution(args, targetVersion) {
  const distributionPath = distributionArgument(args)
  if (distributionPath === undefined) return loadDshDistribution({ mode: 'npm', version: targetVersion })
  return loadDshDistribution({
    mode: 'source',
    manifest: resolve(distributionPath),
    packageJson: join(PACKAGE_ROOT, 'package.json'),
    sourceConfig: loadDshSourceConfig(DEFAULT_SOURCE_CONFIG),
  })
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

/**
 * Classify the published consumer's peer declaration against the target DSH
 * and candidate TUI:
 * - `{ kind: 'ok' }` — every declared peer covers the candidate;
 * - `{ kind: 'stale-tui-peer', tuiRange }` — ONLY the
 *   `@xmoon76/dsh-pi-tui` peer fails to cover the candidate while every
 *   `@deepseek-ai/dsh-*` peer covers the target DSH. This is a stale
 *   third-party declaration: the targeted real runtime smoke decides when
 *   `--allow-stale-tui-peer` is given;
 * - `{ kind: 'unsupported-dsh-peer', peers }` — every declared DSH range is a
 *   VALID range that provably excludes the target DSH, and NOTHING else is
 *   wrong (no missing peers, no invalid range, no stale/missing TUI peer, no
 *   broken metadata). This is the ONLY classification the Owner-approved
 *   PR-only typed skip may accept;
 * - `{ kind: 'block', problems }` — anything else (missing peers, missing TUI
 *   peer, invalid versions/ranges, a mixed DSH+TUI problem, broken metadata)
 *   is always blocking.
 */
function classifyConsumerMetadata(consumerPackage, manifest, candidatePackage) {
  if (typeof consumerPackage !== 'object' || consumerPackage === null || Array.isArray(consumerPackage)) {
    return { kind: 'block', problems: ['  published consumer metadata: (not a package object)'] }
  }
  const peerDependencies = consumerPackage.peerDependencies
  if (peerDependencies !== undefined
    && (typeof peerDependencies !== 'object' || peerDependencies === null || Array.isArray(peerDependencies))) {
    return { kind: 'block', problems: ['  peerDependencies: (malformed)'] }
  }
  const tuiRange = peerDependencies?.[EXPECTED_PACKAGE_NAME]
  // A DSH-ish peer with a non-string/empty range is broken metadata, not a
  // peer that simply did not cover the target: it must stay blocking.
  const malformedDshPeers = Object.entries(peerDependencies ?? {}).filter(([name, range]) =>
    (name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-'))
    && (typeof range !== 'string' || range.trim() === ''))
  if (malformedDshPeers.length > 0) {
    return { kind: 'block', problems: malformedDshPeers.map(([name]) => `  ${name}: (invalid declared range)`) }
  }
  const dshPeers = relevantDshPeerEntries(consumerPackage)
  const unsupportedDshPeers = dshPeers.filter(([, range]) => !rangeIncludesVersion(range, manifest.dshVersion))

  if (dshPeers.length === 0) {
    return { kind: 'block', problems: ['  @deepseek-ai/dsh-* peers: (none declared)'] }
  }
  // A MISSING TUI peer is a contract blocker, not a stale range: "declared
  // too old" can be proven stale by the real runtime smoke, but "never
  // declared a dependency on the TUI at all" cannot.
  const tuiMissing = typeof tuiRange !== 'string' || tuiRange.trim() === ''
  const tuiStale = !tuiMissing && !rangeIncludesVersion(tuiRange, candidatePackage.version)
  const tuiRangeInvalid = !tuiMissing && semver.validRange(tuiRange) === null
  if (unsupportedDshPeers.length > 0) {
    const dshRangesValid = dshPeers.every(([, range]) => semver.validRange(range) !== null)
    const versionsValid = semver.valid(manifest.dshVersion) !== null && semver.valid(candidatePackage.version) !== null
    const identityValid = consumerPackage.name === CONSUMER_PACKAGE_NAME
      && consumerPackage.version === manifest.pi2dshVersion
    const tuiCoversCandidate = !tuiMissing && !tuiStale && !tuiRangeInvalid
    if (dshRangesValid && versionsValid && identityValid && tuiCoversCandidate) {
      return { kind: 'unsupported-dsh-peer', peers: unsupportedDshPeers }
    }
    // The typed skip is unavailable, so report EVERY blocking fact (never only
    // the DSH ranges) and stay blocking.
    const problems = unsupportedDshPeerProblems(unsupportedDshPeers)
    if (tuiMissing) problems.push(`  ${EXPECTED_PACKAGE_NAME}: (missing)`)
    else if (tuiRangeInvalid) problems.push(`  ${EXPECTED_PACKAGE_NAME}: ${tuiRange} (invalid range)`)
    else if (tuiStale) problems.push(`  ${EXPECTED_PACKAGE_NAME}: ${tuiRange}`)
    if (!dshRangesValid) {
      problems.push('  @deepseek-ai/dsh-* peers: (a declared range is not a valid semver range)')
    }
    if (!versionsValid) problems.push('  versions: (the manifest or candidate version is not a valid semver)')
    if (!identityValid) problems.push(`  published consumer identity: (expected ${CONSUMER_PACKAGE_NAME}@${manifest.pi2dshVersion})`)
    return { kind: 'block', problems }
  }
  if (tuiMissing) {
    return { kind: 'block', problems: [`  ${EXPECTED_PACKAGE_NAME}: (missing)`] }
  }
  if (tuiStale) return { kind: 'stale-tui-peer', tuiRange }
  return { kind: 'ok' }
}

function failConsumerMetadata(consumerPackage, manifest, candidatePackage, problems) {
  const consumerName = typeof consumerPackage?.name === 'string' ? consumerPackage.name : 'pi2dsh'
  const consumerVersion = typeof consumerPackage?.version === 'string' ? consumerPackage.version : '(unknown version)'
  fail('ECOSYSTEM_CONTRACT_BLOCKER', [
    `${consumerName}@${consumerVersion} does not declare support for:`,
    `  DSH ${manifest.dshVersion}`,
    `  ${EXPECTED_PACKAGE_NAME} ${candidatePackage.version}`,
    'Declared ranges that do not cover the candidate:',
    ...problems,
  ].join('\n'))
}

/**
 * The blocking metadata preflight. Throws `ECOSYSTEM_CONTRACT_BLOCKER` for a
 * DSH peer mismatch, missing dsh peers, or any other contract problem; a
 * stale-TUI-peer-only classification is returned (not thrown) so the caller
 * can run the targeted runtime smoke under `--allow-stale-tui-peer`. The
 * typed `unsupported-dsh-peer` classification is returned so the CALLER can
 * decide whether the narrow PR-only skip is permissible; everywhere else it is
 * blocking exactly like before.
 */
function validateConsumerMetadata(consumerPackage, manifest, candidatePackage) {
  const classification = classifyConsumerMetadata(consumerPackage, manifest, candidatePackage)
  if (classification.kind === 'block') {
    failConsumerMetadata(consumerPackage, manifest, candidatePackage, classification.problems)
  }
  if (classification.kind === 'unsupported-dsh-peer') {
    failConsumerMetadata(consumerPackage, manifest, candidatePackage, unsupportedDshPeerProblems(classification.peers))
  }
  return classification
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
  setSmokeDeadline(Date.now() + GATE_BUDGET_MS)
  try {
    const smokeArgs = process.argv.slice(2)
    const dispositionFile = dispositionFileArgument(smokeArgs)
    const skipUnsupportedDshPeerOnPr = skipUnsupportedDshPeerOnPrArgument(smokeArgs)
    if (skipUnsupportedDshPeerOnPr && dispositionFile === undefined) {
      fail('COMPAT_BOOT_FAILURE', '--skip-unsupported-dsh-peer-on-pr requires --disposition-file (or PI2DSH_COMPAT_DISPOSITION_FILE): a typed skip must be machine-readable')
    }
    context.tarball = resolveTarball(candidateArgument(smokeArgs))
    context.manifest = readJson(MANIFEST_PATH, 'pi2dsh compatibility manifest')
    context.candidatePackage = validateCandidateTarball(context.tarball)
    validateManifest(context.manifest)
    context.distribution = resolveDshDistribution(smokeArgs, context.manifest.dshVersion)
    if (context.distribution.version !== context.manifest.dshVersion) {
      fail('COMPAT_BOOT_FAILURE', `DSH distribution version mismatch: expected ${context.manifest.dshVersion}, got ${context.distribution.version}`)
    }
    if (context.distribution.kind === 'source-pack') {
      console.log('SKIPPED: a source-pack distribution cannot validate the published pi2dsh ecosystem (run without --dsh-distribution)')
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
    if (forcePeersArgument(smokeArgs)) {
      if (dispositionFile !== undefined) {
        fail('COMPAT_BOOT_FAILURE', '--force-peers is INVESTIGATIVE and can never produce a pi2dsh compatibility disposition')
      }
      console.log('PEER PREFLIGHT BYPASSED (--force-peers): the published peer declaration does not cover the candidate; running the runtime smoke anyway — the result is INVESTIGATIVE and never stands in for the blocking preflight')
    } else {
      const classification = classifyConsumerMetadata(context.consumerPackage, context.manifest, context.candidatePackage)
      if (unsupportedDshPeerSkipAllowed({
        classification,
        skipRequested: skipUnsupportedDshPeerOnPr,
        ref: process.env.GITHUB_REF,
        dispositionFile,
      })) {
        // The Owner-approved PR-only typed skip: the published DSH peers
        // PROVABLY exclude the target and nothing else is wrong. Do not install
        // the candidate, the bridge or the fixture, and never claim runtime
        // compatibility. The disposition is the only artifact.
        writeDispositionFile(dispositionFile, DISPOSITION_SKIPPED_UNSUPPORTED_DSH_PEER)
        console.log(`PI2DSH_COMPAT_DISPOSITION=${DISPOSITION_SKIPPED_UNSUPPORTED_DSH_PEER}`)
        console.log('PI2DSH_COMPAT_EVIDENCE=published-peer-mismatch')
        console.log('PI2DSH_RUNTIME_QUALIFIED=false')
        console.log(`UNSUPPORTED_DSH_PEER: ${CONSUMER_PACKAGE_NAME}@${context.consumerPackage.version} declares ${classification.peers.map(([name, range]) => `${name} ${range}`).join(', ')}, which does not cover DSH ${context.manifest.dshVersion}`)
        console.log(`NOT_QUALIFIED: external pi2dsh compatibility for ${CONSUMER_PACKAGE_NAME}@${context.manifest.pi2dshVersion} x DSH ${context.manifest.dshVersion} is NOT qualified; no candidate, bridge or fixture was installed. This PR-only typed skip is not a release qualification and never becomes one.`)
        return
      }
      const preflight = validateConsumerMetadata(context.consumerPackage, context.manifest, context.candidatePackage)
      if (preflight.kind === 'stale-tui-peer') {
        if (!allowStaleTuiPeerArgument(smokeArgs)) {
          failConsumerMetadata(context.consumerPackage, context.manifest, context.candidatePackage, [`  ${EXPECTED_PACKAGE_NAME}: ${preflight.tuiRange}`])
        }
        context.staleTuiPeer = preflight.tuiRange
        console.log(`STALE_EXTERNAL_PEER: ${CONSUMER_PACKAGE_NAME}@${context.consumerPackage.version} declares ${EXPECTED_PACKAGE_NAME} ${preflight.tuiRange}, which does not cover the candidate ${context.candidatePackage.version}; the DSH peers cover ${context.manifest.dshVersion}. Running the targeted real runtime smoke — its result decides (--allow-stale-tui-peer).`)
      }
    }
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
    console.log(`pi2dsh compatibility smoke passed — ${basename(context.tarball)} × pi2dsh@${context.manifest.pi2dshVersion}`)
    if (context.staleTuiPeer !== undefined) {
      console.log(`WARN: ${CONSUMER_PACKAGE_NAME}@${context.manifest.pi2dshVersion} still declares ${EXPECTED_PACKAGE_NAME} ${context.staleTuiPeer} (stale peer declaration — does not cover ${context.candidatePackage.version}); the targeted real runtime smoke PASSED, so the stale metadata is a warning, not a blocker. Ask the pi2dsh maintainers to widen the peer (e.g. ^0.3.3 || ^0.4.0-alpha.1).`)
    }
    // Reached ONLY after every preflight and PTY smoke check succeeded.
    writeDispositionFile(dispositionFile, DISPOSITION_PASSED)
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
  classifyConsumerMetadata,
  CLEANUP_BUDGET_MS,
  CI_ECOSYSTEM_TIMEOUT_MS,
  dispositionFileArgument,
  failConsumerMetadata,
  fixtureImportViolations,
  GATE_BUDGET_MS,
  hasFreshResizeWidth,
  isPullRequestRef,
  pi2dshCompatibilityFailureLine,
  PI2DSH_COMPAT_DISPOSITIONS,
  REQUIRED_CONTRACTS,
  RESIZE_FAILURE_PHASE,
  skipUnsupportedDshPeerOnPrArgument,
  unsupportedDshPeerSkipAllowed,
  validateConsumerMetadata,
  validateFixturePackageData,
  validateManifest,
  validateTargetDshManifest,
  writeDispositionFile,
}
