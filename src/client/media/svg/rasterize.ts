/**
 * Client-local SVG → PNG rasterization through ONE isolated child process.
 *
 * The rasterizer is NOT called from `TuiApp.render`: the loader fires it once
 * per (source digest) and the component repaints when the settle notification
 * arrives. The child is a separate OS process because a native rasterizer can
 * abort (resvg's own unbounded-viewBox failure was measured as a real
 * `SIGABRT`); the admission gate in `domain/visual/svg-admission.ts` already
 * refuses the known crash inputs, and process isolation contains the residual
 * native risk. A POSIX virtual-memory cap and a hard timeout bound the child;
 * The production composition only enables this rasterizer on Linux, where the
 * `ulimit` boundary is verified. Platforms without a verifiable native memory
 * bound (macOS, Windows) use the description + source text fallback; a DIRECT
 * call also refuses there. A `ulimit` installation failure exits the child
 * with code 97 BEFORE the native rasterizer runs — it never silently continues.
 * @module @xmoon76/dsh-pi-tui/client/media/svg/rasterize
 */

import { spawn } from 'node:child_process'
import { admitSvg } from '../../../domain/visual/svg-admission.ts'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
  SVG_MAX_PNG_BYTES,
  SVG_MAX_RASTER_PIXELS,
  SVG_MAX_RASTER_SIDE,
  SVG_RASTER_TIMEOUT_MS,
} from '../../../domain/visual/constants.ts'

/** One successful raster output. */
export interface SvgRasterResult {
  /** The PNG bytes (already validated for signature, size and dimensions). */
  readonly png: Uint8Array
  /** The same bytes as base64, the form the PiTui `Image` component takes. */
  readonly base64: string
  readonly widthPx: number
  readonly heightPx: number
}

/** The injectable rasterizer seam (the loader owns dedupe and stale fences). */
export type SvgRasterize = (
  source: string,
  options: { readonly targetWidth: number; readonly signal: AbortSignal },
) => Promise<SvgRasterResult>

const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const MAX_STDERR_BYTES = 16 * 1024
const POSIX_MEMORY_CAP_KB = 4 * 1024 * 1024

/**
 * The child program. It reads one JSON request from stdin, imports the
 * already-resolved resvg module path, rasterizes at the requested width and
 * writes one JSON answer to stdout. Nothing else may reach stdout.
 */
const WORKER_SOURCE = `
import { pathToFileURL } from 'node:url'
// DIAGNOSTIC: one bounded record per milestone — the text "rp ", one of the five
// names request|import|ctor|render|answer, then "=" and the whole milliseconds
// since this child started. The parent treats a line as a record ONLY under that
// exact grammar: a new phase name must be added to its pattern too, and anything
// else stays ordinary stderr that the exit message still reports.
const rpStart = performance.now()
const rp = (phase) => process.stderr.write('rp ' + phase + '=' + Math.round(performance.now() - rpStart) + '\\n')
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', async () => {
  rp('request')
  let input
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    process.stdout.write(JSON.stringify({ ok: false, error: 'raster worker: invalid request' }))
    return
  }
  try {
    const module = await import(pathToFileURL(input.modulePath).href)
    rp('import')
    const Resvg = module.Resvg ?? (module.default && module.default.Resvg)
    if (typeof Resvg !== 'function') throw new Error('resvg module has no Resvg export')
    // The parent sends the EXACT declared CSS viewport; never derive it from
    // Resvg.width/height, which round fractional viewports (0.5 becomes 1) and
    // would under-estimate the fitted canvas. Compute the real canvas and
    // check it BEFORE render() allocates the bitmap.
    const canvasWidth = input.width
    const canvasHeight = Math.ceil(input.width * (input.viewportHeight / input.viewportWidth))
    const renderer = new Resvg(input.svg, { fitTo: { mode: 'width', value: input.width } })
    rp('ctor')
    if (!Number.isInteger(canvasWidth) || !Number.isInteger(canvasHeight)
      || canvasWidth <= 0 || canvasHeight <= 0
      || canvasWidth > ${SVG_MAX_RASTER_SIDE} || canvasHeight > ${SVG_MAX_RASTER_SIDE}
      || canvasWidth * canvasHeight > ${SVG_MAX_RASTER_PIXELS}) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: 'raster canvas ' + String(canvasWidth) + 'x' + String(canvasHeight)
          + ' exceeds the ${SVG_MAX_RASTER_SIDE}px / ${SVG_MAX_RASTER_PIXELS}-pixel budget',
      }))
      return
    }
    const png = renderer.render().asPng()
    rp('render')
    process.stdout.write(JSON.stringify({ ok: true, png: Buffer.from(png).toString('base64') }))
    rp('answer')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  }
})
`

/**
 * Whether this deployment has a verified native memory boundary for the
 * raster child. Only Linux is qualified today (`ulimit -v` was measured); every
 * other platform converges to the description/source text mode.
 */
export function isolatedSvgRasterSupported(): boolean {
  return process.platform === 'linux'
}

/** Resolve the platform binary package once per call (fail with a clear message). */
function resvgModulePath(): string {
  try {
    return createRequire(import.meta.url).resolve('@resvg/resvg-js')
  } catch {
    throw new Error('SVG rasterizer is unavailable: @resvg/resvg-js could not be resolved')
  }
}

/** Read the PNG's own IHDR dimensions after checking the 8-byte signature. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  for (const [index, value] of signature.entries()) if (bytes[index] !== value) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  if (width === 0 || height === 0) return undefined
  return { width, height }
}

/**
 * Rasterize one admitted SVG in an isolated child.
 * @param source - the admitted standalone SVG text.
 * @param options - the requested pixel width and the caller's abort signal.
 * @returns the validated PNG and its dimensions.
 */
/** The injectable child-spawn seam (the production default is `node:child_process.spawn`). */
export type SpawnProcess = typeof spawn

/**
 * Build one rasterizer over an injectable child launcher. The seam exists so a
 * test can instrument the REAL child lifecycle (spawn/close) and prove that a
 * cancellation or overflow settles only after the child is gone; production
 * always uses {@link rasterizeSvg}.
 */
export function createSvgRasterizer(spawnProcess: SpawnProcess = spawn): SvgRasterize {
  return async (source, options) => {
    if (!isolatedSvgRasterSupported()) {
      throw new Error('SVG rasterization requires a verifiable native memory bound; this platform uses the text/source fallback')
    }
    // Re-run the bounded admission to obtain the EXACT source-declared
    // viewport, then refuse an over-budget canvas BEFORE spawning the native
    // child (the post-render IHDR check remains the last line of defense).
    const admission = admitSvg(source)
    if (!admission.ok) {
      throw new Error(`SVG rasterizer rejected the document: ${admission.reason}`)
    }
    const width = Math.max(1, Math.min(SVG_MAX_RASTER_SIDE, Math.floor(options.targetWidth)))
    const canvasWidth = width
    const canvasHeight = Math.ceil(width * (admission.viewportHeight / admission.viewportWidth))
    if (canvasWidth > SVG_MAX_RASTER_SIDE || canvasHeight > SVG_MAX_RASTER_SIDE
      || canvasWidth * canvasHeight > SVG_MAX_RASTER_PIXELS) {
      throw new Error(`SVG raster canvas ${canvasWidth}x${canvasHeight} exceeds the ${SVG_MAX_RASTER_SIDE}px / ${SVG_MAX_RASTER_PIXELS}-pixel budget`)
    }
    const modulePath = resvgModulePath()
    // `|| exit 97` is the fail-closed gate: if the shell cannot install the
    // virtual-memory cap, the native rasterizer must never run. The parent
    // reports the exit and the card keeps its description/source text.
    const command = '/bin/sh'
    const args = ['-c', `ulimit -v ${POSIX_MEMORY_CAP_KB} || exit 97; exec "$0" --max-old-space-size=256 --input-type=module -e "$1"`, process.execPath, WORKER_SOURCE]
    return await new Promise<SvgRasterResult>((resolve, reject) => {
      const child = spawnProcess(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      let stdout = ''
      let stderr = ''
      let settled = false
      let timedOut = false
      let cancelled = false
      let overflow = false
      let timer: NodeJS.Timeout | undefined
      // ── DIAGNOSTIC (branch fix/svg-raster-coldstart-timeout-20261105) ──────
      // The relative phase timeline of ONE child, so a tripped bound names the
      // stalled boundary instead of only reporting "exceeded 3000 ms". The
      // parent-side marks carry numbers and a code/signal only: no SVG source,
      // no PNG bytes, no child stderr text. The only child-supplied text the
      // timeout message adds is the worker's own milestone records, matched by
      // their exact grammar below.
      //
      // Two DIFFERENT authorities, never conflated by one mark:
      //   `stdinWritten`  = this process's `Writable.end()` callback ran, i.e.
      //                     the parent's loop handed the bytes into the OS pipe.
      //                     It is NOT proof the worker read or parsed them.
      //   `rp request`    = the worker's own line: its stdin really reached EOF.
      // A late `stdinWritten` with no `rp` line at all is therefore "the parent
      // never got scheduled", while `rp request` present and no `rp answer` is
      // "the worker took the work and stalled inside it".
      const startedAt = performance.now()
      const phases: string[] = []
      const mark = (phase: string, detail?: string): void => {
        phases.push(`${phase}=${Math.round(performance.now() - startedAt)}${detail !== undefined ? `(${detail})` : ''}`)
      }
      mark('spawn')
      // The child's own milestone records, kept separate from any real stderr so
      // neither message buries the other. Matching is the EXACT record grammar
      // the worker writes, never a bare prefix: a native error line that happens
      // to begin `rp ` is real stderr and must stay visible in the exit message
      // instead of being absorbed as a phase. A missing or empty milestone set is
      // a valid answer (`''`): nothing parses the numbers, so an absent field can
      // never raise a new failure over the real one.
      const isMilestone = (line: string): boolean => /^rp (?:request|import|ctor|render|answer)=\d+$/u.test(line)
      const workerPhases = (): string => stderr.split('\n').filter(isMilestone).join(' ')
      const workerStderr = (): string => stderr.split('\n').filter(line => !isMilestone(line)).join('\n').trim().slice(0, 200)
      // ───────────────────────────────────────────────────────────────────────
      const finish = (error: Error | undefined, result?: SvgRasterResult): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        options.signal.removeEventListener('abort', onAbort)
        if (error !== undefined) reject(error)
        else resolve(result as SvgRasterResult)
      }
      // A termination only kills the child. The promise settles on the child's
      // `close` event, so the loader's single worker lane cannot start the NEXT
      // native process while this one still exists (SIGSTOP, a slow teardown and
      // an overflow all wait for the real close).
      const terminate = (reason: 'cancelled' | 'timeout' | 'overflow'): void => {
        if (settled) return
        if (reason === 'cancelled') cancelled = true
        else if (reason === 'timeout') timedOut = true
        else overflow = true
        mark('terminate', reason)
        child.kill('SIGKILL')
      }
      const onAbort = (): void => terminate('cancelled')
      timer = setTimeout(() => terminate('timeout'), SVG_RASTER_TIMEOUT_MS)
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        if (stdout.length === 0) mark('firstStdout')
        stdout += chunk
        if (Buffer.byteLength(stdout, 'utf8') > MAX_STDOUT_BYTES) terminate('overflow')
      })
      child.stdout.on('end', () => mark('stdoutEnd', `${Buffer.byteLength(stdout, 'utf8')}b`))
      child.stderr.on('data', (chunk: string) => {
        if (stderr.length < MAX_STDERR_BYTES) stderr += chunk
      })
      child.on('error', (error: Error) => finish(new Error(`SVG rasterizer failed to start: ${error.message}`)))
      child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        mark('exit', `code=${code ?? 'null'} signal=${signal ?? 'null'}`)
      })
      child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
        mark('close', `code=${code ?? 'null'} signal=${signal ?? 'null'}`)
        if (timedOut) {
          finish(new Error(`SVG rasterization exceeded ${SVG_RASTER_TIMEOUT_MS} ms [${phases.join(' ')}] [${workerPhases()}]`))
          return
        }
        if (cancelled) {
          finish(new Error('SVG rasterization was cancelled'))
          return
        }
        if (overflow) {
          finish(new Error('SVG rasterizer produced too much output'))
          return
        }
        if (code !== 0) {
          finish(new Error(`SVG rasterizer exited (${code ?? signal ?? 'unknown'}): ${workerStderr()}`))
          return
        }
        let message: unknown
        try {
          message = JSON.parse(stdout)
        } catch {
          finish(new Error('SVG rasterizer returned an unreadable answer'))
          return
        }
        const answer = message as { ok?: unknown; png?: unknown; error?: unknown }
        if (answer.ok !== true || typeof answer.png !== 'string') {
          finish(new Error(typeof answer.error === 'string' ? `SVG rasterizer rejected the document: ${answer.error}` : 'SVG rasterizer rejected the document'))
          return
        }
        const png = Buffer.from(answer.png, 'base64')
        if (png.length === 0 || png.length > SVG_MAX_PNG_BYTES) {
          finish(new Error(`SVG rasterizer produced an out-of-budget PNG (${png.length} bytes)`))
          return
        }
        const dimensions = pngDimensions(png)
        if (dimensions === undefined) {
          finish(new Error('SVG rasterizer produced an invalid PNG'))
          return
        }
        if (dimensions.width > SVG_MAX_RASTER_SIDE || dimensions.height > SVG_MAX_RASTER_SIDE
          || dimensions.width * dimensions.height > SVG_MAX_RASTER_PIXELS) {
          finish(new Error(`SVG raster exceeded the pixel budget (${dimensions.width}×${dimensions.height})`))
          return
        }
        finish(undefined, { png, base64: answer.png, widthPx: dimensions.width, heightPx: dimensions.height })
      })
      child.stdin.on('error', () => { /* the child may exit before reading; close handles it */ })
      if (options.signal.aborted) {
        terminate('cancelled')
      } else {
        options.signal.addEventListener('abort', onAbort, { once: true })
        // DIAGNOSTIC: the parent-side write boundary (see the block above): this
        // callback runs when OUR loop pushed the bytes into the pipe.
        child.stdin.end(JSON.stringify({
        modulePath,
        svg: source,
        width,
        viewportWidth: admission.viewportWidth,
        viewportHeight: admission.viewportHeight,
      }), () => mark('stdinWritten'))
      }
    })
  }
}

/** The production rasterizer (Linux-only, verified native memory bound). */
export const rasterizeSvg: SvgRasterize = createSvgRasterizer()
