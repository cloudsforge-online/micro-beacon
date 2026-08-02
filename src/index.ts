/**
 * The composition root.
 *
 * Everything this service is made of is constructed here, once, in an order that is not arbitrary.
 * Each step carries the reason it must precede the next; the ordering is the substance of this
 * file.
 *
 * What this file deliberately does **not** do: run migrations. That is `src/migrator.ts`, a
 * separate one-shot process — AD-17 and rule 7. Here that matters twice over: below
 * `SCHEMA_VERSION` the partial unique index `incidents_open_uniq` may not exist, and neither may
 * the CHECK that stops an indeterminate gate evaluation from being recorded as a promotion. Both
 * are controls rather than conveniences.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE OBSERVATION PLANE IS A LEAF, AND THIS FILE IS WHERE THAT IS ENFORCED.**
 *
 * 07-dependency-map.md:76 — "No service calls `beacon`". Nothing here dials another service at
 * boot, nothing blocks on one, and every upstream probe is SOFT. A monitor that cannot start
 * because the thing it monitors is down is a monitor that is absent at the only moment anyone
 * wants it, and 07-dependency-map.md:147 already records the intended posture: "beacon failing is
 * not a service failure".
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Traces are exported by the OpenTelemetry SDK loaded ahead of this module —
 * `NODE_OPTIONS=--import @opentelemetry/auto-instrumentations-node/register` in the deploy, which
 * reads `OTEL_EXPORTER_OTLP_ENDPOINT` and friends from the environment itself. That is why no
 * `OTEL_*` variable appears in `src/env.ts`.
 */

import postgres from 'postgres'
import { assertSchemaAtLeast, type Sql } from '@cloudsforge/db'
import { JobQueue, JobRunner, type Sql as JobsSql } from '@cloudsforge/jobs'
import { Verifier } from '@cloudsforge/auth'
import { Lifecycle, installSignalHandlers, postgresProbe } from '@cloudsforge/lifecycle'
import { Logger, Metrics, registerHttpMetrics, registerJobMetrics } from '@cloudsforge/telemetry'
import { SERVICE, env } from './env.ts'
import { SCHEMA_VERSION } from './migrations.ts'
import { createServer, registerServiceMetrics, scrapeRefresh } from './server.ts'
import { registerHandlers, rescheduleRecurring, sampleQueue, seedRecurring } from './jobs.ts'
import { JOURNEYS } from './estate.ts'
import { browserJourneys, undeclared } from './browser/journeys.ts'
import { scoreboard } from './claims.ts'
import { syncRegistry } from './journeys.ts'

// 1. Environment. Importing `./env.ts` validated it; a missing or placeholder secret has already
//    exited with a structured line naming the variable.

// 2. Telemetry, before anything that can fail. A logger that exists before the pool means the
//    pool's failure is a structured, searchable, redacted line rather than a bare V8 stack the
//    collector drops.
const logger = new Logger({
  service: SERVICE,
  level: env.logLevel,
  version: env.version,
  env: env.env,
})
const metrics = registerServiceMetrics(registerJobMetrics(registerHttpMetrics(new Metrics())))

// The browser set is computed from the catalogue and the configured addresses, never written down.
// It is empty in every deployment that exists today, because no compose file serves a frontend
// container for a browser to point at — doc 22 §8.7. `undeclared` is logged rather than the count
// alone: "0 browser journeys" reads as an oversight, and "BJ-XS-10: no address for site, hub, …"
// reads as the one deploy change that would turn it on.
const browserConfig = {
  enabled: env.browserEnabled,
  executablePath: env.browserExecutable,
  timeoutMs: env.browserTimeoutMs,
}
const browserRegistry = { config: browserConfig, targets: new Set(env.targets.keys()) }
const ALL_JOURNEYS = [...JOURNEYS, ...browserJourneys(browserRegistry)]

logger.info('starting', {
  version: env.version,
  schemaVersion: SCHEMA_VERSION,
  journeys: ALL_JOURNEYS.length,
  browserJourneys: ALL_JOURNEYS.length - JOURNEYS.length,
  browserUndeclared: undeclared(browserRegistry),
  targets: [...env.targets.keys()],
  // Said at boot, because a public status page that is switched off looks exactly like one that
  // is broken until somebody reads the environment.
  publicStatus: env.publicStatus,
  gateConsecutiveGreen: env.gateConsecutiveGreen,
  // The eleven "one platform" claims, as a number beside the version tag. 17 §7's table has said
  // "three of eleven are true" since it was written and nothing recomputes it; this does, from the
  // journeys this build actually declares.
  platformClaims: scoreboard(),
})

// 3. The database pool. Opened before the schema assertion for the obvious reason that the
//    assertion is a query, and before the Lifecycle because the readiness probe closes over it.
const sql = postgres(env.databaseUrl, {
  max: env.databasePoolMax,
  // postgres.js writes notices to stderr as unstructured text by default, which is how a
  // connection string ends up in a log the collector cannot parse.
  onnotice: () => {},
})
const db = sql as unknown as Sql

// 4. Assert the schema. This does NOT migrate. Failing here rather than serving is the point.
try {
  await assertSchemaAtLeast(db, SCHEMA_VERSION)
} catch (err) {
  logger.fatal('schema assertion failed', { err, required: SCHEMA_VERSION })
  await sql.end({ timeout: 5 }).catch(() => {})
  process.exit(1)
}

// 5. Reconcile the code journey registry into the table. A data write, not DDL — which is why it
//    is here and not in the migrator. Operator state (`muted`) is preserved; see `syncRegistry`.
await syncRegistry(db, ALL_JOURNEYS)

// 6. The Lifecycle and its probes, before the routes, because `/readyz` is a route and it needs
//    something to report.
const lifecycle = new Lifecycle({
  drainDelayMs: 5_000,
  // Generous, because a drain must not cut a journey between a step that moved money and the
  // write that records it — that gap is the one place a synthetic run could leave a row behind
  // with nothing saying so.
  drainTimeoutMs: 30_000,
  onStateChange: (state) => logger.info('lifecycle state', { state }),
})

lifecycle.addProbe(
  // HARD, and the only hard probe. Beacon without its database can serve `/livez` and nothing
  // else worth having: the probe catalogue, the hysteresis state, the incident record and the
  // gate's every input are rows. Reporting ready without them would mean answering `/v1/gate`
  // with `beacon_unavailable` on every call while sitting in the balancer as healthy.
  postgresProbe('postgres', (signal) =>
    Promise.race([
      sql`select 1`,
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('probe aborted')), { once: true })
      }),
    ]),
  ),
)

// The probed estate is deliberately NOT wired into readiness at all — not even as soft probes.
// A soft failure sets the state to `degraded`, and a monitor that reports itself degraded because
// the thing it monitors is degraded is a monitor reporting somebody else's outage as its own. The
// estate's health is the CONTENT of this service, not a precondition for it.

// 7. The queue and the runner's dependencies.
const queue = new JobQueue(sql as unknown as JobsSql, {
  owner: env.instanceId,
  // Comfortably above the longest thing a handler does — a journey with its own 90-second
  // deadline plus its teardown. A lease shorter than the work is two workers on one journey,
  // which is the exact failure the lease exists to prevent.
  leaseMs: 180_000,
})

// 8. Routes. After the Lifecycle so the health handlers report real state.
const verifier = new Verifier({ jwksUrl: env.identityJwksUrl, issuer: env.identityIssuer })
const refresh = scrapeRefresh({ sql: db, metrics })
const server = createServer({
  lifecycle,
  logger,
  metrics,
  verifier,
  sql: db,
  token: env.token,
  publicStatus: env.publicStatus,
  incidentWindowDays: env.incidentRetentionDays,
  gate: { freshnessMs: env.gateFreshnessMs, consecutiveGreen: env.gateConsecutiveGreen },
  // Gauges are sampled at scrape time rather than on a timer. There is no `setInterval` in this
  // repository and CI greps for one — rule 8.
  beforeScrape: async () => {
    await refresh()
    await sampleQueue(queue, metrics)
  },
})

// 9. The job runner, started before `listen()`. Background work is claimed under a lease, so a
//    replica that is draining stops claiming before it stops serving.
const reschedule = rescheduleRecurring(queue, logger)
const runner = new JobRunner({
  queue,
  // Four at a time. Probes are IO-bound and short; a journey is long and holds one slot. Higher
  // would mean a burst of probes crowding out the journey behind them, which is the wrong way
  // round: a journey answers a question no probe can.
  concurrency: 4,
  pollMs: 1_000,
  shouldClaim: () => lifecycle.claimingJobs,
  onEvent: (event) => {
    if (event.kind) {
      if (event.type === 'claimed') metrics.increment('jobs_claimed_total', { kind: event.kind })
      if (event.type === 'completed') metrics.increment('jobs_completed_total', { kind: event.kind })
      if (event.type === 'failed') metrics.increment('jobs_failed_total', { kind: event.kind })
      if (event.type === 'dead') metrics.increment('jobs_dead_total', { kind: event.kind })
      if (event.durationMs !== undefined) {
        metrics.observe('jobs_duration_ms', event.durationMs, { kind: event.kind })
      }
    }
    if (event.type === 'failed' || event.type === 'dead' || event.type === 'error') {
      logger.error('job failure', { ...event })
    }
    reschedule(event)
  },
})

registerHandlers(runner, {
  sql: db,
  logger,
  metrics,
  queue,
  thresholds: { failThreshold: env.failThreshold, recoverThreshold: env.recoverThreshold },
  journeys: ALL_JOURNEYS,
  targets: env.targets,
  journeyDeadlineMs: env.journeyDeadlineMs,
  journeyIntervalMs: env.journeyIntervalMs,
  retention: {
    checkDays: env.checkRetentionDays,
    rollupDays: env.rollupRetentionDays,
    runDays: env.runRetentionDays,
    incidentDays: env.incidentRetentionDays,
  },
})
await seedRecurring(queue)
runner.start()

// 10. Listen. Last of the construction steps, because a socket that accepts before its
//     dependencies exist is a socket that answers 500.
await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(env.port, () => resolve())
})
logger.info('listening', { port: env.port })

// 11. Ready. Only now does `/readyz` start answering 200 and the balancer send traffic.
lifecycle.markReady()

// 12. Signal handlers, last of all. Hooks run in reverse registration order, so the server closes
//     first, then the runner stops claiming and DRAINS, then the pool closes with nothing left to
//     use it.
lifecycle.onShutdown(async () => {
  await sql.end({ timeout: 5 })
  logger.info('database pool closed')
})
lifecycle.onShutdown(async () => {
  const clean = await runner.stop(25_000)
  logger.info('job runner stopped', { clean })
})
lifecycle.onShutdown(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      // Idle keep-alive sockets hold the server open past the drain budget.
      server.closeIdleConnections()
    }),
)

installSignalHandlers(lifecycle)
