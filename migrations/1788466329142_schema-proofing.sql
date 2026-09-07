-- Up Migration

-- Corrections to the original schema, found while modelling file storage. Nothing here
-- is about files except the last section, which needed the `files` table to exist first.


-- 1. Leadership was stored in three places
--
-- roles.name = 'area_lead', areas.lead_user_id, and area_members.is_area_leader all
-- answered "who leads this area", and nothing kept them agreeing. area_members is the
-- only one that can be right: leadership is per-area, so the same person can lead one
-- area and be an ordinary member of another, which a column on areas cannot express.
--
-- Dropping the column also breaks the circular foreign key between areas and users
-- (areas.lead_user_id -> users.id, users.primary_area_id -> areas.id), which forced
-- every area/lead pair to be created with an insert followed by an update.

INSERT INTO area_members (area_id, user_id, is_area_leader)
SELECT id, lead_user_id, true FROM areas WHERE lead_user_id IS NOT NULL
ON CONFLICT (user_id, area_id) DO UPDATE SET is_area_leader = true;

ALTER TABLE areas DROP COLUMN lead_user_id;


-- 2. A soft-deleted user's address was locked away forever
--
-- users.deleted_at marks a user as gone, but the UNIQUE on email applied to every row,
-- so the address could never be registered again. Uniqueness has to be scoped to the
-- live rows. Two soft-deleted users may now share an address, which is correct: they are
-- history, not accounts.
--
-- The constraint name is Postgres's default for a column-level UNIQUE. If this line
-- fails, the constraint was renamed at some point - check \d users for the real name.

ALTER TABLE users DROP CONSTRAINT users_email_key;
CREATE UNIQUE INDEX uq_users_email_live ON users (email) WHERE deleted_at IS NULL;


-- 3. logs.action_id referenced nothing
--
-- Give it a target, and a timestamp - a log line without one records that something
-- happened but not when, which is most of the value. Shaped like event_types, which is
-- the existing lookup-table pattern in this schema.
--
-- action_id becomes NOT NULL: a log entry with no action is not a log entry. If the
-- table already holds rows with a null action this migration fails and rolls back
-- whole, which is the right outcome - it means there is data to decide about first.

CREATE TABLE actions (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code  varchar(50) NOT NULL UNIQUE,
    label varchar(200) NOT NULL
);
COMMENT ON COLUMN actions.code IS 'Stable machine name, e.g. user_login, file_upload, absence_approved';

ALTER TABLE logs ADD COLUMN created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE logs ALTER COLUMN action_id SET NOT NULL;
ALTER TABLE logs ADD CONSTRAINT fk_logs_action_id_actions_id
    FOREIGN KEY (action_id) REFERENCES actions (id);

CREATE INDEX idx_logs_action_id ON logs (action_id);
CREATE INDEX idx_logs_created_at ON logs (created_at);


-- 4. absence_details -> absences
--
-- The table holds the absence, not details about one. Constraints and the primary key
-- index are renamed too, so nothing in the schema still carries the old name.

ALTER TABLE absence_details RENAME TO absences;
ALTER TABLE absences RENAME CONSTRAINT fk_absence_details_event_id_events_id
    TO fk_absences_event_id_events_id;
ALTER TABLE absences RENAME CONSTRAINT fk_absence_details_approved_by_users_id
    TO fk_absences_approved_by_users_id;
ALTER INDEX absence_details_pkey RENAME TO absences_pkey;


-- 5. Constraints the model always implied but never stated

ALTER TABLE events ADD CONSTRAINT events_ends_after_starts
    CHECK (ends_at >= starts_at);

ALTER TABLE days_off ADD CONSTRAINT days_off_amount_nonneg
    CHECK (amount >= 0);
ALTER TABLE days_off ADD CONSTRAINT days_off_used_within_amount
    CHECK (used >= 0 AND used <= amount);

-- An exception either cancels the occurrence or replaces it. Replacing it with no times
-- at all was accepted, and would have expanded into an occurrence with a null window.
ALTER TABLE event_exceptions ADD CONSTRAINT event_exceptions_override_complete
    CHECK (is_cancelled OR (starts_at IS NOT NULL AND ends_at IS NOT NULL));
ALTER TABLE event_exceptions ADD CONSTRAINT event_exceptions_ends_after_starts
    CHECK (starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at);

-- Two places could end a recurrence: the recurrence_until column and an UNTIL= inside
-- the RFC 5545 rule. When they disagreed, the answer depended on which one the expansion
-- code happened to read. Only one of them may now be set.
ALTER TABLE events ADD CONSTRAINT events_recurrence_end_stated_once
    CHECK (recurrence_until IS NULL OR rule IS NULL OR rule NOT ILIKE '%UNTIL=%');


-- 6. Free-text URLs become real references
--
-- avatar_url and document_url were text standing in for a file store that did not exist
-- yet. It does now. Dropped rather than migrated: a URL cannot be turned into a files
-- row, and there is nothing stored behind these to preserve.

ALTER TABLE users DROP COLUMN avatar_url;
ALTER TABLE users ADD COLUMN avatar_file_id bigint REFERENCES files (id);

ALTER TABLE absences DROP COLUMN document_url;
ALTER TABLE absences ADD COLUMN document_file_id bigint REFERENCES files (id);

CREATE INDEX idx_users_avatar_file_id ON users (avatar_file_id);
CREATE INDEX idx_absences_document_file_id ON absences (document_file_id);


-- Down Migration

DROP INDEX idx_absences_document_file_id;
DROP INDEX idx_users_avatar_file_id;

ALTER TABLE absences DROP COLUMN document_file_id;
ALTER TABLE absences ADD COLUMN document_url text;

ALTER TABLE users DROP COLUMN avatar_file_id;
ALTER TABLE users ADD COLUMN avatar_url text;

ALTER TABLE events DROP CONSTRAINT events_recurrence_end_stated_once;
ALTER TABLE event_exceptions DROP CONSTRAINT event_exceptions_ends_after_starts;
ALTER TABLE event_exceptions DROP CONSTRAINT event_exceptions_override_complete;
ALTER TABLE days_off DROP CONSTRAINT days_off_used_within_amount;
ALTER TABLE days_off DROP CONSTRAINT days_off_amount_nonneg;
ALTER TABLE events DROP CONSTRAINT events_ends_after_starts;

ALTER INDEX absences_pkey RENAME TO absence_details_pkey;
ALTER TABLE absences RENAME CONSTRAINT fk_absences_approved_by_users_id
    TO fk_absence_details_approved_by_users_id;
ALTER TABLE absences RENAME CONSTRAINT fk_absences_event_id_events_id
    TO fk_absence_details_event_id_events_id;
ALTER TABLE absences RENAME TO absence_details;

DROP INDEX idx_logs_created_at;
DROP INDEX idx_logs_action_id;
ALTER TABLE logs DROP CONSTRAINT fk_logs_action_id_actions_id;
ALTER TABLE logs ALTER COLUMN action_id DROP NOT NULL;
ALTER TABLE logs DROP COLUMN created_at;
DROP TABLE actions;

DROP INDEX uq_users_email_live;
ALTER TABLE users ADD CONSTRAINT users_email_key UNIQUE (email);

-- Lossy on purpose, and the only part of this file that is. An area with several leaders
-- in area_members can only get one of them back into a single column, and the rows the
-- up migration inserted are left in place rather than guessed at.
ALTER TABLE areas ADD COLUMN lead_user_id bigint;
ALTER TABLE areas ADD CONSTRAINT fk_areas_lead_user_id_users_id
    FOREIGN KEY (lead_user_id) REFERENCES users (id);
UPDATE areas a SET lead_user_id = (
    SELECT am.user_id FROM area_members am
    WHERE am.area_id = a.id AND am.is_area_leader
    ORDER BY am.user_id LIMIT 1
);
