#!/usr/bin/env node
/**
 * Bounded subprocess execution for Source Mode commands.
 *
 * Source builds invoke package managers that create their own descendants.
 * Running each command in a detached process group lets timeout and signal
 * cleanup terminate the whole tree instead of orphaning pnpm/node workers.
 *
 * @module process
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

/**
 * Resolve the installed pnpm binary instead of a project self-management shim.
 * A clean temporary workspace has no node_modules state, so pnpm's shim may
 * otherwise select a stale/broken package-manager link before parsing args.
 */
export function pnpmExecutable() {
  const configured = process.env.PNPM_EXECUTABLE
  if (configured !== undefined && configured !== '') return configured
  const lookup = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { encoding: 'utf8' })
  const shim = (lookup.stdout ?? '').split(/\r?\n/u).find(line => line.trim() !== '')?.trim()
  if (shim === undefined || shim === '') return 'pnpm'
  try {
    const source = readFileSync(shim, 'utf8')
    const target = source.match(/exec\s+"([^"]+)"\s+"\$@"/u)?.[1]
    if (target !== undefined) {
      const expanded = target.replace('$basedir', dirname(shim))
      if (existsSync(expanded)) return resolve(expanded)
    }
  } catch {
    // The platform may use a binary/cmd shim; let spawn resolve it normally.
  }
  return shim
}

const active = new Set()
let forwardingSignal = false
let pendingSignal
let signalExitScheduled = false

function signalNumber(signal) {
  return signal === 'SIGINT' ? 130 : 143
}

function scheduleSignalExit() {
  if (pendingSignal === undefined || signalExitScheduled) return
  signalExitScheduled = true
  setImmediate(() => {
    signalExitScheduled = false
    if (active.size === 0) process.exit(signalNumber(pendingSignal))
  })
}

function maybeExitAfterCleanup() {
  if (active.size === 0) scheduleSignalExit()
}

/** Clean descendants left behind by a synchronous spawnSync timeout. */
export function cleanupTimedOutProcessTree(result, options = {}) {
  if (result?.error?.code !== 'ETIMEDOUT' || typeof result.pid !== 'number') return
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    try {
      ;(options.spawnSync ?? spawnSync)('taskkill', ['/pid', String(result.pid), '/t', '/f'], { stdio: 'ignore', timeout: 5_000 })
    } catch {
      // The child may have exited between the timeout and tree cleanup.
    }
    return
  }
  if (options.detached === false) return
  try {
    ;(options.kill ?? process.kill)(-result.pid, 'SIGKILL')
  } catch {
    // The child group may have exited between the timeout and this cleanup.
  }
}

function killProcessGroup(record, signal) {
  if (record.child.pid === undefined) return
  if (process.platform !== 'win32') {
    try {
      process.kill(-record.child.pid, signal)
    } catch {
      // The child may have exited between the group and direct kill.
    }
  } else if (signal === 'SIGKILL') {
    try {
      spawnSync('taskkill', ['/pid', String(record.child.pid), '/t', '/f'], { stdio: 'ignore' })
    } catch {
      // Fall through to the direct child kill below.
    }
  }
  try {
    record.child.kill(signal)
  } catch {
    // The child may have exited between timeout and cleanup.
  }
}

function forwardSignal(signal) {
  if (forwardingSignal) return
  forwardingSignal = true
  pendingSignal = signal
  for (const record of active) {
    killProcessGroup(record, signal)
    killProcessGroup(record, 'SIGKILL')
  }
  scheduleSignalExit()
}

process.once('SIGINT', () => forwardSignal('SIGINT'))
process.once('SIGTERM', () => forwardSignal('SIGTERM'))

/**
 * Run one command with a hard timeout and process-group cleanup.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, label?: string}} options
 * @returns {Promise<{status: number|null, signal: NodeJS.Signals|null, error?: Error, timedOut: boolean}>}
 */
export function runBounded(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 15 * 60 * 1000
  const label = options.label ?? `${command} ${args.join(' ')}`
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`invalid subprocess timeout for ${label}: ${timeoutMs}`)
  }

  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      windowsHide: true,
    })
    const record = { child, timedOut: false }
    active.add(record)
    let timeout
    let killTimeout
    let settled = false

    const finish = (result) => {
      if (settled) return
      // Do not resolve until the hard-kill grace period has run. Otherwise a
      // SIGTERM-compliant parent can exit while an ignoring descendant lives.
      if (record.timedOut && killTimeout !== undefined) {
        record.pendingResult = result
        return
      }
      settled = true
      clearTimeout(timeout)
      if (!record.timedOut) clearTimeout(killTimeout)
      active.delete(record)
      resolve(result)
      maybeExitAfterCleanup()
    }

    timeout = setTimeout(() => {
      record.timedOut = true
      killProcessGroup(record, 'SIGTERM')
      killTimeout = setTimeout(() => {
        killTimeout = undefined
        killProcessGroup(record, 'SIGKILL')
        if (record.pendingResult !== undefined) finish(record.pendingResult)
      }, 1_000)
    }, timeoutMs)

    child.once('error', error => finish({ status: null, signal: null, error, timedOut: record.timedOut }))
    child.once('exit', (status, signal) => {
      if (record.timedOut) {
        const error = new Error(`${label} timed out after ${timeoutMs}ms`)
        error.code = 'ETIMEDOUT'
        finish({ status, signal, error, timedOut: true })
      } else {
        finish({ status, signal, timedOut: false })
      }
    })
  })
}
