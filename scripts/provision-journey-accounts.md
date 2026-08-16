# Provisioning `BEACON_JOURNEY_ACCOUNTS`

Eight accounts, created once, that beacon's journeys sign in as instead of registering a new one
every five minutes.

## Why this is a manual step and not a script

Beacon cannot make an account it can use. `POST /auth/register` answers **202 with no session**, and
`signInRefusal` refuses the account until the mailed verification link is spent. Measured against
mainnet identity 2.5.19 on 2026-08-11, registering as a service principal:

```
POST /auth/register                  202  {"verificationRequired":true, …}   no token, no user id
POST /auth/login  (that account)     403  {"error":{"code":"email_unverified", …}}
```

The token that would verify the account exists in exactly one place — the
`identity.email.verification_requested` event payload, in notify's outbox. Beacon does not probe
notify, must not read another service's outbox, and the token is a **live credential**: a harness
that handled one would be one careless log line from writing it to disk. micro-org#371 states that
constraint in as many words.

So the accounts are provisioned by a person, once, and beacon is given their credentials the same
way it is given `BEACON_SERVICE_CREDENTIAL` and `BEACON_HANDOFF_ORIGIN` — through the environment.
Until the variable is set, every journey that needs a session **skips with a reason naming this
file**. That is deliberate: an estate that has not provisioned the pool has not demonstrated a
broken product, and a fail here would open an incident against identity for a deploy step nobody
has run.

## Choosing the addresses

Use a domain the estate can actually mail, or a reserved one, and **know which you have chosen**:

- **A reserved domain** (`@beacon.test`, RFC 6761 §6) costs no mail — `notify/src/reserved.ts`
  refuses to open a channel for it, which is the rule that stopped beacon burning the whole daily
  allowance (micro-org#243, #390). But no verification mail arrives, so step 3 below is the only way
  to verify the account.
- **A real mailbox you control** lets you spend the link the way a person does, which is the more
  honest provisioning. It costs eight messages, once. The daily allowance is 150.

Either is fine. What is not fine is a domain that resolves and that nobody reads: that is eight
verification mails into a black hole and eight accounts that can never sign in.

## Which identity to provision at

**The one the estate declares, which is not always the one it runs.** `CF_IDENTITY_URL` in that
estate's env file is the answer; unset means the in-compose `identity` container.

This paragraph used to read "mainnet and testnet need separate pools — the accounts live in each
network's own identity database", and it stopped being true when the two estates were given one
identity (micro-org#459 stage 2). What replaced it is stricter, not looser:

- **One identity database, so one namespace.** A pool provisioned "on testnet" is a set of rows in
  the *mainnet* identity's `users` table. Nothing separates them but the addresses you choose.
- **The addresses must still differ per estate**, and for the reason the slot table below already
  gives. Sessions live in identity and identity is now shared, so two estates pointed at one
  address are two journeys sharing an account — the hazard `parsePool`'s duplicate check exists to
  refuse, reintroduced one layer up where it cannot see it. Mainnet holds `pool0…7@beacon.test`;
  testnet holds `pool0…7@beacon-testnet.test`, provisioned 2026-08-16.
- **`BEACON_TARGETS` must name that identity too.** It said `identity=http://identity:4000` on both
  estates until 2026-08-16, which is a pool provisioned correctly at the shared identity and then
  signed in at the local one: 401 on every authenticated journey, and the credential exchange 401s
  with it. It now follows `CF_IDENTITY_URL` (micro-org#472).

## The procedure

Run this on the app host, for the network you are provisioning, **against that network's declared
identity**.

### 1. Register eight accounts

Registration is behind a Turnstile, so present beacon's service credential — the challenge bypass is
the service principal (micro-org#361). Two things about that exchange, both measured on 2026-08-16
by getting them wrong:

- The response field is **`token`**, not `accessToken`. `Bearer undefined` is not a 401; it is a 403
  `challenge_required`, because an unusable bearer makes the route fall through to the challenge it
  was meant to bypass (`challengeBypass` in identity's `server.ts` logs `reason: "malformed"` and
  says so).
- Registration is rate-limited to **5 per 60s per source address**, and a rejected attempt still
  spends its slot. A failed run therefore costs the next run its first few registrations. Do it in
  batches with a pause, and be ready to fill the gaps in a second pass — the pool must end up in
  **slot order**, so merge by address rather than appending.

```sh
# From inside the beacon container for the estate being provisioned, which already holds
# BEACON_SERVICE_CREDENTIAL for that estate's declared identity.
#
# STDOUT carries the credential set and NOTHING else; progress goes to stderr. Redirect stdout
# straight to a file. A password that reaches a terminal is a password in a scrollback buffer.
docker exec cf-testnet-beacon-1 node -e '
  const { randomBytes } = require("node:crypto")
  // ... POST /service-tokens/exchange at CF_IDENTITY_URL, read `token`, then POST /auth/register
  // eight times with the service token, a pause every four, writing [{email, password}] to stdout.
' > /tmp/pool.json
```

The output is the value of `BEACON_JOURNEY_ACCOUNTS`: a JSON array of `{"email","password"}`.

JSON rather than the `a=b,c=d` shape `BEACON_TARGETS` uses, and the reason is in `pool.ts`: a URL
cannot contain a comma, a password can contain anything, and a delimited list has a class of legal
password it silently mangles.

### 2. Verify them

Either spend the eight links from the mailbox (if you chose a real domain), or — for a reserved
domain, where no mail is sent — mark them verified directly:

```sql
-- The DECLARED identity's database — for testnet that is the mainnet postgres, not its own.
-- Narrow, and it names the eight addresses rather than matching a pattern: this sets the column
-- that decides whether an account may sign in, and a LIKE here would verify every synthetic
-- account in the table. `pool_@beacon.test` would also match the other estate's pool.
update users
   set email_verified_at = now()
 where email in ('pool0@beacon-testnet.test', … the eight you created …)
   and email_verified_at is null;
```

This is the same thing migration 13 did when it back-filled existing accounts as verified. It is
written out rather than hidden in a script because it is a write to an authentication column on a
production table, and it should be read before it is run.

### 3. Prove they sign in, before touching anything

One `POST /auth/login` per address at the declared identity, printing the status and nothing else.
Two slots is enough to catch the mistakes that matter, and eight would spend the 10-per-minute
login limit the journeys themselves need. A 403 here means step 2 was missed; a 401 means the pool
was provisioned at one identity and is being offered to another, which is the whole reason this
section exists.

### 4. Put it on the host and redeploy

`BEACON_JOURNEY_ACCOUNTS` goes wherever that estate's other beacon secrets live — the untracked
`tokens.env` or `tokens.testnet.env` on the app host — and compose passes it through to the beacon
service. Splice the file in place from the JSON you captured, rather than pasting it: the value
never needs to be displayed to be installed, and this is the step that most invites displaying it.

Deploy with `scripts/release-deploy.sh`. A bare `docker compose up` drops `mainnet.env`.

### 5. Check it took

```sh
# Every journey that needed a session should stop skipping within one cycle. Drop `-i` and add
# `</dev/null`: in a script fed to bash through a pipe, `docker exec -i` consumes the REST OF THE
# SCRIPT as the container's stdin, and everything after this line silently does not run.
docker exec cloudsforge-estate-postgres-1 psql -U cloudsforge -d beacon -tAc \
  "select journey, status, count(*) from journey_runs
    where started_at > now() - interval '20 minutes' group by 1,2 order by 1" </dev/null
```

A skip mentioning `BEACON_JOURNEY_ACCOUNTS` means the variable did not reach the container. A skip
mentioning *"has never confirmed its address"* means step 2 was missed for that slot — the mistake
this procedure most invites, which is why `poolSession` names it specifically instead of reporting
"expected 200 from /auth/login, got 403".

## What each account is used for

`pool.ts`'s `POOL_SLOTS` is the table, and it is a **static assignment rather than a checkout
queue**. One slot belongs to one journey on every replica, for ever, because two journeys sharing an
account move each other's balance and each other's session — and the flake that produces is
indistinguishable from the outage it gets reported as.

| slot | journey |
| --- | --- |
| 0 | `identity.signin` |
| 1 | `identity.handoff` |
| 2 | `ecosystem.event-bus` — the subject |
| 3 | `ecosystem.event-bus` — the bystander, whose feed must **not** contain the subject's record |
| 4 | `ecosystem.one-activity` |
| 5 | `ecosystem.one-portfolio` |
| 6 | `ecosystem.one-account` |
| 7 | `ecosystem.deposit-address` |

Slots 2 and 3 must be **different accounts**. That journey's last step reads one account's feed with
another account's token and asserts the first record is not visible; with one account it would be
comparing an account with itself, and the estate's worst possible data leak would be guarded by a
check that cannot fail. `parsePool` refuses a pool that names one address twice for this reason.

A pool shorter than eight is not shared out — the uncovered journeys skip and say how many accounts
are needed. Wrapping round would fix the skip by reintroducing exactly the hazard above.
