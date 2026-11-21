/**
 * Client fatal diagnostics: the private, bounded, redacted artifact written by
 * a Split Client's three real fatal paths, plus its terminal-safe locator.
 *
 * Evidence level: product unit + real filesystem. Every writer case uses a
 * test-owned temporary DSH_HOME and real filesystem objects (no mocked write).
 * @module @xmoon76/dsh-pi-tui/client-fatal-diagnostics.test
 */

import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import {
  clientDiagnosticLocation,
  clientFatalErrorDetails,
  clientFatalKind,
  clientModuleSpecifier,
  writeAllBytes,
  writeClientFatalDiagnostic,
} from '../../src/app/remote-process/client-fatal-diagnostics.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

function fixture(t: TestContext): { life: TestLifecycle; home: string; env: NodeJS.ProcessEnv } {
  const life = testLifecycle(t)
  const home = life.tempDir('dsh-client-fatal-')
  return { life, home, env: { DSH_HOME: home } }
}

test('writes one 0700/0600 private file with the real module error and stack', t => {
  const { home, env } = fixture(t)
  const error = Object.assign(
    new Error("Cannot find package '@deepseek-ai/dsh-client-store' imported from /private/profile/client-bootstrap.mjs"),
    {
      code: 'ERR_MODULE_NOT_FOUND',
      stack: "Error: Cannot find package '@deepseek-ai/dsh-client-store'\n    at Module._resolveFilename (node:internal/modules/cjs/loader:123:45)",
    },
  )
  const result = writeClientFatalDiagnostic(error, 'client-assembly', env)
  assert.equal(result.kind, 'written')
  if (result.kind !== 'written') return
  assert.match(result.fileName, /^startup-[0-9a-f-]+\.log$/u)
  const directory = join(home, 'logs', 'pi-tui-client')
  assert.equal(statSync(directory).mode & 0o777, 0o700, 'Client directory is private 0700')
  const file = join(directory, result.fileName)
  const fileStats = statSync(file)
  assert.equal(fileStats.mode & 0o777, 0o600, 'fatal file is private 0600')
  const text = readFileSync(file, 'utf8')
  assert.ok(text.startsWith('dsh-pi-tui client fatal v1\n'), text.slice(0, 80))
  assert.match(text, /phase: client-assembly/u)
  assert.match(text, /kind: CLIENT_MODULE_MISSING/u)
  assert.match(text, /error\.code: ERR_MODULE_NOT_FOUND/u)
  assert.match(text, /Cannot find package '@deepseek-ai\/dsh-client-store'/u)
  assert.match(text, /at Module\._resolveFilename/u)
})

test('DSH_PI_TUI_LOG=off and the empty value disable the file without creating the directory', t => {
  const { home } = fixture(t)
  for (const value of ['off', '']) {
    const result = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', { DSH_HOME: home, DSH_PI_TUI_LOG: value })
    assert.deepEqual(result, { kind: 'disabled' })
  }
  assert.equal(existsSync(join(home, 'logs')), false)
})

test('an existing wider Client directory is tightened to 0700 without touching the shared logs parent', t => {
  const { home, env } = fixture(t)
  const logs = join(home, 'logs')
  mkdirSync(logs, { mode: 0o755 })
  const directory = join(logs, 'pi-tui-client')
  mkdirSync(directory, { mode: 0o755 })
  chmodSync(logs, 0o755)
  chmodSync(directory, 0o755)
  const result = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', env)
  assert.equal(result.kind, 'written')
  assert.equal(statSync(directory).mode & 0o777, 0o700)
  assert.equal(statSync(logs).mode & 0o777, 0o755, 'the shared logs parent is never chmodded')
})

test('a symlinked Client directory is refused and nothing is written outside the root', t => {
  const { life, home, env } = fixture(t)
  const outside = life.tempDir('dsh-client-fatal-outside-')
  mkdirSync(join(home, 'logs'), { mode: 0o700 })
  symlinkSync(outside, join(home, 'logs', 'pi-tui-client'))
  const result = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', env)
  assert.equal(result.kind, 'unavailable')
  assert.equal(readdirSync(outside).length, 0, 'no file may be created through the link')
})

test('a directory not owned by this process user is refused', t => {
  const { home, env } = fixture(t)
  mkdirSync(join(home, 'logs'), { mode: 0o700 })
  const originalGetuid = process.getuid
  try {
    process.getuid = () => (originalGetuid === undefined ? 1 : originalGetuid() + 1)
    const result = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', env)
    assert.equal(result.kind, 'unavailable')
    assert.equal(existsSync(join(home, 'logs', 'pi-tui-client')), false)
  } finally {
    process.getuid = originalGetuid
  }
})

test('an unwritable logs parent fails closed as unavailable', t => {
  const { home, env } = fixture(t)
  const logs = join(home, 'logs')
  mkdirSync(logs, { mode: 0o500 })
  try {
    const result = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', env)
    assert.equal(result.kind, 'unavailable')
    if (result.kind === 'unavailable') assert.match(result.errno, /^E[A-Z]+$/u)
    assert.equal(existsSync(join(logs, 'pi-tui-client')), false)
  } finally {
    chmodSync(logs, 0o700)
  }
})

test('bounded causes, circular causes and hostile getters never throw or exceed 32 KiB', t => {
  const circularRoot = new Error('primary')
  const circularCause = new Error('cause-1')
  circularRoot.cause = circularCause
  circularCause.cause = circularRoot
  const circularPreview = clientFatalErrorDetails(circularRoot, 'client-assembly')
  assert.ok(circularPreview.text.includes('<circular cause>'))
  assert.ok(circularPreview.text.indexOf('primary') < circularPreview.text.indexOf('cause[1]'), 'primary is first')

  const root = new Error(`primary ${'x'.repeat(4000)}`)
  root.stack = `stack ${'y'.repeat(30_000)}😀`
  let current: Error = root
  for (let depth = 1; depth <= 5; depth += 1) {
    const cause = new Error(`cause-${String(depth)} ${'é'.repeat(2000)}`)
    current.cause = cause
    current = cause
  }
  const preview = clientFatalErrorDetails(root, 'client-assembly')
  assert.ok(Buffer.byteLength(preview.text, 'utf8') <= 32 * 1024)
  assert.equal(Buffer.from(preview.text, 'utf8').toString('utf8'), preview.text, 'UTF-8 stays valid')
  assert.ok(preview.text.includes('primary'))
  assert.ok(preview.text.includes('cause[1]'))

  const hostile = new Error('hostile')
  Object.defineProperty(hostile, 'name', { get() { throw new Error('name getter') } })
  Object.defineProperty(hostile, 'stack', { get() { throw new Error('stack getter') } })
  Object.defineProperty(hostile, 'message', { get() { throw new Error('message getter') } })
  assert.doesNotThrow(() => clientFatalErrorDetails(hostile, 'client-assembly'))
})

test('AggregateError cleanup branches stay visible as bounded cause layers', () => {
  const primary = new Error('primary')
  const first = new Error('first cleanup cause')
  const second = new Error('second cleanup cause')
  primary.cause = new AggregateError([first, second], 'cleanup aggregate')
  const preview = clientFatalErrorDetails(primary, 'client-runtime')
  assert.match(preview.text, /error\.message: primary/u)
  assert.match(preview.text, /cause\[1\]\.message: cleanup aggregate/u)
  assert.match(preview.text, /cause\[2\]\.message: first cleanup cause/u)
  assert.match(preview.text, /cause\[3\]\.message: second cleanup cause/u)
})

test('a short write is retried to completion and a zero write is an IO failure', () => {
  const chunks: string[] = []
  const shortWrite = ((_fd: number, buffer: NodeJS.ArrayBufferView, offset = 0, length = buffer.byteLength) => {
    const size = Math.min(3, length)
    chunks.push(Buffer.from(buffer.buffer, buffer.byteOffset + offset, size).toString('utf8'))
    return size
  }) as unknown as typeof import('node:fs').writeSync
  writeAllBytes(1, 'abcdefgh', shortWrite)
  assert.equal(chunks.join(''), 'abcdefgh')
  const zeroWrite = (() => 0) as unknown as typeof import('node:fs').writeSync
  assert.throws(() => writeAllBytes(1, 'abc', zeroWrite), /EIO/u)
})

test('known credential carriers are redacted in the file and the locator has no private path', t => {
  const { home, env } = fixture(t)
  const error = new Error([
    'Authorization: Bearer secret-auth',
    'Cookie: session=secret-cookie',
    'Set-Cookie: session=secret-set-cookie',
    'visit https://127.0.0.1:9/connect?token=secret-connect',
    'token=secret-token password=secret-pass access_token=secret-access',
    'token="secret-quoted" password=\'secret-single\'',
    'token=\\"secret escaped space\\"',
  ].join('\n'))
  const preview = clientFatalErrorDetails(error, 'client-assembly')
  for (const secret of ['secret-auth', 'secret-cookie', 'secret-set-cookie', 'secret-connect', 'secret-token', 'secret-pass', 'secret-access', 'secret-quoted', 'secret-single', 'secret escaped space']) {
    assert.ok(!preview.text.includes(secret), `secret leaked: ${secret}`)
  }
  assert.match(preview.text, /<redacted>/u)
  const result = writeClientFatalDiagnostic(error, 'client-assembly', env)
  assert.equal(result.kind, 'written')
  if (result.kind !== 'written') return
  const text = readFileSync(join(home, 'logs', 'pi-tui-client', result.fileName), 'utf8')
  assert.ok(!text.includes('secret-token'))
  const locator = clientDiagnosticLocation(result)
  assert.ok(!locator.includes(home), 'the locator never echoes the private absolute home')
  assert.match(locator, /^Client diagnostics: \$DSH_HOME\/logs\/pi-tui-client\/startup-[0-9a-f-]+\.log/u)
  assert.equal(clientDiagnosticLocation({ kind: 'disabled' }), 'Client diagnostic file disabled (DSH_PI_TUI_LOG=off)')
  assert.match(clientDiagnosticLocation({ kind: 'unavailable', errno: 'EACCES' }), /DIAGNOSTIC_WRITE_FAILURE: EACCES/u)
})

test('classifies module-missing codes strictly and describes non-standard thrown values', t => {
  const moduleError = Object.assign(new Error("Cannot find module 'left-pad'"), { code: 'MODULE_NOT_FOUND' })
  assert.equal(clientFatalKind(moduleError, 'client-assembly'), 'CLIENT_MODULE_MISSING')
  assert.equal(clientModuleSpecifier(moduleError), 'left-pad')
  assert.equal(clientModuleSpecifier(Object.assign(new Error("Cannot find module '/private/secret.js'"), { code: 'ERR_MODULE_NOT_FOUND' })), undefined)
  assert.equal(clientModuleSpecifier(Object.assign(new Error('Cannot find module "x y"'), { code: 'ERR_MODULE_NOT_FOUND' })), undefined)
  assert.equal(clientFatalKind(new Error('boom'), 'client-assembly'), 'CLIENT_STARTUP_FAILED')
  assert.equal(clientFatalKind(new Error('boom'), 'client-runtime'), 'CLIENT_RUNTIME_FAILED')

  const { home, env } = fixture(t)
  const result = writeClientFatalDiagnostic('plain thrown', 'client-assembly', env)
  assert.equal(result.kind, 'written')
  if (result.kind !== 'written') return
  const text = readFileSync(join(home, 'logs', 'pi-tui-client', result.fileName), 'utf8')
  assert.match(text, /error\.name: NonError/u)
  assert.match(text, /error\.message: plain thrown/u)

  const missingHome = writeClientFatalDiagnostic(new Error('boom'), 'client-assembly', { DSH_HOME: join(home, 'missing') })
  assert.deepEqual(missingHome, { kind: 'unavailable', errno: 'ENOENT' })
})
