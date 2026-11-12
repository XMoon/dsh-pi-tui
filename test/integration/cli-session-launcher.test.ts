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
 * ENVIRONMENT: the pinned CLI comes from the project's mise toolchain (the
 * same executable the developer tasks use). When it is not on PATH or is not
 * the version pinned by `package.json`, the test is SKIPPED with the concrete
 * reason instead of pretending the contract was exercised. The profile, the
 * DSH_HOME and every probe artifact live under the test lifecycle's private
 * temp root; the real `~/.dsh` is never touched.
 *
 * @module @xmoon76/dsh-pi-tui/cli-session-launcher.test
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
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

/** Resolve the pinned launcher from PATH, or a concrete skip reason. */
function pinnedLauncher(): { readonly path: string } | { readonly skip: string } {
  const probe = spawnSync('dsh', ['--version'], { encoding: 'utf8', timeout: 20_000 })
  if (probe.error !== undefined) {
    return { skip: `the pinned DSH CLI is not on PATH (${probe.error.message}); run this lane through the project's mise toolchain` }
  }
  const version = probe.stdout.trim().split('\n')[0]?.trim() ?? ''
  if (probe.status !== 0) {
    return { skip: `dsh --version failed with exit ${String(probe.status)}; the pinned CLI is not usable in this environment` }
  }
  const pinned = pinnedDshVersion()
  if (version !== pinned) {
    return { skip: `the DSH CLI on PATH reports ${version || '(no version)'}, not the pinned ${pinned}` }
  }
  // The launcher has to resolve `dsh` by name; PATH is the same executable the
  // version probe just used.
  return { path: 'dsh' }
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
  if (!existsSync(join(ROOT, 'dist', 'index.mjs'))) {
    t.skip('the built bundle is missing at dist/index.mjs; this lane must run after `pnpm build`')
    return
  }
  const launcher = pinnedLauncher()
  if ('skip' in launcher) {
    t.skip(launcher.skip)
    return
  }

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
  const install = spawnSync(launcher.path, ['plugin', '--profile', PROFILE, '--', 'add', `link:${ROOT}`], {
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
    const result = spawnSync(launcher.path, ['--profile', PROFILE, '--patch', patchPath, ...args], {
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
  // Session/Workspace write.
  const durable = (): { readonly sessions: boolean; readonly workspace: boolean } => ({
    sessions: existsSync(join(home, 'sessions')),
    workspace: existsSync(join(home, 'storages', 'workspace.json')),
  })
  const before = durable()
  const conflict = run(['--session', '-c'])
  assert.equal(conflict.status, 1, `the --session/--continue conflict must exit nonzero:\n${conflict.output}`)
  assert.equal(probeRecord(conflict.output), undefined, 'the conflict must not publish tuiStartup')
  assert.match(conflict.output, /--session and --continue are mutually exclusive/u)
  assert.deepEqual(durable(), before, 'the conflict must perform no Host Session or Workspace write')
})
