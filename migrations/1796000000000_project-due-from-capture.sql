-- Up Migration

-- Un proyecto convertido no tomaba la fecha de entrega que capturó su solicitud, así que no salía
-- en el calendario ni en la lista de proyectos. La conversión ya la toma; esto llena los que
-- quedaron sin fecha. Las mismas claves que DUE_DATE_KEYS en requests.js.
UPDATE projects p
SET due_on = v.value::date
FROM project_field_values v
WHERE v.project_id = p.id
  AND v.key IN ('fecha_entrega', 'fecha_de_entrega')
  AND v.value ~ '^\d{4}-\d{2}-\d{2}$'
  AND p.due_on IS NULL;

-- Down Migration

-- Sin vuelta atrás: no se distingue una fecha llenada aquí de una puesta a mano después.
