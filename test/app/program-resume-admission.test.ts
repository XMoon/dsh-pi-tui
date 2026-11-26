import assert from 'node:assert/strict'
import test from 'node:test'
import { admitProgramResume, programResumeAdmitted } from '../../src/app/program-resume-admission.ts'

test('the explicit TSP opt-in disables OSC 7577 even when PiTui later falls back', () => {
  assert.equal(programResumeAdmitted({ DSH_PI_TUI_RENDERER: 'tsp' }), false)
  assert.equal(programResumeAdmitted({ DSH_PI_TUI_RENDERER: 'pi-tui' }), true)
  assert.equal(programResumeAdmitted({}), true, 'the ordinary PiTui boot remains admitted')
})

test('a TSP opt-in never invokes the capability builder; the ordinary boot still does', () => {
  let built = 0
  const capability = { token: 't', facts: {} }
  assert.equal(admitProgramResume({ DSH_PI_TUI_RENDERER: 'tsp' }, () => {
    built += 1
    return capability
  }), undefined)
  assert.equal(built, 0, 'no capability, no reporter, even after an SDK decline')
  assert.equal(admitProgramResume({}, () => {
    built += 1
    return capability
  }), capability)
  assert.equal(built, 1, 'the PiTui positive control reaches the builder')
})
