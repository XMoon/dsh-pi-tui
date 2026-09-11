#!/usr/bin/env node
/**
 * Verify the published root composeAgent compatibility seam against the
 * candidate package tarball. The fixture typechecks and runs through the
 * package root so both package exports (`." -> dist/index.*`) are exercised.
 *
 * @module compose-agent-compat-smoke
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function candidateTarball() {
  const explicit = process.argv[2]
  if (explicit !== undefined) {
    const path = resolve(explicit)
    if (!existsSync(path)) throw new Error(`tarball not found: ${explicit}`)
    return path
  }
  const candidates = readdirSync(PACKAGE_ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/.test(name))
    .map(name => join(PACKAGE_ROOT, name))
    .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
  if (candidates.length === 0) {
    throw new Error(`no xmoon76-dsh-pi-tui-*.tgz in ${PACKAGE_ROOT}; run pnpm pack:release first`)
  }
  return candidates[0]
}

function writeFixture(fixtureDir) {
  mkdirSync(join(fixtureDir, 'src'), { recursive: true })
  writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
    name: 'dsh-pi-tui-compose-agent-fixture',
    private: true,
    type: 'module',
  }, null, 2))
  writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'NodeNext',
      moduleResolution: 'NodeNext',
      strict: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ['src/typecheck.mts'],
  }, null, 2))
  writeFileSync(join(fixtureDir, 'src', 'typecheck.mts'), `import { composeAgent } from '@xmoon76/dsh-pi-tui'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelectionRef } from '@deepseek-ai/dsh-agent'

declare const ctx: Context
declare const agentCtx: Context
declare const ref: ModelSelectionRef
declare const agent: Agent

const legacy = await composeAgent(ctx, ref)
await legacy.setup(agentCtx)

const current = await composeAgent(ctx, (setupCtx, setupAgent) => {
  const typedContext: Context = setupCtx
  const typedAgent: Agent = setupAgent
  void typedContext
  void typedAgent
})
await current.setup(agentCtx, agent)
// @ts-expect-error The explicit-Agent production setup requires its Agent.
await current.setup(agentCtx)
`)
  writeFileSync(join(fixtureDir, 'src', 'runtime.mjs'), `import { composeAgent } from '@xmoon76/dsh-pi-tui'

function recordingContext(events) {
  return {
    on(name) {
      events.push(name)
      return () => {}
    },
  }
}

const legacySelection = { current: undefined, assembled: undefined }
const noRoster = { get: () => undefined }
const legacy = await composeAgent(noRoster, legacySelection)
const noRosterEvents = []
await legacy.setup(recordingContext(noRosterEvents))
if (noRosterEvents.join(',') !== 'system-prompt/assemble,agent/request,agent/pre-step') {
  throw new Error('legacy setup did not install the selection listeners')
}

const mounted = []
const roster = {
  resolve: async () => ({ id: 'standard' }),
  mount: async (_ctx, id) => { mounted.push(id) },
}
const withRoster = { get: name => name === 'agentPresets' ? roster : undefined }
const legacyRoster = await composeAgent(withRoster, { current: undefined, assembled: undefined })
await legacyRoster.setup(recordingContext([]))
if (mounted.join(',') !== 'standard') throw new Error('legacy setup skipped the preset mount')

const suppliedAgent = {}
let receivedAgent
const current = await composeAgent(noRoster, (_ctx, agent) => { receivedAgent = agent })
await current.setup(recordingContext([]), suppliedAgent)
if (receivedAgent !== suppliedAgent) throw new Error('explicit installer received the wrong Agent')

console.log('compose-agent-compat-smoke: passed')
`)
}

function linkDependencies(packageDir, fixtureDir) {
  const hostModules = join(PACKAGE_ROOT, 'node_modules')
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true })
  mkdirSync(join(fixtureDir, 'node_modules'), { recursive: true })
  for (const entry of readdirSync(hostModules)) {
    const source = join(hostModules, entry)
    const packageTarget = join(packageDir, 'node_modules', entry)
    if (!existsSync(packageTarget)) symlinkSync(source, packageTarget, 'dir')
    const fixtureTarget = join(fixtureDir, 'node_modules', entry)
    if (!existsSync(fixtureTarget)) symlinkSync(source, fixtureTarget, 'dir')
  }
}

function main() {
  const tarball = candidateTarball()
  const workDir = mkdtempSync(join(tmpdir(), 'compose-agent-compat-'))
  try {
    const extractedRoot = join(workDir, 'extracted')
    const packageDir = join(extractedRoot, 'package')
    const fixtureDir = join(workDir, 'fixture')
    mkdirSync(extractedRoot, { recursive: true })
    mkdirSync(fixtureDir, { recursive: true })
    const extract = run('tar', ['-xzf', tarball, '-C', extractedRoot])
    if (extract.status !== 0) throw new Error(`tarball extraction failed: ${extract.stderr}`)
    if (!existsSync(join(packageDir, 'dist', 'index.mjs')) || !existsSync(join(packageDir, 'dist', 'index.d.mts'))) {
      throw new Error('candidate tarball is missing the published root dist entry')
    }

    mkdirSync(join(fixtureDir, 'node_modules', '@xmoon76'), { recursive: true })
    symlinkSync(packageDir, join(fixtureDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), 'dir')
    linkDependencies(packageDir, fixtureDir)
    writeFixture(fixtureDir)

    const tsc = run(process.execPath, [
      join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', join(fixtureDir, 'tsconfig.json'),
    ], { cwd: fixtureDir })
    if (tsc.status !== 0) {
      throw new Error(`packed root declaration fixture failed:\n${tsc.stdout}${tsc.stderr}`)
    }

    const runtime = run(process.execPath, [join(fixtureDir, 'src', 'runtime.mjs')], { cwd: fixtureDir })
    if (runtime.status !== 0 || !runtime.stdout.includes('compose-agent-compat-smoke: passed')) {
      throw new Error(`packed root runtime fixture failed:\n${runtime.stdout}${runtime.stderr}`)
    }
    console.log(`compose-agent-compat-smoke: verified ${tarball}`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }
}

main()
