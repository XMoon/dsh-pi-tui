/**
 * L3 regression lock for the Remote Task activity read (M3-5 PR2, plan §5 Must 6,
 * §14 L6 step 5/9).
 *
 * The Task Center listing deliberately retains NO descendant Session, so the
 * commit-time activity read must use the official Session-LIST fact
 * (`list.byId[id].running`) and never a borrowed/retained BINDING. Reading the
 * binding-based `sessionFacts.running()` here returned `undefined` for every
 * unretained child and forced every Remote row to `inactive` with an empty
 * badge, even while the semantic Task read reported `running`.
 * @module @xmoon76/dsh-pi-tui/remote-task-activity.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createRemotePresentationSource } from '../src/app/remote/presentation-source.ts'
import type { ExperimentalRemoteRuntime, RemoteBackendRuntime } from '../src/app/remote/runtime.ts'

interface TaskActivityHarness {
  /** The selected Task read's commit-time activity fact. */
  activityOf(childSessionId: string): 'running' | 'inactive' | undefined
  jobs(sessionId: string): readonly { readonly id: string; readonly status: string }[]
  setRunning(childSessionId: string, running: boolean): void
  /** Whether any child generation was borrowed (it must never be). */
  readonly bindingReads: string[]
}

/** Build the REAL Remote presentation bundle over a sessions face whose
 *  `binding()` RECORDS every borrow: the activity read must not need one. */
function taskActivityHarness(): TaskActivityHarness {
  const bindingReads: string[] = []
  const byId = new Map<string, { running: boolean }>([['child-a', { running: true }]])
  const sessions = {
    list: {
      getSnapshot: () => ({
        ids: [...byId.keys()],
        byId: Object.fromEntries(byId),
        projectionsBySession: {},
        phase: 'ready',
      }),
      subscribe: () => () => {},
    },
    refreshProjections: async () => {},
    binding: (id: string) => {
      bindingReads.push(id)
      return undefined
    },
    retain: () => {
      throw new Error('the Task activity read must never retain a Session')
    },
  }
  const wire = {
    client: {
      sessions,
      connection: { generation: { getSnapshot: () => ({ id: 'generation-1' }) } },
      jobs: {
        state: {
          getSnapshot: () => ({ rows: { parent: [{ id: 'job-1', kind: 'bash', label: 'j', status: 'running', startedAt: 1 }] } }),
          subscribe: () => () => {},
        },
        watchRows: () => () => {},
      },
      remote: {
        commands: { list: async () => ({ ok: true, value: [] }) },
        skills: { list: async () => ({ ok: true, value: { skills: [] } }) },
      },
    },
  } as unknown as ExperimentalRemoteRuntime
  const backendRuntime = {
    semantics: {
      sessionReader: { sessionStatus: () => undefined },
      presentationReader: { read: async () => undefined, loadOlder: async () => undefined, loadThrough: async () => undefined },
    },
  } as unknown as RemoteBackendRuntime

  const task = createRemotePresentationSource(wire, backendRuntime).task
  return {
    activityOf: childSessionId => task.activityOf(childSessionId),
    jobs: sessionId => task.jobs(sessionId),
    setRunning(childSessionId, running) { byId.set(childSessionId, { running }) },
    bindingReads,
  }
}

test('an UNRETAINED running child reads running from the official Session list, never from a binding', () => {
  const harness = taskActivityHarness()
  assert.equal(harness.activityOf('child-a'), 'running',
    'the Session-list running fact answers without any retained binding')
  assert.deepEqual(harness.bindingReads, [],
    'the listing deliberately retains/borrows nothing for a descendant')
  harness.setRunning('child-a', false)
  assert.equal(harness.activityOf('child-a'), 'inactive', 'the flip converges on the same fact')
})

test('an unknown Session reads undefined and the roster reads the official rows', () => {
  const harness = taskActivityHarness()
  assert.equal(harness.activityOf('nobody'), undefined, 'an unknown Session is not an authoritative activity')
  assert.deepEqual(harness.jobs('parent').map(job => job.id), ['job-1'])
  assert.deepEqual(harness.jobs('unwatched'), [], 'an unwatched root has no roster key, never a sentinel row')
})
