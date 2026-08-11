/**
 * The journey harness.
 *
 * A journey is a working scenario driven against the live estate: register, sign in, hand off to
 * another product, move money, read it back. A probe tells you a service answers. A journey tells
 * you the product works, which is a different and much harder question — and the only one a user
 * asks. It is also why journeys, not metrics, are the alerting source of record for user-visible
 * failure (AD-20): a metric says "p99 is high"; a journey says "a user cannot withdraw".
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE THREE RULES ARE LOAD-BEARING AND ARE PORTED FORWARD UNCHANGED.**
 * 13-operational-model.md names them as things that must not be relaxed, and the frozen
 * harness (`infra/beacon/src/runner.js`) already gets all three right.
 *
 *   1. **A failed assertion and a thrown error are different outcomes.** An assertion failure is
 *      `fail` — the product is broken. Anything else thrown is `error` — Beacon is broken.
 *      Collapse them and a TypeError in a journey reads as an outage, which is how somebody
 *      spends an evening debugging a service that was fine.
 *
 *   2. **Not-run is not passed.** A journey without its credentials reports `skip` with the
 *      reason, and **a skip is never green.** The metric emits 0.5 for a skip and never 1, and
 *      the gate counts a skip against the journey SLO exactly as a failure would. The journeys
 *      that quietly did nothing are the easiest ones to fake.
 *
 *   3. **Cleanup runs even when the journey does not.** Registered teardown executes in reverse
 *      order on every exit path, and a failure inside it is reported separately rather than
 *      overwriting the real result.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * What is NOT ported: the frozen scheduler. `infra/beacon/src/schedule.js` is a
 * `setTimeout`-plus-`setInterval` fan-out over a module-scope queue, which means two replicas run
 * every journey twice — twice the money moved, twice the rows left behind, and a synthetic account
 * whose balance two journeys are changing underneath each other. Scheduling here is a leased job;
 * see `jobs.ts`.
 */

import { randomUUID } from 'node:crypto'
import type { Sql } from '@cloudsforge/db'

export type JourneyStatus = 'pass' | 'fail' | 'error' | 'skip'

/** Thrown by `ctx.assert`. The PRODUCT is broken. */
export class JourneyAssertion extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JourneyAssertion'
  }
}

/** Thrown by `ctx.skip`. Not applicable — never green, never red. */
export class JourneySkip extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JourneySkip'
  }
}

export interface StepResult {
  readonly name: string
  readonly status: JourneyStatus
  readonly durationMs: number
  readonly error: string | null
}

export interface JourneyContext {
  readonly runId: string
  /** The estate's addresses, by service name. Throws rather than returning undefined. */
  target(name: string): string
  /** Assert, and mark the failure as the product's rather than Beacon's. */
  assert(condition: unknown, message: string): void
  /** Abandon as not-applicable. Never green, never red. */
  skip(reason: string): never
  /** Register teardown. Runs in reverse order, on every exit path. */
  cleanup(fn: () => Promise<void> | void, label?: string): void
  /**
   * One timed, recorded step.
   *
   * Step names must be stable: they are the unit the step-latency series aggregate over, so
   * renaming one starts a new series and abandons its history.
   */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>
  readonly signal: AbortSignal
}

export interface JourneyDefinition {
  /** Stable id, used in URLs, in metric labels and as the `journeys` primary key. */
  readonly name: string
  readonly title: string
  /** The public product group. Never a service name — see `publicstatus.ts`. */
  readonly productGroup: string
  /**
   * The service that owns this journey's error budget. **Internal, and never published.**
   *
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * Added 2026-08-04, when the owner set the journey objectives and the seeder needed a `service`
   * for each `slos` row. It is declared here rather than derived for two reasons, and the second
   * is the one that matters.
   *
   *   1. **The fact did not exist anywhere.** The `journeys` TABLE records `product_group` and
   *      nothing else that identifies a service, and `ProductGroup` is deliberately a public
   *      customer-facing name — `groups.ts` says "never a service name" and `publicstatus.ts`
   *      exists because a predecessor leaked `pay.rates` onto a pre-auth page. So the group
   *      cannot stand in for this, in either direction.
   *   2. **The name prefix is not the service.** Slicing `name` at the dot yields `ecosystem`,
   *      `estate` and `identity` — and only the third is a service this estate runs. An error
   *      budget attributed to a service called `ecosystem` is a budget nobody owns, which is the
   *      same defect as no budget at all, arrived at with more ceremony.
   *
   * For a journey that spans services this is the service the failure would be attributed to —
   * the one that must produce the joined-up answer — not every service it touches. Each is
   * justified where it is set.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly service: string
  /**
   * One of the critical-path set: register, sign in, SSO handoff, deposit, convert, spend,
   * withdraw, mint deploy, market purchase (13-operational-model.md). A critical journey that
   * is not green refuses a release on its own.
   */
  readonly critical: boolean
  /** Its own deadline, when the global one is wrong for it. */
  readonly deadlineMs?: number
  /**
   * Its own MINIMUM cadence, when running at the estate's default would cost more than it proves.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────────
   * Added 2026-08-11 for `identity.register`, which is the only journey in the estate that leaves a
   * permanent row behind on every run — 15,210 of them in identity's `users` on mainnet, 2,231 a
   * day, against an estate with no real users (micro-org#390). A cadence is the honest lever for
   * that: the journey keeps registering against the real route, and it does so twice an hour
   * instead of twelve times.
   *
   * A FLOOR, not an override. `schedule.sync` takes whichever of this and
   * `BEACON_JOURNEY_INTERVAL_MS` is LONGER, so a deployment that slows everything down slows this
   * too, and one that speeds everything up cannot speed this up — which is the direction that
   * matters, because the cost being bounded here is the deployment's, not beacon's.
   *
   * Absent means "the estate's default", which is what every other journey wants: a cadence
   * declared per journey by default would be twelve numbers nobody revisits.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   */
  readonly intervalMs?: number
  run(ctx: JourneyContext): Promise<void>
}

export interface JourneyRun {
  readonly runId: string
  readonly journey: string
  readonly startedAt: Date
  readonly durationMs: number
  readonly status: JourneyStatus
  readonly failedStep: string | null
  readonly error: string | null
  readonly trigger: 'schedule' | 'manual' | 'gate'
  readonly releaseTag: string | null
  readonly steps: readonly StepResult[]
}

export interface RunOptions {
  readonly trigger?: 'schedule' | 'manual' | 'gate'
  readonly releaseTag?: string | undefined
  readonly deadlineMs?: number
  readonly targets?: ReadonlyMap<string, string>
  readonly now?: () => number
}

/**
 * Run one journey to completion, or to its deadline.
 *
 * **Never throws.** The failure IS the return value, for the same reason `execute()` in
 * `probes.ts` never throws: a journey that threw would reach the job runner as a handler failure,
 * be retried with backoff, and be dead-lettered after five attempts — so a product that was merely
 * broken would end up deleting its own monitoring.
 */
export async function runJourney(
  definition: JourneyDefinition,
  options: RunOptions = {},
): Promise<JourneyRun> {
  const now = options.now ?? (() => Date.now())
  const runId = randomUUID()
  const startedAt = new Date(now())
  const started = now()
  const steps: StepResult[] = []
  const teardown: Array<{ fn: () => Promise<void> | void; label: string }> = []
  const targets = options.targets ?? new Map<string, string>()
  const deadlineMs = definition.deadlineMs ?? options.deadlineMs ?? 90_000

  const controller = new AbortController()
  let currentStep: string | null = null

  const ctx: JourneyContext = {
    runId,
    signal: controller.signal,
    target(name) {
      const url = targets.get(name)
      // A missing address is a SKIP, not a failure: a journey pointed at a service this deployment
      // does not run has not demonstrated a defect. It has demonstrated nothing, which is what
      // skip means — and rule 2 keeps that from reading green.
      if (!url) throw new JourneySkip(`no address configured for "${name}"`)
      return url
    },
    assert(condition, message) {
      if (!condition) throw new JourneyAssertion(message)
    },
    skip(reason) {
      throw new JourneySkip(reason)
    },
    cleanup(fn, label = 'cleanup') {
      teardown.push({ fn, label })
    },
    async step(name, fn) {
      const stepStarted = now()
      currentStep = name
      try {
        const value = await fn()
        steps.push({ name, status: 'pass', durationMs: now() - stepStarted, error: null })
        return value
      } catch (err) {
        steps.push({
          name,
          status:
            err instanceof JourneySkip ? 'skip' : err instanceof JourneyAssertion ? 'fail' : 'error',
          durationMs: now() - stepStarted,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
    },
  }

  let status: JourneyStatus = 'pass'
  let error: string | null = null
  let failedStep: string | null = null

  try {
    await withDeadline(definition.run(ctx), deadlineMs, controller)
  } catch (err) {
    if (err instanceof JourneySkip) {
      status = 'skip'
      error = err.message
    } else if (err instanceof JourneyAssertion) {
      status = 'fail'
      error = err.message
      failedStep = currentStep
    } else {
      status = 'error'
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      failedStep = currentStep
    }
  } finally {
    // Reverse order, each isolated: a cleanup that throws must not prevent the next one running,
    // and must never overwrite the verdict. A journey that failed and then failed to tidy up is
    // still a journey that failed, and the verdict is the part somebody acts on.
    for (const { fn, label } of teardown.reverse()) {
      const cleanupStarted = now()
      try {
        await withDeadline(Promise.resolve(fn()), 15_000, new AbortController())
      } catch (err) {
        steps.push({
          name: `${label} (teardown)`,
          status: 'error',
          durationMs: now() - cleanupStarted,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  return {
    runId,
    journey: definition.name,
    startedAt,
    durationMs: now() - started,
    status,
    failedStep,
    error,
    trigger: options.trigger ?? 'schedule',
    releaseTag: options.releaseTag ?? null,
    steps,
  }
}

/**
 * Race a promise against a deadline.
 *
 * The abort is the courtesy and the race is the guarantee — identical to `probes.ts` and for the
 * identical reason. A journey step awaiting a socket that will never answer would otherwise hold
 * its job lease until the lease expired, and the next replica would pick the same journey up and
 * hang on the same socket.
 */
function withDeadline<T>(promise: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      // An assertion, deliberately: a journey that ran out of time is a product that took too
      // long, which is a `fail`. Classing it as `error` would say Beacon is broken and would send
      // the investigation to the wrong team.
      reject(new JourneyAssertion(`journey exceeded ${ms}ms`))
    }, ms)
    timer.unref?.()
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/* ------------------------------------------------------------------ the registry */

export interface RegisteredJourney {
  readonly name: string
  readonly title: string
  readonly productGroup: string
  readonly critical: boolean
  readonly muted: boolean
  readonly mutedReason: string | null
  readonly mutedBy: string | null
}

interface JourneyRow {
  name: string
  title: string
  product_group: string
  critical: boolean
  muted: boolean
  muted_reason: string | null
  muted_by: string | null
}

function toRegistered(row: JourneyRow): RegisteredJourney {
  return {
    name: row.name,
    title: row.title,
    productGroup: row.product_group,
    critical: row.critical,
    muted: row.muted,
    mutedReason: row.muted_reason,
    mutedBy: row.muted_by,
  }
}

/**
 * Reconcile the code registry into the table, preserving operator state.
 *
 * `muted` is deliberately NOT overwritten. It is an operator's decision with an owner and a
 * reason attached, and a deploy that silently unmuted every journey would hand an on-call engineer
 * a wall of red at the worst possible moment — while a deploy that silently RE-muted one would
 * hide a regression somebody had already decided to look at.
 */
export async function syncRegistry(
  sql: Sql,
  definitions: readonly JourneyDefinition[],
): Promise<void> {
  for (const definition of definitions) {
    await sql`
      insert into journeys (name, title, product_group, critical)
      values (${definition.name}, ${definition.title}, ${definition.productGroup},
              ${definition.critical})
      on conflict (name) do update set
        title = excluded.title,
        product_group = excluded.product_group,
        critical = excluded.critical
    `
  }
}

export async function listRegistered(sql: Sql): Promise<readonly RegisteredJourney[]> {
  const rows = (await sql`select * from journeys order by name`) as unknown as JourneyRow[]
  return rows.map(toRegistered)
}

/**
 * Mute a journey. Requires a reason and an owner, and the database enforces both.
 *
 * 17-definition-of-done.md — "A muted journey is not a passing journey; it is an unmeasured
 * one." The gate counts muted journeys and refuses while any exist, so this is a way of saying
 * "we are not shipping until somebody looks at this", never a way of making the board green.
 */
export async function setMuted(
  sql: Sql,
  name: string,
  muted: boolean,
  reason: string | null,
  by: string | null,
): Promise<RegisteredJourney | null> {
  const rows = (await sql`
    update journeys
       set muted = ${muted},
           muted_reason = ${muted ? reason : null},
           muted_by = ${muted ? by : null},
           muted_at = ${muted ? new Date() : null}
     where name = ${name}
    returning *
  `) as unknown as JourneyRow[]
  const row = rows[0]
  return row ? toRegistered(row) : null
}

/* ------------------------------------------------------------------ runs */

export async function recordRun(sql: Sql, run: JourneyRun): Promise<void> {
  await sql`
    insert into journey_runs
      (run_id, journey, started_at, duration_ms, status, failed_step, error, trigger, release_tag)
    values
      (${run.runId}, ${run.journey}, ${run.startedAt}, ${Math.round(run.durationMs)},
       ${run.status}, ${run.failedStep}, ${run.error}, ${run.trigger}, ${run.releaseTag})
  `
  for (const [seq, step] of run.steps.entries()) {
    await sql`
      insert into journey_steps (run_id, seq, name, status, duration_ms, error)
      values (${run.runId}, ${seq}, ${step.name}, ${step.status},
              ${Math.round(step.durationMs)}, ${step.error})
    `
  }
}

export interface LatestRun {
  readonly journey: string
  readonly status: JourneyStatus
  readonly startedAt: Date
  readonly runId: string
}

/**
 * The most recent SCHEDULED run of every journey.
 *
 * Manual runs are excluded on purpose. A manual run is somebody debugging: during an incident the
 * first thing an operator does is press Run, and if that counted, the act of investigating an
 * outage could turn the gate green.
 */
export async function latestRuns(sql: Sql): Promise<readonly LatestRun[]> {
  const rows = (await sql`
    select distinct on (journey) journey, status, started_at, run_id
      from journey_runs
     where trigger <> 'manual'
     order by journey, started_at desc
  `) as unknown as Array<{ journey: string; status: string; started_at: Date; run_id: string }>
  return rows.map((row) => ({
    journey: row.journey,
    status: row.status as JourneyStatus,
    startedAt: row.started_at,
    runId: row.run_id,
  }))
}

/**
 * The last `count` non-manual runs of one journey, newest first.
 *
 * The gate reads this to answer "three consecutive green runs". Fewer than `count` rows come back
 * when the journey has not run that many times, which the gate treats as indeterminate rather than
 * as a pass — a journey deployed an hour ago has not demonstrated three green runs, whatever the
 * one run it managed says.
 */
export async function recentRuns(
  sql: Sql,
  journey: string,
  count: number,
): Promise<readonly LatestRun[]> {
  const rows = (await sql`
    select journey, status, started_at, run_id
      from journey_runs
     where journey = ${journey} and trigger <> 'manual'
     order by started_at desc
     limit ${count}
  `) as unknown as Array<{ journey: string; status: string; started_at: Date; run_id: string }>
  return rows.map((row) => ({
    journey: row.journey,
    status: row.status as JourneyStatus,
    startedAt: row.started_at,
    runId: row.run_id,
  }))
}

/** The value `beacon_journey_status` publishes: 1 pass, 0.5 skip, 0 fail or error. */
export function journeyStatusValue(status: JourneyStatus): number {
  if (status === 'pass') return 1
  // 0.5 EXACTLY so that `beacon_journey_status == bool 1` in
  // deploy/prometheus/rules/slo.yaml distinguishes a skip from a pass. Emitting 1 for a skip
  // would make an unrun journey indistinguishable from a passing one on every dashboard in the
  // estate, which is rule 2 defeated by a rendering decision.
  if (status === 'skip') return 0.5
  return 0
}
