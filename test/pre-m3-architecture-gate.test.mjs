/**
 * Static audit for the Pre-M3 TS Architecture Convergence dependency direction
 * (plan §5 Dependency direction, §15 Architecture gate 最终规则): the real
 * production tree must satisfy every application-layer rule, and the gate's
 * AST scanner must catch each synthetic violation while ignoring comments,
 * dynamic imports, package imports, and the deliberate non-Backend Direct
 * application owners. The gate itself (`scripts/pre-m3-architecture-gate.mjs`)
 * is the enforcement; this test guards the rules against regressions.
 * @module @xmoon76/dsh-pi-tui/pre-m3-architecture-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { testLifecycle } from './support/temp-lifecycle.ts'
import {
  ARCHITECTURE_RULES,
  buildStaticEdges,
  collectSourceEntries,
  findDirectAdapterConstructions,
  findViolations,
  isDirectCompositionFile,
  parseImportSpecifiers,
  resolveRelativeImport,
  STARTUP_REMOTE_COMPOSITION_RULE,
  staticImportCandidates,
} from '../scripts/pre-m3-architecture-gate.mjs'

/** One synthetic source entry; `findViolations` only needs rel + source. */
const entry = (rel, source) => ({ rel, source })

test('the real production tree satisfies every architecture rule', () => {
  const violations = findViolations(collectSourceEntries())
  assert.deepEqual(
    violations,
    [],
    `application-layer dependency direction violated — fix the import or record a deliberate exception:\n${violations
      .map(v => `src/${v.file}:${v.line} [${v.rule}] ${v.detail}`)
      .join('\n')}`,
  )
})

test('runtime importing app is rejected', () => {
  const violations = findViolations([
    entry('runtime/direct/leak.ts', "import { x } from '../../app/direct/runtime.ts'\n"),
  ])
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'runtime-imports-app')
  assert.equal(violations[0].file, 'runtime/direct/leak.ts')
  assert.equal(violations[0].line, 1)
})

test('non-Direct application owners importing app/direct OR runtime/direct are rejected', () => {
  for (const file of ['app/session/runtime.ts', 'app/submission/runtime.ts', 'app/command/runtime.ts', 'app/surface/runtime.ts']) {
    const depth = file.split('/').length - 1
    const up = '../'.repeat(depth)
    for (const target of ['app/direct/runtime.ts', 'runtime/direct/backend-direct.ts']) {
      const violations = findViolations([entry(file, `import { backend } from '${up}${target}'\n`)])
      assert.equal(violations.length, 1, `${file} -> ${target} must be rejected`)
      assert.equal(violations[0].rule, 'direct-import-outside-composition')
    }
    // A type-only import is NOT an escape hatch for a non-Direct owner.
    assert.equal(
      findViolations([entry(file, `import type { T } from '${up}app/direct/runtime.ts'\n`)]).length,
      1,
      `${file} type-only app/direct import must be rejected`,
    )
  }
})

test('presentation/adjacent modules importing Direct wiring are rejected (enumeration-free)', () => {
  for (const file of [
    'tui-app.ts',
    'task-panel.ts',
    'plugin-manager/panel.ts',
    'transcript.ts',
    'present.ts',
    'icons.ts',
    'search-presentation.ts',
    'file-completion/presentation.ts',
    'components/media/file-attachment.ts',
    'footer/status-line.ts',
  ]) {
    const depth = file.split('/').length - 1
    const up = '../'.repeat(depth)
    for (const target of ['app/direct/runtime.ts', 'runtime/direct/backend-direct.ts']) {
      const violations = findViolations([entry(file, `import { direct } from '${up}${target}'\n`)])
      assert.equal(violations.length, 1, `${file} -> ${target} must be rejected`)
      assert.equal(violations[0].rule, 'direct-import-outside-composition')
    }
  }
})

test('only the composition owners may import Direct wiring', () => {
  for (const file of ['index.ts', 'app/bootstrap.ts', 'app/direct/runtime.ts']) {
    const depth = file.split('/').length - 1
    const up = '../'.repeat(depth)
    for (const target of ['app/direct/runtime.ts', 'runtime/direct/backend-direct.ts']) {
      assert.deepEqual(
        findViolations([entry(file, `import { direct } from '${up}${target}'\n`)]),
        [],
        `${file} must be allowed to import ${target}`,
      )
    }
  }
  // src/runtime/** may import runtime/direct, but never app/** (runtime-imports-app).
  for (const file of ['runtime/direct/backend-direct.ts', 'runtime/catalog-port.ts']) {
    const depth = file.split('/').length - 1
    const up = '../'.repeat(depth)
    assert.deepEqual(
      findViolations([entry(file, `import { direct } from '${up}runtime/direct/backend-direct.ts'\n`)]),
      [],
      `${file} must be allowed to import runtime/direct`,
    )
    const appImport = findViolations([entry(file, `import { direct } from '${up}app/direct/runtime.ts'\n`)])
    assert.equal(appImport.length, 1, `${file} must not import app/direct`)
    assert.equal(appImport[0].rule, 'runtime-imports-app')
  }
})

test('the only non-composition Direct import is the allowlisted legacy settings TYPE import', () => {
  const withoutAllowlist = findViolations(collectSourceEntries(), { allowlist: [] })
  assert.deepEqual(
    withoutAllowlist.map(v => `${v.file}:${v.rule}`),
    ['legacy-settings-migration.ts:direct-import-outside-composition'],
    'the historical exception must stay exactly one type-only import',
  )
  assert.deepEqual(findViolations(collectSourceEntries()), [], 'the checked-in allowlist must clear it')
})

test('an allowlist entry excuses only a TYPE-ONLY import, never a value import', () => {
  const file = 'legacy-settings-migration.ts'
  const target = 'runtime/direct/tui-settings-direct.ts'
  const allowlist = [`${file}:${target}`]
  assert.deepEqual(
    findViolations([entry(file, `import type { T } from './${target}'\n`)], { allowlist }),
    [],
    'the type-only import must be excused',
  )
  const valueImport = findViolations([entry(file, `import { T } from './${target}'\n`)], { allowlist })
  assert.equal(valueImport.length, 1, 'a value import of the same target must still fail')
  assert.equal(valueImport[0].rule, 'direct-import-outside-composition')
  const inlineTypeOnly = findViolations([entry(file, `import { type T } from './${target}'\n`)], { allowlist })
  assert.deepEqual(inlineTypeOnly, [], 'an all-inline-type import is type-only too')
})

test('startup.ts directly importing Remote composition is rejected', () => {
  const remote = findViolations([entry('startup.ts', "import { x } from './runtime/remote/session-reader-remote.ts'\n")])
  assert.equal(remote.length, 1)
  assert.equal(remote[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)

  const client = findViolations([entry('startup.ts', "import type { ClientConnection } from '@deepseek-ai/dsh-client-connection'\n")])
  assert.equal(client.length, 1)
  assert.equal(client[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
})

test('Remote composition statically reachable from startup.ts is rejected through an intermediate module', () => {
  const entries = [
    entry('startup.ts', "import { boot } from './runtime/backend-loader.ts'\n"),
    entry('runtime/backend-loader.ts', "import { remote } from './remote/session-reader-remote.ts'\n"),
    entry('runtime/remote/session-reader-remote.ts', 'export const remote = 1\n'),
  ]
  const edges = buildStaticEdges(entries)
  assert.deepEqual([...edges.get('startup.ts')], ['runtime/backend-loader.ts'])
  const violations = findViolations(entries)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'runtime/backend-loader.ts')
  assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
  assert.match(violations[0].detail, /statically reachable from src\/startup\.ts/)
})

test('Remote composition NOT reachable from startup.ts is not flagged by the startup rule', () => {
  const entries = [
    entry('startup.ts', "import { boot } from './runtime/backend-loader.ts'\n"),
    entry('runtime/backend-loader.ts', 'export const boot = 1\n'),
    entry('runtime/unrelated.ts', "import { remote } from './remote/x.ts'\n"),
    entry('runtime/remote/x.ts', 'export const remote = 1\n'),
  ]
  assert.deepEqual(findViolations(entries), [])
})

test('NodeNext .js/.mjs emitted-extension specifiers resolve in the startup static graph', () => {
  const entries = [
    entry('startup.ts', "import { boot } from './runtime/backend-loader.js'\n"),
    entry('runtime/backend-loader.ts', "import { remote } from './remote/x.js'\n"),
    entry('runtime/remote/x.ts', 'export const remote = 1\n'),
  ]
  assert.deepEqual([...buildStaticEdges(entries).get('startup.ts')], ['runtime/backend-loader.ts'])
  const violations = findViolations(entries)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'runtime/backend-loader.ts')
  assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
})

test('a .mjs specifier resolving to a .d.mts declaration file is part of the startup static graph', () => {
  const entries = [
    entry('startup.ts', "import { boot } from './runtime/loader.mjs'\n"),
    entry('runtime/loader.d.mts', "type T = import('./remote/x.js').T\nexport type { T }\n"),
    entry('runtime/remote/x.ts', 'export type T = 1\n'),
  ]
  assert.deepEqual([...buildStaticEdges(entries).get('startup.ts')], ['runtime/loader.d.mts'])
  const violations = findViolations(entries)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'runtime/loader.d.mts')
  assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
})

test('staticImportCandidates covers NodeNext emitted extensions', () => {
  assert.deepEqual(staticImportCandidates('runtime/x.js'), ['runtime/x.ts', 'runtime/x.d.ts', 'runtime/x.js'])
  assert.deepEqual(staticImportCandidates('runtime/x.mjs'), ['runtime/x.mts', 'runtime/x.d.mts', 'runtime/x.mjs'])
  assert.deepEqual(staticImportCandidates('runtime/x.cjs'), ['runtime/x.cts', 'runtime/x.d.cts', 'runtime/x.cjs'])
  assert.deepEqual(staticImportCandidates('runtime/x.ts'), ['runtime/x.ts'])
  assert.deepEqual(staticImportCandidates('runtime/x.d.mts'), ['runtime/x.d.mts'])
  assert.deepEqual(staticImportCandidates('runtime/x'), [
    'runtime/x.ts',
    'runtime/x.mts',
    'runtime/x.cts',
    'runtime/x.d.ts',
    'runtime/x.d.mts',
    'runtime/x.d.cts',
    'runtime/x/index.ts',
    'runtime/x/index.d.ts',
  ])
})

test('staticImportCandidates agrees with TypeScript NodeNext resolution for every legal spelling', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pre-m3-nodenext-')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'b.d.mts'), 'export const b = 1\n')
  writeFileSync(join(dir, 'c.cts'), 'export const c = 1\n')
  writeFileSync(join(dir, 'entry.ts'), '')
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
  }
  for (const [specifier, expected] of [['./a.js', 'a.ts'], ['./b.mjs', 'b.d.mts'], ['./c.cjs', 'c.cts']]) {
    const resolved = ts.resolveModuleName(specifier, join(dir, 'entry.ts'), options, ts.sys).resolvedModule?.resolvedFileName
    assert.ok(resolved !== undefined, `${specifier} must resolve under NodeNext`)
    const rel = relative(dir, resolved).split('\\').join('/')
    assert.equal(rel, expected)
    assert.ok(
      staticImportCandidates(specifier.slice(2)).includes(rel),
      `staticImportCandidates(${specifier.slice(2)}) must include the TypeScript-resolved ${rel}`,
    )
  }
})

test('TypeScript import() type queries are static dependencies and are zone-checked', () => {
  const violations = findViolations([
    entry('app/surface/runtime.ts', "type T = import('../../runtime/direct/x.ts').T\n"),
  ])
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'direct-import-outside-composition')
  assert.deepEqual(parseImportSpecifiers("type U = typeof import('./y.ts')\n"), [{ specifier: './y.ts', line: 1, typeOnly: true }])
})

test('app/surface constructing a Direct semantic adapter is rejected (canonical and parenthesized)', () => {
  for (const source of [
    'const w = new DirectSessionWriter(deps)\n',
    'const w = new (DirectSessionWriter)(deps)\n',
  ]) {
    const violations = findViolations([entry('app/surface/runtime.ts', source)])
    assert.equal(violations.length, 1, source)
    assert.equal(violations[0].rule, 'surface-constructs-direct-adapter')
    assert.match(violations[0].detail, /DirectSessionWriter/)
  }
})

test('a type-assertion wrapped Direct construction is still detected', () => {
  for (const source of [
    'const w = new (DirectSessionWriter as Constructor)(deps)\n',
    'const w = new ((DirectSessionWriter as unknown) as Constructor)(deps)\n',
  ]) {
    const violations = findViolations([entry('app/surface/runtime.ts', source)])
    assert.equal(violations.length, 1, source)
    assert.equal(violations[0].rule, 'surface-constructs-direct-adapter')
    assert.match(violations[0].detail, /DirectSessionWriter/)
  }
})

test('Direct construction inside a comment never produces a false violation', () => {
  assert.deepEqual(
    findViolations([
      entry(
        'app/surface/runtime.ts',
        '/* new DirectSessionWriter(deps) */\n// new DirectSessionReader(deps)\nconst ok = 1\n',
      ),
    ]),
    [],
  )
})

test('the deliberate non-Port Direct application owners are not flagged in app/surface', () => {
  assert.deepEqual(
    findViolations([
      entry(
        'app/surface/runtime.ts',
        'const m = new DirectModelSelectionOwner(deps)\ninstallAssistantStreamDirect(app)\n',
      ),
    ]),
    [],
  )
})

test('dynamic import is not a static edge (the sanctioned lazy backend-loading seam)', () => {
  assert.deepEqual(
    findViolations([
      entry('runtime/direct/x.ts', "const m = await import('../../app/direct/runtime.ts')\n"),
      entry('startup.ts', "const r = await import('./runtime/remote/x.ts')\n"),
    ]),
    [],
  )
})

test('package specifiers resolve to undefined and never match a relative zone rule', () => {
  assert.equal(resolveRelativeImport('runtime/x.ts', '@deepseek-ai/dsh-agent'), undefined)
  assert.equal(resolveRelativeImport('runtime/x.ts', './app/y.ts'), 'runtime/app/y.ts')
  assert.equal(resolveRelativeImport('app/session/x.ts', '../../runtime/direct/y.ts'), 'runtime/direct/y.ts')
})

test('parseImportSpecifiers covers the static ESM forms, type-only flags, and ignores comments/dynamic imports', () => {
  const specs = parseImportSpecifiers(
    [
      "// import { hidden } from './app/direct/runtime.ts'",
      "/* import { alsoHidden } from './app/direct/runtime.ts' */",
      "import { a } from './a.ts'",
      "export { b } from './b.ts'",
      "const c = await import('./c.ts')",
      "import './d.ts'",
      "import e = require('./e.ts')",
      "import type { f } from './f.ts'",
      "export type { g } from './g.ts'",
      "import { type h } from './h.ts'",
    ].join('\n'),
  )
  assert.deepEqual(specs.map(s => s.specifier), ['./a.ts', './b.ts', './d.ts', './e.ts', './f.ts', './g.ts', './h.ts'])
  assert.deepEqual(specs.map(s => s.line), [3, 4, 6, 7, 8, 9, 10])
  assert.deepEqual(specs.map(s => s.typeOnly), [false, false, false, false, true, true, true])
})

test('parseImportSpecifiers detects a from-clause split across lines', () => {
  const specs = parseImportSpecifiers("import { x } from\n  './app/direct/x.ts'\n")
  assert.deepEqual(specs, [{ specifier: './app/direct/x.ts', line: 1, typeOnly: false }])
})

test('a multi-line block comment containing an import is ignored', () => {
  const specs = parseImportSpecifiers(
    ['/*', "import { x } from './app/direct/x.ts'", '*/', "import { y } from './y.ts'", ''].join('\n'),
  )
  assert.deepEqual(specs, [{ specifier: './y.ts', line: 4, typeOnly: false }])
})

test('the allowlist suppresses exactly the matching file:target pair', () => {
  const file = 'legacy-settings-migration.ts'
  const target = 'runtime/direct/tui-settings-direct.ts'
  const entries = [entry(file, `import type { T } from './${target}'\n`)]
  assert.equal(findViolations(entries, { allowlist: [`${file}:${target}`] }).length, 0)
  assert.equal(findViolations(entries, { allowlist: [`other.ts:${target}`] }).length, 1)
})

test('collectSourceEntries walks a tree and reports src-relative paths', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pre-m3-arch-')
  mkdirSync(join(dir, 'app', 'session'), { recursive: true })
  writeFileSync(join(dir, 'app', 'session', 'runtime.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'top.ts'), 'export const y = 2\n')
  writeFileSync(join(dir, 'decl.d.mts'), 'export const d: number\n')
  writeFileSync(join(dir, 'legacy.cts'), 'export const c = 1\n')
  const entries = collectSourceEntries(dir)
  assert.deepEqual(entries.map(e => e.rel), ['app/session/runtime.ts', 'decl.d.mts', 'legacy.cts', 'top.ts'])
})

test('zone predicates match the plan boundaries', () => {
  assert.ok(isDirectCompositionFile('index.ts'))
  assert.ok(isDirectCompositionFile('app/bootstrap.ts'))
  assert.ok(isDirectCompositionFile('app/direct/runtime.ts'))
  assert.ok(isDirectCompositionFile('runtime/catalog-port.ts'))
  assert.ok(!isDirectCompositionFile('tui-app.ts'))
  assert.ok(!isDirectCompositionFile('transcript.ts'))
  assert.ok(!isDirectCompositionFile('app/session/runtime.ts'))
  assert.ok(!isDirectCompositionFile('app/submission/runtime.ts'))
  assert.ok(!isDirectCompositionFile('app/command/runtime.ts'))
  assert.ok(!isDirectCompositionFile('app/surface/runtime.ts'))
  assert.ok(ARCHITECTURE_RULES.length >= 2)
})

test('Direct adapter construction scan reports line + name for every new Direct<...>(', () => {
  const source = 'x = new DirectSessionWriter(d)\ny = new DirectModelSelectionOwner(d)\n'
  assert.deepEqual(findDirectAdapterConstructions(source), [
    { name: 'DirectSessionWriter', line: 1 },
    { name: 'DirectModelSelectionOwner', line: 2 },
  ])
})
