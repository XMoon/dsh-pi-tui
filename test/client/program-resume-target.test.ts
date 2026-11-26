import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { encodeProgramResumeHandoff } from '../../src/client/program-resume/handoff.ts'
import {
  clientProgramResumeCapability,
  directProgramResumeCapability,
  programResumeTarget,
  resolveOfficialCliEntry,
  type ProgramResumeLaunchEnvironment,
  type ProgramResumeProfileContext,
} from '../../src/client/program-resume/target.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const TOKEN = 'dummy-token-replace-me'
const PROFILE = 'custom-profile'
const SESSION = `session-${'a'.repeat(32)}`

interface Fixture {
  readonly root: string
  readonly home: string
  readonly cwd: string
  readonly installAnchor: string
  readonly entry: string
  readonly profileContext: ProgramResumeProfileContext
}

function fixture(t: TestContext): Fixture {
  const root = testLifecycle(t).tempDir('program-resume-target-')
  const home = join(root, 'dsh-home')
  const cwd = join(root, 'launch-cwd')
  const packageRoot = join(root, 'dsh-install')
  mkdirSync(home, { recursive: true })
  mkdirSync(join(home, 'profiles', PROFILE), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  mkdirSync(join(packageRoot, 'lib'), { recursive: true })
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
    bin: { dsh: 'lib/bin.js' },
  }))
  const entry = join(packageRoot, 'lib', 'bin.js')
  writeFileSync(entry, '// official CLI entry fixture\n')
  const installAnchor = join(packageRoot, 'package.json')
  return {
    root,
    home,
    cwd,
    installAnchor,
    entry,
    profileContext: {
      name: PROFILE,
      home,
      cwd,
      installAnchor,
      overlays: [],
      telemetryDisabledEnv: undefined,
    },
  }
}

function launchFrom(entries: Readonly<Record<string, { readonly value: string; readonly source: 'process' | 'project-env' | 'user-env' }>>): ProgramResumeLaunchEnvironment {
  return {
    getFrom(name, sources) {
      const entry = entries[name]
      if (entry === undefined) return undefined
      return sources.includes(entry.source) ? { value: entry.value, source: entry.source } : undefined
    },
  }
}

function directInput(f: Fixture, launch: ProgramResumeLaunchEnvironment, overrides: Partial<Parameters<typeof directProgramResumeCapability>[0]> = {}) {
  return {
    profileContext: f.profileContext,
    launch,
    presetId: undefined,
    env: {},
    execArgv: [],
    argv: ['/node', f.entry],
    execPath: process.execPath,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: 'linux' as NodeJS.Platform,
    ...overrides,
  }
}

test('an official manifest cannot point its bin outside the installation root', t => {
  const f = fixture(t)
  const outside = join(f.root, 'outside.js')
  writeFileSync(outside, '// not the official entry\n')
  writeFileSync(f.installAnchor, JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
    bin: { dsh: '../outside.js' },
  }))
  assert.equal(resolveOfficialCliEntry(f.installAnchor), undefined)
  writeFileSync(f.installAnchor, JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: '0.2.2-rc.5',
    bin: { dsh: outside },
  }))
  assert.equal(resolveOfficialCliEntry(f.installAnchor), undefined)
})

test('a leading-dash or control-bearing Profile is never placed into argv', t => {
  const f = fixture(t)
  const inherited = launchFrom({ OSC7577_TOKEN: { value: TOKEN, source: 'process' } })
  for (const name of ['-danger', 'bad\nname', '']) {
    assert.equal(directProgramResumeCapability(directInput(f, inherited, {
      profileContext: { ...f.profileContext, name },
    })), undefined, name)
  }
})

test('the direct capability uses only the inherited token and the exact official CLI target', t => {
  const f = fixture(t)
  const capability = directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'process' },
  })))
  assert.ok(capability)
  assert.equal(capability.token, TOKEN)
  assert.equal(capability.facts.ownerPid, process.pid)
  assert.equal(capability.facts.home, f.home)
  assert.equal(capability.facts.profile, PROFILE)
  assert.equal(capability.facts.backend, 'direct')
  assert.equal(capability.facts.cwd, f.cwd)
  assert.equal(capability.facts.nodePath, process.execPath)
  assert.equal(capability.facts.cliPath, resolveOfficialCliEntry(f.installAnchor, f.entry))
})

test('the direct target is the exact frozen argv with cwd carried separately', t => {
  const f = fixture(t)
  const capability = directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'process' },
  })))
  assert.ok(capability)
  const target = programResumeTarget(capability, SESSION)
  assert.ok(target)
  assert.deepEqual(target.argv, [
    '/usr/bin/env',
    `DSH_HOME=${f.home}`,
    'DSH_PI_TUI_BACKEND=direct',
    process.execPath,
    f.entry,
    '--profile',
    PROFILE,
    '--session',
    SESSION,
  ])
  assert.equal(target.cwd, f.cwd)
  assert.equal(target.ownerPid, process.pid)
  assert.equal(programResumeTarget(capability, 'short-id'), undefined)
  assert.equal(programResumeTarget(capability, undefined), undefined)
})

test('a project/user .env token never grants the capability', t => {
  const f = fixture(t)
  assert.equal(directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'project-env' },
  }))), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'user-env' },
  }))), undefined)
})

test('launch forms the command cannot express fail closed', t => {
  const f = fixture(t)
  const inherited = launchFrom({ OSC7577_TOKEN: { value: TOKEN, source: 'process' } })
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { presetId: 'standard' })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, {
    profileContext: { ...f.profileContext, overlays: [{}] },
  })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, {
    profileContext: { ...f.profileContext, telemetryDisabledEnv: '1' },
  })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { execArgv: ['--require', 'x'] })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { env: { NODE_OPTIONS: '--require x' } })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { env: { TMUX: '/tmp/tmux' } })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { env: { STY: 'x' } })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { env: { ZELLIJ: 'x' } })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { stdinIsTTY: false })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { stdoutIsTTY: false })), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, inherited, { platform: 'win32' })), undefined)
})

test('an SSH marker in the inherited layer disables the capability', t => {
  const f = fixture(t)
  assert.equal(directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'process' },
    SSH_CONNECTION: { value: '1.2.3.4 1 5.6.7.8 2', source: 'process' },
  }))), undefined)
  assert.equal(directProgramResumeCapability(directInput(f, launchFrom({
    OSC7577_TOKEN: { value: TOKEN, source: 'process' },
    SSH_TTY: { value: '/dev/pts/1', source: 'process' },
  }))), undefined)
})

test('the daemon handoff validates the official scope, owner and v1 facts', t => {
  const f = fixture(t)
  const facts = {
    version: 1 as const,
    ownerPid: 4242,
    home: f.home,
    profile: PROFILE,
    backend: 'daemon' as const,
    cwd: f.cwd,
    nodePath: process.execPath,
    cliPath: f.entry,
  }
  const handoff = encodeProgramResumeHandoff(facts)
  const base = {
    token: TOKEN,
    handoff,
    expectedHome: f.home,
    expectedProfile: PROFILE,
    isReexec: false,
    parentPid: 4242,
    env: {},
    execArgv: [],
    stdinIsTTY: true,
    stdoutIsTTY: true,
    platform: 'linux' as NodeJS.Platform,
  }
  const capability = clientProgramResumeCapability(base)
  assert.ok(capability)
  assert.equal(capability.facts.backend, 'daemon')
  assert.equal(capability.facts.ownerPid, 4242)
  assert.equal(clientProgramResumeCapability({ ...base, parentPid: 9999 }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, expectedProfile: 'other' }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, expectedHome: join(f.root, 'other') }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, token: 'short' }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, handoff: '{}' }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, env: { TMUX: 'x' } }), undefined)
  assert.equal(clientProgramResumeCapability({ ...base, stdinIsTTY: false }), undefined)
  // The existing expected-instance reexec is the only case whose parent is the
  // waiting old Client, not the stable supervisor.
  assert.ok(clientProgramResumeCapability({ ...base, isReexec: true, parentPid: 9999 }))
})
