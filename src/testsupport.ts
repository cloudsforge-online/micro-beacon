/**
 * The database harness, and the fakes.
 *
 * **A database test runs only against a database whose name says it is a test database.**
 *
 * Not a convenience: `resetBeacon` truncates every table this service owns, and requiring "test"
 * in the name is the difference between a red build and an emptied environment. This service holds
 * `check_rollups`, which 13-operational-model.md:683 names as "the only irreplaceable part" of the
 * observation plane's backup story — a 400-day uptime history that cannot be recomputed from
 * anything, because the raw checks behind it were pruned a year ago.
 *
 * Only a `beacon_test` database is ever created or written by this suite.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import postgres from 'postgres'
import { migrate, type Sql } from '@cloudsforge/db'
import { Logger, Metrics } from '@cloudsforge/telemetry'
import { MIGRATIONS, TABLES } from './migrations.ts'
import { registerServiceMetrics } from './server.ts'
import { upsertProbe, type Probe, type ProbeSpec } from './probes.ts'
import { upsertSlo } from './slo.ts'
import { syncRegistry, type JourneyDefinition } from './journeys.ts'
import { PPM } from './slo.ts'

const url = process.env['BEACON_TEST_DATABASE_URL']

export const enabled = Boolean(url && /test/i.test(url))

export const skip = enabled ? false : 'set BEACON_TEST_DATABASE_URL (name must contain "test")'

export function openDb(max = 8): postgres.Sql {
  if (!enabled) throw new Error('database tests are disabled')
  return postgres(url!, { max, onnotice: () => {} })
}

/**
 * Bring the schema up. Idempotent, so every test file may call it and only the first does work.
 *
 * Deliberately runs the real `MIGRATIONS` rather than a hand-written fixture schema. A fixture
 * would let the constraints drift out of the tests that are supposed to prove they fire — and two
 * of them, `incidents_open_uniq` and `gate_decisions_indeterminate_never_promotes`, are the two
 * most important lines in this repository.
 */
export async function migrateTestDb(sql: postgres.Sql): Promise<void> {
  await migrate(sql as unknown as Sql, MIGRATIONS, { service: 'beacon-test' })
}

/** Empty every table this service owns. `jobs` included, so a lease cannot leak between files. */
export async function resetBeacon(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`truncate ${[...TABLES, 'jobs'].join(', ')} restart identity cascade`)
}

/** Logs are discarded rather than silenced, so a serialisation failure still throws. */
export function quietLogger(): Logger {
  return new Logger({ service: 'beacon-test', sink: () => {} })
}

export function testMetrics(): Metrics {
  return registerServiceMetrics(new Metrics())
}

export const db = (sql: postgres.Sql): Sql => sql as unknown as Sql

/* ------------------------------------------------------------------ fixtures */

export const PROBE_DEFAULTS: Omit<ProbeSpec, 'name' | 'url'> = {
  target: 'ledger',
  productGroup: 'Wallet',
  method: 'GET',
  expectStatus: 200,
  intervalMs: 30_000,
  deadlineMs: 5_000,
  critical: true,
  enabled: true,
}

export async function seedProbe(
  sql: postgres.Sql,
  name: string,
  overrides: Partial<ProbeSpec> = {},
): Promise<Probe> {
  return upsertProbe(db(sql), {
    ...PROBE_DEFAULTS,
    name,
    url: `http://127.0.0.1:1/${name}`,
    ...overrides,
  })
}

/** A journey definition that does exactly what it is told, for testing the harness itself. */
export function fakeJourney(
  name: string,
  body: JourneyDefinition['run'],
  overrides: Partial<Omit<JourneyDefinition, 'name' | 'run'>> = {},
): JourneyDefinition {
  return {
    name,
    title: `the ${name} journey`,
    productGroup: 'Account',
    critical: true,
    run: body,
    ...overrides,
  }
}

export async function seedJourney(
  sql: postgres.Sql,
  definition: JourneyDefinition,
): Promise<void> {
  await syncRegistry(db(sql), [definition])
}

/** 99.5% — the Tier-2 default from 13-operational-model.md:429. */
export const TIER2_PPM = 995_000n
/** 99.95% — Tier 1, the money services. Twenty-one minutes over 28 days. */
export const TIER1_PPM = 999_500n
/** 100%, no budget. The ledger's trial balance. */
export const NO_BUDGET_PPM = PPM

export async function seedSlo(
  sql: postgres.Sql,
  name: string,
  objectivePpm: bigint,
  windowDays = 28,
): Promise<void> {
  await upsertSlo(db(sql), {
    name,
    service: name.split('.')[0] ?? name,
    tier: objectivePpm >= TIER1_PPM ? 1 : 2,
    kind: name.endsWith('.runs') ? 'journey' : 'availability',
    objectivePpm,
    windowDays,
    enabled: true,
  })
}

/* ------------------------------------------------------------------ a real HTTP target */

export interface FakeTarget {
  readonly baseUrl: string
  /** Every path that was requested. The probe tests assert on the length of this. */
  readonly hits: readonly string[]
  /** Answer with this status until told otherwise. */
  setStatus(status: number): void
  /**
   * Stop answering entirely.
   *
   * The socket is accepted and then nothing is written — which is what a wedged upstream actually
   * looks like, and is a genuinely different failure from a refused connection. A test that only
   * ever simulates ECONNREFUSED never exercises the deadline, and the deadline is the thing that
   * keeps one bad target from stalling the whole scheduler.
   */
  hang(value: boolean): void
  close(): Promise<void>
}

export async function fakeTarget(): Promise<FakeTarget> {
  const hits: string[] = []
  let status = 200
  let hanging = false
  const open = new Set<import('node:net').Socket>()

  const server: Server = createServer((req, res) => {
    hits.push(req.url ?? '/')
    if (hanging) return
    const payload = `${JSON.stringify({ ok: status < 400 })}\n`
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    res.end(payload)
  })
  server.on('connection', (socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    hits,
    setStatus(value) {
      status = value
    },
    hang(value) {
      hanging = value
    },
    close: () =>
      new Promise<void>((resolve) => {
        // A hung request holds its socket open, so `server.close()` alone would never call back
        // and the test file would sit there until the runner killed it.
        for (const socket of open) socket.destroy()
        server.close(() => resolve())
      }),
  }
}
