/**
 * The schema.
 *
 * The migrator is exercised as a migrator, on an empty database, exactly as a deploy runs it. A
 * schema created by the test suite instead would never prove the one-shot job works — and the
 * controls this repository turns on are CHECK constraints and a partial unique index that only
 * exist because that job ran.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import type postgres from 'postgres'
import { assertSchemaAtLeast, checksumOf, type Sql } from '@cloudsforge/db'
import { BASELINE_VERSION, MIGRATIONS, SCHEMA_VERSION, TABLES } from './migrations.ts'
import { migrateTestDb, openDb, skip } from './testsupport.ts'

describe('the migration list', () => {
  it('is numbered from one with no gaps', () => {
    assert.deepEqual(
      MIGRATIONS.map((migration) => migration.version),
      MIGRATIONS.map((_migration, index) => index + 1),
    )
  })

  it('names every migration', () => {
    for (const migration of MIGRATIONS) assert.ok(migration.name.length > 0)
  })

  it('has no duplicate names', () => {
    const names = MIGRATIONS.map((migration) => migration.name)
    assert.equal(new Set(names).size, names.length)
  })

  it('reports the version the service asserts', () => {
    assert.equal(SCHEMA_VERSION, MIGRATIONS.length)
  })

  it('baselines at zero, because this service is new', () => {
    assert.equal(BASELINE_VERSION, 0)
  })

  it('gives every migration a stable checksum', () => {
    // The migrator refuses to run when an APPLIED migration's text has changed — "add a new
    // migration instead of editing a released one". This asserts the mechanism is reachable.
    for (const migration of MIGRATIONS) assert.match(checksumOf(migration), /^[0-9a-f]{8}$/)
  })

  it('lists every owned table for the truncating harness', () => {
    // A table missing here is a table that leaks rows between test files, which produces a
    // failure in whichever file happens to run second.
    assert.ok(TABLES.includes('gate_decisions'))
    assert.ok(TABLES.includes('slo_observations'))
    assert.ok(TABLES.includes('probe_state'))
  })
})

describe('the schema as the migrator leaves it', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  it('satisfies the version the service asserts at boot', async () => {
    await assert.doesNotReject(() => assertSchemaAtLeast(sql as unknown as Sql, SCHEMA_VERSION))
  })

  it('refuses a version above what has been applied', async () => {
    await assert.rejects(() => assertSchemaAtLeast(sql as unknown as Sql, SCHEMA_VERSION + 1))
  })

  it('creates every table this service owns', async () => {
    const rows = (await sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `) as unknown as { table_name: string }[]
    const present = new Set(rows.map((row) => row.table_name))
    for (const table of TABLES) assert.ok(present.has(table), `${table} is missing`)
    assert.ok(present.has('jobs'))
  })

  it('CREATES THE PARTIAL UNIQUE INDEX THAT DEDUPES INCIDENTS', async () => {
    // Without it an outage opens one incident per probe cycle. `index.ts` asserts the schema
    // version rather than creating this, so a replica below version 4 refuses to serve.
    const rows = (await sql`
      select indexdef from pg_indexes where indexname = 'incidents_open_uniq'
    `) as unknown as { indexdef: string }[]
    assert.equal(rows.length, 1)
    assert.match(rows[0]?.indexdef ?? '', /WHERE \(closed_at IS NULL\)/i)
  })

  it('CREATES THE CHECK THAT STOPS AN INDETERMINATE GATE FROM PROMOTING', async () => {
    const rows = (await sql`
      select conname from pg_constraint
       where conname = 'gate_decisions_indeterminate_never_promotes'
    `) as unknown as { conname: string }[]
    assert.equal(rows.length, 1)
  })

  it('creates the check that stops a green conformance row with nothing behind it', async () => {
    const rows = (await sql`
      select conname from pg_constraint
       where conname in ('conformance_runs_pass_ran_something',
                         'conformance_runs_pass_has_no_breaking')
    `) as unknown as { conname: string }[]
    assert.equal(rows.length, 2)
  })

  it('creates the check that keeps a mute attributed', async () => {
    const rows = (await sql`
      select conname from pg_constraint where conname = 'journeys_mute_is_attributed'
    `) as unknown as { conname: string }[]
    assert.equal(rows.length, 1)
  })

  it('creates the check that keeps a probe deadline below its interval', async () => {
    const rows = (await sql`
      select conname from pg_constraint where conname = 'probes_deadline_below_interval'
    `) as unknown as { conname: string }[]
    assert.equal(rows.length, 1)
  })

  it('creates the check that keeps an SLO objective within one million ppm', async () => {
    const rows = (await sql`
      select conname from pg_constraint where conname = 'slos_objective_range'
    `) as unknown as { conname: string }[]
    assert.equal(rows.length, 1)
  })

  it('leaves probe_state.updated_at nullable, so a new probe is due at once', async () => {
    const rows = (await sql`
      select is_nullable from information_schema.columns
       where table_name = 'probe_state' and column_name = 'updated_at'
    `) as unknown as { is_nullable: string }[]
    assert.equal(rows[0]?.is_nullable, 'YES')
  })

  it('stores SLO counts as bigint, not as integer', async () => {
    // A 28-day window at one observation per check per probe passes 2^31 in a large estate, and
    // an integer that silently wrapped would produce a budget that read healthy.
    const rows = (await sql`
      select data_type from information_schema.columns
       where table_name = 'slo_observations' and column_name = 'total'
    `) as unknown as { data_type: string }[]
    assert.equal(rows[0]?.data_type, 'bigint')
  })

  it('is idempotent — a second run applies nothing', async () => {
    await assert.doesNotReject(() => migrateTestDb(sql))
  })
})
