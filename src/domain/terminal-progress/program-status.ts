/**
 * The neutral main-Agent "program status" vocabulary.
 *
 * The terminal presentation (OSC 7501) and the Client-local Pane reporters
 * (Herdr) consume the SAME already-derived logical status: `idle` / `working` /
 * `blocked`, the settled `done`/`error` outcomes of a running interval, and the
 * `clear` presentation retirement. The type lives in the neutral domain layer so
 * application owners and Client-local capabilities can name it without importing
 * terminal presentation, while `src/tui/terminal/program-status.ts` keeps the
 * protocol encoding and classification.
 *
 * @module @xmoon76/dsh-pi-tui/domain/terminal-progress/program-status
 */

/** The closed logical program-status vocabulary shared by every sink. */
export type ProgramStatus =
  | { state: 'idle' | 'working' | 'done' | 'error' }
  | { state: 'blocked'; kind: 'permission' | 'question' }
  | { state: 'clear' }
