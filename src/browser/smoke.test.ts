/**
 * The smoke tier, proved two ways.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A SUITE THAT ONLY RUNS WHERE AN ESTATE EXISTS IS A SUITE CI NEVER RUNS.**
 *
 * That is the trap this file is built around. There is no estate in GitHub Actions, so the
 * browser-driven half can only skip there — and a skipping check is exactly the shape of the
 * defect this whole tier was written to end. So the file has two halves and they carry different
 * weight:
 *
 *   1. **The half that always runs, everywhere, including CI.** Every assertion in `smoke.ts` is a
 *      pure function of a `PageObservation`, and the fixtures below are TRANSCRIPTIONS OF WHAT THE
 *      REAL ESTATE ACTUALLY RETURNED on 2026-08-04 — the Worlds registry's `ERR_FAILED` on
 *      `worlds-api.<apex>/v1/titles`, Foresight's blank body and uncaught TypeError, Trade's
 *      transparent background, Tessera's 401. Each one is asserted to be RED. If somebody weakens
 *      a check to make the estate go green, these go red instead, in CI, with no estate anywhere.
 *   2. **The half that drives Chromium**, which runs wherever an estate answers and skips with an
 *      address in the reason where none does.
 *
 * And one structural check that is the whole point of the tier existing: **this repository's
 * browser code contains no request interception at all**. `page.route`, `route.fulfill`,
 * `setOfflineMode` and `route.abort` are the four ways a Playwright suite can start answering its
 * own requests, and the day one appears here, this tier has become the thing it replaced.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  SMOKE_SURFACES,
  UNPAINTED_BACKGROUND,
  checkSurface,
  estateReachable,
  mark,
  runSmoke,
  since,
  smokeHosts,
  surfaceUrl,
  type Credentials,
  type PageObservation,
  type SmokeSurface,
} from './smoke.ts'
import { collectPins, pinPolicy, type CertificateFacts } from './estatecert.ts'
import { browserAvailable, launchArgs, newSink, type BrowserConfig } from './driver.ts'

const HANDLE = 'estateadmin'

const CREDENTIALS: Credentials = {
  // Defaults, not secrets: this account exists only in a dev estate, and `deploy`'s own
  // `estate-bootstrap.sh` creates it with this password. Overridable so the same suite can be
  // pointed at an environment where the credential is a real one held in the runner.
  identifier: process.env['BEACON_SMOKE_IDENTIFIER'] ?? 'estate-admin@example.test',
  password: process.env['BEACON_SMOKE_PASSWORD'] ?? 'correct-horse-battery-staple-42',
  handle: process.env['BEACON_SMOKE_HANDLE'] ?? HANDLE,
}

/**
 * The apex, defaulted rather than required.
 *
 * A required variable would mean the suite runs nowhere by default, which is how a check becomes
 * ceremonial. Defaulted to the dev estate's apex, it runs on every developer machine that has one
 * up, and skips — with the address in the reason — everywhere else.
 */
const APEX = process.env['BEACON_SMOKE_APEX'] ?? 'cloudsforge.localtest.me'

/* ================================================================== the half that always runs */

/**
 * A green page. Every field is what a working surface produced, so that flipping ONE of them is
 * a controlled experiment: the finding that appears is caused by the field that changed.
 *
 * Transcribed from `market.cloudsforge.localtest.me/` on 2026-08-04, which is genuinely healthy:
 * it renders an EMPTY state ("The market answered, and there are no live listings"), and empty is
 * not failed. That distinction is the design system's own (`<each frontend>/src/components/states.tsx`) and this
 * fixture is the proof that the suite honours it rather than matching on the word "no".
 */
function healthy(overrides: Partial<PageObservation> = {}): PageObservation {
  return {
    surfaceKey: 'market',
    url: 'https://market.cloudsforge.localtest.me/',
    status: 200,
    navigationError: null,
    bodyText:
      'Skip to the listings CloudsForge Forge Market Sign in Forge Market Browse Collections Sell ' +
      'Orders Fees Browse the market Every price is shown in the asset it settles in. Filter these ' +
      'listings ◇ Nothing is listed here right now The market answered, and there are no live listings.',
    backgroundColor: 'rgb(14, 12, 10)',
    fontFamily: 'Inter, system-ui, ui-sans-serif',
    failureStates: [],
    collected: newSink(),
    ...overrides,
  }
}

function surface(key: string): SmokeSurface {
  const found = SMOKE_SURFACES.find((s) => s.key === key)
  assert.ok(found, `${key} is not in SMOKE_SURFACES`)
  return found
}

test('a healthy surface produces no finding at all', () => {
  assert.deepEqual(checkSurface(healthy(), surface('market'), HANDLE), [])
})

test('an EMPTY state is not a failure — the market answered with nothing, and that is fine', () => {
  // Guarding the exact confusion `states.tsx` was written to prevent. "Nothing is listed here
  // right now" is in the fixture's body text; a suite matching on prose would call this red.
  const findings = checkSurface(healthy(), surface('market'), HANDLE)
  assert.equal(findings.length, 0)
})

test('THE WORLDS REGISTRY DEFECT IS RED: the frontend calls a host the gateway does not route', () => {
  // Verbatim from Chromium against the running estate. `worlds-web` asks
  // `worlds-api.<apex>/v1/titles`; that hostname has no router, so the preflight is refused and
  // the fetch fails. The page still answers 200 and still renders 900 characters of copy, which
  // is precisely why nothing else caught it.
  const observation = healthy({
    surfaceKey: 'worlds',
    url: 'https://worlds.cloudsforge.localtest.me/',
    bodyText:
      'Skip to the page CloudsForge Forge Worlds Sign in The platform FORGE WORLDS The platform ' +
      'games run on Forge Worlds is not a game. The title registry Which titles exist. ' +
      'The registry did not load',
    failureStates: ['■ The registry did not load Failed to fetch Quote this to support: 8m2 Try again'],
    collected: {
      consoleErrors: [
        "Access to fetch at 'https://worlds-api.cloudsforge.localtest.me/v1/titles' from origin " +
          "'https://worlds.cloudsforge.localtest.me' has been blocked by CORS policy",
      ],
      pageErrors: [],
      failedRequests: [
        {
          url: 'https://worlds-api.cloudsforge.localtest.me/v1/titles',
          method: 'GET',
          failure: 'net::ERR_FAILED',
        },
      ],
      observabilityFailures: [],
    requests: [],
    },
  })
  const checks = checkSurface(observation, surface('worlds'), HANDLE).map((f) => f.check)
  assert.ok(checks.includes('no error state on screen'), 'the design system said it failed')
  assert.ok(checks.includes('nothing failed on the wire'), 'a request failed and was not counted')
  assert.ok(checks.includes('no console error'), 'the CORS refusal was on the console')
})

test('THE FORESIGHT DEFECT IS RED: a page that renders nothing at all', () => {
  const observation = healthy({
    surfaceKey: 'foresight',
    url: 'https://foresight.cloudsforge.localtest.me/',
    bodyText: '',
    failureStates: [],
    collected: {
      consoleErrors: [],
      pageErrors: ["Cannot read properties of undefined (reading 'markets')"],
      failedRequests: [],
      observabilityFailures: [],
    requests: [],
    },
  })
  const checks = checkSurface(observation, surface('foresight'), HANDLE).map((f) => f.check)
  assert.ok(checks.includes('the application mounted'), 'a blank body must fail')
  assert.ok(checks.includes('nothing failed on the wire'), 'the uncaught TypeError must fail')
  assert.ok(checks.includes('the surface renders its own words'))
})

test('THE UNSTYLED-TRADE DEFECT IS RED: the document answered 200 and nothing painted it', () => {
  // The one a human spots instantly and no HTTP check ever will. Every other assertion passes on
  // this page: 200, mounted, no failed request, its own words on screen.
  const observation = healthy({
    surfaceKey: 'trade',
    url: 'https://trade.cloudsforge.localtest.me/',
    bodyText: 'Skip to the page CloudsForge Forge Trade Sign in Strategies Backtests Bots Strategies',
    backgroundColor: UNPAINTED_BACKGROUND,
    fontFamily: 'Times',
  })
  const findings = checkSurface(observation, surface('trade'), HANDLE)
  assert.deepEqual(
    findings.map((f) => f.check),
    ['the page is painted'],
    'the ONLY thing wrong with this page is that it is not painted, and it must still be red',
  )
})

test('THE TESSERA DEFECT IS RED: a 401 the page turned into an error state', () => {
  const observation = healthy({
    surfaceKey: 'tessera',
    url: 'https://tessera.cloudsforge.localtest.me/',
    bodyText:
      'Skip to the page CloudsForge Forge Worlds Sign in World Wards Land Kiln Discover Workshop ' +
      '■ That did not load a valid bearer token is required Try again',
    failureStates: ['■ That did not load a valid bearer token is required'],
    collected: {
      consoleErrors: ['Failed to load resource: the server responded with a status of 401 ()'],
      pageErrors: [],
      failedRequests: [
        { url: 'https://tessera.cloudsforge.localtest.me/v1/wards', method: 'GET', failure: 'HTTP 401' },
      ],
      observabilityFailures: [],
    requests: [],
    },
  })
  const checks = checkSurface(observation, surface('tessera'), HANDLE).map((f) => f.check)
  assert.ok(checks.includes('no error state on screen'))
  assert.ok(checks.includes('nothing failed on the wire'))
})

test('a surface serving the WRONG bundle is red even when everything about it is healthy', () => {
  // The failure a per-surface HTTP probe cannot see: a gateway that routes every hostname to
  // whichever bundle answers first. Sixteen 200s, sixteen mounted pages, one product.
  const observation = healthy({ surfaceKey: 'worlds', url: 'https://worlds.cloudsforge.localtest.me/' })
  const findings = checkSurface(observation, surface('worlds'), HANDLE)
  assert.ok(
    findings.every((f) => f.check === 'the surface renders its own words'),
    `expected only identity findings, got ${JSON.stringify(findings)}`,
  )
  assert.equal(findings.length, 2, 'both of the worlds patterns must be reported, not just the first')
})

test('a signed-in surface that does not know the account is red', () => {
  const observation = healthy({
    surfaceKey: 'hub',
    url: 'https://hub.cloudsforge.localtest.me/',
    bodyText: 'CloudsForge Products Sign in Sign in to CloudsForge Email or handle Password Portfolio Activity',
  })
  const findings = checkSurface(observation, surface('hub'), HANDLE).map((f) => f.check)
  assert.ok(findings.includes('the session reached this surface'))
})

test('a navigation that threw is reported against its own surface, not as a crash', () => {
  const observation = healthy({
    surfaceKey: 'status',
    url: 'https://status.cloudsforge.localtest.me/',
    status: null,
    navigationError: 'page.goto: net::ERR_CERT_AUTHORITY_INVALID',
    bodyText: '',
    backgroundColor: '',
  })
  const checks = checkSurface(observation, surface('status'), HANDLE).map((f) => f.check)
  assert.ok(checks.includes('the document answers'))
  assert.ok(checks.includes('the application mounted'), 'a surface that never loaded also never mounted')
})

test('every finding for a page is reported, never just the first', () => {
  const observation = healthy({
    surfaceKey: 'foresight',
    status: 500,
    bodyText: '',
    backgroundColor: UNPAINTED_BACKGROUND,
    failureStates: ['■ That did not load'],
    collected: {
      consoleErrors: ['boom'],
      pageErrors: ['boom'],
      failedRequests: [],
      observabilityFailures: [],
    requests: [],
    },
  })
  const checks = new Set(checkSurface(observation, surface('foresight'), HANDLE).map((f) => f.check))
  // Six distinct classes of defect on one page. Reporting one at a time turns one afternoon into
  // six.
  assert.ok(checks.size >= 5, `expected at least five distinct checks, got ${[...checks].join(', ')}`)
})

/* ------------------------------------------------------------------ the sink is sliced per page */

test('one surface never inherits the previous surface’s failures', () => {
  const sink = newSink()
  sink.consoleErrors.push('from the first page')
  const at = mark(sink)
  sink.consoleErrors.push('from the second page')
  const slice = since(sink, at)
  assert.deepEqual(slice.consoleErrors, ['from the second page'])
})

test('the browser telemetry sink is partitioned, so a broken reporter is not a broken page', () => {
  // `driver.ts` puts `/ingest/client` failures in their own array precisely so a page is not
  // called broken because the thing REPORTING breakage broke. Asserted here because this tier
  // treats a failed request as fatal, and without the partition every surface would be red for a
  // reason that belongs to micro-lantern.
  const observation = healthy({
    collected: {
      consoleErrors: [],
      pageErrors: [],
      failedRequests: [],
      observabilityFailures: [
        { url: 'https://lantern.cloudsforge.localtest.me/ingest/client', method: 'POST', failure: 'net::ERR_FAILED' },
      ],
      requests: [],
    },
  })
  assert.deepEqual(checkSurface(observation, surface('market'), HANDLE), [])
})

/* ------------------------------------------------------------------ the manifest */

test('the manifest covers the sixteen surfaces the estate serves, each exactly once', () => {
  assert.equal(SMOKE_SURFACES.length, 16)
  const keys = SMOKE_SURFACES.map((s) => s.key)
  assert.equal(new Set(keys).size, keys.length, 'a surface is listed twice')
  const hosts = smokeHosts('example.test')
  assert.equal(new Set(hosts).size, hosts.length, 'two surfaces resolve to one hostname')
})

test('the apex surface is the apex, not a subdomain of it', () => {
  assert.equal(surfaceUrl('example.test', surface('site')), 'https://example.test/')
  assert.equal(surfaceUrl('example.test', surface('hub')), 'https://hub.example.test/')
})

test('every surface names at least one word only its own bundle produces', () => {
  for (const s of SMOKE_SURFACES) {
    assert.ok(s.renders.length > 0, `${s.key} asserts nothing about what it renders`)
  }
})

/* ------------------------------------------------------------------ the certificate */

/**
 * The certificate the estate's gateway really serves, read off it on 2026-08-04.
 *
 * A leaf for `*.cloudsforge.localtest.me` issued by `CN=CloudsForge Estate Local CA`, a root that
 * exists on one machine and in no trust store — so Node's verdict is
 * `UNABLE_TO_VERIFY_LEAF_SIGNATURE` and Chromium's is `ERR_CERT_AUTHORITY_INVALID`.
 */
function cert(overrides: Partial<CertificateFacts> = {}): CertificateFacts {
  return {
    host: 'hub.cloudsforge.localtest.me',
    spkiSha256: '22mImMShg3xVbRjEGYZIW4jTvoPx3dJe2aQFWlYyGa0=',
    subject: 'CN=cloudsforge.localtest.me',
    issuer: 'CN=CloudsForge Estate Local CA O=CloudsForge (development only)',
    trusted: false,
    verifyError: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    hostMatched: '*.cloudsforge.localtest.me',
    notBefore: Date.parse('2026-08-03T18:49:41Z'),
    notAfter: Date.parse('2027-08-03T18:49:41Z'),
    ...overrides,
  }
}

test('the dev gateway’s locally-issued certificate is pinned, and only its leaf key', () => {
  const decision = pinPolicy(cert(), Date.parse('2026-08-04T00:00:00Z'))
  assert.equal(decision.pin, true)
  // The LEAF, not the issuing CA. Driven against the estate: the leaf's SPKI loads the page and
  // the CA's produces ERR_CERT_AUTHORITY_INVALID, so pinning the issuer would have looked correct
  // and excused nothing.
  assert.equal(decision.pin && decision.spkiSha256, '22mImMShg3xVbRjEGYZIW4jTvoPx3dJe2aQFWlYyGa0=')
})

test('AN EXPIRED CERTIFICATE IS NEVER PINNED — that is an outage, not an inconvenience', () => {
  // The check `ignoreHTTPSErrors: true` deletes, and the reason this module exists. The SPKI list
  // excuses ALL errors for a listed key, expiry included, so if this branch were missing the one
  // host that matters most would be permanently blind to its own certificate expiring.
  const decision = pinPolicy(cert(), Date.parse('2028-01-01T00:00:00Z'))
  assert.equal(decision.pin, false)
  assert.match(decision.why, /expired/)
})

test('a certificate that is not yet valid is never pinned either', () => {
  const decision = pinPolicy(cert(), Date.parse('2026-01-01T00:00:00Z'))
  assert.equal(decision.pin, false)
  assert.match(decision.why, /not valid until/)
})

test('A CERTIFICATE FOR ANOTHER HOSTNAME IS NEVER PINNED — that is being sent somewhere else', () => {
  const decision = pinPolicy(
    cert({ hostMatched: null, subject: 'CN=someone-else.example' }),
    Date.parse('2026-08-04T00:00:00Z'),
  )
  assert.equal(decision.pin, false)
  assert.match(decision.why, /does not cover this hostname/)
})

test('a verification failure that is NOT a private root is never pinned', () => {
  // The allowlist doing its job. Revocation, a bad signature and a broken chain are not laptop
  // inconveniences, and a denylist here would have excused every code nobody thought of.
  for (const code of ['CERT_REVOKED', 'CERT_SIGNATURE_FAILURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    const decision = pinPolicy(cert({ verifyError: code }), Date.parse('2026-08-04T00:00:00Z'))
    assert.equal(decision.pin, false, `${code} was pinned`)
    assert.match(decision.why, /not a private root/)
  }
})

test('A PUBLICLY TRUSTED CERTIFICATE IS NEVER PINNED — the browser must validate it normally', () => {
  // Pointing this suite at staging must not carry the laptop's exemption with it. Nothing is
  // excused there, so a certificate that later expires or is mis-issued is still a red.
  const decision = pinPolicy(
    cert({ trusted: true, verifyError: '', issuer: "CN=R3, O=Let's Encrypt" }),
    Date.parse('2026-08-04T00:00:00Z'),
  )
  assert.equal(decision.pin, false)
  assert.match(decision.why, /nothing needs excusing/)
})

test('an empty pin set produces NO flag, rather than an empty one', () => {
  const base: BrowserConfig = { enabled: true, executablePath: '', timeoutMs: 1_000 }
  assert.ok(!launchArgs(base).some((a) => a.startsWith('--ignore-certificate-errors')))
  const pinned = launchArgs({ ...base, certificatePins: ['aaa=', 'bbb='] })
  assert.ok(pinned.includes('--ignore-certificate-errors-spki-list=aaa=,bbb='))
})

test('a host that will not speak TLS is a reason, not a thrown setup error', async () => {
  // Port 1 on the loopback: nothing listens, and the other fifteen surfaces must still be
  // checkable. A collector that threw here would report "the estate is down" for one bad host.
  const pins = await collectPins(['hub.cloudsforge.localtest.me'], { port: 1, connectTo: '127.0.0.1' })
  assert.deepEqual(pins.spki, [])
  assert.equal(pins.reasons.length, 1)
  assert.match(pins.reasons[0] ?? '', /no certificate to inspect/)
})

/* ================================================ the property this whole tier exists to have */

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * The four ways a Playwright suite starts answering its own requests.
 *
 * `page.route` with a `route.fulfill` is the estate's signature defect and the reason this tier
 * was commissioned. The other three are the same mistake by other means: `route.abort` fakes a
 * failure, and `setOfflineMode` fakes the whole network.
 */
const INTERCEPTION = [/\.route\s*\(/, /\.fulfill\s*\(/, /setOfflineMode/, /\.abort\s*\(/]

/**
 * Offending lines in one source file.
 *
 * Prose is excluded. Every file in this directory DISCUSSES the interception it refuses, quoting
 * the exact call, and a check that cannot tell code from a sentence about code is a check people
 * learn to route around rather than obey. That exclusion is also the reason the next test exists:
 * a scanner that skips comments could skip everything, so it is proved against a planted call
 * before it is trusted against a clean tree.
 */
export function scanForInterception(source: string, file: string): readonly string[] {
  const offences: string[] = []
  source.split('\n').forEach((line, index) => {
    const code = line.replace(/^\s*(\*|\/\/).*$/, '')
    if (INTERCEPTION.some((pattern) => pattern.test(code))) {
      offences.push(`${file}:${index + 1}: ${line.trim()}`)
    }
  })
  return offences
}

test('the interception scanner CAN fail — proved against the exact line that caused all of this', () => {
  const planted = [
    'async function journey(page) {',
    "  await page.route('**/*', async (route) => {",
    '    await route.fulfill({ status: 200, body: JSON.stringify(FIXTURE) })',
    '  })',
    '}',
  ].join('\n')
  const offences = scanForInterception(planted, 'planted.ts')
  assert.equal(offences.length, 2, `expected the route and the fulfill, got ${JSON.stringify(offences)}`)
  // And the comment exclusion does not swallow a real call sitting after code on the same line.
  assert.deepEqual(scanForInterception('  // await page.route("x")', 'c.ts'), [])
})

test('THIS TIER INTERCEPTS NOTHING — no route, no fulfill, no offline mode, anywhere in src/browser', async () => {
  const files = (await readdir(HERE))
    .filter((f) => f.endsWith('.ts'))
    // The one exclusion, and it is the file you are reading: it must spell the four forbidden
    // calls out in order to look for them, so scanning itself would be a permanent false red.
    // Everything it asserts about the other files is asserted about it by the test above, which
    // plants a real interception and requires the scanner to find it.
    .filter((f) => f !== 'smoke.test.ts')
  assert.ok(files.length >= 6, 'the browser directory got smaller; this check is reading the wrong place')
  const offences: string[] = []
  for (const file of files) {
    offences.push(...scanForInterception(await readFile(join(HERE, file), 'utf8'), file))
  }
  assert.deepEqual(
    offences,
    [],
    'a request interception appeared in the browser tier. This suite exists BECAUSE every frontend ' +
      'stubbed its own network and could not see that the API was unreachable:\n' + offences.join('\n'),
  )
})

/* ================================================================== the half that drives a browser */

const CONFIG: BrowserConfig = {
  enabled: true,
  executablePath: process.env['BEACON_BROWSER_EXECUTABLE'] ?? '',
  timeoutMs: Number(process.env['BEACON_SMOKE_TIMEOUT_MS'] ?? '20000'),
}

const reachable = await estateReachable(APEX)
const chromium = await browserAvailable(CONFIG)

/**
 * One `node:test` case, so the skip has a reason and the failure has every surface in it.
 *
 * Not sixteen cases. `node:test` builds its tree synchronously, and a per-surface case would mean
 * either launching Chromium sixteen times — which discards the session that half the assertions
 * turn on — or driving the browser during tree construction, which is worse. One case, and the
 * message names every surface that failed and why.
 */
test('THE ESTATE, IN A REAL BROWSER, THROUGH THE REAL GATEWAY, WITH NOTHING STUBBED', async (t) => {
  if (!reachable.ok) {
    t.skip(reachable.reason)
    return
  }
  if (!chromium.ok) {
    t.skip(`${chromium.reason} — the estate is up and nothing is looking at it`)
    return
  }

  const pins = await collectPins(smokeHosts(APEX))
  for (const reason of pins.reasons) t.diagnostic(`tls: ${reason}`)

  const result = await runSmoke({
    apex: APEX,
    credentials: CREDENTIALS,
    browser: { ...CONFIG, certificatePins: pins.spki },
  })

  for (const observation of result.observations) {
    t.diagnostic(
      `${observation.surfaceKey.padEnd(16)} HTTP ${String(observation.status ?? 'ERR').padEnd(4)} ` +
        `${observation.bodyText.trim().length} chars  ${observation.url}`,
    )
  }

  const report = result.findings
    .map((f) => `  [${f.surfaceKey}] ${f.check}\n      ${f.detail}`)
    .join('\n')
  assert.deepEqual(
    result.findings,
    [],
    `${result.findings.length} finding(s) against ${APEX}. Every one of these is a thing a person ` +
      `opening a browser would see, and nothing in the estate was looking:\n${report}\n`,
  )
})
