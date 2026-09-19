-- Up Migration

INSERT INTO data_types (
  code,
  name,
  base_type,
  properties
)
VALUES
  (
    'text',
    'Texto',
    'string',
    '{}'::jsonb
  ),
  (
    'email',
    'Correo electrónico',
    'string',
    '{"format": "email"}'::jsonb
  ),
  (
    'phone',
    'Teléfono',
    'string',
    '{}'::jsonb
  ),
  (
    'location',
    'Ubicación',
    'string',
    '{}'::jsonb
  ),
  (
    'quantity',
    'Cantidad',
    'number',
    '{"integer": true, "min": 0}'::jsonb
  ),
  (
    'currency',
    'Moneda',
    'number',
    '{"decimals": 2, "min": 0, "symbol": "$"}'::jsonb
  ),
  (
    'percentage',
    'Porcentaje',
    'number',
    '{"decimals": 2, "min": 0, "max": 100}'::jsonb
  ),
  (
    'date',
    'Fecha',
    'date',
    '{}'::jsonb
  ),
  (
    'datetime',
    'Fecha y hora',
    'datetime',
    '{}'::jsonb
  ),
  (
    'boolean',
    'Sí / No',
    'boolean',
    '{}'::jsonb
  ),
  (
    'url',
    'URL',
    'string',
    '{"format": "url"}'::jsonb
  ),
  (
    'document',
    'Documento',
    'file',
    '{}'::jsonb
  )
ON CONFLICT (code) DO NOTHING;

-- Down Migration