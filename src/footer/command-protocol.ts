/**
 * The footer command protocol V1 (plan §17.5): the JSON stdin payload a
 * user-configured status-line command receives. It is a serialization of
 * the StatusSnapshot — the SAME safe projection the footer consumes — so
 * it carries NO secrets, NO credentials, NO raw prompts, NO tool
 * arguments, NO environment dumps, NO session events.
 * @module @xmoon76/dsh-pi-tui/footer/command-protocol
 */

import type { StatusSnapshot } from '../status/types.ts'

/** The V1 stdin payload. */
export interface FooterCommandInputV1 {
  readonly schemaVersion: 1
  readonly surface: {
    readonly width: number
    readonly height: number
    readonly fullscreen: boolean
    readonly focusedSeat: 'editor' | 'overlay' | 'editor-panel' | 'none'
  }
  readonly view: {
    readonly subject: 'main' | 'subagent'
  }
  readonly composition: StatusSnapshot['composition']
  readonly access: StatusSnapshot['access']
  readonly collaboration: {
    readonly plan: StatusSnapshot['collaboration']['plan']
  }
  readonly interaction: StatusSnapshot['interaction']
  readonly workspace: StatusSnapshot['workspace']
  readonly activity: StatusSnapshot['activity']
  readonly usage: StatusSnapshot['usage']
  readonly host: StatusSnapshot['host']
}

/** Build the V1 payload from the snapshot + the live surface geometry. */
export function buildCommandInput(
  snapshot: StatusSnapshot,
  width: number,
  height: number,
): FooterCommandInputV1 {
  return {
    schemaVersion: 1,
    surface: {
      width,
      height,
      fullscreen: snapshot.surface.fullscreen,
      focusedSeat: snapshot.surface.focusedSeat,
    },
    view: {
      subject: snapshot.view.subject.kind === 'subagent' ? 'subagent' : 'main',
    },
    composition: snapshot.composition,
    access: snapshot.access,
    collaboration: { plan: snapshot.collaboration.plan },
    interaction: snapshot.interaction,
    workspace: snapshot.workspace,
    activity: snapshot.activity,
    usage: snapshot.usage,
    host: snapshot.host,
  }
}
