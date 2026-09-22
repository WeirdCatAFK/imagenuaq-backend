-- Lo que una etapa recibe y lo que entrega, y los dos tipos de campo que son de finanzas.
--
-- **Entradas y salidas hacen de `RF-FLW-06` una garantía y no una intención.** Hasta ahora una
-- etapa producía valores y la siguiente los encontraba si alguien se acordó de capturarlos;
-- `project_field_values.produced_by_stage_id` lo registraba después del hecho. Ahora la etapa
-- declara qué claves necesita (`inputs`) y qué claves entrega (`outputs`), y el visto bueno
-- **se niega** si una salida declarada no tiene valor, nombrando cuál falta. Por eso la etapa
-- de imprenta encuentra el número de orden: la de diseño no pudo cerrarse sin capturarlo.
--
-- Solo se exigen las salidas. Las entradas son para quien atiende la etapa —esto es lo que
-- necesitas para trabajar— y no bloquean nada: un dato que no llegó es justamente el motivo por
-- el que una etapa se queda esperando (`RF-FLW-07`), no un error de captura.
--
-- Son arreglos de claves de campo (`jsonb`), no una tabla puente, por lo mismo que los campos
-- de un formato: se leen de una etapa a la vez y nada busca entre etapas distintas. Cuando
-- entren los flujos declarativos (§6), `workflow_stages` llevará la declaración y
-- `project_stages` seguirá llevando la copia instanciada.
--
-- **`factura` y `cotizacion` son tipos de campo, no tablas.** Guardan el folio o la referencia
-- que genera el sistema financiero de la UAQ, que `RF-MIG-04` dice que se captura a mano
-- porque este sistema no lo sustituye. Son `string` como `url` o `email`, y llevan
-- `properties.finance = true`, que es cómo el resto del sistema sabe que un campo es de
-- finanzas sin mantener una lista aparte. Cuando ARC tenga carga de archivos, el mismo campo
-- acepta el PDF (`RF-ARC-05`) sin mover ningún dato.
--
-- **Finanzas entra a ver, y puede pedir.** `project.read` al rol `finance` para que vea el
-- tablero completo y lo filtre por el valor de un campo. Para señalar que un proyecto necesita
-- factura o cotización hay un permiso propio, `finance.request`, y una ruta que solo puede
-- escribir dos claves reservadas: `requiere_factura` y `requiere_cotizacion`. No se le da
-- `project.write` porque ese permiso alcanza para etapas, vistos buenos y cierre, que no es lo
-- que finanzas necesita (`RF-USR-05`: leer y escribir son independientes).
--
-- El nombre es `finance.request` y no `project.request` porque en este dominio «request» ya es
-- la solicitud: `project.request` se leería como «la solicitud del proyecto».

-- Up Migration

ALTER TABLE project_stages
  ADD COLUMN inputs  jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN outputs jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE project_stages
  ADD CONSTRAINT project_stages_inputs_is_array  CHECK (jsonb_typeof(inputs) = 'array'),
  ADD CONSTRAINT project_stages_outputs_is_array CHECK (jsonb_typeof(outputs) = 'array');

COMMENT ON COLUMN project_stages.inputs IS 'RF-FLW-06: claves de project_field_values que esta etapa necesita para trabajar. Informativas: no bloquean.';
COMMENT ON COLUMN project_stages.outputs IS 'RF-FLW-06: claves que esta etapa entrega. El visto bueno se niega si alguna no tiene valor.';

INSERT INTO data_types (code, name, base_type, properties) VALUES
    ('cotizacion', 'Cotización', 'string', '{"finance": true}'::jsonb),
    ('factura',    'Factura',    'string', '{"finance": true}'::jsonb)
ON CONFLICT (code) DO NOTHING;

INSERT INTO permissions (code, label, description)
VALUES ('finance.request', 'Pedir factura o cotización',
        'Señalar que un proyecto necesita factura o cotización, sin poder editar el proyecto')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r
JOIN permissions p ON p.code IN ('project.read', 'finance.request')
WHERE r.name = 'finance'
ON CONFLICT DO NOTHING;

-- Down Migration

DELETE FROM role_permissions
WHERE role_id = (SELECT id FROM roles WHERE name = 'finance')
  AND permission_id IN (SELECT id FROM permissions WHERE code IN ('project.read', 'finance.request'));

DELETE FROM permissions WHERE code = 'finance.request';

-- Las filas que ya usen estos tipos detienen el rollback por la llave foránea que no existe:
-- `schema_versions.fields` los nombra por código, así que aquí solo se van los tipos.
DELETE FROM data_types WHERE code IN ('factura', 'cotizacion');

ALTER TABLE project_stages
  DROP CONSTRAINT project_stages_outputs_is_array,
  DROP CONSTRAINT project_stages_inputs_is_array;

ALTER TABLE project_stages
  DROP COLUMN outputs,
  DROP COLUMN inputs;
