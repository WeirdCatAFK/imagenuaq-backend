-- Up Migration

-- The absence documents folder was found by its name, so anyone who may create folders could make a
-- second one, and a rename would have stopped hiding the first (RF-AUS-13). A key marks it instead.
ALTER TABLE folders ADD COLUMN system_key varchar(50);
CREATE UNIQUE INDEX uq_folders_system_key ON folders (system_key) WHERE system_key IS NOT NULL;
COMMENT ON COLUMN folders.system_key IS 'What the system uses the folder for; such a folder is not renamed, moved, shared or deleted.';

UPDATE folders SET system_key = 'absence_documents'
 WHERE id = (SELECT min(id) FROM folders
              WHERE name = 'Oficios de ausencia' AND parent_id IS NULL AND deleted_at IS NULL);

-- Down Migration

DROP INDEX uq_folders_system_key;
ALTER TABLE folders DROP COLUMN system_key;
