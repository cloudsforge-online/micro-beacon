/**
 * The public status projection.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **REDACTED BY CONSTRUCTION, NOT BY CONVENTION.**
 *
 * The internal record and the public record are **separate types**, and the public one is built by
 * an explicit field-by-field mapping that is then passed through `seal()`, which copies only the
 * keys named in an allowlist tuple. Three things follow, and all three are the point:
 *
 *   * **A new internal field cannot leak.** Adding `lastError` to `Incident` changes nothing here,
 *     because nothing here reads an internal object generically. There is no spread, no
 *     `Object.assign`, no `...rest` anywhere in this file, and a test asserts on the exact key set.
 *   * **A new public field cannot be added by accident.** `PUBLIC_INCIDENT_FIELDS` and
 *     `keyof PublicIncident` are asserted equal AT COMPILE TIME by `Exact<>` below. Adding a field
 *     to the interface without adding it to the tuple fails `pnpm typecheck`, and so does the
 *     reverse. Publishing something new is therefore always a deliberate, reviewable, two-line act.
 *   * **A mistake in the mapping is still caught.** `seal()` is a runtime backstop: if someone
 *     later writes `{ ...incident, group }` — which TypeScript permits, because excess-property
 *     checking does not apply to spreads — the seal strips every key the allowlist does not name
 *     before the object reaches a socket.
 *
 * Why this much machinery for a status page: "our status page told the attacker which service fell
 * over first" is not worth a nicer page. The withheld set is named in 13-operational-model.md
 * — per-service latency, error rates, **internal target names**, replica counts, journey step
 * names, error strings, and the `proves` text on each probe.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **THE CORRECTION THIS MODULE EXISTS TO IMPLEMENT.** 02-target-architecture.md records
 * that the frozen `redactStatus` (`infra/beacon/src/server.js`) is *not* sufficient: it
 * emits `t.name` and `incidents[].subject` verbatim — `pay.rates`, `hearth.seed` — which is
 * internal topology, and it carries no maintenance and no chain fields. That is true; I checked
 * the source. `server.js` publishes `subject` on every incident and `server.js`
 * publishes `t.name` on every target.
 *
 * So target names do not appear here **at all**. The unit of publication is the PRODUCT GROUP —
 * "Wallet", never `pay.rates` — and a group's state is the worst state of the probes inside it.
 */

import type { Sql } from '@cloudsforge/db'
import type { Incident, IncidentUpdate, Severity } from './incidents.ts'
import type { ReportedState } from './probes.ts'

/* ------------------------------------------------------------------ the public vocabulary */

/**
 * What a customer is told. Not the internal `up | degraded | down | pending`.
 *
 * A separate vocabulary rather than the internal one passed through, because the words differ in
 * meaning as well as in spelling: `pending` internally means "this probe has never run", which is
 * an operational fact and not a customer-facing state at all. It maps to `operational`, because a
 * service nobody has measured yet is not a service the public should be told is broken — and the
 * gate, which is the thing that must not be fooled, refuses on exactly that case.
 */
export type PublicState = 'operational' | 'degraded' | 'outage' | 'maintenance'

/** The customer-facing lifecycle. Never the internal `detected | declared | mitigated | …`. */
export type PublicIncidentState = 'investigating' | 'identified' | 'monitoring' | 'resolved'

/* ------------------------------------------------------------------ the exactness machinery */

/**
 * `Exact<A, B>` is `true` only when the two string unions are identical in both directions.
 *
 * Assigning `true` to it is what turns a divergence between an interface and its allowlist into a
 * compile error rather than into a field that quietly stops being published — or, far worse, one
 * that quietly starts.
 */
type Exact<A extends string, B extends string> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never

/**
 * Copy exactly the allowlisted keys, and nothing else.
 *
 * The runtime half of the guarantee. It exists because TypeScript's excess-property check does not
 * apply to spreads or to values that have been widened, so the type system alone cannot promise
 * that an object handed to `JSON.stringify` carries only what it should. This can.
 */
function seal<T extends object>(fields: readonly (keyof T & string)[], candidate: T): T {
  const out: Record<string, unknown> = {}
  for (const field of fields) out[field] = candidate[field]
  return out as T
}

/* ------------------------------------------------------------------ public incident */

export interface PublicIncident {
  /** Opaque, stable, non-enumerable. Enough to link a customer to an update, and nothing more. */
  readonly reference: string
  /** The PRODUCT GROUP. Never `subject`, which is internal topology. */
  readonly group: string
  readonly severity: Severity
  readonly state: PublicIncidentState
  readonly openedAt: string
  readonly closedAt: string | null
  readonly updates: readonly PublicUpdate[]
}

export const PUBLIC_INCIDENT_FIELDS = [
  'reference',
  'group',
  'severity',
  'state',
  'openedAt',
  'closedAt',
  'updates',
] as const satisfies readonly (keyof PublicIncident)[]

// Divergence between the interface and the allowlist is a build failure. Both directions.
const _publicIncidentIsExact: Exact<
  keyof PublicIncident & string,
  (typeof PUBLIC_INCIDENT_FIELDS)[number]
> = true
void _publicIncidentIsExact

export interface PublicUpdate {
  readonly at: string
  readonly body: string
}

export const PUBLIC_UPDATE_FIELDS = ['at', 'body'] as const satisfies readonly (keyof PublicUpdate)[]

const _publicUpdateIsExact: Exact<
  keyof PublicUpdate & string,
  (typeof PUBLIC_UPDATE_FIELDS)[number]
> = true
void _publicUpdateIsExact

/**
 * Internal lifecycle to public lifecycle. Exhaustive on purpose.
 *
 * `noFallthroughCasesInSwitch` plus a `never` default means adding a sixth internal state fails to
 * compile until somebody decides what a customer should be told about it. A default that guessed
 * would publish a word nobody chose.
 */
export function publicStateOf(state: Incident['state']): PublicIncidentState {
  switch (state) {
    case 'detected':
      return 'investigating'
    case 'declared':
      return 'identified'
    case 'mitigated':
      return 'monitoring'
    case 'resolved':
      return 'resolved'
    case 'reviewed':
      // A completed post-incident review is an internal milestone. To a customer the incident
      // finished when it finished.
      return 'resolved'
    default: {
      const exhaustive: never = state
      throw new Error(`unmapped incident state: ${String(exhaustive)}`)
    }
  }
}

/**
 * Project one incident.
 *
 * Every field is named. `subject`, `cause`, `lastError`, `failures`, `detectedBy`, `scope` and `id`
 * are absent because they are not written down here — not because a filter removed them. That is
 * the difference between redaction by construction and redaction by convention, and it is why
 * adding a field to `Incident` requires no change to this file and produces no leak.
 */
export function projectIncident(
  incident: Incident,
  updates: readonly IncidentUpdate[] = [],
): PublicIncident {
  return seal(PUBLIC_INCIDENT_FIELDS, {
    reference: incident.id,
    group: incident.productGroup,
    severity: incident.severity,
    state: publicStateOf(incident.state),
    openedAt: incident.openedAt.toISOString(),
    closedAt: incident.closedAt === null ? null : incident.closedAt.toISOString(),
    updates: updates
      // A non-public update is an internal timeline entry — "rolled back deploy 4c1f, still
      // seeing 502s from the pool". Filtered on the flag, then projected, so the body of a
      // private update is never even copied into the candidate object.
      .filter((update) => update.isPublic)
      .map((update) => seal(PUBLIC_UPDATE_FIELDS, { at: update.at.toISOString(), body: update.body })),
  })
}

/* ------------------------------------------------------------------ public group */

export interface PublicDay {
  readonly date: string
  readonly state: PublicState
  /**
   * How much of that day came back clean, in parts per million, `0` to `1_000_000`.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **THE ONE NUMBER THIS DOCUMENT PUBLISHES, AND WHY IT IS NOT THE THING THE REDACTION SET
   * REFUSES.**
   *
   * 13-operational-model.md withholds "per-service latency, error rates, internal target names,
   * replica counts, journey step names, error strings". A per-service error rate is refused
   * because it names a service. This is a share of the checks in ONE PRODUCT GROUP on ONE DAY,
   * and the group is the unit this whole projection publishes in — "Wallet", never `pay.rates`.
   * It says how much of a day was clean; it cannot say which service made it dirty, because the
   * probe names were summed away before this number existed.
   *
   * The DENOMINATOR is deliberately not published. The count of checks in a group in a day is
   * (probes in the group) × (cadence), which is internal topology by arithmetic — close enough to
   * a replica count to sit inside the withheld set. A ratio is the largest true thing that can be
   * said here without saying that.
   *
   * **Parts per million as an integer, not a float, and not a percentage.** `slo.ts` already
   * argues this for `objective_ppm`: floating point in an availability figure is a correctness
   * bug, and a percentage rounded to one decimal cannot express the difference between a perfect
   * day and one bad check in ten thousand — which is precisely the difference this field exists
   * to carry. It is computed by rounding DOWN, so this document never claims a day was cleaner
   * than it was.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly cleanPpm: number
}

export const PUBLIC_DAY_FIELDS = [
  'date',
  'state',
  'cleanPpm',
] as const satisfies readonly (keyof PublicDay)[]

const _publicDayIsExact: Exact<keyof PublicDay & string, (typeof PUBLIC_DAY_FIELDS)[number]> = true
void _publicDayIsExact

export interface PublicGroup {
  readonly group: string
  readonly state: PublicState
  /** Ninety bars. From `check_rollups`, which is the table AD-20's 400 days actually applies to. */
  readonly uptime: readonly PublicDay[]
}

export const PUBLIC_GROUP_FIELDS = [
  'group',
  'state',
  'uptime',
] as const satisfies readonly (keyof PublicGroup)[]

const _publicGroupIsExact: Exact<
  keyof PublicGroup & string,
  (typeof PUBLIC_GROUP_FIELDS)[number]
> = true
void _publicGroupIsExact

export interface PublicMaintenance {
  readonly group: string
  readonly summary: string
  readonly startsAt: string
  readonly endsAt: string
}

export const PUBLIC_MAINTENANCE_FIELDS = [
  'group',
  'summary',
  'startsAt',
  'endsAt',
] as const satisfies readonly (keyof PublicMaintenance)[]

const _publicMaintenanceIsExact: Exact<
  keyof PublicMaintenance & string,
  (typeof PUBLIC_MAINTENANCE_FIELDS)[number]
> = true
void _publicMaintenanceIsExact

export interface PublicStatus {
  readonly generatedAt: string
  /**
   * The hero chip: the worst state across every group — or `null` when there are no groups.
   *
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   * **NULL MEANS "WE MEASURED NOTHING", AND IT IS NOT THE SAME AS `operational`.**
   *
   * This was `PublicState` and it published `operational` for an empty estate, because `worst([])`
   * folds from its identity. On 2026-08-04 a deployment with no probes registered served exactly
   * that on the most public URL in the estate:
   *
   *     {"generatedAt":"2026-08-04T21:45:14.548Z","state":"operational","groups":[], …}
   *
   * Nothing had been measured, and the document said everything was fine. This service's own
   * package description is "an unknown is never a pass"; that is enforced at the gate and was not
   * enforced here.
   *
   * Null rather than a fifth vocabulary word, deliberately. `PublicState` is a closed four-word
   * union and the reader depends on it staying closed: `status-web/src/lib/publicstatus.ts` says
   * of its own `unknown` that it is "deliberately not in `PublicState` — Beacon cannot send it —
   * so it can only ever be produced HERE, by this page failing to establish something". Adding
   * `unknown` upstream would let an unknown be sorted and compared as though it were a verdict
   * this service gave. An absent claim is not a verdict, and null is how a field says it is absent.
   *
   * The key is still always present; only its value goes empty. A document whose SHAPE changes
   * with its content is one every consumer has to special-case.
   * ══════════════════════════════════════════════════════════════════════════════════════════════
   */
  readonly state: PublicState | null
  readonly groups: readonly PublicGroup[]
  readonly incidents: readonly PublicIncident[]
  readonly maintenance: readonly PublicMaintenance[]
}

export const PUBLIC_STATUS_FIELDS = [
  'generatedAt',
  'state',
  'groups',
  'incidents',
  'maintenance',
] as const satisfies readonly (keyof PublicStatus)[]

const _publicStatusIsExact: Exact<
  keyof PublicStatus & string,
  (typeof PUBLIC_STATUS_FIELDS)[number]
> = true
void _publicStatusIsExact

/* ------------------------------------------------------------------ rolling up */

/**
 * Internal probe state to public state.
 *
 * `pending` is `operational` — see the note on `PublicState`. It is the one mapping here that
 * could be argued the other way, so: the alternative is publishing an outage every time a probe is
 * added, which trains customers that the page is wrong. The gate is where "we have not measured
 * this" must bite, and it does.
 */
export function publicStateOfProbe(state: ReportedState): PublicState {
  switch (state) {
    case 'up':
      return 'operational'
    case 'degraded':
      return 'degraded'
    case 'down':
      return 'outage'
    case 'pending':
      return 'operational'
    default: {
      const exhaustive: never = state
      throw new Error(`unmapped probe state: ${String(exhaustive)}`)
    }
  }
}

const SEVERITY_ORDER: readonly PublicState[] = ['operational', 'maintenance', 'degraded', 'outage']

/** The worst of a set. A group is as healthy as its unhealthiest part; so is the estate. */
export function worst(states: readonly PublicState[]): PublicState {
  let out: PublicState = 'operational'
  for (const state of states) {
    if (SEVERITY_ORDER.indexOf(state) > SEVERITY_ORDER.indexOf(out)) out = state
  }
  return out
}

/* ------------------------------------------------------------------ one day of one group */

/**
 * What `check_rollups` summed to for one product group on one day. Counts of CHECKS, not of
 * probes and not of services — the probe names are already gone by the time this exists.
 */
export interface DayCounts {
  /** Every check that ran, whatever it came back as. Never zero; see `projectDay`. */
  readonly checks: number
  readonly degraded: number
  readonly down: number
}

/** One million, the unit of `cleanPpm`. Spelled here so the field is not a bare literal. */
const DAY_PPM = 1_000_000

/**
 * The share of a day that came back clean, in parts per million, rounded DOWN.
 *
 * `checks` is bounded by (probes in a group) × (checks per probe per day) — four figures at this
 * estate's cadences — so `clean * DAY_PPM` stays far below `Number.MAX_SAFE_INTEGER` and the
 * arithmetic is exact in `number`. `slo.ts` uses `bigint` for the same reason it uses ppm at all,
 * over a window that really can overflow; this one cannot, and a `bigint` on the wire would
 * serialise as a string.
 */
export function cleanPpm(counts: DayCounts): number {
  const clean = counts.checks - counts.degraded - counts.down
  return Math.floor((clean * DAY_PPM) / counts.checks)
}

/**
 * A day's colour, from its counts.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS WAS A BOOLEAN OR, AND IT PUBLISHED A FALSE DOCUMENT FOR FOUR CONSECUTIVE DAYS.**
 *
 * The rule was: a day is `outage` if ANYTHING was down in it. One failed check out of thousands,
 * anywhere in the group, at any hour, painted the whole day red. On 2026-08-07
 * `status.cloudsforge.online` reported every one of twenty product groups as out for four days
 * running while the estate was answering 30/30 HTTPS 200s, and `status-web` faithfully rendered
 * "0.0% of 4 measured days came back clean" underneath a green `Operational` verdict — because
 * the verdict comes from the live probe states and the bars came from this fold, and the two
 * disagreed. No amount of rewording downstream fixes a renderer that is correctly rendering a
 * wrong document. 32-roadmap-ui-and-content.md §8 calls this the single worst thing a stranger
 * can currently be shown, and it is the estate's only public trust artefact.
 *
 * The old rule's stated defence was coarseness: "a percentage per day per group invites the
 * question 'which service was that', which is the question this projection exists not to answer."
 * That argument is sound about the WITHHELD SET and does not distinguish a boolean from a ratio.
 * A red bar invites "which service was that" exactly as loudly as a 97.4% bar does, and neither
 * one can answer it, because the probe names were summed away in the query. What the boolean
 * bought was not privacy. It was a claim the service could not support.
 *
 * **The replacement has no tunable threshold, deliberately.** Any "outage above N% down" invents
 * N, and rule 1 of that roadmap — no number on a public surface that is not checkable against
 * something real — applies to a constant that decides a colour as much as to one that is printed.
 * So the rule is a comparison instead:
 *
 *   * `outage`      — more checks came back down than came back up. The day was majority broken.
 *   * `degraded`    — something was down or degraded, and most of the day was not.
 *   * `operational` — nothing was down and nothing was degraded.
 *
 * The cost is stated rather than hidden: a day that was 40% down reads `degraded`, which is
 * gentler than it deserves. That is what `cleanPpm` is for. The colour is a summary and the ratio
 * is the claim; a reader who wants to know how bad Tuesday was is told, to six figures, and is
 * never told it by a constant somebody picked.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function dayState(counts: DayCounts): PublicState {
  const up = counts.checks - counts.degraded - counts.down
  if (counts.down > up) return 'outage'
  if (counts.down > 0 || counts.degraded > 0) return 'degraded'
  return 'operational'
}

export interface ProjectionInput {
  readonly generatedAt: Date
  readonly probes: readonly { readonly productGroup: string; readonly state: ReportedState }[]
  /**
   * COUNTS, not verdicts. `dailyUptime` used to classify each day itself and hand this function a
   * finished `PublicState`, which put the estate's most public fold in the one place that cannot
   * be exercised without a database — and it is the fold, not the query, that was wrong for four
   * days. Handing over the raw sums moves `dayState` and `cleanPpm` in here, where `projectStatus`
   * already lives precisely so "the leak test does not need a database, a socket or a clock".
   */
  readonly uptime: readonly (DayCounts & {
    readonly productGroup: string
    readonly day: string
  })[]
  readonly incidents: readonly { readonly incident: Incident; readonly updates: readonly IncidentUpdate[] }[]
  readonly maintenance: readonly {
    readonly productGroup: string
    readonly summary: string
    readonly startsAt: Date
    readonly endsAt: Date
  }[]
}

/**
 * Build the whole public document.
 *
 * Pure, so the leak test does not need a database, a socket or a clock — which matters, because a
 * redaction test that is awkward to run is a redaction test that gets skipped.
 */
export function projectStatus(input: ProjectionInput): PublicStatus {
  const byGroup = new Map<string, PublicState[]>()
  for (const probe of input.probes) {
    const list = byGroup.get(probe.productGroup) ?? []
    list.push(publicStateOfProbe(probe.state))
    byGroup.set(probe.productGroup, list)
  }

  const daysByGroup = new Map<string, PublicDay[]>()
  for (const row of input.uptime) {
    // A day with no checks in it is NOT a bar. It is dropped, so the array carries only days this
    // service actually measured and `status-web` can say "measured since {the first date here}"
    // rather than counting an unmeasured day as one that came back dirty — which is the other half
    // of what made the 2026-08-07 page read "0.0% of 4 measured days came back clean · 86 days we
    // never measured". `dailyUptime` already excludes them in SQL; this is the guard for any other
    // caller, and it is here rather than inside `dayState` because there is no honest colour for a
    // day nobody looked at. Rendering a named hole beats painting a plausible one.
    if (row.checks <= 0) continue
    const list = daysByGroup.get(row.productGroup) ?? []
    list.push(
      seal(PUBLIC_DAY_FIELDS, {
        date: row.day,
        state: dayState(row),
        cleanPpm: cleanPpm(row),
      }),
    )
    daysByGroup.set(row.productGroup, list)
  }

  const now = input.generatedAt.getTime()
  const activeMaintenance = new Set(
    input.maintenance
      .filter((window) => window.startsAt.getTime() <= now && window.endsAt.getTime() > now)
      .map((window) => window.productGroup),
  )

  const groups: PublicGroup[] = [...byGroup.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, states]) =>
      seal(PUBLIC_GROUP_FIELDS, {
        group,
        // A group in a declared maintenance window reads `maintenance` unless something is
        // actually down. Announced work that reads as an outage is how a status page loses the
        // benefit of having announced it.
        state: activeMaintenance.has(group) ? worst([...states, 'maintenance']) : worst(states),
        uptime: daysByGroup.get(group) ?? [],
      }),
    )

  return seal(PUBLIC_STATUS_FIELDS, {
    generatedAt: input.generatedAt.toISOString(),
    // The empty case is NOT `worst([])`. See the note on `PublicStatus.state`: a fold's identity
    // is the right answer for a group, whose set can never be empty, and a lie for the estate,
    // whose set is empty exactly when nothing has been measured.
    state: groups.length === 0 ? null : worst(groups.map((group) => group.state)),
    incidents: input.incidents.map((entry) => projectIncident(entry.incident, entry.updates)),
    groups,
    maintenance: input.maintenance.map((window) =>
      seal(PUBLIC_MAINTENANCE_FIELDS, {
        group: window.productGroup,
        summary: window.summary,
        startsAt: window.startsAt.toISOString(),
        endsAt: window.endsAt.toISOString(),
      }),
    ),
  })
}

/* ------------------------------------------------------------------ the daily bars */

/**
 * Ninety days of per-group uptime, from `check_rollups`.
 *
 * **This function no longer decides anything.** It sums, and `projectStatus` classifies — see
 * `dayState` for the fold that was wrong for four days and for why the replacement has no
 * threshold in it. The split is deliberate: the classification is the part that was defective, and
 * it now lives in the pure module that the suite can drive without a database, a socket or a clock.
 *
 * `sum(r.total)` is the denominator and it is summed here rather than derived from
 * `up + degraded + down`, because `checks` has a `state in ('up','degraded','down')` constraint
 * today and a fourth word added tomorrow would silently make a derived denominator too small — and
 * a too-small denominator makes every day look cleaner than it was, which is the direction an
 * honesty fix must never be able to fail in.
 *
 * `having sum(r.total) > 0` rather than letting a zero-check day through: a rollup row that
 * recorded nothing is not a measurement, and a day that was never measured must not be given a
 * colour. It is absent from the array instead, which is what lets the reader say what is missing.
 */
export async function dailyUptime(
  sql: Sql,
  days = 90,
): Promise<readonly (DayCounts & { productGroup: string; day: string })[]> {
  const rows = (await sql`
    select p.product_group,
           to_char(date_trunc('day', r.bucket), 'YYYY-MM-DD') as day,
           sum(r.total)::bigint    as checks,
           sum(r.down)::bigint     as down,
           sum(r.degraded)::bigint as degraded
      from check_rollups r
      join probes p on p.name = r.probe_name
     where r.bucket > now() - make_interval(days => ${days})
     group by p.product_group, day
    having sum(r.total) > 0
     order by day
  `) as unknown as Array<{
    product_group: string
    day: string
    checks: string
    down: string
    degraded: string
  }>
  return rows.map((row) => ({
    productGroup: row.product_group,
    day: row.day,
    // `sum(...)::bigint` comes back as a string from `postgres`, and these are counts of checks in
    // one group on one day — four figures at this estate's cadences. `Number` is exact here and
    // `cleanPpm` documents the headroom; the `bigint` the old fold used bought nothing but a
    // comparison against `0n`.
    checks: Number(row.checks),
    down: Number(row.down),
    degraded: Number(row.degraded),
  }))
}

export async function activeMaintenance(
  sql: Sql,
  now: Date = new Date(),
): Promise<
  readonly { productGroup: string; summary: string; startsAt: Date; endsAt: Date }[]
> {
  const rows = (await sql`
    select product_group, summary, starts_at, ends_at
      from maintenance_windows
     where ends_at > ${now}
     order by starts_at
  `) as unknown as Array<{
    product_group: string
    summary: string
    starts_at: Date
    ends_at: Date
  }>
  return rows.map((row) => ({
    productGroup: row.product_group,
    summary: row.summary,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  }))
}
