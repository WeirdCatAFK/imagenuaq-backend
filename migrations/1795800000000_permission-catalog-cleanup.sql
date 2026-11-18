-- Up Migration

-- absence.reason.read y absence.read_detail decían lo mismo con la misma etiqueta, pero el código
-- solo consulta absence.read_detail (RF-AUS-13): marcar el primero en «Roles y permisos» no daba
-- nada. Quien lo tenía conserva el acceso al pasarle el que sí cuenta.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, d.id
FROM role_permissions rp
JOIN permissions r ON r.id = rp.permission_id AND r.code = 'absence.reason.read'
JOIN permissions d ON d.code = 'absence.read_detail'
ON CONFLICT DO NOTHING;

DELETE FROM permissions WHERE code = 'absence.reason.read';

-- Las descripciones se leen tal cual en el signo de ayuda de «Roles y permisos»: sin códigos de
-- requerimiento y con acentos, como las que limpió permission-descriptions-plain.
UPDATE permissions p SET label = d.label, description = d.description
FROM (VALUES
    ('absence.read',        'Ver ausencias',                     'Ver la disponibilidad del personal y las ausencias propias.'),
    ('absence.write',       'Registrar ausencias',               'Solicitar un permiso o registrar una ausencia.'),
    ('absence.manage',      'Administrar tipos de ausencia',     'Dar de alta y modificar tipos de ausencia y sus topes por tipo de contrato.'),
    ('absence.read_detail', 'Ver motivo de ausencia',            'Ver el motivo y el documento de respaldo de cualquier ausencia. Es distinto de ver la disponibilidad.'),
    ('print.read',          'Ver impresión',                     'Ver la cola de trabajos y las órdenes de impresión.'),
    ('print.create',        'Crear órdenes de impresión',        'Crear órdenes de trabajo para las máquinas.'),
    ('print.write',         'Modificar órdenes de impresión',    'Modificar, cambiar el estatus y eliminar órdenes de trabajo.'),
    ('print.manage',        'Administrar catálogo de impresión', 'Administrar el catálogo de pantones y máquinas.'),
    ('vehicle.book',        'Reservar vehículos',                'Reservar un vehículo para entregar o recoger material. Solo quien reservó o coordinación cambia la reserva.'),
    ('vehicle.manage',      'Administrar vehículos',             'Dar de alta, renombrar y desactivar los vehículos.')
) AS d(code, label, description)
WHERE p.code = d.code;

-- Down Migration

-- Las descripciones anteriores no se restauran: solo cambiaba el texto de ayuda.
INSERT INTO permissions (code, label, description) VALUES
    ('absence.reason.read', 'Ver motivo de ausencia',
     'Ver el motivo de una ausencia y su documento de respaldo. Es distinto de ver la disponibilidad.')
ON CONFLICT (code) DO NOTHING;
