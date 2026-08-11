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
-- ── WHAT THIS CLEANS UP, MEASURED ON MAINNET 2026-08-11 (micro-org#390) ─────────────────────────
--
--   identity.users            15,364 rows total, of which 15,210 are `beacon+…@beacon.test`
--                             2,231–2,256 created per day, one roughly every 38 seconds
--   notify.channel_targets    12,975 email targets under `@beacon.test`
--
-- The estate has NO REAL USERS — every account on both networks is beacon or test residue — so the
-- population being deleted here is synthetic in its entirety. That is a claim worth re-checking
-- rather than inheriting: step 1 below is the check, and it is not optional.
--
-- ── WHY THE ROWS EXISTED, AND WHY THEY STOP ────────────────────────────────────────────────────
--
-- Beacon registered a throwaway account per journey per cycle, because registration used to return
-- a session and eight journeys needed one. It no longer does — `POST /auth/register` answers 202
-- with no session — so the journeys sign in as a provisioned pool instead and only
-- `identity.register` still registers, at a thirty-minute cadence. That is ~48 rows a day rather
-- than ~2,250, from the one journey whose subject is registration.
--
-- **So this prune is a one-off, and it is not a recurring job.** If it ever needs running twice for
-- the same reason, the fix is in beacon and not in a cron entry. The 48/day that remain are the
-- honest cost of proving that people can still open accounts, and they are what the retention
-- policy in section 4 is for.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 0. THE BACKUP. NOT OPTIONAL, AND IT COMES FIRST.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- On the app host, before anything below:
--
--     docker exec cloudsforge-estate-postgres-1 \
--       pg_dump -U cloudsforge -d identity -Fc -f /tmp/identity-preprune.dump
--     docker cp cloudsforge-estate-postgres-1:/tmp/identity-preprune.dump ./identity-preprune.dump
--
--     docker exec cloudsforge-estate-postgres-1 \
--       pg_dump -U cloudsforge -d notify -Fc -f /tmp/notify-preprune.dump
--     docker cp cloudsforge-estate-postgres-1:/tmp/notify-preprune.dump ./notify-preprune.dump
--
-- Verify the dump is restorable BEFORE deleting anything — `pg_restore --list` on the file. A dump
-- that was never read back is a file, not a backup.
--
-- Two databases, because the residue spans two services and they are pruned by separate statements
-- against separate connections. There is no transaction that covers both, which is the next point.
--
-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 1. THE CHECK. RUN THIS FIRST AND READ THE NUMBERS.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
-- `psql -U cloudsforge -d identity`:

select count(*) filter (where email like 'beacon+%@beacon.test') as beacon_rows,
       count(*) filter (where email not like 'beacon+%@beacon.test') as everything_else,
       count(*) as total
  from users;

-- Then look at what is NOT being deleted, by eye, because "everything else" being small is the
-- whole safety argument for a LIKE pattern against a production table:

select id, email, status, created_at
  from users
 where email not like 'beacon+%@beacon.test'
 order by created_at
 limit 100;

-- ** IF ANY ROW IN THAT SECOND LIST IS SOMEBODY REAL, STOP. ** The pattern below is narrow, but a
-- narrow pattern applied to the wrong database is still the wrong delete, and `identity` on the
-- testnet project (`cf-testnet`) is a different database from `identity` on mainnet.
--
-- The pattern is `beacon+%@beacon.test` and NOT `beacon+%`. `calls.ts`'s `throwaway()` mints only
-- the first shape, and the second would also match a real person whose address begins "beacon+" —
-- plus-addressing is a thing people use, and gmail hands it out by default.

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
-- There is no ordering that makes stopping halfway free, and this is the one that makes it cheap.
--
-- `psql -U cloudsforge -d notify`:

begin;

-- Deliveries reference channel_targets, so they go first or the delete below is refused. This is
-- the FK the ticket's "whatever notify-side cleanup the FKs require" is asking about; check the
-- constraint names against the live schema before running, because a migration may have added one:
--
--     \d+ deliveries
--     select conname, conrelid::regclass, confrelid::regclass
--       from pg_constraint where confrelid = 'channel_targets'::regclass;

delete from deliveries
 where channel_target_id in (
   select id from channel_targets
    where channel = 'email' and address like 'beacon+%@beacon.test'
 );

delete from channel_targets
 where channel = 'email' and address like 'beacon+%@beacon.test';

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
-- ** THE CHILD TABLES ARE NOT ALL `ON DELETE CASCADE`, AND THIS IS THE PART TO CHECK BY HAND. **
-- Enumerate them against the live schema first rather than trusting this list, which was written on
-- 2026-08-11 and is a claim about a schema this repository cannot see:
--
--     select conrelid::regclass as child, conname, confdeltype
--       from pg_constraint
--      where confrelid = 'users'::regclass and contype = 'f'
--      order by 1;
--
-- `confdeltype` is `c` for cascade, `a` for no action, `r` for restrict. Every `a` and every `r` is
-- a table that must be deleted from explicitly below, or the whole statement is refused — which is
-- the good outcome. The bad outcome is a cascade nobody expected reaching a table that mattered, so
-- read the `c` rows too.

begin;

-- Explicit deletes for the children that do NOT cascade. Add or remove rows here to match what the
-- query above actually returned; a statement against a table that does not exist fails the
-- transaction, which is why this whole block is one.
delete from sessions where user_id in (select id from users where email like 'beacon+%@beacon.test');
delete from email_verifications where user_id in (select id from users where email like 'beacon+%@beacon.test');
delete from password_resets where user_id in (select id from users where email like 'beacon+%@beacon.test');
delete from mfa_factors where user_id in (select id from users where email like 'beacon+%@beacon.test');
delete from devices where user_id in (select id from users where email like 'beacon+%@beacon.test');
delete from organisation_memberships where user_id in (select id from users where email like 'beacon+%@beacon.test');

-- The outbox is deliberately NOT touched. Its rows are facts that were already published to the
-- bus and consumed by activity; deleting them would not un-publish anything and would only remove
-- the record that it happened. They age out under identity's own retention.

delete from users where email like 'beacon+%@beacon.test';

-- Same discipline: read the count, then commit.
-- rollback;
commit;

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- 4. AFTERWARDS
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--
--   * Run section 1's first query again. `beacon_rows` should be 0, `everything_else` unchanged.
--   * Run the same thing against the TESTNET project — `cf-testnet` — which has the same residue
--     from the same cause and is a separate cluster's worth of databases. micro-org#390's own
--     closing rule applies in reverse here: a mainnet prune proves nothing about testnet.
--   * `vacuum (analyze) users;` — 15,000 dead tuples in a table this small is most of it.
--   * Expect ~48 new `beacon+…@beacon.test` rows a day from `identity.register` and no more. If the
--     rate is higher than that, a journey has started registering again and the fix is in beacon.
