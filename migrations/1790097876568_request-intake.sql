-- Lo que la solicitud necesita para poder venir de una hoja sin duplicarse (RF-MIG-01,
-- RF-MIG-02, RF-SOL-06).
--
-- **La fila de origen se reconoce por su contenido, no por su posición.** Graph no da un
-- identificador estable de renglón: `/rows` los entrega por índice, y ese índice se mueve en
-- cuanto alguien ordena la hoja, inserta arriba o arrastra celdas. Por eso la huella es un
-- `sha256` de las celdas que el mapeo declare (`hashColumns`), normalizadas —recortadas, en
-- minúsculas, con los espacios colapsados—, y es única por libro. Reimportar la misma hoja
-- vuelve a calcular las mismas huellas y no crea nada; ordenarla tampoco.
--
-- Se descartó **escribir la marca de leído de vuelta en la hoja**, que es lo que el plan de
-- desarrollo proponía para I2. Habría necesitado permiso de escritura en Graph
-- (`Files.ReadWrite.All`, otro consentimiento), una columna reservada en cada libro y la
-- confianza de que nadie la borra ni la sobrescribe. La huella en la base de datos no le pide
-- nada a la hoja y no se puede alterar desde Excel.
--
-- **El costo, dicho:** la huella solo cubre las columnas que el mapeo nombra. Si alguien
-- corrige una celda que sí entra en la huella, la fila se lee como nueva; para eso está
-- `possible_duplicate_of`, que la liga con la que probablemente era y deja que una persona
-- decida. Si corrige una celda que no entra, el cambio es invisible por diseño. Y las filas
-- que fallan un campo obligatorio se reportan y no se insertan: una solicitud a medias en la
-- bandeja es peor que una fila pendiente en la hoja.
--
-- `source_data` guarda el renglón completo indexado por encabezado, **incluidas las columnas
-- que el mapeo ignora**. `RF-SOL-06` pide conservar todo lo capturado, y el mapeo de hoy no
-- sabe qué va a ocupar facturación mañana.

-- Up Migration

ALTER TABLE requests
  ADD COLUMN source_index         int,
  ADD COLUMN source_data          jsonb,
  ADD COLUMN source_hash          varchar(64),
  ADD COLUMN possible_duplicate_of bigint REFERENCES requests (id);

COMMENT ON COLUMN requests.source_index IS 'Renglón del que salió, para volver a verlo en la hoja. Decorativo: el índice se mueve si alguien ordena.';
COMMENT ON COLUMN requests.source_data IS 'RF-SOL-06: el renglón completo indexado por encabezado, incluidas las columnas que el mapeo ignora.';
COMMENT ON COLUMN requests.source_hash IS 'RF-MIG-02: sha256 de las celdas que el mapeo declara, normalizadas. Único por libro; es lo que impide importar dos veces la misma fila.';
COMMENT ON COLUMN requests.possible_duplicate_of IS 'La solicitud que esta probablemente corrige: mismo título y solicitante en el mismo libro, con la huella cambiada. Lo resuelve una persona.';

ALTER TABLE requests
  ADD CONSTRAINT requests_hash_origin CHECK (source_hash IS NULL OR source = 'sheet'),
  ADD CONSTRAINT requests_data_is_object_or_null
    CHECK (source_data IS NULL OR jsonb_typeof(source_data) = 'object');

CREATE UNIQUE INDEX uq_requests_sheet_hash ON requests (sheet_id, source_hash)
  WHERE sheet_id IS NOT NULL AND source_hash IS NOT NULL;

CREATE INDEX idx_requests_duplicate_of ON requests (possible_duplicate_of)
  WHERE possible_duplicate_of IS NOT NULL;

-- Down Migration

DROP INDEX idx_requests_duplicate_of;
DROP INDEX uq_requests_sheet_hash;

ALTER TABLE requests
  DROP CONSTRAINT requests_data_is_object_or_null,
  DROP CONSTRAINT requests_hash_origin;

ALTER TABLE requests
  DROP COLUMN possible_duplicate_of,
  DROP COLUMN source_hash,
  DROP COLUMN source_data,
  DROP COLUMN source_index;
