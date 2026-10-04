/**
 * M3-5 PR5 two-process Session-writer holder (plan §12 Slice D1).
 *
 * Runs under plain Node against the installed official rc.2 packages: it
 * creates ONE Session over the given persistence root, materializes a minimal
 * completed turn, prints `holding`, and then keeps the descriptor — and with
 * it the kernel write lease — open until the parent kills this process. The
 * release path never runs (SIGKILL is a crash), so the recovery positive
 * control proves the real OS/kernel ownership rather than a cooperative
 * unlock.
 *
 * Mirrors the upstream `session-persistence-jsonl` two-process fixture
 * behavior; it does not import upstream private test code. The holder mounts
 * the package's DEFAULT compression: the shared root is owned by a Host that
 * mounts the same default (zstd), and the Host's own artifact listing refuses
 * a root whose mode differs from a file's actual encoding — so the holder must
 * agree with the root it locks, exactly as upstream's two-process fixture
 * configures both sides identically.
 *
 * argv: persistenceRoot, sessionId, [cwd]
 */

import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, sessionId, cwd] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root })
const handle = await ctx.sessionPersistence.create({
  version: SESSION_FORMAT_VERSION,
  id: sessionId,
  createdAt: 1000,
  cwd: cwd ?? '/work',
  isSeeded: false,
})
await handle.append([
  { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
])
process.stdout.write('holding\n')
// Keep the descriptor (and with it the kernel lock) until killed; never close.
setInterval(() => {}, 1000)
