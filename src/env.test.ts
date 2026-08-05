/**
 * Configuration.
 *
 * `loadEnv` is pure over its source, so every failure path is testable without mutating the
 * process. The eager export in `env.ts` is what makes the service fail fast; these tests are what
 * make the failures specific.
 */

import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { describe, it } from 'node:test'

/**
 * GENERATED, NOT WRITTEN.
 *
 * The literal that used to sit here was `'a-real-looking-break-glass-token-value'` — a hyphenated
 * sentence describing itself, which is the exact family the estate's own
 * `estate-only-beacon-breakglass-000000000` belongs to. It cleared the old 24-character floor for
 * the same reason that placeholder did, which is to say for no reason at all.
 *
 * Regenerated per run rather than replaced with a better-looking literal, so a placeholder cannot
 * creep back in the next time somebody needs a fixture.
 */
const TOKEN = randomBytes(48).toString('base64')

/**
 * THIS FIXTURE CONTAINS HYPHENS ON PURPOSE, AND THAT IS THE MOST IMPORTANT THING ABOUT IT.
 *
 * A credential body is base64**url**, so `-` and `_` are in its alphabet. Measured on the running
 * estates: the mainnet credential is alphanumeric (`cloudsforge-estate-beacon-1`, 2026-08-05,
 * `cfsc_` + 43) and the testnet one CONTAINS A HYPHEN. So a "secrets have no hyphens" rule — which
 * is correct for a generated signing key, and which every placeholder this estate wrote would have
 * failed — passes mainnet and kills testnet at boot, on the one service whose death makes every
 * other outage invisible.
 *
 * Keeping a hyphenated credential here means that mistake fails CI instead of failing one estate in
 * production. Do not "tidy" the hyphens out of this value.
 */
const CREDENTIAL = 'cfsc_TToR-eOeVTDnqhX1-nu6-u7DoCr4MCfa86g4g6kd404'

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
  BEACON_TOKEN: TOKEN,
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

  /**
   * **THE VALUE THIS SERVICE IS RUNNING ON TODAY, PINNED AS A FAILURE.**
   *
   * `deploy/compose/docker-compose.estate.yml` carries
   * `BEACON_TOKEN: estate-only-beacon-breakglass-000000000` on two lines as a HARDCODED literal,
   * and the same string was measured inside `cloudsforge-estate-beacon-1` on 2026-08-05. It is 39
   * characters, so the 24-character floor this service used to apply could never fail for it —
   * which is micro-org #142, and it is why the floor is gone.
   *
   * Quoted here because it is an already-public defect value with no secrecy left to protect, and
   * because a test that names the exact string the estate shipped is the only kind that cannot be
   * satisfied by a rule that happens to catch something else.
   */
  it('REFUSES THE VALUE THE ESTATE IS RUNNING, which is the whole of this change', () => {
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_TOKEN: 'estate-only-beacon-breakglass-000000000' }),
      (err: unknown) =>
        err instanceof EnvError &&
        /BEACON_TOKEN/.test(err.message) &&
        /estateonly/.test(err.message) &&
        // The message names the marker it matched, never the value it matched it in: the fatal
        // handler writes this to stderr and the collector ships it onwards.
        !err.message.includes('estate-only-beacon-breakglass-000000000'),
    )
  })

  it('refuses a short token, and the message says how short', () => {
    // This assertion used to demand the message say "at least 24 characters" — the keystroke floor
    // that let a 39-character placeholder through. Pinning that wording made the test a DEFENCE of
    // the defective rule: any fix that stopped counting to 24 would fail CI, however much better
    // the new rule was. What it asserts now is the property that matters.
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_TOKEN: 'short' }),
      (err: unknown) =>
        err instanceof EnvError && /is 5 characters/.test(err.message) && /at least 16/.test(err.message),
    )
  })

  it('refuses a long, well-formed, DEGENERATE token', () => {
    // Long enough for any keystroke floor and carrying zero bits of entropy, because every
    // character is the same one. This is the half of the old rule that was wrong even for values
    // nobody would call a placeholder.
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_TOKEN: 'a'.repeat(40) }),
      (err: unknown) => err instanceof EnvError && /entropy/.test(err.message),
    )
  })

  /**
   * An operator's own value is accepted, and that is deliberate.
   *
   * `BEACON_TOKEN` is checked BEFORE the identity bearer so the gate stays readable when identity
   * is the thing that has broken, which means it is a value a person transcribes during an
   * incident. It is therefore held to `assertOpaqueSecret` rather than to the estate's
   * base64-or-hex rule — a guard that refused a working hand-set value would be a guard somebody
   * removes, and the marker check that catches the real defect above is identical under both rules.
   */
  it('accepts a hand-set value whose alphabet the estate does not control', () => {
    const typed = 'Zq7!vX#4mT$8kW%2nR&6'
    assert.equal(loadEnv({ ...BASE, BEACON_TOKEN: typed }).token, typed)
  })
})

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * BEACON_SERVICE_CREDENTIAL — the OTHER kind of secret, and the names do not say which is which.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

describe('the service credential', () => {
  it('is ABSENT by default, and absence is a supported mode rather than a throw', () => {
    // Compose interpolates `${BEACON_IDENTITY_CREDENTIAL:-}`, so an ungranted deployment hands this
    // process the empty string. The journeys that need a scoped token are then not declared at all.
    // Turning that into exit(1) would take down the service that reports every other outage.
    assert.equal(loadEnv(BASE).serviceCredential, '')
    assert.equal(loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: '' }).serviceCredential, '')
    assert.equal(loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: '   ' }).serviceCredential, '')
  })

  it('accepts a real credential, INCLUDING A HYPHENATED ONE', () => {
    // The hyphen is the point. See the comment on CREDENTIAL: mainnet's is alphanumeric and
    // testnet's is not, so a "no hyphens" rule boots one estate and kills the other.
    assert.equal(loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: CREDENTIAL }).serviceCredential, CREDENTIAL)
  })

  it('refuses a value that is present and is not a credential', () => {
    // Absent is a deployment nobody has granted one to. A short or malformed one is a deployment
    // that BELIEVES it has a credential, and it fails at the exchange with a 401 that reads as
    // "identity rejected beacon" rather than "nobody set this variable".
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: 'cfsc_short' }),
      (err: unknown) => err instanceof EnvError && /BEACON_SERVICE_CREDENTIAL/.test(err.message),
    )
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: TOKEN }),
      (err: unknown) => err instanceof EnvError && /cfsc_/.test(err.message),
    )
  })

  it('refuses a JWT BY NAME — the ten-minute cliff wearing the fix’s clothes', () => {
    // `ecosystem.ts` EXCHANGES this value for a short-lived token. An injected 600-second JWT here
    // looks configured, works for ten minutes, and then answers 401 for ever with nothing re-minting
    // it. micro-org #197/#222: that is how the settlement container spent a day unhealthy.
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${randomBytes(64).toString('base64url')}.${randomBytes(64).toString('base64url')}`
    assert.throws(
      () => loadEnv({ ...BASE, BEACON_SERVICE_CREDENTIAL: jwt }),
      (err: unknown) => err instanceof EnvError && /micro-org#197/.test(err.message),
    )
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
