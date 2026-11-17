/**
 * The `script(1)` PTY argv contract AND the real-PTY behaviour both split
 * smoke drivers depend on.
 *
 * The argv cases are structural (every platform can reason about the plan);
 * the PTY cases run the CURRENT platform's system `script(1)` for real: a
 * child sees `stdin.isTTY === stdout.isTTY === true`, keyboard bytes arrive,
 * the exit status propagates (0 and non-zero), and `script` itself settles
 * when the command ends.
 *
 * @module @xmoon76/dsh-pi-tui/tooling/pty-script.test
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { testLifecycle } from '../support/temp-lifecycle.ts'
import { currentPtyScriptArgv, ptyScriptArgv } from '../../scripts/lib/pty-script.mjs'

const POSIX_ONLY = process.platform === 'win32' ? 'system script(1) is POSIX-only' : false

/**
 * Spawn the current platform's system script and collect its streams.
 *
 * STDIN. Darwin's system `script(1)` aborts on a socketpair or FIFO stdin
 * (`tcgetattr/ioctl: Operation not supported on socket`), which is exactly
 * what a Node `stdio: 'pipe'` child gets. The PTY input path therefore uses a
 * regular FILE descriptor: either `/dev/null` (no keystrokes) or a pre-written
 * keystroke file that `script` copies into its own PTY. The bytes still travel
 * through the real PTY; only their source is a file instead of a live socket.
 * Streaming input from a non-TTY parent on Darwin is a split-smoke (PR-2/3)
 * obligation, not something `script` itself accepts.
 */
function spawnPty(t, command, { inputBytes } = {}) {
  const life = testLifecycle(t)
  let stdinPath = '/dev/null'
  if (inputBytes !== undefined) {
    stdinPath = join(life.tempDir('pty-input-'), 'keystrokes.bin')
    writeFileSync(stdinPath, inputBytes)
  }
  const plan = currentPtyScriptArgv(command)
  const stdin = openSync(stdinPath, 'r')
  const child = spawn(plan.program, plan.args, { stdio: [stdin, 'pipe', 'pipe'] })
  closeSync(stdin)
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  return { child, exit, output: () => out }
}

test('linux spells the GNU form: -qefc <command> /dev/null', () => {
  assert.deepEqual(ptyScriptArgv('linux', "node -e 'x'"), { program: 'script', args: ['-qefc', "node -e 'x'", '/dev/null'] })
})

test('darwin spells the BSD form: -qF /dev/null /bin/sh -c <command>', () => {
  assert.deepEqual(ptyScriptArgv('darwin', "node -e 'x'"), { program: 'script', args: ['-qF', '/dev/null', '/bin/sh', '-c', "node -e 'x'"] })
})

test('the command string is passed through verbatim: no re-splitting, no re-quoting', () => {
  const tricky = `node -e 'process.stdout.write("a b")'`
  for (const platform of ['linux', 'darwin']) {
    const plan = ptyScriptArgv(platform, tricky)
    const command = platform === 'linux' ? plan.args[1] : plan.args[4]
    assert.equal(command, tricky)
  }
})

test('an empty command is refused, and win32 is explicitly unsupported (never a fake PTY)', () => {
  assert.throws(() => ptyScriptArgv('linux', ''), /command string is required/u)
  assert.throws(() => ptyScriptArgv('linux', undefined), /command string is required/u)
  const plan = ptyScriptArgv('win32', 'x')
  assert.equal(plan.program, undefined)
  assert.match(plan.unsupported, /not supported on win32/u)
})

test('a real script(1) child sees a TTY on stdin and stdout', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { exit, output } = spawnPty(t, `node -e 'process.stdout.write(String(process.stdin.isTTY) + "/" + String(process.stdout.isTTY))'`)
  assert.equal((await exit).code, 0)
  assert.match(output(), /true\/true/u, `stdin/stdout must be real TTYs, saw: ${JSON.stringify(output())}`)
})

test('keyboard bytes reach the child through the real PTY', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  // Raw mode stops the PTY line discipline from translating the bytes. The
  // child waits for ESC (1b) and A (41) and reports the raw hex it received.
  const script = `node -e 'process.stdout.write("TTY:" + String(process.stdin.isTTY) + " "); process.stdin.setRawMode(true); let seen = ""; process.stdin.on("data", c => { seen += c.toString("hex"); if (seen.includes("1b41")) { process.stdout.write("GOT:" + seen); process.exit(0) } }); setTimeout(() => process.exit(9), 8000)'`
  const { exit, output } = spawnPty(t, script, { inputBytes: Buffer.from([0x1b, 0x41]) })
  const result = await exit
  assert.equal(result.code, 0, `the PTY child must see the keyboard bytes: ${JSON.stringify(output())}`)
  assert.match(output(), /TTY:true/u, `the command's stdin must be the PTY, saw: ${JSON.stringify(output())}`)
  assert.match(output(), /GOT:.*1b41/u, `ESC and A must arrive through the PTY, saw: ${JSON.stringify(output())}`)
})

test('a non-zero child exit propagates through script(1)', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { exit } = spawnPty(t, 'node -e "process.exit(7)"')
  assert.equal((await exit).code, 7, 'the PTY wrapper must not swallow the child exit status')
})

test('script(1) settles when the command ends (no leftover wrapper)', { skip: POSIX_ONLY, timeout: 30_000 }, async (t) => {
  const { child, exit } = spawnPty(t, `node -e 'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 100)"]); c.on("exit", () => process.exit(0))'`)
  const result = await exit
  assert.equal(result.code, 0)
  // The wrapper exited with the command: it must not keep its own event loop
  // or a PTY session alive after the command ends.
  assert.notEqual(child.exitCode, null)
})
