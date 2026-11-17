-- Permission to request absences on behalf of other people.
-- Without it a user can only request their own.
INSERT INTO permissions (code, label, description)
VALUES ('absence.request_others', 'Solicitar ausencias por otros',
        'Permite registrar ausencias a nombre de otra persona')
ON CONFLICT (code) DO NOTHING;

-- Grant to admin
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.name = 'admin' AND p.code = 'absence.request_others'
ON CONFLICT DO NOTHING;
