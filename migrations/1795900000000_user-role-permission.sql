-- Up Migration

-- Cambiar el rol de una persona (RF-USR-02) desde «Empleados». Es un permiso aparte para que
-- coordinación lo delegue sin dar todo lo demás de la pantalla. Solo admin da o quita el rol admin.
INSERT INTO permissions (code, label, description) VALUES
    ('user.role', 'Cambiar el rol de una persona',
     'Cambiar el rol de otra persona, por ejemplo para ascenderla a líder de área. Nadie cambia el suyo y solo coordinación da o quita el rol de coordinación.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'user.role'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM permissions WHERE code = 'user.role';
