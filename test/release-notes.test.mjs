import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { testLifecycle } from './support/temp-lifecycle.ts'
import { requiredGuidance } from '../scripts/lib/dsh-compat.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The version this checkout ships. The gate only ever validates the current
 * line, so the expectations below are generated from the shared matrix
 * instead of being re-written by hand for every release. The tag prefix is
 * chosen explicitly per test: a version string alone cannot encode the
 * publication channel. */
const CURRENT_VERSION = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version

function currentGuidance(omit) {
  const entries = requiredGuidance(CURRENT_VERSION).filter(command => command !== omit)
  return `\n${entries.map(command => `- ${command}`).join('\n')}`
}

/** The pairing bullets a release body must carry from the 0.4 line onward;
 * fixtures get them by default so the generic tag/structure cases exercise
 * the same gate a real release faces. */
function guidanceBullets(version) {
  return `\n${requiredGuidance(version).map(command => `- ${command}`).join('\n')}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function createFixture(life, { version, englishDate = '2026-08-28', chineseDate = englishDate, guidance = undefined, channel = 'latest' }) {
  const root = life.tempDir('dsh-pi-tui-release-notes-')
  const comparePrefix = channel === 'next' ? 'next-v' : 'v'
  const output = join(root, 'release-notes.md')
  const packageJson = join(root, 'package.json')
  const chinese = join(root, 'CHANGELOG.md')
  const english = join(root, 'CHANGELOG.en.md')
  const injectedGuidance = guidance ?? guidanceBullets(version)

  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  cpSync(join(repo, 'scripts/release-context.mjs'), join(root, 'scripts', 'release-context.mjs'))
  cpSync(join(repo, 'scripts/release-notes.mjs'), join(root, 'scripts', 'release-notes.mjs'))
  cpSync(join(repo, 'scripts/lib/dsh-compat.mjs'), join(root, 'scripts', 'lib', 'dsh-compat.mjs'))
  cpSync(join(repo, 'src', 'dsh-compat-matrix.json'), join(root, 'src', 'dsh-compat-matrix.json'))
  writeFileSync(packageJson, `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version }, null, 2)}\n`)
  writeFileSync(chinese, `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - ${chineseDate}\n\n### 变更\n\n- 中文迁移说明。${injectedGuidance}\n\n[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}${version}...HEAD\n[${version}]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}0.0.0...${comparePrefix}${version}\n`)
  writeFileSync(english, `# Changelog\n\n## [Unreleased]\n\n## [${version}] - ${englishDate}\n\n### Changes\n\n- English migration note.${injectedGuidance}\n\n[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}${version}...HEAD\n[${version}]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}0.0.0...${comparePrefix}${version}\n`)
  return { root, output, packageJson, chinese, english }
}

function run(fixture, input) {
  return spawnSync(
    process.execPath,
    [join(fixture.root, 'scripts', 'release-notes.mjs'), input, fixture.output],
    { cwd: fixture.root, encoding: 'utf8' },
  )
}

test('release-notes accepts both channels with stable and prerelease SemVer', (t) => {
  const life = testLifecycle(t)

  // The four prefix × maturity combinations: the tag prefix selects the
  // channel; the SemVer suffix never does.
  const stableLatest = createFixture(life, { version: '1.2.3', channel: 'latest' })
  const stableLatestResult = run(stableLatest, 'v1.2.3')
  assert.equal(stableLatestResult.status, 0, stableLatestResult.stderr)
  const body = readFileSync(stableLatest.output, 'utf8')
  assert.match(body, /^## 中文/m)
  assert.match(body, /^## English/m)

  const rcLatest = createFixture(life, { version: '1.2.3-rc.1', channel: 'latest' })
  const rcLatestResult = run(rcLatest, 'v1.2.3-rc.1')
  assert.equal(rcLatestResult.status, 0, rcLatestResult.stderr)
  assert.match(readFileSync(rcLatest.output, 'utf8'), /English migration note\./)

  const stableNext = createFixture(life, { version: '1.2.3', channel: 'next' })
  const stableNextResult = run(stableNext, 'next-v1.2.3')
  assert.equal(stableNextResult.status, 0, stableNextResult.stderr)
  assert.match(readFileSync(stableNext.output, 'utf8'), /English migration note\./)

  const alphaNext = createFixture(life, { version: '1.2.3-alpha.1', channel: 'next' })
  const alphaNextResult = run(alphaNext, 'next-v1.2.3-alpha.1')
  assert.equal(alphaNextResult.status, 0, alphaNextResult.stderr)
  assert.match(readFileSync(alphaNext.output, 'utf8'), /English migration note\./)
})

test('release-notes rejects bare versions: a version cannot encode a channel', (t) => {
  const life = testLifecycle(t)
  const stable = createFixture(life, { version: '1.2.3' })
  const stableResult = run(stable, '1.2.3')
  assert.notEqual(stableResult.status, 0, 'a bare stable version unexpectedly passed')
  assert.match(stableResult.stderr, /unsupported release tag 1\.2\.3/u)

  const prerelease = createFixture(life, { version: '1.2.3-rc.1' })
  const prereleaseResult = run(prerelease, '1.2.3-rc.1')
  assert.notEqual(prereleaseResult.status, 0, 'a bare prerelease version unexpectedly passed')
  assert.match(prereleaseResult.stderr, /unsupported release tag 1\.2\.3-rc\.1/u)
})

test('release-notes requires a dated current section directly after Unreleased and reference links', (t) => {
  const life = testLifecycle(t)
  const undated = createFixture(life, { version: '1.2.3', englishDate: 'not-a-date' })
  const undatedResult = run(undated, 'v1.2.3')
  assert.notEqual(undatedResult.status, 0)
  assert.match(undatedResult.stderr, /YYYY-MM-DD release date/u)

  const missingUnreleased = createFixture(life, { version: '1.2.3' })
  for (const path of [missingUnreleased.chinese, missingUnreleased.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replace('## [Unreleased]\n\n', ''))
  }
  const missingUnreleasedResult = run(missingUnreleased, 'v1.2.3')
  assert.notEqual(missingUnreleasedResult.status, 0)
  assert.match(missingUnreleasedResult.stderr, /must contain an Unreleased section/u)

  const misplacedUnreleased = createFixture(life, { version: '1.2.3' })
  for (const path of [misplacedUnreleased.chinese, misplacedUnreleased.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replace('# 更新日志\n\n', '# 更新日志\n\n## [1.2.2] - 2026-08-27\n\n### 变更\n\n- 历史条目。\n\n'))
  }
  writeFileSync(misplacedUnreleased.english, readFileSync(misplacedUnreleased.english, 'utf8').replace('# Changelog\n\n', '# Changelog\n\n## [1.2.2] - 2026-08-27\n\n### Changes\n\n- Historical entry.\n\n'))
  const misplacedUnreleasedResult = run(misplacedUnreleased, 'v1.2.3')
  assert.notEqual(misplacedUnreleasedResult.status, 0)
  assert.match(misplacedUnreleasedResult.stderr, /Unreleased as the first changelog section/u)

  const misplaced = createFixture(life, { version: '1.2.3' })
  for (const path of [misplaced.chinese, misplaced.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replace('## [Unreleased]\n\n##', '## [Unreleased]\n\n- pending\n\n##'))
  }
  const misplacedResult = run(misplaced, 'v1.2.3')
  assert.notEqual(misplacedResult.status, 0)
  assert.match(misplacedResult.stderr, /immediately follow an empty Unreleased/u)

  const missingReferences = createFixture(life, { version: '1.2.3' })
  for (const path of [missingReferences.chinese, missingReferences.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^\[1\.2\.3\]:.*\n?/mu, ''))
  }
  const missingReferencesResult = run(missingReferences, 'v1.2.3')
  assert.notEqual(missingReferencesResult.status, 0)
  assert.match(missingReferencesResult.stderr, /release reference links/u)

  const wrongChannel = createFixture(life, { version: '1.2.3-rc.1' })
  const wrongChannelResult = run(wrongChannel, 'next-v1.2.3-rc.1')
  assert.notEqual(wrongChannelResult.status, 0)
  assert.match(wrongChannelResult.stderr, /matching next release reference links/u)

  const wrongRepository = createFixture(life, { version: '1.2.3' })
  for (const path of [wrongRepository.chinese, wrongRepository.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('https://github.com/XMoon/dsh-pi-tui/compare/', 'https://example.invalid/compare/'))
  }
  const wrongRepositoryResult = run(wrongRepository, 'v1.2.3')
  assert.notEqual(wrongRepositoryResult.status, 0)
  assert.match(wrongRepositoryResult.stderr, /matching latest release reference links/u)

  const lookalikeRepository = createFixture(life, { version: '1.2.3' })
  for (const path of [lookalikeRepository.chinese, lookalikeRepository.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('https://github.com/XMoon/dsh-pi-tui/compare/', 'https://githubXcom/XMoon/dsh-pi-tui/compare/'))
  }
  const lookalikeRepositoryResult = run(lookalikeRepository, 'v1.2.3')
  assert.notEqual(lookalikeRepositoryResult.status, 0)
  assert.match(lookalikeRepositoryResult.stderr, /matching latest release reference links/u)
})

test('the current release body documents every matrix install pairing under either tag prefix', (t) => {
  const life = testLifecycle(t)
  // The channel cannot be derived from CURRENT_VERSION (a -rc.* package
  // version must not silently select the next channel), so the current
  // release body gate is exercised explicitly under both tag prefixes.
  for (const channel of ['latest', 'next']) {
    const tag = `${channel === 'next' ? 'next-' : ''}v${CURRENT_VERSION}`
    const fixture = createFixture(life, { version: CURRENT_VERSION, guidance: currentGuidance(), channel })
    const result = run(fixture, tag)
    assert.equal(result.status, 0, result.stderr)
    const body = readFileSync(fixture.output, 'utf8')
    for (const command of requiredGuidance(CURRENT_VERSION)) {
      assert.ok(body.includes(command), `release body is missing ${command}`)
    }
    assert.doesNotMatch(body, /@xmoon76\/dsh-pi-tui@(latest|next)/u)
  }
})

test('the release-notes gate rejects a body missing any matrix pairing', (t) => {
  const life = testLifecycle(t)
  const tag = `v${CURRENT_VERSION}`
  for (const omitted of requiredGuidance(CURRENT_VERSION)) {
    const fixture = createFixture(life, { version: CURRENT_VERSION, guidance: currentGuidance(omitted), channel: 'latest' })
    const result = run(fixture, tag)
    assert.notEqual(result.status, 0, `omitting ${omitted} unexpectedly passed`)
    assert.match(result.stderr, new RegExp(`must document ${escapeRegExp(omitted)}`, 'u'))
  }
})

test('release-notes rejects bilingual heading/date mismatch', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: '1.2.3', chineseDate: '2026-08-28', englishDate: '2026-08-29' })
  const result = run(fixture, 'v1.2.3')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Changelog headings do not match/)
})

test('release-notes rejects malformed tags', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: '1.2.3' })
  for (const input of ['release-v1.2.3', 'next-v1.2.3!']) {
    const result = run(fixture, input)
    assert.notEqual(result.status, 0, `${input} unexpectedly passed`)
  }
})
