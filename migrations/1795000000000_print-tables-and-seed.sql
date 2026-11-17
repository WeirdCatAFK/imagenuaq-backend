-- Up Migration

-- Print shop module (RF-IMP-01 to RF-IMP-08). Machines are configurable at runtime
-- so coordination can add presses without a deploy (RF-IMP-02).

CREATE TABLE print_machines (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name      varchar(50) NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT true
);

CREATE TABLE pantone_catalog (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_name  varchar(200) NOT NULL,
  pantone_code varchar(50)  NOT NULL,
  hex_value    varchar(7),
  is_active    boolean NOT NULL DEFAULT true,
  UNIQUE (entity_name, pantone_code)
);

CREATE TABLE print_orders (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id    bigint NOT NULL REFERENCES projects(id),
  order_number  varchar(50) NOT NULL UNIQUE,
  machine_id    bigint NOT NULL REFERENCES print_machines(id),
  status        varchar(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','in_progress','completed','cancelled')),
  entity_name   varchar(200),
  pantone_code  varchar(50),
  pantalla      varchar(100),
  trabajo       varchar(300) NOT NULL,
  papel_type    varchar(100),
  papel_size    varchar(50),
  cantidad      integer,
  laminas       integer,
  frente        boolean NOT NULL DEFAULT false,
  vuelta        boolean NOT NULL DEFAULT false,
  corte         varchar(50),
  folio         varchar(50),
  paquetes_d    integer,
  pegado        boolean NOT NULL DEFAULT false,
  copiante      boolean NOT NULL DEFAULT false,
  notes         text,
  created_by    bigint NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz
);

CREATE INDEX idx_print_orders_project ON print_orders (project_id);
CREATE INDEX idx_print_orders_status  ON print_orders (status);

-- Seed machines
INSERT INTO print_machines (name) VALUES ('SORM'), ('GTO');

-- Seed pantone catalog (institutional colors by faculty/dependency)
INSERT INTO pantone_catalog (entity_name, pantone_code, hex_value) VALUES
  ('Azul Base',                               '2189',    null),
  ('Rectoria + Secretaria Particular',        '226',     '#e41379'),
  ('Bachilleres',                             '632',     '#93d3de'),
  ('Enfermeria',                              '3262',    '#008aa6'),
  ('Ciencias Naturales',                      '2293',    '#9fbc36'),
  ('Ingenieria',                              '200',     '#d30028'),
  ('Informatica',                             '635',     '#94d2dd'),
  ('Quimica',                                 '21',      '#ed6023'),
  ('Contaduria y Administracion',             '387',     '#bdeb40'),
  ('Ciencias Politicas y Sociales',           '298',     '#00a8cb'),
  ('Lenguas y Letras',                        '136',     '#ffc137'),
  ('Medicina',                                '301',     '#0079a4'),
  ('Derecho',                                 '419',     '#636466'),
  ('Artes',                                   '2607',    '#493280'),
  ('Psicologia y Educacion',                  '348',     '#008042'),
  ('Filosofia',                               '232',     '#dc679b'),
  ('Finanzas',                                '2426',    '#01924f'),
  ('Investigacion Innovacion y Posgrado',     '151',     '#f3824c'),
  ('Contraloria',                             '7440',    '#aa78ab'),
  ('Vinculacion y Servicios Universitarios',  '570',     '#6dc2b5'),
  ('Planeacion y Gestion Institucional',      '292',     '#5ea7d0'),
  ('Extension y Cultura Universitaria',       '220',     '#b24e73'),
  ('Administrativa',                          '2592',    '#9b669e'),
  ('Gestion Estrategica',                     '382',     '#9cbc3f'),
  ('Academica',                               '2200',    '#5fa6d2'),
  ('Abogado General',                         '7569',    '#d58b5c'),
  ('UAVIG',                                   '2079',    '#dbc5db'),
  ('UAVIG',                                   'Gris 70', '#d9d9d9'),
  ('Contaduria y Administracion',             '3292',    '#4da82c')
ON CONFLICT (entity_name, pantone_code) DO UPDATE SET hex_value = EXCLUDED.hex_value;

-- Permissions
INSERT INTO permissions (code, label, description) VALUES
  ('print.read',   'Ver impresion',
   'RF-IMP-03: ver la cola de trabajos y las ordenes de impresion'),
  ('print.create', 'Crear ordenes de impresion',
   'RF-IMP-04: crear ordenes de trabajo para las maquinas'),
  ('print.write',  'Modificar ordenes de impresion',
   'RF-IMP-04: modificar, cambiar estatus y eliminar ordenes de trabajo'),
  ('print.manage', 'Administrar catalogo de impresion',
   'RF-IMP-06: administrar el catalogo de pantones y maquinas')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code IN ('print.read', 'print.create', 'print.write', 'print.manage')
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;

-- Audit actions
INSERT INTO actions (code, label) VALUES
  ('print_order_created',  'Orden de impresion creada'),
  ('print_order_updated',  'Orden de impresion modificada'),
  ('print_order_status',   'Cambio de estatus de orden de impresion'),
  ('print_order_deleted',  'Orden de impresion eliminada'),
  ('pantone_created',      'Pantone creado'),
  ('pantone_updated',      'Pantone modificado'),
  ('pantone_deleted',      'Pantone eliminado'),
  ('machine_created',      'Maquina creada'),
  ('machine_updated',      'Maquina modificada')
ON CONFLICT (code) DO NOTHING;


-- Down Migration

DELETE FROM logs WHERE action_id IN (
  SELECT id FROM actions WHERE code IN (
    'print_order_created', 'print_order_updated', 'print_order_status',
    'print_order_deleted', 'pantone_created', 'pantone_updated',
    'pantone_deleted', 'machine_created', 'machine_updated'
  )
);
DELETE FROM actions WHERE code IN (
  'print_order_created', 'print_order_updated', 'print_order_status',
  'print_order_deleted', 'pantone_created', 'pantone_updated',
  'pantone_deleted', 'machine_created', 'machine_updated'
);

DROP TABLE IF EXISTS print_orders;
DROP TABLE IF EXISTS pantone_catalog;
DROP TABLE IF EXISTS print_machines;

DELETE FROM role_permissions
WHERE permission_id IN (
  SELECT id FROM permissions WHERE code IN ('print.read', 'print.create', 'print.write', 'print.manage')
);
DELETE FROM permissions WHERE code IN ('print.read', 'print.create', 'print.write', 'print.manage');
