-- Up Migration

-- Reference tables first, then the tables that point at them. Foreign keys are added at
-- the end rather than inline: users.primary_area_id and areas.lead_user_id reference each
-- other, so no creation order satisfies both.

CREATE TABLE roles (
    id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- admin, area_lead, worker, finance
    name varchar(50) NOT NULL UNIQUE
);
COMMENT ON COLUMN roles.name IS 'admin, area_lead, worker, finance';

CREATE TABLE contract_types (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name           varchar(200) NOT NULL,
    annual_offdays int NOT NULL
);

CREATE TABLE event_types (
    id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- horario, proyecto, ausencia, festivo
    code  varchar(50) NOT NULL UNIQUE,
    label varchar(200) NOT NULL
);
COMMENT ON COLUMN event_types.code IS 'horario, proyecto, ausencia, festivo';

CREATE TABLE event_collections (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- horario_daniel, vacaciones_contrato_x
    key         varchar(200) NOT NULL UNIQUE,
    name        varchar(300) NOT NULL,
    description text
);
COMMENT ON COLUMN event_collections.key IS 'horario_daniel, vacaciones_contrato_x';

CREATE TABLE areas (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         varchar(200) NOT NULL,
    description  text,
    lead_user_id bigint
);

CREATE TABLE users (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    primary_area_id  bigint,
    schedule_id      bigint,
    contract_type_id bigint NOT NULL,
    role_id          bigint NOT NULL,
    email            varchar(320) NOT NULL UNIQUE,
    full_name        varchar(200) NOT NULL,
    birthday         date,
    password_hash    varchar(500),
    avatar_url       text,
    created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at       timestamptz
);
CREATE INDEX users_idx_users_primary_area_id ON users (primary_area_id);
CREATE INDEX users_index_2 ON users (role_id);

CREATE TABLE area_members (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    area_id        bigint NOT NULL,
    user_id        bigint NOT NULL,
    is_area_leader boolean NOT NULL
);
CREATE INDEX area_members_idx_area_members_area_id ON area_members (area_id);
CREATE UNIQUE INDEX area_members_idx_area_members_user_id_area_id ON area_members (user_id, area_id);

-- One row per user per year. No annual reset job needed.
CREATE TABLE days_off (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id  bigint NOT NULL,
    year     int NOT NULL,
    allotted int NOT NULL,
    used     int NOT NULL DEFAULT 0
);
COMMENT ON TABLE days_off IS 'One row per user per year. No annual reset job needed.';
CREATE UNIQUE INDEX days_off_idx_leave_balances_user_id_year ON days_off (user_id, year);

-- starts_at/ends_at describe the FIRST occurrence. Recurring events are expanded at read
-- time for the requested window.
CREATE TABLE events (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_type_id    bigint NOT NULL,
    title            varchar(300) NOT NULL,
    description      text,
    all_day          boolean NOT NULL DEFAULT false,
    starts_at        timestamptz NOT NULL,
    ends_at          timestamptz NOT NULL,
    timezone         text NOT NULL DEFAULT 'America/Mexico_City',
    -- RFC 5545, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1. NULL = single occurrence
    rule             text,
    recurrence_until timestamptz,
    created_by       bigint,
    created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE events IS 'starts_at/ends_at describe the FIRST occurrence. Recurring events are expanded at read time for the requested window.';
COMMENT ON COLUMN events.rule IS 'RFC 5545, e.g. FREQ=WEEKLY;BYDAY=MO,WE,FR;INTERVAL=1. NULL = single occurrence';
CREATE INDEX events_idx_events_event_type_id ON events (event_type_id);
CREATE INDEX events_idx_events_starts_at_ends_at ON events (starts_at, ends_at);

-- Exactly one of user_id / area_id set. Area rows fan out to all members at query time.
CREATE TABLE event_participants (
    id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id bigint NOT NULL,
    area_id  bigint,
    user_id  bigint,
    -- The "exactly one" from the table comment, enforced rather than described.
    CONSTRAINT event_participants_one_target CHECK (num_nonnulls(area_id, user_id) = 1)
);
COMMENT ON TABLE event_participants IS 'Exactly one of user_id / area_id set. Area rows fan out to all members at query time.';
CREATE INDEX event_participants_idx_event_participants_event_id ON event_participants (event_id);
-- Partial, per the COMMENT ON INDEX in the source DDL: the rule only applies to rows that
-- carry that target, and the index stays off the rows that do not.
CREATE UNIQUE INDEX event_participants_uq_event_participants_area
    ON event_participants (area_id, event_id) WHERE area_id IS NOT NULL;
CREATE UNIQUE INDEX event_participants_uq_event_participants_user
    ON event_participants (user_id, event_id) WHERE user_id IS NOT NULL;

CREATE TABLE event_exceptions (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id       bigint NOT NULL,
    -- Identifies which occurrence this overrides
    original_start timestamptz NOT NULL,
    is_cancelled   boolean NOT NULL DEFAULT false,
    starts_at      timestamptz,
    ends_at        timestamptz
);
COMMENT ON COLUMN event_exceptions.original_start IS 'Identifies which occurrence this overrides';
CREATE UNIQUE INDEX idx_event_exceptions_event_id_original_start ON event_exceptions (event_id, original_start);

CREATE TABLE collection_events (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id      bigint NOT NULL,
    collection_id bigint NOT NULL
);
CREATE UNIQUE INDEX idx_collection_events_collection_id_event_id ON collection_events (collection_id, event_id);

CREATE TABLE absence_details (
    event_id     bigint PRIMARY KEY,
    reason       text NOT NULL,
    document_url text,
    approved_by  bigint,
    approved_at  timestamptz,
    created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE logs (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id   bigint,
    action_id bigint
);

-- Foreign key constraints

ALTER TABLE area_members ADD CONSTRAINT fk_area_members_area_id_areas_id FOREIGN KEY (area_id) REFERENCES areas (id);
ALTER TABLE event_participants ADD CONSTRAINT fk_event_participants_area_id_areas_id FOREIGN KEY (area_id) REFERENCES areas (id);
ALTER TABLE users ADD CONSTRAINT fk_users_primary_area_id_areas_id FOREIGN KEY (primary_area_id) REFERENCES areas (id);
ALTER TABLE users ADD CONSTRAINT fk_users_contract_type_id_contract_types_id FOREIGN KEY (contract_type_id) REFERENCES contract_types (id);
ALTER TABLE collection_events ADD CONSTRAINT fk_collection_events_collection_id_event_collections_id FOREIGN KEY (collection_id) REFERENCES event_collections (id);
ALTER TABLE users ADD CONSTRAINT fk_users_schedule_id_event_collections_id FOREIGN KEY (schedule_id) REFERENCES event_collections (id);
ALTER TABLE events ADD CONSTRAINT fk_events_event_type_id_event_types_id FOREIGN KEY (event_type_id) REFERENCES event_types (id);
ALTER TABLE absence_details ADD CONSTRAINT fk_absence_details_event_id_events_id FOREIGN KEY (event_id) REFERENCES events (id);
ALTER TABLE collection_events ADD CONSTRAINT fk_collection_events_event_id_events_id FOREIGN KEY (event_id) REFERENCES events (id);
ALTER TABLE event_exceptions ADD CONSTRAINT fk_event_exceptions_event_id_events_id FOREIGN KEY (event_id) REFERENCES events (id);
ALTER TABLE event_participants ADD CONSTRAINT fk_event_participants_event_id_events_id FOREIGN KEY (event_id) REFERENCES events (id);
ALTER TABLE absence_details ADD CONSTRAINT fk_absence_details_approved_by_users_id FOREIGN KEY (approved_by) REFERENCES users (id);
ALTER TABLE area_members ADD CONSTRAINT fk_area_members_user_id_users_id FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE areas ADD CONSTRAINT fk_areas_lead_user_id_users_id FOREIGN KEY (lead_user_id) REFERENCES users (id);
ALTER TABLE event_participants ADD CONSTRAINT fk_event_participants_user_id_users_id FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE events ADD CONSTRAINT fk_events_created_by_users_id FOREIGN KEY (created_by) REFERENCES users (id);
ALTER TABLE logs ADD CONSTRAINT fk_logs_user_id_users_id FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE days_off ADD CONSTRAINT fk_days_off_user_id_users_id FOREIGN KEY (user_id) REFERENCES users (id);
ALTER TABLE users ADD CONSTRAINT fk_users_role_id_roles_id FOREIGN KEY (role_id) REFERENCES roles (id);

-- Down Migration

-- CASCADE so the drop does not depend on getting the foreign-key order right.
DROP TABLE IF EXISTS logs CASCADE;
DROP TABLE IF EXISTS absence_details CASCADE;
DROP TABLE IF EXISTS collection_events CASCADE;
DROP TABLE IF EXISTS event_exceptions CASCADE;
DROP TABLE IF EXISTS event_participants CASCADE;
DROP TABLE IF EXISTS events CASCADE;
DROP TABLE IF EXISTS days_off CASCADE;
DROP TABLE IF EXISTS area_members CASCADE;
DROP TABLE IF EXISTS users CASCADE;
DROP TABLE IF EXISTS areas CASCADE;
DROP TABLE IF EXISTS event_collections CASCADE;
DROP TABLE IF EXISTS event_types CASCADE;
DROP TABLE IF EXISTS contract_types CASCADE;
DROP TABLE IF EXISTS roles CASCADE;
