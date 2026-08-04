/**
 * The HTTP surface.
 *
 * Rule 4 of docs/ecosystem/03 §2: `/livez`, `/readyz` and `/metrics` on every service, or it does
 * not pass CI.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **`GET /v1/gate` IS THE RELEASE GATE, AND IT IS A DECISION RATHER THAN A REPORT.**
 *
 * It answers `promote`, `promote_with_override` or `refuse` with machine-readable reason codes,
 * and `cli.ts` turns the same call into an exit code. Nothing here renders a dashboard for a human
 * to interpret: ENA-37's acceptance criterion is that a manifest "cannot be promoted without a
 * green full journey run on staging, **enforced in the workflow, not by convention**", and a
 * convention is exactly what a page somebody reads amounts to.
 *
 * The route is a GET and it does **not** record by default. Asking the gate a question must not
 * change what the gate would answer next time, or a pipeline that retries becomes a pipeline that
 * writes history. `POST /v1/gate` is the recording form, used at the moment of an actual promotion.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * **AUTHENTICATION HAS TWO DOORS, DELIBERATELY.**
 *
 *   * An identity JWT, for people and for services that hold one.
 *   * A static `x-beacon-token`, for Prometheus, for Alertmanager and for CI.
 *
 * The second exists because of what this service is: when identity is the thing that has broken,
 * every route that requires an identity token is a route nobody can reach — and the routes nobody
 * can reach are the ones that would say identity has broken. `deploy/prometheus/prometheus.yml:90`
 * already presents this header; the estate's own correction to AD-20 is that the scrape needs it.
 *
 * **THE SECOND DOOR DOES NOT OPEN THE ADMIN ROUTES.** The static token satisfies READ, GATE and
 * WRITE and never `role:admin`, so the four `adminOnly` routes — gate overrides, probe upsert,
 * journey mute and SLO writes — need an identity that names a person. `authorise` carries the
 * full reasoning; the short version is that a shared secret able to mute a journey is a shared
 * secret able to turn the release gate green.
 */

import { timingSafeEqual } from 'node:crypto'
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http'
import { ForbiddenError, TokenError, bearerFrom, isAdmin, statusFor, type Principal } from '@cloudsforge/auth'
import type { Sql } from '@cloudsforge/db'
import type { Lifecycle } from '@cloudsforge/lifecycle'
import { Metrics, newRequestId, type Logger } from '@cloudsforge/telemetry'
import {
  addOverride,
  decisionHistory,
  evaluate,
  OverrideError,
  type ReasonCode,
} from './gate.ts'
import {
  addUpdate,
  closeIncident,
  findIncident,
  listOpen,
  listRecent,
  listUpdates,
  openIncident,
  type Severity,
} from './incidents.ts'
import { latestConformance, recordConformanceRun, statusFor as conformanceStatusFor } from './conformance.ts'
import { latestRuns, listRegistered, setMuted, journeyStatusValue } from './journeys.ts'
import { listProbes, listStates, stateValue, upsertProbe } from './probes.ts'
import { activeMaintenance, dailyUptime, projectStatus } from './publicstatus.ts'
import { allBudgets, listSlos, remainingRatio, upsertSlo, type SloKind } from './slo.ts'

export interface PrincipalVerifier {
  principal(token: string): Promise<Principal>
}

export const READ_SCOPE = 'beacon:read'
export const GATE_SCOPE = 'beacon:gate'
export const WRITE_SCOPE = 'beacon:write'

export interface ServerDeps {
  readonly lifecycle: Lifecycle
  readonly logger: Logger
  readonly metrics: Metrics
  readonly verifier: PrincipalVerifier
  readonly sql: Sql
  /** The static break-glass credential. See the file header. */
  readonly token: string
  readonly publicStatus: boolean
  readonly incidentWindowDays: number
  /**
   * The deploy's gate settings, passed in rather than read from `env.ts`.
   *
   * Keeping `env.ts` out of this module's import graph is what lets a test construct a server
   * without a database connection string in the environment — `env.ts` exits the process on a bad
   * configuration, which is right for a service and fatal for a test runner.
   */
  readonly gate: { readonly freshnessMs: number; readonly consecutiveGreen: number }
  readonly beforeScrape?: () => Promise<void>
}

/** Domain metrics, declared rather than inferred from a log line — AD-20. */
export function registerServiceMetrics(metrics: Metrics): Metrics {
  return (
    metrics
      // The series names below are NOT free to change: `deploy/prometheus/rules/slo.yaml:138,147`
      // and `deploy/grafana/dashboards/*.json` are already written against them. Renaming one
      // empties a panel and evaluates a rule to nothing — silently, which is the failure this
      // whole plane exists to prevent.
      .register({
        name: 'beacon_up',
        help: 'Always 1. The series that proves the scrape reached Beacon at all.',
        kind: 'gauge',
        labels: [],
      })
      .register({
        name: 'beacon_target_up',
        help: 'Target health. 1 up, 0 down, 0.5 degraded — answered, but slowly. A probe that has never run publishes nothing rather than 0.',
        kind: 'gauge',
        labels: ['probe', 'target', 'group'],
      })
      .register({
        name: 'beacon_journey_status',
        help: 'Journey result. 1 pass, 0.5 skip, 0 fail or error. A skip is never 1: not-run is not passed.',
        kind: 'gauge',
        labels: ['journey', 'group'],
      })
      .register({
        name: 'beacon_journey_last_run_timestamp_seconds',
        help: 'When each journey last ran. A journey that stopped running reports its last status for ever; this is the only series that catches that.',
        kind: 'gauge',
        labels: ['journey'],
      })
      .register({
        name: 'beacon_journeys_muted',
        help: 'Muted journeys. Must be zero at a release gate: a muted journey is not a passing journey, it is an unmeasured one.',
        kind: 'gauge',
        labels: [],
      })
      .register({
        name: 'beacon_slo_budget_remaining_ratio',
        help: 'Error budget remaining, 0..1. Rendered as a float because Prometheus has no other number; the ledger behind it is integer.',
        kind: 'gauge',
        labels: ['slo'],
      })
      .register({
        name: 'beacon_slo_budget_remaining_events',
        help: 'Error budget remaining as a whole number of events you may still fail. Negative means overspent, and by how much.',
        kind: 'gauge',
        labels: ['slo'],
      })
      .register({
        name: 'beacon_conformance_vectors',
        help: 'Conformance comparisons by result. A suite that could not be run reports under skipped, never under passed.',
        kind: 'gauge',
        labels: ['suite', 'result'],
      })
      .register({
        name: 'beacon_incidents_open',
        help: 'Open incidents by severity.',
        kind: 'gauge',
        labels: ['severity'],
      })
      .register({
        name: 'beacon_probes_due',
        help: 'Probes the scheduler found due on its last sweep. A number that only climbs is a runner that has stopped.',
        kind: 'gauge',
        labels: [],
      })
      .register({
        name: 'beacon_checks_total',
        help: 'Probe results recorded, by target and state.',
        kind: 'counter',
        labels: ['target', 'state'],
      })
      .register({
        name: 'beacon_journey_runs_total',
        help: 'Journey executions, by status.',
        kind: 'counter',
        labels: ['journey', 'status'],
      })
      .register({
        name: 'beacon_incidents_opened_total',
        help: 'Incidents opened. Deduped opens do not increment this — one outage is one increment.',
        kind: 'counter',
        labels: ['scope'],
      })
      .register({
        name: 'beacon_gate_decisions_total',
        help: 'Gate evaluations by verdict. A climbing refuse count with no promote is a pipeline that has been blocked all week.',
        kind: 'counter',
        labels: ['decision'],
      })
  )
}

const SAFE_REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
const MAX_BODY_BYTES = 256 * 1024
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

interface Reply {
  readonly status: number
  readonly body?: unknown
  readonly text?: string
  readonly contentType?: string
}

interface RequestContext {
  readonly req: IncomingMessage
  readonly url: URL
  readonly requestId: string
  readonly log: Logger
  readonly params: Readonly<Record<string, string>>
}

interface Route {
  readonly method: string
  /** Used verbatim as the metric label, so cardinality is bounded by the number of routes. */
  readonly path: string
  readonly pattern: RegExp
  readonly handle: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>
}

function compile(path: string): RegExp {
  const source = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':')
        ? `(?<${segment.slice(1)}>[^/]+)`
        : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/')
  return new RegExp(`^${source}$`)
}

class BadRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

class NotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NotFoundError'
  }
}

export function createServer(deps: ServerDeps): Server {
  const routes = buildRoutes()
  let inFlight = 0

  return createHttpServer((req, res) => {
    const startedAt = process.hrtime.bigint()
    const presented = headerOf(req, 'x-request-id')
    const requestId = presented && SAFE_REQUEST_ID.test(presented) ? presented : newRequestId()
    res.setHeader('x-request-id', requestId)

    const url = new URL(req.url ?? '/', `http://${headerOf(req, 'host') ?? 'localhost'}`)
    const method = req.method ?? 'GET'

    let matched: Route | undefined
    let params: Record<string, string> = {}
    for (const route of routes) {
      if (route.method !== method) continue
      const match = route.pattern.exec(url.pathname)
      if (match) {
        matched = route
        params = { ...match.groups }
        break
      }
    }

    const routeLabel = matched ? matched.path : 'unmatched'
    const log = deps.logger.child({ requestId, method, route: routeLabel })

    inFlight += 1
    deps.metrics.set('http_requests_in_flight', inFlight)

    const finish = (status: number) => {
      inFlight -= 1
      deps.metrics.set('http_requests_in_flight', inFlight)
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6
      deps.metrics.increment('http_requests_total', { method, route: routeLabel, status: String(status) })
      deps.metrics.observe('http_request_duration_ms', durationMs, { method, route: routeLabel })
    }

    void handle(matched, { req, url, requestId, log, params }, deps)
      .then((reply) => {
        send(res, reply, requestId)
        finish(reply.status)
      })
      .catch((err: unknown) => {
        log.error('request handler threw after mapping', { err })
        send(res, errorReply(500, 'internal', 'the request could not be completed', requestId), requestId)
        finish(500)
      })
  })
}

async function handle(route: Route | undefined, ctx: RequestContext, deps: ServerDeps): Promise<Reply> {
  if (!route) {
    return errorReply(404, 'not_found', `no route for ${ctx.req.method} ${ctx.url.pathname}`, ctx.requestId)
  }
  try {
    return await route.handle(ctx, deps)
  } catch (err) {
    const authStatus = statusFor(err)
    if (authStatus === 401) {
      // The reason is logged, never returned — "signature verification failed" versus "expired"
      // tells an attacker which half of a forged token to fix.
      ctx.log.info('unauthenticated request', { err })
      return errorReply(401, 'unauthenticated', 'a valid credential is required', ctx.requestId)
    }
    if (authStatus === 403) {
      const required = err instanceof ForbiddenError ? err.required : 'unknown'
      return errorReply(403, 'forbidden', `missing required authority: ${required}`, ctx.requestId)
    }
    if (authStatus === 503) {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // A VERIFIER OUTAGE MUST NOT MAKE BEACON UNREACHABLE.
      //
      // Identity being down is the single most likely reason somebody is reading a status page,
      // and if every route here needed an identity token then the page would be down too. That is
      // what the static token is for, and it is checked BEFORE the JWT in `authorise`.
      //
      // Reachable from exactly two callers, and neither is a read. A caller who presented no
      // static token at all; and a caller who presented one on an `adminOnly` route TOGETHER with
      // a bearer, since the static token does not satisfy `role:admin` and the bearer must then
      // be verified. Break-glass with no bearer never gets here — it is a 403 above. So identity
      // being down still costs nobody a read, and costs an admin only the four routes that
      // change the estate, which is the correct thing to lose.
      // ══════════════════════════════════════════════════════════════════════════════════════
      ctx.log.error('token verifier unavailable', { err })
      return errorReply(503, 'verifier_unavailable', 'authentication is temporarily unavailable', ctx.requestId)
    }
    if (err instanceof OverrideError) {
      // 422 rather than 400: the request was well formed and the gate refused it on policy. A
      // caller needs to be able to tell "you typed it wrong" from "you may not do that".
      return errorReply(422, 'override_refused', err.message, ctx.requestId)
    }
    if (err instanceof NotFoundError) return errorReply(404, 'not_found', err.message, ctx.requestId)
    if (err instanceof BadRequestError || err instanceof RangeError) {
      return errorReply(400, 'bad_request', err.message, ctx.requestId)
    }
    ctx.log.error('unhandled request failure', { err })
    return errorReply(500, 'internal', 'the request could not be completed', ctx.requestId)
  }
}

function buildRoutes(): Route[] {
  const define = (
    method: string,
    path: string,
    handler: (ctx: RequestContext, deps: ServerDeps) => Promise<Reply>,
  ): Route => ({ method, path, pattern: compile(path), handle: handler })

  return [
    define('GET', '/livez', async (_ctx, deps) => ({ status: 200, body: deps.lifecycle.livez() })),

    define('GET', '/readyz', async (_ctx, deps) => {
      const report = await deps.lifecycle.readyz()
      return { status: report.ready ? 200 : 503, body: report }
    }),

    define('GET', '/metrics', async (ctx, deps) => {
      // Gated, and that is the correction AD-20 needed: an open /metrics publishes the shape of
      // the estate — which services exist, which are down, which journey is failing — to anyone
      // who can reach the port.
      await authorise(ctx, deps, READ_SCOPE)
      try {
        await deps.beforeScrape?.()
      } catch (err) {
        // Serve the previous values rather than 500. A scrape that fails loses every series,
        // including the ones that would have said what was wrong.
        ctx.log.warn('gauge refresh failed; serving the previous values', { err })
      }
      return {
        status: 200,
        text: deps.metrics.render(),
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
      }
    }),

    /* ------------------------------------------------------------------ the gate */

    /**
     * Evaluate the gate. Read-only by default: asking must not change the answer.
     */
    define('GET', '/v1/gate', async (ctx, deps) => {
      await authorise(ctx, deps, GATE_SCOPE)
      const releaseTag = requireRelease(ctx)
      const decision = await evaluate(deps.sql, releaseTag, {
        record: false,
        freshnessMs: deps.gate.freshnessMs,
        consecutiveGreen: deps.gate.consecutiveGreen,
      })
      deps.metrics.increment('beacon_gate_decisions_total', { decision: decision.decision })
      return {
        // 200 for `refuse` as well. The REFUSAL is the answer, and answering with a 4xx would
        // make a refused release indistinguishable from a malformed request to every retry
        // wrapper ever written. The verdict is in the body, and `cli.ts` is what turns it into an
        // exit code.
        status: 200,
        body: gateBody(decision),
      }
    }),

    /** Record a decision. Used at the moment of an actual promotion, not to ask a question. */
    define('POST', '/v1/gate', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, GATE_SCOPE)
      const releaseTag = requireRelease(ctx)
      const decision = await evaluate(deps.sql, releaseTag, {
        record: true,
        evaluatedBy: actorOf(principal),
        freshnessMs: deps.gate.freshnessMs,
        consecutiveGreen: deps.gate.consecutiveGreen,
      })
      deps.metrics.increment('beacon_gate_decisions_total', { decision: decision.decision })
      ctx.log.info('gate evaluated', {
        release: releaseTag,
        decision: decision.decision,
        indeterminate: decision.indeterminate,
        reasons: decision.reasons.map((reason) => reason.code),
      })
      return { status: 200, body: gateBody(decision) }
    }),

    define('GET', '/v1/gate/history', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const releaseTag = requireRelease(ctx)
      const history = await decisionHistory(deps.sql, releaseTag)
      return { status: 200, body: { release: releaseTag, decisions: history } }
    }),

    /**
     * Break-glass. Admin only, and `addOverride` refuses an indeterminate reason code outright.
     */
    define('POST', '/v1/gate/overrides', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, WRITE_SCOPE, { adminOnly: true })
      const body = await readJson(ctx.req)
      const override = await addOverride(deps.sql, {
        releaseTag: requireString(body, 'release'),
        reasonCode: requireString(body, 'reasonCode') as ReasonCode,
        subject: typeof body['subject'] === 'string' ? body['subject'] : '*',
        reason: requireString(body, 'reason'),
        // Never taken from the body. An override's author is who authenticated, not who claims to
        // be the author — otherwise the accountability the whole mechanism rests on is a text
        // field.
        requestedBy: actorOf(principal),
        ttlMs: requireInteger(body, 'ttlMs'),
      })
      ctx.log.warn('a gate override was recorded', {
        release: override.releaseTag,
        reasonCode: override.reasonCode,
        subject: override.subject,
        requestedBy: override.requestedBy,
        expiresAt: override.expiresAt.toISOString(),
      })
      return { status: 201, body: override }
    }),

    /* ------------------------------------------------------------------ public status */

    /**
     * The redacted public projection. `status-web` renders this.
     *
     * Pre-auth when `BEACON_PUBLIC_STATUS` is true, because a status page behind a login is not a
     * status page. `publicstatus.ts` is what makes that safe: no target name, no error string, no
     * latency and no journey step name is written into the document at all.
     */
    define('GET', '/api/status/public', async (ctx, deps) => {
      if (!deps.publicStatus) await authorise(ctx, deps, READ_SCOPE)
      const generatedAt = new Date()
      const probes = await listProbes(deps.sql, true)
      const states = new Map((await listStates(deps.sql)).map((state) => [state.probe, state]))
      const incidents = await listRecent(deps.sql, deps.incidentWindowDays)
      const withUpdates = await Promise.all(
        incidents.map(async (incident) => ({
          incident,
          updates: await listUpdates(deps.sql, incident.id, true),
        })),
      )
      const document = projectStatus({
        generatedAt,
        probes: probes.map((probe) => ({
          productGroup: probe.productGroup,
          state: states.get(probe.name)?.reported ?? 'pending',
        })),
        uptime: await dailyUptime(deps.sql),
        incidents: withUpdates,
        maintenance: await activeMaintenance(deps.sql, generatedAt),
      })
      return { status: 200, body: document }
    }),

    /* ------------------------------------------------------------------ probes */

    define('GET', '/v1/probes', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const probes = await listProbes(deps.sql)
      const states = new Map((await listStates(deps.sql)).map((state) => [state.probe, state]))
      return {
        status: 200,
        body: {
          probes: probes.map((probe) => ({
            ...probe,
            state: states.get(probe.name)?.reported ?? 'pending',
            since: states.get(probe.name)?.since ?? null,
          })),
        },
      }
    }),

    define('PUT', '/v1/probes/:name', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE, { adminOnly: true })
      const body = await readJson(ctx.req)
      const probe = await upsertProbe(deps.sql, {
        name: ctx.params['name'] ?? '',
        target: requireString(body, 'target'),
        productGroup: requireString(body, 'productGroup'),
        url: requireString(body, 'url'),
        method: typeof body['method'] === 'string' ? body['method'] : 'GET',
        expectStatus: typeof body['expectStatus'] === 'number' ? body['expectStatus'] : 200,
        intervalMs: requireInteger(body, 'intervalMs'),
        deadlineMs: requireInteger(body, 'deadlineMs'),
        critical: body['critical'] !== false,
        enabled: body['enabled'] !== false,
      })
      return { status: 200, body: probe }
    }),

    /* ------------------------------------------------------------------ journeys */

    define('GET', '/v1/journeys', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const registered = await listRegistered(deps.sql)
      const latest = new Map((await latestRuns(deps.sql)).map((run) => [run.journey, run]))
      return {
        status: 200,
        body: {
          journeys: registered.map((journey) => ({
            ...journey,
            lastStatus: latest.get(journey.name)?.status ?? null,
            lastRunAt: latest.get(journey.name)?.startedAt ?? null,
          })),
        },
      }
    }),

    define('POST', '/v1/journeys/:name/mute', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, WRITE_SCOPE, { adminOnly: true })
      const body = await readJson(ctx.req)
      const muted = body['muted'] !== false
      if (muted && (typeof body['reason'] !== 'string' || body['reason'].trim().length < 8)) {
        // A mute without a reason is an unmeasured journey nobody owns. The database refuses it
        // too; this is the layer that gives a sentence instead of a constraint name.
        throw new BadRequestError('a mute must carry a reason')
      }
      const journey = await setMuted(
        deps.sql,
        ctx.params['name'] ?? '',
        muted,
        muted ? String(body['reason']) : null,
        muted ? actorOf(principal) : null,
      )
      if (!journey) throw new NotFoundError('no such journey')
      ctx.log.warn('journey mute changed', { journey: journey.name, muted, by: actorOf(principal) })
      return { status: 200, body: journey }
    }),

    /* ------------------------------------------------------------------ incidents */

    define('GET', '/v1/incidents', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const open = ctx.url.searchParams.get('open') === 'true'
      const incidents = open
        ? await listOpen(deps.sql)
        : await listRecent(deps.sql, deps.incidentWindowDays)
      return { status: 200, body: { incidents } }
    }),

    define('POST', '/v1/incidents', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const result = await openIncident(deps.sql, {
        scope: 'manual',
        subject: requireString(body, 'subject'),
        severity: requireSeverity(body),
        productGroup: requireString(body, 'productGroup'),
        cause: typeof body['cause'] === 'string' ? body['cause'] : undefined,
        detectedBy: 'manual',
      })
      return { status: result.opened ? 201 : 200, body: result.incident }
    }),

    define('POST', '/v1/incidents/:id/updates', async (ctx, deps) => {
      const principal = await authorise(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const incident = await findIncident(deps.sql, ctx.params['id'] ?? '')
      if (!incident) throw new NotFoundError('no such incident')
      const update = await addUpdate(
        deps.sql,
        incident.id,
        actorOf(principal),
        requireString(body, 'body'),
        body['public'] === true,
      )
      return { status: 201, body: update }
    }),

    define('POST', '/v1/incidents/:id/close', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE)
      const incident = await findIncident(deps.sql, ctx.params['id'] ?? '')
      if (!incident) throw new NotFoundError('no such incident')
      const closed = await closeIncident(deps.sql, incident.scope, incident.subject)
      return { status: 200, body: closed ?? incident }
    }),

    /**
     * The Alertmanager receiver.
     *
     * `deploy/alertmanager/alertmanager.yml:118` already posts here. Every alert opens a Beacon
     * incident as well as being delivered, because Beacon already owns incident open/close, the
     * hysteresis, the timeline and the status page — and two incident systems is two records to
     * reconcile at the worst possible moment.
     *
     * Authenticated with the static token: Alertmanager holds no identity credential, and an
     * incident-opening endpoint that anyone who can reach the port may call is a way to put a
     * false outage on the public status page.
     */
    define('POST', '/api/alerts/webhook', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const alerts = Array.isArray(body['alerts']) ? (body['alerts'] as unknown[]) : []
      let opened = 0
      let closed = 0
      for (const entry of alerts) {
        if (typeof entry !== 'object' || entry === null) continue
        const alert = entry as Record<string, unknown>
        const labels = (alert['labels'] ?? {}) as Record<string, unknown>
        const alertname = typeof labels['alertname'] === 'string' ? labels['alertname'] : 'unknown'
        const service = typeof labels['service'] === 'string' ? labels['service'] : 'estate'
        const subject = `${service}/${alertname}`
        if (alert['status'] === 'resolved') {
          await closeIncident(deps.sql, 'alert', subject)
          closed += 1
          continue
        }
        const annotations = (alert['annotations'] ?? {}) as Record<string, unknown>
        await openIncident(deps.sql, {
          scope: 'alert',
          subject,
          severity: severityFromLabel(labels['severity']),
          productGroup: typeof labels['team'] === 'string' ? labels['team'] : 'Network',
          cause: typeof annotations['summary'] === 'string' ? annotations['summary'] : alertname,
          detectedBy: 'alert',
        })
        opened += 1
      }
      // 200 with counts rather than 202: Alertmanager retries on a non-2xx, and a receiver that
      // cannot say what it did makes a duplicate delivery indistinguishable from a first one.
      return { status: 200, body: { opened, closed } }
    }),

    /* ------------------------------------------------------------------ SLOs */

    define('GET', '/v1/slos', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      const budgets = await allBudgets(deps.sql)
      return {
        status: 200,
        body: {
          // `objectivePpm` is a bigint and `JSON.stringify` THROWS on one rather than coercing it.
          // Converted here, explicitly, so the failure mode is a decimal string on the wire rather
          // than a 500 on a read-only route the first time an SLO exists.
          slos: (await listSlos(deps.sql)).map((slo) => ({
            ...slo,
            objectivePpm: slo.objectivePpm.toString(),
          })),
          // Every count as a STRING. They are bigints, and a JSON number above 2^53 is a number
          // that has already lost its low bits by the time anyone reads it.
          budgets: budgets.map((budget) => ({
            slo: budget.slo,
            total: budget.total.toString(),
            good: budget.good.toString(),
            bad: budget.bad.toString(),
            allowedBad: budget.allowedBad.toString(),
            remaining: budget.remaining.toString(),
            consumedPpm: budget.consumedPpm.toString(),
            exhausted: budget.exhausted,
            indeterminate: budget.indeterminate,
          })),
        },
      }
    }),

    define('PUT', '/v1/slos/:name', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE, { adminOnly: true })
      const body = await readJson(ctx.req)
      const objective = body['objectivePpm']
      if (typeof objective !== 'string' || !/^\d{1,7}$/.test(objective)) {
        // A STRING, refused if it is a number. An objective sent as a JSON float is an objective
        // that has already been rounded by whatever produced it, and 0.9995 does not survive a
        // round trip through every language the estate is written in.
        throw new BadRequestError('objectivePpm must be a decimal string of parts per million')
      }
      await upsertSlo(deps.sql, {
        name: ctx.params['name'] ?? '',
        service: requireString(body, 'service'),
        tier: requireInteger(body, 'tier'),
        kind: requireString(body, 'kind') as SloKind,
        objectivePpm: BigInt(objective),
        windowDays: typeof body['windowDays'] === 'number' ? body['windowDays'] : 28,
        enabled: body['enabled'] !== false,
      })
      return { status: 200, body: { name: ctx.params['name'] } }
    }),

    /* ------------------------------------------------------------------ conformance */

    define('GET', '/v1/conformance', async (ctx, deps) => {
      await authorise(ctx, deps, READ_SCOPE)
      return { status: 200, body: { suites: await latestConformance(deps.sql) } }
    }),

    /**
     * Record a conformance run.
     *
     * The corpus is replayed by `@cloudsforge/conformance` in CI; this is where the result becomes
     * an operational fact and a gate input. The status is DERIVED from the counts rather than
     * accepted from the caller — a reporter that could declare its own `pass` alongside a breaking
     * difference is a reporter that eventually does.
     */
    define('POST', '/v1/conformance', async (ctx, deps) => {
      await authorise(ctx, deps, WRITE_SCOPE)
      const body = await readJson(ctx.req)
      const counts = {
        identical: optionalInteger(body, 'identical'),
        benign: optionalInteger(body, 'benign'),
        breaking: optionalInteger(body, 'breaking'),
      }
      const run = await recordConformanceRun(deps.sql, {
        suite: requireString(body, 'suite'),
        status: conformanceStatusFor(counts),
        identical: counts.identical,
        benign: counts.benign,
        breaking: counts.breaking,
        skipped: optionalInteger(body, 'skipped'),
        ...(typeof body['durationMs'] === 'number' ? { durationMs: body['durationMs'] } : {}),
        ...(typeof body['release'] === 'string' ? { releaseTag: body['release'] } : {}),
        ...(typeof body['corpusRef'] === 'string' ? { corpusRef: body['corpusRef'] } : {}),
      })
      return { status: 201, body: run }
    }),
  ]
}

/* ------------------------------------------------------------------ the scrape refresh */

/**
 * Refresh every gauge from the database, once per scrape.
 *
 * The service this supersedes serves `/metrics` from memory and never touches Postgres, with a
 * stated reason: "a metrics endpoint that queries the database gives anyone who can reach it a way
 * to put load on the database by scraping in a loop" (`infra/beacon/src/metrics.js:8-12`). That
 * reasoning was right for a single-replica monitor holding live state in a `Map`. It does not
 * survive replicas — a two-replica deployment serving from memory publishes two different answers
 * depending on which one Prometheus reached, and the panel flickers between them.
 *
 * So this reads, and the objection is answered rather than ignored: the route is authenticated
 * (so "anyone who can reach it" is nobody), the scrape interval is 30s by config, and every query
 * below is a bounded index scan over tables whose row counts are the number of probes, journeys,
 * SLOs and open incidents — tens, not millions. The raw `checks` table is never touched here.
 */
export function scrapeRefresh(deps: {
  readonly sql: Sql
  readonly metrics: Metrics
}): () => Promise<void> {
  return async () => {
    deps.metrics.set('beacon_up', 1)

    const probes = await listProbes(deps.sql, true)
    const states = new Map((await listStates(deps.sql)).map((state) => [state.probe, state]))
    for (const probe of probes) {
      const value = stateValue(states.get(probe.name)?.reported ?? 'pending')
      // `pending` yields null and publishes NOTHING. A gap in a graph is readable; a series that
      // reads 0 for a probe that has never run makes every deploy look like an outage.
      if (value === null) continue
      deps.metrics.set('beacon_target_up', value, {
        probe: probe.name,
        target: probe.target,
        group: probe.productGroup,
      })
    }

    const registered = await listRegistered(deps.sql)
    const byName = new Map(registered.map((journey) => [journey.name, journey]))
    for (const run of await latestRuns(deps.sql)) {
      const journey = byName.get(run.journey)
      deps.metrics.set('beacon_journey_status', journeyStatusValue(run.status), {
        journey: run.journey,
        group: journey?.productGroup ?? 'Network',
      })
      deps.metrics.set(
        'beacon_journey_last_run_timestamp_seconds',
        Math.floor(run.startedAt.getTime() / 1000),
        { journey: run.journey },
      )
    }
    deps.metrics.set('beacon_journeys_muted', registered.filter((journey) => journey.muted).length)

    for (const budget of await allBudgets(deps.sql)) {
      if (budget.indeterminate) continue
      deps.metrics.set('beacon_slo_budget_remaining_ratio', remainingRatio(budget), { slo: budget.slo })
      // Clamped to what a double can hold exactly. A budget larger than 2^53 events is not a
      // thing this estate will ever have, and clamping is still better than publishing a number
      // that is silently wrong.
      deps.metrics.set('beacon_slo_budget_remaining_events', clampToSafe(budget.remaining), {
        slo: budget.slo,
      })
    }

    for (const run of await latestConformance(deps.sql)) {
      deps.metrics.set('beacon_conformance_vectors', run.identical, { suite: run.suite, result: 'identical' })
      deps.metrics.set('beacon_conformance_vectors', run.benign, { suite: run.suite, result: 'benign' })
      deps.metrics.set('beacon_conformance_vectors', run.breaking, { suite: run.suite, result: 'failed' })
      deps.metrics.set('beacon_conformance_vectors', run.skipped, { suite: run.suite, result: 'skipped' })
    }

    const open = await listOpen(deps.sql)
    for (const severity of ['sev1', 'sev2', 'sev3', 'sev4'] as const) {
      // Every severity is set every scrape, including the zeroes. A series that simply stops when
      // the last incident closes leaves an alert on `beacon_incidents_open` evaluating against a
      // stale sample rather than against zero.
      deps.metrics.set(
        'beacon_incidents_open',
        open.filter((incident) => incident.severity === severity).length,
        { severity },
      )
    }
  }
}

function clampToSafe(value: bigint): number {
  const max = BigInt(Number.MAX_SAFE_INTEGER)
  if (value > max) return Number.MAX_SAFE_INTEGER
  if (value < -max) return -Number.MAX_SAFE_INTEGER
  return Number(value)
}

/* ------------------------------------------------------------------ helpers */

function gateBody(decision: {
  releaseTag: string
  decision: string
  reasons: readonly { code: string; subject: string; detail: string; determinacy: string }[]
  waived: readonly { code: string; subject: string }[]
  indeterminate: boolean
}): Record<string, unknown> {
  return {
    release: decision.releaseTag,
    decision: decision.decision,
    promote: decision.decision !== 'refuse',
    indeterminate: decision.indeterminate,
    reasons: decision.reasons,
    waived: decision.waived,
  }
}

interface AuthOptions {
  readonly adminOnly?: boolean
}

/**
 * Authorise a request by static token first, then by identity JWT.
 *
 * **The order is the point.** The static token is checked before the verifier is consulted, so a
 * caller holding it is never affected by identity being unreachable — which is precisely the state
 * in which somebody is trying to read this service.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **BUT THE STATIC TOKEN IS NEVER AN ADMINISTRATOR, AND THE ORDER IS WHY THAT NEEDS SAYING.**
 *
 * Checking it first used to mean checking it INSTEAD: the match returned before the `adminOnly`
 * branch below was reached, so `adminOnly` was decorative on all four routes that declare it —
 * gate overrides, probe upsert, journey mute and SLO writes. `BEACON_TOKEN` is one long-lived
 * value that sits in the estate compose file, in Prometheus's secrets directory and in CI, held
 * by three processes that are not people. Muting a journey makes the release gate green, and
 * writing an SLO moves the line the gate is measured against — so a shared secret that could do
 * either was a shared secret that could approve its own release. A credential that can silence
 * the thing watching you is the one to get right.
 *
 * The line is drawn at `adminOnly` rather than at read-only, and that is a decision rather than a
 * compromise. Break-glass exists so the estate can be READ when identity is down, but its actual
 * deployed holders also legitimately WRITE two non-admin routes: Alertmanager posts
 * `/api/alerts/webhook` to open incidents (`alertmanager.yml:118`) and the conformance CLI posts
 * `/v1/conformance` (`conformance/src/cli.ts:298`). Neither holds an identity credential, and
 * cutting them to read-only would mean alerts that open no incident — losing the estate's
 * incident record at the exact moment it is needed. Nothing that holds this token needs an
 * `adminOnly` route. The one caller that used to, `beacon slo-seed --token`, already documents
 * `--bearer` as preferred for precisely this reason (`cli.ts`, `parseSloSeedArgs`).
 *
 * So: the static token satisfies READ, GATE and WRITE, and never `role:admin`. Administrative
 * change to beacon requires an identity that names a person.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
async function authorise(
  ctx: RequestContext,
  deps: ServerDeps,
  scope: string,
  options: AuthOptions = {},
): Promise<Principal> {
  const presented = headerOf(ctx.req, 'x-beacon-token')
  // Timing-safe, because a byte-at-a-time comparison of a shared secret is a byte-at-a-time
  // forgery oracle: an attacker who can measure it recovers the token one character at a time
  // without ever knowing it.
  const breakGlass =
    presented !== undefined && presented !== '' && constantTimeEquals(presented, deps.token)
  if (breakGlass && !options.adminOnly) {
    return { kind: 'service', service: 'beacon-token', scopes: [scope] }
  }

  const token = bearerFrom(headerOf(ctx.req, 'authorization'))
  // A missing token takes the same 401 path as a bad one rather than being a separate branch that
  // can drift away from it.
  if (!token) {
    // ...except when the caller DID present valid break-glass and simply is not an admin. That is
    // a 403, not a 401: the credential was recognised. An operator who gets a bare "a valid
    // credential is required" while holding a valid credential retries with the same token
    // instead of reaching for an identity, and debugs the wrong thing during an incident.
    if (breakGlass) throw new ForbiddenError('role:admin')
    throw new TokenError('no credential presented', 'missing')
  }
  // Falling through rather than refusing outright, so that break-glass does not POISON a request
  // that also carries a real admin bearer. A client that sets this header from an environment
  // variable and also signs in is not an attacker, and the bearer still has to pass `isAdmin`.
  const principal = await deps.verifier.principal(token)

  if (options.adminOnly) {
    if (principal.kind === 'user' && isAdmin(principal)) return principal
    if (principal.kind === 'service' && principal.scopes.includes(scope)) return principal
    throw new ForbiddenError(options.adminOnly ? `role:admin or ${scope}` : scope)
  }
  if (principal.kind === 'user') return principal
  if (principal.scopes.includes(scope)) return principal
  throw new ForbiddenError(scope)
}

function constantTimeEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented)
  const b = Buffer.from(expected)
  // Length is compared first and leaks only the length. `timingSafeEqual` throws on a mismatch,
  // and a throw here would be a 500 that tells the caller their token was the wrong size.
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function actorOf(principal: Principal): string {
  return principal.kind === 'user' ? `user:${principal.userId}` : `service:${principal.service}`
}

function requireRelease(ctx: RequestContext): string {
  const tag = ctx.url.searchParams.get('release')?.trim() ?? ''
  if (!RELEASE_TAG.test(tag)) {
    throw new BadRequestError('release must be a tag of up to 128 characters of [A-Za-z0-9._-]')
  }
  return tag
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestError(`${field} is required`)
  }
  return value.trim()
}

function requireInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new BadRequestError(`${field} must be a whole number`)
  }
  return value
}

function optionalInteger(body: Record<string, unknown>, field: string): number {
  const value = body[field]
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestError(`${field} must be a non-negative whole number`)
  }
  return value
}

function requireSeverity(body: Record<string, unknown>): Severity {
  const value = body['severity']
  if (value !== 'sev1' && value !== 'sev2' && value !== 'sev3' && value !== 'sev4') {
    throw new BadRequestError('severity must be one of sev1, sev2, sev3, sev4')
  }
  return value
}

/**
 * Alertmanager's `severity` label to the ladder.
 *
 * Anything unrecognised becomes SEV3 rather than being dropped. An alert whose label was
 * misspelled is still an alert somebody wrote, and dropping it silently is how a rule fires for a
 * month into nothing.
 */
function severityFromLabel(value: unknown): Severity {
  if (value === 'critical' || value === 'sev1') return 'sev1'
  if (value === 'page' || value === 'sev2') return 'sev2'
  if (value === 'info' || value === 'sev4') return 'sev4'
  return 'sev3'
}

async function readRaw(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new BadRequestError('request body too large')
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRaw(req)
  if (raw.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new BadRequestError('request body must be a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (err) {
    if (err instanceof BadRequestError) throw err
    throw new BadRequestError('request body is not valid JSON')
  }
}

function errorReply(status: number, code: string, message: string, requestId: string): Reply {
  return { status, body: { error: { code, message, requestId } } }
}

function send(res: ServerResponse, reply: Reply, requestId: string): void {
  if (res.writableEnded) return
  const payload = reply.text ?? `${JSON.stringify(reply.body ?? {})}\n`
  res.writeHead(reply.status, {
    'content-type': reply.contentType ?? 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'x-request-id': requestId,
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function headerOf(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}
