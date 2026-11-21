/**
 * The ONE Darwin tmux OS/PTY driver behind the split-smoke `SurfaceEntryProcess`.
 *
 * BSD `script(1)` cannot take a live keystroke stream from a Node pipe parent
 * (`pty-script.mjs` records the measured `tcgetattr` failure), so the Darwin
 * surface driver uses the ALREADY QUALIFIED macOS tmux pattern from
 * `scripts/smoke/macos-split-parity.mjs`: ONE private tmux server per run
 * (`-L <random> -f /dev/null`), one real pane per surface Client, real
 * keystrokes through `send-keys`, and the real painted frame through
 * `capture-pane`. This module owns terminal and process lifecycle ONLY: every
 * business assertion stays in the shared registry cases.
 *
 * The driver never reads `/proc` (absent on Darwin), never pkills, and never
 * signals a process it did not learn from its own pane's JSONL records. An
 * unmapped control byte or escape sequence fails loudly instead of being
 * silently dropped.
 *
 * @module split-smoke-darwin-pty
 */

import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from './split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

/** Read the wrapper-recorded exit status of one pane, when it exists yet. */
function readExitStatus(path) {
  try {
    const text = readFileSync(path, 'utf8').trim()
    return /^\d+$/u.test(text) ? Number(text) : null
  } catch {
    return null
  }
}

/** The named tmux keys for the control bytes the shared cases really send. */
const CONTROL_KEYS = new Map([
  ['\r', 'Enter'],
  ['\n', 'Enter'],
  ['\t', 'Tab'],
  ['\x15', 'C-u'],
  ['\x13', 'C-s'],
  ['\x7f', 'BSpace'],
])

/** The named tmux keys for the CSI arrow/home/end sequences the cases send. */
const CSI_KEYS = new Map([
  ['\x1b[A', 'Up'],
  ['\x1b[B', 'Down'],
  ['\x1b[C', 'Right'],
  ['\x1b[D', 'Left'],
  ['\x1b[H', 'Home'],
  ['\x1b[F', 'End'],
])

/**
 * Tokenize one real editor input payload into tmux key units. A literal run
 * never contains a control character; an UNMAPPED control byte or an unknown
 * escape sequence throws instead of being dropped or re-labelled.
 *
 * Exported for the tooling guard that proves the mapping covers exactly the
 * input classes the shared cases send.
 */
export function darwinKeyTokensOf(data) {
  const text = String(data)
  const tokens = []
  let literal = ''
  const flush = () => {
    if (literal === '') return
    // A literal beginning with `-` would be parsed as a tmux option: hex mode.
    if (literal.startsWith('-')) {
      tokens.push({ kind: 'hex', hex: Buffer.from(literal, 'utf8').toString('hex') })
    } else {
      tokens.push({ kind: 'literal', text: literal })
    }
    literal = ''
  }
  for (let index = 0; index < text.length; index += 1) {
    const rest = text.slice(index)
    if (rest.startsWith('\x1b[')) {
      const named = CSI_KEYS.get(rest.slice(0, 3))
      flush()
      assert(named !== undefined,
        `unsupported surface input escape ${JSON.stringify(rest.slice(0, 3))} for the Darwin tmux driver`)
      tokens.push({ kind: 'key', name: named })
      index += 2
      continue
    }
    if (rest.startsWith('\x1b')) {
      // A bare ESC is the Escape key; any other introducer (ESC O …) is not
      // an input class the shared cases send and must fail loudly.
      flush()
      assert(rest.length === 1 || (rest[1] !== 'O' && rest[1] !== '['),
        `unsupported surface input escape ${JSON.stringify(rest.slice(0, 3))} for the Darwin tmux driver`)
      tokens.push({ kind: 'key', name: 'Escape' })
      continue
    }
    const character = text[index]
    const named = CONTROL_KEYS.get(character)
    if (named !== undefined) {
      flush()
      tokens.push({ kind: 'key', name: named })
      continue
    }
    const code = character.charCodeAt(0)
    assert(code >= 0x20,
      `unsupported surface input byte 0x${code.toString(16).padStart(2, '0')} for the Darwin tmux driver`)
    literal += character
  }
  flush()
  return tokens
}

/**
 * The per-run Darwin surface scope: the ONE private tmux server name, the
 * panes it created and the bounded server teardown. Importing this module
 * performs no I/O; the tmux server starts with the first real pane.
 */
export function createDarwinSurfacePtyScope() {
  const server = `dsh-split-darwin-${randomUUID().slice(0, 8)}`
  const panes = new Set()

  function tmux(args, label, options = {}) {
    const result = spawnSync('tmux', ['-L', server, '-f', '/dev/null', ...args], {
      encoding: 'utf8',
      timeout: options.timeoutMs ?? 20_000,
    })
    if (result.error !== undefined) {
      throw new SplitSmokeAssertionError(`${label}: tmux could not run: ${result.error.message}`)
    }
    if (result.status !== 0 && options.allowMissing !== true) {
      throw new SplitSmokeAssertionError(
        `${label}: tmux ${args[0]} exited ${String(result.status)}: ${(result.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-700)}`,
      )
    }
    return result
  }

  /**
   * One real tmux pane running one surface Client entry through the same
   * installed profile facts the Linux `script(1)` path receives.
   *
   * The pane runs a tiny shell wrapper: the Client entry is its CHILD and the
   * wrapper records the shell-reported exit status to a private file. That
   * gives the two facts the shared cases read: a REAL wrapper pid distinct
   * from the business pid (`client.child.pid`), and the 128+signal status of
   * a SIGKILLed Client (tmux's own `pane_dead_status` is EMPTY for a signaled
   * death, so it cannot carry this fact). The pane's pty IS the Client's
   * terminal; the JSONL record file stays the record authority as on Linux.
   */
  function createPane({ entry, cwd, env, columns, rows, recordPath, exitPath, role }) {
    assert(cwd !== undefined && env !== undefined, `${role}: the Darwin pane needs a cwd and an environment`)
    assert(exitPath !== undefined, `${role}: the Darwin pane needs its private exit-status path`)
    const session = `surface-${randomUUID().slice(0, 8)}`
    const pairs = Object.entries(env).map(([key, value]) => `${key}=${String(value)}`)
    const command = [
      ['env', '-u', 'NO_COLOR', ...pairs, process.execPath, entry].map(shellQuote).join(' '),
      // The Linux path reads the Client's stderr from its own pipe; a pane's
      // stderr never crosses the tmux boundary, so keep it next to the record
      // file instead. Nothing asserts on it: it is diagnosis material for a
      // kept (SPLIT_PROCESS_SMOKE_KEEP=1) scene.
      ` 2>>${shellQuote(`${recordPath}.stderr`)}`,
      `; __dsh_surface_status=$?; printf '%s' "$__dsh_surface_status" > ${shellQuote(exitPath)}`,
    ].join('')
    tmux(
      [
        'new-session', '-d', '-s', session, '-x', String(columns), '-y', String(rows), '-c', cwd, command,
        // Keep the dead pane INSIDE the session so the wrapper pid and the
        // recorded exit status stay readable after the business Client exits:
        // without `remain-on-exit` tmux destroys the session and both are lost.
        // The option is set on the session the new-session call just created
        // (the `;` separator chains it onto the same server round trip).
        ';', 'set-option', 'remain-on-exit', 'on',
      ],
      `new-session ${role}`,
    )
    const listed = tmux(['list-panes', '-t', session, '-F', '#{pane_pid}'], `pane pid ${role}`)
    const panePid = Number(listed.stdout.trim())
    assert(Number.isInteger(panePid) && panePid > 0, `${role}: the tmux pane published no pid`)
    const pane = {
      session,
      recordPath,
      exitPath,
      role,
      /** The REAL shell wrapper pid of this pane (never the business pid). */
      panePid,
      /** The REAL painted pane rows, padded to the configured viewport height. */
      captureLines() {
        const captured = tmux(['capture-pane', '-p', '-t', session], `capture ${role}`, { allowMissing: true })
        const lines = (captured.status === 0 ? captured.stdout : '').split('\n')
        while (lines.length < rows) lines.push('')
        return lines.slice(0, rows)
      },
      /**
       * The pane's tmux buffer, when something copied into it.
       *
       * The product's Client-local copy policy tries the tmux leg first when
       * `TMUX` is set (a real pane always sets it) and `tmux load-buffer -w -`
       * resolves the socket from `$TMUX`, so the text lands in THIS private
       * server's buffer. That is the Darwin-observable fact for a copy: the
       * pane consumes the OSC 52 bytes, so the client's byte stream cannot
       * carry them here.
       */
      bufferText() {
        const shown = tmux(['show-buffer'], `show-buffer ${role}`, { allowMissing: true })
        return shown.status === 0 ? shown.stdout : undefined
      },
      /** The pane's death fact: `dead` plus the wrapper-recorded exit status. */
      deadFacts() {
        const exists = tmux(['has-session', '-t', session], `has-session ${role}`, { allowMissing: true })
        if (exists.status !== 0) return { dead: true, status: readExitStatus(exitPath) }
        const shown = tmux(
          ['display-message', '-p', '-t', session, '#{pane_dead}'],
          `dead ${role}`,
          { allowMissing: true },
        )
        if (shown.status !== 0 || shown.stdout.trim() !== '1') return { dead: false, status: null }
        return { dead: true, status: readExitStatus(exitPath) }
      },
      /** Real keystrokes: named tmux keys for controls, `-l`/`-H` for text. */
      sendTokens(tokens) {
        let keyName = null
        let keyCount = 0
        const flushKeys = () => {
          if (keyName === null) return
          tmux(
            ['send-keys', '-t', session, ...Array.from({ length: keyCount }, () => keyName)],
            `send ${keyName}×${String(keyCount)} ${role}`,
          )
          keyName = null
          keyCount = 0
        }
        for (const token of tokens) {
          if (token.kind === 'key') {
            if (keyName === token.name) keyCount += 1
            else {
              flushKeys()
              keyName = token.name
              keyCount = 1
            }
            continue
          }
          flushKeys()
          if (token.kind === 'literal') {
            tmux(['send-keys', '-t', session, '-l', token.text], `send literal ${role}`)
          } else {
            tmux(['send-keys', '-t', session, '-H', token.hex], `send hex literal ${role}`)
          }
        }
        flushKeys()
      },
      /** Teardown: kill the pane, wait for its death; never guess a pid. */
      async dispose() {
        tmux(['kill-session', '-t', session], `kill-session ${role}`, { allowMissing: true })
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          if (this.deadFacts().dead) return
          await sleep(100)
        }
      },
    }
    panes.add(pane)
    return pane
  }

  /**
   * The scoped teardown: every registered pane must already be dead (each
   * surface disposed its own pane), then the private server is killed. A
   * still-alive pane is a real leftover and fails the lane instead of being
   * silently discarded.
   */
  async function stopServer() {
    for (const pane of panes) {
      const facts = pane.deadFacts()
      assert(facts.dead, `NOT_QUIESCED: the Darwin surface pane ${pane.session} (${pane.role}) is still alive`)
    }
    tmux(['kill-server'], 'stop the private Darwin tmux server', { allowMissing: true })
    panes.clear()
  }

  return { server, createPane, stopServer }
}

/**
 * The Darwin Host seat file path, resolved exactly like the production seat
 * (`src/app/remote-process/local-scope.ts` `darwinHostProfileSeatDir`): the OS
 * ACCOUNT home from `os.userInfo()`, never `$HOME`/`DSH_HOME`/`$TMPDIR`. The
 * lane runs the Client with an ISOLATED `$HOME`, so a probe based on
 * `os.homedir()` would look at a directory the seat never lives in and report
 * "free" for the wrong reason. The optional `accountHome` exists ONLY so the
 * tooling guard can exercise the lock against a private directory.
 */
export function darwinHostSeatFilePath(scopeId, accountHome = userInfo().homedir) {
  assert(typeof scopeId === 'string' && scopeId !== '', 'the Darwin seat probe needs a scope id')
  return join(accountHome, '.dsh-pi-tui', 'run', scopeId, `seat-host-${scopeId}.lock`)
}

/**
 * Probe the Darwin Host seat file the same kernel claim the Host holds: the
 * seat is free exactly when the `O_EXLOCK` file lock can be taken again. The
 * probe never creates a missing file (ENOENT is already free) and never
 * removes or chmods anything.
 */
export async function darwinHostSeatFileFree(
  scopeId,
  { timeoutMs = 15_000, accountHome } = {},
) {
  // O_RDWR|O_EXLOCK|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC — deliberately NO O_CREAT.
  const flags = 2 | 32 | 4 | 256 | 16777216
  const path = darwinHostSeatFilePath(scopeId, accountHome)
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    let fd
    try {
      fd = openSync(path, flags, 0o600)
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      if (error?.code === 'EAGAIN' || error?.code === 'EWOULDBLOCK') {
        await sleep(100)
        continue
      }
      throw error
    }
    closeSync(fd)
    return true
  }
  return false
}
