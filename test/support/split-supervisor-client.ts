/**
 * The ONE Worker-side IPC client for the detached Split Supervisor.
 *
 * Both the Pilot fixture and the upgrade fixture speak this protocol; there is
 * deliberately no second fork/request/close implementation. The Supervisor owns
 * the scene root, profile installs and every real Host process; a Worker only
 * receives opaque host identities and can request bounded operations.
 *
 * A caller may pass its own run id (the upgrade Scene does), so two Vitest
 * workers that inherit the same environment still get distinct receipts. When
 * no run id is passed, the Supervisor keeps its historical
 * `SPLIT_VITEST_RUN_ID` behaviour unchanged.
 */

import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const SUPPORT_DIR = fileURLToPath(new URL('.', import.meta.url))
export const SPLIT_HOST_SUPERVISOR_PATH = join(SUPPORT_DIR, 'split-host-supervisor.mjs')

export interface SupervisorExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: NodeJS.Timeout
  onProgress?: (message: Record<string, any>) => void
}

export interface SupervisorClientOptions {
  /** Unique receipt/run identity for this Scene; omit for the Pilot default. */
  runId?: string
  /** Test/probe override for the Supervisor entry; production callers omit it. */
  supervisorPath?: string
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export class SupervisorClient {
  readonly #child: ChildProcess
  readonly #pending = new Map<string, PendingRequest>()
  readonly #exitPromise: Promise<SupervisorExitResult>
  #exitResult: SupervisorExitResult | undefined
  #sequence = 0

  constructor(options: SupervisorClientOptions = {}) {
    const env = options.runId === undefined
      ? process.env
      : { ...process.env, SPLIT_VITEST_RUN_ID: options.runId }
    this.#child = fork(options.supervisorPath ?? SPLIT_HOST_SUPERVISOR_PATH, [], {
      detached: true,
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env,
    })
    this.#child.unref()
    this.#exitPromise = new Promise(resolve => {
      this.#child.once('exit', (code, signal) => {
        this.#exitResult = { code, signal }
        for (const [requestId, pending] of this.#pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`Supervisor exited before response to ${requestId}: ${JSON.stringify(this.#exitResult)}`))
          this.#pending.delete(requestId)
        }
        resolve(this.#exitResult)
      })
    })
    this.#child.on('message', (message: Record<string, any>) => {
      if (message?.type === 'PROGRESS') {
        const pending = this.#pending.get(String(message.requestId))
        pending?.onProgress?.(message)
        return
      }
      const requestId = typeof message?.requestId === 'string' ? message.requestId : undefined
      if (requestId === undefined) return
      const pending = this.#pending.get(requestId)
      if (pending === undefined) return
      clearTimeout(pending.timer)
      this.#pending.delete(requestId)
      if (message.type === 'ERROR') {
        const error = new Error(String(message.message ?? 'Supervisor request failed'))
        Object.assign(error, { code: message.code })
        pending.reject(error)
      } else {
        pending.resolve(message.payload)
      }
    })
  }

  get pids(): { worker: number; supervisor: number | undefined } {
    return { worker: process.pid, supervisor: this.#child.pid }
  }

  async request(
    type: string,
    payload: Record<string, unknown> = {},
    options: { timeoutMs?: number; onProgress?: (message: Record<string, any>) => void } = {},
  ): Promise<any> {
    const requestId = `${type}-${String(++this.#sequence)}-${String(Date.now())}`
    const timeoutMs = options.timeoutMs ?? 120_000
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId)
        reject(new Error(`Supervisor request ${type} timed out after ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.#pending.set(requestId, {
        resolve,
        reject,
        timer,
        ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
      })
      if (this.#exitResult !== undefined) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(new Error(`Supervisor already exited: ${JSON.stringify(this.#exitResult)}`))
        return
      }
      try {
        this.#child.send({ type, requestId, ...payload }, error => {
          if (error !== undefined && error !== null) {
            const pending = this.#pending.get(requestId)
            if (pending === undefined) return
            clearTimeout(pending.timer)
            this.#pending.delete(requestId)
            reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(asError(error))
      }
    })
  }

  async waitExit(timeoutMs = 30_000): Promise<SupervisorExitResult> {
    if (this.#exitResult !== undefined) return this.#exitResult
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Supervisor did not exit within ${String(timeoutMs)}ms`))
      }, timeoutMs)
      this.#exitPromise.then(result => {
        clearTimeout(timer)
        resolve(result)
      }, error => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  async close(options: { timeoutMs?: number; allowKill?: boolean } = {}): Promise<void> {
    if (this.#exitResult !== undefined) return
    const timeoutMs = options.timeoutMs ?? 15_000
    const allowKill = options.allowKill ?? true
    try {
      this.#child.disconnect()
    } catch {
      // A disconnected child may already be collecting its owned resources.
    }
    try {
      await this.waitExit(timeoutMs)
    } catch (error) {
      if (!allowKill) throw error
      try { this.#child.kill('SIGKILL') } catch { /* already gone */ }
      await this.waitExit(3_000).catch(() => undefined)
    }
  }
}
