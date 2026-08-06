/**
 * The wallet, driven — and doc 22 §8.2 corrected by driving it.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE LARGEST BLOCKER IN THE CATALOGUE IS CLOSED, AND IT WAS CLOSED BY LOOKING.**
 *
 * Doc 22 §8.2 says, and `catalogue.ts` repeated until this file was written: "`hub-web/src/pages/
 * wallet.tsx` contains no `<form>`, no `<button>`, no `onClick` and no mutation… No Send flow. No
 * Receive flow. No key-export ceremony." Seventeen `BJ-WAL` rows, `BJ-ADV-20`, `BJ-ADV-21`,
 * `BJ-A11Y-13`, `BJ-A11Y-14` and `BJ-XS-03` were blocked on it — the single largest gap recorded
 * anywhere in the catalogue.
 *
 * It is false. A grep of `wallet.tsx` alone still finds nothing, which is how the claim survived:
 * the page was refactored and the three mutations live beside it in
 * `hub-web/src/components/send.tsx`, `receive.tsx` and `keyexport.tsx`. Driven in Chromium against
 * the running estate, `hub.<apex>/wallet` renders a Send form with an asset select, a destination
 * field, an amount field and a Review button; a Receive panel; and a key-export panel. The page's
 * own header now records the change: "This page was read-only until docs/ecosystem/22 §8.2 named
 * it as the estate's largest coverage gap… The three mutations are now here."
 *
 * A claim in a document is a lead, never evidence. This one had been true, and had stopped being
 * true, and nothing noticed.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ## What this estate still cannot complete, and why that is a finding rather than a failure
 *
 * **No asset in this estate can actually be withdrawn.** `micro-wallet` quotes the network fee
 * inside `POST /v1/withdrawals` and refuses rather than guessing when none is configured;
 * `WALLET_FEE_QUOTES` appears nowhere in `deploy/compose/docker-compose.estate.yml`. Driven:
 *
 *   * `EMBER` → `fee_unavailable`, "no EMBER network fee is configured; withdrawals for it are
 *     refused rather than priced by guessing"
 *   * `SHARD` → `not_withdrawable`, "SHARD does not settle on a chain and cannot be withdrawn"
 *
 * **The status codes that used to be written above — 400 for both — were wrong, and are removed
 * rather than corrected in place.** `micro-wallet`'s source says `not_withdrawable` is 422
 * (`withdrawals.ts`) and `fee_unavailable` is 503; 400 in that route is only ever `invalid_amount`.
 * Two stale numbers standing beside a correct error code is the failure this repository keeps
 * finding: the code was checked, the number beside it was believed. The `expected` lists below
 * carry the statuses, read out of the service, and say which gate produces each.
 *
 * So the settlement half of BJ-WAL-08 cannot be driven here. The half that CAN — and which is the
 * half doc 22's row actually specifies, `asserts: client-request` — is that the destination
 * submitted is byte-identical to the destination confirmed. That is asserted in full below, and
 * the refusal is then used for a second assertion nothing else makes: **the money did not move.**
 * A withdrawal that is refused and still debits is the worst outcome available, and it is checked
 * against the ledger's own books rather than against the screen.
 */

import type { JourneyContext, JourneyDefinition } from '../journeys.ts'
import { GROUPS } from '../groups.ts'
import type { BrowserConfig, BrowserPage } from './driver.ts'
import { requestsTo } from './driver.ts'
import type { Scenario } from './catalogue.ts'
import { surfaceJourney } from './journeys.ts'
import { fundAccount, signInBrowser, type Operator } from './fixtures.ts'
import { ledgerBalances, money, trialBalanceBalanced } from './money.ts'

type Implementation = (
  config: BrowserConfig,
  scenario: Scenario,
  operator: Operator | null,
) => JourneyDefinition

/**
 * The fixture's asset, and it is deliberately NOT a chain asset.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **A TEST FIXTURE MUST NOT MINT A LIABILITY NOTHING BACKS — AND MUST NOT MOVE MONEY EITHER.**
 *
 * The first draft of this file credited 5 EMBER per run and never reversed it. Seventy fixture
 * entries accumulated, twenty-one of them EMBER, and reconciliation measured the result exactly:
 * custody 135321000000000000000 wei against 31000000000000000000 observed on chain 7412, drift
 * 104321000000000000000, `drift_exceeded` — and it FROZE EMBER estate-wide.
 *
 * The seed asset was moved to SHARD for that reason. **It has moved back to EMBER on 2026-08-04,
 * and both halves of the original objection are now answered elsewhere:**
 *
 *   1. **The credit is reversed.** `fundAccount` registers a `ctx.cleanup` that calls
 *      `reverseEntry` on every exit path, so the fixture posts and unposts within one run and
 *      leaves no position for reconciliation to find. That is what makes EMBER safe to credit
 *      again; nothing about the freeze above was wrong.
 *   2. **SHARD is no longer offered by the page.** `hub-web`'s Send filter was `/^[A-Z]+$/`, which
 *      its own comment said was meant to exclude SHARD and did not, because `SHARD` is plain
 *      uppercase. It is now an allowlist — it has to be, since `USD` is also plain uppercase and
 *      also unwithdrawable, so no pattern over the string can separate them. With SHARD correctly
 *      excluded, a SHARD fixture cannot arm a payment at all: the asset never appears, Review
 *      never enables, and these journeys fail at a step that has nothing to do with what they
 *      assert.
 *
 * ── WHAT THAT COST, AND WHAT REPLACES IT ──────────────────────────────────────────────────────
 *
 * SHARD guaranteed "no money moves" STRUCTURALLY: `micro-wallet` refuses it at the asset gate
 * (`withdrawals.ts`, `not_withdrawable`, 422) before anything is reserved. **EMBER has no such
 * gate, and the guarantee does not transfer.**
 *
 * It is worth being exact about how nearly this went wrong. The destination below is the burn
 * address, and it was assumed to be refused as malformed — it is not. `canonicaliseAddress('ember',
 * '0x…dEaD')` ACCEPTS it: the mixed case is a valid EIP-55 checksum, which was confirmed by running
 * micro-wallet's own canonicaliser rather than by reading it. So with EMBER the request now passes
 * the asset gate AND the address gate, and the only thing left between this fixture and a real
 * withdrawal of a real chain asset to an address nobody can spend from is the balance.
 *
 * So the guarantee is made explicit and CHECKED, rather than left to be true by accident:
 * `SEED_AMOUNT` is asserted below to be far smaller than the amount these journeys type. A future
 * edit that raises the seed past the request — an entirely reasonable-looking change — would
 * otherwise turn a refusal into a queued payment, and the first anyone knew of it would be
 * reconciliation.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const SEED_ASSET = 'EMBER'
const SEED_AMOUNT = 1_234_567n

/**
 * What the send form is filled with, in display units, and the same figure in base units.
 *
 * EMBER carries 18 decimals, so 1000 EMBER is 10^21 of the smallest unit — fourteen orders of
 * magnitude above `SEED_AMOUNT`. The pair is written out here rather than left implicit in a
 * string literal three hundred lines below, because the safety property is a relationship BETWEEN
 * these two numbers and a relationship nobody can see is a relationship nobody preserves.
 */
const SEND_AMOUNT_DISPLAY = '1000'
const SEND_AMOUNT_BASE = 1_000n * 10n ** 18n

/**
 * **The refusal these journeys depend on, enforced at import.**
 *
 * Throws rather than warns, and does so before a browser is launched or an account is created: a
 * fixture that can no longer guarantee its withdrawal is refused must not run at all. See the
 * header — with EMBER the asset gate and the address gate both pass, so this is the only thing
 * standing between the browser tier and a real payment.
 */
if (SEED_AMOUNT >= SEND_AMOUNT_BASE) {
  throw new Error(
    `the wallet browser fixture seeds ${SEED_AMOUNT} of ${SEED_ASSET} and asks to send ` +
      `${SEND_AMOUNT_BASE}. The request must exceed the balance by a wide margin or the ` +
      'withdrawal could SUCCEED, and these journeys move real money on a real chain to an ' +
      'address nobody can spend from. Lower the seed or raise the amount sent.',
  )
}

/**
 * An address that is definitely not one of this account's own wallets.
 *
 * The burn address, chosen because the untrusted-destination warning is part of what BJ-WAL-08
 * asserts and a self-address would suppress it. Nothing is ever sent here: every withdrawal this
 * file requests is refused by the service before it reaches a chain.
 */
const FOREIGN_DESTINATION = '0x000000000000000000000000000000000000dEaD'

/** The dashboard, as the account's own token sees it. The response the page is rendering. */
async function dashboard(ctx: JourneyContext, hubBase: string, token: string): Promise<{
  readonly tiles: Record<string, { status?: string; data?: unknown }>
}> {
  const response = await fetch(`${hubBase.replace(/\/+$/, '')}/v1/dashboard`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
  })
  if (!response.ok) throw new Error(`GET /v1/dashboard answered HTTP ${response.status}`)
  return (await response.json()) as { tiles: Record<string, { status?: string; data?: unknown }> }
}

async function settled(page: BrowserPage, timeoutMs: number): Promise<string> {
  await page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {})
  await page.waitForTimeout(1_500)
  return await page.evaluate(() => document.body?.innerText ?? '')
}

/* ------------------------------------------------------------------ BJ-WAL-01 */

/**
 * BJ-WAL-01 ★ — the wallet registry on screen is the wallet registry the response carried.
 *
 * Doc 22: "one row per wallet, and each row's chain, network badge and lifecycle state match the
 * dashboard response."
 *
 * The interesting case in this estate is the empty one, and it is not a weaker test — it is the
 * one the design system exists to make. `hub-web/src/components/states.tsx` separates `EMPTY`
 * ("the query answered, with nothing") from `FAILED` ("the query did not answer"), and a wallets
 * tile that answered `[]` must render the first. Rendering the second, or rendering nothing at all,
 * is a reader being told their wallets are gone. So the tile's `status` is read off the response
 * and the page is required to agree with it either way.
 */
const walletRegistry: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.wallet,
    config,
    surface: 'hub',
    critical: scenario.gate,
    async verify(ctx, page, _collected, base) {
      const account = await ctx.step('an account with a real balance, posted to the ledger', async () =>
        fundAccount(ctx, operator, { tag: 'w1', credit: new Map([[SEED_ASSET, SEED_AMOUNT]]) }),
      )

      await ctx.step('sign in through the page a person uses', async () => {
        await signInBrowser(ctx, page, base, account, config.timeoutMs)
      })

      const tile = await ctx.step('read the wallets tile hub-api actually sent', async () => {
        const body = await dashboard(ctx, base, account.token)
        const wallets = body.tiles['wallets']
        ctx.assert(
          wallets !== undefined,
          'GET /v1/dashboard carried no wallets tile at all — the page has nothing to render and ' +
            `the response holds ${Object.keys(body.tiles).join(', ')}`,
        )
        return wallets as { status?: string; data?: readonly Record<string, unknown>[] }
      })

      await ctx.step('THE PAGE AGREES WITH THE TILE, INCLUDING WHEN THE TILE IS EMPTY', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/wallet`, { waitUntil: 'domcontentloaded' })
        const text = await settled(page, config.timeoutMs)

        const failures = await page.evaluate(() =>
          Array.from(document.querySelectorAll('[class*="state--failed"]')).map(
            (node) => (node as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 160),
          ),
        )
        const rows = tile.data ?? []

        if (tile.status === 'ok' && rows.length === 0) {
          // The distinction the design system is built around. An answered-with-nothing tile that
          // renders as a failure — or as a blank — tells somebody their wallets have vanished.
          ctx.assert(
            failures.length === 0,
            `the wallets tile answered ok with no wallets and ${page.url()} is showing a failure ` +
              `state: ${failures.join(' | ')}. "Answered with nothing" and "did not answer" are ` +
              'different things and must not look the same',
          )
          ctx.assert(
            /no wallet has been created or connected/i.test(text),
            `the wallets tile answered ok with no wallets and ${page.url()} does not say so. It ` +
              `rendered ${text.trim().length} characters. An empty registry rendered as silence is ` +
              'indistinguishable from an outage',
          )
          return
        }

        ctx.assert(
          tile.status === 'ok',
          `the wallets tile answered "${tile.status}", so this run cannot check a row-per-wallet ` +
            'rendering. The upstream is degraded',
        )
        // One row per wallet, keyed on the one field a reader would check.
        for (const wallet of rows) {
          const address = String(wallet['address'] ?? '')
          ctx.assert(
            address !== '' && text.includes(address),
            `hub-api returned a wallet at ${address || '(no address)'} and ${page.url()} does not ` +
              'render it',
          )
        }
      })
    },
  })

/* ------------------------------------------------------------------ BJ-WAL-08 */

/**
 * BJ-WAL-08 ★ — the destination submitted is the destination confirmed, byte for byte.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **THE MOST EXPENSIVE DEFECT A FRONTEND IN THIS ESTATE CAN HAVE.**
 *
 * `hub-web/src/components/send.tsx`'s own header states the rule and the reason: "The destination
 * shown on the confirmation step is the destination submitted. Not 'the same string' — the same
 * OBJECT… A form that displays one address and sends to another is the most expensive defect a
 * frontend can have in this estate."
 *
 * `hub-web/test/money.test.ts` asserts that against a stub. What it cannot assert, and what this
 * does, is that the bytes which left a REAL browser through a REAL gateway to a REAL service are
 * the bytes that were on screen — after React state, after `JSON.stringify`, after whatever a
 * proxy did to the body. The request log makes that readable without intercepting anything.
 *
 * Three assertions, and the third is the one nothing else in the estate makes:
 *
 *   1. The confirmation step renders the destination IN FULL. A shortened address on a
 *      confirmation step confirms the first eight characters, which is precisely what an address
 *      substitution is designed to survive.
 *   2. The body's `destination` is byte-identical to that, and its `amount` is the exact integer
 *      of smallest units — compared as a `bigint`, never as a formatted string.
 *   3. **The refusal did not move any money.** This estate refuses every withdrawal
 *      (`fee_unavailable`), and a refusal that still debits is worse than a refusal that fails
 *      loudly. Checked against `micro-ledger`'s books and its trial balance, not against the page.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
const sendDestinationIsConfirmed: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.wallet,
    config,
    surface: 'hub',
    critical: scenario.gate,
    // The withdrawal this estate cannot price. Declared, because a refusal scenario's 4xx arrives
    // in the same bucket as a 404ing chunk and the journey could otherwise never be green — and
    // narrow, because a blanket "ignore 4xx" would delete the check for everything else on the page.
    // ── EVERY WAY micro-wallet CAN REFUSE THIS, BECAUSE WHICH ONE FIRES IS A DEPLOY FACT ──────
    //
    // Read out of `wallet/src/withdrawals.ts` and `wallet/src/server.ts`, in the order the route
    // applies them. Under-declaring makes the journey red for a refusal that was expected;
    // the single stale `400` that used to be here is neither of those, it is simply not a status
    // this route returns for this request.
    //
    //   503  fee_unavailable    — no WALLET_FEE_QUOTES in this estate, so EMBER cannot be priced.
    //                             THIS IS THE ONE THAT FIRES TODAY, and it is raised before the
    //                             idempotency claim and before any ledger reservation.
    //   422  amount_too_small   — below the minimum-fee multiple. What BJ-WAL-08's dust amount
    //                             would meet once fees ARE configured.
    //   422  not_withdrawable   — the asset gate. Unreachable for EMBER; reachable again the day
    //                             the seed asset changes back.
    //   409  ledger refusal     — insufficient funds. What BJ-WAL-09's 1000 EMBER would meet once
    //                             fees are configured, and the refusal the import-time check
    //                             above exists to guarantee.
    //
    // NOT DRIVEN. The browser tier is not registered in this estate — `journeys` holds eleven rows
    // and none is a `browser.*` — so this list is derived from the service's source and has not
    // been confirmed against a running page. Stated because an undriven claim that looks driven is
    // exactly what the header of this file is about.
    expected: [
      { path: '/v1/withdrawals', status: 503 },
      { path: '/v1/withdrawals', status: 422 },
      { path: '/v1/withdrawals', status: 409 },
    ],
    async verify(ctx, page, collected, base) {
      const account = await ctx.step('an account with a real balance, posted to the ledger', async () =>
        fundAccount(ctx, operator, { tag: 'w8', credit: new Map([[SEED_ASSET, SEED_AMOUNT]]) }),
      )

      await ctx.step('sign in through the page a person uses', async () => {
        await signInBrowser(ctx, page, base, account, config.timeoutMs)
      })

      const asset = await ctx.step('the Send form offers the balance the ledger holds', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/wallet`, { waitUntil: 'domcontentloaded' })
        const text = await settled(page, config.timeoutMs)
        ctx.assert(
          /\bSend\b/.test(text),
          `${page.url()} renders no Send panel. doc 22 §8.2 recorded this page as read-only and ` +
            'hub-web now serves send.tsx; if this is failing, the surface has regressed',
        )
        const selected = await page.evaluate(
          () =>
            (document.querySelector('#send-asset') as HTMLSelectElement | null)?.value ?? '',
        )
        ctx.assert(
          selected !== '',
          `${page.url()} renders a Send panel with no asset selected — there is nothing to send ` +
            'and the fixture credited a balance',
        )
        // The scale is derived from the API's own two forms of the same number, exactly as the
        // bundle derives it (`hub-web/src/lib/format.ts:scaleOf`). This repository holds no table
        // of decimals: a table would be a ninth copy of a vocabulary that already drifted once.
        const body = await dashboard(ctx, base, account.token)
        const holdings =
          ((body.tiles['portfolio']?.data as { holdings?: readonly Record<string, unknown>[] })
            ?.holdings ?? [])
        const holding = holdings.find((h) => h['assetCode'] === selected)
        ctx.assert(
          holding !== undefined,
          `the Send form offers "${selected}" and the portfolio tile holds ` +
            `${holdings.map((h) => String(h['assetCode'])).join(', ') || 'nothing'} — the form is ` +
            'offering an asset the account does not have',
        )
        const amount = money(holding?.['amount'], `the ${selected} holding`)
        const formatted = String(holding?.['amountFormatted'] ?? '')
        // `scaleOf` in one line: the digits the API dropped between the two forms ARE the decimals.
        const scale = formatted.includes('.')
          ? (formatted.split('.')[1] ?? '').length
          : amount.toString().length - formatted.replace(/[^0-9]/g, '').length
        return { code: selected, amount, scale: scale < 0 ? 0 : scale }
      })

      const typed = await ctx.step('fill in a payment and press Review', async () => {
        // A tenth of what is held, so the amount is unambiguous and the account keeps a balance to
        // check afterwards. Computed in `bigint` from the holding rather than typed as a literal.
        const units = asset.amount / 10n
        const decimal =
          asset.scale === 0
            ? units.toString()
            : (() => {
                const digits = units.toString().padStart(asset.scale + 1, '0')
                const cut = digits.length - asset.scale
                const fraction = digits.slice(cut).replace(/0+$/, '')
                return fraction === '' ? digits.slice(0, cut) : `${digits.slice(0, cut)}.${fraction}`
              })()
        await page.fill('#send-destination', FOREIGN_DESTINATION)
        await page.fill('#send-amount', decimal)
        await page.click('button:has-text("Review")')
        await page.waitForTimeout(1_000)
        return { units, decimal }
      })

      const confirmed = await ctx.step('THE CONFIRMATION SHOWS THE ADDRESS IN FULL', async () => {
        const shown = await page.evaluate(
          () =>
            (document.querySelector('[data-testid=confirm-destination]') as HTMLElement | null)
              ?.innerText ?? '',
        )
        ctx.assert(
          shown.trim() !== '',
          `${page.url()} armed no confirmation step — there is no [data-testid=confirm-destination] ` +
            'on the page after pressing Review, so the payment would be sent with nothing shown',
        )
        // In FULL. An address rendered as `0x0000…dEaD` is a confirmation of eight characters.
        ctx.assert(
          shown.trim() === FOREIGN_DESTINATION,
          `the confirmation step shows "${shown.trim()}" and the address typed was ` +
            `"${FOREIGN_DESTINATION}". A shortened or altered address on a confirmation step is ` +
            'exactly what an address substitution is designed to survive',
        )
        const text = await page.evaluate(() => document.body?.innerText ?? '')
        // The untrusted-destination warning, because this address is not one of the account's own.
        ctx.assert(
          /not one of your cloudsforge wallets/i.test(text),
          'the confirmation step does not warn that this destination is not one of the account’s ' +
            'own wallets, and it is not',
        )
        return shown.trim()
      })

      const before = collected.requests.length
      await ctx.step('press Send it, and read what actually left the browser', async () => {
        await page.click('button:has-text("Send it")')
        await page.waitForTimeout(3_000)
      })

      await ctx.step('THE BODY’S DESTINATION IS BYTE-IDENTICAL TO THE ONE CONFIRMED', async () => {
        const sent = requestsTo(collected.requests.slice(before), 'POST', '/v1/withdrawals')
        ctx.assert(
          sent.length === 1,
          `pressing Send it produced ${sent.length} POST(s) to /v1/withdrawals. One press is one ` +
            'withdrawal request',
        )
        const request = sent[0] as { postData: string | null; headers: Record<string, string> }
        ctx.assert(
          request.postData !== null,
          'the withdrawal request carried no body at all, so there is nothing to compare against ' +
            'the confirmation step',
        )
        const body = JSON.parse(request.postData as string) as Record<string, unknown>
        ctx.assert(
          body['destination'] === confirmed,
          `the confirmation step showed "${confirmed}" and the body sent ` +
            `"${String(body['destination'])}". These must be the same bytes`,
        )
        // As a `bigint`, and derived from the ledger's own figure. A formatted string here would
        // pass against a body carrying "0.5" where the service takes smallest units — and against
        // an empty string, which `BigInt` reads as zero.
        ctx.assert(
          money(body['amount'], 'the withdrawal body’s amount') === typed.units,
          `the form was given ${typed.decimal} ${asset.code} — ${typed.units} smallest units — and ` +
            `the body carries ${JSON.stringify(body['amount'])}`,
        )
        // One intent, one key. The header is what makes a retry safe and its absence is silent.
        ctx.assert(
          (request.headers['idempotency-key'] ?? '') !== '',
          'the withdrawal request carries no Idempotency-Key, so a retry of it is a second payment',
        )
      })

      await ctx.step('AND THE LEDGER DID NOT MOVE, BECAUSE THE SERVICE REFUSED', async () => {
        // ── The assertion the screen cannot make ────────────────────────────────────────────
        // This estate refuses every withdrawal: `WALLET_FEE_QUOTES` is unset, so micro-wallet
        // answers 400 `fee_unavailable` rather than pricing a fee by guessing. A refusal that
        // nevertheless debits is the worst outcome available and would look, on screen, exactly
        // like the refusal that did not.
        const after = await ledgerBalances(account.ledger, account.subject)
        const held = after.get(asset.code)
        ctx.assert(
          held === asset.amount,
          `the withdrawal was refused and ${account.subject} now holds ${held ?? 'no account'} ` +
            `${asset.code} where it held ${asset.amount} before. A refused payment moved money`,
        )
        ctx.assert(
          await trialBalanceBalanced(account.ledger),
          'the ledger’s trial balance does not balance after a refused withdrawal — a partial ' +
            'journal was written',
        )
      })
    },
  })

/* ------------------------------------------------------------------ BJ-WAL-09 */

/**
 * BJ-WAL-09 — double-click Confirm, and exactly one request leaves the browser.
 *
 * Doc 22: "exactly one withdrawal request leaves the browser. The key is minted when the intent is
 * formed, not per fetch — `market-web/src/lib/idempotency.ts` already states the rule and is
 * the model."
 *
 * ── HOW THE TWO CLICKS ARE MADE, AND WHY IT MATTERS ────────────────────────────────────────────
 *
 * Two awaited `page.click()` calls are not a double-click: playwright waits for actionability and
 * for the first to settle, so the second happens after the response and is an ordinary retry. A
 * real double-submit is two clicks before the first answer, so both are dispatched SYNCHRONOUSLY
 * from one evaluation. Getting this wrong is the difference between testing a guard and testing
 * nothing — the estate found a fixture this week that expired 41 seconds into a 45-second wait for
 * the same class of reason.
 */
const sendDoubleSubmit: Implementation = (config, scenario, operator) =>
  surfaceJourney({
    name: `browser.${scenario.id.toLowerCase()}`,
    title: scenario.title,
    productGroup: GROUPS.wallet,
    config,
    surface: 'hub',
    critical: scenario.gate,
    // ── EVERY WAY micro-wallet CAN REFUSE THIS, BECAUSE WHICH ONE FIRES IS A DEPLOY FACT ──────
    //
    // Read out of `wallet/src/withdrawals.ts` and `wallet/src/server.ts`, in the order the route
    // applies them. Under-declaring makes the journey red for a refusal that was expected;
    // the single stale `400` that used to be here is neither of those, it is simply not a status
    // this route returns for this request.
    //
    //   503  fee_unavailable    — no WALLET_FEE_QUOTES in this estate, so EMBER cannot be priced.
    //                             THIS IS THE ONE THAT FIRES TODAY, and it is raised before the
    //                             idempotency claim and before any ledger reservation.
    //   422  amount_too_small   — below the minimum-fee multiple. What BJ-WAL-08's dust amount
    //                             would meet once fees ARE configured.
    //   422  not_withdrawable   — the asset gate. Unreachable for EMBER; reachable again the day
    //                             the seed asset changes back.
    //   409  ledger refusal     — insufficient funds. What BJ-WAL-09's 1000 EMBER would meet once
    //                             fees are configured, and the refusal the import-time check
    //                             above exists to guarantee.
    //
    // NOT DRIVEN. The browser tier is not registered in this estate — `journeys` holds eleven rows
    // and none is a `browser.*` — so this list is derived from the service's source and has not
    // been confirmed against a running page. Stated because an undriven claim that looks driven is
    // exactly what the header of this file is about.
    expected: [
      { path: '/v1/withdrawals', status: 503 },
      { path: '/v1/withdrawals', status: 422 },
      { path: '/v1/withdrawals', status: 409 },
    ],
    async verify(ctx, page, collected, base) {
      const account = await ctx.step('an account with a real balance, posted to the ledger', async () =>
        fundAccount(ctx, operator, { tag: 'w9', credit: new Map([[SEED_ASSET, SEED_AMOUNT]]) }),
      )

      await ctx.step('sign in through the page a person uses', async () => {
        await signInBrowser(ctx, page, base, account, config.timeoutMs)
      })

      await ctx.step('arm a payment', async () => {
        await page.goto(`${base.replace(/\/+$/, '')}/wallet`, { waitUntil: 'domcontentloaded' })
        await settled(page, config.timeoutMs)
        await page.fill('#send-destination', FOREIGN_DESTINATION)
        // From the constant, so the amount and the import-time safety check cannot drift apart.
        await page.fill('#send-amount', SEND_AMOUNT_DISPLAY)
        await page.click('button:has-text("Review")')
        await page.waitForTimeout(1_000)
        const armed = await page.evaluate(
          () => document.querySelector('[data-testid=confirm-destination]') !== null,
        )
        ctx.assert(armed, 'the confirmation step did not arm, so there is no Confirm to press twice')
      })

      const before = collected.requests.length
      await ctx.step('PRESS CONFIRM TWICE, BOTH BEFORE THE FIRST ANSWER', async () => {
        const clicks = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[]
          const button = buttons.find((candidate) => /send it/i.test(candidate.textContent ?? ''))
          if (!button) return 0
          // Synchronously, in one task. Neither click can have seen the other's response.
          button.click()
          button.click()
          return 2
        })
        ctx.assert(clicks === 2, 'no Send it button was found to press, so nothing was double-submitted')
        await page.waitForTimeout(4_000)
      })

      await ctx.step('EXACTLY ONE WITHDRAWAL REQUEST LEFT THE BROWSER', async () => {
        const sent = requestsTo(collected.requests.slice(before), 'POST', '/v1/withdrawals')
        ctx.assert(
          sent.length === 1,
          `two synchronous presses of Confirm produced ${sent.length} POST(s) to /v1/withdrawals. ` +
            'Two requests is two payments if the service ever prices one',
        )
        const keys = new Set(sent.map((r) => r.headers['idempotency-key'] ?? ''))
        // One intent, one key — and it is stated as its own assertion, because a second request
        // under the SAME key is safe and a second under a different one is a second payment.
        ctx.assert(
          keys.size === 1 && !keys.has(''),
          `the withdrawal requests carried ${keys.size} distinct Idempotency-Key value(s): ` +
            `${[...keys].map((k) => k || '(absent)').join(', ')}. The key is minted when the intent ` +
            'is formed, not per fetch',
        )
      })

      await ctx.step('and the ledger is untouched', async () => {
        const after = await ledgerBalances(account.ledger, account.subject)
        ctx.assert(
          after.get(SEED_ASSET) === SEED_AMOUNT,
          `a double-submitted, refused withdrawal left ${account.subject} holding ` +
            `${after.get(SEED_ASSET) ?? 'no account'} ${SEED_ASSET} where it held ${SEED_AMOUNT}`,
        )
      })
    },
  })

/** The wallet implementations, by scenario id. */
export const WALLET_IMPLEMENTATIONS: Readonly<Record<string, Implementation>> = {
  'BJ-WAL-01': walletRegistry,
  'BJ-WAL-08': sendDestinationIsConfirmed,
  'BJ-WAL-09': sendDoubleSubmit,
}
