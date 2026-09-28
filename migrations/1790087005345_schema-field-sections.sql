-- Los campos de un formato se agrupan por sección 

-- `schema-field-shape` documentó la forma que el código ya validaba: un arreglo plano en el
-- que cada campo llevaba `section` como atributo. La forma que la coordinación especificó
-- agrupa: un objeto con `deliverables` e `information`, cada uno con sus campos. Es la
-- misma información, pero dicha donde se lee -- el constructor de formatos y la pantalla de
-- captura muestran dos listas, y con el arreglo plano las derivaban filtrando.
--
----
-- - Se va `propagate`. Existía para marcar qué valores salen de la solicitud hacia
--   `project_field_values` (`RF-FLW-06`, `RF-IMP-05`). La propagación es justamente para que
--   las herramientas posteriores -- etiquetas, existencias, facturación -- lean los datos del
--   proyecto, y en la organización no hay valores reservados que justifiquen excluir alguno:
--   **todos los valores capturados viajan**, cada uno bajo su código.
-- - Entra `note`, la indicación humana del campo ("PDF con la firma de Alma"), y se va
--   `options`, que era un objeto libre sin lector.
--
-- Las cinco semillas se reescriben. No se pueden actualizar: el trigger
-- `schema_versions_immutable` rechaza todo UPDATE sobre una versión publicada, que es
-- precisamente la regla que protege lo capturado. Se borran y se vuelven a insertar, lo que
-- es seguro mientras nada las referencie -- y si algo ya lo hace, la llave foránea detiene la
-- migración en vez de dejar una solicitud apuntando a una versión que cambió de forma bajo
-- sus pies.

-- Up Migration

ALTER TABLE schema_versions DROP CONSTRAINT schema_versions_fields_is_array;

-- Las semillas viejas se van ANTES de que entre la restricción nueva: son arreglos, así que
-- una restricción que exige objeto las encuentra y detiene la migración.
DELETE FROM schema_versions
 WHERE schema_id IN (SELECT id FROM schemas WHERE code IN
   ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia'));

ALTER TABLE schema_versions
  ALTER COLUMN fields SET DEFAULT '{"deliverables": [], "information": []}'::jsonb;

ALTER TABLE schema_versions
  ADD CONSTRAINT schema_versions_fields_is_sections CHECK (
    jsonb_typeof(fields) = 'object'
    AND fields ? 'deliverables'
    AND fields ? 'information'
    AND jsonb_typeof(fields -> 'deliverables') = 'array'
    AND jsonb_typeof(fields -> 'information') = 'array'
  );

COMMENT ON COLUMN schema_versions.fields IS
  'Campos por sección: { "deliverables": [...], "information": [...] }. Cada campo es { code (snake_case, único entre ambas secciones; es la llave en requests.data y en project_field_values), name, type (data_types.code), note, required }. Todo valor capturado viaja al proyecto al convertir la solicitud (RF-FLW-06).';

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

-- Down Migration

DELETE FROM schema_versions
 WHERE schema_id IN (SELECT id FROM schemas WHERE code IN
   ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia'));

ALTER TABLE schema_versions DROP CONSTRAINT schema_versions_fields_is_sections;

ALTER TABLE schema_versions ALTER COLUMN fields SET DEFAULT '[]'::jsonb;

ALTER TABLE schema_versions
  ADD CONSTRAINT schema_versions_fields_is_array CHECK (jsonb_typeof(fields) = 'array');

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de campos: { code, name, type (data_types.code), section (deliverables|information), required, propagate, options }. propagate: el valor viaja a project_field_values al convertir la solicitud (RF-FLW-06).';

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
FROM schemas
WHERE code IN ('solicitud_general', 'papel_institucional', 'impresion', 'diseno_grafico', 'fotografia');
