# `cloudsforge-beacon`

[![ci](https://github.com/cloudsforge-online/micro-beacon/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsforge-online/micro-beacon/actions/workflows/ci.yml) [![TypeScript](https://img.shields.io/badge/TypeScript-strict%20ESM-3178C6?logo=typescript&logoColor=white)](./tsconfig.base.json) [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?logo=nodedotjs&logoColor=white)](./package.json) [![tests](https://img.shields.io/badge/tests-real%20Postgres-4169E1?logo=postgresql&logoColor=white)](./.github/workflows/ci.yml)

Synthetic probes, user journeys, incidents, SLOs and error budgets, conformance runs, Prometheus
metrics, and the redacted public status projection that `status-web` renders.

Design authority: [`ecosystem/13-operational-model.md`](https://github.com/cloudsforge-online/micro-docs/blob/main/ecosystem/13-operational-model.md)

**It is the release gate (AD-04).** A release is promoted only if Beacon says the estate's journeys
pass and the error budget allows it. That decision is an endpoint and a CLI exit code, not a
dashboard someone reads.

```
GET  /v1/gate?release=v1.4.2          →  { "decision": "refuse", "promote": false, "reasons": [ … ] }
beacon gate --release v1.4.2 --url …  →  exit 0 promote · 1 refuse · 2 could not ask
```

---

## 1. What the gate decides

**Whether a release manifest may be promoted.** Nothing else. It reads five things and answers one
of three verdicts with machine-readable reason codes.

| Verdict | Meaning | Exit code |
| --- | --- | --- |
| `promote` | Nothing blocks. | 0 |
| `promote_with_override` | Something blocked and a recorded, attributed, expiring override waived it. **Never reported as a plain `promote`** — a release that only shipped because somebody waived something must say so in its own record. | 0 |
| `refuse` | Something blocks, or something could not be determined. | 1 |

A fourth outcome exists only at the CLI: **exit 2, "could not ask"** — Beacon unreachable, bad
arguments, an unparseable answer. It blocks too. Two non-zero codes rather than one because "the
estate is not fit to ship" and "the gate is broken" have different fixes and different people, but
neither of them is a release.

### What makes it refuse

| Reason code | Determinacy | What it means |
| --- | --- | --- |
| `journey_failing` | known | A critical journey's most recent scheduled run was a `fail` or an `error`. |
| `journey_skipped` | known | Its most recent run was a **skip**. A skip is not a pass. |
| `journey_muted` | known | Any journey is muted, critical or not. A muted journey is not a passing journey; it is an unmeasured one, and the count must be zero at a gate. |
| `journey_recent_failure` | known | A red run appears within the last three, even though the latest is green. |
| `error_budget_exhausted` | known | An SLO's 28-day budget is spent. 100% consumed is a change freeze on that service, and this is the freeze rather than a paragraph describing one. |
| `conformance_breaking` | known | The recorded corpus reports a breaking difference. Benign differences do not block — a gate that fires on every routine release gets removed. |
| `incident_open` | known | A SEV1 or SEV2 is open. SEV3 and SEV4 do not block, so the estate can still ship its own remedy. |
| `journey_never_run` | **unknown** | A critical journey has no recorded scheduled run at all. |
| `journey_stale` | **unknown** | Its last run is older than the freshness horizon. **This is what catches a dead scheduler** — a journey that stopped running reports its last status for ever, and nothing else in the system notices. |
| `journey_insufficient_history` | **unknown** | Fewer than three recorded runs, however green they are. |
| `error_budget_no_data` | **unknown** | An SLO with zero observations in its window. Zero bad out of zero is not 100% availability. |
| `conformance_never_run` | **unknown** | No conformance run has been recorded. |
| `beacon_unavailable` | **unknown** | Beacon could not read its own state. |

Every reason is collected, never just the first. A gate that reports one problem per run makes
fixing three problems take three deploys, and the third is found at 6pm on release day.

### The gate is fail-closed, and an unknown is not a pass

The six `unknown` codes above all refuse, and they refuse **before anything else is considered**.

Why, rather than "assume green when we have no data": every plausible way of losing the signal —
the scheduler dying, a database being unreachable, a journey never having been deployed, a probe's
target being renamed — produces **missing** data, not red data. A gate that treats missing as green
opens hardest exactly when the estate is least observable.

It is enforced in three independent places, so removing it takes three deliberate acts:

1. `decide()` returns `refuse` the moment any input is `unknown`, in a branch that runs first and
   from which the override list is unreachable — `src/gate.ts`.
2. `gate_decisions_indeterminate_never_promotes`, a CHECK constraint. A promotion recorded against
   an indeterminate evaluation **cannot commit**, even from a caller that bypassed `decide()`.
3. `beacon gate` exits non-zero on anything that is not a promotion, and on its own failure to
   reach Beacon at all.

---

## 2. How an operator overrides it

**There is an override, it is narrow, and it is loud.** A gate with no break-glass is untenable —
you must be able to ship the fix for the outage that is burning the budget — but a `--force` flag
would be an unattributed, unexpiring, unrecorded override living in somebody's shell history.

```
POST /v1/gate/overrides
{ "release": "v1.4.2",
  "reasonCode": "journey_failing",
  "subject": "identity.register",
  "reason": "known upstream outage in identity, the fix is in this release",
  "ttlMs": 3600000 }
```

Five constraints, each of which is refused rather than warned about:

* **It names one reason code and one subject.** `"*"` waives a code for every subject and is
  deliberately ugly to type, because "every failing journey" is a thing an operator should have to
  mean.
* **It expires.** Twelve hours maximum. There is no "until further notice"; a permanent override is
  the gate being deleted one reason code at a time.
* **It carries a written reason**, at least 16 characters, enforced by the application *and* by a
  CHECK constraint.
* **It is attributed to whoever authenticated**, never to a field in the body.
* **It requires an admin role.**

### An override may waive a KNOWN failure. It may never waive an UNKNOWN one.

This is the line the whole design rests on, and it is refused at creation *and* unreachable at
evaluation.

Overriding a known failure is a person saying "I have looked at this, I accept it, here is my
name". Overriding an unknown is a person saying "nobody has looked at this and I accept it anyway"
— which is not a decision anyone can be accountable for, and the unknowns are precisely the states
in which the estate is least able to tell you what you just shipped.

There is **no** `--force` on the CLI, and CI greps for one.

---

## 3. Running it

```bash
pnpm install
pnpm typecheck
pnpm migrate                     # a one-shot job; NEVER the service process
pnpm start
```

Tests need a real Postgres whose database name contains `test`:

```bash
BEACON_TEST_DATABASE_URL=postgres://beacon:beacon@127.0.0.1:5432/beacon_test pnpm test
```

**369 tests, `node:test` only.** They run against a real database because the two most important
controls in this repository are a partial unique index and a CHECK constraint, and neither can be
proved against a fake.

---

## 4. The architecture, and what changed from the service it replaces

`stack/infra/beacon` is frozen. Roughly half of it is right and is carried forward whole; the other
half cannot survive a second replica. Both halves are itemised, with line references, because a
port that does not say what it rejected is a rewrite pretending to be a port.

### Ported forward

| What | From | Why it was right |
| --- | --- | --- |
| **Hysteresis** — an incident is a state transition that survived `failThreshold`, not a failed check | `store.js`, `incidents.js` | The difference between a monitor you read and a monitor you mute. Three failures at a 30s cadence is 90 seconds to detection: fast enough to matter, slow enough to be true. Recovery has its own threshold, so a flapping target produces no paired open/close stream. |
| **The journey harness's three rules** | `runner.js` | An assertion failure is `fail` (the product is broken) and any other throw is `error` (Beacon is broken); not-run is not passed; teardown runs on every exit path. 13-operational-model.md names these as load-bearing, and they are. |
| **A skip is never green, and emits 0.5** | `metrics.js` | `deploy/prometheus/rules/slo.yaml` already depends on the 0.5 to distinguish a skip from a pass. |
| **The partial unique index on open incidents** | `db.js` | "Two probe cycles overlapping is exactly how you get a duplicate and exactly the case nobody tests." Correct then and load-bearing now. |
| **`up` / `degraded` / `down` and the 1 / 0.5 / 0 encoding** | `metrics.js` | Grafana's dashboards are already written against it. Renaming a state empties a panel silently. |
| **A monitor must not become the incident** | `schedule.js` | The idea survives; the implementation does not — see below. |
| **Rollups outlive raw checks by more than a year** | `db.js`, `env.js` | `BEACON_ROLLUP_RETENTION_DAYS=400` is the figure AD-20's 400-day line actually describes. |

### Dropped, and why

| What | From | Why it could not come |
| --- | --- | --- |
| **The entire schedule** — `setInterval` for probes, one per journey, one for the write buffer | `probe.js`, `schedule.js`, `store.js` | Per-process. Two replicas probe everything twice, write two check rows per cycle, halve every uptime denominator when one restarts, and move a synthetic account's balance underneath each other. The overlap guard at `probe.js` is a module-scope boolean — the right idea in the one place it cannot work. Replaced by a leased job table claimed `for update skip locked`. |
| **Hysteresis in a `Map`** | `store.js` | Two replicas each hold half the evidence, each count to three separately, and neither gets there. Now a row, updated in one atomic upsert. |
| **Nineteen `BEACON_*_URL` variables and 922 lines of `targets.js`** | `env.js`, `targets.js` | Adding a service to the estate meant editing the monitor, and every default is a container name that is right in one deployment. Replaced by a `probes` table plus one `BEACON_TARGETS` variable. |
| **Idempotent DDL run on every boot** | `db.js` | No version table, no advisory lock, no ordering guarantee. Two replicas booting together race and one crash-loops. Replaced by versioned migrations under `@cloudsforge/db`'s advisory lock, run by a separate one-shot process. |
| **`redactStatus`** | `server.js` | It emits `t.name` and `incidents[].subject` verbatim — `pay.rates`, `hearth.seed` — which is internal topology. 02-target-architecture.md records this and it is correct; I re-checked the source. Replaced by a projection that publishes **product groups only**. |
| **`BEACON_TOKEN` defaulting to `''`** | `env.js` | An unauthenticated-by-accident `/metrics` the moment somebody flips a check. Now required at boot. |
| **The bundled dashboard and SSE stream** | `public/`, `server.js` | Grafana owns dashboards now (AD-20) and `status-web` owns the public page. A second UI is a second thing to keep true. |
| **The EVM conformance runner's own execution** | `conformance.js` | Corpus replay belongs to `@cloudsforge/conformance`, which classifies identical / benign / breaking and exits 1 only on breaking. This service records the *result* and makes it a gate input. |

### An inherited claim that was false

02-target-architecture.md says Beacon's `/metrics` is auth-gated and that scraping it costs
a credential. **True** — `server.js` gates it, and `deploy/prometheus/prometheus.yml`
already presents the header. Recorded here rather than re-discovered.

The claim I could **not** confirm is subtler and is recorded because it changes behaviour: the
frozen service's own `metrics.js` argues that `/metrics` must never touch Postgres, because
"a metrics endpoint that queries the database gives anyone who can reach it a way to put load on
the database by scraping in a loop". That reasoning is sound for a single-replica monitor holding
live state in a `Map`, and **it does not survive replicas**: two replicas serving from memory
publish two different answers depending on which one Prometheus reached. This service reads from
the database on scrape and answers the objection instead of ignoring it — the route is
authenticated, the interval is 30s by config, and every query is a bounded index scan over tables
whose row counts are the number of probes, journeys, SLOs and open incidents. The raw `checks`
table is never touched. That trade is stated at `src/server.ts` `scrapeRefresh`.

---

## 5. The public projection

`status-web` renders `GET /api/status/public`. It is **redacted by construction, not by
convention**.

* The internal record and the public record are **separate types**. `Incident` carries `subject`,
  `cause`, `lastError`, `failures`, `scope` and `detectedBy`; `PublicIncident` carries seven fields
  and none of those are among them.
* The mapping is field-by-field with **no spread anywhere in the file**, and CI greps for one.
* `PUBLIC_INCIDENT_FIELDS` and `keyof PublicIncident` are asserted equal **at compile time** by an
  `Exact<>` type. Adding a field to the interface without adding it to the tuple fails
  `pnpm typecheck`, and so does the reverse. Publishing something new is always a deliberate,
  reviewable, two-line act.
* `seal()` is a runtime backstop that copies only allowlisted keys, because TypeScript's
  excess-property check does not apply to spreads.
* The unit of publication is the **product group** — "Wallet", never `pay.rates`. A group's state is
  the worst state of the probes inside it.
* **`state` is `null` when `groups` is empty, and that is not `operational`.** A deployment with no
  probes registered has measured nothing, and the top-level state used to fold from `worst([])`'s
  identity and publish `operational` anyway — which is what
  `https://status.cloudsforge.online/api/status/public` served on 2026-08-04 at 21:45 UTC, on a
  document whose `groups` was `[]`. This service's own rule is that an unknown is never a pass; an
  absent claim is null, never a fifth vocabulary word, so `PublicState` stays a closed four-word
  union that the reader can rely on.
* The internal lifecycle (`detected → declared → mitigated → resolved → reviewed`) is mapped
  explicitly to a customer-facing one (`investigating → identified → monitoring → resolved`).

Tested three ways: the exact key set of every projected object; a serialised document searched for
every internal string; and a test that attaches fields to the internal object that **no version of
`Incident` has ever declared** — which is what a future field looks like to today's code — and
asserts they do not appear.

`BEACON_PUBLIC_STATUS` defaults to `false`. "Public" is a decision.

---

## 6. Error budgets

An SLO needs a window and a budget, and the budget must be spendable.

* The objective is **parts per million as an integer**. 99.95% is `999_500`; 99.5% is `995_000`;
  100% is `1_000_000` and means *no budget*, which is the ledger's trial-balance SLI.
* Every count is a `bigint`. Nothing divides in floating point. `remaining` is a whole number of
  events you may still fail — a thing a human can hold and a pipeline can compare against zero.
* `requiredGood` rounds **up**, so the budget is never larger than the objective promises.
  `consumedPpm` rounds **up**, so a service cannot cross the 75%-consumed policy line without the
  review the policy requires.
* Exhaustion is derived from consumption, not from `remaining <= 0`. A 100%-objective SLO has zero
  allowed bad events and therefore zero remaining from its first clean minute; reading exhaustion
  off `remaining` would freeze it permanently for being perfect.
* An empty window is `indeterminate`, never green. The gate refuses on it.

The exposition format is a float because Prometheus has no other number. That conversion happens
once, at the boundary, in `remainingRatio()`. The ledger behind it stays integral.

Windows, tiers and the 50 / 75 / 100 % policy come from 13-operational-model.md §8.

---

## 7. Journeys

Definitions are code (`src/estate.ts`, `src/ecosystem.ts`, `src/browser/`); operator state
(`muted`) is a row, preserved across deploys. Scheduling is a leased job.

**Only journeys that actually exercise something are declared.** The critical-path set in
13-operational-model.md is nine — register, sign in, SSO handoff, deposit, convert, spend,
withdraw, mint deploy, market purchase.

**A skip can neither open an incident nor close one.** A skip is "not applicable — never green,
never red", and an incident is the reddest thing this service emits, so an unmeasurable journey
must not produce a customer-facing outage — nor mark one resolved, which would be claiming health
from an absence of evidence. Everything that should notice still notices: the run is recorded, the
journey SLO scores it 0, `beacon_journey_runs_total{status="skip"}` increments and **the gate
refuses to promote**. The rule was written after `identity.handoff` began skipping on a live
deployment whose `BEACON_HANDOFF_ORIGIN` named the wrong apex, and put `Account · Investigating ·
SEV2` on the public status page for two and a half hours while the hand-off it accused was working
— an incident nothing could close, because only a pass closes one and a skipping journey never
passes. `src/jobs.test.ts` pins both halves.

### 7.1 Per-service journeys — `src/estate.ts`

| Journey | Critical | Status |
| --- | --- | --- |
| `identity.register` | yes | implemented |
| `identity.signin` | yes | implemented — **fixed 2026-08-03, see below** |
| `identity.handoff` | yes | implemented, including the single-use assertion — **fixed 2026-08-03** |
| `estate.reachable` | yes | implemented |
| `market.catalogue` | no | implemented |
| `worlds.registry` | no | implemented |
| `deposit` | — | **half of it now exists** — `ecosystem.deposit-address`, below |
| `convert`, `spend`, `withdraw`, `mint deploy`, `market purchase` | — | **absent, not stubbed** |

The remaining money journeys are absent rather than declared-and-skipping, and that is the safe
choice in both directions. A declared-but-skipping critical journey would refuse every release for
ever, because a skip is not a pass — and a gate that refuses everything is a gate that gets switched
off within a week. A declared-but-faked journey would report green and make the gate a lie, which is
worse than not having one. Adding a real one is this file plus one row.

**`deposit` is the one that moved, and only halfway.** Deposit provisioning is the single way money
enters this platform — payments here are crypto-native and balances are funded by on-chain deposit
only — and `POST /v1/deposits` answered 500 for the whole life of the service without anything
noticing. `deposit` was named in the critical-path set above and in `journeys.ts`, and nothing in
this repository drove any part of it. `ecosystem.deposit-address` now drives provisioning end to end
against wallet AND custody. **It does not deposit**: crediting one needs an on-chain transfer and
the indexer's confirmation depth, which no journey can produce on demand, so the row stays open.

**Two of the six could only ever fail, and there were no tests here at all.** Found on 2026-08-03
by running them against the dev estate:

* `identity.signin` posted `{ email, password }` to `POST /auth/login`.
  `@cloudsforge/contracts-auth`'s `validateLogin` reads `identifier` and has never read `email`, so
  identity answered `400 an identifier and a password are required` on every run.
* `identity.handoff` posted `{}` to `POST /auth/handoff`, which requires `redirectOrigin`, and
  redeemed without the `Origin` header the redemption route requires. 400 on every run.

Both are critical, so the gate refused every release — for the monitor's own defect, reported as
the product being broken. That is the worst failure a release gate has, because the fix everybody
reaches for is to switch the gate off. `src/estate.test.ts` now drives all six against a fake
estate that answers what the real services answer, and every assertion is proved to go red.

`identity.handoff` needs `BEACON_HANDOFF_ORIGIN` and **skips**, naming the variable, without one.
The dev estate does not set `IDENTITY_HANDOFF_ORIGINS` at all, so the hand-off is unproven there
and says so.

### 7.2 Ecosystem journeys — `src/ecosystem.ts`

Cross-service journeys: the seams no single service's suite can express. If one service's tests
could assert it, it does not belong there.

| Journey | Proves | Declared |
| --- | --- | --- |
| `ecosystem.event-bus` | a fact committed in identity reaches activity's read model through the real outbox, signature and inbox — exactly once, in the right person's feed and no one else's | yes |
| `ecosystem.one-activity` | activity and hub-api serve the same record byte for byte, with the cursor passed back unparsed | yes |
| `ecosystem.one-portfolio` | hub's two paths to one portfolio total — the dashboard tile and the portfolio page, separately cached — agree on the whole payload including `pricedAt` | yes |
| `ecosystem.one-account` | one access token resolves to one subject in identity, hub-api and activity, and none of the three serves without it | yes |
| `ecosystem.deposit-address` | `POST /v1/deposits` provisions a real address, **custody is holding the key it names**, and asking twice does not mint a second one | yes — needs `wallet` and `custody` in `BEACON_TARGETS` |
| `ecosystem.trial-balance` | Σ debits − Σ credits is exactly zero **over a journal with entries in it** | **only with `BEACON_SERVICE_CREDENTIAL`** |

`ecosystem.trial-balance` is absent rather than skipping because beacon cannot hold a credential
today: `IDENTITY_SERVICE_TOKEN_GRANTS` in `deploy/compose/docker-compose.estate.yml` names thirteen
services and `beacon` is not among them, so `POST /service-credentials` answers 500 *"no scopes are
configured for service 'beacon'"*. One line there and one variable here declares it.

Note what that journey refuses to do: **a zero trial balance over an empty journal is a skip, not a
pass.** Zero minus zero is zero, and publishing a green reconciliation signal for a ledger that has
never recorded an entry is the same defect as a CI job that builds an image and never boots it.

`src/claims.ts` maps the eleven "one platform" statements in 01 §2 onto the journeys that move
them, with a cited blocker where none does. Its test refuses a claim marked `partly` or `proven`
that names no journey.

All four of the original declared ecosystem journeys were run against the dev estate on 2026-08-03
and pass — `event-bus` in 1.0s, `one-activity` in 0.8s, `one-portfolio` in 0.1s, `one-account` in
0.8s.

**`ecosystem.deposit-address` is the fifth, added 2026-08-04, and it is the one this section is
worth reading for.** `POST /v1/deposits` — the single way money enters a crypto-native platform —
answered 500 to every caller for the whole life of the service, because wallet never sent the
`orderId` custody requires and nothing caught the resulting refusal. Every layer of observability
missed it: `deposit` was named in the critical-path set and driven by nothing, and the conformance
corpus deliberately excluded the happy path *because* it was broken, which is correct at the time
and becomes a permanent blind spot the moment the route is fixed.

It is **not critical**, deliberately, and for the reason `ecosystem.event-bus` records: a critical
journey refuses every release from the moment it is declared, and this one has no history in any
deployment. It is promoted once its own flake rate is a number rather than an assumption.

**What one run leaves behind: one custody key, one managed wallet row, one assignment and one
indexer watch.** One and not two, and the second `POST /v1/deposits` the journey makes is what
guarantees that — custody honours no idempotency key, so wallet's find-or-create is the whole
protection against a retry minting twice, and this journey is the only thing asserting it. At a
five-minute cadence that is ~288 addresses a day; nothing in the estate deletes them.

    delete from custody_keys where user_id in (select id from users where email like 'beacon+%');

#### What running them found, that is not beacon's to fix

Recorded here because each was invisible from inside the service that owns it, which is the whole
argument for this tier existing. None is fixed in this repository.

| Finding | Where | Why it matters |
| --- | --- | --- |
| `identity.user.registered` has **no subscription row at all** — `event_subscriptions` in the dev estate carries only `identity.session.created` (to activity) and `identity.user.deleted` (to activity and notify) | the estate's bootstrap | "Your account was created" is classified, user-visible and never delivered. The feed's first entry is a sign-in. |
| `IDENTITY_HANDOFF_ORIGINS` is not set in `deploy/compose/docker-compose.estate.yml` | `micro-deploy` | SSO hand-off cannot be exercised at all, in a browser or over HTTP. Vision claim 1 is unprovable in the dev estate. |
| `IDENTITY_SERVICE_TOKEN_GRANTS` names thirteen services and not `beacon`; `POST /service-credentials` answers **500**, not 4xx, for an unconfigured service | `micro-deploy`, `micro-identity` | Beacon can hold no scoped token, so the ledger, custody and reconciliation claims stay unproven. The 500 is a second, smaller defect: a configuration error reported as an internal one. |
| hub-api's activity tile answered `unavailable (activity answered 401)` eleven minutes after the estate came up | the ten-minute cliff, `deploy/README.md` | Reproduced exactly. Classified as an `error` rather than a `fail` per doc 22 §4.1 — the environment expired, the product did not. |

### 7.3 The browser tier — `src/browser/`

Doc 22 puts tier 3 — the 86 scenarios that need the estate, the frontends and a sign-in surface —
in this repository, and tiers 1 and 2 beside their bundles. The catalogue is `catalogue.ts`, the
`playwright-core` harness is `driver.ts`, and the declaration is **computed** in `journeys.ts`: a
scenario becomes a journey only when it carries no permanent blocker, every surface it needs has an
address, and an implementation exists.

**This paragraph used to say the answer was the empty set, and it no longer is.** It was empty
because `deploy/compose/docker-compose.estate.yml` served no frontend container (doc 22 §8.7) and
nothing served a sign-in page. Both premises are now false — the estate serves sixteen bundles
behind the gateway and `hub-web` serves the sign-in surface — so four scenarios declare themselves
whenever `BEACON_TARGETS` names the surfaces they need, with no code change to make it happen,
which is the whole point of computing the declaration. `BJ-ACC-01`, `BJ-ACC-02`, `BJ-ACC-03` and
`BJ-XS-10` are implemented; thirty-one of the eighty-seven remain blocked on a screen that does not
exist, and the rest are named one line at a time by `unimplemented()` rather than quietly omitted.
`index.ts` logs the reason per scenario at boot, because "0 browser journeys" reads as an oversight
and "no address for site, hub, …" reads as a deploy change.

The harness itself is proved, with and without a browser. `assertRendered` and `assertClean` are
pure functions checked in every run; against a real Chromium, a page whose bundle 404s is required
to go **red** while its shell answers 200 — which is the entire argument for a browser tier, since
`domcontentloaded` fires on the empty shell and a missing chunk leaves the network perfectly idle.

Every route a journey calls was read out of the service that serves it, never out of a document.
Method and path rather than line numbers, for the reason `src/estate.ts`'s header sets out at
length.

### 7.1 The smoke tier — `pnpm smoke`

```
beacon smoke [--apex <host>] [--env <label>] [--surface <key>] [--browser <path>] [--timeout <ms>]
```

Signs in for real, then loads all sixteen surfaces in one Chromium session, through the gateway.

`--env` names the environment and is a **suffix on each subdomain**, not a prefix on the apex:
`--env testnet` drives `hub-testnet.<apex>`, and the apex surface at `testnet.<apex>`. It is a
separate flag because both environments are served on one zone — a wildcard certificate matches
exactly one label, so the `hub.testnet.<apex>` shape this replaced failed the TLS handshake at
Cloudflare's edge and could never have been smoked at all.

**It intercepts nothing.** Every byte those pages receive came from the estate. That sentence is
the whole product, because the reason it exists is that the estate shipped completely unusable and
completely green: every frontend's browser suite did

```js
await page.route('**/*', async (route) => { … route.fulfill({ … }) })
```

— a real browser, a real bundle, and every network request answered from a fixture. What that
proves is "this app renders correctly when its API works", and it is structurally incapable of
noticing that the API is unreachable. It was sitting at the exact seam where nothing else was
looking. `src/browser/smoke.test.ts` and a CI step both assert, as text over this repository's
sources, that no `route`, `fulfill`, `abort` or `setOfflineMode` appears anywhere in `src/browser`.

Per surface it asserts: the document answers 200; the application mounted; **the page is painted**
(`body`'s computed background is not transparent — "renders unstyled" is a thing a human sees in
one second and no HTTP check ever sees); **no `state--failed` or `state--forbidden` node**, which
is the estate's own four-state component and therefore distinguishes "the query answered with
nothing" from "the query did not answer" without this repository inventing a regex for it; no
failed request; no uncaught exception; no console error; and that the surface rendered words only
its own bundle produces.

**And, on the one surface whose product is a single answer, that it reached one.** Every check
above hunts for a page that BROKE, and on 2026-08-04 this tier drove
`status.cloudsforge.online` in Chromium, on a healthy estate, while it read *"Not determined — we
cannot currently determine status"*, and returned **an empty finding list**. Nothing was broken:
it answered 200, mounted, painted, logged nothing, failed no request and rendered its brand words.
It had simply concluded that it could not answer, which is invisible to a check that only looks
for errors. `SmokeSurface.concludes` names the conclusions a surface exists to reach — for
`status`, the four verdict headlines and deliberately not the fifth. All four are accepted,
including `Active outage`: the assertion is that the page ANSWERED, never that the answer was good
news, because a check that went red on an outage would be a check with an incentive to hide one.
It is on exactly one of the sixteen surfaces and `smoke.test.ts` asserts that it stays that way.

**TLS.** The dev gateway serves a certificate issued by a local CA that no trust store has
enrolled. `ignoreHTTPSErrors: true` would accept that — and would also accept an expired
certificate, one issued for another hostname, and an active man-in-the-middle, in every
environment, for ever. Instead `src/browser/estatecert.ts` reads the certificate over a plain TLS
socket before any browser starts, and pins **one leaf public key** through Chromium's
`--ignore-certificate-errors-spki-list`, which excuses errors only for the keys named. It refuses
to pin a publicly trusted certificate (nothing needs excusing), an expired or not-yet-valid one, a
certificate that does not cover the hostname, or any verification failure other than an unreachable
root. Driven, not assumed: the leaf's SPKI loads the page, one changed byte fails
`ERR_CERT_AUTHORITY_INVALID`, and so does the issuing CA's SPKI — which is why the leaf is what
gets pinned.

**Exit codes: 0 healthy · 1 something a person would see is broken · 2 the estate was unreachable
or there is no browser.** Two and not zero, for the same reason `beacon browser` treats a skip as a
failure: `node --test` can only *skip* the browser half where no estate answers, and a pipeline
reading a skip reads a green. A deploy script runs this command instead and cannot get a success it
did not earn.

---

## 8. Metrics

`/metrics` is authenticated. Present `x-beacon-token`, or an identity token carrying `beacon:read`.

| Series | Notes |
| --- | --- |
| `beacon_up` | Always 1. Proves the scrape reached Beacon at all. |
| `beacon_target_up{probe,target,group}` | 1 up, 0.5 degraded, 0 down. A probe that has never run publishes **nothing** rather than 0. |
| `beacon_journey_status{journey,group}` | 1 pass, **0.5 skip**, 0 fail or error. |
| `beacon_journey_last_run_timestamp_seconds{journey}` | The staleness series. The only thing that catches a dead scheduler. |
| `beacon_journeys_muted` | Must be zero at a gate. |
| `beacon_slo_budget_remaining_ratio{slo}` | 0..1. |
| `beacon_slo_budget_remaining_events{slo}` | Whole events. Negative means overspent, and by how much. |
| `beacon_conformance_vectors{suite,result}` | `identical`, `benign`, `failed`, `skipped`. |
| `beacon_incidents_open{severity}` | Every severity every scrape, including the zeroes — a series that stops leaves an alert evaluating a stale sample. |
| plus the RED and job sets from `@cloudsforge/telemetry` | |

`deploy/prometheus/rules/slo.yaml` and `deploy/grafana/dashboards/*.json` are already written
against these names. Renaming one empties a panel and evaluates a rule to nothing — silently.

**The 400-day retention line applies to `check_rollups`, not to Prometheus.** Prometheus cannot
downsample and has one retention for all data at one resolution; the 5-minute recording rules in
`deploy/prometheus/rules/slo.yaml` are the honest half of that story. See
02-target-architecture.md.

---

## 9. Alertmanager

`POST /api/alerts/webhook`, which `deploy/alertmanager/alertmanager.yml` already targets. Every
alert opens a Beacon incident as well as being delivered, because Beacon already owns incident
open/close, the hysteresis, the timeline and the status page — and two incident systems is two
records to reconcile at the worst possible moment. Redelivery dedupes into one incident. The
endpoint is authenticated: an incident-opening route that anyone who can reach the port may call is
a way to put a false outage on the public status page.

---

## 10. Rules this repository holds itself to

* **No `setInterval`.** Every recurrence is a leased job. The only timers are the deadline races in
  `probes.ts` and `journeys.ts`, and CI permits them in exactly those two files and nowhere else.
* **A probe that hangs is a probe that fails.** The abort is a courtesy; the `Promise.race` is the
  guarantee. A hung check is recorded as `down` with `deadline exceeded`, never left pending.
* **Migrations are never run by the service process.** `index.ts` asserts the schema version and
  refuses to serve below it.
* **One database, and it is this service's own.**
* **Strict TypeScript, ESM, Node ≥ 22**, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.
* **No secret in the repository.** `.env.example` carries `CHANGE_ME` and CI checks that it still
  does.

---

## Provenance

The code in this repository was written by **Claude Opus 5** and **Claude Fable 5**, assets
generated with **FLUX 2 Pro**, under human direction and review.
