-- Plantillas de flujo, y la etapa separada en su definición y su ejecución.
--
-- **Fases, no un grafo.** `DATAMODEL.md` §2.1 planeó el flujo como nodos y aristas con
-- posición en pantalla. El diseñador que se construyó arma el flujo por fases: columnas
-- ordenadas cuyas etapas trabajan en paralelo (`RF-FLW-09`), y la fase siguiente empieza
-- cuando la anterior terminó. Eso cubre la bifurcación y la reunión de ramas en el borde de
-- una fase, que es lo que las entrevistas describen; lo que no expresa son dos cadenas
-- independientes avanzando a ritmos distintos. Si aparecen, las aristas se agregan encima de
-- estas tablas sin rehacerlas.
--
-- **La definición de una etapa es una cosa y su ejecución es otra.** `project_stages`
-- mezclaba las dos: área, título, orden y claves de entrada y salida junto al estatus, el
-- intento y las fechas, y un visto bueno rechazado copiaba la definición entera en la fila del
-- intento siguiente. Una plantilla necesita la definición sin la ejecución, y tener una tabla
-- de etapas para plantillas y otra para proyectos con las mismas columnas es la duplicación
-- que ya costó la jefatura de área en tres lugares (`schema-proofing`). Así que:
--
--   flow_phases / flow_stages   la definición, de una versión de plantilla O de un proyecto
--   project_stages              la ejecución: un renglón por intento de una definición
--
-- El dueño de una fase es exactamente uno (`flow_phases_one_owner`). Partir de una plantilla
-- (el incremento siguiente) copia sus fases y etapas al proyecto; el proyecto puede cambiar
-- su copia sin tocar la plantilla, y la plantilla puede publicar otra versión sin tocar los
-- proyectos que ya salieron de ella (`DATAMODEL.md` §2.2).
--
-- **`project_stages.project_id` se va.** El proyecto ya está en la fase de la definición;
-- dejarlo también en la ejecución es guardarlo dos veces, y dos copias sin algo que las
-- mantenga de acuerdo terminan en desacuerdo. Todo lo que lo leía ya tiene que unir con la
-- definición para saber el área o el título, así que la unión no cuesta nada nuevo.
--
-- **La clave única pasa a `(flow_stage_id, attempt)`**, que es la que §2.6 esperaba: `seq`
-- sostenía el lugar del nodo mientras no hubiera nodos. Conserva su nombre para que la
-- traducción del error en `orchestration/projects.js` siga funcionando.
--
-- **Las versiones publicadas no se editan** (`RF-FLW-02`, `RF-PRY-06`, §2.2), igual que
-- `schema_versions`: un disparador rechaza actualizar una versión, sus fases o sus etapas, y
-- agregar fases o etapas a una versión publicada en otra transacción. Publicar escribe
-- versión, fases y etapas en una sola sentencia, así que pasa. Borrar sí se permite: las
-- pruebas lo necesitan y la aplicación no lo expone.
--
-- `workflow.manage` es su propio permiso por lo mismo que `schema.manage` y
-- `status.manage`: el catálogo lo edita la coordinación, no quien atiende un proyecto.
--
-- Al subir, los intentos de una misma etapa comparten una definición, así que todos quedan con
-- el título y las claves del intento más reciente -- lo que la pantalla ya mostraba.
--
-- Down revierte de verdad, con un límite: si una fase de proyecto tiene dos etapas de la misma
-- área, la clave vieja `(project_id, area_id, seq, attempt)` no puede distinguirlas y se
-- niega en vez de mezclarlas. Pierde las notas, los días estimados, los nombres de fase y
-- todas las plantillas.

-- Up Migration

INSERT INTO permissions (code, label, description)
VALUES ('workflow.manage', 'Administrar plantillas de flujo',
        'RF-FLW-02, RF-PRY-06: crear plantillas de flujo, publicar versiones, clonarlas y desactivarlas')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'workflow.manage'
WHERE r.name = 'admin'
ON CONFLICT DO NOTHING;


CREATE TABLE workflows (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code       varchar(50) NOT NULL,
    name       varchar(300) NOT NULL,
    is_active  boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_workflows_code UNIQUE (code)
);
COMMENT ON TABLE workflows IS 'RF-FLW-02, RF-PRY-06: identidad estable de una plantilla de flujo. Su contenido vive en workflow_versions.';

CREATE TABLE workflow_versions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_id  bigint NOT NULL REFERENCES workflows (id),
    version      int NOT NULL,
    published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_by bigint REFERENCES users (id),
    CONSTRAINT workflow_versions_version_positive CHECK (version >= 1),
    CONSTRAINT uq_workflow_versions_version UNIQUE (workflow_id, version)
);
COMMENT ON TABLE workflow_versions IS 'DATAMODEL 2.2: inmutable una vez publicada. Editar una plantilla publica una version nueva.';

CREATE TABLE flow_phases (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    workflow_version_id bigint REFERENCES workflow_versions (id) ON DELETE CASCADE,
    project_id          bigint REFERENCES projects (id),
    seq                 int NOT NULL,
    name                varchar(100) NOT NULL,
    CONSTRAINT flow_phases_one_owner CHECK (num_nonnulls(workflow_version_id, project_id) = 1),
    CONSTRAINT flow_phases_seq_positive CHECK (seq >= 1)
);
COMMENT ON TABLE flow_phases IS 'RF-FLW-02, RF-FLW-09: una fase del flujo. Sus etapas trabajan en paralelo; la siguiente fase empieza cuando esta termina. Pertenece a una version de plantilla o a un proyecto, nunca a los dos.';
COMMENT ON COLUMN flow_phases.seq IS 'Orden de la fase dentro de su flujo. Es lo que decide que fase sigue.';

CREATE UNIQUE INDEX uq_flow_phases_version_seq ON flow_phases (workflow_version_id, seq)
    WHERE workflow_version_id IS NOT NULL;
CREATE UNIQUE INDEX uq_flow_phases_project_seq ON flow_phases (project_id, seq)
    WHERE project_id IS NOT NULL;

CREATE TABLE flow_stages (
    id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    phase_id            bigint NOT NULL REFERENCES flow_phases (id) ON DELETE CASCADE,
    seq                 int NOT NULL DEFAULT 1,
    area_id             bigint NOT NULL REFERENCES areas (id),
    title               varchar(300) NOT NULL,
    default_assignee_id bigint REFERENCES users (id),
    input_keys          jsonb NOT NULL DEFAULT '[]'::jsonb,
    output_keys         jsonb NOT NULL DEFAULT '[]'::jsonb,
    input_note          text,
    output_note         text,
    estimated_days      int,
    CONSTRAINT flow_stages_seq_positive CHECK (seq >= 1),
    CONSTRAINT flow_stages_input_keys_is_array  CHECK (jsonb_typeof(input_keys) = 'array'),
    CONSTRAINT flow_stages_output_keys_is_array CHECK (jsonb_typeof(output_keys) = 'array'),
    CONSTRAINT flow_stages_estimated_days_positive CHECK (estimated_days IS NULL OR estimated_days > 0),
    CONSTRAINT uq_flow_stages_phase_seq UNIQUE (phase_id, seq)
);
COMMENT ON TABLE flow_stages IS 'La definicion de una etapa: que area, que hace, que necesita y que entrega. Su ejecucion (intentos, estatus, fechas) vive en project_stages.';
COMMENT ON COLUMN flow_stages.seq IS 'Orden de presentacion dentro de la fase. No decide que sigue: las etapas de una fase son paralelas.';
COMMENT ON COLUMN flow_stages.default_assignee_id IS 'Solo en plantillas: la persona sugerida, miembro activo del area al publicar. En un proyecto el responsable es project_stages.assigned_to.';
COMMENT ON COLUMN flow_stages.input_keys IS 'RF-FLW-06: claves de project_field_values que esta etapa necesita para trabajar. Informativas: no bloquean.';
COMMENT ON COLUMN flow_stages.output_keys IS 'RF-FLW-06: claves que esta etapa entrega. El visto bueno se niega si alguna no tiene valor.';
COMMENT ON COLUMN flow_stages.input_note IS 'Descripcion libre de lo que entra, para quien lee el flujo.';
COMMENT ON COLUMN flow_stages.output_note IS 'Descripcion libre de lo que sale, para quien lee el flujo.';
COMMENT ON COLUMN flow_stages.estimated_days IS 'Dias habiles estimados. Obligatorio en plantillas, opcional en proyectos.';

CREATE INDEX idx_flow_stages_area_id ON flow_stages (area_id);


-- Lo publicado no se edita. Un renglón insertado por otra parte de la misma sentencia no es
-- visible aquí, y por eso publicar y clonar -- que escriben versión, fases y etapas de una vez
-- -- pasan, mientras que cualquier escritura posterior sobre una versión se rechaza.

CREATE FUNCTION workflow_versions_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'workflow_version % is published and cannot be edited; publish a new version instead', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_versions_immutable
  BEFORE UPDATE ON workflow_versions
  FOR EACH ROW
  EXECUTE FUNCTION workflow_versions_reject_update();

CREATE FUNCTION flow_version_is_sealed(version_id bigint) RETURNS boolean AS $$
  SELECT EXISTS (
    SELECT 1 FROM workflow_versions
    WHERE id = version_id AND published_at < transaction_timestamp()
  );
$$ LANGUAGE sql STABLE;

CREATE FUNCTION flow_phases_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.workflow_version_id IS NOT NULL OR NEW.workflow_version_id IS NOT NULL) THEN
    RAISE EXCEPTION 'flow_phase % belongs to a published workflow version and cannot be edited', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' AND flow_version_is_sealed(NEW.workflow_version_id) THEN
    RAISE EXCEPTION 'workflow_version % is published; publish a new version instead', NEW.workflow_version_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flow_phases_immutable
  BEFORE INSERT OR UPDATE ON flow_phases
  FOR EACH ROW
  EXECUTE FUNCTION flow_phases_guard();

CREATE FUNCTION flow_stages_guard() RETURNS trigger AS $$
DECLARE
  new_version bigint;
  old_version bigint;
BEGIN
  SELECT workflow_version_id INTO new_version FROM flow_phases WHERE id = NEW.phase_id;
  IF TG_OP = 'UPDATE' THEN
    SELECT workflow_version_id INTO old_version FROM flow_phases WHERE id = OLD.phase_id;
    IF old_version IS NOT NULL OR new_version IS NOT NULL THEN
      RAISE EXCEPTION 'flow_stage % belongs to a published workflow version and cannot be edited', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF flow_version_is_sealed(new_version) THEN
    RAISE EXCEPTION 'workflow_version % is published; publish a new version instead', new_version
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER flow_stages_immutable
  BEFORE INSERT OR UPDATE ON flow_stages
  FOR EACH ROW
  EXECUTE FUNCTION flow_stages_guard();


-- La ejecución solo apunta a definiciones de un proyecto: una plantilla no se ejecuta.

ALTER TABLE project_stages ADD COLUMN flow_stage_id bigint REFERENCES flow_stages (id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM project_stages WHERE seq < 1) THEN
    RAISE EXCEPTION 'project_stages has rows with seq < 1; phases start at 1. Renumber them before migrating.';
  END IF;
END;
$$;

INSERT INTO flow_phases (project_id, seq, name)
SELECT DISTINCT project_id, seq, 'Fase ' || seq
FROM project_stages;

-- Una definición por (proyecto, área, seq), que era la identidad de la etapa; su título y sus
-- claves salen del intento más reciente, que es lo que la pantalla mostraba.
INSERT INTO flow_stages (phase_id, seq, area_id, title, input_keys, output_keys)
SELECT fp.id,
       row_number() OVER (PARTITION BY fp.id ORDER BY d.first_id),
       d.area_id, d.title, d.inputs, d.outputs
FROM (
    SELECT DISTINCT ON (project_id, area_id, seq)
           project_id, area_id, seq, title, inputs, outputs,
           min(id) OVER (PARTITION BY project_id, area_id, seq) AS first_id
    FROM project_stages
    ORDER BY project_id, area_id, seq, attempt DESC, id DESC
) d
JOIN flow_phases fp ON fp.project_id = d.project_id AND fp.seq = d.seq;

UPDATE project_stages ps
SET flow_stage_id = fs.id
FROM flow_stages fs
JOIN flow_phases fp ON fp.id = fs.phase_id
WHERE fp.project_id = ps.project_id
  AND fp.seq = ps.seq
  AND fs.area_id = ps.area_id;

ALTER TABLE project_stages ALTER COLUMN flow_stage_id SET NOT NULL;

DROP INDEX uq_project_stages_attempt;
CREATE UNIQUE INDEX uq_project_stages_attempt ON project_stages (flow_stage_id, attempt);
DROP INDEX idx_project_stages_open;
CREATE INDEX idx_project_stages_open ON project_stages (flow_stage_id)
    WHERE status IN ('active', 'waiting_external');
DROP INDEX idx_project_stages_project_id;

ALTER TABLE project_stages
  DROP COLUMN project_id,
  DROP COLUMN area_id,
  DROP COLUMN title,
  DROP COLUMN seq,
  DROP COLUMN inputs,
  DROP COLUMN outputs;

COMMENT ON TABLE project_stages IS 'RF-FLW-01, RF-FLW-03, RF-PRY-03: la ejecucion de una etapa, un renglon por intento. La definicion vive en flow_stages; la etapa actual es el conjunto de filas con status active, no una columna en projects.';
COMMENT ON COLUMN project_stages.flow_stage_id IS 'La definicion que este intento ejecuta. Siempre de un proyecto, nunca de una plantilla.';

CREATE FUNCTION project_stages_guard_definition() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM flow_stages fs JOIN flow_phases fp ON fp.id = fs.phase_id
    WHERE fs.id = NEW.flow_stage_id AND fp.workflow_version_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'flow_stage % belongs to a workflow template; a project runs its own copy', NEW.flow_stage_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER project_stages_definition_is_project
  BEFORE INSERT OR UPDATE OF flow_stage_id ON project_stages
  FOR EACH ROW
  EXECUTE FUNCTION project_stages_guard_definition();

-- Down Migration

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM flow_stages fs JOIN flow_phases fp ON fp.id = fs.phase_id
    WHERE fp.project_id IS NOT NULL
    GROUP BY fp.id, fs.area_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A project phase has two stages of the same area; the old key (project_id, area_id, seq, attempt) cannot tell them apart.';
  END IF;
END;
$$;

DROP TRIGGER project_stages_definition_is_project ON project_stages;
DROP FUNCTION project_stages_guard_definition();

ALTER TABLE project_stages
  ADD COLUMN project_id bigint REFERENCES projects (id),
  ADD COLUMN area_id    bigint REFERENCES areas (id),
  ADD COLUMN title      varchar(300),
  ADD COLUMN seq        int DEFAULT 1,
  ADD COLUMN inputs     jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN outputs    jsonb DEFAULT '[]'::jsonb;

UPDATE project_stages ps
SET project_id = fp.project_id,
    area_id    = fs.area_id,
    title      = fs.title,
    seq        = fp.seq,
    inputs     = fs.input_keys,
    outputs    = fs.output_keys
FROM flow_stages fs
JOIN flow_phases fp ON fp.id = fs.phase_id
WHERE fs.id = ps.flow_stage_id;

ALTER TABLE project_stages
  ALTER COLUMN project_id SET NOT NULL,
  ALTER COLUMN area_id    SET NOT NULL,
  ALTER COLUMN title      SET NOT NULL,
  ALTER COLUMN seq        SET NOT NULL,
  ALTER COLUMN inputs     SET NOT NULL,
  ALTER COLUMN outputs    SET NOT NULL;

ALTER TABLE project_stages
  ADD CONSTRAINT project_stages_inputs_is_array  CHECK (jsonb_typeof(inputs) = 'array'),
  ADD CONSTRAINT project_stages_outputs_is_array CHECK (jsonb_typeof(outputs) = 'array');

COMMENT ON TABLE project_stages IS 'RF-FLW-01, RF-FLW-09, RF-PRY-03. La etapa actual es el conjunto de filas con status active, no una columna en projects.';
COMMENT ON COLUMN project_stages.seq IS 'Orden de presentacion dentro del proyecto. No decide que sigue.';
COMMENT ON COLUMN project_stages.inputs IS 'RF-FLW-06: claves de project_field_values que esta etapa necesita para trabajar. Informativas: no bloquean.';
COMMENT ON COLUMN project_stages.outputs IS 'RF-FLW-06: claves que esta etapa entrega. El visto bueno se niega si alguna no tiene valor.';

DROP INDEX uq_project_stages_attempt;
CREATE UNIQUE INDEX uq_project_stages_attempt
    ON project_stages (project_id, area_id, seq, attempt);
CREATE INDEX idx_project_stages_project_id ON project_stages (project_id);
DROP INDEX idx_project_stages_open;
CREATE INDEX idx_project_stages_open ON project_stages (area_id, status)
    WHERE status IN ('active', 'waiting_external');

ALTER TABLE project_stages DROP COLUMN flow_stage_id;

DROP TABLE flow_stages;
DROP TABLE flow_phases;
DROP TABLE workflow_versions;
DROP TABLE workflows;

DROP FUNCTION flow_stages_guard();
DROP FUNCTION flow_phases_guard();
DROP FUNCTION flow_version_is_sealed(bigint);
DROP FUNCTION workflow_versions_reject_update();

DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'workflow.manage');

DELETE FROM permissions WHERE code = 'workflow.manage';
