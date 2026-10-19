-- La entrega de una etapa: la evidencia escrita y, si hace falta, un archivo (`RF-FLW-03`,
-- `RF-PRY-09` en su parte de evidencia, `RF-ARC-01`).
--
-- Vive en el intento (`project_stages`) y no en el visto bueno: quien hace la etapa entrega, y
-- quien firma revisa lo entregado. Un visto bueno rechazado abre otro intento con la entrega en
-- blanco, y la del intento anterior queda en su fila como historia. El archivo es un archivo
-- más de la carpeta del proyecto; aquí solo se apunta a él.
--
-- La etapa es también la unidad de trabajo de «Mis tareas» (`RF-TSK-01` a `RF-TSK-06`): no hay
-- tabla de tareas. Quien tiene una etapa a su nombre la ve con `task.read`; quien lidera un área
-- reparte sus etapas con `task.write`.

-- Up Migration

ALTER TABLE project_stages
    ADD COLUMN delivery_note    text,
    ADD COLUMN delivery_file_id bigint REFERENCES files (id) ON DELETE SET NULL,
    ADD COLUMN delivered_by     bigint REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN delivered_at     timestamptz;

COMMENT ON COLUMN project_stages.delivery_note IS 'RF-FLW-03: la evidencia de lo entregado, escrita por quien hizo la etapa.';
COMMENT ON COLUMN project_stages.delivery_file_id IS 'Archivo opcional de la entrega, en la carpeta del proyecto.';

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'task.read'
WHERE r.name IN ('area_lead', 'worker', 'finance')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'task.write'
WHERE r.name = 'area_lead'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE name IN ('area_lead', 'worker', 'finance'))
  AND permission_id IN (SELECT id FROM permissions WHERE code IN ('task.read', 'task.write'));

ALTER TABLE project_stages
    DROP COLUMN delivered_at,
    DROP COLUMN delivered_by,
    DROP COLUMN delivery_file_id,
    DROP COLUMN delivery_note;
