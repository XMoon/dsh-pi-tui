#!/usr/bin/env node
/**
 * @xmoon76/dsh-pi-tui/scripts/naming-gate — CI guard for the naming and
 * packaging decisions (AGENTS.md "Naming (hard rules)"): nothing here may
 * use the `dsh-tui` / `@deepseek-ai/dsh-tui` family, the profile stays
 * `pi-tui`, the fork stays private and bundled, and the bundle is the only
 * published package with its fork in `deps.onlyBundle`. Fails with a clear
 * list when any decision regresses.
 * @module naming-gate
 */

import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const failures = []
const checks = []

function check(name, ok, detail = '') {
  checks.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(`${name}${detail === '' ? '' : `: ${detail}`}`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

const rootPkg = readJson(join(ROOT, 'package.json'))
const bundlePkg = readJson(join(ROOT, 'packages', 'dsh-pi-tui', 'package.json'))
const forkPkg = readJson(join(ROOT, 'packages', 'pi-tui', 'package.json'))

// 1. Repository + profile naming: never the reserved `tui` / `dsh-tui` family.
check('root package name is dsh-pi-tui', rootPkg.name === 'dsh-pi-tui', rootPkg.name)
check('no @deepseek-ai/dsh-tui anywhere', !['@deepseek-ai/dsh-tui', 'dsh-tui'].some(name =>
  [rootPkg, bundlePkg, forkPkg].some(pkg => pkg.name === name)))
for (const pkg of [rootPkg, bundlePkg, forkPkg]) {
  const manifest = JSON.stringify(pkg)
  if (manifest.includes('@deepseek-ai/dsh-tui') || manifest.includes('"dsh-tui"')) {
    check(`no dsh-tui references in ${pkg.name}`, false)
  }
}
// The startup service keeps its stable id (internal Loader ids, fine as-is).
const patch = readFileSync(join(ROOT, 'packages', 'dsh-pi-tui', 'cordis.patch.yml'), 'utf8')
check('patch rows keep tui-startup/tui-app ids', patch.includes('id: tui-startup') && patch.includes('id: tui-app'))
check('startup service keeps TUI_STARTUP_SERVICE',
  readFileSync(join(ROOT, 'packages', 'dsh-pi-tui', 'src', 'startup.ts'), 'utf8').includes("export const TUI_STARTUP_SERVICE = 'tuiStartup'"))

// 2. Package roles: the fork is private + bundled; the bundle is public.
check('fork package is private (@xmoon76/pi-tui)', forkPkg.private === true, `private=${String(forkPkg.private)}`)
check('bundle package is public (@xmoon76/dsh-pi-tui)', bundlePkg.private !== true, `private=${String(bundlePkg.private)}`)
check('bundle declares dsh.bundle.patch', bundlePkg.dsh?.bundle?.patch !== undefined, bundlePkg.dsh?.bundle?.patch)

// 3. The fork is bundled, never a runtime dependency of the published package.
const tsdown = readFileSync(join(ROOT, 'packages', 'dsh-pi-tui', 'tsdown.config.ts'), 'utf8')
check('tsdown deps.onlyBundle includes @xmoon76/pi-tui',
  tsdown.includes("onlyBundle") && tsdown.includes("'@xmoon76/pi-tui'"))
const runtimeDeps = bundlePkg.dependencies ?? {}
check('@xmoon76/pi-tui is NOT a runtime dependency of the bundle',
  !(runtimeDeps['@xmoon76/pi-tui'] !== undefined), runtimeDeps['@xmoon76/pi-tui'] ?? 'absent')
const forkDeps = forkPkg.dependencies ?? {}
check('the fork does not depend on the bundle', !(forkDeps['@xmoon76/dsh-pi-tui'] !== undefined))

// 4. The vendored-version single source of truth stays in the fork manifest.
check('fork repository.note records the vendored commit (single source of truth)',
  typeof forkPkg.repository?.note === 'string' && forkPkg.repository.note.length > 20,
  forkPkg.repository?.note ?? 'missing')

// 5. The tarball smoke + pack gate stay wired (stage G).
check('bundle prepack gate exists', (bundlePkg.scripts?.prepack ?? '').includes('build:package'))
check('bundle postpack smoke exists', (bundlePkg.scripts?.postpack ?? '').includes('tarball-smoke'))

// 6. The workspace has no stray dist/ or tarballs COMMITTED (dist is
//    gitignored by design; the gate checks git tracking, not the tree).
for (const pkg of ['pi-tui', 'dsh-pi-tui']) {
  const tracked = spawnSync('git', ['ls-files', `packages/${pkg}/dist`], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
  check(`packages/${pkg}/dist is not committed`, tracked === '', tracked.split('\n').filter(Boolean).slice(0, 3).join(', '))
}
const tgz = spawnSync('git', ['ls-files', '*.tgz'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
check('no tarballs committed', tgz === '', tgz.split('\n').filter(Boolean).slice(0, 3).join(', '))

for (const line of checks) console.log(line)
if (failures.length > 0) {
  console.error(`\nnaming-gate FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nnaming-gate passed')
