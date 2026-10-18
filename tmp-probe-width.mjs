import { visibleWidth } from '@xmoon76/pi-tui'
import { color } from './src/tui/theme/runtime.ts'
const txt = color.text('DeepSeek Search API')
const chip = color.textMuted('[current]')
console.log('text visibleWidth', visibleWidth(txt), 'len', txt.length, JSON.stringify(txt))
console.log('chip visibleWidth', visibleWidth(chip))
console.log('space', visibleWidth(' '))
