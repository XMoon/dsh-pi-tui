#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/sixel-packed-verification — F6b, from the packed
 * artifact through the REAL DSH loader.
 *
 * I8-1 shipped the SIXEL codec behind a consumer-less module and the bundle
 * tree-shook it away (`dist/index.mjs` had ZERO `sixelEncode` occurrences). This
 * verification is the re-entry the I8-1 review required: it proves the PUBLISHED
 * package, installed and loaded the way a user loads it, really encodes a picture
 * and writes the bytes through the production Screen.
 *
 * It is deliberately NOT a product-lane test: that lane provisions neither a
 * packed tarball nor the `dsh` CLI, and a qualification lane must not carry a
 * skip for a capability it cannot provide. This script belongs to the artifact
 * phase (`pnpm verify:sixel-packed` against the tarball `pnpm pack` produced).
 *
 * Chain: tarball → fresh `npm install` → `dsh plugin add` into an isolated
 * DSH_HOME → the real `dsh --profile …` CLI under a PTY (`script -qec`) with the
 * terminal's own DA1 / `CSI 6;h;w t` / OSC 11 replies written to its stdin →
 * `/image <png>` typed into the real editor → the Screen's DCS, validated here
 * against the same facts the independent decoder checks in the unit suite
 * (declared raster geometry, the two-band palette, a single ST terminator).
 *
 * Usage: node scripts/sixel-packed-verification.mjs [path-to-tgz]
 *   The tarball defaults to the newest `xmoon76-dsh-pi-tui-*.tgz` in the repo root.
 * Env: SIXEL_PACKED_KEEP=1 keeps the temp install for inspection.
 * @module sixel-packed-verification
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const checks = []

/**
 * The developer's enclosing terminal must not decide this verification.
 *
 * The Direct SIXEL candidate is statically denied inside a multiplexer or on a
 * terminal the fork classifies as Kitty/iTerm2, so inheriting e.g. `ZELLIJ=0` or
 * `TERM_PROGRAM=tern` from the shell would silently turn the packed check into a
 * text-only run. The lane runner strips the same variables; this script does too,
 * and the child terminal is the scripted PTY below, not the developer's tty.
 */
const AMBIENT_TERMINAL_ENV = [
  'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'KITTY_WINDOW_ID', 'KITTY_PID', 'WEZTERM_PANE',
  'ZELLIJ', 'ZELLIJ_PANE_ID', 'ZELLIJ_SESSION_NAME', '_ZL_MATCH_MODE',
  'TMUX', 'TMUX_PANE', 'STY',
  'TERN_ACP', 'TERN_BLOB_DIR', 'TERN_COMPLETE', 'TERN_IDENTITY', 'TERN_LENSES',
  'TERN_PANE', 'TERN_PANE_SOCKET', 'TERN_WINDOW_SOCKET',
  'PI_IMAGE_PROTOCOL', 'PI_TUI_TMUX_KITTY_IMAGES', 'PI_TUI_TMUX_KITTY_PLACEHOLDERS',
]

function cleanEnvironment(extra) {
  const env = { ...process.env, ...extra }
  for (const name of AMBIENT_TERMINAL_ENV) delete env[name]
  return env
}

function check(name, ok, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

function newestTarball() {
  const explicit = process.argv[2]
  if (explicit !== undefined) return existsSync(explicit) ? resolve(explicit) : undefined
  return readdirSync(ROOT)
    .filter(name => /^xmoon76-dsh-pi-tui-.*\.tgz$/u.test(name))
    .map(name => join(ROOT, name))
    .sort()
    .at(-1)
}

function dshBinary() {
  const which = spawnSync('sh', ['-c', 'command -v dsh'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : ''
}

async function waitFor(predicate, label, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise(next => setTimeout(next, 25))
  }
}

async function main() {
  const tarball = newestTarball()
  if (tarball === undefined) {
    console.error('no xmoon76-dsh-pi-tui-*.tgz found; run `pnpm pack` first')
    process.exit(2)
  }
  const dsh = dshBinary()
  if (dsh === '') {
    console.error('the real `dsh` CLI is required for this verification (not on PATH)')
    process.exit(2)
  }
  check('the artifact exists', true, tarball)

  const root = mkdtempSync(join(tmpdir(), 'sixel-packed-'))
  const keep = process.env.SIXEL_PACKED_KEEP === '1'
  const home = join(root, 'home')
  try {
    // 1. Install the artifact as a consumer would.
    const install = spawnSync(
      'npm',
      ['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error', tarball],
      { cwd: root, encoding: 'utf8', timeout: 900_000 },
    )
    check('the tarball installs standalone', install.status === 0, (install.stderr ?? '').slice(-400))
    if (install.status !== 0) return
    const packed = join(root, 'node_modules', '@xmoon76', 'dsh-pi-tui')
    check('the installed package carries its published entry', existsSync(join(packed, 'dist', 'index.mjs')))
    check('the installed tree resolves the codec the worker require()s', existsSync(join(root, 'node_modules', 'sixel')))

    // 2. The shipped bundle really contains the codec (I8-1 tree-shook it away).
    const bundle = join(packed, 'dist', 'index.mjs')
    const bundleSource = existsSync(bundle) ? spawnSync('sh', ['-c', `grep -c sixelEncode ${JSON.stringify(bundle)} || true`], { encoding: 'utf8' }).stdout.trim() : '0'
    // The I8-1 regression was ZERO occurrences (the codec was tree-shaken away); the
    // exact count is a build detail, so this asserts presence, not a number.
    check('the shipped bundle references the codec at least once', Number(bundleSource) > 0, `sixelEncode occurrences: ${bundleSource}`)

    // 3. Load it through the real loader: an isolated profile, then the CLI.
    const profile = spawnSync(dsh, ['plugin', '--profile', 'i8-2a-packed', 'add', packed], {
      cwd: root,
      encoding: 'utf8',
      timeout: 300_000,
      env: cleanEnvironment({ DSH_HOME: home }),
    })
    check('the isolated profile accepts the packed package', profile.status === 0, (profile.stderr ?? '').slice(-400))
    if (profile.status !== 0) return

    const fixture = join(root, 'bands.png')
    const { default: sharp } = await import('sharp')
    const rgba = new Uint8Array(80 * 40 * 4)
    for (let y = 0; y < 40; y += 1) {
      for (let x = 0; x < 80; x += 1) {
        const offset = (y * 80 + x) * 4
        rgba[offset] = y < 20 ? 255 : 0
        rgba[offset + 2] = y < 20 ? 0 : 255
        rgba[offset + 3] = 255
      }
    }
    await sharp(Buffer.from(rgba), { raw: { width: 80, height: 40, channels: 4 } }).png().toFile(fixture)

    const child = spawn('script', ['-qec', `${dsh} --profile i8-2a-packed`, '/dev/null'], {
      cwd: root,
      env: cleanEnvironment({ DSH_HOME: home, TERM: 'xterm-256color' }),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let output = ''
    const answered = new Set()
    const reply = (marker, data) => {
      if (answered.has(marker)) return
      answered.add(marker)
      child.stdin.write(data)
    }
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      if (output.includes('\x1b[16t')) reply('cell', '\x1b[6;20;10t')
      if (output.includes('\x1b]11;?')) reply('bg', '\x1b]11;rgb:2828/2c2c/3434\x07')
      if (output.includes('\x1b[c')) reply('da1', '\x1b[?61;4;6;7;14;21;22;23;24;28;32;42;52c')
    })
    child.stderr.on('data', () => {})
    try {
      await waitFor(() => output.includes('\x1b[16t'), 'the packed CLI to paint and query the terminal')
      child.stdin.write(`/image ${fixture}\r`)
      await waitFor(() => output.includes('\x1bP0;'), 'the packed consumer to encode and paint')
      const start = output.lastIndexOf('\x1bP')
      const end = output.indexOf('\x1b\\', start)
      const dcs = output.slice(start, end + 2)
      check('the Screen wrote one complete DCS', dcs.startsWith('\x1bP') && dcs.endsWith('\x1b\\'))
      check('the DCS declares the scaled two-band raster', dcs.includes('"1;1;80;36'), dcs.slice(0, 40))
      check('the exact palette carries both bands', dcs.includes('#0;2;100;0;0') && dcs.includes('#1;2;0;0;100'))
      check('no Kitty APC is emitted', output.includes('\x1b_G') === false)
    } finally {
      child.kill('SIGTERM')
    }
  } finally {
    if (!keep) rmSync(root, { recursive: true, force: true })
    else console.log(`[keep] ${root}`)
  }
}

await main()
for (const line of checks) console.log(line)
console.log(`\nsixel packed verification: ${failures.length === 0 ? 'PASS' : `FAILED (${failures.length})`}`)
process.exit(failures.length === 0 ? 0 : 1)
