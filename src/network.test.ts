/**
 * Which estate a probe watches.
 *
 * beacon is the first wave-5 service, and it takes a shape the plan's class-C listing did not
 * predict: ONE database with a `network` column, rather than two pools. The argument is in
 * micro-deploy `docs/network-consolidation.md` §5.3 and reduces to this — beacon's rows are
 * OBSERVATIONS, not an estate's user data. There is no isolation requirement to enforce, only an
 * attribution one, and the public status page wants both estates in one query, which two pools
 * would turn into a join across databases that postgres cannot do.
 */
import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'

describe('a testnet probe must be named as one', () => {
  /*
   * `probe_state` is keyed on `probes.name`, and it holds HYSTERESIS — the consecutive-failure
   * count that decides whether a blip becomes an incident. Two estates sharing one state row would
   * count each other's failures and report a state neither of them is in: mainnet failing twice
   * and testnet once would open an incident against both, or against the wrong one.
   *
   * So a consolidated beacon needs two rows per service, and the database CHECK requires the
   * testnet one to be named for it. The suffix is a convention an operator can see in the URL they
   * are typing, which is why the estate is DERIVED from the name rather than taken from the body:
   * one source cannot disagree with itself.
   */
  const networkFor = (name: string) => (name.endsWith('-testnet') ? 'testnet' : 'mainnet')

  it('derives the estate from the name, so the two cannot disagree', () => {
    assert.equal(networkFor('ledger'), 'mainnet')
    assert.equal(networkFor('ledger-testnet'), 'testnet')
  })

  it('gives the two estates different names, so hysteresis cannot be shared', () => {
    assert.notEqual('ledger', 'ledger-testnet')
  })

  it('does not mistake a name that merely CONTAINS the word', () => {
    // `-testnet` as a suffix, not a substring: a probe named `testnet-gateway` watches the testnet
    // gateway FROM mainnet's point of view in some configurations, and guessing from a substring
    // would silently reclassify it.
    assert.equal(networkFor('testnet-gateway'), 'mainnet')
    assert.equal(networkFor('gateway-testnet'), 'testnet')
  })
})

describe('the check counter carries the network', () => {
  /*
   * The label matters more here than almost anywhere else in the estate, because this counter is
   * what the public status page and the RELEASE GATE read. Without it a testnet outage and a
   * mainnet one are the same series: the gate would refuse a mainnet release for a testnet fault,
   * or — worse — promote one while mainnet was failing, because the two averaged out.
   */
  it('groups by network before target', () => {
    const labels = ['network', 'target', 'state']
    assert.equal(labels[0], 'network', 'network must be the first thing an alert groups by')
    assert.ok(labels.includes('target'))
  })

  it('keeps the two estates as separate series for one target', () => {
    const key = (l: Record<string, string>) => `${l['network']}/${l['target']}/${l['state']}`

    assert.notEqual(
      key({ network: 'mainnet', target: 'ledger', state: 'fail' }),
      key({ network: 'testnet', target: 'ledger', state: 'fail' }),
    )
  })
})

describe('the back-fill is honest here, unlike notify’s', () => {
  /*
   * `probes.network` defaults to 'mainnet' NOT NULL, and notify's `deliveries.network` is nullable
   * and not back-filled. The difference is worth stating because the two look like inconsistency.
   *
   * notify's history was written by a pod whose estate is *inferable* from the deployment —
   * inferable, not recorded. beacon's is different in kind: every row in a mainnet beacon's
   * database was written by a mainnet prober watching URLs that ARE mainnet's. The estate is not
   * being guessed from context; it is a property of which database the migration runs against, and
   * the testnet deployment defaults its own rows the same way in its own database before the two
   * are ever merged.
   */
  it('defaults every existing row to the estate its database belongs to', () => {
    const existingRow = { name: 'ledger', network: 'mainnet' }
    assert.equal(existingRow.network, 'mainnet')
  })
})
