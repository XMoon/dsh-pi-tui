/**
 * The ONE user-facing Job Stop settlement (plan J2 / L1): every
 * {@link JobStopOutcome} maps to a distinct, truthful notice, and an
 * INDETERMINATE settlement is never reported as a proven negative.
 *
 * @module @xmoon76/dsh-pi-tui/job-stop-notice.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { jobStopNotice } from '../src/app/surface/runtime.ts'

test('jobStopNotice preserves the Job Stop certainty taxonomy', () => {
  assert.deepEqual(jobStopNotice({ kind: 'requested' }, 'build'), {
    message: 'stopping build',
    level: 'info',
  })
  assert.deepEqual(jobStopNotice({ kind: 'already-finished' }, 'build'), {
    message: 'build already finished',
    level: 'info',
  })
  assert.deepEqual(jobStopNotice({ kind: 'not-found' }, 'build'), {
    message: 'build is no longer active',
    level: 'info',
  })
  assert.deepEqual(jobStopNotice({ kind: 'rejected', message: 'the registry refused' }, 'build'), {
    message: 'could not stop build: the registry refused',
    level: 'error',
  })
})

test('an indeterminate settlement is never reported as a proven non-commit', () => {
  const notice = jobStopNotice({ kind: 'indeterminate', message: 'carrier went away' }, 'build')
  assert.equal(notice.level, 'error')
  assert.match(notice.message, /could not confirm stopping build/)
  assert.match(notice.message, /the state will decide/)
  // The certainty contract: an unproven settlement must not read as a refusal.
  assert.doesNotMatch(notice.message, /could not stop|not stopped|already finished|no longer active/)
})
