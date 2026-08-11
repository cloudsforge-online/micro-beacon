/**
 * The journey objectives the owner set, and the seeder that registers them.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THESE NUMBERS ARE THE OWNER'S. NOTHING HERE MAY INVENT ONE.**
 *
 * `slos` was empty for the whole life of this estate, and three agents in a row declined to fill
 * it. They were right to: `upsertSlo` has exactly one caller — an admin-only route — so an
 * objective is REGISTERED, never derived, and a threshold nobody agreed to becomes the one the
 * estate is judged by. `deploy/compose/docker-compose.estate.yml` records the same refusal in the
 * `beacon-migrate` block, in as many words: "inventing eleven of them in a compose repository is
 * how a threshold nobody agreed to becomes the one the estate is judged by."
 *
 * What that cost while it stood, and it was not nothing: `slo_observations` has a foreign key onto
 * `slos(name)`, so every observation the job runner wrote was rejected —
 * `jobs.ts` catches the violation and warns, so nothing crashed and `/readyz` stayed green while
 * the estate recorded no error budget at all. The gate's two budget reason codes were unreachable
 * for the same reason: `allBudgets` iterates `slos`, and an empty table means the loop that would
 * emit `error_budget_no_data` never executes. **An empty `slos` did not make the gate lenient by
 * saying the budgets were fine; it made the gate silent by never asking.**
 *
 * The owner set them on 2026-08-04: 99% on the five `ecosystem.*` journeys, 95% on the other six,
 * a 28-day window on all eleven. The table below is that decision transcribed and nothing else.
 * A journey that is not in it gets no SLO — `MISSING_IS_AN_ERROR` below refuses to guess.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The objectives are per journey rather than per tier because the tiers are not interchangeable
 * here: 13-operational-model.md's journey rule is "99% of scheduled runs pass — a skip counts
 * against it, because a skip is not a pass", and the owner's 95% for the second group is a
 * deliberate loosening for journeys that depend on estate configuration this deployment may not
 * carry. Both halves are the owner's to set and neither is computed from the other.
 */

import type { JourneyDefinition } from './journeys.ts'
import type { Slo, SloKind } from './slo.ts'

/** `<journey>.runs`, matching `jobs.ts`'s `journeySloName`. One naming rule, and it is that one. */
export function journeySloName(journey: string): string {
  return `${journey}.runs`
}

/**
 * `<target>.availability`.
 *
 * **Moved here from `jobs.ts` on 2026-08-11, in the direction `journeySloName` already went and for
 * the reason its note gives**: the seeder writes the `slos` row and the job runner writes the
 * `slo_observations` row that carries a foreign key onto it, so the two spellings must agree
 * exactly — and two one-line functions returning `` `${x}.availability` `` is precisely the shape
 * that drifts the day one of them grows a prefix. It cannot live in `jobs.ts` and be imported from
 * here: `jobs.ts` pulls in the whole job runner, and `beacon slo-seed` runs from a shell that has
 * no database and no queue.
 */
export function availabilitySloName(target: string): string {
  return `${target}.availability`
}

/**
 * The kind, for all eleven.
 *
 * `'journey'` rather than `'availability'`. `SloKind` distinguishes them and the denominators are
 * genuinely different things: an availability SLO counts probe checks and a journey SLO counts
 * scheduled runs, so folding them together would produce a budget whose denominator is two
 * populations added up.
 */
export const JOURNEY_SLO_KIND: SloKind = 'journey'

/** The kind for every row `planAvailability` produces, for the same reason stated the other way. */
export const AVAILABILITY_SLO_KIND: SloKind = 'availability'

/** 99%, in the parts-per-million integer `slos.objective_ppm` stores. */
export const PPM_99 = 990_000n
/** 95%. */
export const PPM_95 = 950_000n

/** The owner's window, for every one of them. */
export const WINDOW_DAYS = 28

export interface Objective {
  readonly tier: number
  readonly objectivePpm: bigint
}

/**
 * The owner's table, transcribed.
 *
 * Keyed on the journey NAME rather than on a tier or a prefix, so adding a journey does not
 * silently acquire an objective by pattern-matching its name. A journey the owner has not ruled
 * on has no row here and gets no SLO, which is the honest state and is reported as one.
 */
export const OBJECTIVES: Readonly<Record<string, Objective>> = Object.freeze({
  'ecosystem.one-account': { tier: 1, objectivePpm: PPM_99 },
  'ecosystem.one-portfolio': { tier: 1, objectivePpm: PPM_99 },
  'ecosystem.one-activity': { tier: 1, objectivePpm: PPM_99 },
  'ecosystem.trial-balance': { tier: 1, objectivePpm: PPM_99 },
  'ecosystem.event-bus': { tier: 1, objectivePpm: PPM_99 },
  // ── TIER 2, AND THE ONE ROW IN THIS TABLE THE OWNER DID NOT SET DIRECTLY ────────────────────
  //
  // Added 2026-08-04 with `ecosystem.deposit-address`. `plan()` throws on a registered journey
  // with no objective, so leaving it out would not be neutral: the seeder would refuse EVERY row
  // and the estate would go back to the empty `slos` table this file's header describes at
  // length. Silence is not an option here, so the choice is which of the owner's two numbers.
  //
  // 95% rather than 99%, applying the owner's own stated rule rather than the `ecosystem.` prefix.
  // The header says the second group's 95% is "a deliberate loosening for journeys that depend on
  // estate configuration this deployment may not carry", and this journey is exactly that: it
  // needs `wallet` and `custody` addresses in `BEACON_TARGETS` and an indexer that accepts a watch
  // registration, none of which every deployment has. Choosing 99% by prefix would be deriving an
  // objective "from the tier of a journey that looks similar", which the error message below
  // refuses in as many words.
  //
  // It is a placeholder for a decision, not a decision: the journey is non-critical and has no
  // history, and the owner's number replaces this the moment there is one.
  'ecosystem.deposit-address': { tier: 2, objectivePpm: PPM_95 },
  'identity.signin': { tier: 2, objectivePpm: PPM_95 },
  'identity.register': { tier: 2, objectivePpm: PPM_95 },
  'identity.handoff': { tier: 2, objectivePpm: PPM_95 },
  'market.catalogue': { tier: 2, objectivePpm: PPM_95 },
  'worlds.registry': { tier: 2, objectivePpm: PPM_95 },
  'estate.reachable': { tier: 2, objectivePpm: PPM_95 },

  /*
   * ── THE THREE THAT WERE HOLDING THE WHOLE TABLE HOSTAGE ────────────────────────────────────
   *
   * Measured on mainnet 2026-08-11: `slos` held **0 rows** and `slo_observations` held **0 rows**,
   * for the entire life of the estate. `plan()` refuses all-or-nothing, so three journeys with no
   * objective withheld the twelve the owner HAD set, and every observation the job runner wrote —
   * 21 probes and 15 journeys, every cycle, on both networks — was rejected by
   * `slo_observations_slo_name_fkey` and warned away. micro-org#370 names two of the three; the
   * third, `identity.registration-challenge`, shipped after the ticket was filed and is the
   * demonstration of why this refusal cannot stay total: the set of unruled journeys GROWS.
   *
   * All three take 95% over 28 days, applying the owner's own stated rule rather than a prefix.
   * The header's words for the second group are "a deliberate loosening for journeys that depend on
   * estate configuration this deployment may not carry", and each of these is precisely that:
   *
   *   * `browser.bj-med-01` / `browser.bj-med-02` need `playwright-core` and a Chromium in the
   *     image. `package.json` makes that dependency OPTIONAL by design — "a deployment choosing not
   *     to ship a browser installs nothing extra and every browser journey skips" — and mainnet is
   *     such a deployment today: both journeys recorded 24 skips in the two hours this was measured
   *     and have never recorded anything else. A skip counts against the budget, so 99% would put
   *     these two permanently over budget for a dependency the estate deliberately did not install.
   *   * `identity.registration-challenge` is conditional on IDENTITY's configuration, published at
   *     runtime by `GET /auth/challenge` and unknowable from here — `estate.ts` says so at length.
   *     It skips on every deployment without a Turnstile.
   *
   * **These are placeholders for a decision, not decisions**, exactly as `ecosystem.deposit-address`
   * above is, and they are marked so for the same reason: all three journeys are non-critical to
   * the budget question and the owner's number replaces this the moment there is one. What is NOT
   * a placeholder is the refusal below no longer taking twelve agreed objectives down with it.
   */
  'browser.bj-med-01': { tier: 2, objectivePpm: PPM_95 },
  'browser.bj-med-02': { tier: 2, objectivePpm: PPM_95 },
  'identity.registration-challenge': { tier: 2, objectivePpm: PPM_95 },
})

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AVAILABILITY OBJECTIVES — THE LARGER HALF OF THE EMPTY TABLE, AND NOTHING HAS EVER SEEDED ONE.**
 *
 * `jobs.ts` writes an observation named `<target>.availability` after every single probe check, and
 * on mainnet 2026-08-11 there were **21 enabled probes and no `slos` row for any of them**. Not the
 * seeder, not a migration, not a route: `availabilitySloName` had no counterpart anywhere in the
 * estate, so every probe observation ever taken was rejected by the foreign key and dropped with a
 * warn. Twenty-one identical warns per cycle for months, which is how an outage becomes furniture.
 *
 * ── WHY SEEDING THESE RATHER THAN DROPPING THE FOREIGN KEY ────────────────────────────────────
 *
 * micro-org#370 argues the other way, and the argument is a good one: "an observation is a
 * measurement, an objective is a policy, and a measurement should not be discarded because nobody
 * has yet written down what it ought to be." It is rejected here for one reason. The measurements
 * are not what the estate is missing — `checks` and `check_rollups` have held every probe result
 * this whole time, so nothing about the estate's history was actually lost. What is missing is the
 * BUDGET, and `allBudgets` iterates `slos`; relaxing the key would store rows that still produce no
 * budget, no gate reason and no page. It would make the warn stop, which is the part of the problem
 * that does not matter.
 *
 * ── THE NUMBERS ARE THE OWNER'S, TRANSCRIBED, AND THE TIER MAP IS SOMEBODY ELSE'S FILE ────────
 *
 * `docs/ecosystem/13-operational-model.md` §8 sets what a tier COSTS — Tier 1 money at 99.95%,
 * Tier 2 product at 99.5%, Tier 3 edge at 99.9% — and `deploy/prometheus/tiers.yaml` holds the
 * MEMBERSHIP, deliberately split that way and saying so in its own header. Neither is importable
 * from here: `docs/` is not checked out on the deploy host (measured 2026-08-09) and `deploy/` is a
 * different repository. So this is a transcription, and it is a transcription of §8's Tier 3 for
 * every row.
 *
 * **Every probe in this estate is Tier 3, and that is a finding rather than a shortcut.** Read the
 * probe catalogue on mainnet: all 21 targets are public HTTPS surfaces — `https://hub…/`,
 * `https://market…/`, `https://cloudsforge.online/` — nginx serving bundles, plus one API route.
 * `tiers.yaml` says of exactly these: "NOT LISTED, ON PURPOSE: every `*-web`, `site` and
 * `network-site`. They are nginx serving static bundles… §8 covers them under Tier 3 as edge."
 * So beacon is not probing `ledger` or `custody` at all, and an availability SLO here is a
 * statement about the EDGE. Giving one of these rows a Tier-1 99.95% because its hostname contains
 * the name of a money service would be attributing a gateway's uptime to a service beacon never
 * dialled — the drift `tiers.yaml`'s header describes, arrived at from the other direction.
 *
 * When beacon grows a probe that dials a service directly, it gets a row here with its own reason,
 * and `planAvailability` refuses rather than defaulting — a silent default to Tier 3 is how a money
 * service quietly acquires the loosest objective in the estate.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

/** 99.9%, §8's Tier 3 edge objective. 40 minutes of budget per 28 days. */
export const PPM_999 = 999_000n

/** §8's Tier 3. Named rather than repeated, so the twenty-one rows below carry one fact. */
export const EDGE: Objective = Object.freeze({ tier: 3, objectivePpm: PPM_999 })

/**
 * Keyed on the probe's TARGET, which is what `availabilitySloName` is given — not on the probe's
 * name. They are equal for every probe today and they are different fields, and the one that ends
 * up in `slo_observations` is the target.
 */
export const AVAILABILITY_OBJECTIVES: Readonly<Record<string, Objective>> = Object.freeze({
  // The eight product surfaces. Each is a `*-web` bundle behind the gateway.
  hub: EDGE,
  market: EDGE,
  trade: EDGE,
  worlds: EDGE,
  foresight: EDGE,
  emberkin: EDGE,
  aetherholm: EDGE,
  tessera: EDGE,
  // The estate's own front doors and operator surfaces.
  site: EDGE,
  network: EDGE,
  explorer: EDGE,
  create: EDGE,
  developers: EDGE,
  admin: EDGE,
  status: EDGE,
  beacon: EDGE,
  lantern: EDGE,
  // Paths under a surface rather than surfaces of their own — `hub…/account`, `hub…/wallet`,
  // `network…/faucet`. Still edge: what a check of one of these can fail on is the gateway, the
  // bundle and the route, which is the same population as the row above it.
  signin: EDGE,
  wallet: EDGE,
  faucet: EDGE,
  // THE ONE API PROBE. `https://api…/v1/titles` — the only target in the catalogue that reaches a
  // service rather than a bundle, and `tiers.yaml` puts `worlds` in Tier 2. It stays EDGE anyway,
  // and the reason is what the probe actually measures: an unauthenticated GET through the public
  // gateway, which fails on TLS, on DNS and on the gateway's routing long before it fails on
  // anything worlds did. A Tier-2 availability budget for `worlds` is a statement about the
  // service, and it belongs on a probe that dials the service.
  'worlds.titles': EDGE,
})

export class SloSeedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SloSeedError'
  }
}

/**
 * Every journey in the registry must appear in the owner's table, and vice versa.
 *
 * **A seeder that skipped what it did not recognise would be the empty table again, one journey at
 * a time.** The failure it prevents is specific: somebody adds a journey, the seeder runs green,
 * `slo_observations` starts silently violating its foreign key for that one name, and the gate
 * carries no budget for it while carrying budgets for the other eleven — which reads, on the SLO
 * page, exactly like a journey that is doing fine.
 *
 * Checked in BOTH directions. An objective for a journey that no longer exists is the other half
 * of the same defect: `allBudgets` would iterate it for ever, find no observations, and emit
 * `error_budget_no_data` — an UNKNOWN — refusing every release on behalf of a journey that was
 * deleted on purpose.
 */
export const MISSING_IS_AN_ERROR = true

/**
 * Turn the journeys the estate has REGISTERED, plus the owner's table, into the rows to write.
 *
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 * **`registered` comes from the running estate, not from importing the registry.**
 *
 * The first version of this took `JOURNEYS` from `estate.ts` and was wrong in a way that only
 * showed up when it was run: `ecosystemJourneys()` reads `process.env` AT IMPORT and omits
 * `ecosystem.trial-balance` unless `BEACON_SERVICE_CREDENTIAL` is set. The estate's beacon
 * container sets it and a shell does not, so the same command seeded eleven objectives from
 * inside the container and refused from outside it — and the refusal blamed the owner's table for
 * naming a journey "this build does not declare".
 *
 * A seeder whose output depends on which process invoked it is a seeder that writes a different
 * `slos` table depending on where somebody stood. So the registry is read over the wire from
 * `GET /v1/journeys`, which is the same set `syncRegistry` wrote and the same set the gate
 * iterates, and the code catalogue is consulted only for the one fact the wire does not carry:
 * each journey's owning service.
 * ──────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Pure: no socket and no clock. The property that matters — that these are the owner's numbers
 * and not a computation over them — is provable by reading the return value in a test.
 */
/**
 * What the seeder will write, and what it refuses to write and why.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **REFUSING TO GUESS MUST NOT MEAN REFUSING TO RECORD, AND FOR MONTHS IT DID.**
 *
 * `plan()` threw on the first unruled journey, so the twelve objectives the owner HAD set were
 * withheld because of three he had not — and the estate spent its whole life with an empty `slos`,
 * an empty `slo_observations`, and a release gate whose two error-budget reason codes were
 * unreachable. Measured on mainnet 2026-08-11: 0 rows in both tables.
 *
 * That is a strictly worse outcome than the one `MISSING_IS_AN_ERROR` was protecting against, and
 * it is worse in the same currency: the guard exists so that a journey cannot quietly end up with
 * no budget while its neighbours have one, and what it actually produced was NO journey having one.
 *
 * So a refusal is now a VALUE rather than a throw, and the seeder writes what is ruled and reports
 * what is not. The guard's teeth are kept in the one place they bite: `beacon slo-seed` exits
 * **non-zero** when `refusals` is non-empty, so a deploy step that runs it still goes red, an
 * operator still reads the same sentence, and nobody discovers the gap six weeks later from a chart.
 * What changed is that the estate now has eleven working budgets while that conversation happens.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export interface SeedPlan {
  readonly slos: readonly Slo[]
  /** One sentence per thing nobody has ruled on. Empty means the plan is complete. */
  readonly refusals: readonly string[]
}

export function plan(
  catalogue: readonly JourneyDefinition[],
  registered: readonly string[],
): SeedPlan {
  const byName = new Map(catalogue.map((journey) => [journey.name, journey]))
  const refusals: string[] = []

  const unruled = registered.filter((name) => !(name in OBJECTIVES))
  if (unruled.length > 0) {
    refusals.push(
      `no objective has been set for: ${unruled.join(', ')}. ` +
        "An objective is the owner's to set — add it to OBJECTIVES with the decision, do not " +
        'derive one from the tier of a journey that looks similar. Their observations will keep ' +
        'being rejected by slo_observations_slo_name_fkey until one is.',
    )
  }

  const orphaned = Object.keys(OBJECTIVES).filter((name) => !registered.includes(name))
  if (orphaned.length > 0) {
    // Still only a refusal, and deliberately not a deletion. An SLO whose journey is gone reports
    // `error_budget_no_data` for ever — an UNKNOWN, which refuses every release on behalf of
    // something nobody is running — and the fix is a person deciding whether the journey or the
    // objective was the mistake. A seeder that disabled the row would be making that decision by
    // itself, at deploy time, in the direction that makes the gate quieter.
    refusals.push(
      `OBJECTIVES names journeys the estate has not registered: ${orphaned.join(', ')}. ` +
        'An SLO whose journey is gone reports error_budget_no_data for ever, which is an unknown, ' +
        'which refuses every release on behalf of something nobody is running.',
    )
  }

  const unknownToCode = registered.filter((name) => !byName.has(name))
  if (unknownToCode.length > 0) {
    refusals.push(
      `the estate has registered journeys this build cannot describe: ${unknownToCode.join(', ')}. ` +
        'Their owning service is unknown, and guessing it from the name is what the `service` ' +
        'field on JourneyDefinition exists to prevent.',
    )
  }

  const slos = registered
    // Both conditions, not just the first. A journey the owner has ruled on but this build cannot
    // describe has no `service` to attribute its budget to, and inventing one from the name is the
    // exact substitution `unknownToCode` refuses two blocks up.
    .filter((name) => name in OBJECTIVES && byName.has(name))
    .map((name) => {
      const objective = OBJECTIVES[name] as Objective
      const journey = byName.get(name) as JourneyDefinition
      return {
        name: journeySloName(name),
        // From the definition, never from the name. `journeys.ts`'s `service` field says why:
        // slicing the name yields `ecosystem` and `estate`, neither of which is a service.
        service: journey.service,
        tier: objective.tier,
        kind: JOURNEY_SLO_KIND,
        objectivePpm: objective.objectivePpm,
        windowDays: WINDOW_DAYS,
        enabled: true,
      }
    })

  return { slos, refusals }
}

/**
 * The availability rows, from the probe targets the estate has actually registered.
 *
 * Same shape and same rule as `plan`: a target nobody has ruled on is a refusal rather than a
 * default, because a silent default is how a service acquires an objective nobody agreed to. The
 * argument for these numbers is in `AVAILABILITY_OBJECTIVES`.
 *
 * `service` is the TARGET name. That is the honest attribution and it is not the same field a
 * journey SLO carries: a journey names the service that owes the joined-up answer, while a probe
 * check can only ever say that one address answered. Deriving a service name from a target here
 * would be claiming the probe measured something it did not dial — see the `worlds.titles` note.
 */
export function planAvailability(targets: readonly string[]): SeedPlan {
  const refusals: string[] = []

  const unruled = targets.filter((target) => !(target in AVAILABILITY_OBJECTIVES))
  if (unruled.length > 0) {
    refusals.push(
      `no availability objective has been set for: ${unruled.join(', ')}. ` +
        'Add each to AVAILABILITY_OBJECTIVES with the tier it is being held to and the reason. ' +
        'Until then every probe check against it writes an observation that the foreign key ' +
        'rejects, which is the state the whole estate was in until 2026-08-11.',
    )
  }

  const orphaned = Object.keys(AVAILABILITY_OBJECTIVES).filter((target) => !targets.includes(target))
  if (orphaned.length > 0) {
    refusals.push(
      `AVAILABILITY_OBJECTIVES names targets the estate is not probing: ${orphaned.join(', ')}. ` +
        'An availability SLO with no probe behind it reports error_budget_no_data for ever, which ' +
        'is an unknown, which refuses every release on behalf of an address nobody is checking.',
    )
  }

  const slos = targets
    .filter((target) => target in AVAILABILITY_OBJECTIVES)
    .map((target) => {
      const objective = AVAILABILITY_OBJECTIVES[target] as Objective
      return {
        name: availabilitySloName(target),
        service: target,
        tier: objective.tier,
        kind: AVAILABILITY_SLO_KIND,
        objectivePpm: objective.objectivePpm,
        windowDays: WINDOW_DAYS,
        enabled: true,
      }
    })

  return { slos, refusals }
}

/**
 * Every journey this build can describe, conditional ones included.
 *
 * Deliberately the WIDER set — `ALL_ECOSYSTEM_JOURNEYS` rather than `ecosystemJourneys()` — for
 * the reason in `plan`'s header: this is the lookup for "what service owns the journey the estate
 * says it is running", and a catalogue that hid the conditionally-declared ones would be unable to
 * answer for exactly the journey that caused the bug.
 */
export async function catalogue(): Promise<readonly JourneyDefinition[]> {
  const [{ SERVICE_JOURNEYS }, { ALL_ECOSYSTEM_JOURNEYS }, { browserCatalogue }] = await Promise.all([
    import('./estate.ts'),
    import('./ecosystem.ts'),
    // The BROWSER tier, added 2026-08-11 (micro-org#370). Without it the seeder refused
    // `browser.bj-med-01` and `browser.bj-med-02` as "journeys this build cannot describe" — from
    // inside a container that has no browser and therefore declares none, while the estate's
    // `journeys` table has had both rows, gated, since they shipped. `browserCatalogue` is the
    // deployment-independent list for exactly this reason; see its header.
    import('./browser/journeys.ts'),
  ])
  return [...SERVICE_JOURNEYS, ...ALL_ECOSYSTEM_JOURNEYS, ...browserCatalogue()]
}

/** `GET /v1/journeys` — the names the estate has actually registered. */
export async function registeredNames(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  const response = await fetch(new URL('/v1/journeys', baseUrl), {
    headers: { ...headers, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new SloSeedError(`beacon answered ${response.status} for GET /v1/journeys`)
  }
  const body = (await response.json()) as { journeys?: Array<{ name?: string }> }
  return (body.journeys ?? []).map((journey) => journey.name ?? '').filter((name) => name.length > 0)
}

/**
 * `GET /v1/probes` — the TARGETS the estate is actually checking, de-duplicated.
 *
 * The target and not the probe name, because the target is what `availabilitySloName` is given and
 * therefore what the foreign key is on. They happen to be equal for all 21 probes on mainnet today,
 * and relying on that would be relying on a coincidence: `probes.name` and `probes.target` are
 * separate columns precisely so two probes can check one target by different routes, and the day
 * somebody adds `hub.deep` against target `hub` this would otherwise plan a second, orphaned row.
 *
 * Over the wire for `registeredNames`' reason: the catalogue lives in the database, so a build's
 * idea of it is not the estate's.
 */
export async function probeTargets(
  baseUrl: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs = 30_000,
): Promise<readonly string[]> {
  const response = await fetch(new URL('/v1/probes', baseUrl), {
    headers: { ...headers, accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new SloSeedError(`beacon answered ${response.status} for GET /v1/probes`)
  }
  const body = (await response.json()) as { probes?: Array<{ target?: string; enabled?: boolean }> }
  const targets = (body.probes ?? [])
    // A DISABLED probe still has history and may be re-enabled, so its objective is kept rather
    // than planned away — an operator switching a probe off for an afternoon must not find that
    // the deploy deleted its budget and reset its window.
    .map((probe) => probe.target ?? '')
    .filter((target) => target.length > 0)
  return [...new Set(targets)].sort()
}

/**
 * The wire body for `PUT /v1/slos/:name`.
 *
 * `objectivePpm` is a STRING, and the route refuses a number: an objective sent as a JSON float
 * has already been rounded by whatever produced it, and 0.9995 does not survive a round trip
 * through every language the estate is written in.
 */
export function bodyFor(slo: Slo): Record<string, unknown> {
  return {
    service: slo.service,
    tier: slo.tier,
    kind: slo.kind,
    objectivePpm: slo.objectivePpm.toString(),
    windowDays: slo.windowDays,
    enabled: slo.enabled,
  }
}

export interface SeedResult {
  readonly name: string
  readonly status: number
  readonly ok: boolean
  readonly error: string | null
}

/**
 * Register every planned SLO through the API.
 *
 * **Through the front door, never with an INSERT.** The route is the path an operator uses, it is
 * the only caller of `upsertSlo`, and going around it would mean the seeding had never exercised
 * the thing it is meant to make routine. `upsert` semantics make it idempotent, so running it
 * twice is not an error and running it on every deploy is the intended use.
 *
 * Sequential rather than concurrent. Eleven requests is not worth a pool, and a failure part-way
 * through leaves a report naming exactly which rows exist rather than eleven interleaved statuses.
 */
export async function seed(
  slos: readonly Slo[],
  options: {
    readonly baseUrl: string
    readonly headers: Readonly<Record<string, string>>
    readonly timeoutMs?: number
  },
): Promise<readonly SeedResult[]> {
  const results: SeedResult[] = []
  for (const slo of slos) {
    const url = new URL(`/v1/slos/${encodeURIComponent(slo.name)}`, options.baseUrl)
    try {
      const response = await fetch(url, {
        method: 'PUT',
        headers: { ...options.headers, 'content-type': 'application/json' },
        body: JSON.stringify(bodyFor(slo)),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      })
      const text = await response.text()
      results.push({
        name: slo.name,
        status: response.status,
        ok: response.ok,
        error: response.ok ? null : text.slice(0, 240),
      })
    } catch (err) {
      // Recorded, not thrown. A seeder that threw on the fourth of eleven would leave an operator
      // with a stack trace and no statement of which of the first three had been written.
      results.push({
        name: slo.name,
        status: 0,
        ok: false,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      })
    }
  }
  return results
}
