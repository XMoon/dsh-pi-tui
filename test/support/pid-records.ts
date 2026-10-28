/**
 * Records and observations of the OS processes a tooling test spawned.
 *
 * A bare `process.kill(pid, 0)` answers "SOME process has this PID", which is
 * NOT the same fact as "the helper we started is still executing": a killed
 * child keeps its PID as a ZOMBIE until its parent reaps it, and a long-lived
 * runner can eventually REUSE the PID. A fixture therefore records its own
 * identity — PID plus the Linux start time — and the observation compares that
 * identity instead of a bare PID.
 *
 * Linux exposes `/proc/<pid>/stat`; elsewhere the record has no start time and
 * the liveness probe is the whole evidence, which a caller must not describe
 * as more.
 *
 * @module @xmoon76/dsh-pi-tui/test/support/pid-records
 */

import { existsSync, readFileSync, watch } from 'node:fs'
import { basename, dirname } from 'node:path'
import type { FSWatcher } from 'node:fs'

/** One process a test fixture recorded at startup. */
export interface PidRecord {
  /** The fixture's role: `daemon`, `window`, `serve`, ... */
  kind: string
  pid: number
  /** The Linux start time from `/proc/<pid>/stat`, when one was recorded. */
  startTime?: string
}

interface ProcStat {
  /** The process state letter: `R`, `S`, `D`, `Z`, ... */
  state: string
  /** Field 22 of `/proc/<pid>/stat`. */
  startTime: string
}

/**
 * The Linux state and start time of a live PID.
 *
 * The command name between `(` and the LAST `)` may itself contain spaces and
 * parentheses, so the remaining fields are counted from that closing paren:
 * the first one is the state (field 3), and start time is field 22.
 */
function procStat(pid: number): ProcStat | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return { state: fields[0], startTime: fields[19] }
  } catch {
    return undefined
  }
}

/** The Linux start time of a PID, undefined where `/proc` does not exist. */
export function startTimeOf(pid: number): string | undefined {
  return procStat(pid)?.startTime
}

/**
 * Read the records a fixture wrote, one `<kind> <pid> [<startTime>|-]` per line.
 */
export function readPidRecords(file: string): PidRecord[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
    const [kind, rawPid, rawStart] = line.trim().split(' ')
    return {
      kind,
      pid: Number(rawPid),
      // The fixture records its own start time, because it is the only process
      // that can read that field while it is certainly THIS process.
      startTime: rawStart === undefined || rawStart === '-' ? undefined : rawStart,
    }
  }).filter((record) => Number.isInteger(record.pid) && record.pid > 0)
}

/**
 * Wait until the fixture has recorded `count` processes.
 *
 * The FILE CONTENT is the authority; a file event only notifies a re-read.
 * `deadlineMs` bounds a fixture that never writes, so a broken fixture fails
 * with a real message instead of hanging.
 *
 * The first read and the watcher registration are two separate steps, so a
 * record written between them emits an event nobody was listening for. The
 * check therefore runs ONCE AFTER `watch()` is armed as well: the registration
 * window cannot lose a wakeup, while every later notification is still a real
 * event. The same `settled` guard makes the timer, an event and the
 * post-registration read settle at MOST once.
 */
export function waitForPidRecords(file: string, count: number, deadlineMs: number): Promise<PidRecord[]> {
  return new Promise((resolve, reject) => {
    let watcher: FSWatcher | undefined
    let settled = false
    /** Read the CURRENT file content; settle only when it satisfies `count`. */
    const checkRecords = (): void => {
      if (settled) return
      const records = readPidRecords(file)
      if (records.length < count) return
      settled = true
      clearTimeout(timer)
      watcher?.close()
      resolve(records)
    }
    // reason: a bounded deadline around a file event, not a settle window — the
    // fixture writes its record synchronously at startup.
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      watcher?.close()
      reject(new Error(`the fixture wrote ${readPidRecords(file).length} PID record(s) within ${deadlineMs}ms`))
    }, deadlineMs)
    checkRecords()
    if (settled) return
    // Watch the DIRECTORY: watching the log path before it exists throws ENOENT.
    watcher = watch(dirname(file), { persistent: false }, (_event, name) => {
      if (name !== undefined && String(name) !== basename(file)) return
      checkRecords()
    })
    // Close the registration window: a record written after the first read but
    // before the watcher was armed produced no event this wait can see.
    checkRecords()
  })
}

/**
 * Whether the RECORDED process — not merely some process with its PID — still
 * executes.
 *
 * A zombie cannot execute; a different start time is a REUSED PID, not the
 * helper whose record we hold. Without `/proc`, liveness is the only evidence
 * there is.
 */
export function isExecuting(record: PidRecord): boolean {
  try {
    process.kill(record.pid, 0)
  } catch {
    return false
  }
  const stat = procStat(record.pid)
  if (stat === undefined) return true
  if (stat.state === 'Z') return false
  return record.startTime === undefined || stat.startTime === record.startTime
}

/**
 * Observe — in a bounded window — that none of the recorded processes execute.
 *
 * Returns the survivors (empty means the teardown was observed). The window is
 * the observation itself: "a helper no longer runs" has no event to wait for.
 */
export async function waitForNoExecuting(records: PidRecord[], deadlineMs: number): Promise<PidRecord[]> {
  const deadline = Date.now() + deadlineMs
  let survivors = records.filter(isExecuting)
  while (survivors.length > 0 && Date.now() < deadline) {
    // reason: a NEGATIVE fact — this helper must no longer execute — has no
    // event to wait for, so a bounded observation window is the evidence. The
    // bound exists so a genuinely surviving helper is reported instead of
    // hanging the test.
    await new Promise((resolve) => setTimeout(resolve, 25))
    survivors = records.filter(isExecuting)
  }
  return survivors
}

/**
 * Kill whatever is still executing, for a test's OWN cleanup.
 *
 * Only the PIDs this test recorded are signalled, and only after the assertions
 * have run: the cleanup must never stand in for the teardown under test.
 */
export function killStillExecuting(records: PidRecord[]): void {
  for (const record of records) {
    if (!isExecuting(record)) continue
    try {
      process.kill(record.pid, 'SIGKILL')
    } catch {
      // It exited between the check and the signal; nothing is left to clean.
    }
  }
}
