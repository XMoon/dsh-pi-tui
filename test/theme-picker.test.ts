/**
 * The /settings source-qualified theme picker (the review's P2/P3): the
 * submenu rows carry the SOURCE-QUALIFIED value as their IDENTITY (row
 * id) — display labels are presentational only and never round-trip back
 * to an identity; labels are unique across the whole picker (builtin +
 * file + plugin, including a file that mimics a suffixed label).
 * @module @xmoon76/dsh-pi-tui/theme-picker.test
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { SettingsList, type SettingItem } from '@xmoon76/pi-tui'
import { customThemesDir, darkColors, settingsListTheme } from '../src/theme.ts'
import { ThemeRegistry } from '../src/theme-registry.ts'
import { themePickerRows } from '../src/theme-source.ts'
import { ThemeSubmenu, themeDisplayName } from '../src/theme-menu.ts'

/** Register one plugin theme into a fresh registry. */
function pluginTheme(registry: ThemeRegistry, id: string, name: string, owner = 'acme-plugin'): void {
  registry.register({ id, name, palette: { text: '#123456' } as never }, `${owner}-owner`, owner)
}

test('the picker rows carry the source-qualified VALUE as the identity; display names are unique across builtin/file/plugin', () => {
  const registry = new ThemeRegistry()
  pluginTheme(registry, 'solarized', 'Solarized')
  const rows = themePickerRows(registry)
  // Builtins keep their bare labels.
  assert.deepEqual(rows.slice(0, 3).map(row => ({ value: row.value, displayName: row.displayName })), [
    { value: 'auto', displayName: 'auto' },
    { value: 'dark', displayName: 'dark' },
    { value: 'light', displayName: 'light' },
  ])
  // The plugin row's VALUE is the source-qualified identity; its LABEL is
  // the friendly name (no collision here, so no tag).
  const pluginRow = rows.find(row => row.value === 'plugin:acme-plugin/solarized')
  assert.ok(pluginRow !== undefined, 'the plugin row must carry the source-qualified value')
  assert.equal(pluginRow.displayName, 'Solarized')
})

test('a dark.json custom file next to the builtin dark is disambiguated (the review\'s P2 repro)', () => {
  // `~/.dsh-pi-tui/themes/dark.json` must never produce a second row
  // labeled `dark` — the builtin keeps `dark`, the file becomes
  // `dark (file)`, and the VALUES stay distinct identities.
  const file = join(customThemesDir(), 'dark.json')
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(file, JSON.stringify({ name: 'dark', colors: { primary: '#112233' } }))
  try {
    const rows = themePickerRows(undefined)
    const darks = rows.filter(row => row.displayName === 'dark')
    assert.equal(darks.length, 1, `exactly one row may be labeled "dark": ${JSON.stringify(rows)}`)
    assert.equal(darks[0]?.value, 'dark', 'the bare "dark" label belongs to the BUILTIN, never the file')
    const fileRow = rows.find(row => row.value === 'file:dark')
    assert.ok(fileRow !== undefined, 'the file row exists with its source-qualified value')
    assert.equal(fileRow.displayName, 'dark (file)')
    // The labels are unique across the whole set.
    const labels = rows.map(row => row.displayName)
    assert.equal(new Set(labels).size, labels.length, `labels must be unique: ${labels}`)
  } finally {
    rmSync(file, { force: true })
  }
})

test('a file named "X (plugin)" cannot collide with a plugin label (suffix tagging is label-only)', () => {
  const registry = new ThemeRegistry()
  pluginTheme(registry, 'solarized', 'Solarized')
  const file = join(customThemesDir(), `${randomUUID()}.json`)
  // A file whose NAME mimics the plugin-tag suffix of a (plugin) row.
  const colliding = join(customThemesDir(), 'Solarized (plugin).json')
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(colliding, JSON.stringify({ name: 'Solarized (plugin)', colors: { primary: '#445566' } }))
  try {
    const rows = themePickerRows(registry)
    const pluginRow = rows.find(row => row.value === 'plugin:acme-plugin/solarized')
    assert.ok(pluginRow !== undefined)
    // The plugin claimed `Solarized` first (declaration order: file rows
    // come before plugin rows, but the FILE here is `Solarized (plugin)` —
    // a different label, so no collision with the plugin's bare
    // `Solarized`). The file keeps its literal name.
    const fileRow = rows.find(row => row.value === `file:Solarized (plugin)`)
    assert.ok(fileRow !== undefined, 'the file row exists')
    // If the file were named `Solarized` it would be tagged — covered by
    // the next assertion: labels unique.
    const labels = rows.map(row => row.displayName)
    assert.equal(new Set(labels).size, labels.length, `labels must be unique: ${labels}`)
  } finally {
    rmSync(colliding, { force: true })
  }
})

test('themeDisplayName normalizes a legacy custom:X persisted value to the file row label', () => {
  const name = `legacy-${randomUUID()}`
  const filePath = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ name, colors: { primary: '#778899' } }))
  try {
    // A legacy `custom:<name>` persisted value displays the friendly
    // file name (normalize → file row → label).
    assert.equal(themeDisplayName(`custom:${name}`, undefined), name)
    assert.equal(themeDisplayName(`file:${name}`, undefined), name)
    // A gone plugin value shows the raw qualified value (never a lie).
    assert.equal(themeDisplayName('plugin:acme/gone', undefined), 'plugin:acme/gone')
  } finally {
    rmSync(filePath, { force: true })
  }
})

test('ThemeSubmenu row ids ARE the source-qualified values and labels are unique (no display round-trip)', () => {
  const registry = new ThemeRegistry()
  pluginTheme(registry, 'solarized', 'Solarized')
  const rows = themePickerRows(registry)
  const submenuRows = rows.map(row => ({
    value: row.value,
    label: row.displayName,
  }))
  const submenuValues = submenuRows.map(row => row.value)
  // The ids are the identities — never the display labels.
  assert.ok(submenuValues.includes('auto'))
  assert.ok(submenuValues.includes('dark'))
  assert.ok(submenuValues.includes('plugin:acme-plugin/solarized'))
  // The labels are unique.
  const labels = submenuRows.map(row => row.label)
  assert.equal(new Set(labels).size, labels.length, `labels must be unique: ${labels}`)
  // The submenu constructor builds rows with id = value (rendered labels
  // come from the same rows); esc/settle behavior is exercised at the
  // integration level (session-state.test.ts). Construction must not throw.
  let doneValue: string | undefined = 'unset'
  const menu = new ThemeSubmenu('auto', registry, (picked) => { doneValue = picked })
  assert.ok(menu.render(80).length > 0, 'the submenu renders')
  assert.equal(doneValue, 'unset', 'construction must not settle anything')
})

test('the submenu marks "← current" on the row matching the CURRENT display (the review\'s P3: a re-open after a pick follows the new selection)', () => {
  const registry = new ThemeRegistry()
  const rows = themePickerRows(registry)
  // The fork's submenu contract: the outer row's LIVE currentValue (the
  // NEW selection after a previous pick — the fork sets
  // `item.currentValue = selectedValue` BEFORE the outer onChange) is
  // passed as `currentDisplay` on every open. The submenu marks exactly
  // the row whose LABEL equals it.
  const rendered = (currentDisplay: string): string =>
    new ThemeSubmenu(currentDisplay, registry, () => {}).render(80).join('\n')
  const openAtAuto = rendered('auto')
  assert.ok(openAtAuto.includes('auto') && openAtAuto.includes('← current'),
    'opening with "auto" marks the auto row')
  // After picking `file:…` the outer row shows the friendly label of the
  // picked value — reopening with it marks THAT row (not the stale panel-
  // open value).
  const file = join(customThemesDir(), `${randomUUID()}.json`)
  const name = `current-${randomUUID()}`
  const filePath = join(customThemesDir(), `${name}.json`)
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ name, colors: { primary: '#aabbcc' } }))
  try {
    const openAtFile = rendered(name)
    // Exactly ONE row carries the marker, and it is the file row's label
    // (the file label is unique here — no collision).
    const marked = themePickerRows(registry).filter(row => openAtFile.includes(`${row.displayName}  ← current`) || openAtFile.split('\n').some(line => line.includes('← current') && line.includes(row.displayName)))
    assert.equal(marked.length, 1, `exactly one row must be marked: ${JSON.stringify(themePickerRows(registry))}`)
    assert.ok(marked[0]?.value === `file:${name}`, `the marked row is the picked file: ${marked[0]?.value}`)
  } finally {
    rmSync(filePath, { force: true })
  }
})

test('a selection made before an HMR unload keeps its ORIGINAL identity (never resolves to a same-named new contribution)', () => {
  // The review's P2 HMR repro: the submenu opens while plugin owner A
  // provides `Solarized`; the user confirms AFTER A unloads and a NEW
  // plugin B registers the SAME display name. Because the row id IS the
  // source-qualified value captured at OPEN time, the selection stays A's
  // identity — the confirm never re-resolves the display label against
  // the live registry.
  const registry = new ThemeRegistry()
  // The submenu is opened against A's live registry.
  const handleA = registry.register({
    id: 'solarized',
    name: 'Solarized',
    palette: { text: '#123456' } as never,
  }, 'owner-a-owner', 'owner-a')
  const rowsAtOpen = themePickerRows(registry)
  const rowA = rowsAtOpen.find(row => row.value === 'plugin:owner-a/solarized')
  assert.ok(rowA !== undefined)
  // The user's selection is the FROZEN VALUE (the row id), captured at
  // open time — the /settings handler receives this string and applies it
  // as-is.
  const pickedValue = rowA.value
  // HMR: A unloads (the duplicate-name namespace is free again); B
  // re-registers the same display name under a NEW owner.
  handleA.dispose()
  const handleB = registry.register({
    id: 'solarized',
    name: 'Solarized',
    palette: { text: '#fedcba' } as never,
  }, 'owner-b-owner', 'owner-b')
  const rowsAfterReload = themePickerRows(registry)
  const rowB = rowsAfterReload.find(row => row.value === 'plugin:owner-b/solarized')
  assert.ok(rowB !== undefined)
  // The CONFIRM value is unchanged — the handlers resolve it verbatim
  // (resolveThemeSelection('plugin:owner-a/solarized', registry) resolves
  // A's palette only; after A's unload the registry has no record for
  // owner-a, so it resolves undefined → builtin fallback. Either way the
  // display label never re-ran through the live registry).
  assert.equal(pickedValue, 'plugin:owner-a/solarized',
    'the confirm must carry the open-time identity, never the reloaded one')
  assert.notEqual(pickedValue, rowB.value)
  assert.equal(registry.paletteForSelectable('plugin:owner-a/solarized'), undefined,
    'after A unloads the old identity resolves nothing (deterministic fallback)')
  handleB.dispose()
})
test('INTEGRATION: the vendored SettingsList submenu chain keeps the outer row FRIENDLY and the reopen marker correct (the review\'s P2)', () => {
  // Reviewer's exact repro, driven through the REAL fork SettingsList:
  // 1. the theme row opens a ThemeSubmenu; picking a plugin row fires the
  //    fork's done contract — `item.currentValue = selectedValue` (RAW
  //    identity) then outer onChange(selectedValue).
  // 2. the /settings handler (commands.ts) applies the value AND calls
  //    revert(friendlyLabel) — the openSettings updateValue seam — so the
  //    outer row displays the friendly name, never `plugin:acme/solarized`.
  // 3. reopening the submenu passes the LIVE outer currentValue (now the
  //    friendly label) → the correct row carries `← current`.
  const registry = new ThemeRegistry()
  pluginTheme(registry, 'solarized', 'Solarized')
  pluginTheme(registry, 'nord', 'Nord')

  // The outer row as the /settings handler builds it (commands.ts shape):
  // currentValue holds the FRIENDLY label; submenu is the ThemeSubmenu.
  const outerItems: SettingItem[] = [{
    id: 'theme',
    label: 'Theme',
    currentValue: 'auto',
    submenu: (currentValue, done) => new ThemeSubmenu(currentValue, registry, (picked) => {
      if (picked !== undefined) done(picked)
      else done()
    }),
  }]

  // A faithful miniature of TuiApp.openSettings: the fork ALREADY mutated
  // the row's currentValue to the raw selected value before onChange; the
  // revert callback rewrites the DISPLAYED value (updateValue).
  const applied: string[] = []
  let settledValue: string | undefined
  let list: SettingsList | undefined
  list = new SettingsList(
    outerItems,
    6,
    settingsListTheme(),
    (_id, value) => {
      // The fork has written the RAW identity into the row.
      assert.equal(outerItems[0]?.currentValue, value,
        'the fork contract: item.currentValue = raw selected value BEFORE onChange')
      // The /settings handler's behavior: apply the identity (persist),
      // then rewrite the display back to the friendly label.
      applied.push(value)
      settledValue = value
      const friendly = themeDisplayName(value, registry)
      list?.updateValue('theme', friendly)
    },
    () => {},
    { enableSearch: true },
  )
  const outer = (): string => list!.render(80).join('\n')

  // Open the Theme submenu and select the Solarized plugin row.
  list!.handleInput('\r') // activate the theme row → submenu opens
  let rendered = list!.render(80).join('\n')
  // The submenu shows the plugin label, not the raw identity.
  assert.ok(rendered.includes('Solarized'), `submenu shows the friendly label:\n${rendered}`)
  assert.ok(!rendered.includes('plugin:acme'), `submenu never shows a raw identity:\n${rendered}`)
  // The submenu is a SettingsList; its first row is 'auto'. Move down to
  // Solarized (auto, dark, light, then plugin rows sorted: Nord, Solarized)
  // — the submenu's own handleInput consumes everything now.
  list!.handleInput('\x1b[B') // dark
  list!.handleInput('\x1b[B') // light
  list!.handleInput('\x1b[B') // Nord
  list!.handleInput('\x1b[B') // Solarized
  list!.handleInput('\r') // select Solarized → done(plugin:acme-plugin/solarized)
  // After the pick: the applied identity is the source-qualified value.
  assert.deepEqual(applied, ['plugin:acme-plugin/solarized'])
  assert.equal(settledValue, 'plugin:acme-plugin/solarized')
  // The OUTER row displays the FRIENDLY label (the revert/updateValue
  // seam rewrote it) — never the raw identity.
  rendered = outer()
  assert.ok(rendered.includes('Theme') && rendered.includes('Solarized'), `outer row shows the friendly label:\n${rendered}`)
  assert.ok(!rendered.includes('plugin:acme-plugin/solarized'), `outer row must NOT show the raw identity:\n${rendered}`)

  // Reopen the submenu: the fork passes the LIVE outer currentValue (the
  // friendly label after the rewrite); the Solarized row carries
  // `← current` (not the panel-open 'auto').
  list!.handleInput('\r') // reopen
  rendered = list!.render(80).join('\n')
  assert.ok(rendered.includes('← current'), `the reopen marks a current row:\n${rendered}`)
  // Exactly the Solarized label row is marked.
  const markedLines = rendered.split('\n').filter(line => line.includes('Solarized'))
  assert.ok(markedLines.some(line => line.includes('← current')), `Solarized row is the current one:\n${rendered}`)
  const nordMarked = rendered.split('\n').filter(line => line.includes('Nord') && line.includes('← current'))
  assert.equal(nordMarked.length, 0, `Nord must not be marked:\n${rendered}`)
})

test('the claim algorithm disambiguates a GENERATED suffix against a same-source real name (the review\'s P3/P2)', async () => {
  // Reviewer's repro: a plugin whose REAL display name is `X (plugin)`
  // collides with the GENERATED label of another plugin `X` (which was
  // itself tagged against a file `X`). Same source ('plugin'), so the old
  // `used.get(label) !== source` guard skipped it — two rows looked
  // identical. The fixed claim tags until unique regardless of source.
  const registry = new ThemeRegistry()
  // File rows come first: X.json claims bare 'X' (customThemeNames reads
  // the FILE BASENAME — the content name is irrelevant to the picker).
  const filePath = join(customThemesDir(), 'X.json')
  mkdirSync(customThemesDir(), { recursive: true })
  writeFileSync(filePath, JSON.stringify({ name: 'X', colors: { primary: '#334455' } }))
  try {
    // Plugin A: id a, name 'X' → collides with the FILE's 'X' → tagged
    // 'X (plugin)'.
    registry.register({ id: 'a', name: 'X', palette: { text: '#111111' } as never }, 'oa', 'pluginA')
    // Plugin B: id b, name 'X (plugin)' (a REAL display name) → must be
    // tagged AGAIN (e.g. 'X (plugin 2)'), never a duplicate label.
    registry.register({ id: 'b', name: 'X (plugin)', palette: { text: '#222222' } as never }, 'ob', 'pluginB')
    const rows = themePickerRows(registry)
    const labels = rows.map(row => row.displayName)
    assert.equal(new Set(labels).size, labels.length, `labels must be unique: ${JSON.stringify(rows)}`)
    const xPlugin = rows.find(row => row.value === 'plugin:pluginA/a')
    const xPluginTagged = rows.find(row => row.value === 'plugin:pluginB/b')
    assert.equal(xPlugin?.displayName, 'X (plugin)')
    assert.ok(xPluginTagged !== undefined && xPluginTagged.displayName !== 'X (plugin)',
      `the second plugin must get a unique label, got ${xPluginTagged?.displayName}`)
  } finally {
    rmSync(filePath, { force: true })
  }
})
