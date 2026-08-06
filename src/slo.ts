/**
 * SLOs and error budgets.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE BUDGET IS INTEGER ARITHMETIC OVER RECORDED EVENTS. IT IS NOT A GAUGE SOMEBODY EYEBALLS.**
 *
 * An error budget only does its job if both sides agree on the number at the moment one of them
 * wants to ship and the other does not. That agreement is impossible if the figure is a float:
 * `total * 0.9995` is not associative, two services computing it in different orders get different
 * last digits, and the argument becomes about arithmetic instead of about the release.
 *
 * So: the objective is stored as **parts per million as an integer** (99.95% is `999_500`), every
 * count is a `bigint`, and nothing here divides in floating point. `remaining` is a whole number of
 * events you may still fail, which is a thing a human can hold and a pipeline can compare against
 * zero.
 *
 * Rounding is deliberately asymmetric and both directions are chosen, not defaulted:
 *
 *   * `requiredGood` rounds **up**. A budget that rounds in the operator's favour is a budget that
 *     is slightly larger than the objective promises, which means the SLO is not the SLO.
 *   * `consumedPpm` rounds **up**. Reporting 74% consumed when 74.4% is spent is how a service
 *     crosses the 75%-consumed policy line without the review the policy requires.
 *
 * Both are one-line functions here rather than expressions at three call sites, so there is one
 * place where the rounding of a budget is decided.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The tiers, objectives and the budget policy come from 13-operational-model.md §8:
 * Tier 1 money services at 99.95% (21 minutes over 28 days), Tier 2 product services at 99.5%
 * (3h 22m), the ledger's trial balance at **100% with no budget at all**, and journey SLOs at
 * "99% of scheduled runs pass — a skip counts against it, because a skip is not a pass".
 */

import type { Sql } from '@cloudsforge/db'

/** One million. The unit of `objective_ppm`, named so the constant is not a bare literal. */
export const PPM = 1_000_000n

/** A burn rate of exactly 1.0x, in milli-units. 14.4x is `14_400`. */
export const BURN_UNIT = 1_000n

export type SloKind = 'availability' | 'journey' | 'latency' | 'correctness'

export interface Slo {
  readonly name: string
  readonly service: string
  readonly tier: number
  readonly kind: SloKind
  /** Parts per million. `1_000_000` means no budget. */
  readonly objectivePpm: bigint
  readonly windowDays: number
  readonly enabled: boolean
}

export interface ErrorBudget {
  readonly slo: string
  /** Events observed in the window. */
  readonly total: bigint
  readonly good: bigint
  readonly bad: bigint
  /** How many events the objective permits to be bad across the whole window. */
  readonly allowedBad: bigint
  /** `allowedBad - bad`. Negative means overspent, and by how much. */
  readonly remaining: bigint
  /** Parts per million of the budget spent, rounded up. Capped at `PPM`. */
  readonly consumedPpm: bigint
  /**
   * The whole budget is spent. **What the gate reads.**
   *
   * Derived from `consumedPpm`, not from `remaining <= 0`, and the difference is a real case
   * rather than a stylistic one. A 100%-objective SLO — the ledger's trial balance — has
   * `allowedBad = 0` and therefore `remaining = 0` from its very first clean minute. Reading
   * exhaustion off `remaining` would freeze that service permanently, on the day it was created,
   * for being perfect. `consumedPpm` distinguishes "nothing to spend" from "spent".
   */
  readonly exhausted: boolean
  /**
   * True when nothing was observed.
   *
   * **An empty window is not a green window.** A service with no traffic and no probes has not
   * demonstrated anything, and treating "zero bad out of zero" as 100% availability is how a
   * scheduler that died reads as an estate that is perfectly healthy. The gate refuses on this.
   */
  readonly indeterminate: boolean
}

/** `ceil(a / b)` for non-negative integers, without leaving the integers. */
function ceilDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n
  return (a + b - 1n) / b
}

/**
 * The whole of the budget arithmetic, in one pure function over three integers.
 *
 * Pure and exported so the property that matters — that it never loses a low bit — is testable
 * without a database, a clock or a probe.
 */
export function computeBudget(
  name: string,
  total: bigint,
  good: bigint,
  objectivePpm: bigint,
): ErrorBudget {
  if (total < 0n || good < 0n) throw new RangeError('an event count cannot be negative')
  if (good > total) throw new RangeError('good events cannot exceed total events')
  if (objectivePpm <= 0n || objectivePpm > PPM) {
    throw new RangeError(`objectivePpm must be within (0, ${PPM}]`)
  }

  const bad = total - good
  // Rounds UP: see the header. At objectivePpm = PPM this is exactly `total`, so `allowedBad` is
  // zero and the first bad event exhausts the budget — which is what "100%, no budget" means.
  const requiredGood = ceilDiv(total * objectivePpm, PPM)
  const allowedBad = total - requiredGood
  const remaining = allowedBad - bad

  const consumedPpm =
    allowedBad === 0n
      ? bad > 0n
        ? PPM
        : 0n
      : // Capped rather than allowed to exceed PPM: "180% of the budget consumed" is a true
        // statement that no dashboard renders usefully, and `remaining` already carries the
        // overspend exactly.
        bigintMin(PPM, ceilDiv(bad * PPM, allowedBad))

  return {
    slo: name,
    total,
    good,
    bad,
    allowedBad,
    remaining,
    consumedPpm,
    exhausted: consumedPpm >= PPM,
    indeterminate: total === 0n,
  }
}

function bigintMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}

/**
 * Budget remaining as a ratio, for `beacon_slo_budget_remaining_ratio`.
 *
 * The exposition format is a float because Prometheus has no other number. That is a rendering
 * concern and it happens HERE, at the boundary, once — the ledger behind it stays integral. A
 * float that is only ever produced for display cannot drift into a decision.
 */
export function remainingRatio(budget: ErrorBudget): number {
  if (budget.allowedBad === 0n) return budget.bad > 0n ? 0 : 1
  if (budget.remaining <= 0n) return 0
  return Number((budget.remaining * PPM) / budget.allowedBad) / Number(PPM)
}

/**
 * Burn rate in milli-units: `1_000` is 1.0x, `14_400` is the 1-hour paging threshold.
 *
 * The multi-window pair from 13-operational-model.md — 14.4x over 1h pages (2% of a 28-day
 * budget in an hour), 6x over 6h tickets. A single window cannot serve both: a short one pages on
 * every blip, a long one fires after the budget is already gone.
 */
export function burnRateMilli(total: bigint, good: bigint, objectivePpm: bigint): bigint {
  if (total <= 0n) return 0n
  if (objectivePpm >= PPM) return good < total ? BURN_UNIT * PPM : 0n
  const bad = total - good
  const allowedPpm = PPM - objectivePpm
  return (bad * PPM * BURN_UNIT) / (total * allowedPpm)
}

/* ------------------------------------------------------------------ persistence */

interface SloRow {
  name: string
  service: string
  tier: number
  kind: string
  objective_ppm: string | bigint
  window_days: number
  enabled: boolean
}

function toSlo(row: SloRow): Slo {
  return {
    name: row.name,
    service: row.service,
    tier: Number(row.tier),
    kind: row.kind as SloKind,
    // postgres.js hands back `bigint` columns as strings by default so that a value above
    // Number.MAX_SAFE_INTEGER survives the driver. Converting through BigInt rather than Number is
    // what keeps that true all the way to the arithmetic.
    objectivePpm: BigInt(row.objective_ppm),
    windowDays: Number(row.window_days),
    enabled: row.enabled,
  }
}

export async function upsertSlo(sql: Sql, slo: Slo): Promise<void> {
  await sql`
    insert into slos (name, service, tier, kind, objective_ppm, window_days, enabled)
    values (${slo.name}, ${slo.service}, ${slo.tier}, ${slo.kind},
            ${slo.objectivePpm.toString()}, ${slo.windowDays}, ${slo.enabled})
    on conflict (name) do update set
      service = excluded.service, tier = excluded.tier, kind = excluded.kind,
      objective_ppm = excluded.objective_ppm, window_days = excluded.window_days,
      enabled = excluded.enabled
  `
}

export async function listSlos(sql: Sql): Promise<readonly Slo[]> {
  const rows = (await sql`select * from slos order by tier, name`) as unknown as SloRow[]
  return rows.map(toSlo)
}

/**
 * Add observations to a bucket.
 *
 * **`+ excluded`, never `= excluded`.** These are counters. An upsert that overwrote them would
 * make a re-run of an evaluation silently discard everything the previous run recorded in the same
 * minute — which is a lost failure, and a lost failure is a budget that reads healthier than the
 * service is.
 */
export async function recordObservation(
  sql: Sql,
  sloName: string,
  bucket: Date,
  good: bigint,
  total: bigint,
): Promise<void> {
  if (good > total) throw new RangeError('good events cannot exceed total events')
  await sql`
    insert into slo_observations (slo_name, bucket, good, total)
    values (${sloName}, ${bucket}, ${good.toString()}, ${total.toString()})
    on conflict (slo_name, bucket) do update set
      good = slo_observations.good + excluded.good,
      total = slo_observations.total + excluded.total
  `
}

/** The budget for one SLO over its own window, as of `now`. */
export async function budgetFor(sql: Sql, slo: Slo, now: Date = new Date()): Promise<ErrorBudget> {
  const from = new Date(now.getTime() - slo.windowDays * 86_400_000)
  const rows = (await sql`
    select coalesce(sum(good), 0)::bigint as good, coalesce(sum(total), 0)::bigint as total
      from slo_observations
     where slo_name = ${slo.name} and bucket > ${from} and bucket <= ${now}
  `) as unknown as Array<{ good: string; total: string }>
  const row = rows[0] ?? { good: '0', total: '0' }
  return computeBudget(slo.name, BigInt(row.total), BigInt(row.good), slo.objectivePpm)
}

/** Every enabled SLO's budget. The gate reads this and the metrics endpoint renders it. */
export async function allBudgets(sql: Sql, now: Date = new Date()): Promise<readonly ErrorBudget[]> {
  const slos = await listSlos(sql)
  const out: ErrorBudget[] = []
  for (const slo of slos) {
    if (!slo.enabled) continue
    out.push(await budgetFor(sql, slo, now))
  }
  return out
}

/**
 * The budget policy of 13-operational-model.md, as a value rather than as a paragraph.
 *
 * 50% consumed is a ticket; 75% reprioritises reliability work above features; **100% is a change
 * freeze on that service**, which is the line the gate enforces.
 */
export type BudgetPolicy = 'ok' | 'ticket' | 'reprioritise' | 'freeze'

export function policyFor(budget: ErrorBudget): BudgetPolicy {
  if (budget.exhausted) return 'freeze'
  if (budget.consumedPpm >= 750_000n) return 'reprioritise'
  if (budget.consumedPpm >= 500_000n) return 'ticket'
  return 'ok'
}
