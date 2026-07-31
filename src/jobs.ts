/**
 * Background work.
 *
 * Rule 8 of docs/ecosystem/03 §2: every background timer is a leased job. There is no
 * `setInterval` in this repository doing domain work and CI greps for one.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS THE FILE THAT REPLACES THE FROZEN SERVICE'S TIMERS, AND IT IS THE POINT OF THE PORT.**
 *
 * The service this supersedes schedules everything with `setInterval` in module scope:
 * `probe.js:98` fires a whole probe cycle every thirty seconds, `schedule.js:77` arms one interval
 * per journey, `store.js:221` flushes the write buffer every two seconds. Each of those is
 * per-process state, and every one of them means **two replicas do the work twice**:
 *
 *   * Twice the load on a target that is already too slow to answer — the monitor becoming the
 *     incident, which `schedule.js:12-15` explicitly warns about and then does not prevent.
 *   * Two journeys moving one synthetic account's balance underneath each other.
 *   * Two rows per check, so every uptime percentage is computed from a doubled denominator that
 *     halves when a replica restarts.
 *
 * The frozen service's own overlap guard (`probe.js:22`, a module-scope `running` boolean) is the
 * tell: it is exactly the right idea implemented in exactly the place that cannot work across
 * processes. The lease is that idea in the one place that can.
 *
 * **THE LEASE KEY NAMES THE CONTENDED RESOURCE, NOT THE ROW.**
 *
 *   | Work           | Key            | Why                                                       |
 *   |----------------|----------------|-----------------------------------------------------------|
 *   | `probe.run`    | the probe name | **The target.** Two workers probing one endpoint is double |
 *   |                |                | load on the thing being asked whether it is healthy.       |
 *   | `journey.run`  | the journey    | **The synthetic account and the rows the journey leaves.** |
 *   |                |                | A journey is not idempotent: it registers, it deposits, it |
 *   |                |                | withdraws. Two of them is two of each.                     |
 *   | `schedule.sync`| `global`       | The enqueueing decision itself.                            |
 *   | `slo.evaluate` | `global`       | The observation counters, which are `+=`.                  |
 *   | `rollup`       | `global`       | The `check_rollups` upsert.                                |
 *   | `prune`        | `global`       | Deletions.                                                 |
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **Why a sync job rather than self-rearming handlers.** A handler cannot re-arm itself: the
 * runner deletes the row on success *after* the handler returns, so a self-enqueue collides with
 * the row that is about to be deleted and is silently dropped by `on conflict do nothing`. The
 * schedule would then stop, quietly, some minutes after boot. `schedule.sync` computes the next
 * due time from `probe_state.updated_at` instead, which also means a probe added, disabled or
 * re-timed in the table takes effect within one sync rather than at the next deploy.
 */

import { JobRunner, type Job, type JobQueue, type RunnerEvent } from '@cloudsforge/jobs'
import type { Sql } from '@cloudsforge/db'
import type { Logger, Metrics } from '@cloudsforge/telemetry'
import { closeIncident, openIncident, severityFor } from './incidents.ts'
import {
  execute,
  findProbe,
  listProbes,
  recordCheck,
  type ExecuteDeps,
  type Thresholds,
} from './probes.ts'
import {
  listRegistered,
  recentRuns,
  recordRun,
  runJourney,
  type JourneyDefinition,
} from './journeys.ts'
import { recordObservation } from './slo.ts'

export const PROBE_KIND = 'probe.run'
export const JOURNEY_KIND = 'journey.run'
export const SYNC_KIND = 'schedule.sync'
export const SLO_KIND = 'slo.evaluate'
export const ROLLUP_KIND = 'rollup'
export const PRUNE_KIND = 'prune'

export interface Recurring {
  readonly kind: string
  readonly key: string
  readonly everyMs: number
}

/**
 * The four jobs that are recurring in their own right. Probes and journeys are NOT here: they are
 * enqueued by `schedule.sync` from the table, which is what lets the catalogue change without a
 * deploy.
 */
export const RECURRING: readonly Recurring[] = Object.freeze([
  // Five seconds. It must be finer than the shortest probe interval or a 30-second probe drifts
  // to 30-plus-sync. One indexed query; it is cheaper than the drift it prevents.
  { kind: SYNC_KIND, key: 'global', everyMs: 5_000 },
  // Every five minutes, as 13-operational-model.md:165 specifies for SLO evaluation.
  { kind: SLO_KIND, key: 'global', everyMs: 300_000 },
  { kind: ROLLUP_KIND, key: 'global', everyMs: 300_000 },
  { kind: PRUNE_KIND, key: 'global', everyMs: 3_600_000 },
])

/** Enqueue the recurring set at boot. `keep` means N replicas booting together produce one row. */
export async function seedRecurring(queue: JobQueue): Promise<void> {
  for (const job of RECURRING) {
    await queue.enqueue({ kind: job.kind, key: job.key, onConflict: 'keep', payload: {} })
  }
}

/**
 * Re-arm a recurring job once it has finished.
 *
 * From the completion event, because that is the only moment the row is gone — see the file
 * header. A dead-lettered recurring job is deliberately **not** re-armed: the row stays,
 * `jobs_dead_total` increments and `jobs_overdue` climbs, which is how an operator finds out that
 * the thing which schedules everything else has stopped.
 */
export function rescheduleRecurring(
  queue: JobQueue,
  logger: Logger,
): (event: RunnerEvent) => void {
  const byKey = new Map(RECURRING.map((job) => [`${job.kind} ${job.key}`, job]))
  return (event) => {
    if (event.type !== 'completed' || !event.kind || !event.key) return
    const job = byKey.get(`${event.kind} ${event.key}`)
    if (!job) return
    void queue
      .enqueue({
        kind: job.kind,
        key: job.key,
        runAt: new Date(Date.now() + job.everyMs),
        onConflict: 'earliest',
        payload: {},
      })
      .catch((err: unknown) => logger.error('failed to re-arm recurring job', { kind: job.kind, err }))
  }
}

export interface JobDeps {
  readonly sql: Sql
  readonly logger: Logger
  readonly metrics: Metrics
  readonly queue: Pick<JobQueue, 'enqueue'>
  readonly thresholds: Thresholds
  /** The code registry. Journey definitions are code; their operator state is a row. */
  readonly journeys: readonly JourneyDefinition[]
  readonly targets: ReadonlyMap<string, string>
  readonly journeyDeadlineMs: number
  readonly journeyIntervalMs: number
  readonly execute?: ExecuteDeps
  readonly retention: {
    readonly checkDays: number
    readonly rollupDays: number
    readonly runDays: number
    readonly incidentDays: number
  }
  readonly now?: () => Date
}

/** Availability SLO name for a service. One naming rule, applied in one place. */
export function availabilitySloName(target: string): string {
  return `${target}.availability`
}

/** Journey SLO name. `99% of scheduled runs pass`, and a skip counts against it. */
export function journeySloName(journey: string): string {
  return `${journey}.runs`
}

export function registerHandlers(runner: JobRunner, deps: JobDeps): JobRunner {
  const now = deps.now ?? (() => new Date())

  /* ---------------------------------------------------------------- schedule.sync */

  runner.register(SYNC_KIND, async (_job, ctx) => {
    const at = now()

    // Probes: due when `updated_at + interval_ms` has passed, or when the state row has never
    // been written. `keep` so three syncs before the first run produce one run, not three.
    const due = (await deps.sql`
      select p.name, p.interval_ms, s.updated_at
        from probes p
        left join probe_state s on s.probe_name = p.name
       where p.enabled = true
         and (s.updated_at is null
              or s.updated_at + make_interval(secs => p.interval_ms / 1000.0) <= ${at})
    `) as unknown as Array<{ name: string; interval_ms: number; updated_at: Date | null }>

    for (const row of due) {
      if (ctx.signal.aborted) return
      await deps.queue.enqueue({
        kind: PROBE_KIND,
        key: row.name,
        payload: { probe: row.name },
        onConflict: 'keep',
      })
    }

    const registered = await listRegistered(deps.sql)
    const known = new Set(deps.journeys.map((journey) => journey.name))
    const lastRun = (await deps.sql`
      select journey, max(started_at) as last_at
        from journey_runs where trigger <> 'manual' group by journey
    `) as unknown as Array<{ journey: string; last_at: Date }>
    const lastByJourney = new Map(lastRun.map((row) => [row.journey, row.last_at]))

    for (const journey of registered) {
      if (ctx.signal.aborted) return
      // A row whose definition has been deleted from the code is not scheduled. It stays in the
      // table so its history survives, and the gate keeps refusing on it if it is critical —
      // deleting a failing journey must not be a way to make the gate green.
      if (!known.has(journey.name)) continue
      const last = lastByJourney.get(journey.name)
      if (last && at.getTime() - last.getTime() < deps.journeyIntervalMs) continue
      await deps.queue.enqueue({
        kind: JOURNEY_KIND,
        key: journey.name,
        payload: { journey: journey.name },
        onConflict: 'keep',
      })
    }

    deps.metrics.set('beacon_probes_due', due.length)
  })

  /* ---------------------------------------------------------------- probe.run */

  runner.register<{ probe?: string }>(PROBE_KIND, async (job: Job<{ probe?: string }>, ctx) => {
    const name = job.payload.probe ?? job.key
    const probe = await findProbe(deps.sql, name)
    // A probe deleted between enqueue and claim is not an error and must not burn attempts: it is
    // an operator removing a probe, which is a thing operators are allowed to do.
    if (!probe || !probe.enabled) return

    const result = await execute(probe, deps.execute)
    if (ctx.signal.aborted) return

    const at = now()
    const recorded = await recordCheck(deps.sql, probe, result, deps.thresholds, at)

    // One observation per check: the denominator of an availability SLO is checks, and every check
    // contributes exactly one. `degraded` counts as GOOD — it answered. A latency objective is a
    // separate SLO with its own budget, and folding the two together produces a number that
    // answers neither question.
    await recordObservation(
      deps.sql,
      availabilitySloName(probe.target),
      truncateToMinute(at),
      result.state === 'down' ? 0n : 1n,
      1n,
    ).catch((err: unknown) => {
      // An SLO with no row yet is a foreign-key violation, which must not fail the check that has
      // already been written. The observation is lost; the check is not, and the check is the
      // thing an operator is looking at.
      deps.logger.warn('could not record an availability observation', { probe: probe.name, err })
    })

    if (recorded.transition === 'opened') {
      const opened = await openIncident(deps.sql, {
        scope: 'probe',
        subject: probe.name,
        severity: severityFor(probe.critical),
        productGroup: probe.productGroup,
        cause: `${probe.target} failed ${deps.thresholds.failThreshold} consecutive checks`,
        lastError: result.error ?? undefined,
        detectedBy: 'probe',
        at,
      })
      deps.logger.error('incident opened', {
        probe: probe.name,
        incidentId: opened.incident.id,
        deduped: !opened.opened,
      })
      deps.metrics.increment('beacon_incidents_opened_total', { scope: 'probe' })
    } else if (recorded.transition === 'closed') {
      await closeIncident(deps.sql, 'probe', probe.name, at)
      deps.logger.info('incident closed', { probe: probe.name })
    }

    deps.metrics.increment('beacon_checks_total', { target: probe.target, state: result.state })
  })

  /* ---------------------------------------------------------------- journey.run */

  runner.register<{ journey?: string }>(JOURNEY_KIND, async (job: Job<{ journey?: string }>, ctx) => {
    const name = job.payload.journey ?? job.key
    const definition = deps.journeys.find((journey) => journey.name === name)
    if (!definition) return

    const registered = (await listRegistered(deps.sql)).find((journey) => journey.name === name)
    if (!registered) return

    const run = await runJourney(definition, {
      trigger: 'schedule',
      deadlineMs: deps.journeyDeadlineMs,
      targets: deps.targets,
    })
    if (ctx.signal.aborted) return

    await recordRun(deps.sql, run)

    // **A SKIP COUNTS AGAINST THE OBJECTIVE.** 13-operational-model.md:437 — "99% of scheduled
    // runs pass. A skip counts against it, because a skip is not a pass." `good` is 1 only for
    // `pass`; fail, error and skip are all 0.
    await recordObservation(
      deps.sql,
      journeySloName(name),
      truncateToMinute(run.startedAt),
      run.status === 'pass' ? 1n : 0n,
      1n,
    ).catch((err: unknown) => {
      deps.logger.warn('could not record a journey observation', { journey: name, err })
    })

    deps.metrics.increment('beacon_journey_runs_total', { journey: name, status: run.status })

    // A muted journey still RUNS and still records — muting suppresses the page, not the
    // measurement. "A muted journey is not a passing journey; it is an unmeasured one" is a
    // statement about the gate, which refuses while any journey is muted, and the data keeps
    // accruing so that unmuting it does not start from nothing.
    if (registered.muted) return

    if (run.status === 'pass') {
      await closeIncident(deps.sql, 'journey', name, run.startedAt)
      return
    }

    // Two consecutive non-passes, read from the table rather than from a counter in this process.
    // At a five-minute cadence that is ten minutes to detection, which is right for a scenario:
    // a journey touches six services and a single flake in any of them is not news.
    const recent = await recentRuns(deps.sql, name, 2)
    if (recent.length < 2 || recent.some((entry) => entry.status === 'pass')) return

    const opened = await openIncident(deps.sql, {
      scope: 'journey',
      subject: name,
      severity: severityFor(definition.critical),
      productGroup: definition.productGroup,
      cause: `${definition.title} — failing at step "${run.failedStep ?? 'unknown'}"`,
      lastError: run.error ?? undefined,
      detectedBy: 'journey',
      at: run.startedAt,
    })
    deps.logger.error('journey incident', {
      journey: name,
      status: run.status,
      incidentId: opened.incident.id,
      deduped: !opened.opened,
    })
    deps.metrics.increment('beacon_incidents_opened_total', { scope: 'journey' })
  })

  /* ---------------------------------------------------------------- slo.evaluate */

  runner.register(SLO_KIND, async (_job, _ctx) => {
    // Evaluation is a read: `allBudgets` is pure arithmetic over recorded observations, and the
    // observations are written by the probe and journey handlers at the moment they learn
    // something. There is deliberately no separate collection pass — a second writer is a second
    // place for the denominator to disagree with itself.
    const { allBudgets, policyFor, remainingRatio } = await import('./slo.ts')
    for (const budget of await allBudgets(deps.sql)) {
      if (budget.indeterminate) continue
      deps.metrics.set('beacon_slo_budget_remaining_ratio', remainingRatio(budget), {
        slo: budget.slo,
      })
      if (policyFor(budget) === 'freeze') {
        deps.logger.warn('error budget exhausted — this service is frozen', {
          slo: budget.slo,
          bad: String(budget.bad),
          allowedBad: String(budget.allowedBad),
        })
      }
    }
  })

  /* ---------------------------------------------------------------- rollup */

  runner.register(ROLLUP_KIND, async (_job, _ctx) => {
    // Re-runs over the last few hours on purpose: the current hour is incomplete every time it is
    // written, so the upsert has to be able to CORRECT it rather than assume it is final.
    await deps.sql`
      insert into check_rollups (probe_name, bucket, total, up, degraded, down, latency_p50, latency_p95)
      select probe_name,
             date_trunc('hour', ts)                              as bucket,
             count(*)::int                                       as total,
             count(*) filter (where state = 'up')::int           as up,
             count(*) filter (where state = 'degraded')::int     as degraded,
             count(*) filter (where state = 'down')::int         as down,
             percentile_disc(0.5) within group (order by latency_ms)
               filter (where state <> 'down')                    as latency_p50,
             percentile_disc(0.95) within group (order by latency_ms)
               filter (where state <> 'down')                    as latency_p95
        from checks
       where ts >= date_trunc('hour', now() - interval '3 hours')
       group by probe_name, bucket
      on conflict (probe_name, bucket) do update set
        total = excluded.total, up = excluded.up, degraded = excluded.degraded,
        down = excluded.down, latency_p50 = excluded.latency_p50,
        latency_p95 = excluded.latency_p95
    `
  })

  /* ---------------------------------------------------------------- prune */

  runner.register(PRUNE_KIND, async (_job, _ctx) => {
    // Raw checks go first and go soonest: they are the bulk of the data and answer no question
    // anyone asks a fortnight later. `check_rollups` outlives them by more than a year, and IT is
    // what AD-20's 400-day figure actually describes — Prometheus cannot downsample and never
    // could, which is recorded in 02-target-architecture.md:501-507.
    await deps.sql`delete from checks where ts < now() - make_interval(days => ${deps.retention.checkDays})`
    await deps.sql`delete from check_rollups where bucket < now() - make_interval(days => ${deps.retention.rollupDays})`
    await deps.sql`delete from journey_runs where started_at < now() - make_interval(days => ${deps.retention.runDays})`
    await deps.sql`
      delete from incidents
       where closed_at is not null
         and closed_at < now() - make_interval(days => ${deps.retention.incidentDays})
    `
  })

  return runner
}

/**
 * SLO observations are bucketed to the minute.
 *
 * Fine enough that a 28-day window is 40,320 rows per SLO — small — and coarse enough that a
 * hundred checks in one minute are one row rather than a hundred. Rounding, not truncation of the
 * value: the counts inside the bucket are exact, and only their timestamp is coarse.
 */
export function truncateToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000)
}

/** Refresh the queue-depth gauges. Called at scrape time, never on a timer. */
export async function sampleQueue(queue: JobQueue, metrics: Metrics): Promise<void> {
  const stats = await queue.stats()
  metrics.set('jobs_pending', stats.pending)
  metrics.set('jobs_overdue', stats.overdue)
}

/** Every probe the catalogue knows, for the readiness report and the status projection. */
export async function catalogueSize(sql: Sql): Promise<number> {
  return (await listProbes(sql, true)).length
}
