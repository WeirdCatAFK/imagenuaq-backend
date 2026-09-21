-- Up Migration

ALTER TABLE schema_versions
ADD CONSTRAINT uq_composite_schema
UNIQUE (schema_id, version);

-- Down Migration

ALTER TABLE schema_versions 
DROP CONSTRAINT uq_composite_schema;