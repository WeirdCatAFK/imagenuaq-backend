-- Up Migration

-- Las descripciones de permisos se muestran tal cual en la pantalla de roles (el signo de ayuda);
-- quien las lee no conoce los códigos de requerimiento ni las claves internas.
UPDATE permissions p SET description = d.description
FROM (VALUES
    ('project.read',        'Consultar los proyectos del área y de las personas a cargo.'),
    ('project.write',       'Modificar proyectos, sus etapas y vistos buenos. Es independiente de poder verlos.'),
    ('request.read',        'Ver la bandeja de solicitudes entrantes.'),
    ('request.write',       'Modificar solicitudes. Es independiente de poder verlas.'),
    ('task.read',           'Ver las tareas propias y las del área.'),
    ('task.write',          'Repartir tareas del área, asignar responsables y dar el visto bueno de las etapas.'),
    ('finance.read',        'Ver, sin poder modificar, las facturas y cotizaciones de cualquier área.'),
    ('availability.read',   'Ver qué días falta cada persona y de qué área, sin ver el motivo.'),
    ('absence.reason.read', 'Ver el motivo de una ausencia y su documento de respaldo. Es distinto de ver la disponibilidad.'),
    ('absence.approve',     'Autorizar o rechazar permisos de ausencia.'),
    ('area.manage',         'Dar de alta y administrar áreas y coordinaciones.'),
    ('spreadsheet.read',    'Ver las cuentas Microsoft conectadas y los libros de Excel registrados.'),
    ('spreadsheet.write',   'Conectar o desconectar la cuenta Microsoft propia y registrar o quitar libros de Excel.'),
    ('status.manage',       'Crear, editar y desactivar los estatus, globales y por área.'),
    ('workflow.manage',     'Crear plantillas de flujo, publicar versiones nuevas, clonarlas y desactivarlas.'),
    ('document.read',       'Ver carpetas y descargar archivos de las carpetas a las que se tiene acceso.'),
    ('document.write',      'Crear carpetas y subir, renombrar y mover archivos donde se tiene acceso de escritura.'),
    ('document.manage',     'Eliminar y recompartir carpetas y archivos ajenos donde se tiene acceso de escritura.'),
    ('document.share',      'Crear y revocar enlaces temporales de solo lectura a carpetas que se pueden ver.'),
    ('calendar.read',       'Ver el calendario propio y el de las áreas a las que se pertenece.'),
    ('calendar.write',      'Administrar eventos globales y ventanas de cierre de semestre.'),
    ('finance.write',       'Decidir cotizaciones, cambiar el estatus de las facturas y administrar proveedores.'),
    ('finance.validate',    'Dar el visto bueno a un recibo antes de emitirlo. Nunca a uno propio.')
) AS d(code, description)
WHERE p.code = d.code;

-- Down Migration

-- Los textos anteriores solo citaban códigos internos; no se restauran.
SELECT 1;
