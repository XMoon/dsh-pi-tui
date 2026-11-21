#!/usr/bin/env node
/**
 * Real independent-process seat worker for `test/integration/darwin-kernel-seat.test.ts`.
 *
 * It claims ONE production Darwin kernel seat, reports the claimed FD (the
 * test needs the number to prove the close-on-exec behavior), and then serves
 * newline-delimited commands from stdin:
 *
 *   assert              -> {event:"current"} | {event:"assert-error",code}
 *   spawn default|inherit -> spawns the FD probe (`/dev/fd/3`) and relays
 *                            {event:"probe",value}
 *   close               -> closes the seat, reports it, exits 0
 *
 * The FD is observed by patching `fs.openSync` (synced to the ESM named
 * exports) BEFORE the production module is imported; the test must never guess
 * a descriptor number.
 *
 * @module @xmoon76/dsh-pi-tui/fixtures/darwin-seat/seat-worker
 */

import fs from 'node:fs'
import { spawn } from 'node:child_process'
import readline from 'node:readline'
import { syncBuiltinESMExports } from 'node:module'

const [modulePath, directory, scopeId, kind] = process.argv.slice(2)
if (modulePath === undefined || directory === undefined || scopeId === undefined || kind === undefined) {
  process.stderr.write('usage: seat-worker.mjs <module-url> <dir> <scopeId> <kind>\n')
  process.exit(2)
}

const seatSuffix = `seat-${kind}-${scopeId}.lock`
let seatFd = null
const realOpenSync = fs.openSync
fs.openSync = (path, flags, mode) => {
  const fd = realOpenSync(path, flags, mode)
  if (String(path).endsWith(seatSuffix)) seatFd = fd
  return fd
}
syncBuiltinESMExports()

const send = value => { process.stdout.write(`${JSON.stringify(value)}\n`) }

let seat
try {
  const { bindDarwinKernelSeat } = await import(modulePath)
  seat = await bindDarwinKernelSeat(directory, scopeId, kind, 'HOST_ALREADY_OWNED')
} catch (error) {
  send({ event: 'error', code: error?.code ?? null, message: String(error?.message ?? error) })
  process.exit(3)
}
send({ event: 'held', pid: process.pid, fd: seatFd })

// fd 3 may exist for unrelated reasons; the probe proves it is the SEAT by
// comparing the open descriptor's inode with the seat path's inode.
const FD_PROBE = `const fs = require('node:fs')
const path = process.argv[1]
let same = false
try {
  const fdInfo = fs.fstatSync(3)
  const pathInfo = fs.statSync(path)
  same = fdInfo.dev === pathInfo.dev && fdInfo.ino === pathInfo.ino
} catch {}
process.stdout.write(same ? 'present' : 'absent')`

readline.createInterface({ input: process.stdin }).on('line', line => {
  const [command, argument] = line.trim().split(/\s+/u)
  if (command === 'assert') {
    try {
      seat.assertCurrent()
      send({ event: 'current' })
    } catch (error) {
      send({ event: 'assert-error', code: error?.code ?? null })
    }
    return
  }
  if (command === 'spawn') {
    const stdio = argument === 'inherit'
      ? ['ignore', 'pipe', 'ignore', seatFd]
      : ['ignore', 'pipe', 'ignore']
    if (argument === 'inherit' && typeof seatFd !== 'number') {
      send({ event: 'probe-error', message: 'the seat fd was not observed' })
      return
    }
    const child = spawn(process.execPath, ['-e', FD_PROBE, `${directory}/seat-${kind}-${scopeId}.lock`], { stdio })
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', chunk => { output += chunk })
    child.once('close', () => { send({ event: 'probe', value: output.trim() }) })
    return
  }
  if (command === 'close') {
    void seat.close().then(() => {
      send({ event: 'closed' })
      process.exit(0)
    })
  }
})
