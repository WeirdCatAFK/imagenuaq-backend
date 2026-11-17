-- Formularios públicos (RF-SOL-01, RF-MIG-01): el enlace que reemplaza al de Microsoft Forms.
-- Quien lo abre no tiene cuenta; el token es la credencial y aquí solo se guarda su hash, igual
-- que en access_tokens. Cada respuesta es una solicitud con source 'form', y si el enlace nombra
-- un libro, la fila también se escribe en ese Excel (DATAMODEL §2.21).

-- Up Migration

CREATE TABLE form_links (
    id          bigserial PRIMARY KEY,
    token_hash  char(64) NOT NULL UNIQUE,
    schema_id   bigint NOT NULL REFERENCES schemas (id) ON DELETE CASCADE,
    sheet_id    bigint REFERENCES sheets (id) ON DELETE SET NULL,
    created_by  bigint NOT NULL REFERENCES users (id),
    created_at  timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    revoked_at  timestamptz,
    CONSTRAINT form_links_hash_is_hex CHECK (token_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX idx_form_links_schema_id ON form_links (schema_id);

COMMENT ON TABLE form_links IS 'RF-SOL-01, RF-MIG-01: enlace público a un formato. Guarda el hash del token, nunca el token. sheet_id: el libro al que se agrega cada respuesta; NULL = solo base de datos.';

ALTER TABLE requests
    ADD COLUMN form_link_id bigint REFERENCES form_links (id) ON DELETE SET NULL,
    ADD COLUMN sheet_written_at timestamptz;

COMMENT ON COLUMN requests.form_link_id IS 'El enlace público por el que llegó, si llegó por uno.';
COMMENT ON COLUMN requests.sheet_written_at IS 'Cuándo se agregó su fila al libro del enlace. NULL con un enlace que tiene libro = pendiente.';

INSERT INTO data_types (code, name, base_type, properties)
VALUES ('choice', 'Opción de una lista', 'string', '{}'::jsonb)
ON CONFLICT (code) DO NOTHING;

-- Down Migration

ALTER TABLE requests
    DROP COLUMN IF EXISTS sheet_written_at,
    DROP COLUMN IF EXISTS form_link_id;

DROP TABLE IF EXISTS form_links;

DELETE FROM data_types d
 WHERE d.code = 'choice'
   AND NOT EXISTS (SELECT 1 FROM field_keys k WHERE k.type = 'choice');
