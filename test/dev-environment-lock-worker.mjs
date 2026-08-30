import { resolveDshDevContext } from '../scripts/dsh-dev-context.mjs'
import { _test as bootstrapTest } from '../scripts/dev-bootstrap.mjs'

const [root, config, cache, holdText] = process.argv.slice(2)
const context = resolveDshDevContext({
  root,
  config,
  environment: { ...process.env, XDG_CACHE_HOME: cache },
})
const lock = await bootstrapTest.acquireSourceLock({}, context)
console.log(JSON.stringify({
  acquired: lock.acquired,
  lockPath: lock.lockPath,
  harnessRepository: context.harnessRepository,
  harnessCheckout: context.harnessCheckout,
}))
await new Promise(resolve => setTimeout(resolve, Number(holdText) || 100))
bootstrapTest.releaseSourceLock(lock)
