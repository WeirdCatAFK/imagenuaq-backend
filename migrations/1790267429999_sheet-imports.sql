-- La corrida de una importación, y el mapeo que la hace posible (RF-MIG-01, RF-MIG-02).
--
-- **Por qué la corrida es una tabla y no solo una respuesta HTTP.** Importar veinticuatro filas
-- deja veinticuatro resultados: unas se crearon, unas se saltaron porque ya estaban, una falló
-- porque le falta un campo obligatorio. Quien corre la importación ve eso en la respuesta, pero
-- la pregunta que se hace después —«¿qué pasó la última vez?», «¿por qué esta fila no entró?»—
-- no tiene dónde contestarse si el reporte vivió solo en una pantalla que ya se cerró. Cada
-- corrida es una fila con sus conteos y sus errores, y `sheets.last_imported_at` sigue diciendo
-- hasta dónde llegó la última.
--
-- Los conteos se guardan además de los errores porque «se saltaron 20» es la respuesta normal de
-- una reimportación y no hay nada que anotar de cada una; contar filas de `errors` no diría eso.
--
-- **El mapeo se queda en `sheets.column_map`**, mutable, sin versionar (DATAMODEL 2.10). Una
-- solicitud ya importada no se vuelve a leer a través del mapeo: su captura quedó en
-- `requests.data` y su renglón crudo en `source_data`, así que remapear la hoja no cambia nada de
-- lo ya importado. Eso es lo que hace innecesaria una tabla de versiones del mapeo.
--
-- **No hay escritura de vuelta a la hoja, todavía.** La cuenta está conectada con
-- `Files.Read.All` y el cliente de Graph solo tiene GET. Sincronizar el estatus del proyecto
-- hacia el Excel es un incremento aparte: necesita otro consentimiento del dueño de la cuenta,
-- un PATCH en el primitivo y una columna reservada en cada libro. Mientras tanto la hoja se
-- importa una vez —con su estatus, que el mapeo traduce— y a partir de ahí el avance vive aquí.

-- Up Migration

CREATE TABLE sheet_imports (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sheet_id     bigint NOT NULL REFERENCES sheets (id),
    run_by       bigint REFERENCES users (id),
    started_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at  timestamptz,
    -- Cuántas filas traía la hoja bajo el encabezado, antes de decidir nada sobre ellas.
    rows_read    int NOT NULL DEFAULT 0,
    rows_created int NOT NULL DEFAULT 0,
    -- Ya estaban: su huella coincide con una solicitud de este libro.
    rows_skipped int NOT NULL DEFAULT 0,
    rows_failed  int NOT NULL DEFAULT 0,
    -- Entraron, pero parecen la corrección de una fila anterior (`possible_duplicate_of`).
    rows_flagged int NOT NULL DEFAULT 0,
    errors       jsonb NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT sheet_imports_errors_is_array CHECK (jsonb_typeof(errors) = 'array')
);

COMMENT ON TABLE sheet_imports IS 'RF-MIG-02: una corrida de importación con sus conteos y los renglones que no entraron. Sobrevive a la respuesta HTTP porque la pregunta "por qué no entró esta fila" se hace después.';
COMMENT ON COLUMN sheet_imports.errors IS 'Arreglo de { index, message }: el renglón de la hoja y por qué no se pudo importar.';

CREATE INDEX idx_sheet_imports_sheet_id ON sheet_imports (sheet_id, started_at DESC);

COMMENT ON COLUMN sheets.column_map IS
  'RF-MIG-02: cómo una fila se vuelve solicitud. { version, title, requester, priority, status: {op, column, map: {texto: codigo}, default}, hashColumns, fields: {codigo: regla} }. Las reglas son column | constant | concat | split, y nombran columnas por el texto de su encabezado. hashColumns es la identidad de la fila: la columna Id del formulario si la hay, y si no las celdas mapeadas. Ver src/utils/columnMap.js.';

INSERT INTO actions (code, label) VALUES
    ('sheet_imported', 'Libro importado')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs WHERE action_id = (SELECT id FROM actions WHERE code = 'sheet_imported');
DELETE FROM actions WHERE code = 'sheet_imported';

COMMENT ON COLUMN sheets.column_map IS
  'Encabezado del Excel -> campo de schema_versions.fields o columna promovida de requests';

DROP TABLE sheet_imports;
