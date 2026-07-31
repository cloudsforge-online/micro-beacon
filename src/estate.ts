/**
 * The journeys this build runs against the estate.
 *
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 * **ONLY JOURNEYS THAT ACTUALLY EXERCISE SOMETHING ARE DECLARED HERE.**
 *
 * The critical-path set in 13-operational-model.md:435 is nine journeys — register, sign in, SSO
 * handoff, deposit, convert, spend, withdraw, mint deploy, market purchase. Five of them move
 * money across a chain, and the services that would do so are not deployed
 * (18-build-status.md:43: "nothing is deployed"). So they are **absent** rather than declared and
 * left to skip.
 *
 * That is a deliberate choice and it is the safe one in both directions:
 *
 *   * A declared-but-skipping critical journey would refuse every release for ever, because a skip
 *     is not a pass. The gate would be switched off within a week, which is how a gate dies.
 *   * A declared-but-faked journey — one that asserts nothing and returns — would report green and
 *     make the gate a lie, which is worse than not having one.
 *
 * The README lists which of the nine exist and which do not, so the gap is a stated fact rather
 * than an absence somebody has to notice. Adding one is this file plus one row.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Every route below was read out of the service that serves it, not out of a document:
 * `identity/src/server.ts:655` (`/auth/register`), `:691` (`/auth/login`), `:891` (`/auth/me`),
 * `:1035` (`/auth/handoff`), `:1043` (`/auth/handoff/redeem`), `market/src/server.ts:618`
 * (`/v1/listings`), `worlds/src/server.ts:467` (`/v1/titles`). Two of the estate's own
 * architecture documents were found stale while this repository was being written, so a route
 * taken from prose is a route that has not been checked.
 */

import { randomUUID } from 'node:crypto'
import type { JourneyContext, JourneyDefinition } from './journeys.ts'

/** Product groups, as the public page names them. Never a service name. */
export const GROUPS = {
  account: 'Account',
  wallet: 'Wallet',
  market: 'Market',
  worlds: 'Worlds',
  network: 'Network',
} as const

interface Json {
  readonly [key: string]: unknown
}

/**
 * A JSON call inside a journey step.
 *
 * Every request carries its own deadline. The journey has one too, but a journey deadline that
 * fires tells you only that the whole scenario was slow; a per-call one tells you which call was.
 */
async function call(
  ctx: JourneyContext,
  url: string,
  init: { method?: string; body?: unknown; token?: string; deadlineMs?: number } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  if (init.token) headers['authorization'] = `Bearer ${init.token}`

  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(init.deadlineMs ?? 10_000)])
  const response = await fetch(url, {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal,
    redirect: 'manual',
  })
  const text = await response.text()
  let body: Json = {}
  if (text.length > 0) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (typeof parsed === 'object' && parsed !== null) body = parsed as Json
    } catch {
      // A non-JSON body from a JSON route is a finding, not a crash. The status is still the
      // thing the assertion is about, and the empty body makes the assertion fail with a message
      // about what was expected rather than with a SyntaxError from the harness.
      body = {}
    }
  }
  return { status: response.status, body }
}

function stringField(body: Json, ...path: string[]): string | null {
  let cursor: unknown = body
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return null
    cursor = (cursor as Record<string, unknown>)[key]
  }
  return typeof cursor === 'string' ? cursor : null
}

/**
 * A throwaway account, per run.
 *
 * **Never a real user and never one shared between journeys.** Two journeys sharing an account
 * would move each other's balance and each other's session, and the flake that produces is
 * indistinguishable from the outage it would be reported as. The address is namespaced so the rows
 * can be found and pruned — identity has no account-deletion route, which is a fact about the
 * estate rather than about this harness, and it is said here because a monitor that quietly
 * accumulates rows in a production table gets switched off by whoever finds out the hard way.
 *
 *     delete from users where email like 'beacon+%';
 */
function throwaway(): { email: string; handle: string; password: string } {
  const id = randomUUID().replace(/-/g, '').slice(0, 16)
  return {
    email: `beacon+${id}@beacon.test`,
    handle: `bx_${id.slice(0, 14)}`,
    // Generated per run and written nowhere. It is a credential for an account that owns nothing,
    // and it still never reaches a log: the telemetry redactor drops `password` at any depth.
    password: `Bx-${randomUUID().slice(0, 20)}`,
  }
}

export const IDENTITY_REGISTER: JourneyDefinition = {
  name: 'identity.register',
  title: 'A new account can be created and recognised',
  productGroup: GROUPS.account,
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    const token = await ctx.step('register', async () => {
      const result = await call(ctx, `${identity}/auth/register`, {
        method: 'POST',
        body: { email: account.email, handle: account.handle, password: account.password },
      })
      if (result.status === 429) {
        // The estate protecting itself is not the estate being broken. Identity rate-limits
        // registration, and recording a limit hit as a failure would open an incident against a
        // control that is working.
        ctx.skip('registration is rate limited')
      }
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
      const accessToken = stringField(result.body, 'accessToken') ?? stringField(result.body, 'tokens', 'accessToken')
      ctx.assert(accessToken !== null, 'registration returned no access token')
      return accessToken as string
    })

    await ctx.step('read the account back from the token', async () => {
      const result = await call(ctx, `${identity}/auth/me`, { token })
      ctx.assert(result.status === 200, `expected 200 from /auth/me, got ${result.status}`)
    })

    await ctx.step('an unauthenticated read is refused', async () => {
      const result = await call(ctx, `${identity}/auth/me`)
      // Asserted, not assumed. A monitor that only ever checks the happy path cannot tell an
      // authenticated endpoint from an open one, and the day that regresses is the day nobody
      // notices.
      ctx.assert(result.status === 401, `expected 401 without a token, got ${result.status}`)
    })
  },
}

export const IDENTITY_SIGNIN: JourneyDefinition = {
  name: 'identity.signin',
  title: 'An existing account can sign in',
  productGroup: GROUPS.account,
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    await ctx.step('register the account this run will sign into', async () => {
      const result = await call(ctx, `${identity}/auth/register`, {
        method: 'POST',
        body: { email: account.email, handle: account.handle, password: account.password },
      })
      if (result.status === 429) ctx.skip('registration is rate limited')
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
    })

    await ctx.step('sign in', async () => {
      const result = await call(ctx, `${identity}/auth/login`, {
        method: 'POST',
        body: { email: account.email, password: account.password },
      })
      if (result.status === 429) ctx.skip('login is rate limited')
      ctx.assert(result.status === 200, `expected 200 from /auth/login, got ${result.status}`)
      ctx.assert(
        stringField(result.body, 'accessToken') !== null ||
          stringField(result.body, 'tokens', 'accessToken') !== null,
        'login returned no access token',
      )
    })

    await ctx.step('the wrong password is refused', async () => {
      const result = await call(ctx, `${identity}/auth/login`, {
        method: 'POST',
        body: { email: account.email, password: `${account.password}-wrong` },
      })
      if (result.status === 429) ctx.skip('login is rate limited')
      ctx.assert(result.status === 401, `expected 401 for a wrong password, got ${result.status}`)
    })
  },
}

export const IDENTITY_HANDOFF: JourneyDefinition = {
  name: 'identity.handoff',
  title: 'One account signs into everything, once',
  productGroup: GROUPS.account,
  critical: true,
  async run(ctx) {
    const identity = ctx.target('identity')
    const account = throwaway()

    const token = await ctx.step('register', async () => {
      const result = await call(ctx, `${identity}/auth/register`, {
        method: 'POST',
        body: { email: account.email, handle: account.handle, password: account.password },
      })
      if (result.status === 429) ctx.skip('registration is rate limited')
      ctx.assert(result.status === 201, `expected 201 from /auth/register, got ${result.status}`)
      const accessToken =
        stringField(result.body, 'accessToken') ?? stringField(result.body, 'tokens', 'accessToken')
      ctx.assert(accessToken !== null, 'registration returned no access token')
      return accessToken as string
    })

    const code = await ctx.step('mint a handoff code', async () => {
      const result = await call(ctx, `${identity}/auth/handoff`, { method: 'POST', token, body: {} })
      ctx.assert(result.status === 201 || result.status === 200, `expected 2xx from /auth/handoff, got ${result.status}`)
      const value = stringField(result.body, 'code')
      ctx.assert(value !== null, 'handoff returned no code')
      return value as string
    })

    await ctx.step('redeem it in the other product', async () => {
      const result = await call(ctx, `${identity}/auth/handoff/redeem`, {
        method: 'POST',
        body: { code },
      })
      ctx.assert(result.status === 200, `expected 200 from redeem, got ${result.status}`)
    })

    await ctx.step('the code is single use', async () => {
      const result = await call(ctx, `${identity}/auth/handoff/redeem`, {
        method: 'POST',
        body: { code },
      })
      // THE security property of the handoff, and the reason this journey is critical rather than
      // convenient. A replayable code is a session anyone who saw one URL can take.
      ctx.assert(result.status >= 400, `a redeemed handoff code was accepted twice (${result.status})`)
    })
  },
}

export const MARKET_CATALOGUE: JourneyDefinition = {
  name: 'market.catalogue',
  title: 'The market catalogue can be read',
  productGroup: GROUPS.market,
  critical: false,
  async run(ctx) {
    const market = ctx.target('market')
    await ctx.step('read the listings', async () => {
      const result = await call(ctx, `${market}/v1/listings`)
      ctx.assert(result.status === 200, `expected 200 from /v1/listings, got ${result.status}`)
      ctx.assert(Array.isArray(result.body['listings']), '/v1/listings returned no listings array')
    })
    await ctx.step('read the collections', async () => {
      const result = await call(ctx, `${market}/v1/collections`)
      ctx.assert(result.status === 200, `expected 200 from /v1/collections, got ${result.status}`)
    })
  },
}

export const WORLDS_REGISTRY: JourneyDefinition = {
  name: 'worlds.registry',
  title: 'The title registry answers, so a launcher can list games',
  productGroup: GROUPS.worlds,
  critical: false,
  async run(ctx) {
    const worlds = ctx.target('worlds')
    await ctx.step('read the title registry', async () => {
      const result = await call(ctx, `${worlds}/v1/titles`)
      ctx.assert(result.status === 200, `expected 200 from /v1/titles, got ${result.status}`)
      ctx.assert(Array.isArray(result.body['titles']), '/v1/titles returned no titles array')
    })
  },
}

/**
 * Every configured address answers `/livez`.
 *
 * Not a substitute for a probe — a probe checks one target every thirty seconds and this runs
 * every five minutes — but it is the one journey that fails when the *estate* is missing rather
 * than when a *service* is. A deploy that brought up eight of nine containers passes every
 * per-service probe that exists and fails this.
 */
export const ESTATE_REACHABLE: JourneyDefinition = {
  name: 'estate.reachable',
  title: 'Every service the estate is configured to have is answering',
  productGroup: GROUPS.network,
  critical: true,
  async run(ctx) {
    // Ordered so a failure names the same service every time. An unordered scan reports whichever
    // one happened to be checked first, which makes two runs of the same outage look different.
    for (const name of [...ESTATE_SERVICES].sort()) {
      let base: string
      try {
        base = ctx.target(name)
      } catch {
        // Not configured in this deployment. `ctx.target` throws a skip, and catching it here
        // rather than letting it end the journey is what lets a partial estate still prove the
        // part it does run.
        continue
      }
      await ctx.step(`${name} is answering`, async () => {
        const result = await call(ctx, `${base}/livez`, { deadlineMs: 5_000 })
        ctx.assert(result.status === 200, `${name} answered ${result.status} on /livez`)
      })
    }
  },
}

/** The services `estate.reachable` will look for, if `BEACON_TARGETS` names them. */
export const ESTATE_SERVICES: readonly string[] = [
  'identity',
  'ledger',
  'wallet',
  'billing',
  'market',
  'mint',
  'worlds',
  'notify',
  'hub-api',
]

/** The registry this build ships. `index.ts` syncs it into the table at boot. */
export const JOURNEYS: readonly JourneyDefinition[] = [
  IDENTITY_REGISTER,
  IDENTITY_SIGNIN,
  IDENTITY_HANDOFF,
  MARKET_CATALOGUE,
  WORLDS_REGISTRY,
  ESTATE_REACHABLE,
]

/** Re-exported so a caller can construct one in a test without importing the internals. */
export type { JourneyContext }
