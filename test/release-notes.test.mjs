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
 * instead of being re-written by hand for every release. */
const CURRENT_VERSION = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version
const CURRENT_CHANNEL = CURRENT_VERSION.includes('-') ? 'next' : 'stable'
const CURRENT_TAG = `${CURRENT_CHANNEL === 'next' ? 'next-' : ''}v${CURRENT_VERSION}`

function currentGuidance(omit) {
  const entries = requiredGuidance(CURRENT_VERSION).filter(command => command !== omit)
  return `\n${entries.map(command => `- ${command}`).join('\n')}`
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function createFixture(life, { version, englishDate = '2026-08-28', chineseDate = englishDate, guidance = '', channel = 'stable' }) {
  const root = life.tempDir('dsh-pi-tui-release-notes-')
  const comparePrefix = channel === 'next' ? 'next-v' : 'v'
  const output = join(root, 'release-notes.md')
  const packageJson = join(root, 'package.json')
  const chinese = join(root, 'CHANGELOG.md')
  const english = join(root, 'CHANGELOG.en.md')

  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true })
  mkdirSync(join(root, 'src'), { recursive: true })
  cpSync(join(repo, 'scripts/release-context.mjs'), join(root, 'scripts', 'release-context.mjs'))
  cpSync(join(repo, 'scripts/release-notes.mjs'), join(root, 'scripts', 'release-notes.mjs'))
  cpSync(join(repo, 'scripts/lib/dsh-compat.mjs'), join(root, 'scripts', 'lib', 'dsh-compat.mjs'))
  cpSync(join(repo, 'src', 'dsh-compat-matrix.json'), join(root, 'src', 'dsh-compat-matrix.json'))
  writeFileSync(packageJson, `${JSON.stringify({ name: '@xmoon76/dsh-pi-tui', version }, null, 2)}\n`)
  writeFileSync(chinese, `# 更新日志\n\n## [Unreleased]\n\n## [${version}] - ${chineseDate}\n\n### 变更\n\n- 中文迁移说明。${guidance}\n\n[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}${version}...HEAD\n[${version}]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}0.0.0...${comparePrefix}${version}\n`)
  writeFileSync(english, `# Changelog\n\n## [Unreleased]\n\n## [${version}] - ${englishDate}\n\n### Changes\n\n- English migration note.${guidance}\n\n[Unreleased]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}${version}...HEAD\n[${version}]: https://github.com/XMoon/dsh-pi-tui/compare/${comparePrefix}0.0.0...${comparePrefix}${version}\n`)
  return { root, output, packageJson, chinese, english }
}

function run(fixture, input) {
  return spawnSync(
    process.execPath,
    [join(fixture.root, 'scripts', 'release-notes.mjs'), input, fixture.output],
    { cwd: fixture.root, encoding: 'utf8' },
  )
}

test('release-notes accepts stable v tags and next-v prerelease tags', (t) => {
  const life = testLifecycle(t)
  const stable = createFixture(life, { version: '1.2.3' })
  const result = run(stable, 'v1.2.3')
  assert.equal(result.status, 0, result.stderr)
  const body = readFileSync(stable.output, 'utf8')
  assert.match(body, /^## 中文/m)
  assert.match(body, /^## English/m)

  const next = createFixture(life, { version: '1.2.3-alpha.1', channel: 'next' })
  const nextResult = run(next, 'next-v1.2.3-alpha.1')
  assert.equal(nextResult.status, 0, nextResult.stderr)
  assert.match(readFileSync(next.output, 'utf8'), /English migration note\./)
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

  const wrongChannel = createFixture(life, { version: '1.2.3-alpha.1' })
  const wrongChannelResult = run(wrongChannel, 'next-v1.2.3-alpha.1')
  assert.notEqual(wrongChannelResult.status, 0)
  assert.match(wrongChannelResult.stderr, /matching next release reference links/u)

  const wrongRepository = createFixture(life, { version: '1.2.3' })
  for (const path of [wrongRepository.chinese, wrongRepository.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('https://github.com/XMoon/dsh-pi-tui/compare/', 'https://example.invalid/compare/'))
  }
  const wrongRepositoryResult = run(wrongRepository, 'v1.2.3')
  assert.notEqual(wrongRepositoryResult.status, 0)
  assert.match(wrongRepositoryResult.stderr, /matching stable release reference links/u)

  const lookalikeRepository = createFixture(life, { version: '1.2.3' })
  for (const path of [lookalikeRepository.chinese, lookalikeRepository.english]) {
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll('https://github.com/XMoon/dsh-pi-tui/compare/', 'https://githubXcom/XMoon/dsh-pi-tui/compare/'))
  }
  const lookalikeRepositoryResult = run(lookalikeRepository, 'v1.2.3')
  assert.notEqual(lookalikeRepositoryResult.status, 0)
  assert.match(lookalikeRepositoryResult.stderr, /matching stable release reference links/u)
})

test('the current release body documents every matrix install pairing', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: CURRENT_VERSION, guidance: currentGuidance(), channel: CURRENT_CHANNEL })
  const result = run(fixture, CURRENT_TAG)
  assert.equal(result.status, 0, result.stderr)
  const body = readFileSync(fixture.output, 'utf8')
  for (const command of requiredGuidance(CURRENT_VERSION)) {
    assert.ok(body.includes(command), `release body is missing ${command}`)
  }
  assert.doesNotMatch(body, /@xmoon76\/dsh-pi-tui@(latest|next)/u)
})

test('the release-notes gate rejects a body missing any matrix pairing', (t) => {
  const life = testLifecycle(t)
  for (const omitted of requiredGuidance(CURRENT_VERSION)) {
    const fixture = createFixture(life, { version: CURRENT_VERSION, guidance: currentGuidance(omitted), channel: CURRENT_CHANNEL })
    const result = run(fixture, CURRENT_TAG)
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

test('release-notes rejects malformed or channel-inconsistent tags', (t) => {
  const life = testLifecycle(t)
  const fixture = createFixture(life, { version: '1.2.3' })
  for (const input of ['next-v1.2.3', 'v1.2.3-alpha.1', 'release-v1.2.3']) {
    const result = run(fixture, input)
    assert.notEqual(result.status, 0, `${input} unexpectedly passed`)
  }
})
