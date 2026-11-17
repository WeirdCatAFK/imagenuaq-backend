-- Up Migration

-- Permissions for the absence module (RF-AUS-01 to RF-AUS-15).
-- absence.read_detail is separate from absence.read because RF-AUS-13 restricts
-- who may see the reason and the backing document.

INSERT INTO permissions (code, label, description) VALUES
    ('absence.read',        'Ver ausencias',
     'RF-AUS-10, RF-AUS-11: ver la disponibilidad del personal y las ausencias propias'),
    ('absence.write',       'Registrar ausencias',
     'RF-AUS-01: solicitar un permiso o registrar una ausencia'),
    ('absence.approve',     'Autorizar ausencias',
     'RF-AUS-14: aprobar, rechazar o cancelar un permiso y marcar gozado'),
    ('absence.manage',      'Administrar tipos de ausencia',
     'RF-AUS-03: dar de alta y modificar tipos de ausencia y topes por esquema de contratación'),
    ('absence.read_detail', 'Ver motivo de ausencia',
     'RF-AUS-13: ver el motivo y el documento de respaldo de cualquier ausencia')
ON CONFLICT (code) DO NOTHING;

-- Grant every absence permission to admin.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code IN (
    'absence.read', 'absence.write', 'absence.approve', 'absence.manage', 'absence.read_detail'
)
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Actions for the audit trail (absence writes that go through logs, not absence_status_history).
INSERT INTO actions (code, label) VALUES
    ('absence_type_created',      'Tipo de ausencia creado'),
    ('absence_type_updated',      'Tipo de ausencia modificado'),
    ('entitlement_created',       'Tope de ausencia creado'),
    ('entitlement_updated',       'Tope de ausencia modificado'),
    ('entitlement_closed',        'Tope de ausencia cerrado'),
    ('absence_created',           'Ausencia registrada'),
    ('absence_status_changed',    'Cambio de estatus de ausencia'),
    ('absence_deleted',           'Ausencia eliminada'),
    ('balance_adjusted',          'Saldo de ausencia ajustado')
ON CONFLICT (code) DO NOTHING;


-- Seed absence types obtained from personnel (RF-AUS-03).
-- 'vacaciones' already exists from the absence-types-and-balances migration.

INSERT INTO absence_types (code, label, unit, consumes_balance, requires_document) VALUES
    ('permiso_economico',   'Permiso económico',        'day',  true,  false),
    ('incapacidad',         'Incapacidad',              'day',  true,  true),
    ('dia_institucional',   'Día institucional',        'day',  false, false),
    ('permiso_sin_goce',    'Permiso sin goce de sueldo', 'day', false, true),
    ('cumpleanos',          'Día de cumpleaños',        'day',  true,  false),
    ('comision',            'Comisión oficial',         'day',  false, true)
ON CONFLICT (code) DO NOTHING;


-- Down Migration

DELETE FROM logs WHERE action_id IN (
    SELECT id FROM actions WHERE code IN (
        'absence_type_created', 'absence_type_updated',
        'entitlement_created', 'entitlement_updated', 'entitlement_closed',
        'absence_created', 'absence_status_changed', 'absence_deleted',
        'balance_adjusted'
    )
);
DELETE FROM actions WHERE code IN (
    'absence_type_created', 'absence_type_updated',
    'entitlement_created', 'entitlement_updated', 'entitlement_closed',
    'absence_created', 'absence_status_changed', 'absence_deleted',
    'balance_adjusted'
);

DELETE FROM role_permissions
WHERE permission_id IN (
    SELECT id FROM permissions WHERE code IN (
        'absence.read', 'absence.write', 'absence.approve', 'absence.manage', 'absence.read_detail'
    )
);
DELETE FROM permissions WHERE code IN (
    'absence.read', 'absence.write', 'absence.approve', 'absence.manage', 'absence.read_detail'
);

DELETE FROM absence_types WHERE code IN (
    'permiso_economico', 'incapacidad', 'dia_institucional',
    'permiso_sin_goce', 'cumpleanos', 'comision'
);
