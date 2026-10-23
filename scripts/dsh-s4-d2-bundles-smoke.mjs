#!/usr/bin/env node
/**
 * S4-D2 Optional-bundle CLI smoke (implementation plan §4.1).
 *
 * Three explicit modes, never a fake pass:
 *
 * - default (no flags): OFFLINE inspection of the provisioned official
 *   installation used by `test/support/optional-bundle-fixture.ts`.
 *   A missing/wrong-version artifact is `BLOCKED`; npm/profile/restart and any
 *   external/native capability stay `EXTERNAL_UNVERIFIED` (this mode performs
 *   no public network call).
 * - `--network`: the REAL pinned-npm CLI profile loop: install
 *   `@deepseek-ai/dsh@<exact target>` into an isolated harness, install one exact
 *   `@deepseek-ai/dsh-experimental-*@<exact target>` bundle into an isolated
 *   profile, compose/restart the profile with `--dump-config`, then remove the
 *   dependency and dump again. Requires an explicit flag because it downloads
 *   public npm artifacts.
 * - `--native`: the explicit external Claude Code / Codex credential gate. It
 *   records the presence/absence of the official environment credentials and
 *   `EXTERNAL_UNVERIFIED`; the REAL native start lives behind the unit-test gate
 *   `DSH_PI_TUI_S4_D2_NATIVE=1` (`test/integration/native-subagents.test.ts`) under an
 *   isolated HOME. This CLI never fabricates a native success.
 * - `--gate`: operator/CI gate mode. Exit nonzero whenever the provisioned
 *   fixture is BLOCKED instead of silently treating the offline inspection as a
 *   pass.
 * - `--provision`: install the official package set at this checkout's exact
 *   target into the fixture's `temp/s4-d2-bundles` tree (a local test artifact,
 *   never a tracked dependency). This is the one-time setup the in-process
 *   fixture consumes.
 *
 * Usage:
 *   node scripts/dsh-s4-d2-bundles-smoke.mjs --provision
 *   node scripts/dsh-s4-d2-bundles-smoke.mjs --network --evidence /tmp/d2.json
 *   node scripts/dsh-s4-d2-bundles-smoke.mjs --native
 *
 * @module dsh-s4-d2-bundles-smoke
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  dshInvocation,
  isolatedEnvironment,
  requireExactVersion,
  run,
  runDsh,
  runPnpmInstall,
} from './pi2dsh-compat-smoke.mjs'
import { loadDshDistribution, npmDshVersion } from './lib/dsh-distribution.mjs'
import { pnpmExecutable } from './lib/process.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** The exact DSH family this checkout develops against. Provisioned artifacts
 *  and the profile loop must match the same manifest the version bump edits. */
const TARGET_VERSION = npmDshVersion()
const PNPM_COMMAND = pnpmExecutable()
const FIXTURE_CACHE = join(REPO_ROOT, 'temp', 's4-d2-bundles')
const PROVISION_TIMEOUT_MS = 20 * 60_000

const SHIPPED_OPTIONAL = [
  '@deepseek-ai/dsh-experimental-agent-team-profile',
  '@deepseek-ai/dsh-experimental-voice-input-bundle',
  '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile',
  '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle',
  '@deepseek-ai/dsh-experimental-terminal-bundle',
  '@deepseek-ai/dsh-experimental-session-search',
  '@deepseek-ai/dsh-experimental-session-titles-bundle',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle',
  '@deepseek-ai/dsh-experimental-ralph-bundle',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle',
]
const ON_DEMAND = [
  '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code',
]
const ALL_BUNDLES = [...SHIPPED_OPTIONAL, ...ON_DEMAND]

/** A row package name each bundle's real patch inserts (the composed tree is
 *  read as row names, so the bundle package itself need not appear). */
const BUNDLE_ROW_MARKERS = {
  '@deepseek-ai/dsh-experimental-agent-team-profile': '@deepseek-ai/dsh-experimental-agent-team',
  '@deepseek-ai/dsh-experimental-voice-input-bundle': '@deepseek-ai/dsh-experimental-speech-to-text',
  '@deepseek-ai/dsh-experimental-auto-review': '@deepseek-ai/dsh-experimental-auto-review',
  '@deepseek-ai/dsh-experimental-inspector-profile': '@deepseek-ai/dsh-experimental-inspector',
  '@deepseek-ai/dsh-experimental-tool-worktree': '@deepseek-ai/dsh-experimental-tool-worktree',
  '@deepseek-ai/dsh-experimental-cot-translation-bundle': '@deepseek-ai/dsh-experimental-translator',
  '@deepseek-ai/dsh-experimental-terminal-bundle': '@deepseek-ai/dsh-tool-terminal',
  '@deepseek-ai/dsh-experimental-session-search': '@deepseek-ai/dsh-tool-session-query',
  '@deepseek-ai/dsh-experimental-session-titles-bundle': '@deepseek-ai/dsh-session-title-all-prompts-llm',
  '@deepseek-ai/dsh-experimental-badge-skill-bundle': '@deepseek-ai/dsh-skill-badge',
  '@deepseek-ai/dsh-experimental-ralph-bundle': '@deepseek-ai/dsh-tool-ralph',
  '@deepseek-ai/dsh-experimental-plugin-market-bundle': '@deepseek-ai/dsh-plugin-market',
  '@deepseek-ai/dsh-subagent-codex': '@deepseek-ai/dsh-subagent-codex',
  '@deepseek-ai/dsh-subagent-claude-code': '@deepseek-ai/dsh-subagent-claude-code',
}

function fail(phase, message) {
  throw Object.assign(new Error(message), { phase })
}

function commandOutput(result) {
  return [result.stdout, result.stderr, result.error?.message]
    .filter(value => typeof value === 'string' && value.length > 0)
    .join('\n')
    .trim()
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function packageVersion(nodeModules, packageName) {
  const path = join(nodeModules, packageName, 'package.json')
  if (!existsSync(path)) return undefined
  return readJson(path).version
}

function parseArgs(argv) {
  const options = { network: false, native: false, provision: false, gate: false, bundle: SHIPPED_OPTIONAL[4], evidence: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--network') options.network = true
    else if (arg === '--native') options.native = true
    else if (arg === '--provision') options.provision = true
    else if (arg === '--gate') options.gate = true
    else if (arg === '--bundle') {
      const value = argv[++index]
      if (value === undefined || !ALL_BUNDLES.includes(value)) fail('USAGE', `--bundle must be one of the 14 exact identities: ${value}`)
      options.bundle = value
    } else if (arg === '--evidence') {
      const value = argv[++index]
      if (value === undefined || value.length === 0) fail('USAGE', '--evidence needs a path')
      options.evidence = resolve(value)
    } else {
      fail('USAGE', `unknown argument ${JSON.stringify(arg)}`)
    }
  }
  return options
}

/** The fixture's provisioned installation, as the tests consume it. */
function inspectFixtureInstallation() {
  const nodeModules = join(FIXTURE_CACHE, 'node_modules')
  const problems = []
  const versions = {}
  for (const packageName of ['@deepseek-ai/dsh-base', ...ALL_BUNDLES]) {
    const version = packageVersion(nodeModules, packageName)
    versions[packageName] = version
    if (version === undefined) problems.push(`${packageName} is absent`)
    else if (version !== TARGET_VERSION) problems.push(`${packageName}@${version} is not @${TARGET_VERSION}`)
  }
  return {
    status: problems.length === 0 ? 'PRESENT' : 'BLOCKED',
    root: FIXTURE_CACHE,
    versions,
    ...(problems.length === 0 ? {} : { problems }),
  }
}

/** One-time local provisioning of the official target package set for the tests. */
function provisionFixtureCache(options) {
  mkdirSync(FIXTURE_CACHE, { recursive: true })
  const repoManifest = readJson(join(REPO_ROOT, 'package.json'))
  const dependencies = {
    '@deepseek-ai/dsh-base': TARGET_VERSION,
    ...Object.fromEntries(ALL_BUNDLES.map(name => [name, TARGET_VERSION])),
  }
  for (const [name, version] of Object.entries(repoManifest.devDependencies ?? {})) {
    if (name.startsWith('@deepseek-ai/') && dependencies[name] === undefined) dependencies[name] = version
  }
  writeFileSync(join(FIXTURE_CACHE, 'package.json'), `${JSON.stringify({
    name: 's4-d2-optional-bundles',
    private: true,
    dependencies,
  }, null, 2)}\n`)
  writeFileSync(join(FIXTURE_CACHE, '.npmrc'), [
    'registry=https://registry.npmjs.org/',
    'node-linker=hoisted',
    'shamefully-hoist=true',
    'auto-install-peers=true',
    'minimum-release-age=0',
    '',
  ].join('\n'))
  writeFileSync(join(FIXTURE_CACHE, 'pnpm-workspace.yaml'), [
    'packages: []',
    'allowBuilds:',
    '  esbuild: true',
    '  koffi: false',
    "  '@deepseek-ai/dsh-subprocess-local': true",
    "  '@google/genai': false",
    '  node-pty: false',
    '  protobufjs: false',
    '',
  ].join('\n'))
  const env = { ...process.env, npm_config_registry: 'https://registry.npmjs.org' }
  const result = run(PNPM_COMMAND, [
    'install', '--force', '--ignore-workspace',
    '--config.shamefully-hoist=true', '--config.public-hoist-pattern=*',
    '--config.auto-install-peers=true', '--config.minimum-release-age=0',
    '--no-ignore-scripts',
    '--allow-build=@deepseek-ai/dsh-subprocess-local',
    '--allow-build=!@google/genai', '--allow-build=!koffi', '--allow-build=!node-pty',
    '--allow-build=!protobufjs', '--allow-build=!esbuild',
    '--reporter=append-only',
  ], { cwd: FIXTURE_CACHE, env, timeout: PROVISION_TIMEOUT_MS })
  if (result.status !== 0) fail('INFRA_INSTALL_FAILURE', `fixture cache provisioning failed:\n${commandOutput(result)}`)
  const inspection = inspectFixtureInstallation()
  if (inspection.status !== 'PRESENT') fail('INFRA_INSTALL_FAILURE', `provisioned cache is incomplete: ${(inspection.problems ?? []).join('; ')}`)
  return { status: 'PROVISIONED', ...inspection }
}

/** The composed profile tree one real `dsh` process reports. */
let dumpCounter = 0
function dumpProfileTree(invocation, profile, harnessDir, env, phase) {
  const dumped = runDsh(invocation, ['--profile', profile, '--dump-config'], harnessDir, env)
  if (dumped.status !== 0) fail(phase, `dsh --dump-config failed:\n${commandOutput(dumped)}`)
  const text = commandOutput(dumped)
  if (text.trim().length === 0) fail(phase, 'dsh --dump-config printed no tree')
  if (process.env.S4_D2_KEEP === '1') {
    writeFileSync(join(harnessDir, '..', `dump-${dumpCounter++}.yml`), text)
  }
  return text
}

/** The REAL pinned-npm profile loop (requires --network). */
function runNetworkLoop(bundle, evidence) {
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-s4-d2-smoke-'))
  const home = join(workDir, 'home')
  const dshHome = join(workDir, 'dsh-home')
  const harnessDir = join(workDir, 'harness')
  for (const dir of [home, dshHome, harnessDir]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(workDir, 'npmrc'), 'registry=https://registry.npmjs.org\n')
  const env = isolatedEnvironment(workDir, home, dshHome, join(workDir, 'compat-evidence.json'))
  try {
    writeFileSync(join(harnessDir, 'package.json'), `${JSON.stringify({
      name: 'dsh-s4-d2-smoke-harness',
      private: true,
      type: 'module',
      dependencies: { '@deepseek-ai/dsh': targetDshVersion },
    }, null, 2)}\n`)
    runPnpmInstall(harnessDir, env, loadDshDistribution({ mode: 'npm', version: targetDshVersion }))
    const invocation = dshInvocation(harnessDir)
    const version = runDsh(invocation, ['--version'], harnessDir, env)
    if (version.status !== 0) fail('INFRA_INSTALL_FAILURE', `installed DSH --version failed:\n${commandOutput(version)}`)
    requireExactVersion('DSH', commandOutput(version).trim(), targetDshVersion)

    const profile = 's4-d2-smoke'
    const profileDir = join(dshHome, 'profiles', profile)
    // pnpm 12 turns every undecided dependency build script into a hard failure.
    // The isolated profile records the same explicit decisions the repository
    // already carries (only the subprocess-local chmod runs; nothing compiles).
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'pnpm-workspace.yaml'), [
      'packages:',
      '  - .',
      'nodeLinker: hoisted',
      'autoInstallPeers: false',
      'allowBuilds:',
      '  esbuild: true',
      '  koffi: false',
      "  '@deepseek-ai/dsh-subprocess-local': true",
      "  '@google/genai': false",
      '  node-pty: false',
      '  protobufjs: false',
      '',
    ].join('\n'))
    // A fresh custom profile must be created by the official plugin command
    // before it can be dumped; adding base initializes it and selects base.
    const initialized = runDsh(invocation, ['plugin', '--profile', profile, 'add', `@deepseek-ai/dsh-base@${TARGET_VERSION}`], harnessDir, env)
    if (initialized.status !== 0) fail('PROFILE_INIT_FAILURE', `profile initialization failed:\n${commandOutput(initialized)}`)
    const off = dumpProfileTree(invocation, profile, harnessDir, env, 'PROFILE_INIT_FAILURE')
    // `dsh plugin ... add` is the official CLI package operation: it installs
    // the dependency AND reconciles it into dsh.profile.bundles.
    const added = runDsh(invocation, ['plugin', '--profile', profile, 'add', `${bundle}@${TARGET_VERSION}`], harnessDir, env)
    if (added.status !== 0) fail('INFRA_INSTALL_FAILURE', `profile install failed for ${bundle}:\n${commandOutput(added)}`)
    const installedVersion = packageVersion(join(profileDir, 'node_modules'), bundle)
    if (installedVersion !== TARGET_VERSION) {
      fail('INFRA_INSTALL_FAILURE', `profile installed ${bundle}@${String(installedVersion)}, expected @${TARGET_VERSION}`)
    }
    const on = dumpProfileTree(invocation, profile, harnessDir, env, 'PROFILE_DUMP_FAILURE')
    const removed = runDsh(invocation, ['plugin', '--profile', profile, 'remove', bundle], harnessDir, env)
    if (removed.status !== 0) fail('INFRA_INSTALL_FAILURE', `profile removal failed for ${bundle}:\n${commandOutput(removed)}`)
    const offAgain = dumpProfileTree(invocation, profile, harnessDir, env, 'PROFILE_DUMP_FAILURE')
    const readded = runDsh(invocation, ['plugin', '--profile', profile, 'add', `${bundle}@${TARGET_VERSION}`], harnessDir, env)
    if (readded.status !== 0) fail('INFRA_INSTALL_FAILURE', `profile re-install failed for ${bundle}:\n${commandOutput(readded)}`)
    const onAgain = dumpProfileTree(invocation, profile, harnessDir, env, 'PROFILE_DUMP_FAILURE')
    evidence.network = { offDump: off, onDump: on, offAgainDump: offAgain, onAgainDump: onAgain }
    if (off === on || on === offAgain || offAgain === onAgain) {
      fail('PROFILE_COMPOSITION_FAILURE', `the official CLI add/remove did not change the composed profile tree for ${bundle}`)
    }
    // The bundle patch inserts real rows from its installed package; the dump
    // text naming one of those row packages is the composition proof, not a
    // tool-runtime one (the in-process fixture owns the live registry proof).
    const marker = BUNDLE_ROW_MARKERS[bundle]
    if (!on.includes(marker)) fail('PROFILE_COMPOSITION_FAILURE', `the enabled tree does not name ${marker} (${bundle})`)
    if (offAgain.includes(marker)) fail('PROFILE_COMPOSITION_FAILURE', `the disabled tree still names ${marker} (${bundle})`)
    if (!onAgain.includes(marker)) fail('PROFILE_COMPOSITION_FAILURE', `the restarted tree does not name ${marker} (${bundle})`)
    evidence.network = {
      status: 'PASS',
      dshVersion: targetDshVersion,
      bundle,
      installedVersion,
      profileDir,
      offTreeWithoutBundle: true,
      onTreeWithBundle: true,
      disabledTreeWithoutBundle: true,
      restartedTreeWithBundle: true,
      officialCliAddRemove: true,
    }
  } finally {
    if (process.env.S4_D2_KEEP === '1') {
      console.error(`kept S4-D2 smoke environment: ${workDir}`)
      writeFileSync(join(workDir, 'off.dump.yml'), evidence.network?.offDump ?? '')
      writeFileSync(join(workDir, 'on.dump.yml'), evidence.network?.onDump ?? '')
      writeFileSync(join(workDir, 'off-again.dump.yml'), evidence.network?.offAgainDump ?? '')
    } else {
      rmSync(workDir, { recursive: true, force: true })
    }
  }
}

/** The native credential gate: record presence only; the REAL start is the
 *  explicitly gated unit test under an isolated HOME, never a fabricated pass. */
function runNativeGate(bundle, evidence) {
  const credentialPresence = {
    anthropicEnv: process.env.ANTHROPIC_API_KEY === undefined ? 'absent' : 'present',
    openaiEnv: process.env.OPENAI_API_KEY === undefined ? 'absent' : 'present',
  }
  evidence.native = {
    status: 'EXTERNAL_UNVERIFIED',
    bundle,
    credentialPresence,
    execution: 'not-run',
    reason: '--native records credential presence only. The real native start is gated by '
      + 'DSH_PI_TUI_S4_D2_NATIVE=1 in test/integration/native-subagents.test.ts under an isolated HOME; '
      + 'without a real result the row stays EXTERNAL_UNVERIFIED. No system claude/codex CLI is substituted.',
  }
}

function emit(evidence, options) {
  const json = `${JSON.stringify(evidence, null, 2)}\n`
  if (options.evidence !== undefined) {
    mkdirSync(dirname(options.evidence), { recursive: true })
    writeFileSync(options.evidence, json)
  }
  process.stdout.write(json)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const evidence = {
    script: 'dsh-s4-d2-bundles-smoke',
    target: TARGET_VERSION,
    mode: options.provision ? 'provision' : options.network ? 'network' : 'offline',
    fixture: inspectFixtureInstallation(),
  }
  if (options.provision) {
    evidence.provision = provisionFixtureCache(options)
    evidence.fixture = inspectFixtureInstallation()
  }
  if (options.network) runNetworkLoop(options.bundle, evidence)
  else evidence.network = { status: 'EXTERNAL_UNVERIFIED', reason: '--network was not supplied; no public npm profile call was made' }
  if (options.native) runNativeGate(options.bundle, evidence)
  else evidence.native = { status: 'EXTERNAL_UNVERIFIED', reason: '--native was not supplied' }
  emit(evidence, options)
  const blocked = evidence.fixture.status === 'BLOCKED' || evidence.network?.status === 'FAIL' || evidence.provision?.status === 'FAIL'
  if (blocked && (options.gate || options.network || options.provision)) process.exitCode = 1
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    console.error(`DSH_S4_D2_SMOKE_FAILURE[${error?.phase ?? 'UNKNOWN'}]: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}
