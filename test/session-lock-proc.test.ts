/**
 * Headless tests for the real /proc owner probe: stat parsing, the Linux
 * verdict matrix (alive / zombie / reused-pid / vanished / non-dsh / unknown),
 * and the non-Linux degradation path.
 * @module @xmoon76/dsh-pi-tui/session-lock-proc.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import {
  createProcProbe,
  parseProcStat,
  readProcCmdline,
  readProcExe,
} from '../src/session-lock-proc.ts'
import type { SessionLockInfo } from '../src/session-lock.ts'

/** A real /proc sample for a live non-zombie process (this test process). */
function selfProcStat(): string {
  return readFileSync(`/proc/${process.pid}/stat`, 'utf8')
}

/** Parse the REAL current process's starttime from /proc, for a real-owner test. */
function selfStarttime(): number {
  const parsed = parseProcStat(selfProcStat())
  assert.ok(parsed !== undefined)
  return parsed.starttime
}

/** The real current process, as a lock owner record. */
function selfOwner(): SessionLockInfo {
  return { pid: process.pid, starttime: selfStarttime(), startedAt: Date.now(), profile: 'pi-tui-dev' }
}

test('parseProcStat extracts state and starttime from a real stat', () => {
  const parsed = parseProcStat(selfProcStat())
  assert.ok(parsed !== undefined)
  assert.ok(['R', 'S'].includes(parsed.state))
  assert.ok(parsed.starttime > 0)
})

test('parseProcStat handles a comm containing spaces and parentheses', () => {
  // Field 2 (comm) may be "(node (worker) )"; the parser indexes from the
  // last ')' so state and starttime stay correct. The stat fields after
  // comm: index 0 = state (field 3), index 19 = field 22 (starttime).
  const parsed = parseProcStat('1 (node (worker) ) S 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 99 21 22')
  assert.deepEqual(parsed, { state: 'S', starttime: 99 })
})

test('parseProcStat rejects malformed stat content', () => {
  assert.equal(parseProcStat(''), undefined)
  assert.equal(parseProcStat('1 (no close'), undefined)
  assert.equal(parseProcStat('1 (x) S 2 3'), undefined) // too few fields
})

test('probe: this very process is alive (real /proc, matching starttime)', () => {
  const probe = createProcProbe()
  const outcome = probe.probe(selfOwner(), selfOwner())
  assert.equal(outcome.kind, 'alive')
})

test('probe: a reused pid (same pid, different starttime) is stale', () => {
  // Same pid as the real process but a starttime that cannot match.
  const probe = createProcProbe()
  const outcome = probe.probe({ pid: process.pid, starttime: 1, startedAt: 0 }, selfOwner())
  assert.equal(outcome.kind, 'stale')
})

test('probe: a nonexistent pid is stale', () => {
  const probe = createProcProbe()
  // pid 1 exists on Linux; use an impossible starttime to force mismatch OR a
  // pid that cannot exist. 2**30 is beyond the pid_max default of 4194304.
  const outcome = probe.probe({ pid: 1 << 30, starttime: 1, startedAt: 0 }, selfOwner())
  assert.equal(outcome.kind, 'stale')
})

test('probe: a zombie state is stale (injected stat read)', () => {
  const probe = createProcProbe({
    readFile: (path) => {
      if (path.endsWith('/stat')) return '1 (defunct) Z 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 5'
      return '/usr/bin/dsh'
    },
  })
  const outcome = probe.probe({ pid: 9999, starttime: 5, startedAt: 0 }, selfOwner())
  assert.equal(outcome.kind, 'stale')
})

test('probe: a SIGSTOP-paused owner is still alive (no heartbeat, never takeover)', () => {
  // A STOPPED ('T' state) process is alive — a TUI suspended with SIGSTOP
  // keeps its session lock: inactivity is never a staleness signal (the
  // takeover criteria are liveness + starttime + dsh identity ONLY).
  const probe = createProcProbe({
    readFile: (path) => {
      // Field layout after comm: index 0 = state (field 3), index 19 =
      // starttime (field 22) — SIGSTOP's 'T' must NOT read as dead.
      if (path.endsWith('/stat')) return '1 (dsh) T 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 5 21 22'
      return '/usr/bin/node /home/x/.local/bin/dsh --profile pi-tui'
    },
  })
  const outcome = probe.probe({ pid: 9999, starttime: 5, startedAt: 0 }, selfOwner())
  assert.equal(outcome.kind, 'alive', 'a SIGSTOP-paused dsh owner must stay alive')
})

test('probe: a cmdline read failure is unknown, never a stale takeover', () => {
  // The stat proves the process is alive and is the same one; an unreadable
  // cmdline (hidepid, transient race) must not classify the owner as stale —
  // that would take a possibly-live owner's lock over.
  const probe = createProcProbe({
    readFile: (path) => {
      if (path.endsWith('/stat')) {
        return '1 (MainThread) S 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 123 21 22'
      }
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    },
  })
  const outcome = probe.probe(
    { pid: 9999, starttime: 123, startedAt: 0, profile: 'pi-tui-dev' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'unknown')
})

test('probe: a matching stat with a non-dsh cmdline is stale (pid reuse)', () => {
  const probe = createProcProbe({
    readFile: (path) => {
      if (path.endsWith('/stat')) {
        return '1 (MainThread) S 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 123 21 22'
      }
      return '/usr/bin/sshd' // same pid/starttime, but not a dsh invocation
    },
  })
  const outcome = probe.probe(
    { pid: 9999, starttime: 123, startedAt: 0, profile: 'pi-tui-dev' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'stale')
})

test('probe: a matching stat with a dsh cmdline is alive', () => {
  const probe = createProcProbe({
    readFile: (path) => {
      if (path.endsWith('/stat')) {
        // A live process whose starttime matches the owner record.
        return '1 (MainThread) S 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 123 21 22'
      }
      return '/usr/bin/node /home/user/.nvm/versions/node/v24/bin/dsh --profile pi-tui'
    },
  })
  const outcome = probe.probe(
    { pid: 9999, starttime: 123, startedAt: 0, profile: 'pi-tui-dev' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'alive')
})

test('probe: non-Linux degradation with a matching command is alive', () => {
  const probe = createProcProbe({
    platform: 'darwin',
    execFile: ((_bin: string, _args: string[], _opts: unknown) => '/usr/local/bin/dsh --profile pi-tui') as never,
  })
  const outcome = probe.probe(
    { pid: process.pid, starttime: 1, startedAt: 0, profile: 'pi-tui' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'alive')
})

test('probe: non-Linux degradation with a non-dsh command is stale', () => {
  const probe = createProcProbe({
    platform: 'darwin',
    execFile: ((_bin: string, _args: string[], _opts: unknown) => '/usr/bin/vim foo.ts') as never,
  })
  const outcome = probe.probe(
    { pid: process.pid, starttime: 1, startedAt: 0, profile: 'pi-tui' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'stale')
})

test('probe: non-Linux degradation with a failed ps is unknown', () => {
  const probe = createProcProbe({
    platform: 'darwin',
    execFile: (() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }) as never,
  })
  const outcome = probe.probe(
    { pid: process.pid, starttime: 1, startedAt: 0, profile: 'pi-tui' },
    selfOwner(),
  )
  assert.equal(outcome.kind, 'unknown')
})

test('readProcCmdline reads the real command line', () => {
  const cmdline = readProcCmdline(process.pid)
  assert.ok(cmdline !== undefined)
  assert.ok(cmdline.length > 0)
})

test('readProcExe resolves the real executable', () => {
  const exe = readProcExe(process.pid)
  assert.ok(exe !== undefined)
  assert.ok(exe.length > 0)
})
