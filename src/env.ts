/**
 * Configuration, validated at import.
 *
 * Rule 9 of docs/ecosystem/03 §2 — "a repo declares the variables it needs; the deploy provides
 * exactly those" — is a property of this file. Every variable this service reads is named here and
 * nowhere else.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE TWENTY-URL BLOCK IS GONE, AND ITS ABSENCE IS DELIBERATE.**
 *
 * The service this supersedes carries one environment variable per probed address —
 * `BEACON_NIMBUS_URL`, `BEACON_GAME_URL`, `BEACON_PAY_URL`, … nineteen of them, each with a
 * hardcoded compose-network default (`infra/beacon/src/env.js`). Two costs, both paid:
 * adding a service to the estate means editing the monitor's source, and every one of those
 * defaults is a container name that is right in exactly one deployment. `MAP.md` §4 in that repo
 * is the record of the same mistake being made three times.
 *
 * Here there is ONE variable — `BEACON_TARGETS` — and the probe catalogue lives in a table. A
 * monitor whose target list is a deploy concern rather than a source change is a monitor that can
 * follow the estate it watches.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Two behaviours are copied deliberately from the siblings:
 *
 *   1. **A missing variable names itself.** `undefined` propagating into a connection string
 *      surfaces four layers later as an unreadable driver error.
 *   2. **A known placeholder is refused outright.** A default secret in source is not convenient,
 *      it is catastrophic, and a placeholder that boots is a placeholder that reaches production.
 */

import { hostname } from 'node:os'
import { SecretError, assertOpaqueSecret, assertServiceCredential } from '@cloudsforge/secrets'
import { TargetsError, parseTargets as parseTargetsPure } from './targets.ts'

/**
 * The service's own name. A constant rather than a variable: it is a property of the repository,
 * not of the deployment, and making it configurable is how two services end up sharing a migration
 * advisory lock.
 */
export const SERVICE = 'beacon'

/** Raised by `loadEnv`. Distinct so a caller can tell configuration from every other failure. */
export class EnvError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvError'
  }
}

/**
 * THE `PLACEHOLDERS` SET THAT USED TO BE HERE IS GONE, AND ITS ABSENCE IS THE FIX.
 *
 * It held nine exact strings and was paired with a 24-character floor. Neither could fail for the
 * value that is in `deploy/compose/docker-compose.estate.yml` on two lines TODAY:
 * `BEACON_TOKEN: estate-only-beacon-breakglass-000000000` is 39 characters and was on nobody's
 * list. Measured out of `cloudsforge-estate-beacon-1` on 2026-08-05, so this is not a reading of
 * the file — it is what the running container holds. Both lines are HARDCODED LITERALS rather than
 * `${BEACON_TOKEN:-…}` interpolations, so no deploy has ever been able to override them.
 *
 * A check that cannot fail is worse than no check, because the absence of an alarm gets read as the
 * absence of a problem — and this is the release gate. `/metrics` and `/v1/gate` describe the shape
 * of the estate: which services exist, which are down, which journey is failing, and whether a
 * release may be promoted.
 *
 * A deny-list of exact strings is structurally unable to work: the next placeholder somebody writes
 * is, by definition, not on it. `@cloudsforge/secrets` asserts the SHAPE of the value instead,
 * which is the property a placeholder cannot have. It is imported rather than copied so that this
 * service cannot drift from the other sixteen.
 */

type Source = Readonly<Record<string, string | undefined>>

function required(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) throw new EnvError(`${name} is required — ${SERVICE} refuses to start without it`)
  return value
}

/**
 * Re-wrap the shared guard's `SecretError` as this service's `EnvError`.
 *
 * `loadEnv` documents a single error class for every configuration failure, and the boot path
 * catches that one class. The message is preserved verbatim — it already names the variable and the
 * command that fixes it, and it never contains the value.
 */
function asEnvError<T>(run: () => T): T {
  try {
    return run()
  } catch (err) {
    if (err instanceof SecretError) throw new EnvError(err.message)
    throw err
  }
}

/**
 * A secret whose ALPHABET THIS ESTATE DOES NOT CONTROL.
 *
 * ── WHY `assertOpaqueSecret` AND NOT `assertGeneratedSecret` ───────────────────────────────────
 *
 * `assertGeneratedSecret` is the stricter rule and it is the right one for a key the estate MINTS,
 * because the estate chooses those values with `openssl rand -base64 48` and can therefore demand
 * the base64 or hex alphabet of them. `BEACON_TOKEN` is not one of those, and the compose file says
 * so in its own words: "BEACON_TOKEN IS INBOUND BREAK-GLASS, NOT AN OUTBOUND SERVICE TOKEN … a
 * static shared secret, like `ANALYTICS_TOKEN`, and NOT minted by identity."
 *
 * That is not a detail of provenance, it is the property the token exists to have. This service
 * checks `BEACON_TOKEN` BEFORE the identity bearer precisely so that "when identity is the thing
 * that has broken, a Beacon that could only be read with an identity token would be a Beacon nobody
 * can read". A value with that job is one a person transcribes out of a runbook during an incident,
 * which is the case `@cloudsforge/secrets` documents `assertOpaqueSecret` for by name.
 *
 * ── IT REFUSES THE LIVE VALUE ANYWAY, WHICH IS THE ENTIRE POINT ────────────────────────────────
 *
 * The two rules differ on the alphabet and agree on everything that matters here. Both normalise
 * punctuation and case away and then refuse a placeholder MARKER anywhere in the value, so
 * `estate-only-beacon-breakglass-000000000` flattens to a string containing `estateonly` and is
 * refused by either. The choice between them buys the operator a hand-set value that works; it does
 * not buy the defect a way through.
 *
 * **CONSEQUENCE, STATED PLAINLY: this service will not boot on either estate until `BEACON_TOKEN`
 * is set to a real value.** That is the fix, not a side effect of it — see the block above.
 */
function requiredOpaqueSecret(source: Source, name: string): string {
  const value = required(source, name)
  asEnvError(() => assertOpaqueSecret(name, value))
  return value
}

function optional(source: Source, name: string, fallback: string): string {
  const value = source[name]?.trim()
  return value && value.length > 0 ? value : fallback
}

/**
 * A SERVICE CREDENTIAL that may be absent, but must be real if present.
 *
 * ── ABSENCE IS A SUPPORTED MODE, AND IT STAYS ONE ──────────────────────────────────────────────
 *
 * The empty check is AHEAD of the assertion, and it has to be. Compose interpolates
 * `BEACON_SERVICE_CREDENTIAL: ${BEACON_IDENTITY_CREDENTIAL:-}`, so a deployment that has not been
 * granted a credential hands this process the EMPTY STRING rather than nothing at all — that is the
 * supported mode, not a malformed one, and the journeys that need a scoped token are then not
 * declared rather than declared-and-failing. Turning that into `exit(1)` would take the release
 * gate itself down, which is the one service whose absence makes every other outage invisible.
 *
 * ── WHY NOT `assertOpaqueSecret`, LET ALONE `assertGeneratedSecret` ────────────────────────────
 *
 * Because this variable is the OTHER kind, and the compose file had to say so out loud: "the names
 * do not match … `beacon/src/ecosystem.ts` EXCHANGES it at `POST /service-tokens/exchange` for
 * a `ledger:read` token, so it is the long-lived `cfsc_…` kind". `assertGeneratedSecret` would
 * refuse every credential this estate has ever minted — the underscore in `cfsc_` disqualifies both
 * alphabets — and beacon would exit 1 at boot on BOTH networks.
 *
 * `assertServiceCredential` also refuses a JWT BY NAME, which is the failure worth catching here:
 * an injected 600-second token in this variable looks configured, works for ten minutes, and then
 * answers 401 for ever with nothing re-minting it (micro-org #197/#222). Measured live on
 * 2026-08-05, `cloudsforge-estate-beacon-1` holds `cfsc_` + 43 characters — a real credential, and
 * it PASSES.
 */
function optionalCredential(source: Source, name: string): string {
  const value = source[name]?.trim()
  if (!value) return ''
  asEnvError(() => assertServiceCredential(name, value))
  return value
}

function integer(source: Source, name: string, fallback: number, min: number, max: number): number {
  const raw = source[name]?.trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new EnvError(`${name} must be a whole number between ${min} and ${max} (got ${raw})`)
  }
  return value
}

function boolean(source: Source, name: string, fallback: boolean): boolean {
  const raw = source[name]?.trim().toLowerCase()
  if (!raw) return fallback
  if (raw === 'true' || raw === '1') return true
  if (raw === 'false' || raw === '0') return false
  throw new EnvError(`${name} must be true or false (got ${raw})`)
}

/**
 * `name=url,name=url` — the estate's addresses.
 *
 * The parser itself lives in `./targets.ts`, which has no side effects, so `beacon browser` can
 * read the same variable without importing this module and therefore without demanding a database
 * credential. Re-raised as an `EnvError` here so every caller of `loadEnv` still sees one type.
 */
export function parseTargets(raw: string): ReadonlyMap<string, string> {
  try {
    return parseTargetsPure(raw)
  } catch (err) {
    if (err instanceof TargetsError) throw new EnvError(err.message)
    throw err
  }
}

export interface Env {
  readonly port: number
  readonly env: string
  readonly version: string
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error'
  /**
   * Rule 1: one database, named by this service's own variable. The CI check greps for any other
   * connection-string variable, so adding a second one here fails the build rather than review.
   */
  readonly databaseUrl: string
  readonly databasePoolMax: number
  readonly identityJwksUrl: string
  readonly identityIssuer: string
  readonly instanceId: string

  /** The estate's addresses. One variable; see the file header. */
  readonly targets: ReadonlyMap<string, string>

  /**
   * The credential Prometheus presents in `x-beacon-token`.
   *
   * **AD-20 says adopting a scraper costs "a scrape config rather than a rewrite". It costs a
   * scrape config AND THIS**, and 02-target-architecture.md records the correction:
   * "Scraping Beacon costs a credential, not just a scrape config … Verified — an unauthenticated
   * scrape returns 401 and the target reads DOWN." `/metrics` describes the shape of the estate —
   * which services exist, which are down, which journey is failing — and an open one hands that to
   * anyone who can reach the port. `deploy/prometheus/prometheus.yml` already carries the
   * matching `http_headers: files:` block, and `BeaconScrapeFailing` is the alert that fires when
   * this is unset.
   *
   * The name is `BEACON_TOKEN` because that is the name the built deploy already reads
   * (`deploy/.env.example:19-20`). Required here, not optional: the frozen service defaults it to
   * `''` (`infra/beacon/src/env.js`), which is exactly why the estate ships a scrape that 401s.
   * A credential whose absence is a supported mode is a credential nobody notices is absent.
   */
  readonly token: string

  /** How long one probe attempt may take before it is a FAILURE. See `probes.ts`. */
  readonly probeDeadlineMs: number
  /** How long one journey may take before it is a FAILURE. */
  readonly journeyDeadlineMs: number
  /** Default probe cadence for a row that does not name its own. */
  readonly probeIntervalMs: number
  readonly journeyIntervalMs: number

  /** Consecutive failures before an incident opens. One failure is a dropped packet. */
  readonly failThreshold: number
  /** Consecutive successes before it closes. Hysteresis in both directions. */
  readonly recoverThreshold: number

  /**
   * How stale a journey result may be and still count as an ANSWER.
   *
   * Past this the gate treats the journey as indeterminate and refuses. It is the single most
   * important number in this file: it is what makes "the scheduler died" a refusal rather than a
   * permanent green. Default is four journey intervals, so one missed run is tolerated and two are
   * not.
   */
  readonly gateFreshnessMs: number

  /**
   * How many consecutive green journey runs a release must show.
   *
   * Three, from 13-operational-model.md — "must pass the full journey suite three consecutive
   * times before its manifest is promoted" — and 17-definition-of-done.md. One green run after
   * a red one is a flake that happened to land the right way up; three is a claim.
   */
  readonly gateConsecutiveGreen: number

  /** The SLO window, in days. 28 rather than 30: four whole weeks compare like with like. */
  readonly sloWindowDays: number

  /** Serve the redacted projection without a token. "Public" is a decision, so it defaults off. */
  readonly publicStatus: boolean

  /* ---------------------------------------------------------------- journeys that need more */

  /**
   * The origin an SSO hand-off code is minted against, for `identity.handoff`.
   *
   * A hand-off code is bound to one origin at mint and matched at redemption — that binding is the
   * whole security of the hand-off, because without it an open redirect anywhere in the estate
   * turns a legitimate sign-in into a token delivered to somebody else's page. So the journey
   * cannot invent one: it has to be an origin identity's own `IDENTITY_HANDOFF_ORIGINS` names.
   *
   * Empty is supported and means the journey SKIPS with that reason. It is not a failure: an
   * estate that has not configured SSO has not demonstrated a broken SSO. The dev estate has not —
   * `IDENTITY_HANDOFF_ORIGINS` is unset in `deploy/compose/docker-compose.estate.yml`.
   */
  readonly handoffOrigin: string

  /**
   * A long-lived service credential, exchanged for a short-lived scoped token per journey run.
   *
   * **A credential, never an injected token, and that is the point.** `deploy/README.md` records
   * the ten-minute cliff: identity issues service tokens with a 600-second TTL and nothing re-mints
   * one, so anything holding an injected token starts answering 401 ten minutes after the estate
   * came up. `POST /service-tokens/exchange` turns a credential into a fresh token whenever one is
   * needed, which is the shape a monitor running every five minutes for weeks requires.
   *
   * Empty is supported and means the journeys that need a scoped token are **not declared at all**
   * — absent rather than declared-and-skipping. Beacon cannot hold one today in any case:
   * `IDENTITY_SERVICE_TOKEN_GRANTS` names thirteen services and `beacon` is not among them.
   */
  readonly serviceCredential: string

  /* ---------------------------------------------------------------- the browser */

  /**
   * Drive a real browser at all.
   *
   * Off by default. A browser is a large optional dependency and a deployment that chooses not to
   * ship one is making a decision, not suffering an outage — so every browser journey skips with
   * that reason rather than failing.
   */
  readonly browserEnabled: boolean
  /**
   * Absolute path to a Chromium.
   *
   * Empty lets `playwright-core` find its own, which is what a developer machine with a
   * `ms-playwright` cache wants. A container sets it, because the image installs Chromium through
   * the package manager rather than through playwright.
   */
  readonly browserExecutable: string
  /** How long one page operation may take. Separate from the journey deadline, which covers all of them. */
  readonly browserTimeoutMs: number

  readonly checkRetentionDays: number
  readonly rollupRetentionDays: number
  readonly runRetentionDays: number
  readonly incidentRetentionDays: number
}

const LEVELS = new Set(['debug', 'info', 'warn', 'error'])

export function loadEnv(source: Source = process.env, host = ''): Env {
  const logLevel = optional(source, 'LOG_LEVEL', 'info')
  if (!LEVELS.has(logLevel)) {
    throw new EnvError(`LOG_LEVEL must be one of debug, info, warn, error (got ${logLevel})`)
  }

  const journeyIntervalMs = integer(source, 'BEACON_JOURNEY_INTERVAL_MS', 300_000, 10_000, 86_400_000)
  const failThreshold = integer(source, 'BEACON_FAIL_THRESHOLD', 3, 1, 100)
  const recoverThreshold = integer(source, 'BEACON_RECOVER_THRESHOLD', 2, 1, 100)

  const probeDeadlineMs = integer(source, 'BEACON_PROBE_DEADLINE_MS', 5_000, 100, 120_000)
  const probeIntervalMs = integer(source, 'BEACON_PROBE_INTERVAL_MS', 30_000, 1_000, 3_600_000)
  if (probeDeadlineMs >= probeIntervalMs) {
    // A deadline at or above the cadence means the previous attempt can still be running when the
    // next is due. The lease stops two workers taking one probe, but the schedule itself would
    // stretch past its own period and the monitor's resolution would collapse exactly when the
    // network went bad — which is when it needs to be sharp.
    throw new EnvError(
      `BEACON_PROBE_DEADLINE_MS (${probeDeadlineMs}) must be below BEACON_PROBE_INTERVAL_MS (${probeIntervalMs})`,
    )
  }

  // Validated rather than passed through. An origin with a path, or a bare hostname, produces a
  // hand-off code identity will never match at redemption, and the journey would report SSO broken
  // for a configuration typo.
  const handoffOrigin = optional(source, 'BEACON_HANDOFF_ORIGIN', '')
  if (handoffOrigin.length > 0) {
    let parsed: URL
    try {
      parsed = new URL(handoffOrigin)
    } catch {
      throw new EnvError(`BEACON_HANDOFF_ORIGIN must be an absolute origin (got "${handoffOrigin}")`)
    }
    if (parsed.origin !== handoffOrigin) {
      throw new EnvError(
        `BEACON_HANDOFF_ORIGIN must be exactly an origin — scheme, host and optional port, no ` +
          `path or trailing slash (got "${handoffOrigin}", meant "${parsed.origin}")`,
      )
    }
  }

  return {
    port: integer(source, 'PORT', 4011, 1, 65_535),
    env: optional(source, 'NODE_ENV', 'development'),
    version: optional(source, 'CLOUDSFORGE_TAG', 'dev'),
    logLevel: logLevel as Env['logLevel'],
    databaseUrl: required(source, 'BEACON_DATABASE_URL'),
    databasePoolMax: integer(source, 'BEACON_DATABASE_POOL_MAX', 10, 1, 100),
    identityJwksUrl: required(source, 'IDENTITY_JWKS_URL'),
    identityIssuer: required(source, 'IDENTITY_ISSUER'),
    instanceId: optional(source, 'INSTANCE_ID', host || 'unknown'),

    targets: parseTargets(optional(source, 'BEACON_TARGETS', '')),
    token: requiredOpaqueSecret(source, 'BEACON_TOKEN'),

    probeDeadlineMs,
    journeyDeadlineMs: integer(source, 'BEACON_JOURNEY_DEADLINE_MS', 90_000, 1_000, 900_000),
    probeIntervalMs,
    journeyIntervalMs,

    failThreshold,
    recoverThreshold,

    gateFreshnessMs: integer(
      source,
      'BEACON_GATE_FRESHNESS_MS',
      journeyIntervalMs * 4,
      60_000,
      7 * 86_400_000,
    ),

    gateConsecutiveGreen: integer(source, 'BEACON_GATE_CONSECUTIVE_GREEN', 3, 1, 20),
    sloWindowDays: integer(source, 'BEACON_SLO_WINDOW_DAYS', 28, 1, 400),

    publicStatus: boolean(source, 'BEACON_PUBLIC_STATUS', false),

    handoffOrigin,
    // Never logged, never echoed. Absent stays a SUPPORTED mode — the empty check sits ahead of the
    // assertion, because compose interpolates `${BEACON_IDENTITY_CREDENTIAL:-}` and an unset
    // credential therefore arrives as the empty string. What is no longer supported is a value that
    // is present and is not a credential: see `optionalCredential`.
    serviceCredential: optionalCredential(source, 'BEACON_SERVICE_CREDENTIAL'),

    browserEnabled: boolean(source, 'BEACON_BROWSER_ENABLED', false),
    browserExecutable: optional(source, 'BEACON_BROWSER_EXECUTABLE', ''),
    browserTimeoutMs: integer(source, 'BEACON_BROWSER_TIMEOUT_MS', 30_000, 1_000, 300_000),

    // Raw checks are the bulk of the data and are worthless once rolled up. Rollups are small and
    // are what a 90-day uptime figure is computed from, so they outlive the raw rows.
    checkRetentionDays: integer(source, 'BEACON_CHECK_RETENTION_DAYS', 14, 1, 400),
    rollupRetentionDays: integer(source, 'BEACON_ROLLUP_RETENTION_DAYS', 400, 1, 3_650),
    runRetentionDays: integer(source, 'BEACON_RUN_RETENTION_DAYS', 90, 1, 3_650),
    incidentRetentionDays: integer(source, 'BEACON_INCIDENT_RETENTION_DAYS', 400, 1, 3_650),
  }
}

/**
 * The checks above run at import, before the logger exists, so an uncaught throw reaches the
 * container as a bare V8 stack: not JSON, no level, no service name. The collector drops it and
 * the only symptom an operator gets is a container that exits instantly.
 *
 * So emit one structured fatal line by hand. It is built from a literal rather than routed through
 * the telemetry package: nothing that can itself fail may sit between a configuration error and
 * the report of it.
 */
function fatalConfig(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: 'fatal',
      service: SERVICE,
      step: 'env',
      msg: `startup failed at: env — ${message}`,
    })}\n`,
  )
  process.exit(1)
}

export const env: Env = (() => {
  try {
    return loadEnv(process.env, hostname())
  } catch (err) {
    fatalConfig(err)
  }
})()
