/**
 * Host startup PATH augmentation (`src/app/remote-process/host-environment.ts`).
 *
 * Evidence level: unit semantics over the real decision function. Directory
 * existence, symlink following and the missing/file cases use the real
 * filesystem under the run-owned temp root; the inaccessible/invalid-value
 * branches inject the directory probe so the classification is deterministic
 * on every account. The REAL Host process boot, official profile snapshot and
 * child execution are owned by the selectable split-process case, not here.
 *
 * @module @xmoon76/dsh-pi-tui/test/app/host-environment
 */

import assert from 'node:assert/strict'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import {
  INVALID_HOST_PATH_MODE,
  resolveHostPath,
  type HostPathDirectoryStat,
} from '../../src/app/remote-process/host-environment.ts'
import { testLifecycle } from '../support/temp-lifecycle.ts'

/** One run-owned real directory. */
function tempRoot(t: TestContext): string {
  return testLifecycle(t).tempDir('dsh-pi-tui-host-environment-')
}

/** Create and return one real directory. */
function directory(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

/** The appended suffix of one augmented PATH; an unchanged PATH yields no suffix. */
function appendedOf(env: Readonly<NodeJS.ProcessEnv>, path: string | undefined): string[] {
  assert.notEqual(path, undefined)
  const original = env.PATH === undefined || env.PATH === '' ? undefined : env.PATH
  if (original === undefined) return (path as string).split(':')
  assert.ok((path as string).startsWith(`${original}:`), 'the inherited PATH must stay the exact prefix')
  return (path as string).slice(original.length + 1).split(':')
}

/** One injected probe over a fixed directory set; the rest is a normal absence. */
function probeOf(present: readonly string[], inaccessible: readonly string[] = []): (path: string) => HostPathDirectoryStat {
  const existing = new Set(present)
  const unreadable = new Set(inaccessible)
  return path => {
    if (unreadable.has(path)) throw Object.assign(new Error(`EACCES: ${path}`), { code: 'EACCES' })
    if (!existing.has(path)) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
    return { isDirectory: () => true }
  }
}

test('augment keeps the inherited PATH bytes and appends only existing common directories', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const localBin = directory(join(home, '.local', 'bin'))
  const homeBin = directory(join(home, 'bin'))
  const cargoBin = directory(join(home, '.cargo', 'bin'))
  // A regular file where a tool directory would be must not become a PATH entry.
  mkdirSync(join(home, '.bun'), { recursive: true })
  writeFileSync(join(home, '.bun', 'bin'), 'not a directory')
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: 'custom-first:/usr/bin::relative:custom-first:/bin',
  }

  const result = resolveHostPath({ env, platform: 'linux' })

  assert.equal(result.mode, 'augment')
  assert.equal(result.skippedInvalidCount, 0)
  assert.equal(result.skippedInaccessibleCount, 0)
  const inherited = env.PATH!.split(':')
  assert.deepEqual((result.path as string).split(':').slice(0, inherited.length), inherited)
  const appended = appendedOf(env, result.path)
  assert.equal(result.addedPathCount, appended.length)
  assert.ok(appended.includes(localBin), 'an existing common user bin directory is appended')
  assert.ok(appended.includes(homeBin))
  assert.ok(appended.includes(cargoBin))
  assert.ok(!appended.includes(join(home, '.bun', 'bin')), 'a regular file is not a PATH entry')
  assert.ok(!appended.includes(join(home, '.volta', 'bin')), 'a missing directory is not a PATH entry')
  assert.ok(!appended.includes('/opt/homebrew/bin'), 'the other platform package-manager group does not participate')
  assert.equal(appended.includes(''), false, 'no empty PATH segment is introduced')
  assert.equal(new Set(appended).size, appended.length, 'each appended directory appears once')
})

test('a missing or empty inherited PATH becomes only the existing absolute candidates', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const localBin = directory(join(home, '.local', 'bin'))

  const missing = resolveHostPath({ env: { HOME: home }, platform: 'linux', statDirectory: probeOf([localBin]) })
  assert.equal(missing.path, localBin)
  assert.equal(missing.addedPathCount, 1)

  const empty = resolveHostPath({ env: { HOME: home, PATH: '' }, platform: 'linux', statDirectory: probeOf([localBin]) })
  assert.equal(empty.path, localBin)

  const none = resolveHostPath({ env: { HOME: home }, platform: 'linux', statDirectory: probeOf([]) })
  assert.equal(none.path, undefined)
  assert.equal(none.addedPathCount, 0)

  const noneEmpty = resolveHostPath({ env: { HOME: home, PATH: '' }, platform: 'linux', statDirectory: probeOf([]) })
  assert.equal(noneEmpty.path, '')
  assert.equal(noneEmpty.addedPathCount, 0)
})

test('explicit tool configuration is appended before the regular user defaults', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  directory(join(home, '.local', 'bin'))
  const miseShims = directory(join(root, 'mise-shims'))
  const miseData = directory(join(root, 'mise-data'))
  directory(join(miseData, 'shims'))
  const xdg = directory(join(root, 'xdg'))
  directory(join(xdg, 'mise', 'shims'))
  directory(join(xdg, 'pnpm'))
  directory(join(home, '.local', 'share', 'mise', 'shims'))

  const shimsFirst = resolveHostPath({
    env: { HOME: home, PATH: '/usr/bin', MISE_SHIMS_DIR: miseShims, MISE_DATA_DIR: miseData, XDG_DATA_HOME: xdg },
    platform: 'linux',
  })
  const shimsAppended = appendedOf({ PATH: '/usr/bin' }, shimsFirst.path)
  assert.ok(shimsAppended.includes(miseShims))
  assert.ok(!shimsAppended.includes(join(miseData, 'shims')), 'one tool selects exactly one configured location')
  assert.ok(!shimsAppended.includes(join(xdg, 'mise', 'shims')))

  const dataFirst = resolveHostPath({
    env: { HOME: home, PATH: '/usr/bin', MISE_DATA_DIR: miseData, XDG_DATA_HOME: xdg },
    platform: 'linux',
  })
  const dataAppended = appendedOf({ PATH: '/usr/bin' }, dataFirst.path)
  assert.ok(dataAppended.includes(join(miseData, 'shims')))
  assert.ok(!dataAppended.includes(join(xdg, 'mise', 'shims')))

  const xdgFirst = resolveHostPath({ env: { HOME: home, PATH: '/usr/bin', XDG_DATA_HOME: xdg }, platform: 'linux' })
  const xdgAppended = appendedOf({ PATH: '/usr/bin' }, xdgFirst.path)
  assert.ok(xdgAppended.includes(join(xdg, 'mise', 'shims')))
  assert.ok(xdgAppended.includes(join(xdg, 'pnpm')), 'Linux pnpm follows the explicit XDG data home')
  assert.ok(xdgAppended.indexOf(join(xdg, 'mise', 'shims')) < xdgAppended.indexOf(join(home, '.local', 'bin')),
    'the explicit group precedes the regular user defaults')
})

test('a configured location that does not exist never falls back to the tool default', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const missingShims = join(root, 'missing-shims')
  const defaultShims = directory(join(home, '.local', 'share', 'mise', 'shims'))

  const result = resolveHostPath({
    env: { HOME: home, PATH: '/usr/bin', MISE_SHIMS_DIR: missingShims },
    platform: 'linux',
  })

  const appended = appendedOf({ PATH: '/usr/bin' }, result.path)
  assert.ok(!appended.includes(missingShims))
  assert.ok(!appended.includes(defaultShims), 'a usable override uses only its own location')
})

test('each supported tool reads its own override in table order', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const asdfShims = directory(join(root, 'asdf', 'shims'))
  const cargoHome = directory(join(root, 'cargo'))
  const cargoBin = directory(join(cargoHome, 'bin'))
  const gobin = directory(join(root, 'gobin'))
  const voltaHome = directory(join(root, 'volta'))
  const voltaBin = directory(join(voltaHome, 'bin'))
  const bunInstall = directory(join(root, 'bun'))
  const bunBin = directory(join(bunInstall, 'bin'))
  const pnpmHome = directory(join(root, 'pnpm-home'))

  const result = resolveHostPath({
    env: {
      HOME: home,
      PATH: '/usr/bin',
      ASDF_DATA_DIR: join(root, 'asdf'),
      CARGO_HOME: cargoHome,
      GOBIN: gobin,
      VOLTA_HOME: voltaHome,
      BUN_INSTALL: bunInstall,
      PNPM_HOME: pnpmHome,
    },
    platform: 'linux',
  })

  const appended = appendedOf({ PATH: '/usr/bin' }, result.path)
  const expectedOrder = [asdfShims, cargoBin, gobin, voltaBin, bunBin, pnpmHome]
  const indexes = expectedOrder.map(path => appended.indexOf(path))
  assert.ok(indexes.every(index => index >= 0), `every configured location is appended: ${JSON.stringify(indexes)}`)
  assert.deepEqual([...indexes].sort((left, right) => left - right), indexes)
})

test('macOS pnpm uses the platform default while XDG still owns mise', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const xdg = directory(join(root, 'xdg'))
  directory(join(xdg, 'mise', 'shims'))
  const pnpmDefault = directory(join(home, 'Library', 'pnpm'))

  const result = resolveHostPath({ env: { HOME: home, PATH: '/usr/bin', XDG_DATA_HOME: xdg }, platform: 'darwin' })
  const appended = appendedOf({ PATH: '/usr/bin' }, result.path)
  assert.ok(appended.includes(join(xdg, 'mise', 'shims')))
  assert.ok(appended.includes(pnpmDefault))
  assert.ok(!appended.includes(join(xdg, 'pnpm')))
})

test('home resolution falls back to the OS account without writing the environment', t => {
  const root = tempRoot(t)
  const accountHome = directory(join(root, 'account-home', 'alice'))
  const accountBin = directory(join(accountHome, '.local', 'bin'))
  const envWithHome: NodeJS.ProcessEnv = { HOME: directory(join(root, 'declared-home')), DSH_HOME: join(root, 'dsh-home') }
  let accountCalls = 0

  const declared = resolveHostPath({
    env: envWithHome,
    platform: 'linux',
    accountHome: () => {
      accountCalls += 1
      return accountHome
    },
    statDirectory: probeOf([accountBin]),
  })
  assert.equal(accountCalls, 0, 'a usable HOME is authoritative')
  assert.equal(declared.homeAvailable, true)

  const envWithoutHome: NodeJS.ProcessEnv = { DSH_HOME: join(root, 'dsh-home') }
  const fallback = resolveHostPath({
    env: envWithoutHome,
    platform: 'linux',
    accountHome: () => {
      accountCalls += 1
      return accountHome
    },
    statDirectory: probeOf([accountBin]),
  })
  assert.equal(accountCalls, 1)
  assert.equal(fallback.path, accountBin)
  assert.equal(envWithoutHome.HOME, undefined, 'the fallback never writes HOME back')
  assert.equal(envWithoutHome.DSH_HOME, join(root, 'dsh-home'), 'DSH_HOME never substitutes the user home')

  const invalidHome = resolveHostPath({
    env: { HOME: 'relative/home' },
    platform: 'linux',
    accountHome: () => accountHome,
    statDirectory: probeOf([accountBin]),
  })
  assert.equal(invalidHome.path, accountBin)

  const overridesOnly = resolveHostPath({
    env: { MISE_SHIMS_DIR: directory(join(root, 'override-shims')) },
    platform: 'linux',
    accountHome: () => '',
    statDirectory: probeOf([join(root, 'override-shims')]),
  })
  assert.equal(overridesOnly.homeAvailable, false)
  assert.ok((overridesOnly.path as string).split(':').includes(join(root, 'override-shims')))
})

test('invalid explicit values are counted and replaced by the tool default', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const defaultCargoBin = directory(join(home, '.cargo', 'bin'))

  const result = resolveHostPath({
    env: {
      HOME: home,
      PATH: '/usr/bin',
      MISE_SHIMS_DIR: 'relative/shims',
      ASDF_DATA_DIR: '~/asdf',
      CARGO_HOME: '/cargo:home',
      BUN_INSTALL: '/bun\0install',
    },
    platform: 'linux',
    statDirectory: probeOf([defaultCargoBin]),
  })

  assert.equal(result.skippedInvalidCount, 4)
  const appended = appendedOf({ PATH: '/usr/bin' }, result.path)
  assert.ok(appended.includes(defaultCargoBin), 'an invalid override falls back to the tool default')
  assert.ok(!appended.some(path => path.includes('relative/shims') || path.includes('~') || path.includes('\0')))
})

test('an unreadable candidate is skipped with a warning count while unknown failures propagate', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const localBin = join(home, '.local', 'bin')
  const homeBin = join(home, 'bin')

  const unreadable = resolveHostPath({
    env: { HOME: home, PATH: '/usr/bin' },
    platform: 'linux',
    statDirectory: probeOf([], [localBin, homeBin]),
  })
  assert.equal(unreadable.skippedInaccessibleCount, 2)
  assert.equal(unreadable.path, '/usr/bin', 'an unreadable candidate is never appended')

  assert.throws(
    () => resolveHostPath({
      env: { HOME: home },
      platform: 'linux',
      statDirectory: () => {
        throw Object.assign(new Error('EIO: an unexpected I/O failure'), { code: 'EIO' })
      },
    }),
    /EIO/,
  )
})

test('real filesystem entries: dangling links and regular files are absent, a directory symlink is appended', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const linkedTarget = directory(join(root, 'linked-target'))
  const linkedShims = join(root, 'linked-shims')
  symlinkSync(linkedTarget, linkedShims)
  const danglingShims = join(root, 'dangling-shims')
  symlinkSync(join(root, 'does-not-exist'), danglingShims)
  mkdirSync(join(home, '.go'), { recursive: true })
  writeFileSync(join(home, '.go', 'bin'), 'not a directory')

  const linked = resolveHostPath({ env: { HOME: home, PATH: '/usr/bin', MISE_SHIMS_DIR: linkedShims }, platform: 'linux' })
  assert.ok(appendedOf({ PATH: '/usr/bin' }, linked.path).includes(linkedShims), 'a legal directory symlink is a directory')
  assert.equal(linked.skippedInaccessibleCount, 0)

  const dangling = resolveHostPath({ env: { HOME: home, PATH: '/usr/bin', MISE_SHIMS_DIR: danglingShims }, platform: 'linux' })
  assert.ok(!appendedOf({ PATH: '/usr/bin' }, dangling.path).includes(danglingShims))
  assert.equal(dangling.skippedInaccessibleCount, 0)
  assert.equal(dangling.skippedInvalidCount, 0)

  const regularFile = resolveHostPath({ env: { HOME: home, PATH: '/usr/bin', GOBIN: join(home, '.go', 'bin') }, platform: 'linux' })
  assert.ok(!appendedOf({ PATH: '/usr/bin' }, regularFile.path).includes(join(home, '.go', 'bin')))
  assert.equal(regularFile.skippedInaccessibleCount, 0)
})

test('inherit leaves every PATH shape untouched and consults neither home nor the filesystem', t => {
  const root = tempRoot(t)
  const untouched = [
    resolveHostPath({
      env: { PATH: undefined, DSH_PI_TUI_HOST_PATH_MODE: 'inherit' },
      platform: 'darwin',
      accountHome: () => { throw new Error('inherit must not resolve an account home') },
      statDirectory: () => { throw new Error('inherit must not stat a candidate') },
    }),
    resolveHostPath({
      env: { PATH: '', DSH_PI_TUI_HOST_PATH_MODE: 'inherit' },
      platform: 'linux',
      statDirectory: () => { throw new Error('inherit must not stat a candidate') },
    }),
    resolveHostPath({
      env: { PATH: 'a:/usr/bin:relative', DSH_PI_TUI_HOST_PATH_MODE: 'inherit' },
      platform: 'linux',
      statDirectory: () => { throw new Error('inherit must not stat a candidate') },
    }),
  ]
  assert.deepEqual(untouched.map(result => [result.mode, result.path, result.addedPathCount]), [
    ['inherit', undefined, 0],
    ['inherit', '', 0],
    ['inherit', 'a:/usr/bin:relative', 0],
  ])
  assert.ok(untouched.every(result => result.homeAvailable === undefined))

  for (const invalid of ['', ' ', 'true', 'off', 'AUGMENT', 'augment ']) {
    assert.throws(
      () => resolveHostPath({ env: { PATH: '/usr/bin', DSH_PI_TUI_HOST_PATH_MODE: invalid }, platform: 'linux' }),
      { message: INVALID_HOST_PATH_MODE },
    )
  }
  assert.throws(
    () => resolveHostPath({ env: { PATH: '/usr/bin', DSH_PI_TUI_HOST_PATH_MODE: 'off' }, platform: 'linux' }),
    (error: unknown) => error instanceof Error && !error.message.includes('off'),
    'the invalid value is never echoed',
  )
  assert.equal(resolveHostPath({ env: { PATH: '/usr/bin' }, platform: 'linux', statDirectory: probeOf([]) }).mode, 'augment')
})

test('known directories are deduplicated and resolving twice changes no environment field', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const localBin = directory(join(home, '.local', 'bin'))
  const cargoBin = directory(join(home, '.cargo', 'bin'))
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PATH: `custom:${localBin}:custom:/usr/bin`,
    GOBIN: cargoBin,
  }
  const keysBefore = Object.keys(env).sort()
  const valuesBefore = { ...env }

  const first = resolveHostPath({ env, platform: 'linux', statDirectory: probeOf([localBin, cargoBin]) })
  const second = resolveHostPath({ env, platform: 'linux', statDirectory: probeOf([localBin, cargoBin]) })

  assert.deepEqual(first, second)
  const appended = appendedOf(env, first.path)
  assert.ok(!appended.includes(localBin), 'an inherited directory is never appended again')
  assert.equal(appended.filter(path => path === cargoBin).length, 1,
    'two rows that select the same directory produce one PATH entry')
  assert.deepEqual(Object.keys(env).sort(), keysBefore)
  assert.deepEqual({ ...env }, valuesBefore, 'resolving never writes the environment')
})

test('an inherited directory for the same tool stays ahead of every appended candidate', t => {
  const root = tempRoot(t)
  const home = directory(join(root, 'home'))
  const explicitBin = directory(join(root, 'explicit-bin'))
  const pnpmHome = directory(join(root, 'pnpm-home'))
  const env: NodeJS.ProcessEnv = { HOME: home, PATH: `${explicitBin}:/usr/bin`, PNPM_HOME: pnpmHome }

  const result = resolveHostPath({ env, platform: 'linux' })
  const segments = (result.path as string).split(':')

  assert.ok(segments.indexOf(explicitBin) < segments.indexOf(pnpmHome),
    'the inherited PATH keeps its precedence over every appended directory')
})
