/** Shell execution settings use exact SI display units in browse projections.
 *  The authoritative numeric values remain milliseconds/bytes everywhere else.
 *  Only positive safe integers divisible by 1000 are converted; every other
 *  observed value keeps its original exact unit. */
export function formatShellSettingValue(value: number, unit: 'ms' | 'bytes'): string {
  if (!Number.isSafeInteger(value) || value <= 0 || value % 1000 !== 0) {
    return `${String(value)} ${unit}`
  }
  return unit === 'ms'
    ? `${String(value / 1000)} s`
    : `${String(value / 1000)} kB`
}
