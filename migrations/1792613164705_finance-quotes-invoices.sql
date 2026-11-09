-- Cotizaciones, facturas y proveedores (RF-FIN-01 a RF-FIN-10,
-- RF-FIN-17, RF-FIN-18, RF-USR-08). Primera mitad de I9; oficios, pagos y recibos llegan después.
--
-- **Detectar antes que exigir.** Las áreas no suben sus facturas con constancia, así que casi todo
-- es nulable: una factura con solo el monto ya cuenta, y finanzas ve lo que falta en vez de que el
-- sistema rechace lo incompleto. El estatus es una lista fija con fecha por paso, porque las alertas
-- dependen de sus códigos; no es el catálogo configurable de `statuses`.
--
-- **Retención propia.** Un archivo al que apunta un registro de finanzas no se va con el barrido
-- semestral: vive `finance_months` desde el cierre del proyecto, o para siempre con
-- `finance_keep_forever`. `finance_files` es la lista de esos archivos; la siguiente migración de
-- finanzas la redefine con sus propias columnas.
--
-- **Bitácora en la misma sentencia** (§5.6): estas escrituras insertan su renglón de `logs` dentro
-- del mismo CTE, así que necesitan sus acciones en el catálogo.

-- Up Migration

CREATE TABLE providers (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name         varchar(300) NOT NULL,
    rfc          varchar(13),
    contact_name varchar(300),
    email        varchar(320),
    phone        varchar(50),
    notes        text,
    created_by   bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at   timestamptz
);

CREATE UNIQUE INDEX uq_providers_name ON providers (lower(name)) WHERE deleted_at IS NULL;

COMMENT ON TABLE providers IS 'RF-FIN-18: supplier directory. Its history is read from quotes, invoices and payments.';

CREATE TABLE quotes (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id       bigint NOT NULL REFERENCES projects (id),
    provider_id      bigint REFERENCES providers (id),
    entity           varchar(300),
    amount           numeric(12, 2) NOT NULL,
    description      text,
    file_id          bigint REFERENCES files (id),
    status           varchar(20) NOT NULL DEFAULT 'issued',
    in_review_at     timestamptz,
    decided_at       timestamptz,
    decided_by       bigint REFERENCES users (id) ON DELETE SET NULL,
    decision_comment text,
    created_by       bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at       timestamptz,
    CONSTRAINT quotes_status_valid CHECK (status IN ('issued', 'in_review', 'approved', 'rejected')),
    CONSTRAINT quotes_amount_positive CHECK (amount >= 0),
    CONSTRAINT quotes_decision_complete CHECK ((status IN ('approved', 'rejected')) = (decided_at IS NOT NULL))
);

CREATE INDEX idx_quotes_project ON quotes (project_id) WHERE deleted_at IS NULL;

COMMENT ON TABLE quotes IS 'RF-FIN-01 to RF-FIN-04: visible from the moment it is issued, not only once approved.';
COMMENT ON COLUMN quotes.entity IS 'Free text, like projects.requester (DATAMODEL §2.11), when the quote is not from a provider.';

CREATE TABLE invoices (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    project_id    bigint NOT NULL REFERENCES projects (id),
    quote_id      bigint REFERENCES quotes (id),
    provider_id   bigint REFERENCES providers (id),
    amount        numeric(12, 2) NOT NULL,
    material      text,
    invoice_folio varchar(100),
    fiscal_folio  varchar(36),
    destination   varchar(300),
    file_id       bigint REFERENCES files (id),
    status        varchar(20) NOT NULL DEFAULT 'uploaded',
    payment_folio varchar(100),
    sent_at       timestamptz,
    in_payment_at timestamptz,
    paid_at       timestamptz,
    created_by    bigint REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at    timestamptz,
    CONSTRAINT invoices_status_valid CHECK (status IN ('uploaded', 'sent', 'in_payment', 'paid')),
    CONSTRAINT invoices_amount_positive CHECK (amount >= 0)
);

CREATE INDEX idx_invoices_project ON invoices (project_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_invoices_fiscal_folio ON invoices (upper(fiscal_folio))
    WHERE fiscal_folio IS NOT NULL AND deleted_at IS NULL;

COMMENT ON TABLE invoices IS 'RF-FIN-05 to RF-FIN-10: grouped by project, not by area. Only the amount is required.';
COMMENT ON COLUMN invoices.fiscal_folio IS 'CFDI UUID. Unique among live invoices, so the same invoice is not uploaded twice.';

ALTER TABLE projects ADD COLUMN expected_invoice_count integer;
ALTER TABLE projects ADD CONSTRAINT projects_expected_invoices_positive CHECK (expected_invoice_count >= 0);
COMMENT ON COLUMN projects.expected_invoice_count IS 'RF-FIN-07: declared by finance or coordination. NULL = nobody declared it.';

ALTER TABLE file_retention
    ADD COLUMN finance_months integer NOT NULL DEFAULT 60,
    ADD COLUMN finance_keep_forever boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT file_retention_finance_months_positive CHECK (finance_months > 0);

CREATE VIEW finance_files AS
    SELECT file_id FROM quotes WHERE file_id IS NOT NULL AND deleted_at IS NULL
    UNION
    SELECT file_id FROM invoices WHERE file_id IS NOT NULL AND deleted_at IS NULL;

INSERT INTO permissions (code, label, description) VALUES
    ('finance.write', 'Llevar el trámite financiero',
     'RF-FIN-03, RF-FIN-10: decidir cotizaciones, cambiar estatus de facturas y administrar proveedores')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r JOIN permissions p ON p.code = 'finance.write'
WHERE r.name IN ('admin', 'finance')
ON CONFLICT DO NOTHING;

INSERT INTO actions (code, label) VALUES
    ('provider_created', 'Proveedor registrado'),
    ('provider_updated', 'Proveedor modificado'),
    ('provider_deleted', 'Proveedor eliminado'),
    ('quote_created',    'Cotización registrada'),
    ('quote_updated',    'Cotización modificada'),
    ('quote_decided',    'Cotización revisada'),
    ('quote_deleted',    'Cotización eliminada'),
    ('invoice_created',  'Factura cargada'),
    ('invoice_updated',  'Factura modificada'),
    ('invoice_deleted',  'Factura eliminada'),
    ('project_closed',   'Proyecto cerrado')
ON CONFLICT (code) DO NOTHING;

-- Down Migration

DELETE FROM logs
WHERE action_id IN (SELECT id FROM actions WHERE code IN
  ('provider_created', 'provider_updated', 'provider_deleted',
   'quote_created', 'quote_updated', 'quote_decided', 'quote_deleted',
   'invoice_created', 'invoice_updated', 'invoice_deleted', 'project_closed'));

DELETE FROM actions WHERE code IN
  ('provider_created', 'provider_updated', 'provider_deleted',
   'quote_created', 'quote_updated', 'quote_decided', 'quote_deleted',
   'invoice_created', 'invoice_updated', 'invoice_deleted', 'project_closed');

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'finance.write');

DELETE FROM permissions WHERE code = 'finance.write';

DROP VIEW finance_files;

ALTER TABLE file_retention
    DROP CONSTRAINT file_retention_finance_months_positive,
    DROP COLUMN finance_keep_forever,
    DROP COLUMN finance_months;

ALTER TABLE projects DROP CONSTRAINT projects_expected_invoices_positive;
ALTER TABLE projects DROP COLUMN expected_invoice_count;

DROP TABLE invoices;
DROP TABLE quotes;
DROP TABLE providers;
