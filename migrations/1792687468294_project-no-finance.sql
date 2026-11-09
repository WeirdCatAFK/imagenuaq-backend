-- Un proyecto que nunca pasa por finanzas (RF-FIN-08, DATAMODEL §2.20).
--
-- Hay trabajo que no compra nada ni cobra nada —acomodar el mobiliario de un evento de la UAQ,
-- por ejemplo—. Sin costo, ese proyecto ya no dispara alertas, pero seguía apareciendo en la lista
-- de finanzas como `no_finance_records`, que es ruido. `no_finance` lo saca de todo reporte de
-- finanzas: la lista, el resumen periódico y los pendientes al cerrar.
--
-- No convive con `has_cost`: un proyecto con costo es de finanzas por definición. Marcarlo con
-- cotizaciones, facturas o un número esperado de facturas lo rechaza la API, no esta restricción,
-- porque esas viven en otras tablas.

-- Up Migration

ALTER TABLE projects ADD COLUMN no_finance boolean NOT NULL DEFAULT false;
ALTER TABLE projects ADD CONSTRAINT projects_no_finance_without_cost CHECK (NOT (has_cost AND no_finance));
COMMENT ON COLUMN projects.no_finance IS 'Never goes through finance: left out of every finance list, digest and closing check.';

-- Down Migration

ALTER TABLE projects DROP CONSTRAINT projects_no_finance_without_cost;
ALTER TABLE projects DROP COLUMN no_finance;
