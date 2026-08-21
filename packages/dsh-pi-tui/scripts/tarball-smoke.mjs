#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/tarball-smoke — verify a packed
 * `@xmoon76/dsh-pi-tui` tarball end to end, so a fresh checkout can never
 * publish a broken or leaky artifact:
 *
 *   1. structure — every `exports` file exists, config + cordis.patch.yml +
 *      repair scripts are included, nothing else leaks in (no test fixtures,
 *      no backups, no nested tarballs, no absolute paths);
 *   2. content — no workspace absolute paths anywhere, and the bundle does
 *      NOT import `@xmoon76/pi-tui` externally (it is bundled);
 *   3. parse — every `.mjs` passes `node --check`; every `.d.mts` parses via
 *      the TypeScript compiler when available;
 *   4. install — the tarball installs standalone (`npm install --omit=dev`
 *      in a fresh temp project), both `exports` entries import, and
 *      `@xmoon76/pi-tui` is NOT resolvable from the installed package;
 *   5. repair CLI — `--help` works and a read-only `--scan` over fixture
 *      sessions reports the damaged one and touches nothing.
 *
 * Usage: node scripts/tarball-smoke.mjs [path-to-tgz]
 * The tarball path defaults to the newest `xmoon76-dsh-pi-tui-*.tgz` in
 * the current directory (the `pnpm pack` / `npm pack` output location;
 * npm/pnpm strip the `@` scope from tarball filenames).
 *
 * Env: TARBALL_SMOKE_SKIP_INSTALL=1 skips the npm install step (offline
 * dev runs); TARBALL_SMOKE_KEEP=1 keeps the temp dirs for inspection.
 * @module tarball-smoke
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { zstdCompressSync } from 'node:zlib'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
/** The dsh-pi-tui package root (the workspace checkout). */
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')

const failures = []
const checks = []

/** Record a passing check or a hard failure (failures exit non-zero at the end). */
function check(name, ok, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

/** Resolve the tarball: explicit arg, else the newest matching tgz in the
 * current directory or its parent (pnpm workspace packs may land either
 * place depending on how the lifecycle was invoked). */
function resolveTarball(explicit) {
  if (explicit !== undefined) {
    // Absolutize BEFORE any subprocess uses it: `npm install` below runs
    // with cwd=probeDir, so a caller-relative path (e.g. the CI artifact
    // download `tarball/xmoon76-*.tgz`) would resolve against the temp
    // probe and fail with ENOENT.
    const absolute = resolve(explicit)
    if (!existsSync(absolute)) throw new Error(`tarball not found: ${explicit}`)
    return absolute
  }
  // npm/pnpm strip the `@` scope from tarball filenames, so the glob is
  // `xmoon76-dsh-pi-tui-*.tgz` even though the package is @xmoon76/dsh-pi-tui.
  const candidates = [process.cwd(), join(process.cwd(), '..')]
    .flatMap(dir => {
      try {
        return readdirSync(dir).map(name => join(dir, name))
      } catch {
        return []
      }
    })
    .filter(path => /xmoon76-dsh-pi-tui-.*\.tgz$/.test(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (candidates.length === 0) throw new Error(`no xmoon76-dsh-pi-tui-*.tgz in the current directory (${process.cwd()}) or its parent (${join(process.cwd(), '..')}); pass the tarball path`)
  return candidates[0]
}

/** Extract an npm tarball; returns the `package/` directory. */
function extract(tarball, workDir) {
  const result = run('tar', ['-xzf', tarball, '-C', workDir])
  if (result.status !== 0) throw new Error(`tar extraction failed: ${result.stderr}`)
  const extracted = join(workDir, 'package')
  if (!existsSync(extracted)) throw new Error('tarball has no package/ root (not an npm tarball?)')
  return extracted
}

/** Walk a directory tree, returning relative file paths. */
function walkFiles(root) {
  const out = []
  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) walk(join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out
}

/** Load the TypeScript compiler for parse-only validation, when available. */
function loadTypescript() {
  try {
    return createRequire(join(PACKAGE_ROOT, 'package.json'))('typescript')
  } catch {
    return undefined
  }
}

/** Parse-only check of a .d.mts file: no resolution, syntax errors only. */
function dtsParses(ts, file) {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  return source.parseDiagnostics.length === 0
    ? { ok: true }
    : { ok: false, detail: source.parseDiagnostics[0].messageText }
}

function main() {
  const tarball = resolveTarball(process.argv[2])
  const keep = process.env.TARBALL_SMOKE_KEEP === '1'
  const skipInstall = process.env.TARBALL_SMOKE_SKIP_INSTALL === '1'
  const workDir = mkdtempSync(join(tmpdir(), 'tarball-smoke-'))
  const probeDir = join(workDir, 'probe')
  try {
    check('tarball exists', existsSync(tarball), basename(tarball))
    const extracted = extract(tarball, workDir)
    const pkg = JSON.parse(readFileSync(join(extracted, 'package.json'), 'utf8'))
    check('package name', pkg.name === '@xmoon76/dsh-pi-tui', pkg.name)
    check('published package is not private', pkg.private !== true, `private=${String(pkg.private)}`)

    // --- structure ---
    const files = walkFiles(extracted)
    const has = (path) => files.includes(path)
    check('exports entry dist/extension/advanced.mjs', has('dist/extension/advanced.mjs'))
    check('exports entry dist/extension/unstable.mjs', has('dist/extension/unstable.mjs'))
    check('types dist/extension/advanced.d.mts', has('dist/extension/advanced.d.mts'))
    check('types dist/extension/unstable.d.mts', has('dist/extension/unstable.d.mts'))
    check('exports entry dist/builtins.mjs', has('dist/builtins.mjs'))
    check('types dist/builtins.d.mts', has('dist/builtins.d.mts'))
    check('cordis.patch.yml included', has('cordis.patch.yml'))
    check('config/ included', files.some(name => name.startsWith('config/')))
    check('repair-session.mjs included', has('scripts/repair-session.mjs'))
    check('repair-core.mjs included', has('scripts/repair-core.mjs'))
    check('README included', has('README.md'))
    const leaks = files.filter(name => name.includes('test/')
      || name.endsWith('.bak')
      || name.endsWith('.tgz')
      || /^\//.test(name)
      || name.includes('..'))
    check('no test fixtures / backups / nested tarballs / absolute paths', leaks.length === 0,
      leaks.length === 0 ? '' : leaks.join(', '))

    // --- content ---
    const textFiles = files
      .filter(name => /\.(mjs|ts|yml|yaml|json|md)$/.test(name))
      .map(name => join(extracted, name))
    // Leak detection is DYNAMIC, not tied to this machine: the runtime-
    // resolved repo/package/dist roots (realpath) catch THIS checkout's
    // absolute paths on any machine, and the generic patterns catch the
    // common absolute-path shapes (Unix home, macOS Users, CI workspaces,
    // Windows drives) everywhere. The smoke script itself is exempt from
    // the generic patterns: its source deliberately assembles the old
    // /home/xmoon/ marker at runtime (the literal would otherwise trip the
    // check on its own file). The dynamic-root checks still apply to it.
    const repoRoot = realpathSync(join(SCRIPT_DIR, '..', '..', '..'))
    const packageRoot = realpathSync(PACKAGE_ROOT)
    // The bundle dist may be absent (a smoke run on a raw checkout); the
    // structure checks below already fail loudly for that, so never crash
    // here — realpathSync on a missing dir would throw ENOENT and turn the
    // failure into a bare `tarball-smoke: ...` stderr line.
    const distRoot = join(PACKAGE_ROOT, 'dist')
    const leakRoots = [...new Set([
      repoRoot,
      packageRoot,
      ...(existsSync(distRoot) ? [realpathSync(distRoot)] : []),
    ])]
    const absolutePathPatterns = [
      /\/home\/[^/"']+/,
      /\/Users\/[^/"']+/,
      /\/home\/runner\/work\//,
      /[A-Za-z]:\\(?:[^\\"']*\\)+/,
    ]
    const workspaceLeaks = textFiles.filter(file => {
      const text = readFileSync(file, 'utf8')
      if (leakRoots.some(root => root.length > 1 && text.includes(root))) return true
      if (basename(file) === 'tarball-smoke.mjs') return false
      return absolutePathPatterns.some(pattern => pattern.test(text))
    })
    check('no workspace absolute paths in packaged files', workspaceLeaks.length === 0,
      workspaceLeaks.length === 0 ? '' : workspaceLeaks.join(', '))
    const dist = files.filter(name => name.startsWith('dist/') && name.endsWith('.mjs'))
      .map(name => readFileSync(join(extracted, name), 'utf8'))
    const externalFork = dist.filter(text => /from\s*["']@xmoon76\/pi-tui["']/.test(text) || /require\(\s*["']@xmoon76\/pi-tui["']/.test(text))
    check('bundle does not import @xmoon76/pi-tui externally', externalFork.length === 0,
      externalFork.length === 0 ? '' : `${externalFork.length} file(s) still import the fork`)

    // --- parse ---
    const mjsFiles = files.filter(name => /\.mjs$/.test(name)).map(name => join(extracted, name))
    const badMjs = mjsFiles.filter(file => run(process.execPath, ['--check', file]).status !== 0)
    check('every .mjs parses (node --check)', badMjs.length === 0,
      badMjs.length === 0 ? '' : badMjs.join(', '))
    const ts = loadTypescript()
    const dtsFiles = files.filter(name => /\.d\.mts$/.test(name)).map(name => join(extracted, name))
    if (ts !== undefined) {
      const badDts = dtsFiles.filter(file => !dtsParses(ts, file).ok)
      check('every .d.mts parses (typescript)', badDts.length === 0,
        badDts.length === 0 ? '' : badDts.join(', '))
    } else {
      checks.push(`skip .d.mts parse — typescript unavailable`)
    }

    // --- public .d.mts leak gate (M3/E, round-1/2 review): the shipped
    // declarations must not reference the vendored fork, TuiApp, private
    // screens, or repository source paths. tsdown INLINES types into the
    // .d.mts with `//#region <path>` markers; a fork leak shows up as a
    // region pointing OUTSIDE the package's own src/ (`../pi-tui/...`,
    // `node_modules/@xmoon76/pi-tui/...`) or as fork module names
    // (`src/tui-main-screen.d.ts`), often inside an auto-generated SHARED
    // CHUNK that the SDK entries only re-export. The gate therefore:
    //   (a) scans EVERY dist/*.d.mts (entries AND chunks);
    //   (b) treats any region marker whose path is not this package's own
    //       src/ as a leak (allowlist by construction);
    //   (c) bans fork imports and fork module names anywhere;
    //   (d) bans the bare private identifiers (TuiMainScreen/TuiAltScreen/
    //       TuiApp) line-scoped over every file, skipping comment lines.
    const dtsAll = files.filter(name => name.startsWith('dist/') && name.endsWith('.d.mts'))
    const sdkIdentifiers = [/\bTuiMainScreen\b/, /\bTuiAltScreen\b/, /\bTuiApp\b/]
    const dtsLeaks = []
    for (const name of dtsAll) {
      const text = readFileSync(join(extracted, name), 'utf8')
      const lines = text.split('\n')
      // (b) region markers: allow only `//#region src/<public module>.d.ts`.
      // The ROOT entry (dist/index.d.mts) is the runner's own surface: it
      // legitimately inlines the TuiApp implementation (src/tui-app.d.ts)
      // for the Loader row — it is NOT a third-party SDK entry. Its region
      // is exempted; everything else (chunks, extensions, builtins) must
      // name only the public modules below.
      const isRoot = name === 'dist/index.d.mts'
      for (const line of lines) {
        const match = /\/\/#region\s+(\S+)/.exec(line)
        if (match) {
          const regionPath = match[1]
          const allowed = /^src\/(builtins|commands|diag|extension\/advanced|extension\/advanced-types|extension\/public-types|extension\/service|extension\/slot-map|extension\/unstable|extension\/unstable-types|extensions|index|skill-catalog|startup|surface-catalog)\.d\.ts$/.test(regionPath)
          const rootAllowed = isRoot && /^src\/tui-app\.d\.ts$/.test(regionPath)
          if (!allowed && !rootAllowed) dtsLeaks.push(`${name}: region ${regionPath}`)
        }
      }
      // (c) fork imports and fork module names anywhere.
      if (/from\s*["']@xmoon76\/pi-tui["']/.test(text)) dtsLeaks.push(`${name}: fork import`)
      if (/packages\/pi-tui/.test(text)) dtsLeaks.push(`${name}: packages/pi-tui path`)
      if (/\b(tui-main-screen|tui-alt-screen)\.d\.ts\b/.test(text)) dtsLeaks.push(`${name}: fork screen module`)
      // (d) bare private identifiers, line-scoped (comments skipped). No
      // exemption: the clean dist has zero TuiApp identifiers anywhere
      // (round-3 finding 1 — the old root exemption was dead code).
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue
        for (const pattern of sdkIdentifiers) {
          if (pattern.test(trimmed)) dtsLeaks.push(`${name}: bare ${pattern}`)
        }
      }
    }
    check('every public .d.mts leaks no private pi-tui / internal paths', dtsLeaks.length === 0,
      dtsLeaks.length === 0 ? '' : dtsLeaks.join('; '))
    // The .mjs bodies must not import the fork externally either (it is
    // bundled) — the existing dist check below covers every .mjs.

    // --- install + runtime ---
    if (skipInstall) {
      checks.push('skip npm install (TARBALL_SMOKE_SKIP_INSTALL=1)')
    } else {
      mkdirSync(probeDir)
      writeFileSync(join(probeDir, 'package.json'), JSON.stringify({ name: 'tarball-smoke-probe', private: true }))
      const install = run('npm', [
        'install', '--omit=dev', '--no-save',
        '--cache', join(workDir, 'npm-cache'),
        tarball,
      ], { cwd: probeDir, timeout: 180_000 })
      check('tarball installs standalone (npm install --omit=dev)', install.status === 0,
        install.status === 0 ? '' : (install.stderr.split('\n').slice(-3).join(' ')))
      if (install.status === 0) {
        const installed = join(probeDir, 'node_modules', '@xmoon76', 'dsh-pi-tui')
        check('installed package contains dist', existsSync(join(installed, 'dist', 'index.mjs')))
        const importRun = run(process.execPath, ['--input-type=module', '-e',
          "Promise.all([import('@xmoon76/dsh-pi-tui'), import('@xmoon76/dsh-pi-tui/startup'),"
            + "import('@xmoon76/dsh-pi-tui/extensions'), import('@xmoon76/dsh-pi-tui/builtins'),"
            + "import('@xmoon76/dsh-pi-tui/extensions/advanced'), import('@xmoon76/dsh-pi-tui/extensions/unstable')])"
            + ".then(m => { if (m[4].ADVANCED_API_LEVEL !== 1) throw new Error('ADVANCED_API_LEVEL');"
            + "if (m[5].UNSTABLE_API_LEVEL !== 1) throw new Error('UNSTABLE_API_LEVEL'); console.log('imports-ok') })"
            + ".catch(e => { console.error(e.message); process.exit(1) })",
        ], { cwd: probeDir })
        check('all exports entries import', importRun.status === 0 && importRun.stdout.includes('imports-ok'),
          importRun.status === 0 ? '' : importRun.stderr.slice(0, 200))
        const forkRun = run(process.execPath, ['--input-type=module', '-e',
          "import('@xmoon76/pi-tui').then(() => process.exit(0)).catch(() => process.exit(3))",
        ], { cwd: probeDir })
        check('@xmoon76/pi-tui is not resolvable from the installed package (self-contained)',
          forkRun.status === 3, `status=${forkRun.status}`)
      }

      // --- repair CLI from the installed package ---
      const cli = join(probeDir, 'node_modules', '@xmoon76', 'dsh-pi-tui', 'scripts', 'repair-session.mjs')
      if (existsSync(cli)) {
        const help = run(process.execPath, [cli, '--help'])
        check('installed repair CLI shows help', help.status === 0 && help.stdout.includes('usage:'),
          help.status === 0 ? '' : help.stderr.slice(0, 200))
        // A read-only scan over fixtures: healthy + torn sessions. The CLI
        // needs a dsh stub whose node_modules resolves @deepseek-ai/dsh-session
        // (npm installed the peer deps into the probe).
        const dshSession = join(probeDir, 'node_modules', '@deepseek-ai', 'dsh-session')
        if (existsSync(dshSession)) {
          const home = join(workDir, 'home')
          const stub = join(workDir, 'dsh-stub')
          const torn = join(home, 'sessions', 'proj', 'torn-session')
          const healthy = join(home, 'sessions', 'proj', 'ok-session')
          mkdirSync(join(stub, 'node_modules', '@deepseek-ai'), { recursive: true })
          writeFileSync(join(stub, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.0.0' }))
          symlinkSync(dshSession, join(stub, 'node_modules', '@deepseek-ai', 'dsh-session'), 'dir')
          mkdirSync(torn, { recursive: true })
          mkdirSync(healthy, { recursive: true })
          const HEADER = JSON.stringify({
            type: 'session', version: 0, id: 'torn-session', createdAt: 1,
            cwd: '/work', delegationDepth: 0, agentPreset: 'standard',
          })
          const text = [HEADER,
            JSON.stringify({ type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } }),
            JSON.stringify({ type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } }),
          ].join('\n')
          writeFileSync(join(healthy, 'session.jsonl'), `${text}\n`)
          // A torn zstd artifact: complete frames + a truncated frame tail.
          const full = Buffer.concat([
            zstdCompressSync(Buffer.from(`${HEADER}\n`, 'utf8')),
            zstdCompressSync(Buffer.from(`${text.slice(HEADER.length + 1)}\n`, 'utf8')),
            zstdCompressSync(Buffer.from('{"type":"user/message","seq":2,"time":3,"data":{"content":[{"type":"text","text":"lost"}],"source":{"kind":"user"}}}\n', 'utf8')),
          ])
          writeFileSync(join(torn, 'session.jsonl.zstd'), full.subarray(0, full.length - 9))
          const scan = run(process.execPath, [cli, '--scan', '--dsh-dir', stub, '--dsh-home', home])
          check('installed repair CLI --scan reports the torn session and ignores the healthy one',
            scan.status === 1 && scan.stdout.includes('torn-session') && !scan.stdout.includes('ok-session'),
            `status=${scan.status} stdout=${scan.stdout.trim().slice(0, 200)}`)
          const before = readFileSync(join(torn, 'session.jsonl.zstd'))
          const dry = run(process.execPath, [cli, 'torn-session', '--dsh-dir', stub, '--dsh-home', home])
          const after = readFileSync(join(torn, 'session.jsonl.zstd'))
          check('installed repair CLI dry run is read-only', dry.status === 1 && before.equals(after),
            `status=${dry.status} ${dry.stdout.trim().slice(0, 120)}`)
        } else {
          checks.push('skip repair CLI scan — peer deps not installed in probe')
        }
      }
    }
  } finally {
    if (!keep) rmSync(workDir, { recursive: true, force: true })
  }

  for (const line of checks) console.log(line)
  if (failures.length > 0) {
    console.error(`\ntarball smoke FAILED (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\ntarball smoke passed')
}

try {
  await main()
} catch (error) {
  console.error(`tarball-smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
