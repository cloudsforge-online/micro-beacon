/**
 * The tier-3 browser catalogue.
 *
 * `docs/ecosystem/22-browser-journeys.md` is the specification: 318 scenarios across three tiers,
 * and its §2.2 puts **tier 3 here** — the scenarios that need the dev estate, the frontends and a
 * sign-in surface, and which therefore cannot live in any one of the thirteen frontend
 * repositories that would each have to stand the estate up to run them. Tiers 1 and 2 stay beside
 * their bundles.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **EVERY T3 SCENARIO IS HERE. NONE OF THEM IS DECLARED AS A JOURNEY TODAY.**
 *
 * Those two sentences are not in tension; they are the whole design.
 *
 * `estate.ts` sets the rule this file inherits: only journeys that actually exercise something are
 * declared, because a declared-but-skipping journey refuses every release for ever and the gate
 * gets switched off, while a declared-but-faked one reports green and makes the gate a lie. Doc 22
 * §8.7 is the fact that applies it here — `deploy/compose/docker-compose.estate.yml` defines 22
 * domain services and **no frontend container at all**, so there is nowhere for a browser to point
 * a tab. Nothing in this catalogue can run until that changes.
 *
 * So the catalogue is **data**, and the declaration is **computed** from it: `journeys.ts` turns a
 * scenario into a `JourneyDefinition` only when the scenario carries no permanent blocker AND
 * every surface it needs has an address. Today that is the empty set, and the empty set is the
 * honest answer. The day a compose profile serves the bundles behind the gateway and
 * `BEACON_TARGETS` names them, six scenarios declare themselves with no code change; the other
 * eighty name what they are still waiting for.
 *
 * That is the difference between a stated gap and an absence somebody has to notice.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## The layer boundary (doc 22 §3), enforced rather than advised
 *
 * A browser scenario may never assert a business rule. The reason is a real incident: a game
 * client withheld four SKUs from its UI while the payment routes stayed live and chargeable, and a
 * client-side test asserting "the four SKUs are not shown" would have passed, green, against the
 * defect — because the defect was that hiding them was the entire control.
 *
 * Advice does not survive a deadline, so every scenario carries two fields and `catalogue.test.ts`
 * fails the build without them:
 *
 *   * `asserts` — `presentation`, `client-request` or `navigation`, and nothing else. There is no
 *     `absence` kind: a scenario that would assert something is NOT on screen must instead assert
 *     the positive presentation fact, or it is not a browser scenario.
 *   * `ownedBy` — required whenever the outcome depends on a server-side rule. Not a description;
 *     a path, resolvable by grep, in the service that enforces the rule.
 *
 * ## Where this deviates from doc 22, and why
 *
 * Doc 22 marks 48 of its 318 scenarios ⛔. Its §8.1 also says, in prose, that "the whole of doc 05
 * §1.1 and journey 2 is unrunnable in a browser, **and so is every scenario downstream of a
 * session**" — which is a wider set than the rows it actually marked. BJ-ACC-09, BJ-ACC-12,
 * BJ-ACC-13, BJ-WAL-01, BJ-DSH-01 and a dozen others are unmarked rows that need a browser to be
 * signed in, which needs a page that does not exist. Those are blocked here, each saying so in its
 * own reason, rather than being carried forward as runnable because a table cell was empty. A
 * scenario the catalogue calls runnable and the estate cannot run is the same lie in the other
 * direction.
 */

/** What a scenario is allowed to assert. Doc 22 §3.1. There is no fourth kind. */
export type Asserts = 'presentation' | 'client-request' | 'navigation'

/**
 * Whether the expected outcome is the estate REFUSING something.
 *
 * The meta-test keys off this: a scenario whose expected outcome is a 4xx, a refusal, a denial or
 * an absence, and which carries no `ownedBy`, fails the suite. The browser asserts the sentence
 * the user is shown; the refusal itself belongs to the service that enforces it.
 */
export type Outcome = 'positive' | 'refusal'

export interface Blocker {
  /** What is missing, in a sentence somebody could act on. */
  readonly reason: string
  /** The section of doc 22 that records it. */
  readonly doc: string
}

export interface Scenario {
  /**
   * Stable, and never renumbered. A renamed scenario abandons its metric history — the same rule
   * beacon already applies to step names.
   */
  readonly id: string
  /** The catalogue group, as doc 22 §6 names it. */
  readonly group: string
  readonly title: string
  readonly asserts: Asserts
  readonly outcome: Outcome
  /** ★ in doc 22: a release candidate does not promote until this is green. */
  readonly gate: boolean
  /**
   * What must be up, named the way `BEACON_TARGETS` names things.
   *
   * Surface keys (`hub`, `market`, `site`) and service names (`identity`, `hub-api`) share one
   * namespace on purpose: a browser journey resolves a surface's address exactly as an HTTP
   * journey resolves a service's, and neither this file nor `driver.ts` restates the surface
   * registry. `ui/packages/ui/src/surfaces.ts` carries its own header recording that the same
   * list was maintained by hand in eight places and had already drifted; a ninth copy here would
   * be that mistake made again in the one repository that is supposed to notice it.
   */
  readonly needs: readonly string[]
  /** The server-side test that owns the rule, when the outcome depends on one. */
  readonly ownedBy: string | null
  /** Non-null when the scenario cannot be written as code at all yet. */
  readonly blocked: Blocker | null
}

/* ------------------------------------------------------------------ the blockers, once each */

/*
 * ── THREE BLOCKERS ARE GONE, AND THEY WERE REMOVED BY DRIVING THEM, NOT BY READING ──────────────
 *
 * `NO_SIGNIN`, `EXCHANGE_ROUTE` and `SESSION_DOWNSTREAM` stood here and blocked forty-four of the
 * eighty-seven rows below. All three premises are now false, and each was checked in Chromium
 * against the running estate rather than against a document:
 *
 *   * NO_SIGNIN said "nothing in the estate serves a sign-in page… micro-identity renders no HTML
 *     at all". micro-ui added a `signin` registry row riding on Hub and micro-hub-web serves the
 *     page (`hub-web/src/pages/account.tsx`). Driven: `GET hub.<apex>/account/register` answers
 *     200 and renders the form; filling it and pressing Create account lands the browser on
 *     `hub.<apex>/` holding `cf.accessToken` and `cf.refreshToken`, with the handle rendered in
 *     the account menu.
 *
 *   * EXCHANGE_ROUTE said the shared UI posts to `${nimbus}/auth/exchange` while identity serves
 *     `/auth/handoff/redeem`. The UI was corrected — `ui/packages/ui/src/auth.test.ts` records
 *     the address that actually shipped and the correction — and `deploy/scripts/estate-verify.sh`
 *     drives the whole hand-off through the gateway: minted at Hub for Market, redeemed from
 *     Market's origin, refused from a foreign one.
 *
 *   * SESSION_DOWNSTREAM said "no page in the estate can sign a browser in", which is the same
 *     claim as NO_SIGNIN and falls with it. Driven twice more: a protected deep link
 *     (`hub.<apex>/security`) redirects to `/account/login?return=…`, and signing in there ARRIVES
 *     AT THE DEEP LINK rather than at the root — which is BJ-ACC-03 in full.
 *
 * Removing a blocker does NOT declare a journey. It moves the scenario from "cannot be written" to
 * "not written yet", which `journeys.ts`'s `unimplemented()` names one line at a time. That is the
 * distinction the whole file turns on, and it is why the removals are safe: nothing goes green
 * because of them.
 */

/*
 * ── A FOURTH BLOCKER IS GONE, AND IT WAS THE LARGEST ONE IN THE CATALOGUE ───────────────────
 *
 * `NO_WALLET_WRITE` stood here and blocked eleven of the rows below, and doc 22 §8.2 blocked six
 * more outside this file (BJ-ADV-20, BJ-ADV-21, BJ-A11Y-13, BJ-A11Y-14, BJ-XS-03 and the receive
 * pair). Its premise was: "hub-web's wallet page contains no form, no button, no onClick and no
 * mutation — it reads three tiles of /v1/dashboard."
 *
 * That premise is false, and the way it survived is worth recording because it will happen again.
 * A grep of `hub-web/src/pages/wallet.tsx` STILL finds no form and no button: the page was
 * refactored and its three mutations moved beside it into `hub-web/src/components/send.tsx`,
 * `receive.tsx` and `keyexport.tsx`. The claim was checked against the file it named rather than
 * against the screen, and the screen had changed.
 *
 * Driven in Chromium against the running estate before this was removed: `hub.<apex>/wallet`,
 * signed in, renders a Send panel with `#send-asset`, `#send-destination`, `#send-amount` and a
 * Review button; a confirmation step carrying `[data-testid=confirm-destination]`; a Receive panel
 * offering a deposit address; and a key-export panel. `walletjourneys.ts` drives all of it.
 *
 * Removing a blocker does NOT declare a journey — it moves a scenario from "cannot be written" to
 * "not written yet", which `unimplemented()` names one line at a time. Nothing goes green because
 * of this.
 *
 * What is NOT unblocked, and stays blocked with its own reason: the ceremony rows that need a
 * SECOND factor (`NO_MFA_UI`, still true — `hub-web/src/pages/security.tsx` renders "No second
 * factor is enrolled" and offers no enrolment, no recovery-code issue and no factor removal), and
 * the two reorg fixtures of doc 22 §8.8 which no estate can produce on demand.
 */

const NO_SETTLEABLE_ASSET: Blocker = {
  reason:
    'no asset in this estate can be withdrawn, so a send cannot be carried to settlement. ' +
    'micro-wallet quotes the network fee inside POST /v1/withdrawals and refuses rather than ' +
    'guessing when none is configured; WALLET_FEE_QUOTES appears nowhere in ' +
    'deploy/compose/docker-compose.estate.yml. Driven: EMBER answers 400 fee_unavailable and ' +
    'SHARD answers 400 not_withdrawable. The client-request half of the send flow IS runnable and ' +
    'is BJ-WAL-08; these are the rows that need a withdrawal to reach a state machine.',
  doc: '22 §8.2',
}

const NO_POLICY_ON_WITHDRAWAL: Blocker = {
  reason:
    'the withdrawal path consults no policy service, so there is no deny, challenge or review to ' +
    'render. grep policy over wallet/src/withdrawals.ts finds nothing, and the refusals it can ' +
    'produce are withdrawals_disabled, not_withdrawable, invalid_amount, fee_unavailable, ' +
    'amount_too_small and the ledger’s insufficient-funds. hub-web/src/components/send.tsx ' +
    'records the same finding: a limit panel here would be a screen for a decision nothing makes.',
  doc: '22 §8.2',
}

const NO_MFA_UI: Blocker = {
  reason:
    'micro-identity serves six MFA routes and hub-web renders mfaEnabled as a fact while offering ' +
    'no enrolment, no recovery-code issue and no factor removal.',
  doc: '22 §8.2',
}

/*
 * ── A FIFTH BLOCKER IS GONE, AND ITS PREMISE HAD BECOME FALSE RATHER THAN HAVING BEEN WRONG ──
 *
 * `NO_CUSTODY_ADDRESS` stood here and blocked BJ-WAL-16 and BJ-WAL-18. It said: "micro-custody
 * refuses to mint a deposit address for this estate… Driven: POST /v1/deposits on micro-wallet
 * answers 500 and the wallet log records CustodyRefusedError on POST http://custody:4000/
 * v1/addresses → 400."
 *
 * Every word of that was true when it was written, and it is the interesting case: this is not a
 * claim that was checked against the wrong thing, like `NO_WALLET_WRITE`. It was checked correctly,
 * against the running estate, and then the estate was FIXED — wallet never sent the `orderId`
 * custody requires and now does (`wallet/src/deposits.ts`, the block above `custody.createAddress`)
 * — and nothing anywhere re-asked the question. A blocker is a claim with a shelf life, and the
 * repair of the thing it describes is precisely the event that will not update it.
 *
 * Re-driven on 2026-08-04, through the gateway with a user's own token, before this was removed:
 *
 *   POST pay.<apex>/v1/deposits {"assetCode":"EMBER"}  →  201, with an address, a walletId, a
 *   custodyKeyUrn naming that address, status "active" and a non-null watchedAt.
 *   GET  vault.<apex>/v1/addresses/<that address>      →  200, purpose "deposit", scheme hd_bip44.
 *
 * So a managed wallet and an exportable key both exist for a journey to act on, and the premise is
 * gone. `ecosystem.deposit-address` in `../ecosystem.ts` now drives the HTTP half of this every
 * five minutes, which is what stops the same fact going stale a second time — a blocker removed by
 * hand is a claim; a journey is a check.
 *
 * Removing a blocker does NOT declare a journey. BJ-WAL-16 and BJ-WAL-18 move from "cannot be
 * written" to "not written yet", which `unimplemented()` names one line at a time. Nothing goes
 * green because of this.
 *
 * What stays blocked, and is a different claim from the one removed: BJ-WAL-19 needs a
 * notification surface (`NO_NOTIFY_UI`) and the export ceremony's SECOND-FACTOR steps still have
 * no screen (`NO_MFA_UI`) — but BJ-WAL-18 asserts the ten-stage refusal ordering rather than
 * enrolment, and its `ownedBy` already puts the rule in `custody/src/server.test.ts`.
 */

const NO_SIGNER: Blocker = {
  reason:
    'there is no signer in any CloudsForge bundle, so a challenge cannot be signed and an external ' +
    'wallet cannot be verified. hub-web says so on the page itself: "Forge Hub cannot ask a ' +
    'browser extension or a hardware wallet to sign anything — there is no signer in this ' +
    'application — so the flow has no screen here." The wallet service serves both halves.',
  doc: '22 §8.2',
}

const NO_STUDIO_UI: Blocker = {
  reason: 'micro-studio exists and no surface fetches a brand kit; there is no studio-web.',
  doc: '22 §8.3',
}

const NO_WORLD_CLIENT: Blocker = {
  reason:
    'worlds-web is a registry and account surface. There is no client for Ninety Days After, so ' +
    'joining a world and completing an objective cannot be driven.',
  doc: '22 §8.3',
}

const NO_SANDBOX_UI: Blocker = {
  reason: 'devportal-web has keys, webhooks, OAuth, usage and organisations, and no sandbox screen.',
  doc: '22 §8.3',
}

const NO_CONSOLE_SCREEN = (what: string): Blocker => ({
  reason: `admin-web has eight routes and none of them is a ${what} screen.`,
  doc: '22 §8.4',
})

const NO_COMMUNITY_UI: Blocker = {
  reason:
    'micro-community is built and tested — proposals, votes, delegations, tally, gating, ' +
    'executions — and nothing renders any of it.',
  doc: '22 §8.5',
}

const NO_NOTIFY_UI: Blocker = {
  reason:
    'notify has no entry in the surface registry, so cloudsforgeHosts() cannot produce a URL for ' +
    'it, and it is not one of hub-api’s upstreams. The notifications tile is permanently ' +
    'unavailable by construction.',
  doc: '22 §8.6',
}

/* ------------------------------------------------------------------ the catalogue */

const scenario = (
  id: string,
  group: string,
  title: string,
  asserts: Asserts,
  needs: readonly string[],
  extra: Partial<Pick<Scenario, 'gate' | 'outcome' | 'ownedBy' | 'blocked'>> = {},
): Scenario => ({
  id,
  group,
  title,
  asserts,
  outcome: extra.outcome ?? 'positive',
  gate: extra.gate ?? false,
  needs,
  ownedBy: extra.ownedBy ?? null,
  blocked: extra.blocked ?? null,
})

const A = 'A — account and session'
const B = 'B — wallet, deposits, withdrawals, key export'
const C = 'C — dashboard, portfolio, activity, access'
const D = 'D — Forge Create'
const E = 'E — Forge Market'
const F = 'F — Forge Trade'
const G = 'G — Forge Worlds'
const H = 'H — Emberkin'
const I = 'I — Aetherholm'
const L = 'L — the developer platform'
const M = 'M — the operator console'
const N = 'N — Forge Network: the site, the faucet, the explorer'
const J = 'J — Forge Foresight, the player surface'
const Q = 'Q — community and governance'
const R = 'R — cross-surface journeys'
const S = 'S — the adversarial matrix'

export const T3_SCENARIOS: readonly Scenario[] = [
  /* ---- group A */
  scenario('BJ-ACC-01', A, 'Register from the sign-in surface and land back with a session', 'presentation', ['account', 'site', 'identity'], { gate: true }),
  scenario('BJ-ACC-02', A, 'Register with a taken handle: inline error, other fields keep their values', 'presentation', ['account', 'identity'], { outcome: 'refusal', ownedBy: 'identity/src/server.test.ts' }),
  scenario('BJ-ACC-03', A, 'Sign in from a protected deep link and arrive at the deep link', 'navigation', ['account', 'identity', 'hub'], { gate: true }),
  scenario('BJ-ACC-04', A, 'SSO handoff: Hub to Worlds with no second credential prompt', 'client-request', ['account', 'identity', 'worlds'], { gate: true }),
  scenario('BJ-ACC-05', A, 'The handoff code is single-use: a replayed callback does not sign in', 'presentation', ['account', 'identity'], { outcome: 'refusal', ownedBy: 'identity/src/server.test.ts' }),
  scenario('BJ-ACC-09', A, 'Session expires mid-flow: the re-authentication path, no stale data left as current', 'presentation', ['identity', 'hub', 'hub-api'], { gate: true }),
  scenario('BJ-ACC-12', A, 'End one session from Security: the list reloads and that row is gone', 'presentation', ['identity', 'hub', 'hub-api'], {}),
  scenario('BJ-ACC-13', A, 'Sign out everywhere revokes the device performing it too', 'navigation', ['identity', 'hub', 'hub-api'], {}),
  scenario('BJ-ACC-15', A, 'MFA lockout: the recovery-code path and the no-codes path', 'presentation', ['account', 'identity'], { outcome: 'refusal', ownedBy: 'identity/src/mfa.test.ts', blocked: NO_MFA_UI }),

  /* ---- group B */
  scenario('BJ-WAL-01', B, 'Wallet page: one row per wallet, each matching the dashboard response', 'presentation', ['hub', 'hub-api', 'wallet', 'ledger'], { gate: true }),
  scenario('BJ-WAL-08', B, 'Send: the destination confirmed is the destination submitted, byte for byte', 'client-request', ['hub', 'hub-api', 'wallet', 'ledger', 'identity'], { gate: true, outcome: 'refusal', ownedBy: 'wallet/src/server.test.ts' }),
  scenario('BJ-WAL-09', B, 'Send: double-clicking Confirm sends exactly one request, under one key', 'client-request', ['hub', 'hub-api', 'wallet', 'ledger', 'identity'], { outcome: 'refusal', ownedBy: 'wallet/src/server.test.ts' }),
  scenario('BJ-WAL-12', B, 'Send: a policy deny is rendered as a reason, a limit and a route to raise it', 'presentation', ['hub', 'policy', 'wallet'], { outcome: 'refusal', ownedBy: 'policy/src/server.test.ts', blocked: NO_POLICY_ON_WITHDRAWAL }),
  scenario('BJ-WAL-13', B, 'Send: a policy challenge prompts MFA inline and continues', 'presentation', ['hub', 'policy', 'identity'], { outcome: 'refusal', ownedBy: 'policy/src/server.test.ts', blocked: NO_MFA_UI }),
  scenario('BJ-WAL-14', B, 'Send: a policy review is shown as queued with a turnaround, not as failed', 'presentation', ['hub', 'policy'], { outcome: 'refusal', ownedBy: 'policy/src/server.test.ts', blocked: NO_POLICY_ON_WITHDRAWAL }),
  scenario('BJ-WAL-15', B, 'Send: retrying a stuck withdrawal twice produces one in-flight outbound', 'client-request', ['hub', 'wallet'], { blocked: NO_SETTLEABLE_ASSET }),
  scenario('BJ-WAL-16', B, 'Receive: the address rendered is the address in the response', 'presentation', ['hub', 'wallet', 'custody'], {}),
  scenario('BJ-WAL-18', B, 'Key export ceremony, all ten stages, each refused until the previous completed', 'presentation', ['hub', 'custody', 'identity'], { gate: true, outcome: 'refusal', ownedBy: 'custody/src/server.test.ts' }),
  scenario('BJ-WAL-19', B, 'Key export: cancel from the notification link needs no MFA, at any point', 'navigation', ['hub', 'custody', 'notify'], { blocked: NO_NOTIFY_UI }),
  scenario('BJ-WAL-21', B, 'Connect an external wallet: the closed five authorisations, granted separately', 'client-request', ['hub', 'wallet'], { blocked: NO_SIGNER }),
  scenario('BJ-WAL-22', B, 'An unverified external address is not offered as a withdrawal destination', 'presentation', ['hub', 'wallet'], { outcome: 'refusal', ownedBy: 'wallet/src/server.test.ts', blocked: NO_SIGNER }),

  /* ---- group C */
  scenario('BJ-DSH-01', C, 'Hub overview with every upstream healthy: eleven tiles, total equals the sum', 'presentation', ['hub', 'hub-api', 'ledger', 'pricing', 'wallet', 'activity', 'billing', 'identity'], { gate: true }),
  scenario('BJ-DSH-17', C, 'Activity feed: the second page is appended and the cursor passed back unparsed', 'client-request', ['hub', 'hub-api', 'activity', 'ledger', 'identity'], { gate: true }),
  scenario('BJ-DSH-20', C, 'Activity shows events from at least six different services', 'presentation', ['hub', 'hub-api', 'activity'], {}),

  /* ---- group D */
  scenario('BJ-CRE-03', D, 'Launch: POST /v1/tokens lands on the order, in the state the response gave', 'navigation', ['create', 'mint', 'identity'], { gate: true }),
  scenario('BJ-CRE-04', D, 'Press Deploy: the page says accepted, never deployed', 'presentation', ['create', 'mint'], { gate: true }),
  scenario('BJ-CRE-05', D, 'The truth arrives by re-reading the order, not from the button’s response', 'presentation', ['create', 'mint', 'indexer'], {}),
  scenario('BJ-CRE-10', D, 'The ten-step launch flow, each step reachable from the previous', 'navigation', ['create', 'mint', 'studio', 'market'], { blocked: NO_STUDIO_UI }),

  /* ---- group E */
  scenario('BJ-MKT-03', E, 'Buy: the fee and royalty split are on screen before the button, and total matches', 'client-request', ['market', 'ledger'], { gate: true }),
  scenario('BJ-MKT-08', E, 'Two tabs, one listing, both press Buy: exactly one order, the loser sees the refusal', 'client-request', ['market', 'ledger'], { outcome: 'refusal', ownedBy: 'market/src/server.test.ts' }),
  scenario('BJ-MKT-12', E, 'Raise a dispute: the two visible facts, and no invented status', 'presentation', ['market'], {}),
  scenario('BJ-MKT-18', E, 'Moderate a fraudulent listing: indicators as facts, never an editorial score', 'presentation', ['admin', 'admin-api', 'market'], { blocked: NO_CONSOLE_SCREEN('moderation') }),

  /* ---- group F */
  scenario('BJ-TRD-02', F, 'Queue a backtest: the browser lands on the status page, which says it has not run', 'navigation', ['trade'], { gate: true }),
  scenario('BJ-TRD-03', F, 'The report replaces the status only when the run reports complete', 'presentation', ['trade'], {}),
  scenario('BJ-TRD-04', F, 'Another customer’s backtest id renders the not-found screen, not a permission error', 'navigation', ['trade'], { outcome: 'refusal', ownedBy: 'trade/src/server.test.ts' }),
  scenario('BJ-TRD-06', F, 'Create a bot: it is a draft, and the page states nothing is reserved', 'presentation', ['trade'], { gate: true }),
  scenario('BJ-TRD-12', F, 'Fee settlements: one row per settlement, no duplicate settlement id', 'presentation', ['trade', 'billing'], {}),
  scenario('BJ-TRD-13', F, 'Another customer’s bot id renders the owner-scoped not-found screen', 'navigation', ['trade'], { outcome: 'refusal', ownedBy: 'trade/src/server.test.ts' }),

  /* ---- group G */
  scenario('BJ-WLD-05', G, 'An unsupported provision: the service’s own sentence, UNDELIVERABLE, no retry control', 'presentation', ['worlds'], { gate: true, outcome: 'refusal', ownedBy: 'worlds/src/server.test.ts' }),
  scenario('BJ-WLD-08', G, 'Join a world, complete an objective, see the reward in Hub and spend it in Market', 'presentation', ['worlds', 'hub-api', 'market', 'ledger'], { blocked: NO_WORLD_CLIENT }),

  /* ---- group H */
  scenario('BJ-EMB-01', H, 'Play: the client posts an intent with an Idempotency-Key and animates the log', 'client-request', ['emberkin'], { gate: true }),
  scenario('BJ-EMB-11', H, 'Equip a cosmetic: the applied item changes no stat anywhere on the page', 'presentation', ['emberkin', 'billing'], {}),

  /* ---- group I */
  scenario('BJ-AET-03', I, 'A write answers: the server’s settled stocks replace the projection immediately', 'presentation', ['aetherholm'], { gate: true }),
  scenario('BJ-AET-10', I, 'Found an alliance against a community that already exists; no create-community button', 'client-request', ['aetherholm', 'community'], { gate: true }),
  scenario('BJ-AET-11', I, 'The alliance directory lists the world with the caller’s membership marked', 'presentation', ['aetherholm'], {}),

  /* ---- group L */
  scenario('BJ-DEV-03', L, 'Enrol an organisation: the screen does not mutate in order to read', 'client-request', ['developers', 'devplatform', 'identity'], {}),
  scenario('BJ-DEV-04', L, 'Create a project: a member sees the refusal in words, not a 403 dump', 'presentation', ['developers', 'devplatform'], { outcome: 'refusal', ownedBy: 'devplatform/src/server.test.ts' }),
  scenario('BJ-DEV-08', L, 'Reload after the once-modal: the key is listed, the secret is not, no show-again', 'presentation', ['developers', 'devplatform'], {}),
  scenario('BJ-DEV-09', L, 'Revoke a key: the row shows revoked and its usage history is retained', 'presentation', ['developers', 'devplatform'], {}),
  scenario('BJ-DEV-10', L, 'Rotate a webhook secret: the once-modal again, under one idempotency key', 'client-request', ['developers', 'devplatform'], { gate: true }),
  scenario('BJ-DEV-12', L, 'Register an endpoint, then read deliveries and retries with each outcome', 'presentation', ['developers', 'devplatform', 'notify'], {}),
  scenario('BJ-DEV-13', L, 'Disable and delete a webhook endpoint; both take effect on reload', 'presentation', ['developers', 'devplatform'], {}),
  scenario('BJ-DEV-14', L, 'Register an OAuth client: the secret goes through the once-modal, with a key', 'client-request', ['developers', 'devplatform'], { gate: true }),
  scenario('BJ-DEV-15', L, 'Quotas and usage render, and a quota raise is not offered', 'presentation', ['developers', 'devplatform'], { outcome: 'refusal', ownedBy: 'devplatform/src/server.test.ts' }),
  scenario('BJ-DEV-17', L, 'The sandbox leg: resettable state and testnet wallets from public docs alone', 'client-request', ['developers', 'devplatform'], { blocked: NO_SANDBOX_UI }),

  /* ---- group M */
  scenario('BJ-ADM-09', M, 'The approvals queue under each filter produces the rows the response contains', 'presentation', ['admin', 'admin-api'], {}),
  scenario('BJ-ADM-10', M, 'The action catalogue renders the blocked action and its reason', 'presentation', ['admin', 'admin-api'], { gate: true }),
  scenario('BJ-ADM-14', M, 'One correlation id returns every audit event across the services, with no free-text box', 'presentation', ['admin', 'admin-api'], { gate: true }),
  scenario('BJ-ADM-16', M, 'Lower an engagement policy: the write takes effect and names the approval', 'client-request', ['admin', 'admin-api', 'ledger'], {}),
  scenario('BJ-ADM-19', M, 'Set a feature flag: the form refuses locally with the same rules the service does', 'client-request', ['admin', 'admin-api'], { outcome: 'refusal', ownedBy: 'admin-api/src/server.test.ts' }),
  scenario('BJ-ADM-21', M, 'A stuck withdrawal: filter by state, sort by age, bump-fee or abandon with dual approval', 'client-request', ['admin', 'admin-api', 'wallet'], { blocked: NO_CONSOLE_SCREEN('withdrawals') }),
  scenario('BJ-ADM-22', M, 'A reconciliation drift alert freezes one asset and one operator cannot override it', 'presentation', ['admin', 'admin-api', 'ledger'], { outcome: 'refusal', ownedBy: 'ledger/src/reconcile.test.ts', blocked: NO_CONSOLE_SCREEN('reconciliation') }),
  scenario('BJ-ADM-23', M, 'A support agent answers a balance question from the console alone, with an audit record', 'client-request', ['admin', 'admin-api'], { blocked: NO_CONSOLE_SCREEN('support-lookup') }),

  /* ---- group N — the six that need no session */
  scenario('BJ-NET-09', N, 'Faucet refusal: the message shown is the limiter’s, verbatim', 'presentation', ['network', 'faucet'], { gate: true, outcome: 'refusal', ownedBy: 'faucet/src/server.test.ts' }),
  scenario('BJ-NET-14', N, 'The chains page renders one row per scope with the state its own index reports', 'presentation', ['explorer', 'indexer'], { gate: true }),
  scenario('BJ-NET-18', N, 'Reorgs render with their depth; a chain behind its tip states the lag', 'presentation', ['explorer', 'indexer'], {}),
  scenario('BJ-NET-20', N, 'Token supply and authorities are as the contract reports them, not as an order claims', 'presentation', ['explorer', 'indexer'], {}),
  scenario('BJ-NET-21', N, 'A block page renders height, hash and the transactions in it', 'presentation', ['explorer', 'indexer'], {}),

  /* ---- group J — Forge Foresight
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════
   * **DOC 22 TIERS FOUR OF THESE AT T1/T2. THEY ARE HERE, AND THE REASON IS NOT CONVENIENCE.**
   *
   * §4 puts a scenario at T1 when it needs "nothing but the bundle, a browser, and stubbed
   * responses", and at T2 when it needs the bundle plus its own API. Both tiers were to live in
   * `foresight-web/test/`. Two facts have made that placement wrong for these rows specifically:
   *
   *   1. **No frontend repository in this estate has a browser.** §1 records it and it is still
   *      true — every `*-web/package.json` runs `node --test` over stubs, and `hub-web/test/
   *      browser-stubs.ts` states the position: "There is no DOM in this suite on purpose."
   *      A T2 row placed there is a row nobody runs.
   *   2. **These four are only worth anything against a live chain.** Foresight's whole design is
   *      that the page renders a MIRROR and the contract is the record — so "the page showed 0.3
   *      EMBER" is satisfied by a mirror that drifted, and the assertion that matters is against
   *      `ForesightMarket`'s storage. A stub cannot hold that, by construction.
   *
   * So the tier doc 22 assigns is recorded in each row's title and the scenario lives where it can
   * actually run. This is not licence to move T1 rows here wholesale: a scenario that needs a
   * STUBBED response — a failed tile, a 503, a reorg — still cannot be written in this tier at all,
   * because it intercepts nothing, and those stay in doc 22 §8.8's gap rather than moving.
   * ══════════════════════════════════════════════════════════════════════════════════════════
   */
  scenario('BJ-FOR-01', J, 'Open one market: the terms are above the pool, in document order', 'presentation', ['foresight'], { gate: true }),
  scenario('BJ-FOR-06', J, 'The pool on screen is the pool the contract holds, to the wei', 'presentation', ['foresight', 'chain'], {}),
  scenario('BJ-FOR-13', J, 'The filter set offered is exactly the lifecycle states the service uses', 'presentation', ['foresight'], {}),
  scenario('BJ-FOR-14', J, 'Portfolio by address: every figure equals the contract’s own storage', 'presentation', ['foresight', 'chain'], { gate: true }),
  scenario('BJ-FOR-17', J, 'The refusal list renders with no account, and no request carries a credential', 'client-request', ['foresight'], { gate: true }),

  /* ---- user-uploaded images
   *
   * These are T3 by construction rather than by assignment. A browser upload is a CROSS-ORIGIN
   * request carrying an Authorization header, so it is preflighted — and a preflight is enforced
   * by a browser and by nothing else. A stubbed tier cannot see a missing allow-header, and an
   * HTTP-level journey from this process cannot either, because Node's fetch neither preflights
   * nor enforces CORS. Only a real page on a real surface origin can.
   *
   * `studio` is named in `needs` and is not routed through the gateway today, so these will show
   * as undeclared until it is. That is the honest state: `undeclared()` prints the reason, which
   * is the behaviour rule 2 asks for — a scenario that cannot run must say so rather than pass.
   */
  scenario('BJ-MED-01', E, 'Upload an image on Market: it is stored, stripped of its location, and the browser decodes what is served', 'presentation', ['market', 'studio', 'identity'], { gate: true }),
  scenario('BJ-MED-02', E, 'A script-bearing SVG and a wrong-magic-byte file are both refused, whatever Content-Type they claim', 'client-request', ['market', 'studio', 'identity'], { outcome: 'refusal', ownedBy: 'studio/src/imagebytes.test.ts', gate: true }),
  scenario('BJ-MED-03', J, 'Upload an image on Foresight: the same, from the other origin the CORS list must cover', 'presentation', ['foresight', 'studio', 'identity'], {}),

  /* ---- group Q */
  scenario('BJ-COM-01', Q, 'Found a token-gated community: the treasury accounts are visible after creation', 'presentation', ['community', 'ledger'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-02', Q, 'Join; holdings verified; membership re-evaluated, with the grace period on screen', 'presentation', ['community'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-03', Q, 'A treasury_spend proposal renders snapshot block, quorum and threshold before a vote', 'presentation', ['community'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-04', Q, 'The weighting scheme in force is named on the ballot, not inferred', 'presentation', ['community'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-05', Q, 'passed → timelocked → executed, with the expiry visible and execution appearing once', 'presentation', ['community'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-06', Q, 'There is no platform-wide proposal surface anywhere', 'navigation', ['community'], { outcome: 'refusal', ownedBy: 'community/src/server.test.ts', blocked: NO_COMMUNITY_UI }),
  scenario('BJ-COM-07', Q, 'An alliance is bound to a community created elsewhere (see BJ-AET-10)', 'client-request', ['aetherholm', 'community'], { blocked: NO_COMMUNITY_UI }),

  /* ---- group R */
  scenario('BJ-XS-01', R, 'One account signs into everything, once: Hub → Worlds → Market, no second prompt', 'presentation', ['account', 'identity', 'hub', 'hub-api', 'worlds', 'market'], { gate: true }),
  scenario('BJ-XS-02', R, 'The profile created at registration renders in Market, Worlds and Community', 'presentation', ['account', 'identity', 'market', 'worlds', 'community'], { blocked: NO_COMMUNITY_UI }),
  scenario('BJ-XS-03', R, 'The wallet is the same screen at the same address from Worlds, Trade and Create', 'navigation', ['hub', 'worlds', 'trade', 'create'], {}),
  scenario('BJ-XS-04', R, 'The total on Hub overview and on Hub portfolio are equal and share a pricedAt', 'presentation', ['hub', 'hub-api', 'ledger', 'pricing', 'identity'], { gate: true }),
  scenario('BJ-XS-05', R, 'Act in three products, then see all three in one feed with six originating services', 'presentation', ['hub', 'hub-api', 'activity'], { gate: true }),
  scenario('BJ-XS-06', R, 'Earn a reward in a world, spend it in Market, see both legs on one timeline', 'presentation', ['worlds', 'market', 'hub-api', 'activity'], { blocked: NO_WORLD_CLIENT }),
  scenario('BJ-XS-07', R, 'A Studio brand kit becomes game content and a Market listing under one asset id', 'presentation', ['studio', 'worlds', 'market'], { blocked: NO_STUDIO_UI }),
  scenario('BJ-XS-08', R, 'Changing a notification preference on one surface changes what is delivered', 'client-request', ['notify'], { blocked: NO_NOTIFY_UI }),
  scenario('BJ-XS-09', R, 'Answer a balance question from admin-web alone (see BJ-ADM-23)', 'presentation', ['admin', 'admin-api'], { blocked: NO_CONSOLE_SCREEN('support-lookup') }),
  scenario('BJ-XS-10', R, 'Every entry in the rendered switcher opens a surface that answers 200 on its index', 'navigation', ['site', 'hub', 'market', 'trade', 'worlds', 'create', 'explorer', 'developers', 'status'], { gate: true }),
  scenario('BJ-XS-13', R, 'A transaction link from a wallet row and from an order both land on the explorer', 'navigation', ['hub', 'market', 'explorer', 'indexer'], { gate: true }),
  scenario('BJ-XS-14', R, 'A Worlds title page links to its Market listings and back', 'navigation', ['worlds', 'market'], {}),

  /* ---- group S — the one hazard the matrix puts at T3 */
  scenario('BJ-ADV-01-H5', S, 'Buy with the session expiring mid-flow: re-auth path, no stale data as current', 'presentation', ['market', 'identity'], { gate: true }),
]

/**
 * The continuously-run set — doc 22 §7.1.
 *
 * Not "everything green": the scenarios beacon would hold a browser open for on its own schedule
 * against the deployed estate. Eleven scenarios plus the fifteen per-surface 404 assertions, and
 * it is small for beacon's own reason — a journey that could only ever skip must not be declared,
 * and a browser held open every five minutes against production is a cost as well as a check.
 *
 * Only `BJ-XS-10` and `BJ-NET-06`/`BJ-NET-07` of that list are T3 or reachable from here; the rest
 * are tier 2 and live in their own repositories. The ids are recorded so the set is one list
 * rather than a sentence in a document, and `catalogue.test.ts` checks the T3 members exist.
 */
export const CONTINUOUS_T3: readonly string[] = ['BJ-XS-10']

/** Every id, for the tests that check uniqueness and for anything that wants to grep one. */
export const T3_IDS: readonly string[] = T3_SCENARIOS.map((s) => s.id)

/** The scenarios with no permanent blocker. Still not declarable until their surfaces have addresses. */
export function unblocked(): readonly Scenario[] {
  return T3_SCENARIOS.filter((s) => s.blocked === null)
}

/** Everything that cannot be written as code yet, grouped by the doc section that says why. */
export function blockedByDoc(): ReadonlyMap<string, readonly Scenario[]> {
  const out = new Map<string, Scenario[]>()
  for (const s of T3_SCENARIOS) {
    if (s.blocked === null) continue
    const bucket = out.get(s.blocked.doc)
    if (bucket) bucket.push(s)
    else out.set(s.blocked.doc, [s])
  }
  return out
}
