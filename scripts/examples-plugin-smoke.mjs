#!/usr/bin/env node
/**
 * examples-plugin-smoke — verify the Phase-5 EXAMPLE plugins (vim,
 * questionnaire, interactive-shell) against the PACKED
 * `@xmoon76/dsh-pi-tui` tarball (plan §14/§18):
 *
 *   1. each example imports ONLY the public subpaths (extensions /
 *      extensions/advanced / extensions/unstable + cordis) — importing
 *      `@xmoon76/pi-tui`, `src/tui-app` or any repository-relative
 *      internal path FAILS the gate (static imports, dynamic import()
 *      AND require() are all scanned);
 *   2. each example typechecks against the packed `.d.mts`;
 *   3. each example COMPILES to JS and RUNTIME-LOADS against the packed
 *      bytes (apply() registers through a mock service without throwing);
 *   4. the examples exercise their tier surfaces: vim (editor SDK +
 *      modal state machine), questionnaire (imperative UI broker),
 *      interactive-shell (unstable raw + low-level mount);
 *   5. no duplicate dsh runtime in the example trees.
 *
 * The probe mirrors the host install with SYMLINKS (no npm install — the
 * gate is offline-safe; the packed package's runtime deps resolve from
 * the repo's node_modules exactly like a real profile).
 *
 * Usage: node scripts/examples-plugin-smoke.mjs [path-to-tgz]
 * @module examples-plugin-smoke
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
const EXAMPLES_ROOT = join(PACKAGE_ROOT, 'examples', 'plugins')

/** The example plugins under gate (name → expected module name). */
const EXAMPLES = [
  { dir: 'vim', moduleName: 'dsh-pi-example-vim', surface: ['registerEditor', 'handleInput', 'EditorInputEvent', "'insert'", "'normal'"] },
  { dir: 'questionnaire', moduleName: 'dsh-pi-example-questionnaire', surface: ['ui.ui.select', 'ui.ui.input', 'ui.ui.confirm', 'ui.ui.notify'] },
  { dir: 'interactive-shell', moduleName: 'dsh-pi-example-interactive-shell', surface: ['ui.input.captureRaw', "mode: 'exclusive'", 'mountComponent'] },
]

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

/** The import statements of one source file (multi-line blocks). */
function importStatementsOf(source) {
  const lines = source.split('\n')
  const statements = []
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*import\b/.test(lines[index] ?? '')) {
      let statement = lines[index] ?? ''
      while (!statement.includes(';') && index + 1 < lines.length) {
        index += 1
        statement += lines[index]
      }
      statements.push(statement)
    }
  }
  return statements.join('\n')
}

function main() {
  const tarball = resolveTarball(process.argv[2])
  const workDir = mkdtempSync(join(tmpdir(), 'examples-plugin-'))
  try {
    // 1. Extract the packed package.
    const extractedDir = join(workDir, 'pkg')
    mkdirSync(extractedDir)
    const extract = run('tar', ['-xzf', tarball, '-C', extractedDir])
    check('tarball extracts', extract.status === 0, extract.stderr)
    const pkgDir = join(extractedDir, 'package')
    check('packed package has dist/extensions.mjs', existsSync(join(pkgDir, 'dist', 'extensions.mjs')))
    check('packed package has dist/extension/advanced.mjs', existsSync(join(pkgDir, 'dist', 'extension', 'advanced.mjs')))
    check('packed package has dist/extension/unstable.mjs', existsSync(join(pkgDir, 'dist', 'extension', 'unstable.mjs')))

    // The host modules (symlinked into the probe trees — the offline-safe
    // mirror of a real profile install).
    const hostModules = join(PACKAGE_ROOT, 'node_modules')

    for (const example of EXAMPLES) {
      const exampleRoot = join(EXAMPLES_ROOT, example.dir)
      const fixtureSrc = readFileSync(join(exampleRoot, 'src', 'index.ts'), 'utf8')
      const importLines = importStatementsOf(fixtureSrc)
      const dynamicSpecifiers = [...fixtureSrc.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
        .map(match => match[1])
        .concat([...fixtureSrc.matchAll(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)]
          .map(match => match[1]))

      // 2. IMPORT BAN (plan §14 CI gate).
      const banned = [
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
        check(`${example.dir}: does not import ${name}`, staticMatches.length === 0 && dynamicMatches.length === 0,
          [...staticMatches, ...dynamicMatches].join(', '))
      }
      const dshImports = importLines.match(/@xmoon76\/dsh-pi-tui[^'"]*/g) ?? []
      const allowed = ['@xmoon76/dsh-pi-tui/extensions', '@xmoon76/dsh-pi-tui/extensions/advanced', '@xmoon76/dsh-pi-tui/extensions/unstable']
      check(`${example.dir}: imports ONLY the public extensions subpaths`,
        dshImports.length > 0 && dshImports.every(specifier => allowed.includes(specifier)),
        dshImports.join(', '))

      // 3. SURFACE EXERCISE (plan §18 acceptance).
      for (const api of example.surface) {
        check(`${example.dir}: exercises ${api}`, fixtureSrc.includes(api))
      }
      check(`${example.dir}: never parses raw terminal bytes (no CSI-u / escape matching in the plugin)`,
        !/\\x1b\[/.test(fixtureSrc) && !/escape\s*\(/.test(fixtureSrc.replace(/handleInput/g, '')))

      // 4. The probe tree: symlink the packed package + the host modules.
      const fixtureDir = join(workDir, example.dir)
      mkdirSync(join(fixtureDir, 'node_modules', '@xmoon76'), { recursive: true })
      symlinkSync(pkgDir, join(fixtureDir, 'node_modules', '@xmoon76', 'dsh-pi-tui'), 'dir')
      mkdirSync(join(pkgDir, 'node_modules'), { recursive: true })
      for (const entry of readdirSync(hostModules)) {
        const target = join(pkgDir, 'node_modules', entry)
        if (existsSync(target)) continue
        symlinkSync(join(hostModules, entry), target, 'dir')
      }
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
        name: example.moduleName,
        private: true,
        type: 'module',
      }, null, 2))

      // 5. Typecheck against the packed .d.mts.
      const tsc = run('node', [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(fixtureDir, 'tsconfig.json')], { cwd: fixtureDir })
      check(`${example.dir}: typechecks against the packed .d.mts`, tsc.status === 0,
        tsc.status === 0 ? '' : (tsc.stdout + tsc.stderr).split('\n').slice(-6).join(' '))

      // 6. Module shape.
      const moduleShape = /export const name = ['"][^'"]+['"]/s.test(fixtureSrc)
        && /export const inject = \[/s.test(fixtureSrc)
        && /export function apply\(ctx: Context\)/s.test(fixtureSrc)
      check(`${example.dir}: module shape (name/inject/apply) matches the Loader`, moduleShape)

      // 7. RUNTIME LOAD: compile to JS and apply() with a mock service.
      const emitDir = join(fixtureDir, 'dist-out')
      const emit = run('node', [join(PACKAGE_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p', join(fixtureDir, 'tsconfig.json'), '--noEmit', 'false', '--outDir', emitDir], { cwd: fixtureDir })
      check(`${example.dir}: compiles to JS for the runtime probe`, emit.status === 0,
        emit.status === 0 ? '' : (emit.stdout + emit.stderr).split('\n').slice(-4).join(' '))
      if (emit.status === 0) {
        writeFileSync(join(fixtureDir, 'runtime-probe.mjs'), `
          const context = {
            get: (name) => name === 'piTuiExtensions' ? mockService() : undefined,
            on: () => {},
          }
          function mockService() {
            const inertLease = {
              id: 'inert', active: false, focused: false,
              focus: () => {}, blur: () => {}, invalidate: () => {},
              close: () => {}, hide: () => {}, show: () => {},
            }
            const inertControls = {
              getEditorState: () => ({ text: '', cursor: 0, focused: false, composing: false }),
              setEditorText: () => {}, setEditorCursor: () => {},
              insertEditorText: () => {}, pasteToEditor: () => {}, requestEditorFocus: () => {},
            }
            const inertHandle = {
              surfaceId: 'inert', generation: 0, width: 0, height: 0,
              requestRender: () => {},
              mountComponent: () => inertLease,
            }
            const makeHandle = () => ({ id: 'x', invalidate: () => {}, replace: () => {}, dispose: () => {} })
            return {
              api: () => ({
                apiVersion: 1,
                hostVersion: 'test',
                capabilities: new Set([
                  'slot.chrome.header.badge', 'slot.input.dock.item', 'slot.chrome.footer.status',
                  'slot.input.widget', 'advanced.input.capture', 'advanced.ui.interactive',
                  'advanced.editor.control', 'unstable.input.raw', 'unstable.surface.handle',
                ]),
                deprecations: new Map(),
              }),
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
              _advancedCaptureInput: (spec) => ({ id: spec.id, dispose: () => {} }),
              _advancedShowInteractiveOverlay: () => inertLease,
              _advancedEditorControls: () => inertControls,
              _advancedUiSelect: () => Promise.resolve(undefined),
              _advancedUiConfirm: () => Promise.resolve(false),
              _advancedUiInput: () => Promise.resolve(undefined),
              _advancedUiNotify: () => {},
              _advancedUiCustom: () => Promise.resolve(undefined),
              _advancedHostState: () => ({
                getTheme: () => 'dark', setTheme: () => {}, setTitle: () => {},
                setWorkingMessage: () => {}, setToolsExpanded: () => {},
              }),
              _unstableCaptureRaw: (spec) => ({ id: spec.id, dispose: () => {} }),
              _unstableSurfaceHandle: () => inertHandle,
            }
          }
          const plugin = await import(${JSON.stringify(join(emitDir, 'index.js').replaceAll('\\', '/'))})
          plugin.apply(context)
          if (plugin.name !== ${JSON.stringify(example.moduleName)}) throw new Error('bad name: ' + plugin.name)
          console.log('fixture-runtime-ok')
        `)
        const runtime = run(process.execPath, [join(fixtureDir, 'runtime-probe.mjs')], { cwd: fixtureDir })
        check(`${example.dir}: runtime-loads and apply() registers without throwing`,
          runtime.status === 0 && runtime.stdout.includes('fixture-runtime-ok'),
          runtime.status === 0 ? '' : (runtime.stderr || runtime.stdout).split('\n').slice(-8).join(' '))
      }

      // 8. No duplicate dsh runtime in the example tree.
      const probeReal = resolve(workDir)
      const nm = join(fixtureDir, 'node_modules', '@deepseek-ai')
      const realDirs = []
      const entries = existsSync(nm) ? readdirSync(nm) : []
      for (const name of entries) {
        const entry = join(nm, name)
        let isSymlink = false
        try { isSymlink = lstatSync(entry).isSymbolicLink() } catch { /* missing */ }
        if (!isSymlink) {
          realDirs.push(`${name} (real dir)`)
          continue
        }
        try {
          const target = resolve(realpathSync(entry))
          if (target.startsWith(probeReal)) realDirs.push(`${name}->${target}`)
        } catch {
          realDirs.push(`${name} (dangling)`)
        }
      }
      check(`${example.dir}: no duplicate @deepseek-ai dsh-runtime copy (symlinks only)`,
        realDirs.length === 0,
        realDirs.join(', '))
    }
  } finally {
    if (process.env.EXAMPLES_SMOKE_KEEP !== '1') rmSync(workDir, { recursive: true, force: true })
  }

  for (const line of checks) console.log(line)
  if (failures.length > 0) {
    console.error(`\nexamples-plugin smoke FAILED (${failures.length}):`)
    for (const failure of failures) console.error(`  - ${failure}`)
    process.exit(1)
  }
  console.log('\nexamples-plugin smoke passed')
}

main()
