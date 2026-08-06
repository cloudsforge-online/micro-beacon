/**
 * Probes: the catalogue, the execution, and the hysteresis.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A PROBE THAT HANGS IS A PROBE THAT FAILS.**
 *
 * `execute()` races the request against a timer and the timer is the guarantee, not the
 * `AbortSignal`. Aborting *asks* a request to stop; a socket in a state the runtime does not
 * expect, or a `fetch` implementation that ignores the signal, leaves the await pending for ever.
 * A pending await inside a job handler holds its lease, so a single hung target would stall the
 * scheduler and every other probe behind it, and the monitor would go quiet at the exact moment
 * the estate was in trouble.
 *
 * So the abort is a courtesy and the race is the guarantee — the same reasoning `@cloudsforge/
 * lifecycle` gives for its own probe timeout, for the same reason. A timed-out probe is recorded
 * as `down` with `error: 'deadline exceeded'`; it is never left pending and never silently
 * dropped.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The `up` / `degraded` / `down` vocabulary is carried forward unchanged from the frozen service
 * (`infra/beacon/src/metrics.js`) because Grafana's dashboards and the recording rules in
 * `deploy/prometheus/rules/slo.yaml` are already written against `beacon_target_up` with 1, 0.5
 * and 0. Renaming a state would silently empty a panel rather than break a build.
 */

import type { Sql } from '@cloudsforge/db'

export type ProbeState = 'up' | 'degraded' | 'down'
export type ReportedState = ProbeState | 'pending'

export interface Probe {
  readonly id: string
  readonly name: string
  readonly target: string
  readonly productGroup: string
  readonly url: string
  readonly method: string
  readonly expectStatus: number
  readonly intervalMs: number
  readonly deadlineMs: number
  readonly critical: boolean
  readonly enabled: boolean
}

export interface CheckResult {
  readonly state: ProbeState
  readonly statusCode: number | null
  readonly latencyMs: number
  readonly error: string | null
}

/** Raised by nothing here. `execute` never throws — the failure IS the return value. */
export interface ExecuteDeps {
  readonly fetch?: typeof globalThis.fetch
  /** Injected so the timeout test does not have to wait five real seconds. */
  readonly now?: () => number
  /** Answering, but slower than this, is `degraded` rather than `up`. */
  readonly slowMs?: number
}

const DEFAULT_SLOW_MS = 1_500

/**
 * Run one probe to completion, or to its deadline, whichever comes first.
 *
 * **Never throws.** A probe that threw would reach the job runner as a handler failure, which
 * would retry it with backoff and dead-letter it after five attempts — so a target that was
 * merely down would end up removing its own monitoring. The failure is the return value.
 */
export async function execute(probe: Probe, deps: ExecuteDeps = {}): Promise<CheckResult> {
  const doFetch = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => Date.now())
  const slowMs = deps.slowMs ?? DEFAULT_SLOW_MS
  const started = now()

  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const deadline = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(() => {
      // The courtesy. If the request honours it we also stop holding the socket; if it does not,
      // the resolve below has already answered and nothing waits on it.
      controller.abort()
      resolve({
        state: 'down',
        statusCode: null,
        latencyMs: probe.deadlineMs,
        error: `deadline exceeded after ${probe.deadlineMs}ms`,
      })
    }, probe.deadlineMs)
    // Unreferenced so a pending deadline cannot hold the process open through a shutdown. The
    // race has already been decided by then either way.
    timer.unref?.()
  })

  const attempt = (async (): Promise<CheckResult> => {
    try {
      const response = await doFetch(probe.url, {
        method: probe.method,
        signal: controller.signal,
        // A 302 that a probe silently follows is a probe that reports the health of whatever it
        // was redirected to. Manual, so a redirect is a status code like any other.
        redirect: 'manual',
      })
      const latencyMs = Math.max(0, now() - started)
      if (response.status !== probe.expectStatus) {
        return {
          state: 'down',
          statusCode: response.status,
          latencyMs,
          error: `expected ${probe.expectStatus}, got ${response.status}`,
        }
      }
      return {
        state: latencyMs >= slowMs ? 'degraded' : 'up',
        statusCode: response.status,
        latencyMs,
        error: null,
      }
    } catch (err) {
      return {
        state: 'down',
        statusCode: null,
        latencyMs: Math.max(0, now() - started),
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })()

  try {
    return await Promise.race([attempt, deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ the catalogue */

interface ProbeRow {
  id: string
  name: string
  target: string
  product_group: string
  url: string
  method: string
  expect_status: number
  interval_ms: number
  deadline_ms: number
  critical: boolean
  enabled: boolean
}

function toProbe(row: ProbeRow): Probe {
  return {
    id: row.id,
    name: row.name,
    target: row.target,
    productGroup: row.product_group,
    url: row.url,
    method: row.method,
    expectStatus: Number(row.expect_status),
    intervalMs: Number(row.interval_ms),
    deadlineMs: Number(row.deadline_ms),
    critical: row.critical,
    enabled: row.enabled,
  }
}

export type ProbeSpec = Omit<Probe, 'id'>

export async function upsertProbe(sql: Sql, spec: ProbeSpec): Promise<Probe> {
  const rows = (await sql`
    insert into probes
      (name, target, product_group, url, method, expect_status, interval_ms, deadline_ms,
       critical, enabled)
    values
      (${spec.name}, ${spec.target}, ${spec.productGroup}, ${spec.url}, ${spec.method},
       ${spec.expectStatus}, ${spec.intervalMs}, ${spec.deadlineMs}, ${spec.critical},
       ${spec.enabled})
    on conflict (name) do update set
      target = excluded.target, product_group = excluded.product_group, url = excluded.url,
      method = excluded.method, expect_status = excluded.expect_status,
      interval_ms = excluded.interval_ms, deadline_ms = excluded.deadline_ms,
      critical = excluded.critical, enabled = excluded.enabled
    returning *
  `) as unknown as ProbeRow[]
  const row = rows[0]
  if (!row) throw new Error('probe upsert returned no row')
  // The state row is created here rather than lazily on the first check, so that a probe which has
  // never run is visibly `pending` rather than absent. "Absent" and "never succeeded" look the
  // same on a grid, and only one of them is a problem.
  await sql`
    insert into probe_state (probe_name) values (${row.name}) on conflict (probe_name) do nothing
  `
  return toProbe(row)
}

export async function listProbes(sql: Sql, enabledOnly = false): Promise<readonly Probe[]> {
  const rows = (await sql`
    select * from probes ${enabledOnly ? sql`where enabled = true` : sql``} order by name
  `) as unknown as ProbeRow[]
  return rows.map(toProbe)
}

export async function findProbe(sql: Sql, name: string): Promise<Probe | null> {
  const rows = (await sql`select * from probes where name = ${name}`) as unknown as ProbeRow[]
  const row = rows[0]
  return row ? toProbe(row) : null
}

/* ------------------------------------------------------------------ hysteresis */

export type Transition = 'opened' | 'closed' | null

export interface RecordedCheck {
  readonly probe: string
  readonly reported: ReportedState
  readonly previous: ReportedState
  readonly transition: Transition
  readonly consecutiveFail: number
  readonly consecutiveOk: number
}

export interface Thresholds {
  /** Consecutive failures before the reported state flips to `down`. */
  readonly failThreshold: number
  /** Consecutive successes before it flips back. Hysteresis in BOTH directions. */
  readonly recoverThreshold: number
}

/**
 * Record one probe result and report the transition, if any.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE COUNTERS AND THE REPORTED STATE MOVE IN ONE STATEMENT.**
 *
 * The service this supersedes keeps them in a module-scope `Map` (`infra/beacon/src/store.js`)
 * and does read-modify-write in JavaScript. That is correct for exactly one replica. For two it is
 * two half-counts that each reach `failThreshold` on their own schedule or never — and the flap it
 * produces is indistinguishable from a real one.
 *
 * Here it is a single upsert. `previous_state` is written in the same statement, which is what
 * makes the transition derivable without a second read that another replica could interleave
 * with.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The thresholds themselves are the frozen service's, and they were right: one failed probe is a
 * dropped packet, three in a row is an outage. At a 30-second cadence that is 90 seconds to
 * detection — fast enough to matter, slow enough to be true.
 */
export async function recordCheck(
  sql: Sql,
  probe: Probe,
  result: CheckResult,
  thresholds: Thresholds,
  at: Date = new Date(),
): Promise<RecordedCheck> {
  await sql`
    insert into checks (ts, probe_name, target, state, status_code, latency_ms, error)
    values (${at}, ${probe.name}, ${probe.target}, ${result.state}, ${result.statusCode},
            ${Math.round(result.latencyMs)}, ${result.error})
  `

  const isDown = result.state === 'down'
  const rows = (await sql`
    insert into probe_state
      (probe_name, reported_state, previous_state, consecutive_fail, consecutive_ok, since,
       last_ok_at, updated_at)
    values
      (${probe.name},
       ${isDown ? 'pending' : result.state},
       'pending',
       ${isDown ? 1 : 0},
       ${isDown ? 0 : 1},
       ${at},
       ${isDown ? null : at},
       ${at})
    on conflict (probe_name) do update set
      previous_state = probe_state.reported_state,
      consecutive_fail = case when ${isDown} then probe_state.consecutive_fail + 1 else 0 end,
      consecutive_ok   = case when ${isDown} then 0 else probe_state.consecutive_ok + 1 end,
      last_ok_at       = case when ${isDown} then probe_state.last_ok_at else ${at} end,
      reported_state = case
        -- Down only after failThreshold consecutive failures.
        when ${isDown} and probe_state.consecutive_fail + 1 >= ${thresholds.failThreshold}
          then 'down'
        -- Back up only after recoverThreshold consecutive successes. Without this half a flapping
        -- target produces a stream of paired open/close notifications, which is how an operator
        -- learns to filter the channel.
        when not ${isDown} and probe_state.reported_state = 'down'
             and probe_state.consecutive_ok + 1 >= ${thresholds.recoverThreshold}
          then ${result.state}
        when not ${isDown} and probe_state.reported_state <> 'down'
          then ${result.state}
        else probe_state.reported_state
      end,
      updated_at = ${at}
    returning reported_state, previous_state, consecutive_fail, consecutive_ok
  `) as unknown as Array<{
    reported_state: string
    previous_state: string
    consecutive_fail: number
    consecutive_ok: number
  }>

  const row = rows[0]
  if (!row) throw new Error('probe_state upsert returned no row')
  const reported = row.reported_state as ReportedState
  const previous = row.previous_state as ReportedState

  let transition: Transition = null
  if (reported === 'down' && previous !== 'down') transition = 'opened'
  else if (previous === 'down' && reported !== 'down') transition = 'closed'

  if (transition) {
    // Only on a transition, so `since` answers "how long has it been in THIS state" rather than
    // "when was it last checked". A separate statement rather than a repeated CASE expression in
    // the upsert: transitions are rare, and a duplicated hysteresis expression is a hysteresis
    // rule that can drift from itself.
    await sql`update probe_state set since = ${at} where probe_name = ${probe.name}`
  }

  return {
    probe: probe.name,
    reported,
    previous,
    transition,
    consecutiveFail: Number(row.consecutive_fail),
    consecutiveOk: Number(row.consecutive_ok),
  }
}

export interface ProbeStateRow {
  readonly probe: string
  readonly reported: ReportedState
  readonly since: Date
  readonly lastOkAt: Date | null
  /** Null until the first check. See the schema: that is what makes a new probe due immediately. */
  readonly updatedAt: Date | null
}

export async function listStates(sql: Sql): Promise<readonly ProbeStateRow[]> {
  const rows = (await sql`
    select probe_name, reported_state, since, last_ok_at, updated_at
      from probe_state order by probe_name
  `) as unknown as Array<{
    probe_name: string
    reported_state: string
    since: Date
    last_ok_at: Date | null
    updated_at: Date | null
  }>
  return rows.map((row) => ({
    probe: row.probe_name,
    reported: row.reported_state as ReportedState,
    since: row.since,
    lastOkAt: row.last_ok_at,
    updatedAt: row.updated_at,
  }))
}

/** The numeric form `beacon_target_up` publishes: 1 up, 0.5 degraded, 0 down. */
export function stateValue(state: ReportedState): number | null {
  if (state === 'up') return 1
  if (state === 'degraded') return 0.5
  if (state === 'down') return 0
  // `pending` publishes NOTHING rather than zero. A probe that has never run is not a probe that
  // failed, and emitting 0 would make every deploy look like an outage for the first cycle.
  return null
}
