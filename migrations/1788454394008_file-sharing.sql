-- Up Migration

-- The tree lives here; the disks are a content-addressed bag of bytes keyed by SHA-256.
-- Identity is the content, the path is metadata on a row, and the two move independently:
-- renaming a folder is one row update and nothing on disk moves, while draining a dying
-- disk copies bytes and changes no path.

CREATE TABLE storage_volumes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The join key between a row here and a mount. STORAGE_VOLUMES in the environment maps
  -- label -> path, and each disk carries a .imagenuaq-volume marker naming its label, so
  -- a disk that fails to mount is caught at startup instead of being written into.
  label       varchar(100) NOT NULL UNIQUE,
  -- Documentation only, and deliberately not authoritative: the same disk is /mnt/disk1
  -- on the host and /srv/storage/main inside the container, so no single path stored here
  -- can be correct in both places. The label is what identifies the volume.
  location    varchar(500),
  -- Policy, not observation. Whether a disk is mounted right now is runtime truth that
  -- only the process on that machine can know, and it changes without the database
  -- hearing about it; a stored mount flag is stale the moment it is written. This says
  -- "place new content here", which is a decision the database can legitimately hold.
  is_writable boolean NOT NULL DEFAULT true,
  -- Optional cap in bytes. NULL means "as much as the filesystem has".
  max_storage bigint,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT storage_volumes_max_storage_positive CHECK (max_storage IS NULL OR max_storage > 0)
);

CREATE TABLE folders (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  parent_id  bigint REFERENCES folders(id),
  name       varchar(255) NOT NULL,
  owner_id   bigint NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  CONSTRAINT folders_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

-- Sibling names, split in two because the rules genuinely differ. Inside the tree, no two
-- live children of one folder may share a name. At the top there is no parent to scope
-- by, and several people each having a root called "Documentos" has to stay legal, so
-- roots are scoped by owner instead.
CREATE UNIQUE INDEX uq_folders_parent_name ON folders (parent_id, name)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_folders_root_name ON folders (owner_id, name)
  WHERE parent_id IS NULL AND deleted_at IS NULL;

CREATE INDEX idx_folders_parent_id ON folders (parent_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_folders_owner_id ON folders (owner_id);

-- Postgres will happily accept A -> B -> A. Nothing declarative catches it, and the
-- ancestor walk that resolves a path or a permission would spin on it, so it is caught
-- on the way in. The depth cap doubles as a guard against a cycle created by a concurrent
-- transaction this trigger cannot see.
CREATE FUNCTION folders_reject_cycle() RETURNS trigger AS $$
DECLARE
  ancestor bigint := NEW.parent_id;
  hops     int := 0;
BEGIN
  WHILE ancestor IS NOT NULL LOOP
    IF ancestor = NEW.id THEN
      RAISE EXCEPTION 'folder % cannot be its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    hops := hops + 1;
    IF hops > 100 THEN
      RAISE EXCEPTION 'folder tree is deeper than 100 levels, or already cyclic'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT parent_id INTO ancestor FROM folders WHERE id = ancestor;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER folders_no_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON folders
  FOR EACH ROW WHEN (NEW.parent_id IS NOT NULL)
  EXECUTE FUNCTION folders_reject_cycle();

CREATE TABLE files (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  folder_id  bigint NOT NULL REFERENCES folders(id),
  author_id  bigint NOT NULL REFERENCES users(id),
  -- Lowercase hex SHA-256 of the content. NOT unique: two rows sharing a hash is exactly
  -- what deduplication means, and it is unavoidable here anyway - the path on disk is
  -- derived from the hash, so a second upload of the same bytes lands on the same file.
  -- The check is also what makes path traversal impossible when this reaches a path join.
  hash       char(64) NOT NULL,
  name       varchar(255) NOT NULL,
  -- Of the content, so every row sharing a hash necessarily agrees on it. No `extension`
  -- column: it would duplicate the tail of `name` and the two can drift apart.
  size       bigint NOT NULL,
  mime       varchar(255),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at timestamptz,
  CONSTRAINT files_hash_is_hex  CHECK (hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT files_size_nonneg  CHECK (size >= 0)
);

CREATE UNIQUE INDEX uq_files_folder_name ON files (folder_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_folder_id ON files (folder_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_files_hash ON files (hash);
CREATE INDEX idx_files_author_id ON files (author_id);

-- Where a given piece of CONTENT lives, keyed by hash rather than by file id. A file id
-- would be wrong: two rows sharing a hash share one physical file, so reclaiming by file
-- id would delete bytes another row still points at.
--
-- No foreign key to files.hash, because that column is deliberately not unique. The link
-- is maintained by the sweeper instead: content whose hash no live file references is
-- reclaimed after a grace window.
--
-- A composite primary key rather than a surrogate one, so the same content cannot be
-- recorded twice on the same volume. Multiple rows per hash are the point - that is both
-- replication and the temporary two-places state that draining a failing disk requires.
CREATE TABLE file_locations (
  hash              char(64) NOT NULL,
  storage_volume_id bigint NOT NULL REFERENCES storage_volumes(id),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hash, storage_volume_id),
  CONSTRAINT file_locations_hash_is_hex CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_file_locations_volume ON file_locations (storage_volume_id);

-- Grants an area access to a folder, inherited by everything beneath it: effective access
-- is resolved by walking up to the nearest ancestor carrying a row here. A join table
-- rather than a column on folders, so a folder can be shared with several areas at once.
-- Additive, with no deny level, on purpose - deny rules force a precedence ordering that
-- stops being reasonable exactly when it matters.
CREATE TABLE folder_areas (
  folder_id  bigint NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  area_id    bigint NOT NULL REFERENCES areas(id) ON DELETE CASCADE,
  level      varchar(10) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (folder_id, area_id),
  CONSTRAINT folder_areas_level_valid CHECK (level IN ('read', 'write'))
);

CREATE INDEX idx_folder_areas_area_id ON folder_areas (area_id);

-- Share links. The escape hatch for anyone the owner/area rules cannot reach.
CREATE TABLE access_tokens (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- The SHA-256 of the token, never the token itself, for the same reason
  -- users.password_hash exists: a database leak must not hand out working links.
  -- The plaintext is shown once, at creation, and is not recoverable afterwards.
  token_hash char(64) NOT NULL UNIQUE,
  folder_id  bigint REFERENCES folders(id) ON DELETE CASCADE,
  file_id    bigint REFERENCES files(id) ON DELETE CASCADE,
  level      varchar(10) NOT NULL,
  authorizer bigint NOT NULL REFERENCES users(id),
  -- timestamptz, not date: a date expires the link at midnight in an unstated timezone.
  expires_at timestamptz NOT NULL,
  -- Separate from expiry so a leaked link can be killed now rather than waited out.
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT access_tokens_hash_is_hex CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT access_tokens_level_valid CHECK (level IN ('read', 'write')),
  -- Exactly one target, mirroring event_participants_one_target.
  CONSTRAINT access_tokens_one_target CHECK (num_nonnulls(folder_id, file_id) = 1)
);

CREATE INDEX idx_access_tokens_folder_id ON access_tokens (folder_id);
CREATE INDEX idx_access_tokens_file_id ON access_tokens (file_id);

COMMENT ON TABLE storage_volumes IS 'One row per mounted disk, identified by label. The mount path is not authoritative here: it comes from STORAGE_VOLUMES in the environment, because the same disk mounts at a different path inside the container than on the host.';
COMMENT ON TABLE folders IS 'The tree. parent_id NULL is a root; there may be many, one per owner. Cycles are rejected by the folders_no_cycle trigger, which nothing declarative can express.';
COMMENT ON TABLE files IS 'One row per appearance of content in the tree. hash is deliberately not unique: two rows sharing it share one physical file on disk, which is what deduplication means.';
COMMENT ON TABLE file_locations IS 'Which volumes hold a given piece of content, keyed by hash rather than file id because the bytes are shared. Placement is recorded here and never derived from the hash: deriving it would reshuffle every existing file the moment a disk is added.';
COMMENT ON TABLE folder_areas IS 'Area grants on a folder, inherited by everything beneath it. Additive; the nearest ancestor carrying a row wins.';
COMMENT ON TABLE access_tokens IS 'Share links. Stores the hash of the token, never the token. Exactly one of folder_id / file_id is set. CHECK access_tokens_one_target: num_nonnulls(folder_id, file_id) = 1';

-- Down Migration

DROP TABLE access_tokens;
DROP TABLE folder_areas;
DROP TABLE file_locations;
DROP TABLE files;
DROP TRIGGER folders_no_cycle ON folders;
DROP FUNCTION folders_reject_cycle();
DROP TABLE folders;
DROP TABLE storage_volumes;
