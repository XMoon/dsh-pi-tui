#!/usr/bin/env node
/**
 * vim-plugin-smoke — verify the M10 vim acceptance plugin against the
 * PACKED `@xmoon76/dsh-pi-tui` tarball (plan §15):
 *
 *   1. the vim fixture imports ONLY the public `@xmoon76/dsh-pi-tui/
 *      extensions` subpath — importing `@xmoon76/pi-tui`, `src/tui-app`
 *      or any repository-relative internal path FAILS the gate (static
 *      imports, dynamic import() AND require() are all scanned);
 *   2. the fixture typechecks against the packed `.d.mts`;
 *   3. the fixture COMPILES to JS and RUNTIME-LOADS against the packed
 *      bytes (apply() registers through a mock service without throwing);
 *   4. the fixture exercises the EDITOR-EXTENSION SEAM (replacement
 *      registration + semantic EditorInputEvent handling + modal state);
 *      the remaining public surfaces (commands, themes, settings,
 *      autocomplete, keybindings, renderers, overlays, widgets) are each
 *      covered by their own dedicated tests — this gate is NOT a
 *      Stable-completeness proof;
 *   5. the fixture's module shape (name/inject/apply) matches the Loader;
 *   6. no duplicate dsh runtime in the fixture tree.
 *
 * The probe mirrors the host install with SYMLINKS (no npm install — the
 * gate is offline-safe; the packed package's runtime deps resolve from
 * the repo's node_modules exactly like a real profile).
 *
 * Usage: node scripts/vim-plugin-smoke.mjs [path-to-tgz]
 * @module vim-plugin-smoke
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
  lstatSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(SCRIPT_DIR, '..')
const FIXTURE_ROOT = join(PACKAGE_ROOT, 'test', 'fixtures', 'vim-plugin')

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
  const workDir = mkdtempSync(join(tmpdir(), 'vim-plugin-'))
  try {
    // 1. Extract the packed package.
    const extractedDir = join(workDir, 'pkg')
    mkdirSync(extractedDir)
    const extract = run('tar', ['-xzf', tarball, '-C', extractedDir])
    check('tarball extracts', extract.status === 0, extract.stderr)
    const pkgDir = join(extractedDir, 'package')
    check('packed package has dist/extensions.mjs', existsSync(join(pkgDir, 'dist', 'extensions.mjs')))
    check('packed package has dist/extensions.d.mts', existsSync(join(pkgDir, 'dist', 'extensions.d.mts')))

    // 2. IMPORT BAN (plan §15 CI gate): the fixture's IMPORT STATEMENTS
    //    (multi-line blocks), dynamic import() and require() specifiers
    //    must never reference private internals (prose may name them —
    //    the gate is about what the plugin can IMPORT).
    const fixtureSrc = readFileSync(join(FIXTURE_ROOT, 'src', 'index.ts'), 'utf8')
    const lines = fixtureSrc.split('\n')
    const importStatements = []
    for (let index = 0; index < lines.length; index++) {
      if (/^\s*import\b/.test(lines[index] ?? '')) {
        let statement = lines[index] ?? ''
        while (!statement.includes(';') && index + 1 < lines.length) {
          index += 1
          statement += lines[index]
        }
        importStatements.push(statement)
      }
    }
    const importLines = importStatements.join('\n')
    const dynamicSpecifiers = [...fixtureSrc.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
      .map(match => match[1])
      .concat([...fixtureSrc.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map(match => match[1]))
    const banned = [
      // Word-boundary: `@xmoon76/pi-tui` must NOT match
      // `@xmoon76/dsh-pi-tui` (a substring of the public package name).
      ['@xmoon76/pi-tui (the private fork, word-bounded)', /@xmoon76\/pi-tui(?![-a-z])/g],
      ['@moonshot-ai/pi-tui', /@moonshot-ai\/pi-tui/g],
      ['src/tui-app', /src\/tui-app/g],
      ['TuiApp', /\bTuiApp\b/g],
      ['TuiMainScreen', /\bTuiMainScreen\b/g],
      ['TuiAltScreen', /\bTuiAltScreen\b/g],
      ['repository-relative internal path', /\.\.\/\.\.\/src/g],
    ]
    for (const [name, pattern] of banned) {
      const staticMatches = importLines.match(pattern) ?? []
      const dynamicMatches = dynamicSpecifiers.filter(specifier => pattern.test(specifier))
      check(`fixture does not import ${name}`, staticMatches.length === 0 && dynamicMatches.length === 0,
        [...staticMatches, ...dynamicMatches].join(', '))
    }
    // The ONLY @xmoon76/dsh-pi-tui imports are the extensions subpath
    // (cordis is a legitimate peer for the plugin's apply signature).
    const dshImports = importLines.match(/@xmoon76\/dsh-pi-tui[^'"]*/g) ?? []
    check('fixture imports ONLY the public extensions subpath',
      dshImports.length === 1 && dshImports[0] === '@xmoon76/dsh-pi-tui/extensions',
      dshImports.join(', '))

    // 3. EDITOR-SEAM SURFACE (plan §15 acceptance): the editor seam
    //    exercised through the vim fixture. The checks below validate the
    //    editor-extension seam, NOT a Stable-completeness proof: each
    //    remaining public surface (commands, themes, settings,
    //    autocomplete, keybindings, renderers, overlays, widgets) has its
    //    own dedicated tests (plan §8) — this gate must not grow into a
    //    FULL-SDK proof.
    const surface = [
      ['registerEditor', 'editor replacement'],
      ['handleInput', 'semantic editor input channel'],
      ['EditorInputEvent', 'host-normalized event shape'],
      ['create:', 'editor create() protocol member'],
      ['dispose:', 'editor dispose() protocol member'],
    ]
    for (const [api, label] of surface) {
      check(`fixture exercises ${label} (${api})`, fixtureSrc.includes(api))
    }
    // P1-6: the vim fixture is a MINIMAL modal editor — it must implement the
    // semantic handleInput(event) channel (EditorInputEvent) and own a mode
    // state machine. (The checks below validate the editor-extension seam
    // through the vim fixture; they are not a Stable-completeness proof —
    // the fixture keeps its mini modal editor, which is not a blocker,
    // see plan §7.)
    check('fixture owns a modal state machine (insert/normal modes)',
      fixtureSrc.includes("'insert'") && fixtureSrc.includes("'normal'"))
    check('fixture never parses raw terminal bytes (no CSI-u / escape matching in the plugin)',
      !/\\x1b\[/.test(fixtureSrc) && !/escape\s*\(/.test(fixtureSrc.replace(/handleInput/g, '')))

    // 4. The fixture tree: symlink the packed package + the host's
    //    node_modules (the offline-safe mirror of a real profile install —
    //    the packed tarball itself carries no node_modules).
    const fixtureDir = join(workDir, 'fixture')
    mkdirSync(join(fixtureDir, 'node_modules', '@xmoon76'), { recursive: true })
    symlinkSync(pkgDir, join(fixtureDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), 'dir')
    const hostModules = join(PACKAGE_ROOT, 'node_modules')
    mkdirSync(join(pkgDir, 'node_modules'), { recursive: true })
    for (const entry of readdirSync(hostModules)) {
      const target = join(pkgDir, 'node_modules', entry)
      if (existsSync(target)) continue
      symlinkSync(join(hostModules, entry), target, 'dir')
    }
    // The fixture ALSO imports @deepseek-ai/cordis directly (the apply
    // Context type) — mirror the host modules into the fixture tree too.
    mkdirSync(join(fixtureDir, 'node_modules'), { recursive: true })
    for (const entry of readdirSync(hostModules)) {
      const target = join(fixtureDir, 'node_modules', entry)
      if (existsSync(target)) continue
      symlinkSync(join(hostModules, entry), target, 'dir')
    }
    mkdirSync(join(fixtureDir, 'src'), { recursive: true })
    writeFileSync(join(fixtureDir, 'src', 'index.ts'), fixtureSrc)
    writeFileSync(join(fixtureDir, 'tsconfig.json'), JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
      },
      include: ['src'],
    }, null, 2))
    writeFileSync(join(fixtureDir, 'package.json'), JSON.stringify({
      name: 'dsh-pi-vim-fixture',
      private: true,
      type: 'module',
    }, null, 2))

    // 5. Typecheck against the packed .d.mts (the repo's tsc — no
    //    registry fetch).
    const tsc = run('node', [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(fixtureDir, 'tsconfig.json')], { cwd: fixtureDir })
    check('fixture typechecks against the packed .d.mts', tsc.status === 0,
      tsc.status === 0 ? '' : (tsc.stdout + tsc.stderr).split('\n').slice(-6).join(' '))

    // 6. Module shape.
    const moduleShape = /export const name = ['"][^'"]+['"]/s.test(fixtureSrc)
      && /export const inject = \[/s.test(fixtureSrc)
      && /export function apply\(ctx: Context\)/s.test(fixtureSrc)
    check('fixture module shape (name/inject/apply) matches the Loader', moduleShape)

    // 7. RUNTIME LOAD (round-1 finding 2): compile the fixture to JS and
    //    apply() it with a mock service — the registrations must not
    //    throw and must resolve the PACKED extensions module.
    const emitDir = join(fixtureDir, 'dist-out')
    const emit = run('node', [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '-p', join(fixtureDir, 'tsconfig.json'), '--noEmit', 'false', '--outDir', emitDir], { cwd: fixtureDir })
    check('fixture compiles to JS for the runtime probe', emit.status === 0,
      emit.status === 0 ? '' : (emit.stdout + emit.stderr).split('\n').slice(-4).join(' '))
    if (emit.status === 0) {
      writeFileSync(join(fixtureDir, 'runtime-probe.mjs'), `
        const context = {
          get: (name) => name === 'piTuiExtensions' ? mockService() : undefined,
          on: () => {},
        }
        function mockService() {
          const makeHandle = () => ({ id: 'x', invalidate: () => {}, replace: () => {}, dispose: () => {} })
          return {
            api: () => ({ apiVersion: 1, hostVersion: 'test', capabilities: new Set(['slot.input.widget', 'slot.input.dock.item', 'slot.chrome.header.badge', 'slot.chrome.footer.status']) }),
            register: () => makeHandle(),
            registerCommand: () => makeHandle(),
            registerTheme: () => makeHandle(),
            registerAutocomplete: () => makeHandle(),
            registerSetting: () => makeHandle(),
            registerKeybinding: () => makeHandle(),
            registerMessageRenderer: () => makeHandle(),
            registerToolRenderer: () => makeHandle(),
            registerEditor: () => makeHandle(),
            showOverlay: () => ({ close: () => {}, hide: () => {}, show: () => {} }),
          }
        }
        const plugin = await import(${JSON.stringify(join(emitDir, 'index.js').replaceAll('\\', '/'))})
        plugin.apply(context)
        if (plugin.name !== 'dsh-pi-vim-fixture') throw new Error('bad name: ' + plugin.name)
        console.log('fixture-runtime-ok')
      `)
      const runtime = run(process.execPath, [join(fixtureDir, 'runtime-probe.mjs')], { cwd: fixtureDir })
      check('fixture runtime-loads and apply() registers without throwing',
        runtime.status === 0 && runtime.stdout.includes('fixture-runtime-ok'),
        runtime.status === 0 ? '' : (runtime.stderr || runtime.stdout).split('\n').slice(-8).join(' '))
    }

    // 8. No duplicate dsh runtime: every @deepseek-ai entry in BOTH the
    //    packed package tree AND the fixture tree must be a SYMLINK whose
    //    realpath resolves into the host module tree (the packed tarball
    //    itself carries no node_modules — the scaffolding symlinks them,
    //    exactly like a real profile resolves in-box packages from the
    //    dsh installation). A REAL directory is a duplicate runtime copy.
    // The symlinks point into the HOST's modules (pnpm's virtual store
    // under node_modules/.pnpm, itself linking to the pnpm store — a
    // REAL host install). The defect class is a COPY: a real directory,
    // or a symlink resolving back INTO the packed/fixture tree (a
    // self-contained duplicate). A symlink resolving OUTSIDE the probe
    // (host node_modules / pnpm store) is exactly the host resolution a
    // real profile uses.
    const probeReal = resolve(workDir)
    const auditTrees = [
      ['packed package', join(pkgDir, 'node_modules', '@deepseek-ai')],
      ['fixture tree', join(fixtureDir, 'node_modules', '@deepseek-ai')],
    ]
    const realDirs = []
    for (const [label, nm] of auditTrees) {
      const entries = existsSync(nm) ? readdirSync(nm) : []
      for (const name of entries) {
        const entry = join(nm, name)
        let isSymlink = false
        try { isSymlink = lstatSync(entry).isSymbolicLink() } catch { /* missing */ }
        if (!isSymlink) {
          realDirs.push(`${label}:${name} (real dir)`)
          continue
        }
        // A symlink whose target resolves INSIDE the probe is a duplicate
        // copy; a dangling link is a defect. Anything else (host modules,
        // the pnpm store) is the intended host resolution.
        try {
          const target = resolve(realpathSync(entry))
          if (target.startsWith(probeReal)) realDirs.push(`${label}:${name}->${target}`)
        } catch {
          realDirs.push(`${label}:${name} (dangling)`)
        }
      }
    }
    check('no duplicate @deepseek-ai dsh-runtime copy (symlinks only, both trees)',
      realDirs.length === 0,
      realDirs.join(', '))
  } finally {
    if (process.env.VIM_SMOKE_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
  }

  for (const line of checks) console.log(line)
  if (failures.length > 0) {
    console.error(`\nvim-plugin smoke FAILED (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nvim-plugin smoke passed')
}

main()
