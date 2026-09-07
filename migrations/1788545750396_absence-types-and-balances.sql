-- Up Migration

-- Leave had no type dimension, and a permit had no status.
--
-- The model being replaced was one integer and one bucket: contract_types.annual_offdays
-- for the cap, days_off(user_id, year, amount, used) for the balance. Four requirements
-- cannot be expressed on top of that shape, and the first one is the reason this cannot
-- wait for real data:
--
--   RF-AUS-04 — caps belong to (contract scheme x absence type x validity period), and
--               changing one must NOT rewrite history already consumed. A mutable integer
--               on contract_types does precisely what the requirement forbids: raise the
--               figure after a collective-contract change and every past balance silently
--               reinterprets itself against a cap that was not in force at the time.
--   RF-AUS-03 — the catalogue of absence types is configured from the application, with
--               its counting unit, cap, validity and whether it consumes balance.
--   RF-AUS-05 — individual exceptions, such as the days that grow with seniority in the
--               sindicalizado scheme, without inventing areas or groups to hold them.
--   RF-AUS-14 — a permit has its own status (solicitado, autorizado, rechazado, cancelado,
--               gozado) with the user and date of each change. absences carried only
--               approved_by/approved_at, so rejected and cancelled were unrepresentable —
--               and RF-AUS-06 requires restoring balance on cancellation, which needs the
--               cancelled state to exist.


-- 1. The catalogue of absence types
--
-- consumes_balance is what makes RF-AUS-09 sayable at all: institutional non-working days
-- apply to staff without drawing down anyone's allowance, and until now there was no way
-- to distinguish them from a permit that does.

CREATE TABLE absence_types (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- vacaciones, permiso_economico, incapacidad, dia_institucional
    code              varchar(50)  NOT NULL UNIQUE,
    label             varchar(200) NOT NULL,
    -- How the allowance is counted for this type. RF-AUS-03, "unidad de conteo"
    unit              varchar(10)  NOT NULL,
    consumes_balance  boolean NOT NULL DEFAULT true,
    requires_document boolean NOT NULL DEFAULT false,
    is_active         boolean NOT NULL DEFAULT true,
    CONSTRAINT absence_types_unit_valid CHECK (unit IN ('day', 'hour'))
);
COMMENT ON COLUMN absence_types.code IS 'vacaciones, permiso_economico, incapacidad, dia_institucional';
COMMENT ON COLUMN absence_types.unit IS 'How the allowance is counted for this type: day or hour. RF-AUS-03';
COMMENT ON COLUMN absence_types.consumes_balance IS 'RF-AUS-09: false for institutional non-working days, which apply without drawing down an allowance';


-- 2. Caps per contract scheme, with a validity period
--
-- This is RF-AUS-04 made structural. Changing a cap CLOSES the current row by setting
-- valid_to and inserts a new one; it is never an UPDATE of amount. A balance consumed
-- under the old contract keeps being explained by the cap that was in force when it was
-- consumed, which is the whole point.

CREATE TABLE contract_type_entitlements (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    contract_type_id bigint NOT NULL REFERENCES contract_types (id),
    absence_type_id  bigint NOT NULL REFERENCES absence_types (id),
    amount           numeric(6,2) NOT NULL,
    valid_from       date NOT NULL,
    -- NULL = still in force
    valid_to         date,
    CONSTRAINT cte_amount_nonneg CHECK (amount >= 0),
    CONSTRAINT cte_valid_range   CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
COMMENT ON TABLE contract_type_entitlements IS 'RF-AUS-04. A cap change closes the current row with valid_to and inserts a new one; amount is never updated in place, so consumed history keeps the cap that was in force at the time.';
COMMENT ON COLUMN contract_type_entitlements.valid_to IS 'NULL = still in force';

CREATE INDEX idx_cte_contract_type_id ON contract_type_entitlements (contract_type_id);
CREATE INDEX idx_cte_absence_type_id  ON contract_type_entitlements (absence_type_id);

-- Two overlapping validity periods for the same scheme and type would make "the cap on
-- date D" ambiguous, and would do it silently: whichever row the query happened to pick
-- would look like an answer. A unique key cannot express this, because the conflict is
-- between ranges rather than values. btree_gist is what lets equality on the two bigints
-- share a gist index with the range overlap operator; it ships with the official Postgres
-- image.
--
-- Drop this constraint and the extension with it if that dependency is unwanted — the
-- fallback is UNIQUE (contract_type_id, absence_type_id, valid_from) plus an overlap check
-- in orchestration. Note that DBML cannot express EXCLUDE either, so like the partial
-- indexes this constraint is invisible in the snapshot and lives only here.
CREATE EXTENSION IF NOT EXISTS btree_gist;
ALTER TABLE contract_type_entitlements ADD CONSTRAINT cte_no_overlap
    EXCLUDE USING gist (
        contract_type_id WITH =,
        absence_type_id  WITH =,
        (daterange(valid_from, valid_to, '[]')) WITH &&
    );


-- 3. Balances, per person and per type
--
-- Replaces days_off. granted starts as a copy of the scheme's cap and can be raised for
-- one person without touching anyone else: that is RF-AUS-05, the seniority days in the
-- sindicalizado scheme, with no artificial area or group to hold them.
--
-- The cycle is a pair of dates rather than a `year` integer on purpose. Whether leave runs
-- on the calendar year or on each person's contract anniversary is still undecided, and
-- for the sindicalizado scheme the two do not coincide. Dates let either be seeded without
-- another migration, which turns an open modelling question into an operational one.

CREATE TABLE leave_balances (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint NOT NULL REFERENCES users (id),
    absence_type_id bigint NOT NULL REFERENCES absence_types (id),
    cycle_start     date NOT NULL,
    cycle_end       date NOT NULL,
    granted         numeric(6,2) NOT NULL,
    used            numeric(6,2) NOT NULL DEFAULT 0,
    note            text,
    CONSTRAINT lb_cycle_range    CHECK (cycle_end >= cycle_start),
    CONSTRAINT lb_granted_nonneg CHECK (granted >= 0),
    CONSTRAINT lb_used_within    CHECK (used >= 0 AND used <= granted)
);
COMMENT ON TABLE leave_balances IS 'One row per person, type and cycle. RF-AUS-15. The cycle is a date range rather than a year, so calendar-year and contract-anniversary cycles both fit.';
COMMENT ON COLUMN leave_balances.granted IS 'Starts as a copy of the scheme cap; raised individually for RF-AUS-05 exceptions such as seniority days';

-- The two CHECKs above are the ones days_off carried, now scoped per type.
CREATE UNIQUE INDEX uq_leave_balances_user_type_cycle
    ON leave_balances (user_id, absence_type_id, cycle_start);
CREATE INDEX idx_leave_balances_user_id ON leave_balances (user_id);


-- 4. Status on the permit, and its history
--
-- absence_type_id enters nullable and is tightened to NOT NULL in section 5, after the
-- backfill. Adding it NOT NULL now would fail on any existing row.

ALTER TABLE absences ADD COLUMN absence_type_id bigint REFERENCES absence_types (id);
ALTER TABLE absences ADD COLUMN status varchar(20) NOT NULL DEFAULT 'requested';

-- Existing rows predate the concept. approved_at is the only evidence available of what
-- state they are in, and it is enough: a row that was approved is approved.
UPDATE absences SET status = CASE WHEN approved_at IS NOT NULL THEN 'approved'
                                  ELSE 'requested' END;

ALTER TABLE absences ADD CONSTRAINT absences_status_valid
    CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled', 'taken'));
COMMENT ON COLUMN absences.status IS 'RF-AUS-14: solicitado, autorizado, rechazado, cancelado, gozado';

CREATE INDEX idx_absences_status ON absences (status);
CREATE INDEX idx_absences_absence_type_id ON absences (absence_type_id);

-- A table of its own, and NOT entries in logs, which is the general rule stated in
-- DATAMODEL.md §2.7. The exception is deliberate and the reason is confidentiality:
-- RF-AUS-13 restricts who may see the detail of a permit, and putting that trail in the
-- general audit log would mean every query against logs has to remember to exclude
-- target_table = 'absences' or leak it. Keeping everything restricted inside absence_*
-- tables leaves one contiguous boundary to guard instead of a filter to remember.
CREATE TABLE absence_status_history (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id   bigint NOT NULL REFERENCES absences (event_id) ON DELETE CASCADE,
    status     varchar(20) NOT NULL,
    changed_by bigint REFERENCES users (id),
    changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    note       text,
    CONSTRAINT ash_status_valid
        CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled', 'taken'))
);
COMMENT ON TABLE absence_status_history IS 'RF-AUS-14: user and date on every status change. Separate from logs because RF-AUS-13 restricts who may read the detail of a permit.';

CREATE INDEX idx_absence_status_history_event_id ON absence_status_history (event_id);


-- 5. Migrating the old shape, then removing it
--
-- A seed type is required before anything can be moved: the old model had exactly one
-- undifferentiated bucket of days, and vacaciones is what it was being used for.

INSERT INTO absence_types (code, label, unit, consumes_balance)
VALUES ('vacaciones', 'Vacaciones', 'day', true);

-- valid_from is set far enough back to cover every balance already consumed. A later date
-- would leave historical rows with no cap in force to explain them, which is the exact
-- failure RF-AUS-04 is about.
INSERT INTO contract_type_entitlements
       (contract_type_id, absence_type_id, amount, valid_from)
SELECT ct.id, atype.id, ct.annual_offdays, DATE '2000-01-01'
FROM contract_types ct
CROSS JOIN absence_types atype
WHERE atype.code = 'vacaciones';

INSERT INTO leave_balances
       (user_id, absence_type_id, cycle_start, cycle_end, granted, used)
SELECT d.user_id, atype.id,
       make_date(d.year, 1, 1), make_date(d.year, 12, 31),
       d.amount, d.used
FROM days_off d
CROSS JOIN absence_types atype
WHERE atype.code = 'vacaciones';

UPDATE absences
SET absence_type_id = (SELECT id FROM absence_types WHERE code = 'vacaciones')
WHERE absence_type_id IS NULL;

ALTER TABLE absences ALTER COLUMN absence_type_id SET NOT NULL;

DROP TABLE days_off;
ALTER TABLE contract_types DROP COLUMN annual_offdays;


-- 6. Availability without exposing the reason
--
-- Because a permit now has status from the moment it is requested, and the absence is
-- still the event, events on its own over-reports: it would show rejected and cancelled
-- permits as people being away. Filtering means joining absences — the table RF-AUS-13
-- restricts.
--
-- This view is the seam. It exposes dates, person and area and nothing else: no reason, no
-- document_file_id, not even the status. Availability consumers (RF-TSK-06, RF-TSK-07,
-- RF-CAL-05, RF-CAL-06) read this instead of the base tables, and the RF-EST-10
-- notification is built from it, which is what makes it carry dates and duration but never
-- the motive. Stating the rule once in the schema beats repeating it in every query.
--
-- Recurring absences are represented here by their first occurrence, exactly as in events:
-- expansion for a requested window happens at read time.
CREATE VIEW absence_availability AS
SELECT e.id AS event_id,
       e.starts_at,
       e.ends_at,
       e.all_day,
       e.timezone,
       e.rule,
       e.recurrence_until,
       ep.user_id,
       ep.area_id
FROM events e
JOIN absences a ON a.event_id = e.id
JOIN event_participants ep ON ep.event_id = e.id
WHERE a.status IN ('approved', 'taken');

COMMENT ON VIEW absence_availability IS 'RF-AUS-12: who is away and when, with the reason and the backing document deliberately absent. Read this rather than absences for anything to do with availability.';


-- Down Migration

DROP VIEW IF EXISTS absence_availability;

-- Rebuild contract_types.annual_offdays from the entitlement that replaced it. Nullable
-- first, because the column was NOT NULL and there may be schemes with no vacaciones row.
ALTER TABLE contract_types ADD COLUMN annual_offdays int;
UPDATE contract_types ct
SET annual_offdays = COALESCE((
    SELECT round(cte.amount)::int
    FROM contract_type_entitlements cte
    JOIN absence_types atype ON atype.id = cte.absence_type_id
    WHERE cte.contract_type_id = ct.id
      AND atype.code = 'vacaciones'
      AND cte.valid_to IS NULL
    ORDER BY cte.valid_from DESC
    LIMIT 1
), 0);
ALTER TABLE contract_types ALTER COLUMN annual_offdays SET NOT NULL;

-- One row per user per year. No annual reset job needed.
CREATE TABLE days_off (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id  bigint NOT NULL,
    year     int NOT NULL,
    amount   int NOT NULL,
    used     int NOT NULL DEFAULT 0
);
COMMENT ON TABLE days_off IS 'One row per user per year. No annual reset job needed.';
CREATE UNIQUE INDEX days_off_idx_leave_balances_user_id_year ON days_off (user_id, year);
ALTER TABLE days_off ADD CONSTRAINT fk_days_off_user_id_users_id
    FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE days_off ADD CONSTRAINT days_off_amount_nonneg CHECK (amount >= 0);
ALTER TABLE days_off ADD CONSTRAINT days_off_used_within_amount
    CHECK (used >= 0 AND used <= amount);

-- This reversal is asymmetric, and it is the reason this migration would not be safe to
-- roll back against production data. Only vacaciones balances can come back, because the
-- old schema has nowhere to put any other type; balances for types added after this
-- migration are dropped here. Fractional amounts are rounded, since the old columns are
-- int. Acceptable on a fixes branch, not acceptable once real leave is recorded.
INSERT INTO days_off (user_id, year, amount, used)
SELECT lb.user_id,
       EXTRACT(YEAR FROM lb.cycle_start)::int,
       round(lb.granted)::int,
       round(lb.used)::int
FROM leave_balances lb
JOIN absence_types atype ON atype.id = lb.absence_type_id
WHERE atype.code = 'vacaciones';

DROP TABLE IF EXISTS absence_status_history;

DROP INDEX IF EXISTS idx_absences_absence_type_id;
DROP INDEX IF EXISTS idx_absences_status;
ALTER TABLE absences DROP CONSTRAINT IF EXISTS absences_status_valid;
ALTER TABLE absences DROP COLUMN IF EXISTS status;
ALTER TABLE absences DROP COLUMN IF EXISTS absence_type_id;

DROP TABLE IF EXISTS leave_balances;
DROP TABLE IF EXISTS contract_type_entitlements;
DROP TABLE IF EXISTS absence_types;

-- btree_gist is left installed on purpose: dropping an extension is a database-wide act
-- and something else may have come to depend on it.
