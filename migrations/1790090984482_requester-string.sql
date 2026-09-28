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

-- Los formatos sembrados pierden `dependencia`: ahora es la columna `requester`. No se
-- pueden actualizar -- el trigger de inmutabilidad rechaza todo UPDATE sobre una versión
-- publicada -- así que se borran y se vuelven a insertar.
DELETE FROM schema_versions
 WHERE schema_id IN (SELECT id FROM schemas WHERE code IN
   ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia'));

INSERT INTO schema_versions (schema_id, version, fields)
SELECT id, 1,
  CASE code
    WHEN 'solicitud_general' THEN '{
      "deliverables": [
        {"code":"descripcion","name":"Descripción del trabajo","type":"text","note":"Qué se necesita, con el detalle que haya","required":true},
        {"code":"fecha_entrega","name":"Fecha de entrega deseada","type":"date","note":"","required":false}
      ],
      "information": [
        {"code":"contacto_nombre","name":"Nombre del contacto","type":"text","note":"","required":true},
        {"code":"contacto_correo","name":"Correo del contacto","type":"email","note":"","required":true},
        {"code":"contacto_telefono","name":"Teléfono del contacto","type":"phone","note":"","required":false}
      ]
    }'::jsonb
    WHEN 'papel_institucional' THEN '{
      "deliverables": [
        {"code":"tipo_papel","name":"Tipo de papel","type":"text","note":"Hoja membretada, sobre, tarjeta de presentación","required":true},
        {"code":"tiraje","name":"Tiraje","type":"quantity","note":"","required":true},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"contacto_correo","name":"Correo del contacto","type":"email","note":"","required":true},
        {"code":"numero_orden","name":"Número de orden","type":"text","note":"Lo genera diseño y lo ocupa facturación de imprenta (RF-IMP-08)","required":false}
      ]
    }'::jsonb
    WHEN 'impresion' THEN '{
      "deliverables": [
        {"code":"descripcion","name":"Descripción del trabajo","type":"text","note":"","required":true},
        {"code":"tiraje","name":"Tiraje","type":"quantity","note":"","required":true},
        {"code":"tamano","name":"Tamaño","type":"text","note":"","required":true},
        {"code":"pantone","name":"Pantone","type":"text","note":"El de la facultad, si aplica (RF-IMP-06)","required":false},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"con_costo","name":"Con costo","type":"boolean","note":"El tratamiento financiero difiere (RF-PRY-07)","required":false}
      ]
    }'::jsonb
    WHEN 'diseno_grafico' THEN '{
      "deliverables": [
        {"code":"nombre_evento","name":"Nombre del evento o producto","type":"text","note":"","required":true},
        {"code":"descripcion","name":"Descripción","type":"text","note":"","required":true},
        {"code":"medidas","name":"Medidas o formato","type":"text","note":"","required":false},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"fecha_evento","name":"Fecha del evento","type":"date","note":"","required":false},
        {"code":"material_referencia","name":"Material de referencia","type":"document","note":"Lo que entregue la dependencia","required":false}
      ]
    }'::jsonb
    WHEN 'fotografia' THEN '{
      "deliverables": [
        {"code":"evento","name":"Evento","type":"text","note":"","required":true},
        {"code":"fecha_evento","name":"Fecha y hora del evento","type":"datetime","note":"","required":true},
        {"code":"lugar","name":"Lugar","type":"location","note":"","required":true}
      ],
      "information": [
        {"code":"duracion_horas","name":"Duración estimada (horas)","type":"quantity","note":"","required":false}
      ]
    }'::jsonb
  END
FROM schemas
WHERE code IN ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia');

-- Down Migration

DELETE FROM schema_versions
 WHERE schema_id IN (SELECT id FROM schemas WHERE code IN
   ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia'));

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

INSERT INTO schema_versions (schema_id, version, fields)
SELECT id, 1,
  CASE code
    WHEN 'solicitud_general' THEN '{
      "deliverables": [
        {"code":"descripcion","name":"Descripción del trabajo","type":"text","note":"Qué se necesita, con el detalle que haya","required":true},
        {"code":"fecha_entrega","name":"Fecha de entrega deseada","type":"date","note":"","required":false}
      ],
      "information": [
        {"code":"dependencia","name":"Dependencia solicitante","type":"text","note":"","required":true},
        {"code":"contacto_nombre","name":"Nombre del contacto","type":"text","note":"","required":true},
        {"code":"contacto_correo","name":"Correo del contacto","type":"email","note":"","required":true},
        {"code":"contacto_telefono","name":"Teléfono del contacto","type":"phone","note":"","required":false}
      ]
    }'::jsonb
    WHEN 'papel_institucional' THEN '{
      "deliverables": [
        {"code":"tipo_papel","name":"Tipo de papel","type":"text","note":"Hoja membretada, sobre, tarjeta de presentación","required":true},
        {"code":"tiraje","name":"Tiraje","type":"quantity","note":"","required":true},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"dependencia","name":"Dependencia solicitante","type":"text","note":"","required":true},
        {"code":"contacto_correo","name":"Correo del contacto","type":"email","note":"","required":true},
        {"code":"numero_orden","name":"Número de orden","type":"text","note":"Lo genera diseño y lo ocupa facturación de imprenta (RF-IMP-08)","required":false}
      ]
    }'::jsonb
    WHEN 'impresion' THEN '{
      "deliverables": [
        {"code":"descripcion","name":"Descripción del trabajo","type":"text","note":"","required":true},
        {"code":"tiraje","name":"Tiraje","type":"quantity","note":"","required":true},
        {"code":"tamano","name":"Tamaño","type":"text","note":"","required":true},
        {"code":"pantone","name":"Pantone","type":"text","note":"El de la facultad, si aplica (RF-IMP-06)","required":false},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"dependencia","name":"Dependencia solicitante","type":"text","note":"","required":true},
        {"code":"con_costo","name":"Con costo","type":"boolean","note":"El tratamiento financiero difiere (RF-PRY-07)","required":false}
      ]
    }'::jsonb
    WHEN 'diseno_grafico' THEN '{
      "deliverables": [
        {"code":"nombre_evento","name":"Nombre del evento o producto","type":"text","note":"","required":true},
        {"code":"descripcion","name":"Descripción","type":"text","note":"","required":true},
        {"code":"medidas","name":"Medidas o formato","type":"text","note":"","required":false},
        {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","note":"","required":true}
      ],
      "information": [
        {"code":"dependencia","name":"Dependencia solicitante","type":"text","note":"","required":true},
        {"code":"fecha_evento","name":"Fecha del evento","type":"date","note":"","required":false},
        {"code":"material_referencia","name":"Material de referencia","type":"document","note":"Lo que entregue la dependencia","required":false}
      ]
    }'::jsonb
    WHEN 'fotografia' THEN '{
      "deliverables": [
        {"code":"evento","name":"Evento","type":"text","note":"","required":true},
        {"code":"fecha_evento","name":"Fecha y hora del evento","type":"datetime","note":"","required":true},
        {"code":"lugar","name":"Lugar","type":"location","note":"","required":true}
      ],
      "information": [
        {"code":"dependencia","name":"Dependencia solicitante","type":"text","note":"","required":true},
        {"code":"duracion_horas","name":"Duración estimada (horas)","type":"quantity","note":"","required":false}
      ]
    }'::jsonb
  END
FROM schemas
WHERE code IN ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia');
