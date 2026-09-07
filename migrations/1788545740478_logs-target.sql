-- Up Migration

-- logs recorded who did what, but not to what.
--
-- RF-USR-07 asks for a trail over "each relevant record (project, status, file, invoice)".
-- logs(user_id, action_id, created_at) answers who and when and which verb, and stops
-- there: "who deleted this invoice" has no answer, because nothing on the row names the
-- invoice. The previous migration gave action_id a target table to reference; this one
-- gives the log entry a target row.
--
-- It also unblocks the decision in DATAMODEL.md §2.7 — status changes are recorded here
-- rather than in a status_history table of their own, so that there is one audit
-- mechanism instead of two.


ALTER TABLE logs ADD COLUMN target_table varchar(50);
ALTER TABLE logs ADD COLUMN target_id    bigint;
ALTER TABLE logs ADD COLUMN before_data  jsonb;
ALTER TABLE logs ADD COLUMN after_data   jsonb;

COMMENT ON COLUMN logs.target_table IS 'Table the action was performed on. Not a foreign key: the target is a different table per row';
COMMENT ON COLUMN logs.target_id IS 'Primary key of the affected row, within target_table';
COMMENT ON COLUMN logs.before_data IS 'Row before the change. NULL = the row was created';
COMMENT ON COLUMN logs.after_data IS 'Row after the change. NULL = the row was deleted';

-- No foreign key is possible: the target lives in a different table on every row, and
-- Postgres has no polymorphic reference. What can be enforced is that the two halves
-- travel together, which is the same num_nonnulls() pattern event_participants and
-- access_tokens already use. Zero is allowed on purpose: an action like user_login is a
-- real log entry with no object. One is always a bug — half a reference points nowhere.
ALTER TABLE logs ADD CONSTRAINT logs_target_complete
    CHECK (num_nonnulls(target_table, target_id) IN (0, 2));

-- Partial, because a large share of entries are session actions with no target and
-- indexing their nulls buys nothing. The predicate is invisible in the DBML snapshot —
-- the format cannot express it, exactly as with uq_users_email_live — so this file is the
-- only place that records it.
CREATE INDEX idx_logs_target ON logs (target_table, target_id)
    WHERE target_table IS NOT NULL;

-- before_data/after_data rather than before/after: both are non-reserved keywords in
-- Postgres and would parse, but they read as clauses rather than columns in a SELECT.
-- Together they make the shape of the change self-describing without consulting actions:
-- null before = insert, null after = delete, both present = update.


-- Down Migration

DROP INDEX IF EXISTS idx_logs_target;
ALTER TABLE logs DROP CONSTRAINT IF EXISTS logs_target_complete;
ALTER TABLE logs DROP COLUMN IF EXISTS after_data;
ALTER TABLE logs DROP COLUMN IF EXISTS before_data;
ALTER TABLE logs DROP COLUMN IF EXISTS target_id;
ALTER TABLE logs DROP COLUMN IF EXISTS target_table;
