-- Up Migration

-- There was nowhere to store a permission.
--
-- users.role_id -> roles.name was the whole authorisation model, which means every rule
-- lived in code. Two requirements need permissions to be data:
--
--   RF-USR-05 — read and write must be independent and assignable by role, so that a user
--               can see information they cannot modify. That is two permissions, not two
--               levels of one: a `level` column ordered read < write would make "write
--               without read" unrepresentable, and finance already needs the opposite
--               shape (RF-USR-08, transversal read with no write anywhere).
--   RF-USR-10 — seeing the reason for an absence is a different permission from seeing
--               that someone is away. They are two rows below, and their being two rows
--               is what stops them collapsing into one when this is implemented.


CREATE TABLE permissions (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Dotted resource.action, e.g. project.write. Stable machine name, like actions.code
    code        varchar(100) NOT NULL UNIQUE,
    label       varchar(200) NOT NULL,
    description text
);
COMMENT ON COLUMN permissions.code IS 'Dotted resource.action, e.g. project.write. Stable machine name, like actions.code';

CREATE TABLE role_permissions (
    role_id       bigint NOT NULL REFERENCES roles (id)       ON DELETE CASCADE,
    permission_id bigint NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);
COMMENT ON TABLE role_permissions IS 'Which permissions a role grants. Deleting either side removes the grant rather than leaving it dangling.';

-- The primary key already indexes role_id first, which serves "what can this role do".
-- This one serves the other direction, "who can do this", used when auditing a permission.
CREATE INDEX idx_role_permissions_permission_id ON role_permissions (permission_id);


-- The catalogue is seeded here rather than left to the application because these codes are
-- the requirements expressed as data: the set is part of the schema's meaning, and a
-- deployment without them grants nothing to anyone. Which role gets which permission is
-- NOT seeded — that is configuration, and RF-USR-05 puts it in the hands of coordination.

INSERT INTO permissions (code, label, description) VALUES
    ('project.read',        'Ver proyectos',              'RF-USR-03, RF-USR-04: consultar proyectos del area y de los usuarios a cargo'),
    ('project.write',       'Editar proyectos',           'RF-USR-05, RF-USR-06: independiente de project.read'),
    ('request.read',        'Ver solicitudes',            'RF-SOL-04: bandeja de solicitudes entrantes'),
    ('request.write',       'Editar solicitudes',         'RF-USR-05: independiente de request.read'),
    ('task.read',           'Ver tareas',                 'RF-TSK-03, RF-TSK-04'),
    ('task.write',          'Editar y asignar tareas',    'RF-TSK-01: el responsable de area reparte'),
    ('finance.read',        'Ver información financiera', 'RF-USR-08: acceso transversal de solo lectura a facturas y cotizaciones de cualquier area'),
    ('availability.read',   'Ver disponibilidad',         'RF-AUS-12: que dias falta gente y de que area, sin el motivo'),
    ('absence.reason.read', 'Ver motivo de ausencia',     'RF-AUS-13, RF-USR-10: motivo y respaldo documental. Deliberadamente distinto de availability.read'),
    ('absence.approve',     'Autorizar ausencias',        'RF-AUS-14: cambiar el estatus de un permiso'),
    ('area.manage',         'Administrar áreas',          'RF-USR-09: dar de alta areas y coordinaciones sin desarrollo');


-- Deliberately NOT in this migration: per-area roles.
--
-- users.role_id stays global. The schema-proofing migration already concluded that
-- leadership is per-area, and the same argument applies here — someone can lead one area
-- and be an ordinary member of another, so a single global role cannot express what they
-- may do in each. But RF-USR-03 and RF-USR-04 are answerable today by crossing
-- area_members, and moving the role onto that table touches two tables and every
-- authorisation call site. It belongs in its own branch, and DATAMODEL.md §5.2 keeps the
-- note.


-- Down Migration

DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS permissions;
