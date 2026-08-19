#!/usr/bin/env node
/**
 * vim-plugin-smoke — verify the M10 vim acceptance plugin against the
 * PACKED `@xmoon76/dsh-pi-tui` tarball (plan §15):
 *
 *   1. the vim fixture imports ONLY the public `@xmoon76/dsh-pi-tui/
 *      extensions` subpath — importing `@xmoon76/pi-tui`, `src/tui-app`
 *      or any repository-relative internal path FAILS the gate;
 *   2. the fixture typechecks against the packed `.d.mts`;
 *   3. the fixture's module shape (name/inject/apply) matches what the
 *      Loader mounts;
 *   4. the fixture exercises the FULL SDK: editor replacement, keybinding,
 *      widget, command, setting, tool renderer, managed overlay.
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
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
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
    //    must never reference private internals (prose/doc comments may
    //    name them — the gate is about what the plugin can IMPORT).
    const fixtureSrc = readFileSync(join(FIXTURE_ROOT, 'src', 'index.ts'), 'utf8')
    // Import STATEMENTS (multi-line `import { ... } from '...'` blocks):
    // gather from every `import` keyword through its terminating `;`.
    const importStatements = []
    const lines = fixtureSrc.split('\n')
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
      const matches = importLines.match(pattern) ?? []
      check(`fixture does not import ${name}`, matches.length === 0,
        matches.length === 0 ? '' : matches.join(', '))
    }
    // The ONLY @xmoon76/dsh-pi-tui imports are the extensions subpath
    // (cordis is a legitimate peer for the plugin's apply signature).
    const dshImports = importLines.match(/@xmoon76\/dsh-pi-tui[^'"]*/g) ?? []
    check('fixture imports ONLY the public extensions subpath',
      dshImports.length === 1 && dshImports[0] === '@xmoon76/dsh-pi-tui/extensions',
      dshImports.join(', '))

    // 3. SDK SURFACE COVERAGE (plan §15 acceptance): every public
    //    capability must be exercised.
    const surface = [
      ['registerEditor', 'editor replacement'],
      ['registerKeybinding', 'keybindings'],
      ["register<InputWidget>", 'widget slot'],
      ['registerCommand', 'command ownership'],
      ['registerSetting', 'settings'],
      ['registerToolRenderer', 'tool renderer'],
      ['showOverlay', 'managed overlay'],
    ]
    for (const [api, label] of surface) {
      check(`fixture exercises ${label} (${api})`, fixtureSrc.includes(api))
    }

    // 4. Copy the fixture into the workdir and typecheck against the
    //    packed package.
    const probeDir = join(workDir, 'probe')
    mkdirSync(probeDir)
    writeFileSync(join(probeDir, 'package.json'), JSON.stringify({
      name: 'vim-plugin-probe',
      private: true,
      type: 'module',
      dependencies: {
        '@xmoon76/dsh-pi-tui': `file:${pkgDir}`,
        '@deepseek-ai/cordis': '*',
      },
      devDependencies: {
        typescript: '^5.9.0',
      },
    }, null, 2))
    mkdirSync(join(probeDir, 'src'))
    writeFileSync(join(probeDir, 'src', 'index.ts'), fixtureSrc)
    writeFileSync(join(probeDir, 'tsconfig.json'), JSON.stringify({
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
    const install = run('npm', ['install', '--no-save', '--ignore-scripts', '--cache', join(workDir, 'npm-cache')], { cwd: probeDir, timeout: 240_000 })
    check('fixture dependencies install', install.status === 0,
      install.status === 0 ? '' : (install.stderr.split('\n').slice(-3).join(' ')))
    if (install.status === 0) {
      const typecheck = run(join(probeDir, 'node_modules', '.bin', 'tsc'), ['-p', 'tsconfig.json'], { cwd: probeDir })
      check('fixture typechecks against the packed .d.mts', typecheck.status === 0,
        typecheck.status === 0 ? '' : (typecheck.stdout + typecheck.stderr).split('\n').slice(-5).join(' '))
      // 5. Module shape.
      const moduleShape = /export const name = ['"][^'"]+['"]/s.test(fixtureSrc)
        && /export const inject = \[/s.test(fixtureSrc)
        && /export function apply\(ctx: Context\)/s.test(fixtureSrc)
      check('fixture module shape (name/inject/apply) matches the Loader', moduleShape)
      // 6. No duplicate dsh runtime in the fixture's node_modules —
      //    only the type-check peer (cordis) may resolve; the dsh runtime
      //    packages (@deepseek-ai/dsh-*) must be absent (they resolve
      //    from the host installation).
      const nm = join(probeDir, 'node_modules', '@deepseek-ai')
      const runtimeCopies = existsSync(nm)
        ? readdirSync(nm).filter(name => name.startsWith('dsh-'))
        : []
      check('fixture has no @deepseek-ai dsh-runtime copy', runtimeCopies.length === 0,
        runtimeCopies.length === 0 ? '' : runtimeCopies.join(', '))
    }
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
