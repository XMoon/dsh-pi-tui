import assert from 'node:assert/strict'
import test from 'node:test'
import { PROGRAM_RESUME_HANDOFF_ENV, PROGRAM_RESUME_TOKEN_ENV } from '../../src/client/program-resume/handoff.ts'
import { hostCandidateEnvironment } from '../../src/app/remote-process/local-host-manager.ts'
import { applyProgramResumeChildEnvironment } from '../../src/app/remote-process/program-resume-child.ts'
import { decodeProgramResumeHandoff } from '../../src/client/program-resume/handoff.ts'

test('the detached Host candidate never inherits the OSC capability or a Client selector', () => {
  const source = {
    PATH: '/bin',
    [PROGRAM_RESUME_TOKEN_ENV]: 'dummy-token-replace-me',
    [PROGRAM_RESUME_HANDOFF_ENV]: '{"version":1}',
    DSH_PI_TUI_BACKEND: 'daemon',
    DSH_PI_TUI_ROLE: 'host',
    DSH_PI_TUI_HOST_ENTRY: '/stale/local-host.mjs',
    SPLIT_PROCESS_EXTRA_PATCH: '/stale/patch.yml',
    SPLIT_PROCESS_DSH_ANCHOR: '/stale/package.json',
  }
  const env = hostCandidateEnvironment({ dshAnchor: '/dsh/package.json', profile: 'pi-tui' }, source)
  assert.equal(env[PROGRAM_RESUME_TOKEN_ENV], undefined)
  assert.equal(env[PROGRAM_RESUME_HANDOFF_ENV], undefined)
  assert.equal(env.DSH_PI_TUI_BACKEND, undefined)
  assert.equal(env.DSH_PI_TUI_ROLE, undefined)
  assert.equal(env.DSH_PI_TUI_HOST_ENTRY, undefined)
  assert.equal(env.SPLIT_PROCESS_EXTRA_PATCH, undefined)
  assert.equal(env.SPLIT_PROCESS_DSH_ANCHOR, '/dsh/package.json')
  assert.equal(env.SPLIT_PROCESS_PROFILE, 'pi-tui')
  assert.equal(env.PATH, '/bin')
})

test('the admitted foreground Client alone receives the token and non-secret facts', () => {
  const env: NodeJS.ProcessEnv = { PATH: '/bin' }
  const capability = {
    token: 'dummy-token-replace-me',
    facts: {
      version: 1 as const,
      ownerPid: 4242,
      home: '/home/user/.dsh',
      profile: 'pi-tui',
      backend: 'daemon' as const,
      cwd: '/home/user/project',
      nodePath: '/usr/local/bin/node',
      cliPath: '/opt/dsh/lib/bin.js',
    },
  }
  applyProgramResumeChildEnvironment(env, capability)
  assert.equal(env[PROGRAM_RESUME_TOKEN_ENV], capability.token)
  const facts = decodeProgramResumeHandoff(env[PROGRAM_RESUME_HANDOFF_ENV] as string)
  assert.deepEqual(facts, capability.facts)
  assert.equal(JSON.stringify(facts).includes(capability.token), false, 'the private facts never repeat the secret')
})
