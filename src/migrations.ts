/**
 * The versioned schema.
 *
 * Rule 7 of docs/ecosystem/03 §2: versioned files, run by a one-shot job under an advisory lock,
 * expand/contract only. Nothing here is executed by `index.ts` — `src/migrator.ts` is the only
 * caller, and the service asserts the version rather than reaching it.
 *
 * The service this supersedes has no migration framework: `db.js:52-172` is one `sql.unsafe` of
 * idempotent DDL run on every boot, with no version table, no ordering guarantee and no advisory
 * lock. Two replicas booting together race on `pg_type` and one crash-loops, which is a large part
 * of why the frozen estate cannot run a second replica of anything.
 *
 * ---------------------------------------------------------------------------------------------
 * **WHAT IS STRUCTURALLY NEW HERE, AND WHY EACH ONE EXISTS.**
 *
 *   `probes` IS A TABLE.      The frozen monitor's target list is nineteen environment variables
 *                             and 922 lines of `targets.js`. Adding a service to the estate meant
 *                             editing the monitor. A row means it does not.
 *
 *   `probe_state` IS A TABLE. Hysteresis — `consecutiveFail`, `consecutiveOk`, the reported state
 *                             — lives in a module-scope `Map` in the frozen service
 *                             (`store.js:17`). Two replicas therefore each hold half the evidence,
 *                             each count to three separately, and neither ever gets there. State
 *                             shared between replicas belongs in the database they share.
 *
 *   `slos` AND                A budget must be SPENDABLE, so it is arithmetic over recorded
 *   `slo_observations` EXIST. integer counts, not a float gauge. `good` and `total` are `bigint`
 *                             for the same reason a money column is: a ratio computed from two
 *                             exact integers can be audited, and a stored float cannot.
 *
 *   `gate_decisions` EXISTS.  The gate is a decision, and a decision nobody can look up afterwards
 *                             is an opinion. Every evaluation is recorded with its reasons,
 *                             including the refusals — especially the refusals.
 *
 *   `gate_overrides` EXISTS.  A break-glass that is a row, with an author, a reason, an expiry and
 *                             the exact reason code it waives. See `gate.ts`: an override may
 *                             waive a KNOWN failure and may never waive an UNKNOWN one.
 * ---------------------------------------------------------------------------------------------
 */

import { JOBS_SCHEMA_SQL } from '@cloudsforge/jobs'
import type { Migration } from '@cloudsforge/db'

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'jobs',
    // Taken verbatim from the runtime package so the table the claim query assumes and the table
    // that exists cannot drift.
    up: JOBS_SCHEMA_SQL,
  },
  {
    version: 2,
    name: 'probes',
    up: `
      -- The probe catalogue. A ROW, not an environment variable — see the header.
      create table if not exists probes (
        id             uuid        primary key default gen_random_uuid(),
        name           text        not null,
        -- The estate's own name for the thing being probed, e.g. 'ledger'. Used as a metric
        -- label, so it is bounded by the number of services rather than by anything a caller
        -- controls: 13-operational-model §13 budgets 500k active series.
        target         text        not null,
        -- The product group the public projection rolls this up into. NEVER the target name:
        -- 'Wallet', not 'pay.rates'. See publicstatus.ts.
        product_group  text        not null,
        url            text        not null,
        method         text        not null default 'GET',
        expect_status  integer     not null default 200,
        interval_ms    integer     not null,
        deadline_ms    integer     not null,
        -- A non-critical probe cannot open a SEV1 and cannot refuse a release on its own.
        critical       boolean     not null default true,
        enabled        boolean     not null default true,
        created_at     timestamptz not null default now(),
        constraint probes_name_uniq unique (name),
        -- A deadline at or above the cadence lets one attempt still be running when the next is
        -- due. The lease stops two workers taking one probe; this stops the schedule stretching
        -- past its own period, which is how a monitor's resolution collapses exactly when the
        -- network goes bad.
        constraint probes_deadline_below_interval check (deadline_ms < interval_ms),
        constraint probes_deadline_positive check (deadline_ms > 0)
      );

      -- Hysteresis state, one row per probe. In the database rather than in a process, because
      -- two replicas each counting to three separately never reach three.
      create table if not exists probe_state (
        probe_name       text        primary key references probes (name) on delete cascade,
        reported_state   text        not null default 'pending',
        -- The state this row held BEFORE the write that produced the current one.
        --
        -- Not history and not a convenience: it is what makes "did this check open an incident?"
        -- answerable from the single atomic upsert that records the check. The alternative is
        -- read-then-write, and two replicas doing read-then-write against one probe is how the
        -- same outage opens two incidents — which is the exact bug the partial unique index on
        -- incidents exists to catch, caught one layer earlier and without relying on a
        -- constraint violation as control flow.
        previous_state   text        not null default 'pending',
        consecutive_fail integer     not null default 0,
        consecutive_ok   integer     not null default 0,
        since            timestamptz not null default now(),
        last_ok_at       timestamptz,
        -- NULLABLE, and null means "never checked" rather than "checked at creation".
        --
        -- The scheduler's due query reads "updated_at is null or updated_at + interval <= now()",
        -- so defaulting this to now() would make every newly added probe wait a full interval before
        -- its first run. A monitor that shows pending for thirty seconds after a deploy is a
        -- monitor nobody trusts during the deploy, which is when it is read most.
        updated_at       timestamptz,
        constraint probe_state_known check (reported_state in ('pending','up','degraded','down'))
      );

      -- Every probe result, raw. The bulk of the data and the shortest-lived: once an hour is
      -- rolled up, the individual samples inside it answer no question anyone asks a fortnight
      -- later.
      create table if not exists checks (
        id          bigserial   primary key,
        ts          timestamptz not null default now(),
        probe_name  text        not null,
        target      text        not null,
        state       text        not null,
        status_code integer,
        latency_ms  integer,
        error       text,
        constraint checks_state_known check (state in ('up','degraded','down'))
      );
      create index if not exists checks_ts_idx        on checks (ts desc);
      create index if not exists checks_probe_ts_idx  on checks (probe_name, ts desc);

      -- Hourly aggregate. Small, and the only thing a 90-day uptime bar reads — which is why it
      -- outlives the raw rows by more than a year. THIS is the table AD-20's 400-day retention
      -- actually describes; Prometheus cannot downsample and never could.
      create table if not exists check_rollups (
        probe_name  text        not null,
        bucket      timestamptz not null,
        total       integer     not null,
        up          integer     not null,
        degraded    integer     not null,
        down        integer     not null,
        latency_p50 integer,
        latency_p95 integer,
        primary key (probe_name, bucket)
      );
      create index if not exists check_rollups_bucket_idx on check_rollups (bucket desc);
    `,
  },
  {
    version: 3,
    name: 'journeys',
    up: `
      -- The journey registry. Definitions live in code (src/journeys.ts); this row carries the
      -- OPERATOR state that must survive a restart and be shared between replicas — above all
      -- \`muted\`, whose count must be zero at every gate (17-definition-of-done.md:237).
      create table if not exists journeys (
        name          text        primary key,
        title         text        not null,
        product_group text        not null,
        -- A critical-path journey: register, sign in, SSO handoff, deposit, convert, spend,
        -- withdraw, mint deploy, market purchase (13-operational-model.md:435).
        critical      boolean     not null default false,
        muted         boolean     not null default false,
        muted_reason  text,
        muted_by      text,
        muted_at      timestamptz,
        created_at    timestamptz not null default now(),
        -- A mute without an attributed reason is an unmeasured journey nobody owns. The database
        -- refuses one, so "we'll write it up later" cannot commit.
        constraint journeys_mute_is_attributed check (
          muted = false or (muted_reason is not null and muted_by is not null)
        )
      );

      create table if not exists journey_runs (
        run_id      uuid        primary key,
        journey     text        not null references journeys (name) on delete cascade,
        started_at  timestamptz not null,
        duration_ms integer     not null,
        status      text        not null,
        failed_step text,
        error       text,
        -- 'schedule' | 'manual' | 'gate'. A MANUAL run never opens or closes an incident: the
        -- first thing an operator does during an outage is hit Run, and that must not resolve the
        -- incident they are looking at.
        trigger     text        not null,
        -- The release candidate this run was executed against, when it was executed for a gate.
        release_tag text,
        constraint journey_runs_status_known check (status in ('pass','fail','error','skip'))
      );
      create index if not exists journey_runs_journey_ts_idx on journey_runs (journey, started_at desc);
      create index if not exists journey_runs_release_idx    on journey_runs (release_tag, started_at desc)
        where release_tag is not null;

      -- Steps are their own rows rather than a jsonb array, so "how long has checkout taken, per
      -- day, for a month" is an index scan instead of a scan through documents.
      create table if not exists journey_steps (
        id          bigserial   primary key,
        run_id      uuid        not null references journey_runs (run_id) on delete cascade,
        seq         integer     not null,
        name        text        not null,
        status      text        not null,
        duration_ms integer     not null,
        error       text,
        constraint journey_steps_seq_uniq unique (run_id, seq)
      );
    `,
  },
  {
    version: 4,
    name: 'incidents',
    up: `
      create table if not exists incidents (
        id            uuid        primary key default gen_random_uuid(),
        -- 'probe' | 'journey' | 'slo' | 'alert' | 'manual'
        scope         text        not null,
        subject       text        not null,
        -- SEV1..SEV4, the ladder in 13-operational-model.md:529. The frozen service has only
        -- minor|major, which cannot express "money at risk" and so expresses nothing.
        severity      text        not null,
        -- detected -> declared -> mitigated -> resolved -> reviewed (13-operational-model.md:570).
        -- Mitigation precedes diagnosis, and the state machine says so.
        state         text        not null default 'detected',
        product_group text        not null,
        opened_at     timestamptz not null default now(),
        closed_at     timestamptz,
        cause         text,
        last_error    text,
        -- How many failures have been folded into this ONE incident. This is the dedupe counter:
        -- a probe failing every thirty seconds for an hour is one incident with failures=120, not
        -- a hundred and twenty incidents.
        failures      integer     not null default 1,
        -- alert | journey | probe | manual | customer. The ratio of customer-reported to
        -- self-detected is a tracked monthly number; above 10% means the monitoring is wrong.
        detected_by   text        not null default 'probe',
        constraint incidents_severity_known check (severity in ('sev1','sev2','sev3','sev4')),
        constraint incidents_state_known check (
          state in ('detected','declared','mitigated','resolved','reviewed')
        ),
        -- A closed incident must be in a terminal state, and an open one must not be. Without
        -- this an incident can be "resolved" and still open, which is how a status page shows a
        -- resolved outage for a week.
        constraint incidents_closed_is_terminal check (
          (closed_at is null and state in ('detected','declared','mitigated'))
          or (closed_at is not null and state in ('resolved','reviewed'))
        )
      );
      create index if not exists incidents_opened_idx on incidents (opened_at desc);

      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- ONE OPEN INCIDENT PER SUBJECT, ENFORCED BY THE DATABASE.
      --
      -- A partial unique index rather than application logic, because two probe cycles overlapping
      -- is exactly how a duplicate is produced and exactly the case nobody tests. With it, the
      -- second open is an ON CONFLICT that increments \`failures\`; without it, an outage produces
      -- one incident per probe and the page it opens is unreadable at the moment it matters.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create unique index if not exists incidents_open_uniq
        on incidents (scope, subject) where closed_at is null;

      create table if not exists incident_updates (
        id          uuid        primary key default gen_random_uuid(),
        incident_id uuid        not null references incidents (id) on delete cascade,
        at          timestamptz not null default now(),
        author      text        not null,
        body        text        not null,
        -- One incident, two audiences, ONE WRITE. A separate public record is a second thing to
        -- keep true during the twenty minutes nobody has time to keep anything true.
        is_public   boolean     not null default false
      );
      create index if not exists incident_updates_incident_idx on incident_updates (incident_id, at);

      create table if not exists maintenance_windows (
        id            uuid        primary key default gen_random_uuid(),
        product_group text        not null,
        summary       text        not null,
        starts_at     timestamptz not null,
        ends_at       timestamptz not null,
        created_at    timestamptz not null default now(),
        constraint maintenance_windows_ordered check (ends_at > starts_at)
      );
    `,
  },
  {
    version: 5,
    name: 'slos',
    up: `
      -- ════════════════════════════════════════════════════════════════════════════════════════
      -- AN SLO NEEDS A WINDOW AND A BUDGET, AND THE BUDGET MUST BE SPENDABLE.
      --
      -- \`objective_ppm\` is PARTS PER MILLION as an integer: 99.95% is 999500, 99.5% is 995000,
      -- and 100% is 1000000. Not a float. A budget computed from a float objective is a budget
      -- whose remaining figure changes depending on which service computed it, and the whole
      -- point of an error budget is that both sides agree on the number when one of them wants to
      -- ship and the other does not.
      --
      -- 1000000 means NO BUDGET — the ledger's trial-balance SLI is "100%, no budget"
      -- (13-operational-model.md:415). The arithmetic in slo.ts handles that as zero allowed bad
      -- events rather than as a special case, so a single bad minute exhausts it. That is correct.
      -- ════════════════════════════════════════════════════════════════════════════════════════
      create table if not exists slos (
        name         text        primary key,
        service      text        not null,
        tier         integer     not null,
        -- 'availability' | 'journey' | 'latency' | 'correctness'
        kind         text        not null,
        objective_ppm bigint     not null,
        window_days  integer     not null default 28,
        enabled      boolean     not null default true,
        created_at   timestamptz not null default now(),
        constraint slos_objective_range check (objective_ppm > 0 and objective_ppm <= 1000000),
        constraint slos_tier_range check (tier between 1 and 3),
        constraint slos_window_positive check (window_days > 0)
      );

      -- Recorded observations, in whole events. \`good\` and \`total\` are bigint and are only ever
      -- INCREMENTED, never overwritten with a recomputed figure — a counter that can go down is a
      -- counter that hides the thing it was counting.
      create table if not exists slo_observations (
        slo_name text        not null references slos (name) on delete cascade,
        bucket   timestamptz not null,
        good     bigint      not null default 0,
        total    bigint      not null default 0,
        primary key (slo_name, bucket),
        constraint slo_observations_good_within_total check (good >= 0 and good <= total)
      );
      create index if not exists slo_observations_bucket_idx on slo_observations (bucket desc);
    `,
  },
  {
    version: 6,
    name: 'conformance',
    up: `
      -- One row per conformance suite execution. The corpus is @cloudsforge/conformance's; what
      -- this table holds is the OPERATIONAL fact that it was run and what it said.
      --
      -- \`breaking\` is the column the gate reads. The corpus classifies every difference as
      -- identical / benign / breaking, and only breaking blocks: exiting non-zero on benign
      -- differences would fire on every routine release, and a gate that fires on every release
      -- gets removed.
      create table if not exists conformance_runs (
        id          uuid        primary key default gen_random_uuid(),
        ts          timestamptz not null default now(),
        suite       text        not null,
        status      text        not null,
        identical   integer     not null default 0,
        benign      integer     not null default 0,
        breaking    integer     not null default 0,
        skipped     integer     not null default 0,
        duration_ms integer,
        release_tag text,
        corpus_ref  text,
        constraint conformance_runs_status_known check (status in ('pass','fail','skip','error')),
        -- A suite that could not be run reports 'skip' and NEVER under passed. "If a vector cannot
        -- be made to pass, the correct response is to say so, not to skip it" — and a skip that
        -- counted as a pass is precisely how a suite nobody has executed for a month reads green.
        constraint conformance_runs_pass_ran_something check (
          status <> 'pass' or (identical + benign) > 0
        ),
        constraint conformance_runs_pass_has_no_breaking check (status <> 'pass' or breaking = 0)
      );
      create index if not exists conformance_runs_suite_ts_idx on conformance_runs (suite, ts desc);
    `,
  },
  {
    version: 7,
    name: 'gate',
    up: `
      -- Every evaluation of the gate, kept. Including — especially — the refusals: "we shipped it
      -- anyway" is a sentence that needs a row behind it, and a refusal nobody can look up is an
      -- argument rather than a record.
      create table if not exists gate_decisions (
        id           uuid        primary key default gen_random_uuid(),
        release_tag  text        not null,
        decided_at   timestamptz not null default now(),
        -- 'promote' | 'promote_with_override' | 'refuse'
        decision     text        not null,
        -- Machine-readable reason codes, so a pipeline can branch on WHY rather than on prose.
        reasons      jsonb       not null default '[]'::jsonb,
        -- True when at least one input could not be determined. An indeterminate gate is always a
        -- refusal; this column is what lets an operator tell "we know it is broken" from "we do
        -- not know anything", which are different problems with different fixes.
        indeterminate boolean    not null default false,
        evaluated_by text        not null default 'beacon',
        constraint gate_decisions_known check (
          decision in ('promote','promote_with_override','refuse')
        ),
        -- An indeterminate evaluation may never promote. The rule is in gate.ts and it is ALSO
        -- here, because a check that exists only in the language that is easiest to change is a
        -- check that will be changed.
        constraint gate_decisions_indeterminate_never_promotes check (
          indeterminate = false or decision = 'refuse'
        )
      );
      create index if not exists gate_decisions_release_idx on gate_decisions (release_tag, decided_at desc);

      -- The break-glass. A ROW: attributed, expiring, and naming the exact reason code it waives.
      create table if not exists gate_overrides (
        id           uuid        primary key default gen_random_uuid(),
        release_tag  text        not null,
        -- The ONE reason code this waives. Never a blanket "ignore everything": an override that
        -- waives whatever happens to be wrong waives the thing nobody had noticed yet.
        reason_code  text        not null,
        -- And the ONE subject it waives it for — a journey name, an SLO name, a suite. '*' is
        -- permitted and is deliberately ugly to type, because "every failing journey" is a thing
        -- an operator should have to mean.
        subject      text        not null default '*',
        reason       text        not null,
        requested_by text        not null,
        created_at   timestamptz not null default now(),
        expires_at   timestamptz not null,
        constraint gate_overrides_expires_after_creation check (expires_at > created_at),
        constraint gate_overrides_reason_is_written check (length(btrim(reason)) >= 16),
        constraint gate_overrides_release_code_uniq unique (release_tag, reason_code, subject)
      );
      create index if not exists gate_overrides_release_idx on gate_overrides (release_tag);
    `,
  },
]

/**
 * The schema version this build of the service requires.
 *
 * `index.ts` asserts it and refuses to serve below it. That matters here for one reason above the
 * others: below version 4 the partial unique index `incidents_open_uniq` may not exist, and
 * without it an outage opens one incident per probe cycle.
 */
export const SCHEMA_VERSION = MIGRATIONS.length

/**
 * A new service, so there is nothing to baseline over. Zero makes the option a no-op rather than
 * a lie, and stating it is how the next person knows it was considered.
 */
export const BASELINE_VERSION = 0

/** Every table this service owns. The test harness truncates exactly these — see `testsupport.ts`. */
export const TABLES: readonly string[] = [
  'gate_overrides',
  'gate_decisions',
  'conformance_runs',
  'slo_observations',
  'slos',
  'maintenance_windows',
  'incident_updates',
  'incidents',
  'journey_steps',
  'journey_runs',
  'journeys',
  'check_rollups',
  'checks',
  'probe_state',
  'probes',
]
