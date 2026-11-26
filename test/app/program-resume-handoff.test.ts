import assert from 'node:assert/strict'
import test from 'node:test'
import { PROGRAM_RESUME_HANDOFF_ENV, PROGRAM_RESUME_TOKEN_ENV } from '../../src/client/program-resume/handoff.ts'
import { hostCandidateEnvironment } from '../../src/app/remote-process/local-host-manager.ts'

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
