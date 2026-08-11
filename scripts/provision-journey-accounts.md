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

## The procedure

Run this on the app host, against the network you are provisioning. **Mainnet and testnet need
separate pools** — the accounts live in each network's own identity database, and a pool provisioned
on one proves nothing about the other.

### 1. Register eight accounts

Mainnet has a Turnstile in front of registration, so present beacon's service credential — the
challenge bypass is the service principal (micro-org#361). Registration is rate-limited to **5 per
60s per source address**, so this must be done in two batches or with a pause.

```sh
# From inside the beacon container, which already holds BEACON_SERVICE_CREDENTIAL.
# Note: the passwords are generated here and PRINTED ONCE. Capture them; there is no way to read
# them back, and a lost one means re-provisioning that slot.
docker exec cloudsforge-estate-beacon-1 node -e '
  const { randomUUID } = require("node:crypto")
  // ... exchange BEACON_SERVICE_CREDENTIAL at POST /service-tokens/exchange, then POST
  // /auth/register eight times with a 15s pause every five, printing {email, password} as JSON.
'
```

The output is the value of `BEACON_JOURNEY_ACCOUNTS`: a JSON array of `{"email","password"}`.

JSON rather than the `a=b,c=d` shape `BEACON_TARGETS` uses, and the reason is in `pool.ts`: a URL
cannot contain a comma, a password can contain anything, and a delimited list has a class of legal
password it silently mangles.

### 2. Verify them

Either spend the eight links from the mailbox (if you chose a real domain), or — for a reserved
domain, where no mail is sent — mark them verified directly:

```sql
-- identity, on the network being provisioned. Narrow, and it names the eight addresses rather than
-- matching a pattern: this sets the column that decides whether an account may sign in, and a LIKE
-- here would verify every synthetic account in the table.
update users
   set email_verified_at = now()
 where email in ('pool0@beacon.test', … the eight you created …)
   and email_verified_at is null;
```

This is the same thing migration 13 did when it back-filled existing accounts as verified. It is
written out rather than hidden in a script because it is a write to an authentication column on a
production table, and it should be read before it is run.

### 3. Put it on the host and redeploy

`BEACON_JOURNEY_ACCOUNTS` goes wherever the estate's other beacon secrets live — the untracked
`tokens.env` on the app host — and compose passes it through to the beacon service.

Deploy with `scripts/release-deploy.sh`. A bare `docker compose up` drops `mainnet.env`.

### 4. Check it took

```sh
# Every journey that needed a session should stop skipping within one cycle.
docker exec cloudsforge-estate-postgres-1 psql -U cloudsforge -d beacon -tAc \
  "select journey, status, count(*) from journey_runs
    where started_at > now() - interval '20 minutes' group by 1,2 order by 1"
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
