/**
 * Tests for the `!`/`!!` bash completion bridge (docs/architecture/surface-behavior.md
 * §1): the cursor-context parser, the compgen-backed suggestion paths
 * (command names, `$VAR` names, git subcommands) against a REAL bash, the
 * degradation when bash is unavailable, and the MentionProvider integration
 * (shell words complete, path positions still reach the fork's provider).
 * @module @xmoon76/dsh-pi-tui/shell-completion.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { MentionProvider } from '../../src/tui/interaction/autocomplete/provider.ts'
import { shellCompletionContext, shellWordSuffix, suggestShellCompletion } from '../../src/tui/interaction/autocomplete/shell.ts'
import type { HostShellCompletionPort, HostShellCompletionRequest } from '../../src/runtime/host-shell-completion-port.ts'
import type { HostFileScope } from '../../src/runtime/host-file-port.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { testLifecycle, type TestLifecycle } from '../support/temp-lifecycle.ts'

const abort = new AbortController().signal
const cwd = tmpdir()
const pathContext = (prefix: string, priorWords: readonly string[]) => ({
  kind: 'paths' as const,
  prefix,
  priorWords,
  word: { valuePrefix: prefix, quote: undefined, closingQuoteAfterCursor: false },
})

// --- shellCompletionContext: cursor parsing ---

test('shellCompletionContext parses command, subcommand, variable and path positions', () => {
  // Command name: first word after `!` (or `!!`).
  assert.deepEqual(shellCompletionContext('!gi', 3), { kind: 'command', prefix: 'gi', priorWords: [] })
  assert.deepEqual(shellCompletionContext('!!gi', 4), { kind: 'command', prefix: 'gi', priorWords: [] })
  assert.deepEqual(shellCompletionContext('!', 1), { kind: 'command', prefix: '', priorWords: [] })
  // A later word of a known listable command: subcommand.
  assert.deepEqual(shellCompletionContext('!git che', 8), { kind: 'subcommand', prefix: 'che', priorWords: ['git'] })
  // A `$VAR` word anywhere after the first word.
  assert.deepEqual(shellCompletionContext('!echo $HO', 10), {
    kind: 'variable', prefix: '$HO', priorWords: ['echo'],
    word: { valuePrefix: '$HO', quote: undefined, closingQuoteAfterCursor: false },
  })
  assert.deepEqual(shellCompletionContext('!ls /u', 6), pathContext('/u', ['ls']))
  assert.deepEqual(shellCompletionContext('!cat src/de', 11), pathContext('src/de', ['cat']))
  assert.deepEqual(shellCompletionContext('!./run.sh', 9), pathContext('./run.sh', []))
  assert.deepEqual(shellCompletionContext('!~/bin', 6), pathContext('~/bin', []))
  assert.deepEqual(shellCompletionContext('!unknowncmd foo', 15), pathContext('foo', ['unknowncmd']))
  // Non-shell lines never produce a context.
  assert.equal(shellCompletionContext('plain text', 10), undefined)
  assert.equal(shellCompletionContext('/cmd', 4), undefined)
})

test('Shell path context preserves quote state and decodes only the Host lookup prefix', () => {
  const doubleLine = '!cat "./my file'
  const double = shellCompletionContext(doubleLine, doubleLine.length)
  assert.deepEqual(double, {
    kind: 'paths', prefix: '"./my file', priorWords: ['cat'],
    word: { valuePrefix: './my file', quote: '"', closingQuoteAfterCursor: false },
  })

  const singleLine = "!cat './my file' tail"
  const closing = singleLine.indexOf("' tail")
  assert.deepEqual(shellCompletionContext(singleLine, closing), {
    kind: 'paths', prefix: "'./my file", priorWords: ['cat'],
    word: { valuePrefix: './my file', quote: "'", closingQuoteAfterCursor: true },
  })

  const escapedLine = '!cat ./my\\ file'
  assert.deepEqual(shellCompletionContext(escapedLine, escapedLine.length), {
    kind: 'paths', prefix: './my\\ file', priorWords: ['cat'],
    word: { valuePrefix: './my file', quote: undefined, closingQuoteAfterCursor: false },
  })
  assert.equal(shellCompletionContext(escapedLine, escapedLine.length)?.word?.valuePrefix, './my file')
})

test('Shell path context keeps a word-leading literal space or quote in the semantic prefix', () => {
  // The decoded Host token STARTS with the literal byte: the user quoted (or
  // escaped) the first character, so the bridge must receive it intact.
  const spaceLine = "!cat ' spacey"
  assert.deepEqual(shellCompletionContext(spaceLine, spaceLine.length), {
    kind: 'paths', prefix: "' spacey", priorWords: ['cat'],
    word: { valuePrefix: ' spacey', quote: "'", closingQuoteAfterCursor: false },
  })
  const quoteLine = '!cat \\"quoted'
  assert.deepEqual(shellCompletionContext(quoteLine, quoteLine.length), {
    kind: 'paths', prefix: '\\"quoted', priorWords: ['cat'],
    word: { valuePrefix: '"quoted', quote: undefined, closingQuoteAfterCursor: false },
  })
})

test('shellWordSuffix replaces exactly the current Shell word tail', () => {
  const tail = (line: string, prefix: string): string => {
    const col = line.indexOf(prefix) + prefix.length
    const context = shellCompletionContext(line, col)
    assert.ok(context?.kind === 'paths' && context.word !== undefined, `${line} is a path position`)
    return shellWordSuffix(line, col, context.word.quote)
  }
  // A following separate word is never part of the replaced range.
  assert.equal(tail('!cat ./f1-mid-suffix tail', './f1-mid-'), 'suffix')
  // A quoted word keeps the closing quote for the accepted literal to use.
  assert.equal(tail('!cat "./f1-mid-suffix" tail', './f1-mid-'), 'suffix')
  // Spaces inside Shell quote-equivalent regions stay inside the word.
  assert.equal(tail('!cat ./f1-mid-$(touch x).txt tail', './f1-mid-'), '$(touch x).txt')
  assert.equal(tail('!cat ./f1-mid-${NAME:-a b}.txt tail', './f1-mid-'), '${NAME:-a b}.txt')
  assert.equal(tail('!cat ./f1-mid-`touch x`.txt tail', './f1-mid-'), '`touch x`.txt')
  // An unquoted operator ends the word.
  assert.equal(tail('!cat ./f1-mid-suffix;echo after', './f1-mid-'), 'suffix')
})

test('a quoted $VAR word is queried and filtered by its semantic name', async () => {
  const line = '!echo "$HO'
  const context = shellCompletionContext(line, line.length)
  assert.deepEqual(context, {
    kind: 'variable', prefix: '$HO', priorWords: ['echo'],
    word: { valuePrefix: '$HO', quote: '"', closingQuoteAfterCursor: false },
  })
  const requests: HostShellCompletionRequest[] = []
  const port: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete({ request }) {
      requests.push(request)
      return request.kind === 'variables'
        ? { kind: 'ok', candidates: ['HOME', 'HOSTNAME'] }
        : { kind: 'ok', candidates: [] }
    },
  }
  assert.ok(context !== undefined)
  const suggestions = await suggestShellCompletion(context, port, 'session-a', { signal: abort, force: true })
  assert.deepEqual(suggestions, {
    items: [{ value: '$HOME', label: '$HOME' }, { value: '$HOSTNAME', label: '$HOSTNAME' }],
    prefix: '$HO',
  }, 'the semantic name queries, filters and prefixes the quoted variable')
  assert.deepEqual(requests, [{ kind: 'variables', prefix: 'HO' }],
    'the Host query receives the decoded variable name, not the raw quoted word')
})

test('the word start scanner and the word tail scanner share one delimiter rule', () => {
  for (const line of [
    '!cat file;./src/de',
    '!cat file&&./src/de',
    '!cat file|./src/de',
    '!cat (./src/de',
    '!cat file>./src/de',
  ]) {
    const context = shellCompletionContext(line, line.length)
    assert.ok(context?.kind === 'paths', `${line} is a path position`)
    assert.equal(context.prefix, './src/de', `${line} completes the word after the operator`)
    assert.equal(context.word?.valuePrefix, './src/de')
  }
  // Quoted/escaped operators are word bytes, never delimiters.
  const quoted = '!cat "a;b'
  assert.equal(shellCompletionContext(quoted, quoted.length)?.word?.valuePrefix, 'a;b')
  const escaped = '!cat a\\;b'
  assert.equal(shellCompletionContext(escaped, escaped.length)?.word?.valuePrefix, 'a;b')
})

test('a control separator starts a new command word; a path there stays a path', async () => {
  for (const line of ['!echo hi;ec', '!echo hi && ec', '!echo hi || ec', '!echo hi|ec', '!echo hi;(ec']) {
    const context = shellCompletionContext(line, line.length)
    assert.equal(context?.kind, 'command', `${line} is a command position`)
    assert.equal(context?.prefix, 'ec', line)
  }
  assert.equal(shellCompletionContext('!echo hi;', 10)?.kind, 'command',
    'a trailing separator leaves the NEXT word at a command position')
  // A redirection target ends the word WITHOUT opening a command position.
  const redirect = '!echo hi>out'
  assert.equal(shellCompletionContext(redirect, redirect.length)?.kind, 'paths')

  const requests: HostShellCompletionRequest[] = []
  const port: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete({ request }) {
      requests.push(request)
      return request.kind === 'commands'
        ? { kind: 'ok', candidates: ['echo'] }
        : { kind: 'ok', candidates: ['./path'] }
    },
  }
  const commandLine = '!echo hi;ec'
  const commandContext = shellCompletionContext(commandLine, commandLine.length)
  assert.ok(commandContext !== undefined)
  await suggestShellCompletion(commandContext, port, 'session-a', { signal: abort, force: true })
  const pathLine = '!cmd && ./path'
  const pathContext = shellCompletionContext(pathLine, pathLine.length)
  assert.ok(pathContext !== undefined)
  await suggestShellCompletion(pathContext, port, 'session-a', { signal: abort, force: true })
  assert.deepEqual(requests, [
    { kind: 'commands', prefix: 'ec' },
    { kind: 'paths', prefix: './path' },
  ], 'the Host port sees a COMMAND after `;` and a PATH after `&&`')
})

test('a cursor before an opening quote completes the empty word and replaces the quoted tail', () => {
  const line = '!cat "'
  assert.deepEqual(shellCompletionContext(line, 5), {
    kind: 'paths', prefix: '', priorWords: ['cat'],
    word: { valuePrefix: '', quote: undefined, closingQuoteAfterCursor: false },
  })
  // The dangling/complete quoted tail after the cursor belongs to the word
  // the acceptance replaces; the opening quote never survives twice.
  assert.equal(shellWordSuffix(line, 5, undefined), '"')
  assert.equal(shellWordSuffix('!cat "my file" tail', 5, undefined), '"my file"')
})

test('Host path candidates are encoded as literal Shell words for each quote mode', async () => {
  const requestPrefixes: string[] = []
  const port: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete({ request }) {
      if (request.kind !== 'paths') return { kind: 'ok', candidates: [] }
      requestPrefixes.push(request.prefix)
      return { kind: 'ok', candidates: ['./file$(touch /tmp/f1-shell-escape).txt'] }
    },
  }
  const cases = [
    { line: '!cat ./file', expected: "'./file$(touch /tmp/f1-shell-escape).txt'" },
    { line: '!cat "./file', expected: '"./file\\$(touch /tmp/f1-shell-escape).txt"' },
    { line: "!cat './file", expected: "'./file$(touch /tmp/f1-shell-escape).txt'" },
  ]
  for (const { line, expected } of cases) {
    const context = shellCompletionContext(line, line.length)
    assert.ok(context?.kind === 'paths' && context.word !== undefined)
    const suggestions = await suggestShellCompletion(context, port, 'session-a', { signal: abort, force: true })
    assert.deepEqual(suggestions?.items.map(item => item.value), [expected])
    assert.deepEqual(suggestions?.items.map(item => item.label), ['./file$(touch /tmp/f1-shell-escape).txt'])
  }
  assert.deepEqual(requestPrefixes, ['./file', './file', './file'], 'Host discovery receives decoded path prefixes')
})

test('Host path candidates preserve quoted and literal tilde semantics', async () => {
  const requests: string[] = []
  const port: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete({ request }) {
      if (request.kind !== 'paths') return { kind: 'ok', candidates: [] }
      requests.push(request.prefix)
      const candidate = request.prefix.startsWith('./~/')
        ? './~/f1-literal-$(touch sentinel).txt'
        : request.prefix.startsWith('~/')
          ? '~/f1-home-$(touch sentinel).txt'
          : '~user-file$(touch sentinel).txt'
      return { kind: 'ok', candidates: [candidate] }
    },
  }
  const cases = [
    { line: '!cat "~/f1-literal-', request: './~/f1-literal-', expected: '"./~/f1-literal-\\$(touch sentinel).txt"' },
    { line: "!cat '~/f1-literal-", request: './~/f1-literal-', expected: "'./~/f1-literal-$(touch sentinel).txt'" },
    { line: '!cat ~/f1-home-', request: '~/f1-home-', expected: "~/'f1-home-$(touch sentinel).txt'" },
    { line: '!cat ~user-file', request: '~user-file', expected: "'~user-file$(touch sentinel).txt'" },
  ]
  for (const item of cases) {
    const context = shellCompletionContext(item.line, item.line.length)
    assert.ok(context?.kind === 'paths' && context.word !== undefined)
    const suggestions = await suggestShellCompletion(context, port, 'session-a', { signal: abort, force: true })
    assert.equal(suggestions?.items[0]?.value, item.expected)
  }
  assert.deepEqual(requests, cases.map(item => item.request))
})

// --- suggestShellCompletion: real bash ---

test('command-name completion returns cached PATH commands matching the prefix', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
  assert.ok(suggestions !== null, 'git must be on PATH in the test environment')
  assert.ok(suggestions.items.some(item => item.value === 'git'), `git missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
  assert.equal(suggestions.prefix, 'gi')
})

test('an empty command prefix stays quiet on natural triggers and lists on Tab', async () => {
  const context = { kind: 'command' as const, prefix: '', priorWords: [] as readonly string[] }
  const natural = await suggestShellCompletion(context, directShellPort(cwd), undefined, { signal: abort, force: false })
  assert.equal(natural, null, 'a natural trigger with an empty prefix must not flash the list')
  const forced = await suggestShellCompletion(context, directShellPort(cwd), undefined, { signal: abort, force: true })
  assert.ok(forced !== null && forced.items.length > 0, 'explicit Tab with an empty prefix lists commands')
})

test('variable completion returns $VAR names for the word after the dollar', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'variable', prefix: '$HO', priorWords: ['echo'] }, directShellPort(cwd), undefined, { signal: abort })
  assert.ok(suggestions !== null, 'HOME must be a variable')
  assert.ok(suggestions.items.some(item => item.value === '$HOME'), `$HOME missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
  assert.equal(suggestions.prefix, '$HO')
})

test('git subcommand completion lists git subcommands', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'subcommand', prefix: 'che', priorWords: ['git'] }, directShellPort(cwd), undefined, { signal: abort })
  assert.ok(suggestions !== null, 'git --list-cmds must produce subcommands')
  assert.ok(suggestions.items.some(item => item.value === 'checkout'), `checkout missing from ${JSON.stringify(suggestions.items.slice(0, 8))}`)
  assert.equal(suggestions.prefix, 'che')
})

test('no matches yield null, never an error', async () => {
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'zzz-no-such-command-xyz', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
  assert.equal(suggestions, null)
})

test('an aborted request never spawns a shell', async () => {
  const controller = new AbortController()
  controller.abort()
  const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: controller.signal })
  assert.equal(suggestions, null)
})

test('a PATH without bash degrades to null (missing shell)', async () => {
  const saved = process.env.PATH
  try {
    process.env.PATH = join(tmpdir(), 'dsh-no-bash')
    const suggestions = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
    assert.equal(suggestions, null, 'a missing bash must yield no suggestions, never a throw')
  } finally {
    if (saved === undefined) delete process.env.PATH
    else process.env.PATH = saved
  }
})

// --- MentionProvider integration ---

function fixtureWorkspace(life: TestLifecycle): string {
  const root = life.tempDir('dsh-shell-completion-')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'deep-nested.ts'), 'deep')
  writeFileSync(join(root, 'top.txt'), 'top')
  return root
}

test('MentionProvider completes shell command words on ! lines', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null), undefined, undefined, undefined, undefined, [], directShellPort(root))
  const suggestions = await provider.getSuggestions(['!gi'], 0, 3, { signal: abort })
  assert.ok(suggestions !== null, 'command-name completion must run through the provider')
  assert.ok(suggestions.items.some(item => item.value === 'git'), 'git must be suggested')
})

test('MentionProvider still completes paths on ! lines (path positions reach the fork)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null), undefined, undefined, undefined, undefined, [], directShellPort(root))
  const suggestions = await provider.getSuggestions(['!cat src/de'], 0, 11, { signal: abort })
  assert.ok(suggestions !== null, 'a path position on a ! line must reach the fork provider')
  assert.ok(suggestions.items.some(item => item.value.includes('deep-nested.ts')), `deep-nested.ts missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
})

test('a backend without Host shell facts (Remote) shows NO shell suggestions at any position — not even the path fallback (shell amendment M3-4 PR3)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // hostShellCompletion=false models the Remote backend: no compgen AND no
  // fd-backed Client-filesystem path completion may answer a shell line.
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null))
  const commandSeat = await provider.getSuggestions(['!gi'], 0, 3, { signal: abort, force: true })
  assert.equal(commandSeat, null, 'command-name completion must stay silent without Host shell facts')
  const pathSeat = await provider.getSuggestions(['!cat src/de'], 0, 11, { signal: abort, force: true })
  assert.equal(pathSeat, null, 'path completion must NOT fall through to the Client filesystem provider')
  const trigger = provider.shouldTriggerFileCompletion(['!cat src/de'], 0, 11)
  assert.equal(trigger, false, 'the Tab trigger must not even open a file-completion request on a shell line')
})

test('MentionProvider applies a shell item as a plain word replacement', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null), undefined, undefined, undefined, undefined, [], directShellPort(root))
  // A Shell item is accepted only when it came from the CURRENT request: the
  // suggestion set for this exact document/cursor supplies it.
  const commandSuggestions = await provider.getSuggestions(['!gi'], 0, 3, { signal: abort, force: true })
  assert.ok(commandSuggestions !== null)
  const gitItem = commandSuggestions.items.find(item => item.label === 'git')
  assert.ok(gitItem !== undefined)
  const applied = provider.applyCompletion(['!gi'], 0, 3, gitItem, commandSuggestions.prefix)
  assert.deepEqual(applied, { lines: ['!git '], cursorLine: 0, cursorCol: 5 })
  // Host variable candidates carry the same currentness fence: each case uses
  // the item the CURRENT request offered for that exact document/cursor.
  const acceptVariable = async (line: string, col: number) => {
    const suggestions = await provider.getSuggestions([line], 0, col, { signal: abort, force: true })
    assert.ok(suggestions !== null, `${line} must produce variable suggestions`)
    const item = suggestions.items.find(candidate => candidate.value === '$HOME')
    assert.ok(item !== undefined, `$HOME missing for ${line}: ${JSON.stringify(suggestions.items)}`)
    return provider.applyCompletion([line], 0, col, item, suggestions.prefix)
  }
  const appliedVar = await acceptVariable('!echo $HO', 9)
  assert.deepEqual(appliedVar, { lines: ['!echo $HOME '], cursorLine: 0, cursorCol: 12 })
  // A quoted variable keeps its quote and NEVER appends the space inside it.
  const quotedVar = await acceptVariable('!echo "$HO', 10)
  assert.deepEqual(quotedVar, { lines: ['!echo "$HOME'], cursorLine: 0, cursorCol: 12 })
  const closedQuotedVar = await acceptVariable('!echo "$HO"', 10)
  assert.deepEqual(closedQuotedVar, { lines: ['!echo "$HOME"'], cursorLine: 0, cursorCol: 12 })
  // A mid-word unquoted variable is one WORD too: the tail is replaced.
  const midVar = await acceptVariable('!echo $HOme', 9)
  assert.deepEqual(midVar, { lines: ['!echo $HOME '], cursorLine: 0, cursorCol: 12 })
})

/** A port whose candidate sets are fixed per request kind (no real shell). */
function fixedShellPort(candidates: {
  readonly commands?: readonly string[]
  readonly subcommands?: readonly string[]
  readonly variables?: readonly string[]
  readonly paths?: readonly string[]
  readonly authority?: 'client' | 'host'
}): HostShellCompletionPort {
  return {
    pathAuthority: candidates.authority ?? 'client',
    async complete({ request }) {
      if (request.kind === 'commands') return { kind: 'ok', candidates: candidates.commands ?? [] }
      if (request.kind === 'subcommands') return { kind: 'ok', candidates: candidates.subcommands ?? [] }
      if (request.kind === 'variables') return { kind: 'ok', candidates: candidates.variables ?? [] }
      if (request.kind === 'paths') return { kind: 'ok', candidates: candidates.paths ?? [] }
      return { kind: 'ok', candidates: [] }
    },
  }
}

test('command and subcommand acceptance replaces the whole RAW word, not the decoded prefix length', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shell-word-range-')
  const port = fixedShellPort({ commands: ['zoom', 'zo space'], subcommands: ['checkout'] })
  const provider = new MentionProvider([], root, null, undefined, undefined, undefined, undefined, [], port)
  // Suggest first, then apply exactly what the dropdown offered: the query
  // prefix for these kinds is the DECODED word, so the applied range must come
  // from the raw line instead.
  const accept = async (line: string, col: number, label: string) => {
    const suggestions = await provider.getSuggestions([line], 0, col, { signal: abort, force: true })
    assert.ok(suggestions !== null, `${JSON.stringify(line)} must produce shell suggestions`)
    const item = suggestions.items.find(candidate => candidate.label === label)
    assert.ok(item !== undefined, `${label} missing for ${JSON.stringify(line)}: ${JSON.stringify(suggestions.items)}`)
    return provider.applyCompletion([line], 0, col, item, suggestions.prefix)
  }
  const cases = [
    { line: '!zo', col: 3, label: 'zoom', lines: ['!zoom '], cursorCol: 6 },
    // The `!!` (shell-local) wire prefix is the scanner boundary too: it is
    // never part of the replaced word.
    { line: '!!zo', col: 4, label: 'zoom', lines: ['!!zoom '], cursorCol: 7 },
    // A backslash-escaped word: the decoded query is `zo s`, while the raw
    // range is `zo\ s` — applying by decoded length would replace the wrong
    // bytes.
    { line: '!zo\\ s', col: 6, label: 'zo space', lines: ['!zo\\ space '], cursorCol: 11 },
    // A cursor MID-WORD: the already-typed raw suffix belongs to the range.
    { line: '!zoombox', col: 4, label: 'zoom', lines: ['!zoom '], cursorCol: 6 },
    { line: '!git check', col: 8, label: 'checkout', lines: ['!git checkout '], cursorCol: 14 },
    { line: '!echo a && zo', col: 14, label: 'zoom', lines: ['!echo a && zoom '], cursorCol: 16 },
    // A half-typed quote is replaced, never left unbalanced; a closing quote
    // after the cursor is part of the replaced range too.
    { line: '!"zo', col: 3, label: 'zoom', lines: ['!zoom '], cursorCol: 6 },
    { line: '!"zo"', col: 3, label: 'zoom', lines: ['!zoom '], cursorCol: 6 },
    // Following text is kept byte-for-byte; the inserted separator space lands
    // before the preserved one, so a single existing space becomes two.
    { line: '!zo arg', col: 3, label: 'zoom', lines: ['!zoom  arg'], cursorCol: 6 },
  ]
  for (const item of cases) {
    await t.test(`${item.line}| @${item.col} -> ${item.lines[0]}`, async () => {
      assert.deepEqual(await accept(item.line, item.col, item.label), {
        lines: item.lines,
        cursorLine: 0,
        cursorCol: item.cursorCol,
      })
    })
  }
})

test('the accepted escaped command word executes as the intended command under real bash', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shell-word-exec-')
  const bin = life.tempDir('dsh-shell-word-bin-')
  const run = life.tempDir('dsh-shell-word-run-')
  const name = 'zo space'
  writeFileSync(join(bin, name), "#!/bin/sh\nprintf '%s' 'f1-word-range-executed'\n")
  chmodSync(join(bin, name), 0o755)
  const provider = new MentionProvider(
    [], root, null, undefined, undefined, undefined, undefined, [], fixedShellPort({ commands: [name] }),
  )
  const line = '!zo\\ s'
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: abort, force: true })
  assert.ok(suggestions !== null)
  const item = suggestions.items.find(candidate => candidate.label === name)
  assert.ok(item !== undefined, `zo space missing from ${JSON.stringify(suggestions.items)}`)
  const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix)
  assert.deepEqual(applied.lines, ['!zo\\ space '],
    'the accepted word is ONE Bash-safe literal, so the half-typed raw word is replaced whole')
  // The edited line, minus the `!` wire prefix, is the exact shell source the
  // acceptance produces: it must run the intended command, nothing else.
  const executed = spawnSync('bash', ['-c', applied.lines[0]!.slice(1)], {
    cwd: run,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  })
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(executed.stdout, 'f1-word-range-executed')
})

// --- shell-editor-mode virtual prefix (the editor buffer no longer holds
// the `!` / `!!` prefix; the provider synthesizes it at the boundary) ---

/** A mutable mode source (the app wires it to the live editor mode). */
function modeSource(initial: 'prompt' | 'shell-context' | 'shell-local'): {
  source: () => 'prompt' | 'shell-context' | 'shell-local'
  set: (mode: 'prompt' | 'shell-context' | 'shell-local') => void
} {
  let mode = initial
  return { source: () => mode, set: (next) => { mode = next } }
}

test('MentionProvider completes shell words on the bare body via the virtual prefix', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
  // The buffer holds `gi` (no `!`); the provider synthesizes `!gi`.
  const suggestions = await provider.getSuggestions(['gi'], 0, 2, { signal: abort })
  assert.ok(suggestions !== null, 'command completion must run through the virtual prefix')
  assert.ok(suggestions.items.some(item => item.value === 'git'), 'git must be suggested')
  assert.equal(suggestions.prefix, 'gi', 'the suggestion prefix must be the REAL word (no synthetic !)')
})

test('MentionProvider applies a shell item without ever writing the synthetic prefix', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { source } = modeSource('shell-local')
  const provider = new MentionProvider([], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
  const suggestions = await provider.getSuggestions(['git che'], 0, 7, { signal: abort, force: true })
  assert.ok(suggestions !== null)
  const checkout = suggestions.items.find(item => item.label === 'checkout')
  assert.ok(checkout !== undefined)
  const applied = provider.applyCompletion(['git che'], 0, 7, checkout, suggestions.prefix)
  assert.deepEqual(applied, { lines: ['git checkout '], cursorLine: 0, cursorCol: 13 },
    'the applied line must be the bare body — the !! prefix never enters the buffer')
})

test('MentionProvider still completes paths on a shell-mode body (path positions reach the fork)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
  const suggestions = await provider.getSuggestions(['cat src/de'], 0, 10, { signal: abort })
  assert.ok(suggestions !== null, 'a path position on a shell-mode body must reach the fork provider')
  assert.ok(suggestions.items.some(item => item.value.includes('deep-nested.ts')), `deep-nested.ts missing from ${JSON.stringify(suggestions.items.slice(0, 5))}`)
})

test('a natural trigger on a leading / in a shell mode stays quiet (never slash commands)', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([{ name: 'image', description: 'Attach an image file' }], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
  // The fork's slash-command branch would list `image` for a natural
  // trigger on `/`; the shell-mode routing must suppress it (a path, not
  // a command). Tab (force) still completes the path.
  const natural = await provider.getSuggestions(['/usr/lo'], 0, 7, { signal: abort, force: false })
  assert.equal(natural, null, 'a natural trigger on a shell-mode path must stay quiet')
  const forced = await provider.getSuggestions(['/usr/lo'], 0, 7, { signal: abort, force: true })
  assert.ok(forced !== null && forced.items.length > 0, 'Tab on a shell-mode path must complete the path')
})

test('shouldTriggerFileCompletion allows Tab on a leading / in a shell mode', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider([], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
  // The fork's bare-slash-command block would return false for `/usr/lo`
  // (no space); the virtual prefix keeps the fork's judgment on the
  // serialized line, where `/usr/lo` is a path.
  assert.equal(provider.shouldTriggerFileCompletion(['/usr/lo'], 0, 7), true)
  // Prompt mode: a leading `/` without a space is a slash-command NAME
  // shape — the gate fast-fails to the fork's judgment (never file
  // completion), and the host's own file branch is closed for the
  // ordinary position in getSuggestions (plan §2.1).
  const { source: promptSource } = modeSource('prompt')
  const promptProvider = new MentionProvider([], root, null, promptSource)
  assert.equal(promptProvider.shouldTriggerFileCompletion(['/usr/lo'], 0, 7), false)
  // The gate's PROOF: the host's own completion stays quiet in prompt mode.
  assert.equal(await promptProvider.getSuggestions(['/usr/lo'], 0, 7, { signal: abort, force: true }), null,
    'an ordinary prompt position must never open the HOST file dropdown')
})

// --- injected-runner determinism (review finding 4/5: failed runs must not
// be cached, and the spawn/cache must be testable without real bash) ---

import { resetCommandCacheForTest, requestShellCandidates, setCompgenRunnerForTest, type CompgenRun } from '../../src/client/shell/compgen.ts'
import { DirectHostFilePort } from '../../src/runtime/direct/host-file-direct.ts'

function directShellPort(root: string): HostShellCompletionPort {
  return {
    pathAuthority: 'client',
    async complete({ request, signal }) {
      if (request.kind === 'paths') return { kind: 'ok', candidates: [] }
      const candidateRequest = request.kind === 'commands'
        ? { kind: 'commands' as const }
        : request.kind === 'variables'
          ? { kind: 'variables' as const, prefix: request.prefix }
          : { kind: 'subcommands' as const, command: request.command }
      return { kind: 'ok', candidates: await requestShellCandidates(candidateRequest, root, signal) }
    },
  }
}

function fakeRunner(script: (expression: string, prefix: string) => CompgenRun): {
  calls: { expression: string; prefix: string }[]
} {
  const calls: { expression: string; prefix: string }[] = []
  setCompgenRunnerForTest((_cwd, expression, prefix) => {
    calls.push({ expression, prefix })
    return Promise.resolve(script(expression, prefix))
  })
  return { calls }
}

test('successful command lists are cached; failed runs are never cached', async () => {
  resetCommandCacheForTest()
  try {
    const runner = fakeRunner(() => ({ ok: true, lines: ['git', 'gist'] }))
    const first = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
    assert.ok(first !== null && first.items.some(item => item.value === 'git'))
    assert.equal(runner.calls.length, 1, 'the first request spawns once')
    // Cache hit: a second request must not spawn again.
    const second = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
    assert.ok(second !== null)
    assert.equal(runner.calls.length, 1, 'a cache hit must not re-run compgen')
    // A FAILED run (timeout/abort/spawn error) must not create a cache
    // entry: the next request retries the spawn instead of seeing an empty
    // command set for the whole TTL.
    resetCommandCacheForTest()
    const failedRunner = fakeRunner(() => ({ ok: false, lines: [] }))
    const failed = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
    assert.equal(failed, null)
    assert.equal(failedRunner.calls.length, 1, 'the failed run happened once')
    const retried = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: abort })
    assert.equal(retried, null)
    assert.equal(failedRunner.calls.length, 2, 'a failed run must NOT be cached — the retry must spawn again')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
})

test('an aborted request never spawns and variable/subcommand failures degrade', async () => {
  resetCommandCacheForTest()
  try {
    const controller = new AbortController()
    const calls: string[] = []
    setCompgenRunnerForTest((_cwd, expression) => {
      calls.push(expression)
      return Promise.resolve({ ok: false, lines: [] })
    })
    controller.abort()
    const aborted = await suggestShellCompletion({ kind: 'command', prefix: 'gi', priorWords: [] }, directShellPort(cwd), undefined, { signal: controller.signal })
    assert.equal(aborted, null)
    assert.equal(calls.length, 0, 'an already-aborted request must not spawn')
    // Variable failure: null, no cache side effects.
    const vars = await suggestShellCompletion({ kind: 'variable', prefix: '$HO', priorWords: ['echo'] }, directShellPort(cwd), undefined, { signal: abort })
    assert.equal(vars, null)
    // Subcommand lister failure: the static fallback wins (never treated as
    // a valid empty list).
    const subs = await suggestShellCompletion({ kind: 'subcommand', prefix: 'che', priorWords: ['git'] }, directShellPort(cwd), undefined, { signal: abort })
    assert.ok(subs !== null && subs.items.some(item => item.value === 'checkout'),
      'a failed lister must fall back to the static subcommand table')
  } finally {
    setCompgenRunnerForTest(undefined)
    resetCommandCacheForTest()
  }
})

test('a shell word that LOOKS like /image <path> is never an attachment seat', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // A declared attachment command must be installed in the catalog, so the
  // ONLY thing that can keep the attachment plane closed is the shell fact.
  const commands = [{ name: 'image', description: 'Attach an image file', getArgumentCompletions: () => [] }]
  const { source } = modeSource('shell-context')
  const provider = new MentionProvider(commands, root, null, source, undefined, undefined, undefined, [], directShellPort(root))

  // `!echo /image sh` — the `/image` here is a shell WORD. It must not be
  // classified as the attachment path argument, and no Client-local
  // attachment candidates may be produced for it.
  // `top` matches the fixture's real file, so the positive control below is a
  // genuine candidate rather than an empty list.
  const line = 'echo /image top'
  const suggestions = await provider.getSuggestions([line], 0, line.length, {
    signal: abort, force: true,
  })
  assert.ok(
    suggestions === null || !suggestions.items.some(item => (item as { inlineAttachment?: string }).inlineAttachment !== undefined),
    `a shell argument must never yield attachment candidates: ${JSON.stringify(suggestions?.items.slice(0, 5))}`,
  )
  // The SAME text in PROMPT mode is the attachment seat (the shell fact is the
  // only difference) — this is the discriminating control.
  const { source: promptSource } = modeSource('prompt')
  const promptProvider = new MentionProvider(commands, root, null, promptSource)
  const promptSuggestions = await promptProvider.getSuggestions([line], 0, line.length, {
    signal: abort, force: true,
  })
  assert.ok(promptSuggestions !== null, 'prompt mode completes the same text as an attachment path')
  assert.ok(
    promptSuggestions.items.every(item => (item as { inlineAttachment?: string }).inlineAttachment === 'path'),
    'every prompt-mode row is an attachment path row',
  )
  assert.ok(promptSuggestions.items.some(item => item.value.includes('top.txt')),
    `the same text must complete in prompt mode: ${JSON.stringify(promptSuggestions.items.slice(0, 5))}`)
  assert.equal(promptSuggestions.prefix, '', 'the inline seat binds no leading-command prefix')
})

test('Remote shell commands and paths use only Host candidates and fail closed on unavailable paths', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const requests: HostShellCompletionRequest[] = []
  const hostPort: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete({ request }) {
      requests.push(request)
      return request.kind === 'paths'
        ? { kind: 'ok', candidates: ['src/de-host-only.ts'] }
        : request.kind === 'commands'
          ? { kind: 'ok', candidates: ['host-only-command'] }
          : { kind: 'ok', candidates: [] }
    },
  }
  const scope = () => ({ kind: 'session' as const, sessionId: 'session-a' })
  const provider = new MentionProvider([], root, new DirectHostFilePort(() => undefined, null), undefined, scope, null, root, [], hostPort)
  const commandLine = '!host'
  const commandSuggestions = await provider.getSuggestions([commandLine], 0, commandLine.length, { signal: abort, force: true })
  assert.ok(commandSuggestions?.items.some(item => item.value === 'host-only-command'))
  const pathLine = '!cat src/de'
  const pathSuggestions = await provider.getSuggestions([pathLine], 0, pathLine.length, { signal: abort, force: true })
  assert.deepEqual(pathSuggestions?.items.map(item => item.value), ["'src/de-host-only.ts'"])
  assert.deepEqual(requests.map(request => request.kind), ['commands', 'paths'])

  const unavailableHost: HostShellCompletionPort = {
    pathAuthority: 'host',
    async complete() { return { kind: 'unavailable', reason: 'Host shell unavailable' } },
  }
  const closed = new MentionProvider([], root, null, undefined, scope, null, root, [], unavailableHost)
  assert.equal(await closed.getSuggestions([pathLine], 0, pathLine.length, { signal: abort, force: true }), null,
    'Remote must not fall back to the Client filesystem when Host paths are unavailable')
})

test('command-name candidates are applied as ONE Bash-safe word, never as shell source', async (t) => {
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shell-command-escape-')
  const bin = life.tempDir('dsh-shell-command-bin-')
  const run = life.tempDir('dsh-shell-command-run-')
  const cases = [
    { raw: 'zo$(touch WITNESS_625)', escaped: 'zo\\$\\(touch\\ WITNESS_625\\)', marker: 'substitution-name' },
    { raw: 'zo space', escaped: 'zo\\ space', marker: 'space-name' },
    { raw: 'zo;semicolon', escaped: 'zo\\;semicolon', marker: 'semicolon-name' },
  ]
  for (const item of cases) {
    const file = join(bin, item.raw)
    writeFileSync(file, `#!/bin/sh\nprintf '%s' '${item.marker}'\n`)
    chmodSync(file, 0o755)
  }
  const savedPath = process.env.PATH
  const savedBashEnv = process.env.BASH_ENV
  try {
    process.env.PATH = `${bin}${delimiter}${savedPath ?? ''}`
    // `bash -lc` re-runs the login profile, which may reset PATH; BASH_ENV
    // re-asserts the fixture directory first for the compgen shell itself.
    const pathScript = join(root, 'path.sh')
    writeFileSync(pathScript, `PATH=${JSON.stringify(bin)}:"$PATH"\nexport PATH\n`)
    process.env.BASH_ENV = pathScript
    const { source } = modeSource('shell-context')
    const provider = new MentionProvider([], root, null, source, undefined, undefined, undefined, [], directShellPort(root))
    // The accepted item must be the one the provider offered for this exact
    // document/cursor, so the suggestion set is taken through the provider.
    const suggestions = await provider.getSuggestions(['zo'], 0, 2, { signal: abort, force: true })
    assert.ok(suggestions !== null, 'the fixture commands must be discovered through PATH')
    const byLabel = new Map(suggestions.items.map(item => [item.label, item]))
    for (const item of cases) {
      const suggestion = byLabel.get(item.raw)
      assert.ok(suggestion !== undefined,
        `${JSON.stringify(item.raw)} missing from ${JSON.stringify([...byLabel.keys()].slice(0, 8))}`)
      assert.equal(suggestion.label, item.raw, 'the label stays the raw displayed name')
      assert.equal(suggestion.value, item.escaped)
      assert.equal(suggestion.value.replace(/\\([\s\S])/gu, '$1'), item.raw,
        'the accepted value differs from the raw name only by escaping')
      assert.notEqual(suggestion.value, item.raw)
      const applied = provider.applyCompletion(['zo'], 0, 2, suggestion, suggestions.prefix)
      assert.deepEqual(applied.lines, [`${item.escaped} `], 'the accepted line is exactly one word plus the separator')
      const executed = spawnSync('bash', ['-c', applied.lines[0]!], { cwd: run, encoding: 'utf8' })
      assert.equal(executed.status, 0, `${item.raw} did not execute: ${executed.stderr}`)
      assert.equal(executed.stdout, item.marker,
        `${item.raw} must resolve to the command itself, not to a command prefix`)
      assert.equal(existsSync(join(run, 'WITNESS_625')), false,
        `${item.raw} must never run its own name as shell source`)
    }
  } finally {
    if (savedPath === undefined) delete process.env.PATH
    else process.env.PATH = savedPath
    if (savedBashEnv === undefined) delete process.env.BASH_ENV
    else process.env.BASH_ENV = savedBashEnv
    resetCommandCacheForTest()
  }
})

test('a subcommand candidate is inserted as ONE Bash-safe word and runs as the intended argument', async (t) => {
  // A git subcommand name is SUBPROCESS-produced text (`git --list-cmds`), so
  // it is as untrusted as a compgen command name: it must be inserted as one
  // literal word, never as shell source.
  const life = testLifecycle(t)
  const root = life.tempDir('dsh-shell-subcommand-')
  const bin = life.tempDir('dsh-shell-subcommand-bin-')
  const run = life.tempDir('dsh-shell-subcommand-run-')
  writeFileSync(join(bin, 'git'), "#!/bin/sh\nprintf '%s' \"git-stub:$1\"\n")
  chmodSync(join(bin, 'git'), 0o755)
  const raw = 'che$(touch WITNESS_SUB)'
  const escaped = 'che\\$\\(touch\\ WITNESS_SUB\\)'
  const provider = new MentionProvider(
    [], root, null, undefined, undefined, undefined, undefined, [], fixedShellPort({ subcommands: [raw] }),
  )
  const line = '!git che'
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal: abort, force: true })
  assert.ok(suggestions !== null, 'the git subcommand position must produce suggestions')
  const item = suggestions.items.find(candidate => candidate.label === raw)
  assert.ok(item !== undefined, `${raw} missing from ${JSON.stringify(suggestions.items)}`)
  assert.equal(item.value, escaped, 'the inserted subcommand is one Bash-safe literal')
  const applied = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix)
  assert.deepEqual(applied.lines, [`!git ${escaped} `])
  const executed = spawnSync('bash', ['-c', applied.lines[0]!.slice(1)], {
    cwd: run,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  })
  assert.equal(executed.status, 0, executed.stderr)
  assert.equal(executed.stdout, `git-stub:${raw}`,
    'the subcommand resolves as ONE argument, not as a command substitution')
  assert.equal(existsSync(join(run, 'WITNESS_SUB')), false,
    'the subcommand name must never be evaluated as shell source')
})

test('every command line of a multiline shell draft completes with Host candidates and a correct raw range', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({
    commands: ['zoom'],
    subcommands: ['checkout'],
    variables: ['F1_HOST_VARIABLE_20261109'],
    paths: ['src/deep-nested.ts'],
    authority: 'host',
  })
  const accept = async (mode: 'shell-context' | 'shell-local', lines: string[], cursorLine: number, cursorCol: number, value: string) => {
    const provider = new MentionProvider([], root, null, modeSource(mode).source, undefined, undefined, undefined, [], port)
    const suggestions = await provider.getSuggestions(lines, cursorLine, cursorCol, { signal: abort, force: true })
    assert.ok(suggestions !== null, `${mode} line ${String(cursorLine)} must produce suggestions: ${JSON.stringify(lines)}`)
    const item = suggestions.items.find(candidate => candidate.label === value)
    assert.ok(item !== undefined, `${value} missing for ${JSON.stringify(lines)}: ${JSON.stringify(suggestions.items)}`)
    return provider.applyCompletion(lines, cursorLine, cursorCol, item, suggestions.prefix)
  }
  // 2nd line command name.
  assert.deepEqual(await accept('shell-context', ['git status', 'zo'], 1, 2, 'zoom'),
    { lines: ['git status', 'zoom '], cursorLine: 1, cursorCol: 5 })
  // 3rd line git subcommand.
  assert.deepEqual(await accept('shell-context', ['a', 'b', 'git che'], 2, 7, 'checkout'),
    { lines: ['a', 'b', 'git checkout '], cursorLine: 2, cursorCol: 13 })
  // 2nd line variable (quote kept, no space inside it).
  assert.deepEqual(await accept('shell-context', ['x', 'echo "$F1_HOST_'], 1, 15, '$F1_HOST_VARIABLE_20261109'),
    { lines: ['x', 'echo "$F1_HOST_VARIABLE_20261109'], cursorLine: 1, cursorCol: 32 })
  // 2nd line HOST path (never a Client candidate).
  const pathApplied = await accept('shell-context', ['x', 'cat src/de'], 1, 10, 'src/deep-nested.ts')
  assert.deepEqual(pathApplied.lines, ['x', "cat 'src/deep-nested.ts'"])
  assert.ok(!pathApplied.lines.join('\n').includes('client'), 'Host path completion never leaks Client candidates')
  // `!!` mode: the second line completes too and the synthetic prefix is absent.
  const localApplied = await accept('shell-local', ['x', 'zo'], 1, 2, 'zoom')
  assert.deepEqual(localApplied, { lines: ['x', 'zoom '], cursorLine: 1, cursorCol: 5 })
  assert.ok(!localApplied.lines.join('\n').includes('!'), 'the synthetic !! prefix never enters the buffer')
})

test('an untrusted cross-line structure never produces or rewrites a shell word', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'], subcommands: ['checkout'], authority: 'host' })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  for (const lines of [['echo "open', 'zo'], ["echo 'open", 'zo'], ['echo a \\', 'zo'], ['echo $(x', 'zo']]) {
    const suggestions = await provider.getSuggestions(lines, 1, 2, { signal: abort, force: true })
    assert.ok(suggestions === null || !suggestions.items.some(item => item.value === 'zoom'),
      `an untrusted continuation must not offer a shell command: ${JSON.stringify(lines)}`)
  }
})

test('a stale multiline shell result is never applied after the edit, scope or request changes', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'] })
  let scope: HostFileScope = { kind: 'workspace', cwd: root }
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, () => scope, undefined, undefined, [], port)
  const lines = ['git status', 'zo']
  const first = await provider.getSuggestions(lines, 1, 2, { signal: abort, force: true })
  assert.ok(first !== null)
  const item = first.items.find(candidate => candidate.value === 'zoom')
  assert.ok(item !== undefined)
  // A newer request replaces the current suggestion identity.
  const newer = await provider.getSuggestions(['git status', 'zoo'], 1, 3, { signal: abort, force: true })
  assert.ok(newer !== null)
  assert.deepEqual(provider.applyCompletion(lines, 1, 2, item, first.prefix),
    { lines, cursorLine: 1, cursorCol: 2 }, 'an older request result must not apply')
  // A Session/scope change invalidates the current identity too.
  const current = await provider.getSuggestions(lines, 1, 2, { signal: abort, force: true })
  assert.ok(current !== null)
  const currentItem = current.items.find(candidate => candidate.value === 'zoom')
  assert.ok(currentItem !== undefined)
  scope = { kind: 'session', sessionId: SessionId('other-session') }
  assert.deepEqual(provider.applyCompletion(lines, 1, 2, currentItem, current.prefix),
    { lines, cursorLine: 1, cursorCol: 2 }, 'a Session change must refuse the stale candidate')
})

test('an open shell continuation offers nothing — not even a Client path — and refuses stale applies', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  // Direct authority: without the open-continuation gate this branch would
  // reach the fork path provider and offer CLIENT filesystem candidates.
  const port = fixedShellPort({ commands: ['zoom'], paths: ['client-only.txt'], authority: 'client' })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  for (const lines of [['echo "open', '/u'], ["echo 'open", '/u'], ['echo a \\', '/u'], ['echo $(x', '/u']]) {
    assert.equal(await provider.getSuggestions(lines, 1, 2, { signal: abort, force: true }), null,
      `an open continuation must offer no suggestion: ${JSON.stringify(lines)}`)
  }
  // A stale command item produced for an earlier, complete line must not
  // rewrite the open continuation.
  const first = await provider.getSuggestions(['zo'], 0, 2, { signal: abort, force: true })
  assert.ok(first !== null)
  const stale = first.items.find(candidate => candidate.value === 'zoom')
  assert.ok(stale !== undefined)
  assert.deepEqual(provider.applyCompletion(['echo "open', 'zo'], 1, 2, stale, first.prefix),
    { lines: ['echo "open', 'zo'], cursorLine: 1, cursorCol: 2 })
})

test('a finished backslash continuation and a comment do not block later command lines', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'], subcommands: ['checkout'] })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  // `printf a \` + `  b` is ONE finished command; the third line is a new one.
  const continued = ['printf %s hello \\', '  world', 'zo']
  const suggestions = await provider.getSuggestions(continued, 2, 2, { signal: abort, force: true })
  assert.ok(suggestions !== null && suggestions.items.some(item => item.value === 'zoom'),
    'the command line AFTER a completed continuation must complete again')
  // A comment's quote is not an unfinished quote.
  const commented = ['# example "unfinished', 'git che']
  const sub = await provider.getSuggestions(commented, 1, 7, { signal: abort, force: true })
  assert.ok(sub !== null && sub.items.some(item => item.value === 'checkout'),
    'a quote inside a comment must not poison the next line')
})

test('a here-document body is text, and the line after its delimiter completes again', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'] })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  const body = ['cat <<EOF', 'zo']
  assert.equal(await provider.getSuggestions(body, 1, 2, { signal: abort, force: true }), null,
    'the here-document body is text, never a command position')
  const after = ['cat <<EOF', 'zo', 'EOF', 'zo']
  const suggestions = await provider.getSuggestions(after, 3, 2, { signal: abort, force: true })
  assert.ok(suggestions !== null && suggestions.items.some(item => item.value === 'zoom'),
    'the line after the here-document delimiter is a fresh command again')
})

test('here-document delimiters match exactly, and multiple bodies are consumed in order', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'] })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  const offers = async (lines: string[], cursorLine: number) => {
    const suggestions = await provider.getSuggestions(lines, cursorLine, lines[cursorLine]!.length, { signal: abort, force: true })
    return suggestions !== null && suggestions.items.some(item => item.value === 'zoom')
  }
  // A near-match line (spaces around the word) is still BODY, not the end.
  assert.equal(await offers(['cat <<EOF', 'zo', ' EOF ', 'zo'], 3), false,
    'a whitespace near-match must not close the here-document')
  assert.equal(await offers(['cat <<EOF', 'zo', 'EOF ', 'zo'], 3), false,
    'a trailing space must not close the here-document')
  // The exact delimiter line closes it; `<<-` accepts leading TABS only.
  assert.equal(await offers(['cat <<EOF', 'zo', 'EOF', 'zo'], 3), true,
    'the exact delimiter line restores the command position')
  assert.equal(await offers(['cat <<-EOF', 'zo', '\tEOF', 'zo'], 3), true,
    '<<- strips leading tabs for the delimiter line')
  assert.equal(await offers(['cat <<-EOF', 'zo', ' EOF', 'zo'], 3), false,
    '<<- never strips spaces')
  // Two here-documents on one command are consumed in declaration order.
  assert.equal(await offers(['cat <<A <<B', 'a', 'A', 'b', 'B', 'zo'], 5), true,
    'the command position returns after the LAST pending body')
  assert.equal(await offers(['cat <<A <<B', 'a', 'A', 'b', 'zz'], 4), false,
    'the second body is still text even after the first delimiter')
})

test('a here-document body begins only after the logical command line ends', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ commands: ['zoom'] })
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, undefined, undefined, undefined, [], port)
  // `cat <<STOP \` + `STOP` is ONE command: the second STOP is the argument
  // that continues it, not the body delimiter. The body therefore starts on
  // the NEXT line and stays text until the real delimiter.
  const inBody = ['cat <<STOP \\', 'STOP', 'not a command', 'zo', 'STOP']
  assert.equal(await provider.getSuggestions(inBody, 3, 2, { signal: abort, force: true }), null,
    'a continued command must not start its here-document body early')
  // The real delimiter ends the body; the line after it completes again.
  const afterBody = ['cat <<STOP \\', 'STOP', 'not a command', 'STOP', 'zo']
  const suggestions = await provider.getSuggestions(afterBody, 4, 2, { signal: abort, force: true })
  assert.ok(suggestions !== null && suggestions.items.some(item => item.value === 'zoom'),
    'the command position returns after the real delimiter')
})

test('Host path and variable candidates obey the same Session currentness fence', async (t) => {
  const life = testLifecycle(t)
  const root = fixtureWorkspace(life)
  const port = fixedShellPort({ variables: ['HOME'], paths: ['src/deep-nested.ts'], authority: 'host' })
  let scope: HostFileScope = { kind: 'workspace', cwd: root }
  const provider = new MentionProvider([], root, null, modeSource('shell-context').source, () => scope, undefined, undefined, [], port)
  const variableLine = ['echo "$HO']
  const pathLine = ['cat src/de']
  const variable = await provider.getSuggestions(variableLine, 0, 10, { signal: abort, force: true })
  assert.ok(variable !== null)
  const variableItem = variable.items.find(candidate => candidate.value === '$HOME')
  assert.ok(variableItem !== undefined)
  const path = await provider.getSuggestions(pathLine, 0, 10, { signal: abort, force: true })
  assert.ok(path !== null)
  const pathItem = path.items[0]
  assert.ok(pathItem !== undefined)
  // Same document, but the Session scope changed: neither Host fact applies.
  scope = { kind: 'session', sessionId: SessionId('other-session') }
  assert.deepEqual(provider.applyCompletion(variableLine, 0, 10, variableItem, variable.prefix),
    { lines: variableLine, cursorLine: 0, cursorCol: 10 })
  assert.deepEqual(provider.applyCompletion(pathLine, 0, 10, pathItem, path.prefix),
    { lines: pathLine, cursorLine: 0, cursorCol: 10 })
})
