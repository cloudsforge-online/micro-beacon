/**
 * **The release gate. AD-04.**
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE GATE IS FAIL-CLOSED. AN UNKNOWN IS NOT A PASS.**
 *
 * This is the single most important behaviour in this repository, so it is stated once, here, and
 * then enforced in three independent places so that removing it takes three deliberate acts:
 *
 *   1. `decide()` returns `refuse` the moment any input is `unknown`, before it looks at anything
 *      else, and **an override cannot reach an unknown** — see `applyOverride` below.
 *   2. `gate_decisions` carries a CHECK constraint, `gate_decisions_indeterminate_never_promotes`,
 *      so a promotion recorded against an indeterminate evaluation cannot commit.
 *   3. `cli.ts` exits non-zero on anything that is not `promote` or `promote_with_override`, and
 *      exits non-zero on its own failure to reach Beacon at all. A pipeline that cannot ask does
 *      not ship.
 *
 * Why this and not "assume green when we have no data": every plausible way of losing the signal —
 * the scheduler dying, a database being unreachable, a journey never having been deployed, a
 * probe's target being renamed — produces MISSING data, not red data. A gate that treats missing
 * as green is a gate that opens hardest exactly when the estate is least observable. The frozen
 * estate is the worked example: 18-build-status.md:150 records that no cross-service integration
 * has ever run, and nothing anywhere reported that as a failure, because nothing was asked.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What the gate decides, in one sentence: **whether a release manifest may be promoted.** It reads
 * journeys, error budgets, conformance and open incidents, and answers `promote`,
 * `promote_with_override` or `refuse` with machine-readable reason codes. It is an endpoint and a
 * CLI exit code, not a dashboard: 08-prioritised-backlog ENA-37 requires the refusal to be
 * "enforced in the workflow, not by convention".
 */

import type { Sql } from '@cloudsforge/db'
import {
  latestRuns,
  listRegistered,
  recentRuns,
  type JourneyStatus,
} from './journeys.ts'
import { allBudgets, type ErrorBudget } from './slo.ts'
import { latestConformance } from './conformance.ts'
import { listOpen, type Severity } from './incidents.ts'

/**
 * Every reason the gate can give, as a closed set.
 *
 * Machine-readable and stable, because a pipeline branches on these and an override names one.
 * Prose belongs in `detail`; if a caller has to regex the prose to find out what happened, the
 * code is missing.
 */
export type ReasonCode =
  /* ---- known failures: we looked, and it is bad ---- */
  | 'journey_failing'
  | 'journey_skipped'
  | 'journey_muted'
  | 'journey_recent_failure'
  | 'error_budget_exhausted'
  | 'conformance_breaking'
  | 'incident_open'
  /* ---- unknowns: we could not find out, which is worse ---- */
  | 'journey_never_run'
  | 'journey_stale'
  | 'journey_insufficient_history'
  | 'error_budget_no_data'
  | 'conformance_never_run'
  | 'conformance_inconclusive'
  | 'beacon_unavailable'

/**
 * `known` — we looked and it is bad. `unknown` — we could not find out.
 *
 * The distinction is the whole design. They both refuse; only one of them may ever be overridden,
 * because "ship it anyway, I know about that" is a decision a human can be accountable for and
 * "ship it anyway, nobody knows" is not a decision at all.
 */
export type Determinacy = 'known' | 'unknown'

export interface GateReason {
  readonly code: ReasonCode
  /** The journey, SLO, suite or incident this is about. Used to scope an override. */
  readonly subject: string
  readonly detail: string
  readonly determinacy: Determinacy
}

const UNKNOWN_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'journey_never_run',
  'journey_stale',
  'journey_insufficient_history',
  'error_budget_no_data',
  'conformance_never_run',
  'conformance_inconclusive',
  'beacon_unavailable',
])

/** Single source of truth for the classification, so a new code cannot be silently `known`. */
export function determinacyOf(code: ReasonCode): Determinacy {
  return UNKNOWN_CODES.has(code) ? 'unknown' : 'known'
}

function reason(code: ReasonCode, subject: string, detail: string): GateReason {
  return { code, subject, detail, determinacy: determinacyOf(code) }
}

export type GateVerdict = 'promote' | 'promote_with_override' | 'refuse'

export interface GateOverride {
  readonly releaseTag: string
  readonly reasonCode: ReasonCode
  /** `'*'` waives the code for every subject. Deliberately explicit. */
  readonly subject: string
  readonly reason: string
  readonly requestedBy: string
  readonly expiresAt: Date
}

export interface GateDecision {
  readonly releaseTag: string
  readonly decision: GateVerdict
  /** Everything that blocked, whether or not it was waived. Never pruned. */
  readonly reasons: readonly GateReason[]
  /** The subset that an active override waived. Empty on a plain `promote`. */
  readonly waived: readonly GateReason[]
  /** True if any input was `unknown`. Implies `refuse`, always. */
  readonly indeterminate: boolean
}

/**
 * The decision, as a pure function of the reasons and the overrides in force.
 *
 * Pure and exported so the property this whole repository exists to guarantee — that an unknown
 * never promotes — is provable without a database, a clock, an HTTP server or a probe.
 */
export function decide(
  releaseTag: string,
  reasons: readonly GateReason[],
  overrides: readonly GateOverride[] = [],
  now: Date = new Date(),
): GateDecision {
  const unknowns = reasons.filter((r) => r.determinacy === 'unknown')

  if (unknowns.length > 0) {
    // ────────────────────────────────────────────────────────────────────────────────────────
    // The fail-closed branch, and it is FIRST so nothing can be evaluated ahead of it.
    //
    // `waived` is empty by construction here: an override is not consulted at all on this path.
    // Making it unreachable rather than merely unusual is the point — a future edit that adds a
    // waiver step further down cannot accidentally apply it to an unknown, because there is no
    // further down.
    // ────────────────────────────────────────────────────────────────────────────────────────
    return { releaseTag, decision: 'refuse', reasons, waived: [], indeterminate: true }
  }

  if (reasons.length === 0) {
    return { releaseTag, decision: 'promote', reasons: [], waived: [], indeterminate: false }
  }

  const active = overrides.filter((o) => o.releaseTag === releaseTag && o.expiresAt > now)
  const waived: GateReason[] = []
  const blocking: GateReason[] = []

  for (const r of reasons) {
    const covered = active.some(
      (o) => o.reasonCode === r.code && (o.subject === '*' || o.subject === r.subject),
    )
    if (covered) waived.push(r)
    else blocking.push(r)
  }

  if (blocking.length > 0) {
    return { releaseTag, decision: 'refuse', reasons, waived, indeterminate: false }
  }

  // Never a plain `promote`. A release that only shipped because somebody waived something must
  // say so in its own record, or the next person reading the promotion history sees a clean run.
  return { releaseTag, decision: 'promote_with_override', reasons, waived, indeterminate: false }
}

/* ------------------------------------------------------------------ gathering the inputs */

export interface GateInputs {
  readonly freshnessMs: number
  readonly consecutiveGreen: number
  readonly now: Date
}

/**
 * Collect every reason a release should not promote.
 *
 * Deliberately collects them ALL rather than short-circuiting on the first. A gate that reports
 * one problem per run makes fixing three problems take three deploys, and the third one is found
 * at 6pm on the day of the release.
 */
export async function collectReasons(sql: Sql, inputs: GateInputs): Promise<readonly GateReason[]> {
  const reasons: GateReason[] = []

  /* ---- journeys ---- */

  const registered = await listRegistered(sql)
  const latest = new Map((await latestRuns(sql)).map((r) => [r.journey, r]))

  for (const journey of registered) {
    if (journey.muted) {
      // 17-definition-of-done.md:237 — the muted count must be ZERO at a gate. A muted journey is
      // not a passing journey; it is an unmeasured one, and it is `known` rather than `unknown`
      // because somebody chose it and left their name on it.
      reasons.push(
        reason(
          'journey_muted',
          journey.name,
          `muted by ${journey.mutedBy ?? 'unknown'}: ${journey.mutedReason ?? 'no reason given'}`,
        ),
      )
      continue
    }
    if (!journey.critical) continue

    const run = latest.get(journey.name)
    if (!run) {
      reasons.push(reason('journey_never_run', journey.name, 'no scheduled run has ever been recorded'))
      continue
    }

    const ageMs = inputs.now.getTime() - run.startedAt.getTime()
    if (ageMs > inputs.freshnessMs) {
      // THE ONE THAT CATCHES A DEAD SCHEDULER. A journey that stopped running reports its last
      // status for ever, so a green grid can mean nothing has run since Tuesday. Nothing else in
      // the system notices this.
      reasons.push(
        reason(
          'journey_stale',
          journey.name,
          `last run was ${Math.round(ageMs / 1000)}s ago, older than the ${Math.round(inputs.freshnessMs / 1000)}s horizon`,
        ),
      )
      continue
    }

    if (run.status === 'skip') {
      // A skip is never green. It counts against the journey exactly as a failure would, because
      // the journeys that quietly did nothing are the easiest ones to fake.
      reasons.push(reason('journey_skipped', journey.name, 'the most recent run was a skip'))
      continue
    }
    if (run.status !== 'pass') {
      reasons.push(
        reason('journey_failing', journey.name, `the most recent run was a ${run.status}`),
      )
      continue
    }

    // Three consecutive green runs, not one (13-operational-model.md:150). One green run after a
    // red one is a flake that happened to land the right way up.
    const recent = await recentRuns(sql, journey.name, inputs.consecutiveGreen)
    if (recent.length < inputs.consecutiveGreen) {
      reasons.push(
        reason(
          'journey_insufficient_history',
          journey.name,
          `only ${recent.length} of the required ${inputs.consecutiveGreen} runs have been recorded`,
        ),
      )
      continue
    }
    const red = recent.find((r) => r.status !== 'pass')
    if (red) {
      reasons.push(
        reason(
          'journey_recent_failure',
          journey.name,
          `a ${red.status} appears within the last ${inputs.consecutiveGreen} runs`,
        ),
      )
    }
  }

  /* ---- error budgets ---- */

  for (const budget of await allBudgets(sql, inputs.now)) {
    if (budget.indeterminate) {
      // Zero observations is not 100% availability. A service nothing has measured has not
      // demonstrated anything, and treating an empty window as perfect is how a broken collector
      // reads as a perfect estate.
      reasons.push(
        reason('error_budget_no_data', budget.slo, 'no observations recorded in the window'),
      )
      continue
    }
    if (budget.exhausted) {
      // 100% consumed is a change freeze on that service (13-operational-model.md:444). This is
      // the gate being the freeze rather than a paragraph describing one.
      reasons.push(
        reason(
          'error_budget_exhausted',
          budget.slo,
          `${budget.bad} bad events against an allowance of ${budget.allowedBad} (${budget.remaining} remaining)`,
        ),
      )
    }
  }

  /* ---- conformance ---- */

  const conformance = await latestConformance(sql)
  if (conformance.length === 0) {
    reasons.push(reason('conformance_never_run', 'conformance', 'no conformance run has been recorded'))
  }
  for (const run of conformance) {
    // ────────────────────────────────────────────────────────────────────────────────────────
    // A SUITE THAT DID NOT RUN IS NOT A SUITE THAT PASSED, AND UNTIL 2026-08-04 THIS LOOP
    // TREATED THE TWO THE SAME.
    //
    // The only thing asked of a recorded run was `breaking > 0`. `conformance.ts` is explicit
    // that "a suite that could not be run reports `skip` with the reason — never `pass`", and
    // the database enforces the other half with `conformance_runs_pass_ran_something`. But a
    // `skip` row carries `breaking = 0`, so it fell through this loop saying nothing at all —
    // and because the ONLY other conformance input is `conformance.length === 0`, one skipped
    // suite was enough to retire `conformance_never_run` and leave the gate with no
    // characterisation evidence and no reason code to say so.
    //
    // That is the exact shape of failure this repository exists to prevent, arrived at from the
    // other side: not a green row without a run, but a run whose honest "I could not look"
    // silenced the only code that was watching. The estate can produce it today — six of the
    // corpus's eight scenarios skip because the services they characterise are not deployed —
    // so this was one `POST /v1/conformance` away from turning an indeterminate gate
    // determinate without a single comparison having been made.
    //
    // `skip` and `error` are therefore UNKNOWN: nobody found out. They cannot be overridden,
    // which is right — "ship it anyway, the suite could not run" is not a decision anyone can
    // be accountable for, and `addOverride` refuses it at the point of creation.
    // ────────────────────────────────────────────────────────────────────────────────────────
    if (run.status === 'skip' || run.status === 'error') {
      reasons.push(
        reason(
          'conformance_inconclusive',
          run.suite,
          `the most recent run was a ${run.status}, so nothing was compared ` +
            `(${run.identical} identical, ${run.benign} benign, ${run.skipped} skipped)`,
        ),
      )
      continue
    }
    // `status` and `breaking` are derived together by `statusFor`, so a `fail` carries a
    // breaking count and a breaking count carries a `fail`. Both are read anyway: the pair can
    // only disagree by a write that bypassed `recordConformanceRun`, and the failure mode of
    // reading just one of them is that such a row reports clean.
    if (run.status === 'fail' || run.breaking > 0) {
      reasons.push(
        reason(
          'conformance_breaking',
          run.suite,
          `${run.breaking} breaking difference(s) against the recorded corpus`,
        ),
      )
    }
  }

  /* ---- open incidents ---- */

  for (const incident of await listOpen(sql)) {
    if (!blocksRelease(incident.severity)) continue
    reasons.push(
      reason(
        'incident_open',
        incident.subject,
        `${incident.severity.toUpperCase()} open since ${incident.openedAt.toISOString()}`,
      ),
    )
  }

  return reasons
}

/**
 * SEV1 and SEV2 block; SEV3 and SEV4 do not.
 *
 * SEV3 is "degraded but working" and SEV4 is "no user impact" — refusing on those would mean the
 * estate could not ship the fix for a certificate expiring in a fortnight, and a gate that blocks
 * its own remedy gets switched off.
 */
export function blocksRelease(severity: Severity): boolean {
  return severity === 'sev1' || severity === 'sev2'
}

/* ------------------------------------------------------------------ evaluation and record */

/**
 * The defaults, here rather than read from `env.ts`.
 *
 * `env.ts` validates eagerly and calls `process.exit(1)` on a bad configuration, which is correct
 * for a service and wrong for a library: importing it from here would put a process exit in the
 * import graph of every test that touches the gate, and of `cli.ts --url`, which must be able to
 * make an HTTP request without holding a database connection string. The deploy's values are
 * passed in by `index.ts` and `server.ts`; these are what applies when nobody says.
 */
export const DEFAULT_FRESHNESS_MS = 20 * 60_000
export const DEFAULT_CONSECUTIVE_GREEN = 3

export interface EvaluateOptions {
  readonly freshnessMs?: number
  readonly consecutiveGreen?: number
  readonly now?: Date
  /** Skip the write. The CLI and `GET /v1/gate` use this: asking must not change the record. */
  readonly record?: boolean
  readonly evaluatedBy?: string
}

/**
 * Evaluate the gate for a release and, by default, record the decision.
 *
 * **A failure to gather the inputs is itself a refusal.** If the database cannot be read the
 * catch below produces `beacon_unavailable`, which is an `unknown`, which refuses. It does not
 * rethrow: an exception reaching the caller would be handled by whatever the caller does with
 * exceptions, and one plausible thing a caller does with an exception is log it and carry on.
 */
export async function evaluate(
  sql: Sql,
  releaseTag: string,
  options: EvaluateOptions = {},
): Promise<GateDecision> {
  const now = options.now ?? new Date()
  const inputs: GateInputs = {
    freshnessMs: options.freshnessMs ?? DEFAULT_FRESHNESS_MS,
    consecutiveGreen: options.consecutiveGreen ?? DEFAULT_CONSECUTIVE_GREEN,
    now,
  }

  let reasons: readonly GateReason[]
  let overrides: readonly GateOverride[] = []
  try {
    reasons = await collectReasons(sql, inputs)
    overrides = await activeOverrides(sql, releaseTag, now)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    const decision = decide(
      releaseTag,
      [reason('beacon_unavailable', 'beacon', `the gate could not read its own state: ${detail}`)],
      [],
      now,
    )
    // Deliberately NOT recorded: the write would use the connection that just failed, and a throw
    // from inside the failure path would replace a clean refusal with a stack trace.
    return decision
  }

  const decision = decide(releaseTag, reasons, overrides, now)
  if (options.record !== false) {
    await recordDecision(sql, decision, options.evaluatedBy ?? 'beacon')
  }
  return decision
}

export async function recordDecision(
  sql: Sql,
  decision: GateDecision,
  evaluatedBy: string,
): Promise<void> {
  await sql`
    insert into gate_decisions (release_tag, decision, reasons, indeterminate, evaluated_by)
    values (${decision.releaseTag}, ${decision.decision},
            ${JSON.stringify(decision.reasons)}::jsonb, ${decision.indeterminate}, ${evaluatedBy})
  `
}

export interface RecordedDecision extends GateDecision {
  readonly decidedAt: Date
  readonly evaluatedBy: string
}

export async function decisionHistory(
  sql: Sql,
  releaseTag: string,
  limit = 20,
): Promise<readonly RecordedDecision[]> {
  const rows = (await sql`
    select release_tag, decision, reasons, indeterminate, decided_at, evaluated_by
      from gate_decisions
     where release_tag = ${releaseTag}
     order by decided_at desc
     limit ${Math.min(limit, 200)}
  `) as unknown as Array<{
    release_tag: string
    decision: string
    reasons: GateReason[] | string
    indeterminate: boolean
    decided_at: Date
    evaluated_by: string
  }>
  return rows.map((row) => ({
    releaseTag: row.release_tag,
    decision: row.decision as GateVerdict,
    reasons: typeof row.reasons === 'string' ? (JSON.parse(row.reasons) as GateReason[]) : row.reasons,
    waived: [],
    indeterminate: row.indeterminate,
    decidedAt: row.decided_at,
    evaluatedBy: row.evaluated_by,
  }))
}

/* ------------------------------------------------------------------ overrides */

export class OverrideError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OverrideError'
  }
}

export interface OverrideRequest {
  readonly releaseTag: string
  readonly reasonCode: ReasonCode
  readonly subject?: string
  readonly reason: string
  readonly requestedBy: string
  readonly ttlMs: number
}

/** Twelve hours. Long enough to ship a fix, short enough that it cannot be forgotten. */
export const MAX_OVERRIDE_TTL_MS = 12 * 60 * 60 * 1_000

/**
 * Record a break-glass override.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN OVERRIDE MAY WAIVE A KNOWN FAILURE. IT MAY NEVER WAIVE AN UNKNOWN.**
 *
 * Refused here, at the point of creation, as well as being unreachable in `decide()`. Two layers
 * because they fail differently: `decide()` protects against an override that already exists, and
 * this protects against one being written in the belief that it will work — an operator who is
 * told "no, and here is why" at 3am learns something, whereas an operator whose override is
 * silently ignored spends the next twenty minutes wondering why the pipeline still refuses.
 *
 * The reasoning: overriding a known failure is a person saying "I have looked at this, I accept
 * it, here is my name". Overriding an unknown is a person saying "nobody has looked at this and I
 * accept it anyway", which is not a decision anyone can be accountable for — and the unknowns are
 * precisely the states in which the estate is least able to tell you what you just shipped.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function addOverride(sql: Sql, request: OverrideRequest): Promise<GateOverride> {
  if (determinacyOf(request.reasonCode) === 'unknown') {
    throw new OverrideError(
      `${request.reasonCode} is an indeterminate result and cannot be overridden — ` +
        'find out what is true, then decide',
    )
  }
  if (request.reason.trim().length < 16) {
    // The database enforces this too. Here as well so the caller gets a sentence rather than a
    // constraint name: "override" and "an unexplained override" are different things, and a
    // reason field somebody typed "fix" into is the second one.
    throw new OverrideError('an override must carry a written reason of at least 16 characters')
  }
  if (request.ttlMs <= 0 || request.ttlMs > MAX_OVERRIDE_TTL_MS) {
    // A permanent override is the gate being deleted one reason code at a time. There is no
    // "until further notice" here on purpose.
    throw new OverrideError(`an override must expire within ${MAX_OVERRIDE_TTL_MS}ms`)
  }

  const now = new Date()
  const expiresAt = new Date(now.getTime() + request.ttlMs)
  const subject = request.subject ?? '*'
  const rows = (await sql`
    insert into gate_overrides
      (release_tag, reason_code, subject, reason, requested_by, created_at, expires_at)
    values (${request.releaseTag}, ${request.reasonCode}, ${subject}, ${request.reason},
            ${request.requestedBy}, ${now}, ${expiresAt})
    on conflict (release_tag, reason_code, subject) do update set
      reason = excluded.reason, requested_by = excluded.requested_by,
      created_at = excluded.created_at, expires_at = excluded.expires_at
    returning *
  `) as unknown as Array<{
    release_tag: string
    reason_code: string
    subject: string
    reason: string
    requested_by: string
    expires_at: Date
  }>
  const row = rows[0]
  if (!row) throw new Error('override upsert returned no row')
  return {
    releaseTag: row.release_tag,
    reasonCode: row.reason_code as ReasonCode,
    subject: row.subject,
    reason: row.reason,
    requestedBy: row.requested_by,
    expiresAt: row.expires_at,
  }
}

export async function activeOverrides(
  sql: Sql,
  releaseTag: string,
  now: Date = new Date(),
): Promise<readonly GateOverride[]> {
  const rows = (await sql`
    select release_tag, reason_code, subject, reason, requested_by, expires_at
      from gate_overrides
     where release_tag = ${releaseTag} and expires_at > ${now}
  `) as unknown as Array<{
    release_tag: string
    reason_code: string
    subject: string
    reason: string
    requested_by: string
    expires_at: Date
  }>
  return rows.map((row) => ({
    releaseTag: row.release_tag,
    reasonCode: row.reason_code as ReasonCode,
    subject: row.subject,
    reason: row.reason,
    requestedBy: row.requested_by,
    expiresAt: row.expires_at,
  }))
}

/** The exit code a pipeline reads. 0 promotes; anything else does not. */
export function exitCodeFor(decision: GateDecision): 0 | 1 {
  return decision.decision === 'refuse' ? 1 : 0
}

/** Convenience for a caller that only wants the status counts. */
export function summariseStatuses(
  runs: readonly { readonly status: JourneyStatus }[],
): Record<JourneyStatus, number> {
  const out: Record<JourneyStatus, number> = { pass: 0, fail: 0, error: 0, skip: 0 }
  for (const run of runs) out[run.status] += 1
  return out
}

/** Every budget the gate would refuse on. Exposed so an operator can see the freeze before it bites. */
export function frozenBudgets(budgets: readonly ErrorBudget[]): readonly ErrorBudget[] {
  return budgets.filter((b) => b.exhausted)
}
