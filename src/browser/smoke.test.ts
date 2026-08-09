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
  smokeCredentials,
  smokeHosts,
  surfaceHost,
  surfaceUrl,
  type ImageOnPage,
  type PageObservation,
  type SmokeSurface,
} from './smoke.ts'
import { collectPins, pinPolicy, type CertificateFacts } from './estatecert.ts'
import { browserAvailable, launchArgs, newSink, type BrowserConfig } from './driver.ts'

/**
 * The handle the TRANSCRIBED fixtures below were captured with.
 *
 * A plain constant, and it no longer doubles as the browser half's credential. The pure half is a
 * function of its fixtures and nothing else — reading an environment variable into it would mean
 * the always-runs half of this file could pass or fail differently on two machines, which is the
 * one property it has that makes it worth having.
 */
const HANDLE = 'estateadmin'

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
    // Market's index renders its gallery only once something is listed, and this transcription is
    // of the empty state. An imageless page is the honest default across most of the estate.
    images: [],
    // Market declares no `imagery`: its pictures are user-uploaded listing photographs, which no
    // fixed path can name. Thirteen of the seventeen surfaces are in the same position.
    requiredImages: [],
    collected: newSink(),
    ...overrides,
  }
}

/** An `<img>` the browser decoded. The shape a working picture has, for contrast below. */
function loadedImage(overrides: Partial<ImageOnPage> = {}): ImageOnPage {
  return {
    src: '/world-assets/tiles/ashfield-ground-a-256x128.png',
    currentSrc: 'https://tessera.cloudsforge.localtest.me/world-assets/tiles/ashfield-ground-a-256x128.png',
    naturalWidth: 256,
    complete: true,
    loading: 'eager',
    alt: '',
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

/* ------------------------------------------------------------------ imagery */

test('a page whose pictures all decoded is not a finding', () => {
  const findings = checkSurface(
    healthy({ images: [loadedImage(), loadedImage({ src: '/world-assets/avatar/base-a-front-256x512.png' })] }),
    surface('market'),
    HANDLE,
  )
  assert.deepEqual(findings, [])
})

test('THE TESSERA MOUNT DEFECT IS RED: the tags are all there and the pictures are not', () => {
  // The 2026-08-05 audit, as a fixture. `deploy/compose/estate/world-assets/` held a README and
  // nothing else, so `SET.json` and all 392 sprites 404'd on both networks while every existing
  // check stayed green — the document answered 200, the app mounted, the page was painted, no
  // design-system failure state rendered and the surface said its own words.
  //
  // THE POINT OF THIS CASE: an assertion that an `<img>` exists passes on this fixture. Every tag
  // is present, every `src` is spelled correctly, and the reader is looking at broken icons.
  const findings = checkSurface(
    healthy({
      images: [
        loadedImage({ naturalWidth: 0 }),
        loadedImage({ src: '/world-assets/avatar/base-a-front-256x512.png', naturalWidth: 0 }),
      ],
    }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.check, 'every image on the page loaded')
  assert.match(findings[0]?.detail ?? '', /2 <img> tag\(s\) the browser could not decode/)
  assert.match(findings[0]?.detail ?? '', /ashfield-ground-a/)
})

test('a tag with no src at all is reported SEPARATELY — it was never given a picture', () => {
  // "Never had an image" and "has one that fails to load" are repaired in different repositories:
  // the first is a surface nobody wired, the second is a file nobody serves. One finding covering
  // both sends the reader to the wrong one.
  const findings = checkSurface(
    healthy({ images: [loadedImage({ src: '', currentSrc: '', naturalWidth: 0, alt: 'Island' })] }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.check, 'every image has a source')
  assert.match(findings[0]?.detail ?? '', /no src attribute/)
  assert.match(findings[0]?.detail ?? '', /alt="Island"/)
})

test('a lazy image that has not loaded yet is NOT a finding — deferring is what lazy means', () => {
  // `emberkin`'s dex grid, `market`'s gallery and `foresight`'s market image all set
  // `loading="lazy"`. Going red on a below-the-fold tag would fail a surface for being fast, and
  // this tier would be switched off within a week.
  const findings = checkSurface(
    healthy({ images: [loadedImage({ naturalWidth: 0, complete: false, loading: 'lazy' })] }),
    surface('market'),
    HANDLE,
  )
  assert.deepEqual(findings, [])
})

test('a lazy image the browser FINISHED and could not decode is still red', () => {
  // The allowance above is bounded by `complete`. A lazy tag the browser has finished with is a
  // tag the browser tried and failed on, and excusing it would turn the allowance into a way to
  // hide every broken picture by adding one attribute.
  const findings = checkSurface(
    healthy({ images: [loadedImage({ naturalWidth: 0, complete: true, loading: 'lazy' })] }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.check, 'every image on the page loaded')
})

/* ------------------------------------------------------------------ declared art */

test('THE TESSERA MOUNT DEFECT IS RED THE WAY IT ACTUALLY PRESENTED: no <img> anywhere', () => {
  // The case above uses `<img>` tags because they make the contrast readable. This one is the
  // defect as it really was, and it is the reason `SmokeSurface.imagery` exists at all: Tessera
  // has NO `<img>` tags — `src/render/renderer.ts` draws into a canvas from ImageBitmaps, and
  // `SpriteCache.fetchOne` swallows its own 404s by design. So `images` is empty, every DOM check
  // is satisfied, and 392 generated sprites reach nobody.
  //
  // Verbatim from `tessera.cloudsforge.online` before the mount was populated on 2026-08-05.
  const findings = checkSurface(
    healthy({
      surfaceKey: 'tessera',
      url: 'https://tessera.cloudsforge.online/',
      images: [],
      requiredImages: [
        { path: '/world-assets/SET.json', kind: 'receipt', status: 404, naturalWidth: null, parsed: null, error: null },
        {
          path: '/world-assets/tiles/ashfield-ground-a-256x128.png',
          kind: 'image',
          status: null,
          naturalWidth: 0,
          parsed: null,
          error: null,
        },
      ],
    }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 2)
  assert.ok(findings.every((f) => f.check === 'the art this product needs is served'))
  assert.match(findings[0]?.detail ?? '', /answered HTTP 404 for \/world-assets\/SET\.json/)
  assert.match(findings[0]?.detail ?? '', /unpopulated or unrouted/)
})

test('declared art the browser produced no picture from is red, whatever the status was', () => {
  // The failure a status-code check cannot see: an HTML error page served with a 200, a truncated
  // copy, or a Content-Type that makes nosniff refuse the estate's own picture. All three arrive
  // as a decoded width of zero, which is why the width is what is asserted on — and why an image
  // carries NO status here at all. It is resolved through an image element rather than `fetch`
  // (see `resolveImagery`), so there is no status to be reassured by, only a picture or not.
  const findings = checkSurface(
    healthy({
      requiredImages: [
        { path: '/art/species/cindercub-256x256.png', kind: 'image', status: null, naturalWidth: 0, parsed: null, error: null },
      ],
    }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 1)
  assert.equal(findings[0]?.check, 'the art this product needs is served')
  assert.match(findings[0]?.detail ?? '', /the browser produced no picture from it/)
})

test('a receipt that 200s with a body that is not JSON is red', () => {
  const findings = checkSurface(
    healthy({
      requiredImages: [
        { path: '/world-assets/SET.json', kind: 'receipt', status: 200, naturalWidth: null, parsed: false, error: null },
      ],
    }),
    surface('market'),
    HANDLE,
  )
  assert.equal(findings.length, 1)
  assert.match(findings[0]?.detail ?? '', /not readable JSON/)
})

test('declared art that resolves and decodes produces no finding', () => {
  const findings = checkSurface(
    healthy({
      requiredImages: [
        { path: '/world-assets/SET.json', kind: 'receipt', status: 200, naturalWidth: null, parsed: true, error: null },
        {
          path: '/world-assets/tiles/ashfield-ground-a-256x128.png',
          kind: 'image',
          status: null,
          naturalWidth: 256,
          parsed: null,
          error: null,
        },
      ],
    }),
    surface('market'),
    HANDLE,
  )
  assert.deepEqual(findings, [])
})

test('EVERY declared image path is on the surface\'s own origin, and none is a wildcard', () => {
  // The rule `ContractualEmpty` establishes, applied to the other direction. An allowance narrows
  // what the tier looks at; a declaration widens it — but a declaration naming another host would
  // let one surface's green vouch for a different one's mount, and a pattern would let a
  // declaration match a file nobody meant. Both are refused structurally here rather than by
  // review, because this list will grow.
  for (const surfaceDef of SMOKE_SURFACES) {
    for (const image of surfaceDef.imagery ?? []) {
      assert.ok(
        image.path.startsWith('/'),
        `${surfaceDef.key} declares ${image.path}, which is not a path on its own origin`,
      )
      assert.ok(
        !/[*?]/.test(image.path),
        `${surfaceDef.key} declares ${image.path}, which is a pattern — declare the file`,
      )
      assert.ok(
        image.why.length > 40,
        `${surfaceDef.key}'s ${image.path} has no reason recorded; say what breaks without it`,
      )
    }
  }
})

test('THE WORLDS REGISTRY DEFECT IS RED: the frontend calls a host the gateway does not route', () => {
  // Verbatim from Chromium against the running estate on 2026-08-05, kept as a fixture because it
  // is the shape this check exists to catch. `worlds-web` asked `worlds-api.<apex>/v1/titles`;
  // that hostname resolved nowhere, so the preflight was refused and the fetch failed. The page
  // still answered 200 and still rendered 900 characters of copy, which is precisely why nothing
  // else caught it.
  //
  // BOTH SIDES ARE FIXED NOW — `API_SURFACE` is `'api'` and the `cf-api-worlds-api` router is
  // deleted — so this is a recorded observation, not a live address. It must NOT be "updated" to a
  // working host: the assertion is that a failed request makes a 200 page RED, and swapping in a
  // host that works deletes the only case that proves it.
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

/* ------------------------------------------------------------- the surface whose job is a verdict */

/**
 * The public status page, exactly as it answered on 2026-08-04 — and it is NOT a pass.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS TIER LOOKED AT THIS PAGE AND SAW NOTHING WRONG WITH IT.** Not as a thought experiment:
 * `status.cloudsforge.online` was driven through this file's own `visit()` in Chromium at 22:05
 * UTC, and `checkSurface` returned `[]` — an empty finding list — against the body text
 * transcribed below. The estate was healthy at the time: mainnet and testnet both up, both chains
 * mining, eleven of twelve scheduled journeys green.
 *
 * Every check that existed had an honest reason to be quiet. The document answered 200. The
 * bundle mounted, was painted, logged nothing and failed no request. It rendered its own words —
 * `STATUS` and `How we measure` are chrome, and chrome is what `renders` is FOR: it pins that the
 * gateway routed this hostname to this product. And `state--failed` is the design system's marker
 * for a component that could not load, which is not what happened: the page loaded perfectly and
 * reached the conclusion that it could not say anything.
 *
 * So the gap was not a weak check. It was a missing KIND of check: no assertion anywhere in this
 * repository read what the status page CONCLUDED. A surface whose entire purpose is to answer one
 * question must be asserted to have answered it, and for this one surface that is the whole
 * product — a status page that cannot determine status has failed at the only thing it does, and
 * it fails silently, looking exactly like a working page to anything that only checks for errors.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const STATUS_PAGE_WITHOUT_A_VERDICT =
  'Skip to status CloudsForge STATUS Current History How we measure ? Not determined ' +
  'We cannot currently determine status. Our status service answered, but part of the answer was ' +
  'missing or unreadable. An incomplete answer can report a problem; it cannot report that there ' +
  'is none, so we do not. · Observed 04 Aug 2026, 22:05 UTC (just now) Check again ' +
  'One open incident Account ◌ Investigating SEV2 Opened 04 Aug 2026, 19:23 UTC · Not yet closed ' +
  'Product groups The answer contained no product groups. That is not "everything is fine" — it ' +
  'is an answer we cannot read anything into, which is why the state above says so.'

test('a status page that cannot determine status is RED, however clean the page is', () => {
  const observation = healthy({
    surfaceKey: 'status',
    url: 'https://status.cloudsforge.online/',
    bodyText: STATUS_PAGE_WITHOUT_A_VERDICT,
  })
  const findings = checkSurface(observation, surface('status'), HANDLE)
  assert.deepEqual(
    findings.map((f) => f.check),
    ['the page reaches its verdict'],
    'the ONLY thing wrong with this page is that it reached no verdict — if anything else fired, ' +
      'the fixture has drifted from the page that was actually observed',
  )
  // The detail has to carry the sentence the reader saw, because "no verdict" is unactionable and
  // "it says: We cannot currently determine status" names the thing to go and look at.
  assert.match(findings[0]?.detail ?? '', /cannot currently determine status/i)
})

test('a status page that reached a verdict is green, and an OUTAGE is a verdict', () => {
  // The check asserts that the page ANSWERED, never that the answer was good news. A status page
  // reporting an outage is a status page doing its job, and a check that went red on "Active
  // outage" would be a check with an incentive to hide one.
  for (const verdict of [
    'All systems operational',
    'Some systems degraded',
    'Active outage',
    'Planned maintenance in progress',
  ]) {
    const observation = healthy({
      surfaceKey: 'status',
      url: 'https://status.cloudsforge.online/',
      bodyText: `Skip to status CloudsForge STATUS Current History How we measure ${verdict} Measured across 19 product groups.`,
    })
    assert.deepEqual(
      checkSurface(observation, surface('status'), HANDLE),
      [],
      `"${verdict}" is a verdict and must not be a finding`,
    )
  }
})

test('only the status surface is asked to reach a verdict', () => {
  // `concludes` is opt-in, and fifteen of the sixteen surfaces do not carry it. Asserted so that
  // adding it to a surface whose job is not to conclude anything is a deliberate act rather than
  // something that arrives by copying a neighbour.
  assert.deepEqual(
    SMOKE_SURFACES.filter((s) => s.concludes !== undefined).map((s) => s.key),
    ['status'],
  )
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

  // IDENTITY IS HOST PLUS PATH, not host alone. It was host alone while every surface was its own
  // bundle on its own subdomain; folding the Foresight operator panel into `admin` as a nested
  // route made that false — `admin` and `admin-foresight` share a hostname on purpose and differ
  // by path. Asserting on the pair keeps what this check was actually for (two surfaces silently
  // aimed at one address) without forbidding the arrangement that is now correct.
  const addresses = SMOKE_SURFACES.map(
    (s) => `${s.subdomain === '' ? '' : s.subdomain + '.'}example.test${s.path}`,
  )
  assert.equal(new Set(addresses).size, addresses.length, 'two surfaces resolve to one address')

  // And the pin list is per HOST, so it dedupes.
  const hosts = smokeHosts('example.test')
  assert.equal(new Set(hosts).size, hosts.length, 'collectPins would pin one host twice')
})

test('the apex surface is the apex, not a subdomain of it', () => {
  assert.equal(surfaceUrl('example.test', surface('site')), 'https://example.test/')
  assert.equal(surfaceUrl('example.test', surface('hub')), 'https://hub.example.test/')
})

test('an environment is a SUFFIX on the subdomain, and stands alone on the apex surface', () => {
  // The shape this replaced was `hub.testnet.example.test` — a second label under a wildcard
  // certificate that matches one, so it failed the TLS handshake at the edge and this suite would
  // have refused the whole estate as unreachable rather than reporting anything about it.
  assert.equal(surfaceHost('example.test', 'hub', 'testnet'), 'hub-testnet.example.test')
  assert.equal(surfaceUrl('example.test', surface('hub'), 'testnet'), 'https://hub-testnet.example.test/')
  // The apex surface takes the label ALONE: its subdomain is the empty string, and
  // `-testnet.example.test` is not a legal DNS label.
  assert.equal(surfaceHost('example.test', '', 'testnet'), 'testnet.example.test')
  assert.equal(surfaceUrl('example.test', surface('site'), 'testnet'), 'https://testnet.example.test/')
  // No environment is the unadorned estate, in both cases, which is what every existing caller
  // gets by not passing one.
  assert.equal(surfaceHost('example.test', 'hub'), 'hub.example.test')
  assert.equal(surfaceHost('example.test', ''), 'example.test')
})

test('every hostname the run pins is the environment it is about to visit', () => {
  // The failure this pins: `cli.ts` composed the pin list itself with a second copy of the
  // `<sub>.<apex>` rule. Left alone, a `--env testnet` run would have pinned sixteen MAINNET
  // certificates and then visited sixteen testnet pages — every certificate rejected, on an
  // estate that was healthy.
  const hosts = smokeHosts('example.test', 'testnet')
  const visited = SMOKE_SURFACES.map((s) => new URL(surfaceUrl('example.test', s, 'testnet')).host)
  assert.deepEqual([...new Set(visited)].sort(), [...hosts].sort())
  assert.ok(hosts.includes('hub-testnet.example.test'))
  assert.ok(hosts.includes('testnet.example.test'), 'the apex surface')
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

/* ============================================================== the credential has no default */

/*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A DEFAULT PASSWORD IS A PUBLISHED PASSWORD, AND THIS ONE WAS.**
 *
 * `BEACON_SMOKE_PASSWORD` fell back to a constant that `deploy/scripts/estate-bootstrap.sh` also
 * used as its `ADMIN_PASSWORD` default. Mainnet was bootstrapped without overriding it, so on
 * 2026-08-09 that literal returned 200 from `POST https://api.cloudsforge.online/v1/auth/login`
 * with `roles: ["player","admin"]` — out of a public repository. micro-org#276 has the whole
 * measurement; the rotation revoked 149 sessions.
 *
 * These cases run everywhere, including CI, and they are the reason the fallback cannot come back
 * quietly: restoring one makes the first case red with no estate anywhere.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
test('AN UNSET SMOKE PASSWORD IS A REFUSAL, NOT A DEFAULT', () => {
  const verdict = smokeCredentials({})
  assert.equal(verdict.ok, false, 'a default password came back — that is the defect, restored')
  if (verdict.ok) return
  // The reason has to be actionable on the machine it is read on. Naming the variable alone sends
  // somebody to invent a value; naming the FILE the rotated one is already in does not.
  assert.match(verdict.reason, /BEACON_SMOKE_PASSWORD/)
  assert.match(verdict.reason, /compose\/estate\/tokens\.env/)
  assert.match(verdict.reason, /micro-org#276/)
})

test('an empty string is unset — a variable exported without a value must not sign anything in', () => {
  assert.equal(smokeCredentials({ BEACON_SMOKE_PASSWORD: '' }).ok, false)
})

test('the identifier and the handle keep their defaults, because neither is a secret', () => {
  const verdict = smokeCredentials({ BEACON_SMOKE_PASSWORD: 'not-the-published-one' })
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason)
  assert.deepEqual(verdict.credentials, {
    identifier: 'estate-admin@example.test',
    password: 'not-the-published-one',
    handle: 'estateadmin',
  })
})

test('all three are overridable, so the same suite can be pointed at another estate', () => {
  const verdict = smokeCredentials({
    BEACON_SMOKE_IDENTIFIER: 'someone@example.test',
    BEACON_SMOKE_PASSWORD: 'a-different-one',
    BEACON_SMOKE_HANDLE: 'someone',
  })
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.reason)
  assert.deepEqual(verdict.credentials, {
    identifier: 'someone@example.test',
    password: 'a-different-one',
    handle: 'someone',
  })
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

  /*
   * ── THE CREDENTIAL IS READ HERE, AFTER THE TWO SKIPS, AND ITS ABSENCE IS A FAILURE ──────────
   *
   * `BEACON_SMOKE_PASSWORD` has no default any more: the constant it used to fall back to was
   * published in a public repository and was the estate administrator's real password on mainnet
   * until 2026-08-09 (micro-org#276). The replacement lives in the host's gitignored
   * `compose/estate/tokens.env`.
   *
   * The ORDER is the whole of the design. Reading it at module scope and throwing would take this
   * file's always-runs half down in CI, where there is no estate, no credential and no reason for
   * either — and that half is the part that goes red when somebody weakens a check. Reading it
   * after the reachability and browser skips means the only run that ever demands a password is
   * one that has an estate in front of it and a browser to drive.
   *
   * And once we are in that run it is `assert`, never `t.skip`. An estate is up, Chromium is
   * present, and the tier that exists because "a skipping check is exactly the shape of the defect
   * this whole tier was written to end" must not answer "I had no password" with a green.
   */
  const credentials = smokeCredentials(process.env)
  if (!credentials.ok) assert.fail(credentials.reason)

  const pins = await collectPins(smokeHosts(APEX))
  for (const reason of pins.reasons) t.diagnostic(`tls: ${reason}`)

  const result = await runSmoke({
    apex: APEX,
    credentials: credentials.credentials,
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
