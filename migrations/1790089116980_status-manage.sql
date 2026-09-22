-- El catálogo de estatus se edita desde la aplicación (RF-EST-02), y una solicitud
-- rechazada necesita dónde vivir.
--
-- `status.manage` es un tercer código porque el catálogo no es un registro de trabajo: lo
-- edita la coordinación, no quien atiende un proyecto, así que no cabe en
-- `project.write` ni en `request.write`. Las lecturas se quedan en la sesión -- un formulario
-- tiene que poder llenar su selector.
--
-- `rechazada` es global y terminal. Los siete estatus que sembró `projects-spine` describen
-- trabajo que avanza y ninguno dice "esto no se va a hacer"; sin él, una solicitud rechazada
-- se queda en `recibido` para siempre o se borra, y `DATAMODEL.md` §2.8 existe justamente
-- para no perder lo que no se convirtió.
--
-- Las entidades reutilizan `request.read` / `request.write`: son datos de captura
-- (`RF-SOL-07`), aparecen en el mismo formulario y un cuarto par de códigos para una tabla
-- que nadie administra por separado sería un permiso sin política detrás.

-- Up Migration

INSERT INTO permissions (code, label, description)
VALUES ('status.manage', 'Administrar estatus',
        'RF-EST-02: crear, editar y desactivar los estatus globales y por área')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'status.manage'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

INSERT INTO statuses (area_id, code, label, sort_order, is_terminal)
VALUES (NULL, 'rechazada', 'Rechazada', 65, true)
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM statuses WHERE area_id IS NULL AND code = 'rechazada';

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'status.manage');

DELETE FROM permissions WHERE code = 'status.manage';
