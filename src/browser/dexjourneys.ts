/**
 * Forge Exchange in a browser — and the only journeys in this repository that SIGN.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **AN INJECTED PROVIDER IS NOT INTERCEPTION, AND THE DIFFERENCE IS THE WHOLE FILE.**
 *
 * `smoke.test.ts` bans `.route(`, `.fulfill(`, `.abort(` and `setOfflineMode` by regex, and the ban
 * is correct: every one of those answers a request the estate was supposed to answer, so a suite
 * that uses them cannot see that the estate is down. `driver.ts` grew `addInitScript` and
 * `exposeFunction` for this file, and they do the opposite thing. They add an object to the page —
 * `window.ethereum`, which no CloudsForge service was ever going to supply, because a browser
 * wallet is a browser EXTENSION and the Chromium beacon drives has none — and every request the
 * page makes as a result still goes to the real gateway, the real RPC and the real chain.
 *
 * Interception replaces an answer the product owed. Injection supplies an input the product's
 * ENVIRONMENT owed. A swap journey that stubbed the RPC would prove nothing; a swap journey with
 * no wallet cannot press the button at all, which is exactly what `exchange-web` says on the page:
 * "No wallet is installed in this browser, so nothing here can be signed."
 *
 * ── WHAT THE INJECTED WALLET IS AND IS NOT ───────────────────────────────────────────────────
 *
 * It is five JSON-RPC methods, because `exchange-web/src/lib/wallet.ts` calls exactly five:
 * `eth_requestAccounts`, `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain` and
 * `eth_sendTransaction`. Anything else is recorded and refused rather than guessed at — a sixth
 * method appearing is a change in the product worth failing on, not a gap to paper over.
 *
 * The private key never enters the page. The object installed in the browser has no signing code
 * at all: it serialises each request, hands it to this process through `exposeFunction`, and this
 * process signs with `@cloudsforge/hearth-wallet-core` — the same core the extension, the desktop
 * client and the mobile client sign with, for the reason 25-wallet-clients.md §3 gives: three
 * clients depending on divergent copies of a signer is the worst failure that design can have, and
 * a fourth copy written here to save a dependency would be the fourth divergence.
 *
 * ── WHY THE KEY IS READ FROM THE ENVIRONMENT HERE, AND NOT THREADED THROUGH THE REGISTRY ─────
 *
 * `journeys.ts` threads the estate operator's credential to every implementation because every
 * implementation may legitimately need to seed an account. A private key that can move coins is not
 * that: it is needed by one scenario, and a registry argument would put it within reach of the
 * fifteen that must never touch it. So it is read here, once, by name, and it is never printed.
 * The ADDRESS derived from it is printed freely — an address is not a credential, and a skip that
 * cannot say which address to fund is a skip nobody can act on.
 *
 * ── NOTHING BELOW IS CONFIGURED ──────────────────────────────────────────────────────────────
 *
 * Not the factory, not the router, not the pair, not the tokens. The pool comes from the page's own
 * `/pools` list; everything else is then VERIFIED against the chain — the pair must be the one the
 * factory registers for its own two tokens, and the router the page asks this wallet to sign for
 * must report the same factory as the pair does. A configured address would go stale the first
 * time the estate redeployed, and a journey that skipped when it was unset would skip for ever.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */

import { TX_TYPE_LEGACY, addressFromPrivateKey, signTransaction } from '@cloudsforge/hearth-wallet-core'
import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import type { BrowserConfig, BrowserPage } from './driver.ts'
import type { Scenario } from './catalogue.ts'
import { surfaceJourney } from './journeys.ts'
import { chainRpc, decodeUintAt, encodeCall, ethCall, type ChainAccess } from './money.ts'

type Implementation = (config: BrowserConfig, scenario: Scenario) => JourneyDefinition

/**
 * `ctx.skip`, as a declared function, so the compiler knows control does not continue past it.
 *
 * The same indirection `foresightjourneys.ts` carries, for the same reason: `verify`'s parameters
 * are contextually typed, so a bare `ctx.skip` in a discovery step leaves the value after it typed
 * as possibly undefined — and the natural fix is a non-null assertion, which is precisely the
 * assertion a journey must not make about its own fixture.
 */
function stop(ctx: JourneyContext, reason: string): never {
  return ctx.skip(reason)
}

const chainOf = (ctx: JourneyContext): ChainAccess => ({
  rpc: ctx.target('chain'),
  signal: ctx.signal,
})

/**
 * A URL under the exchange, carrying whatever the TARGET carried.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THIS IS WHAT LETS ONE PAIR OF JOURNEYS DRIVE EITHER NETWORK, AND IT IS NOT A CONVENIENCE.**
 *
 * Under the combined view the `-testnet` web hostnames are retired, so `exchange.<apex>` is the
 * only address this surface has and the network a reader is VIEWING is carried in `?net=` —
 * `ui/packages/ui/src/network-view.ts`, and `exchange-web/src/lib/rpc.ts` picks `rpc` or
 * `rpc-testnet` off `viewedNetwork()`. Nothing is persisted: the choice lives in module memory for
 * the tab, so every `page.goto` in this file is a fresh module and a fresh default. A journey that
 * composed its URLs by string concatenation would therefore drive the FIRST page on whatever
 * network the target named and every page after it on mainnet, and the two halves would disagree
 * silently — the pool list from one chain, the swap panel on the other.
 *
 * So the target is treated as a URL rather than as a prefix, and its query survives every
 * navigation. `--targets "exchange=https://exchange.<apex>/?net=testnet"` drives testnet end to
 * end; the same target without the query drives mainnet, which is what `estate-browser.sh` passes.
 *
 * There is no `net` constant anywhere in this file, and there must not be one. The network is the
 * OPERATOR's choice, named once on the command line, and a journey that hard-coded it would be
 * asserting against a chain the person running it did not ask for. The mismatch that matters is
 * caught by the product itself: `installWallet` answers `eth_chainId` with what the `chain` target
 * says, so a page viewing 7411 with an RPC target on 7412 asks this wallet to switch, is refused
 * with EIP-3085's 4902, and BJ-DEX-02 fails on "switch your wallet to" rather than swapping on the
 * wrong chain.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
function pageAt(base: string, path: string, params: Readonly<Record<string, string>> = {}): string {
  const url = new URL(base)
  // `URL` resolves a relative path against the base, which would DROP the last segment of a target
  // that names one — `account=https://hub.example/account` is a real shape in this estate. Joining
  // the pathnames by hand keeps that segment, and the base's own query is untouched by it.
  const prefix = url.pathname.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  url.pathname = suffix === '' ? `${prefix}/` : `${prefix}/${suffix}`
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value)
  return url.toString()
}

/** Wait for the network to settle, then read the body. */
async function bodyText(page: BrowserPage, timeoutMs: number): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  // The exchange reads every figure over the public RPC after mount — reserves, quote, balances —
  // and `networkidle` fires before React has committed the result. A short settle is a courtesy to
  // that, not a precondition: the assertion below is against the chain, so a page that never
  // renders fails on the content rather than on the wait.
  await page.waitForTimeout(2_500)
  return await page.evaluate(() => document.body?.innerText ?? '')
}

/* ------------------------------------------------------------------ reading the contracts */

/** A `0x`-prefixed hex quantity, as the JSON-RPC spec requires — no leading zeros. */
const quantity = (value: bigint): string => `0x${value.toString(16)}`

/** A quantity the node answered, or `null` when it answered something that is not one. */
function quantityOf(value: unknown): bigint | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? BigInt(value) : null
}

/**
 * The nth word of a return value, read as an address.
 *
 * Lower-cased on the way out and compared lower-cased everywhere below. Solidity returns an address
 * left-padded into 32 bytes with no case information in it, while `exchange-web` renders and links
 * checksummed — so a comparison that did not normalise would fail on two spellings of one address,
 * which is the least useful red a monitor can produce.
 */
function addressAt(data: unknown, index = 0): string | null {
  if (typeof data !== 'string' || !data.startsWith('0x')) return null
  const body = data.slice(2)
  const start = index * 64
  if (body.length < start + 64) return null
  const word = body.slice(start, start + 64)
  if (!/^[0-9a-fA-F]{64}$/.test(word)) return null
  if (!/^0{24}/.test(word)) return null
  return `0x${word.slice(24).toLowerCase()}`
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** `getReserves()` — the two balances a V2 pair holds, in the tokens' own smallest units. */
async function reservesOf(
  chain: ChainAccess,
  pair: string,
): Promise<{ reserve0: bigint; reserve1: bigint } | null> {
  const data = await ethCall(chain, pair, encodeCall('getReserves()'))
  const reserve0 = decodeUintAt(data, 0)
  const reserve1 = decodeUintAt(data, 1)
  // `null` rather than a pair of zeros. An `eth_call` against a syncing node, an address with no
  // code at it, or a chain the node has dropped all answer `0x`, and `0x` read as zero is a
  // confident "the pool is empty" where the truth is "nobody answered".
  return reserve0 === null || reserve1 === null ? null : { reserve0, reserve1 }
}

interface Pair {
  readonly address: string
  readonly token0: string
  readonly token1: string
  readonly factory: string
}

/** The pair addresses the product itself links to, in the order it lists them. */
async function listedPairs(page: BrowserPage, base: string, timeoutMs: number): Promise<readonly string[]> {
  await page.goto(pageAt(base, 'pools'), { waitUntil: 'domcontentloaded' })
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  await page.waitForTimeout(2_500)
  const hrefs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'), (a) => (a as HTMLAnchorElement).href),
  )
  const out: string[] = []
  for (const href of hrefs) {
    const found = /\/pools\/(0x[0-9a-fA-F]{40})(?:[/?#]|$)/.exec(href)
    if (found && !out.includes(found[1]!.toLowerCase())) out.push(found[1]!.toLowerCase())
  }
  return out
}

/**
 * The pair the page linked, proven to be a real pair of the factory it names.
 *
 * ── WHY THIS STEP EXISTS AT ALL ──────────────────────────────────────────────────────────────
 *
 * The address comes from the DOM, which means the page chose it, which means an assertion that
 * only read it back from the same page would be circular. So the address is treated as a FIXTURE
 * and immediately checked against the chain in the one way that cannot be faked: the pair is asked
 * which factory deployed it and which two tokens it holds, and that factory is asked, separately,
 * which pair it registered for those two tokens. A page linking an address with no contract at it,
 * an address belonging to a different exchange, or an address it invented fails here rather than
 * three steps later with a message about a missing number.
 */
async function pairFacts(chain: ChainAccess, pair: string): Promise<Pair | null> {
  const token0 = addressAt(await ethCall(chain, pair, encodeCall('token0()')))
  const token1 = addressAt(await ethCall(chain, pair, encodeCall('token1()')))
  const factory = addressAt(await ethCall(chain, pair, encodeCall('factory()')))
  if (token0 === null || token1 === null || factory === null) return null
  return { address: pair.toLowerCase(), token0, token1, factory }
}

/* ------------------------------------------------------------------ BJ-DEX-01 */

/**
 * BJ-DEX-01 — the pool page holds what the pair contract holds, to the smallest unit.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE ASSERTION IS `k`, AND THE CHOICE IS THE POINT.**
 *
 * `pool.tsx` renders four figures, and three of them are rounded for a reader: the two reserves go
 * through `formatUnits(…, 6)` and the price is a quotient. A monitor asserting on any of those is
 * asserting on a rounding, and the substring "1.234567" appears on a page showing a great many
 * numbers that are not the one being checked.
 *
 * `k` is different. It is `reserve0 × reserve1` in smallest units, rendered by `{k.toString()}`
 * with no formatting whatsoever — a fifty-digit integer that a page cannot produce by accident,
 * cannot round into agreement, and cannot match by coincidence with a stale or invented figure. It
 * is also the invariant the product tells the reader must never fall, so a page whose `k` disagrees
 * with the pair's own storage is showing a reader the one number the whole page is about, wrong.
 *
 * The reserves are read from the CONTRACT and multiplied here in `bigint`; nothing is parsed out of
 * the DOM and turned back into a number, which is where precision is lost.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const poolPageAgainstChain: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.exchange,
    config,
    surface: 'exchange',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const chain = chainOf(ctx)

      const found = await ctx.step('find a pool the product lists, and prove it is one', async () => {
        const listed = await listedPairs(page, base, config.timeoutMs)
        if (listed.length === 0) {
          // ── A LOUD SKIP, NOT A QUIET PASS ──────────────────────────────────────────────────
          // "The page listed no pools and there is nothing to check" is a check that cannot fail,
          // and it is the exact shape this tier exists to refuse.
          stop(
            ctx,
            `${page.url()} links no pool at all. Either the factory has no pairs on this chain or ` +
              'the list did not render, and asserting nothing against nothing would be green for ' +
              'both.',
          )
        }
        for (const address of listed) {
          const facts = await pairFacts(chain, address)
          if (facts === null) continue
          const registered = addressAt(
            await ethCall(
              chain,
              facts.factory,
              encodeCall('getPair(address,address)', [
                { type: 'address', value: facts.token0 },
                { type: 'address', value: facts.token1 },
              ]),
            ),
          )
          ctx.assert(
            registered === facts.address,
            `${page.url()} links ${facts.address} as a pool. That contract says it holds ` +
              `${facts.token0} and ${facts.token1} and was deployed by ${facts.factory} — and ` +
              `${facts.factory} says the pair for those two tokens is ${registered ?? 'nothing'}. ` +
              'The page is linking an address the factory does not recognise as its own pair.',
          )
          const reserves = await reservesOf(chain, facts.address)
          if (reserves === null) continue
          if (reserves.reserve0 > 0n && reserves.reserve1 > 0n) return { pair: facts, reserves }
        }
        stop(
          ctx,
          `${listed.length} pool(s) are listed and none of them holds a reserve on both sides. ` +
            'A page showing zeroes matches a pair holding zeroes, so there is no figure here whose ' +
            'agreement would mean anything.',
        )
      })

      await ctx.step('THE PAGE SHOWS THE INVARIANT THE PAIR HOLDS, TO THE UNIT', async () => {
        const k = found.reserves.reserve0 * found.reserves.reserve1
        await page.goto(pageAt(base, `pools/${found.pair.address}`), {
          waitUntil: 'domcontentloaded',
        })
        const text = await bodyText(page, config.timeoutMs)
        ctx.assert(
          text.includes(k.toString()),
          `${found.pair.address} holds ${found.reserves.reserve0} and ` +
            `${found.reserves.reserve1} in its two reserves, so k is ${k} — and ${page.url()} does ` +
            `not contain that string anywhere. It rendered ${text.trim().length} characters, ` +
            `beginning "${text.trim().slice(0, 120)}"`,
        )
      })
    },
  })

/* ------------------------------------------------------------------ the wallet */

/**
 * The key that signs, or `null`. **Read by name; never printed, never logged, never in a message.**
 *
 * `BEACON_DEX_KEY` holds 32 bytes of hex. It is optional and its absence is a skip, because the
 * alternative — a default — would be a key committed to this repository that can spend coins on a
 * live chain. Every failure path below names the ADDRESS and never the key: an address is public
 * by construction, and it is the only thing an operator needs in order to fund the journey.
 */
function configuredKey(): Uint8Array | null {
  const raw = (process.env['BEACON_DEX_KEY'] ?? '').trim()
  if (raw === '') return null
  const body = raw.replace(/^0x/i, '')
  // The value is not echoed even when it is malformed. A monitor that printed the bad key in order
  // to explain why it was bad would publish it to every log sink the estate has.
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error('BEACON_DEX_KEY is set and is not 32 bytes of hex — its value is not printed')
  }
  const out = new Uint8Array(32)
  for (let i = 0; i < 32; i += 1) out[i] = Number.parseInt(body.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * The provider, as SOURCE TEXT rather than as a function — and it has to be text.
 *
 * Playwright serialises a function argument to `addInitScript` with `toString()` and evaluates the
 * result in the page. This process runs its TypeScript through `tsx`, which is esbuild, which has
 * `keepNames` on, so `const request = async (…) => {…}` is emitted as
 * `const request = __name(async (…) => {…}, "request")`. `__name` is a module helper that exists
 * here and nowhere in the browser, so the injected text died on `ReferenceError: __name is not
 * defined` before installing anything, `window.ethereum` stayed undefined, and the swap page said —
 * correctly — that no wallet was installed. The journey then reported the product broken for a
 * defect that was entirely its own.
 *
 * It cost hours to find because every symptom pointed away from it: an inline arrow passed to
 * `evaluate` carries no name binding and is left alone, so every other evaluation in this file
 * worked, and a hand-written `.mjs` reproduction of the same injection worked too — the one thing
 * it did not reproduce was the transpiler. A string is not transpiled by anything.
 *
 * `isBeacon` rather than `isMetaMask`: nothing in `exchange-web` reads either — it asks only
 * whether `request` is a function — and claiming to be a wallet this is not would make any future
 * vendor-specific branch take the wrong side for a reason nobody could find.
 */
const PROVIDER_SOURCE = `
(() => {
  const request = async (args) => {
    const raw = await window.beaconWalletRequest(args.method, JSON.stringify(args.params ?? []))
    const parsed = JSON.parse(raw)
    if (parsed.ok) return parsed.result
    const error = new Error(parsed.message ?? 'the wallet refused')
    error.code = parsed.code ?? -32603
    throw error
  }
  window.ethereum = { isBeacon: true, request, on: () => {}, removeListener: () => {} }
})()
`

interface SentTransaction {
  readonly to: string
  readonly data: string
  readonly value: bigint
  readonly hash: string
}

interface InstalledWallet {
  readonly address: string
  readonly sent: readonly SentTransaction[]
  /** Methods the page asked for that this wallet does not implement. Asserted on, not ignored. */
  readonly unexpected: readonly string[]
}

/**
 * Install an EIP-1193 provider in the page, backed by a signer in this process.
 *
 * ── WHY THE ERROR TEXT IS NARROWED ───────────────────────────────────────────────────────────
 *
 * A caught error from anything that has touched a URL is not safe to repeat. Node's `fetch` puts
 * the whole request URL in the exception, and `chain` is an operator-supplied endpoint that may
 * carry credentials in its authority — that is how a node's RPC credential has leaked in this
 * estate before, and no redaction rule catches it. So a `MoneyError`, whose message this file
 * builds from the node's own JSON-RPC `error.message`, is passed through; anything else is
 * reported by its constructor's name and the method that produced it, and nothing more.
 */
async function installWallet(
  ctx: JourneyContext,
  page: BrowserPage,
  chain: ChainAccess,
  key: Uint8Array,
  chainIdNumber: number,
): Promise<InstalledWallet> {
  const address = addressFromPrivateKey(key).toLowerCase()
  const sent: SentTransaction[] = []
  const unexpected: string[] = []

  const answer = async (method: string, paramsJson: string): Promise<string> => {
    const params = JSON.parse(paramsJson) as readonly unknown[]
    try {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') {
        return JSON.stringify({ ok: true, result: [address] })
      }
      if (method === 'eth_chainId') {
        // What the NODE says, not what this journey expects. A wallet that answered from its own
        // configuration would hide precisely the mismatch `wallet_switchEthereumChain` exists for.
        return JSON.stringify({ ok: true, result: quantity(BigInt(chainIdNumber)) })
      }
      if (method === 'wallet_switchEthereumChain') {
        const wanted = (params[0] as { chainId?: unknown } | undefined)?.chainId
        const id = quantityOf(wanted)
        if (id === BigInt(chainIdNumber)) return JSON.stringify({ ok: true, result: null })
        // 4902 is EIP-3085's "unrecognised chain", which is the honest answer: this wallet is
        // attached to one node and cannot become attached to another.
        return JSON.stringify({
          ok: false,
          code: 4902,
          message:
            `the page asked this wallet to switch to chain ${String(wanted)} and it is attached ` +
            `to ${chainIdNumber}`,
        })
      }
      if (method === 'eth_sendTransaction') {
        const request = (params[0] ?? {}) as {
          to?: unknown
          data?: unknown
          value?: unknown
          from?: unknown
        }
        const to = typeof request.to === 'string' ? request.to.toLowerCase() : ''
        const data = typeof request.data === 'string' ? request.data : '0x'
        const value = quantityOf(request.value) ?? 0n
        if (!ADDRESS.test(to)) {
          return JSON.stringify({
            ok: false,
            code: -32602,
            message: `the page asked to sign a transaction whose "to" is ${String(request.to)}`,
          })
        }
        const from = typeof request.from === 'string' ? request.from.toLowerCase() : ''
        if (from !== '' && from !== address) {
          // The page building a transaction from an address this wallet does not hold is a defect
          // worth failing on rather than silently re-signing as somebody else.
          return JSON.stringify({
            ok: false,
            code: -32602,
            message: `the page asked to sign from ${from}, and this wallet holds ${address}`,
          })
        }
        const nonce = quantityOf(await chainRpc(chain, 'eth_getTransactionCount', [address, 'pending']))
        const gasPrice = quantityOf(await chainRpc(chain, 'eth_gasPrice', []))
        const estimated = quantityOf(
          await chainRpc(chain, 'eth_estimateGas', [
            { from: address, to, data, value: quantity(value) },
          ]),
        )
        if (nonce === null || gasPrice === null || estimated === null) {
          return JSON.stringify({
            ok: false,
            code: -32603,
            message: 'the node did not answer one of nonce, gas price or gas estimate',
          })
        }
        // A quarter over the estimate. `eth_estimateGas` binary-searches against the state at the
        // pending block, and a swap executed one block later touches a `SLOAD` the estimate did
        // not: the router's own interface has used a headroom for that since V2 shipped.
        const gasLimit = (estimated * 125n) / 100n
        const signed = signTransaction(
          { type: TX_TYPE_LEGACY, nonce, gasPrice, gasLimit, to, value, data },
          key,
          chainIdNumber,
        )
        const hash = await chainRpc(chain, 'eth_sendRawTransaction', [signed.raw])
        if (typeof hash !== 'string' || !hash.startsWith('0x')) {
          return JSON.stringify({
            ok: false,
            code: -32603,
            message: 'the node accepted the transaction and did not return a hash',
          })
        }
        // The core computes the hash from the bytes it signed, and the node computes it from the
        // bytes it received. They are the same transaction or one of them is wrong, and a monitor
        // that tracked the node's hash without checking would follow a receipt for a payload it
        // never signed.
        if (hash.toLowerCase() !== signed.hash.toLowerCase()) {
          return JSON.stringify({
            ok: false,
            code: -32603,
            message: `the node hashed the broadcast as ${hash} and the signer hashed it as ${signed.hash}`,
          })
        }
        sent.push({ to, data, value, hash: hash.toLowerCase() })
        return JSON.stringify({ ok: true, result: hash })
      }
      unexpected.push(method)
      return JSON.stringify({
        ok: false,
        code: 4200,
        message: `this wallet implements the five methods exchange-web calls, and not ${method}`,
      })
    } catch (err) {
      // See the header above this function. The message is either one this file composed from the
      // node's own JSON-RPC error, or it is a class name.
      const message =
        err instanceof Error && err.name === 'MoneyError'
          ? err.message
          : `${err instanceof Error ? err.constructor.name : typeof err} while answering ${method}`
      return JSON.stringify({ ok: false, code: -32603, message })
    }
  }

  await page.exposeFunction('beaconWalletRequest', answer)
  await page.addInitScript(PROVIDER_SOURCE)

  ctx.cleanup(() => {
    // Nothing to undo in the page — it is torn down with the context — but the count belongs in the
    // record either way, and it is the one number that says whether the journey spent anything.
    if (sent.length > 0) {
      process.stdout.write(
        `[bj-dex] ${sent.length} transaction(s) signed by ${address}: ` +
          `${sent.map((s) => s.hash).join(', ')}\n`,
      )
    }
  }, 'record what was signed')

  return { address, sent, unexpected }
}

/** The text of the one action control the swap panel renders, whatever state it is in. */
async function actionText(page: BrowserPage): Promise<string> {
  return await page.evaluate(() => {
    const button = document.querySelector('.xc-action') as HTMLButtonElement | null
    if (button !== null) return button.textContent ?? ''
    const none = document.querySelector('.xc-action__none') as HTMLElement | null
    return none === null ? '' : none.innerText
  })
}

/** The refusal the swap panel is showing, or the empty string. `role="alert"` in the markup. */
async function problemText(page: BrowserPage): Promise<string> {
  return await page.evaluate(() => {
    const problem = document.querySelector('.xc-problem') as HTMLElement | null
    return problem === null ? '' : problem.innerText
  })
}

/* ------------------------------------------------------------------ BJ-DEX-02 */

/**
 * BJ-DEX-02 ★ — a swap signed in the browser reaches the chain, and the receipt says it succeeded.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE PHASE-H GATE, AND THE ONLY JOURNEY IN THIS REPOSITORY THAT SPENDS MONEY.**
 *
 * `docs/ecosystem/39-forge-exchange.md` §6 makes the gate "beacon drives a swap through the real
 * gateway". Every word of that is load-bearing and each one rules out a cheaper thing:
 *
 *   * **a swap** — not a quote, not a connect. The router is called and the pool moves.
 *   * **drives** — through the controls a reader uses. The amount is typed into the input the page
 *     labels "Amount to pay" and the button the page renders is pressed. No transaction is built
 *     here and handed to the chain behind the page's back; if `buildSwapTransaction` computes the
 *     wrong path, the wrong minimum or the wrong deadline, this journey signs the wrong thing and
 *     the chain says so.
 *   * **the real gateway** — `estate-browser.sh` points `exchange` at the estate's Traefik, so the
 *     bundle, its assets and its RPC calls are all served the way a customer is served.
 *
 * ── THE ASSERTION IS THE RECEIPT ─────────────────────────────────────────────────────────────
 *
 * Not the "Swap sent." status line, not the absence of `.xc-problem`, not a state class. A page can
 * render every one of those for a transaction the mempool dropped. `eth_getTransactionReceipt` with
 * `status: 0x1` is the chain saying the router executed — and the receipt's `to` is checked against
 * the pair's own factory, so a page that sent a perfectly successful transaction to some other
 * contract fails here rather than passing on a green toast.
 *
 * ── WHAT IT REFUSES TO DO ────────────────────────────────────────────────────────────────────
 *
 * Without `BEACON_DEX_KEY` it skips, loudly, naming the variable. With a key holding nothing it
 * skips, loudly, naming the address to fund. It never falls back to asserting that a page which
 * cannot sign correctly says it cannot sign — that is a check that cannot fail, and it is the
 * failure mode this whole tier exists to refuse.
 *
 * It is deliberately not `critical`: the gate it closes is a phase gate, and a release must not be
 * refused because an operator's synthetic key ran out of coins.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const swapThroughTheGateway: Implementation = (config, scenario) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.exchange,
    config,
    surface: 'exchange',
    critical: scenario.gate,
    // Seven minutes, and the only browser journey that asks for more than the tier's two.
    //
    // Everything up to the press is page work and fits inside 120s with room. What does not is the
    // wait AFTER it: `THE CHAIN SAYS THE SWAP SUCCEEDED` polls for a receipt for five minutes on
    // its own, because a transaction is not mined when it is accepted — EMBER's block interval is
    // the thing being waited on, and on a chain at its difficulty floor that interval is neither
    // constant nor a number this process gets to choose (the step's own comment carries the
    // measurements). Both earlier drives signed a swap that succeeded on chain and were reported
    // red anyway: once as `journey exceeded 120000ms` (0xe52a2974…8207, block 18188) and once as
    // "in a mempool the chain is not mining" (0x11a647bb…b2eb, block 18199, mined 83 seconds after
    // the poll gave up). Seven minutes is the five-minute poll plus the page work in front of it.
    deadlineMs: 420_000,
    async verify(ctx, page, _collected, base) {
      const chain = chainOf(ctx)

      const key = configuredKey()
      if (key === null) {
        stop(
          ctx,
          'no BEACON_DEX_KEY is set, so there is no wallet that can sign. This journey presses the ' +
            'button a reader presses and asserts the chain receipt; without a funded key the only ' +
            'thing left to check is that a page with no wallet says so, which is a check that ' +
            'cannot fail.',
        )
      }

      const chainIdNumber = await ctx.step('the node names its chain', async () => {
        const id = quantityOf(await chainRpc(chain, 'eth_chainId', []))
        ctx.assert(id !== null, 'eth_chainId did not answer a quantity — the node is not reachable')
        return Number(id)
      })

      const wallet = await installWallet(ctx, page, chain, key, chainIdNumber)

      await ctx.step('the wallet holds enough to swap and pay for it', async () => {
        const balance = quantityOf(await chainRpc(chain, 'eth_getBalance', [wallet.address, 'latest']))
        ctx.assert(balance !== null, `eth_getBalance for ${wallet.address} did not answer a quantity`)
        if ((balance as bigint) < MINIMUM_BALANCE) {
          stop(
            ctx,
            `${wallet.address} holds ${balance} wei on chain ${chainIdNumber} and this journey ` +
              `needs at least ${MINIMUM_BALANCE} to swap ${SWAP_AMOUNT} and pay the gas. Fund that ` +
              'address, or unset BEACON_DEX_KEY so the skip says the honest thing.',
          )
        }
      })

      const found = await ctx.step('find a pool with the native coin on one side', async () => {
        const listed = await listedPairs(page, base, config.timeoutMs)
        if (listed.length === 0) {
          stop(ctx, `${page.url()} links no pool at all, so there is no pair to trade against.`)
        }
        for (const address of listed) {
          const facts = await pairFacts(chain, address)
          if (facts === null) continue
          const reserves = await reservesOf(chain, facts.address)
          if (reserves === null || reserves.reserve0 === 0n || reserves.reserve1 === 0n) continue
          return { pair: facts, reserves }
        }
        stop(
          ctx,
          `${listed.length} pool(s) are listed and none holds a reserve on both sides. A swap into ` +
            'an empty pool reverts, and the revert would be this journey\'s own fault rather than ' +
            'the product\'s.',
        )
      })

      /**
       * Which side of the pair is the wrapped native, decided by the product rather than guessed.
       *
       * The swap page takes both sides from the query string, and `from=native` makes the router's
       * path start at the wrapped address. So the token to receive is whichever of the pair's two
       * tokens is NOT the wrapped one — and rather than infer that from a symbol string, this asks
       * the page: offered the wrapped address as `to`, `swap.tsx` resolves both sides to the same
       * token and refuses. Exactly one of the two candidates leaves something to trade against,
       * which makes this deterministic rather than a heuristic. The choice is then verified against
       * the chain once the router appears, below.
       *
       * BOTH refusals count, and which one appears is the product's business: `sameAsset` fires
       * when the wrapped address resolves to the same token the native side already is, and
       * `hasPool` fires when the address is not one the deployment lists at all. Matching only the
       * second would take the wrapped side as the answer the moment the first is the one shown, and
       * a swap along [wrapped, wrapped] reverts — a failure this journey would have authored.
       */
      const REFUSED = /no pool for this pair|choose two different tokens/i
      const token = await ctx.step('choose the token to receive, from the pair itself', async () => {
        for (const candidate of [found.pair.token1, found.pair.token0]) {
          await page.goto(pageAt(base, '', { from: 'native', to: candidate }), {
            waitUntil: 'domcontentloaded',
          })
          await page.waitForLoadState('networkidle', { timeout: config.timeoutMs }).catch(() => {})
          await page.waitForTimeout(2_000)
          const text = await actionText(page)
          // `useWalletAddress` asks `eth_accounts` on mount and the injected provider answers with
          // the address, so the panel is past its connect state here without a press — which is
          // what makes the refusals above readable at all. Asserted rather than skipped over: a
          // provider that failed to install shows a message about the WALLET, which matches neither
          // refusal, and the loop would otherwise read that as "this candidate is tradable" and
          // take the wrapped side.
          ctx.assert(
            !/no wallet is installed/i.test(text),
            `${page.url()} says no wallet is installed after one was injected before any of its ` +
              'own script ran. `getProvider()` reads `window.ethereum` and requires `request` to ' +
              'be a function; the object installed has one, unless the init script itself threw — ' +
              'see `PROVIDER_SOURCE`.',
          )
          if (!REFUSED.test(text)) return candidate
        }
        stop(
          ctx,
          `${found.pair.address} holds ${found.pair.token0} and ${found.pair.token1}, and the swap ` +
            'page reports no pool for the native coin against either of them. The pool list and ' +
            'the swap page disagree about what can be traded.',
        )
      })

      await ctx.step('connect the wallet the page asked for', async () => {
        // Up to three presses, because the panel renders one control at a time and each press
        // advances it: connect, then — only if the wallet is on another chain — switch. A loop
        // rather than three unconditional clicks, so a page that connects in one step is not
        // reported broken for skipping a state it correctly never entered.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const text = (await actionText(page)).trim()
          if (/^connect a wallet$/i.test(text) || /^switch your wallet to /i.test(text)) {
            await page.click('.xc-action', { timeout: config.timeoutMs })
            await page.waitForTimeout(2_000)
            continue
          }
          break
        }
        const text = (await actionText(page)).trim()
        ctx.assert(
          !/no wallet is installed/i.test(text),
          `${page.url()} says no wallet is installed after one was injected before any of its own ` +
            'script ran. `getProvider()` reads `window.ethereum` and requires `request` to be a ' +
            'function; the object installed has one.',
        )
        ctx.assert(
          !/^connect a wallet$/i.test(text) && !/^switch your wallet to /i.test(text),
          `the swap panel still shows "${text}" after three presses. The wallet answered ` +
            `eth_requestAccounts with ${wallet.address} and eth_chainId with ${chainIdNumber}.`,
        )
      })

      await ctx.step('type the amount a reader types', async () => {
        await page.fill('input[aria-label="Amount to pay"]', SWAP_AMOUNT, {
          timeout: config.timeoutMs,
        })
        // The quote is an RPC round trip through `getAmountsOut`, and the button stays disabled
        // until it lands. Polling the control's own text is what a reader does.
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const text = (await actionText(page)).trim()
          if (/^swap$/i.test(text)) return
          await page.waitForTimeout(1_000)
        }
        const text = (await actionText(page)).trim()
        ctx.assert(
          false,
          `${SWAP_AMOUNT} was typed into the amount field and after fifteen seconds the action ` +
            `control still says "${text}" rather than "Swap". ${found.pair.address} holds ` +
            `${found.reserves.reserve0}/${found.reserves.reserve1} and ${wallet.address} is ` +
            'funded, so the quote is the step that did not complete.',
        )
      })

      const hash = await ctx.step('PRESS SWAP, AND SIGN WHAT THE PAGE BUILT', async () => {
        await page.click('.xc-action', { timeout: config.timeoutMs })
        for (let attempt = 0; attempt < 30; attempt += 1) {
          if (wallet.sent.length > 0) break
          const problem = (await problemText(page)).trim()
          if (problem !== '') {
            ctx.assert(false, `the page refused its own swap: "${problem}"`)
          }
          await page.waitForTimeout(1_000)
        }
        ctx.assert(
          wallet.unexpected.length === 0,
          `the page asked this wallet for ${wallet.unexpected.join(', ')}. exchange-web calls five ` +
            'JSON-RPC methods and this wallet implements those five; a sixth means the product ' +
            'changed and the wallet has not been told.',
        )
        ctx.assert(
          wallet.sent.length === 1,
          `pressing Swap produced ${wallet.sent.length} signed transaction(s), and a native-in ` +
            'swap needs exactly one — there is nothing to approve when the input is the coin ' +
            'itself.',
        )
        return wallet.sent[0] as SentTransaction
      })

      await ctx.step('the router it was sent to is the pool’s own', async () => {
        // The router was never configured and never read off a page: it is whatever address the
        // product asked this wallet to sign for. Both checks below are what make that safe.
        const factory = addressAt(await ethCall(chain, hash.to, encodeCall('factory()')))
        ctx.assert(
          factory === found.pair.factory,
          `the page asked for a transaction to ${hash.to}, and that contract reports its factory ` +
            `as ${factory ?? 'nothing'} while the pool being traded reports ${found.pair.factory}. ` +
            'A swap routed through a different exchange would still succeed on chain.',
        )
        const wrapped = addressAt(await ethCall(chain, hash.to, encodeCall('WETH()')))
        const other = token === found.pair.token0 ? found.pair.token1 : found.pair.token0
        ctx.assert(
          wrapped === other,
          `${hash.to} wraps the native coin as ${wrapped ?? 'nothing'}, and the side of ` +
            `${found.pair.address} that is not ${token} is ${other}. The page sent the native coin ` +
            'into a pair that does not hold the router\'s wrapped token.',
        )
        ctx.assert(
          hash.value > 0n,
          `the transaction the page built carries no value, and a swap whose input is the native ` +
            'coin passes the input as `value`. `buildSwapTransaction` picked the wrong entry point ' +
            '— which does not revert, it swaps the wrong amount.',
        )
      })

      await ctx.step('THE CHAIN SAYS THE SWAP SUCCEEDED', async () => {
        // Five minutes, and the number is measured rather than picked. EMBER testnet's intervals
        // between blocks 18185 and 18200 on 2026-08-16 were 7, 15, 42, 79, 19, 13, 12, 14, 6, 59,
        // 28, 132, 16, 83 and 75 seconds: a mean near 40 and a tail past two. A two-minute poll
        // reported "in a mempool the chain is not mining" over a transaction that mined 83 seconds
        // later, which is a monitor calling a chain broken for running at its own speed. A chain
        // that has genuinely stopped still fails here — it just gets the length of its worst
        // observed gap, twice over, to prove it has not.
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const receipt = (await chainRpc(chain, 'eth_getTransactionReceipt', [hash.hash])) as {
            status?: unknown
            to?: unknown
            blockNumber?: unknown
          } | null
          if (receipt !== null && receipt !== undefined) {
            const status = quantityOf(receipt.status)
            ctx.assert(
              status === 1n,
              `${hash.hash} was mined and reverted (status ${String(receipt.status)}). The page ` +
                `built a call to ${hash.to} carrying ${hash.value} wei against ` +
                `${found.pair.address}; the router rejected it.`,
            )
            const to = typeof receipt.to === 'string' ? receipt.to.toLowerCase() : ''
            ctx.assert(
              to === hash.to,
              `the receipt for ${hash.hash} names ${to} as its recipient and the wallet signed for ` +
                `${hash.to}`,
            )
            return
          }
          await page.waitForTimeout(3_000)
        }
        ctx.assert(
          false,
          `${hash.hash} was accepted by the node five minutes ago and has no receipt. It is in a ` +
            'mempool the chain is not mining, which is a chain fault rather than an exchange one — ' +
            'and the page has already told the reader it was sent.',
        )
      })

      await ctx.step('the page tells the reader it was sent', async () => {
        // Last, and deliberately weakest. The chain has already answered; this is the courtesy the
        // product owes a reader who cannot read a receipt, and asserting it before the receipt
        // would let a green toast stand in for a mined transaction.
        const text = await page.evaluate(() => {
          const sent = document.querySelector('.xc-sent') as HTMLElement | null
          return sent === null ? '' : sent.innerText
        })
        ctx.assert(
          /sent/i.test(text),
          `${hash.hash} succeeded on chain ${chainIdNumber} and ${page.url()} shows the reader ` +
            `nothing where it renders "Swap sent." — the status line read "${text}"`,
        )
      })
    },
  })

/**
 * What the journey spends, and the floor it refuses to start below.
 *
 * A thousandth of a coin, which is small enough that the pool's price barely moves and large enough
 * that it is not dust the router refuses. The floor is a hundredth, leaving an order of magnitude
 * for gas: below it the journey skips naming the address rather than sending a transaction that
 * fails for want of a fee and reporting the exchange broken.
 */
const SWAP_AMOUNT = '0.001'
const MINIMUM_BALANCE = 10_000_000_000_000_000n

/** The Forge Exchange implementations, by scenario id. `journeys.ts` merges these into its registry. */
export const DEX_IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-DEX-01': poolPageAgainstChain,
  'BJ-DEX-02': swapThroughTheGateway,
}

export type { Implementation as DexImplementation }
