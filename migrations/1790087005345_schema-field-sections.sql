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
-- Los formatos de arranque ya no se siembran: los crea la coordinación (RF-SOL-01).

-- Up Migration

ALTER TABLE schema_versions DROP CONSTRAINT schema_versions_fields_is_array;

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

-- Down Migration

ALTER TABLE schema_versions DROP CONSTRAINT schema_versions_fields_is_sections;

ALTER TABLE schema_versions ALTER COLUMN fields SET DEFAULT '[]'::jsonb;

ALTER TABLE schema_versions
  ADD CONSTRAINT schema_versions_fields_is_array CHECK (jsonb_typeof(fields) = 'array');

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de campos: { code, name, type (data_types.code), section (deliverables|information), required, propagate, options }. propagate: el valor viaja a project_field_values al convertir la solicitud (RF-FLW-06).';

