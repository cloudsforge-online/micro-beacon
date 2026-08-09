/**
 * The declaration, and the proof that it declares nothing today for the right reason.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **"NO BROWSER JOURNEYS" AND "THE BROWSER TIER IS NOT BUILT" LOOK IDENTICAL FROM OUTSIDE.**
 *
 * This file is the difference. The harness exists, the catalogue exists, one scenario is
 * implemented, and the registry is empty — because `deploy/compose/docker-compose.estate.yml`
 * serves no frontend container, so no surface has an address (doc 22 §8.7). The cases below assert
 * exactly that chain: empty when nothing is addressable, non-empty the moment something is, and
 * `undeclared()` naming what is missing rather than reporting a zero.
 *
 * `surfaceJourney` itself is exercised against a real server: a bundle that 404s must make the
 * journey report `fail` at "the application boots", which is the whole reason a browser is in this
 * repository. It skips when no Chromium is present, and `driver.test.ts` proves the same property
 * as pure functions in every run.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import { checkPassword } from '@cloudsforge/contracts-auth'
import { T3_SCENARIOS } from './catalogue.ts'
import { browserAvailable, type BrowserConfig } from './driver.ts'
import { syntheticPassword } from './fixtures.ts'
import {
  IMPLEMENTED_IDS,
  SURFACE_KEYS,
  browserJourneys,
  join,
  surfaceJourney,
  undeclared,
  unimplemented,
} from './journeys.ts'
import { runJourney } from '../journeys.ts'
import { GROUPS } from '../groups.ts'

const CONFIG: BrowserConfig = {
  enabled: true,
  executablePath: process.env['BEACON_BROWSER_EXECUTABLE'] ?? '',
  timeoutMs: 15_000,
}
const OFF: BrowserConfig = { enabled: false, executablePath: '', timeoutMs: 5_000 }

/* ------------------------------------------------------------------ the declaration */

test('NOTHING is declared when no surface has an address', () => {
  const declared = browserJourneys({ config: CONFIG, targets: new Set(['identity', 'market', 'ledger']) })
  assert.deepEqual(declared, [], 'a service address is not a surface address')
})

test('the undeclared list names the missing addresses rather than reporting a count', () => {
  const reasons = undeclared({ config: CONFIG, targets: new Set<string>() })
  assert.ok(reasons.length > 0)
  // "0 browser journeys" reads as an oversight. "BJ-XS-10: no address for site, hub, …" reads as
  // the one deploy change that turns it on.
  assert.ok(reasons.some((r) => r.startsWith('BJ-XS-10: no address for')))
  assert.ok(reasons.some((r) => r.includes('no implementation yet')))
})

test('a scenario declares itself the moment every surface it needs is addressable', () => {
  const scenario = T3_SCENARIOS.find((s) => s.id === 'BJ-XS-10')
  assert.ok(scenario)
  const declared = browserJourneys({ config: CONFIG, targets: new Set(scenario.needs) })
  assert.equal(declared.length, 1)
  // A gate scenario is a CRITICAL journey. Doc 22 marks BJ-XS-10 with a star, and a starred
  // scenario that declared itself non-critical would be a release criterion the gate ignores.
  assert.equal(declared[0]?.critical, true)
  assert.equal(declared[0]?.name, 'browser.bj-xs-10')
  // Its own deadline, not the global one: launching Chromium and waiting for a SPA to mount is
  // not comparable to a JSON round trip.
  assert.equal(declared[0]?.deadlineMs, 120_000)
})

test('one missing surface is enough to withhold a scenario', () => {
  const scenario = T3_SCENARIOS.find((s) => s.id === 'BJ-XS-10')
  const partial = new Set((scenario?.needs ?? []).slice(1))
  assert.deepEqual(browserJourneys({ config: CONFIG, targets: partial }), [])
})

test('a blocked scenario is never declared, whatever addresses exist', () => {
  // The check that would otherwise cannot-fail: point every name in the catalogue at an address
  // and the blocked scenarios must still be absent, because the blocker is a missing FEATURE.
  const everything = new Set(T3_SCENARIOS.flatMap((s) => s.needs))
  const declared = browserJourneys({ config: CONFIG, targets: everything }).map((j) => j.name)
  for (const scenario of T3_SCENARIOS) {
    if (scenario.blocked === null) continue
    assert.ok(
      !declared.includes(`browser.${scenario.id.toLowerCase()}`),
      `${scenario.id} is blocked (${scenario.blocked.doc}) and was declared anyway`,
    )
  }
})

test('every implemented id is a real, unblocked catalogue scenario', () => {
  for (const id of IMPLEMENTED_IDS) {
    const scenario = T3_SCENARIOS.find((s) => s.id === id)
    assert.ok(scenario, `${id} is implemented and is not in the catalogue`)
    assert.equal(scenario?.blocked, null, `${id} is implemented and marked blocked`)
  }
})

test('the unimplemented gap is stated rather than silent', () => {
  const missing = unimplemented().map((s) => s.id)
  // Fifty-two, not five: three blockers were removed after being disproved in a browser, which
  // moved forty-four scenarios from "cannot be written" to "not written yet". That is a bigger
  // stated gap and a smaller real one, and both halves are the point.
  //
  // Pinned by SHAPE rather than by full list. The whole list would be a fifty-two-line literal
  // that nobody re-reads, and the property worth guarding is not its contents: it is that
  // implemented and unimplemented partition the unblocked set exactly, with no scenario in both
  // and none in neither.
  const unblockedIds = T3_SCENARIOS.filter((s) => s.blocked === null).map((s) => s.id)
  assert.equal(missing.length + IMPLEMENTED_IDS.length, unblockedIds.length)
  for (const id of IMPLEMENTED_IDS) {
    assert.ok(!missing.includes(id), `${id} is implemented AND reported as a gap`)
  }
  for (const id of unblockedIds) {
    assert.ok(
      missing.includes(id) || IMPLEMENTED_IDS.includes(id),
      `${id} is unblocked and is in neither the implemented set nor the stated gap`,
    )
  }
  // The four scenarios closest to being written are named, because a shape check alone would pass
  // against a file that had quietly lost one.
  for (const id of ['BJ-NET-09', 'BJ-NET-14', 'BJ-XS-01', 'BJ-DSH-20']) {
    assert.ok(missing.includes(id), `${id} should still be a stated gap`)
  }
})

test('EVERY IMPLEMENTED SCENARIO IS ONE THAT WAS DRIVEN', () => {
  // Every one of these was run in Chromium against the estate before it was added. A scenario in
  // this list that has never been driven is the thing the whole file argues against: a declared
  // journey that has not demonstrated it can be green — or, for the two below that are RED on this
  // estate, that it goes red for a reason in the product rather than in itself.
  //
  // ── BJ-FOR-01 AND BJ-FOR-06 ARE DECLARED AND FAILING, ON PURPOSE ──────────────────────────────
  // Both open a market at its own address, and on this estate that address is broken: the gateway
  // splits `foresight.<apex>/markets/:id` between the bundle and the API on `Accept:
  // application/json`, and the HTML carries no `Vary: Accept`, so the browser's HTTP cache answers
  // the bundle's own JSON fetch with the page it just navigated to. Isolated in Chromium — see the
  // header of `marketPageOrder`. Beacon's rule 1 is that an assertion failure means the PRODUCT is
  // broken; it is, and withdrawing the journey until somebody fixes it is how a gap becomes
  // invisible.
  assert.deepEqual([...IMPLEMENTED_IDS].sort(), [
    'BJ-ACC-01',
    'BJ-ACC-02',
    'BJ-ACC-03',
    'BJ-DSH-01',
    'BJ-DSH-17',
    'BJ-FOR-01',
    'BJ-FOR-06',
    'BJ-FOR-13',
    'BJ-FOR-14',
    'BJ-FOR-17',
    // ── BJ-MED-01/02/03 ARE IMPLEMENTED AND HAVE **NOT** BEEN DRIVEN. SAYING SO IS THE POINT. ──
    //
    // Every other id in this list was run in Chromium against the estate before it was added.
    // These three have not been, and the reason is not that nobody tried: they cannot be run at
    // all on this estate, because `micro-studio` HAS NO GATEWAY ROUTER. It is a container on the
    // compose network with no `Host()` rule anywhere in `deploy/gateway/dynamic/estate-web.yml`,
    // so there is no address a browser can reach it at, and `BEACON_TARGETS` has no `studio` entry
    // to resolve. `undeclared()` reports them as `no address for studio` for exactly this reason.
    //
    // They are recorded here rather than quietly omitted, and they are not marked `blocked`,
    // because both alternatives would misreport the state. `blocked` means "cannot be written as
    // code at all"; these ARE written, and the code is the part that is finished. Omitting them
    // would make a shipped feature look untested rather than untestable-here. The gap is one
    // router and one target, both named in the report that accompanied this change.
    //
    // This note comes out — and these three move up into the driven set above — the first time
    // they are run green against an estate that routes studio. If that never happens, this comment
    // is the record that a browser test was written for a path no browser can reach, which is a
    // finding rather than a formality.
    'BJ-MED-01',
    'BJ-MED-02',
    'BJ-MED-03',
    'BJ-WAL-01',
    'BJ-WAL-08',
    'BJ-WAL-09',
    'BJ-XS-04',
    'BJ-XS-10',
  ])
})

test('join() does not produce //register or accountregister', () => {
  // `account` resolves to `hub.<apex>/account` - a path under another surface - so this is
  // load-bearing rather than tidiness. One of the two wrong answers is a 404 that reads as a
  // missing route.
  assert.equal(join('https://hub.test/account', 'register'), 'https://hub.test/account/register')
  assert.equal(join('https://hub.test/account/', '/register'), 'https://hub.test/account/register')
  assert.equal(join('https://hub.test', ''), 'https://hub.test')
})

test('the surface keys are keys only — no hostname, port or apex leaks into this repository', () => {
  for (const key of SURFACE_KEYS) {
    assert.match(key, /^[a-z][a-z0-9-]*$/, `"${key}" looks like an address, not a key`)
    assert.ok(!key.includes('.'), `"${key}" contains a dot`)
  }
  // The registry in `ui/packages/ui/src/surfaces.ts` records that the same list of hostnames was
  // maintained by hand in eight places and had already drifted. A ninth copy here would be that
  // mistake made in the repository whose job is to notice drift.
  assert.ok(SURFACE_KEYS.includes('account'), 'the sign-in surface must be nameable in order to be missing')
})

/* ------------------------------------------------------------------ the synthetic credential */

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ACCOUNTS THIS TIER REGISTERS ARE REAL, PERMANENT, AND MUST NOT SHARE A PASSWORD.**
 *
 * Every browser journey registers against the real identity service, and identity has no deletion
 * route a monitor may call — so thousands of accounts beacon created are still rows on mainnet and
 * testnet. Until 2026-08-09 all of them carried one constant that was committed to a PUBLIC
 * repository (micro-org#276), which made every one of them signable-into by anybody who read it.
 *
 * Two properties, and the second is the one a future edit is most likely to break: unpredictable,
 * and ACCEPTED BY IDENTITY. A generator that satisfied the first and not the second would fail
 * every journey at its own fixture, which reports as the estate being down.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('the synthetic password is different every time it is asked for', () => {
  const seen = new Set(Array.from({ length: 200 }, () => syntheticPassword()))
  assert.equal(seen.size, 200, 'two runs got the same password — it is derived from something')
  // Not a strength score; a floor. base64url over 24 bytes is 32 characters, and anything much
  // shorter than that arriving here means the generator was swapped for a slice of something.
  for (const password of seen) assert.ok(password.length >= 32, `${password.length} characters`)
})

test("the synthetic password satisfies IDENTITY'S OWN policy, asked of identity's own contract", () => {
  // `checkPassword` from the shared contract, never a copy of its rules: length bounds, the
  // one-character-repeated rule and — the one that matters here — that a password may not contain
  // the handle or the email local part. Deriving the secret from the run id, which is what the
  // identifiers do, would have tripped that last rule.
  for (let i = 0; i < 200; i += 1) {
    const handle = `bj${randomUUID().replace(/-/g, '').slice(0, 14)}`
    const verdict = checkPassword(syntheticPassword(), { handle, email: `${handle}@example.test` })
    assert.ok(verdict.ok, verdict.ok ? '' : JSON.stringify(verdict.errors))
  }
})

/* ------------------------------------------------------------------ surfaceJourney itself */

test('a surface with no address skips, naming the surface', async () => {
  const journey = surfaceJourney({
    name: 'browser.test',
    title: 'a surface',
    productGroup: GROUPS.network,
    surface: 'hub',
    config: OFF,
  })
  const result = await runJourney(journey, { targets: new Map() })
  // It skips on the browser first when the browser is off, which is also correct — both are
  // "not applicable here", and both refuse a release rather than passing one.
  assert.equal(result.status, 'skip')
})

async function serve(page: 'good' | 'broken'): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.url === '/assets/app.js') {
      if (page === 'broken') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(`document.body.textContent = 'Overview Portfolio Wallet Activity Security Settings Search';`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><title>s</title></head><body><script src="/assets/app.js"></script></body></html>`)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

const availability = await browserAvailable(CONFIG)
const noBrowser = availability.ok ? false : `no browser: ${availability.reason}`

test('surfaceJourney passes against a bundle that mounts', { skip: noBrowser }, async () => {
  const surface = await serve('good')
  try {
    const journey = surfaceJourney({
      name: 'browser.good',
      title: 'a surface that works',
      productGroup: GROUPS.network,
      surface: 'hub',
      config: CONFIG,
    })
    const result = await runJourney(journey, { targets: new Map([['hub', surface.url]]) })
    assert.equal(result.status, 'pass', String(result.error))
    assert.deepEqual(result.steps.map((s) => s.name), ['load the page', 'the application boots'])
  } finally {
    await surface.close()
  }
})

test('SURFACEJOURNEY GOES RED ON A BUNDLE THAT 404s, WITH THE SHELL STILL ANSWERING 200', { skip: noBrowser }, async () => {
  const surface = await serve('broken')
  try {
    const journey = surfaceJourney({
      name: 'browser.broken',
      title: 'a surface whose bundle is missing',
      productGroup: GROUPS.network,
      surface: 'hub',
      config: CONFIG,
    })
    const result = await runJourney(journey, { targets: new Map([['hub', surface.url]]) })
    // `load the page` PASSES — the shell is a 200, and every server-side probe in this repository
    // is green right here. The journey fails one step later, which is the entire argument for a
    // browser tier existing at all.
    assert.equal(result.steps[0]?.status, 'pass', 'the shell must load, or this proves nothing')
    assert.equal(result.status, 'fail', String(result.error))
    assert.equal(result.failedStep, 'the application boots')
    assert.match(String(result.error), /did not mount/)
  } finally {
    await surface.close()
  }
})
