/**
 * PR2 real-Launcher qualification: the PINNED `dsh` executable must forward
 * `--session [id-or-query]`, `-c/--continue` and an adjacent `--preset` to the
 * tree verbatim, and the app's own command action must fail the conflict
 * before publishing `tuiStartup` or writing a Host Session/Workspace.
 *
 * The probe is an EXTRA `--patch` overlay row: the launcher applies it after
 * the profile layer, the row injects the real `tuiStartup` + `appExit`
 * services, prints the published values once, and exits. The REAL launcher
 * owns profile boot, bundle loading and inner-argument forwarding; the probe
 * only observes the app's published service, it does not parse argv itself.
 *
 * ENVIRONMENT: the test prefers the pinned CLI the project mise toolchain puts
 * on PATH. When that executable is absent or is a different version, it
 * provisions the EXACT `package.json` pin into a private `pnpm` root (with
 * lifecycle scripts ignored) and runs the same real launcher from there, so
 * the product shards exercise the contract instead of skipping it. The
 * profile, the DSH_HOME and every probe artifact live under the test
 * lifecycle's private temp root; the real `~/.dsh` is never touched.
 *
 * @module @xmoon76/dsh-pi-tui/cli-session-launcher.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
// @ts-expect-error -- the repository's plain-JavaScript tooling helper has no declaration file
import { pnpmExecutable } from '../../scripts/lib/process.mjs'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PROFILE = 'pi-tui-cli-launch'
const PROBE_MARKER = 'CLI_STARTUP_PROBE '

/** The version this repository's toolchain pins for the DSH family. */
function pinnedDshVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    devDependencies?: Record<string, string>
  }
  const version = pkg.devDependencies?.['@deepseek-ai/dsh-agent']
  if (version === undefined || version === '') {
    throw new Error('package.json does not pin @deepseek-ai/dsh-agent')
  }
  return version
}

/** One resolved real launcher invocation. */
interface Launcher {
  readonly command: string
  readonly prefix: readonly string[]
}

/** The version one launcher invocation reports. */
function launcherVersion(command: string, prefix: readonly string[], env: NodeJS.ProcessEnv): string {
  const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8', timeout: 20_000, env })
  return probe.status === 0 ? (probe.stdout.trim().split('\n')[0]?.trim() ?? '') : ''
}

/**
 * Resolve the EXACT `package.json` pin. The project mise toolchain is the
 * first choice; an environment without it (the product shards) provisions the
 * same pin into a private pnpm root, so the contract is exercised rather than
 * skipped. The provisioned entry is the real `dsh` launcher binary, never a
 * reimplementation of its argv parser.
 */
function resolveLauncher(home: string, env: NodeJS.ProcessEnv): Launcher {
  const pinned = pinnedDshVersion()
  if (launcherVersion('dsh', [], env) === pinned) return { command: 'dsh', prefix: [] }
  const cliRoot = join(home, 'dsh-cli')
  mkdirSync(cliRoot, { recursive: true })
  writeFileSync(join(cliRoot, 'package.json'), JSON.stringify({ name: 'dsh-cli-launcher-test', private: true }))
  // Lifecycle scripts are ignored on purpose: the launcher, its argv parser
  // and the probe row do not need the optional native modules, and pnpm 12
  // otherwise refuses an install whose dependency scripts are not approved.
  const install = spawnSync(pnpmExecutable(), ['add', `@deepseek-ai/dsh@${pinned}`, '--ignore-scripts'], {
    cwd: cliRoot,
    env,
    encoding: 'utf8',
    timeout: 240_000,
  })
  assert.equal(install.status, 0,
    `could not provision the pinned DSH CLI ${pinned} for this lane:\n${install.stdout ?? ''}\n${install.stderr ?? ''}`)
  const bin = join(cliRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  assert.ok(existsSync(bin), `the provisioned DSH CLI entry is missing at ${bin}`)
  const launcher: Launcher = { command: process.execPath, prefix: [bin] }
  assert.equal(launcherVersion(launcher.command, launcher.prefix, env), pinned,
    `the provisioned DSH CLI must report the pinned ${pinned}`)
  return launcher
}

/** The test-only overlay row: observe the REAL published startup values once. */
function probeModuleSource(): string {
  return [
    'export const name = "cli-launch-probe"',
    'export const inject = ["tuiStartup", "appExit"]',
    'export function apply(ctx) {',
    '  const startup = ctx.get("tuiStartup")',
    '  const values = {',
    '    ...(startup.sessionId === undefined ? {} : { sessionId: startup.sessionId }),',
    '    ...(startup.sessionLaunch === undefined ? {} : { sessionLaunch: startup.sessionLaunch }),',
    '    ...(startup.presetId === undefined ? {} : { presetId: startup.presetId }),',
    '  }',
    '  process.stdout.write(`CLI_STARTUP_PROBE ${JSON.stringify(values)}\\n`)',
    '  ctx.get("appExit")(0)',
    '}',
    '',
  ].join('\n')
}

/** Extract the LAST probe record on one launcher run's combined output. */
function probeRecord(output: string): unknown {
  let found: unknown
  for (const line of output.split('\n')) {
    const index = line.lastIndexOf(PROBE_MARKER)
    if (index < 0) continue
    const start = line.indexOf('{', index + PROBE_MARKER.length)
    if (start < 0) continue
    // The probe writes plain JSON; the TUI may have painted ANSI on the same
    // physical line, so stop at the matching top-level brace.
    let depth = 0
    let end = -1
    for (let cursor = start; cursor < line.length; cursor += 1) {
      const char = line[cursor]
      if (char === '{') depth += 1
      else if (char === '}') {
        depth -= 1
        if (depth === 0) { end = cursor + 1; break }
      }
    }
    if (end < 0) continue
    found = JSON.parse(line.slice(start, end))
  }
  return found
}

test('the real pinned dsh launcher forwards the PR2 Session grammar to tuiStartup', async (t) => {
  assert.ok(existsSync(join(ROOT, 'dist', 'index.mjs')),
    'the product lane must run after `pnpm build`: dist/index.mjs is the bundle the isolated profile loads')

  const life = testLifecycle(t)
  const home = life.tempDir('dsh-cli-launcher-home-')
  const profileDir = join(home, 'profiles', PROFILE)
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
  }
  delete env.DSH_MODE
  delete env.DSH_PI_TUI_ROLE
  delete env.DSH_PI_TUI_HOST_ENTRY
  delete env.SPLIT_PROCESS_CLIENT_MODE
  delete env.SPLIT_PROCESS_CLIENT_SESSION

  // Install THIS worktree's built bundle into a private profile with the real
  // `dsh plugin` entry (no hand-written profile files).
  const launcher = resolveLauncher(home, env)
  const install = spawnSync(launcher.command, [...launcher.prefix, 'plugin', '--profile', PROFILE, '--', 'add', `link:${ROOT}`], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 180_000,
  })
  assert.equal(install.status, 0, `dsh plugin failed to install the candidate into the isolated profile:\n${install.stdout}\n${install.stderr}`)
  assert.ok(existsSync(profileDir), 'the real launcher must create the isolated profile directory')

  // The probe overlay: an EXTRA patch row after the profile layer.
  const probePath = join(home, 'cli-launch-probe.mjs')
  writeFileSync(probePath, probeModuleSource())
  const patchPath = join(home, 'cli-launch-probe.yml')
  writeFileSync(patchPath, [
    '- insert:',
    '    - id: cli-launch-probe',
    `      name: ${JSON.stringify(pathToFileURL(probePath).href)}`,
    '      inject: [tuiStartup, appExit]',
    '',
  ].join('\n'))

  const run = (args: readonly string[]): { readonly status: number | null; readonly output: string } => {
    const result = spawnSync(launcher.command, [...launcher.prefix, '--profile', PROFILE, '--patch', patchPath, ...args], {
      cwd: ROOT,
      env,
      encoding: 'utf8',
      timeout: 120_000,
    })
    assert.equal(result.error, undefined, `dsh could not start: ${result.error?.message ?? ''}`)
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  }

  const cases: ReadonlyArray<{
    readonly args: readonly string[]
    readonly expected: unknown
  }> = [
    { args: ['--session'], expected: { sessionLaunch: { kind: 'browse', query: '' } } },
    { args: ['--session='], expected: { sessionLaunch: { kind: 'browse', query: '' } } },
    { args: ['--session=mysql'], expected: { sessionLaunch: { kind: 'lookup', query: 'mysql' } } },
    { args: ['-c', '--preset', 'p'], expected: { sessionLaunch: { kind: 'continue' }, presetId: 'p' } },
    { args: ['--session', '--preset', 'p'], expected: { sessionLaunch: { kind: 'browse', query: '' }, presetId: 'p' } },
    { args: ['--session', 'mysql', '--preset', 'p'], expected: { sessionLaunch: { kind: 'lookup', query: 'mysql' }, presetId: 'p' } },
  ]

  for (const { args, expected } of cases) {
    const result = run(args)
    assert.equal(result.status, 0, `the real launcher must exit 0 for ${args.join(' ')}:\n${result.output}`)
    assert.deepEqual(probeRecord(result.output), expected,
      `the real launcher must forward ${args.join(' ')} verbatim to tuiStartup:\n${result.output}`)
  }

  // The conflict must fail inside the app command action, BEFORE the startup
  // service publication (the probe never runs) and without a Host durable
  // Session/Workspace write. Existence alone is not enough: a pre-existing
  // durable file must not be MODIFIED either, so the snapshot records the
  // content digest and stat identity of every entry under the two authorities.
  const durable = (): string => {
    const entries: string[] = []
    const visit = (path: string): void => {
      if (!existsSync(path)) {
        entries.push(`${path} absent`)
        return
      }
      const stat = statSync(path)
      if (stat.isDirectory()) {
        entries.push(`${path} dir ${String(stat.mtimeMs)}`)
        for (const name of readdirSync(path).sort()) visit(join(path, name))
        return
      }
      const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
      entries.push(`${path} file ${String(stat.size)} ${String(stat.mtimeMs)} ${digest}`)
    }
    visit(join(home, 'sessions'))
    visit(join(home, 'storages', 'workspace.json'))
    return entries.join('\n')
  }
  const before = durable()
  const conflict = run(['--session', '-c'])
  assert.equal(conflict.status, 1, `the --session/--continue conflict must exit nonzero:\n${conflict.output}`)
  assert.equal(probeRecord(conflict.output), undefined, 'the conflict must not publish tuiStartup')
  assert.match(conflict.output, /--session and --continue are mutually exclusive/u)
  assert.equal(durable(), before, 'the conflict must perform no Host Session or Workspace create, modify or delete')
})
