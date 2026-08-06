/**
 * What the estate actually holds — read from the ledger and from the chain, never from the page.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A JOURNEY THAT CLICKS SEND AND ASSERTS A TOAST APPEARED HAS PROVED NOTHING.**
 *
 * `smoke.ts` established that a suite which answers its own requests cannot see the API is down.
 * This file is the other half of the same argument: a suite that only reads the DOM cannot see
 * that the money did not move. The estate has a real Postgres behind `micro-ledger` and a real
 * chain at id 7412 with the owner's miner on it, so the assertions read those.
 *
 * Two oracles, and each is deliberately the record rather than a copy of it:
 *
 *   * **The ledger**, through `GET /accounts/:subject/balances` and `GET /trial-balance` — the
 *     service of record for every internal balance, and the one whose schema carries the deferred
 *     constraint that refuses an unbalanced journal. `deploy/scripts/estate-verify.sh`
 *     already drives both routes with a service token; this is the same seam from the browser tier.
 *   * **The chain**, through `eth_call` — for Foresight, where the pool is in the contract and the
 *     mirror is explicitly allowed to be wrong. `foresight-web/src/lib/abi.ts` says so in as many
 *     words: "when the two disagree, `claim.ts` believes the chain". So does this file, and a page
 *     rendering the mirror's number where the contract holds another is a defect this catches and
 *     nothing else in the estate does.
 *
 * ── EVERY QUANTITY IS A `bigint`, AND THE REASON IS A DEFECT THIS ESTATE KEEPS FINDING ─────────
 *
 * `BigInt('')` is `0n`. So is `BigInt('0x')`, which is what `eth_call` answers for an address that
 * holds no code, and `BigInt(null as never)` throws where `Number(null)` would have been 0. A
 * balance that is UNKNOWN and a balance that is ZERO must never arrive at an assertion as the same
 * value, so every read below answers `bigint | null` and every parse refuses an empty string by
 * name. `micro-wallet/src/pricingclient.ts` states the rule for prices — "a zero would be a
 * valuation, and a valuation of zero is a lie about a holding that exists" — and it is the same
 * rule for balances.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { wait, waitMsFor } from './backoff.ts'
import { keccak256, selector, toHex } from './keccak.ts'

/** Re-exported through one object so `toHexOfSignature` reads as the whole-digest sibling of `selector`. */
const keccakModule = { keccak256, toHex }

/* ------------------------------------------------------------------ parsing money */

export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * A decimal integer string as a `bigint`, refusing everything `BigInt()` silently accepts.
 *
 * `BigInt('')` is `0n` and `BigInt(' 12 ')` is `12n`. Both are how a missing field becomes a
 * balance nobody questions. Digits only, and a leading `-` for a debit-side figure.
 */
export function money(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) {
    throw new MoneyError(
      `${what} is not a decimal integer string (got ${JSON.stringify(value)}) — refusing to ` +
        'coerce it, because BigInt("") is 0n and a missing amount must never read as a zero one',
    )
  }
  return BigInt(value)
}

/** The same, but `null` for an absent field rather than a throw. Never `0n` for absent. */
export function moneyOrNull(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^-?[0-9]+$/.test(value)) return null
  return BigInt(value)
}

/* ------------------------------------------------------------------ the ledger */

export interface LedgerAccess {
  /** `micro-ledger`'s base URL, as `BEACON_TARGETS` resolves `ledger`. */
  readonly base: string
  /** A service token carrying `ledger:read` (and `ledger:post` for the seeding calls). */
  readonly token: string
  readonly signal?: AbortSignal
}

async function ledgerJson(access: LedgerAccess, path: string): Promise<unknown> {
  const response = await fetch(`${access.base.replace(/\/+$/, '')}${path}`, {
    headers: { authorization: `Bearer ${access.token}`, accept: 'application/json' },
    ...(access.signal ? { signal: access.signal } : {}),
  })
  if (!response.ok) {
    throw new MoneyError(`GET ${path} on the ledger answered HTTP ${response.status}`)
  }
  return await response.json()
}

/**
 * Every balance a subject holds, by asset code, in the asset's smallest units.
 *
 * The subject form is the ledger's own: `user:<uuid>`, `custody`, `engagement:market`. Purposes
 * are SUMMED per asset — `available` and `reserved` are two rows of one holding, and a browser
 * showing "you hold X" is showing the sum. A caller that wants them apart reads `balanceRows`.
 */
export async function ledgerBalances(
  access: LedgerAccess,
  subject: string,
): Promise<ReadonlyMap<string, bigint>> {
  const out = new Map<string, bigint>()
  for (const row of await balanceRows(access, subject)) {
    out.set(row.assetCode, (out.get(row.assetCode) ?? 0n) + row.amount)
  }
  return out
}

export interface BalanceRow {
  readonly assetCode: string
  readonly purpose: string
  readonly amount: bigint
}

export async function balanceRows(
  access: LedgerAccess,
  subject: string,
): Promise<readonly BalanceRow[]> {
  const body = (await ledgerJson(access, `/accounts/${encodeURIComponent(subject)}/balances`)) as {
    balances?: readonly Record<string, unknown>[]
  }
  const rows = body.balances ?? []
  return rows.map((row) => ({
    assetCode: String(row['assetCode'] ?? ''),
    purpose: String(row['purpose'] ?? ''),
    amount: money(row['amount'], `ledger balance for ${subject}`),
  }))
}

/**
 * Do the books balance?
 *
 * Asserted alongside every journey that moves money, because a page can be right about a balance
 * while the journal behind it is not — and an unbalanced ledger is money invented. It is the
 * assertion `estate-verify.sh` calls "the estate's strongest", made from the browser tier so that
 * a UI flow which posts a half-entry is caught by the same control.
 */
export async function trialBalanceBalanced(access: LedgerAccess): Promise<boolean> {
  const body = (await ledgerJson(access, '/trial-balance')) as { balanced?: unknown }
  return body.balanced === true
}

/* ------------------------------------------------------------------ seeding, over HTTP */

export interface Identity {
  readonly base: string
  readonly signal?: AbortSignal
}

/**
 * Mint a service token, exactly as `estate-verify.sh` does.
 *
 * An ordinary account cannot do this and identity answers 403 — which is the gap that script
 * already records. The credential used here is the estate operator's, supplied by configuration,
 * and the token it returns lives 600 seconds (`identity/src/tokens.ts`). That TTL is doc 22
 * §4.1's ten-minute cliff, and it is why every journey mints its own rather than sharing one: a
 * shard that runs eight minutes would otherwise hand its last journey an expired credential and
 * report the product broken.
 */
export async function mintServiceToken(
  identity: Identity,
  operatorToken: string,
  service: string,
  scopes: readonly string[],
): Promise<string> {
  const response = await fetch(`${identity.base.replace(/\/+$/, '')}/service-tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ service, scopes }),
    ...(identity.signal ? { signal: identity.signal } : {}),
  })
  if (!response.ok) {
    throw new MoneyError(
      `identity refused to mint a ${service} token carrying ${scopes.join(', ')} ` +
        `(HTTP ${response.status}) — this is the journey's fixture, not the product`,
    )
  }
  const body = (await response.json()) as { token?: unknown }
  if (typeof body.token !== 'string' || body.token === '') {
    throw new MoneyError('identity answered 200 with no token')
  }
  return body.token
}

/** Sign in over HTTP and return the access token. identity's field is `identifier`, not `email`. */
export async function signInForToken(
  identity: Identity,
  identifier: string,
  password: string,
): Promise<string> {
  // ── THE LOGIN LIMITER IS REAL, AND WAITING FOR IT IS NOT DEFEATING IT ────────────────────────
  //
  // identity caps `/auth/login` at ten per window (`identity/src/server.ts`), taken at dispatch
  // so a refusal costs what a success does. A shard of six money journeys signs the operator in
  // once each to mint a service token, and will reach it. Honouring the `retry-after` the service
  // itself names — a bounded number of times, and still an error when exhausted — is the difference
  // between a harness that waits its turn and one that reports the product broken because it was
  // throttled.
  let response: Response | null = null
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(`${identity.base.replace(/\/+$/, '')}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password }),
      ...(identity.signal ? { signal: identity.signal } : {}),
    })
    if (response.status !== 429) break
    await response.arrayBuffer()
    await wait(waitMsFor(response.headers.get('retry-after')), identity.signal)
  }
  if (response === null || !response.ok) {
    throw new MoneyError(
      `identity refused the operator credential (HTTP ${response?.status ?? 'no response'}) — set ` +
        'BEACON_ESTATE_OPERATOR / _PASSWORD to an account that can mint service tokens',
    )
  }
  const body = (await response.json()) as { accessToken?: unknown }
  if (typeof body.accessToken !== 'string' || body.accessToken === '') {
    throw new MoneyError('identity answered 200 with no access token')
  }
  return body.accessToken
}

/** The id identity holds for the account this token belongs to. The ledger's subject, after `user:`. */
export async function subjectOf(identity: Identity, userToken: string): Promise<string> {
  const response = await fetch(`${identity.base.replace(/\/+$/, '')}/auth/me`, {
    headers: { authorization: `Bearer ${userToken}`, accept: 'application/json' },
    ...(identity.signal ? { signal: identity.signal } : {}),
  })
  if (!response.ok) throw new MoneyError(`identity /auth/me answered HTTP ${response.status}`)
  const body = (await response.json()) as { user?: { id?: unknown } }
  const id = body.user?.id
  if (typeof id !== 'string' || id === '') throw new MoneyError('identity /auth/me returned no id')
  return id
}

/**
 * Credit a subject with real money, as a real balanced double entry.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE FIXTURE IS A REAL POSTING, NOT A ROW INSERTED BEHIND THE SERVICE'S BACK.**
 *
 * Two postings, Σ debits = Σ credits: custody gains the asset, the account gains a liability claim
 * on it. That is the shape `estate-verify.sh` posts and the shape a deposit actually takes, so a
 * journey seeded this way is asserting against a balance the estate produced through its own
 * arithmetic. Writing the row with SQL would seed a state the service could never reach, and every
 * assertion downstream would be about a fiction.
 *
 * The idempotency key carries the run id, so a retried journey credits once and a second replica
 * cannot collide with the first — ledger answers 200 on a replay rather than posting twice.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function creditSubject(
  access: LedgerAccess,
  options: {
    readonly subject: string
    readonly assetCode: string
    readonly amount: bigint
    readonly idempotencyKey: string
  },
): Promise<string> {
  if (options.amount <= 0n) throw new MoneyError('a credit fixture must be a positive amount')
  const amount = options.amount.toString()
  const body = {
    kind: 'deposit_credited',
    originatingService: 'wallet',
    actor: 'service:wallet',
    idempotencyKey: options.idempotencyKey,
    description: 'beacon browser journey fixture',
    postings: [
      {
        direction: 'debit',
        amount,
        assetCode: options.assetCode,
        sequence: 0,
        account: {
          subject: 'custody',
          assetCode: options.assetCode,
          purpose: 'available',
          type: 'asset',
        },
      },
      {
        direction: 'credit',
        amount,
        assetCode: options.assetCode,
        sequence: 1,
        account: {
          subject: options.subject,
          assetCode: options.assetCode,
          purpose: 'available',
          type: 'liability',
        },
      },
    ],
  }
  const response = await fetch(`${access.base.replace(/\/+$/, '')}/entries`, {
    method: 'POST',
    headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(access.signal ? { signal: access.signal } : {}),
  })
  // 201 on the first post, 200 on a replay of the same key. Anything else is the fixture failing,
  // which is an `error` for the caller rather than a `fail` — see `journeys.ts` rule 1.
  if (response.status !== 201 && response.status !== 200) {
    throw new MoneyError(
      `the ledger refused the fixture posting (HTTP ${response.status}) — ` +
        `${(await response.text()).slice(0, 200)}`,
    )
  }
  // The id is RETURNED, not discarded, because the caller is required to reverse it. See
  // `reverseEntry` and the header of `fundAccount`.
  const created = (await response.json()) as { entry?: { id?: unknown }; id?: unknown }
  const id = created.entry?.id ?? created.id
  if (typeof id !== 'string' || id === '') {
    throw new MoneyError(
      'the ledger accepted the fixture posting and returned no entry id, so the fixture cannot ' +
        'reverse itself and would leave a liability behind. Refusing to continue',
    )
  }
  return id
}

/**
 * Reverse an entry this run posted, by writing a NEW entry that undoes it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FIXTURE THAT MOVES MONEY AND DOES NOT PUT IT BACK IS NOT A FIXTURE. IT IS A DEPOSIT.**
 *
 * This is not a hypothetical. An earlier version of this file credited EMBER per run and never
 * reversed it. Seventy fixture entries accumulated, twenty-one of them EMBER, and reconciliation
 * measured the result exactly: custody 135321000000000000000 wei against 31000000000000000000
 * observed on chain 7412, drift 104321000000000000000, `drift_exceeded` — and it FROZE EMBER
 * estate-wide, refusing every withdrawal.
 *
 * The freeze was correct and is the guarantee the whole chain-backing design exists for: something
 * credited a deposit that never happened and the ledger refused to agree with itself within two
 * minutes. An entry in a double-entry ledger is indistinguishable from a real deposit BY DESIGN,
 * which is the entire point of it, so a test tier that posts one has created money.
 *
 * `POST /entries/:id/reverse` writes a new, balanced, opposite entry and never edits the original —
 * the journal is append-only and a fixture must not be able to make its own tracks disappear.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export async function reverseEntry(
  access: LedgerAccess,
  entryId: string,
  why: string,
): Promise<void> {
  const response = await fetch(
    `${access.base.replace(/\/+$/, '')}/entries/${encodeURIComponent(entryId)}/reverse`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        // Bound to the authenticated principal by `ledger/src/server.ts` — `attribute()` now
        // refuses a posting whose claimed service is not the one the token was minted for, so
        // these two are checked rather than believed.
        originatingService: 'wallet',
        actor: 'service:wallet',
        idempotencyKey: `beacon-fixture-reversal-${entryId}`,
        description: why,
      }),
      ...(access.signal ? { signal: access.signal } : {}),
    },
  )
  if (response.status !== 201 && response.status !== 200) {
    throw new MoneyError(
      `the ledger refused to reverse the fixture entry ${entryId} (HTTP ${response.status}) — ` +
        `${(await response.text()).slice(0, 200)}. THE FIXTURE HAS LEFT A LIABILITY BEHIND`,
    )
  }
}

/* ------------------------------------------------------------------ the chain */

/**
 * The calls this tier makes, each beside the line of the contract it was read from.
 *
 * `foresight/src/contracts/ForesightMarket.sol`, and the same nine signatures
 * `foresight-web/src/lib/abi.ts` declares — that file is the other side of the same coupling and
 * the two are held together by `keccak.test.ts` pinning the selectors rather than by an import.
 */
export const MARKET_ABI = {
  /** `uint256[2] public pool` — sol:120, so the getter takes the index. */
  pool: 'pool(uint256)',
  /** `function stakeOf(address) external view returns (uint256 yes, uint256 no)` — sol:352. */
  stakeOf: 'stakeOf(address)',
  /** `function payoutOf(address) public view returns (uint256)` — sol:405. */
  payoutOf: 'payoutOf(address)',
  /** `Status public status` — sol:114. `enum Status { Open, Resolved, Void }` — sol:49-53. */
  status: 'status()',
  /** `uint8 public winningOutcome` — sol:117. Meaningless unless `status` is Resolved. */
  winningOutcome: 'winningOutcome()',
  /** `function feeAmount() public view returns (uint256)` — sol:381. Off the LOSING pool only. */
  feeAmount: 'feeAmount()',
} as const

/** `enum Status { Open, Resolved, Void }`. */
export const CONTRACT_STATUS = { open: 0n, resolved: 1n, void: 2n } as const

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** A `uint256`/`uint8` word: 32 bytes, big-endian, unpadded hex. */
export function encodeUint(value: bigint): string {
  if (value < 0n) throw new MoneyError('an unsigned word cannot be negative')
  if (value >= 1n << 256n) throw new MoneyError('value does not fit in a 256-bit word')
  return value.toString(16).padStart(64, '0')
}

/** An `address` word: the 20 bytes, left-padded to 32. */
export function encodeAddress(address: string): string {
  if (!ADDRESS.test(address)) throw new MoneyError(`not a 20-byte address: ${address}`)
  return address.slice(2).toLowerCase().padStart(64, '0')
}

export type AbiArg =
  | { readonly type: 'uint256'; readonly value: bigint }
  | { readonly type: 'address'; readonly value: string }

export function encodeCall(signature: string, args: readonly AbiArg[] = []): string {
  const head = args
    .map((arg) => (arg.type === 'address' ? encodeAddress(arg.value) : encodeUint(arg.value)))
    .join('')
  return `${selector(signature)}${head}`
}

/**
 * The nth 32-byte word of a return value, unsigned. `null` for a short or malformed result.
 *
 * `null` rather than `0n`, and this is the whole reason the file says what it says about `bigint`.
 * An `eth_call` against a syncing node, an address holding no code, or a chain the node has since
 * dropped all answer `0x` — and `0x` decoded as `0n` is a confident zero where the truth is "not
 * known". `foresight-web/src/lib/abi.ts` makes the same choice for the same reason.
 */
export function decodeUintAt(data: unknown, index = 0): bigint | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return null
  const body = data.slice(2)
  const start = index * 64
  if (body.length < start + 64) return null
  const word = body.slice(start, start + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null
  return BigInt(`0x${word}`)
}

export interface ChainAccess {
  /** A JSON-RPC endpoint, as `BEACON_TARGETS` resolves `chain`. */
  readonly rpc: string
  readonly signal?: AbortSignal
}

async function rpc(access: ChainAccess, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(access.rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    ...(access.signal ? { signal: access.signal } : {}),
  })
  if (!response.ok) throw new MoneyError(`${method} answered HTTP ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new MoneyError(`${method}: ${body.error.message ?? 'rpc error'}`)
  return body.result
}

/** The chain id the node reports. Decimal. */
export async function chainId(access: ChainAccess): Promise<bigint | null> {
  const result = await rpc(access, 'eth_chainId', [])
  return typeof result === 'string' && result.startsWith('0x') ? BigInt(result) : null
}

/** One `eth_call` at the latest block. */
export async function ethCall(access: ChainAccess, to: string, data: string): Promise<unknown> {
  return await rpc(access, 'eth_call', [{ to, data }, 'latest'])
}

/** `pool(outcome)` — the wei staked on one side, straight out of contract storage. */
export async function poolOf(
  access: ChainAccess,
  contract: string,
  outcome: 0 | 1,
): Promise<bigint | null> {
  return decodeUintAt(
    await ethCall(access, contract, encodeCall(MARKET_ABI.pool, [{ type: 'uint256', value: BigInt(outcome) }])),
  )
}

/** `stakeOf(staker)` — two words back: yes at 0, no at 1. `null` when the call answered nothing. */
export async function stakeOf(
  access: ChainAccess,
  contract: string,
  staker: string,
): Promise<{ readonly yes: bigint; readonly no: bigint } | null> {
  const data = await ethCall(
    access,
    contract,
    encodeCall(MARKET_ABI.stakeOf, [{ type: 'address', value: staker }]),
  )
  const yes = decodeUintAt(data, 0)
  const no = decodeUintAt(data, 1)
  return yes === null || no === null ? null : { yes, no }
}

/** `payoutOf(staker)` — what the contract will pay this address, in wei. */
export async function payoutOf(
  access: ChainAccess,
  contract: string,
  staker: string,
): Promise<bigint | null> {
  return decodeUintAt(
    await ethCall(access, contract, encodeCall(MARKET_ABI.payoutOf, [{ type: 'address', value: staker }])),
  )
}

/** `status()` — 0 open, 1 resolved, 2 void. */
export async function contractStatus(
  access: ChainAccess,
  contract: string,
): Promise<bigint | null> {
  return decodeUintAt(await ethCall(access, contract, encodeCall(MARKET_ABI.status)))
}

/**
 * The addresses that have staked on one market, found by asking the chain for its own logs.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE STAKER IS DISCOVERED, NEVER CONFIGURED, AND THAT IS THE POINT.**
 *
 * `BJ-FOR-14` asserts that the portfolio page's figures for an address equal what the contract
 * holds for it. To drive it you need an address that has actually staked, and the estate exposes no
 * route that lists them: `foresight/src/server.ts` serves `/markets/:id/positions/:address`, which
 * answers about an address you already have. The obvious shortcut is an environment variable —
 * and it is the wrong one twice over. A configured address goes stale the moment the estate is
 * rebuilt, and a journey that skips when it is unset is a journey that skips for ever in CI.
 *
 * `Staked(address indexed staker, uint8 indexed outcome, uint256 amount, uint256 poolYes,
 * uint256 poolNo)` — `ForesightMarket.sol`. `staker` is INDEXED, so it is topic 1, and the
 * chain will name its own stakers to anybody who asks. The signature is hashed rather than
 * memorised for `keccak.ts`'s reason.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export const STAKED_EVENT = 'Staked(address,uint8,uint256,uint256,uint256)'

export async function stakersOf(
  access: ChainAccess,
  contract: string,
): Promise<readonly string[]> {
  const logs = (await rpc(access, 'eth_getLogs', [
    {
      address: contract,
      fromBlock: '0x0',
      toBlock: 'latest',
      topics: [selectorTopic(STAKED_EVENT)],
    },
  ])) as readonly { topics?: readonly string[] }[] | null
  if (!Array.isArray(logs)) return []
  const out: string[] = []
  for (const log of logs) {
    const staker = log.topics?.[1]
    // A 32-byte topic holding a left-padded 20-byte address. Anything else is not one, and
    // guessing at a malformed topic is how a journey ends up asserting about `0x000…0`.
    if (typeof staker !== 'string' || staker.length !== 66) continue
    const address = `0x${staker.slice(26)}`
    if (ADDRESS.test(address) && !out.includes(address)) out.push(address)
  }
  return out
}

/** The full 32-byte keccak of an event signature — topic 0, not a four-byte selector. */
export function selectorTopic(signature: string): string {
  return `0x${toHexOfSignature(signature)}`
}

function toHexOfSignature(signature: string): string {
  // Deliberately the WHOLE digest. `selector()` truncates to four bytes, which is right for
  // calldata and wrong for a topic — a truncated topic matches nothing and the journey would report
  // "this market has no stakers" about a market that has two.
  const { keccak256, toHex } = keccakModule
  return toHex(keccak256(new TextEncoder().encode(signature)))
}

/* ------------------------------------------------------------------ reading a rendered figure */

/**
 * Wei to its exact decimal string. String arithmetic, never a division.
 *
 * The page renders `0.3 EMBER` where the contract holds `300000000000000000`. Asserting that the
 * page contains the wei digits would fail against a correct page; asserting a float would round the
 * least significant digits away, which on a payout is the difference between what somebody is owed
 * and a number that never existed. So the decimal is DERIVED from the bigint here and the page is
 * required to show that string — which keeps the assertion exact on both sides.
 *
 * Trailing zeros are trimmed, because `0.300000000000000000` and `0.3` are the same number and the
 * shorter one is the one a person can check. `foresight-web` trims the same way.
 */
export function weiToDecimal(value: bigint, decimals = 18): string {
  if (value < 0n) throw new MoneyError('a negative wei figure has no rendering here')
  if (decimals === 0) return value.toString()
  const digits = value.toString().padStart(decimals + 1, '0')
  const cut = digits.length - decimals
  const fraction = digits.slice(cut).replace(/0+$/, '')
  return fraction === '' ? digits.slice(0, cut) : `${digits.slice(0, cut)}.${fraction}`
}

/**
 * Every group of digits on a page, with the separators a locale put in them removed.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A FORMATTED STRING IS NOT AN AMOUNT, AND ASSERTING ON ONE ALONE IS THE DEFECT.**
 *
 * The brief this tier answers is explicit: assert exact wei, never a formatted string alone. So
 * nothing here converts a rendered figure into money. What it does is answer one narrow question —
 * "does this page contain the exact digit string the estate holds?" — which is what a presentation
 * assertion about an amount actually means.
 *
 * `1,234,567` and `1234567` are the same amount rendered two ways, and a suite that failed on the
 * comma would be testing `Intl.NumberFormat`. `1.5` and `1500000000000000000` are NOT the same
 * string and are not treated as one: the caller decides which form it is asserting and says so.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
export function digitRuns(text: string): ReadonlySet<string> {
  const out = new Set<string>()
  // Commas, narrow no-break spaces and ordinary spaces are all thousands separators somewhere.
  const flattened = text.replace(/[,  ](?=[0-9])/g, '').replace(/ (?=[0-9]{3}\b)/g, '')
  for (const match of flattened.matchAll(/[0-9]+/g)) out.add(match[0])
  return out
}

/** Does the page render this exact amount, in whatever separators it chose? */
export function rendersAmount(text: string, amount: bigint): boolean {
  return digitRuns(text).has(amount.toString())
}
