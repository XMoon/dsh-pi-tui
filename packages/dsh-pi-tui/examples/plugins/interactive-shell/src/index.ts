/**
 * The INTERACTIVE-SHELL example plugin (Phase 5, plan §7): a terminal-
 * native interactive surface built on the UNSTABLE low-level seam — the
 * main real consumer of raw input interception, exclusive raw ownership
 * and the low-level mount. It registers a local `/shell` command that
 * mounts a raw-rendering component and takes exclusive raw input; typing
 * `exit` (or the Host emergency fail-safe, triple-Esc) returns to the
 * Host.
 *
 * Tier usage (plan §7): Unstable — exclusive raw input, raw rendering,
 * raw output streaming. The plugin author owns terminal behavior (the
 * Unstable contract); the Host emergency fail-safe (triple-Esc) is the
 * recovery.
 *
 * This plugin consumes ONLY the public package exports — exactly like an
 * external package (the examples smoke gates it against the packed
 * tarball).
 * @module dsh-pi-example-interactive-shell
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  PI_TUI_EXTENSIONS_SERVICE,
  type PiTuiExtensionService,
  type TuiLocalCommandHandler,
} from '@xmoon76/dsh-pi-tui/extensions'
import { unstable } from '@xmoon76/dsh-pi-tui/extensions/unstable'

export const name = 'dsh-pi-example-interactive-shell'

export const inject = ['tuiStartup', PI_TUI_EXTENSIONS_SERVICE]

export function apply(ctx: Context): void {
  const service = ctx.get(PI_TUI_EXTENSIONS_SERVICE) as PiTuiExtensionService | undefined
  if (service === undefined) return
  // Feature-detect, never parse versions (the API contract).
  if (!service.api().capabilities.has('unstable.input.raw')) return
  if (!service.api().capabilities.has('unstable.surface.handle')) return
  const ui = unstable(service)

  // The interactive shell (plan §7): exclusive raw input + a raw-
  // rendering mount showing the session. `exit` (or the Host fail-safe)
  // returns to the Host.
  const runShell: TuiLocalCommandHandler = async () => {
    const handle = ui.surface.handle
    if (handle.surfaceId === 'inert') return { kind: 'error', text: 'no surface attached' }

    // The session state (owned by the plugin).
    const lines: string[] = ['interactive shell — type anything; `exit` to leave']
    let buffer = ''

    // The raw-rendering mount (plan §9 option A): RAW lines, RAW input.
    const lease = handle.mountComponent({
      render: (width) => {
        const rows = [...lines, `> ${buffer}`]
        return rows.map(line => line.slice(0, Math.max(1, width)))
      },
      handleInput: (raw) => {
        // RAW input: the plugin owns terminal behavior (the Unstable
        // contract). A printable run appends to the buffer; Enter echoes
        // the line; `exit` closes the mount.
        if (raw === '\r' || raw === '\n') {
          lines.push(`> ${buffer}`)
          if (buffer.trim() === 'exit') {
            lease.close()
            return
          }
          lines.push(`echo: ${buffer}`)
          buffer = ''
          handle.requestRender()
          return
        }
        if (raw === '\x7f' || raw === '\b') {
          buffer = buffer.slice(0, -1)
          handle.requestRender()
          return
        }
        if (raw.length === 1 && raw.charCodeAt(0) >= 32 && raw.charCodeAt(0) < 127) {
          buffer += raw
          handle.requestRender()
        }
      },
      dispose: () => {},
    })

    // Exclusive raw ownership (plan §6): the shell owns raw input while
    // it is up — the Host's ordinary input path receives nothing. The
    // Host emergency fail-safe (triple-Esc) is the recovery.
    const capture = ui.input.captureRaw({
      id: 'example-shell-exclusive',
      mode: 'exclusive',
      handle: (event) => {
        // The mount's focused component already receives raw input via
        // the overlay dispatch; the exclusive capture is the ownership
        // declaration (it observes and passes — the mount handles the
        // session). A broken shell can never stall the Host: a throwing
        // handler fails open.
        return { action: 'pass' }
      },
    })

    // The shell runs until the mount closes (exit / fail-safe / owner
    // unload). The command handler resolves when the mount closes.
    // NOTE (Phase-5 gap process): the mount lease has no close
    // notification — the example polls `lease.active` (a demo-grade
    // completion; a production plugin would want a close event on the
    // lease, which is a candidate Advanced/Unstable API addition).
    await new Promise<void>((resolve) => {
      const check = (): void => {
        if (!lease.active) {
          capture.dispose()
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    })
    return { kind: 'success', text: 'shell exited' }
  }

  service.registerCommand({
    id: 'example-interactive-shell',
    name: 'shell',
    description: 'Run the Phase-5 interactive-shell example (Unstable raw seam).',
    execution: 'local',
    handler: runShell,
  })
}
