#!/usr/bin/env node
/**
 * R8-E PR-1 real-profile qualification runner.
 *
 * One cross-owner runner proves the R8-E PR-1 claim end to end against a REAL
 * isolated DSH profile: the packed PiTui tarball and three real `npm pack`ed
 * third-party fixtures, installed by the official `dsh plugin` command, booted
 * by the official pinned `profile-boot`/`app-boot` composition with the
 * product's OWN Host-only overlay, then asserted through the official
 * `configEditor`, `settings` and `pluginManager` services.
 *
 * What each gate actually observes (never a mock, never a copy of the logic):
 *  - P1-01 official PM selection + two distinct ACTIVE Loader fibers, and the
 *    official `pluginManager.setBundleEnabled` stopping/restarting one bundle;
 *  - P1-02 the real package-name hash, the trusted carrier module, and a
 *    sentinel file the fixtures write on ANY `./tui` import/apply;
 *  - P1-03/P1-04 official `describe`/`mutate` with independent namespaces,
 *    revisions and USER-patch persistence across a real process restart;
 *  - P1-05 a `$DSH_HOME/cordis.patch.yml` and a `--patch` overlay each refusing
 *    the covered write while the sibling and the TUI preferences stay writable;
 *  - P1-06 the Host Runtime service INSTANCE and the official
 *    `loader/partial-dispose` stream proving a volatile save does not touch the
 *    Host rows, plus a negative control that changes a NON-volatile Host Runtime
 *    option and must be detected as a remount;
 *  - P1-07 the Dual fixture's own `./host` row executed by the native Loader;
 *  - P1-08 the PACKED `./extension-config` export, declaration file and static
 *    dependency graph;
 *  - P1-09 the plain DSH Host plugin (no `dshPiTui`) staying fully native.
 *
 * Output: a machine-readable evidence JSON and a short log under the gitignored
 * `temp/r8/pr1/<stamp>/`. Exit code is non-zero when any judged gate FAILs.
 *
 * Usage: node scripts/smoke/r8-extension-config-smoke.mjs [candidate.tgz]
 *        pnpm smoke:r8-extension-config -- [candidate.tgz]
 *
 * The runner never touches `~/.dsh`, a user profile or the shared system temp
 * root. P1-10 (DSH rc.3) and the in-flight Turn half of P1-06 are reported as
 * NOT_VERIFIED when their environment is absent, never inferred as PASS.
 * @module @xmoon76/dsh-pi-tui/scripts/smoke/r8-extension-config-smoke
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  discoverClientExtension,
  extensionConfigRowId,
} from '../../src/app/plugin-manager/client-extension-discovery.ts'
import { seedProfileBuildPolicy } from '../lib/dsh-profile-build-policy.mjs'
import { npmDshDistribution } from '../lib/dsh-distribution.mjs'
import { runPnpmInstall } from '../lib/dsh-smoke-harness.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..', '..')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'r8-extension-config')
const EVIDENCE_ROOT = join(PACKAGE_ROOT, 'temp', 'r8', 'pr1')
const PROFILE = 'pi-tui'
const CARRIER_MODULE = '@xmoon76/dsh-pi-tui/extension-config'
const FIXTURES = ['a', 'b', 'dual', 'plain']
/** Test-only perturbation used to prove a gate rejects its false-positive
 * condition; never set by the normal qualification run. */
const PROBE = process.env.R8_PR1_PROBE ?? ''
/** The ONLY probes allowed to skip the rc.3 chain: they never exercise it. */
const RC3_SKIP_PROBES = new Set(['stale-save', 'prefs-mutation'])
const rowId = name => extensionConfigRowId(`@r8-pr1-fixture/${name}`)

/* ------------------------------------------------------------------ *
 * Tiny assertion ledger
 * ------------------------------------------------------------------ */

const gates = []
const logLines = []

function log(line) {
  logLines.push(line)
  process.stdout.write(`${line}\n`)
}

function gate(id, status, expected, actual) {
  gates.push({ id, status, expected, actual })
}

function check(id, condition, expected, actual) {
  gate(id, condition ? 'PASS' : 'FAIL', expected, actual)
  return condition
}

function notVerified(id, expected, reason) {
  gate(id, 'NOT_VERIFIED', expected, reason)
}

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right)
const sha256 = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-')

/* ------------------------------------------------------------------ *
 * Isolated environment and process helpers
 * ------------------------------------------------------------------ */

function isolatedEnv(runRoot, home) {
  const env = { TERM: 'xterm-256color', CI: '1' }
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return {
    ...env,
    HOME: home,
    DSH_HOME: join(runRoot, 'dsh-home'),
    TMPDIR: join(runRoot, 'tmp'),
    TMP: join(runRoot, 'tmp'),
    TEMP: join(runRoot, 'tmp'),
    XDG_DATA_HOME: join(runRoot, 'xdg-data'),
    XDG_CACHE_HOME: join(runRoot, 'xdg-cache'),
    XDG_CONFIG_HOME: join(runRoot, 'xdg-config'),
    npm_config_registry: 'https://registry.npmjs.org',
    NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org',
    npm_config_minimum_release_age: '0',
    pnpm_config_minimum_release_age: '0',
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: 'false',
    PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS: 'false',
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15 * 60_000, ...options })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${String(result.status)})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  return result
}

function realBinOf(command) {
  const where = spawnSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' })
  if (where.status !== 0) throw new Error(`${command} is not on PATH`)
  return where.stdout.trim()
}

/** The installed official dsh CLI package.json (the runtime anchor). */
function dshAnchor() {
  const bin = realBinOf('dsh')
  return createRequire(join(dirname(bin), 'noop.cjs')).resolve('@deepseek-ai/dsh/package.json')
}

function dshVersion() {
  return run('dsh', ['--version']).stdout.trim()
}

/* ------------------------------------------------------------------ *
 * Candidate + fixtures
 * ------------------------------------------------------------------ */

function newestTarball() {
  const candidates = readdirSync(PACKAGE_ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(PACKAGE_ROOT, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  if (candidates.length === 0) throw new Error('no candidate tarball in the package root; run pnpm pack:artifact first')
  return candidates[0]
}

function candidateTarball(argument, workDir) {
  const sourcePackage = readJson(join(PACKAGE_ROOT, 'package.json'))
  const path = argument === undefined ? newestTarball() : resolve(argument)
  if (!existsSync(path)) throw new Error(`candidate tarball not found: ${path}`)
  const extractDir = join(workDir, 'candidate')
  mkdirSync(extractDir, { recursive: true })
  run('tar', ['-xzf', path, '-C', extractDir])
  const packed = readJson(join(extractDir, 'package', 'package.json'))
  if (packed.name !== sourcePackage.name || packed.version !== sourcePackage.version) {
    throw new Error(`candidate tarball is ${packed.name}@${packed.version}, source is ${sourcePackage.name}@${sourcePackage.version}`)
  }
  return { path, checksum: sha256(path), extractDir, version: packed.version, listing: run('tar', ['-tzf', path]).stdout.split('\n') }
}

/** Copy one fixture and add the CURRENT candidate peer range (no placeholder). */
function materializeFixture(name, userVersion, stampDir) {
  const from = join(FIXTURE_ROOT, name)
  const to = join(stampDir, 'fixtures', name)
  cpSync(from, to, { recursive: true })
  const manifest = readJson(join(to, 'package.json'))
  if (name !== 'plain') manifest.peerDependencies = { '@xmoon76/dsh-pi-tui': `^${userVersion}` }
  writeFileSync(join(to, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  const packed = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', join(stampDir, 'tarballs')], { cwd: to })
  return join(stampDir, 'tarballs', JSON.parse(packed.stdout)[0].filename)
}

function install(spec, env, runRoot) {
  seedProfileBuildPolicy(env.DSH_HOME, PROFILE)
  log(`install ${spec}`)
  run('dsh', ['plugin', '--profile', PROFILE, 'add', spec], { cwd: runRoot, env })
}

/* ------------------------------------------------------------------ *
 * Host child: run the official profile in this process (spawned by runHost)
 * ------------------------------------------------------------------ */

async function hostChild() {
  const requireFromAnchor = createRequire(process.env.R8_PR1_ANCHOR)
  const resolveAnchor = specifier => requireFromAnchor.resolve(specifier)
  const { symbols } = await import(resolveAnchor('@deepseek-ai/cordis'))
  const profileBoot = await import(resolveAnchor('@deepseek-ai/dsh/profile-boot'))
  const appBoot = await import(resolveAnchor('@deepseek-ai/dsh-app-boot'))
  const hostEntry = join(process.env.R8_PR1_WORKTREE, 'dist', 'local-host.mjs')
  const { HOST_ONLY_PATCH } = await import(hostEntry)
  writeFileSync(process.env.R8_PR1_OVERLAY, HOST_ONLY_PATCH)
  // The production launcher runs local-host.mjs as the main module and lets the
  // entry declare that same path; reproduce that contract so `tui-startup`
  // takes the Host-only branch instead of the Direct TUI-surface verdict.
  process.argv[1] = hostEntry
  process.env.DSH_PI_TUI_ROLE = 'host'
  process.env.DSH_PI_TUI_HOST_ENTRY = hostEntry

  const patchFiles = [process.env.R8_PR1_OVERLAY]
  if (process.env.R8_PR1_EXTRA_PATCH !== undefined) patchFiles.push(process.env.R8_PR1_EXTRA_PATCH)

  const report = { status: 'FAIL', mode: process.env.R8_PR1_MODE, pid: process.pid, snapshots: [] }
  let shutdown
  try {
    const handle = await profileBoot.runProfile({
      environment: appBoot.loadLayeredEnv('dsh', process.cwd()),
      profile: process.env.R8_PR1_PROFILE,
      patchFiles,
      args: [],
    })
    shutdown = handle.shutdown
    const ctx = handle.ctx
    const disposeEvents = []
    ctx.on('loader/partial-dispose', entry => { disposeEvents.push(entry.options.id) })
    let nextIdentity = 1
    const identities = new WeakMap()
    const identityOf = value => {
      if (value === undefined || value === null) return undefined
      const original = value[symbols.original] ?? value
      if (typeof original !== 'object' && typeof original !== 'function') return String(original)
      if (!identities.has(original)) identities.set(original, nextIdentity++)
      return identities.get(original)
    }
    const relevant = entry => entry.options.id.startsWith('pi-tui-extcfg-')
      || entry.options.id === 'r8-pr1-fixture-dual-host'
      || entry.options.id === 'r8-pr1-fixture-plain-host'
      || entry.options.id === 'r8-pr1-fixture-plain-tui-row'
      || entry.options.id === 'split-host-pi-tui-runtime'
      || entry.options.id === 'plugin-manager'
      || entry.options.id === 'config-editor'
      || entry.options.id === 'settings'
    const snapshot = name => {
      const descriptors = ctx.get('settings').describe()
      report.snapshots.push({
        name,
        pid: process.pid,
        hostRuntimeUid: [...ctx.loader.entries()].find(entry => entry.options.id === 'split-host-pi-tui-runtime')?.fiber?.uid,
        hostRuntimeServiceIdentity: identityOf(ctx.get('piTuiHostReady')),
        preferencesServiceIdentity: identityOf(ctx.get('piTuiPreferences')),
        disposeEvents: [...disposeEvents],
        fixtureTuiRows: [...ctx.loader.entries()]
          .filter(entry => entry.options.name.startsWith('@r8-pr1-fixture/') && entry.options.name.endsWith('/tui'))
          .map(entry => ({ id: entry.options.id, name: entry.options.name, state: entry.fiber?.state })),
        rows: [...ctx.loader.entries()].filter(relevant).map(entry => ({
          id: entry.options.id,
          name: entry.options.name,
          disabled: entry.options.disabled === true,
          fiberUid: entry.fiber?.uid,
          state: entry.fiber?.state,
        })),
        configEditorIds: ctx.get('configEditor').entries().map(entry => entry.options.id),
        // The OFFICIAL resolved package identity (not a path guess): the same
        // PluginPackages lookup production discovery consumes.
        packages: Object.fromEntries(['a', 'b', 'dual', 'plain'].map(fixture => {
          const name = `@r8-pr1-fixture/${fixture}`
          const resolved = ctx.get('pluginPackages')?.packageOf(name, ctx.baseUrl)
          return [fixture, resolved === undefined ? undefined : {
            name: resolved.name, version: resolved.version, dir: resolved.dir, manifestName: resolved.manifest?.name,
          }]
        })),
        settings: descriptors
          .filter(row => row.ns.startsWith('pi-tui-extcfg-') || row.ns === 'pi-tui-preferences')
          .map(row => ({ ns: row.ns, revision: row.revision, schema: row.schema, value: row.value, base: row.base, user: row.user })),
        sentinel: readSentinel(),
      })
    }
    const attempt = async (step, action) => {
      try {
        await action()
        report.snapshots.push({ name: step.name, outcome: 'ok' })
      } catch (error) {
        report.snapshots.push({
          name: step.name,
          outcome: 'error',
          errorName: error.name,
          errorCode: error.code,
          errorMessage: error.message,
        })
      }
    }
    snapshot('boot')
    for (const step of JSON.parse(process.env.R8_PR1_STEPS)) {
      if (step.kind === 'snapshot') snapshot(step.name)
      if (step.kind === 'mutate') {
        await attempt(step, () => ctx.get('settings').mutate(step.ns, step.ops, step.revision))
        snapshot(step.name)
      }
      if (step.kind === 'non-json') {
        await attempt(step, () => ctx.get('settings').replace(step.ns, { data: new Date() }))
        snapshot(step.name)
      }
      if (step.kind === 'extension-port') {
        // PR-2: exercise the new semantic port on THIS real official Host
        // Settings authority (both the rc.5 and the rc.3 qualification boots).
        try {
          const { DirectExtensionConfigsConfig } = await import(
            pathToFileURL(join(process.env.R8_PR1_WORKTREE, 'src/runtime/direct/config-direct.ts')).href
          )
          const config = new DirectExtensionConfigsConfig(ctx)
          const factsOf = read => read.kind === 'ready'
            ? {
                kind: read.kind,
                revision: read.revision,
                effective: read.effective,
                inherited: read.inherited,
                user: read.user,
                userDataPresent: read.userDataPresent,
              }
            : { kind: read.kind, reason: read.reason }
          const a0 = config.read('@r8-pr1-fixture/a')
          const b0 = config.read('@r8-pr1-fixture/b')
          if (a0.kind !== 'ready' || b0.kind !== 'ready') {
            throw new Error(`extension port rows must be readable (${a0.kind}/${b0.kind})`)
          }
          const writeA = await config.mutate('@r8-pr1-fixture/a', [
            { op: 'set', path: ['label'], value: 'alpha-port' },
          ], a0.revision, a0.generation)
          const a1 = config.read('@r8-pr1-fixture/a')
          const b1 = config.read('@r8-pr1-fixture/b')
          const stale = a1.kind === 'ready'
            ? await config.mutate('@r8-pr1-fixture/a', [
                { op: 'set', path: ['label'], value: 'alpha-port-stale' },
              ], a0.revision, a1.generation)
            : { kind: 'not-run' }
          const a2 = config.read('@r8-pr1-fixture/a')
          report.snapshots.push({
            name: step.name,
            outcome: 'ok',
            port: {
              a0: factsOf(a0),
              b0: factsOf(b0),
              writeA: writeA.kind,
              a1: factsOf(a1),
              b1: factsOf(b1),
              stale: stale.kind,
              a2: factsOf(a2),
            },
          })
        } catch (error) {
          report.snapshots.push({
            name: step.name,
            outcome: 'error',
            errorName: error.name,
            errorMessage: error.message,
          })
        }
      }
      if (step.kind === 'pm-bundle') {
        await attempt(step, () => ctx.get('pluginManager').setBundleEnabled(step.bundle, step.enabled))
        snapshot(step.name)
      }
      if (step.kind === 'remount-oracle') {
        const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === 'split-host-pi-tui-runtime')
        report.snapshots.push({
          name: step.name,
          oracle: 'before',
          fiberUid: entry.fiber?.uid,
          serviceIdentity: identityOf(ctx.get('piTuiHostReady')),
          disposeEvents: [...disposeEvents],
        })
        await entry.update({ config: { ...entry.options.config, sessionId: step.sessionId } })
        await new Promise(done => setTimeout(done, 250))
        report.snapshots.push({
          name: step.name,
          oracle: 'after',
          fiberUid: entry.fiber?.uid,
          serviceIdentity: identityOf(ctx.get('piTuiHostReady')),
          disposeEvents: [...disposeEvents],
        })
      }
    }
    report.phase = 'done'
    report.status = 'PASS'
  } catch (error) {
    report.error = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
  } finally {
    if (shutdown !== undefined) {
      try { await shutdown.shutdown(0) } catch (error) { report.shutdownError = String(error) }
    }
    writeFileSync(process.env.R8_PR1_REPORT, `${JSON.stringify(report, undefined, 2)}\n`)
    process.exit(report.status === 'PASS' ? 0 : 1)
  }
}

function readSentinel() {
  const path = process.env.R8_EXTENSION_CONFIG_SENTINEL
  if (path === undefined || !existsSync(path)) return []
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Boot the real profile in a child process and return its report. */
function runHost({ env, runRoot, stampDir, sentinel, label, steps = [], extraPatch, host }) {
  const reportPath = join(stampDir, `host-${label}.json`)
  const overlayPath = join(stampDir, `host-only-${label}.patch.yml`)
  rmSync(reportPath, { force: true })
  writeFileSync(sentinel, '')
  const childEnv = {
    ...env,
    R8_PR1_CHILD: 'host',
    R8_PR1_REPORT: reportPath,
    R8_PR1_OVERLAY: overlayPath,
    R8_PR1_PROFILE: PROFILE,
    R8_PR1_MODE: label,
    R8_PR1_STEPS: JSON.stringify(steps),
    R8_PR1_WORKTREE: PACKAGE_ROOT,
    R8_PR1_ANCHOR: host?.anchor ?? dshAnchor(),
    R8_PR1_DSH_VERSION: host?.version ?? dshVersion(),
    R8_EXTENSION_CONFIG_SENTINEL: sentinel,
    DSH_PI_TUI_ROLE: 'host',
    DSH_PI_TUI_HOST_ENTRY: join(PACKAGE_ROOT, 'dist', 'local-host.mjs'),
  }
  if (extraPatch !== undefined) childEnv.R8_PR1_EXTRA_PATCH = extraPatch
  const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--host'], {
    encoding: 'utf8',
    env: childEnv,
    cwd: runRoot,
    timeout: 10 * 60_000,
  })
  if (!existsSync(reportPath)) {
    throw new Error(`host child produced no report (status ${String(result.status)})\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
  }
  const report = readJson(reportPath)
  if (report.status !== 'PASS') throw new Error(`host child failed: ${String(report.error)}`)
  for (const snapshot of report.snapshots) {
    bootAudit.sentinelEvents.push(...(snapshot.sentinel ?? []))
    bootAudit.fixtureTuiRows.push(...(snapshot.fixtureTuiRows ?? []))
  }
  return report
}

const bootAudit = { sentinelEvents: [], fixtureTuiRows: [] }

const snapshotOf = (report, name) => report.snapshots.find(entry => entry.name === name && entry.settings !== undefined)

/** A projected Settings form's semantic shape, ignoring per-describe schema uids. */
function formShape(schema) {
  const root = schema?.refs?.[String(schema.uid)]
  const dataRef = root?.dict?.data
  const data = dataRef === undefined ? undefined : schema.refs[String(dataRef)]
  return {
    type: root?.type,
    keys: Object.keys(root?.dict ?? {}),
    dataType: data?.type,
    dataMeta: data?.meta,
  }
}

/** The durable Settings facts a save must leave untouched (schema uids are not). */
const settingsShape = row => row === undefined
  ? undefined
  : { revision: row.revision, value: row.value, base: row.base, user: row.user }
const describeRow = (report, ns) => report.settings.find(row => row.ns === ns)
const rowOf = (report, id) => report.rows.find(row => row.id === id)

/* ------------------------------------------------------------------ *
 * Packed-consumer proof (P1-08)
 * ------------------------------------------------------------------ */

function preparePackedConsumer(candidate, stampDir) {
  const consumerDir = join(stampDir, 'consumer')
  const modules = join(consumerDir, 'node_modules')
  mkdirSync(join(modules, '@xmoon76'), { recursive: true })
  cpSync(join(candidate.extractDir, 'package'), join(modules, '@xmoon76', 'dsh-pi-tui'), { recursive: true })
  for (const name of ['@deepseek-ai', 'typescript', '@types']) {
    symlinkSync(join(PACKAGE_ROOT, 'node_modules', name), join(modules, name), 'dir')
  }
  writeFileSync(
    join(consumerDir, 'index.ts'),
    "import { Config, apply } from '@xmoon76/dsh-pi-tui/extension-config'\nconst schema: unknown = Config\nvoid schema\nvoid apply\n",
  )
  return consumerDir
}

/* ------------------------------------------------------------------ *
 * P1-10: the same chain on the old published DSH floor (rc.3)
 * ------------------------------------------------------------------ */

function rc3Qualification({ stampDir, candidate, tarballs, evidence }) {
  const rc3Root = join(stampDir, 'rc3')
  const harnessDir = join(rc3Root, 'harness')
  const rc3Env = isolatedEnv(join(rc3Root, 'run'), join(rc3Root, 'run', 'home'))
  for (const directory of [harnessDir, rc3Env.HOME, rc3Env.TMPDIR]) mkdirSync(directory, { recursive: true })
  writeFileSync(join(harnessDir, 'package.json'), `${JSON.stringify({ name: 'r8-pr1-rc3-harness', private: true, type: 'module' }, undefined, 2)}\n`)
  let anchor
  let cli
  let version
  try {
    runPnpmInstall(harnessDir, rc3Env, npmDshDistribution('0.2.2-rc.3'))
    cli = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    anchor = join(harnessDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    version = readJson(anchor).version
    if (version !== '0.2.2-rc.3') throw new Error(`installed rc.3 harness reports ${String(version)}`)
  } catch (error) {
    // NOT_VERIFIED is reserved for an unavailable rc.3 ENVIRONMENT.
    evidence.rc3 = { phase: 'provision', status: 'NOT_VERIFIED', error: error instanceof Error ? error.message : String(error) }
    notVerified('P1-10', 'official DSH rc.3 installs and boots the two Config rows',
      `rc.3 installation could not be provisioned: ${error instanceof Error ? error.message : String(error)}`)
    notVerified('P2-14-rc3', 'the real rc.3 Host Settings authority serves the per-package Port read/write/CAS',
      `rc.3 installation could not be provisioned: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  evidence.rc3 = { version, phase: 'install', status: 'RUNNING' }
  const rc3Install = spec => {
    seedProfileBuildPolicy(rc3Env.DSH_HOME, PROFILE)
    run(process.execPath, [cli, 'plugin', '--profile', PROFILE, 'add', spec], { cwd: harnessDir, env: rc3Env })
  }
  try {
    rc3Install(candidate.path)
    rc3Install(tarballs.a)
    // Probe only: prove a genuine rc.3 install failure is a FAIL, not NOT_VERIFIED.
    rc3Install(PROBE === 'rc3-install-fail' ? join(stampDir, 'missing-fixture.tgz') : tarballs.b)
  } catch (error) {
    evidence.rc3 = { version, phase: 'install', status: 'FAIL', error: error instanceof Error ? error.message : String(error) }
    gate('P1-10', 'FAIL', 'official DSH rc.3 installs and boots the two Config rows',
      `rc.3 official plugin install failed: ${error instanceof Error ? error.message : String(error)}`)
    gate('P2-14-rc3', 'FAIL', 'the real rc.3 Host Settings authority serves the per-package Port read/write/CAS',
      `rc.3 official plugin install failed: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  const aRow = rowId('a')
  const bRow = rowId('b')
  try {
    const report = runHost({
      env: rc3Env,
      runRoot: harnessDir,
      stampDir,
      sentinel: join(stampDir, 'rc3-sentinel.jsonl'),
      label: 'rc3',
      host: { anchor, version },
      steps: [
        { kind: 'mutate', name: 'rc3-save-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-rc3' }], revision: 0 },
        { kind: 'mutate', name: 'rc3-stale-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-rc3-stale' }], revision: 0 },
      ],
    })
    const boot = report.snapshots[0]
    const aEntry = rowOf(boot, aRow)
    const bEntry = rowOf(boot, bRow)
    const afterSave = snapshotOf(report, 'rc3-save-a')
    const stale = report.snapshots.find(entry => entry.name === 'rc3-stale-a')
    evidence.rc3 = {
      version,
      phase: 'settings-chain',
      status: aEntry?.state === 2 && bEntry?.state === 2 && afterSave !== undefined && stale?.errorName === 'SettingsConflictError' ? 'PASS' : 'FAIL',
    }
    check('P1-10', aEntry?.state === 2 && bEntry?.state === 2 && aEntry.fiberUid !== bEntry.fiberUid
      && describeRow(boot, aRow)?.value.data.label === 'alpha'
      && describeRow(boot, bRow)?.value.data.label === 'bravo'
      && afterSave !== undefined && describeRow(afterSave, aRow)?.value.data.label === 'alpha-rc3'
      && stale?.errorName === 'SettingsConflictError',
    'official DSH rc.3 profile mounts two Config rows and Settings reads/writes them independently',
    JSON.stringify({ version, a: aEntry, b: bEntry, afterSave: describeRow(afterSave, aRow)?.value, stale: stale?.errorName }))

    // P2-14 (rc.3): the new semantic port on the SAME real rc.3 Host.
    const portReport = runHost({
      env: rc3Env,
      runRoot: harnessDir,
      stampDir,
      sentinel: join(stampDir, 'rc3-sentinel.jsonl'),
      label: 'rc3-port',
      host: { anchor, version },
      steps: [{ kind: 'extension-port', name: 'rc3-port' }],
    })
    const port = portReport.snapshots.find(entry => entry.name === 'rc3-port')
    const facts = port?.port
    evidence.rc3Port = { status: port?.outcome === 'ok' ? 'PASS' : 'FAIL', port }
    check('P2-14-rc3', port?.outcome === 'ok'
      && facts?.writeA === 'accepted'
      && facts?.stale === 'conflict'
      && facts?.a1?.kind === 'ready' && facts.a1.effective?.label === 'alpha-port'
      && facts?.a2?.kind === 'ready' && facts.a2.effective?.label === 'alpha-port'
      && facts?.a0?.kind === 'ready' && facts?.b0?.kind === 'ready'
      && sameJson(facts.b0.effective, facts.b1?.effective),
    'the real rc.3 Host Settings authority serves the per-package Port read/write/CAS',
    JSON.stringify({ version, outcome: port?.outcome, error: port?.errorMessage, writeA: facts?.writeA, stale: facts?.stale }))
  } catch (error) {
    evidence.rc3 = { version, phase: 'boot', status: 'FAIL', error: error instanceof Error ? error.message : String(error) }
    gate('P1-10', 'FAIL', 'official DSH rc.3 profile mounts two Config rows and Settings reads/writes them independently',
      `rc.3 Host boot failed: ${error instanceof Error ? error.message : String(error)}`)
    gate('P2-14-rc3', 'FAIL', 'the real rc.3 Host Settings authority serves the per-package Port read/write/CAS',
      `rc.3 Host boot failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/* ------------------------------------------------------------------ *
 * Parent mode
 * ------------------------------------------------------------------ */

function main() {
  mkdirSync(EVIDENCE_ROOT, { recursive: true })
  const stampDir = join(EVIDENCE_ROOT, stamp())
  const runRoot = join(stampDir, 'run')
  const home = join(runRoot, 'home')
  for (const directory of [home, join(runRoot, 'tmp'), join(stampDir, 'tarballs'), join(stampDir, 'fixtures')]) {
    mkdirSync(directory, { recursive: true })
  }
  const env = isolatedEnv(runRoot, home)
  const sentinel = join(stampDir, 'sentinel.jsonl')
  bootAudit.sentinelEvents = []
  bootAudit.fixtureTuiRows = []
  const evidence = {
    schemaVersion: 1, status: 'FAIL', gateVersion: 'r8-e-pr1', gates, log: logLines, runRoot,
    ...(PROBE === '' ? {} : { probe: PROBE }),
  }
  try {
    const sourcePackage = readJson(join(PACKAGE_ROOT, 'package.json'))
    const candidate = candidateTarball(process.argv[2], stampDir)
    evidence.piTuiTarball = candidate.path
    evidence.piTuiTarballSha256 = candidate.checksum
    evidence.piTuiVersion = candidate.version
    evidence.dshVersion = dshVersion()
    evidence.dshAnchor = dshAnchor()
    evidence.profile = PROFILE
    if (!check(
      'INFRA-CLI',
      evidence.dshVersion === sourcePackage.devDependencies['@deepseek-ai/dsh-agent'],
      `official dsh CLI ${sourcePackage.devDependencies['@deepseek-ai/dsh-agent']}`,
      `official dsh CLI ${evidence.dshVersion}`,
    )) throw new Error('the official dsh CLI does not match the pinned family')

    const tarballs = Object.fromEntries(FIXTURES.map(name => [name, materializeFixture(name, candidate.version, stampDir)]))
    install(candidate.path, env, runRoot)
    // B before A on purpose: the two packages' independence must not depend on
    // install order.
    for (const name of ['b', 'a', 'dual', 'plain']) install(tarballs[name], env, runRoot)

    const profileDir = join(env.DSH_HOME, 'profiles', PROFILE)
    const bundles = readJson(join(profileDir, 'package.json')).dsh.profile.bundles
    for (const name of [...FIXTURES.map(fixture => `@r8-pr1-fixture/${fixture}`), '@xmoon76/dsh-pi-tui']) {
      check(`P1-01a:${name}`, bundles.includes(name), `official PM selects ${name}`, `bundles=${bundles.join(',')}`)
    }
    const first = runHost({ env, runRoot, stampDir, sentinel, label: 'first' })
    const boot = first.snapshots[0]
    evidence.firstBoot = boot
    const manifestOf = fixture => {
      const resolved = boot.packages?.[fixture]
      if (resolved?.dir === undefined) throw new Error(`official PluginPackages did not resolve @r8-pr1-fixture/${fixture}`)
      return { name: resolved.name, manifest: readJson(join(resolved.dir, 'package.json')) }
    }
    for (const fixture of FIXTURES) {
      const resolved = boot.packages?.[fixture]
      check(`P1-02f:${fixture}`, resolved?.name === `@r8-pr1-fixture/${fixture}` && resolved?.manifestName === resolved.name,
        `official PluginPackages resolves @r8-pr1-fixture/${fixture}`, JSON.stringify(resolved))
    }
    const aRow = rowId('a')
    const bRow = rowId('b')
    const dualRow = rowId('dual')
    const aEntry = rowOf(boot, aRow)
    const bEntry = rowOf(boot, bRow)
    check('P1-01b', aEntry?.state === 2 && bEntry?.state === 2 && aEntry.fiberUid !== bEntry.fiberUid,
      'both Config rows ACTIVE with distinct fibers', `${JSON.stringify(aEntry)} / ${JSON.stringify(bEntry)}`)
    check('P1-02a', aRow !== bRow && boot.rows.filter(row => row.id === aRow).length === 1
      && boot.rows.filter(row => row.id === bRow).length === 1
      && boot.configEditorIds.includes(aRow) && boot.configEditorIds.includes(bRow),
    'two unique rows addressable by configEditor', `ids=${boot.configEditorIds.filter(id => id.includes('extcfg')).join(',')}`)
    const rowNames = boot.rows.filter(row => row.id === aRow || row.id === bRow).map(row => row.name)
    check('P1-02b', rowNames.length === 2 && rowNames.every(name => name === CARRIER_MODULE),
      `both rows name ${CARRIER_MODULE}`, `names=${rowNames.join(',')}`)
    // P1-02c is asserted again at the END over EVERY Host boot (below).

    // P1-02 discovery uses the REAL installed manifests and the REAL mounted
    // rows through the real pure function, never a copy of the hash rule.
    const discoveryA = discoverClientExtension({
      package: manifestOf('a'),
      selectedBundle: bundles.includes('@r8-pr1-fixture/a'),
      effectiveRows: boot.rows.map(row => ({ id: row.id, name: row.name })),
    })
    check('P1-02d', discoveryA.kind === 'candidate' && discoveryA.configRowId === aRow,
      'pure discovery returns the candidate for the real row', JSON.stringify(discoveryA))
    const wrongRow = discoverClientExtension({
      package: manifestOf('a'),
      selectedBundle: true,
      effectiveRows: boot.rows.filter(row => row.id !== aRow).map(row => ({ id: row.id, name: row.name })),
    })
    check('P1-02e', wrongRow.kind === 'invalid-opt-in', 'a mis-mounted row loses Client qualification only', JSON.stringify(wrongRow))
    const plainDiscovery = discoverClientExtension({
      package: manifestOf('plain'),
      selectedBundle: true,
      effectiveRows: boot.rows.map(row => ({ id: row.id, name: row.name })),
    })
    check('P1-09a', plainDiscovery.kind === 'not-opted-in', 'a plain DSH plugin is never a Client extension', JSON.stringify(plainDiscovery))

    const describeA = describeRow(boot, aRow)
    const describeB = describeRow(boot, bRow)
    const prefsBefore = describeRow(boot, 'pi-tui-preferences')
    check('P1-03a', describeA !== undefined && describeB !== undefined
      && sameJson(formShape(describeA.schema), { type: 'object', keys: ['data'], dataType: 'any', dataMeta: {} })
      && sameJson(formShape(describeA.schema), formShape(describeB.schema))
      && describeA.value.data.label === 'alpha' && describeB.value.data.label === 'bravo',
    'two namespaces with independent alpha/bravo defaults', `${JSON.stringify(describeA?.value)} / ${JSON.stringify(describeB?.value)}`)
    check('P1-03b', describeA !== undefined && describeB !== undefined
      && describeA.revision === 0 && describeB.revision === 0 && sameJson(Object.keys(describeA.value), ['data']),
    'independent revision 0 and one data field', `${describeA?.revision}/${describeB?.revision}`)
    check('P1-03c', describeA !== undefined && describeB !== undefined
      && sameJson(describeA.user, {}) && sameJson(describeB.user, {}),
    'no USER value before any save', `${JSON.stringify(describeA?.user)} / ${JSON.stringify(describeB?.user)}`)

    // P1-04 / P1-06: save A, stale revision, non-JSON, then B.
    const save = runHost({
      env, runRoot, stampDir, sentinel, label: 'save',
      steps: [
        { kind: 'mutate', name: 'save-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-user' }], revision: 0 },
        { kind: 'mutate', name: 'stale-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-stale' }], revision: 0 },
        { kind: 'non-json', name: 'bad-json-a', ns: aRow },
        { kind: 'mutate', name: 'save-b', ns: bRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'bravo-user' }], revision: 0 },
      ],
    })
    const saveAOutcome = save.snapshots.find(entry => entry.name === 'save-a')
    const afterA = snapshotOf(save, 'save-a')
    const aAfter = afterA === undefined ? undefined : describeRow(afterA, aRow)
    const bAfter = afterA === undefined ? undefined : describeRow(afterA, bRow)
    const prefsAfter = afterA === undefined ? undefined : describeRow(afterA, 'pi-tui-preferences')
    check('P1-04a', saveAOutcome?.outcome === 'ok' && aAfter !== undefined,
      'save A succeeds', JSON.stringify(saveAOutcome?.errorMessage ?? saveAOutcome?.outcome))
    check('P1-04b', aAfter !== undefined && aAfter.value.data.label === 'alpha-user'
      && aAfter.user.data.label === 'alpha-user' && aAfter.base.data.label === 'alpha' && aAfter.revision === 1,
    'A effective/user follow the saved value at revision 1', JSON.stringify(aAfter))
    check('P1-04c', bAfter !== undefined && bAfter.revision === 0 && sameJson(bAfter.user, {}) && bAfter.value.data.label === 'bravo',
      'B untouched by the A save', JSON.stringify(bAfter))
    check('P1-04d', prefsAfter !== undefined && sameJson(settingsShape(prefsAfter), settingsShape(prefsBefore)),
      'pi-tui-preferences untouched by the A save', JSON.stringify(prefsAfter?.value))
    const stale = save.snapshots.find(entry => entry.name === 'stale-a')
    check('P1-04e', stale?.errorName === 'SettingsConflictError' && stale?.errorCode === 'SETTINGS_CONFLICT',
      'stale revision refused by SettingsConflictError', JSON.stringify(stale))
    const afterBad = snapshotOf(save, 'bad-json-a')
    const badOutcome = save.snapshots.find(entry => entry.name === 'bad-json-a')
    check('P1-04f', badOutcome?.outcome === 'error'
      && afterBad !== undefined && describeRow(afterBad, aRow)?.value.data.label === 'alpha-user',
    'a non-JSON write is rejected before persistence', JSON.stringify(badOutcome?.errorMessage))
    const savedUserPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    const patchRowIds = savedUserPatch.split('\n').filter(line => line.startsWith('- id: ')).map(line => line.slice(6).trim())
    check('P1-04g', patchRowIds.length === 2 && patchRowIds.includes(aRow) && patchRowIds.includes(bRow)
      && savedUserPatch.includes('alpha-user') && savedUserPatch.includes('bravo-user')
      && !savedUserPatch.includes('pi-tui-preferences'),
    'USER patch carries exactly the two saved Config rows and nothing else', JSON.stringify(patchRowIds))

    const restart = runHost({ env, runRoot, stampDir, sentinel, label: 'restart' })
    const restarted = restart.snapshots[0]
    evidence.restart = restarted
    const aRestart = describeRow(restarted, aRow)
    const bRestart = describeRow(restarted, bRow)
    check('P1-04h', aRestart !== undefined && bRestart !== undefined
      && aRestart.user.data.label === 'alpha-user' && aRestart.value.data.label === 'alpha-user'
      && aRestart.base.data.label === 'alpha' && bRestart.user.data.label === 'bravo-user',
    'both saved values survive a real process restart', `${JSON.stringify(aRestart?.value)} / ${JSON.stringify(bRestart?.value)}`)

    // P1-05: home patch and CLI overlay each refuse the covered write.
    const homePatch = join(env.DSH_HOME, 'cordis.patch.yml')
    writeFileSync(homePatch, `- id: ${aRow}\n  config:\n    data:\n      label: alpha-home\n`)
    const coveredBoot = runHost({ env, runRoot, stampDir, sentinel, label: 'home-patch' })
    const coveredInitial = coveredBoot.snapshots[0]
    const aCovered = describeRow(coveredInitial, aRow)
    const prefsCovered = describeRow(coveredInitial, 'pi-tui-preferences')
    check('P1-05a', aCovered?.value.data.label === 'alpha-home',
      'home patch wins the effective A value', JSON.stringify(aCovered?.value))
    const coveredSteps = [
      { kind: 'mutate', name: 'write-covered-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'home-write' }], revision: 0 },
    ]
    if (PROBE === 'prefs-mutation') {
      // Probe only: a prefs mutation during the covered window must be caught
      // by P1-05e instead of passing on a stale pre-write snapshot.
      coveredSteps.push({ kind: 'mutate', name: 'probe-prefs', ns: 'pi-tui-preferences', ops: [{ op: 'set', path: ['theme'], value: 'dark' }], revision: 0 })
    }
    coveredSteps.push({ kind: 'mutate', name: 'write-b-under-home', ns: bRow, ops: [{ op: 'set', path: ['data', 'limit'], value: 8 }], revision: 0 })
    const covered = runHost({ env, runRoot, stampDir, sentinel, label: 'home-write', steps: coveredSteps })
    const afterCoveredA = snapshotOf(covered, 'write-covered-a')
    const afterCoveredB = snapshotOf(covered, 'write-b-under-home')
    const coveredWrite = covered.snapshots.find(entry => entry.name === 'write-covered-a')
    const aAfterRefusal = afterCoveredA === undefined ? undefined : describeRow(afterCoveredA, aRow)
    check('P1-05b', coveredWrite?.outcome === 'error'
      && /overridden by a home patch or command-line overlay/u.test(coveredWrite.errorMessage ?? '')
      && aAfterRefusal !== undefined
      && aAfterRefusal.value.data.label === 'alpha-home'
      && aAfterRefusal.user.data.label === 'alpha-user'
      && aAfterRefusal.revision === aCovered?.revision,
    'home-patched A refuses the write and its effective/user configuration is unchanged',
    JSON.stringify({ outcome: coveredWrite?.errorMessage, after: aAfterRefusal }))
    const bUnderHome = snapshotOf(covered, 'write-b-under-home')
    check('P1-05c', covered.snapshots.find(entry => entry.name === 'write-b-under-home')?.outcome === 'ok'
      && bUnderHome !== undefined && describeRow(bUnderHome, bRow)?.value.data.limit === 8,
    'B stays writable under the A home override', JSON.stringify(bUnderHome?.settings?.find(row => row.ns === bRow)?.value))
    // P1-05e reads the AUTHORITATIVE post-write descriptors, not the boot snapshot.
    const prefsAfterCoveredA = afterCoveredA === undefined ? undefined : describeRow(afterCoveredA, 'pi-tui-preferences')
    const prefsAfterCoveredB = afterCoveredB === undefined ? undefined : describeRow(afterCoveredB, 'pi-tui-preferences')
    check('P1-05e', prefsCovered !== undefined && prefsAfterCoveredA !== undefined && prefsAfterCoveredB !== undefined
      && sameJson(settingsShape(prefsAfterCoveredA), settingsShape(prefsCovered))
      && sameJson(settingsShape(prefsAfterCoveredB), settingsShape(prefsCovered)),
    'pi-tui-preferences untouched after both the refused A write and the B write',
    JSON.stringify({ before: prefsCovered?.revision, afterA: prefsAfterCoveredA?.revision, afterB: prefsAfterCoveredB?.revision }))
    rmSync(homePatch, { force: true })
    const restored = runHost({
      env, runRoot, stampDir, sentinel, label: 'home-restored',
      steps: [
        { kind: 'mutate', name: 'write-restored-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-restored' }], revision: 0 },
      ],
    })
    const restoredWrite = restored.snapshots.find(entry => entry.name === 'write-restored-a')
    const restoredSnapshot = snapshotOf(restored, 'write-restored-a')
    check('P1-05f', restoredWrite?.outcome === 'ok'
      && describeRow(restoredSnapshot, aRow)?.value.data.label === 'alpha-restored',
    'removing the home override restores A writability', JSON.stringify(restoredWrite?.errorMessage ?? restoredWrite?.outcome))
    const overlay = join(stampDir, 'a-config-overlay.yml')
    writeFileSync(overlay, `- id: ${aRow}\n  config:\n    data:\n      label: alpha-cli\n`)
    const overlayBoot = runHost({
      env, runRoot, stampDir, sentinel, label: 'cli-patch', extraPatch: overlay,
      steps: [
        { kind: 'mutate', name: 'write-cli-covered-a', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'cli-write' }], revision: 0 },
      ],
    })
    const cliWrite = overlayBoot.snapshots.find(entry => entry.name === 'write-cli-covered-a')
    check('P1-05d', cliWrite?.outcome === 'error'
      && /overridden by a home patch or command-line overlay/u.test(cliWrite.errorMessage ?? ''),
    'CLI-overlaid A refuses the write', JSON.stringify(cliWrite))

    // P1-06: a volatile save keeps the Host Runtime instance; the oracle detects
    // a real non-volatile remount.
    const p16 = runHost({
      env, runRoot, stampDir, sentinel, label: 'p1-06',
      steps: [
        // Probe only: a refused save must make P1-06a fail rather than pass on
        // unchanged Host identity.
        { kind: 'mutate', name: 'save-a-live', ns: aRow, ops: [{ op: 'set', path: ['data', 'label'], value: 'alpha-live' }], revision: PROBE === 'stale-save' ? 99 : 0 },
        { kind: 'remount-oracle', name: 'host-remount', sessionId: 'oracle-remount' },
      ],
    })
    const live = p16.snapshots[0]
    const afterLive = snapshotOf(p16, 'save-a-live')
    const liveSaveOutcome = p16.snapshots.find(entry => entry.name === 'save-a-live' && entry.outcome !== undefined)
    evidence.liveSave = { before: live, after: afterLive, outcome: liveSaveOutcome }
    const liveFacts = snapshot => snapshot === undefined ? undefined : {
      pid: snapshot.pid,
      hostRuntimeUid: snapshot.hostRuntimeUid,
      hostRuntimeServiceIdentity: snapshot.hostRuntimeServiceIdentity,
      preferencesServiceIdentity: snapshot.preferencesServiceIdentity,
      rowFibers: [...snapshot.rows].sort((left, right) => left.id < right.id ? -1 : 1)
        .map(row => `${row.id}:${String(row.fiberUid)}`),
    }
    const liveA = afterLive === undefined ? undefined : describeRow(afterLive, aRow)
    const liveB = afterLive === undefined ? undefined : describeRow(afterLive, bRow)
    const livePrefs = afterLive === undefined ? undefined : describeRow(afterLive, 'pi-tui-preferences')
    const liveA0 = describeRow(live, aRow)
    const liveB0 = describeRow(live, bRow)
    check('P1-06a', liveSaveOutcome?.outcome === 'ok'
      && liveA !== undefined && liveA.value.data.label === 'alpha-live' && liveA.user.data.label === 'alpha-live'
      && liveA0 !== undefined && liveA.revision === liveA0.revision + 1
      && liveB !== undefined && liveB0 !== undefined && sameJson(settingsShape(liveB), settingsShape(liveB0))
      && livePrefs !== undefined && sameJson(settingsShape(livePrefs), settingsShape(prefsBefore))
      && afterLive !== undefined && sameJson(liveFacts(afterLive), liveFacts(live)),
    'a SUCCESSFUL volatile save (A reread alpha-live at revision+1) leaves B/prefs and the Host identity unchanged',
    JSON.stringify({
      outcome: liveSaveOutcome?.outcome,
      beforeA: liveA0 === undefined ? undefined : { value: liveA0.value, revision: liveA0.revision },
      afterA: liveA === undefined ? undefined : { value: liveA.value, revision: liveA.revision },
      identity: [liveFacts(live), liveFacts(afterLive)],
    }))
    // A settings save legitimately runs the official ConfigEditor reconciliation,
    // which emits `loader/partial-dispose` for every row WITHOUT restarting it
    // (the row fiber uids above prove that). Record the fact so the evidence does
    // not confuse the reconfiguration pass with a remount.
    evidence.reconfiguration = {
      partialDisposeEvents: afterLive?.disposeEvents.length,
      note: 'official ConfigEditor reconciliation; every sampled row fiber uid stayed identical',
    }
    const oracle = p16.snapshots.filter(entry => entry.name === 'host-remount')
    check('P1-06c', oracle.length === 2
      && oracle[1].serviceIdentity !== oracle[0].serviceIdentity
      && oracle[1].fiberUid === oracle[0].fiberUid,
    'the negative control really remounts the Host runtime (service instance changes although its fiber uid does not)',
    JSON.stringify(oracle))
    notVerified('P1-06d', 'in-flight Turn keeps its frozen Focus across the save',
      'the isolated profile has no model credentials; the runner must not fabricate a Turn')

    // P1-07: Dual's own ./host row runs natively; no ./tui Host row exists.
    const dualHost = rowOf(boot, 'r8-pr1-fixture-dual-host')
    check('P1-07a', dualHost?.state === 2, 'Dual ./host row ACTIVE in the native Loader', JSON.stringify(dualHost))
    check('P1-07b', boot.sentinel.some(line => line.event === 'host-apply' && line.package === '@r8-pr1-fixture/dual'),
      'the Dual ./host row really applied', JSON.stringify(boot.sentinel))
    check('P1-07c', !boot.rows.some(row => row.name === '@r8-pr1-fixture/dual/tui'),
      'PiTui added no Host row for the package ./tui entry', JSON.stringify(boot.rows.filter(row => row.name.includes('dual'))))
    const dualDiscovery = discoverClientExtension({
      package: manifestOf('dual'),
      selectedBundle: true,
      effectiveRows: boot.rows.map(row => ({ id: row.id, name: row.name })),
    })
    check('P1-07d', dualDiscovery.kind === 'candidate' && dualDiscovery.configRowId === dualRow,
      'Dual stays a Client candidate', JSON.stringify(dualDiscovery))

    // P1-09: the plain plugin stays fully native; its own ./tui Host row runs by
    // native rules and is never a PiTui Client claim.
    const plainHost = rowOf(boot, 'r8-pr1-fixture-plain-host')
    const plainTuiRow = rowOf(boot, 'r8-pr1-fixture-plain-tui-row')
    check('P1-09b', plainHost?.state === 2, 'plain DSH Host plugin row ACTIVE', JSON.stringify(plainHost))
    check('P1-09c', boot.sentinel.some(line => line.event === 'host-apply' && line.package === '@r8-pr1-fixture/plain'),
      'plain DSH Host plugin applied', JSON.stringify(boot.sentinel))
    check('P1-09d', plainTuiRow?.state === 2
      && boot.sentinel.some(line => line.event === 'plain-tui-import')
      && plainDiscovery.kind === 'not-opted-in',
    'the deliberate ./tui Host row runs natively and stays not-opted-in', JSON.stringify({ row: plainTuiRow, discovery: plainDiscovery }))
    const pmToggle = runHost({
      env, runRoot, stampDir, sentinel, label: 'plain-toggle',
      steps: [
        { kind: 'pm-bundle', name: 'disable-plain', bundle: '@r8-pr1-fixture/plain', enabled: false },
        { kind: 'pm-bundle', name: 'enable-plain', bundle: '@r8-pr1-fixture/plain', enabled: true },
        { kind: 'pm-bundle', name: 'disable-a', bundle: '@r8-pr1-fixture/a', enabled: false },
        { kind: 'pm-bundle', name: 'enable-a', bundle: '@r8-pr1-fixture/a', enabled: true },
      ],
    })
    const afterDisablePlain = snapshotOf(pmToggle, 'disable-plain')
    const afterEnablePlain = snapshotOf(pmToggle, 'enable-plain')
    check('P1-09e', afterDisablePlain !== undefined && afterEnablePlain !== undefined
      && !afterDisablePlain.rows.some(row => row.id === 'r8-pr1-fixture-plain-host')
      && afterEnablePlain.rows.some(row => row.id === 'r8-pr1-fixture-plain-host' && row.state === 2),
    'official PM disable/enable stops and restarts the plain plugin',
    JSON.stringify({ disabled: afterDisablePlain?.rows, enabled: afterEnablePlain?.rows }))
    const afterDisableA = snapshotOf(pmToggle, 'disable-a')
    const afterEnableA = snapshotOf(pmToggle, 'enable-a')
    check('P1-01c', afterDisableA !== undefined && afterEnableA !== undefined
      && !afterDisableA.rows.some(row => row.id === aRow && row.state === 2)
      && afterEnableA.rows.some(row => row.id === aRow && row.state === 2)
      && afterEnableA.settings.some(row => row.ns === aRow),
    'official PM disable/enable controls the A Config row',
    JSON.stringify({ disabled: afterDisableA?.rows.filter(row => row.id === aRow), enabled: afterEnableA?.rows.filter(row => row.id === aRow) }))

    // P1-09f: the official CLI REMOVE path (not merely PM enable/disable).
    run('dsh', ['plugin', '--profile', PROFILE, 'remove', '@r8-pr1-fixture/plain'], { cwd: runRoot, env })
    const removedBoot = runHost({ env, runRoot, stampDir, sentinel, label: 'plain-removed' })
    const removedSnapshot = removedBoot.snapshots[0]
    const bundlesAfterRemove = readJson(join(profileDir, 'package.json')).dsh.profile.bundles
    check('P1-09f', !bundlesAfterRemove.includes('@r8-pr1-fixture/plain')
      && !removedSnapshot.rows.some(row => row.id === 'r8-pr1-fixture-plain-host')
      && !removedSnapshot.rows.some(row => row.id === 'r8-pr1-fixture-plain-tui-row')
      && removedSnapshot.rows.some(row => row.id === aRow && row.state === 2)
      && removedSnapshot.rows.some(row => row.id === bRow && row.state === 2)
      && removedSnapshot.settings.some(row => row.ns === aRow)
      && removedSnapshot.settings.some(row => row.ns === bRow),
    'official dsh plugin remove uninstalls the plain plugin while BOTH Config rows stay ACTIVE',
    JSON.stringify({
      bundles: bundlesAfterRemove,
      plainRows: removedSnapshot.rows.filter(row => row.id.includes('plain')),
      configRows: removedSnapshot.rows.filter(row => row.id === aRow || row.id === bRow),
    }))

    // PR-2 P2-14 (rc.5): the SAME real official Host Settings authority is
    // read/written through the new semantic port, with a stale CAS negative.
    const pr2PortBoot = runHost({
      env, runRoot, stampDir, sentinel, label: 'pr2-port',
      steps: [{ kind: 'extension-port', name: 'pr2-port' }],
    })
    const pr2Port = pr2PortBoot.snapshots.find(entry => entry.name === 'pr2-port')
    const pr2PortFacts = pr2Port?.port
    check('P2-14-rc5', pr2Port?.outcome === 'ok'
      && pr2PortFacts?.writeA === 'accepted'
      && pr2PortFacts?.stale === 'conflict'
      && pr2PortFacts?.a1?.kind === 'ready' && pr2PortFacts.a1.effective?.label === 'alpha-port'
      && pr2PortFacts?.a2?.kind === 'ready' && pr2PortFacts.a2.effective?.label === 'alpha-port'
      && pr2PortFacts?.a0?.kind === 'ready' && pr2PortFacts?.b0?.kind === 'ready'
      && sameJson(pr2PortFacts.b0.effective, pr2PortFacts.b1?.effective),
    'the real rc.5 Host Settings authority serves the per-package Port read/write/CAS',
    JSON.stringify({
      outcome: pr2Port?.outcome,
      error: pr2Port?.errorMessage,
      writeA: pr2PortFacts?.writeA,
      stale: pr2PortFacts?.stale,
      a1: pr2PortFacts?.a1?.effective,
      b0: pr2PortFacts?.b0?.effective,
      b1: pr2PortFacts?.b1?.effective,
    }))

    // P1-08: the PACKED public export.
    const packedDir = join(candidate.extractDir, 'package')
    const packedManifest = readJson(join(packedDir, 'package.json'))
    const configExport = packedManifest.exports?.['./extension-config']
    check('P1-08a', configExport?.default === './dist/extension-config.mjs' && configExport?.types === './dist/extension-config.d.mts',
      'package.json exports the carrier .mjs/.d.mts', JSON.stringify(configExport))
    check('P1-08b', existsSync(join(packedDir, 'dist', 'extension-config.mjs'))
      && existsSync(join(packedDir, 'dist', 'extension-config.d.mts')),
    'packed carrier files exist', 'dist/extension-config.mjs + dist/extension-config.d.mts')
    const carrierSource = readFileSync(join(packedDir, 'dist', 'extension-config.mjs'), 'utf8')
    const carrierImports = [...carrierSource.matchAll(/^import .* from "([^"]+)";$/gmu)].map(match => match[1])
    check('P1-08c', sameJson(carrierImports, ['@deepseek-ai/schemastery'])
      && carrierImports.every(specifier => !specifier.startsWith('.') && !specifier.startsWith('src/') && !specifier.startsWith('/')),
    'carrier static graph is the one external schema peer', JSON.stringify(carrierImports))
    check('P1-08d', !candidate.listing.some(entry => entry.startsWith('package/node_modules/')),
      'the tarball carries no nested runtime copy', 'no package/node_modules entries')
    const consumerDir = preparePackedConsumer(candidate, stampDir)
    const imported = run(process.execPath, ['--input-type=module', '-e',
      "const carrier = await import('@xmoon76/dsh-pi-tui/extension-config'); console.log(JSON.stringify({ name: carrier.name, config: carrier.Config !== undefined, apply: typeof carrier.apply }))"], { cwd: consumerDir, env })
    const carrierShape = JSON.parse(imported.stdout)
    check('P1-08e', carrierShape.name === 'pi-tui-extension-config' && carrierShape.config === true && carrierShape.apply === 'function',
      'the packed carrier imports with name/Config/apply', JSON.stringify(carrierShape))
    const tsc = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'index.ts'], { cwd: consumerDir, env, encoding: 'utf8' })
    check('P1-08f', tsc.status === 0, 'a real tsc consumer typechecks ./extension-config',
      tsc.status === 0 ? 'tsc --noEmit exit 0' : `${String(tsc.status)}: ${tsc.stdout ?? ''}${tsc.stderr ?? ''}`)

    evidence.packedConsumerDir = consumerDir
    const fixtureTuiEvents = bootAudit.sentinelEvents
      .filter(line => (line.event === 'tui-import' || line.event === 'tui-apply')
        && line.package !== '@r8-pr1-fixture/plain')
    const rogueTuiRows = bootAudit.fixtureTuiRows
      .filter(row => row.name !== '@r8-pr1-fixture/plain/tui')
    check('P1-02c', fixtureTuiEvents.length === 0 && rogueTuiRows.length === 0,
      'every Host boot imported/applied no A/B/Dual ./tui entry and mounted no ./tui Host row',
      JSON.stringify({ fixtureTuiEvents, rogueTuiRows }))
    const rc3SkipRequested = process.env.R8_PR1_SKIP_RC3 === '1'
    if (rc3SkipRequested && !RC3_SKIP_PROBES.has(PROBE)) {
      // A skipped rc.3 environment can NEVER produce a successful qualification
      // verdict: only the two negative-control probes that do not exercise rc.3
      // may skip it, and an ordinary run must execute the real official chain.
      evidence.rc3 = { phase: 'skipped', status: 'REFUSED', probe: PROBE === '' ? undefined : PROBE }
      gate('P1-10', 'FAIL', 'official DSH rc.3 profile mounts two Config rows and Settings reads/writes them independently',
        `R8_PR1_SKIP_RC3=1 is only allowed for the ${[...RC3_SKIP_PROBES].join('/')} probes; this run had probe=${PROBE === '' ? '<none>' : PROBE}`)
    } else if (rc3SkipRequested) {
      evidence.rc3 = { phase: 'skipped-for-probe', status: 'SKIPPED_FOR_PROBE', probe: PROBE }
      // Never silently omit the mandatory P1-10 row: the probe did not exercise it.
      notVerified('P1-10', 'official DSH rc.3 profile mounts two Config rows and Settings reads/writes them independently',
        `not exercised by the ${PROBE} negative-control probe`)
    } else {
      rc3Qualification({ stampDir, candidate, tarballs, evidence })
    }
    // Deterministic guard: a refused skip must always leave a P1-10 FAIL row and
    // therefore a FAILED run, independent of the branch above.
    if (rc3SkipRequested && !RC3_SKIP_PROBES.has(PROBE)
      && !gates.some(entry => entry.id === 'P1-10' && entry.status === 'FAIL')) {
      gate('P1-10', 'FAIL', 'a skipped rc.3 environment can never produce a successful qualification verdict',
        'internal guard: the refusal gate was not recorded')
    }
  } catch (error) {
    gate('INFRA', 'FAIL', 'the runner completes', error instanceof Error ? `${error.name}: ${error.message}` : String(error))
  } finally {
    evidence.gates = gates
    evidence.log = logLines
    const failed = gates.filter(entry => entry.status === 'FAIL')
    const unverified = gates.filter(entry => entry.status === 'NOT_VERIFIED')
    // A gate that could not run is never folded into a bare PASS.
    evidence.status = failed.length > 0 ? 'FAIL' : unverified.length > 0 ? 'PASS_WITH_NOT_VERIFIED' : 'PASS'
    evidence.notVerified = unverified.map(entry => entry.id)
    evidence.pruned = process.env.R8_PR1_KEEP !== '1'
    writeFileSync(join(stampDir, 'evidence.json'), `${JSON.stringify(evidence, undefined, 2)}\n`)
    // The evidence is the JSON/reports/log; the installed profiles, pnpm stores
    // and packed copies are disposable inputs. Set R8_PR1_KEEP=1 to inspect them.
    if (evidence.pruned) {
      for (const directory of [runRoot, join(stampDir, 'rc3'), join(stampDir, 'candidate'),
        join(stampDir, 'consumer'), join(stampDir, 'fixtures'), join(stampDir, 'tarballs')]) {
        rmSync(directory, { recursive: true, force: true })
      }
    }
    for (const entry of gates) process.stdout.write(`${entry.status.padEnd(12)} ${entry.id}: ${entry.actual}\n`)
    process.stdout.write(`${evidence.status} ${String(failed.length)} failed / ${String(unverified.length)} not-verified / ${String(gates.length)} gates; evidence ${join(stampDir, 'evidence.json')}\n`)
    process.exitCode = failed.length === 0 ? 0 : 1
  }
}

if (process.env.R8_PR1_CHILD === 'host') {
  await hostChild()
} else {
  main()
}
