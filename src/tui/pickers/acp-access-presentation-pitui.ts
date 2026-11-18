/**
 * The default PiTui `/acp` presentation: ONE short Settings overlay.
 *
 * It is deliberately NOT a second Settings workspace: the menu is a small list
 * of the live listener state, the ONE action that state admits, and the read-only
 * Details entry. Every projection is rebuilt from the command's settled read; a
 * menu never keeps an ACP state of its own and never writes anything — an
 * activation only forwards the explicit intent through {@link AcpAccessRequest.act}.
 *
 * A projection is mounted by closing the PREVIOUS overlay first and opening the
 * new one second, so at most one ACP menu (and one focus seat) exists at a time.
 * Closing the overlay retires the presentation only: an accepted Host mutation is
 * never undone.
 *
 * Pointer activation is the `SettingsList` component's OWN mouse contract and
 * is delivered by the alt-screen (fullscreen) surface, which is the only place
 * this host enables terminal mouse reporting and routes pointer events to
 * overlays. The regular screen deliberately keeps the terminal's native
 * selection/drag behavior and has no overlay pointer capture, so this presenter
 * adds NO custom mouse routing and no vendored-fork divergence.
 *
 * @module tui/pickers/acp-access-presentation-pitui
 */

import type { SettingItem } from '@xmoon76/pi-tui'
import type {
  AcpAccessActionId,
  AcpAccessMenuHandle,
  AcpAccessNotice,
  AcpAccessPresentation,
  AcpAccessReadOutcome,
  AcpAccessRequest,
} from '../../app/command/acp-access-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import type { TuiApp } from '../../tui-app.ts'

/** The status vocabulary as one menu row label. */
function statusLabel(outcome: AcpAccessReadOutcome): string {
  if (outcome.kind === 'unavailable') return 'Status: unavailable (connection)'
  return `Status: ${outcome.status.state}`
}

/** The complete status sentence shown under the selected state row. */
function statusDescription(outcome: AcpAccessReadOutcome): string {
  if (outcome.kind === 'unavailable') {
    return `The Host ACP status could not be read: ${sanitizedPhysicalLine(outcome.message)}`
  }
  const status = outcome.status
  switch (status.state) {
    case 'disabled':
      return 'The local ACP v1 listener is not bound on this Host.'
    case 'enabled':
      return "The local ACP v1 listener is bound on this Host's Unix socket."
    case 'changing':
      return 'An ACP enable/disable request is still running; wait for it to settle.'
    case 'unavailable':
      return `The Host cannot report a healthy ACP listener: ${sanitizedPhysicalLine(status.reason)}`
  }
}

/** The one row every projection starts with: the CURRENT Host fact. */
function statusRow(outcome: AcpAccessReadOutcome): SettingItem {
  return {
    id: 'acp-status',
    label: statusLabel(outcome),
    description: statusDescription(outcome),
    currentValue: '',
  }
}

/** Build one action row (it is the ONLY row shape that can write). */
function actionRow(id: AcpAccessActionId, label: string, description: string): SettingItem {
  return { id: `acp-${id}`, label, description, currentValue: '', values: [id] }
}

/** The Details entry (a read-only projection, never a write). */
function detailsRow(outcome: AcpAccessReadOutcome): SettingItem {
  return {
    id: 'acp-details',
    label: 'Details…',
    description: `Host, current state and limits of the local ACP listener (${statusLabel(outcome).replace(/^Status: /u, '')}).`,
    currentValue: '',
    values: ['details'],
  }
}

/**
 * The read-only Details projection: the durable facts a user must know before
 * pressing anything. No socket path, token or private bind name enters a menu
 * row.
 */
function detailsRows(outcome: AcpAccessReadOutcome): SettingItem[] {
  const facts: ReadonlyArray<readonly [string, string]> = [
    ['Host', 'Local Split Host (same OS user; no TCP/HTTP)'],
    ['Status', statusDescription(outcome)],
    ['Enable / Disable', "Serve or retire this Host's local ACP listener."],
    ['Auto-start', 'Settings → General → Start ACP automatically applies on the next Host start.'],
    ['Sessions', 'Closing an ACP View detaches it; it does not end Host sessions or TUI work.'],
  ]
  return [
    {
      id: 'acp-back',
      label: '← Back to ACP',
      description: 'Return to the ACP menu (Esc also closes this page).',
      currentValue: '',
      values: ['back'],
    },
    ...facts.map(([label, description]) => ({ id: `acp-fact-${label}`, label, description, currentValue: '' })),
  ]
}

/** The action-result row: a transient fact painted INSIDE the menu, because the
 *  overlay covers the base surface's notice line at common heights. */
function noticeRow(notice: AcpAccessNotice): SettingItem {
  return {
    id: 'acp-notice',
    label: sanitizedPhysicalLine(notice.message),
    description: notice.kind === 'error'
      ? 'The action failed; the current Host state is shown below.'
      : 'Action result.',
    currentValue: '',
  }
}

/** The loading projection: one inert row, no write. */
function loadingRow(): SettingItem[] {
  return [{
    id: 'acp-loading',
    label: 'Loading ACP status…',
    description: 'Reading the Host ACP listener state.',
    currentValue: '',
  }]
}

/** One inert progress row for an admitted action (no write is offered). */
function pendingRow(message: string): SettingItem[] {
  return [{
    id: 'acp-pending',
    label: sanitizedPhysicalLine(message),
    description: 'Waiting for the Host to answer.',
    currentValue: '',
  }]
}

export function pituiAcpAccessPresentation(app: TuiApp): AcpAccessPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request: AcpAccessRequest) => {
      let disposed = false
      let closer: (() => void) | undefined
      /** Close the mounted overlay (the caller then opens the next one). */
      const retire = (): void => {
        const close = closer
        closer = undefined
        close?.()
      }
      /** Mount one projection after retiring the previous one. */
      const show = (rows: SettingItem[], act: (value: string) => void): void => {
        if (disposed) return
        retire()
        closer = app.openSettings(
          rows,
          (_id, value) => { act(value) },
          () => {
            // Esc / ctrl+c: the menu is gone and this presentation is retired.
            closer = undefined
            disposed = true
          },
        )
      }
      let current: AcpAccessReadOutcome | undefined
      const menu = (outcome: AcpAccessReadOutcome, notice?: AcpAccessNotice): void => {
        current = outcome
        const rows: SettingItem[] = [statusRow(outcome)]
        if (notice !== undefined) rows.push(noticeRow(notice))
        if (outcome.kind === 'status') {
          switch (outcome.status.state) {
            case 'disabled':
              rows.push(actionRow('enable', 'Enable ACP', "Start this Host's local ACP v1 listener."))
              break
            case 'enabled':
              rows.push(actionRow('disable', 'Disable ACP', "Stop this Host's local ACP v1 listener. The TUI keeps running."))
              break
            case 'changing':
            case 'unavailable':
              // No write is offered while the Host is changing or cannot report
              // a healthy listener.
              break
          }
        }
        rows.push(detailsRow(outcome))
        show(rows, (value) => {
          if (disposed || !request.isCurrent()) return
          if (value === 'details') {
            show(detailsRows(outcome), (detailsValue) => {
              if (detailsValue === 'back' && current !== undefined) menu(current)
            })
            return
          }
          // Only an action the CURRENT state really offered can reach here.
          request.act(value as AcpAccessActionId)
        })
      }
      const handle: AcpAccessMenuHandle = {
        setLoading: () => show(loadingRow(), () => {}),
        setPending: (message) => show(pendingRow(message), () => {}),
        setStatus: (outcome, notice) => menu(outcome, notice),
        isDisposed: () => disposed,
        close: () => {
          if (disposed) return
          disposed = true
          retire()
        },
      }
      // The menu asks the Host for its status as soon as it is entered; the
      // command's read owner answers through `setStatus`.
      handle.setLoading()
      request.runOwned('acp status', () => request.readStatus(), {
        isCancellation: () => handle.isDisposed() || !request.isCurrent(),
        onResult: (outcome) => {
          if (handle.isDisposed() || !request.isCurrent()) return
          handle.setStatus(outcome)
        },
      })
      return handle
    },
  }
}
