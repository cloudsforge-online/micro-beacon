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
 * The kind, for all eleven.
 *
 * `'journey'` rather than `'availability'`. `SloKind` distinguishes them and the denominators are
 * genuinely different things: an availability SLO counts probe checks and a journey SLO counts
 * scheduled runs, so folding them together would produce a budget whose denominator is two
 * populations added up.
 */
export const JOURNEY_SLO_KIND: SloKind = 'journey'

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
  'identity.signin': { tier: 2, objectivePpm: PPM_95 },
  'identity.register': { tier: 2, objectivePpm: PPM_95 },
  'identity.handoff': { tier: 2, objectivePpm: PPM_95 },
  'market.catalogue': { tier: 2, objectivePpm: PPM_95 },
  'worlds.registry': { tier: 2, objectivePpm: PPM_95 },
  'estate.reachable': { tier: 2, objectivePpm: PPM_95 },
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
export function plan(
  catalogue: readonly JourneyDefinition[],
  registered: readonly string[],
): readonly Slo[] {
  const byName = new Map(catalogue.map((journey) => [journey.name, journey]))

  const unruled = registered.filter((name) => !(name in OBJECTIVES))
  if (unruled.length > 0) {
    throw new SloSeedError(
      `no objective has been set for: ${unruled.join(', ')}. ` +
        "An objective is the owner's to set — add it to OBJECTIVES with the decision, do not " +
        'derive one from the tier of a journey that looks similar.',
    )
  }

  const orphaned = Object.keys(OBJECTIVES).filter((name) => !registered.includes(name))
  if (orphaned.length > 0) {
    throw new SloSeedError(
      `OBJECTIVES names journeys the estate has not registered: ${orphaned.join(', ')}. ` +
        'An SLO whose journey is gone reports error_budget_no_data for ever, which is an unknown, ' +
        'which refuses every release on behalf of something nobody is running.',
    )
  }

  const unknownToCode = registered.filter((name) => !byName.has(name))
  if (unknownToCode.length > 0) {
    throw new SloSeedError(
      `the estate has registered journeys this build cannot describe: ${unknownToCode.join(', ')}. ` +
        'Their owning service is unknown, and guessing it from the name is what the `service` ' +
        'field on JourneyDefinition exists to prevent.',
    )
  }

  return registered.map((name) => {
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
  const [{ SERVICE_JOURNEYS }, { ALL_ECOSYSTEM_JOURNEYS }] = await Promise.all([
    import('./estate.ts'),
    import('./ecosystem.ts'),
  ])
  return [...SERVICE_JOURNEYS, ...ALL_ECOSYSTEM_JOURNEYS]
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
