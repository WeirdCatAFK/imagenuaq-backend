-- Marcar las filas que ya existen como vistas, sin volverlas solicitudes.
--
-- **El caso que lo pide.** Un rastreador que ya lleva meses llega con dos docenas de renglones
-- históricos, casi todos atendidos y cerrados hace tiempo. Importarlos crearía dos docenas de
-- solicitudes que nadie va a trabajar, y dejarlos sin importar significa que cada corrida futura
-- vuelve a leerlos, a intentarlos y —cuando les falta un campo obligatorio— a reportarlos como
-- error. Lo que hace falta es una raya: de aquí para atrás no, de aquí en adelante sí.
--
-- **Por qué una tabla y no una columna en `sheets`.** La identidad de una fila es su huella
-- (`requests.source_hash`, §2.13), así que «esta fila ya la conozco» hoy sólo se puede decir
-- teniendo la solicitud. Marcar sin crear necesita otro lugar donde vivan esas huellas, y son
-- muchas por libro: una por renglón. Una tabla con `UNIQUE (sheet_id, source_hash)` es la misma
-- forma que ya tiene el antiduplicado, así que `listSourceHashes()` sólo une los dos conjuntos y
-- la importación no cambia en nada más.
--
-- **Se guarda quién y cuándo**, porque marcar es una decisión operativa con consecuencias: las
-- filas marcadas dejan de entrar, y alguien tiene que poder ver que se tomó esa decisión y
-- deshacerla. `DELETE /api/spreadsheets/:id/baseline` la deshace; sin salida de vuelta, un clic
-- por error dejaría filas fuera del sistema para siempre.
--
-- **El límite, dicho:** la huella depende de `hashColumns` del mapeo. Si esas columnas cambian,
-- las marcas dejan de corresponder a las filas que marcaron, igual que le pasa al antiduplicado
-- de las solicitudes ya importadas. No es un problema nuevo de esta tabla, pero sí una razón más
-- para preferir una columna de identificador (`Id` de Formularios) sobre el contenido.

-- Up Migration

CREATE TABLE sheet_row_marks (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    sheet_id    bigint NOT NULL REFERENCES sheets (id) ON DELETE CASCADE,
    -- La misma huella que calcularía la importación para esa fila: sha256 de las celdas que
    -- `hashColumns` nombra, normalizadas (src/utils/columnMap.js::rowHash).
    source_hash varchar(64) NOT NULL,
    marked_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    marked_by   bigint REFERENCES users (id),
    CONSTRAINT uq_sheet_row_marks UNIQUE (sheet_id, source_hash)
);

COMMENT ON TABLE sheet_row_marks IS 'RF-MIG-02: filas de un libro marcadas como ya vistas sin haberlas importado. Sirve para poner en cero un rastreador que ya traía historia: la importación las salta igual que si existiera la solicitud.';
COMMENT ON COLUMN sheet_row_marks.source_hash IS 'La huella de la fila, calculada con el mapeo vigente al marcarla. Si hashColumns cambia, las marcas dejan de corresponder.';
COMMENT ON COLUMN sheet_row_marks.marked_by IS 'Quién decidió no importar esas filas. Nulo si lo hizo un proceso sin sesión.';

INSERT INTO actions (code, label) VALUES
    ('sheet_rows_marked', 'Filas marcadas como ya vistas')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DROP TABLE sheet_row_marks;

DELETE FROM actions WHERE code = 'sheet_rows_marked';
