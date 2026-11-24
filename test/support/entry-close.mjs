/**
 * The ONE real close waiter shared by the Process Supervisor entries and the
 * close-authority control test. It awaits the close promise registered at
 * spawn; it never synthesizes settlement from child.exitCode/signalCode.
 */
export async function waitForEntryClose(handle, label, timeoutMs = 180_000) {
  if (handle.closePromise === undefined) {
    throw new Error(`${label}: the entry has no registered close event`)
  }
  let timer
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: the entry did not close within ${String(timeoutMs)}ms`))
    }, timeoutMs)
    handle.closePromise.then(value => {
      clearTimeout(timer)
      resolve(value)
    }, error => {
      clearTimeout(timer)
      reject(error)
    })
  })
  // The close listener owns the durable flag; exitCode alone is not a close.
  if (handle.exited !== true) {
    throw new Error(`${label}: the real close event did not settle the entry ledger`)
  }
  return result
}
