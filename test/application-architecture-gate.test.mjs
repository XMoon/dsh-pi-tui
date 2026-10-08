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
  ARCHITECTURE_ALLOWLIST,
  ARCHITECTURE_RULES,
  buildStaticEdges,
  collectSourceEntries,
  findDirectAdapterConstructions,
  findConcreteRegistryPlacementViolations,
  findFinalSourceRootStateViolations,
  findRemoteDynamicImportViolations,
  findRetiredSourceDirectoryViolations,
  findRetiredSourceRootViolations,
  findSourceRootViolations,
  findStartupIslandViolations,
  findViolations,
  isBootstrapCompositionFile,
  isDirectCompositionFile,
  isDshImplementationPackage,
  isRemoteComposition,
  isRuntimeProcessSubtree,
  listSourceFilesUnder,
  listSourceRootDirectories,
  listSourceRootFiles,
  parseImportSpecifiers,
  parseValueDynamicImports,
  readSourceRootBaseline,
  REMOTE_COMPOSITION_SPECIFIER,
  REMOTE_DYNAMIC_IMPORT_OWNER,
  REMOTE_DYNAMIC_IMPORT_TARGET,
  resolveRelativeImport,
  RETIRED_SOURCE_DIRECTORIES,
  RETIRED_SOURCE_ROOTS,
  REMOTE_TO_DIRECT_APPROVED_BRIDGES,
  FINAL_STABLE_SOURCE_ROOTS,
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
    'tui/transcript/tool-presentation.ts',
    'tui/icons.ts',
    // TS6 moved the rendered-search mechanics under the PiTui component tree;
    // the rule is enumeration-free, so the sample follows the real owner.
    'tui/components/transcript/search-presentation.ts',
    'tui/file-completion/presentation.ts',
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
  //
  // CRITICAL fixture shape: `findViolations` keys imports by `rel`, so an
  // importer that ALSO appears in the scanned stub set has its own imports
  // overwritten by the stub and the positive control would assert NOTHING. Each
  // legal case therefore lists ONLY the target stub(s) it needs, and a paired
  // owner-importer negative proves the very same edge+target is really being
  // judged (so "allowed" can never mean "the rule never ran").
  //
  // Both halves are additionally CANONICALIZED against the known stub before the
  // assertion runs: a target/prefix pair that resolves somewhere else (e.g. the
  // facade row once generated `../bootstrap/lifecycle.ts`, which resolves to
  // `bootstrap/lifecycle.ts` rather than the intended `app/bootstrap/lifecycle.ts`)
  // fails LOUDLY here instead of silently re-asserting nothing.
  const legalCompositionEdges = [
    { file: 'index.ts', target: 'app/bootstrap', known: ['app/bootstrap.ts'], ownerTarget: '../bootstrap' },
    // `app/bootstrap.ts` -> `app/bootstrap/lifecycle.ts` (the facade consumes helpers).
    { file: 'app/bootstrap.ts', target: 'app/bootstrap/lifecycle', known: ['app/bootstrap/lifecycle.ts'], ownerTarget: '../bootstrap/lifecycle' },
    // sibling helper -> helper.
    { file: 'app/bootstrap/runtime-selection.ts', target: 'app/bootstrap/lifecycle', known: ['app/bootstrap/lifecycle.ts'], ownerTarget: '../bootstrap/lifecycle' },
  ]
  const ownerImporter = 'app/surface/runtime.ts'
  const resolvesToStub = (importer, specifier, stub) =>
    staticImportCandidates(resolveRelativeImport(importer, specifier)).includes(stub)
  for (const { file, target, known, ownerTarget } of legalCompositionEdges) {
    const depth = file.split('/').length - 1
    const prefix = depth === 0 ? './' : '../'.repeat(depth)
    assert.equal(known.includes(file), false, `${file} must not also be a scanned stub (it would overwrite its own imports)`)
    assert.equal(known.length, 1, 'each legal case pairs with exactly ONE known stub')
    const knownEntries = known.map(rel => entry(rel, 'export const stub = 1\n'))
    assert.ok(
      resolvesToStub(file, `${prefix}${target}.ts`, known[0]),
      `${file} -> ${prefix}${target}.ts must canonically resolve to the known stub ${known[0]}`,
    )
    assert.ok(
      resolvesToStub(ownerImporter, `${ownerTarget}.ts`, known[0]),
      `${ownerImporter} -> ${ownerTarget}.ts must target the SAME stub ${known[0]}`,
    )
    for (const ext of spellings) {
      const specifier = `${prefix}${target}${ext}`
      assert.deepEqual(
        findViolations([entry(file, `import { bootstrap } from '${specifier}'\n`), ...knownEntries]),
        [],
        `${file} must stay allowed to import ${specifier}`,
      )
      // Paired negative on the SAME target: an owner importer is rejected.
      const ownerSpecifier = `${ownerTarget}${ext}`
      const ownerViolations = findViolations([entry(ownerImporter, `import { x } from '${ownerSpecifier}'\n`), ...knownEntries])
      assert.equal(ownerViolations.length, 1, `${ownerImporter} -> ${ownerSpecifier} must be rejected`)
      assert.equal(ownerViolations[0].rule, 'owner-imports-bootstrap')
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

test('the production tree has no non-composition Direct import (the historical allowlist is gone)', () => {
  // TS8-F2 moved the legacy settings migration into the composition zone and
  // removed the historical exception, so no non-composition module may import
  // Direct wiring at all — with or without an allowlist.
  assert.deepEqual(
    findViolations(collectSourceEntries(), { allowlist: [] }).map(v => `${v.file}:${v.rule}`),
    [],
    'no non-composition Direct import may remain',
  )
  assert.deepEqual(ARCHITECTURE_ALLOWLIST, [], 'the checked-in allowlist is empty')
  assert.deepEqual(findViolations(collectSourceEntries()), [])
})

test('an allowlist entry excuses only a TYPE-ONLY import, never a value import', () => {
  const file = 'app/command/surface.ts'
  const target = 'runtime/direct/tui-settings-direct.ts'
  const specifier = `../../${target}`
  const allowlist = [`${file}:${target}`]
  assert.deepEqual(
    findViolations([entry(file, `import type { T } from '${specifier}'\n`)], { allowlist }),
    [],
    'the type-only import must be excused',
  )
  const valueImport = findViolations([entry(file, `import { T } from '${specifier}'\n`)], { allowlist })
  assert.equal(valueImport.length, 1, 'a value import of the same target must still fail')
  assert.equal(valueImport[0].rule, 'direct-import-outside-composition')
  const inlineTypeOnly = findViolations([entry(file, `import { type T } from '${specifier}'\n`)], { allowlist })
  assert.deepEqual(inlineTypeOnly, [], 'an all-inline-type import is type-only too (the historical allowance semantics)')
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
  // TypeScript NodeNext resolves `./compat/bridge.js` AND `./compat/bridge.jsx`
  // to `compat/bridge.tsx`; the gate must resolve the same edge, or the startup
  // compatibility island could re-enter Remote composition through a TSX file.
  // The fixture deliberately avoids a layer directory that owns its own rules
  // (e.g. `client/**`), so this case reports the startup rule and nothing else.
  for (const spelling of ['./compat/bridge.js', './compat/bridge.jsx']) {
    const entries = [
      entry('startup.ts', `export { bridge } from '${spelling}'\n`),
      entry('compat/bridge.tsx', "export { remote } from '../app/remote/runtime.ts'\n"),
      entry('app/remote/runtime.ts', 'export const remote = 1\n'),
    ]
    assert.deepEqual([...buildStaticEdges(entries).get('startup.ts')], ['compat/bridge.tsx'], spelling)
    const violations = findViolations(entries)
    assert.equal(violations.length, 1, spelling)
    assert.equal(violations[0].file, 'compat/bridge.tsx')
    assert.equal(violations[0].rule, STARTUP_REMOTE_COMPOSITION_RULE.id)
  }
  // Positive control: the explicit `.tsx` spelling reports the same violation.
  const control = findViolations([
    entry('startup.ts', "export { bridge } from './compat/bridge.tsx'\n"),
    entry('compat/bridge.tsx', "export { remote } from '../app/remote/runtime.ts'\n"),
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
  assert.deepEqual(parseImportSpecifiers("type U = typeof import('./y.ts')\n"), [{ specifier: './y.ts', line: 1, typeOnly: true, moduleTypeOnly: true }])
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
    { specifier: '../../app/remote/runtime.ts', line: 2, typeOnly: true, moduleTypeOnly: true },
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
    { specifier: './dep.ts', line: 1, typeOnly: false, moduleTypeOnly: false },
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
  assert.deepEqual(specs, [{ specifier: './app/direct/x.ts', line: 1, typeOnly: false, moduleTypeOnly: false }])
})

test('a multi-line block comment containing an import is ignored', () => {
  const specs = parseImportSpecifiers(
    ['/*', "import { x } from './app/direct/x.ts'", '*/', "import { y } from './y.ts'", ''].join('\n'),
  )
  assert.deepEqual(specs, [{ specifier: './y.ts', line: 4, typeOnly: false, moduleTypeOnly: false }])
})

test('the allowlist suppresses exactly the matching file:target pair', () => {
  const file = 'app/command/surface.ts'
  const target = 'runtime/direct/tui-settings-direct.ts'
  const entries = [entry(file, `import type { T } from '../../${target}'\n`)]
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
    // TS8-A: the Client-local capability is the inner layer and the neutral
    // domain never depends on it; the Client never reaches into Host
    // transport/composition (Direct is closed by its own rule below).
    ['domain/file-completion/query.ts', '../../client/file-completion/local-discovery.ts', ['domain-imports-client']],
    // TS8-B: the Host semantic/adaptor layer must never depend on the
    // Client-local capability (the inner platform layer, like app/tui).
    ['runtime/direct/foo.ts', '../../client/file-completion/local-discovery.ts', ['runtime-imports-client']],
    ['client/file-completion/local-discovery.ts', '../../runtime/remote/session-reader-remote.ts', ['client-imports-remote-composition']],
    ['client/file-completion/local-discovery.ts', '../../app/remote/runtime.ts', ['client-imports-remote-composition']],
    ['client/file-completion/local-discovery.ts', '../../runtime/direct/file-completion/host-discovery.ts', ['direct-import-outside-composition']],
    // TS8-C: the same four directions on the canonical media/platform owners.
    // The neutral domain may not depend on the Client capability, the Host
    // semantic layer may not depend on it, and the Client capability may not
    // reach Direct wiring or the Remote composition.
    ['domain/media/foo.ts', '../../client/media/image/types.ts', ['domain-imports-client']],
    ['runtime/remote/foo.ts', '../../client/media/image/loader.ts', ['runtime-imports-client']],
    ['client/media/image/loader.ts', '../../../runtime/direct/session-archive-direct.ts', ['direct-import-outside-composition']],
    ['client/media/image/loader.ts', '../../../runtime/remote/session-reader-remote.ts', ['client-imports-remote-composition']],
    ['client/clipboard/read.ts', '../../app/remote/runtime.ts', ['client-imports-remote-composition']],
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
    // TS8-A: the canonical file-completion directions — Client/TUI consume the
    // neutral domain policy, the application owner consumes the Client
    // capability, and the Direct adapter consumes the same neutral domain.
    ['client/file-completion/directory-completion.ts', '../../domain/file-completion/query.ts'],
    ['app/command/artifacts.ts', '../../client/file-completion/directory-completion.ts'],
    // TS8-B: the TUI presentation layer consumes the Client-local capability
    // (the `runtime-imports-client` negative above keeps this from being
    // vacuous).
    ['tui/file-completion/path-argument.ts', '../../client/file-completion/local-discovery.ts'],
    ['tui/file-completion/local-path-completion.ts', '../../domain/file-completion/discovery-policy.ts'],
    ['runtime/direct/file-completion/host-discovery.ts', '../../../domain/file-completion/ranking.ts'],
    // TS8-C: the canonical media/platform directions — the application Direct
    // preparation consumes the Client draft capability, the application platform
    // owner composes the Client clipboard, the TUI renders through the Client
    // durable-byte loader, and the Client/neutral runtime layers consume the
    // neutral domain vocabulary.
    ['app/submission/direct-message-preparation.ts', '../../client/media/attachment/placeholder.ts'],
    ['app/surface/client-actions.ts', '../../client/clipboard/read.ts'],
    ['tui/components/media/image-thumbnail.ts', '../../../client/media/image/loader.ts'],
    ['client/media/image/intake.ts', '../../../domain/media/types.ts'],
    ['runtime/prepared-prompt.ts', '../domain/media/types.ts'],
    ['runtime/remote/prompt-serializer-remote.ts', '../prepared-prompt.ts'],
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
  // TS8-B: a literal VALUE dynamic import is an EQUIVALENT spelling of the same
  // edge, so `runtime-imports-client` opts into `checksValueDynamicImport` and
  // must classify it — otherwise the layer could be entered later with a green
  // gate. The dynamic positives keep the opt-in from becoming a blanket
  // dynamic-import ban for the legal runtime targets.
  const dynamicCases = [
    ['runtime/direct/foo.ts', '../../client/file-completion/local-discovery.ts', ['runtime-imports-client']],
    ['runtime/remote/foo.ts', '../../client/artifact/save.ts', ['runtime-imports-client']],
  ]
  for (const [file, specifier, rules] of dynamicCases) {
    const violations = findViolations([entry(file, `const m = await import('${specifier}')\n`)])
    assert.deepEqual([...violations.map(v => v.rule)].sort(), [...rules].sort(),
      `${file} -> (dynamic) ${specifier} must fail as ${rules.join(' + ')} only`)
  }
  const dynamicAllowed = [
    // The Host semantic layer may dynamically load the neutral domain and its
    // own runtime ports.
    ['runtime/direct/foo.ts', '../../domain/file-completion/query.ts'],
    ['runtime/remote/foo.ts', '../host-file-port.ts'],
  ]
  for (const [file, specifier] of dynamicAllowed) {
    assert.deepEqual(
      findViolations([entry(file, `const m = await import('${specifier}')\n`)]),
      [],
      `${file} -> (dynamic) ${specifier} must stay allowed`,
    )
  }
})

test('app owners must not import the TUI implementation layer (TS4 §11/§12)', () => {
  // The composition zone is the ONLY place that selects concrete TUI
  // implementations; every other application owner consumes semantic contracts
  // and injected narrow factories. Type-only imports count.
  const cases = [
    ['app/surface/plugin-manager-runtime.ts', '../../tui/plugin-manager/panel.ts', 'tui/plugin-manager/panel.ts'],
    ['app/surface/task-runtime.ts', '../../tui/panels/task-panel.ts', 'tui/panels/task-panel.ts'],
    ['app/session/runtime.ts', '../../tui/pickers/model-picker.ts', 'tui/pickers/model-picker.ts'],
    // TS8-D: the compact token formatter is terminal presentation; an
    // app/surface owner consumes the semantic usage facts, never this module.
    ['app/surface/runtime.ts', '../../tui/token-format.ts', 'tui/token-format.ts'],
  ]
  for (const [file, specifier, target] of cases) {
    const valueImport = findViolations([entry(file, `import { x } from '${specifier}'\n`), entry(target, 'export const x = 1\n')])
    assert.equal(valueImport.length, 1, `${file} -> ${specifier} must be rejected`)
    assert.equal(valueImport[0].rule, 'app-imports-tui')
    const typeImport = findViolations([entry(file, `import type { X } from '${specifier}'\n`), entry(target, 'export type X = 1\n')])
    assert.equal(typeImport.length, 1, `${file} -> ${specifier} (type-only) must be rejected too`)
    assert.equal(typeImport[0].rule, 'app-imports-tui')
  }
  // The composition zone MAY wire concrete TUI implementations.
  const allowed = [
    ['app/bootstrap.ts', '../tui/plugin-manager/panel.ts', 'tui/plugin-manager/panel.ts'],
    ['app/bootstrap/lifecycle.ts', '../../tui/plugin-manager/panel.ts', 'tui/plugin-manager/panel.ts'],
    // The reverse direction stays open: a TUI module may consume application
    // contracts (it is the presentation layer's input).
    ['tui/pickers/model-picker.ts', '../../app/command/model-selection.ts', 'app/command/model-selection.ts'],
  ]
  for (const [file, specifier, target] of allowed) {
    assert.deepEqual(
      findViolations([entry(file, `import { x } from '${specifier}'\n`), entry(target, 'export const x = 1\n')]),
      [],
      `${file} -> ${specifier} must stay allowed`,
    )
  }
  // A literal VALUE dynamic import reaches the same concrete module and must not
  // escape the lock: it is parsed by `parseValueDynamicImports()`, which no other
  // rule consumes, so `app-imports-tui` opts into it explicitly.
  const dynamic = findViolations([
    entry('app/surface/plugin-manager-runtime.ts', "const { PluginManagerPanel } = await import('../../tui/plugin-manager/panel.ts')\n"),
    entry('tui/plugin-manager/panel.ts', 'export const PluginManagerPanel = 1\n'),
  ])
  assert.equal(dynamic.length, 1, 'app owner -> tui/** value dynamic import must be rejected')
  assert.equal(dynamic[0].rule, 'app-imports-tui')
  assert.equal(dynamic[0].line, 1)
  // The template-literal spelling with no substitution is the SAME module
  // reference (NoSubstitutionTemplateLiteral in the AST) and must be caught too.
  const dynamicTemplate = findViolations([
    entry('app/surface/plugin-manager-runtime.ts', "const { PluginManagerPanel } = await import(`../../tui/plugin-manager/panel.ts`)\n"),
    entry('tui/plugin-manager/panel.ts', 'export const PluginManagerPanel = 1\n'),
  ])
  assert.equal(dynamicTemplate.length, 1, 'app owner -> tui/** template-literal dynamic import must be rejected')
  assert.equal(dynamicTemplate[0].rule, 'app-imports-tui')
  // Transparent expression wrappers do not change WHICH module is referenced, so
  // each spelling must be classified like the bare literal (a parenthesized
  // argument is plain JS and type-checks; the casts are ordinary TS).
  for (const [label, argument] of [
    ['parenthesized', "('../../tui/plugin-manager/panel.ts')"],
    ['as-cast', "'../../tui/plugin-manager/panel.ts' as string"],
    ['satisfies', "'../../tui/plugin-manager/panel.ts' satisfies string"],
    ['angle-bracket assertion', "<string>'../../tui/plugin-manager/panel.ts'"],
    ['non-null', "'../../tui/plugin-manager/panel.ts'!"],
  ]) {
    const wrapped = findViolations([
      entry('app/surface/plugin-manager-runtime.ts', `const p = await import(${argument})\n`),
      entry('tui/plugin-manager/panel.ts', 'export const PluginManagerPanel = 1\n'),
    ])
    assert.equal(wrapped.length, 1, `app owner -> tui/** ${label} dynamic import must be rejected`)
    assert.equal(wrapped[0].rule, 'app-imports-tui')
  }
  // A `${…}` substitution is genuinely dynamic and stays outside the static model.
  assert.deepEqual(
    findViolations([
      entry('app/surface/plugin-manager-runtime.ts', 'const p = await import(`../../tui/plugin-manager/${name}.ts`)\n'),
      entry('tui/plugin-manager/panel.ts', 'export const PluginManagerPanel = 1\n'),
    ]),
    [],
    'a substituted template specifier is not statically resolvable',
  )
  // …while the composition zone keeps its dynamic selection freedom.
  assert.deepEqual(
    findViolations([
      entry('app/bootstrap.ts', "const { createPluginManagerPanel } = await import('../tui/plugin-manager/panel.ts')\n"),
      entry('tui/plugin-manager/panel.ts', 'export const createPluginManagerPanel = 1\n'),
    ]),
    [],
    'the bootstrap composition zone may also dynamically import tui/**',
  )
  assert.deepEqual(
    findViolations([
      entry('app/bootstrap.ts', 'const { createPluginManagerPanel } = await import(`../tui/plugin-manager/panel.ts`)\n'),
      entry('tui/plugin-manager/panel.ts', 'export const createPluginManagerPanel = 1\n'),
    ]),
    [],
    'the bootstrap composition zone may also use the template-literal spelling',
  )
  // The sanctioned Remote lazy edge stays governed ONLY by its own rule: the
  // generic runtime/app rules must not be applied to dynamic imports wholesale.
  const remoteEdge = findViolations([
    entry('runtime/backend-loader.ts', "const backend = await import('../app/remote/runtime.ts')\n"),
    entry('app/remote/runtime.ts', 'export const backend = 1\n'),
  ])
  assert.deepEqual(remoteEdge, [], 'the sanctioned Remote dynamic edge is not re-classified')
  // The second consumer of the shared primitive: the Remote lazy-boundary rule
  // now also sees the template-literal spelling (primitive semantic completion).
  const remoteEdgeTemplate = findViolations([
    entry('app/remote/not-the-loader.ts', 'const backend = await import(`./runtime.ts`)\n'),
    entry('app/remote/runtime.ts', 'export const backend = 1\n'),
  ])
  assert.equal(remoteEdgeTemplate.length, 1, 'only the loader owner may dynamically import the Remote composition root')
  assert.equal(remoteEdgeTemplate[0].rule, 'remote-dynamic-import-owner')
  // …and the parenthesized spelling reaches that rule too.
  const remoteEdgeWrapped = findViolations([
    entry('app/remote/not-the-loader.ts', "const backend = await import(('./runtime.ts'))\n"),
    entry('app/remote/runtime.ts', 'export const backend = 1\n'),
  ])
  assert.equal(remoteEdgeWrapped.length, 1, 'a wrapped argument must not bypass the Remote lazy-boundary rule')
  assert.equal(remoteEdgeWrapped[0].rule, 'remote-dynamic-import-owner')
})

test('TS5 ownership boundaries are non-vacuous (app/domain/runtime -> tui locks)', () => {
  // The TS5 owners are exactly the files the plan names. Each direction lock
  // must reject a concrete `tui/**` import from its layer (type-only included),
  // so "the new owners are behind a seam" cannot pass vacuously.
  const negatives = [
    ['app/surface/settings-runtime.ts', '../../tui/keybindings/manager.ts', 'tui/keybindings/manager.ts', 'app-imports-tui'],
    ['app/surface/settings-runtime.ts', '../../tui/footer/runtime.ts', 'tui/footer/runtime.ts', 'app-imports-tui'],
    ['app/surface/notification-runtime.ts', '../../tui/notification/runtime.ts', 'tui/notification/runtime.ts', 'app-imports-tui'],
    ['domain/footer/layout.ts', '../../tui/footer/composer.ts', 'tui/footer/composer.ts', 'domain-imports-tui'],
    ['domain/notification/controller.ts', '../../tui/notification/terminal-notifier.ts', 'tui/notification/terminal-notifier.ts', 'domain-imports-tui'],
    ['runtime/backend-loader.ts', '../tui/interaction/input-router.ts', 'tui/interaction/input-router.ts', 'runtime-imports-tui'],
  ]
  for (const [file, specifier, target, rule] of negatives) {
    const violations = findViolations([
      entry(file, `import type { X } from '${specifier}'\n`),
      entry(target, 'export type X = 1\n'),
    ])
    assert.equal(violations.length, 1, `${file} -> ${specifier} must be rejected`)
    assert.equal(violations[0].rule, rule)
  }
  // Positive controls: the composition zone selects the concrete TUI
  // implementation, and the TUI consumes application-facing / extension
  // structural contracts.
  const positives = [
    ['app/bootstrap.ts', '../tui/notification/runtime.ts', 'tui/notification/runtime.ts'],
    ['app/bootstrap/lifecycle.ts', '../../tui/notification/runtime.ts', 'tui/notification/runtime.ts'],
    ['tui/interaction/approval-runtime.ts', '../../app/surface/notification-runtime.ts', 'app/surface/notification-runtime.ts'],
    ['tui/keybindings/manager.ts', '../../extension/public-types.ts', 'extension/public-types.ts'],
  ]
  for (const [file, specifier, target] of positives) {
    assert.deepEqual(
      findViolations([entry(file, `import { x } from '${specifier}'\n`), entry(target, 'export const x = 1\n')]),
      [],
      `${file} -> ${specifier} must stay allowed`,
    )
  }
})

test('the backend-neutral transcript core rejects renderer mechanics (TS6)', () => {
  // `src/tui/transcript/**` is consumed by the concrete renderer mechanics, so
  // the direction `PiTui mechanics -> tui/transcript` is the only legal one:
  // EVERY other `src/tui/**` owner is mechanics, not just the enumerated ones.
  // Each negative below names a distinct renderer-mechanics family the core must
  // stay blind to; the positive controls are anchored by those negatives, so
  // "allowed" cannot pass vacuously.
  const forbidden = [
    ['@xmoon76/pi-tui', '@xmoon76/pi-tui'],
    ['@xmoon76/pi-tui/dist/index.mjs', '@xmoon76/pi-tui/dist/index.mjs'],
    ['@stencil-hq/tern', '@stencil-hq/tern'],
    ['@stencil-hq/tern/ui', '@stencil-hq/tern/ui'],
    ['../components/transcript/focus-activity.ts', 'tui/components/transcript/focus-activity.ts'],
    ['../panels/x.ts', 'tui/panels/x.ts'],
    ['../pickers/x.ts', 'tui/pickers/x.ts'],
    ['../interaction/x.ts', 'tui/interaction/x.ts'],
    // The two owners an enumeration-based rule missed: the whole-layer contract
    // must not depend on remembering every extracted mechanics directory.
    ['../keybindings/manager.ts', 'tui/keybindings/manager.ts'],
    ['../commands/status.ts', 'tui/commands/status.ts'],
    ['../footer/x.ts', 'tui/footer/x.ts'],
    ['../notification/x.ts', 'tui/notification/x.ts'],
    ['../plugin-manager/x.ts', 'tui/plugin-manager/x.ts'],
    ['../../tui-app.ts', 'tui-app.ts'],
    // The command facade is part of the TUI command layer, not a core input.
    ['../../commands.ts', 'commands.ts'],
    ['../../theme.ts', 'theme.ts'],
    ['../icons.ts', 'tui/icons.ts'],
    // The allowance is the core SUBTREE, not a name prefix: a similarly-named
    // NON-core directory is still mechanics.
    ['../../tui/transcript-legacy/x.ts', 'tui/transcript-legacy/x.ts'],
    ['../../renderer-registry.ts', 'renderer-registry.ts'],
    // TS8-E: the canonical concrete renderer registry ownership is under the
    // extension boundary and stays forbidden to the core too.
    ['../../extension/internal/renderer-registry.ts', 'extension/internal/renderer-registry.ts'],
    // TS7: the core reads the canonical `domain/transcript/**` owners directly;
    // the stable facade and the three retired semantic roots are never inputs.
    ['../../transcript.ts', 'transcript.ts'],
    ['../../transcript-semantics.ts', 'transcript-semantics.ts'],
    ['../../context-presentation.ts', 'context-presentation.ts'],
    ['../../transcript-window.ts', 'transcript-window.ts'],
  ]
  for (const [specifier, target] of forbidden) {
    const valueImport = findViolations([
      entry('tui/transcript/x.ts', `import { x } from '${specifier}'\n`),
      entry(target, 'export const x = 1\n'),
    ])
    assert.equal(valueImport.length, 1, `tui/transcript/x.ts -> ${specifier} must be rejected`)
    assert.equal(valueImport[0].rule, 'tui-transcript-imports-renderer-mechanics')
    assert.equal(valueImport[0].line, 1)
    // A type-only import reaches the same owner and is never an escape hatch.
    const typeImport = findViolations([
      entry('tui/transcript/x.ts', `import type { X } from '${specifier}'\n`),
      entry(target, 'export type X = 1\n'),
    ])
    assert.equal(typeImport.length, 1, `tui/transcript/x.ts -> ${specifier} (type-only) must be rejected too`)
    assert.equal(typeImport[0].rule, 'tui-transcript-imports-renderer-mechanics')
  }
  // The literal dynamic spellings reach the same module: a relative component
  // target and a bare package specifier both opt into `parseValueDynamicImports`.
  const dynamicRelative = findViolations([
    entry('tui/transcript/x.ts', "const m = await import('../components/transcript/x.ts')\n"),
    entry('tui/components/transcript/x.ts', 'export const m = 1\n'),
  ])
  assert.equal(dynamicRelative.length, 1, 'a relative renderer-mechanics dynamic import must be rejected')
  assert.equal(dynamicRelative[0].rule, 'tui-transcript-imports-renderer-mechanics')
  // The whole-layer rule holds on the dynamic path too.
  const dynamicTuiOwner = findViolations([
    entry('tui/transcript/x.ts', "const m = await import('../keybindings/manager.ts')\n"),
    entry('tui/keybindings/manager.ts', 'export const m = 1\n'),
  ])
  assert.equal(dynamicTuiOwner.length, 1, 'a relative TUI-mechanics dynamic import must be rejected')
  assert.equal(dynamicTuiOwner[0].rule, 'tui-transcript-imports-renderer-mechanics')
  const dynamicPackage = findViolations([
    entry('tui/transcript/x.ts', "const m = await import('@xmoon76/pi-tui')\n"),
  ])
  assert.equal(dynamicPackage.length, 1, 'a bare renderer-package dynamic import must be rejected')
  assert.equal(dynamicPackage[0].rule, 'tui-transcript-imports-renderer-mechanics')
  // …and this bare-specifier handling belongs to THIS rule alone. An older rule
  // must keep its exact baseline scope: a non-relative dynamic specifier was
  // never resolved into a target, so an npm package/subpath that merely starts
  // with `tui/` is not an `app -> src/tui/**` edge. (The static spelling of that
  // specifier is reported at baseline; the asymmetry is pre-existing and out of
  // TS6 scope — the dynamic spelling must not be retro-fitted onto that rule.)
  assert.deepEqual(
    findViolations([entry('app/surface/x.ts', "const m = await import('tui/widget')\n")]),
    [],
    'a bare external tui/* dynamic specifier must not be read as src/tui/** by app-imports-tui',
  )
  // Positive controls: the canonical domain owner the core migrated to, the
  // pure application-facing policy and every intra-core module stay open.
  const allowed = [
    // TS7: the canonical semantic owner is the core's only transcript input.
    ['tui/transcript/x.ts', '../../domain/transcript/types.ts', 'domain/transcript/types.ts', 'export const x = 1\n'],
    ['tui/transcript/x.ts', '../../domain/transcript/semantics.ts', 'domain/transcript/semantics.ts', 'export const x = 1\n'],
    // Shared transitional policy with a real pure consumer.
    ['tui/transcript/x.ts', '../../display-preset.ts', 'display-preset.ts', 'export const x = 1\n'],
    // Sibling core modules are the point of the directory.
    ['tui/transcript/x.ts', './structure.ts', 'tui/transcript/structure.ts', 'export const x = 1\n'],
    // …and the allowance is the CORE SUBTREE, not one flat directory: a nested
    // core module keeps reaching its siblings.
    ['tui/transcript/nested/x.ts', '../structure.ts', 'tui/transcript/structure.ts', 'export const x = 1\n'],
    // The reverse direction is the contract: PiTui mechanics consume the core.
    ['tui/components/transcript/x.ts', '../../transcript/structure.ts', 'tui/transcript/structure.ts', 'export const x = 1\n'],
  ]
  for (const [file, specifier, target, source] of allowed) {
    assert.deepEqual(
      findViolations([entry(file, `import { x } from '${specifier}'\n`), entry(target, source)]),
      [],
      `${file} -> ${specifier} must stay allowed`,
    )
  }
})

test('the transcript semantic domain is a closed-world purity contract (TS7)', () => {
  // `src/domain/transcript/**` is the ONE transport/UI-neutral transcript
  // semantic/lifecycle authority. The contract is CLOSED-WORLD: only domain
  // siblings and the two canonical TYPE-ONLY compatibility edges
  // (`domain/display/icons.ts`, `runtime/assistant-stream-port.ts`) are
  // admitted — everything else fails by default, so a future escape hatch has
  // to be added deliberately instead of being missed by a forbidden-target
  // list. A value import must never ride along on a type-only allowance, and
  // the literal-dynamic spelling must reach the same verdict.
  const RULE = 'domain-transcript-imports-backend-mechanics'
  const staticEdge = (file, specifier, target, source) =>
    findViolations([entry(file, source), entry(target, 'export const x = 1\n')])
  const valueImport = (specifier, target) =>
    staticEdge('domain/transcript/x.ts', specifier, target, `import { x } from '${specifier}'\n`)
  const typeImport = (specifier, target) =>
    staticEdge('domain/transcript/x.ts', specifier, target, `import type { X } from '${specifier}'\n`)
  const dynamicImport = (specifier, target) =>
    staticEdge('domain/transcript/x.ts', specifier, target, `const m = await import('${specifier}')\n`)

  // 1. Every renderer/application/transport owner — and the plain root modules
  // the old forbidden-list strategy let through (`commands.ts` is the TUI
  // command-layer facade, `display-preset.ts`/`search-overlay.ts` are presentation
  // policy, the retired semantic roots must stay unreachable): value AND type-only
  // spellings both fail.
  const forbidden = [
    ['../../tui/transcript/structure.ts', 'tui/transcript/structure.ts'],
    ['../../tui/components/transcript/context-row.ts', 'tui/components/transcript/context-row.ts'],
    ['../../app/surface/runtime.ts', 'app/surface/runtime.ts'],
    ['../../app/remote/runtime.ts', 'app/remote/runtime.ts'],
    ['../../runtime/direct/backend-direct.ts', 'runtime/direct/backend-direct.ts'],
    ['../../runtime/remote/session-reader-remote.ts', 'runtime/remote/session-reader-remote.ts'],
    ['../../tui-app.ts', 'tui-app.ts'],
    ['../../renderer-registry.ts', 'renderer-registry.ts'],
    ['../../theme.ts', 'theme.ts'],
    ['../../transcript.ts', 'transcript.ts'],
    ['../../commands.ts', 'commands.ts'],
    ['../../display-preset.ts', 'display-preset.ts'],
    // TS8-D: the retired transitional roots are never legal inputs again.
    ['../../present.ts', 'present.ts'],
    ['../../context.ts', 'context.ts'],
    // TS8-D: only the TYPE-ONLY `domain/display/icons.ts` edge is open; the
    // neutral preset authority and the concrete palette stay closed.
    ['../../domain/display/preset.ts', 'domain/display/preset.ts'],
    ['../../tui/icons.ts', 'tui/icons.ts'],
    ['../../search-overlay.ts', 'search-overlay.ts'],
    ['../../transcript-semantics.ts', 'transcript-semantics.ts'],
    ['../../context-presentation.ts', 'context-presentation.ts'],
    ['../../transcript-window.ts', 'transcript-window.ts'],
    ['@xmoon76/pi-tui', '@xmoon76/pi-tui'],
    ['@stencil-hq/tern', '@stencil-hq/tern'],
    ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-runtime'],
  ]
  for (const [specifier, target] of forbidden) {
    assert.deepEqual(
      valueImport(specifier, target).map(v => v.rule),
      [RULE],
      `domain/transcript/x.ts -> ${specifier} (value) must be rejected exactly once by the TS7 rule`,
    )
    assert.deepEqual(
      typeImport(specifier, target).map(v => v.rule),
      [RULE],
      `domain/transcript/x.ts -> ${specifier} (type-only) must be rejected too`,
    )
  }

  // 2. The two TYPE-ONLY edges are canonical domain vocabulary
  // (`domain/display/icons.ts`) and a neutral runtime port
  // (`runtime/assistant-stream-port.ts`) — not transitional roots. Only the
  // type spelling passes; value and literal-dynamic spellings remain forbidden
  // by the closed-world semantic-domain contract.
  const typeOnlyEdges = [
    ['../../domain/display/icons.ts', 'domain/display/icons.ts'],
    ['../../runtime/assistant-stream-port.ts', 'runtime/assistant-stream-port.ts'],
  ]
  for (const [specifier, target] of typeOnlyEdges) {
    assert.deepEqual(
      staticEdge('domain/transcript/x.ts', specifier, target, `import type { X } from '${specifier}'\n`),
      [],
      `domain/transcript/x.ts -> ${specifier} (type-only) must stay allowed`,
    )
    assert.deepEqual(
      valueImport(specifier, target).map(v => v.rule),
      [RULE],
      `domain/transcript/x.ts -> ${specifier} (value) must NOT ride on the type-only allowance`,
    )
    assert.deepEqual(
      dynamicImport(specifier, target).map(v => v.rule),
      [RULE],
      `domain/transcript/x.ts -> ${specifier} (dynamic value) must NOT ride on the type-only allowance`,
    )
  }

  // 3. The literal-dynamic spelling of an ordinary forbidden relative edge and of
  // a bare renderer package fails too (only this rule opts into dynamic parsing).
  assert.deepEqual(
    dynamicImport('../../commands.ts', 'commands.ts').map(v => v.rule),
    [RULE],
    'a literal dynamic import of the TUI command facade must be rejected',
  )
  assert.deepEqual(
    dynamicImport('@xmoon76/pi-tui', '@xmoon76/pi-tui').map(v => v.rule),
    [RULE],
    'a bare renderer-package dynamic import must be rejected',
  )

  // 4. Positive controls: domain siblings, official DSH semantic packages, and
  // the correct `tui/transcript -> domain/transcript` direction stay open.
  // There is no transitional root VALUE edge left after TS8-D.
  const allowed = [
    ['./types.ts', 'domain/transcript/types.ts'],
    ['./search.ts', 'domain/transcript/search.ts'],
    ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-llm'],
    ['@deepseek-ai/dsh-tool-workflow/types', '@deepseek-ai/dsh-tool-workflow/types'],
  ]
  for (const [specifier, target] of allowed) {
    assert.deepEqual(
      valueImport(specifier, target),
      [],
      `domain/transcript/x.ts -> ${specifier} must stay allowed`,
    )
  }
  assert.deepEqual(
    staticEdge(
      'tui/transcript/x.ts',
      '../../domain/transcript/types.ts',
      'domain/transcript/types.ts',
      "import { x } from '../../domain/transcript/types.ts'\n",
    ),
    [],
    'the reverse direction (PiTui mechanics -> core -> domain) stays open',
  )
})

test('parseValueDynamicImports reports only value import() calls with literal specifiers', () => {
  const specs = parseValueDynamicImports(
    [
      "const a = await import('./a.ts')",
      'const b = await import(dynamic)',
      "// const c = await import('./c.ts')",
      "type T = import('./d.ts').T",
      "import { e } from './e.ts'",
      // A template literal with NO substitution is an EQUIVALENT static spelling
      // (the AST calls it NoSubstitutionTemplateLiteral, not StringLiteral), so
      // the primitive must classify it exactly like the string form.
      'const f = await import(`./f.ts`)',
      // …while a substitution is a genuinely dynamic expression and stays out.
      'const g = await import(`./g/${name}.ts`)',
      // Transparent wrappers do not change WHICH module is referenced: the
      // parenthesized form is plain JS, the casts are ordinary TS, and all of
      // them type-check. Each must be classified like the bare literal.
      "const h = await import(('./h.ts'))",
      "const i = await import('./i.ts' as string)",
      "const j = await import('./j.ts' satisfies string)",
      "const k = await import(<string>'./k.ts')",
      "const l = await import('./l.ts'!)",
      // A concatenation is genuinely dynamic and stays out.
      "const m = await import('./m.ts' + '')",
    ].join('\n'),
  )
  assert.deepEqual(specs, [
    { specifier: './a.ts', line: 1 },
    { specifier: './f.ts', line: 6 },
    { specifier: './h.ts', line: 8 },
    { specifier: './i.ts', line: 9 },
    { specifier: './j.ts', line: 10 },
    { specifier: './k.ts', line: 11 },
    { specifier: './l.ts', line: 12 },
  ])
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

test('TS8-F: the process layer owns its five forbidden inner layers under one rule id', () => {
  // The generic runtime-imports-app|tui|client rules carve this subtree out so
  // the runtime-layer direction has ONE rule id here. The carve-out is scoped to
  // those rules only: an INDEPENDENT contract can still report the same file
  // under its own id (pinned in the overlap test below), which is not the same
  // invariant double-reported.
  const targets = ['app/surface/status-runtime.ts', 'tui/components/frame.ts', 'client/media/format.ts', 'runtime/direct/backend-direct.ts', 'runtime/remote/skill-remote.ts']
  for (const target of targets) {
    const violations = findViolations([entry('runtime/process/tasks.ts', `import { x } from '../../${target}'\n`)])
    assert.equal(violations.length, 1, `runtime/process -> ${target} must be rejected exactly once`)
    assert.equal(violations[0].rule, 'runtime-process-imports-inner-layers')
    assert.equal(violations[0].file, 'runtime/process/tasks.ts')
    assert.equal(violations[0].line, 1)
  }
  // A TYPE-ONLY import is not an escape hatch for the layer rule.
  assert.equal(
    findViolations([entry('runtime/process/diagnostics.ts', "import type { T } from '../../client/media/format.ts'\n")]).length,
    1,
    'a type-only runtime/process -> client edge must be rejected',
  )
  // A literal VALUE dynamic import reaches the same module as a static one.
  assert.equal(
    findViolations([entry('runtime/process/tasks.ts', "import('../../app/surface/status-runtime.ts')\n")])[0]?.rule,
    'runtime-process-imports-inner-layers',
    'a value dynamic runtime/process -> app edge must be rejected',
  )
})

test('TS8-F: the process-layer rule coexists with independent contracts (not one invariant double-reported)', () => {
  // The bootstrap-composition contract and the Remote lazy-boundary contract
  // each keep their own rule id for an edge the process rule also governs.
  const staticOverlap = findViolations([entry('runtime/process/tasks.ts', "import { x } from '../../app/bootstrap.ts'\n")])
  assert.deepEqual(
    [...new Set(staticOverlap.map(v => v.rule))].sort(),
    ['owner-imports-bootstrap', 'runtime-process-imports-inner-layers'],
    'the bootstrap-composition contract and the process rule are two independent contracts',
  )
  const dynamicOverlap = findViolations([entry('runtime/process/tasks.ts', "import('../../app/remote/runtime.ts')\n")])
  assert.deepEqual(
    [...new Set(dynamicOverlap.map(v => v.rule))].sort(),
    ['remote-dynamic-import-owner', 'runtime-process-imports-inner-layers'],
    'the Remote lazy-boundary contract and the process rule are two independent contracts',
  )
})

test('TS8-F: the process layer rejects DSH implementation runtime edges but keeps erased type faces and Node stdlib', () => {
  const reject = findViolations([entry('runtime/process/tasks.ts', "import { createAgent } from '@deepseek-ai/dsh-agent'\n")])
  assert.equal(reject.length, 1)
  assert.equal(reject[0].rule, 'runtime-process-imports-dsh-implementation')
  // A bare VALUE dynamic import is the same value edge, not an escape hatch.
  assert.equal(
    findViolations([entry('runtime/process/tasks.ts', "import('@deepseek-ai/dsh-session')\n")])[0]?.rule,
    'runtime-process-imports-dsh-implementation',
  )
  // verbatimModuleSyntax: an INLINE type specifier still emits a runtime module
  // load, so the rule must reject it. `typeOnly` alone cannot see this — the
  // strict discriminator is `moduleTypeOnly` (declaration fully erased).
  for (const spec of [
    "import { type Agent } from '@deepseek-ai/dsh-agent'\n",
    "export { type X } from '@deepseek-ai/dsh-agent'\n",
  ]) {
    const violations = findViolations([entry('runtime/process/tasks.ts', spec)])
    assert.equal(violations.length, 1, `an inline-type DSH runtime edge must be rejected: ${spec.trim()}`)
    assert.equal(violations[0].rule, 'runtime-process-imports-dsh-implementation')
  }
  // The parser proves WHY: the inline form is typeOnly but NOT moduleTypeOnly.
  assert.deepEqual(
    parseImportSpecifiers("import { type Agent } from '@deepseek-ai/dsh-agent'\n").map(s => [s.typeOnly, s.moduleTypeOnly]),
    [[true, false]],
  )
  // An ordinary import-equals is a runtime require; a TYPE import-equals is
  // fully erased under verbatimModuleSyntax (historical `typeOnly` stays false).
  assert.equal(
    findViolations([entry('runtime/process/tasks.mts', "import AgentModule = require('@deepseek-ai/dsh-agent')\n")])[0]?.rule,
    'runtime-process-imports-dsh-implementation',
    'an ordinary import-equals must be rejected as a runtime edge',
  )
  assert.deepEqual(
    findViolations([entry('runtime/process/tasks.mts', "import type AgentModule = require('@deepseek-ai/dsh-agent')\nexport type Agent = AgentModule.Agent\n")]),
    [],
    'a fully erased type import-equals must be allowed',
  )
  assert.deepEqual(
    parseImportSpecifiers("import type AgentModule = require('@deepseek-ai/dsh-agent')\n", 'runtime/process/tasks.mts').map(s => [s.typeOnly, s.moduleTypeOnly]),
    [[false, true]],
    'the type import-equals is erased (moduleTypeOnly) without changing the historical typeOnly flag',
  )
  // Allowed: Node standard library, a FULLY ERASED DSH type face, a
  // non-business infrastructure package, and a process-layer sibling.
  assert.deepEqual(findViolations([entry('runtime/process/diagnostics.ts', "import { join } from 'node:path'\n")]), [])
  assert.deepEqual(findViolations([entry('runtime/process/tasks.ts', "import type { Agent } from '@deepseek-ai/dsh-agent'\n")]), [])
  assert.deepEqual(findViolations([entry('runtime/process/tasks.ts', "export type { X } from '@deepseek-ai/dsh-agent'\n")]), [])
  assert.deepEqual(findViolations([entry('runtime/process/tasks.ts', "import { symbols } from '@deepseek-ai/cordis'\n")]), [])
  assert.deepEqual(findViolations([entry('runtime/process/tasks.ts', "import type { Diag } from './diagnostics.ts'\n")]), [])
})

test('TS8-F: the process-layer predicates match the subtree and package boundaries', () => {
  assert.ok(isRuntimeProcessSubtree('runtime/process/tasks.ts'))
  assert.ok(isRuntimeProcessSubtree('runtime/process/nested/x.ts'))
  assert.ok(!isRuntimeProcessSubtree('runtime/backend.ts'))
  assert.ok(!isRuntimeProcessSubtree('runtime/process.ts'))
  assert.ok(isDshImplementationPackage('@deepseek-ai/dsh-agent'))
  assert.ok(isDshImplementationPackage('@deepseek-ai/dsh-tools/lib/face'))
  assert.ok(!isDshImplementationPackage('@deepseek-ai/cordis'))
  assert.ok(!isDshImplementationPackage('@xmoon76/pi-tui'))
})

test('the source-root baseline accepts the exact captured tree and fails closed on every drift (TS1 §20.3)', (t) => {
  const baseline = readSourceRootBaseline()
  const current = listSourceRootFiles()
  assert.deepEqual(findSourceRootViolations(baseline, current), [],
    'the checked-in baseline must match the exact current root module set')
  // The stable set is the deliberate root facade contract; the legacy set is
  // EMPTY because F7 closed the TS8-F migration (the final state is enforced
  // by `findFinalSourceRootStateViolations` in the dedicated tests below).
  assert.deepEqual(baseline.stable, ['builtins.ts', 'commands.ts', 'extensions.ts', 'index.ts', 'startup.ts', 'transcript.ts', 'tui-app.ts'])
  assert.deepEqual(baseline.legacy, current.filter(name => !baseline.stable.includes(name)))
  assert.equal(baseline.legacy.length, 0, 'the TS8-F train is closed: no legacy root remains')
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

test('a retired historical feature directory must not reappear (TS8-A/TS8-C)', () => {
  // The directory-level companion of the root ledger: TS8-A retires the mixed
  // `src/file-completion/**` directory and TS8-C retires `src/image/**` +
  // `src/attachment/**`, so the real tree must no longer have them and every
  // retired entry must fail closed when it is recreated.
  const directories = listSourceRootDirectories()
  assert.deepEqual(findRetiredSourceDirectoryViolations(directories), [],
    'the real production tree must not contain a retired feature directory')
  for (const name of ['file-completion', 'image', 'attachment']) {
    assert.ok(RETIRED_SOURCE_DIRECTORIES.includes(name),
      `the retired ledger must track the ${name} directory`)
    assert.equal(directories.includes(name), false,
      `src/${name}/ must be gone after its TS8 stage`)
    assert.match(
      findRetiredSourceDirectoryViolations([...directories, name]).join('\n'),
      new RegExp(`src/${name}/ is a retired historical feature directory`),
      `recreating src/${name}/ must FAIL`,
    )
  }
  // A brand-new unrelated directory is not this rule's business (the root
  // ledger governs modules; this rule governs retired subtree placements).
  assert.deepEqual(findRetiredSourceDirectoryViolations([...directories, 'brand-new-feature']), [])
})

test('TS8-E: the Stable extension public declaration sources reject TUI implementation imports', () => {
  // Plan §21 #5: a published plugin type must be nameable without the project's
  // TUI implementation. Both the type-only and the value spelling fail.
  const sources = [
    ['extensions.ts', './tui-app.ts'],
    ['extension/public-types.ts', '../tui-app.ts'],
    ['extension/advanced.ts', '../tui-app.ts'],
    ['extension/advanced-types.ts', '../tui-app.ts'],
    ['extension/unstable.ts', '../tui-app.ts'],
    ['extension/unstable-types.ts', '../tui-app.ts'],
  ]
  for (const [rel, specifier] of sources) {
    for (const kind of ['import type', 'import']) {
      const violations = findViolations([
        entry(rel, `${kind} { TuiApp } from '${specifier}'\n`),
        entry('tui-app.ts', 'export class TuiApp {}\n'),
      ])
      assert.equal(violations.length, 1, `${rel} -> tui-app.ts (${kind}) must be rejected`)
      assert.equal(violations[0].rule, 'extension-public-declaration-imports-tui')
    }
  }
  // The concrete registries under extension/internal/** keep their reviewed
  // adapter edges — the public-source rule must not govern them.
  assert.deepEqual(findViolations([
    entry('extension/internal/keybinding-registry.ts', "import { canonicalizeKeyId } from '../../tui/keybindings/key-identity.ts'\n"),
    entry('tui/keybindings/key-identity.ts', 'export const canonicalizeKeyId = (value) => value\n'),
  ]), [])
})

// ── TS8-F final state (plan §11.4 assertions 1-5, §11.5) ────────────────────

test('TS8-F final state: the checked-in root baseline is the CLOSED 7-stable / 0-legacy ledger', () => {
  const baseline = readSourceRootBaseline()
  assert.deepEqual([...baseline.stable].sort(), [...FINAL_STABLE_SOURCE_ROOTS].sort(),
    'the stable root set must be exactly the seven final entries/facades')
  assert.deepEqual(baseline.legacy, [], 'no legacy root may remain once TS8-F closes')
  assert.deepEqual(findFinalSourceRootStateViolations(baseline), [])
  assert.deepEqual(findSourceRootViolations(baseline, listSourceRootFiles()), [],
    'the real tree must match the closed ledger exactly')
})

test('TS8-F final state: a re-opened legacy root or a changed stable set is rejected', () => {
  const baseline = readSourceRootBaseline()
  const reopened = findFinalSourceRootStateViolations({ ...baseline, legacy: ['leftover.ts'] })
  assert.equal(reopened.length, 1)
  assert.match(reopened[0], /no legacy root may remain/)
  assert.equal(findFinalSourceRootStateViolations({ ...baseline, stable: baseline.stable.slice(1) }).length, 1,
    'a missing stable entry must fail')
  assert.equal(findFinalSourceRootStateViolations({ ...baseline, stable: [...baseline.stable, 'extra.ts'] }).length, 1,
    'an extra stable entry must fail')
})

test('TS8-F retired roots are a closed forbidden set (48 physical roots, builtins excluded)', () => {
  assert.equal(RETIRED_SOURCE_ROOTS.length, 48, 'all 48 physical roots removed by F1-F6 are forbidden')
  assert.equal(new Set(RETIRED_SOURCE_ROOTS).size, 48, 'the retired set has no duplicates')
  assert.equal(RETIRED_SOURCE_ROOTS.includes('builtins.ts'), false,
    'builtins.ts is reclassified STABLE by F7, never retired')
  assert.deepEqual(findRetiredSourceRootViolations(listSourceRootFiles(), collectSourceEntries()), [],
    'no retired root exists today and no production import names one')
})

test('TS8-F retired roots: a recreated file or a dangling old-path import is rejected', () => {
  const recreated = findRetiredSourceRootViolations(['diff.ts', ...listSourceRootFiles()], [])
  assert.equal(recreated.length, 1)
  assert.match(recreated[0], /retired TS8-F root recreated: src\/diff\.ts/)
  for (const [rel, specifier] of [['app/surface/example.ts', '../../diff.ts'], ['tui/transcript/example.ts', '../../diff.ts']]) {
    const violations = findRetiredSourceRootViolations([], [
      entry(rel, `import { renderDiffView } from '${specifier}'\n`),
    ])
    assert.equal(violations.length, 1, `${rel} -> ${specifier} must resolve to the retired root`)
    assert.match(violations[0], /imports the retired TS8-F root path/)
  }
  // A specifier that resolves to a NESTED sibling of the same basename is not
  // the retired root.
  assert.deepEqual(findRetiredSourceRootViolations([], [
    entry('app/surface/example.ts', "import { x } from './diff.ts'\n"),
  ]), [])
  // A canonical sibling that merely shares the basename stays legal.
  assert.deepEqual(findRetiredSourceRootViolations([], [
    entry('tui/components/transcript/diff.ts', "import { localHunkRows } from '../../transcript/diff-projection.ts'\n"),
  ]), [])
  // A comment naming the old path is not an import.
  assert.deepEqual(findRetiredSourceRootViolations([], [
    entry('app/surface/example.ts', '// see src/diff.ts for the old derivation\n'),
  ]), [])
})

test('TS8-F final assertion 7: a Remote adapter cannot import the Direct implementation (HF1 bridge excepted)', () => {
  // `direct-import-outside-composition` treats the whole runtime/** layer as
  // Direct composition, so runtime/remote was silently exempt; this rule is
  // the actual assertion.
  for (const specifier of ['../direct/example.ts', '../direct/nested/deep.ts']) {
    const violations = findViolations([entry('runtime/remote/example.ts', `import { x } from '${specifier}'\n`)])
    assert.equal(violations.length, 1, `${specifier} from a Remote adapter must fail`)
    assert.equal(violations[0].rule, 'runtime-remote-imports-direct')
  }
  // The statically knowable dynamic edge is the same edge.
  assert.equal(findViolations([
    entry('runtime/remote/example.ts', "const load = () => import('../direct/example.ts')\n"),
  ]).filter(v => v.rule === 'runtime-remote-imports-direct').length, 1)
  // The reviewed HF1 Host-side construction bridge keeps its direct helpers.
  assert.deepEqual([...REMOTE_TO_DIRECT_APPROVED_BRIDGES], ['runtime/remote/pi-tui-file-reference-host-bridge.ts'],
    'the exception set must stay exactly the one documented HF1 bridge')
  for (const rel of REMOTE_TO_DIRECT_APPROVED_BRIDGES) {
    assert.equal(findViolations([entry(rel, "import { x } from '../direct/x.ts'\n")]).length, 0,
      `${rel} is the approved Host-construction exception`)
  }
  // A Remote adapter importing anything else stays legal.
  assert.deepEqual(findViolations([
    entry('runtime/remote/example.ts', "import { x } from '../backend-loader.ts'\n"),
  ]), [])
})

test('TS8-F final assertion 11: a concrete extension registry must live under extension/internal/**', () => {
  assert.deepEqual(findConcreteRegistryPlacementViolations(listSourceFilesUnder('src')), [],
    'the real tree keeps every concrete extension registry under extension/internal/**')
  for (const rel of ['extension/keybinding-registry.ts', 'extension/nested/renderer-registry.ts']) {
    const violations = findConcreteRegistryPlacementViolations([rel])
    assert.equal(violations.length, 1, `${rel} must fail the concrete-registry placement check`)
    assert.match(violations[0], /outside extension\/internal\/\*\*/)
  }
  assert.deepEqual(findConcreteRegistryPlacementViolations(['extension/internal/renderer-registry.ts']), [])
  // Registry-shaped modules outside the extension tree are out of this
  // assertion's scope (app/tui own their own registries).
  assert.deepEqual(findConcreteRegistryPlacementViolations([
    'app/command/client-command-registry.ts',
    'tui/footer/item-registry.ts',
  ]), [])
})

test('TS8-F final assertion 14: the startup island must not reach a repository implementation module', () => {
  const real = collectSourceEntries()
  assert.equal(real.some(entryItem => entryItem.rel === 'startup.ts'), true, 'the real startup entry exists')
  assert.deepEqual(findStartupIslandViolations(real), [],
    'the real startup island reaches no repository implementation module')
  // A direct application-graph edge is the reviewer's counterexample.
  assert.equal(findStartupIslandViolations([
    entry('startup.ts', "import './app/surface/runtime.ts'\n"),
    entry('app/surface/runtime.ts', ''),
  ]).length, 1)
  // A transitive edge fails too, and the reported module is the offending hop.
  assert.equal(findStartupIslandViolations([
    entry('startup.ts', "import './tui/x.ts'\n"),
    entry('tui/x.ts', "import '../runtime/backend-loader.ts'\n"),
    entry('runtime/backend-loader.ts', ''),
  ]).length, 2)
  // The island's legitimate imports build no repository edge: packages, Node
  // built-ins, JSON data and a FULLY ERASED type face stay legal.
  assert.deepEqual(findStartupIslandViolations([
    entry('startup.ts', "import { Command } from 'commander'\nimport { readFileSync } from 'node:fs'\n"
      + "import compat from './dsh-compat-matrix.json' with { type: 'json' }\n"
      + "import type { Context } from '@deepseek-ai/cordis'\nimport type { X } from './tui/x.ts'\n"),
    entry('tui/x.ts', ''),
  ]), [])
  // Under verbatimModuleSyntax an INLINE type import still emits a runtime
  // module load, so it is a repository edge.
  assert.equal(findStartupIslandViolations([
    entry('startup.ts', "import { type X } from './tui/x.ts'\n"),
    entry('tui/x.ts', ''),
  ]).length, 1)
})
