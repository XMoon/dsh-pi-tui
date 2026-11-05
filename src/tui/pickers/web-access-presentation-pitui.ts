/**
 * The default PiTui `/web` presentation: ONE short Settings overlay.
 *
 * It is deliberately NOT a second Settings workspace: the menu is a small list
 * of the state fact, the actions the CURRENT Host status admits, and the
 * Details entry. Every projection is rebuilt from the command's settled read;
 * a menu never keeps a Web state of its own and never writes anything — an
 * activation only forwards the explicit intent through
 * {@link WebAccessRequest.act}.
 *
 * A projection is mounted by closing the PREVIOUS overlay first and opening the
 * new one second, so at most one Web menu (and one focus seat) exists at a
 * time. Closing the overlay retires the presentation only: an accepted Host
 * mutation is never undone.
 *
 * Pointer activation is the `SettingsList` component's OWN mouse contract and
 * is delivered by the alt-screen (fullscreen) surface, which is the only place
 * this host enables terminal mouse reporting and routes pointer events to
 * overlays. The regular screen deliberately keeps the terminal's native
 * selection/drag behavior and has no overlay pointer capture, so this presenter
 * adds NO custom mouse routing and no vendored-fork divergence.
 *
 * @module tui/pickers/web-access-presentation-pitui
 */

import type { SettingItem } from '@xmoon76/pi-tui'
import type {
  WebAccessActionId,
  WebAccessMenuHandle,
  WebAccessPresentation,
  WebAccessReadOutcome,
  WebAccessRequest,
} from '../../app/command/web-access-presentation.ts'
import { sanitizedPhysicalLine } from '../presentation/lines.ts'
import type { TuiApp } from '../../tui-app.ts'

/** The status vocabulary as one menu row label. */
function statusLabel(outcome: WebAccessReadOutcome): string {
  if (outcome.kind === 'unavailable') return 'Status: unavailable (connection)'
  return `Status: ${outcome.status.state}`
}

/** The complete status sentence shown under the selected state row. */
function statusDescription(outcome: WebAccessReadOutcome): string {
  if (outcome.kind === 'unavailable') {
    return `The Host Web status could not be read: ${sanitizedPhysicalLine(outcome.message)}`
  }
  const status = outcome.status
  switch (status.state) {
    case 'disabled':
      return 'The official Web frontend is not being served by this Host.'
    case 'enabled':
      return 'The official Web frontend is being served by this Host on 127.0.0.1.'
    case 'changing':
      return 'A Web enable/disable request is still running; wait for it to settle.'
    case 'unavailable':
      return `The Host cannot report a serving Web frontend: ${sanitizedPhysicalLine(status.reason)}`
  }
}

/** The one row every projection starts with: the CURRENT Host fact. */
function statusRow(outcome: WebAccessReadOutcome): SettingItem {
  return {
    id: 'web-status',
    label: statusLabel(outcome),
    description: statusDescription(outcome),
    currentValue: '',
  }
}

/** Build one action row (it is the ONLY row shape that can write). */
function actionRow(id: WebAccessActionId, label: string, description: string): SettingItem {
  return { id: `web-${id}`, label, description, currentValue: '', values: [id] }
}

/** The Details entry (a read-only projection, never a write). */
function detailsRow(outcome: WebAccessReadOutcome): SettingItem {
  return {
    id: 'web-details',
    label: 'Details…',
    description: `Host, current state and limits of the Web frontend (${statusLabel(outcome).replace(/^Status: /u, '')}).`,
    currentValue: '',
    values: ['details'],
  }
}

/**
 * The read-only Details projection: the durable facts a user must know before
 * pressing anything, with NO launch URL (the token never enters a menu row).
 */
function detailsRows(outcome: WebAccessReadOutcome): SettingItem[] {
  const facts: ReadonlyArray<readonly [string, string]> = [
    ['Host', '127.0.0.1 (this machine only; no LAN, proxy or SSH tunnel)'],
    ['Status', statusDescription(outcome)],
    ['Enable / Disable', 'Stop or start serving the official Web frontend. Disabling unloads the Web-only rows; it does not revoke browser cookies or terminate an already open page.'],
    ['Session', 'Opens the Web home page; choose a session there. The TUI does not open or follow a specific session.'],
    ['Auto-start', 'The Auto-start preference applies on the next Host launch.'],
  ]
  return [
    {
      id: 'web-back',
      label: '← Back to Web',
      description: 'Return to the Web menu (Esc also closes this page).',
      currentValue: '',
      values: ['back'],
    },
    ...facts.map(([label, description]) => ({ id: `web-fact-${label}`, label, description, currentValue: '' })),
  ]
}

/** The loading projection: one inert row, no write. */
function loadingRow(): SettingItem[] {
  return [{
    id: 'web-loading',
    label: 'Loading Web status…',
    description: 'Reading the Host Web frontend state.',
    currentValue: '',
  }]
}

/** One inert progress row for an admitted action (no write is offered). */
function pendingRow(message: string): SettingItem[] {
  return [{
    id: 'web-pending',
    label: sanitizedPhysicalLine(message),
    description: 'Waiting for the Host to answer.',
    currentValue: '',
  }]
}

export function pituiWebAccessPresentation(app: TuiApp): WebAccessPresentation {
  return {
    notify: (message, kind) => app.notify(message, kind),
    open: (request: WebAccessRequest) => {
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
      let current: WebAccessReadOutcome | undefined
      const menu = (outcome: WebAccessReadOutcome): void => {
        current = outcome
        const rows: SettingItem[] = [statusRow(outcome)]
        if (outcome.kind === 'status') {
          switch (outcome.status.state) {
            case 'disabled':
              rows.push(actionRow('enable', 'Enable Web', 'Start serving the official Web frontend from this Host.'))
              break
            case 'enabled':
              rows.push(
                actionRow('open-browser', 'Open Browser', 'Request the OS to open the official Web home page.'),
                actionRow('copy-link', 'Copy Link', 'Copy the authenticated Web home link to the clipboard.'),
                actionRow('disable', 'Disable Web', 'Stop serving the official Web frontend. The TUI keeps running.'),
              )
              break
            case 'changing':
            case 'unavailable':
              // No write is offered while the Host is changing or cannot
              // report a serving frontend.
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
          request.act(value as WebAccessActionId)
        })
      }
      const handle: WebAccessMenuHandle = {
        setLoading: () => show(loadingRow(), () => {}),
        setPending: (message) => show(pendingRow(message), () => {}),
        setStatus: (outcome) => menu(outcome),
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
      request.runOwned('web status', () => request.readStatus(), {
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
