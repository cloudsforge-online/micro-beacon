/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

/**
 * A valid environment, applied to the process BEFORE `./env.ts` is imported.
 *
 * The import itself is a test: `env.ts` validates eagerly and calls `process.exit(1)` on a bad
 * configuration, so if these values were not sufficient this file would not run at all.
 */
const BASE: Record<string, string> = {
  BEACON_DATABASE_URL: 'postgres://beacon:beacon@127.0.0.1:5432/beacon',
  IDENTITY_JWKS_URL: 'http://127.0.0.1:4001/.well-known/jwks.json',
  IDENTITY_ISSUER: 'http://127.0.0.1:4001',
  BEACON_TOKEN: 'a-real-looking-break-glass-token-value',
}
for (const [key, value] of Object.entries(BASE)) process.env[key] = value

const { EnvError, SERVICE, env, loadEnv, parseTargets } = await import('./env.ts')

describe('the service names itself', () => {
  it('is a constant, not a variable', () => {
    // Making it configurable is how two services end up sharing a migration advisory lock.
    assert.equal(SERVICE, 'beacon')
  })
})

describe('required variables', () => {
  it('loads a valid environment', () => {
    const loaded = loadEnv(BASE)
    assert.equal(loaded.databaseUrl, BASE['BEACON_DATABASE_URL'])
    assert.equal(loaded.port, 4011)
  })

  it('names the missing database url', () => {
    const { BEACON_DATABASE_URL: _omitted, ...rest } = BASE
    assert.throws(() => loadEnv(rest), (err: unknown) => {
      assert.ok(err instanceof EnvError)
      assert.match(err.message, /BEACON_DATABASE_URL/)
      return true
    })
  })

  it('names the missing jwks url', () => {
    const { IDENTITY_JWKS_URL: _omitted, ...rest } = BASE
    assert.throws(() => loadEnv(rest), /IDENTITY_JWKS_URL/)
  })

  it('REQUIRES THE SCRAPE CREDENTIAL', () => {
    // The frozen service defaults it to '' and therefore ships an unauthenticated-by-accident
    // endpoint the moment somebody flips a check.
    const { BEACON_TOKEN: _omitted, ...rest } = BASE
    assert.throws(() => loadEnv(rest), /BEACON_TOKEN/)
  })

  it('refuses a placeholder token', () => {
    assert.throws(() => loadEnv({ ...BASE, BEACON_TOKEN: 'changeme' }), /placeholder/)
  })

  it('refuses a short token', () => {
    assert.throws(() => loadEnv({ ...BASE, BEACON_TOKEN: 'short' }), /at least 24 characters/)
  })
})

describe('numbers are validated, not coerced', () => {
  it('refuses a non-numeric port', () => {
    assert.throws(() => loadEnv({ ...BASE, PORT: 'eleven' }), /PORT must be a whole number/)
  })

  it('refuses a port outside the range', () => {
    assert.throws(() => loadEnv({ ...BASE, PORT: '70000' }), /PORT/)
  })

  it('refuses an unknown log level', () => {
    assert.throws(() => loadEnv({ ...BASE, LOG_LEVEL: 'chatty' }), /LOG_LEVEL/)
  })

  it('REFUSES A PROBE DEADLINE AT OR ABOVE ITS CADENCE', () => {
    // A deadline at or above the interval lets one attempt still be running when the next is due,
    // and the schedule stretches past its own period exactly when the network goes bad.
    assert.throws(
      () =>
        loadEnv({ ...BASE, BEACON_PROBE_DEADLINE_MS: '30000', BEACON_PROBE_INTERVAL_MS: '30000' }),
      /must be below/,
    )
  })

  it('accepts a deadline below its cadence', () => {
    const loaded = loadEnv({
      ...BASE,
      BEACON_PROBE_DEADLINE_MS: '2000',
      BEACON_PROBE_INTERVAL_MS: '10000',
    })
    assert.equal(loaded.probeDeadlineMs, 2_000)
  })

  it('derives the gate freshness horizon from the journey cadence', () => {
    const loaded = loadEnv({ ...BASE, BEACON_JOURNEY_INTERVAL_MS: '120000' })
    // Four intervals: one missed run is tolerated, two are not.
    assert.equal(loaded.gateFreshnessMs, 480_000)
  })

  it('lets the freshness horizon be set explicitly', () => {
    assert.equal(loadEnv({ ...BASE, BEACON_GATE_FRESHNESS_MS: '900000' }).gateFreshnessMs, 900_000)
  })

  it('requires three consecutive green runs by default', () => {
    assert.equal(loadEnv(BASE).gateConsecutiveGreen, 3)
  })

  it('keeps a 28-day SLO window by default', () => {
    assert.equal(loadEnv(BASE).sloWindowDays, 28)
  })

  it('keeps the 400-day rollup retention AD-20 refers to', () => {
    // This is the number the 400-day figure actually describes: Beacon's own rollups, not
    // Prometheus, which cannot downsample.
    assert.equal(loadEnv(BASE).rollupRetentionDays, 400)
  })
})

describe('booleans', () => {
  it('defaults the public status page to OFF', () => {
    // "Public" is a decision.
    assert.equal(loadEnv(BASE).publicStatus, false)
  })

  it('accepts true and 1', () => {
    assert.equal(loadEnv({ ...BASE, BEACON_PUBLIC_STATUS: 'true' }).publicStatus, true)
    assert.equal(loadEnv({ ...BASE, BEACON_PUBLIC_STATUS: '1' }).publicStatus, true)
  })

  it('refuses anything else', () => {
    assert.throws(() => loadEnv({ ...BASE, BEACON_PUBLIC_STATUS: 'yes' }), /must be true or false/)
  })
})

describe('BEACON_TARGETS replaces the frozen service\'s twenty URL variables', () => {
  it('parses an empty list', () => {
    assert.equal(parseTargets('').size, 0)
  })

  it('parses one pair', () => {
    assert.equal(parseTargets('identity=http://identity:4001').get('identity'), 'http://identity:4001')
  })

  it('parses several', () => {
    const parsed = parseTargets('identity=http://identity:4001, ledger=http://ledger:4004')
    assert.deepEqual([...parsed.keys()], ['identity', 'ledger'])
  })

  it('strips a trailing slash so a journey never builds a double slash', () => {
    assert.equal(parseTargets('identity=http://identity:4001/').get('identity'), 'http://identity:4001')
  })

  it('REFUSES an entry that is not name=url', () => {
    // A typo that silently produced a target named "pay=http://pay" would probe nothing and
    // report green, and a monitor that reports green because it was misconfigured is worse than
    // no monitor: it is a monitor that has been believed.
    assert.throws(() => parseTargets('identity'), /not name=url/)
  })

  it('refuses a name that is not kebab-case', () => {
    assert.throws(() => parseTargets('Identity=http://x'), /kebab-case/)
  })

  it('refuses a url that is not http', () => {
    assert.throws(() => parseTargets('identity=identity:4001'), /http\(s\) URL/)
  })

  it('refuses a duplicated name', () => {
    assert.throws(() => parseTargets('a=http://x,a=http://y'), /twice/)
  })

  it('is read into the environment', () => {
    const loaded = loadEnv({ ...BASE, BEACON_TARGETS: 'identity=http://identity:4001' })
    assert.equal(loaded.targets.get('identity'), 'http://identity:4001')
  })
})

describe('the eagerly loaded environment', () => {
  it('exists, which means the import above did not exit', () => {
    assert.equal(env.port, 4011)
  })
})
