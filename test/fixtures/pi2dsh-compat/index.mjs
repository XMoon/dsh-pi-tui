import { writeFileSync } from 'node:fs'

const evidencePath = process.env.PI2DSH_COMPAT_EVIDENCE
const state = {
  commandInvoked: false,
  renderWidths: [],
  inputs: [],
  disposeCount: 0,
  doneCount: 0,
}

function writeEvidence() {
  if (typeof evidencePath !== 'string' || evidencePath.length === 0) return
  writeFileSync(evidencePath, JSON.stringify(state, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  })
}

class Pi2dshCompatComponent {
  constructor(tui, done) {
    this.tui = tui
    this.done = done
  }

  render(width) {
    state.renderWidths.push(width)
    writeEvidence()
    return [
      'PI2DSH_COMPAT_READY',
      `PI2DSH_COMPAT_INPUT=${state.inputs.at(-1) ?? '(none)'}`,
      `PI2DSH_COMPAT_WIDTH=${width}`,
      'PI2DSH_COMPAT_CLOSE=q',
    ]
  }

  handleInput(data) {
    if (data === 'q') {
      this.done({ closed: true })
      return
    }
    state.inputs.push(data)
    writeEvidence()
    this.tui.requestRender()
  }

  dispose() {
    state.disposeCount += 1
    writeEvidence()
  }
}

export default function pi2dshCompatFixture(pi) {
  pi.registerCommand('xmoon-pi-compat', {
    description: 'Open the Pi to pi2dsh component compatibility probe',
    async handler(_args, ctx) {
      state.commandInvoked = true
      writeEvidence()
      ctx.ui.setStatus('compat', 'pi2dsh-compat')
      await ctx.ui.custom((tui, _theme, _keybindings, done) => {
        const complete = value => {
          state.doneCount += 1
          writeEvidence()
          done(value)
        }
        return new Pi2dshCompatComponent(tui, complete)
      })
    },
  })
}
