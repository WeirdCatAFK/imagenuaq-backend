-- Up Migration

-- The MVP spine: a request can be received, become a project, and move through areas.
--
-- Nothing in SOL, PRY, FLW or EST had a table. Work lives in Google Forms answers, an
-- Excel tracker and a Teams thread, which is the whole problem the system exists to solve,
-- and the three implemented halves (USR, CAL/AUS, ARC) have nothing to hang off. This
-- migration lands the smallest set of tables that makes the chain sayable end to end and
-- leaves the modules that were cut able to enter without reshaping it.
--
-- What is deliberately NOT here, and why the shape below still expects it:
--
--   FLW proper -- `workflows`, `workflow_versions`, `workflow_stages`,
--   `workflow_transitions`, the node editor of RF-FLW-02. `project_stages` rows are created
--   by hand until it lands; when it does, the rows gain `workflow_stage_id` and nothing
--   else moves. Section 7.
--
--   TSK -- `tasks`, `time_entries`, `notes`, `project_members`. `project_stages.assigned_to`
--   is one person per stage, which is the area lead's first cut of RF-TSK-01 and not
--   RF-TSK-02's breakdown. Those tables reference `projects` and `project_stages`; they
--   add, they do not alter.
--
--   FIN, INV, IMP -- DATAMODEL.md 4 lists the hooks. `project_field_values` is the one
--   built here, because RF-FLW-06 names it from the SOL side and RF-IMP-08 from the other,
--   and retrofitting provenance onto values already captured is not possible.
--
-- Three shapes here are the expensive ones to reverse, each argued where it appears: there
-- is no current-stage pointer (section 7), published schema versions are immutable
-- (section 3), and values crossing stages are rows rather than an accumulated JSONB
-- (section 9). DATAMODEL.md 2.1, 2.2 and 2.4 are the prose behind them.


-- 1. The requesting party
--
-- RF-SOL-07 asks for the contact data of the requesting entity -- person, mail,
-- dependencia -- kept tied to both the request and the project, and RF-PRY-02 lists the
-- entity among what a project must record. Two tables rather than columns on `requests`,
-- because the same faculty requests dozens of times and its contacts change while it does
-- not: flattening them means correcting a mail address in every historical row, or leaving
-- them disagreeing.
--
-- `kind` is free text against a CHECK rather than a catalogue table. It has four values
-- that come from the interviews and nothing reads it but a filter; a catalogue would be a
-- join for a label. If IMP needs pantones per faculty (RF-IMP-06) they hang off `entities`,
-- and that is when the row earns more columns.

CREATE TABLE entities (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       varchar(300) NOT NULL,
    -- facultad, dependencia, coordinacion, externo
    kind       varchar(20),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamptz,
    CONSTRAINT entities_kind_valid
        CHECK (kind IS NULL OR kind IN ('facultad', 'dependencia', 'coordinacion', 'externo'))
);
COMMENT ON TABLE entities IS 'RF-SOL-07: la entidad solicitante. Persiste entre solicitudes; sus contactos cambian y viven aparte.';
COMMENT ON COLUMN entities.kind IS 'facultad, dependencia, coordinacion, externo';

-- Partial on deleted_at, like uq_users_email_live: a dependencia that is dissolved and
-- recreated must not be blocked by the name of the dead row.
CREATE UNIQUE INDEX uq_entities_name ON entities (name) WHERE deleted_at IS NULL;

CREATE TABLE entity_contacts (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    entity_id  bigint NOT NULL REFERENCES entities (id),
    full_name  varchar(200) NOT NULL,
    email      varchar(320),
    phone      varchar(50),
    job_title  varchar(200),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamptz
);
COMMENT ON TABLE entity_contacts IS 'RF-SOL-07. Es tambien la identidad del externo para RF-EXT-01 y quien firma el lado externo de RF-FLW-05.';

CREATE INDEX idx_entity_contacts_entity_id ON entity_contacts (entity_id) WHERE deleted_at IS NULL;
-- lower(), because the same person writes their address both ways across two requests, and
-- two contact rows for one human is what makes RF-FLW-05 ambiguous about who signed.
CREATE UNIQUE INDEX uq_entity_contacts_email ON entity_contacts (entity_id, lower(email))
    WHERE email IS NOT NULL AND deleted_at IS NULL;


-- 2. Statuses, per area
--
-- RF-EST-01 wants every project to carry a visible, updatable status; RF-EST-02 says the
-- catalogue is configurable per area, because each one runs different stages. So the
-- catalogue is a table with an area dimension, and `area_id IS NULL` is the shared set
-- every area starts from.
--
-- Two partial unique indexes rather than one on (area_id, code): NULL is distinct from NULL
-- in a unique index, so a single index would let the global catalogue accumulate duplicate
-- codes silently. Same split, same reason, as uq_folders_parent_name and
-- uq_folders_root_name.

CREATE TABLE statuses (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- NULL = catalogo global, punto de partida de todas las areas
    area_id     bigint REFERENCES areas (id),
    code        varchar(50) NOT NULL,
    label       varchar(200) NOT NULL,
    sort_order  int NOT NULL DEFAULT 0,
    is_terminal boolean NOT NULL DEFAULT false,
    is_active   boolean NOT NULL DEFAULT true
);
COMMENT ON TABLE statuses IS 'RF-EST-02: catalogo configurable por area. area_id NULL es el catalogo global.';
COMMENT ON COLUMN statuses.is_terminal IS 'RF-EST-05: el cierre con pendientes se valida contra los estatus marcados terminales';

CREATE UNIQUE INDEX uq_statuses_area_code   ON statuses (area_id, code) WHERE area_id IS NOT NULL;
CREATE UNIQUE INDEX uq_statuses_global_code ON statuses (code)          WHERE area_id IS NULL;

-- The seven RF-EST-01 names, and only those. Per-area catalogues are coordination's call
-- and are seeded empty for the same reason role_permissions leaves `worker` and `area_lead`
-- empty: the requirement asks for them to be configured, not decided here.
INSERT INTO statuses (area_id, code, label, sort_order, is_terminal) VALUES
    (NULL, 'recibido',      'Recibido',              10, false),
    (NULL, 'en_proceso',    'En proceso',            20, false),
    (NULL, 'esperando_vb',  'Esperando visto bueno', 30, false),
    (NULL, 'en_produccion', 'En produccion',         40, false),
    (NULL, 'enviado',       'Enviado',               50, false),
    (NULL, 'entregado',     'Entregado',             60, false),
    (NULL, 'cerrado',       'Cerrado',               70, true);


-- 3. Request formats, and why a published version cannot be edited
--
-- RF-SOL-01 has coordination adding request formats -- fields, data type, whether they are
-- required -- without development. That definition is data, so it is a row; the argument is
-- which row.
--
-- `schemas` is the format's stable identity and `schema_versions` is what it looked like
-- when something was captured with it. Editing publishes a new version. If the definition
-- were edited in place two things break, neither recoverably: a request captured last month
-- can no longer be rendered with the fields it was actually filled in with, and a project
-- in flight changes shape underneath the person working it. DATAMODEL.md 2.2.
--
-- The fields are JSONB and not an EAV table of `schema_fields`. That is a departure from
-- DATAMODEL.md 2.3, which argued for rows on the grounds that the form builder queries and
-- orders them. It does -- but it queries them one version at a time, which JSONB answers in
-- one read, and nothing searches across the field definitions of different formats. The
-- rows come back the day something does; an array is ordered already, so the `sort_order`
-- column that would have justified them is the array index.
--
-- The trigger is not decoration. Immutability that lives only in orchestration is a rule the
-- next UPDATE forgets, and by then the history it protects is already rewritten.

CREATE TABLE schemas (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- formato_02, papel_institucional
    code       varchar(50) NOT NULL UNIQUE,
    name       varchar(300) NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE schemas IS 'RF-SOL-01: identidad estable de un formato de solicitud. Su contenido vive en schema_versions.';

CREATE TABLE schema_versions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    schema_id    bigint NOT NULL REFERENCES schemas (id),
    version      int NOT NULL,
    -- [{ key, label, type, required, options }] en orden de captura
    fields       jsonb NOT NULL DEFAULT '[]'::jsonb,
    published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by bigint REFERENCES users (id),
    CONSTRAINT schema_versions_version_positive CHECK (version >= 1),
    CONSTRAINT schema_versions_fields_is_array  CHECK (jsonb_typeof(fields) = 'array')
);
COMMENT ON TABLE schema_versions IS 'RF-SOL-01, DATAMODEL 2.2: inmutable una vez publicada. Editar un formato publica una version nueva.';
COMMENT ON COLUMN schema_versions.fields IS 'Arreglo ordenado de definiciones de campo: key, label, type, required, options';

CREATE UNIQUE INDEX uq_schema_versions_schema_version ON schema_versions (schema_id, version);

CREATE FUNCTION schema_versions_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'schema_version % is published and cannot be edited; publish a new version instead', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER schema_versions_immutable
  BEFORE UPDATE ON schema_versions
  FOR EACH ROW
  EXECUTE FUNCTION schema_versions_reject_update();


-- 4. The spreadsheets that keep working during the transition
--
-- RF-MIG-01 is explicit that the Excel stays reachable while the answers land in the
-- database, and RF-MIG-02 asks to import what already exists. `src/routes/spreadsheets.js`
-- already reads a Graph workbook; what it has nowhere to record is which workbook, mapped
-- how, into which format.
--
-- drive_id/item_id rather than the URL, because that pair is what the Graph calls take and
-- a shared link neither survives a move nor identifies a table within the file. `web_url` is
-- kept anyway -- it is what a human pastes and what the UI links back to -- but it is
-- decoration, not the key.
--
-- The map points at a `schema_version_id`, not a `schema_id`: a mapping is written against
-- the columns of one specific version, and pointing at the moving identity would silently
-- misalign the day the format gains a field. Re-pointing it after publishing a new version
-- is then a deliberate act, which is the right cost.

CREATE TABLE sheets (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name              varchar(300) NOT NULL,
    drive_id          varchar(255) NOT NULL,
    item_id           varchar(255) NOT NULL,
    -- Tabla dentro del libro. NULL = la primera / unica
    table_name        varchar(200),
    web_url           text,
    schema_version_id bigint NOT NULL REFERENCES schema_versions (id),
    -- { "Nombre del evento": "title", "Correo": "contact_email" }
    column_map        jsonb NOT NULL DEFAULT '{}'::jsonb,
    last_imported_at  timestamptz,
    created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at        timestamptz,
    CONSTRAINT sheets_column_map_is_object CHECK (jsonb_typeof(column_map) = 'object')
);
COMMENT ON TABLE sheets IS 'RF-MIG-01, RF-MIG-02: el libro de Excel que sigue vivo durante la transicion, y como sus columnas caen en un formato.';
COMMENT ON COLUMN sheets.column_map IS 'Encabezado del Excel -> campo de schema_versions.fields o columna promovida de requests';
COMMENT ON COLUMN sheets.last_imported_at IS 'Hasta donde llego la ultima importacion, para que la siguiente sepa desde donde seguir';

-- coalesce(), because a NULL table_name is one specific case -- the default table -- and two
-- rows claiming it would each look like the registration of the same workbook.
CREATE UNIQUE INDEX uq_sheets_item ON sheets (drive_id, item_id, coalesce(table_name, ''))
    WHERE deleted_at IS NULL;


-- 5. Projects
--
-- RF-PRY-02 lists what a project records. Most of it is columns here; two things are
-- deliberately not:
--
--   The participating areas are derived, not stored. They are the areas of the project's
--   stages, and a second list would drift from them the first time a stage is added.
--
--   The current stage is absent entirely. Section 7 is the argument.
--
-- `key` is the short human handle -- the thing that names a folder and gets said out loud --
-- and the CHECK is what keeps it usable as a path segment. It is assigned, not generated:
-- unlike a request folio it is meant to be recognisable.
--
-- `has_cost` is RF-PRY-07, and it is a column rather than a consequence of having invoices
-- because the distinction exists before any financial record does and decides which
-- validations apply. `carried_over` is RF-PRY-08; the period it was carried from wants a
-- `periods` table that belongs to CAL/FIN, so what lands here is the flag the tablero
-- filters on and `period_id` follows it.
--
-- `archived_at` rather than `is_archived`: same information plus when, and it matches the
-- soft-delete shape `users` and `folders` already use. Both columns exist because they are
-- different acts -- archiving is a finished project leaving the board, deleting is a mistake
-- being retracted -- and RF-USR-06 restricts the second one specifically.

CREATE TABLE projects (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- INFORME-2026, PAPEL-FCQ-03
    key                 varchar(50) NOT NULL,
    title               varchar(300) NOT NULL,
    description         text,
    entity_id           bigint REFERENCES entities (id),
    contact_id          bigint REFERENCES entity_contacts (id),
    schema_version_id   bigint REFERENCES schema_versions (id),
    status_id           bigint NOT NULL REFERENCES statuses (id),
    status_since        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    priority            int NOT NULL DEFAULT 0,
    has_cost            boolean NOT NULL DEFAULT false,
    carried_over        boolean NOT NULL DEFAULT false,
    starts_on           date,
    due_on              date,
    folder_id           bigint REFERENCES folders (id),
    event_collection_id bigint REFERENCES event_collections (id),
    created_by          bigint REFERENCES users (id),
    created_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at           timestamptz,
    archived_at         timestamptz,
    deleted_at          timestamptz,
    CONSTRAINT projects_key_format CHECK (key ~ '^[A-Z0-9][A-Z0-9_-]*$'),
    CONSTRAINT projects_date_range CHECK (due_on IS NULL OR starts_on IS NULL OR due_on >= starts_on)
);
COMMENT ON TABLE projects IS 'RF-PRY-02. Las areas participantes se derivan de project_stages; no hay etapa actual, ver DATAMODEL 2.1.';
COMMENT ON COLUMN projects.key IS 'Identificador corto y legible; sirve como nombre de carpeta. Se asigna, no se genera.';
COMMENT ON COLUMN projects.priority IS 'RF-FLW-08: prioridad manual por urgencia. Mayor es mas urgente; no hay orden por fecha de llegada.';
COMMENT ON COLUMN projects.status_since IS 'RF-EST-03, RF-EST-04: desnormalizado para que la alerta de "lleva demasiado tiempo asi" no recorra logs';
COMMENT ON COLUMN projects.event_collection_id IS 'RF-CAL-01: el proyecto aparece en el calendario como una coleccion de eventos';

CREATE UNIQUE INDEX uq_projects_key ON projects (key) WHERE deleted_at IS NULL;
CREATE INDEX idx_projects_status_id ON projects (status_id, status_since);
CREATE INDEX idx_projects_entity_id ON projects (entity_id) WHERE deleted_at IS NULL;
-- RF-EST-07: el tablero pide lo abierto por urgencia, no lo cerrado ni lo archivado.
CREATE INDEX idx_projects_open ON projects (priority DESC, created_at)
    WHERE deleted_at IS NULL AND archived_at IS NULL AND closed_at IS NULL;


-- 6. Requests
--
-- A request is not an early project, and this is the split most sketches collapse. RF-SOL-03
-- gives every incoming request a folio the moment it arrives, before anyone has decided it
-- is work; RF-SOL-04 puts it in an area's inbox; RF-PRY-01 turns one *or several* of them
-- into a project. Squash the two and a rejected request has nowhere to live, and a project
-- born of three requests keeps one of them.
--
-- `project_id` on this side rather than a join table: many requests to one project is the
-- direction RF-PRY-01 states, and the reverse has no case.
--
-- `data` is the whole capture, whatever the format (RF-SOL-06, which insists nothing is
-- dropped, including the fields facturacion will want later). The five things RF-SOL-05
-- searches by -- name, entity, folio, responsible, status -- are promoted to real columns
-- instead, because they are the same for every format and a JSONB path is not an index.
--
-- The folio comes from a sequence with a column default, not from orchestration. Two
-- requests arriving at once is exactly when a SELECT max()+1 in application code produces
-- the same folio twice, and RF-SOL-03 asks for an identifier that is unique and consultable.
-- A per-year reset is a change of the default expression, not of the shape.

CREATE SEQUENCE requests_folio_seq;

CREATE TABLE requests (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    folio             varchar(50) NOT NULL DEFAULT ('SOL-' || to_char(nextval('requests_folio_seq'), 'FM000000')),
    schema_version_id bigint NOT NULL REFERENCES schema_versions (id),
    project_id        bigint REFERENCES projects (id),
    entity_id         bigint REFERENCES entities (id),
    contact_id        bigint REFERENCES entity_contacts (id),
    -- Bandeja en la que cayo, RF-SOL-02
    area_id           bigint REFERENCES areas (id),
    title             varchar(300) NOT NULL,
    data              jsonb NOT NULL DEFAULT '{}'::jsonb,
    status_id         bigint NOT NULL REFERENCES statuses (id),
    status_since      timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    assignee_id       bigint REFERENCES users (id),
    priority          int NOT NULL DEFAULT 0,
    -- form, email, sheet, manual
    source            varchar(20) NOT NULL DEFAULT 'form',
    sheet_id          bigint REFERENCES sheets (id),
    folder_id         bigint REFERENCES folders (id),
    created_by        bigint REFERENCES users (id),
    created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at        timestamptz,
    CONSTRAINT requests_source_valid   CHECK (source IN ('form', 'email', 'sheet', 'manual')),
    CONSTRAINT requests_data_is_object CHECK (jsonb_typeof(data) = 'object'),
    -- Una solicitud importada dice de que libro vino; una capturada a mano no tiene libro.
    CONSTRAINT requests_sheet_origin   CHECK (source = 'sheet' OR sheet_id IS NULL)
);
COMMENT ON TABLE requests IS 'RF-SOL-03. Existe desde que entra, tenga o no proyecto: project_id NULL es una solicitud sin convertir.';
COMMENT ON COLUMN requests.folio IS 'RF-SOL-03: unico y consultable. Lo genera la secuencia, no la orquestacion.';
COMMENT ON COLUMN requests.data IS 'RF-SOL-06: la captura completa, con la forma que dicte schema_versions.fields';
COMMENT ON COLUMN requests.source IS 'RF-SOL-08: las que llegan por correo se registran a mano en el mismo formato';

CREATE UNIQUE INDEX uq_requests_folio ON requests (folio);
-- RF-SOL-04: la bandeja del area, que es lo que se consulta a diario.
CREATE INDEX idx_requests_inbox ON requests (area_id, status_id, priority DESC, created_at)
    WHERE deleted_at IS NULL AND project_id IS NULL;
CREATE INDEX idx_requests_project_id  ON requests (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX idx_requests_entity_id   ON requests (entity_id);
CREATE INDEX idx_requests_assignee_id ON requests (assignee_id) WHERE assignee_id IS NOT NULL;


-- 7. Stages, and the column that is missing on purpose
--
-- RF-FLW-09 lets one project derive simultaneous work for more than one area, and RF-FLW-02
-- asks for that flow to be drawn as nodes. Neither is expressible on top of a
-- `current_stage int`: with two branches open there is no single current stage, and a
-- counter cannot describe a fork or the join after it.
--
-- So the current stage is a query, not a column: the project_stages rows whose status is
-- 'active'. `projects` carries no pointer at all, and adding one is the change that forces
-- the module to be rebuilt the first time something goes to diseno and imprenta at once.
-- DATAMODEL.md 2.1.
--
-- `seq` is a display order and nothing reads it to decide what happens next. It exists so
-- that two stages in the same area -- propuesta, then ajustes -- are distinguishable without
-- abusing `attempt`, which means something else.
--
-- `attempt` is RF-FLW-03's rejected sign-off: the visto bueno sends the work back to diseno
-- and the stage runs again. Without the counter, rework either overwrites the history
-- RF-PRY-03 asks for or collides on the unique index. DATAMODEL.md 2.6.
--
-- `status` here is the flow's own machine and is NOT the same thing as `statuses`, which is
-- the human-readable state of the whole project (RF-EST-01, section 2). They answer
-- different questions: this one says whether the area may work, that one says what the
-- tablero shows. 'waiting_external' with its reason is RF-FLW-07 -- blocked on a third party
-- without losing its place -- and the CHECK makes the reason mandatory, because a block
-- whose motive nobody wrote down is the state the Excel was already in.

CREATE TABLE project_stages (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id     bigint NOT NULL REFERENCES projects (id),
    area_id        bigint NOT NULL REFERENCES areas (id),
    title          varchar(300) NOT NULL,
    -- Orden de presentacion. NO es la etapa actual: esa es el conjunto de filas activas.
    seq            int NOT NULL DEFAULT 1,
    attempt        int NOT NULL DEFAULT 1,
    status         varchar(20) NOT NULL DEFAULT 'pending',
    blocked_reason text,
    assigned_to    bigint REFERENCES users (id),
    event_id       bigint REFERENCES events (id),
    started_at     timestamptz,
    ended_at       timestamptz,
    created_at     timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT project_stages_status_valid
        CHECK (status IN ('pending', 'active', 'waiting_external', 'done', 'cancelled')),
    CONSTRAINT project_stages_blocked_reason_present
        CHECK (status <> 'waiting_external' OR blocked_reason IS NOT NULL),
    CONSTRAINT project_stages_attempt_positive CHECK (attempt >= 1),
    CONSTRAINT project_stages_time_range
        CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);
COMMENT ON TABLE project_stages IS 'RF-FLW-01, RF-FLW-09, RF-PRY-03. La etapa actual es el conjunto de filas con status active, no una columna en projects.';
COMMENT ON COLUMN project_stages.seq IS 'Orden de presentacion dentro del proyecto. No decide que sigue.';
COMMENT ON COLUMN project_stages.attempt IS 'RF-FLW-03: un visto bueno rechazado devuelve el trabajo y la etapa se repite';
COMMENT ON COLUMN project_stages.status IS 'Maquina del flujo. Distinta de statuses, que es el estatus visible del proyecto (RF-EST-01).';
COMMENT ON COLUMN project_stages.blocked_reason IS 'RF-FLW-07: motivo del bloqueo cuando se espera a un tercero externo';
COMMENT ON COLUMN project_stages.event_id IS 'RF-CAL-02: la etapa aparece en el calendario como tiempo de desarrollo previsto';

CREATE UNIQUE INDEX uq_project_stages_attempt
    ON project_stages (project_id, area_id, seq, attempt);
CREATE INDEX idx_project_stages_project_id ON project_stages (project_id);
-- RF-SOL-04 desde el otro lado: lo que un area tiene abierto ahora mismo.
CREATE INDEX idx_project_stages_open ON project_stages (area_id, status)
    WHERE status IN ('active', 'waiting_external');
CREATE INDEX idx_project_stages_assigned_to ON project_stages (assigned_to)
    WHERE assigned_to IS NOT NULL;


-- 8. Sign-offs
--
-- RF-FLW-03 requires every transition to carry a registered visto bueno with user, date and
-- an optional comment, and RF-FLW-05 requires the double kind -- internal area and the
-- requesting entity -- when the flow asks for it. A `completed boolean` on the stage can
-- express none of that, and cannot represent a rejection at all.
--
-- A table of its own rather than entries in `logs`, and that is not the same call
-- DATAMODEL.md 2.7 makes for status changes. A visto bueno is a business object -- it has a
-- decision, a signatory and a comment, and RF-EST-05 blocks a closure by looking for the
-- ones that are missing. A trail cannot be queried for absence.
--
-- The double sign-off is two rows, one per side, not two columns. num_nonnulls() is the
-- pattern event_participants and logs_target_complete already use: exactly one signatory,
-- internal or external, never both and never neither.

CREATE TABLE approvals (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_stage_id    bigint NOT NULL REFERENCES project_stages (id) ON DELETE CASCADE,
    decision            varchar(20) NOT NULL,
    approver_user_id    bigint REFERENCES users (id),
    approver_contact_id bigint REFERENCES entity_contacts (id),
    comment             text,
    decided_at          timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT approvals_decision_valid CHECK (decision IN ('approved', 'rejected')),
    CONSTRAINT approvals_one_approver
        CHECK (num_nonnulls(approver_user_id, approver_contact_id) = 1)
);
COMMENT ON TABLE approvals IS 'RF-FLW-03. Objeto de negocio, no traza: RF-EST-05 pregunta por los que faltan.';
COMMENT ON COLUMN approvals.approver_contact_id IS 'RF-FLW-05: el lado externo del visto bueno de doble parte. Una fila por lado.';

CREATE INDEX idx_approvals_project_stage_id ON approvals (project_stage_id);


-- 9. Values that cross stages
--
-- RF-FLW-06 states the case outright: the order number produced in diseno must appear in
-- imprenta's billing record without being recaptured, and RF-IMP-08 asks for the same thing
-- from the other end.
--
-- Rows and not a mutable `projects.data jsonb`, which is the obvious version and loses two
-- things. Provenance: RF-PRY-03 wants to know which stage produced each value, and a merged
-- object cannot say. And searchability: imprenta looks a project up *by* order number, which
-- is an equality search wanting a plain btree, not a GIN index over an accumulated document.
-- DATAMODEL.md 2.4.
--
-- One row per key per project. A value that is corrected is an UPDATE of that row, and
-- `produced_by_stage_id` moves with it -- the honest record of who last supplied it.

CREATE TABLE project_field_values (
    id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id           bigint NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
    -- numero_orden, folio_sin, pantone
    key                  varchar(100) NOT NULL,
    value                text NOT NULL,
    produced_by_stage_id bigint REFERENCES project_stages (id),
    created_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at           timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
COMMENT ON TABLE project_field_values IS 'RF-FLW-06, RF-IMP-08: los datos que una etapa produce y otra consume sin recaptura.';
COMMENT ON COLUMN project_field_values.produced_by_stage_id IS 'RF-PRY-03: que etapa lo genero. Es lo que un JSONB acumulado no puede decir.';

CREATE UNIQUE INDEX uq_project_field_values ON project_field_values (project_id, key);
-- La busqueda de RF-IMP-08: por igualdad sobre el valor, no sobre el proyecto.
CREATE INDEX idx_project_field_values_key_value ON project_field_values (key, value);


-- Deliberately NOT in this migration: new permission codes or action codes.
--
-- `project.read`, `project.write`, `request.read` and `request.write` were seeded by the
-- role-permissions migration against exactly these tables, before they existed. Adding
-- `stage.*` or `approval.*` would invent an authorisation dimension the requirements do not
-- draw -- RF-FLW-03 says a sign-off is registered, not that signing is a grant separate from
-- editing the project. The action codes are equally untouched: record_created,
-- record_updated, record_deleted and status_changed are table-agnostic by design, so the
-- audit trail covers these ten tables the moment orchestration emits for them.


-- Down Migration

DROP TABLE IF EXISTS project_field_values;
DROP TABLE IF EXISTS approvals;
DROP TABLE IF EXISTS project_stages;
DROP TABLE IF EXISTS requests;
DROP SEQUENCE IF EXISTS requests_folio_seq;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS sheets;

DROP TRIGGER IF EXISTS schema_versions_immutable ON schema_versions;
DROP FUNCTION IF EXISTS schema_versions_reject_update();
DROP TABLE IF EXISTS schema_versions;
DROP TABLE IF EXISTS schemas;

DROP TABLE IF EXISTS statuses;
DROP TABLE IF EXISTS entity_contacts;
DROP TABLE IF EXISTS entities;
