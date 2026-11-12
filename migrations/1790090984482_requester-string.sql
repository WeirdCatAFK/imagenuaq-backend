-- - **Los externos** ven sus archivos por `access_tokens`, el mismo mecanismo temporal del
--   drive personal, sin pantalla propia; no necesitan una fila que los identifique.
-- - **Los vistos buenos son internos** (`RF-FLW-03`). La conformidad del solicitante se
--   captura como evidencia, no como firma, así que nada externo tiene que poder firmar y
--   `approvals.approver_user_id` pasa a ser obligatorio.
-- - **Los pantones** (`RF-IMP-06`) ya son un catálogo indexado por nombre; el selector
--   resuelve por cadena.
--
-- La cadena sube a **columna** y no se queda en `requests.data`: `RF-SOL-05` busca por
-- entidad solicitante, y el autocompletado necesita un lugar del cual juntar las cadenas ya
-- usadas. Si viviera en el JSON, la llave cambiaría con cada formato (`dependencia`,
-- `inst_pet`, ...) y las dos cosas tendrían que adivinarla. Es el mismo criterio de §2.3 que
-- ya hace de `title` una columna. Por eso también se va el campo `dependencia` de los cinco
-- formatos sembrados: duplicaría la columna.
--
-- El nombre se corrige al convertir la solicitud, con autocompletado sobre las cadenas que
-- ya existen (`GET /api/requesters`), que es donde un humano está viendo el registro de
-- todos modos.
--
-- El índice es btree sobre `lower(requester)`: sirve al autocompletado por prefijo y a la
-- igualdad. Un `ilike '%algo%'` lo ignora, y a esta escala —decenas de usuarios, miles de
-- filas— eso es aceptable; el día que no lo sea, la respuesta es `pg_trgm`, no otra tabla.

-- Up Migration

ALTER TABLE requests
  ADD COLUMN requester varchar(300),
  DROP COLUMN entity_id,
  DROP COLUMN contact_id;

COMMENT ON COLUMN requests.requester IS 'RF-SOL-07: la entidad solicitante, como cadena. Se corrige al convertir, con autocompletado sobre las ya usadas.';

CREATE INDEX idx_requests_requester ON requests (lower(requester)) WHERE requester IS NOT NULL;

ALTER TABLE projects
  ADD COLUMN requester varchar(300),
  DROP COLUMN entity_id,
  DROP COLUMN contact_id;

COMMENT ON COLUMN projects.requester IS 'RF-SOL-07: la entidad solicitante, como cadena. Se hereda de la solicitud al convertir.';

CREATE INDEX idx_projects_requester ON projects (lower(requester))
  WHERE requester IS NOT NULL AND deleted_at IS NULL;

-- El visto bueno es interno; la conformidad del solicitante es evidencia, no firma.
ALTER TABLE approvals DROP CONSTRAINT approvals_one_approver;
ALTER TABLE approvals DROP COLUMN approver_contact_id;
ALTER TABLE approvals ALTER COLUMN approver_user_id SET NOT NULL;

COMMENT ON COLUMN approvals.approver_user_id IS 'RF-FLW-03: quien dio el visto bueno. Siempre interno.';

DROP TABLE entity_contacts;
DROP TABLE entities;

-- Down Migration

CREATE TABLE entities (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name       varchar(300) NOT NULL,
    kind       varchar(20),
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at timestamptz,
    CONSTRAINT entities_kind_valid
        CHECK (kind IS NULL OR kind IN ('facultad', 'dependencia', 'coordinacion', 'externo'))
);
COMMENT ON TABLE entities IS 'RF-SOL-07: la entidad solicitante. Persiste entre solicitudes; sus contactos cambian y viven aparte.';
COMMENT ON COLUMN entities.kind IS 'facultad, dependencia, coordinacion, externo';

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
CREATE UNIQUE INDEX uq_entity_contacts_email ON entity_contacts (entity_id, lower(email))
    WHERE email IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE approvals ALTER COLUMN approver_user_id DROP NOT NULL;
ALTER TABLE approvals ADD COLUMN approver_contact_id bigint REFERENCES entity_contacts (id);
ALTER TABLE approvals ADD CONSTRAINT approvals_one_approver
    CHECK (num_nonnulls(approver_user_id, approver_contact_id) = 1);
COMMENT ON COLUMN approvals.approver_contact_id IS 'RF-FLW-05: el lado externo del visto bueno de doble parte. Una fila por lado.';
COMMENT ON COLUMN approvals.approver_user_id IS NULL;

DROP INDEX idx_projects_requester;
ALTER TABLE projects
  DROP COLUMN requester,
  ADD COLUMN entity_id  bigint REFERENCES entities (id),
  ADD COLUMN contact_id bigint REFERENCES entity_contacts (id);
CREATE INDEX idx_projects_entity_id ON projects (entity_id) WHERE deleted_at IS NULL;

DROP INDEX idx_requests_requester;
ALTER TABLE requests
  DROP COLUMN requester,
  ADD COLUMN entity_id  bigint REFERENCES entities (id),
  ADD COLUMN contact_id bigint REFERENCES entity_contacts (id);
CREATE INDEX idx_requests_entity_id ON requests (entity_id);

