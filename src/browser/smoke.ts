/**
 * The smoke tier: a real browser, against the real estate, through the real gateway, stubbing
 * nothing.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS EXISTS: A SUITE THAT ANSWERS ITS OWN REQUESTS CANNOT SEE THAT THE API IS DOWN.**
 *
 * The estate shipped green — 44 healthy containers, CI green in 58 repositories, 314 browser
 * scenarios specified — and when a human opened it in a browser, sign-in failed, the Forge Worlds
 * registry failed, Foresight was blank and Forge Trade rendered unstyled. Every test passed
 * through all of it, and the reason is one line repeated in every frontend's journey helper — in
 * `site/test/journeys/browser.ts`, inside `renderOnlyWithStubbedNetwork`, and in its equivalents
 * across the other frontends:
 *
 *     await page.route('**\/*', async (route) => { … route.fulfill({ … }) })
 *
 * ── CITED BY NAME RATHER THAN BY LINE NUMBER, DELIBERATELY ─────────────────────────────────────
 *
 * That citation said `browser.ts` and the line had moved to 419: the helper was renamed to
 * `renderOnlyWithStubbedNetwork` across six repositories and given a long header, and the number
 * rotted in silence. It was, as far as anyone could find, the only line-numbered citation into
 * that file anywhere in the estate, and beacon has no citations test — so nothing would have
 * noticed the next drift either.
 *
 * A check was considered and refused, and the refusal is the point rather than laziness.
 * `micro-aetherholm-web` checks out its sibling service purely so every route citation is verified
 * against the line it names, and `micro-conformance` and several frontends do the same — that
 * machinery is worth its cost where dozens of citations pin a contract. Here it is ONE, and the
 * check would need a `micro-site` checkout beside this one. Beacon's CI has none, so the test
 * would either fail for the wrong reason or SKIP — and a skip that reads as a pass is precisely
 * what `journeys.ts` rule 2 exists to refuse. Buying a citation check with a new green-when-not-run
 * is a bad trade in the repository that made that argument.
 *
 * So it is anchored on the two things that do not move: the exported function's NAME, and the call
 * itself. Both are greppable, and this file's own `smoke.test.ts` already asserts the same call
 * text is absent from *this* tier — so the string is load-bearing on both sides.
 *
 * It launches a real browser, renders the real bundle, and then **intercepts every network request
 * and answers it from a fixture**. What it proves is "this app renders correctly when its API
 * works". It is structurally incapable of noticing that the API is unreachable — which is the
 * failure it was sitting at the exact seam of.
 *
 * So the single most important property of this file is a negative one:
 *
 *     THERE IS NO `page.route`, NO `route.fulfill`, NO `setOfflineMode`, NO SERVICE WORKER AND NO
 *     FIXTURE ANYWHERE IN THIS TIER. EVERY BYTE THESE PAGES RECEIVE CAME FROM THE ESTATE.
 *
 * `smoke.test.ts` asserts that as text over this repository's own sources, and CI repeats it, so
 * the day somebody reaches for a stub to make a red go away it is a red of its own.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## Why here and not in micro-conformance
 *
 * micro-conformance records what the estate *does* — request in, normalised response out — so a
 * replacement can be proven equivalent. It is an HTTP recorder with a corpus; it has no browser,
 * no notion of a rendered page, and its whole value is that its output is a stable artefact to
 * diff. Adding a Chromium and a set of live assertions to it would make its corpus depend on
 * whether a bundle painted, which is the one thing a characterisation corpus must not do.
 *
 * micro-beacon already owns every piece of this: `driver.ts` drives Chromium and collects console
 * errors, uncaught exceptions and failed requests **and has never intercepted anything**;
 * `journeys.ts` owns "not-run is not passed"; `gate.ts` turns results into a release decision.
 * This is one more file beside them, not a third harness.
 *
 * ## What it asserts, and why each one is the one that would have caught the estate
 *
 * Per surface, in one signed-in browser context, in the order a person would meet them:
 *
 *   1. **The document answers 200.** Necessary and nowhere near sufficient — all sixteen answer
 *      200 today while eight of them show an error state.
 *   2. **The application mounted** (`assertRendered`). Foresight is blank; only this sees it.
 *   3. **The page is painted.** `body`'s computed background is not transparent. Three surfaces
 *      serve a bundle whose own stylesheet never applies, and "renders unstyled" is a thing a
 *      human notices in one second and no HTTP check notices ever.
 *   4. **No `state--failed` and no `state--forbidden` node.** This is the strongest assertion in
 *      the file and it is not a string match on prose. Every frontend renders the same four-state
 *      component (`<each frontend>/src/components/states.tsx`), whose header sets out why the states are
 *      separate: `EMPTY` is "the query answered, with nothing" and `FAILED` is "the query did not
 *      answer". So an empty registry is green and a registry that did not load is red, decided by
 *      the estate's own design system rather than by a regex this repository invented.
 *   5. **No failed request and no uncaught exception**, from `driver.ts`'s collectors. The Worlds
 *      registry defect was exactly this and nothing else: `ERR_FAILED` on
 *      `worlds-api.<apex>/v1/titles`, a hostname that resolved nowhere. Both halves are fixed —
 *      the bundle calls `api.` and the router for the dead name is gone — and the fixture for it
 *      is kept in `smoke.test.ts` because the SHAPE recurs.
 *   6. **No console error.** Asked for explicitly, and fatal HERE where it is not fatal in
 *      `assertClean` — see `SMOKE_CONSOLE_IS_FATAL` below for why the two differ on purpose.
 *   7. **The surface's own words are on screen.** A gateway that routed every hostname to one
 *      bundle would satisfy every assertion above and serve the wrong product at fifteen
 *      addresses.
 *
 * And once, before all of it: **a real sign-in**, with a real password, against real identity,
 * ending on a page that renders the account's handle. It is the single most valuable assertion in
 * the estate and there was nothing anywhere that made it.
 */

import {
  assertClean,
  assertRendered,
  isObservabilitySink,
  unexpectedConsoleErrors,
  type BrowserConfig,
  type BrowserPage,
  type Collected,
} from './driver.ts'

/* ------------------------------------------------------------------ the surfaces */

/** Whether the surface must show the signed-in account, once the suite has signed in. */
export type SessionExpectation = 'shows-the-account' | 'does-not-have-to'

export interface SmokeSurface {
  /** The registry key, as `ui/packages/ui/src/surfaces.ts` names it. */
  readonly key: string
  /** Subdomain under the apex. The empty string is the apex itself. */
  readonly subdomain: string
  /** The page whose primary data matters. The index, for every surface: it is what a person opens. */
  readonly path: string
  readonly session: SessionExpectation
  /**
   * Words only this surface's own bundle produces.
   *
   * Not a data assertion — that is what `state--failed` is for, because the design system already
   * distinguishes "answered with nothing" from "did not answer" and a regex here would be this
   * repository guessing at the difference. These pin IDENTITY: that the gateway routed this
   * hostname to this product, rather than to whichever bundle answers first.
   */
  readonly renders: readonly RegExp[]
  /**
   * Exchanges on THIS surface's own origin where a 4xx is the contract rather than a defect.
   *
   * See `ContractualEmpty`. Absent on fifteen of the sixteen surfaces, and that is the number to
   * watch: every entry here is a check this tier has agreed not to make.
   */
  readonly contractual?: readonly ContractualEmpty[]
  /**
   * The conclusions this surface exists to reach. One of them must be on the page.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THE CHECK THAT WAS MISSING WHEN THE PUBLIC STATUS PAGE COULD NOT DETERMINE STATUS.**
   *
   * On 2026-08-04 `status.<apex>` rendered "Not determined — we cannot currently determine
   * status" on a healthy estate, and this tier drove it in Chromium and found NOTHING: it
   * answered 200, it mounted, it was painted, it logged no console error, it failed no request,
   * it showed no `state--failed` node, and it rendered its own brand words. Every one of those
   * checks was right to be quiet. The page was not broken — it had *concluded* that it could not
   * answer, which looks identical to a working page to anything that only hunts for errors.
   *
   * `renders` could not have caught it and must not be made to. Those patterns pin IDENTITY —
   * that this hostname is serving this product — so they have to match the chrome, which is
   * present on every render of the bundle including this one.
   *
   * So this is a different assertion with a different name: not "did the bundle load" but "did it
   * do its job". It is DELIBERATELY narrow. It belongs only on a surface whose product IS a
   * single answer, which today is exactly one of the sixteen — a status page. A catalogue page
   * legitimately renders an empty state, a dashboard legitimately renders zeroes, and asserting a
   * conclusion on either would be this tier asserting a business rule, which `catalogue.ts` §3
   * forbids for reasons that are a real incident rather than a preference.
   *
   * The alternatives are worse in ways worth writing down, because both will be suggested:
   *
   *   * **Matching on "Not determined" and going red on it** is an absence assertion, and the
   *     catalogue's own rule is that there is no `absence` kind — a check that lists the bad
   *     sentences is a check that passes on the bad sentence nobody thought of. This lists the
   *     GOOD ones: anything else, including a blank hero and including a sentence invented next
   *     year, is a finding.
   *   * **Asserting `operational`** would be a check with an incentive to hide an outage. All
   *     four verdicts are accepted, because the assertion is that the page ANSWERED, never that
   *     the answer was good news.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly concludes?: readonly RegExp[]
  /**
   * Pictures this product cannot work without, as paths on this surface's OWN origin.
   *
   * ════════════════════════════════════════════════════════════════════════════════════════════
   * **THE `<img>` CHECK COULD NOT HAVE CAUGHT THE DEFECT OF 2026-08-05, AND THIS IS WHY.**
   *
   * Tessera served 392 generated sprites to nobody for as long as the mount existed. It has no
   * `<img>` tags at all: `src/render/renderer.ts` draws into a `<canvas>` from `ImageBitmap`s that
   * `src/lib/sprites.ts` fetched, and a fetch that 404s leaves NO tag, NO broken icon and NO
   * console error — `SpriteCache.fetchOne` catches its own failure by design, and reports the hole
   * inside the app. So the page is a canvas of nothing while every DOM assertion available is
   * satisfied.
   *
   * `emberkin` has the same exposure through a different door: its `.glb` models and its keyart
   * reach the page through `fetch`, not markup.
   *
   * So imagery is DECLARED, and the tier resolves it in the browser: `fetch` from the page's own
   * origin, then `createImageBitmap`. The bitmap is the assertion — non-zero dimensions mean
   * Chromium's decoder accepted the bytes, which says in one number that the path routed, that the
   * mount is populated, that the response was an image and that it was not truncated.
   *
   * ── WHY A LITERAL PATH, WHEN `asset-set.ts` ARGUES AGAINST SPELLING FILENAMES ────────────────
   *
   * Because the two are answering different questions. That module refuses to CONSTRUCT names,
   * because a client that invents a filename forks the naming contract silently — which is the
   * defect it was written after. This DECLARES one, and a declared name that has drifted goes red
   * and gets read by a person. The failure modes are opposite: one passes while the product is
   * broken, the other fails while the product is fine. Only the second is safe to have.
   *
   * Absent on most surfaces, and that is not an oversight — thirteen of the seventeen render no
   * product imagery at all. An entry here is a claim that this product is not one of them.
   * ════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly imagery?: readonly RequiredImage[]
}

/** One picture a surface must be able to serve, and the reason it counts as load-bearing. */
export interface RequiredImage {
  /** Absolute path on the surface's own origin. Never another host — see `ContractualEmpty`. */
  readonly path: string
  /** Why this product is broken without it. Printed on nothing; read by whoever sees the red. */
  readonly why: string
}

/**
 * A status this surface's own API answers **by design**, on a named path.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE DANGER IS NOT THIS ENTRY. IT IS THE SECOND ONE, AND THE FIFTH.**
 *
 * A smoke tier that learns to shrug at 404s is worth nothing — a 404 is exactly how the two
 * gateway defects this tier found tonight presented. So the shape of the allowance is doing all
 * the work, and it is deliberately the most awkward one available:
 *
 *   * **One exact path**, never a prefix and never a pattern. `/v1/saves/me` is allowed;
 *     `/v1/saves/*` is not expressible.
 *   * **One exact status.** A 404 that becomes a 500 is a new fact and goes red.
 *   * **This surface's own host only.** `checkSurface` fills the host in from the observed page
 *     origin, so an allowance written for emberkin cannot excuse the same path on nimbus or on
 *     the gateway.
 *   * **A `why` that names the line of source it is derived from**, so a reviewer can check the
 *     claim rather than take it, and so an entry that has stopped being true reads as stale.
 *
 * What is NOT expressible here is the thing that would matter: there is no way to say "ignore
 * 404s on this surface", and no way to say "ignore 404s". If a second entry ever appears, the
 * question to ask is not whether it is correct — it will be — but whether the tier is being
 * gradually taught not to look.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ContractualEmpty {
  /** Exact pathname, as the service routes it. */
  readonly path: string
  /** The status the SERVICE documents for the empty case. */
  readonly status: number
  /** Why this is the contract, citing the source that says so. Printed on nothing; read by people. */
  readonly why: string
}

/**
 * The nineteen surfaces `deploy/compose/docker-compose.estate.yml` serves, in switcher order.
 *
 * Keys and subdomains are read off `ui/packages/ui/src/surfaces.ts`, which is the registry whose
 * own header records that this list was maintained by hand in eight places and had already
 * drifted. Neither the apex NOR THE ENVIRONMENT is recorded here — both come from configuration,
 * so that pointing this suite at another environment is a variable rather than an edit. See
 * {@link surfaceHost} for how the two are combined, and for why the environment stopped being
 * expressible as an apex on 2026-08-05.
 */
export const SMOKE_SURFACES: readonly SmokeSurface[] = [
  {
    key: 'site',
    subdomain: '',
    path: '/',
    session: 'does-not-have-to',
    // ONE EDITORIAL STRING AND ONE STRUCTURAL ONE, deliberately — this pair was
    // `[/One crypto world/i, /The loop is the product/i]` until 2026-08-04, and both were removed
    // from the marketing site on the owner's instruction. The tier went 17/17 → 16/17 and was
    // RIGHT: it is pinned to the site's own words precisely so that a gateway routing every
    // hostname to one bundle is caught, and words are what distinguish one bundle from another.
    //
    // But pinning only a POSITIONING line means this fails every time marketing is legitimately
    // rewritten, which is a check that cries wolf. Pinning only a STRUCTURAL one weakens what it
    // was built for, because a nav label is the sort of thing that later moves into shared chrome
    // and stops being unique. So: one of each.
    //
    // `Build status` was measured against the other bundles before being trusted — absent from
    // hub's and market's JavaScript, present in site's. If it ever appears in shared chrome this
    // pair needs revisiting, and that is a better failure than a silent one.
    //
    // The editorial half is guarded on the other side too: `site/test/content.test.ts` requires the
    // spine to name EMBER and forbids the loop framing anywhere on the home page, so a rewrite
    // that changes it has to pass that first.
    renders: [/EMBER, and everything built on it/i, /Build status/i],
  },
  {
    key: 'hub',
    subdomain: 'hub',
    path: '/',
    // Hub is where the suite signed in. If the account is not on screen HERE, the session did not
    // survive the navigation and every other signed-in surface is being judged on a lie.
    session: 'shows-the-account',
    renders: [/Portfolio/i, /Activity/i],
  },
  {
    key: 'market',
    subdomain: 'market',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Market/i, /Browse the market/i],
  },
  {
    key: 'create',
    subdomain: 'create',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Create/i, /Launch a token/i],
  },
  {
    key: 'trade',
    subdomain: 'trade',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Trade/i, /Strategies/i],
  },
  {
    key: 'exchange',
    subdomain: 'exchange',
    path: '/',
    // No session, and unlike every other `does-not-have-to` on this list that is not a relaxation
    // — `exchange-web` has no account to show. It authenticates nobody, stores nothing, and the
    // only identity in the product is whatever key the reader's own wallet holds.
    session: 'does-not-have-to',
    //
    // THE EDITORIAL HALF IS A SENTENCE THE PAGE CANNOT RENDER WITHOUT REACHING THE CHAIN.
    //
    // `Swap`'s lede is written per-deployment and only mounts once `ChainProvider` has an answer
    // to `eth_chainId` and `deploymentFor()` has matched it. So this string is not decoration that
    // ships in the bundle: getting it on screen means the browser reached `rpc.<apex>` ACROSS
    // ORIGINS and got a chain id back. That is the one deploy fact this surface depends on and the
    // one nothing else in the estate exercises — every other frontend talks to a CloudsForge API
    // on its own origin, so `exchange.<apex>` is the only entry in `cf-cors`'s allowlist whose
    // absence no other check here would notice. Lose the allowlist entry and this goes red.
    //
    // The structural half is the product name from the shell. Pinned second and deliberately weak:
    // it would survive a chain outage, and it is here to catch a gateway serving one bundle from
    // another hostname, which is what `renders` was built for.
    renders: [/The price is not quoted by anybody/i, /Forge Exchange/i],
  },
  {
    key: 'worlds',
    subdomain: 'worlds',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Worlds/i, /The title registry/i],
  },
  {
    key: 'explorer',
    subdomain: 'explorer',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Network Explorer/i, /Chains/i],
  },
  {
    key: 'network',
    subdomain: 'network',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Forge Network/i, /Hearth/i],
  },
  {
    key: 'developers',
    subdomain: 'developers',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Developer Platform/i, /Organisations/i],
  },
  {
    key: 'journal',
    subdomain: 'journal',
    path: '/',
    // Nothing here is behind a sign-in and nothing ever will be: the archive is prose, and an
    // article a reader has to have an account to finish is not published writing. `journal-web`
    // still mounts the shared account bar, so a session that HAS survived shows in it — this
    // entry just does not make that the test, because the page is correct either way.
    session: 'does-not-have-to',
    //
    // THE EDITORIAL HALF IS THE ONE SENTENCE THAT ONLY EXISTS IF THE PRERENDER RAN.
    //
    // `journal-web` has no API and no CMS: every route is written to static HTML at build time by
    // `scripts/prerender.ts`, and the served file is what a crawler and a reader both get. So the
    // hero line below is not proof that a bundle loaded — it is proof that the BUILD STEP after
    // the bundle ran and its output was copied into the image. A container serving the bare
    // `index.html` shell would still hydrate in a browser and would still look right here, which
    // is exactly the failure a `renders` on a client-rendered surface cannot see.
    //
    // The structural half is the publication name out of the shell (`lib/meta.ts`'s
    // `PUBLICATION`), pinned second and deliberately weak, to catch the gateway serving one
    // bundle from another hostname — what `renders` was built for.
    renders: [/Crypto, written down plainly/i, /Forge Journal/i],
    // TESSERA'S FAILURE, DECLARED BEFORE IT HAPPENS. Every article carries a hero and a card, and
    // an archive whose pictures 404 renders as a page of headlines with grey rectangles — which is
    // precisely what `micro-tessera-web` shipped while every check stayed green. Two entries, from
    // two DIFFERENT article directories, because one proves the copy happened and two prove it
    // was whole: a `.dockerignore` that takes some subdirectories and not others is the shape this
    // actually fails in.
    imagery: [
      {
        path: '/articles/crypto-without-the-crypto-words/hero.png',
        why:
          'the lead article on the home page, and the largest single image the archive serves. A ' +
          'hole here is the first thing a first-time reader sees.',
      },
      {
        path: '/articles/the-healthy-way-to-hold-crypto/card.png',
        why:
          'a card rather than a hero, and from another directory: the grid loads these five ' +
          'before it loads anything else, and they come from a different COPY than the heroes.',
      },
    ],
  },
  {
    key: 'agora',
    subdomain: 'agora',
    path: '/',
    // The Square is a TIMELINE and not a sign-up wall, deliberately (`agora-web/src/pages/square.tsx`
    // opens with the argument): a stranger arriving from a linked post sees what people are saying
    // before they are asked for anything. `latest` sends the bearer when there is one and answers
    // the same page without it, so a session that survived changes what is IN the list rather than
    // whether the page renders — which is exactly the surface this assertion must not be made on.
    session: 'does-not-have-to',
    //
    // BOTH HALVES ARE THE PAGE HEAD, AND THE HEAD IS THE PART THAT DOES NOT DEPEND ON THE API.
    //
    // `Timeline` renders its `header` prop above the body in every state — loading, failed, empty
    // and ok alike (`agora-web/src/components/timeline.tsx`, `{header}` then `{body}`) — so these
    // two strings say "this hostname served the Agora bundle and it mounted", and say NOTHING
    // about whether the square loaded. That separation is the one this tier wants: a square that
    // did not load is already red through `state--failed`, and a square that is legitimately empty
    // on a fresh testnet is already green there. Pinning a post, a handle or a count here would
    // make this entry a data assertion and put it in the way of both.
    //
    // The editorial half is the standfirst under the h1. The structural half is the h1 itself,
    // which is also the left rail's first nav label — weaker on purpose, and here to catch the
    // gateway serving one bundle from another hostname.
    //
    // NOT `/Forge Agora/i`, which is what the other entries reach for and would be WRONG here.
    // The registry name reaches this page's DOM through `CloudsForgeFooter`, and that footer lists
    // every `servesUi` surface on EVERY surface that mounts it — so the pattern would match on
    // hub, on site and on market, which is the precise failure `renders` exists to detect. The
    // Journal's `/Forge Journal/i` is safe for the opposite reason: that string is its own
    // masthead, printed by `journal-web/src/lib/meta.ts`. Agora's masthead is the product switcher,
    // and the switcher reads `Products` here — `inSwitcher: false` means `ProductSwitcher` finds no
    // active entry and falls back to the generic label.
    renders: [/Everything posted in the open/i, /The Square/i],
  },
  {
    key: 'admin',
    subdomain: 'admin',
    path: '/',
    // The operator console. An admin surface that renders while signed out is either broken or a
    // hole, and either way it is not a pass.
    session: 'shows-the-account',
    renders: [/Estate/i, /Approvals/i],
  },
  {
    key: 'status',
    subdomain: 'status',
    path: '/',
    session: 'does-not-have-to',
    renders: [/STATUS/, /How we measure/i],
    /*
     * The four headlines `status-web` can reach, and the fifth outcome it must not be left in.
     *
     * Transcribed from `status-web/src/lib/degrade.ts`'s `headlineFor`, which returns exactly
     * these four for the four public states and `We cannot currently determine status.` for
     * `unknown`. They are pinned on that side too — `status-web/test/degrade.test.ts` and
     * and assert each one — so this list going stale is a red test in the
     * repository that owns the words, rather than a check here that quietly stops matching.
     *
     * `unknown` is absent, and that absence IS the check: it is the one outcome that means the
     * page did not do its job.
     */
    concludes: [
      /All systems operational/i,
      /Some systems degraded/i,
      /Active outage/i,
      /Planned maintenance in progress/i,
    ],
  },
  {
    key: 'foresight',
    subdomain: 'foresight',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Foresight/i],
  },
  {
    // FOLDED INTO admin. `foresight-admin.<apex>` no longer exists — the panel is a nested route
    // inside the operator console (`admin-web/src/app.tsx`, `path="foresight"`, index = the queue),
    // and this entry would otherwise probe a hostname nothing serves and fail the release gate.
    key: 'admin-foresight',
    subdomain: 'admin',
    path: '/foresight',
    // NOW 'shows-the-account', where the old entry deliberately refused to require a session.
    // Its reason was specific and is gone: the cross-origin handoff to a separate console "was
    // observed to work on one run and not on the next", and an assertion that is sometimes right
    // teaches people to re-run. There is no handoff any more — this is the same origin as the rest
    // of the console, reached behind the same `ProtectedRoute`. So the stronger assertion is now
    // the honest one, and it matches the `admin` entry above: an operator surface that renders
    // while signed out is either broken or a hole.
    session: 'shows-the-account',
    renders: [/Idea queue/i, /Markets/i],
  },
  {
    key: 'emberkin',
    subdomain: 'emberkin',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Emberkin|Warden|Kin/i, /Dex/i],
    // The ONE allowance in this file, and it was checked on both sides rather than taken from a
    // report. Read `ContractualEmpty` before adding a second.
    contractual: [
      {
        path: '/v1/saves/me',
        status: 404,
        why:
          'a player who has never started a game HAS no save, and the service says so with a 404: ' +
          '`emberkin/src/server.ts:340` returns `not_found` "no save for this account". The client ' +
          'already treats it as the ordinary first visit — `emberkin-web/src/lib/emberkin.ts:205` ' +
          'catches exactly this and returns `null` so the title screen renders — and its own ' +
          'comment draws the line this allowance copies: "every OTHER 404 from this base would be ' +
          'a routing bug and is still thrown". The smoke tier sees a failed request and cannot ' +
          'tell 404-as-empty from 404-as-routing-bug, so it was calling a correct application ' +
          'broken. The account this suite signs in as is an operator, not a player; it will never ' +
          'have a save, so this is the state it observes on every run.',
      },
    ],
    // Emberkin's art is baked into the image rather than mounted, so it has never been missing.
    // Declared anyway, because "baked in" is a property of today's Dockerfile: the day somebody
    // moves this set to a volume — which is what `tessera-web` did — the failure is silent in
    // exactly the same way, and this is the line that would go red instead.
    imagery: [
      {
        path: '/art/species/cindercub-256x256.png',
        why:
          'the dex grid is fifty of these and renders nothing without them. A thumbnail rather ' +
          'than a portrait because the thumbnail is what a first visit actually loads.',
      },
      {
        path: '/art/title/wordmark-1024x384.png',
        why: 'the credits page renders it as the product\'s own name; a hole there is the brand missing.',
      },
    ],
  },
  {
    key: 'aetherholm',
    subdomain: 'aetherholm',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Archipelago/i, /Chronicle/i],
    /*
     * THE SECOND HALF OF THE 2026-08-05 AUDIT, AND THE ONE THAT HAD NOTHING TO GUARD YET.
     *
     * `micro-aetherholm-assets` produced 101 FLUX 2 Pro images and `aetherholm-web` referenced
     * NONE of them — no `<img>`, no `background-image`, no fetch (micro-org#175). That is the
     * other failure mode this tier was written for and the milder one: Tessera served art that
     * 404'd, Aetherholm served none at all, and both render a product that looks like a
     * spreadsheet while every check stays green. The audit's own closing line asked for this
     * entry "the moment its art is wired". It is wired; here it is.
     *
     * Five declarations for seventy-four served pictures, chosen so that each names a DIFFERENT
     * directory under the one `public/art/` copy. One would prove the mount exists; five prove it
     * is whole, which is the failure that actually happens — a `.dockerignore` or a COPY that
     * takes some subdirectories and not others leaves a product that works everywhere the
     * developer looked.
     *
     * Declared, never constructed. Every path below is spelled exactly as `MANIFEST.json` spells
     * it, including the `-<w>x<h>` suffix that is part of the filename rather than a convention —
     * see `RequiredImage` for why a declared name that has drifted is safe and a constructed one
     * is not.
     */
    imagery: [
      {
        path: '/art/title/wordmark-1024x384.png',
        why:
          "the title strip under the shared bar, on EVERY route. The company bar marks `worlds` " +
          'current because a title is played through Forge Worlds, so this wordmark is the only ' +
          'place any screen says which game the player opened — a hole here is the product ' +
          'nameless. It is also the one image `index.html` preloads.',
      },
      {
        path: '/art/keyart/hero-1920x768.png',
        why:
          'the hero of `/chronicle`, which is this game\'s ONLY anonymous surface — every other ' +
          'route is behind ProtectedRoute. It is therefore the one page a signed-out stranger ' +
          'can be shown, and the only in-page picture this tier could observe without a session.',
      },
      {
        path: '/art/buildings/skyhall-512x512.png',
        why:
          'one of the twenty building sprites, which are the art in this client that is CONTENT ' +
          'rather than decoration: /cities renders a city as its buildings. `skyhall` because it ' +
          'is the first type in `aetherholm/src/content.ts` and every city has one.',
      },
      {
        path: '/art/icons/resource-aether-512x512.png',
        why:
          "the Aether row of the stocks table, on the screen a player spends the game looking at. " +
          'A different directory from the sprites above, which is the point of declaring both.',
      },
      {
        path: '/art/islands/highwind_reef-1024x1024.png',
        why:
          'one of the twelve island archetypes shown beside the selected island on the map. The ' +
          'heaviest directory in the set at 7 MB, so it is the first thing a size-conscious ' +
          'change would drop from the image — and the last anybody would notice, since the map ' +
          'is SVG and would keep drawing.',
      },
    ],
  },
  {
    key: 'tessera',
    subdomain: 'tessera',
    path: '/',
    session: 'does-not-have-to',
    renders: [/Wards/i, /Kiln/i],
    // THE DEFECT THIS ENTRY IS WRITTEN FROM. `docker-compose.estate.yml` binds
    // `estate/world-assets` at `/usr/share/nginx/html/world-assets`; on 2026-08-05 that directory
    // held one README on BOTH networks, so the receipt 404'd, `loadAssetSet` returned `absent`,
    // and every one of the 392 sprites was a named hole in a canvas. Nothing anywhere went red.
    imagery: [
      {
        path: '/world-assets/SET.json',
        why:
          'the mount\'s own receipt, written by `tessera-assets/materialise.py`. `asset-set.ts` ' +
          'reads it BEFORE any sprite request, so a 404 here is not one missing picture — it is ' +
          'the whole world, resolved to `absent` in a single request. It is JSON rather than an ' +
          'image, so it is fetched and parsed rather than decoded.',
      },
      {
        path: '/world-assets/tiles/ashfield-ground-a-256x128.png',
        why:
          'one real sprite, decoded, to prove the mount holds BYTES and not just a receipt. A ' +
          'ground tile because ground is drawn first and its absence is the whole floor. The ' +
          '`-256x128` suffix is the delivered geometry `project_iso.py` produced and is part of ' +
          "the filename in `MANIFEST.json`; it is declared here, never constructed — see " +
          '`RequiredImage` for why those are different things.',
      },
    ],
  },
]

/**
 * The hostname a surface is served on, in an environment. `hub` + `` -> `hub.<apex>`; `hub` +
 * `testnet` -> `hub-testnet.<apex>`; the apex surface -> `<apex>` and `testnet.<apex>`.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN ENVIRONMENT IS A SUFFIX ON THE SUBDOMAIN. IT WAS AN APEX, AND THAT SHAPE WAS UNREACHABLE.**
 *
 * Until 2026-08-05 an environment was named by handing this suite a different apex —
 * `--apex testnet.cloudsforge.online`, composing `hub.testnet.cloudsforge.online`. Cloudflare's
 * Universal SSL certificate is `*.cloudsforge.online` plus the apex, a wildcard matches exactly
 * ONE label, and so every two-label name failed the TLS handshake at Cloudflare's edge before a
 * request reached the estate. Testnet was configured and publicly unreachable, and this suite —
 * whose one job is to notice — could not have told anyone, because it would have died in
 * `estateReachable` with "nothing is serving TLS".
 *
 * Advanced Certificate Manager covers two labels, is paid, and is not bought. So the environment
 * moved inside the FIRST LABEL, both environments now share the zone, and `--apex` alone can no
 * longer name one: `cloudsforge.online` is mainnet in both directions. `--env` is what names it.
 *
 * The apex surface — this estate's marketing site, whose registry subdomain is the empty string —
 * takes the environment label ALONE, because `-testnet.cloudsforge.online` is not a legal DNS
 * label. That is the same rule `envLabel()` implements in `ui/packages/ui/src/surfaces.ts` and
 * `CF_SITE_HOST` carries in `deploy/compose/env/traefik.testnet.env`.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function surfaceHost(apex: string, subdomain: string, env = ''): string {
  const label = env === '' ? subdomain : subdomain === '' ? env : `${subdomain}-${env}`
  return label === '' ? apex : `${label}.${apex}`
}

/** `https://hub.apex/path`, or `https://apex/path` for the apex surface. */
export function surfaceUrl(apex: string, surface: SmokeSurface, env = ''): string {
  const host = surfaceHost(apex, surface.subdomain, env)
  return `https://${host}${surface.path.startsWith('/') ? surface.path : `/${surface.path}`}`
}

/**
 * Every hostname the suite will speak TLS to, for `collectPins`. DEDUPED, because a hostname can
 * now carry more than one surface: the Foresight operator panel was folded into `admin` as a
 * nested route, so `admin` and `admin-foresight` are two surfaces on one host. A certificate
 * belongs to the host, not to the section, so pinning it twice would just do the work twice.
 */
export function smokeHosts(apex: string, env = ''): readonly string[] {
  const hosts = SMOKE_SURFACES.map((s) => surfaceHost(apex, s.subdomain, env))
  return [...new Set(hosts)]
}

/* ------------------------------------------------------------------ what a page did */

/**
 * Everything one page visit produced, as data.
 *
 * A plain record with no browser in it, so every assertion below is a pure function of it and can
 * be proved — including proved to FAIL — in a checkout with no Chromium and no estate. The
 * fixtures in `smoke.test.ts` are transcriptions of what the real estate actually returned, so the
 * suite's own red is reproducible after the estate is fixed.
 */
/**
 * One `<img>` the surface rendered, as the browser found it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **WHY THIS IS NOT "AN `<img>` TAG EXISTS".**
 *
 * On 2026-08-05 the estate was audited for missing imagery and the answer was that Tessera served
 * 392 generated sprites to nobody: the mount `docker-compose.estate.yml` binds at
 * `/usr/share/nginx/html/world-assets` held one README, every sprite request 404'd on BOTH
 * networks, and every check in the estate was green. The tags were all there. The pictures were
 * not. A check that counts tags would have passed for as long as the defect lasted, which is the
 * shape of defect this repository exists to refuse.
 *
 * So the recorded fact is `naturalWidth`, read off the page's own tag after the network went
 * quiet. It is non-zero only once Chromium's decoder has accepted the bytes, so one number
 * simultaneously says the URL resolved, the response was an image, it was not truncated, and
 * `nosniff` did not make the browser refuse it. `mediajourneys.ts` reasons the same way about
 * uploads; this applies it to what a surface serves.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ImageOnPage {
  /**
   * The `src` ATTRIBUTE, exactly as authored. Empty when the tag has none.
   *
   * The attribute rather than the property, because `img.src` resolves `src=""` against the
   * document and hands back the page's own URL — which would have made a sourceless tag
   * indistinguishable from a working one. This is the field that separates "never had an image"
   * from "has one that fails to load", and those two have different fixes.
   */
  readonly src: string
  /** What the browser is actually showing, resolved. Empty when it never picked a candidate. */
  readonly currentSrc: string
  /** Chromium's decoded width. Zero means the reader has no picture, whatever the markup says. */
  readonly naturalWidth: number
  /** Whether the browser finished trying. False on a lazy tag below the fold, which is not a fault. */
  readonly complete: boolean
  /** `loading`. `lazy` and incomplete is a deferred fetch, not a broken image. */
  readonly loading: string
  /** `alt`. Never asserted on — it is in the message, because it names what the reader lost. */
  readonly alt: string
}

export interface PageObservation {
  readonly surfaceKey: string
  readonly url: string
  /** The document's own status. `null` when the navigation never produced a response at all. */
  readonly status: number | null
  /**
   * Why the navigation threw, when it did.
   *
   * A refused connection, a DNS answer nobody serves, or a certificate the pin did not excuse.
   * Carried as a field rather than thrown, so one dead surface reports itself and the other
   * fifteen are still visited — a suite that stops at the first failure finds one defect per run.
   */
  readonly navigationError: string | null
  readonly bodyText: string
  /** `body`'s computed background. `rgba(0, 0, 0, 0)` means the surface's stylesheet did not apply. */
  readonly backgroundColor: string
  /** Carried for the message only. Never asserted on — see `dom.d.ts`. */
  readonly fontFamily: string
  /** The text of every `*-state--failed` / `*-state--forbidden` node on the page. */
  readonly failureStates: readonly string[]
  /** Every `<img>` the surface rendered. Empty is legitimate — most surfaces render no image. */
  readonly images: readonly ImageOnPage[]
  /** One entry per `SmokeSurface.imagery` declaration, resolved in the browser. */
  readonly requiredImages: readonly ResolvedImage[]
  readonly collected: Collected
}

/**
 * What the browser made of one {@link RequiredImage}.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE URL IS ABSOLUTE, BUILT FROM THE SURFACE'S OWN ORIGIN, AND THAT IS NOT A DETAIL.**
 *
 * The first version of this fetched the declared PATH relative to whatever document the page was
 * showing. It reported emberkin's entire art set as 404 on mainnet and unreachable on testnet, and
 * both readings were wrong: an unauthenticated visit to `emberkin.<apex>` is redirected to
 * `hub.<apex>/account/login`, so by the time the probe ran the document's origin was `hub`, and
 * the check was asking the wrong host for a file it does not have.
 *
 * That is a false RED, which is worse than it sounds — a tier that cries wolf about missing art is
 * a tier that gets ignored the week the art really is missing. So the origin is computed from the
 * surface rather than read from the page, and it cannot drift with a redirect.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface ResolvedImage {
  /** The declared path. */
  readonly path: string
  /** How it was resolved. See {@link resolveImagery} for why the two differ. */
  readonly kind: 'image' | 'receipt'
  /** A receipt's response status. Always `null` for an image — see `kind`. */
  readonly status: number | null
  /** An image's decoded width; `0` means the browser has no picture. `null` for a receipt. */
  readonly naturalWidth: number | null
  /** A receipt's body parsed as JSON. `null` for an image. */
  readonly parsed: boolean | null
  /** Why the browser could not get it. `null` when it did. */
  readonly error: string | null
}

export interface Finding {
  readonly surfaceKey: string
  readonly check: string
  readonly detail: string
}

/**
 * Console errors are FATAL here, and they are not in `assertClean`. Both are correct.
 *
 * `assertClean` serves declared journeys that run every five minutes for years, and its reasoning
 * holds for that: third-party widgets and extensions produce console errors, and a journey that
 * fails on any `console.error` fails for ever for reasons nobody owns.
 *
 * This tier is different in the two ways that reverse the answer. It runs against an estate we
 * control, in a clean profile with no extensions, on demand rather than on a schedule — and the
 * brief it was written to is explicit that "no console errors and no failed network requests on
 * each page… alone would have caught both defects". It is true: the Worlds registry defect
 * announces itself as a CORS console error before it is anything else.
 *
 * Named as a constant rather than left implicit, so that the day somebody wants to relax it they
 * have to delete a paragraph that says why they should not.
 */
export const SMOKE_CONSOLE_IS_FATAL = true

/** Transparent. The value Chromium reports for a `body` nothing painted. */
export const UNPAINTED_BACKGROUND = 'rgba(0, 0, 0, 0)'

/**
 * Every way this page visit failed. Empty means the surface works.
 *
 * Returns ALL of them rather than the first, because a surface with a 404 and a failure state and
 * a missing stylesheet is three defects, and reporting one at a time turns one afternoon into
 * three.
 */
/**
 * The top of the page, collapsed onto one line.
 *
 * Quoted into the `concludes` finding rather than left out, because "reached no verdict" is not
 * actionable on its own and "it says: Not determined — we cannot currently determine status" sends
 * the reader straight to the projection. Bounded, because a body is a whole page.
 */
function excerpt(bodyText: string, max = 240): string {
  const line = bodyText.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export function checkSurface(
  observation: PageObservation,
  surface: SmokeSurface,
  handle: string,
): readonly Finding[] {
  const findings: Finding[] = []
  const at = (check: string, detail: string): void => {
    findings.push({ surfaceKey: observation.surfaceKey, check, detail })
  }

  if (observation.navigationError !== null) {
    at('the document answers', `${observation.url} could not be loaded: ${observation.navigationError}`)
  } else if (observation.status === null) {
    at('the document answers', `${observation.url} produced no response at all`)
  } else if (observation.status !== 200) {
    at('the document answers', `${observation.url} answered HTTP ${observation.status}`)
  }

  const rendered = assertRendered(observation.bodyText, observation.collected, observation.url)
  if (!rendered.ok) at('the application mounted', rendered.reason)

  if (observation.backgroundColor === UNPAINTED_BACKGROUND) {
    at(
      'the page is painted',
      `${observation.url} rendered with a transparent body background and fell back to ` +
        `"${observation.fontFamily}" — the surface's own stylesheet did not apply, so a reader ` +
        'sees unstyled markup on white',
    )
  }

  if (observation.failureStates.length > 0) {
    at(
      'no error state on screen',
      `${observation.url} is showing ${observation.failureStates.length} failure state(s) from ` +
        `its own design system: ${observation.failureStates.slice(0, 3).join(' | ')}`,
    )
  }

  // ── THE ALLOWANCE LIST, AND THE HOST IT IS BOUND TO ────────────────────────────────────────
  //
  // This used to pass NO expected failures, with the note that "a smoke run has no refusal
  // scenarios, so there is nothing legitimate for it to excuse". That was right about refusal
  // scenarios and wrong about one thing: a surface whose API answers 4xx for the EMPTY case is not
  // refusing anything, and the tier was reporting a correct application as broken. `emberkin`'s
  // `/v1/saves/me` is the case, and the only one.
  //
  // The host is filled in HERE, from the page's own observed origin, rather than written into
  // `SMOKE_SURFACES`. Two reasons and both matter: the surface list deliberately does not record
  // the apex ("so that pointing this suite at staging is a variable rather than an edit"), and
  // binding the allowance to the origin the browser actually loaded means it cannot excuse the
  // same path on nimbus, on lantern or on the gateway — which is what a path-only allowance would
  // have done across six hosts.
  //
  // A malformed observation URL yields NO allowances rather than unbound ones: if the origin
  // cannot be established, neither can the narrowness, and the honest answer is to check
  // everything.
  let ownHost: string | null = null
  try {
    ownHost = new URL(observation.url).host
  } catch {
    ownHost = null
  }
  const expected =
    ownHost === null
      ? []
      : (surface.contractual ?? []).map((c) => ({ path: c.path, status: c.status, host: ownHost }))
  const clean = assertClean(observation.collected, observation.surfaceKey, expected)
  if (!clean.ok) at('nothing failed on the wire', clean.reason)

  // The SAME allowance, applied to the console. An excused 4xx produces two signals — a failed
  // request and a `Failed to load resource … status of 404` line — and honouring one without the
  // other leaves the surface red for the exchange that was just established to be correct. The
  // suppression is bound to the same (host, path, status) triple, so it can never cover more here
  // than it does on the wire, and a console line naming no resource is never touched.
  const consoleErrors = unexpectedConsoleErrors(observation.collected.consoleErrors, expected)
  if (SMOKE_CONSOLE_IS_FATAL && consoleErrors.length > 0) {
    at(
      'no console error',
      `${observation.url} logged ${consoleErrors.length} console error(s): ` +
        consoleErrors.slice(0, 3).join(' | '),
    )
  }

  for (const pattern of surface.renders) {
    if (!pattern.test(observation.bodyText)) {
      at(
        'the surface renders its own words',
        `${observation.url} never rendered ${String(pattern)} — this hostname is not serving the ` +
          `${surface.key} bundle, or the bundle is not showing its own page`,
      )
    }
  }

  // The page did its job, or it did not. See `SmokeSurface.concludes`: this is the only check
  // here that reads what the page CONCLUDED rather than whether it broke, and it exists because a
  // status page that cannot determine status is indistinguishable from a healthy one to every
  // other check in this function.
  if (surface.concludes !== undefined && !surface.concludes.some((p) => p.test(observation.bodyText))) {
    at(
      'the page reaches its verdict',
      `${observation.url} reached none of the conclusions this surface exists ` +
        `to reach (${surface.concludes.map(String).join(', ')}). What it says instead is: ` +
        `"${excerpt(observation.bodyText)}"`,
    )
  }

  // ── IMAGERY ────────────────────────────────────────────────────────────────────────────────
  //
  // Two findings, because there are two defects and they are repaired differently. A tag with no
  // `src` is a surface that was never given a picture; a tag whose picture did not decode is a
  // surface whose picture is not being served. Reporting them under one name sent the 2026-08-05
  // audit looking for a missing generation run when the assets had existed for days and the mount
  // was empty.
  //
  // A lazy tag that has not finished is neither: `loading="lazy"` defers below-the-fold images by
  // design, and `emberkin`'s dex grid, `market`'s gallery and `foresight`'s market image all use
  // it. Going red on those would be this tier failing a surface for being fast.
  const sourceless = observation.images.filter((image) => image.src.trim() === '')
  if (sourceless.length > 0) {
    at(
      'every image has a source',
      `${observation.url} rendered ${sourceless.length} <img> tag(s) with no src attribute — ` +
        'the markup reserves the space and no file was ever wired to it: ' +
        sourceless
          .slice(0, 3)
          .map((image) => `alt="${image.alt}"`)
          .join(' | '),
    )
  }

  // The declared half. See `SmokeSurface.imagery`: this is the one that catches a product whose
  // pictures never become `<img>` tags, which is the shape the 2026-08-05 defect actually had.
  for (const resolved of observation.requiredImages) {
    if (resolved.error !== null) {
      at(
        'the art this product needs is served',
        `${observation.url} could not fetch ${resolved.path} from its own origin: ${resolved.error}`,
      )
    } else if (resolved.kind === 'receipt' && resolved.status !== 200) {
      at(
        'the art this product needs is served',
        `${observation.url} answered HTTP ${resolved.status} for ${resolved.path} — this product ` +
          'declares it as art it cannot work without, so the mount is unpopulated or unrouted',
      )
    } else if (resolved.parsed === false) {
      at(
        'the art this product needs is served',
        `${observation.url} served ${resolved.path} with a 200 and a body that is not readable ` +
          'JSON — the receipt the client reads before any picture is not a receipt',
      )
    } else if (resolved.kind === 'image' && resolved.naturalWidth === 0) {
      at(
        'the art this product needs is served',
        `${observation.url} declares ${resolved.path} as art it cannot work without, and the ` +
          'browser produced no picture from it — the path is unrouted, the mount is unpopulated, ' +
          'the bytes are not an image, or a Content-Type made nosniff refuse the estate\'s own file',
      )
    }
  }

  const broken = observation.images.filter(
    (image) =>
      image.src.trim() !== '' && image.naturalWidth === 0 && (image.complete || image.loading !== 'lazy'),
  )
  if (broken.length > 0) {
    at(
      'every image on the page loaded',
      `${observation.url} rendered ${broken.length} <img> tag(s) the browser could not decode — ` +
        'the file is missing, unroutable or not an image, and the reader sees a broken icon: ' +
        broken
          .slice(0, 3)
          .map((image) => `${image.src} (alt="${image.alt}")`)
          .join(' | '),
    )
  }

  if (surface.session === 'shows-the-account' && !observation.bodyText.includes(handle)) {
    at(
      'the session reached this surface',
      `${observation.url} rendered ${observation.bodyText.trim().length} characters and none of ` +
        `them is the handle "${handle}" — the browser signed in and this surface does not know it`,
    )
  }

  return findings
}

/* ------------------------------------------------------------------ driving it */

/** How many of each collector's entries had already been seen before a navigation. */
export interface SinkMark {
  readonly consoleErrors: number
  readonly pageErrors: number
  readonly failedRequests: number
  readonly observabilityFailures: number
  readonly requests: number
}

export function mark(collected: Collected): SinkMark {
  return {
    consoleErrors: collected.consoleErrors.length,
    pageErrors: collected.pageErrors.length,
    failedRequests: collected.failedRequests.length,
    observabilityFailures: collected.observabilityFailures.length,
    requests: collected.requests.length,
  }
}

/**
 * What happened SINCE a mark.
 *
 * One page is reused for all seventeen navigations, because that is what a session is: signing in
 * once and then walking the estate is the thing under test, and a fresh context per surface would
 * quietly delete the cross-origin half of it. The collectors are cumulative, so each surface is
 * judged on its own slice — without this, surface two inherits surface one's failures and every
 * report after the first is wrong.
 */
export function since(collected: Collected, at: SinkMark): Collected {
  return {
    consoleErrors: collected.consoleErrors.slice(at.consoleErrors),
    pageErrors: collected.pageErrors.slice(at.pageErrors),
    failedRequests: collected.failedRequests.slice(at.failedRequests),
    observabilityFailures: collected.observabilityFailures.slice(at.observabilityFailures),
    requests: collected.requests.slice(at.requests),
  }
}

/**
 * Read one page, having navigated to it.
 *
 * Nothing is mocked, nothing is fulfilled, and the only thing this waits for is the network going
 * quiet — best effort, because a surface that polls for ever never reaches `networkidle` and
 * waiting for it is a courtesy to a slow mount rather than a precondition of anything asserted.
 */
export async function visit(
  page: BrowserPage,
  collected: Collected,
  surface: SmokeSurface,
  apex: string,
  timeoutMs: number,
  env = '',
): Promise<PageObservation> {
  const url = surfaceUrl(apex, surface, env)
  const before = mark(collected)
  let status: number | null = null
  let navigationError: string | null = null
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    status = response === null ? null : response.status()
  } catch (err) {
    navigationError = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err)
  }
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})

  const read = await page
    .evaluate(() => ({
      bodyText: document.body?.innerText ?? '',
      backgroundColor: getComputedStyle(document.body).backgroundColor,
      fontFamily: getComputedStyle(document.body).fontFamily,
      failureStates: Array.from(
        document.querySelectorAll('[class*="state--failed"], [class*="state--forbidden"]'),
      ).map((node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 200)),
      // Read AFTER `networkidle` above, so a picture that was merely slow has already arrived and
      // only a picture that is not coming reads back as zero.
      images: Array.from(document.querySelectorAll('img')).map((node) => {
        const image = node as HTMLImageElement
        return {
          src: image.getAttribute('src') ?? '',
          currentSrc: image.currentSrc,
          naturalWidth: image.naturalWidth,
          complete: image.complete,
          loading: image.loading,
          alt: image.alt,
        }
      }),
    }))
    .catch(() => ({
      bodyText: '',
      backgroundColor: '',
      fontFamily: '',
      failureStates: [] as string[],
      images: [] as ImageOnPage[],
    }))

  // ── THE DECLARED ART, RESOLVED INSIDE CHROMIUM ─────────────────────────────────────────────
  //
  // In the page rather than from Node, for the reason `mediajourneys.ts` sets out about uploads:
  // a `fetch` from this process does not enforce CORS, does not carry the page's cookies, and does
  // not run the browser's image decoder. All three are what is under test. `createImageBitmap` is
  // the same call `tessera-web/src/lib/sprites.ts` makes, so a green here means the client's own
  // code path works, not that a file exists somewhere.
  // `url` and not `page.url()`: an unauthenticated visit to emberkin ends up on hub's sign-in, and
  // asking hub for emberkin's art reports a missing picture that is being served. See
  // `ResolvedImage`.
  const requiredImages = await resolveImagery(page, surface.imagery ?? [], new URL(url).origin)

  return {
    surfaceKey: surface.key,
    url,
    status,
    navigationError,
    bodyText: read.bodyText,
    backgroundColor: read.backgroundColor,
    fontFamily: read.fontFamily,
    failureStates: read.failureStates,
    images: read.images,
    requiredImages,
    collected: since(collected, before),
  }
}

/**
 * Fetch and decode each declared picture from the page's own origin.
 *
 * A path ending `.json` is a receipt and is PARSED; everything else is an image and is DECODED.
 * The distinction is on the extension rather than on a flag because a receipt that has become an
 * image, or the reverse, is a change somebody made on purpose and should have to say so here.
 *
 * Errors are carried, never thrown: one unreachable mount must not stop the other sixteen surfaces
 * being visited, which is the same rule `PageObservation.navigationError` follows.
 */
export async function resolveImagery(
  page: BrowserPage,
  imagery: readonly RequiredImage[],
  origin: string,
): Promise<readonly ResolvedImage[]> {
  if (imagery.length === 0) return []
  const wanted = imagery.map((i) => ({
    path: i.path,
    kind: (i.path.endsWith('.json') ? 'receipt' : 'image') as 'image' | 'receipt',
    url: `${origin.replace(/\/+$/, '')}${i.path}`,
  }))
  return await page
    .evaluate(
      async (targets: readonly { path: string; kind: 'image' | 'receipt'; url: string }[]) => {
        const out: {
          path: string
          kind: 'image' | 'receipt'
          status: number | null
          naturalWidth: number | null
          parsed: boolean | null
          error: string | null
        }[] = []
        for (const target of targets) {
          try {
            if (target.kind === 'receipt') {
              const res = await fetch(target.url)
              let parsed: boolean | null = null
              if (res.ok) {
                parsed = true
                try {
                  await res.json()
                } catch {
                  parsed = false
                }
              }
              out.push({ ...target, status: res.status, naturalWidth: null, parsed, error: null })
              continue
            }
            // An IMAGE ELEMENT, not `fetch` + `createImageBitmap`. An image load is not subject to
            // CORS for the purpose of rendering, so this reads the same answer whether or not the
            // page has been redirected to a sign-in on another host — and `naturalWidth` is still
            // Chromium's own decoder saying yes. `fetch` would have been blocked cross-origin and
            // reported a missing picture that is being served perfectly well.
            const width = await new Promise<number>((resolve) => {
              const image = new Image()
              image.onload = (): void => resolve(image.naturalWidth)
              image.onerror = (): void => resolve(0)
              image.src = target.url
            })
            out.push({ ...target, status: null, naturalWidth: width, parsed: null, error: null })
          } catch (err) {
            out.push({
              ...target,
              status: null,
              naturalWidth: null,
              parsed: null,
              error: String(err).slice(0, 200),
            })
          }
        }
        return out
      },
      wanted,
    )
    .catch((err: unknown) =>
      wanted.map((target) => ({
        path: target.path,
        kind: target.kind,
        status: null,
        naturalWidth: null,
        parsed: null,
        error: `the page could not be asked: ${String(err).slice(0, 160)}`,
      })),
    )
}

/* ------------------------------------------------------------------ the sign-in */

export interface Credentials {
  /** identity's field is `identifier`, and it takes an address OR a handle. It is not `email`. */
  readonly identifier: string
  readonly password: string
  /** What the signed-in estate must render. The evidence that a session exists at all. */
  readonly handle: string
}

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE SMOKE ACCOUNT IS FIXED AND ITS PASSWORD IS CONFIGURATION. THERE IS NO DEFAULT.**
 *
 * `BEACON_SMOKE_PASSWORD` used to fall back to a literal, described in both call sites as a
 * default rather than a secret because "this account exists only in a dev estate". It did not.
 * `deploy/scripts/estate-bootstrap.sh` carried the same literal as its `ADMIN_PASSWORD` default
 * and mainnet was bootstrapped without overriding it, so on 2026-08-09 that string authenticated
 * `estate-admin@example.test` against
 * `https://api.cloudsforge.online/v1/auth/login` and returned a token carrying
 * `roles: ["player","admin"]` — from a PUBLIC repository. micro-org#276 has the measurement, and
 * micro-deploy#13 rotated it. The rotated value exists only in the host's gitignored
 * `compose/estate/tokens.env`.
 *
 * So the fallback is gone, and it is NOT replaced by a generated secret. This is the one credential
 * in the browser tier that names an account somebody else created and that must still be there on
 * the next run: minting a fresh password per run would lock the smoke tier out of the only account
 * the gated consoles will open for. `fixtures.ts` generates, because the accounts it names it also
 * creates; this reads, because this one it does not.
 *
 * Returned rather than thrown, and shaped exactly like `estateReachable` below, because the two
 * callers need different things from the same answer: `beacon smoke` turns it into exit 2 ("the
 * command could not look"), and `smoke.test.ts` turns it into a failed assertion — but only after
 * it has established that there is an estate to look at, so CI, which has none, still skips.
 *
 * Deliberately NOT here: a deny-list refusing the published literal by name. `estate-bootstrap.sh`
 * refuses it there, at the only point where it could become an account's password again. Copying
 * the check into this repository would mean writing the published string back into a public
 * repository in order to guard against the published string, which is the defect wearing the
 * costume of the fix.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function smokeCredentials(
  env: NodeJS.ProcessEnv,
): { readonly ok: true; readonly credentials: Credentials } | { readonly ok: false; readonly reason: string } {
  // Read with NO `??` on this line, and that is a shape rather than a preference: CI greps for a
  // `??` next to this variable's name, because the defect was not a bad default — it was that a
  // default existed at all, and the next one would arrive looking exactly like the last one.
  // An exported-but-empty variable counts as unset: `export BEACON_SMOKE_PASSWORD=` in a shell
  // that lost its tokens.env is the commonest way to arrive here, and signing in with '' would
  // turn it into a 401 against the product.
  const password = env['BEACON_SMOKE_PASSWORD']
  if (password === undefined || password === '') {
    return {
      ok: false,
      reason:
        'BEACON_SMOKE_PASSWORD is not set, and there is no default. The smoke tier signs in as a ' +
        'FIXED estate account, so a generated secret would lock it out of that account on the ' +
        'next run — and the constant that used to be here was published (micro-org#276). The ' +
        "estate operator's password lives in the host's gitignored compose/estate/tokens.env as " +
        'ESTATE_ADMIN_PASSWORD; export it as BEACON_SMOKE_PASSWORD, together with ' +
        'BEACON_SMOKE_IDENTIFIER and BEACON_SMOKE_HANDLE if that account is not the default one.',
    }
  }
  return {
    ok: true,
    credentials: {
      // These two are identifiers, not secrets, and they keep their defaults: they name the
      // account `estate-bootstrap.sh` creates, and requiring them too would make the ordinary case
      // three variables to get right instead of one.
      identifier: env['BEACON_SMOKE_IDENTIFIER'] ?? 'estate-admin@example.test',
      password,
      handle: env['BEACON_SMOKE_HANDLE'] ?? 'estateadmin',
    },
  }
}

export interface SignInResult {
  readonly findings: readonly Finding[]
  /** Where the browser ended up. In the message when the assertion fails. */
  readonly landedAt: string
}

/**
 * Sign in, for real, through the page a person uses.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ASSERTION THE ESTATE DID NOT HAVE, AND THE ONE THAT MATTERED MOST.**
 *
 * The form is filled and submitted in a real browser, which means the request goes wherever the
 * bundle decides to send it, through whatever gateway routing exists, with whatever CORS the
 * services allow. That is the whole point: the defect that shipped was a gateway with no `/auth/*`
 * route at all, and NOTHING in the estate exercised the path from a form to identity and back.
 *
 * The last check is the one with teeth. Reaching a page is not a session: a sign-in that silently
 * failed leaves the browser on a form that looks fine. Landing off `/account` **and** rendering
 * the handle is a string the application can only have obtained from identity's answer.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function signIn(
  page: BrowserPage,
  collected: Collected,
  apex: string,
  credentials: Credentials,
  timeoutMs: number,
  env = '',
): Promise<SignInResult> {
  const url = `https://${surfaceHost(apex, 'hub', env)}/account/login`
  const findings: Finding[] = []
  const at = (check: string, detail: string): void => {
    findings.push({ surfaceKey: 'sign-in', check, detail })
  }
  const before = mark(collected)

  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded' })
    if (response === null) at('the sign-in page answers', `${url} produced no response at all`)
    else if (!response.ok()) {
      at('the sign-in page answers', `${url} answered HTTP ${response.status()}`)
    }
  } catch (err) {
    at('the sign-in page answers', `${url}: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    return { findings, landedAt: url }
  }
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})

  try {
    // BY NAME, which is the attribute hub-web's own inputs carry, and the one a form post would
    // use. `identifier`, not `email`: the field takes either an address or a handle, and a suite
    // that typed into `input[name=email]` would fail on a page that is working.
    await page.fill('input[name=identifier]', credentials.identifier)
    await page.fill('input[name=password]', credentials.password)
  } catch (err) {
    at(
      'the sign-in form is on screen',
      `${url} does not carry input[name=identifier] and input[name=password] ` +
        `(${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    )
    return { findings, landedAt: page.url() }
  }

  try {
    await page.click('button[type=submit]')
    await page.waitForURL((u) => !u.pathname.startsWith('/account'), { timeout: timeoutMs })
  } catch {
    at(
      'signing in leaves the sign-in surface',
      `the form was submitted with a correct credential and the browser is still at ${page.url()} ` +
        `after ${timeoutMs}ms — sign-in did not succeed`,
    )
  }

  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  const landedAt = page.url()
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')

  if (!text.includes(credentials.handle)) {
    at(
      'the estate renders the account that signed in',
      `${landedAt} rendered ${text.trim().length} characters and none of them is the handle ` +
        `"${credentials.handle}" — reaching a page is not a session`,
    )
  }

  const slice = since(collected, before)
  const clean = assertClean(slice, 'sign-in')
  if (!clean.ok) at('nothing failed on the wire while signing in', clean.reason)
  if (SMOKE_CONSOLE_IS_FATAL && slice.consoleErrors.length > 0) {
    at(
      'no console error while signing in',
      slice.consoleErrors.slice(0, 3).join(' | '),
    )
  }

  return { findings, landedAt }
}

/* ------------------------------------------------------------------ the run */

export interface SmokeConfig {
  readonly apex: string
  /**
   * The environment label, empty for the unadorned one. See {@link surfaceHost}: this is a suffix
   * on every surface's subdomain, NOT a prefix on `apex`, and it has to be a separate field
   * because since 2026-08-05 both environments are served on the same zone.
   */
  readonly env?: string
  readonly credentials: Credentials
  readonly browser: BrowserConfig
  /** A subset of `SMOKE_SURFACES`, for driving one surface while fixing it. Defaults to all. */
  readonly surfaces?: readonly SmokeSurface[]
}

export interface SmokeResult {
  readonly signIn: SignInResult
  readonly observations: readonly PageObservation[]
  readonly findings: readonly Finding[]
}

/**
 * Sign in once, walk every surface, and report everything wrong with all of them.
 *
 * `withPage` from `driver.ts` supplies the browser and the collectors — the same driver the
 * declared journeys use, so there is one implementation of "what did this page do wrong" and no
 * second one to drift.
 */
export async function runSmoke(config: SmokeConfig): Promise<SmokeResult> {
  const { withPage } = await import('./driver.ts')
  const surfaces = config.surfaces ?? SMOKE_SURFACES
  const env = config.env ?? ''
  return await withPage(config.browser, async (page, collected) => {
    const signInResult = await signIn(
      page,
      collected,
      config.apex,
      config.credentials,
      config.browser.timeoutMs,
      env,
    )
    const observations: PageObservation[] = []
    const findings: Finding[] = [...signInResult.findings]
    for (const surface of surfaces) {
      const observation = await visit(page, collected, surface, config.apex, config.browser.timeoutMs, env)
      observations.push(observation)
      findings.push(...checkSurface(observation, surface, config.credentials.handle))
    }
    return { signIn: signInResult, observations, findings }
  })
}

/**
 * Is the gateway there at all?
 *
 * Separate from the run and answered before it, so that "the estate is not running" and "the
 * estate is running and broken" are different sentences. The first is a skip with an address in
 * it; the second is the product being red. A suite that reported the first as the second would
 * teach people to ignore it.
 *
 * `fetch`, not a browser: this must answer in a second even where there is no Chromium, and the
 * question is only whether something is listening and speaking TLS.
 */
export async function estateReachable(
  apex: string,
  timeoutMs = 3_000,
  env = '',
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const { inspectCertificate } = await import('./estatecert.ts')
  const host = surfaceHost(apex, 'hub', env)
  try {
    await inspectCertificate(host, { timeoutMs })
    return { ok: true }
  } catch (err) {
    return {
      ok: false,
      reason:
        `nothing is serving TLS at ${host}:443 ` +
        `(${err instanceof Error ? err.message : String(err)}) — bring the estate up, or set ` +
        'BEACON_SMOKE_APEX / BEACON_SMOKE_ENV to an estate that is running',
    }
  }
}

/** Failures that came from the browser telemetry sink, kept visible and never counted. */
export function observabilityAside(observations: readonly PageObservation[]): readonly string[] {
  return observations
    .flatMap((o) => o.collected.observabilityFailures)
    .filter((r) => isObservabilitySink(r.url))
    .map((r) => `${r.failure} ${r.url}`)
}
