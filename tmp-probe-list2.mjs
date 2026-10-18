import { SettingsList } from '@xmoon76/pi-tui'
import { color, settingsListTheme } from './src/tui/theme/runtime.ts'
const items = [
  { id: 'sep', label: color.border('-'.repeat(34)), currentValue: '' },
  { id: 'a', label: 'Web Search Provider', currentValue: 'DeepSeek Search API', values: ['Messages', 'DeepSeek Search API'],
    valueParts: [{ kind: 'text', text: 'DeepSeek Search API' }, { kind: 'text', text: ' ' }, { kind: 'chip', text: '[current]' }] },
  { id: 'b', label: 'Web Fetch Provider', currentValue: 'HTTP', values: ['HTTP', 'DeepSeek Fetch API'],
    valueParts: [{ kind: 'text', text: 'HTTP' }, { kind: 'text', text: ' ' }, { kind: 'chip', text: '[current]' }, { kind: 'text', text: ' ' }, { kind: 'chip', text: '[default]' }] },
  { id: 'c', label: 'Search / Fetch API Endpoint', currentValue: 'https://api.deepseek.com/v1/tools' },
]
for (const width of [60, 64, 66, 68, 70]) {
  const list = new SettingsList(items, 6, settingsListTheme(), () => {}, () => {}, { enableSearch: true })
  const rows = list.render(width).map(r => r.replace(/\u001b\[[0-9;]*m/gu, ''))
  console.log('WIDTH', width)
  console.log(rows.slice(0, 4).map(r => `|${r}|`).join('\n'))
}
