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
-- Starter formats are not seeded: coordination creates its formats from the app (RF-SOL-01).
--
-- constraint-schema-versions added `uq_composite_schema UNIQUE (schema_id, version)` over
-- the `uq_schema_versions_schema_version` index projects-spine already had on the same
-- pair. Two indexes, one job; the later one goes.

-- Up Migration

ALTER TABLE schema_versions DROP CONSTRAINT IF EXISTS uq_composite_schema;

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de campos: { code, name, type (data_types.code), section (deliverables|information), required, propagate, options }. propagate: el valor viaja a project_field_values al convertir la solicitud (RF-FLW-06).';

-- Down Migration

COMMENT ON COLUMN schema_versions.fields IS
  'Arreglo ordenado de definiciones de campo: key, label, type, required, options';

ALTER TABLE schema_versions ADD CONSTRAINT uq_composite_schema UNIQUE (schema_id, version);
