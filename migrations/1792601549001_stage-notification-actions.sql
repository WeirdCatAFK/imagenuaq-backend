-- Los verbos con que el notificador se entera de una asignación, una entrega y un visto bueno
-- (RF-EST-06, RF-FLW-03).
--
-- **Por qué no basta `record_updated`.** Asignar y entregar se anunciaban como `record_updated`
-- sobre `project_stages`, y el visto bueno como `record_created` sobre `approvals`. Para saber a
-- quién avisar, el suscriptor tendría que comparar `before` con `after` y adivinar qué pasó; con
-- un verbo propio cada evento ya dice qué ocurrió, como `stage_activated` desde
-- 1790095041414_projects-intake. La bitácora sigue con un renglón por acción: el verbo
-- reemplaza al genérico, no se suma.
--
-- **Entran al catálogo cerrado.** `audit.js` rechaza un código que no exista, así que sin este
-- INSERT la asignación, la entrega y el visto bueno dejarían de quedar en la bitácora.

-- Up Migration

INSERT INTO actions (code, label) VALUES
    ('stage_assigned',   'Etapa asignada'),
    ('stage_delivered',  'Etapa entregada'),
    ('stage_signed_off', 'Visto bueno registrado')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs
 WHERE action_id IN (SELECT id FROM actions WHERE code IN
   ('stage_assigned', 'stage_delivered', 'stage_signed_off'));

DELETE FROM actions WHERE code IN ('stage_assigned', 'stage_delivered', 'stage_signed_off');
