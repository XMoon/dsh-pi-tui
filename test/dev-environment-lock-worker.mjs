import { resolveDshDevContext } from '../scripts/dsh-dev-context.mjs'
import { _test as bootstrapTest } from '../scripts/dev-bootstrap.mjs'

const [root, config, cache, holdText] = process.argv.slice(2)
const context = resolveDshDevContext({
  root,
  config,
  environment: {
    ...process.env,
    // Hermetic fixture: never inherit repository-local or DSH dev-mode
    // variables from the outer git/CI context.
    GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_PREFIX: undefined,
    GIT_INDEX_FILE: undefined, GIT_OBJECT_DIRECTORY: undefined,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_NAMESPACE: undefined,
    GIT_COMMON_DIR: undefined,
    DSH_DEV_MODE: undefined, DSH_MODE: undefined, DSH_DEV_ROOT: undefined,
    DSH_SOURCE_CONFIG: undefined, DSH_SOURCE_DISTRIBUTION: undefined,
    DSH_DEV_EPHEMERAL: undefined,
    XDG_CACHE_HOME: cache,
  },
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
