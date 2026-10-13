-- El contenido de los archivos vive en MinIO; el árbol, los nombres y los permisos siguen en
-- Postgres (`RF-ARC-01`, `RF-ARC-02`).
--
-- `file-sharing` repartía el contenido entre varios discos montados y anotaba en qué disco
-- quedaba cada hash: `storage_volumes` era la lista de discos y `file_locations` la colocación,
-- porque derivarla del hash (`hash % n`) reacomodaba todo al agregar un disco. Con MinIO esa
-- decisión ya no es nuestra: un solo bucket reparte cada objeto entre sus cuatro discos con
-- código de borrado, así que no hay disco que elegir ni colocación que recordar. Las dos
-- tablas se quedan sin nada que decir, y nada las escribió nunca -- `storage.js` (hoy `minioStorage.js`) no estaba
-- conectado -- de modo que soltarlas no pierde dato alguno.
--
-- Lo que NO cambia es el modelo: la llave del objeto sigue siendo el SHA-256
-- (`content/ab/cd/<hash>`), y `files.hash` sigue siendo el puente. Se descartó guardar el
-- objeto bajo su ruta legible (`PRY-000001/Diseño/x.pdf`), que fue lo que trajo la primera
-- integración con MinIO: renombrar una carpeta se volvía copiar y borrar cada objeto debajo
-- de ella, sin atomicidad, y `folder_areas` y `access_tokens` no tenían dónde colgarse.
--
-- Los nombres dejan de ser llave. `file-sharing` impedía dos archivos o dos carpetas con el
-- mismo nombre en una carpeta, como un sistema de archivos; aquí cada elemento es una fila con
-- su id, el objeto en MinIO se llama por su hash, y nada se resuelve por ruta. Dos
-- «propuesta.pdf» lado a lado son legítimos (dos versiones que alguien quiere conservar), y
-- rechazar el segundo después de haber subido sus bytes sólo dejaba basura en el bucket.
--
-- `document.read` / `document.write` son el par de códigos del router de documentos, como en
-- cualquier otro recurso. *Qué carpetas* puede tocar alguien no es un permiso: lo dicen
-- `folders.owner_id` y `folder_areas`, resueltos en orquestación. Escribir no basta para borrar
-- o recompartir el trabajo ajeno (`RF-USR-05`): eso lo hace el dueño de la carpeta, el autor
-- del archivo, o quien tenga `document.manage`.
--
-- `document.share` emite enlaces temporales a una carpeta para quien no tiene cuenta
-- (`access_tokens`, que ya existía): siempre de solo lectura, porque un externo nunca edita
-- ni borra (`RF-ARC-03`, `RF-EXT-03`), y siempre con vencimiento. Es un permiso de rol y no
-- algo que dé la carpeta: sacar trabajo fuera del sistema es una decisión de coordinación,
-- no de quien la creó.

-- Up Migration

DROP TABLE file_locations;
DROP TABLE storage_volumes;

DROP INDEX uq_folders_parent_name;
DROP INDEX uq_folders_root_name;
DROP INDEX uq_files_folder_name;

COMMENT ON TABLE files IS 'One row per appearance of content in the tree. hash is deliberately not unique: two rows sharing it share one object in MinIO (content/ab/cd/<hash>), which is what deduplication means. name is not unique within a folder either: the id is the identity.';

INSERT INTO permissions (code, label, description) VALUES
    ('document.read',   'Ver documentos',
     'RF-ARC-01: ver carpetas y descargar archivos de las carpetas a las que se tiene acceso'),
    ('document.write',  'Editar documentos',
     'RF-ARC-01: crear carpetas y subir, renombrar y mover archivos donde se tiene acceso de escritura'),
    ('document.manage', 'Administrar documentos',
     'RF-USR-05: eliminar y recompartir carpetas y archivos ajenos donde se tiene acceso de escritura'),
    ('document.share',  'Compartir documentos por enlace',
     'RF-EXT-03: emitir y revocar enlaces temporales de solo lectura a carpetas que se pueden ver')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code IN ('document.read', 'document.write', 'document.manage', 'document.share')
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions
                        WHERE code IN ('document.read', 'document.write', 'document.manage', 'document.share'));

DELETE FROM permissions WHERE code IN ('document.read', 'document.write', 'document.manage', 'document.share');

-- Vuelven a fallar si para entonces hay nombres repetidos; hay que renombrarlos a mano antes.
CREATE UNIQUE INDEX uq_folders_parent_name ON folders (parent_id, name)
  WHERE parent_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_folders_root_name ON folders (owner_id, name)
  WHERE parent_id IS NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_files_folder_name ON files (folder_id, name) WHERE deleted_at IS NULL;

-- Las dos tablas tal como las dejó `file-sharing`. Vuelven vacías: la colocación de lo que
-- se haya subido a MinIO no es algo que estas tablas puedan expresar.
CREATE TABLE storage_volumes (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  label       varchar(100) NOT NULL UNIQUE,
  location    varchar(500),
  is_writable boolean NOT NULL DEFAULT true,
  max_storage bigint,
  created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT storage_volumes_max_storage_positive CHECK (max_storage IS NULL OR max_storage > 0)
);

CREATE TABLE file_locations (
  hash              char(64) NOT NULL,
  storage_volume_id bigint NOT NULL REFERENCES storage_volumes(id),
  verified_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (hash, storage_volume_id),
  CONSTRAINT file_locations_hash_is_hex CHECK (hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_file_locations_volume ON file_locations (storage_volume_id);

COMMENT ON TABLE storage_volumes IS 'One row per mounted disk, identified by label. The mount path is not authoritative here: it comes from STORAGE_VOLUMES in the environment, because the same disk mounts at a different path inside the container than on the host.';
COMMENT ON TABLE files IS 'One row per appearance of content in the tree. hash is deliberately not unique: two rows sharing it share one physical file on disk, which is what deduplication means.';
COMMENT ON TABLE file_locations IS 'Which volumes hold a given piece of content, keyed by hash rather than file id because the bytes are shared. Placement is recorded here and never derived from the hash: deriving it would reshuffle every existing file the moment a disk is added.';
