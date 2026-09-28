-- Lo que le falta al proyecto para tener API: una llave que no haya que inventar, evidencia
-- en el visto bueno y los verbos con que se anuncia el avance.
--
-- **La llave se genera y se puede sobrescribir.** `projects.key` se asignaba a mano
-- (`PAPEL-FCQ-03`), lo que está bien cuando alguien bautiza el proyecto y estorba cuando la
-- vía normal es convertir una solicitud: la conversión se detendría a que una persona invente
-- un nombre, y lo que se teclea en ese momento es `PROYECTO-1`. La secuencia da
-- `PRY-000001` igual que `requests_folio_seq` da `SOL-000001`, y quien sí quiere nombrar
-- sigue mandando su llave. El CHECK `projects_key_format` ya acepta las dos formas.
--
-- **La evidencia es una columna nulable, no una promesa.** El visto bueno es interno
-- (`RF-FLW-03`); la conformidad del solicitante se captura como evidencia, no como firma
-- (DATAMODEL 2.11). `evidence_file_id` existe desde ahora para que la regla viva en el
-- esquema, y queda vacía hasta que ARC tenga por dónde subir un archivo: `openVolumes()`
-- todavía no se llama desde ningún lado.
--
-- **Los tres verbos son del catálogo cerrado.** `audit.js` rechaza un código que no exista,
-- así que `request_converted`, `stage_activated` y `stage_completed` entran aquí o C y E no
-- pueden emitirlos. Los tres dicen algo que `record_updated` no puede: el primero liga dos
-- objetos, y los otros dos son a lo que se suscribirá el notificador de `RF-FLW-04`.

-- Up Migration

CREATE SEQUENCE projects_key_seq;

ALTER TABLE projects
  ALTER COLUMN key SET DEFAULT ('PRY-' || to_char(nextval('projects_key_seq'), 'FM000000'));

COMMENT ON COLUMN projects.key IS 'Identificador corto y legible; sirve como nombre de carpeta. Se genera como PRY-000001 si no se manda, y se puede sobrescribir con uno propio.';

ALTER TABLE approvals ADD COLUMN evidence_file_id bigint REFERENCES files (id);

COMMENT ON COLUMN approvals.evidence_file_id IS 'DATAMODEL 2.11: la conformidad del solicitante como evidencia, no como firma. Nulable hasta que ARC tenga carga de archivos.';

INSERT INTO actions (code, label) VALUES
    ('request_converted', 'Solicitud convertida en proyecto'),
    ('stage_activated',   'Etapa habilitada'),
    ('stage_completed',   'Etapa concluida')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs
 WHERE action_id IN (SELECT id FROM actions WHERE code IN
   ('request_converted', 'stage_activated', 'stage_completed'));

DELETE FROM actions WHERE code IN ('request_converted', 'stage_activated', 'stage_completed');

ALTER TABLE approvals DROP COLUMN evidence_file_id;

ALTER TABLE projects ALTER COLUMN key DROP DEFAULT;

COMMENT ON COLUMN projects.key IS 'Identificador corto y legible; sirve como nombre de carpeta. Se asigna, no se genera.';

DROP SEQUENCE projects_key_seq;
