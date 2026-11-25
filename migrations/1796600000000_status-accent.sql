-- Up Migration

-- El catálogo inicial sembró «En produccion» sin acento. Si coordinación ya le cambió el nombre, se respeta.
UPDATE statuses SET label = 'En producción'
WHERE area_id IS NULL AND code = 'en_produccion' AND label = 'En produccion';

-- Down Migration

UPDATE statuses SET label = 'En produccion'
WHERE area_id IS NULL AND code = 'en_produccion' AND label = 'En producción';
