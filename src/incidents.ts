/**
 * Incidents.
 *
 * An incident is a **state transition that survived hysteresis**, not a failed check. That
 * distinction is the difference between a monitor you read and a monitor you mute, and it is the
 * one idea worth carrying forward whole from the service this supersedes
 * (`infra/beacon/src/incidents.js`).
 *
 * Everything that can open one — a probe crossing `failThreshold`, a journey failing twice
 * running, an Alertmanager webhook, an operator — comes through this module, so there is exactly
 * one place that decides what reaches the incident log.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **DEDUPE IS THE PARTIAL UNIQUE INDEX, NOT A `Map` IN A PROCESS.**
 *
 * The frozen service holds open incidents in a module-scope `Map` keyed on `scope:subject`
 * (`incidents.js`) and separately writes an `ON CONFLICT` insert. With one replica that
 * works. With two, each replica holds half the open set: replica A opens an incident, replica B
 * knows nothing about it, and B's next failing cycle tries to open it again. The database catches
 * that — `incidents_open_uniq` is why — but only because the index exists; the in-memory half was
 * never the thing doing the work.
 *
 * So the index is the mechanism and there is no cache. A probe failing every thirty seconds for an
 * hour produces ONE incident with `failures = 120`, from either replica, in any order.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import type { Sql } from '@cloudsforge/db'

/**
 * The ladder from 13-operational-model.md.
 *
 * The values sort correctly as text — `'sev1' < 'sev2'` — which is why `least()` is a correct
 * severity escalation in SQL and no ordering table is needed. That is a property of the naming,
 * so the naming is not free to change.
 */
export type Severity = 'sev1' | 'sev2' | 'sev3' | 'sev4'

/** `detected → declared → mitigated → resolved → reviewed`. Mitigation precedes diagnosis. */
export type IncidentState = 'detected' | 'declared' | 'mitigated' | 'resolved' | 'reviewed'

export type IncidentScope = 'probe' | 'journey' | 'slo' | 'alert' | 'manual'

export type DetectedBy = 'probe' | 'journey' | 'alert' | 'manual' | 'customer'

/**
 * The INTERNAL incident record. Everything known about it.
 *
 * This type is deliberately never serialised to an unauthenticated caller. `publicstatus.ts` holds
 * the public one, and the two are separate types precisely so that adding a field here cannot
 * reach the public page. See that module's header.
 */
export interface Incident {
  readonly id: string
  readonly scope: IncidentScope
  /** The internal subject: `ledger.postings`, `hearth.seed`. Topology. Never published. */
  readonly subject: string
  readonly severity: Severity
  readonly state: IncidentState
  readonly productGroup: string
  readonly openedAt: Date
  readonly closedAt: Date | null
  readonly cause: string | null
  /** The upstream's own error text. Never published: it describes the shape of the outage. */
  readonly lastError: string | null
  readonly failures: number
  readonly detectedBy: DetectedBy
}

interface IncidentRow {
  id: string
  scope: string
  subject: string
  severity: string
  state: string
  product_group: string
  opened_at: Date
  closed_at: Date | null
  cause: string | null
  last_error: string | null
  failures: number
  detected_by: string
}

function toIncident(row: IncidentRow): Incident {
  return {
    id: row.id,
    scope: row.scope as IncidentScope,
    subject: row.subject,
    severity: row.severity as Severity,
    state: row.state as IncidentState,
    productGroup: row.product_group,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    cause: row.cause,
    lastError: row.last_error,
    failures: Number(row.failures),
    detectedBy: row.detected_by as DetectedBy,
  }
}

export interface OpenRequest {
  readonly scope: IncidentScope
  readonly subject: string
  readonly severity: Severity
  readonly productGroup: string
  readonly cause?: string | undefined
  readonly lastError?: string | undefined
  readonly detectedBy?: DetectedBy | undefined
  readonly at?: Date | undefined
}

export interface OpenResult {
  readonly incident: Incident
  /** False when this folded into an incident that was already open. The dedupe, observable. */
  readonly opened: boolean
}

/**
 * Open an incident, or fold this failure into the one that is already open.
 *
 * The `on conflict` target repeats the partial index's predicate (`where closed_at is null`)
 * because Postgres will not choose a partial index for an upsert unless the statement names it —
 * without the predicate this raises 42P10 rather than deduping, which is a failure that only
 * appears the second time something breaks.
 */
export async function openIncident(sql: Sql, request: OpenRequest): Promise<OpenResult> {
  const at = request.at ?? new Date()
  const rows = (await sql`
    insert into incidents
      (scope, subject, severity, product_group, opened_at, cause, last_error, failures, detected_by)
    values
      (${request.scope}, ${request.subject}, ${request.severity}, ${request.productGroup},
       ${at}, ${request.cause ?? null}, ${request.lastError ?? null}, 1,
       ${request.detectedBy ?? 'probe'})
    on conflict (scope, subject) where closed_at is null
    do update set
      failures = incidents.failures + 1,
      -- Severity ESCALATES and never de-escalates while the incident is open. 'sev1' sorts before
      -- 'sev2', so least() takes the worse of the two. A page that quietly downgraded itself
      -- because a later, milder symptom arrived is a page that stops being answered.
      severity = least(incidents.severity, excluded.severity),
      last_error = coalesce(excluded.last_error, incidents.last_error),
      cause = coalesce(incidents.cause, excluded.cause)
    returning *
  `) as unknown as IncidentRow[]

  const row = rows[0]
  if (!row) throw new Error('incident upsert returned no row')
  const incident = toIncident(row)
  return { incident, opened: incident.failures === 1 }
}

/**
 * Close the open incident for a subject, if there is one.
 *
 * Sets `state = 'resolved'` in the same statement as `closed_at`, because
 * `incidents_closed_is_terminal` refuses a row that is closed but still `detected` — a closed
 * incident in a non-terminal state is how a resolved outage sits on a status page for a week.
 */
export async function closeIncident(
  sql: Sql,
  scope: IncidentScope,
  subject: string,
  at: Date = new Date(),
): Promise<Incident | null> {
  const rows = (await sql`
    update incidents
       set closed_at = ${at}, state = 'resolved'
     where scope = ${scope} and subject = ${subject} and closed_at is null
    returning *
  `) as unknown as IncidentRow[]
  const row = rows[0]
  return row ? toIncident(row) : null
}

/** Move an open incident along the lifecycle. Never backwards, and never past `mitigated`. */
export async function advanceState(
  sql: Sql,
  id: string,
  state: Extract<IncidentState, 'declared' | 'mitigated'>,
): Promise<Incident | null> {
  const rows = (await sql`
    update incidents set state = ${state}
     where id = ${id} and closed_at is null
    returning *
  `) as unknown as IncidentRow[]
  const row = rows[0]
  return row ? toIncident(row) : null
}

/** Mark a closed incident reviewed. The post-incident review is mandatory for SEV1 and SEV2. */
export async function markReviewed(sql: Sql, id: string): Promise<Incident | null> {
  const rows = (await sql`
    update incidents set state = 'reviewed'
     where id = ${id} and closed_at is not null and state = 'resolved'
    returning *
  `) as unknown as IncidentRow[]
  const row = rows[0]
  return row ? toIncident(row) : null
}

export async function listOpen(sql: Sql): Promise<readonly Incident[]> {
  const rows = (await sql`
    select * from incidents where closed_at is null order by severity, opened_at desc
  `) as unknown as IncidentRow[]
  return rows.map(toIncident)
}

export async function listRecent(sql: Sql, windowDays: number, limit = 100): Promise<readonly Incident[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const rows = (await sql`
    select * from incidents
     where closed_at is null or closed_at > ${since}
     order by opened_at desc
     limit ${Math.min(limit, 500)}
  `) as unknown as IncidentRow[]
  return rows.map(toIncident)
}

export async function findIncident(sql: Sql, id: string): Promise<Incident | null> {
  const rows = (await sql`select * from incidents where id = ${id}`) as unknown as IncidentRow[]
  const row = rows[0]
  return row ? toIncident(row) : null
}

export interface IncidentUpdate {
  readonly id: string
  readonly incidentId: string
  readonly at: Date
  readonly author: string
  readonly body: string
  readonly isPublic: boolean
}

/**
 * One incident, two audiences, one write.
 *
 * A separate public-updates store would be a second thing to keep true during the twenty minutes
 * nobody has time to keep anything true. `is_public` is a flag on the same row, and the public
 * projection filters on it.
 */
export async function addUpdate(
  sql: Sql,
  incidentId: string,
  author: string,
  body: string,
  isPublic: boolean,
): Promise<IncidentUpdate> {
  const rows = (await sql`
    insert into incident_updates (incident_id, author, body, is_public)
    values (${incidentId}, ${author}, ${body}, ${isPublic})
    returning *
  `) as unknown as Array<{
    id: string
    incident_id: string
    at: Date
    author: string
    body: string
    is_public: boolean
  }>
  const row = rows[0]
  if (!row) throw new Error('incident update insert returned no row')
  return {
    id: row.id,
    incidentId: row.incident_id,
    at: row.at,
    author: row.author,
    body: row.body,
    isPublic: row.is_public,
  }
}

export async function listUpdates(
  sql: Sql,
  incidentId: string,
  publicOnly: boolean,
): Promise<readonly IncidentUpdate[]> {
  const rows = (await sql`
    select * from incident_updates
     where incident_id = ${incidentId}
       ${publicOnly ? sql`and is_public = true` : sql``}
     order by at
  `) as unknown as Array<{
    id: string
    incident_id: string
    at: Date
    author: string
    body: string
    is_public: boolean
  }>
  return rows.map((row) => ({
    id: row.id,
    incidentId: row.incident_id,
    at: row.at,
    author: row.author,
    body: row.body,
    isPublic: row.is_public,
  }))
}

/**
 * The severity a failing probe or journey opens at.
 *
 * Critical means the critical-path set — register, sign in, deposit, withdraw and the rest — and a
 * Tier-1 journey failing is a SEV2 by the ladder ("a product unusable, or money delayed but
 * safe"). Non-critical is SEV3, "degraded but working". Nothing here opens a SEV1 automatically:
 * SEV1 is "money at risk, or the platform unusable for most users", and that is a judgement a
 * human makes with the correctness signals in front of them, not something a failed HTTP GET can
 * assert on its own.
 */
export function severityFor(critical: boolean): Severity {
  return critical ? 'sev2' : 'sev3'
}
