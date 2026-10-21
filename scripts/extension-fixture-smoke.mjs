#!/usr/bin/env node
/**
 * extension-fixture-smoke — verify the PACKED extension surface end to end
 * with a real third-party-shaped plugin (plan §16 M3 packed fixture):
 *
 *   1. the fixture typechecks against the packed `@xmoon76/dsh-pi-tui`
 *      tarball's `./extensions` subpath (its `.d.mts`);
 *   2. the fixture's runtime import resolves ONLY the packed bytes (the
 *      tarball, not the workspace source);
 *   3. the fixture registers through the public service API and its module
 *      shape (name/inject/apply) matches what the Loader mounts;
 *   4. the fixture's node_modules contains NO `@deepseek-ai` entry (no
 *      duplicate dsh runtime — peer deps resolve from the host install).
 *
 * Usage: node scripts/extension-fixture-smoke.mjs [path-to-tgz]
 * The tarball path defaults to the newest `xmoon76-dsh-pi-tui-*.tgz` in the
 * package directory (the `pnpm pack:release` output location).
 * @module extension-fixture-smoke
 */

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'extension-plugin')

const failures = []
const checks = []

function check(name, ok, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

function resolveTarball(explicit) {
  if (explicit !== undefined) {
    const absolute = resolve(explicit)
    if (!existsSync(absolute)) throw new Error(`tarball not found: ${explicit}`)
    return absolute
  }
  const dir = PACKAGE_ROOT
  const candidates = readdirSync(dir)
    .filter(name => /xmoon76-dsh-pi-tui-.*\.tgz$/.test(name))
    .map(name => join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  if (candidates.length === 0) {
    throw new Error(`no xmoon76-dsh-pi-tui-*.tgz in ${dir}; run pnpm pack:release first`)
  }
  return candidates[0]
}

function main() {
  const tarball = resolveTarball(process.argv[2])
  const workDir = mkdtempSync(join(tmpdir(), 'extension-fixture-'))
  try {
    // 1. Extract the packed package.
    const extractedDir = join(workDir, 'pkg')
    mkdirSync(extractedDir)
    const extract = run('tar', ['-xzf', tarball, '-C', extractedDir])
    check('tarball extracts', extract.status === 0, extract.stderr)
    const pkgDir = join(extractedDir, 'package')
    check('packed package has dist/extensions.mjs', existsSync(join(pkgDir, 'dist', 'extensions.mjs')))
    check('packed package has dist/extensions.d.mts', existsSync(join(pkgDir, 'dist', 'extensions.d.mts')))

    // 2. Fixture workspace: node_modules/@xmoon76/dsh-pi-tui -> packed pkg.
    const fixtureDir = join(workDir, 'fixture')
    mkdirSync(join(fixtureDir, 'node_modules', '@xmoon76'), { recursive: true })
    symlinkSync(pkgDir, join(fixtureDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), 'dir')
    // Peer deps (cordis, commander, @deepseek-ai/*) resolve from the host
    // install in a real deployment. ESM resolution walks UP from the
    // importing file, so the deps must sit in the PACKED package's own
    // node_modules (a fixture-level node_modules would never be reached);
    // the smoke mirrors the host install by symlinking the main package's
    // modules there. The packed tarball itself carries NO node_modules
    // (check 6 asserts that) — this is the smoke fixture's own scaffolding.
    // The fixture's own source also imports @deepseek-ai/cordis (the peer
    // Context type), so the fixture tree sees the same host modules.
    const hostModules = join(PACKAGE_ROOT, 'node_modules')
    mkdirSync(join(pkgDir, 'node_modules'), { recursive: true })
    for (const entry of readdirSync(hostModules)) {
      const target = join(pkgDir, 'node_modules', entry)
      if (existsSync(target)) continue
      symlinkSync(join(hostModules, entry), target, 'dir')
      const fixtureTarget = join(fixtureDir, 'node_modules', entry)
      if (!existsSync(fixtureTarget)) {
        symlinkSync(join(hostModules, entry), fixtureTarget, 'dir')
      }
    }
    mkdirSync(join(fixtureDir, 'src'), { recursive: true })
    // Copy the fixture sources explicitly into the fixture's src/ (keep
    // the repo fixture as the source of truth). Copying each file avoids
    // the `cp -r src dst` behavior differences across platforms when dst
    // already contains src/ (GNU cp merges into dst/src, BSD may nest).
    const sourceDir = join(FIXTURE_ROOT, 'src')
    for (const file of readdirSync(sourceDir)) {
      const from = join(sourceDir, file)
      const to = join(fixtureDir, 'src', file)
      if (statSync(from).isDirectory()) {
        run('cp', ['-r', from, to])
      } else {
        writeFileSync(to, readFileSync(from))
      }
    }
    check('fixture sources copied', existsSync(join(fixtureDir, 'src', 'index.ts')))
    writeFileSync(join(fixtureDir, 'tsconfig.json'), readFileSync(join(FIXTURE_ROOT, 'tsconfig.json')))
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'dsh-pi-extension-fixture',
      private: true,
      type: 'module',
    }, null, 2))

    // 3. Typecheck the fixture against the PACKED .d.mts.
    const tsc = run('node', [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(fixtureDir, 'tsconfig.json')], {
      cwd: fixtureDir,
    })
    check('fixture typechecks against the packed .d.mts', tsc.status === 0,
      tsc.status === 0 ? '' : tsc.stdout.slice(-600) + tsc.stderr.slice(-400))

    // 4. Runtime load: the fixture module must resolve the packed bytes.
    const load = run(process.execPath, ['--input-type=module', '-e', `
      import { name, inject, apply } from '${join(fixtureDir, 'src', 'index.ts').replaceAll('\\', '/')}'
      if (name !== 'pi-extension-fixture') throw new Error('bad name')
      if (typeof apply !== 'function') throw new Error('bad apply')
      console.log('fixture-module-ok')
    `], { cwd: fixtureDir })
    check('fixture module loads from the packed package', load.status === 0 && load.stdout.includes('fixture-module-ok'),
      load.status === 0 ? '' : load.stderr.slice(0, 400))

    // 4b. EXECUTE apply() through a minimal Cordis context: the fixture's
    //     register calls (header badge, dock item, footer segment AND the
    //     configurable footer item) must run against the PACKED service
    //     surface — feature detection first, then the registrations land
    //     on the service ledger. The packed extension service is exported
    //     through the subpath.
    const applyRun = run(process.execPath, ['--input-type=module', '-e', `
      import { apply as fixtureApply, name, inject } from '${join(fixtureDir, 'src', 'index.ts').replaceAll('\\', '/')}'
      import { PI_TUI_EXTENSIONS_SERVICE } from '@xmoon76/dsh-pi-tui/extensions'
      if (inject[0] !== 'tuiStartup' || inject[1] !== PI_TUI_EXTENSIONS_SERVICE) throw new Error('bad inject')
      // A minimal service stand-in: the fixture only reads api() and
      // register(). Feature-detect the slots, then count registrations.
      const registrations = []
      const ctx = {
        get: () => ({
          api: () => ({ capabilities: new Set([
            'slot.chrome.header.badge', 'slot.input.dock.item',
            'slot.chrome.footer.status', 'slot.chrome.footer.item',
          ]) }),
          register: (slot, spec, value) => { registrations.push({ slot, spec, value }) },
        }),
      }
      fixtureApply(ctx)
      const slots = registrations.map(r => r.slot).sort().join(',')
      if (slots !== 'chrome.footer.item,chrome.footer.status,chrome.header.badge,input.dock.item') {
        throw new Error('bad registrations: ' + slots)
      }
      console.log('fixture-apply-ok')
    `], { cwd: fixtureDir })
    check('fixture apply() registers every slot through the packed public surface',
      applyRun.status === 0 && applyRun.stdout.includes('fixture-apply-ok'),
      applyRun.status === 0 ? '' : applyRun.stderr.slice(0, 400))

    // 5. The fixture resolves @xmoon76/dsh-pi-tui/extensions through the
    //    packed subpath (import resolution check).
    const subpath = run(process.execPath, ['--input-type=module', '-e', `
      const m = await import('@xmoon76/dsh-pi-tui/extensions')
      if (typeof m.PI_TUI_EXTENSIONS_SERVICE !== 'string') throw new Error('bad export')
      console.log('subpath-ok')
    `], { cwd: fixtureDir })
    check('@xmoon76/dsh-pi-tui/extensions subpath imports from the packed package',
      subpath.status === 0 && subpath.stdout.includes('subpath-ok'),
      subpath.status === 0 ? '' : subpath.stderr.slice(0, 400))

    // 6. No duplicate @deepseek-ai runtime: the packed package declares
    //    @deepseek-ai/* as PEER dependencies only (resolved from the dsh
    //    install), the TARBALL carries no nested node_modules, the fixture
    //    imports no dsh runtime path itself, and the smoke scaffolding's
    //    host-module links in the extracted package are SYMLINKS only —
    //    never real copies (P2-3: an explicit recursive audit).
    const packedPkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
    const deepseekDeps = Object.keys(packedPkg.dependencies ?? {})
      .filter(name => name.startsWith('@deepseek-ai'))
    check('packed package has no @deepseek-ai dependency (peers only)', deepseekDeps.length === 0,
      deepseekDeps.length === 0 ? '' : deepseekDeps.join(', '))
    const tarballEntries = run('tar', ['-tzf', tarball]).stdout.split('\n')
    check('tarball carries no nested node_modules',
      !tarballEntries.some(entry => /(^|\/)node_modules\//.test(entry)))
    const fixtureSource = readFileSync(join(fixtureDir, 'src', 'index.ts'), 'utf8')
    // A Cordis plugin imports the cordis Context type (peer); the banned
    // set is the dsh RUNTIME packages (agent/session/...) that would
    // duplicate the host install.
    check('fixture imports no dsh runtime @deepseek-ai path',
      !/@deepseek-ai\/(?!cordis)/.test(fixtureSource))
    // Recursive nested-package audit (P2-3): every @deepseek-ai entry in
    // the EXTRACTED package's scaffolding node_modules must be a symlink
    // to the host install (a real directory would be a duplicate copy).
    const scaffoldingModules = join(pkgDir, 'node_modules')
    let realDeepseekDirs = 0
    const audit = (dir, depth) => {
      if (depth > 4) return
      let entries = []
      try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const entry of entries) {
        const full = join(dir, entry.name)
        if (entry.isSymbolicLink()) continue // host links are fine
        if (entry.isDirectory()) {
          if (entry.name.startsWith('@deepseek-ai') || /deepseek/.test(entry.name)) {
            realDeepseekDirs += 1
          }
          if (entry.name !== '.bin') audit(full, depth + 1)
        }
      }
    }
    audit(scaffoldingModules, 0)
    check('extracted-package scaffolding has no REAL @deepseek-ai directory (symlinks only)', realDeepseekDirs === 0,
      realDeepseekDirs === 0 ? '' : `${realDeepseekDirs} real @deepseek-ai director(ies)`)
  } finally {
    rmSync(workDir, { recursive: true, force: true })
  }

  for (const line of checks) console.log(line)
  if (failures.length > 0) {
    console.error(`\nextension fixture smoke FAILED (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nextension fixture smoke passed')
}

try {
  main()
} catch (error) {
  console.error(`extension-fixture-smoke: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
