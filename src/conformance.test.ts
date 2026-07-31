/**
 * Conformance runs.
 *
 * The property under test is the one the constraints exist for: **there is no path that produces a
 * green row without having run something.** A suite that has not executed for a month must not
 * read as a suite that has been green for a month.
 */

import assert from 'node:assert/strict'
import { after, before, beforeEach, describe, it } from 'node:test'
import type postgres from 'postgres'
import {
  conformanceHistory,
  latestConformance,
  recordConformanceRun,
  statusFor,
} from './conformance.ts'
import { db, migrateTestDb, openDb, resetBeacon, skip } from './testsupport.ts'

describe('the status is derived from the counts', () => {
  it('passes when everything matched', () => {
    assert.equal(statusFor({ identical: 60, benign: 0, breaking: 0 }), 'pass')
  })

  it('passes on benign differences alone', () => {
    // Adding a field is benign and removing one is breaking. Exiting non-zero on benign
    // differences would fire on every routine release, and a gate that fires on every release
    // gets removed.
    assert.equal(statusFor({ identical: 58, benign: 2, breaking: 0 }), 'pass')
  })

  it('FAILS on a single breaking difference', () => {
    assert.equal(statusFor({ identical: 59, benign: 0, breaking: 1 }), 'fail')
  })

  it('SKIPS when nothing was compared', () => {
    // Never `pass`. A suite that could not be run has demonstrated nothing.
    assert.equal(statusFor({ identical: 0, benign: 0, breaking: 0 }), 'skip')
  })

  it('prefers fail over skip when a breaking difference was found in a partial run', () => {
    assert.equal(statusFor({ identical: 0, benign: 0, breaking: 3 }), 'fail')
  })
})

describe('conformance runs', { skip }, () => {
  let sql: postgres.Sql

  before(async () => {
    sql = openDb()
    await migrateTestDb(sql)
  })
  beforeEach(async () => {
    await resetBeacon(sql)
  })
  after(async () => {
    await sql.end({ timeout: 5 })
  })

  it('records one', async () => {
    const run = await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'pass',
      identical: 58,
      benign: 2,
    })
    assert.equal(run.suite, 'wallet')
    assert.equal(run.breaking, 0)
  })

  it('THE DATABASE REFUSES A PASS THAT COMPARED NOTHING', async () => {
    await assert.rejects(() =>
      recordConformanceRun(db(sql), { suite: 'wallet', status: 'pass', identical: 0, benign: 0 }),
    )
  })

  it('THE DATABASE REFUSES A PASS ALONGSIDE A BREAKING DIFFERENCE', async () => {
    await assert.rejects(() =>
      recordConformanceRun(db(sql), {
        suite: 'wallet',
        status: 'pass',
        identical: 58,
        breaking: 1,
      }),
    )
  })

  it('permits a skip that compared nothing', async () => {
    const run = await recordConformanceRun(db(sql), { suite: 'wallet', status: 'skip' })
    assert.equal(run.status, 'skip')
  })

  it('refuses an unknown status', async () => {
    await assert.rejects(async () => {
      await sql`insert into conformance_runs (suite, status) values ('wallet', 'green')`
    })
  })

  it('reports the newest run of each suite', async () => {
    await recordConformanceRun(db(sql), { suite: 'wallet', status: 'pass', identical: 58 })
    await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'fail',
      identical: 57,
      breaking: 1,
    })
    await recordConformanceRun(db(sql), { suite: 'identity', status: 'pass', identical: 12 })
    const latest = await latestConformance(db(sql))
    assert.equal(latest.length, 2)
    assert.equal(latest.find((run) => run.suite === 'wallet')?.status, 'fail')
  })

  it('keeps the whole history', async () => {
    for (let i = 0; i < 4; i++) {
      await recordConformanceRun(db(sql), { suite: 'wallet', status: 'pass', identical: 58 })
    }
    assert.equal((await conformanceHistory(db(sql), 'wallet')).length, 4)
  })

  it('filters history by suite', async () => {
    await recordConformanceRun(db(sql), { suite: 'wallet', status: 'pass', identical: 58 })
    await recordConformanceRun(db(sql), { suite: 'identity', status: 'pass', identical: 12 })
    assert.equal((await conformanceHistory(db(sql), 'identity')).length, 1)
    assert.equal((await conformanceHistory(db(sql), null)).length, 2)
  })

  it('carries the release tag and the corpus reference it was compared against', async () => {
    const run = await recordConformanceRun(db(sql), {
      suite: 'wallet',
      status: 'pass',
      identical: 58,
      releaseTag: 'v1.4.2',
      corpusRef: 'corpus@9f2c1',
    })
    assert.equal(run.releaseTag, 'v1.4.2')
    assert.equal(run.corpusRef, 'corpus@9f2c1')
  })
})
