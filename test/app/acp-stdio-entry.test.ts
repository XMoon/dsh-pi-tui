/**
 * ACP stdio Adapter: real Node child + private Unix socket I/O qualification.
 *
 * Evidence level: process + fake UDS. It proves the Adapter's byte relay,
 * half-close, output drain, Host-first-close, stdout EPIPE and redacted error
 * paths. The real Host/ACP Session path is owned by the selected packed smoke,
 * never by this file.
 *
 * @module @xmoon76/dsh-pi-tui/acp-stdio-entry.test
 */

import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { closeSync, mkdirSync, openSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { dirname, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = join(ROOT, 'src', 'app', 'remote-process', 'acp-stdio-entry.ts')
const SOCKET_ENV = 'DSH_PI_TUI_ACP_STDIO_SOCKET_V1'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const CHUNK_DELAY_MS = 15
const BACKPRESSURE_WINDOW_MS = 200

/**
 * A Unix socket pathname must fit `sun_path`; the worktree temp root is too
 * long, so each test owns one short private directory under the OS temp root.
 * It is created 0700 as a private temporary directory, removed at teardown
 * and never shared with another run.
 */
function shortSocketDir(t: TestContext): string {
  const base = process.platform === 'darwin' ? '/private/tmp' : '/tmp'
  return testLifecycle(t).tempDir('dsh-pi-tui-a1-', base)
}

function spawnEntry(t: TestContext, env: NodeJS.ProcessEnv): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, ['--import', 'tsx/esm', ENTRY], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return child
}

function collect(child: ChildProcessWithoutNullStreams): { chunks: Buffer[]; stderr(): string } {
  const chunks: Buffer[] = []
  let stderr = ''
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  return { chunks, stderr: () => stderr }
}

function waitExit(child: ChildProcessWithoutNullStreams, timeoutMs = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the ACP stdio child did not exit within the bound')), timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
}

async function startEchoServer(t: TestContext, dir: string): Promise<{ path: string; server: Server }> {
  const path = join(dir, 'acp.sock')
  const server = createServer(socket => { socket.on('data', chunk => { socket.write(chunk) }) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  return { path, server }
}

test('chunked stdin bytes are preserved across the real child and socket', async t => {
  const dir = shortSocketDir(t)
  const { path } = await startEchoServer(t, dir)
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  const output = collect(child)
  const chunks = [
    Buffer.from('alpha'),
    Buffer.from([0x00, 0x01, 0xfe, 0xff]),
    Buffer.from('-omega'),
  ]
  for (const chunk of chunks) {
    child.stdin.write(chunk)
    await sleep(CHUNK_DELAY_MS)
  }
  child.stdin.end()
  const exit = await waitExit(child)
  assert.equal(exit.code, 0, `the clean EOF must exit 0: ${output.stderr()}`)
  assert.deepEqual(Buffer.concat(output.chunks), Buffer.concat(chunks), 'the relay must not rewrite, split or duplicate bytes')
  assert.equal(output.stderr(), '', 'a clean relay writes no diagnostic')
})

test('stdin EOF half-closes the socket and the Host tail drains before exit', async t => {
  const dir = shortSocketDir(t)
  const path = join(dir, 'acp.sock')
  let sawRequest = ''
  const server = createServer(socket => {
    socket.on('data', chunk => { sawRequest += String(chunk) })
    socket.once('end', () => {
      socket.write('tail-after-client-eof')
      socket.end()
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  const output = collect(child)
  child.stdin.end('request-before-eof')
  const exit = await waitExit(child)
  assert.equal(exit.code, 0, `a client EOF followed by a Host tail is clean: ${output.stderr()}`)
  assert.equal(sawRequest, 'request-before-eof', 'the request must reach the socket before the client half-close')
  assert.equal(Buffer.concat(output.chunks).toString('utf8'), 'tail-after-client-eof', 'the Host tail must drain after stdin EOF')
})

test('a Host-first close exits 4 with a fixed redacted code', async t => {
  const dir = shortSocketDir(t)
  const path = join(dir, 'acp.sock')
  const server = createServer(socket => { socket.end() })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  const output = collect(child)
  const exit = await waitExit(child)
  assert.equal(exit.code, 4, `an unexpected Host close is a transport failure: ${output.stderr()}`)
  assert.equal(Buffer.concat(output.chunks).length, 0, 'an unexpected close writes no fake protocol frame')
  assert.match(output.stderr(), /^dsh-pi-tui acp stdio: ACP_STDIO_HOST_DISCONNECTED$/mu)
  assert.ok(!output.stderr().includes(dir), 'the diagnostic must not carry the private socket path')
})

test('a closed stdout is reported as ACP_STDIO_STDOUT_EPIPE and exits 4', async t => {
  const dir = shortSocketDir(t)
  const path = join(dir, 'acp.sock')
  const server = createServer(socket => { socket.end('host-bytes') })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdout.destroy()
  const exit = await waitExit(child)
  assert.equal(exit.code, 4, `a broken stdout is a transport failure: ${stderr}`)
  assert.match(stderr, /^dsh-pi-tui acp stdio: ACP_STDIO_STDOUT_EPIPE$/mu)
})

test('a refused socket exits 4 without leaking the private path', async t => {
  const dir = shortSocketDir(t)
  const path = join(dir, 'missing.sock')
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  const output = collect(child)
  const exit = await waitExit(child)
  assert.equal(exit.code, 4, `a refused connect is a transport failure: ${output.stderr()}`)
  assert.equal(Buffer.concat(output.chunks).length, 0, 'no fake protocol frame is written')
  assert.match(output.stderr(), /^dsh-pi-tui acp stdio: ACP_STDIO_SOCKET_ERROR$/mu)
  assert.ok(!output.stderr().includes(dir), 'the diagnostic must not carry the private socket path')
})

test('a missing or relative socket env exits 2 with ACP_STDIO_SOCKET_INVALID', async t => {
  for (const value of [undefined, '', 'relative/acp.sock', '/tmp/bad\npath']) {
    const env: NodeJS.ProcessEnv = { ...process.env }
    delete env[SOCKET_ENV]
    if (value !== undefined) env[SOCKET_ENV] = value
    const child = spawn(process.execPath, ['--import', 'tsx/esm', ENTRY], {
      cwd: ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const exit = await waitExit(child)
    assert.equal(exit.code, 2, `invalid socket env ${JSON.stringify(value)} must be usage: ${stderr}`)
    assert.match(stderr, /^dsh-pi-tui acp stdio: ACP_STDIO_SOCKET_INVALID$/mu)
  }
})

test('a long Linux logical path connects through the scope fd short alias', { skip: process.platform !== 'linux' ? 'the fd alias is Linux-only' : false }, async t => {
  const dir = shortSocketDir(t)
  let longDir = join(dir, 'long')
  while (Buffer.byteLength(join(longDir, 'acp.sock'), 'utf8') + 1 <= 200) {
    longDir = join(longDir, 'segment')
    mkdirSync(longDir, { recursive: true, mode: 0o700 })
  }
  const dirFd = openSync(longDir, 'r')
  const server = createServer(socket => { socket.on('data', chunk => socket.write(chunk)) })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(`/proc/self/fd/${String(dirFd)}/acp.sock`, () => { server.off('error', reject); resolve() })
  })
  t.after(async () => {
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    closeSync(dirFd)
  })
  const child = spawnEntry(t, { [SOCKET_ENV]: join(longDir, 'acp.sock') })
  const output = collect(child)
  child.stdin.end('long-path-bytes')
  const exit = await waitExit(child)
  assert.equal(exit.code, 0, `the long logical path must connect through the fd alias: ${output.stderr()}`)
  assert.equal(Buffer.concat(output.chunks).toString('utf8'), 'long-path-bytes')
})

test('a paused stdout applies real pipe backpressure and drains every Host byte', async t => {
  const dir = shortSocketDir(t)
  const path = join(dir, 'acp.sock')
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x61)
  const server = createServer(socket => {
    socket.write(payload)
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve() })
  })
  t.after(() => new Promise<void>(resolve => { server.close(() => resolve()) }))
  const child = spawnEntry(t, { [SOCKET_ENV]: path })
  const chunks: Buffer[] = []
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  child.stdout.pause()
  child.stdin.end()
  await sleep(BACKPRESSURE_WINDOW_MS)
  assert.equal(child.exitCode, null, 'the child must remain blocked while the stdout pipe is not drained')
  child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
  child.stdout.resume()
  const exit = await waitExit(child, 60_000)
  assert.equal(exit.code, 0, `the drained clean Host end must exit 0: ${stderr}`)
  assert.equal(Buffer.concat(chunks).length, payload.length, 'the backpressure path must not drop bytes')
})
