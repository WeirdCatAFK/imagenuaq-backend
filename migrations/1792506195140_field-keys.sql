-- Las claves de datos que ningún formato declara (DATAMODEL §2.13b, `RF-FLW-06`). Una etapa puede
-- entregar un valor que la solicitud nunca pide —el costo total, el número de orden— y hasta ahora
-- esa clave quedaba sin nombre ni tipo: el proyecto la mostraba cruda y no ofrecía dónde
-- capturarla, así que el visto bueno que la exige no se podía dar nunca.
--
-- Aquí se registra con su nombre y su tipo, y el vocabulario la cuenta junto con las de los
-- formatos: la misma regla de §2.13b vale para ambas, una clave no cambia de tipo.
--
-- Las claves que las etapas ya declaraban sin registro entran como texto, con un nombre sacado de
-- la clave; se corrigen desde el diseñador de flujos.

-- Up Migration

CREATE TABLE field_keys (
    key        varchar(100) PRIMARY KEY,
    name       varchar(200) NOT NULL,
    type       varchar(50) NOT NULL REFERENCES data_types (code),
    note       text,
    created_by bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT field_keys_key_shape CHECK (key ~ '^[a-z][a-z0-9_]{0,99}$')
);

COMMENT ON TABLE field_keys IS 'DATAMODEL 2.13b: claves de datos que ningún formato declara, con su nombre y su tipo. El vocabulario las une con las de los formatos.';

-- Las dos claves que escribe el pedido de finanzas (§2.15) tampoco vienen de un formato.
INSERT INTO field_keys (key, name, type) VALUES
    ('requiere_factura', 'Requiere factura', 'boolean'),
    ('requiere_cotizacion', 'Requiere cotización', 'boolean')
ON CONFLICT (key) DO NOTHING;

INSERT INTO field_keys (key, name, type)
SELECT DISTINCT k.key,
       upper(left(replace(k.key, '_', ' '), 1)) || substr(replace(k.key, '_', ' '), 2),
       'text'
  FROM flow_stages fs
 CROSS JOIN LATERAL (
       SELECT jsonb_array_elements_text(fs.input_keys) AS key
       UNION
       SELECT jsonb_array_elements_text(fs.output_keys)
       ) k
 WHERE k.key ~ '^[a-z][a-z0-9_]{0,99}$'
   AND NOT EXISTS (
       SELECT 1
         FROM schema_versions v
        CROSS JOIN LATERAL (
              SELECT value AS f FROM jsonb_array_elements(coalesce(v.fields -> 'deliverables', '[]'::jsonb))
              UNION ALL
              SELECT value AS f FROM jsonb_array_elements(coalesce(v.fields -> 'information', '[]'::jsonb))
              ) field
        WHERE field.f ->> 'code' = k.key
       )
ON CONFLICT (key) DO NOTHING;

-- Down Migration

DROP TABLE IF EXISTS field_keys;
