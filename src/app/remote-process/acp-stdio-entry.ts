#!/usr/bin/env node
/**
 * Trusted-profile ACP stdio Adapter.
 *
 * This internal process is the ONE byte relay between the public
 * `dsh --profile pi-tui acp stdio` command's inherited stdin/stdout and the
 * already-running Host-owned ACP v1 local endpoint (Unix socket on POSIX,
 * profile-scoped Named Pipe on Windows). It imports only Node core plus the
 * one pure endpoint-shape module: it is not an ACP SDK server, owns no
 * Session/Agent/Writer/Host Context and performs no JSON parsing, method
 * dispatch, retry or second protocol cache.
 *
 * The Parent overwrites `DSH_PI_TUI_ACP_STDIO_SOCKET_V1` with the authenticated
 * public logical endpoint of THIS canonical Profile. A Linux pathname longer
 * than `sockaddr_un.sun_path` is reached through the documented
 * `/proc/self/fd/<scopeDirFd>/acp.sock` short alias; macOS uses the parent's
 * trusted short public path unchanged.
 *
 * @module app/remote-process/acp-stdio-entry
 */

import { closeSync, openSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname } from 'node:path'
import { isSafeLocalAcpEndpoint } from './local-acp-endpoint.ts'

/** The parent-owned target channel. */
const SOCKET_ENV = 'DSH_PI_TUI_ACP_STDIO_SOCKET_V1'

/** Linux `sockaddr_un.sun_path` includes its trailing NUL. */
const SUN_PATH_BYTES = 104

/** One fixed, sanitized diagnostic line; never a path, errno, stack or payload. */
function report(code: string): void {
  try {
    process.stderr.write(`dsh-pi-tui acp stdio: ${code}\n`)
  } catch {
    // A closed stderr cannot change the Adapter's exit classification.
  }
}

/**
 * Connect to the Parent-selected public logical path. On Linux the logical
 * scope path commonly exceeds `sun_path`; hold the scope directory fd only
 * until the kernel connect settles, then close it.
 */
function connectLocalAcpSocket(socketPath: string): { socket: Socket; release(): void } {
  if (process.platform === 'linux' && Buffer.byteLength(socketPath, 'utf8') + 1 > SUN_PATH_BYTES) {
    const dirFd = openSync(dirname(socketPath), 'r')
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      try { closeSync(dirFd) } catch { /* already closed */ }
    }
    const socket = connect(`/proc/self/fd/${String(dirFd)}/acp.sock`)
    socket.once('connect', release)
    socket.once('error', release)
    return { socket, release }
  }
  return { socket: connect(socketPath), release: () => {} }
}

function main(): void {
  const rawSocketPath = process.env[SOCKET_ENV]
  if (rawSocketPath === undefined || rawSocketPath === '' || !isSafeLocalAcpEndpoint(rawSocketPath, process.platform)) {
    report('ACP_STDIO_SOCKET_INVALID')
    process.exitCode = 2
    return
  }

  let socket: Socket | undefined
  let releaseDirFd: () => void = () => {}
  let clientHalfClosed = false
  let settled = false
  let stdoutBroken = false

  /**
   * The ONE settlement path. Close the Adapter's own transport, end stdout
   * after already-written protocol bytes drain, and let Node exit naturally
   * with the fixed code. Idempotent for concurrent error/end/close callbacks.
   */
  const finish = (code: number): void => {
    if (settled) return
    settled = true
    releaseDirFd()
    try { process.stdin.unpipe(socket) } catch { /* no pipe yet */ }
    try { socket?.unpipe(process.stdout) } catch { /* no pipe yet */ }
    try { socket?.destroy() } catch { /* already gone */ }
    process.exitCode = code
    if (!stdoutBroken) {
      try { process.stdout.end() } catch { /* already closed */ }
    }
  }

  try {
    const opened = connectLocalAcpSocket(rawSocketPath)
    socket = opened.socket
    releaseDirFd = opened.release
  } catch {
    report('ACP_STDIO_SOCKET_ERROR')
    finish(4)
    return
  }

  socket.once('connect', () => {
    releaseDirFd()
    if (settled) {
      socket?.destroy()
      return
    }
    // Node's default `pipe` half-close supplies the ONE socket.end on stdin EOF;
    // the read direction stays open so the Host's remaining bytes drain.
    process.stdin.pipe(socket as Socket)
    ;(socket as Socket).pipe(process.stdout, { end: false })
  })
  process.stdin.on('end', () => { clientHalfClosed = true })
  process.stdin.on('error', () => {
    report('ACP_STDIO_STDIN_ERROR')
    finish(4)
  })
  socket.on('error', () => {
    report('ACP_STDIO_SOCKET_ERROR')
    finish(4)
  })
  socket.on('end', () => {
    if (!clientHalfClosed) report('ACP_STDIO_HOST_DISCONNECTED')
    finish(clientHalfClosed ? 0 : 4)
  })
  socket.on('close', () => {
    if (settled) return
    if (!clientHalfClosed) report('ACP_STDIO_HOST_DISCONNECTED')
    finish(clientHalfClosed ? 0 : 4)
  })
  process.stdout.on('error', () => {
    stdoutBroken = true
    report('ACP_STDIO_STDOUT_EPIPE')
    finish(4)
  })
  // A Parent SIGTERM/SIGINT closes only this Adapter's transport. It never
  // touches the Host, an Agent, a Session or a TUI; the real signal status is
  // preserved instead of being reported as a successful ACP turn.
  const onSignal = (signal: NodeJS.Signals): void => {
    finish(signal === 'SIGINT' ? 130 : 143)
  }
  process.once('SIGTERM', () => onSignal('SIGTERM'))
  process.once('SIGINT', () => onSignal('SIGINT'))
}

main()
