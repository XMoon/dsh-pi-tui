/**
 * Image-8 / I8-2A — F6b: the PACKED publish entry really reaches the codec.
 *
 * I8-1 shipped the codec behind a consumer-less module and the bundle
 * tree-shook it away: `dist/index.mjs` contained ZERO `sixelEncode`
 * occurrences. F6a proved the packed dependency and the worker/CJS encode in
 * isolation, and the Owner deferred F6b to the first real production consumer
 * with mandatory re-entry here. This file is that re-entry.
 *
 * What runs, and why it is the REAL entry:
 *
 * - the artifact is the tarball `pnpm pack` produced for this commit;
 * - it is INSTALLED as a consumer would install it (`npm install <tgz>`) and
 *   then installed into an isolated DSH profile through `dsh plugin add`;
 * - the child is the real `dsh --profile …` CLI under a PTY (`script -qec`), so
 *   the plugin loader calls the package's own `apply()` and the product's
 *   `startProcessTui()` creates the app — no source-tree import, no test-only
 *   consumer entry, no public export added for the test;
 * - the terminal replies (primary DA1 with attribute 4, `CSI 6;20;10t`,
 *   OSC 11) are written into the app's stdin exactly like a real tty's, and the
 *   draft card is reached by typing the image command into the real editor;
 * - the DCS the app's Screen actually wrote is decoded with the independent
 *   oracle.
 *
 * A missing tarball SKIPS (the product lane runs before `pnpm pack` exists).
 * `SIXEL_PACKAGED_PATH_REQUIRED=1` turns that skip into a hard failure, which is
 * how the stage's evidence run is executed.
 * @module @xmoon76/dsh-pi-tui/integration/sixel-packaged-path.test
 */

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { decodeSixel, pixelAt } from '../support/sixel-oracle.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

const PACKAGE_ROOT = resolve(import.meta.dirname, '..', '..')

/** The newest `xmoon76-dsh-pi-tui-*.tgz` in the repository root, if any. */
function packedTarball(): string | undefined {
  const explicit = process.env.SIXEL_PACKED_TARBALL
  if (explicit !== undefined && explicit !== '') return existsSync(explicit) ? explicit : undefined
  return readdirSync(PACKAGE_ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(PACKAGE_ROOT, name))
    .sort()
    .at(-1)
}

/** The `dsh` that is on PATH, or undefined when this host has none. */
function dshBinary(): string | undefined {
  const which = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  const path = which.status === 0 ? which.stdout.trim() : ''
  return path === '' ? undefined : path
}

interface Session {
  readonly output: () => string
  write(data: string): void
  stop(): void
}

/**
 * Run the installed CLI under a PTY and answer its terminal queries.
 *
 * `script -qec` is the POSIX way to give a child a real tty; its stdin forwards
 * to the child and its stdout carries the child's output, so the app sees the
 * replies a terminal would send and the test sees what the app painted.
 */
function startPackedSession(dsh: string, home: string, profile: string, cwd: string): Session {
  const child = spawn('script', ['-qec', `${dsh} --profile ${profile}`, '/dev/null'], {
    cwd,
    env: { ...process.env, DSH_HOME: home, TERM: 'xterm-256color' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let output = ''
  const answered = new Set<string>()
  const reply = (marker: string, data: string): void => {
    if (answered.has(marker)) return
    answered.add(marker)
    child.stdin.write(data)
  }
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString('utf8')
    if (output.includes('\x1b[16t')) reply('cell', '\x1b[6;20;10t')
    if (output.includes('\x1b]11;?')) reply('bg', '\x1b]11;rgb:2828/2c2c/3434\x07')
    if (output.includes('\x1b[c')) reply('da1', '\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c')
  })
  child.stderr.on('data', () => {})
  return {
    output: () => output,
    write: (data: string) => {
      child.stdin.write(data)
    },
    stop: () => {
      child.kill('SIGTERM')
    },
  }
}

async function until(predicate: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`)
    // reason: the CLI paints on its own frame timer and exposes no frame hook to
    // this harness; every call site below still waits for an authoritative byte.
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** One real two-band PNG (80x40: red over blue) written to `path`. */
async function writeFixture(path: string): Promise<void> {
  const { default: sharp } = await import('sharp')
  const rgba = new Uint8Array(80 * 40 * 4)
  for (let y = 0; y < 40; y += 1) {
    for (let x = 0; x < 80; x += 1) {
      const offset = (y * 80 + x) * 4
      rgba[offset] = y < 20 ? 255 : 0
      rgba[offset + 1] = 0
      rgba[offset + 2] = y < 20 ? 0 : 255
      rgba[offset + 3] = 255
    }
  }
  await sharp(Buffer.from(rgba), { raw: { width: 80, height: 40, channels: 4 } }).png().toFile(path)
}

test('the PACKED publish entry paints a draft card through the real SIXEL chain (F6b)', async (t) => {
  const tarball = packedTarball()
  if (tarball === undefined) {
    if (process.env.SIXEL_PACKAGED_PATH_REQUIRED === '1') {
      assert.fail('SIXEL_PACKAGED_PATH_REQUIRED=1 but no xmoon76-dsh-pi-tui-*.tgz exists; run `pnpm pack` first')
    }
    t.skip('no packed tarball in the repository root (run `pnpm pack` to exercise F6b)')
    return
  }
  const dsh = dshBinary()
  assert.ok(dsh !== undefined, 'F6b needs the real `dsh` CLI to load the packed plugin')

  const root = testLifecycle(t).tempDir('sixel-packed-')
  const home = join(root, 'home')
  // 1. Install the ARTIFACT as a consumer would.
  const install = spawnSync(
    'npm',
    ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', tarball],
    { cwd: root, encoding: 'utf8', timeout: 900_000 },
  )
  assert.equal(install.status, 0, `the tarball must install standalone:\n${install.stdout}\n${install.stderr}`)
  const packed = join(root, 'node_modules', '@xmoon76', 'dsh-pi-tui')
  assert.ok(existsSync(join(packed, 'dist', 'index.mjs')), 'the installed package carries its published entry')
  assert.ok(existsSync(join(root, 'node_modules', 'sixel')), 'the installed tree resolves the codec the worker require()s')

  // 2. Install the INSTALLED package into an isolated DSH profile: the loader
  //    the product uses then imports exactly these files.
  const profile = spawnSync(dsh!, ['plugin', '--profile', 'i8-2a-packed', 'add', packed], {
    cwd: root,
    encoding: 'utf8',
    timeout: 300_000,
    env: { ...process.env, DSH_HOME: home },
  })
  assert.equal(
    profile.status,
    0,
    `the isolated profile must accept the packed package:\n${profile.stdout}\n${profile.stderr}`,
  )

  const fixture = join(root, 'bands.png')
  await writeFixture(fixture)
  const session = startPackedSession(dsh!, home, 'i8-2a-packed', root)
  t.after(() => session.stop())

  // 3. The real app boots, answers the terminal, and accepts the image command.
  await until(() => session.output().includes('\x1b[16t'), 'the packed CLI to paint and query the terminal')
  session.write(`/image ${fixture}\r`)

  // 4. The Screen must write ONE complete DCS for the draft card.
  await until(() => session.output().includes('\x1bP0;'), 'the packed consumer to encode and paint')
  const wire = session.output()
  const start = wire.lastIndexOf('\x1bP')
  const end = wire.indexOf('\x1b\\', start)
  const dcs = wire.slice(start, end + 2)
  assert.ok(dcs.startsWith('\x1bP') && dcs.endsWith('\x1b\\'), 'the painted bytes are one complete DCS')
  assert.equal(wire.includes('\x1b_G'), false, 'no Kitty APC is emitted')

  const decoded = decodeSixel(dcs)
  assert.equal(decoded.width, 80, 'the real source width reached the packed encoder')
  assert.ok(decoded.height > 0 && decoded.height % 6 === 0, 'a whole number of SIXEL bands')
  const [topR, , topB] = pixelAt(decoded, 4, 4)
  assert.ok(topR > 180 && topB < 80, `the top band is red, got ${topR},${topB}`)
  const [, , bottomBlue] = pixelAt(decoded, 4, decoded.height - 8)
  assert.ok(bottomBlue > 180, 'the bottom band is blue')
})
