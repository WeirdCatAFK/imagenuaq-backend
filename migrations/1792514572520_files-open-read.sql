-- Lectura abierta de todo el árbol de archivos (`RF-USR-05`, `RF-ARC-02`).
--
-- Cualquiera con `document.read` ve y descarga cualquier carpeta: restringir la lectura por área
-- causaba fricción sin proteger nada que el resto del sistema no muestre ya. Lo que sigue
-- dependiendo de `folder_areas` es escribir (subir, mover, renombrar) y, con `document.manage`
-- o siendo dueño o autor, borrar. Con eso `document.browse` ya no da nada, así que se retira.

-- Up Migration

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'document.browse');

DELETE FROM permissions WHERE code = 'document.browse';

-- Down Migration

INSERT INTO permissions (code, label, description) VALUES
    ('document.browse', 'Ver todos los documentos',
     'RF-ARC-02: ver y descargar cualquier carpeta; escribir sigue dependiendo de las áreas de la carpeta')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'document.browse'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;
