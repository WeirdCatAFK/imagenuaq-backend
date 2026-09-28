-- Field shape, starter formats and one duplicate constraint (RF-SOL-01, DATAMODEL 2.3).
--
-- projects-spine documented a schema field as `{ key, label, type, required, options }`.
-- The code that validates a version (orchestration/schemas.js) settled on a different
-- shape -- `{ code, name, type, section, required }` -- and the swagger documents that one.
-- Two shapes for one column is a bug waiting for the first reader of the comment, so the
-- comment moves to what the code enforces and gains the one attribute the spine needs and
-- neither had: `propagate`. A propagated field is one whose value leaves the request and
-- becomes a `project_field_values` row when the request is converted (RF-FLW-06,
-- RF-IMP-05): the entity that ordered the work, the delivery date, the order number -- the
-- data a label generator or the print shop reads without re-capturing it. `section`
-- already says whether a field is something to deliver or something to know; `propagate`
-- says whether it travels. They are independent axes.
--
-- The starter formats seeded here are templates in the only sense RF-SOL-01 needs: a
-- schema coordination clones (POST /api/schemas/:id/clone) rather than types from nothing.
-- They are seeded by migration, as the statuses were, so a fresh database can take a
-- request on day one. Their Down deletes them and will fail on the foreign key once a
-- request or sheet references one -- which is the honest answer: a format in use is not
-- something a rollback should erase.
--
-- constraint-schema-versions added `uq_composite_schema UNIQUE (schema_id, version)` over
-- the `uq_schema_versions_schema_version` index projects-spine already had on the same
-- pair. Two indexes, one job; the later one goes.

-- Up Migration

ALTER TABLE schema_versions DROP CONSTRAINT IF EXISTS uq_composite_schema;

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de campos: { code, name, type (data_types.code), section (deliverables|information), required, propagate, options }. propagate: el valor viaja a project_field_values al convertir la solicitud (RF-FLW-06).';

-- Starter formats. Field codes double as project_field_values.key, hence snake_case.
WITH seeded AS (
  INSERT INTO schemas (code, name) VALUES
    ('solicitud_general',   'Solicitud general'),
    ('papel_institucional', 'Papel institucional'),
    ('impresion',           'Trabajo de impresión'),
    ('diseno_grafico',      'Diseño gráfico'),
    ('fotografia',          'Servicio de fotografía')
  ON CONFLICT (code) DO NOTHING
  RETURNING id, code
)
INSERT INTO schema_versions (schema_id, version, fields)
SELECT id, 1,
  CASE code
    WHEN 'solicitud_general' THEN '[
      {"code":"dependencia","name":"Dependencia solicitante","type":"text","section":"information","required":true,"propagate":true},
      {"code":"contacto_nombre","name":"Nombre del contacto","type":"text","section":"information","required":true,"propagate":false},
      {"code":"contacto_correo","name":"Correo del contacto","type":"email","section":"information","required":true,"propagate":false},
      {"code":"contacto_telefono","name":"Teléfono del contacto","type":"phone","section":"information","required":false,"propagate":false},
      {"code":"descripcion","name":"Descripción del trabajo","type":"text","section":"deliverables","required":true,"propagate":false},
      {"code":"fecha_entrega","name":"Fecha de entrega deseada","type":"date","section":"deliverables","required":false,"propagate":true}
    ]'::jsonb
    WHEN 'papel_institucional' THEN '[
      {"code":"dependencia","name":"Dependencia solicitante","type":"text","section":"information","required":true,"propagate":true},
      {"code":"contacto_correo","name":"Correo del contacto","type":"email","section":"information","required":true,"propagate":false},
      {"code":"tipo_papel","name":"Tipo de papel (hoja membretada, sobre, tarjeta)","type":"text","section":"deliverables","required":true,"propagate":true},
      {"code":"tiraje","name":"Tiraje","type":"quantity","section":"deliverables","required":true,"propagate":true},
      {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","section":"deliverables","required":true,"propagate":true},
      {"code":"numero_orden","name":"Número de orden","type":"text","section":"information","required":false,"propagate":true}
    ]'::jsonb
    WHEN 'impresion' THEN '[
      {"code":"dependencia","name":"Dependencia solicitante","type":"text","section":"information","required":true,"propagate":true},
      {"code":"descripcion","name":"Descripción del trabajo","type":"text","section":"deliverables","required":true,"propagate":false},
      {"code":"tiraje","name":"Tiraje","type":"quantity","section":"deliverables","required":true,"propagate":true},
      {"code":"tamano","name":"Tamaño","type":"text","section":"deliverables","required":true,"propagate":true},
      {"code":"pantone","name":"Pantone","type":"text","section":"deliverables","required":false,"propagate":true},
      {"code":"con_costo","name":"Con costo","type":"boolean","section":"information","required":false,"propagate":true},
      {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","section":"deliverables","required":true,"propagate":true}
    ]'::jsonb
    WHEN 'diseno_grafico' THEN '[
      {"code":"dependencia","name":"Dependencia solicitante","type":"text","section":"information","required":true,"propagate":true},
      {"code":"nombre_evento","name":"Nombre del evento o producto","type":"text","section":"deliverables","required":true,"propagate":true},
      {"code":"descripcion","name":"Descripción","type":"text","section":"deliverables","required":true,"propagate":false},
      {"code":"medidas","name":"Medidas o formato","type":"text","section":"deliverables","required":false,"propagate":false},
      {"code":"fecha_evento","name":"Fecha del evento","type":"date","section":"information","required":false,"propagate":true},
      {"code":"fecha_entrega","name":"Fecha de entrega","type":"date","section":"deliverables","required":true,"propagate":true},
      {"code":"material_referencia","name":"Material de referencia","type":"document","section":"information","required":false,"propagate":false}
    ]'::jsonb
    WHEN 'fotografia' THEN '[
      {"code":"dependencia","name":"Dependencia solicitante","type":"text","section":"information","required":true,"propagate":true},
      {"code":"evento","name":"Evento","type":"text","section":"deliverables","required":true,"propagate":true},
      {"code":"fecha_evento","name":"Fecha y hora del evento","type":"datetime","section":"deliverables","required":true,"propagate":true},
      {"code":"lugar","name":"Lugar","type":"location","section":"deliverables","required":true,"propagate":true},
      {"code":"duracion_horas","name":"Duración estimada (horas)","type":"quantity","section":"information","required":false,"propagate":false}
    ]'::jsonb
  END
FROM seeded;

-- Down Migration

DELETE FROM schema_versions
 WHERE schema_id IN (SELECT id FROM schemas WHERE code IN
   ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia'));

DELETE FROM schemas WHERE code IN
  ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia');

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de definiciones de campo: key, label, type, required, options';

ALTER TABLE schema_versions ADD CONSTRAINT uq_composite_schema UNIQUE (schema_id, version);
