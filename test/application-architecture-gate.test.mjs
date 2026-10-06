/**
 * Static audit for the long-lived application-layer dependency direction between
 * `src/app/**` owners, `src/runtime/**` semantic/adaptor layers, presentation/TUI
 * modules, and the experimental Remote composition boundary (see
 * `docs/architecture.md`): the real
 * production tree must satisfy every application-layer rule, and the gate's
 * AST scanner must catch each synthetic violation while ignoring comments,
 * dynamic imports, package imports, and the deliberate non-Backend Direct
 * application owners. The gate itself (`scripts/application-architecture-gate.mjs`)
 * is the enforcement; this test guards the rules against regressions.
 * @module @xmoon76/dsh-pi-tui/application-architecture-gate.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { PRODUCTION_SOURCE_EXTENSIONS, productionScriptKind } from './support/owner-modules.ts'
import {
  ARCHITECTURE_RULES,
  buildStaticEdges,
  collectSourceEntries,
  findDirectAdapterConstructions,
  findRemoteDynamicImportViolations,
  findSourceRootViolations,
  findViolations,
  isBootstrapCompositionFile,
  isDirectCompositionFile,
  isRemoteComposition,
  listSourceRootFiles,
  parseImportSpecifiers,
  parseValueDynamicImports,
  readSourceRootBaseline,
  REMOTE_COMPOSITION_SPECIFIER,
  REMOTE_DYNAMIC_IMPORT_OWNER,
  REMOTE_DYNAMIC_IMPORT_TARGET,
  resolveRelativeImport,
  scriptKindOf,
  SOURCE_EXTENSIONS,
  STARTUP_REMOTE_COMPOSITION_RULE,
  staticImportCandidates,
} from '../scripts/application-architecture-gate.mjs'

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

test('application owners importing the bootstrap composition zone are rejected (index -> bootstrap -> owners)', () => {
  // TS2: the forbidden target is the WHOLE composition zone — the facade
  // (`app/bootstrap.ts`) and the cohesive wiring helpers (`app/bootstrap/**`).
  // Importing either form inverts the dependency exactly the same way.
  // Canonicalization resolves every legal NodeNext spelling against the scanned
  // target, so the emitted-extension (`.js`) and extensionless spellings cannot
  // bypass the rule. The target must be in the scanned set for that to work.
  const zoneTargets = [
    'app/bootstrap',
    'app/bootstrap/event-wiring',
    'app/bootstrap/lifecycle',
  ]
  const scanned = [
    entry('app/bootstrap.ts', 'export const bootstrap = 1\n'),
    entry('app/bootstrap/event-wiring.ts', 'export const wiring = 1\n'),
    entry('app/bootstrap/lifecycle.ts', 'export const lifecycle = 1\n'),
  ]
  const spellings = ['.ts', '.js', '']
  for (const file of [
    'app/surface/runtime.ts',
    'app/command/surface.ts',
    'app/submission/controller.ts',
    'app/session/runtime.ts',
    'app/plugin-manager/controller.ts',
    'tui-app.ts',
    'transcript.ts',
  ]) {
    const depth = file.split('/').length - 1
    // A root-level file needs a real `./` prefix: a bare `app/bootstrap.js` is a
    // package specifier, not a relative import, and would pass for the wrong
    // reason (the old test used exactly that bare form for `tui-app.ts`).
    const prefix = depth === 0 ? './' : '../'.repeat(depth)
    for (const target of zoneTargets) {
      for (const ext of spellings) {
        const specifier = `${prefix}${target}${ext}`
        const violations = findViolations([entry(file, `import { bootstrap } from '${specifier}'\n`), ...scanned])
        assert.equal(violations.length, 1, `${file} -> ${specifier} must be rejected`)
        assert.equal(violations[0].rule, 'owner-imports-bootstrap')
      }
    }
  }
  // The composition direction itself is the ONE allowed exception: the entry
  // imports the FACADE, the facade imports helpers, and helpers import sibling
  // helpers. The facade<->helper reverse edge and the entry->helper edge are
  // separate contracts asserted right below.
  const allowed = [
    { file: 'index.ts', target: 'app/bootstrap' },
    { file: 'app/bootstrap.ts', target: 'app/bootstrap/lifecycle' },
    { file: 'app/bootstrap.ts', target: 'app/bootstrap' },
    { file: 'app/bootstrap/runtime-selection.ts', target: 'app/bootstrap/lifecycle' },
  ]
  for (const { file, target } of allowed) {
    const depth = file.split('/').length - 1
    const prefix = depth === 0 ? './' : '../'.repeat(depth)
    for (const ext of spellings) {
      const specifier = `${prefix}${target}${ext}`
      assert.deepEqual(
        findViolations([entry(file, `import { bootstrap } from '${specifier}'\n`), ...scanned]),
        [],
        `${file} must stay allowed to import ${specifier}`,
      )
    }
  }
  // Contract 1 (plan §7.2/§54): the package entry must go through the FACADE —
  // importing a bootstrap helper directly bypasses it.
  for (const ext of spellings) {
    for (const target of ['app/bootstrap/lifecycle', 'app/bootstrap/event-wiring']) {
      const violations = findViolations([entry('index.ts', `import { x } from './${target}${ext}'\n`), ...scanned])
      assert.equal(violations.length, 1, `index.ts -> ${target}${ext} must be rejected`)
      assert.equal(violations[0].rule, 'entry-imports-bootstrap-helper')
    }
  }
  // Contract 2 (plan §54): a helper must never import the facade — that is the
  // `bootstrap.ts -> helper -> bootstrap.ts` value cycle. The known-target set
  // here is JUST the facade: `findViolations` keys imports by `rel`, so the
  // importer must not also appear as a scanned entry (it would overwrite its own
  // import list).
  const facadeTarget = [entry('app/bootstrap.ts', 'export const bootstrap = 1\n')]
  for (const ext of spellings) {
    for (const file of ['app/bootstrap/lifecycle.ts', 'app/bootstrap/event-wiring.ts']) {
      const violations = findViolations([entry(file, `import { x } from '../bootstrap${ext}'\n`), ...facadeTarget])
      assert.equal(violations.length, 1, `${file} -> ../bootstrap${ext} must be rejected`)
      assert.equal(violations[0].rule, 'helper-imports-bootstrap-facade')
    }
  }
  // A type-only import is still an inverted dependency.
  for (const ext of spellings) {
    assert.equal(
      findViolations([entry('app/surface/runtime.ts', `import type { B } from '../../app/bootstrap/event-wiring${ext}'\n`), ...scanned]).length,
      1,
      `a type-only owner -> helper${ext} import must be rejected`,
    )
    assert.equal(
      findViolations([entry('app/bootstrap/lifecycle.ts', `import type { B } from '../bootstrap${ext}'\n`), ...facadeTarget]).length,
      1,
      `a type-only helper -> facade${ext} import must be rejected`,
    )
  }
})

test('the bootstrap composition zone may construct Direct wiring (TS2)', () => {
  // TS2 composition helpers may select/construct Direct adapters, exactly like
  // the facade: the allowance is the ZONE, not an allowlist of helper names.
  const zoneFiles = [
    'app/bootstrap.ts',
    'app/bootstrap/runtime-selection.ts',
    'app/bootstrap/task-source.ts',
    'app/bootstrap/presentation-bridge.ts',
  ]
  for (const file of zoneFiles) {
    for (const target of ['app/direct/runtime.ts', 'runtime/direct/task-read-direct.ts']) {
      const depth = file.split('/').length - 1
      const up = '../'.repeat(depth)
      assert.deepEqual(
        findViolations([entry(file, `import { direct } from '${up}${target}'\n`)]),
        [],
        `${file} must be allowed to import ${target}`,
      )
    }
    assert.equal(isDirectCompositionFile(file), true, `${file} belongs to the Direct composition zone`)
  }
  // A new helper module is recognized by DIRECTORY, so an extraction cannot
  // escape the zone rules by choosing a new file name.
  assert.equal(isDirectCompositionFile('app/bootstrap/brand-new-helper.ts'), true)
  // Outside the zone the rule is unchanged.
  assert.equal(isDirectCompositionFile('app/surface/runtime.ts'), false)
  assert.equal(isDirectCompositionFile('app/bootstrap-like.ts'), false)
  assert.equal(isDirectCompositionFile('bootstrap.ts'), false)
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

test('a .tsx module reached through a legal .js/.jsx spelling stays in the startup static graph (TS1)', () => {
  // TypeScript NodeNext resolves `./client/bridge.js` AND `./client/bridge.jsx`
  // to `client/bridge.tsx`; the gate must resolve the same edge, or the startup
  // compatibility island could re-enter Remote composition through a TSX file.
  for (const spelling of ['./client/bridge.js', './client/bridge.jsx']) {
    const entries = [
      entry('startup.ts', `export { bridge } from '${spelling}'\n`),
      entry('client/bridge.tsx', "export { remote } from '../app/remote/runtime.ts'\n"),
      entry('app/remote/runtime.ts', 'export const remote = 1\n'),
    ]
    assert.deepEqual([...buildStaticEdges(entries).get('startup.ts')], ['client/bridge.tsx'], spelling)
    const violations = findViolations(entries)
    assert.equal(violations.length, 1, spelling)
    assert.equal(violations[0].file, 'client/bridge.tsx')
    assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
  }
  // Positive control: the explicit `.tsx` spelling reports the same violation.
  const control = findViolations([
    entry('startup.ts', "export { bridge } from './client/bridge.tsx'\n"),
    entry('client/bridge.tsx', "export { remote } from '../app/remote/runtime.ts'\n"),
    entry('app/remote/runtime.ts', 'export const remote = 1\n'),
  ])
  assert.equal(control.length, 1)
  assert.equal(control[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
})

test('staticImportCandidates covers NodeNext emitted extensions', () => {
  assert.deepEqual(staticImportCandidates('runtime/x.js'), ['runtime/x.ts', 'runtime/x.tsx', 'runtime/x.d.ts', 'runtime/x.js'])
  assert.deepEqual(staticImportCandidates('runtime/x.jsx'), ['runtime/x.tsx', 'runtime/x.ts', 'runtime/x.d.ts', 'runtime/x.jsx'])
  assert.deepEqual(staticImportCandidates('runtime/x.mjs'), ['runtime/x.mts', 'runtime/x.d.mts', 'runtime/x.mjs'])
  assert.deepEqual(staticImportCandidates('runtime/x.cjs'), ['runtime/x.cts', 'runtime/x.d.cts', 'runtime/x.cjs'])
  assert.deepEqual(staticImportCandidates('runtime/x.ts'), ['runtime/x.ts'])
  assert.deepEqual(staticImportCandidates('runtime/x.tsx'), ['runtime/x.tsx'])
  assert.deepEqual(staticImportCandidates('runtime/x.d.mts'), ['runtime/x.d.mts'])
  assert.deepEqual(staticImportCandidates('runtime/x'), [
    'runtime/x.ts',
    'runtime/x.tsx',
    'runtime/x.mts',
    'runtime/x.cts',
    'runtime/x.d.ts',
    'runtime/x.d.mts',
    'runtime/x.d.cts',
    'runtime/x/index.ts',
    'runtime/x/index.tsx',
    'runtime/x/index.d.ts',
  ])
})

test('staticImportCandidates agrees with TypeScript NodeNext resolution for every legal spelling', (t) => {
  const life = testLifecycle(t)
  const dir = life.tempDir('pre-m3-nodenext-')
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  writeFileSync(join(dir, 'b.d.mts'), 'export const b = 1\n')
  writeFileSync(join(dir, 'c.cts'), 'export const c = 1\n')
  // A `.tsx` module is a legal NodeNext target of BOTH `.js` and `.jsx`
  // spellings — and of `./x.js` when a `.ts` sibling does not exist.
  writeFileSync(join(dir, 'view.tsx'), 'export const view = 1\n')
  writeFileSync(join(dir, 'both.ts'), 'export const both = 1\n')
  writeFileSync(join(dir, 'both.tsx'), 'export const bothX = 1\n')
  writeFileSync(join(dir, 'fallback.ts'), 'export const fallback = 1\n')
  writeFileSync(join(dir, 'entry.ts'), '')
  const options = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.Preserve,
  }
  for (const [specifier, expected] of [
    ['./a.js', 'a.ts'],
    ['./b.mjs', 'b.d.mts'],
    ['./c.cjs', 'c.cts'],
    ['./view.js', 'view.tsx'],
    ['./view.jsx', 'view.tsx'],
    ['./both.js', 'both.ts'],
    ['./both.jsx', 'both.tsx'],
    ['./fallback.jsx', 'fallback.ts'],
  ]) {
    const resolved = ts.resolveModuleName(specifier, join(dir, 'entry.ts'), options, ts.sys).resolvedModule?.resolvedFileName
    assert.ok(resolved !== undefined, `${specifier} must resolve under NodeNext`)
    const rel = relative(dir, resolved).split('\\').join('/')
    assert.equal(rel, expected)
    const candidates = staticImportCandidates(specifier.slice(2))
    assert.ok(
      candidates.includes(rel),
      `staticImportCandidates(${specifier.slice(2)}) must include the TypeScript-resolved ${rel}`,
    )
    // The FIRST on-disk candidate must be the file TypeScript actually picks:
    // a wrong order would canonicalize the edge to a different module.
    const onDisk = candidates.filter(candidate => existsSync(join(dir, candidate)))
    assert.equal(onDisk[0], rel, `staticImportCandidates(${specifier.slice(2)}) must resolve to ${rel} first (got ${onDisk[0]})`)
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

test('the AST scanners are file-kind aware: a legal .tsx JSX tree is not a bypass (TS1)', () => {
  // A real TSX parse (ScriptKind.TSX) finds the import-type query inside JSX;
  // the same source under ScriptKind.TS would yield no import at all.
  const jsx = [
    'export const view = (',
    "  <Box value={null as import('../../app/remote/runtime.ts').Remote} />",
    ')',
    '',
  ].join('\n')
  assert.deepEqual(parseImportSpecifiers(jsx, 'tui/panels/example.tsx'), [
    { specifier: '../../app/remote/runtime.ts', line: 2, typeOnly: true },
  ])
  // The gate consumer rejects it through the TUI-layer rule.
  const violations = findViolations([entry('tui/panels/example.tsx', jsx)])
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'tui-imports-remote-composition')
  // Type-only JSX children and a value dynamic import inside JSX are seen too.
  const dynamic = "export const lazy = () => <Box onClick={() => import('../../app/remote/client-runtime.ts')} />\n"
  assert.deepEqual(parseValueDynamicImports(dynamic, 'tui/panels/example.tsx'), [
    { specifier: '../../app/remote/client-runtime.ts', line: 1 },
  ])
  assert.equal(findRemoteDynamicImportViolations([entry('tui/panels/example.tsx', dynamic)]).length, 1)
  // The legacy TS grammar (generics / angle-bracket assertions) still parses as
  // TS — `.ts` files must never be forced into TSX mode.
  const legacyTs = [
    'import { x } from "./dep.ts"',
    'const w = new (<Constructor>DirectSessionWriter)(deps)',
    '',
  ].join('\n')
  assert.deepEqual(parseImportSpecifiers(legacyTs, 'app/surface/runtime.ts'), [
    { specifier: './dep.ts', line: 1, typeOnly: false },
  ])
  assert.deepEqual(findDirectAdapterConstructions(legacyTs, 'app/surface/runtime.ts'), [
    { name: 'DirectSessionWriter', line: 2 },
  ])
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
  mkdirSync(join(dir, 'tui', 'panels'), { recursive: true })
  writeFileSync(join(dir, 'app', 'session', 'runtime.ts'), 'export const x = 1\n')
  writeFileSync(join(dir, 'top.ts'), 'export const y = 2\n')
  writeFileSync(join(dir, 'decl.d.mts'), 'export const d: number\n')
  writeFileSync(join(dir, 'legacy.cts'), 'export const c = 1\n')
  // `.tsx` is part of the scanned production population (never a gate bypass).
  writeFileSync(join(dir, 'panel.tsx'), 'export const p = 1\n')
  writeFileSync(join(dir, 'tui', 'panels', 'card.tsx'), 'export const card = 1\n')
  const entries = collectSourceEntries(dir)
  assert.deepEqual(entries.map(e => e.rel), [
    'app/session/runtime.ts',
    'decl.d.mts',
    'legacy.cts',
    'panel.tsx',
    'top.ts',
    'tui/panels/card.tsx',
  ])
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

test('the widened Remote composition specifier rule recognizes every Remote face class (M3-1)', () => {
  for (const specifier of [
    // Root client-/api- packages (the pre-M3 rule).
    '@deepseek-ai/dsh-client-connection',
    '@deepseek-ai/dsh-api-gateway',
    '@deepseek-ai/dsh-api-session-controller',
    // Remote Client face subpaths of ANY dsh package.
    '@deepseek-ai/dsh-api-session-controller/remote',
    '@deepseek-ai/dsh-api-job-controller/remote',
    '@deepseek-ai/dsh-commands/remote',
    '@deepseek-ai/dsh-subagent/remote',
    '@deepseek-ai/dsh-agent-preset-registry/remote',
    '@deepseek-ai/dsh-plugin-manager/remote',
    '@deepseek-ai/dsh-api-settings-controller/remote',
    '@deepseek-ai/dsh-permission-presets/remote',
    '@deepseek-ai/dsh-llm/remote',
    '@deepseek-ai/dsh-client-file-upload/remote',
    // Web module-loader Client bundles.
    '@deepseek-ai/dsh-typert-registry/client',
    '@deepseek-ai/dsh-api-session-controller/client',
  ]) {
    assert.ok(REMOTE_COMPOSITION_SPECIFIER.test(specifier), `${specifier} is Remote composition`)
    assert.ok(isRemoteComposition('somewhere/unrelated.ts', specifier), `${specifier} must classify via specifier`)
  }
  for (const specifier of [
    '@deepseek-ai/dsh-web-app',
    '@deepseek-ai/dsh-commands',
    '@deepseek-ai/dsh-session',
    '@deepseek-ai/dsh-agent-preset-registry',
    '@deepseek-ai/dsh-settings/types',
    '@deepseek-ai/dsh-agent-loop-testkit',
    '@deepseek-ai/cordis',
  ]) {
    assert.equal(REMOTE_COMPOSITION_SPECIFIER.test(specifier), false, `${specifier} is an ordinary Host import`)
  }
})

test('app/remote/** is classified as experimental Remote composition by path (M3-1)', () => {
  assert.ok(isRemoteComposition('app/remote/host-runtime.ts', './host-runtime.ts'))
  assert.ok(isRemoteComposition('app/remote/client-runtime.ts', './client-runtime.ts'))
  assert.ok(isRemoteComposition('app/remote/runtime.ts', './runtime.ts'))
  assert.ok(isRemoteComposition('runtime/remote/session-reader-remote.ts', './session-reader-remote.ts'))
  assert.equal(isRemoteComposition('app/session/runtime.ts', './runtime.ts'), false)
  assert.equal(isRemoteComposition('runtime/backend-loader.ts', './backend-loader.ts'), false)
})

test('startup.ts statically reaching app/remote/** is rejected through an intermediate module (M3-1)', () => {
  const entries = [
    entry('startup.ts', "import { ready } from './startup-support.ts'\n"),
    entry('startup-support.ts', "import { runtime } from './app/remote/runtime.ts'\n"),
    entry('app/remote/runtime.ts', 'export const runtime = 1\n'),
  ]
  const violations = findViolations(entries)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].file, 'startup-support.ts')
  assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
  assert.match(violations[0].detail, /app\/remote\/runtime\.ts/)
})

test('startup.ts statically reaching dsh /client or /remote faces through a helper is rejected (M3-1)', () => {
  for (const specifier of ['@deepseek-ai/dsh-typert-registry/client', '@deepseek-ai/dsh-commands/remote']) {
    const entries = [
      entry('startup.ts', "import { ready } from './startup-support.ts'\n"),
      entry('startup-support.ts', `import { face } from '${specifier}'\n`),
    ]
    const violations = findViolations(entries)
    assert.equal(violations.length, 1, specifier)
    assert.equal(violations[0].file, 'startup-support.ts')
    assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
  }
})

test('startup importing the backend loader alone is fine; its value dynamic import is not a static edge (M3-1)', () => {
  const entries = [
    entry('startup.ts', "import { loadExperimentalRemoteRuntime } from './runtime/backend-loader.ts'\n"),
    entry(
      'runtime/backend-loader.ts',
      `export function loadExperimentalRemoteRuntime() {\n  return import('../app/remote/runtime.ts')\n}\n`,
    ),
    entry('app/remote/runtime.ts', 'export const runtime = 1\n'),
  ]
  assert.deepEqual(findViolations(entries), [])
  // The NodeNext emitted-extension spelling canonicalizes to the same target.
  const jsSpelling = findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export function load() {\n  return import('../app/remote/runtime.js')\n}\n`,
    ),
    entry(REMOTE_DYNAMIC_IMPORT_TARGET, 'export const runtime = 1\n'),
  ])
  assert.deepEqual(jsSpelling, [])
})

test('the sanctioned lazy boundary is the only value dynamic-import owner into app/remote/** (M3-1)', () => {
  const allowed = findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export function load() {\n  return import('../app/remote/runtime.js')\n}\n`,
    ),
    entry(REMOTE_DYNAMIC_IMPORT_TARGET, 'export const runtime = 1\n'),
  ])
  assert.deepEqual(allowed, [])

  // Another src module dynamically importing the composition fails.
  const fromHelper = findRemoteDynamicImportViolations([
    entry('app/bootstrap.ts', "export async function boot() {\n  return await import('./remote/runtime.js')\n}\n"),
    entry('app/remote/runtime.ts', 'export const runtime = 1\n'),
  ])
  assert.equal(fromHelper.length, 1)
  assert.equal(fromHelper[0].file, 'app/bootstrap.ts')
  assert.equal(fromHelper[0].rule, 'remote-dynamic-import-owner')
  assert.equal(fromHelper[0].line, 2)

  // Even the sanctioned owner cannot dynamically import another app/remote module.
  const ownerOtherTarget = findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export function load() {\n  return import('../app/remote/client-runtime.js')\n}\n`,
    ),
    entry('app/remote/client-runtime.ts', 'export const clientRuntime = 1\n'),
  ])
  assert.equal(ownerOtherTarget.length, 1)
  assert.equal(ownerOtherTarget[0].rule, 'remote-dynamic-import-owner')

  // Dynamic imports outside the Remote composition boundary stay out of scope.
  assert.deepEqual(findRemoteDynamicImportViolations([
    entry('app/direct/x.ts', "const m = await import('../../runtime/direct/backend-direct.js')\n"),
    entry('runtime/direct/backend-direct.ts', 'export const backend = 1\n'),
    entry('app/remote/client-runtime.ts', "const bundle = await import('@deepseek-ai/dsh-typert-registry/client')\n"),
  ]), [])
})

test('the M3-4 application-runtime aggregate joins through the SINGLE dynamic entry, not a second target (M3-4 PR1)', () => {
  // The one sanctioned edge covers BOTH composition entries: the loader
  // imports app/remote/runtime.ts, which statically re-exports the aggregate.
  assert.deepEqual(findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export function loadRemoteApplicationRuntime() {\n  return import('../app/remote/runtime.ts').then(m => ({ createRemoteApplicationRuntime: m.createRemoteApplicationRuntime }))\n}\n`,
    ),
    entry(REMOTE_DYNAMIC_IMPORT_TARGET, "export { createRemoteApplicationRuntime } from './application-runtime.ts'\n"),
    entry('app/remote/application-runtime.ts', 'export async function createRemoteApplicationRuntime() {}\n'),
  ]), [])

  // A SECOND dynamic target under the owner — even the aggregate itself —
  // violates the frozen ONE-edge contract.
  const secondTarget = findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export function loadRemoteApplicationRuntime() {\n  return import('../app/remote/application-runtime.ts')\n}\n`,
    ),
    entry('app/remote/application-runtime.ts', 'export async function createRemoteApplicationRuntime() {}\n'),
  ])
  assert.equal(secondTarget.length, 1, 'a second dynamic target must fail')
  assert.equal(secondTarget[0].rule, 'remote-dynamic-import-owner')

  // A SECOND import expression for the SAME sanctioned target is also a
  // violation: "ONE dynamic edge" is one owner + ONE expression + one target
  // (enforced by the gate function itself, not only by the real-tree test).
  const duplicateExpression = findRemoteDynamicImportViolations([
    entry(
      REMOTE_DYNAMIC_IMPORT_OWNER,
      `export const a = () => import('../app/remote/runtime.ts')\nexport const b = () => import('../app/remote/runtime.ts')\n`,
    ),
    entry(REMOTE_DYNAMIC_IMPORT_TARGET, 'export const runtime = 1\n'),
  ])
  assert.equal(duplicateExpression.length, 1, 'a duplicate expression for the sanctioned target must fail')
  assert.equal(duplicateExpression[0].rule, 'remote-dynamic-import-owner')
  assert.match(duplicateExpression[0].detail, /exactly ONE dynamic import expression/)

  // bootstrap may statically import the loader (the selection seam's reach),
  // and the loader's dynamic import is not a static edge — the Remote graph
  // stays unreachable from startup.ts.
  const entries = [
    entry('startup.ts', "import { applyRunner } from './index.ts'\n"),
    entry('index.ts', "import { applyRunner } from './app/bootstrap.ts'\n"),
    entry('app/bootstrap.ts', "import { loadRemoteApplicationRuntime } from '../runtime/backend-loader.ts'\n"),
    entry(
      'runtime/backend-loader.ts',
      `export function loadRemoteApplicationRuntime() {\n  return import('../app/remote/runtime.ts').then(m => ({ createRemoteApplicationRuntime: m.createRemoteApplicationRuntime }))\n}\n`,
    ),
    entry('app/remote/runtime.ts', "export { createRemoteApplicationRuntime } from './application-runtime.ts'\n"),
    entry('app/remote/application-runtime.ts', 'export const applicationRuntime = 1\n'),
  ]
  assert.deepEqual(findViolations(entries), [], 'bootstrap -> backend-loader -> dynamic app/remote/runtime.ts is the sanctioned M3-4 shape')

  // Any other module dynamically importing the composition still fails.
  const other = findRemoteDynamicImportViolations([
    entry('app/surface/runtime.ts', "const m = await import('../../app/remote/runtime.js')\n"),
    entry('app/remote/runtime.ts', 'export const runtime = 1\n'),
  ])
  assert.equal(other.length, 1)
  assert.equal(other[0].rule, 'remote-dynamic-import-owner')
})

test('the REAL production tree carries the bootstrap composition zone -> backend-loader edge, ONE dynamic target, and stays Remote-clean (M3-4 PR1 / TS2)', () => {
  // The M3-4 selection seam is not a synthetic allowance: the TS2 composition
  // zone statically imports the loader — the facade re-exports nothing, the
  // `app/bootstrap/runtime-selection.ts` helper owns the reach — the loader owns
  // the only dynamic edge into app/remote/**, and the whole production tree
  // stays violation-free (the startup graph included — verified by the full
  // findViolations scan in the other real-tree tests).
  const selectionRel = 'app/bootstrap/runtime-selection.ts'
  const selection = collectSourceEntries().find(e => e.rel === selectionRel)
  assert.ok(selection !== undefined, `${selectionRel} must exist in the scanned tree`)
  const edges = parseImportSpecifiers(selection.source, selectionRel)
    .map(spec => resolveRelativeImport(selectionRel, spec.specifier))
    .filter(resolved => resolved === 'runtime/backend-loader.ts')
  assert.equal(edges.length, 1, `the real selection seam statically imports runtime/backend-loader.ts exactly once (the M3-4 seam reach)`)
  const loader = collectSourceEntries().find(e => e.rel === REMOTE_DYNAMIC_IMPORT_OWNER)
  assert.ok(loader !== undefined, 'runtime/backend-loader.ts must exist in the scanned tree')
  const dynamicTargets = parseValueDynamicImports(loader.source)
    .map(({ specifier }) => resolveRelativeImport(REMOTE_DYNAMIC_IMPORT_OWNER, specifier))
    .filter(resolved => resolved !== undefined && resolved.startsWith('app/remote/'))
  assert.deepEqual(dynamicTargets, [REMOTE_DYNAMIC_IMPORT_TARGET],
    'the real loader has EXACTLY ONE dynamic import into app/remote/** (the single entry module)')
  // The entry module statically re-exports the aggregate (intra-app/remote).
  const entryModule = collectSourceEntries().find(e => e.rel === REMOTE_DYNAMIC_IMPORT_TARGET)
  assert.ok(entryModule !== undefined && /export\s*\{[^}]*createRemoteApplicationRuntime[^}]*\}\s*from\s*'\.\/application-runtime\.ts'/.test(entryModule.source),
    'app/remote/runtime.ts must statically re-export the aggregate constructor (the single-entry join)')
  const tree = collectSourceEntries()
  assert.deepEqual(findViolations(tree), [], 'the real tree stays clean with the real seam edge')
  assert.deepEqual(findRemoteDynamicImportViolations(tree), [], 'the real tree keeps the exact dynamic-import owner and single target')
})

test('the test-support production scan mirrors the gate extension set and parser kind (TS2 §19)', () => {
  // `test/support/owner-modules.ts` is TypeScript and cannot import this
  // unchecked `.mjs` gate script, so it mirrors the two facts below. The mirror
  // is only safe while it is provably identical — hence this drift guard: a
  // `.tsx` (or `.mts`/`.cts`) production module must be seen by the whole-tree
  // duplicate detectors with the SAME parser kind the production gate uses.
  assert.deepEqual(
    [...PRODUCTION_SOURCE_EXTENSIONS],
    SOURCE_EXTENSIONS,
    'the test-support production scan must cover exactly the extensions the gate scans',
  )
  for (const rel of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
    assert.equal(productionScriptKind(rel), scriptKindOf(rel), `${rel} must use the gate's parser kind`)
  }
  assert.notEqual(scriptKindOf('a.tsx'), scriptKindOf('a.ts'), 'a .tsx module must not parse as plain TS')
})

test('the domain layer is transport/UI-neutral and the app/plugin owners stay off Direct implementations (TS3)', () => {
  // TS3 §24/§42/§67. Each case lists the EXACT rule ids that must fire (most
  // have exactly one owner rule; a runtime module reaching a bootstrap helper is
  // an inversion of two independent rules). The `rel` values are RELATIVE TO
  // `src/` — the same convention `collectSourceEntries()` produces — so a
  // `src/...` spelling would silently match NO rule and the case would assert
  // nothing.
  const cases = [
    ['domain/status/foo.ts', '../../app/surface/runtime.ts', ['domain-imports-app']],
    ['domain/status/foo.ts', '../../tui/commands/status.ts', ['domain-imports-tui']],
    ['domain/status/foo.ts', '../../app/remote/runtime.ts', ['domain-imports-remote-composition']],
    ['domain/status/foo.ts', '../../runtime/remote/session-reader-remote.ts', ['domain-imports-remote-composition']],
    ['app/plugin-manager/controller.ts', '../../runtime/direct/plugin-manager-direct.ts', ['direct-import-outside-composition']],
    ['app/session/foo.ts', '../bootstrap/lifecycle.ts', ['owner-imports-bootstrap']],
    ['app/surface/foo.ts', '../bootstrap/event-wiring.ts', ['owner-imports-bootstrap']],
    // A runtime module reaching a bootstrap helper is BOTH a runtime->app
    // inversion and a composition-zone inversion: two independent rules answer
    // two different questions, so both are reported.
    ['runtime/foo.ts', '../app/bootstrap/runtime-selection.ts', ['runtime-imports-app', 'owner-imports-bootstrap']],
  ]
  for (const [file, specifier, rules] of cases) {
    const violations = findViolations([entry(file, `import { x } from '${specifier}'\n`)])
    assert.deepEqual([...violations.map(v => v.rule)].sort(), [...rules].sort(),
      `${file} -> ${specifier} must fail as ${rules.join(' + ')} only`)
  }
  // Positive controls: the sanctioned edges stay open.
  const allowed = [
    // The bootstrap composition zone may construct Direct adapters.
    ['app/bootstrap/task-source.ts', '../../runtime/direct/task-read-direct.ts'],
    // The Plugin Manager APPLICATION owner consumes its semantic port.
    ['app/plugin-manager/controller.ts', '../../runtime/plugin-manager-port.ts'],
    // The neutral domain layer may consume neutral runtime port contracts.
    ['domain/status/foo.ts', '../../runtime/session-reader-port.ts'],
  ]
  for (const [file, specifier] of allowed) {
    // Each positive control is anchored by a NEGATIVE case above, so "allowed"
    // can never be satisfied vacuously by a rule that does not run: the
    // domain-file Direct/Remote imports, the plugin-manager Direct import and the
    // runtime -> app import all fail in the `cases` table.
    assert.deepEqual(
      findViolations([entry(file, `import { x } from '${specifier}'\n`)]),
      [],
      `${file} -> ${specifier} must stay allowed`,
    )
  }
})

test('parseValueDynamicImports reports only value import() calls with literal specifiers', () => {
  const specs = parseValueDynamicImports(
    [
      "const a = await import('./a.ts')",
      'const b = await import(dynamic)',
      "// const c = await import('./c.ts')",
      "type T = import('./d.ts').T",
      "import { e } from './e.ts'",
    ].join('\n'),
  )
  assert.deepEqual(specs, [{ specifier: './a.ts', line: 1 }])
})

test('findViolations includes the Remote dynamic-import owner rule in the production tree scan', () => {
  const tree = collectSourceEntries()
  const dynamicOnly = findRemoteDynamicImportViolations(tree)
  assert.deepEqual(dynamicOnly, [], 'the real production tree must satisfy the dynamic-import owner rule')
  assert.deepEqual(findViolations(tree), [], 'the full production scan stays clean with the M3-1 rules')
})

test('the TUI layer must not import experimental Remote composition (TS1)', () => {
  // TS1 created the first long-lived `src/tui/**` layer: terminal presentation
  // consumes semantic/application-facing contracts only.
  const tuiFiles = [
    'tui/foo.ts',
    // `.tsx` is covered by the same dependency rules — never a bypass.
    'tui/panels/example.tsx',
    'tui/commands/settings.ts',
    'tui/commands/sessions.ts',
    'tui/commands/models.ts',
    'tui/commands/skills.ts',
    'tui/commands/tasks.ts',
    'tui/commands/artifacts.ts',
    'tui/commands/status.ts',
    'tui/commands/auth.ts',
    'tui/commands/utility.ts',
    // The transitional command-layer facade/coordinator stays in the TUI-layer
    // rule's scope (strictly stronger than the plan's `tui/**` minimum).
    'commands.ts',
  ]
  const relativeTo = (file, target) => (file.includes('/') ? '../'.repeat(file.split('/').length - 1) : './') + target
  for (const file of tuiFiles) {
    for (const target of ['runtime/remote/session-reader-remote.ts', 'app/remote/runtime.ts', 'app/remote/application-runtime.ts']) {
      const violations = findViolations([entry(file, `import { x } from '${relativeTo(file, target)}'\n`)])
      assert.equal(violations.length, 1, `${file} -> ${target} must be rejected`)
      assert.equal(violations[0].rule, 'tui-imports-remote-composition')
    }
    for (const specifier of [
      '@deepseek-ai/dsh-commands/remote',
      '@deepseek-ai/dsh-client-connection',
      '@deepseek-ai/dsh-typert-registry/client',
    ]) {
      const violations = findViolations([entry(file, `import { x } from '${specifier}'\n`)])
      assert.equal(violations.length, 1, `${file} -> ${specifier} must be rejected`)
      assert.equal(violations[0].rule, 'tui-imports-remote-composition')
    }
  }
  // Normal semantic ports, application owners and protocol/capability surfaces
  // stay allowed — the rule forbids the Remote IMPLEMENTATION, not the layer.
  for (const [file, target] of [
    ['commands.ts', 'runtime/catalog-port.ts'],
    ['tui/commands/settings.ts', 'runtime/config-port.ts'],
    ['tui/commands/sessions.ts', 'app/session/scope.ts'],
    ['tui/commands/models.ts', 'app/command/client-command-registry.ts'],
    ['tui/commands/auth.ts', 'app/command/client-command-registry.ts'],
  ]) {
    assert.deepEqual(
      findViolations([entry(file, `import type { T } from '${relativeTo(file, target)}'\n`)]),
      [],
      `${file} -> ${target} stays allowed`,
    )
  }
  // A TYPE-ONLY Remote import is still Remote composition.
  assert.equal(
    findViolations([entry('tui/commands/models.ts', "import type { Remote } from '../../app/remote/runtime.ts'\n")]).length,
    1,
    'a type-only Remote import must be rejected too',
  )
})

test('the semantic runtime layer must not import terminal presentation (TS1)', () => {
  for (const file of ['runtime/foo.ts', 'runtime/direct/backend-direct.ts', 'runtime/remote/x.ts']) {
    const up = '../'.repeat(file.split('/').length - 1)
    const violations = findViolations([entry(file, `import { x } from '${up}tui/commands/settings.ts'\n`)])
    assert.equal(violations.length, 1, `${file} -> tui/** must be rejected`)
    assert.equal(violations[0].rule, 'runtime-imports-tui')
  }
  // runtime -> its own semantic ports and the app layer keeps its existing rule.
  assert.deepEqual(findViolations([entry('runtime/catalog-port.ts', "import type { T } from '../runtime/backend.ts'\n")]), [])
})

test('the source-root baseline accepts the exact captured tree and fails closed on every drift (TS1 §20.3)', (t) => {
  const baseline = readSourceRootBaseline()
  const current = listSourceRootFiles()
  assert.deepEqual(findSourceRootViolations(baseline, current), [],
    'the checked-in baseline must match the exact current root module set')
  // The stable set is the deliberate root facade contract; legacy is the
  // mechanically generated remainder (no hand selection).
  assert.deepEqual(baseline.stable, ['commands.ts', 'index.ts', 'startup.ts', 'transcript.ts', 'tui-app.ts'])
  assert.deepEqual(baseline.legacy, current.filter(name => !baseline.stable.includes(name)))
  assert.equal(baseline.legacy.length > 0, true, 'legacy entries exist during the train')
  // Mutation fixtures: never touch the real baseline.
  const mutated = (patch) => findSourceRootViolations({ ...baseline, ...patch }, current)
  assert.match(mutated({ legacy: [...baseline.legacy, 'new-feature.ts'] }).join('\n'), /new-feature\.ts/,
    'a new ordinary root module must FAIL when it is neither in stable nor legacy')
  assert.match(
    findSourceRootViolations(baseline, [...current, 'new-feature.ts']).join('\n'),
    /new unclassified root production module: src\/new-feature\.ts/,
    'a new on-disk root module must FAIL')
  assert.match(
    findSourceRootViolations(baseline, [...current, 'new-feature.tsx']).join('\n'),
    /new unclassified root production module: src\/new-feature\.tsx/,
    'a new on-disk .tsx root module must FAIL too (the ledger is not .tsx-bypassable)')
  assert.match(
    mutated({ legacy: [...baseline.legacy, 'moved-away.ts'] }).join('\n'),
    /stale baseline entry: src\/moved-away\.ts/,
    'a legacy entry that no longer exists must FAIL as a stale baseline')
  assert.match(
    findSourceRootViolations(baseline, current.filter(name => name !== 'commands.ts')).join('\n'),
    /stable root entry missing: src\/commands\.ts/,
    'a missing stable facade must FAIL')
  assert.match(
    mutated({ legacy: [...baseline.legacy, 'index.ts'] }).join('\n'),
    /src\/index\.ts is listed in BOTH stable and legacy/,
    'a duplicate stable/legacy entry must FAIL')
  // Unknown schema/version fails closed.
  const life = testLifecycle(t)
  const dir = life.tempDir('ts1-root-baseline-')
  const badSchema = join(dir, 'bad.json')
  writeFileSync(badSchema, JSON.stringify({ version: 2, stable: ['index.ts'], legacy: [] }))
  assert.throws(() => readSourceRootBaseline(badSchema), /unsupported source-root baseline schema/)
  writeFileSync(badSchema, JSON.stringify({ version: 1, stable: ['index.ts'], legacy: [7] }))
  assert.throws(() => readSourceRootBaseline(badSchema), /unsupported source-root baseline schema/)
})
