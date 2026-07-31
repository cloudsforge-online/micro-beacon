/**
 * Conformance runs.
 *
 * The corpus belongs to `@cloudsforge/conformance`: 60 recorded interactions across eight
 * scenarios, each classifying a difference as `identical`, `benign` or `breaking`, exiting 1 on a
 * breaking one and only on a breaking one. That asymmetry is the whole value of the tool — adding
 * a field is benign, removing one is breaking; an array growing is benign, shrinking is breaking —
 * and it is deliberately not re-implemented here.
 *
 * **What this module owns is the operational fact that a run happened and what it said.** Beacon
 * is where the corpus is executed on a schedule and where the result becomes a gate input, because
 * a comparison nothing runs is a comparison nobody has made. 00-current-state.md:301 records the
 * same situation on the chain side: the vector suites gate the rewrite's correctness and Hearth's
 * own CI runs none of them, so Beacon is the only place they are executed at all.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THERE IS NO PATH HERE THAT PRODUCES A GREEN ROW WITHOUT HAVING RUN SOMETHING.**
 *
 * `conformance_runs_pass_ran_something` refuses a `pass` with zero comparisons, and
 * `conformance_runs_pass_has_no_breaking` refuses a `pass` alongside a breaking difference. Both
 * are CHECK constraints rather than assertions in this file, because the failure they prevent —
 * "the suite has been green for a month" when the suite has not executed for a month — is
 * invisible by construction and would be found by nobody.
 *
 * A suite that could not be run reports `skip` with the reason. Never `pass`. The spec is explicit:
 * *if a vector cannot be made to pass, the correct response is to say so, not to skip it.*
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Sql } from '@cloudsforge/db'

export type ConformanceStatus = 'pass' | 'fail' | 'skip' | 'error'

export interface ConformanceRun {
  readonly id: string
  readonly ts: Date
  readonly suite: string
  readonly status: ConformanceStatus
  readonly identical: number
  readonly benign: number
  /** The only count that blocks a release. See the module header. */
  readonly breaking: number
  readonly skipped: number
  readonly durationMs: number | null
  readonly releaseTag: string | null
  /** Which corpus this was compared against — a commit, a tag, a path. */
  readonly corpusRef: string | null
}

export interface ConformanceReport {
  readonly suite: string
  readonly status: ConformanceStatus
  readonly identical?: number
  readonly benign?: number
  readonly breaking?: number
  readonly skipped?: number
  readonly durationMs?: number | undefined
  readonly releaseTag?: string | undefined
  readonly corpusRef?: string | undefined
}

interface ConformanceRow {
  id: string
  ts: Date
  suite: string
  status: string
  identical: number
  benign: number
  breaking: number
  skipped: number
  duration_ms: number | null
  release_tag: string | null
  corpus_ref: string | null
}

function toRun(row: ConformanceRow): ConformanceRun {
  return {
    id: row.id,
    ts: row.ts,
    suite: row.suite,
    status: row.status as ConformanceStatus,
    identical: Number(row.identical),
    benign: Number(row.benign),
    breaking: Number(row.breaking),
    skipped: Number(row.skipped),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
    releaseTag: row.release_tag,
    corpusRef: row.corpus_ref,
  }
}

/**
 * Derive the status rather than accepting one.
 *
 * A caller that reported its own status could report `pass` alongside a breaking difference, and
 * the constraint would then reject the write with a message about a check name. Deriving it here
 * means the two counts and the verdict cannot disagree in the first place — the constraint stays
 * as the thing that catches a future writer who bypasses this function.
 */
export function statusFor(counts: {
  readonly identical: number
  readonly benign: number
  readonly breaking: number
}): ConformanceStatus {
  if (counts.breaking > 0) return 'fail'
  if (counts.identical + counts.benign === 0) return 'skip'
  return 'pass'
}

export async function recordConformanceRun(
  sql: Sql,
  report: ConformanceReport,
): Promise<ConformanceRun> {
  const rows = (await sql`
    insert into conformance_runs
      (suite, status, identical, benign, breaking, skipped, duration_ms, release_tag, corpus_ref)
    values (${report.suite}, ${report.status}, ${report.identical ?? 0}, ${report.benign ?? 0},
            ${report.breaking ?? 0}, ${report.skipped ?? 0}, ${report.durationMs ?? null},
            ${report.releaseTag ?? null}, ${report.corpusRef ?? null})
    returning *
  `) as unknown as ConformanceRow[]
  const row = rows[0]
  if (!row) throw new Error('conformance insert returned no row')
  return toRun(row)
}

/** The most recent run of each suite. What the gate reads. */
export async function latestConformance(sql: Sql): Promise<readonly ConformanceRun[]> {
  const rows = (await sql`
    select distinct on (suite) * from conformance_runs order by suite, ts desc
  `) as unknown as ConformanceRow[]
  return rows.map(toRun)
}

export async function conformanceHistory(
  sql: Sql,
  suite: string | null,
  limit = 100,
): Promise<readonly ConformanceRun[]> {
  const rows = (await sql`
    select * from conformance_runs
     where true ${suite ? sql`and suite = ${suite}` : sql``}
     order by ts desc
     limit ${Math.min(limit, 500)}
  `) as unknown as ConformanceRow[]
  return rows.map(toRun)
}
