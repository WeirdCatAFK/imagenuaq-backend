-- Up Migration

INSERT INTO permissions (
    code,
    label,
    description
)
VALUES (
    'schema.manage',
    'Administrar schemas',
    'Crear schemas, crear nuevas versiones y desactivar schemas'
)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p
    ON p.code = 'schema.manage'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;


-- Down Migration

DELETE FROM role_permissions
WHERE permission_id = (
    SELECT id
    FROM permissions
    WHERE code = 'schema.manage'
);

DELETE FROM permissions
WHERE code = 'schema.manage';