/**
 * M6 headless Web CLI: the REAL installed `dsh --profile pi-tui web ...`
 * commands against one isolated packed Host.
 *
 * The case drives the public CLI entry (never an internal process harness):
 * first the Host-absent refusal, then a real `daemon start`, the five Web verbs,
 * the official token -> Cookie -> Web shell exchange, real unauthenticated and
 * cross-site refusals on the Owner-only route, and the disable path that leaves
 * `/connect` authenticated. The URL token is held only in local variables; no
 * trace or assertion dump contains it.
 *
 * @module split-process/web-cli-m6
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SplitSmokeAssertionError } from '../../lib/split-smoke-diagnostics.mjs'

function assert(condition, message) {
  if (!condition) throw new SplitSmokeAssertionError(message)
}

function runCli(installation, args, extraEnv = {}) {
  const [executable, ...prefix] = installation.dshInvocation
  return spawnSync(executable, [...prefix, '--profile', 'pi-tui', ...args], {
    cwd: installation.profileDir,
    env: { ...installation.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 180_000,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function statusFields(result) {
  const lines = (result.stdout ?? '').split('\n')
  const start = lines.findLastIndex(line => line.startsWith('profile='))
  const fields = {}
  if (start >= 0) {
    for (const line of lines.slice(start)) {
      const at = line.indexOf('=')
      if (at > 0 && !line.includes(' ')) fields[line.slice(0, at)] = line.slice(at + 1)
    }
  }
  return fields
}

function assertExit(result, code, label) {
  assert(result.status === code,
    `${label}: exit ${String(result.status)} != ${String(code)}; stderr tail: ${String(result.stderr ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(-800)}`)
}

function assertExactLine(result, line, label) {
  assertExit(result, 0, label)
  assert(result.stdout === `${line}\n`, `${label}: stdout was ${JSON.stringify(result.stdout)}, expected exactly ${JSON.stringify(`${line}\n`)}`)
  assert(result.stderr === '', `${label}: expected empty stderr, got ${JSON.stringify(result.stderr)}`)
}

function recordPaths(dshHome) {
  const root = join(dshHome, 'run', 'dsh-pi-tui')
  if (!existsSync(root)) return []
  const paths = []
  for (const scope of readdirSync(root, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue
    const dir = join(root, scope.name)
    if (existsSync(join(dir, 'instance.json'))) {
      paths.push({
        instancePath: join(dir, 'instance.json'),
        launchPath: join(dir, 'launch.json'),
      })
    }
  }
  return paths
}

function readRecord(dshHome) {
  const paths = recordPaths(dshHome)
  assert(paths.length === 1, `expected exactly one published Host instance record, found ${paths.length}`)
  return JSON.parse(readFileSync(paths[0].instancePath, 'utf8'))
}

function readLaunch(dshHome, instanceId) {
  const paths = recordPaths(dshHome)
  const path = paths.find(candidate => JSON.parse(readFileSync(candidate.instancePath, 'utf8')).instanceId === instanceId)
  assert(path !== undefined, 'the authenticated Host launch material is missing')
  return JSON.parse(readFileSync(path.launchPath, 'utf8'))
}

async function fetchStatus(url, init) {
  try {
    return await fetch(url, { redirect: 'manual', cache: 'no-store', ...init })
  } catch (error) {
    const cause = error !== null && typeof error === 'object' ? error.cause : undefined
    const code = cause !== null && typeof cause === 'object' && typeof cause.code === 'string' ? cause.code : undefined
    throw new SplitSmokeAssertionError(`HTTP request failed during the Web CLI case${code === undefined ? '' : ` (${code})`}`)
  }
}

function setCookiePair(response) {
  const headers = response.headers
  const raw = headers.getSetCookie?.() ?? (headers.get('set-cookie') === null ? [] : [headers.get('set-cookie')])
  return raw[0]?.split(';', 1)[0] ?? ''
}

function assertWebUrl(raw, record) {
  let url
  try { url = new URL(raw) } catch { throw new SplitSmokeAssertionError('web url: stdout is not a URL') }
  assert(url.protocol === 'http:', `web url: protocol is ${url.protocol}`)
  assert(url.origin === record.origin, `web url: origin ${url.origin} != authenticated Host origin ${record.origin}`)
  assert(url.pathname === '/', `web url: pathname is ${url.pathname}`)
  assert(url.username === '' && url.password === '' && url.hash === '', 'web url: URL carries userinfo or a fragment')
  assert([...url.searchParams.keys()].length === 1 && url.searchParams.getAll('token').length === 1,
    'web url: query must contain exactly one token')
  assert(url.searchParams.get('token') !== '', 'web url: token is empty')
  return url
}

/**
 * Create a fake local opener that validates its URL argument against a
 * SHA-256 digest and writes ONLY a non-secret MATCH/MISMATCH marker. The URL
 * (and therefore its token) is never persisted to a fixture file.
 */
function fakeOpener(installation, name, expectedSha256) {
  const bin = join(installation.workDir, `web-cli-fake-bin-${String(process.pid)}`)
  const log = join(installation.workDir, `web-cli-opener-${String(process.pid)}.log`)
  mkdirSync(bin, { recursive: true, mode: 0o700 })
  const script = join(bin, name)
  writeFileSync(script, [
    '#!/bin/sh',
    'umask 077',
    'if command -v sha256sum >/dev/null 2>&1; then',
    '  digest=$(printf \'%s\' "$1" | sha256sum | awk \'{print $1}\')',
    'else',
    '  digest=$(printf \'%s\' "$1" | shasum -a 256 | awk \'{print $1}\')',
    'fi',
    'if [ "$digest" = "$M6_WEB_OPEN_EXPECT_SHA256" ]; then',
    '  printf \'MATCH\\n\' > "$M6_WEB_OPEN_LOG"',
    '  exit 0',
    'fi',
    'printf \'MISMATCH\\n\' > "$M6_WEB_OPEN_LOG"',
    'exit 1',
    '',
  ].join('\n'), { mode: 0o755 })
  chmodSync(script, 0o755)
  return {
    bin,
    log,
    env: {
      PATH: `${bin}:${installation.env.PATH ?? ''}`,
      M6_WEB_OPEN_LOG: log,
      M6_WEB_OPEN_EXPECT_SHA256: expectedSha256,
    },
  }
}

/**
 * Drive the real public Web CLI against one isolated installed profile.
 * @param context - the selected split-process case context.
 * @returns the case verdict facts.
 */
export async function runWebCliM6({ installation, dshHome, trace }) {
  const result = {
    status: 'PASS',
    headlessCli: 'PASS',
    hostPidUnchanged: true,
    tokenExchanged: true,
    anonymousPostRefused: true,
    crossSitePostRefused: true,
  }
  let hostStarted = false
  let token
  const outputs = []
  try {
    // ── A. Host absent: web status is a clean refusal and never starts a Host ──
    const before = statusFields(runCli(installation, ['daemon', 'status']))
    assert(before.host === 'stopped', `web-cli: the isolated Profile began with host=${String(before.host)}`)
    const absent = runCli(installation, ['web', 'status'])
    outputs.push(`${absent.stdout}${absent.stderr}`)
    assertExit(absent, 3, 'web status with no Host')
    assert(absent.stdout === '', 'web status with no Host must print nothing on stdout')
    assert(/^dsh-pi-tui web: HOST_NOT_RUNNING: /u.test(absent.stderr ?? ''),
      `web status with no Host did not report HOST_NOT_RUNNING: ${String(absent.stderr)}`)
    assert((absent.stderr ?? '').includes('daemon start'), 'web status with no Host must suggest daemon start')
    const stillStopped = statusFields(runCli(installation, ['daemon', 'status']))
    assert(stillStopped.host === 'stopped', 'web status started a Host')
    assert(recordPaths(dshHome).length === 0, 'web status published an instance record without a Host')
    trace('m6-web-cli-absent', { host: 'stopped', exit: absent.status })

    // ── B. Real Host start; default-off status ────────────────────────────
    const started = runCli(installation, ['daemon', 'start'])
    assertExit(started, 0, 'daemon start')
    hostStarted = true
    const startFields = statusFields(started)
    assert(startFields.host === 'ready', `daemon start did not reach host=ready: ${JSON.stringify(startFields)}`)
    const record = readRecord(dshHome)
    const hostPid = record.hostPid
    const instanceId = record.instanceId
    assert(typeof hostPid === 'number' && hostPid > 0, 'the published Host record has no PID')
    const disabledStatus = runCli(installation, ['web', 'status'])
    outputs.push(`${disabledStatus.stdout}${disabledStatus.stderr}`)
    assertExactLine(disabledStatus, 'web=disabled', 'web status default-off')

    // `web disable` is idempotent on the already-disabled roster.
    assertExactLine(runCli(installation, ['web', 'disable']), 'web=disabled', 'web disable default-off')
    assertExactLine(runCli(installation, ['web', 'status']), 'web=disabled', 'web status after idempotent disable')

    // ── C. URL/open refuse, then enable ──────────────────────────────────
    const disabledUrl = runCli(installation, ['web', 'url'])
    outputs.push(`${disabledUrl.stdout}${disabledUrl.stderr}`)
    assertExit(disabledUrl, 4, 'web url while disabled')
    assert(disabledUrl.stdout === '', 'web url while disabled must print nothing on stdout')
    assert(/^dsh-pi-tui web: WEB_DISABLED: /u.test(disabledUrl.stderr ?? ''), 'web url while disabled did not report WEB_DISABLED')
    const disabledOpen = runCli(installation, ['web', 'open'])
    outputs.push(`${disabledOpen.stdout}${disabledOpen.stderr}`)
    assertExit(disabledOpen, 4, 'web open while disabled')
    assert(disabledOpen.stdout === '', 'web open while disabled must print nothing on stdout')
    assert(/^dsh-pi-tui web: WEB_DISABLED: /u.test(disabledOpen.stderr ?? ''), 'web open while disabled did not report WEB_DISABLED')

    // Unauthenticated GET and a legal POST body must both be refused by the
    // official Connection admission BEFORE the route handler; the legal POST
    // would enable Web if the fence were broken, so the following status is a
    // real business-spy negative.
    const anonymousGet = await fetchStatus(`${record.origin}/api/pi-tui.web-control`)
    assert([401, 403].includes(anonymousGet.status), `anonymous GET was not refused: HTTP ${anonymousGet.status}`)
    await anonymousGet.body?.cancel()
    const anonymousPost = await fetchStatus(`${record.origin}/api/pi-tui.web-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ schema: 1, instanceId, op: 'enable' }),
    })
    assert([401, 403].includes(anonymousPost.status), `anonymous POST was not refused: HTTP ${anonymousPost.status}`)
    await anonymousPost.body?.cancel()
    assertExactLine(runCli(installation, ['web', 'status']), 'web=disabled', 'web status after anonymous POST')

    assertExactLine(runCli(installation, ['web', 'enable']), 'web=enabled', 'web enable')
    assertExactLine(runCli(installation, ['web', 'status']), 'web=enabled', 'web status enabled')
    const afterEnable = statusFields(runCli(installation, ['daemon', 'status']))
    assert(afterEnable.host === 'ready' && afterEnable.pid === String(hostPid) && afterEnable.instance === instanceId.slice(0, 8),
      `Web enable changed the Host identity: ${JSON.stringify(afterEnable)}`)
    trace('m6-web-cli-enabled', { hostPid, instance: instanceId.slice(0, 8), state: 'enabled' })

    // ── D. web url + official token exchange -> real Web shell ───────────
    const urlResult = runCli(installation, ['web', 'url'])
    outputs.push(`${urlResult.stdout}${urlResult.stderr}`)
    assertExit(urlResult, 0, 'web url')
    assert(urlResult.stderr === '', 'web url success must have empty stderr')
    const urlLine = urlResult.stdout ?? ''
    assert(urlLine.endsWith('\n') && !urlLine.slice(0, -1).includes('\n'), 'web url stdout must be exactly one line')
    token = new URL(urlLine.trim()).searchParams.get('token')
    assert(typeof token === 'string' && token !== '', 'web url carried no token')
    assertWebUrl(urlLine.trim(), record)
    const exchange = await fetchStatus(urlLine.trim())
    assert(exchange.status === 303, `the official Web token exchange returned HTTP ${exchange.status}`)
    assert(/\bno-store\b/iu.test(exchange.headers.get('cache-control') ?? ''), 'the Web token exchange is not no-store')
    const browserCookie = setCookiePair(exchange)
    assert(browserCookie !== '', 'the official Web token exchange minted no Cookie')
    const index = await fetchStatus(`${record.origin}/`, { headers: { cookie: browserCookie } })
    const indexBody = await index.text()
    assert(index.status === 200, `the authenticated Web shell returned HTTP ${index.status}`)
    assert(indexBody.includes('__ModuleLoader__'), 'the authenticated Web shell carries no official module bootstrap')
    trace('m6-web-cli-url', { exchange: exchange.status, index: index.status, tokenPresent: true, tokenPersisted: false })

    // A cross-site request carrying a real browser Cookie must still be refused
    // by the official Origin/Sec-Fetch fence and must not toggle Web.
    const crossSite = await fetchStatus(`${record.origin}/api/pi-tui.web-control`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: browserCookie,
        origin: 'http://evil.example',
        'sec-fetch-site': 'cross-site',
      },
      body: JSON.stringify({ schema: 1, instanceId, op: 'disable' }),
    })
    assert([403, 401].includes(crossSite.status), `cross-site POST was not refused: HTTP ${crossSite.status}`)
    await crossSite.body?.cancel()
    assertExactLine(runCli(installation, ['web', 'status']), 'web=enabled', 'web status after cross-site POST')

    // ── E. web open uses the local opener only ───────────────────────────
    // The fake opener compares the URL argument to a digest and records only
    // MATCH/MISMATCH, so the authenticated token never reaches a fixture file.
    const openerName = process.platform === 'darwin' ? 'open' : 'xdg-open'
    const expectedUrlSha256 = createHash('sha256').update(urlLine.trim()).digest('hex')
    const opener = fakeOpener(installation, openerName, expectedUrlSha256)
    const openResult = runCli(installation, ['web', 'open'], opener.env)
    outputs.push(`${openResult.stdout}${openResult.stderr}`)
    assertExactLine(openResult, 'browser=requested', 'web open')
    assert(existsSync(opener.log), 'web open never invoked the local OS opener')
    const openerMarker = readFileSync(opener.log, 'utf8')
    assert(openerMarker === 'MATCH\n', `the local opener received a different URL (marker ${JSON.stringify(openerMarker)})`)
    assert(!openerMarker.includes(token) && !openerMarker.includes('token='), 'the opener fixture persisted the URL token')
    assertExactLine(runCli(installation, ['web', 'status']), 'web=enabled', 'web status after open')

    // ── F. Disable: SPA withdrawn, Host and /connect unchanged ───────────
    assertExactLine(runCli(installation, ['web', 'disable']), 'web=disabled', 'web disable')
    const afterDisable = statusFields(runCli(installation, ['daemon', 'status']))
    assert(afterDisable.host === 'ready' && afterDisable.pid === String(hostPid) && afterDisable.instance === instanceId.slice(0, 8),
      `Web disable changed the Host identity: ${JSON.stringify(afterDisable)}`)
    const afterDisableRoot = await fetchStatus(`${record.origin}/`)
    assert(afterDisableRoot.status === 404, `the SPA root still answers after disable: HTTP ${afterDisableRoot.status}`)
    await afterDisableRoot.body?.cancel()
    // `/connect` remains the authenticated Host surface.
    const launch = readLaunch(dshHome, instanceId)
    const connectUrl = new URL(launch.connectUrl)
    connectUrl.searchParams.set('interactions', 'answer')
    const connect = await fetchStatus(connectUrl)
    assert(connect.status === 302, `the official /connect surface stopped after Web disable: HTTP ${connect.status}`)
    await connect.body?.cancel()
    assertExactLine(runCli(installation, ['web', 'status']), 'web=disabled', 'web status after disable')

    // The token never leaks outside the one explicit `web url` stdout.
    const quiet = outputs.filter(output => !output.includes(urlLine.trim()))
    for (const output of quiet) {
      assert(!output.includes(token), 'the Web URL token leaked into another CLI output')
      assert(!output.includes('token='), 'a token parameter leaked into a non-URL CLI output')
    }
    const logs = runCli(installation, ['daemon', 'logs', '--lines', '200'])
    assert(!`${logs.stdout}${logs.stderr}`.includes(token), 'the Web URL token leaked into daemon logs')
    trace('m6-web-cli-disabled', { state: 'disabled', hostPid, instance: instanceId.slice(0, 8), spa: afterDisableRoot.status, connect: connect.status, tokenLeaked: false })

    // ── G. Stop the Host, then the same clean refusal returns ────────────
    const stopped = runCli(installation, ['daemon', 'stop'])
    assertExit(stopped, 0, 'daemon stop')
    hostStarted = false
    const afterStop = runCli(installation, ['web', 'status'])
    assertExit(afterStop, 3, 'web status after Host stop')
    assert(afterStop.stdout === '', 'web status after Host stop must print nothing on stdout')
    assert(/^dsh-pi-tui web: HOST_NOT_RUNNING: /u.test(afterStop.stderr ?? ''), 'web status after Host stop did not report HOST_NOT_RUNNING')
  } catch (error) {
    result.status = 'FAILED'
    result.headlessCli = 'FAILED'
    throw error
  } finally {
    if (hostStarted) {
      try { runCli(installation, ['daemon', 'stop']) } catch { /* global cleanup owns the isolated home */ }
    }
  }
  return result
}
