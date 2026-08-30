const [root, config, distribution, pnpm, allowDirtyText] = process.argv.slice(2)
process.env.PNPM_EXECUTABLE = pnpm
const { prepareDshTestEnvironment } = await import('../scripts/prepare-dsh-test-environment.mjs')
await prepareDshTestEnvironment({
  mode: 'source',
  distribution,
  workspace: root,
  config,
  ref: 'a'.repeat(40),
  expectedVersion: '0.1.2-alpha.1',
  allowDirty: allowDirtyText === 'true',
})
console.log('prepared')
