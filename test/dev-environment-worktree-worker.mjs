import { resolveDshDevContext } from '../scripts/dsh-dev-context.mjs'
import { _test as bootstrapTest } from '../scripts/dev-bootstrap.mjs'

const [root, config, cache] = process.argv.slice(2)
const context = resolveDshDevContext({
  root,
  config,
  environment: { ...process.env, XDG_CACHE_HOME: cache },
})
const checkout = await bootstrapTest.ensureHarnessCheckout(context, undefined, { skipRepository: true })
console.log(JSON.stringify({
  ref: context.source.ref,
  checkout,
  repository: context.harnessRepository,
}))
