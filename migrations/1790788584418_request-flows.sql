-- La solicitud lleva su flujo antes de ser proyecto, y el flujo decide a qué bandejas cae.
--
-- **El reparto se hace con el flujo, no con un área suelta** (`DATAMODEL.md` §2.5). Hasta aquí
-- alguien elegía un área en la solicitud y esa era la bandeja; el flujo del proyecto se armaba
-- después, a mano, al convertir. Eran dos decisiones sobre lo mismo —por dónde va a pasar el
-- trabajo— tomadas en dos momentos, y nada las mantenía de acuerdo. Ahora a la solicitud se le
-- aplica una plantilla o se le diseña un flujo, y cae en la bandeja de cada área de su primera
-- fase. `requests.area_id` se queda para lo que ya se repartió a mano.
--
-- **La solicitud es dueña de una copia**, como un proyecto (`flow-templates`, §2.17): una
-- fase pertenece a una versión de plantilla, a un proyecto o a una solicitud, exactamente a
-- uno. Aplicar una plantilla copia sus fases y etapas; ajustarlas no toca la plantilla.
--
-- **Convertir mueve las filas, no las copia.** Las mismas fases pasan de la solicitud al
-- proyecto cambiando de dueño, y cada etapa recibe su primer intento en `project_stages`. Así
-- la definición que se revisó al repartir es literalmente la que se ejecuta.
--
-- `workflow_version_id` en `requests` y `projects` dice de qué versión de plantilla salió el
-- flujo (§6); es nulo cuando se diseñó desde cero.
--
-- Down borra los flujos de las solicitudes que no se convirtieron —eran borradores de
-- reparto— antes de volver a dos dueños.

-- Up Migration

ALTER TABLE flow_phases ADD COLUMN request_id bigint REFERENCES requests (id);

ALTER TABLE flow_phases DROP CONSTRAINT flow_phases_one_owner;
ALTER TABLE flow_phases ADD CONSTRAINT flow_phases_one_owner
    CHECK (num_nonnulls(workflow_version_id, project_id, request_id) = 1);

CREATE UNIQUE INDEX uq_flow_phases_request_seq ON flow_phases (request_id, seq)
    WHERE request_id IS NOT NULL;

COMMENT ON TABLE flow_phases IS 'RF-FLW-02, RF-FLW-09: una fase del flujo. Sus etapas trabajan en paralelo; la siguiente fase empieza cuando esta termina. Pertenece a una version de plantilla, a una solicitud o a un proyecto: exactamente a uno.';
COMMENT ON COLUMN flow_phases.request_id IS 'Solicitud duena mientras no se convierte (DATAMODEL 2.5). Al convertir, la fase pasa al proyecto.';

ALTER TABLE requests ADD COLUMN workflow_version_id bigint REFERENCES workflow_versions (id);
ALTER TABLE projects ADD COLUMN workflow_version_id bigint REFERENCES workflow_versions (id);

COMMENT ON COLUMN requests.workflow_version_id IS 'La version de plantilla de la que se copio su flujo; nulo si se diseno desde cero o no tiene flujo.';
COMMENT ON COLUMN projects.workflow_version_id IS 'La version de plantilla de la que salio su flujo (DATAMODEL 2.2); nulo si se armo a mano.';

-- Down Migration

DELETE FROM flow_phases WHERE request_id IS NOT NULL;

ALTER TABLE projects DROP COLUMN workflow_version_id;
ALTER TABLE requests DROP COLUMN workflow_version_id;

DROP INDEX uq_flow_phases_request_seq;

ALTER TABLE flow_phases DROP CONSTRAINT flow_phases_one_owner;
ALTER TABLE flow_phases ADD CONSTRAINT flow_phases_one_owner
    CHECK (num_nonnulls(workflow_version_id, project_id) = 1);

ALTER TABLE flow_phases DROP COLUMN request_id;

COMMENT ON TABLE flow_phases IS 'RF-FLW-02, RF-FLW-09: una fase del flujo. Sus etapas trabajan en paralelo; la siguiente fase empieza cuando esta termina. Pertenece a una version de plantilla o a un proyecto, nunca a los dos.';
