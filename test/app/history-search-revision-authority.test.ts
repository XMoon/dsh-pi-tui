/**
 * The pass-scoped official persistence revision authority.
 *
 * The REAL official `@deepseek-ai/dsh-session-persistence-jsonl` plugin is
 * mounted through a real Cordis Loader in a controlled Host Context, so the
 * classifier proves the ACTUAL service registration, provider entry, effective
 * config, package resolution and published package bytes. Negatives are
 * separate controlled contexts: a non-official provider, an unsupported app
 * pin, a relative root and a same-name package with altered bytes.
 *
 * PRODUCTION PREREQUISITES REPRODUCED
 * - the official installed rc.5 JSONL persistence package and its official
 *   persistence/session/format seam packages (real published bytes)
 * - a real Cordis Loader entry, activation fiber and service registration
 * - the official `PluginPackages` lookup over the real Loader base URL
 *
 * TEST STAND-INS
 * - the app anchor manifest is a test-owned file with the official name and
 *   version; only its name/version/anchoring path participate (its bytes are
 *   not a published discriminator)
 * - the profile directory and persistence root are disposable test directories
 * - fake provider packages are deliberately non-official negatives
 *
 * DELIBERATELY ABSENT
 * - no OS process restart (this is the L3 classifier layer; the packed smoke
 *   owns real OS processes)
 *
 * @module @xmoon76/dsh-pi-tui/history-search-revision-authority.test
 */

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { PluginPackages } from '@deepseek-ai/dsh-app-boot'
import {
  captureHistoryRevisionAuthority,
  sourceProofBasis,
  type HistoryRevisionAuthority,
  type HistoryRevisionSnapshotLike,
} from '../../src/app/host/features/history-search-revision-authority.ts'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const PROVIDER_PACKAGE = '@deepseek-ai/dsh-session-persistence-jsonl'
const WORKSPACE_ROOT = fileURLToPath(new URL('../../', import.meta.url))

function authority(root: string, options: {
  readonly codec?: 'none' | 'zstd'
  readonly scopeKey?: string
  readonly current?: boolean
} = {}): HistoryRevisionAuthority {
  const codec = options.codec ?? 'zstd'
  return {
    service: {},
    identity: Symbol('test-authority'),
    scopeKey: options.scopeKey ?? 'a'.repeat(64),
    root,
    codec,
    isCurrent: () => options.current ?? true,
  }
}

function snapshot(overrides: Partial<HistoryRevisionSnapshotLike> = {}): HistoryRevisionSnapshotLike {
  return {
    formatStatus: 'current',
    location: { kind: 'jsonl', path: `${'/root'}/sessions/s1.jsonl.zstd` },
    revision: 'rev-1',
    ...overrides,
  }
}

test('a valid current snapshot yields the exact opaque basis and never reads the source', () => {
  const root = '/root'
  const valid = snapshot()
  assert.deepEqual(sourceProofBasis(authority(root), valid), {
    scopeKey: 'a'.repeat(64),
    sourcePath: '/root/sessions/s1.jsonl.zstd',
    sourceRevision: 'rev-1',
  })
  // The opaque token is preserved literally, including surrounding spaces.
  assert.deepEqual(sourceProofBasis(authority(root), snapshot({ revision: '  rev  ' }))?.sourceRevision, '  rev  ')

  const misses: Array<[string, HistoryRevisionSnapshotLike, HistoryRevisionAuthority]> = [
    ['a non-current format', snapshot({ formatStatus: 'migration-required' }), authority(root)],
    ['an absent format classification', snapshot({ formatStatus: undefined }), authority(root)],
    ['a pending snapshot without location', { revision: 'rev-1' }, authority(root)],
    ['an unknown artifact kind', snapshot({ location: { kind: 'sqlite', path: '/root/sessions/s1.jsonl.zstd' } }), authority(root)],
    ['a non-string revision', snapshot({ revision: 7 }), authority(root)],
    ['an empty revision', snapshot({ revision: '' }), authority(root)],
    ['a relative location', snapshot({ location: { kind: 'jsonl', path: 'sessions/s1.jsonl.zstd' } }), authority(root)],
    ['a path outside the root', snapshot({ location: { kind: 'jsonl', path: '/elsewhere/s1.jsonl.zstd' } }), authority(root)],
    ['a sibling prefix outside the root', snapshot({ location: { kind: 'jsonl', path: '/root-sibling/s1.jsonl.zstd' } }), authority(root)],
    ['the root itself', snapshot({ location: { kind: 'jsonl', path: '/root' } }), authority(root)],
    ['a normalized escape', snapshot({ location: { kind: 'jsonl', path: '/root/../escape.jsonl.zstd' } }), authority(root)],
    ['a wrong codec suffix', snapshot(), authority(root, { codec: 'none' })],
    ['a zstd suffix under none', snapshot({ location: { kind: 'jsonl', path: '/root/s.jsonl.zstd' } }), authority(root, { codec: 'none' })],
    ['a stale authority', snapshot(), authority(root, { current: false })],
  ]
  for (const [label, candidate, current] of misses) {
    assert.equal(sourceProofBasis(current, candidate), undefined, `${label} must not qualify`)
  }

  // The none codec expects exactly the plain JSONL suffix.
  assert.equal(sourceProofBasis(authority(root, { codec: 'none' }), snapshot({
    location: { kind: 'jsonl', path: '/root/sessions/s1.jsonl' },
  }))?.sourcePath, '/root/sessions/s1.jsonl')
})

interface AuthorityFixture {
  readonly ctx: Context
  readonly persistence: object
  readonly entry: { readonly fiber?: { restart(): Promise<void> } }
  dispose(): Promise<void>
}

/** Mount one real or fake provider through a real Loader + PluginPackages. */
async function mountAuthorityFixture(
  life: TestLifecycle,
  options: {
    readonly root: string
    readonly anchorVersion?: string
    readonly provider: 'real' | 'fake' | 'wrong-owner'
    readonly configRoot?: string
  },
): Promise<AuthorityFixture> {
  const workRoot = life.tempDir('dsh-history-q-')
  const anchorDir = join(workRoot, 'anchor')
  mkdirSync(anchorDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(anchorDir, 'package.json'), JSON.stringify({
    name: '@deepseek-ai/dsh',
    version: options.anchorVersion ?? '0.2.2-rc.5',
  }), { mode: 0o600 })
  // Resolve the official seam packages exactly like the real installed app
  // anchor does, without installing a second copy.
  symlinkSync(join(WORKSPACE_ROOT, 'node_modules'), join(anchorDir, 'node_modules'), 'dir')
  const profileDir = join(workRoot, 'profile')
  mkdirSync(profileDir, { recursive: true, mode: 0o700 })

  let baseRoot = WORKSPACE_ROOT
  let entryName = PROVIDER_PACKAGE
  if (options.provider === 'wrong-owner') {
    const providerDir = join(workRoot, 'wrong-owner')
    mkdirSync(providerDir, { recursive: true, mode: 0o700 })
    const modulePath = join(providerDir, 'provider.mjs')
    writeFileSync(modulePath, [
      'export const name = "wrong-owner"',
      'export function apply(ctx) {',
      '  ctx.provide("sessionPersistence", { identity: Symbol("wrong-owner"), async stat() { return undefined }, async list() { return [] }, async open() { throw new Error("unused") } })',
      '}',
    ].join('\n'), { mode: 0o600 })
    entryName = pathToFileURL(modulePath).href
  }
  if (options.provider === 'fake') {
    const fakeRoot = join(workRoot, 'fake-root')
    const packageDir = join(fakeRoot, 'node_modules', '@deepseek-ai', 'dsh-session-persistence-jsonl')
    mkdirSync(packageDir, { recursive: true, mode: 0o700 })
    mkdirSync(join(fakeRoot, 'node_modules', '@deepseek-ai'), { recursive: true, mode: 0o700 })
    symlinkSync(
      join(WORKSPACE_ROOT, 'node_modules', '@deepseek-ai', 'schemastery'),
      join(fakeRoot, 'node_modules', '@deepseek-ai', 'schemastery'),
      'dir',
    )
    writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
      name: PROVIDER_PACKAGE,
      version: '0.2.2-rc.5',
      type: 'module',
      exports: { '.': './index.mjs' },
    }), { mode: 0o600 })
    writeFileSync(join(packageDir, 'index.mjs'), [
      'import z from "@deepseek-ai/schemastery"',
      'export const name = "fake-session-persistence-jsonl"',
      'export const Config = z.object({ root: z.string(), compression: z.union([z.const("zstd"), z.const("none")]).default("zstd") })',
      'export function apply(ctx) {',
      '  ctx.provide("sessionPersistence", { identity: Symbol("fake-session-persistence"), async stat() { return undefined }, async list() { return [] }, async open() { throw new Error("unused") } })',
      '}',
    ].join('\n'), { mode: 0o600 })
    writeFileSync(join(fakeRoot, 'package.json'), JSON.stringify({ name: 'fake-root', private: true }), { mode: 0o600 })
    baseRoot = fakeRoot
  }

  const ctx = new Context()
  await ctx.plugin(Loader, { baseUrl: pathToFileURL(join(baseRoot, 'package.json')).href })
  await ctx.plugin(PluginPackages)
  ctx.provide('profileContext', {
    name: 'history-q-fixture',
    dir: profileDir,
    patchPath: join(profileDir, 'cordis.patch.yml'),
    installAnchor: join(anchorDir, 'package.json'),
    cwd: workRoot,
    home: workRoot,
    startedBundles: [],
    overlays: [],
    telemetryDisabledEnv: undefined,
  } as never)
  const entryId = await ctx.loader.create({
    name: entryName,
    config: { root: options.configRoot ?? options.root },
  })
  const entry = [...ctx.loader.entries()].find(candidate => candidate.id === entryId)
  assert.ok(entry?.fiber !== undefined, 'the provider entry must own an activation fiber')
  await entry.fiber.await()
  const persistence = ctx.reflect.get('sessionPersistence') as object | undefined
  assert.ok(persistence !== undefined, 'the provider must register sessionPersistence')
  return {
    ctx,
    persistence,
    entry: entry as unknown as AuthorityFixture['entry'],
    dispose: () => ctx.fiber.dispose(),
  }
}

async function capture(fixture: AuthorityFixture): Promise<HistoryRevisionAuthority | undefined> {
  return captureHistoryRevisionAuthority(
    fixture.ctx,
    fixture.persistence,
    new AbortController().signal,
  )
}

test('the real installed JSONL provider qualifies and a provider restart invalidates it', async (t) => {
  const life = testLifecycle(t)
  const persistenceRoot = life.tempDir('dsh-history-q-root-')
  const fixture = await mountAuthorityFixture(life, { root: persistenceRoot, provider: 'real' })
  try {
    const captured = await capture(fixture)
    assert.ok(captured !== undefined, 'the real rc.5 provider must qualify')
    assert.equal(captured.root, persistenceRoot)
    assert.equal(captured.codec, 'zstd')
    assert.equal(captured.identity, (fixture.persistence as { identity: symbol }).identity)
    assert.equal(captured.isCurrent(), true)
    assert.equal(captured.scopeKey.length, 64)

    // A REAL Loader/provider restart replaces the raw service and the official
    // Symbol; the old pass authority must never qualify a later proof. The
    // Loader exposes a PromiseLike wrapper, so the restart targets the real
    // activation fiber the wrapper inherits from (the same object the provider
    // ancestry names).
    const activation = Object.getPrototypeOf(fixture.entry.fiber) as { restart(): Promise<void> }
    assert.notEqual(activation, fixture.entry.fiber)
    await activation.restart()
    assert.equal(captured.isCurrent(), false)
    const currentPersistence = fixture.ctx.reflect.get('sessionPersistence') as object
    const recaptured = await captureHistoryRevisionAuthority(
      fixture.ctx,
      currentPersistence,
      new AbortController().signal,
    )
    assert.ok(recaptured !== undefined, 'the new official instance may be qualified again')
    assert.notEqual(recaptured.service, captured.service)
    assert.notEqual(recaptured.identity, captured.identity)
    assert.equal(recaptured.isCurrent(), true)
  } finally {
    await fixture.dispose()
  }
})

test('an unsupported app pin, a relative root and a non-official provider are not qualified', async (t) => {
  const life = testLifecycle(t)

  const unsupportedPin = await mountAuthorityFixture(life, {
    root: life.tempDir('dsh-history-q-pin-root-'),
    anchorVersion: '0.2.2-rc.2',
    provider: 'real',
  })
  try {
    assert.equal(await capture(unsupportedPin), undefined)
  } finally {
    await unsupportedPin.dispose()
  }

  const relativeRoot = await mountAuthorityFixture(life, {
    root: life.tempDir('dsh-history-q-relative-root-'),
    provider: 'real',
    configRoot: 'relative-persistence-root',
  })
  try {
    assert.equal(await capture(relativeRoot), undefined)
  } finally {
    await relativeRoot.dispose()
  }

  const wrongOwner = await mountAuthorityFixture(life, {
    root: life.tempDir('dsh-history-q-owner-root-'),
    provider: 'wrong-owner',
  })
  try {
    assert.equal(await capture(wrongOwner), undefined)
  } finally {
    await wrongOwner.dispose()
  }
})

test('a same-name provider whose published bytes differ is not qualified', async (t) => {
  const life = testLifecycle(t)
  const fixture = await mountAuthorityFixture(life, {
    root: life.tempDir('dsh-history-q-fake-root-'),
    provider: 'fake',
  })
  try {
    const captured = await capture(fixture)
    assert.equal(captured, undefined, 'the package discriminator must reject an unverified same-name package')
  } finally {
    await fixture.dispose()
  }
})
