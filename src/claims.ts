/**
 * The eleven "one platform" claims, and what actually proves each one.
 *
 * `docs/ecosystem/01-product-vision.md` §2: "The test is not whether the products share a logo. It
 * is whether these eleven statements are true." `docs/ecosystem/17-definition-of-done.md` §7 turns
 * each into a demonstration — "a journey signing into all eight surfaces", "checked by a journey
 * that asserts the number, not the HTTP status", "the feed shows events sourced from at least six
 * different services".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS TABLE EXISTS SO THAT "WE HAVE ECOSYSTEM TESTS" CANNOT BE SAID WITHOUT NAMING WHICH ONES.**
 *
 * Both documents are prose, and prose about coverage rots faster than anything else in an estate:
 * 17 §7 says three of the eleven are true, 01 §2 says the same, and neither can tell you whether
 * the demonstration it names has ever been executed. Here the mapping is data, and
 * `claims.test.ts` enforces four things about it:
 *
 *   1. all eleven are present, numbered 1 to 11, with the vision's own wording;
 *   2. every journey a claim names exists in the registry this build ships;
 *   3. **a claim may not be marked `partly` or `proven` without naming at least one journey.** A
 *      row that claims coverage and cites nothing is the failure mode this whole file is for;
 *   4. a claim with no journey must carry a blocker, and a blocker must be specific enough to act
 *      on — it names a file, a variable or a route, not a mood.
 *
 * The scoreboard is therefore checkable rather than believed, and updating it is a code change a
 * reviewer sees.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## `proven` is a high bar and almost nothing clears it
 *
 * `proven` means: a declared journey asserts the demonstration 17 §7 names, in full, and it runs.
 * `partly` means a declared journey asserts a real part of it and the rest is named below.
 * `unproven` means no journey asserts any of it, and the blocker says why.
 *
 * Nothing is `proven` today. The nearest miss is claim 5 — the feed is real, the bus behind it is
 * real, and the demonstration asks for six distinct originating services on one timeline, which
 * needs six products a synthetic account can act in. That is a fact about the estate, not about
 * the harness, and it is written here as such rather than rounded up.
 */

import type { JourneyDefinition } from './journeys.ts'

export type Status = 'proven' | 'partly' | 'unproven'

export interface Claim {
  /** 1..11, in the order 01 §2 states them. Never renumbered. */
  readonly n: number
  /** The statement, in the vision document's own words. */
  readonly statement: string
  /** The demonstration 17 §7 names as the evidence. */
  readonly evidence: string
  readonly status: Status
  /** Journey names in this build's registry that move the claim. */
  readonly journeys: readonly string[]
  /** What the journeys do NOT yet prove, or why there are none. Specific enough to act on. */
  readonly gap: string | null
}

export const CLAIMS: readonly Claim[] = [
  {
    n: 1,
    statement: 'One account signs into everything, once.',
    evidence:
      'A journey signing into all eight surfaces from one session, with no second credential prompt.',
    status: 'partly',
    journeys: ['identity.handoff', 'ecosystem.one-account', 'browser.bj-acc-01', 'browser.bj-acc-03'],
    gap:
      'The HTTP half is proven: a handoff code is minted, redeemed once and refused the second ' +
      'time, and one access token resolves to the same subject in identity, hub-api and activity. ' +
      'A BROWSER can now sign in too, which is new and was checked by driving it rather than by ' +
      'reading: browser.bj-acc-01 registers through the page hub-web serves at ' +
      'hub.<apex>/account/register and lands on a surface rendering the account it created, and ' +
      'browser.bj-acc-03 proves a protected deep link survives the round trip. All three reasons ' +
      'recorded here previously are closed — /login is served, @cloudsforge/ui posts to ' +
      '/auth/handoff/redeem which identity serves, and IDENTITY_HANDOFF_ORIGINS is set in ' +
      'deploy/compose/docker-compose.estate.yml. What is still missing is the DEMONSTRATION ' +
      'ITSELF: it asks for one session crossing eight surfaces, and BJ-XS-01 — Hub to Worlds to ' +
      'Market with no second prompt — is unblocked and unimplemented in ' +
      'src/browser/journeys.ts, which names it in unimplemented(). One surface ' +
      'signing a browser in is not eight.',
  },
  {
    n: 2,
    statement: 'One identity — the same profile, handle and reputation everywhere.',
    evidence:
      'A profile change in Hub renders in Worlds, Market and Trade within the stated cache TTL, ' +
      'verified by journey.',
    status: 'partly',
    journeys: ['ecosystem.one-account'],
    gap:
      'What is proven is that the handle submitted at registration is the handle identity reports ' +
      'back, and that three services resolve one token to one subject. There is no profile beyond ' +
      'a handle to propagate, and no surface renders an identity in Worlds, Market or Trade, so ' +
      'the propagation half of the demonstration has nothing to observe.',
  },
  {
    n: 3,
    statement:
      'One wallet experience — the same receive, send and key screens whichever product you came from.',
    evidence:
      'Every product’s wallet link resolves to Hub’s wallet. Zero wallet screens outside hub-web — ' +
      'verified by route inventory.',
    status: 'unproven',
    journeys: [],
    gap:
      'THE PREMISE THAT STOOD HERE WAS FALSE AND IS CORRECTED: this row said "hub-web’s wallet ' +
      'page is read-only: no form, no button, no onClick, no mutation", which src/browser/' +
      'catalogue.ts had already disproved by driving it — the three mutations moved out of ' +
      'wallet.tsx into components/send.tsx, receive.tsx and keyexport.tsx, so a grep of the page ' +
      'still finds nothing while the screen renders all three. Send, receive and key-export ' +
      'screens DO exist, in hub-web. What is still unproven is the claim itself, which is that ' +
      'they are the SAME screens whichever product you came from: BJ-XS-03 is the scenario for ' +
      'it, it is unblocked, and src/browser/journeys.ts names it in unimplemented(). The ' +
      'route-inventory half is a tier-2 assertion and belongs in the frontend repositories.',
  },
  {
    n: 4,
    statement: 'One portfolio — a single number that is the truth about what you hold.',
    evidence:
      'Hub’s portfolio total equals the ledger’s summed liability for that user, checked by a ' +
      'journey that asserts the number, not the HTTP status.',
    status: 'partly',
    journeys: ['ecosystem.one-portfolio'],
    gap:
      'The journey asserts the number rather than the status, and asserts that hub’s two paths to ' +
      'it — the dashboard tile and the portfolio page, which have separate caches — agree on the ' +
      'whole payload including pricedAt. What it cannot do is compare that number with the ' +
      'ledger’s summed liability, because reading GET /accounts/:subject/balances needs a ' +
      'ledger:read token and beacon can hold none: IDENTITY_SERVICE_TOKEN_GRANTS in ' +
      'deploy/compose/docker-compose.estate.yml names thirteen services and beacon is not one, so ' +
      'POST /service-credentials answers 500 "no scopes are configured for service beacon". Nor ' +
      'can it give the account a non-zero holding, for the same reason — so the agreement is ' +
      'proved over the empty case.',
  },
  {
    n: 5,
    statement:
      'One activity history — every account, money, asset, game and governance event on one timeline.',
    evidence:
      'The feed shows events sourced from at least six different services, covering all sixteen ' +
      'categories in doc 04 §10.1.',
    status: 'partly',
    journeys: ['ecosystem.event-bus', 'ecosystem.one-activity'],
    gap:
      'The mechanism is proven end to end: a fact committed in identity reaches activity’s read ' +
      'model through the real outbox, the real signature and the real inbox, exactly once, in the ' +
      'right person’s feed and no one else’s — and hub-api serves the same record back byte for ' +
      'byte with the cursor unparsed. Six distinct originating services on one timeline is not, ' +
      'and cannot be until a synthetic account can act in six products; today a fresh account ' +
      'produces identity events only. identity.user.registered has no subscription row at all in ' +
      'the dev estate (only identity.session.created and identity.user.deleted do), which is worth ' +
      'raising on its own.',
  },
  {
    n: 6,
    statement: 'One internal economy — Shards and EMBER spend and earn identically in every product.',
    evidence:
      'A reward earned in a world is spent in Market, in one journey, with both legs visible as ' +
      'ledger postings.',
    status: 'unproven',
    journeys: [],
    gap:
      'There is no client for Ninety Days After and no join-a-world or complete-an-objective path ' +
      'a journey could drive (doc 22 §8.3), so nothing can earn. Spending needs a ledger:post ' +
      'credential beacon cannot hold — see claim 4.',
  },
  {
    n: 7,
    statement: 'Assets you create in one product are usable in the others.',
    evidence:
      'A Studio-generated asset is used as a token’s brand, listed in Market, and equipped in a world.',
    status: 'unproven',
    journeys: [],
    gap:
      'micro-studio exists and nothing fetches a brand kit: no page in mint-web calls it and there ' +
      'is no studio surface (doc 22 §8.3, and doc 05’s own table is wrong about this).',
  },
  {
    n: 8,
    statement: 'One set of notifications, with one preference page.',
    evidence:
      'One preference page governs delivery for every product; a critical security notification is ' +
      'delivered despite preferences.',
    status: 'unproven',
    journeys: [],
    gap:
      'notify has no entry in the surface registry, so cloudsforgeHosts() cannot produce a URL for ' +
      'it, and it is not one of hub-api’s upstreams — which is why the notifications tile is ' +
      'permanently unavailable (doc 22 §8.6). There is no preference page to govern anything.',
  },
  {
    n: 9,
    statement: 'One operator view — a support agent can answer any question from one place.',
    evidence:
      'An operator answers "where did this user’s money go" from admin-web alone, by correlation ' +
      'id, without a docker logs.',
    status: 'unproven',
    journeys: [],
    gap:
      'admin-web has eight routes and none of them is a support-lookup screen (doc 22 §8.4). The ' +
      'audit-by-correlation-id half exists as BJ-ADM-14 in the T3 catalogue and is blocked on a ' +
      'browser being able to sign in.',
  },
  {
    n: 10,
    statement: 'One financial source of truth that reconciles against the chain.',
    evidence:
      'Σ user liabilities = Σ custody assets = indexer-observed on-chain holdings, within the ' +
      'stated per-chain tolerance, continuously — and injected drift freezes the correct asset only.',
    status: 'unproven',
    journeys: [],
    gap:
      'ecosystem.trial-balance is written and tested and asserts the first third of this — the ' +
      'trial balance is exactly zero, over a journal that is not empty, which is the continuous ' +
      'gate 17 §8 names. It is NOT declared, because reading GET /trial-balance needs a ' +
      'ledger:read token and IDENTITY_SERVICE_TOKEN_GRANTS has no beacon entry. Adding one line ' +
      'there and setting BEACON_SERVICE_CREDENTIAL declares it. The custody and indexer thirds ' +
      'need more than a read token and are not written.',
  },
  {
    n: 11,
    statement: 'A third party can build on all of it.',
    evidence:
      'A third party builds a working integration against the sandbox using only public ' +
      'documentation, with no help.',
    status: 'unproven',
    journeys: [],
    gap:
      'devportal-web has keys, webhooks, OAuth, usage and organisations, and no sandbox screen ' +
      '(doc 22 §8.3). This claim is also the one no synthetic journey can ever fully answer: the ' +
      'demonstration is about a person with no help, which is a research question, not an ' +
      'assertion. The half a journey can hold is the sandbox being reachable and resettable.',
  },
]

/** Claims that name a journey. Used by the test that checks every name resolves. */
export function citedJourneys(): readonly string[] {
  return [...new Set(CLAIMS.flatMap((claim) => claim.journeys))].sort()
}

/**
 * The scoreboard, for the boot log.
 *
 * Emitted at startup on purpose: 17 §7's table says three of eleven are true and has said so
 * since it was written. A number in a log line beside a version tag is a number somebody reads.
 */
export function scoreboard(): { proven: number; partly: number; unproven: number } {
  return {
    proven: CLAIMS.filter((c) => c.status === 'proven').length,
    partly: CLAIMS.filter((c) => c.status === 'partly').length,
    unproven: CLAIMS.filter((c) => c.status === 'unproven').length,
  }
}

/** True when every journey a claim names is in `registry`. */
export function unresolvedJourneys(registry: readonly JourneyDefinition[]): readonly string[] {
  const known = new Set(registry.map((definition) => definition.name))
  return citedJourneys().filter((name) => !known.has(name))
}
