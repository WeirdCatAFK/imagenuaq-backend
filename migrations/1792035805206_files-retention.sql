-- Vencimiento de archivos y lectura de todo el árbol (`RF-ARC-01`, `RF-ARC-02`).
--
-- `file_retention` es una sola fila: cuántos meses vive un archivo, configurable sin desplegar.
-- El reloj de un archivo dentro de la carpeta de un proyecto arranca cuando el proyecto se
-- cierra o archiva —uno abierto nunca pierde archivos—; el de uno fuera de todo proyecto, al
-- subirlo. Al vencer, la fila se marca borrada y el objeto en MinIO se elimina cuando ya
-- ninguna fila viva comparte su hash; la bitácora (`file_expired`) se conserva.
--
-- `document.browse` da lectura sobre cualquier carpeta. Escribir sigue dependiendo de
-- `folder_areas`; quien no lo tiene llega a los archivos por el proyecto en el que participa.

-- Up Migration

CREATE TABLE file_retention (
    id         boolean PRIMARY KEY DEFAULT true,
    months     integer NOT NULL DEFAULT 6,
    updated_by bigint REFERENCES users (id) ON DELETE SET NULL,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT file_retention_single_row CHECK (id),
    CONSTRAINT file_retention_months_positive CHECK (months > 0)
);

COMMENT ON TABLE file_retention IS 'One row: how many months a file lives once its project is closed or archived, or since upload outside any project.';

INSERT INTO file_retention DEFAULT VALUES;

INSERT INTO actions (code, label) VALUES
    ('file_expired', 'Archivo vencido')
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, label, description) VALUES
    ('document.browse', 'Ver todos los documentos',
     'RF-ARC-02: ver y descargar cualquier carpeta; escribir sigue dependiendo de las áreas de la carpeta')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'document.browse'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'document.browse');

DELETE FROM permissions WHERE code = 'document.browse';

DELETE FROM actions
WHERE code = 'file_expired' AND NOT EXISTS (SELECT 1 FROM logs l WHERE l.action_id = actions.id);

DROP TABLE file_retention;
