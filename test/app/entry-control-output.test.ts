/**
 * The default entry-record sink contract: readable Host production output by
 * default and the raw M4-A0 JSONL qualification stream only on the explicit
 * `DSH_PI_TUI_ENTRY_RECORDS=1` opt-in. Each policy runs in its own child so the
 * module-start environment snapshot is the real input, never a monkeypatch.
 *
 * @module @xmoon76/dsh-pi-tui/app/entry-control-output.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { writeEntryRecord } from '../../src/app/remote-process/entry-control.ts'

const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ENTRY_CONTROL_MODULE = fileURLToPath(new URL('../../src/app/remote-process/entry-control.ts', import.meta.url))

/** The frozen probe records, in call order. */
const RECORDS: ReadonlyArray<Record<string, unknown>> = [
  { m4a0: 'profile-booted', processRole: 'host', pid: 111, phase: 'profile-booted' },
  {
    m4a0: 'ready',
    processRole: 'host',
    pid: 111,
    profile: 'pi-tui-test',
    services: { credentials: true },
    ownerEntries: { agents: ['agent'] },
    entries: [{ id: 'secret-inventory' }],
  },
  { m4a0: 'diagnostic', processRole: 'host', code: 'acp-autostart-unavailable', failure: 'mutation-failed' },
  { m4a0: 'failure', processRole: 'host', phase: 'startup', code: 'HOST_START_FAILED', error: 'example failure', stack: 'stack must not leak' },
  { m4a0: 'cleanup-failure', processRole: 'host', step: 'liveness-close', error: 'cleanup failed' },
  { m4a0: 'status', processRole: 'host', requestId: 'test-only', services: { credentials: true } },
  { m4b2hf: 'host-rpc-proof', processRole: 'host', path: '/private/fake' },
  { m4a0: 'diag', processRole: 'host', level: 'debug', message: 'debug only' },
  { m4a0: 'diag', processRole: 'host', level: 'warn', message: 'warning for user' },
]

interface SinkResult {
  readonly stdout: string
  readonly stderr: string
}

/** Run all probe records through the default sink in one isolated child. */
function runDefaultSink(value?: string): SinkResult {
  const env = { ...process.env }
  delete env.DSH_PI_TUI_ENTRY_RECORDS
  if (value !== undefined) env.DSH_PI_TUI_ENTRY_RECORDS = value
  const source = [
    `import { writeEntryRecord } from ${JSON.stringify(ENTRY_CONTROL_MODULE)}`,
    ...RECORDS.map(record => `writeEntryRecord(${JSON.stringify(record)})`),
  ].join('\n')
  const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', source], {
    cwd: REPOSITORY_ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  assert.equal(result.status, 0, `the entry-control child failed: ${result.stderr}`)
  return { stdout: result.stdout, stderr: result.stderr }
}

test('the default Host output is concise production text without qualification JSON', () => {
  const { stdout, stderr } = runDefaultSink()
  assert.deepEqual(stdout.trim().split('\n'), [
    'dsh-pi-tui host: ready (profile=pi-tui-test, pid=111)',
  ])
  assert.deepEqual(stderr.trim().split('\n'), [
    'dsh-pi-tui host: warning acp-autostart-unavailable (mutation-failed)',
    'dsh-pi-tui host: startup failed [phase=startup] [code=HOST_START_FAILED]: example failure',
    'dsh-pi-tui host: cleanup failed [step=liveness-close]: cleanup failed',
    'dsh-pi-tui host: warn: warning for user',
  ])
  const combined = `${stdout}${stderr}`
  for (const leaked of ['"m4a0"', 'services', 'ownerEntries', 'secret-inventory', 'test-only', 'host-rpc-proof', 'stack must not leak']) {
    assert.ok(!combined.includes(leaked), `the default output must not leak ${leaked}`)
  }
})

test('0 and true keep the same concise production output as unset', () => {
  const baseline = runDefaultSink()
  assert.deepEqual(runDefaultSink('0'), baseline)
  assert.deepEqual(runDefaultSink('true'), baseline)
})

test('the JSONL opt-in preserves every record on stdout in call order', () => {
  const { stdout, stderr } = runDefaultSink('1')
  const lines = stdout.trim().split('\n')
  assert.equal(lines.length, RECORDS.length)
  assert.deepEqual(lines.map(line => JSON.parse(line)), RECORDS)
  assert.equal(stderr, '')
  assert.ok(!stdout.includes('dsh-pi-tui host:'), 'the opt-in stream must stay pure JSONL')
})

test('an explicitly provided sink receives the record unchanged', () => {
  const records: Array<Record<string, unknown>> = []
  const record = { m4a0: 'ready', processRole: 'host', pid: 7, profile: 'custom-sink' }
  writeEntryRecord(record, value => records.push(value))
  assert.deepEqual(records, [record])
})
