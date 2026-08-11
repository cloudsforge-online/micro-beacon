-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- THE BEACON RESIDUE PRUNE. READ THE WHOLE HEADER BEFORE RUNNING ANY OF IT.
--
-- ** NOTHING RUNS THIS AUTOMATICALLY, AND NOTHING IN THIS REPOSITORY EVER WILL. **
--
-- It deletes roughly 15,000 rows from a PRODUCTION identity table. That is a human's decision, it
-- needs a backup taken first, and it is not the kind of thing a monitor is allowed to do to the
-- service it monitors. The file is here so the statements are reviewed in a pull request rather
-- than typed into a psql session at midnight — which is how the estate's memory records the last
-- two incidents starting.
--
-- ── EVERY IDENTIFIER BELOW WAS CHECKED AGAINST THE LIVE SCHEMA ON 2026-08-11 ────────────────────
--
-- The first draft of this file was written from memory and NAMED FOUR OBJECTS THAT DO NOT EXIST:
-- `deliveries.channel_target_id` (the column is `target_id`), `email_verifications` (the table is
-- `email_verification_tokens`), `password_resets` (`password_reset_tokens`) and
-- `organisation_memberships` (`memberships`). Its very first statement would have failed. That is
-- the file arguing its own point: this repository cannot see identity's or notify's schema, so a
-- list of table names written here is a CLAIM, and the claim was wrong four times out of six.
--
-- Every name below has now been read out of `information_schema` and `pg_constraint` on the
-- running mainnet cluster. **Read them again before you run this.** Section 1 gives you the
-- queries. A migration merged since is enough to make this file wrong in the same way again.
--
-- ── WHAT THIS CLEANS UP, MEASURED ON MAINNET 2026-08-11T12:04Z (micro-org#390) ──────────────────
--
--   identity.users            15,467 rows total, of which 15,311 are `beacon+…@beacon.test`
--   identity.organisations    15,420 personal orgs, of which 15,311 have no non-beacon member
--   notify.channel_targets    13,243 email targets under `@beacon.test`
--   notify.notifications      26,487 rows for those users
--   notify.deliveries          1,535 rows against those targets
--
-- The estate has NO REAL USERS — the whole non-beacon population is 156 rows, and all but one of
-- them is under a domain that is itself reserved or tombstoned. That is a claim worth re-checking
-- rather than inheriting: step 1 below is the check, and it is not optional.
--
-- ── WHY THE ROWS EXISTED, AND WHY THEY STOP ────────────────────────────────────────────────────
--
-- Beacon registered a throwaway account per journey per cycle, because registration used to return
-- a session and eight journeys needed one. It no longer does — `POST /auth/register` answers 202
-- with no session — so the journeys sign in as a provisioned pool instead and only
-- `identity.register` still registers, at a thirty-minute floor.
--
-- **Verified on mainnet, not asserted.** beacon 2.5.20 started at 10:14:45Z on 2026-08-11. The
-- three registrations after it are 30 minutes apart to the second:
--
--     10:41:16   —
--     11:11:23   gap 1808s
--     11:41:29   gap 1806s
--
-- ~48 rows a day, against 2,231–2,256 a day for each of the six days before. **So this prune is a
-- one-off, and it is not a recurring job.** If it ever needs running twice for the same reason, the
-- fix is in beacon and not in a cron entry.
--
-- ** THE 48/DAY THAT REMAIN ARE STILL REAPED BY NOTHING. ** Identity has no account-deletion route
-- a monitor may call (`DELETE /users/me` demands the account's own password and opens a grace
-- window), so ~17,500 rows a year still accumulate — slowly enough to be somebody's decision rather
-- than an incident, but it IS still accumulating. An earlier draft of this file said section 4 held
-- "the retention policy" for them. There is no retention policy. Saying so is better than implying
-- one exists.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. THE BACKUP. NOT OPTIONAL, AND IT COMES FIRST.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- On the app host, before anything below. Mainnet is `cloudsforge-estate-postgres-1`; testnet is
-- `cf-testnet-postgres-1` and is a DIFFERENT CLUSTER with its own copy of both databases.
--
--     docker exec <pg> pg_dump -U cloudsforge -d identity -Fc -f /tmp/identity-preprune.dump
--     docker exec <pg> pg_dump -U cloudsforge -d notify   -Fc -f /tmp/notify-preprune.dump
--     docker cp <pg>:/tmp/identity-preprune.dump ./identity-preprune.dump
--     docker cp <pg>:/tmp/notify-preprune.dump   ./notify-preprune.dump
--
-- Verify the dumps are restorable BEFORE deleting anything — `pg_restore --list` on each file, and
-- check `users` and `channel_targets` appear in the listing with a TABLE DATA entry. A dump that
-- was never read back is a file, not a backup.
--
-- Two databases, because the residue spans two services and they are pruned by separate statements
-- against separate connections. There is no transaction that covers both, which is the next point.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE CHECKS. RUN THESE FIRST AND READ THE NUMBERS.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- `psql -U cloudsforge -d identity`:

select count(*) filter (where email like 'beacon+%@beacon.test') as beacon_rows,
       count(*) filter (where email not like 'beacon+%@beacon.test') as everything_else,
       count(*) as total
  from users;

-- Then look at what is NOT being deleted. By DOMAIN rather than by address: the population is a few
-- hundred rows, the question is "is any of this a person", and a domain census answers it without
-- printing anybody's address into a terminal's scrollback.

select lower(split_part(email, '@', 2)) as domain,
       status,
       count(*),
       count(*) filter (where last_seen_at is not null) as ever_seen,
       min(created_at)::date as first_seen,
       max(created_at)::date as last_seen
  from users
 where email not like 'beacon+%@beacon.test'
 group by 1, 2
 order by 3 desc;

-- ** IF ANY DOMAIN IN THAT LIST COULD BELONG TO SOMEBODY REAL, STOP AND LOOK AT IT BY HAND. ** On
-- mainnet on 2026-08-11 it returned five rows — `example.test` (97), `deleted.invalid` (51, and all
-- of them already `status = 'deleted'`), `example.invalid` (4), `example.com` (3) and ONE real
-- consumer mail domain holding a single account. That last row is why the census is here and why
-- the pattern is narrow: it is not matched by anything below, and it must not be.
--
-- The pattern is `beacon+%@beacon.test` and NOT `beacon+%`. `calls.ts`'s `throwaway()` mints only
-- the first shape, and the second would also match a real person whose address begins "beacon+" —
-- plus-addressing is a thing people use, and gmail hands it out by default. `calls.test.ts` reads
-- THIS FILE and asserts that its pattern and `throwaway()` still agree, in both directions.
--
-- Now enumerate the child tables against the LIVE schema, because the list in section 3 is a claim:

select con.conrelid::regclass::text as child_table,
       a.attname                    as fk_column,
       con.confdeltype              as on_delete   -- c=cascade  a=no action  r=restrict  n=set null
  from pg_constraint con
  join pg_attribute a
    on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
 where con.contype = 'f' and con.confrelid = 'users'::regclass
 order by 1;

-- On mainnet 2026-08-11 that returned fifteen rows. Ten are `c` and delete themselves with the
-- user. Five are not, and each is accounted for in section 3:
--
--   platform_role_grants.user_id     a   REFUSES the delete if a row exists. 0 rows for this
--                                        population — checked — so it is a guard rather than work.
--   memberships.invited_by           n   set null; a beacon account never invited anybody.
--   password_reset_tokens.issued_by  n   set null.
--   service_credentials.created_by   n   set null.
--   service_token_issues.issued_by   n   set null.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 2. NOTIFY FIRST, IDENTITY SECOND, AND THE ORDER IS DELIBERATE.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- There is no foreign key between the two databases — they are separate databases in one cluster,
-- and the estate's rule is that a service owns its own schema — so nothing enforces this ordering.
-- It is chosen so that the state BETWEEN the two steps is the harmless one:
--
--   * notify first, identity second: a notify target is deleted whose user still exists. The user
--     is a synthetic account that will never be mailed again. Nothing breaks.
--   * identity first, notify second: a notify target points at a user id that no longer resolves,
--     and every delivery attempt against it becomes an unresolvable reference in a service that
--     retries. That is a queue of permanent failures, which is a page.
--
-- If the operator stops halfway, stopping after step 2 is safe and stopping after step 3 is safe.
--
-- `psql -U cloudsforge -d notify`:

begin;

-- The notifications go first and take their own children with them: `deliveries.notification_id`
-- and `digest_entries.notification_id` are both `on delete cascade`, checked on the live schema.
-- 26,487 rows on mainnet — the largest single population in this file, and the one the first draft
-- of it missed entirely, which would have left notify holding a feed for 13,243 users that no
-- longer exist.
delete from notifications
 where user_id in (
   select user_id from channel_targets
    where channel = 'email' and address like 'beacon+%@beacon.test'
 );

-- Any delivery still pointing at one of these targets. There should be none left after the cascade
-- above; this is here because `deliveries.target_id` is `on delete SET NULL`, not cascade, so a
-- straggler would survive the next statement as a row with a null target rather than being refused.
-- A statement that deletes nothing is the outcome to hope for.
delete from deliveries
 where target_id in (
   select id from channel_targets
    where channel = 'email' and address like 'beacon+%@beacon.test'
 );

delete from channel_targets
 where channel = 'email' and address like 'beacon+%@beacon.test';

-- The `inbox` table is deliberately NOT touched. It is the consumed-event dedupe ledger, keyed by
-- (topic, event_id) with no user column at all — deleting from it would not remove residue, it
-- would make already-processed events eligible for reprocessing.

-- ROLLBACK first, read the row counts, and only then COMMIT. A delete whose count nobody looked at
-- is a delete nobody can describe afterwards.
-- rollback;
commit;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 3. IDENTITY.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- `psql -U cloudsforge -d identity`:
--
-- Ten of the fifteen child constraints cascade, so this is much shorter than it looks like it
-- should be — and that is exactly why section 1's `pg_constraint` query is not optional. The risk
-- here is not a missing delete (that fails loudly, which is fine); it is a CASCADE NOBODY EXPECTED
-- reaching a table that mattered. Read the `c` rows, not just the `a` rows.

begin;

-- The one constraint that would REFUSE the delete. 0 rows on mainnet 2026-08-11: a beacon
-- throwaway holds `roles = {player}` and no platform role grant has ever been made to one. Kept as
-- a statement rather than dropped, because "it was zero when I looked" is not a schema guarantee.
delete from platform_role_grants
 where user_id in (select id from users where email like 'beacon+%@beacon.test');

-- The orphaned personal organisations. Identity creates one `kind = 'personal'` org per account, so
-- there are 15,420 of them for 15,467 users, and `memberships` cascades from BOTH sides — meaning a
-- plain `delete from users` leaves 15,311 organisations with no members and no way to find them
-- afterwards except by the absence this query uses.
--
-- Computed and captured BEFORE the users are deleted, because after the delete the join that
-- identifies them no longer exists. The predicate is deliberately two-sided: an org qualifies only
-- if it has a beacon member AND has no non-beacon member. That excludes the 4 organisations that
-- already had no members at all on 2026-08-11 — they are not this population, and this file will
-- not guess at them.
create temporary table beacon_orgs on commit drop as
  select o.id
    from organisations o
   where exists (select 1 from memberships m join users u on u.id = m.user_id
                  where m.organisation_id = o.id and u.email like 'beacon+%@beacon.test')
     and not exists (select 1 from memberships m join users u on u.id = m.user_id
                      where m.organisation_id = o.id and u.email not like 'beacon+%@beacon.test');

-- Cascades to: auth_exchange_codes, devices, email_verification_tokens, memberships, mfa_challenges,
-- mfa_factors, password_reset_tokens, profiles, refresh_tokens, sessions. All `c` on the live
-- schema, all checked. `memberships.invited_by`, `password_reset_tokens.issued_by`,
-- `service_credentials.created_by` and `service_token_issues.issued_by` are `n` and go to null.
delete from users where email like 'beacon+%@beacon.test';

-- Now the orgs, whose memberships the cascade above has just removed.
delete from organisations where id in (select id from beacon_orgs);

-- The outbox is deliberately NOT touched, and it is the biggest table in the database (33,589 rows,
-- with 51,905 in outbox_deliveries). Its rows are facts that were already published to the bus and
-- consumed by activity; deleting them would not un-publish anything and would only remove the
-- record that it happened. They age out under identity's own retention, which is identity's
-- business and not a monitor's.

-- Same discipline: read the counts, then commit.
-- rollback;
commit;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. AFTERWARDS
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
--   * Run section 1's first query again. `beacon_rows` should be 0, `everything_else` UNCHANGED —
--     the second number is the one that proves nothing else was caught.
--   * `vacuum (analyze) users, organisations, memberships, profiles;` in identity and
--     `vacuum (analyze) notifications, deliveries, channel_targets;` in notify. Fifteen thousand
--     dead tuples in a table this small is most of it, and the planner will go on costing queries
--     as though they were still there.
--   * Run the whole thing again against the TESTNET cluster — `cf-testnet-postgres-1` — which has
--     the same residue from the same cause and its own copy of both databases. micro-org#390's own
--     closing rule applies here in full: a mainnet prune proves nothing about testnet, and the
--     numbers differ (9,399 of 9,431 users on 2026-08-11, not 15,311 of 15,467).
--   * Expect ~48 new `beacon+…@beacon.test` rows a day from `identity.register` and no more. If the
--     rate is higher than that, a journey has started registering again and the fix is in beacon.
